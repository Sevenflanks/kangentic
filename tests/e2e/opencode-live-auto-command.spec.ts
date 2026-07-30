import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { LiveDeliveryStatus } from '../../src/shared/live-delivery-status';
import {
  cleanupTempProject,
  cleanupTestDataDir,
  closeApp,
  createProject,
  createTempProject,
  getTestDataDir,
  launchApp,
  mockAgentPath,
  moveTaskIpc,
  setProjectDefaultAgent,
  waitForAgentSessionId,
} from './helpers';

const BOOTSTRAP_PROMPT_CANARY = '/bootstrap-prompt-canary';
const LIVE_COMMAND_CANARY = 'live-command-canary';
const INTERACTIVE_PROBE_CANARY = 'interactive-probe-canary';
const USER_INPUT_CANARY = 'user-input-canary';
const STATUS_CAPTURE_ID = 'live-delivery-status-capture';
const POLL_INTERVAL_MS = 50;

async function waitForFile(pathname: string, expected: string): Promise<void> {
  await expect.poll(
    async () => fs.existsSync(pathname) ? fs.promises.readFile(pathname, 'utf8') : '',
    { intervals: [POLL_INTERVAL_MS], timeout: 15_000 },
  ).toContain(expected);
}

async function emitTrigger(pathname: string): Promise<void> {
  await fs.promises.writeFile(pathname, 'emit', 'utf8');
  await expect.poll(() => fs.existsSync(pathname), {
    intervals: [POLL_INTERVAL_MS],
    timeout: 5_000,
  }).toBe(false);
}

function readPromptCaptures(capturePath: string): readonly string[] {
  return fs.readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const event: unknown = JSON.parse(line);
      if (typeof event !== 'object' || event === null || !('kind' in event) || !('text' in event)) return [];
      return event.kind === 'prompt' && typeof event.text === 'string' ? [event.text] : [];
    });
}

async function idleEventCount(page: Page, sessionId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const events = await window.electronAPI.sessions.getEvents(id);
    return events.filter((event) => event.type === 'idle').length;
  }, sessionId);
}

async function waitForLiveStatus(
  page: Page,
  taskId: string,
  expected: Pick<LiveDeliveryStatus, 'state'> & { readonly reason?: string },
): Promise<void> {
  await expect.poll(async () => page.evaluate(({ captureId, id }) => {
    const capture = document.getElementById(captureId);
    const events: LiveDeliveryStatus[] = JSON.parse(capture?.textContent ?? '[]');
    return events.findLast((event) => event.taskId === id) ?? null;
  }, { captureId: STATUS_CAPTURE_ID, id: taskId }), {
    intervals: [POLL_INTERVAL_MS],
    timeout: 15_000,
  }).toMatchObject(expected);
}

