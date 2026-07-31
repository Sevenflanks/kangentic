import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;
const PROJECT_A_ID = 'project-compatibility-a';
const PROJECT_B_ID = 'project-compatibility-b';
const TASK_A_ID = 'task-compatibility-a';
const TASK_B_ID = 'task-compatibility-b';
const REQUIREMENT_A_ID = 'requirement-compatibility-a';

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push(
        { id: '${PROJECT_A_ID}', name: 'Project Alpha', path: '/mock/alpha', github_url: null, default_agent: 'opencode', position: 0, last_opened: timestamp, created_at: timestamp },
        { id: '${PROJECT_B_ID}', name: 'Project Beta', path: '/mock/beta', github_url: null, default_agent: 'opencode', position: 1, last_opened: timestamp, created_at: timestamp }
      );
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        state.swimlanes.push(Object.assign({}, lane, { id: 'lane-compatibility-' + index, position: index, created_at: timestamp }));
      });
      state.tasks.push(
        { id: '${TASK_A_ID}', projectId: '${PROJECT_A_ID}', display_id: 1, title: 'Alpha compatibility task', description: '', swimlane_id: 'lane-compatibility-0', position: 0, agent: 'opencode', session_id: null, worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null, labels: [], priority: 0, attachment_count: 0, archived_at: null, created_at: timestamp, updated_at: timestamp },
        { id: '${TASK_B_ID}', projectId: '${PROJECT_B_ID}', display_id: 2, title: 'Beta task', description: '', swimlane_id: 'lane-compatibility-0', position: 0, agent: 'opencode', session_id: null, worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, base_branch: null, labels: [], priority: 0, attachment_count: 0, archived_at: null, created_at: timestamp, updated_at: timestamp }
      );
      state.compatibilityRequirementsByProject['${PROJECT_A_ID}'] = [{
        requirementId: '${REQUIREMENT_A_ID}',
        projectId: '${PROJECT_A_ID}',
        taskId: '${TASK_A_ID}',
        acknowledgementId: 'opencode-runtime-default-v1',
        title: 'OpenCode runtime default',
        description: 'OpenCode resolves plan to its runtime-configured default approval configuration instead of Kangentic permission-mode overrides.',
        actionLabel: 'Acknowledge runtime-configured default'
      }];
      state.compatibilityRequirementsByProject['${PROJECT_B_ID}'] = [];
      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

async function launchPage(cardDensity: 'default' | 'compact' | 'comfortable' = 'default'): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript({ content: `window.__mockConfigOverrides = { cardDensity: '${cardDensity}' };` });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig());
  await page.goto(VITE_URL);
  await page.waitForSelector(`[data-task-id="${TASK_A_ID}"]`);
  return { browser, page };
}

function requirementAlert(page: Page) {
  return page.locator(`[data-task-id="${TASK_A_ID}"] [data-testid="compatibility-requirement"]`);
}

test.describe('OpenCode compatibility acknowledgement', () => {
  test('retains the requirement explanation and accessible acknowledgement action at comfortable density', async () => {
    const { browser, page } = await launchPage('comfortable');
    try {
      const alert = requirementAlert(page);
      await expect(alert).toContainText('OpenCode resolves plan to its runtime-configured default approval configuration instead of Kangentic permission-mode overrides.');
      await expect(alert.getByRole('button', { name: 'Acknowledge runtime-configured default' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('removes the requirement after a successful acknowledgement', async () => {
    const { browser, page } = await launchPage();
    try {
      await requirementAlert(page).getByRole('button', { name: 'Acknowledge runtime-configured default' }).click();

      await expect(requirementAlert(page)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('retains a retryable requirement when acknowledgement retry fails', async () => {
    const { browser, page } = await launchPage();
    try {
      await page.evaluate(() => {
        (window as unknown as { __mockCompatibilityResolveResult: { kind: 'retry-failed' } }).__mockCompatibilityResolveResult = { kind: 'retry-failed' };
      });
      const action = requirementAlert(page).getByRole('button', { name: 'Acknowledge runtime-configured default' });
      await action.click();

      await expect(requirementAlert(page)).toBeVisible();
      await expect(action).toBeEnabled();
    } finally {
      await browser.close();
    }
  });

  test('keeps the compact-card requirement visible and resolves it by keyboard with its captured project identity', async () => {
    const testInfo = test.info();
    const { browser, page } = await launchPage('compact');
    try {
      const alert = requirementAlert(page);
      const action = alert.getByRole('button', { name: 'Acknowledge runtime-configured default' });
      await expect(alert).toContainText('OpenCode resolves plan to its runtime-configured default approval configuration instead of Kangentic permission-mode overrides.');
      await expect(action).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('compact-normal.png') });

      await page.setViewportSize({ width: 480, height: 900 });
      await alert.scrollIntoViewIfNeeded();
      await expect(alert).toBeVisible();
      await expect(action).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('compact-narrow.png') });

      await page.evaluate(() => {
        (window as unknown as { __mockCompatibilityResolveDeferred: boolean }).__mockCompatibilityResolveDeferred = true;
      });
      await action.press('Enter');
      await page.waitForFunction('typeof window.__mockCompatibilityResolve === "function"');

      await page.getByTestId(`project-row-${PROJECT_B_ID}`).click();
      await expect(page.locator(`[data-task-id="${TASK_B_ID}"]`)).toBeVisible();
      await expect(page.locator('[data-testid="compatibility-requirement"]')).toHaveCount(0);

      await page.evaluate(() => {
        (window as unknown as { __mockCompatibilityResolve: () => void }).__mockCompatibilityResolve();
      });
      const calls = await page.evaluate(() => {
        return (window as unknown as {
          electronAPI: { compatibility: { __resolveCalls: Array<{ projectId: string; requirementId: string }> } };
        }).electronAPI.compatibility.__resolveCalls;
      });
      expect(calls).toEqual([{ projectId: PROJECT_A_ID, requirementId: REQUIREMENT_A_ID }]);
      await expect(page.locator('[data-testid="compatibility-requirement"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

});
