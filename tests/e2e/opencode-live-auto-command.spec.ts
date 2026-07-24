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
  createTask,
  createTempProject,
  getTestDataDir,
  getTaskIdByTitle,
  launchApp,
  mockAgentPath,
  moveTaskIpc,
  setProjectDefaultAgent,
  waitForAgentSessionId,
} from './helpers';

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
    const paths = {
      receipt: path.join(testInfo.outputDir, 'live-receipt.txt'),
      initialReceipt: path.join(testInfo.outputDir, 'initial-receipt.txt'),
      probeReceipt: path.join(testInfo.outputDir, 'probe-receipt.txt'),
      rootIdleTrigger: path.join(testInfo.outputDir, 'emit-root-idle'),
      childIdleTrigger: path.join(testInfo.outputDir, 'emit-child-idle'),
      errorTrigger: path.join(testInfo.outputDir, 'emit-error'),
      launchCount: path.join(testInfo.outputDir, 'launch-count.txt'),
      inputCapture: path.join(testInfo.outputDir, 'input-capture.bin'),
    } as const;
    const tmpDir = createTempProject(testName);
    const dataDir = getTestDataDir(testName);
    let app: ElectronApplication | undefined;

    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      agent: {
        cliPaths: { opencode: mockAgentPath('opencode') },
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
          planning: byName('Planning'),
          executing: byName('Executing'),
          review: byName('Code Review'),
          tests: byName('Tests'),
        };
      });
      if (!lanes.planning || !lanes.executing || !lanes.review || !lanes.tests) {
        throw new Error('OpenCode live delivery E2E requires Planning, Executing, Code Review, and Tests lanes');
      }
      await page.evaluate(async ({ executing, review, tests, command }) => {
        await window.electronAPI.swimlanes.update({ id: executing, auto_command: command });
        await window.electronAPI.swimlanes.update({ id: review, auto_command: command });
        await window.electronAPI.swimlanes.update({ id: tests, auto_command: command });
      }, { executing: lanes.executing, review: lanes.review, tests: lanes.tests, command: LIVE_COMMAND_CANARY });

      const title = `OpenCode Live Delivery ${runId}`;
      await createTask(page, title, 'Exercise root-native idle authorization');
      const taskId = await getTaskIdByTitle(page, title);
      await moveTaskIpc(page, taskId, lanes.planning);
      await waitForFile(paths.initialReceipt, 'received');
      await waitForFile(paths.launchCount, '1');
      await waitForAgentSessionId(page, taskId, 'ses_2349b5c91ffeKd6qajuUTR4clq');

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

      await moveTaskIpc(page, taskId, lanes.executing);
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
        .toEqual({ laneId: lanes.executing, sessionId, hasCapture: true });
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      expect(fs.existsSync(paths.receipt)).toBe(false);

      await emitTrigger(paths.childIdleTrigger);
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      expect(fs.existsSync(paths.receipt)).toBe(false);

      await emitTrigger(paths.rootIdleTrigger);
      await waitForLiveStatus(page, taskId, { state: 'delivered' });
      await waitForFile(paths.receipt, 'received');

      await page.evaluate(async ({ id }) => window.electronAPI.sessions.write(id, 'readiness-reset-canary\r'), {
        id: sessionId,
      });
      await moveTaskIpc(page, taskId, lanes.review);
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      await page.evaluate(async ({ id, text }) => window.electronAPI.sessions.write(id, text), {
        id: sessionId,
        text: USER_INPUT_CANARY,
      });
      await waitForLiveStatus(page, taskId, { state: 'cancelled', reason: 'user-input' });
      await emitTrigger(paths.rootIdleTrigger);
      expect(await fs.promises.readFile(paths.receipt, 'utf8')).toBe('received\n');
      await page.evaluate(async ({ id }) => window.electronAPI.sessions.write(id, '\r'), { id: sessionId });

      await moveTaskIpc(page, taskId, lanes.tests);
      await waitForLiveStatus(page, taskId, { state: 'waiting' });
      await emitTrigger(paths.errorTrigger);
      await waitForLiveStatus(page, taskId, { state: 'cancelled', reason: 'turn-error' });
      await emitTrigger(paths.rootIdleTrigger);
      expect(await fs.promises.readFile(paths.receipt, 'utf8')).toBe('received\n');

      await page.evaluate(async ({ id, text }) => window.electronAPI.sessions.write(id, `${text}\r`), {
        id: sessionId,
        text: INTERACTIVE_PROBE_CANARY,
      });
      await waitForFile(paths.probeReceipt, 'received');
      expect(Number(await fs.promises.readFile(paths.launchCount, 'utf8'))).toBe(1);
      const inputBytes = await fs.promises.readFile(paths.inputCapture);
      expect(inputBytes.includes(0x03)).toBe(false);
    } finally {
      await closeApp(app);
      cleanupTempProject(testName);
      cleanupTestDataDir(testName);
    }
  });
});
