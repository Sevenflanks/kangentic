import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompatibilityRequirementCoordinator } from '../../src/main/compatibility/compatibility-requirement-coordinator';
import { autoSpawnTasks } from '../../src/main/transition-engine/session-startup/auto-spawn';
import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup/resume-suspended';
import type { SessionRecord, Swimlane, Task } from '../../src/shared/types';

type PrepareInput = {
  readonly task: { readonly id: string };
  readonly swimlane: { readonly name: string } | null;
  readonly resume: { readonly agentSessionId: string } | null;
  readonly effectiveConfig: { readonly compatibilityAcknowledgements: Readonly<Record<string, boolean>> };
};

const PROJECT_ID = 'project-startup-compatibility';
const LANE_ID = 'lane-startup';
const ACKNOWLEDGEMENT_ID = 'opencode-non-default-v1';
const taskRows: Task[] = [];
const sessionRows: SessionRecord[] = [];
const lanes: Swimlane[] = [];
const preparationCalls: PrepareInput[] = [];
let acknowledged = false;

const mocks = vi.hoisted(() => ({
  prepareAgentSpawn: vi.fn(),
  taskGetById: vi.fn(),
  taskList: vi.fn(),
  taskUpdate: vi.fn(),
  sessionGetByTask: vi.fn(),
  sessionGetLatestByTypeAndIsolation: vi.fn(),
  sessionGetResumable: vi.fn(),
  sessionInsert: vi.fn(),
  swimlaneGetById: vi.fn(),
  swimlaneList: vi.fn(),
  retireRecord: vi.fn(),
}));

function taskById(taskId: string): Task | undefined {
  return taskRows.find((task) => task.id === taskId);
}

function latestRecord(records: readonly SessionRecord[]): SessionRecord | undefined {
  return records.reduce<SessionRecord | undefined>(
    (latest, record) => latest === undefined || record.started_at > latest.started_at ? record : latest,
    undefined,
  );
}

function latestSessionForTask(taskId: string): SessionRecord | undefined {
  return latestRecord(sessionRows.filter((record) => record.task_id === taskId));
}

function latestSessionForTaskByTypeAndIsolation(
  taskId: string,
  sessionType: string,
  isolatedSwimlaneId: string | null,
): SessionRecord | undefined {
  return latestRecord(sessionRows.filter((record) => (
    record.task_id === taskId
    && record.session_type === sessionType
    && record.isolated_swimlane_id === isolatedSwimlaneId
  )));
}

function laneById(laneId: string): Swimlane | undefined {
  return lanes.find((lane) => lane.id === laneId);
}

function requirementFor(taskId: string) {
  return {
    requirementId: `compatibility:${PROJECT_ID}:${taskId}:${ACKNOWLEDGEMENT_ID}`,
    projectId: PROJECT_ID,
    taskId,
    acknowledgementId: ACKNOWLEDGEMENT_ID,
    title: 'OpenCode compatibility acknowledgement',
    description: 'Acknowledge the non-default OpenCode permission mode.',
  };
}

function preparedSpawn() {
  return {
    adapter: { name: 'opencode', sessionType: 'opencode_agent' },
    agent: 'opencode',
    command: 'opencode run',
    cwd: '/project',
    sessionRecordId: 'prepared-record-id',
    agentSessionId: null,
    permissionMode: 'plan',
    statusOutputPath: '/project/status.json',
    eventsOutputPath: '/project/events.jsonl',
    extraEnv: null,
    appliedModel: null,
    appliedEffort: null,
  };
}

vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) }, existsSync: vi.fn(() => true) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));
vi.mock('../../src/main/transition-engine/session-startup/timing', () => ({ startStartupTimer: vi.fn(() => vi.fn()) }));
vi.mock('../../src/main/transition-engine/session-startup/prepare-spawn', () => ({ prepareAgentSpawn: mocks.prepareAgentSpawn }));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  retireRecord: (...args: readonly unknown[]) => mocks.retireRecord(...args),
  markRecordSuspended: vi.fn(() => true),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = (laneId?: string) => mocks.taskList(laneId);
    getById = (taskId: string) => mocks.taskGetById(taskId);
    update = (input: unknown) => mocks.taskUpdate(input);
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getResumable = () => mocks.sessionGetResumable();
    getOrphaned = (): SessionRecord[] => [];
    getInterruptedExited = (): SessionRecord[] => [];
    markAllRunningAsOrphaned = vi.fn();
    markRunningAsOrphanedExcluding = vi.fn();
    getLatestForTask = (taskId: string) => mocks.sessionGetByTask(taskId);
    getLatestForTaskByTypeAndIsolation = (taskId: string, sessionType: string, isolatedSwimlaneId: string | null) => (
      mocks.sessionGetLatestByTypeAndIsolation(taskId, sessionType, isolatedSwimlaneId)
    );
    getUserPausedTaskIds = () => new Set<string>();
    insert = (record: unknown) => mocks.sessionInsert(record);
    updateAppliedSettings = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = () => mocks.swimlaneList();
    getById = (laneId: string) => mocks.swimlaneGetById(laneId);
  },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-startup', display_id: 1, title: 'Compatibility startup task', description: '',
    swimlane_id: LANE_ID, position: 0, agent: null, session_id: null,
    worktree_path: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, head_sha: null,
    external_id: null, external_source: null, external_url: null, base_branch: null, use_worktree: null,
    labels: [], priority: 0, model_override: null, effort_override: null, agent_override: 'opencode',
    permission_mode: null, auto_command: null, profile_id: null, run_mode: 'column_settings',
    attachment_count: 0, detail_view_state: null, archived_at: null,
    created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

function makeLane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID, name: 'Executing', description: null, role: null, position: 0, color: '#334155', icon: null,
    is_archived: false, is_ghost: false, permission_mode: 'plan', auto_spawn: true, auto_command: null,
    plan_exit_target_id: null, agent_override: null, model_override: null, effort_override: null,
    handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume',
    created_at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

function makeRecord(taskId: string): SessionRecord {
  return {
    id: 'suspended-record', task_id: taskId, session_type: 'opencode_agent', isolated_swimlane_id: null,
    agent_session_id: 'opencode-native-session', command: 'opencode --resume', cwd: '/project',
    permission_mode: 'plan', prompt: null, status: 'suspended', exit_code: null,
    started_at: '2026-07-31T00:00:00.000Z', suspended_at: '2026-07-31T01:00:00.000Z', exited_at: null,
    suspended_by: 'system', total_cost_usd: null, total_input_tokens: null, total_output_tokens: null,
    model_id: null, model_display_name: null, applied_model: null, applied_effort: null,
    total_duration_ms: null, tool_call_count: null, lines_added: null, lines_removed: null, files_changed: null,
    tool_breakdown: null, compaction_count: 0,
  };
}

function makeSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    hasSessionForTask: vi.fn(() => false),
    getShell: vi.fn(async () => '/bin/sh'),
    registerSuspendedPlaceholder: vi.fn(),
    spawn: vi.fn(async () => ({ id: 'spawned-pty' })),
  };
}

function makeConfigManager() {
  return {
    load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart: true } })),
    getEffectiveConfig: vi.fn(() => ({
      agent: { permissionMode: 'acceptEdits', cliPaths: {} },
      compatibilityAcknowledgements: acknowledged ? { [ACKNOWLEDGEMENT_ID]: true } : {},
    })),
  };
}

