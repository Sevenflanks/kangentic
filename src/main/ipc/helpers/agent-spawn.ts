import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { ActionRepository } from '../../db/repositories/action-repository';
import { AttachmentRepository } from '../../db/repositories/attachment-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { HandoffRepository } from '../../db/repositories/handoff-repository';
import { TransitionEngine } from '../../transition-engine/transition-engine';
import { getProjectDb } from '../../db/database';
import { interpolateTemplate } from '../../agent/shared';
import { agentRegistry } from '../../agent/agent-registry';
import {
  evaluateAutoCommandDisposition,
  finalizeAutoCommandGate,
} from '../../agent/auto-command-disposition';
import { buildSessionHistoryReference } from '../../agent/handoff/session-history-reference';
import { DEFAULT_AGENT } from '../../../shared/types';
import type { AutoCommandImmediateOutcome } from '../../../shared/auto-command-outcome';
import type { Task, Swimlane, Project } from '../../../shared/types';
import type {
  AutoCommandDisposition,
  AutoCommandGateResult,
  AutoCommandLifecycle,
} from '../../agent/auto-command-disposition';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { IpcContext } from '../ipc-context';
import { isAbortError } from '../../../shared/abort-utils';
import { runSpawnPreamble } from '../../transition-engine/spawn-preamble';
import { isResumeEligible } from '../../transition-engine/spawn-intent';
import { resolveIsolatedSwimlaneId, resolveForceFresh } from '../../transition-engine/session-isolation';
import { emitSpawnProgress, createProgressCallback } from '../../transition-engine/spawn-progress';
import { ensureTaskWorktree, ensureTaskBranchCheckout } from './task-git';
import { getProjectRepos } from './project-repos';
import { withTaskLock } from '../task-lifecycle-lock';
import { runWithProjectLogContext } from '../../diagnostics/project-log-context';

type SpawnExecutionLifecycle = Extract<
  AutoCommandLifecycle,
  { readonly kind: 'fresh' | 'resume' }
>;

/** Build template variables for auto-command interpolation. */
export function buildAutoCommandVars(task: Task): Record<string, string> {
  return {
    title: task.title,
    description: task.description,
    taskId: task.id,
    worktreePath: task.worktree_path || '',
    branchName: task.branch_name || '',
    baseBranch: task.base_branch || '',
  };
}

function isLegacyAutoCommandFallback(
  disposition: AutoCommandDisposition | null,
): boolean {
  if (disposition === null) return true;

  switch (disposition.kind) {
    case 'deliver-live':
    case 'not-applicable':
    case 'skip':
      return false;
    default: {
      const exhaustiveDisposition: never = disposition;
      return exhaustiveDisposition;
    }
  }
}

function toImmediateAutoCommandOutcome(
  gateResult: AutoCommandGateResult | undefined,
): AutoCommandImmediateOutcome {
  return gateResult?.immediateOutcome ?? { kind: 'not-applicable' };
}

function shouldConsumeTaskAutoCommand(outcome: AutoCommandImmediateOutcome): boolean {
  switch (outcome.kind) {
    case 'scheduled':
      return outcome.transport === 'native-idle';
    case 'skipped':
      return true;
    case 'not-applicable':
      return false;
    default: {
      const exhaustiveOutcome: never = outcome;
      return exhaustiveOutcome;
    }
  }
}

function consumeFinalizedTaskAutoCommand(
  tasks: TaskRepository,
  task: Task,
  outcome: AutoCommandImmediateOutcome,
): void {
  if (task.auto_command === null || !shouldConsumeTaskAutoCommand(outcome)) return;
  tasks.clearAutoCommand(task.id);
}

