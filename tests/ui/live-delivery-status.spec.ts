import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'project-live-delivery';
const PROJECT_B_ID = 'project-live-delivery-b';
const TASK_ID = 'task-live-delivery';
const SESSION_ID = 'session-live-delivery';
const COMMAND_CANARY = 'private-command-canary';

interface LaunchPageOptions {
  readonly sessionStatus?: 'running' | 'suspended' | null;
  readonly taskLaneIndex?: number;
}

async function launchPage({ sessionStatus = 'running', taskLaneIndex = 1 }: LaunchPageOptions = {}): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'Live delivery', path: '/mock/live-delivery', default_agent: 'opencode', last_opened: ts, created_at: ts });
      state.projects.push({ id: '${PROJECT_B_ID}', name: 'Live delivery destination', path: '/mock/live-delivery-b', default_agent: 'opencode', last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        state.swimlanes.push(Object.assign({}, lane, {
          id: 'lane-' + index,
          position: index,
          created_at: ts,
          auto_command: index === 1 ? '${COMMAND_CANARY}' : lane.auto_command,
        }));
      });
       if (${JSON.stringify(sessionStatus)}) {
         state.sessions.push({ id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 1, status: ${JSON.stringify(sessionStatus)}, shell: 'bash', cwd: '/mock/live-delivery', startedAt: ts, exitCode: null });
       }
       state.tasks.push({ id: '${TASK_ID}', title: 'Live delivery task', description: '', swimlane_id: 'lane-${taskLaneIndex}', position: 0, agent: 'opencode', session_id: ${sessionStatus ? `'${SESSION_ID}'` : 'null'}, worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null, labels: [], priority: 0, attachment_count: 0, archived_at: null, created_at: ts, updated_at: ts });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);
  await page.goto(VITE_URL);
  await page.waitForSelector(`[data-task-id="${TASK_ID}"]`);
  await page.waitForFunction('typeof window.__mockFireLiveDeliveryStatus === "function"');
  await page.waitForFunction('window.__mockGetLiveDeliveryStatusListenerCount() === 1');
  return { browser, page };
}

function fireStatus(page: Page, status: Record<string, string | number>): Promise<unknown> {
  return page.evaluate(`window.__mockFireLiveDeliveryStatus(${JSON.stringify(status)})`);
}

function status(state: string, generation: number, reason?: string): Record<string, string | number> {
  const value: Record<string, string | number> = {
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    generation,
    at: '2026-07-22T00:00:00.000Z',
    state,
  };
  if (reason) value.reason = reason;
  return value;
}

