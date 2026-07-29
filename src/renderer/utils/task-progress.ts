import { useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/session-store';
import type { Session, SessionUsage, ActivityState, SessionDisplayState } from '../../shared/types';
import type { LiveDeliveryStatus } from '../../shared/live-delivery-status';
import type { AutoCommandWarning } from '../../shared/auto-command-outcome';

// ---------------------------------------------------------------------------
// Unified task progress derivation
//
// Single system that answers "what is this task doing right now?" for both
// the board card and the terminal overlay. Replaces the previously scattered
// logic across session-display-state.ts, TaskCard.tsx (deriveInitializingLabel),
// and TerminalTab.tsx (terminal overlay label derivation).
//
// Display lifecycle:
//   preparing → running → exited
//                       → suspended
//
// - preparing:    Pre-session phase (worktree creation, branch checkout)
// - running:      Agent CLI active (usage data optional)
// - queued:       Waiting for a concurrency slot
// - suspended:    Session paused
// - exited:       PTY process terminated
// - none:         No session, no progress
// ---------------------------------------------------------------------------

/**
 * Terminal overlay label 只讀 renderer 管理的啟動狀態。
 * 不讀 swimlane command，避免 terminal overlay 洩漏 command 文字。
 * Priority chain (highest first):
 *   1. Pending command label (explicit invocation text)
 *   2. Resuming session ("Resuming agent...")
 *   3. Default ("Starting agent...")
 */
export function deriveTerminalOverlayLabel(
  pendingCommandLabel: string | null | undefined,
  isResuming: boolean,
): string {
  if (pendingCommandLabel) return pendingCommandLabel;
  if (isResuming) return 'Resuming agent...';
  return 'Starting agent...';
}

/**
 * Pure derivation of display state from raw task/session data.
 * Centralizes all progress state logic into one priority chain.
 *
 * Priority (highest to lowest):
 *   1. Spawn progress label (main process push during worktree/git I/O)
 *   2. Session-based display state (queued, initializing, running, etc.)
 *   3. None (no session, no progress)
 */
export function getTaskProgress(inputs: {
  session?: Session;
  usage?: SessionUsage;
  activity?: ActivityState;
  spawnProgressLabel?: string | null;
}): SessionDisplayState {
  const { session, usage, activity, spawnProgressLabel } = inputs;

  // Pre-session: spawn progress from main process (worktree creation, etc.)
  if (spawnProgressLabel && !session) {
    return { kind: 'preparing', label: spawnProgressLabel };
  }

  if (!session) return { kind: 'none' };

  switch (session.status) {
    case 'exited':
      return { kind: 'exited', exitCode: session.exitCode ?? 0 };
    case 'suspended':
      return { kind: 'suspended' };
    case 'queued':
      return { kind: 'queued' };
    case 'running': {
      // Session is running - show as running regardless of usage data.
      // Usage enriches the display (model, cost, context %) but its
      // absence doesn't mean the agent isn't running.
      //
      // A running session is in one of three states: 'thinking', 'idle',
      // or 'permission' (waiting on user approval). When the renderer
      // has no cached value (brief startup window, HMR recovery gap
      // where syncSessions's snapshot didn't contain the session,
      // listener reattach race, orphaned DB row with no live engine
      // entry), we default to 'idle'. Defaulting to 'thinking' would
      // stick the spinner permanently for any of those cases; 'idle'
      // is the safer default because a real thinking session emits
      // events quickly and corrects itself.
      return {
        kind: 'running',
        activity: activity ?? 'idle',
        usage: usage ?? null,
      };
    }
  }
}

/**
 * React hook for TaskCard progress state. Subscribes to minimal store slices.
 * Replaces useSessionDisplayState + manual subscriptions.
 */
export function useTaskProgress(taskId: string, sessionId: string | undefined): SessionDisplayState {
  const taskSession = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? s.sessions.find((session) => session.id === sessionId) : undefined,
      [sessionId],
    ),
  );
  const usage = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? s.sessionUsage[sessionId] : undefined,
      [sessionId],
    ),
  );
  const activity = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        sessionId ? s.sessionActivity[sessionId] : undefined,
      [sessionId],
    ),
  );
  const spawnProgressLabel = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.spawnProgress[taskId] ?? null,
      [taskId],
    ),
  );
  return useMemo(
    () => getTaskProgress({
      session: taskSession,
      usage,
      activity,
      spawnProgressLabel,
    }),
    [taskSession, usage, activity, spawnProgressLabel],
  );
}

export function useLiveDeliveryStatus(taskId: string): LiveDeliveryStatus | null {
  return useSessionStore(
    useCallback(
      (state: ReturnType<typeof useSessionStore.getState>) => state.liveDeliveryByTaskId[taskId] ?? null,
      [taskId],
    ),
  );
}

export function useAutoCommandWarning(taskId: string): AutoCommandWarning | null {
  return useSessionStore(
    useCallback(
      (state: ReturnType<typeof useSessionStore.getState>) => state.autoCommandWarningsByTaskId[taskId] ?? null,
      [taskId],
    ),
  );
}

export function getLiveDeliveryLabel(status: LiveDeliveryStatus): string | null {
  switch (status.state) {
    case 'waiting':
      return 'Waiting for agent input...';
    case 'sending':
      return 'Sending lane command...';
    case 'delivered':
      return 'Command bytes reached the terminal.';
    case 'cancelled':
      switch (status.reason) {
        case 'user-input':
          return 'Lane command was not sent because terminal input took priority.';
        case 'timeout':
          return 'Lane command was not sent because the agent did not become idle.';
        case 'session-exit':
          return 'Lane command was not sent because the session ended or changed.';
        case 'turn-error':
          return 'Lane command was not sent because the agent turn failed.';
        case 'delivery-error':
          return 'Lane command could not be delivered safely.';
        case 'superseded':
        case 'shutdown':
          return null;
      }
  }
}

// ---------------------------------------------------------------------------
// Terminal overlay progress
// ---------------------------------------------------------------------------

export interface TerminalOverlayState {
  /** Label for the shimmer overlay (contextual text shown while CLI boots). */
  overlayLabel: string;
}

/**
 * React hook for TerminalTab overlay label. Consolidates the overlay label
 * derivation that was previously in TerminalTab.tsx.
 *
 * Does NOT manage terminalReady state - that's a component-level lifecycle
 * concern (xterm init, firstOutput/usage gating) that stays local.
 */
export function useTerminalOverlay(taskId: string, sessionId: string): TerminalOverlayState {
  const isResuming = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.sessions.find((session) => session.id === sessionId)?.resuming ?? false,
      [sessionId],
    ),
  );
  const pendingCommandLabel = useSessionStore(
    useCallback(
      (s: ReturnType<typeof useSessionStore.getState>) =>
        s.pendingCommandLabel[taskId] ?? null,
      [taskId],
    ),
  );
  const overlayLabel = useMemo(
    () => deriveTerminalOverlayLabel(pendingCommandLabel, isResuming),
    [pendingCommandLabel, isResuming],
  );

  return { overlayLabel };
}