function evaluateSpawnAutoCommandDisposition(input: {
  readonly adapter: AgentAdapter | undefined;
  readonly autoCommand: string | undefined;
  readonly context: IpcContext;
  readonly currentTrack: string | null;
  readonly destinationAgent: string;
  readonly lifecycle: AutoCommandLifecycle;
  readonly task: Task;
  readonly toLane: Swimlane;
}): AutoCommandDisposition | null {
  const sessionId = input.task.session_id;
  const session = sessionId === null
    ? undefined
    : input.context.sessionManager.getSession(sessionId);
  const nativeSnapshot = sessionId === null
    ? null
    : input.context.sessionManager.snapshotNativeIdle(sessionId);

  return evaluateAutoCommandDisposition(input.adapter, {
    hasCommand: input.autoCommand !== undefined,
    destinationAutoSpawn: input.toLane.auto_spawn,
    lifecycle: input.lifecycle,
    currentSessionRunning: session?.status === 'running',
    currentSessionWritable: sessionId !== null
      && session !== undefined
      && input.context.sessionManager.isWritable(sessionId),
    currentAgent: input.task.agent,
    destinationAgent: input.destinationAgent,
    currentTrack: input.currentTrack,
    destinationTrack: resolveIsolatedSwimlaneId(input.toLane),
    liveSubmissionPolicy: input.adapter?.liveSubmissionPolicy,
    rootNativeSessionId: nativeSnapshot?.rootNativeSessionId ?? null,
    sessionGeneration: nativeSnapshot?.sessionGeneration ?? null,
    inputGeneration: nativeSnapshot?.inputGeneration ?? null,
    destinationLaneId: input.toLane.id,
    sequence: input.autoCommand === undefined ? [] : [input.autoCommand],
  });
}

/**
 * Resolve the column-derived spawn overrides handed to
 * `engine.resumeSuspendedSession` and `engine.executeTransition`.
 *
 * model/effort: per-task override (set via the ContextBar popover) wins over the
 * swimlane override, which wins over the project-level default - the user's
 * explicit choice is sticky across column moves and respawns, and the project
 * default is the base fallback below both. Undefined values are returned
 * unchanged so a fully-unset (undefined / undefined / undefined) row produces
 * `undefined` rather than `null` and downstream `?? undefined` coalescing
 * stays a no-op.
 *
 * isolatedSwimlaneId / forceFresh: derived from the destination column's session
 * target + spawn strategy. This is the single resolution site for the spawn path,
 * so every spawn through spawnAgent (normal move, session switch, Phase 3 deferred
 * spawn) lands on the correct track with the correct fresh-vs-resume policy without
 * threading them as separate parameters.
 */
export function resolveSpawnOverrides(
  task: Pick<Task, 'model_override' | 'effort_override'>,
  lane: Pick<Swimlane, 'id' | 'model_override' | 'effort_override' | 'session_target' | 'session_spawn_strategy'> | null | undefined,
  project?: Pick<Project, 'default_model' | 'default_effort'> | null,
): { model: string | null | undefined; effort: string | null | undefined; isolatedSwimlaneId: string | null; forceFresh: boolean } {
  return {
    model: task.model_override ?? lane?.model_override ?? project?.default_model,
    effort: task.effort_override ?? lane?.effort_override ?? project?.default_effort,
    isolatedSwimlaneId: resolveIsolatedSwimlaneId(lane),
    forceFresh: resolveForceFresh(lane),
  };
}

/** Create a TransitionEngine wired to explicit project context (not singletons). */
export function createTransitionEngine(
  context: IpcContext,
  actions: ActionRepository,
  tasks: TaskRepository,
  sessionRepo: SessionRepository,
  attachments: AttachmentRepository,
  projectId: string,
  projectPath: string | null,
): TransitionEngine {
  return new TransitionEngine(
    context.sessionManager, context.terminalSubmit, context.terminalSubmitScheduler, actions, tasks,
    () => {
      const config = context.configManager.getEffectiveConfig(projectPath || undefined);
      const gitConfig = { ...config.git };
      // Overlay board config's defaultBaseBranch (team-shared) onto gitConfig
      const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranch();
      if (boardDefaultBranch) {
        gitConfig.defaultBaseBranch = boardDefaultBranch;
      }
      const project = context.projectRepo.getById(projectId);
      return {
        permissionMode: config.agent.permissionMode,
        projectPath,
        projectId,
        gitConfig,
        mcpServerEnabled: config.mcpServer?.enabled ?? true,
        mcpServerUrl: context.mcpServerHandle?.urlForProject(projectId),
        mcpServerToken: context.mcpServerHandle?.token,
        defaultAgent: project?.default_agent ?? DEFAULT_AGENT,
        cliPathOverrides: config.agent.cliPaths,
      };
    },
    sessionRepo,
    attachments,
  );
}

