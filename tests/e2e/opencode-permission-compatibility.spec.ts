import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createProject, createTask, createTempProject, cleanupTempProject, cleanupTestDataDir, closeApp, getSwimlaneIds, getTaskIdByTitle, getTestDataDir, launchApp, mockAgentPath, moveTaskIpc, setProjectDefaultAgent } from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const TEST_NAME = 'opencode-permission-compatibility';
const runId = Date.now();

test.describe('OpenCode permission compatibility gate', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
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
        compatibilityAcknowledgements: { 'unrelated-notice': true },
      }),
    );

    const result = await launchApp({ dataDir, acknowledgeOpenCodeRuntimeDefault: false });
    app = result.app;
    page = result.page;
    await createProject(page, `OpenCode Compatibility Test ${runId}`, tmpDir);
    await setProjectDefaultAgent(page, 'opencode');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('blocks OpenCode spawn behind compatibility-required while preserving unrelated acknowledgements', async () => {
    const title = `OpenCode Compatibility Gate ${runId}`;

    await createTask(page, title, 'Verify OpenCode gate blocks session creation');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);
    const currentProjectId = await page.evaluate(async () => (await window.electronAPI.projects.getCurrent())?.id ?? null);
    if (!currentProjectId) throw new Error('OpenCode compatibility E2E requires a current project');

    const moveResult = await moveTaskIpc(page, taskId, swimlaneIds.planning);
    expect(moveResult).toMatchObject({
      ok: true,
      autoCommand: {
        kind: 'compatibility-required',
        requirement: {
          requirementId: `compatibility:${currentProjectId}:${taskId}:opencode-runtime-default-v1`,
          projectId: currentProjectId,
          taskId,
          acknowledgementId: 'opencode-runtime-default-v1',
        },
      },
    });

    await expect.poll(async () => {
      return page.evaluate(async (id) => {
        const tasks = await window.electronAPI.tasks.list();
        return tasks.find((task) => task.id === id)?.swimlane_id ?? null;
      }, taskId);
    }, { timeout: 15000 }).toBe(swimlaneIds.planning);

    await expect.poll(async () => {
      return page.evaluate(async (projectId) => {
        const requirements = await window.electronAPI.compatibility.list(projectId);
        return requirements;
      }, currentProjectId);
    }, { timeout: 15000 }).toContainEqual(expect.objectContaining({
      requirementId: `compatibility:${currentProjectId}:${taskId}:opencode-runtime-default-v1`,
      projectId: currentProjectId,
      taskId,
      acknowledgementId: 'opencode-runtime-default-v1',
    }));

    await expect.poll(async () => {
      return page.evaluate(async (id) => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.some((session) => session.taskId === id);
      }, taskId);
    }, { timeout: 5000 }).toBe(false);

    const config: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
    expect(config).toMatchObject({
      compatibilityAcknowledgements: { 'unrelated-notice': true },
    });
    expect(config).not.toHaveProperty('compatibilityAcknowledgements.opencode-runtime-default-v1');
  });
});
