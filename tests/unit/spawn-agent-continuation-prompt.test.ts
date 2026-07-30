/**
 * Tests for continuationPrompt delivery through the real spawnAgent fallback
 * (src/main/ipc/helpers/agent-spawn.ts).
 *
 * The plan-exit auto-move respawns a session whose permission mode changed
 * (Planning -> Executing). The ExitPlanMode approval dialog dies with the
 * suspended PTY, so the listener passes a continuation prompt ("Your plan was
 * approved...") that must be delivered as the resumed session's next message.
 * Contract under test:
 *
 *   - The destination column's auto_command always wins over the continuation
 *     (it is the user's explicit per-column automation).
 *   - The continuation is RESUME-ONLY: a fresh spawn has no prior plan
 *     conversation for "proceed" to refer to.
 *   - Without a continuation (user drag), a resumed session with no
 *     auto_command resumes idle - pins the pre-existing respawn behavior.
 *
 * Harness mirrors spawn-agent-isolated-auto-command.test.ts: the real
 * spawnAgent runs end to end with injected engine/repos/context mocks, and
 * the resumePrompt is the 4th positional arg of resumeSuspendedSession.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, SessionRecord } from '../../src/shared/types';

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode/opencode-adapter';
import { resolveTargetAgent } from '../../src/main/transition-engine/agent-resolver';

const TASK_ID = 'task-aaa00001';
const EXECUTING_LANE_ID = 'lane-executing';
const FRESH_PTY_SESSION_ID = 'pty-fresh-1';
const CONTINUATION = 'Proceed with implementing the approved plan.';
const ACTION_CONTINUATION = 'opaque-action-continuation-7f3c';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: 'Do the thing',
    swimlane_id: EXECUTING_LANE_ID,
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/my-task',
    branch_name: 'my-task',
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'rec-main',
    task_id: TASK_ID,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-sid-1',
    pty_session_id: null,
    status: 'suspended',
    suspended_by: 'system',
    permission_mode: 'plan',
    started_at: '2026-01-01T00:00:00.000Z',
    exited_at: null,
    exit_code: null,
    duration_ms: null,
    cost_usd: null,
    input_tokens: null,
    output_tokens: null,
    model: null,
    effort: null,
    ...overrides,
  } as SessionRecord;
}

function makeDeps(args: {
  resumeRecord: SessionRecord | undefined;
  actionCreatedSession?: boolean;
}) {
  let postSpawnTask = makeTask({ session_id: FRESH_PTY_SESSION_ID });
  const getById = vi.fn();
  getById
    .mockReturnValueOnce(makeTask({ session_id: null }))
    .mockImplementation(() => postSpawnTask);

  const tasks = {
    getById,
    clearAutoCommand: vi.fn((taskId: string) => {
      if (taskId === TASK_ID) {
        postSpawnTask = { ...postSpawnTask, auto_command: null };
      }
    }),
  };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => args.resumeRecord ?? null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => args.resumeRecord),
  };
  const engine = {
    executeTransition: vi.fn(async (...callArgs: unknown[]) => {
      if (!args.actionCreatedSession) return;
      getById.mockReset();
      getById.mockReturnValue(postSpawnTask);
      const lifecycleObserver = callArgs[9];
      if (typeof lifecycleObserver === 'function') lifecycleObserver({ kind: 'resume' });
    }),
    resumeSuspendedSession: vi.fn(async () => {}),
  };
  const scheduleKeystrokes = vi.fn();
  const context = {
    terminalSubmitScheduler: { scheduleKeystrokes },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'acceptEdits' },
        git: { defaultBaseBranch: 'main' },
      })),
    },
    // resolveDefaultBaseBranch (git-stats-capture.ts) reads this for the
    // team-shared board default; undefined falls through to the git config
    // default above, matching resolveAutoCommandVars in agent-spawn.ts.
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
    sessionManager: {
      getSession: vi.fn(() => ({ status: 'running' })),
      snapshotNativeIdle: vi.fn(() => null),
      isWritable: vi.fn(() => true),
    },
  };

  return { tasks, sessionRepo, engine, scheduleKeystrokes, context };
}

async function runSpawn(
  toLane: Swimlane,
  deps: ReturnType<typeof makeDeps>,
  continuationPrompt: string | undefined,
) {
  return spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask({ swimlane_id: toLane.id, session_id: null }),
    fromSwimlaneId: 'lane-planning',
    toLane,
    // Plan-exit moves originate from a non-To-Do column, so the task
    // template is always skipped on this path.
    skipPromptTemplate: true,
    continuationPrompt,
  });
}

/** The resumePrompt is the 4th positional arg of resumeSuspendedSession. */
function resumePromptArg(engine: ReturnType<typeof makeDeps>['engine']): unknown {
  return engine.resumeSuspendedSession.mock.calls[0]?.[3];
}