export interface AgentSpawnOptions {
  context: IpcContext;
  engine: TransitionEngine;
  tasks: TaskRepository;
  sessionRepo: SessionRepository;
  task: Task;
  fromSwimlaneId: string;
  toLane: Swimlane;
  skipPromptTemplate?: boolean;
  signal?: AbortSignal;
  /** Project ID for handoff context resolution. Resolved from caller's context. */
  projectId?: string;
  /** Project filesystem path for handoff context resolution. */
  projectPath?: string | null;
  /**
   * Fallback resume prompt when the destination column has no auto_command.
   * Set by plan-exit auto-moves ("Your plan was approved...") so a respawned
   * session continues instead of resuming idle. Only delivered on a RESUME of
   * an existing conversation - a fresh session has no plan context to
   * continue. The column's auto_command always wins when present.
   */
  continuationPrompt?: string;
  /**
   * Recovery move out of Done: resume the session but do NOT inject the
   * destination column's auto_command (as prompt or keystroke). The session
   * resumes idle, ready for the user to inspect; the NEXT move injects per
   * column config. Set by handleTaskMove when fromLane.role === 'done' and
   * by the unarchive handlers (task-archive.ts, always a move out of Done).
   * Matches startup recovery (resume-suspended.ts), which also resumes
   * without injecting auto_command.
   */
  suppressAutoCommand?: boolean;
  autoCommandLifecycle?: AutoCommandLifecycle;
  /**
   * The lane whose inherited settings the New Task / Edit dialog displayed
   * when the user configured the task. The first-spawn override lock
   * (`lockAdvancedOverridesOnFirstSpawn`) resolves still-inherited fields
   * against THIS lane, never the destination column (whose settings the user
   * never saw in the dialog). Drag moves pass the SOURCE lane (null when it
   * no longer resolves); omit to fall back to `toLane` (creation, promotion,
   * MCP creation, or unarchive directly into a spawn column, where the
   * destination is the lane the user chose).
   */
  settingsSourceLane?: Swimlane | null;
}

/**
 * Single entry point for spawning or resuming an agent session for a task.
 *
 * Implements the "ensure" pattern: idempotent, safe to call multiple times.
 * 1. Runs configured transition actions (which may spawn via spawn_agent action)
 * 2. Verifies whether a session was created (re-reads from DB)
 * 3. If not, spawns or resumes a session as fallback
 * 4. Schedules auto_command injection when appropriate
 *
 * No-ops when: toLane.auto_spawn is false, task already has a session, or
 * task was deleted mid-operation. AbortError always propagates for cancellation.
 */