async function setAutoCommandWarning(page: Page, taskId = TASK_ID): Promise<void> {
  await page.evaluate(({ projectId, id }) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: {
          getState: () => {
            setAutoCommandWarning: (warning: {
              projectId: string;
              taskId: string;
              reason: 'no-active-main-session';
              message: string;
              at: string;
            }) => void;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setAutoCommandWarning({
      projectId,
      taskId: id,
      reason: 'no-active-main-session',
      message: 'Lifecycle warning.',
      at: '2026-07-27T00:00:00.000Z',
    });
  }, { projectId: PROJECT_ID, id: taskId });
}

function readAutoCommandWarningTaskId(page: Page, taskId = TASK_ID): Promise<string | null> {
  return page.evaluate((taskId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: {
          getState: () => {
            autoCommandWarningsByTaskId: Record<string, { taskId: string }>;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    return stores.session.getState().autoCommandWarningsByTaskId[taskId]?.taskId ?? null;
  }, taskId);
}

test.describe('Live delivery status', () => {
  test('uses a fixed resume label while an auto-command move is pending', async () => {
    const { browser, page } = await launchPage({ sessionStatus: 'suspended', taskLaneIndex: 0 });
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    let movePromise: Promise<unknown> | null = null;

    try {
      await page.evaluate(() => {
        (window as unknown as { __mockTaskMoveDeferred?: boolean }).__mockTaskMoveDeferred = true;
      });
      movePromise = page.evaluate(async ({ projectId, taskId }) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => {
                moveTask: (input: { taskId: string; targetSwimlaneId: string; targetPosition: number }, skip: boolean, project: string) => Promise<unknown>;
              };
            };
          };
        }).__zustandStores;
        if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
        await stores.board.getState().moveTask({ taskId, targetSwimlaneId: 'lane-1', targetPosition: 0 }, true, projectId);
      }, { projectId: PROJECT_ID, taskId: TASK_ID });
      await page.waitForFunction('typeof window.__mockTaskMoveResolve === "function"');

      await card.click();
      const launchOverlay = page.locator('[data-testid="launch-overlay"]');
      await expect(launchOverlay).toBeVisible();
      await expect(launchOverlay).toHaveText('Resuming agent...');
      await expect(launchOverlay).not.toContainText(COMMAND_CANARY);
      await expect(card).not.toContainText(COMMAND_CANARY);
      await expect(page.locator('[data-testid="toast"]').filter({ hasText: COMMAND_CANARY })).toHaveCount(0);
    } finally {
      await page.evaluate('window.__mockTaskMoveResolve?.()');
      await movePromise;
      await browser.close();
    }
  });

  test('shows only fixed lifecycle feedback and never command content', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);

    try {
      await fireStatus(page, status('waiting', 1));
      await expect(card).toContainText('Waiting for agent input...');

      await fireStatus(page, status('sending', 1));
      await expect(card).toContainText('Sending lane command...');

      await fireStatus(page, status('delivered', 1));
      await expect(card).toContainText('Command bytes reached the terminal.');
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
      await expect(card).not.toContainText(COMMAND_CANARY);
      const launchOverlay = page.locator('[data-testid="launch-overlay"]');
      await expect(launchOverlay).toBeVisible();
      await expect(launchOverlay).not.toContainText(COMMAND_CANARY);
    } finally {
      await browser.close();
    }
  });

  test('shows the full user-input warning without ellipsis', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    const warning = 'Lane command was not sent because terminal input took priority.';

    try {
      await fireStatus(page, status('cancelled', 2, 'user-input'));
      const liveDeliveryStatus = card.locator('[data-testid="live-delivery-status"]');
      await expect(liveDeliveryStatus).toHaveText(warning);
      await expect(card).not.toContainText(COMMAND_CANARY);

      const layout = await liveDeliveryStatus.evaluate((statusElement) => {
        const warningRow = statusElement.querySelector(':scope > span');
        const warningIcon = warningRow?.querySelector('svg');
        const warningText = warningRow?.querySelector('span');
        if (!warningRow || !warningIcon || !warningText) throw new Error('Expected warning layout');

        const rowStyle = getComputedStyle(warningRow);
        const textStyle = getComputedStyle(warningText);
        const iconRect = warningIcon.getBoundingClientRect();
        const textRect = warningText.getBoundingClientRect();
        return {
          alignItems: rowStyle.alignItems,
          whiteSpace: textStyle.whiteSpace,
          textOverflow: textStyle.textOverflow,
          overflowX: textStyle.overflowX,
          scrollWidth: warningText.scrollWidth,
          clientWidth: warningText.clientWidth,
          scrollHeight: warningText.scrollHeight,
          lineHeight: Number.parseFloat(textStyle.lineHeight),
          iconTop: iconRect.top,
          textTop: textRect.top,
        };
      });

      expect(layout.alignItems).toBe('flex-start');
      expect(layout.whiteSpace).toBe('normal');
      expect(layout.textOverflow).not.toBe('ellipsis');
      expect(layout.overflowX).not.toBe('hidden');
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.scrollHeight).toBeGreaterThan(layout.lineHeight);
      expect(Math.abs(layout.iconTop - layout.textTop)).toBeLessThanOrEqual(0.5);
    } finally {
      await browser.close();
    }
  });

  for (const [reason, warning] of [
    ['user-input', 'Lane command was not sent because terminal input took priority.'],
    ['timeout', 'Lane command was not sent because the agent did not become idle.'],
    ['session-exit', 'Lane command was not sent because the session ended or changed.'],
    ['turn-error', 'Lane command was not sent because the agent turn failed.'],
    ['delivery-error', 'Lane command could not be delivered safely.'],
  ]) {
    test(`shows the fixed ${reason} warning without command content`, async () => {
      const { browser, page } = await launchPage();
      const card = page.locator(`[data-task-id="${TASK_ID}"]`);

      try {
        await fireStatus(page, status('cancelled', 2, reason));
        await expect(card).toContainText(warning);
        await expect(card).not.toContainText(COMMAND_CANARY);
      } finally {
        await browser.close();
      }
    });
  }

  test('surfaces asynchronous delivery errors through a safe amber toast and retained card feedback', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    const warning = 'Lane command could not be delivered safely.';

    try {
      await fireStatus(page, status('cancelled', 2, 'delivery-error'));

      await expect(page.locator('[data-testid="toast"]').filter({ hasText: warning })).toHaveClass(/border-yellow-500\/50/);
      await expect(card.locator('[data-testid="auto-command-warning"]')).toContainText(warning);
      await expect(card.locator('[data-testid="live-delivery-status"]')).toContainText(warning);
      await expect(card).not.toContainText(COMMAND_CANARY);
    } finally {
      await browser.close();
    }
  });

  test('does not toast or replace newer feedback for an older delivery-error generation', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);

    try {
      await fireStatus(page, status('waiting', 3));
      await fireStatus(page, status('cancelled', 2, 'delivery-error'));

      await expect(card.locator('[data-testid="live-delivery-status"]')).toContainText('Waiting for agent input...');
      await expect(card.locator('[data-testid="auto-command-warning"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('does not toast or replace current feedback for a same-generation different session', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);

    try {
      await fireStatus(page, status('waiting', 3));
      await fireStatus(page, { ...status('cancelled', 3, 'delivery-error'), sessionId: 'stale-session' });

      await expect(card.locator('[data-testid="live-delivery-status"]')).toContainText('Waiting for agent input...');
      await expect(card.locator('[data-testid="auto-command-warning"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  for (const reason of ['superseded', 'shutdown']) {
    test(`keeps ${reason} cancellation silent`, async () => {
      const { browser, page } = await launchPage();
      const card = page.locator(`[data-task-id="${TASK_ID}"]`);

      try {
        await fireStatus(page, status('cancelled', 3, reason));
        await expect(card.locator('[data-testid="live-delivery-status"]')).toHaveCount(0);
        await expect(page.locator('[role="alert"]')).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });
  }

  test('ignores a status for another project at event time', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);

    try {
      await fireStatus(page, { ...status('waiting', 1), projectId: 'other-project' });
      await expect(card.locator('[data-testid="live-delivery-status"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('clears the stored warning through the session-exit listener', async () => {
    const { browser, page } = await launchPage();

    try {
      await page.waitForFunction('typeof window.__mockFireExit === "function"');
      await setAutoCommandWarning(page);
      expect(await readAutoCommandWarningTaskId(page)).toBe(TASK_ID);

      await page.evaluate(({ sessionId, projectId }) => {
        (window as unknown as {
          __mockFireExit: (id: string, exitCode: number, project: string, intentional: boolean) => void;
        }).__mockFireExit(sessionId, 0, projectId, true);
      }, { sessionId: SESSION_ID, projectId: PROJECT_ID });

      await expect.poll(() => readAutoCommandWarningTaskId(page)).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('clears warnings on a real project switch but not same-id HMR parity', async () => {
    const { browser, page } = await launchPage();

    try {
      await page.waitForFunction('typeof window.__mockFireProjectAutoOpened === "function"');
      await setAutoCommandWarning(page);

      await page.evaluate((projectId) => {
        (window as unknown as { __mockFireProjectAutoOpened: (id: string) => void })
          .__mockFireProjectAutoOpened(projectId);
      }, PROJECT_ID);
      expect(await readAutoCommandWarningTaskId(page)).toBe(TASK_ID);

      await page.evaluate((projectId) => {
        (window as unknown as { __mockFireProjectAutoOpened: (id: string) => void })
          .__mockFireProjectAutoOpened(projectId);
      }, PROJECT_B_ID);

      await expect.poll(() => readAutoCommandWarningTaskId(page)).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('clears the transient warning after archive succeeds', async () => {
    const { browser, page } = await launchPage();

    try {
      await setAutoCommandWarning(page);
      await page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: { getState: () => { archiveTask: (id: string) => void } };
          };
        }).__zustandStores;
        if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
        stores.board.getState().archiveTask(taskId);
      }, TASK_ID);

      await expect.poll(() => readAutoCommandWarningTaskId(page)).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('clears the transient warning after task deletion succeeds', async () => {
    const { browser, page } = await launchPage();

    try {
      await setAutoCommandWarning(page);
      await page.evaluate(async (taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: { getState: () => { deleteTask: (id: string) => Promise<void> } };
          };
        }).__zustandStores;
        if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
        await stores.board.getState().deleteTask(taskId);
      }, TASK_ID);

      await expect.poll(() => readAutoCommandWarningTaskId(page)).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('shows a task-local skipped warning, retains live delivery status, and dismisses without opening the card', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    const warning = 'Lane command could not be scheduled for this task.';

    try {
      await fireStatus(page, status('waiting', 1));
      await setAutoCommandWarning(page);
      await page.evaluate(`window.__mockTaskMoveResult = {
        ok: true,
        autoCommand: {
          kind: 'skipped',
          reason: 'no-active-main-session',
          warning: ${JSON.stringify(warning)}
        }
      }`);
      await page.evaluate(`window.__zustandStores.board.getState().moveTask({
        taskId: ${JSON.stringify(TASK_ID)},
        targetSwimlaneId: 'lane-2',
        targetPosition: 0
      }, true, ${JSON.stringify(PROJECT_ID)})`);

      const autoCommandWarning = card.locator('[data-testid="auto-command-warning"]');
      await expect(autoCommandWarning).toContainText(warning);
      await expect(autoCommandWarning).not.toContainText('Stale warning from the previous move.');
      await expect(card.locator('[data-testid="live-delivery-status"]')).toContainText('Waiting for agent input...');
      await expect(page.locator('[data-testid="toast"]').filter({ hasText: warning })).toHaveClass(/border-yellow-500\/50/);
      await expect(card).not.toContainText(COMMAND_CANARY);

      const dismissButton = autoCommandWarning.getByRole('button', { name: 'Dismiss auto-command warning' });
      const dismissBounds = await dismissButton.boundingBox();
      if (!dismissBounds) throw new Error('Expected dismiss button bounding box');
      expect(dismissBounds.width).toBeGreaterThanOrEqual(24);
      expect(dismissBounds.height).toBeGreaterThanOrEqual(24);

      const restingBackgroundColor = await dismissButton.evaluate((button) => getComputedStyle(button).backgroundColor);
      await dismissButton.hover();
      await expect.poll(async () => dismissButton.evaluate((button) => getComputedStyle(button).backgroundColor))
        .not.toBe(restingBackgroundColor);

      await dismissButton.click();

      await expect(autoCommandWarning).toHaveCount(0);
      await expect(card.locator('[data-testid="live-delivery-status"]')).toContainText('Waiting for agent input...');
      await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('replaces a warning on later status and dismisses only the warning task', async () => {
    const { browser, page } = await launchPage();
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    const otherTaskId = 'task-live-delivery-other';

    try {
      await setAutoCommandWarning(page);
      await setAutoCommandWarning(page, otherTaskId);
      await expect(card.locator('[data-testid="auto-command-warning"]')).toContainText('Lifecycle warning.');

      await fireStatus(page, status('waiting', 2));
      await expect(card.locator('[data-testid="auto-command-warning"]')).toHaveCount(0);
      expect(await readAutoCommandWarningTaskId(page)).toBeNull();
      expect(await readAutoCommandWarningTaskId(page, otherTaskId)).toBe(otherTaskId);

      await setAutoCommandWarning(page);
      const dismissButton = card
        .locator('[data-testid="auto-command-warning"]')
        .getByRole('button', { name: 'Dismiss auto-command warning' });
      await dismissButton.click();

      expect(await readAutoCommandWarningTaskId(page)).toBeNull();
      expect(await readAutoCommandWarningTaskId(page, otherTaskId)).toBe(otherTaskId);
    } finally {
      await browser.close();
    }
  });
});