describe('startup compatibility retry', () => {
  beforeEach(() => {
    acknowledged = false;
    taskRows.splice(0);
    sessionRows.splice(0);
    lanes.splice(0);
    preparationCalls.splice(0);
    vi.clearAllMocks();
    mocks.taskList.mockImplementation((laneId?: string) => laneId === undefined ? [...taskRows] : taskRows.filter((task) => task.swimlane_id === laneId));
    mocks.taskGetById.mockImplementation((taskId: string) => taskById(taskId));
    mocks.taskUpdate.mockImplementation((input: { readonly id: string; readonly session_id?: string | null }) => {
      const task = taskById(input.id);
      if (task !== undefined && input.session_id !== undefined) task.session_id = input.session_id;
      return task;
    });
    mocks.sessionGetResumable.mockImplementation(() => sessionRows.filter((record) => record.status === 'suspended'));
    mocks.sessionGetByTask.mockImplementation((taskId: string) => latestSessionForTask(taskId));
    mocks.sessionGetLatestByTypeAndIsolation.mockImplementation(
      (taskId: string, sessionType: string, isolatedSwimlaneId: string | null) => (
        latestSessionForTaskByTypeAndIsolation(taskId, sessionType, isolatedSwimlaneId)
      ),
    );
    mocks.swimlaneList.mockImplementation(() => [...lanes]);
    mocks.swimlaneGetById.mockImplementation((laneId: string) => laneById(laneId));
    mocks.prepareAgentSpawn.mockImplementation(async (input: PrepareInput) => {
      preparationCalls.push(input);
      if (!input.effectiveConfig.compatibilityAcknowledgements[ACKNOWLEDGEMENT_ID]) {
        return { ok: false as const, reason: 'compatibility-required' as const, requirement: requirementFor(input.task.id) };
      }
      return { ok: true as const, data: preparedSpawn() };
    });
  });

  it('removes a fresh-start requirement without spawning or mutating either blocked task', async () => {
    // Given
    const firstTask = makeTask();
    const otherTask = makeTask({ id: 'task-other', title: 'Other blocked task' });
    taskRows.push(firstTask, otherTask);
    lanes.push(makeLane());
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager();

    // When
    const initialSpawned = await autoSpawnTasks(
      PROJECT_ID, '/project', sessionManager as never, configManager as never,
      'opencode', null, null, null, undefined, { compatibilityRequirements: coordinator },
    );

    // Then
    expect(initialSpawned).toBe(0);
    expect(firstTask.session_id).toBeNull();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(coordinator.list(PROJECT_ID)).toHaveLength(2);

    // When
    const initialRequirementIds = coordinator.list(PROJECT_ID).map((entry) => entry.requirementId);
    acknowledged = true;
    const result = await coordinator.resolve(PROJECT_ID, requirementFor(firstTask.id).requirementId);

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(initialRequirementIds).toHaveLength(2);
    expect(coordinator.list(PROJECT_ID)).toEqual([requirementFor(otherTask.id)]);
    expect(preparationCalls.map((input) => input.task.id)).toEqual([firstTask.id, otherTask.id]);
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(mocks.sessionInsert).not.toHaveBeenCalled();
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
    expect(firstTask.session_id).toBeNull();
    expect(otherTask.session_id).toBeNull();
  });

  it('removes a suspended-recovery requirement while preserving its record and placeholder for manual resume', async () => {
    // Given
    const task = makeTask({ session_id: 'stale-pty' });
    const record = makeRecord(task.id);
    taskRows.push(task);
    sessionRows.push(record);
    lanes.push(makeLane());
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    const sessionManager = makeSessionManager();
    const configManager = makeConfigManager();

    // When
    const initialResumed = await resumeSuspendedSessions(
      PROJECT_ID, '/project', sessionManager as never, configManager as never,
      'opencode', null, null, null, undefined, { compatibilityRequirements: coordinator },
    );

    // Then
    expect(initialResumed).toBe(0);
    expect(mocks.retireRecord).not.toHaveBeenCalled();
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledWith({ taskId: task.id, projectId: PROJECT_ID, cwd: '/project' });
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(coordinator.get(PROJECT_ID, requirementFor(task.id).requirementId)).not.toBeNull();

    // When
    acknowledged = true;
    const result = await coordinator.resolve(PROJECT_ID, requirementFor(task.id).requirementId);

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(coordinator.list(PROJECT_ID)).toEqual([]);
    expect(preparationCalls).toHaveLength(1);
    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(mocks.sessionInsert).not.toHaveBeenCalled();
    expect(mocks.retireRecord).not.toHaveBeenCalled();
    expect(sessionRows).toEqual([record]);
    expect(sessionManager.registerSuspendedPlaceholder).toHaveBeenCalledTimes(1);
    expect(mocks.taskUpdate).toHaveBeenCalledTimes(1);
  });
});
