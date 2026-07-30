import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: readonly unknown[]) => unknown>();
const scheduler = { cancel: vi.fn(), scheduleKeystrokes: vi.fn() };
const prepareInjectionPlan = vi.fn(() => null);

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: readonly unknown[]) => unknown) => handlers.set(channel, handler)) },
  shell: { openPath: vi.fn(async () => '') },
}));
vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn(), copyFileSync: vi.fn() } }));
vi.mock('node:os', () => ({ default: { tmpdir: vi.fn(() => '/tmp') } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class { updateAppliedSettings = vi.fn(); } }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn() } }));
vi.mock('../../src/main/transition-engine/injection-plan', () => ({ prepareInjectionPlan }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({ restartSessionForSettingsChange: vi.fn() }));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({ runWithProjectLogContext: vi.fn((_name: string, operation: () => unknown) => operation()) }));

const beforeLane = {
  id: 'lane-finalize', name: 'Finalize', position: 4, color: '#123456', icon: 'check',
  auto_spawn: true, auto_command: '/go', agent_override: null, session_target: 'main',
  session_spawn_strategy: 'create_or_resume', model_override: null, effort_override: null,
};
const task = { id: 'task-board-live', session_id: 'session-board-live', agent: 'opencode' };
const swimlanes = {
  getById: vi.fn(() => beforeLane),
  update: vi.fn(), list: vi.fn(() => [beforeLane]), create: vi.fn(), delete: vi.fn(), reorder: vi.fn(),
};
const repos = {
  swimlanes,
  tasks: { list: vi.fn(() => [task]) },
  actions: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), listTransitions: vi.fn(), setTransitions: vi.fn(), getTransitionsFor: vi.fn() },
  attachments: { list: vi.fn(), add: vi.fn(), remove: vi.fn(), getDataUrl: vi.fn(), getById: vi.fn() },
};
vi.mock('../../src/main/ipc/helpers', () => ({ getProjectRepos: vi.fn(() => repos) }));

let registerBoardHandlers: typeof import('../../src/main/ipc/handlers/board').registerBoardHandlers;
let IPC: typeof import('../../src/shared/ipc-channels').IPC;

const context = {
  currentProjectId: 'project-board', currentProjectPath: '/project-board',
  sessionManager: { getSession: vi.fn(() => ({ status: 'running' })) },
  terminalSubmitScheduler: scheduler,
  boardConfigManager: { writeBack: vi.fn(), exists: vi.fn(), exportFromDb: vi.fn(), applyFileChange: vi.fn(), getShortcuts: vi.fn(), setShortcuts: vi.fn(), setDefaultBaseBranch: vi.fn(), getBoardProfiles: vi.fn(() => []) },
  projectRepo: { getById: vi.fn(() => ({ id: 'project-board' })) },
  mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
};

async function updateLane(input: Record<string, unknown>): Promise<void> {
  const handler = handlers.get(IPC.SWIMLANE_UPDATE);
  if (!handler) throw new Error('SWIMLANE_UPDATE handler was not registered');
  await handler(null, input);
}

describe('SWIMLANE_UPDATE live submission invalidation', () => {
  beforeAll(async () => {
    ({ registerBoardHandlers } = await import('../../src/main/ipc/handlers/board'));
    ({ IPC } = await import('../../src/shared/ipc-channels'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerBoardHandlers(context as never);
  });

  it.each([
    ['auto_spawn', { auto_spawn: false }],
    ['auto_command', { auto_command: '/changed' }],
    ['agent_override', { agent_override: 'claude' }],
    ['session_target', { session_target: 'isolated' }],
    ['session_spawn_strategy', { session_spawn_strategy: 'always_spawn_new' }],
    ['model_override', { model_override: 'opus' }],
    ['effort_override', { effort_override: 'high' }],
  ])('cancels pending live delivery when %s changes without rerunning a lane command', async (_field, change) => {
    swimlanes.update.mockReturnValue({ ...beforeLane, ...change });

    await updateLane({ id: beforeLane.id, ...change });

    expect(scheduler.cancel).toHaveBeenCalledWith(task.id);
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it.each([
    ['name', { name: 'Release' }],
    ['position', { position: 2 }],
    ['color', { color: '#abcdef' }],
    ['icon', { icon: 'rocket' }],
  ])('preserves pending live delivery when only visual %s changes', async (_field, change) => {
    swimlanes.update.mockReturnValue({ ...beforeLane, ...change });

    await updateLane({ id: beforeLane.id, ...change });

    expect(scheduler.cancel).not.toHaveBeenCalled();
    expect(prepareInjectionPlan).not.toHaveBeenCalled();
  });
});