export async function spawnAgent(options: AgentSpawnOptions): Promise<AutoCommandImmediateOutcome> {
  const { context, engine, tasks, sessionRepo, task, fromSwimlaneId, toLane, skipPromptTemplate, signal } = options;

  // Resolve the owning project once: used for the default-agent fallback below
  // and to tag every log this spawn emits with [projectName] (see
  // project-log-context.ts). When no project id is supplied the body runs
  // without establishing a new context, inheriting any ambient tag (e.g. from
  // an enclosing task-move).
  const project = options.projectId ? context.projectRepo.getById(options.projectId) : null;

  const run = async (): Promise<AutoCommandImmediateOutcome> => {
  // Guard: if the target column doesn't want agents, no-op
  if (!toLane.auto_spawn) return { kind: 'not-applicable' };

  // Guard: if the user manually paused this task, don't auto-resume.
  // The user must explicitly click Resume (SESSION_RESUME) to restart.
  const latestSession = sessionRepo.getLatestForTask(task.id);
  if (latestSession?.status === 'suspended' && latestSession.suspended_by === 'user') {
    console.log(`[spawnAgent] Skipping auto-spawn for task ${task.id.slice(0, 8)} (manually paused by user)`);
    return { kind: 'not-applicable' };
  }

  // Shared spawn preamble: lock the Advanced overrides on the task's very
  // first ever spawn, then resolve the target agent ONCE (single source of
  // truth) - a just-locked agent_override is what the resolution picks up,
  // and the in-flight spawn below already resolves against the locked values.
  const { agent: targetAgent, isHandoff } = runSpawnPreamble({
    task,
    hasSessionRecord: latestSession !== undefined,
    settingsLane: options.settingsSourceLane === undefined ? toLane : options.settingsSourceLane,
    destinationLane: toLane,
    project,
    globalPermissionMode: () => context.configManager.getEffectiveConfig(options.projectPath || undefined).agent.permissionMode,
    tasks,
  });
  const destinationAdapter = agentRegistry.get(targetAgent);

  // Handoff also requires a previous session to exist, a project context,
  // and the target column's handoff_context toggle to be enabled (default: false).
  // When disabled (default), the agent change is still detected but no context
  // is packaged - the new agent starts fresh with just the task title/description.
  const hasHandoffContext = toLane.handoff_context !== false
    && isHandoff
    && options.projectId !== undefined
    && sessionRepo.getLatestForTask(task.id) !== null;

  console.log(`[spawnAgent] task=${task.id.slice(0, 8)} targetAgent=${targetAgent} isHandoff=${isHandoff} hasHandoffContext=${hasHandoffContext}`);

  // --- Handoff path: locate source session file and spawn target agent ---
  if (hasHandoffContext) {
    // Guard: hasHandoffContext implies isHandoff which implies task.agent !== null
    const sourceAgent = task.agent!;
    console.log(`[spawnAgent] Handoff: ${sourceAgent} -> ${targetAgent} for task ${task.id.slice(0, 8)}`);
    emitSpawnProgress(context.mainWindow, task.id, 'packaging-handoff');
    signal?.throwIfAborted();

    let handoffPromptPrefix: string | undefined;
    let handoffId: string | undefined;
    const handoffProjectId = options.projectId!;
    const handoffDb = getProjectDb(handoffProjectId);

    try {
      // Locate the source agent's native session history file.
      // The file path is derived from the session's agent_session_id + cwd.
      const latestSessionRecord = sessionRepo.getLatestForTask(task.id);
      let sessionFilePath: string | null = null;

      if (latestSessionRecord?.agent_session_id) {
        const sourceAdapter = agentRegistry.get(sourceAgent);
        if (sourceAdapter) {
          sessionFilePath = await sourceAdapter.locateSessionHistoryFile(
            latestSessionRecord.agent_session_id,
            latestSessionRecord.cwd,
          );
        }
      }

      // Determine if the target agent has MCP access (currently only Claude).
      const targetAdapter = agentRegistry.get(targetAgent);
      const targetHasMcpAccess = targetAdapter?.name === 'claude';

      handoffPromptPrefix = buildSessionHistoryReference({
        sourceAgent,
        sessionFilePath,
        targetHasMcpAccess,
      });

      // Store a handoff record for audit trail.
      try {
        const handoffRepo = new HandoffRepository(handoffDb);
        const handoffRecord = handoffRepo.insert({
          task_id: task.id,
          from_session_id: latestSessionRecord?.id ?? null,
          to_session_id: null, // Filled after target agent spawns
          from_agent: sourceAgent,
          to_agent: targetAgent,
          trigger: 'column_transition',
          session_history_path: sessionFilePath,
        });
        handoffId = handoffRecord.id;
      } catch (handoffDbError) {
        console.error('[spawnAgent] Failed to store handoff record:', handoffDbError);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error('[spawnAgent] Handoff preparation failed (continuing without context):', error);
    }

    emitSpawnProgress(context.mainWindow, task.id, 'detecting-agent');

    await engine.resumeSuspendedSession(
      task, toLane.permission_mode, skipPromptTemplate, undefined, signal,
      targetAgent,
      handoffPromptPrefix,
      resolveSpawnOverrides(task, toLane, project),
    );

    // Post-spawn: link handoff record to the target session.
    const currentTask = tasks.getById(task.id);
    if (currentTask?.session_id) {
      try {
        if (handoffId) {
          const handoffRepo = new HandoffRepository(handoffDb);
          const targetSessionRecord = sessionRepo.getLatestForTask(currentTask.id);
          if (targetSessionRecord) {
            handoffRepo.updateToSession(handoffId, targetSessionRecord.id);
          }
        }
      } catch (error) {
        console.error('[spawnAgent] Failed to finalize handoff:', error);
      }

      const effectiveAutoCommand = currentTask.auto_command ?? toLane.auto_command;
      const interpolatedAutoCommand = !options.suppressAutoCommand && effectiveAutoCommand?.trim()
        ? interpolateTemplate(effectiveAutoCommand, buildAutoCommandVars(currentTask))
        : undefined;
      // OpenCode policy 在此集中阻擋 resume、fresh 與 post-spawn Auto-command fallback；一般 Task 與 continuation prompt 仍維持原本生命週期。
      const autoCommandDisposition = evaluateSpawnAutoCommandDisposition({
        adapter: destinationAdapter,
        autoCommand: interpolatedAutoCommand,
        context,
        currentTrack: sessionRepo.getLatestForTask(currentTask.id)?.isolated_swimlane_id ?? null,
        destinationAgent: targetAgent,
        lifecycle: { kind: 'handoff' },
        task: currentTask,
        toLane,
      });
      if (interpolatedAutoCommand !== undefined
        && isLegacyAutoCommandFallback(autoCommandDisposition)) {
        context.terminalSubmitScheduler.scheduleKeystrokes(currentTask.id, currentTask.session_id, [interpolatedAutoCommand], { freshlySpawned: true });
        return toImmediateAutoCommandOutcome(finalizeAutoCommandGate({ kind: 'legacy' }));
      }
      return toImmediateAutoCommandOutcome(finalizeAutoCommandGate({
        kind: 'not-dispatched',
        disposition: autoCommandDisposition,
      }));
    }

    return { kind: 'not-applicable' };
  }

  // --- Normal path: execute transition actions then fallback ---
  // targetAgent is passed through so spawn_agent actions use the correct agent.

  // transition 可以在後續 action 失敗前已成功 spawn；保留最後成功的 lifecycle，讓 re-read 後仍能由中央 gate 做唯一的最終化。
  let transitionSpawnLifecycle: SpawnExecutionLifecycle | null = null;

  try {
    await engine.executeTransition(
      task, fromSwimlaneId, toLane.id, toLane.permission_mode, skipPromptTemplate, signal, targetAgent,
      resolveSpawnOverrides(task, toLane, project),
      // A create_worktree action runs inside the transition; give it the same
      // progress labels as the default task-move worktree path so its
      // "Creating worktree..." / "Running setup script..." phases reach the card.
      createProgressCallback(context.mainWindow, task.id),
      (lifecycle) => {
        transitionSpawnLifecycle = lifecycle;
      },
      options.continuationPrompt,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[spawnAgent] Transition engine error (continuing to fallback):', error);
  }

  // transition action 已建立 session 時不走 fallback；用 observer 保留的 lifecycle
  // 經中央 gate 最終化，避免 action-created OpenCode 走 legacy keystroke。
  let currentTask = tasks.getById(task.id);
  if (!currentTask) return { kind: 'not-applicable' };

  if (currentTask.session_id && transitionSpawnLifecycle !== null) {
    const effectiveAutoCommand = currentTask.auto_command ?? toLane.auto_command;
    const interpolatedAutoCommand = !options.suppressAutoCommand && effectiveAutoCommand?.trim()
      ? interpolateTemplate(effectiveAutoCommand, buildAutoCommandVars(currentTask))
      : undefined;
    const currentTrack = sessionRepo.getLatestForTask(currentTask.id)?.isolated_swimlane_id ?? null;
    const autoCommandDisposition = evaluateSpawnAutoCommandDisposition({
      adapter: destinationAdapter,
      autoCommand: interpolatedAutoCommand,
      context,
      currentTrack,
      destinationAgent: targetAgent,
      lifecycle: options.autoCommandLifecycle ?? transitionSpawnLifecycle,
      task: currentTask,
      toLane,
    });
    return toImmediateAutoCommandOutcome(finalizeAutoCommandGate({
      kind: 'not-dispatched',
      disposition: autoCommandDisposition,
    }));
  }

  if (currentTask.session_id) return { kind: 'not-applicable' };

  // Fallback: no transition spawned a session - resume or spawn fresh
  console.log(`[spawnAgent] No session after transitions, spawning ${targetAgent} for task ${task.id.slice(0, 8)}`);

  // Resolve resume eligibility scoped to the DESTINATION session (agent type +
  // isolated swimlane), mirroring executeSpawnAgent's resolveSpawnIntent. A
  // task-level check (getLatestForTask) would treat a suspended MAIN session as
  // "resumable" when entering an isolated column, which would mis-route the
  // auto_command and drop it; scoping by isolation keeps this decision in
  // lockstep with the actual spawn.
  const destinationIsolatedSwimlaneId = resolveIsolatedSwimlaneId(toLane);
  const destinationResumeRecord = destinationAdapter
    ? sessionRepo.getLatestForTaskByTypeAndIsolation(task.id, destinationAdapter.sessionType, destinationIsolatedSwimlaneId)
    : undefined;
  const canResumeDestination = isResumeEligible(destinationResumeRecord);

  // Auto_command delivery. The command is handed to the spawn as the INITIAL
  // PROMPT (runs immediately, no keystroke timing) whenever the session has no
  // task prompt of its own to run:
  //   - resume: --resume carries it as the next message;
  //   - fresh + skipPromptTemplate: a promptless fresh spawn (e.g. an isolated
  //     review column, which omits the "do this task" prompt). Without this the
  //     CLI sits idle at an empty prompt, never emits a 'thinking' event, and
  //     the keystroke scheduler waits out its full 30s fallback before the
  //     command appears - which reads as "the auto_command never ran".
  // Only a fresh spawn that DOES get a task template needs the post-spawn
  // keystroke, because the task description owns the prompt slot.
  // suppressAutoCommand (recovery move out of Done) zeroes out the command so
  // everything downstream degrades naturally: deliverAutoCommandAsPrompt becomes
  // false, resumePrompt falls back to the (Done-out: absent) continuationPrompt
  // so the resume is promptless, and the post-spawn keystroke is skipped. A
  // fresh-spawn outcome also sits idle because skipPromptTemplate is already
  // true for any non-To-Do source.
  const effectiveAutoCommand = currentTask.auto_command ?? toLane.auto_command;
  const interpolatedAutoCommand = !options.suppressAutoCommand && effectiveAutoCommand?.trim()
    ? interpolateTemplate(effectiveAutoCommand, buildAutoCommandVars(currentTask))
    : undefined;
  const autoCommandDisposition = evaluateSpawnAutoCommandDisposition({
    adapter: destinationAdapter,
    autoCommand: interpolatedAutoCommand,
    context,
    currentTrack: destinationResumeRecord?.isolated_swimlane_id ?? null,
    destinationAgent: targetAgent,
    lifecycle: options.autoCommandLifecycle
      ?? (canResumeDestination ? { kind: 'resume' } : { kind: 'fresh' }),
    task: currentTask,
    toLane,
  });
  const deliveredAutoCommand = isLegacyAutoCommandFallback(autoCommandDisposition)
    ? interpolatedAutoCommand
    : undefined;
  const deliverAutoCommandAsPrompt = deliveredAutoCommand !== undefined
    && (canResumeDestination || skipPromptTemplate === true);
  // The continuation prompt (plan-exit auto-move) is a resume-only fallback:
  // the auto_command is the user's explicit per-column automation and wins,
  // and a fresh spawn has no prior conversation for "proceed" to refer to.
  const resumePrompt = deliverAutoCommandAsPrompt
    ? deliveredAutoCommand
    : (canResumeDestination ? options.continuationPrompt : undefined);

  // Always pass targetAgent so the column's agent_override is respected.
  // Without this, first-time spawns (task.agent=null, isHandoff=false)
  // would fall through to the project default or 'claude' hardcoded fallback.
  await engine.resumeSuspendedSession(
    currentTask, toLane.permission_mode, skipPromptTemplate, resumePrompt, signal,
    targetAgent,
    undefined,
    resolveSpawnOverrides(currentTask, toLane, project),
  );

  currentTask = tasks.getById(task.id);

  if (currentTask?.session_id && deliveredAutoCommand !== undefined && !deliverAutoCommandAsPrompt) {
    context.terminalSubmitScheduler.scheduleKeystrokes(currentTask.id, currentTask.session_id, [deliveredAutoCommand], { freshlySpawned: true });
  }
  if (deliveredAutoCommand !== undefined && currentTask?.session_id) {
    return toImmediateAutoCommandOutcome(finalizeAutoCommandGate({ kind: 'legacy' }));
  }
  return toImmediateAutoCommandOutcome(finalizeAutoCommandGate({
    kind: 'not-dispatched',
    disposition: autoCommandDisposition,
  }));
  };

  const outcome = await (project?.name ? runWithProjectLogContext(project.name, run) : run());
  // Every spawnAgent caller holds the task lock; finalizing here keeps the
  // accepted one-shot decision adjacent to the immediate outcome without re-entry.
  consumeFinalizedTaskAutoCommand(tasks, task, outcome);
  return outcome;
}

/**
 * Auto-spawn an agent session for a newly created task when the target
 * swimlane has `auto_spawn` enabled. Handles worktree setup, branch checkout,
 * transition engine execution, session resume fallback, and auto-command
 * injection.
 *
 * Called by the distinct MCP `onTaskAutoSpawn` lifecycle callback after
 * `onTaskCreated` has completed its notification-only board update.
 */
export async function autoSpawnForTask(
  context: IpcContext,
  projectId: string,
  task: Pick<Task, 'id' | 'title'>,
  swimlaneId: string,
): Promise<AutoCommandImmediateOutcome> {
  // Serialize against any other task-lifecycle op (suspend/resume/move/kill)
  // so an MCP-created auto-spawn can't race a user drag of the same task. This
  // is also the caller-held lock for task-command finalization in spawnAgent.
  return withTaskLock(task.id, async () => {
    // Tag the worktree/checkout/spawn logs below with the project the new task
    // belongs to. This is the entry point for MCP-created-task spawns, which
    // have no enclosing move context to inherit a tag from.
    const logProjectName = context.projectRepo.getById(projectId)?.name ?? null;
    const run = async (): Promise<AutoCommandImmediateOutcome> => {
      const db = getProjectDb(projectId);
      const swimlaneRepo = new SwimlaneRepository(db);
      const toLane = swimlaneRepo.getById(swimlaneId);
      if (!toLane) throw new Error(`Swimlane ${swimlaneId} not found`);
      if (!toLane.auto_spawn) return { kind: 'not-applicable' };

      const project = context.projectRepo.getById(projectId);
      if (!project) throw new Error(`Project ${projectId} not found`);
      const projectPath = project.path;
      if (!projectPath) throw new Error(`Project ${projectId} has no path`);

      const { tasks, actions, attachments } = getProjectRepos(context, projectId);
      const fullTask = tasks.getById(task.id);
      if (!fullTask) throw new Error(`Task ${task.id} not found`);

      await ensureTaskWorktree(context, fullTask, tasks, projectPath);

      // Checkout branch for non-worktree tasks (may fail if another session is active)
      if (fullTask.base_branch && !fullTask.worktree_path) {
        // Inlined from guardActiveNonWorktreeSessions to avoid circular import with task-move.ts
        const activeSessions = context.sessionManager.listSessions()
          .filter(session => session.taskId !== fullTask.id && (session.status === 'running' || session.status === 'queued'));
        const otherNonWorktreeSessions = activeSessions.filter(session => {
          const otherTask = tasks.getById(session.taskId);
          return otherTask && !otherTask.worktree_path;
        });
        if (otherNonWorktreeSessions.length > 0) {
          throw new Error(
            `Cannot switch to branch '${fullTask.base_branch}': another task is running in the main repo. `
            + `Enable worktree mode for branch isolation.`
          );
        }
        await ensureTaskBranchCheckout(fullTask, projectPath);
      }

      const sessionRepo = new SessionRepository(db);
      const engine = createTransitionEngine(context, actions, tasks, sessionRepo, attachments, projectId, projectPath);

      const outcome = await spawnAgent({ context, engine, tasks, sessionRepo, task: fullTask, fromSwimlaneId: '*', toLane, projectId, projectPath });

      console.log(`[MCP auto-spawn] Spawned agent for "${task.title}" in ${toLane.name}`);
      return outcome;
    };
    return logProjectName ? runWithProjectLogContext(logProjectName, run) : run();
  });
}
