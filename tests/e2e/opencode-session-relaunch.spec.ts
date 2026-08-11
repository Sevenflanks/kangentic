import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  cleanupTempProject,
  cleanupTestDataDir,
  closeApp,
  createProject,
  createTask,
  createTempProject,
  getSwimlaneIds,
  getTaskIdByTitle,
  getTestDataDir,
  launchApp,
  mockAgentPath,
  moveTaskIpc,
  setProjectDefaultAgent,
  waitForAgentSessionId,
  waitForRunningSession,
} from './helpers';

const SUITE_NAME = `opencode-session-relaunch-${process.pid}`;
const RUN_ID = Date.now();

async function readLiveTaskSession(page: Page, taskId: string): Promise<{
  id: string;
  agentSessionId: string | null;
} | null> {
  return page.evaluate(async (id) => {
    const sessions = await window.electronAPI.sessions.list();
    const session = sessions.find((candidate) => candidate.taskId === id && candidate.status === 'running');
    return session ? { id: session.id, agentSessionId: session.agentSessionId } : null;
  }, taskId);
}

async function waitForTaskScrollback(page: Page, taskId: string, marker: string): Promise<string> {
  const readScrollback = async (): Promise<string> => page.evaluate(async (id) => {
    const sessions = await window.electronAPI.sessions.list();
    const session = sessions.find((candidate) => candidate.taskId === id && candidate.status === 'running');
    return session ? window.electronAPI.sessions.getScrollback(session.id) : '';
  }, taskId);

  await expect.poll(readScrollback, {
    timeout: 30_000,
    intervals: [200, 500, 1_000],
    message: `Expected task ${taskId} scrollback to contain ${marker}`,
  }).toContain(marker);
  return readScrollback();
}

test('a fresh OpenCode task relaunches with the same native session ID', async () => {
  test.setTimeout(120_000);
  const projectDir = createTempProject(SUITE_NAME);
  const dataDir = getTestDataDir(SUITE_NAME);
  const taskTitle = `OpenCode Relaunch ${RUN_ID}`;
  let app: ElectronApplication | undefined;

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    agent: {
      cliPaths: { opencode: mockAgentPath('opencode') },
      permissionMode: 'acceptEdits',
      maxConcurrentSessions: 1,
      queueOverflow: 'queue',
    },
    git: { worktreesEnabled: false },
  }));

  try {
    const firstLaunch = await launchApp({ dataDir });
    app = firstLaunch.app;
    await createProject(firstLaunch.page, `OpenCode Relaunch Project ${RUN_ID}`, projectDir);
    await setProjectDefaultAgent(firstLaunch.page, 'opencode');
    await createTask(firstLaunch.page, taskTitle, 'Verify native OpenCode session recovery after app relaunch');
    const taskId = await getTaskIdByTitle(firstLaunch.page, taskTitle);
    const swimlaneIds = await getSwimlaneIds(firstLaunch.page);

    await moveTaskIpc(firstLaunch.page, taskId, swimlaneIds.planning);
    await waitForRunningSession(firstLaunch.page);
    const freshScrollback = await waitForTaskScrollback(firstLaunch.page, taskId, 'MOCK_OPENCODE_SESSION:');
    const freshMarker = freshScrollback.match(/MOCK_OPENCODE_SESSION:(ses_[A-Za-z0-9_-]+)/);
    expect(freshMarker).not.toBeNull();
    const freshNativeId = freshMarker?.[1];
    if (!freshNativeId) throw new Error('Fresh OpenCode marker did not include a native session ID');
    await waitForAgentSessionId(firstLaunch.page, taskId, freshNativeId);

    await expect.poll(() => readLiveTaskSession(firstLaunch.page, taskId), {
      timeout: 15_000,
      intervals: [200, 500, 1_000],
    }).not.toBeNull();
    const freshLiveSession = await readLiveTaskSession(firstLaunch.page, taskId);
    if (!freshLiveSession) throw new Error('Fresh OpenCode session stopped before relaunch');
    expect(freshLiveSession.agentSessionId).toBe(freshNativeId);
    await expect.poll(async () => firstLaunch.page.evaluate(async (sessionId) => {
      const events = await window.electronAPI.sessions.getEvents(sessionId);
      return events.filter((event) => event.type === 'session_start').length;
    }, freshLiveSession.id), {
      timeout: 15_000,
      intervals: [200, 500, 1_000],
    }).toBe(1);

    await closeApp(app);
    app = undefined;

    const secondLaunch = await launchApp({ dataDir });
    app = secondLaunch.app;
    await createProject(secondLaunch.page, `OpenCode Relaunch Project ${RUN_ID}`, projectDir);
    await waitForRunningSession(secondLaunch.page, 30_000);
    await waitForAgentSessionId(secondLaunch.page, taskId, freshNativeId, 30_000);
    const resumedScrollback = await waitForTaskScrollback(
      secondLaunch.page,
      taskId,
      `MOCK_OPENCODE_RESUMED:${freshNativeId}`,
    );
    const resumedMarker = resumedScrollback.match(/MOCK_OPENCODE_RESUMED:(ses_[A-Za-z0-9_-]+)/);
    expect(resumedMarker?.[1]).toBe(freshNativeId);

    const resumedLiveSession = await readLiveTaskSession(secondLaunch.page, taskId);
    expect(resumedLiveSession?.agentSessionId).toBe(freshNativeId);
    if (!resumedLiveSession) throw new Error('Resumed OpenCode session stopped before session-start verification');
    await expect.poll(async () => secondLaunch.page.evaluate(async (sessionId) => {
      const events = await window.electronAPI.sessions.getEvents(sessionId);
      return events.filter((event) => event.type === 'session_start').length;
    }, resumedLiveSession.id), {
      timeout: 15_000,
      intervals: [200, 500, 1_000],
    }).toBe(1);
  } finally {
    await closeApp(app);
    cleanupTempProject(SUITE_NAME);
    cleanupTestDataDir(SUITE_NAME);
  }
});