test.describe('OpenCode live lane command delivery', () => {
  test.describe.configure({ mode: 'serial' });

  test('authorizes only root idle and keeps the same terminal usable after cancellations', async ({}, testInfo) => {
    test.slow();
    const runId = Date.now();
    const testName = `opencode-live-auto-command-${runId}`;
    const taskTitle = `OpenCode Live Delivery ${runId}`;
    const taskDescription = 'Exercise root-native idle authorization';
    const paths = {
      receipt: path.join(testInfo.outputDir, 'live-receipt.txt'),
      probeReceipt: path.join(testInfo.outputDir, 'probe-receipt.txt'),
      rootIdleTrigger: path.join(testInfo.outputDir, 'emit-root-idle'),
      childIdleTrigger: path.join(testInfo.outputDir, 'emit-child-idle'),
      errorTrigger: path.join(testInfo.outputDir, 'emit-error'),
      launchMarkers: path.join(testInfo.outputDir, 'launch-count.txt'),
      inputCapture: path.join(testInfo.outputDir, 'input-capture.bin'),
      capture: path.join(testInfo.outputDir, 'opencode-capture.jsonl'),
    } as const;
    const tmpDir = createTempProject(testName);
    const dataDir = getTestDataDir(testName);
    let app: ElectronApplication | undefined;

    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(paths.launchMarkers, '', 'utf8');
    fs.writeFileSync(paths.inputCapture, Buffer.from([0x7f]));
    fs.writeFileSync(paths.capture, '', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      agent: {
          cliPaths: {
            claude: mockAgentPath('claude'),
            opencode: mockAgentPath('opencode'),
          },
        permissionMode: 'acceptEdits',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }));

    try {
      const launched = await launchApp({
        dataDir,
        extraEnv: {
          MOCK_OPENCODE_LIVE_DELIVERY: '1',
          MOCK_OPENCODE_LIVE_DELIVERY_DIR: testInfo.outputDir,
          MOCK_OPENCODE_CAPTURE_PATH: paths.capture,
        },
      });
      app = launched.app;
      const { page } = launched;
      await createProject(page, `OpenCode Live Delivery ${runId}`, tmpDir);
      await setProjectDefaultAgent(page, 'opencode');
      await page.evaluate((captureId) => {
        const capture = document.createElement('output');
        capture.id = captureId;
        capture.textContent = '[]';
        document.body.append(capture);
        window.electronAPI.sessions.onLiveDeliveryStatus((status) => {
          const events: LiveDeliveryStatus[] = JSON.parse(capture.textContent ?? '[]');
          capture.textContent = JSON.stringify([...events, status]);
        });
      }, STATUS_CAPTURE_ID);

      const lanes = await page.evaluate(async () => {
        const swimlanes = await window.electronAPI.swimlanes.list();
        const byName = (name: string) => swimlanes.find((lane) => lane.name === name)?.id ?? null;
        return {
          todo: swimlanes.find((lane) => lane.role === 'todo')?.id ?? null,
          executing: byName('Executing'),
          review: byName('Code Review'),
          tests: byName('Tests'),
          shipping: byName('Ship It'),
        };
      });
      if (!lanes.todo || !lanes.executing || !lanes.review || !lanes.tests || !lanes.shipping) {
        throw new Error('OpenCode live delivery E2E requires To Do, Executing, Code Review, Tests, and Ship It lanes');
      }
      const taskId = await page.evaluate(async ({ todo, executing, review, tests, shipping, bootstrap, command, title, description }) => {
        const project = await window.electronAPI.projects.getCurrent();
        const holding = await window.electronAPI.swimlanes.create({
          name: 'Live Delivery Holding',
          auto_spawn: false,
        });
        await window.electronAPI.swimlanes.update({ id: executing, auto_command: bootstrap });
        await window.electronAPI.swimlanes.update({ id: review, auto_command: command });
        await window.electronAPI.swimlanes.update({ id: tests, auto_command: command });
        await window.electronAPI.swimlanes.update({ id: shipping, auto_command: command });
        if (!project) return null;
        const task = await window.electronAPI.tasks.create({
          title,
          description,
          swimlane_id: todo,
        }, project.id);
        return task.id;
      }, {
        todo: lanes.todo,
        executing: lanes.executing,
        review: lanes.review,
        tests: lanes.tests,
        shipping: lanes.shipping,
        bootstrap: BOOTSTRAP_PROMPT_CANARY,
        command: LIVE_COMMAND_CANARY,
        title: taskTitle,
        description: taskDescription,
      });
      if (!taskId) throw new Error('OpenCode live delivery E2E requires a current project');
      const freshMove = await moveTaskIpc(page, taskId, lanes.executing);
      expect(freshMove).toEqual({
        ok: true,
        autoCommand: {
          kind: 'skipped',
          reason: 'fresh-not-supported',
          warning: 'Auto-command was skipped because OpenCode fresh-session delivery is not supported.',
        },
      });
      await waitForAgentSessionId(page, taskId, 'ses_2349b5c91ffeKd6qajuUTR4clq');
      await expect.poll(() => readPromptCaptures(paths.capture).length).toBe(1);
      const initialPrompts = readPromptCaptures(paths.capture);
      expect(initialPrompts).toHaveLength(1);
      const initialPrompt = initialPrompts[0];
      if (initialPrompt === undefined) throw new Error('Expected exactly one initial OpenCode prompt capture');
      expect(initialPrompt).toContain(taskTitle);
      expect(initialPrompt).toContain(taskDescription);
      expect(initialPrompt).not.toContain(BOOTSTRAP_PROMPT_CANARY);
      expect(initialPrompt).not.toContain(LIVE_COMMAND_CANARY);

      const readSessionId = async (): Promise<string | null> => page.evaluate(async (id) => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.find((session) => session.taskId === id && session.status === 'running')?.id ?? null;
      }, taskId);
      await expect.poll(readSessionId, {
        intervals: [POLL_INTERVAL_MS],
        timeout: 15_000,
      }).not.toBeNull();
      const sessionId = await readSessionId();
      if (!sessionId) throw new Error('OpenCode live delivery E2E lost its running session');
      await expect.poll(async () => page.evaluate(async (id) => {
        const events = await window.electronAPI.sessions.getEvents(id);
        return events.some((event) => event.type === 'session_start');
      }, sessionId), { intervals: [POLL_INTERVAL_MS], timeout: 15_000 }).toBe(true);

      const activeMove = await moveTaskIpc(page, taskId, lanes.review);
      expect(activeMove).toEqual({
        ok: true,
        autoCommand: {
          kind: 'scheduled',
          transport: 'native-idle',
          generation: expect.any(Number),
        },
      });
      await expect.poll(async () => page.evaluate(async ({ id, captureId }) => {
        const tasks = await window.electronAPI.tasks.list();
        const sessions = await window.electronAPI.sessions.list();
        const task = tasks.find((candidate) => candidate.id === id);
        const session = sessions.find((candidate) => candidate.taskId === id && candidate.status === 'running');
        return {
          laneId: task?.swimlane_id ?? null,
          sessionId: session?.id ?? null,
          hasCapture: document.getElementById(captureId) !== null,
        };
      }, { id: taskId, captureId: STATUS_CAPTURE_ID }))
        .toEqual({ laneId: lanes.review, sessionId, hasCapture: true });
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      await expect.poll(async () => page.evaluate(async (id) => {
        const activity = await window.electronAPI.sessions.getActivity();
        return activity[id] ?? null;
      }, sessionId), { timeout: 15_000 }).toBe('idle');
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      expect(fs.existsSync(paths.receipt)).toBe(false);

      const childIdleCount = await idleEventCount(page, sessionId);
      await emitTrigger(paths.childIdleTrigger);
      await expect.poll(() => idleEventCount(page, sessionId)).toBeGreaterThan(childIdleCount);
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      expect(fs.existsSync(paths.receipt)).toBe(false);

      await emitTrigger(paths.rootIdleTrigger);
      await waitForLiveStatus(page, taskId, { state: 'delivered' });
      await waitForFile(paths.receipt, 'received');

      await page.evaluate(async ({ id }) => window.electronAPI.sessions.write(id, 'readiness-reset-canary\r'), {
        id: sessionId,
      });
      await moveTaskIpc(page, taskId, lanes.tests);
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      await page.evaluate(async ({ id, text }) => window.electronAPI.sessions.write(id, text), {
        id: sessionId,
        text: USER_INPUT_CANARY,
      });
      await waitForLiveStatus(page, taskId, { state: 'cancelled', reason: 'user-input' });
      const postInputIdleCount = await idleEventCount(page, sessionId);
      await emitTrigger(paths.rootIdleTrigger);
      await expect.poll(() => idleEventCount(page, sessionId)).toBeGreaterThan(postInputIdleCount);
      expect(await fs.promises.readFile(paths.receipt, 'utf8')).toBe('received\n');
      await page.evaluate(async ({ id }) => window.electronAPI.sessions.write(id, '\r'), { id: sessionId });

      await moveTaskIpc(page, taskId, lanes.shipping);
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      const errorIdleCount = await idleEventCount(page, sessionId);
      await emitTrigger(paths.errorTrigger);
      await expect.poll(() => idleEventCount(page, sessionId)).toBeGreaterThan(errorIdleCount);
      await waitForLiveStatus(page, taskId, { state: 'cancelled', reason: 'turn-error' });
      const postErrorIdleCount = await idleEventCount(page, sessionId);
      await emitTrigger(paths.rootIdleTrigger);
      await expect.poll(() => idleEventCount(page, sessionId)).toBeGreaterThan(postErrorIdleCount);
      expect(await fs.promises.readFile(paths.receipt, 'utf8')).toBe('received\n');

      await page.evaluate(async ({ id, text }) => window.electronAPI.sessions.write(id, `${text}\r`), {
        id: sessionId,
        text: INTERACTIVE_PROBE_CANARY,
      });
      await waitForFile(paths.probeReceipt, 'received');
      expect(await fs.promises.readFile(paths.receipt, 'utf8')).toBe('received\n');
      expect(readPromptCaptures(paths.capture)).toHaveLength(1);
      expect(readPromptCaptures(paths.capture)).not.toContain(LIVE_COMMAND_CANARY);
      expect(await fs.promises.readFile(paths.launchMarkers, 'utf8')).toBe('launch\n');
      const inputBytes = await fs.promises.readFile(paths.inputCapture);
      expect(inputBytes[0]).toBe(0x7f);
      expect(inputBytes.includes(0x03)).toBe(false);

      const holdingId = await page.evaluate(async () => {
        const swimlanes = await window.electronAPI.swimlanes.list();
        return swimlanes.find((lane) => lane.name === 'Live Delivery Holding')?.id ?? null;
      });
      if (!holdingId) throw new Error('OpenCode live delivery E2E requires the holding lane');
      const legacyTaskId = await page.evaluate(async ({ holdingId }) => {
        const project = await window.electronAPI.projects.getCurrent();
        if (!project) return null;
        const task = await window.electronAPI.tasks.create({
          title: `Legacy live delivery ${Date.now()}`,
          description: 'Exercise the non-OpenCode delivery transport.',
          swimlane_id: holdingId,
          agent_override: 'claude',
        }, project.id);
        return task.id;
      }, { holdingId });
      if (!legacyTaskId) throw new Error('OpenCode live delivery E2E could not create the legacy task');

      const legacyMove = await moveTaskIpc(page, legacyTaskId, lanes.executing);
      expect(legacyMove).toEqual({
        ok: true,
        autoCommand: { kind: 'scheduled', transport: 'legacy' },
      });
      expect(await fs.promises.readFile(paths.launchMarkers, 'utf8')).toBe('launch\n');
    } finally {
      await closeApp(app);
      cleanupTempProject(testName);
      cleanupTestDataDir(testName);
    }
  });
});
