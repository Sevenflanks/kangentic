import { vi } from 'vitest';
import type { NativeIdleSnapshot } from '../../../src/main/activity-engine/native-idle-evidence';
import type { NativeIdleRequest } from '../../../src/main/transition-engine/native-idle-waiter';
import type { Swimlane, Task } from '../../../src/shared/types';

const WAIT_POLICY = {
  mode: 'wait-for-native-idle',
  timeoutMs: 120_000,
  cancelOnUserInput: true,
  sendCtrlC: false,
} as const;

export const scheduler = {
  cancel: vi.fn(),
  scheduleKeystrokes: vi.fn(),
  scheduleNativeIdleSubmission: vi.fn<(request: NativeIdleRequest) => void>(),
};

export const sessionManager = {
  getSession: vi.fn(),
  snapshotNativeIdle: vi.fn(),
  suspend: vi.fn(async () => undefined),
  removeByTaskId: vi.fn(),
  killByTaskId: vi.fn(),
  listSessions: vi.fn(() => []),
};

export const updateAppliedSettings = vi.fn((
  _sessionId: string,
  settings: { readonly effort?: string },
) => {
  state.record = {
    ...state.record,
    ...(settings.effort !== undefined ? { applied_effort: settings.effort } : {}),
  };
});
export const spawnAgent = vi.fn(async () => undefined);

export const state: {
  task: Task;
  sourceLane: Swimlane;
  destinationLane: Swimlane;
  record: Record<string, unknown>;
  snapshot: NativeIdleSnapshot | null;
  sessionExists: boolean;
  settingsSequence: string[];
  project: Record<string, unknown>;
} = {
  task: makeTask(),
  sourceLane: makeLane('lane-source'),
  destinationLane: makeLane('lane-91', { name: 'Finalize', auto_command: '/go' }),
  record: makeRecord(),
  snapshot: makeSnapshot(),
  sessionExists: true,
  settingsSequence: [],
  project: { id: 'proj-test', default_agent: 'opencode', default_model: null, default_effort: null },
};

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-live-1', display_id: 1, title: 'Task', description: '',
    swimlane_id: 'lane-source', position: 0, agent: 'opencode',
    session_id: 'pty-live-1', worktree_path: '/worktree', branch_name: 'branch',
    pr_number: null, pr_url: null, base_branch: null, use_worktree: null,
    labels: [], priority: 0, attachment_count: 0, archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeLane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id, name: id, role: null, position: 0, color: '#888', icon: null,
    is_archived: false, is_ghost: false, permission_mode: null,
    auto_spawn: true, auto_command: null, plan_exit_target_id: null,
    agent_override: null, model_override: null, effort_override: null,
    handoff_context: false, session_target: 'main',
    session_spawn_strategy: 'create_or_resume', created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'record-live-1', task_id: 'task-live-1', isolated_swimlane_id: null,
    agent_session_id: 'durable-agent-id', status: 'running',
    started_at: '2026-01-01T00:00:00.000Z', session_type: 'opencode_agent',
    applied_model: null, applied_effort: null, ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<NativeIdleSnapshot> = {}): NativeIdleSnapshot {
  return {
    rootNativeSessionId: 'private-native-id', sessionGeneration: 3,
    inputGeneration: 5, cleanIdle: null, errorLatched: false, ...overrides,
  };
}

export function resetHarness(): void {
  vi.clearAllMocks();
  state.task = makeTask();
  state.sourceLane = makeLane('lane-source');
  state.destinationLane = makeLane('lane-91', { name: 'Finalize', auto_command: '/go' });
  state.record = makeRecord();
  state.snapshot = makeSnapshot();
  state.sessionExists = true;
  state.settingsSequence = [];
  state.project = { id: 'proj-test', default_agent: 'opencode', default_model: null, default_effort: null };
  sessionManager.getSession.mockImplementation((id: string) =>
    state.sessionExists && id === state.task.session_id ? { status: 'running' } : undefined);
  sessionManager.snapshotNativeIdle.mockImplementation(() => state.snapshot);
}

const tasks = {
  getById: vi.fn(() => state.task),
  move: vi.fn((input: { targetSwimlaneId: string; targetPosition: number }) => {
    state.task = { ...state.task, swimlane_id: input.targetSwimlaneId, position: input.targetPosition };
  }),
  update: vi.fn((input: Partial<Task>) => { state.task = { ...state.task, ...input }; }),
  list: vi.fn(() => [state.task]),
  archive: vi.fn(),
};

const swimlanes = {
  getById: vi.fn((id: string) => id === state.destinationLane.id ? state.destinationLane : state.sourceLane),
  list: vi.fn(() => [state.sourceLane, state.destinationLane]),
};

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('simple-git', () => ({ simpleGit: vi.fn(() => ({ diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })) })), default: vi.fn(() => ({})) }));
vi.mock('../../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => state.record);
    getLatestForTaskByTypeAndIsolation = vi.fn(() => state.record);
    updateAppliedSettings = updateAppliedSettings;
    updateGitStats = vi.fn();
  },
}));
vi.mock('../../../src/main/db/repositories/usage-history-repository', () => ({ UsageHistoryRepository: class {} }));
vi.mock('../../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));
vi.mock('../../../src/main/git/worktree-manager', () => ({ WorktreeManager: class { static scheduleBackgroundPrune = vi.fn(); } }));
vi.mock('../../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../../src/main/transition-engine/session-lifecycle', () => ({ markRecordExited: vi.fn(), markRecordSuspended: vi.fn() }));
vi.mock('../../../src/main/transition-engine/spawn-progress', () => ({ emitSpawnProgress: vi.fn(), emitSpawnWaiting: vi.fn(), clearSpawnProgress: vi.fn(), createProgressCallback: vi.fn(() => vi.fn()), getInFlightSpawnProgress: vi.fn(() => ({})) }));
vi.mock('../../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../../src/main/ipc/handlers/session-metrics', () => ({ captureSessionMetrics: vi.fn(), refineTranscriptTokens: vi.fn(), refineTranscriptToolCounts: vi.fn() }));
vi.mock('../../../src/main/agent/shared', () => ({ interpolateTemplate: vi.fn((template: string) => template), resolveBridgeScript: vi.fn(() => '/bridge.js'), execVersion: vi.fn(async () => '1') }));
vi.mock('../../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn((name: string) => ({
    name,
    liveSubmissionPolicy: name === 'opencode' ? WAIT_POLICY : { mode: 'interrupt-immediately', sendCtrlC: true },
    getInjectionSequence: vi.fn(({ effortChanged }: { readonly effortChanged: boolean }) =>
      effortChanged ? state.settingsSequence : []),
  })) },
}));
vi.mock('../../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: vi.fn(() => ({ tasks, swimlanes, actions: { getTransitionsFor: vi.fn(() => []) }, attachments: { deleteByTaskId: vi.fn() } })),
  ensureTaskWorktree: vi.fn(async () => undefined), ensureTaskBranchCheckout: vi.fn(async () => undefined),
  spawnAgent, createTransitionEngine: vi.fn(() => ({})), buildAutoCommandVars: vi.fn(() => ({})),
  cleanupTaskResources: vi.fn(async () => undefined), deleteTaskWorktree: vi.fn(async () => true), autoSpawnForTask: vi.fn(async () => undefined),
}));
vi.mock('../../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn() }));

export const context = {
  currentProjectId: 'proj-test', currentProjectPath: '/project',
  mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  sessionManager, terminalSubmitScheduler: scheduler,
  configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' }, agent: { permissionMode: 'auto' } })) },
  boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
  projectRepo: { getById: vi.fn(() => state.project) },
};
