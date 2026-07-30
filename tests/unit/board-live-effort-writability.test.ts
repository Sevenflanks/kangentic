import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: readonly unknown[]) => unknown>();
const cancel = vi.fn();
const isWritable = vi.fn(() => false);
const scheduleKeystrokes = vi.fn();
const updateAppliedSettings = vi.fn();
const prepareInjectionPlan = vi.fn(() => ({
  sequence: ['/effort xhigh'],
  verifier: null,
  verifiedPrefixLength: 1,
  needsRestartForModel: false,
  appliedSettings: { effort: 'xhigh' },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: readonly unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  shell: { openPath: vi.fn(async () => '') },
}));
vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn(), copyFileSync: vi.fn() } }));
vi.mock('node:os', () => ({ default: { tmpdir: vi.fn(() => '/tmp') } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    updateAppliedSettings = updateAppliedSettings;
  },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: vi.fn() } }));
vi.mock('../../src/main/transition-engine/injection-plan', () => ({ prepareInjectionPlan }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({ restartSessionForSettingsChange: vi.fn() }));
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, operation: () => unknown) => operation()),
}));

const beforeLane = {
  id: 'lane-executing', name: 'Executing', position: 2, color: '#123456', icon: 'play',
  auto_spawn: true, auto_command: '/go', agent_override: null, session_target: 'main',
  session_spawn_strategy: 'create_or_resume', model_override: null, effort_override: null,
};
const updatedLane = { ...beforeLane, effort_override: 'xhigh' };
const task = { id: 'task-board-live', session_id: 'session-board-live', agent: 'opencode' };
const repos = {
  swimlanes: {
    getById: vi.fn(() => beforeLane), update: vi.fn(() => updatedLane), list: vi.fn(() => [updatedLane]),
    create: vi.fn(), delete: vi.fn(), reorder: vi.fn(),
  },
  tasks: { list: vi.fn(() => [task]) },
  actions: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), listTransitions: vi.fn(),
    setTransitions: vi.fn(), getTransitionsFor: vi.fn(),
  },
  attachments: {
    list: vi.fn(), add: vi.fn(), remove: vi.fn(), getDataUrl: vi.fn(), getById: vi.fn(),
  },
};
vi.mock('../../src/main/ipc/helpers', () => ({ getProjectRepos: vi.fn(() => repos) }));

let registerBoardHandlers: typeof import('../../src/main/ipc/handlers/board').registerBoardHandlers;
let IPC: typeof import('../../src/shared/ipc-channels').IPC;

const context = {
  currentProjectId: 'project-board',
  currentProjectPath: '/project-board',
  sessionManager: { getSession: vi.fn(() => ({ status: 'running' })), isWritable },
  terminalSubmitScheduler: { cancel, scheduleKeystrokes },
  boardConfigManager: {
    writeBack: vi.fn(), exists: vi.fn(), exportFromDb: vi.fn(), applyFileChange: vi.fn(),
    getShortcuts: vi.fn(), setShortcuts: vi.fn(), setDefaultBaseBranch: vi.fn(),
  },
  projectRepo: { getById: vi.fn(() => ({ id: 'project-board' })) },
  mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
};

async function updateEffort(): Promise<void> {
  const handler = handlers.get(IPC.SWIMLANE_UPDATE);
  if (!handler) throw new Error('SWIMLANE_UPDATE handler was not registered');
  await handler(null, { id: beforeLane.id, effort_override: 'xhigh' });
}

describe('SWIMLANE_UPDATE live effort writability', () => {
  beforeAll(async () => {
    ({ registerBoardHandlers } = await import('../../src/main/ipc/handlers/board'));
    ({ IPC } = await import('../../src/shared/ipc-channels'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    isWritable.mockReturnValue(false);
    registerBoardHandlers(context as never);
  });

  it('skips live effort scheduling and persistence when the running session is not writable', async () => {
    await updateEffort();

    expect(cancel).toHaveBeenCalledWith(task.id);
    expect(isWritable).toHaveBeenCalledWith(task.session_id);
    expect(cancel.mock.invocationCallOrder[0])
      .toBeLessThan(isWritable.mock.invocationCallOrder[0]);
    expect(scheduleKeystrokes).not.toHaveBeenCalled();
    expect(updateAppliedSettings).not.toHaveBeenCalled();
  });

  it('preserves live effort scheduling and persistence when the running session is writable', async () => {
    isWritable.mockReturnValue(true);

    await updateEffort();

    expect(scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(scheduleKeystrokes).toHaveBeenCalledWith(
      task.id,
      task.session_id,
      ['/effort xhigh'],
      { verifier: null, verifiedPrefixLength: 1 },
    );
    expect(updateAppliedSettings).toHaveBeenCalledTimes(1);
    expect(updateAppliedSettings).toHaveBeenCalledWith(task.session_id, { effort: 'xhigh' });
  });
});
