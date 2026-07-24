import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_ID = 'project-live-delivery';
const TASK_ID = 'task-live-delivery';
const SESSION_ID = 'session-live-delivery';
const COMMAND_CANARY = 'private-command-canary';

async function launchPage(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'Live delivery', path: '/mock/live-delivery', default_agent: 'opencode', last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        state.swimlanes.push(Object.assign({}, lane, {
          id: 'lane-' + index,
          position: index,
          created_at: ts,
          auto_command: index === 1 ? '${COMMAND_CANARY}' : lane.auto_command,
        }));
      });
      state.sessions.push({ id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 1, status: 'running', shell: 'bash', cwd: '/mock/live-delivery', startedAt: ts, exitCode: null });
      state.tasks.push({ id: '${TASK_ID}', title: 'Live delivery task', description: '', swimlane_id: 'lane-1', position: 0, agent: 'opencode', session_id: '${SESSION_ID}', worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null, labels: [], priority: 0, attachment_count: 0, archived_at: null, created_at: ts, updated_at: ts });
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

test.describe('Live delivery status', () => {
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
});
