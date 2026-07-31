import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildTaskXml } from '../../src/main/agent/shared/prompt-xml';
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
  waitForTaskSessionNotRunning,
} from './helpers';

type LaunchCapture = {
  readonly kind: 'launch';
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

type PromptCapture = {
  readonly kind: 'prompt';
  readonly text: string;
};

type RouteCapture = {
  readonly kind: 'route';
  readonly destination: string;
  readonly sessionId: string;
};

type TuiConfigCapture = {
  readonly kind: 'tui-config';
  readonly config: { readonly plugin: readonly string[] };
};

type CaptureEvent = LaunchCapture | PromptCapture | RouteCapture | TuiConfigCapture;

type ExpectedCaptureCounts = {
  readonly launches: number;
  readonly prompts: number;
};

const CAPTURE_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const PROMPTLESS_OBSERVATION_MS = 1_000;
const MOCK_SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';
const PROMPT_METACHARACTERS = ['`', '&', '|', '<', '>', '^', '%'] as const;

function parseStringArray(value: unknown, errorMessage: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(errorMessage);
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError(errorMessage);
    strings.push(item);
  }
  return strings;
}

function parseCaptureEvent(line: string): CaptureEvent {
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError('OpenCode capture line must be an object with a kind');
  }

  if (value.kind === 'launch') {
    if (!('argv' in value)) {
      throw new TypeError('OpenCode launch capture must contain a string argv array');
    }
    const argv = parseStringArray(value.argv, 'OpenCode launch capture must contain a string argv array');
    if (!('env' in value) || typeof value.env !== 'object' || value.env === null) {
      throw new TypeError('OpenCode launch capture must contain string environment values');
    }
    const env: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.env)) {
      if (typeof item !== 'string') {
        throw new TypeError('OpenCode launch capture must contain string environment values');
      }
      env[key] = item;
    }
    return { kind: 'launch', argv, env };
  }

  if (value.kind === 'prompt') {
    if (!('text' in value) || typeof value.text !== 'string') {
      throw new TypeError('OpenCode prompt capture must contain text');
    }
    return { kind: 'prompt', text: value.text };
  }

  if (value.kind === 'route') {
    if (!('destination' in value) || typeof value.destination !== 'string'
      || !('sessionId' in value) || typeof value.sessionId !== 'string') {
      throw new TypeError('OpenCode route capture must contain destination and sessionId');
    }
    return { kind: 'route', destination: value.destination, sessionId: value.sessionId };
  }

  if (value.kind === 'tui-config') {
    if (!('config' in value) || typeof value.config !== 'object' || value.config === null
      || !('plugin' in value.config)) {
      throw new TypeError('OpenCode TUI config capture must contain plugin URLs');
    }
    const plugin = parseStringArray(
      value.config.plugin,
      'OpenCode TUI config capture must contain plugin URLs',
    );
    return { kind: 'tui-config', config: { plugin } };
  }

  throw new TypeError(`Unknown OpenCode capture kind: ${String(value.kind)}`);
}

function readCaptureEvents(capturePath: string): readonly CaptureEvent[] {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseCaptureEvent);
}

