import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { resolveProjectRoot } from '../../../shared/git-utils';
import { fetchIfStale } from '../../git/fetch-throttle';
import { trackEvent } from '../../analytics/analytics';
import { agentRegistry } from '../../agent/agent-registry';
import { removeAdapterHooks } from '../../pty/lifecycle/adapter-lifecycle';
import { DEFAULT_AGENT } from '../../../shared/types';
import type {
  SpawnTransientSessionInput,
  PermissionMode,
  SessionInjectSettingsInput,
  SessionInjectSettingsResult,
} from '../../../shared/types';
import type { SettingsChangeSpec } from '../../agent/agent-adapter';
import type { IpcContext } from '../ipc-context';

/**
 * Transient sessions are ephemeral Claude Code terminals spawned from the
 * command bar (Ctrl+Shift+P). They run at the project root with no task
 * association, no DB persistence, and no resume capability.
 */
export function registerTransientSessionHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.SESSION_SPAWN_TRANSIENT, async (_, input: SpawnTransientSessionInput) => {
    if (!context.currentProjectId) throw new Error('Cannot spawn transient session: no project is currently open');

    const project = context.projectRepo.getById(input.projectId);
    if (!project) throw new Error('Cannot spawn transient session: project not found');

    const projectRoot = resolveProjectRoot(project.path);
    const config = context.configManager.getEffectiveConfig(projectRoot);

    const agentName = project.default_agent || DEFAULT_AGENT;
    const adapter = agentRegistry.getOrThrow(agentName);
    const cliPathOverride = config.agent.cliPaths[agentName] ?? null;

    const detection = await adapter.detect(cliPathOverride);
    if (!detection.found || !detection.path) throw new Error(`${adapter.displayName} CLI not found. Please install it first.`);
    const permissionMode = config.agent.permissionMode as PermissionMode;
    const transientSessionId = uuidv4();

    // Fetch latest from origin and checkout the requested branch before spawning.
    // This ensures Claude Code loads up-to-date commands/skills from the remote.
    const git = simpleGit(projectRoot);
    const targetBranch = input.branch || config.git.defaultBaseBranch || 'main';

    // Best-effort fetch from origin (throttled, network-failure-safe)
    const startPoint = await fetchIfStale(git, projectRoot, targetBranch);

    let branch = targetBranch;
    let checkoutError: string | undefined;
    try {
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (currentBranch !== targetBranch) {
        await git.checkout(targetBranch);
      }
      branch = targetBranch;

      // Fast-forward merge to incorporate fetched remote changes
      if (startPoint.startsWith('origin/')) {
        try {
          await git.merge([startPoint, '--ff-only']);
        } catch {
          // ff-only failed (dirty tree, diverged history) - use local state
        }
      }
    } catch (error) {
      // Checkout may fail (dirty working tree, branch doesn't exist locally)
      // Fall back to whatever branch is currently checked out
      try {
        branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      } catch {
        branch = 'unknown';
      }
      const reason = error instanceof Error ? error.message : String(error);
      checkoutError = `Could not switch to "${targetBranch}" - staying on "${branch}". ${reason}`;
    }

    // Create session directory for status/events bridge files so the
    // shimmer overlay can detect when Claude Code is ready.
    const sessionDirectory = path.join(projectRoot, '.kangentic', 'sessions', transientSessionId);
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const statusOutputPath = path.join(sessionDirectory, 'status.json');
    const eventsOutputPath = path.join(sessionDirectory, 'activity.json');

    const commandOptions = {
      agentPath: detection.path,
      taskId: transientSessionId,
      hookOwnerId: transientSessionId,
      cwd: projectRoot,
      permissionMode,
      projectRoot,
      statusOutputPath,
      eventsOutputPath,
      mcpServerEnabled: config.mcpServer.enabled,
      mcpServerUrl: context.mcpServerHandle?.urlForProject(input.projectId),
      mcpServerToken: context.mcpServerHandle?.token,
      // Project default model/effort, same tier board-task spawns apply. A
      // fresh Command Terminal starts on the project's preferred combo
      // instead of the CLI's own default.
      model: project.default_model ?? undefined,
      effort: project.default_effort ?? undefined,
    };
    const command = adapter.buildCommand(commandOptions);
    const localHookOwner = {
      id: transientSessionId,
      cwd: projectRoot,
      taskId: transientSessionId,
      agentParser: adapter,
    };
    let extraEnv: Record<string, string> | null;
    let exitSequence: string[];
    try {
      extraEnv = adapter.buildEnv?.(commandOptions) ?? null;
      exitSequence = adapter.getExitSequence?.() ?? ['\x03'];
    } catch (error) {
      // buildCommand 可能已保留 shared hooks；只有 spawn() 尚未被呼叫時由 handler 釋放。呼叫後一律交由 SessionManager，避免 rejected promise 被重複釋放。
      removeAdapterHooks(localHookOwner);
      throw error;
    }

    const session = await context.sessionManager.spawn({
      id: transientSessionId,
      taskId: transientSessionId,
      projectId: input.projectId,
      command,
      cwd: projectRoot,
      env: extraEnv ?? undefined,
      statusOutputPath,
      eventsOutputPath,
      transient: true,
      agentParser: adapter,
      agentName: adapter.name,
      exitSequence,
      cols: input.cols,
      rows: input.rows,
    });

    trackEvent('transient_session_spawn', { agent: adapter.name });
    return { session, branch, checkoutError };
  });

  ipcMain.handle(IPC.SESSION_KILL_TRANSIENT, (_, sessionId: string) => {
    // Capture session info before removal for cleanup
    const session = context.sessionManager.getSession(sessionId);
    context.sessionManager.remove(sessionId);

    // Clean up the transient session directory on disk
    if (session?.transient) {
      const sessionDirectory = path.join(session.cwd, '.kangentic', 'sessions', session.taskId);
      try {
        fs.rmSync(sessionDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  // Session-keyed model/effort injection for transient (command-terminal)
  // sessions. These have no task row, so the task-keyed
  // TASK_SET_RUNTIME_OVERRIDE handler cannot serve them. There is nothing to
  // persist (transient sessions are not resumable), so this is a best-effort
  // live slash-command inject only. Mutates no per-task state, so it does not
  // take a task lock.
  ipcMain.handle(
    IPC.SESSION_INJECT_SETTINGS,
    async (_, input: SessionInjectSettingsInput): Promise<SessionInjectSettingsResult> => {
      // Prefer the live session's actual agent (recorded at spawn); fall back
      // to the agent the renderer resolved (the project default) if the
      // registry has no record for this session.
      const resolvedAgentName = context.sessionManager.getSessionAgentName(input.sessionId) ?? input.agent;
      const adapter = agentRegistry.get(resolvedAgentName);
      if (!adapter) {
        return { ok: false, reason: `unknown agent "${resolvedAgentName}"` };
      }

      // The PTY must be live for an inject to land. Transient sessions live in
      // the session manager but carry no DB row, so look them up directly.
      const session = context.sessionManager.getSession(input.sessionId);
      if (!session) {
        return { ok: false, reason: 'session not found' };
      }

      const currentModel = input.currentModel ?? null;
      const currentEffort = input.currentEffort ?? null;
      const nextModel = input.model !== undefined ? input.model : currentModel;
      const nextEffort = input.effort !== undefined ? input.effort : currentEffort;
      const spec: SettingsChangeSpec = {
        model: nextModel,
        modelChanged: input.model !== undefined && input.model !== currentModel,
        effort: nextEffort,
        effortChanged: input.effort !== undefined && input.effort !== currentEffort,
      };

      const sequence = adapter.getInjectionSequence?.(spec) ?? [];
      if (sequence.length === 0) return { ok: true, injected: false };

      // Best-effort live injection. Transient sessions have no DB row, so the
      // command-injection verifier (which needs a SessionRepository + task id)
      // cannot be used; schedule without one, mirroring the auto_command path.
      // The scheduler keys its coalesce/cancel map by the first argument, so
      // we pass the sessionId there as well as the PTY target.
      context.terminalSubmitScheduler.scheduleKeystrokes(input.sessionId, input.sessionId, sequence, {});
      return { ok: true, injected: true };
    },
  );
}