describe('spawnAgent continuationPrompt delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resume with no auto_command: the continuation becomes the resume prompt', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID);
    const deps = makeDeps({ resumeRecord: makeRecord() });

    await runSpawn(executingLane, deps, CONTINUATION);

    expect(resumePromptArg(deps.engine)).toBe(CONTINUATION);
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('auto_command wins over the continuation', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/implement' });
    const deps = makeDeps({ resumeRecord: makeRecord() });

    const outcome = await runSpawn(executingLane, deps, CONTINUATION);

    expect(resumePromptArg(deps.engine)).toBe('/implement');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'scheduled', transport: 'legacy' });
  });

  it('fresh spawn: the continuation is NOT delivered (no prior conversation to continue)', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID);
    const deps = makeDeps({ resumeRecord: undefined });

    const outcome = await runSpawn(executingLane, deps, CONTINUATION);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'not-applicable' });
  });

  it('no continuation (user drag): a resumed session with no auto_command resumes idle', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID);
    const deps = makeDeps({ resumeRecord: makeRecord() });

    await runSpawn(executingLane, deps, undefined);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('per-task auto_command (MCP autoCommand param) wins over the lane auto_command', async () => {
    // effectiveAutoCommand = currentTask.auto_command ?? toLane.auto_command:
    // the task-level value, set only via kangentic_create_task's MCP-only
    // autoCommand param, must win for this task. Ported from the TASK_CREATE
    // handler tests when creates were consolidated onto spawnAgent - this is
    // where the precedence now lives for every entry point. Red-green:
    // reverting agent-spawn.ts to plain `toLane.auto_command` delivers
    // '/lane-command' here and fails.
    const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/lane-command' });
    const deps = makeDeps({ resumeRecord: makeRecord() });
    deps.tasks.getById.mockReset();
    deps.tasks.getById
      .mockReturnValueOnce(makeTask({ session_id: null, auto_command: '/task-command' }))
      .mockReturnValue(makeTask({ session_id: FRESH_PTY_SESSION_ID, auto_command: '/task-command' }));

    await runSpawn(executingLane, deps, undefined);

    expect(resumePromptArg(deps.engine)).toBe('/task-command');
  });

  it('OpenCode resume suppresses auto_command while preserving the explicit continuation prompt', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/implement' });
    const deps = makeDeps({ resumeRecord: makeRecord() });
    vi.mocked(resolveTargetAgent).mockReturnValueOnce({ agent: 'opencode', isHandoff: false });
    vi.mocked(agentRegistry.get).mockReturnValueOnce(new OpenCodeAdapter());

    await runSpawn(executingLane, deps, CONTINUATION);

    expect(resumePromptArg(deps.engine)).toBe(CONTINUATION);
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('forwards continuation to an action-created OpenCode resume without fallback or keystrokes', async () => {
    // Given
    const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/implement' });
    const deps = makeDeps({ resumeRecord: makeRecord(), actionCreatedSession: true });
    vi.mocked(resolveTargetAgent).mockReturnValueOnce({ agent: 'opencode', isHandoff: false });
    vi.mocked(agentRegistry.get).mockReturnValueOnce(new OpenCodeAdapter());

    // When
    const outcome = await runSpawn(executingLane, deps, ACTION_CONTINUATION);

    // Then
    expect(deps.engine.executeTransition.mock.calls[0]?.at(-1)).toBe(ACTION_CONTINUATION);
    expect(deps.engine.resumeSuspendedSession).not.toHaveBeenCalled();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'skipped',
      reason: 'resume-not-supported',
    });
  });

  it('OpenCode fresh spawn suppresses auto_command without removing the ordinary task prompt path', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/implement' });
    const deps = makeDeps({ resumeRecord: undefined });
    vi.mocked(resolveTargetAgent).mockReturnValueOnce({ agent: 'opencode', isHandoff: false });
    vi.mocked(agentRegistry.get).mockReturnValueOnce(new OpenCodeAdapter());

    const outcome = await runSpawn(executingLane, deps, undefined);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'skipped',
      reason: 'fresh-not-supported',
    });
  });
});