async function waitForCapture(
  capturePath: string,
  expected: ExpectedCaptureCounts,
): Promise<readonly CaptureEvent[]> {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  let events: readonly CaptureEvent[] = [];

  while (Date.now() < deadline) {
    events = readCaptureEvents(capturePath);
    const launches = events.filter((event) => event.kind === 'launch').length;
    const prompts = events.filter((event) => event.kind === 'prompt').length;
    if (launches >= expected.launches && prompts >= expected.prompts) return events;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const observedLaunches = events.filter((event) => event.kind === 'launch').length;
  const observedPrompts = events.filter((event) => event.kind === 'prompt').length;
  throw new Error(
    `Timed out waiting for OpenCode capture launches=${expected.launches}, prompts=${expected.prompts}; `
      + `observed launches=${observedLaunches}, prompts=${observedPrompts}`,
  );
}

function expectPromptFreeLaunch(
  launch: LaunchCapture,
  excludedContent: readonly string[],
): void {
  const { argv, env } = launch;
  expect(argv).not.toContain('--prompt');
  expect(argv.some((argument) => argument.startsWith('--prompt='))).toBe(false);
  const commandLineData = argv.join('\0');
  for (const content of excludedContent) {
    expect(commandLineData).not.toContain(content);
  }
  for (const metacharacter of PROMPT_METACHARACTERS) {
    expect(commandLineData).not.toContain(metacharacter);
  }
  const environmentData = Object.values(env).join('\0');
  for (const content of excludedContent) {
    expect(environmentData).not.toContain(content);
  }
  for (const metacharacter of PROMPT_METACHARACTERS) {
    expect(environmentData).not.toContain(metacharacter);
  }
}

const runId = Date.now();

test.describe('OpenCode multiline prompt transport', () => {
  test.describe.configure({ mode: 'serial' });

  const TEST_NAME = `opencode-task-prompt-${runId}`;
  const PROJECT_NAME = `OpenCode Prompt Project ${runId}`;
  let app: ElectronApplication | undefined;
  let page: Page;
  let capturePath: string;
  let sentinelPath: string;
  let projectId: string;
  let todoId: string;
  let planningId: string;

  test.beforeAll(async () => {
    const tmpDir = createTempProject(TEST_NAME);
    const dataDir = getTestDataDir(TEST_NAME);
    capturePath = path.join(dataDir, 'opencode-capture.jsonl');
    sentinelPath = path.join(dataDir, 'shell-side-effect.txt');
    fs.rmSync(capturePath, { force: true });
    fs.rmSync(sentinelPath, { force: true });
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { opencode: mockAgentPath('opencode') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );

    const launched = await launchApp({
      dataDir,
      extraEnv: { MOCK_OPENCODE_CAPTURE_PATH: capturePath },
    });
    app = launched.app;
    page = launched.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'opencode');

    const setup = await page.evaluate(async () => {
      const project = await window.electronAPI.projects.getCurrent();
      const swimlanes = await window.electronAPI.swimlanes.list();
      return {
        projectId: project?.id ?? null,
        todoId: swimlanes.find((swimlane) => swimlane.role === 'todo')?.id ?? null,
        planningId: swimlanes.find((swimlane) => swimlane.name === 'Planning')?.id ?? null,
      };
    });
    if (!setup.projectId || !setup.todoId || !setup.planningId) {
      throw new Error(`OpenCode prompt E2E setup is incomplete: ${JSON.stringify(setup)}`);
    }
    projectId = setup.projectId;
    todoId = setup.todoId;
    planningId = setup.planningId;
  });

  test.afterAll(async () => {
    try {
      await closeApp(app);
    } finally {
      try {
        cleanupTempProject(TEST_NAME);
      } finally {
        cleanupTestDataDir(TEST_NAME);
      }
    }
  });

  test('fresh and resumed prompts use the plugin API without argv or shell execution', async () => {
    test.slow();
    const title = `OpenCode Prompt ${runId} 繁體 "title" & | < > ^ %`;
    const description = `line one\r\n繁體中文 "double" 'single' \`backtick\` & | < > ^ % & echo unsafe > "${sentinelPath}"\r\nline three`;
    const expectedTaskXml = buildTaskXml({ title, description });

    const task = await page.evaluate(async ({ taskTitle, taskDescription, swimlaneId, currentProjectId }) => (
      window.electronAPI.tasks.create({
        title: taskTitle,
        description: taskDescription,
        swimlane_id: swimlaneId,
      }, currentProjectId)
    ), {
      taskTitle: title,
      taskDescription: description,
      swimlaneId: todoId,
      currentProjectId: projectId,
    });

    await moveTaskIpc(page, task.id, planningId);
    let events = await waitForCapture(capturePath, { launches: 1, prompts: 1 });
    let launches = events.filter((event) => event.kind === 'launch');
    let prompts = events.filter((event) => event.kind === 'prompt');
    expect(launches).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expectPromptFreeLaunch(launches[0], [title, description, expectedTaskXml, '<task>', sentinelPath]);
    const tuiConfigs = events.filter((event) => event.kind === 'tui-config');
    expect(tuiConfigs).toHaveLength(1);
    const tuiConfig = tuiConfigs.at(0);
    if (!tuiConfig) throw new TypeError('Missing fresh TUI config capture');
    expect(Object.keys(tuiConfig.config)).toEqual(['plugin']);
    expect(tuiConfig.config.plugin).toHaveLength(1);
    expect(tuiConfig.config.plugin[0]).toMatch(/^file:\/\//);
    expect(JSON.stringify(tuiConfig.config)).not.toContain(expectedTaskXml);
    const freshRouteIndex = events.findIndex((event) => event.kind === 'route');
    const freshPromptIndex = events.findIndex((event) => event.kind === 'prompt');
    expect(events[freshRouteIndex]).toEqual({
      kind: 'route',
      destination: 'session',
      sessionId: MOCK_SESSION_ID,
    });
    expect(freshRouteIndex).toBeLessThan(freshPromptIndex);
    expect(prompts[0].text).toBe(expectedTaskXml);
    expect(fs.existsSync(sentinelPath)).toBe(false);
    await waitForAgentSessionId(page, task.id, MOCK_SESSION_ID);

    await page.evaluate(async ({ taskId, currentProjectId }) => {
      await window.electronAPI.sessions.suspend(taskId, currentProjectId);
    }, { taskId: task.id, currentProjectId: projectId });
    await waitForTaskSessionNotRunning(page, task.id);

    const resumePrompt = 'resume\r\n繁體中文 & | < > ^ %';
    await page.evaluate(async ({ taskId, prompt, currentProjectId }) => {
      await window.electronAPI.sessions.resume(taskId, prompt, currentProjectId);
    }, { taskId: task.id, prompt: resumePrompt, currentProjectId: projectId });
    events = await waitForCapture(capturePath, { launches: 2, prompts: 2 });
    launches = events.filter((event) => event.kind === 'launch');
    prompts = events.filter((event) => event.kind === 'prompt');
    expect(launches).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'route')).toHaveLength(1);
    expect(launches[1].argv).toContain('--session');
    expect(launches[1].argv).toContain(MOCK_SESSION_ID);
    expectPromptFreeLaunch(launches[1], [title, description, expectedTaskXml, resumePrompt, '<task>', sentinelPath]);
    expect(prompts[1].text).toBe(resumePrompt);
    expect(prompts[1].text).not.toContain('<task>');
    expect(fs.existsSync(sentinelPath)).toBe(false);

    await page.evaluate(async ({ taskId, currentProjectId }) => {
      await window.electronAPI.sessions.suspend(taskId, currentProjectId);
    }, { taskId: task.id, currentProjectId: projectId });
    await waitForTaskSessionNotRunning(page, task.id);

    await page.evaluate(async ({ taskId, currentProjectId }) => {
      await window.electronAPI.sessions.resume(taskId, undefined, currentProjectId);
    }, { taskId: task.id, currentProjectId: projectId });
    events = await waitForCapture(capturePath, { launches: 3, prompts: 2 });
    await waitForAgentSessionId(page, task.id, MOCK_SESSION_ID);
    launches = events.filter((event) => event.kind === 'launch');
    prompts = events.filter((event) => event.kind === 'prompt');
    expect(launches).toHaveLength(3);
    expect(prompts).toHaveLength(2);
    expect(launches[2].argv).toContain('--session');
    expect(launches[2].argv).toContain(MOCK_SESSION_ID);
    expectPromptFreeLaunch(launches[2], [title, description, expectedTaskXml, resumePrompt, '<task>', sentinelPath]);
    expect(fs.existsSync(sentinelPath)).toBe(false);

    await new Promise<void>((resolve) => setTimeout(resolve, PROMPTLESS_OBSERVATION_MS));
    expect(readCaptureEvents(capturePath).filter((event) => event.kind === 'prompt')).toHaveLength(2);
    await page.evaluate(async ({ taskId, currentProjectId }) => {
      await window.electronAPI.sessions.suspend(taskId, currentProjectId);
    }, { taskId: task.id, currentProjectId: projectId });
    await waitForTaskSessionNotRunning(page, task.id);

    const finalEvents = readCaptureEvents(capturePath);
    expect(finalEvents.filter((event) => event.kind === 'launch')).toHaveLength(3);
    expect(finalEvents.filter((event) => event.kind === 'prompt')).toHaveLength(2);
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });
});
