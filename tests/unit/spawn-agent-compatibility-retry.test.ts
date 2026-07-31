import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompatibilityRequirementCoordinator } from '../../src/main/compatibility/compatibility-requirement-coordinator';
import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';
import type { AutoCommandImmediateOutcome } from '../../src/shared/auto-command-outcome';
import type { SessionRecord, Swimlane, Task } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  getLatestForTask: vi.fn<() => SessionRecord | undefined>(),
  getLatestForTaskByTypeAndIsolation: vi.fn<() => SessionRecord | undefined>(),
  getProjectRepos: vi.fn(),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn(() => ({
      sessionType: 'opencode_agent',
      getCompatibilityRequirement: () => ({
        acknowledgementId: 'opencode-non-default-v1',
        title: 'OpenCode compatibility acknowledgement',
        description: 'Acknowledge the non-default OpenCode permission mode.',
      }),
    })),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = () => mocks.getLatestForTask();
    getLatestForTaskByTypeAndIsolation = () => mocks.getLatestForTaskByTypeAndIsolation();
  },
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: () => mocks.getProjectRepos(),
}));

vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: async (_taskId: string, operation: () => Promise<unknown>) => operation(),
}));

const PROJECT_ID = 'project-compatibility';
const TASK_ID = 'task-compatibility';
const LANE_ID = 'lane-executing';
const OTHER_LANE_ID = 'lane-review';
const REQUIREMENT_ID = `compatibility:${PROJECT_ID}:${TASK_ID}:opencode-non-default-v1`;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID, display_id: 1,
    title: 'Initial task snapshot',
    description: 'Exercise compatibility retry.',
    swimlane_id: LANE_ID, position: 0, agent: null, session_id: null,
    worktree_path: null, branch_name: null, pr_number: null, pr_url: null,
    pr_state: null, head_sha: null, external_id: null, external_source: null, external_url: null,
    base_branch: null, use_worktree: null, labels: [], priority: 0,
    model_override: null, effort_override: null, agent_override: 'opencode', permission_mode: null,
    auto_command: null, profile_id: null, run_mode: 'column_settings', attachment_count: 0,
    detail_view_state: null, archived_at: null,
    created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID, name: 'Executing', description: null, role: null, position: 0,
    color: '#334155', icon: null, is_archived: false, is_ghost: false,
    permission_mode: 'plan', auto_spawn: true, auto_command: null, plan_exit_target_id: null,
    agent_override: null, model_override: null, effort_override: null, handoff_context: false,
    session_target: 'main', session_spawn_strategy: 'create_or_resume',
    created_at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

function makeHarness(input: { readonly initialTask: Task; readonly retryTask: Task; readonly retryLane: Swimlane }) {
  let acknowledged = false;
  const requirements = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
  const engine = {
    executeTransition: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  };
  const initialTasks = {
    getById: vi.fn(() => input.initialTask),
    update: vi.fn(),
    clearAutoCommand: vi.fn(),
  };
  const retryTasks = {
    getById: vi.fn(() => input.retryTask),
    update: vi.fn(),
    clearAutoCommand: vi.fn(),
  };
  const retrySwimlanes = {
    getById: vi.fn((swimlaneId: string) => swimlaneId === LANE_ID ? input.retryLane : undefined),
  };
  const context = {
    compatibilityRequirements: requirements,
    currentProjectId: PROJECT_ID,
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    projectRepo: {
      getById: vi.fn(() => ({
        id: PROJECT_ID,
        name: '',
        path: '/project',
        default_agent: 'claude',
        default_model: null,
        default_effort: null,
      })),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'acceptEdits' },
        git: { defaultBaseBranch: 'main' },
        compatibilityAcknowledgements: acknowledged ? { 'opencode-non-default-v1': true } : {},
      })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined), getBoardProfiles: vi.fn(() => []) },
    sessionManager: {
      getSession: vi.fn(),
      snapshotNativeIdle: vi.fn(),
      isWritable: vi.fn(),
      findLiveSessionByTaskId: vi.fn(),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
  };

  mocks.getProjectRepos.mockReturnValue({
    tasks: retryTasks,
    swimlanes: retrySwimlanes,
    attachments: { getPathsForTask: vi.fn(() => []) },
  });

  return {
    acknowledge: () => { acknowledged = true; },
    context,
    engine,
    initialTasks,
    requirements,
    retrySwimlanes,
    retryTasks,
  };
}

async function startBlockedSpawn(input: {
  readonly context: ReturnType<typeof makeHarness>['context'];
  readonly engine: ReturnType<typeof makeHarness>['engine'];
  readonly initialTask: Task;
  readonly initialTasks: ReturnType<typeof makeHarness>['initialTasks'];
  readonly lane: Swimlane;
  readonly mode?: { readonly kind: 'explicit-resume'; readonly resumePrompt?: string };
  readonly skipPromptTemplate?: boolean;
}): Promise<AutoCommandImmediateOutcome> {
  return spawnAgent({
    context: input.context as never,
    engine: input.engine as never,
    tasks: input.initialTasks as never,
    sessionRepo: {
      getLatestForTask: () => mocks.getLatestForTask(),
      getLatestForTaskByTypeAndIsolation: () => mocks.getLatestForTaskByTypeAndIsolation(),
    } as never,
    task: input.initialTask,
    fromSwimlaneId: 'lane-todo',
    toLane: input.lane,
    projectId: PROJECT_ID,
    projectPath: '/project',
    mode: input.mode,
    skipPromptTemplate: input.skipPromptTemplate,
  });
}

describe('spawnAgent compatibility retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLatestForTask.mockReturnValue(undefined);
    mocks.getLatestForTaskByTypeAndIsolation.mockReturnValue(undefined);
  });

  it('registers a blocked fresh OpenCode spawn, then retries from repository state after acknowledgement', async () => {
    // Given
    const initialTask = makeTask();
    const retryTask = makeTask({ title: 'Repository re-read task snapshot' });
    const retryLane = makeLane({ permission_mode: 'acceptEdits' });
    const harness = makeHarness({ initialTask, retryTask, retryLane });

    // When
    const outcome = await startBlockedSpawn({
      context: harness.context,
      engine: harness.engine,
      initialTask,
      initialTasks: harness.initialTasks,
      lane: makeLane(),
    });

    // Then
    expect(outcome).toMatchObject({ kind: 'compatibility-required' });
    expect(harness.requirements.get(PROJECT_ID, REQUIREMENT_ID)).not.toBeNull();
    expect(harness.engine.executeTransition).not.toHaveBeenCalled();
    expect(harness.engine.resumeSuspendedSession).not.toHaveBeenCalled();

    // When
    harness.acknowledge();
    const result = await harness.requirements.resolve(PROJECT_ID, REQUIREMENT_ID);

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(harness.retryTasks.getById).toHaveBeenCalledWith(TASK_ID);
    expect(harness.retrySwimlanes.getById).toHaveBeenCalledWith(LANE_ID);
    expect(harness.engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(harness.engine.executeTransition.mock.calls[0][0]).toBe(retryTask);
    expect(harness.engine.executeTransition.mock.calls[0][3]).toBe('acceptEdits');
    expect(harness.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(harness.engine.resumeSuspendedSession.mock.calls[0][0]).toBe(retryTask);
  });

  it('retries an explicit resume once when the re-read suspended task legitimately keeps session_id', async () => {
    // Given
    const initialTask = makeTask({ session_id: 'suspended-pty' });
    const retryTask = makeTask({ session_id: 'suspended-pty', title: 'Re-read suspended task' });
    const harness = makeHarness({ initialTask, retryTask, retryLane: makeLane() });

    // When
    const outcome = await startBlockedSpawn({
      context: harness.context,
      engine: harness.engine,
      initialTask,
      initialTasks: harness.initialTasks,
      lane: makeLane(),
      mode: { kind: 'explicit-resume', resumePrompt: 'Resume this session.' },
      skipPromptTemplate: true,
    });

    expect(outcome).toMatchObject({ kind: 'compatibility-required' });
    expect(harness.requirements.get(PROJECT_ID, REQUIREMENT_ID)).not.toBeNull();
    expect(harness.engine.executeTransition).not.toHaveBeenCalled();
    expect(harness.engine.resumeSuspendedSession).not.toHaveBeenCalled();

    harness.acknowledge();
    const first = harness.requirements.resolve(PROJECT_ID, REQUIREMENT_ID);
    const second = harness.requirements.resolve(PROJECT_ID, REQUIREMENT_ID);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Then
    expect(first).toBe(second);
    expect(firstResult).toEqual({ kind: 'resolved' });
    expect(secondResult).toEqual({ kind: 'resolved' });
    expect(harness.engine.executeTransition).not.toHaveBeenCalled();
    expect(harness.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(harness.engine.resumeSuspendedSession.mock.calls[0][0]).toBe(retryTask);
    expect(harness.engine.resumeSuspendedSession.mock.calls[0][2]).toBe(true);
    expect(harness.engine.resumeSuspendedSession.mock.calls[0][3]).toBe('Resume this session.');
  });

  it('supersedes an explicit resume retry when the task session_id changed before acknowledgement', async () => {
    // Given
    const initialTask = makeTask({ session_id: 'suspended-pty' });
    const retryTask = makeTask({ session_id: 'replacement-pty' });
    const harness = makeHarness({ initialTask, retryTask, retryLane: makeLane() });

    // When
    await startBlockedSpawn({
      context: harness.context,
      engine: harness.engine,
      initialTask,
      initialTasks: harness.initialTasks,
      lane: makeLane(),
      mode: { kind: 'explicit-resume' },
    });
    harness.acknowledge();
    const result = await harness.requirements.resolve(PROJECT_ID, REQUIREMENT_ID);

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(harness.engine.executeTransition).not.toHaveBeenCalled();
    expect(harness.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it.each(['running', 'queued'] as const)(
    'supersedes an explicit resume retry when a %s session is live for the task',
    async (status) => {
      // Given
      const initialTask = makeTask({ session_id: 'suspended-pty' });
      const retryTask = makeTask({ session_id: 'suspended-pty' });
      const harness = makeHarness({ initialTask, retryTask, retryLane: makeLane() });
      harness.context.sessionManager.findLiveSessionByTaskId.mockReturnValue({ status });

      // When
      await startBlockedSpawn({
        context: harness.context,
        engine: harness.engine,
        initialTask,
        initialTasks: harness.initialTasks,
        lane: makeLane(),
        mode: { kind: 'explicit-resume' },
      });
      harness.acknowledge();
      const result = await harness.requirements.resolve(PROJECT_ID, REQUIREMENT_ID);

      // Then
      expect(result).toEqual({ kind: 'resolved' });
      expect(harness.context.sessionManager.findLiveSessionByTaskId).toHaveBeenCalledWith(TASK_ID);
      expect(harness.engine.executeTransition).not.toHaveBeenCalled();
      expect(harness.engine.resumeSuspendedSession).not.toHaveBeenCalled();
    },
  );

  it('supersedes a fresh retry when the task moved to another lane before acknowledgement', async () => {
    // Given
    const initialTask = makeTask();
    const retryTask = makeTask({ swimlane_id: OTHER_LANE_ID });
    const harness = makeHarness({ initialTask, retryTask, retryLane: makeLane() });

    // When
    await startBlockedSpawn({
      context: harness.context,
      engine: harness.engine,
      initialTask,
      initialTasks: harness.initialTasks,
      lane: makeLane(),
    });
    harness.acknowledge();
    const result = await harness.requirements.resolve(PROJECT_ID, REQUIREMENT_ID);

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(harness.engine.executeTransition).not.toHaveBeenCalled();
    expect(harness.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });

  it('supersedes a fresh retry when a live session was attached before acknowledgement', async () => {
    // Given
    const initialTask = makeTask();
    const retryTask = makeTask({ session_id: 'live-pty' });
    const harness = makeHarness({ initialTask, retryTask, retryLane: makeLane() });

    // When
    await startBlockedSpawn({
      context: harness.context,
      engine: harness.engine,
      initialTask,
      initialTasks: harness.initialTasks,
      lane: makeLane(),
    });
    harness.acknowledge();
    const result = await harness.requirements.resolve(PROJECT_ID, REQUIREMENT_ID);

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(harness.engine.executeTransition).not.toHaveBeenCalled();
    expect(harness.engine.resumeSuspendedSession).not.toHaveBeenCalled();
  });
});
