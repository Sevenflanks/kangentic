import type { SessionManager } from '../pty/session-manager';
import type {
  CommandVerifier,
  InjectionCommand,
  InjectionOutcome,
  SubmitKeystrokesResult,
  TerminalSubmit,
} from '../pty/terminal-submit';
import type { SubmissionLease } from '../pty/session-write-coordinator';
import type { AutoCommandMode, SessionStatus, SubmissionVerifier } from '../../shared/types';
import type {
  LiveDeliveryCancellationReason,
  LiveDeliveryStatus,
} from '../../shared/live-delivery-status';
import {
  evaluateNativeIdleReadiness,
  type NativeIdleRequest,
} from './native-idle-waiter';
import { waitForTurnCompletion } from './turn-completion';

/**
 * Re-export so callers in injection-plan and slash-command-verifier can keep
 * importing these from the engine layer without reaching into
 * `pty/terminal-submit.ts` directly.
 */
export type {
  CommandVerifier,
  InjectionCommand,
  InjectionOutcome,
  InjectionVerifyMode,
} from '../pty/terminal-submit';

export interface LiveDeliveryRegistration {
  readonly generation: number;
  readonly accepted: true;
}

/**
 * How an auto_command's arrival is timed.
 *
 * Re-exported from `shared/types`, never redeclared. A second identical string
 * union assigns freely across every boundary a lane's `auto_command_mode`
 * crosses to reach `ScheduleKeystrokesOptions.mode`, so the two copies can only
 * be kept in step by hand - and when they do diverge, the error surfaces as a
 * baffling "AutoCommandMode is not assignable to AutoCommandMode".
 */
export type { AutoCommandMode };

/**
 * What actually happened to one scheduled injection. Every scheduled burst
 * ends in exactly one of these, delivered to `onOutcome`. The old scheduler
 * returned `void` and logged, so a caller could not observe failure at all.
 */
export interface InjectionReport {
  taskId: string;
  sessionId: string;
  commands: string[];
  outcome: InjectionOutcome | 'cancelled';
  /** Commands that were verifiable but never confirmed. */
  unconfirmedCommands: string[];
  /** Text cleared off the prompt to make room, if any. */
  discardedDraft: string | null;
  /** True when delivery interrupted a live turn. */
  interruptedTurn: boolean;
  /** True when delivery only succeeded by restarting the session. */
  escalated: boolean;
  /** Human-readable reason, set when the outcome is a failure. */
  reason?: string;
}

/**
 * Restart the session and deliver `commands` as the CLI's prompt argument.
 *
 * Supplied by the caller rather than implemented here: the scheduler must not
 * know about spawn machinery, and routing this through the caller keeps every
 * spawn on its existing chokepoint (see `spawn-entry-point-parity.md`).
 * Resolves true when the restart was issued.
 */
export type EscalationHandler = (commands: string[]) => Promise<boolean>;

type ScheduledSubmission =
  | { kind: 'content'; text: string; sessionId: string; opts: ScheduleContentOptions }
  | { kind: 'keystrokes'; commands: ScheduledCommand[]; sessionId: string; opts: ScheduleKeystrokesOptions }
  | { kind: 'native-idle'; entry: NativeIdleEntry };

type ScheduledCommand = string | InjectionCommand;

function commandText(command: ScheduledCommand): string {
  return typeof command === 'string' ? command : command.text;
}

function commandVerifyMode(
  command: ScheduledCommand,
  commandIndex: number,
  opts: ScheduleKeystrokesOptions,
  commandCount: number,
): InjectionCommand['verify'] {
  if (typeof command !== 'string') return command.verify;
  if (!opts.verifier) return 'none';
  const verifiedPrefixLength = Math.min(opts.verifiedPrefixLength ?? commandCount, commandCount);
  return commandIndex < verifiedPrefixLength ? 'command-match' : 'none';
}

interface PendingContent {
  controller: AbortController;
  sessionId: string;
  cleanupReadiness: () => void;
  cleanupLifetime: () => void;
  next: ScheduledSubmission | null;
}

type NativeIdlePhase = 'waiting' | 'leased-uncommitted' | 'committed';

interface NativeIdleEntry {
  readonly token: object;
  readonly request: NativeIdleRequest;
  readonly generation: number;
  readonly deadline: number;
  phase: NativeIdlePhase;
  unsubscribe: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
  lease: SubmissionLease | null;
  successor: ScheduledSubmission | null;
  terminalStatus: boolean;
}

type LiveDeliveryStatusCallback = (status: LiveDeliveryStatus) => void;

/** Options for `scheduleKeystrokes`. */
export interface ScheduleKeystrokesOptions {
  /**
   * True when the session was just spawned (or is `queued` waiting to spawn).
   * The scheduler waits for the CLI's first `'thinking'` activity event
   * before pushing keystrokes - sending them while the CLI still prints its
   * banner gets the text rendered into the wrong place.
   */
  freshlySpawned?: boolean;
  /** Per-command verifier; forwarded to TerminalSubmit.submitKeystrokes. */
  verifier?: CommandVerifier | null;
  /** Verifies leading prefix only; trailing commands fire-and-forget. */
  verifiedPrefixLength?: number;
  strictVerification?: boolean;
  onDelivered?: () => void | Promise<void>;
  /**
   * `immediate` (default) interrupts whatever the agent is doing.
   * `deferred` holds until the current turn genuinely completes.
   */
  mode?: AutoCommandMode;
  /**
   * Hard timeout for the fresh-spawn wait. When the CLI never emits
   * `'thinking'` (e.g. agent hung at startup), we cancel this task's
   * pending injection rather than wait forever. Default 120s.
   */
  timeoutMs?: number;
  /**
   * Rung 3 of the delivery ladder. Invoked when keystroke delivery exhausts
   * its retries on a VERIFIABLE command, so the failure is real rather than
   * merely unobservable. Omit to disable escalation for this burst.
   */
  escalate?: EscalationHandler;
  /** Receives the terminal outcome. */
  onOutcome?: (report: InjectionReport) => void;
}

/** A burst waiting its turn behind the one in flight. */
interface QueuedBurst {
  sessionId: string;
  commands: ScheduledCommand[];
  opts: ScheduleKeystrokesOptions;
}

/** State for a task whose burst is in flight. */
interface ActiveBurst {
  controller: AbortController;
  /**
   * FIFO of follow-ups, NOT a single overwritable slot.
   *
   * The previous implementation kept one `next` and overwrote it, so dragging
   * a task through two auto_command columns in quick succession silently
   * dropped the middle command with no record anywhere. Each entry also
   * carries its OWN sessionId: the old stash dropped it and the drain
   * recursed with the original closure's id, which would misdeliver a burst
   * to a dead session the moment a respawn stopped taking the fresh-spawn
   * branch.
  */
  queue: QueuedBurst[];
  /** Latest non-burst successor, started only after the FIFO has drained. */
  successor: ScheduledSubmission | null;
}

/** State for a task waiting on a fresh-spawn or turn-completion signal. */
interface PendingDeferred {
  cleanup: () => void;
  /**
   * The burst this wait is holding.
   *
   * Kept so a supersede can REPORT the burst it drops. The record is also its
   * own identity token: every async continuation compares
   * `this.deferred.get(taskId) === entry` rather than calling `has(taskId)`,
   * because a presence check cannot tell its own wait from a newer one that
   * has since taken the slot.
   */
  burst: QueuedBurst;
}

/** Options for first-output-gated free-form content delivery. */
export interface ScheduleContentOptions {
  readinessTimeoutMs?: number;
  verifier?: SubmissionVerifier | null;
}

/**
 * `TerminalSubmitScheduler` is the task-keyed lifecycle wrapper for terminal delivery.
 * Where `TerminalSubmit.submitKeystrokes` answers "HOW the bytes go out",
 * this class answers "WHEN", and reports what happened.
 *
 *   1. **Existing session, immediate mode** - delivers now, interrupting the
 *      agent if it is mid-turn. If a burst is already in flight for this
 *      task, the new request queues behind it; nothing is dropped.
 *
 *   2. **Existing session, deferred mode** - holds until the current turn
 *      genuinely completes (see `turn-completion.ts`), then delivers.
 *
 *   3. **Freshly spawned / queued session** - waits for the CLI's first
 *      `'thinking'` activity event. 30s fallback delivers anyway if hooks
 *      never fire; `opts.timeoutMs` (default 120s) caps the total wait.
 *
 *   4. **Free-form content** -- waits for first output with no fallback.
 *      Queue time is outside the readiness timeout, and event/cache readiness
 *      share one start guard. Content completion releases only the latest
 *      queued fresh-spawn keystroke follower.
 *
 * Cancellation tears down content and keystroke readiness listeners/timers,
 * drops queued content followers and burst follow-ups, and aborts in-flight
 * content or keystroke delivery through the per-task `AbortController`.
 * Re-scheduling for the same task cancels any prior pending injection. Native
 * delivery becomes non-cancellable at its first byte; explicit cancellation
 * then drops only its successor so settlement can report the real outcome.
 *
 * Used by every column-transition / lifecycle path that injects keystrokes:
 * auto_command on column move, `/model X` + `/effort Y` settings burst,
 * fresh-spawn auto_command, archive/un-archive flows.
 *
 * On a verifiable command exhausting its retries, delivery escalates to
 * `opts.escalate` (restart + deliver as the CLI prompt argument), which is
 * guaranteed by the spawn rather than by TUI timing. Escalation happens at
 * most once per injection and only once the turn-completion predicate is
 * satisfied, so it can never kill live work.
 */
export class TerminalSubmitScheduler {
  private content = new Map<string, PendingContent>();
  private deferred = new Map<string, PendingDeferred>();
  private active = new Map<string, ActiveBurst>();
  private nativeIdle = new Map<string, NativeIdleEntry>();
  private nextNativeGeneration = 1;
  private taskMutations = new Map<string, object>();
  private acceptingSubmissions = true;
  private suppressNativeLateStatuses = false;

  constructor(
    private sessionManager: SessionManager,
    private terminalSubmit: TerminalSubmit,
    private onLiveDeliveryStatus: LiveDeliveryStatusCallback = () => undefined,
  ) {}

  private beginTaskMutation(taskId: string): object {
    const mutation = {};
    this.taskMutations.set(taskId, mutation);
    return mutation;
  }

  private isTaskMutationCurrent(taskId: string, mutation: object): boolean {
    return this.taskMutations.get(taskId) === mutation;
  }

  private cleanupTaskMutation(taskId: string, expectedMutation?: object): void {
    if (this.content.has(taskId)
      || this.deferred.has(taskId)
      || this.active.has(taskId)
      || this.nativeIdle.has(taskId)) return;
    if (expectedMutation && !this.isTaskMutationCurrent(taskId, expectedMutation)) return;
    this.taskMutations.delete(taskId);
  }

  scheduleContent(
    taskId: string,
    sessionId: string,
    text: string,
    opts: ScheduleContentOptions = {},
  ): void {
    if (!this.acceptingSubmissions || text.length === 0) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;
    const mutation = this.beginTaskMutation(taskId);

    const submission: Extract<ScheduledSubmission, { kind: 'content' }> = {
      kind: 'content',
      sessionId,
      text,
      opts,
    };
    const nativeEntry = this.nativeIdle.get(taskId);
    if (nativeEntry?.phase === 'committed') {
      this.replaceSuccessor(nativeEntry, submission, mutation);
      return;
    }
    if (nativeEntry) this.cancelNativeEntry(nativeEntry, 'superseded');
    if (!this.isTaskMutationCurrent(taskId, mutation)) {
      return;
    }

    this.cancelTask(taskId, 'superseded', mutation);
    if (!this.isTaskMutationCurrent(taskId, mutation)) return;
    const status: SessionStatus = session.status;
    let isQueued: boolean;
    switch (status) {
      case 'running':
        isQueued = false;
        break;
      case 'queued':
        isQueued = true;
        break;
      case 'exited':
      case 'suspended':
        this.cleanupTaskMutation(taskId, mutation);
        return;
      default: {
        const unhandledStatus: never = status;
        return unhandledStatus;
      }
    }

    const entry: PendingContent = {
      controller: new AbortController(),
      sessionId,
      cleanupReadiness: () => undefined,
      cleanupLifetime: () => undefined,
      next: null,
    };
    this.content.set(taskId, entry);
    this.scheduleContentReadiness(
      taskId,
      submission,
      opts,
      entry,
      isQueued,
    );
  }

  /**
   * Schedule a keystroke sequence for a task's PTY session. Chained bursts
   * (e.g. `/effort Y` then the auto_command) pass them all in `commands[]` so
   * the whole burst is delivered as one unit.
   */
  scheduleKeystrokes(
    taskId: string,
    sessionId: string,
    commands: ReadonlyArray<string | InjectionCommand>,
    opts: ScheduleKeystrokesOptions = {},
  ): void {
    if (!this.acceptingSubmissions || commands.length === 0) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[TerminalSubmitScheduler] No session ${sessionId.slice(0, 8)} for task ${taskId.slice(0, 8)} -- skipping`);
      this.report(opts, {
        taskId,
        sessionId,
        commands: commands.map(commandText),
        outcome: 'failed',
        unconfirmedCommands: commands.map(commandText),
        discardedDraft: null,
        interruptedTurn: false,
        escalated: false,
        reason: 'The session was no longer running.',
      });
      return;
    }
    const mutation = this.beginTaskMutation(taskId);

    const submission: Extract<ScheduledSubmission, { kind: 'keystrokes' }> = {
      kind: 'keystrokes',
      commands: [...commands],
      sessionId,
      opts,
    };
    const nativeEntry = this.nativeIdle.get(taskId);
    if (nativeEntry?.phase === 'committed') {
      this.replaceSuccessor(nativeEntry, submission, mutation);
      return;
    }
    if (nativeEntry) this.cancelNativeEntry(nativeEntry, 'superseded');
    if (!this.isTaskMutationCurrent(taskId, mutation)) return;
    const pendingContent = this.content.get(taskId);
    if (pendingContent) {
      if (pendingContent.sessionId === sessionId) {
        this.replaceContentSuccessor(taskId, pendingContent, submission);
        return;
      }
      this.cancelContent(taskId);
      if (!this.isTaskMutationCurrent(taskId, mutation)) return;
    }

    this.scheduleKeystrokeBurst(taskId, submission, mutation);
  }

  scheduleNativeIdleSubmission(request: NativeIdleRequest): LiveDeliveryRegistration | null {
    if (!this.acceptingSubmissions) return null;
    const mutation = this.beginTaskMutation(request.taskId);
    const entry: NativeIdleEntry = {
      token: mutation,
      request,
      generation: this.nextNativeGeneration,
      deadline: Date.now() + request.policy.timeoutMs,
      phase: 'waiting',
      unsubscribe: () => undefined,
      timeout: null,
      lease: null,
      successor: null,
      terminalStatus: false,
    };
    this.nextNativeGeneration += 1;

    const currentNative = this.nativeIdle.get(request.taskId);
    if (currentNative?.phase === 'committed') {
      // committed request 仍握有同一條 FIFO；successor 只能保留最新一筆，否則會形成第二個 task queue。
      if (!this.replaceSuccessor(currentNative, { kind: 'native-idle', entry }, mutation)) {
        this.cancelNativeEntry(entry, 'superseded');
        return null;
      }
      return this.watchNativeEntryAndRegister(entry);
    }
    if (currentNative) this.cancelNativeEntry(currentNative, 'superseded');
    if (!this.isTaskMutationCurrent(request.taskId, mutation)) {
      this.cancelNativeEntry(entry, 'superseded');
      return null;
    }

    const pendingContent = this.content.get(request.taskId);
    if (pendingContent) {
      if (!this.replaceContentSuccessor(
        request.taskId,
        pendingContent,
        { kind: 'native-idle', entry },
      )) {
        this.cancelNativeEntry(entry, 'superseded');
        return null;
      }
      return this.watchNativeEntryAndRegister(entry);
    }

    const activeBurst = this.active.get(request.taskId);
    if (activeBurst) {
      if (!this.replaceActiveSuccessor(
        request.taskId,
        activeBurst,
        { kind: 'native-idle', entry },
      )) {
        this.cancelNativeEntry(entry, 'superseded');
        return null;
      }
      return this.watchNativeEntryAndRegister(entry);
    }

    this.cancelKeystrokeBurst(request.taskId);
    if (!this.isTaskMutationCurrent(request.taskId, mutation)) {
      this.cancelNativeEntry(entry, 'superseded');
      return null;
    }
    this.nativeIdle.set(request.taskId, entry);
    return this.watchNativeEntryAndRegister(entry);
  }

  private scheduleKeystrokeBurst(
    taskId: string,
    submission: Extract<ScheduledSubmission, { kind: 'keystrokes' }>,
    mutation: object = this.beginTaskMutation(taskId),
  ): void {
    if (!this.acceptingSubmissions || !this.isTaskMutationCurrent(taskId, mutation)) return;
    const { sessionId, commands, opts } = submission;
    const isQueued = this.sessionManager.getSession(sessionId)?.status === 'queued';
    const freshlySpawned = opts.freshlySpawned ?? false;
    const burst: QueuedBurst = { sessionId, commands: [...commands], opts };

    // Existing session, ready right now.
    if (!freshlySpawned && !isQueued) {
      const existing = this.active.get(taskId);
      if (existing) {
        this.cancelScheduledNative(existing.successor, 'superseded');
        existing.successor = null;
        existing.queue.push(burst);
        console.log(
          `[TerminalSubmitScheduler] Queued burst ${existing.queue.length} for task ${taskId.slice(0, 8)} (burst in flight)`,
        );
        return;
      }
      if ((opts.mode ?? 'immediate') === 'deferred') {
        // A deferred wait can be long (a turn, up to the 120s cap), so a second
        // deferred burst for the same task routinely arrives while the first is
        // still waiting. Retire the older one explicitly - and report it - so
        // the two never race for the single `deferred` slot.
        this.supersedeDeferred(taskId);
        this.scheduleAfterTurn(taskId, burst);
        return;
      }
      this.startBurst(taskId, burst);
      return;
    }

    // Fresh spawn or queued - wait for CLI to come alive, then start the burst.
    this.cancelKeystrokeBurst(taskId);
    if (!this.isTaskMutationCurrent(taskId, mutation)) return;
    this.scheduleDeferred(taskId, burst, isQueued);
  }

  private replaceContentSuccessor(
    taskId: string,
    entry: PendingContent,
    successor: ScheduledSubmission,
  ): boolean {
    const mutation = this.taskMutations.get(taskId);
    if (!mutation) return false;
    this.cancelScheduledNative(entry.next, 'superseded');
    if (!this.isTaskMutationCurrent(taskId, mutation)) return false;
    entry.next = successor;
    return true;
  }

  private replaceActiveSuccessor(
    taskId: string,
    entry: ActiveBurst,
    successor: ScheduledSubmission,
  ): boolean {
    const mutation = this.taskMutations.get(taskId);
    if (!mutation) return false;
    this.cancelScheduledNative(entry.successor, 'superseded');
    if (!this.isTaskMutationCurrent(taskId, mutation)) return false;
    entry.successor = successor;
    return true;
  }

  private replaceSuccessor(
    entry: NativeIdleEntry,
    successor: ScheduledSubmission,
    mutation: object,
  ): boolean {
    this.cancelScheduledNative(entry.successor, 'superseded');
    if (!this.isTaskMutationCurrent(entry.request.taskId, mutation)) return false;
    entry.successor = successor;
    return true;
  }

  private cancelScheduledNative(
    submission: ScheduledSubmission | null,
    reason: LiveDeliveryCancellationReason,
  ): void {
    if (submission?.kind === 'native-idle') this.cancelNativeEntry(submission.entry, reason);
  }

  private cancelStrictNativeSuccessor(entry: ActiveBurst): void {
    const successor = entry.successor;
    if (successor?.kind !== 'native-idle') return;
    entry.successor = null;
    this.cancelNativeEntry(successor.entry, 'delivery-error');
  }

  private startScheduledSubmission(taskId: string, submission: ScheduledSubmission): void {
    if (!this.acceptingSubmissions) return;
    switch (submission.kind) {
      case 'content':
        this.scheduleContent(taskId, submission.sessionId, submission.text, submission.opts);
        return;
      case 'keystrokes': {
        this.scheduleKeystrokes(taskId, submission.sessionId, submission.commands, submission.opts);
        return;
      }
      case 'native-idle':
        if (submission.entry.terminalStatus) return;
        this.taskMutations.set(taskId, submission.entry.token);
        this.nativeIdle.set(taskId, submission.entry);
        this.evaluateNativeEntry(submission.entry);
        return;
      default: {
        const unhandledSubmission: never = submission;
        return unhandledSubmission;
      }
    }
  }

  /**
   * Cancel any pending or in-flight injection for a specific task. Aborts the
   * AbortController plumbed through to TerminalSubmit so an in-flight burst
   * stops at the next write/wait boundary, and drops every queued follow-up,
   * content follower, and uncommitted native successor.
   */
  cancel(taskId: string): void {
    const mutation = this.beginTaskMutation(taskId);
    this.cancelTask(taskId, 'superseded', mutation);
    this.cleanupTaskMutation(taskId, mutation);
  }

  private cancelTask(
    taskId: string,
    reason: LiveDeliveryCancellationReason,
    mutation: object,
  ): void {
    this.cancelContent(taskId, reason);
    if (!this.isTaskMutationCurrent(taskId, mutation)) return;
    this.cancelKeystrokeBurst(taskId, reason);
    if (!this.isTaskMutationCurrent(taskId, mutation)) return;
    const nativeEntry = this.nativeIdle.get(taskId);
    if (nativeEntry) {
      this.cancelNativeEntry(nativeEntry, reason);
      if (nativeEntry.phase === 'committed'
        && this.nativeIdle.get(taskId) === nativeEntry
        && this.isTaskMutationCurrent(taskId, mutation)) {
        this.taskMutations.set(taskId, nativeEntry.token);
      }
    }
  }

  private cancelContent(
    taskId: string,
    nativeReason: LiveDeliveryCancellationReason = 'superseded',
  ): void {
    const pending = this.content.get(taskId);
    if (!pending) return;

    this.content.delete(taskId);
    this.cancelScheduledNative(pending.next, nativeReason);
    pending.next = null;
    pending.cleanupLifetime();
    pending.controller.abort();
  }

  private cancelKeystrokeBurst(
    taskId: string,
    nativeReason: LiveDeliveryCancellationReason = 'superseded',
  ): void {
    const pending = this.deferred.get(taskId);
    if (pending) {
      this.deferred.delete(taskId);
      pending.cleanup();
    }
    const burst = this.active.get(taskId);
    if (burst) {
      this.cancelScheduledNative(burst.successor, nativeReason);
      burst.successor = null;
      burst.queue.length = 0;
      burst.controller.abort();
    }
  }

  /** Cancel all pending injections. Called on `killAll`/`suspendAll`. */
  cancelAll(reason?: 'shutdown'): void {
    if (reason === 'shutdown') {
      // admission 必須先關閉，否則 shutdown cancellation callback 可在 snapshot iteration 外建立新 owner。
      this.acceptingSubmissions = false;
    }
    const nativeReason: LiveDeliveryCancellationReason = reason ?? 'superseded';
    const taskIds = new Set([
      ...this.content.keys(),
      ...this.deferred.keys(),
      ...this.active.keys(),
      ...this.nativeIdle.keys(),
    ]);
    for (const taskId of taskIds) {
      const mutation = this.beginTaskMutation(taskId);
      this.cancelTask(taskId, nativeReason, mutation);
      this.cleanupTaskMutation(taskId, mutation);
    }
    if (reason === 'shutdown') {
      this.suppressNativeLateStatuses = true;
      this.taskMutations.clear();
    }
  }

  private watchNativeEntry(entry: NativeIdleEntry): void {
    const onEvidenceChanged = (): void => this.evaluateNativeEntry(entry);
    entry.unsubscribe = this.sessionManager.subscribeNativeIdle(entry.request.sessionId, onEvidenceChanged);
    const remaining = Math.max(0, entry.deadline - Date.now());
    entry.timeout = setTimeout(() => {
      if (!this.isNativeEntryOwned(entry) || entry.phase === 'committed') return;
      this.cancelNativeEntry(entry, 'timeout');
    }, remaining);
    this.emitNativeStatus(entry, { state: 'waiting' });
    this.evaluateNativeEntry(entry);
  }

  private watchNativeEntryAndRegister(entry: NativeIdleEntry): LiveDeliveryRegistration | null {
    this.watchNativeEntry(entry);
    // waiting status observer 會同步執行；若它替換目前 owner，這次 admission 不可回報 accepted。
    return this.isNativeEntryOwned(entry) ? { accepted: true, generation: entry.generation } : null;
  }

  private evaluateNativeEntry(entry: NativeIdleEntry): void {
    if (!this.acceptingSubmissions
      || !this.isNativeEntryOwned(entry)
      || entry.terminalStatus
      || entry.phase !== 'waiting') return;
    if (this.hasNativeDeadlineElapsed(entry)) {
      this.cancelNativeEntry(entry, 'timeout');
      return;
    }
    // 只接受 expectation 指定的 root-native clean idle；不可退回 generic activity，否則 child idle 會提早放行。
    const readiness = evaluateNativeIdleReadiness(
      this.sessionManager.snapshotNativeIdle(entry.request.sessionId),
      entry.request,
    );
    if (readiness !== 'waiting' && readiness !== 'ready') {
      this.cancelNativeEntry(entry, readiness);
      return;
    }
    const validation = entry.request.validateCurrent();
    if (validation !== 'valid') {
      this.cancelNativeEntry(entry, validation);
      return;
    }
    if (readiness !== 'ready'
      || entry.phase !== 'waiting'
      || entry.terminalStatus
      || this.nativeIdle.get(entry.request.taskId) !== entry) return;
    this.acquireAndSubmitNative(entry);
  }

  private acquireAndSubmitNative(entry: NativeIdleEntry): void {
    if (this.hasNativeDeadlineElapsed(entry)) {
      this.cancelNativeEntry(entry, 'timeout');
      return;
    }
    entry.phase = 'leased-uncommitted';
    const lease = this.sessionManager.acquireAutomation(
      entry.request.sessionId,
      {
        sessionGeneration: entry.request.sessionGeneration,
        inputGeneration: entry.request.inputGeneration,
      },
      () => {
        if (entry.phase === 'leased-uncommitted') entry.phase = 'committed';
      },
    );
    entry.lease = lease;
    if (!lease) {
      entry.phase = 'waiting';
      const reason = this.hasNativeDeadlineElapsed(entry)
        ? 'timeout'
        : this.classifyNativeAdmissionFailure(entry);
      this.cancelNativeEntry(entry, reason);
      return;
    }
    if (this.hasNativeDeadlineElapsed(entry)) {
      this.cancelNativeEntry(entry, 'timeout');
      return;
    }

    this.emitNativeStatus(entry, { state: 'sending' });

    const readiness = evaluateNativeIdleReadiness(
      this.sessionManager.snapshotNativeIdle(entry.request.sessionId),
      entry.request,
    );
    const validation = entry.request.validateCurrent();
    const deadlineElapsed = this.hasNativeDeadlineElapsed(entry);
    const leaseMatches = lease.sessionId === entry.request.sessionId
      && lease.sessionGeneration === entry.request.sessionGeneration
      && lease.inputGeneration === entry.request.inputGeneration;
    if (this.nativeIdle.get(entry.request.taskId) !== entry
      || !this.isTaskMutationCurrent(entry.request.taskId, entry.token)
      || entry.terminalStatus
      || entry.phase !== 'leased-uncommitted'
      || entry.lease !== lease
      || !leaseMatches
      || deadlineElapsed
      || readiness !== 'ready'
      || validation !== 'valid') {
      if (!entry.terminalStatus) {
        const reason = deadlineElapsed
          ? 'timeout'
          : validation === 'valid'
          ? readiness === 'user-input' || readiness === 'turn-error' || readiness === 'session-exit'
            ? readiness
            : 'delivery-error'
          : validation;
        this.cancelNativeEntry(entry, reason);
      }
      return;
    }

    // final guard 後必須同 call stack 進入 writer；插入 await 會讓 user input 越過 first-byte commitment。
    const delivery = this.terminalSubmit.submitKeystrokes(
      entry.request.sessionId,
      [entry.request.command],
      {
      writer: lease,
      sendCtrlC: false,
      verifier: null,
      verifiedPrefixLength: 0,
      source: 'live-delivery',
      },
    );
    this.settleNativeDelivery(entry, delivery);
  }

  private classifyNativeAdmissionFailure(entry: NativeIdleEntry): LiveDeliveryCancellationReason {
    const readiness = evaluateNativeIdleReadiness(
      this.sessionManager.snapshotNativeIdle(entry.request.sessionId),
      entry.request,
    );
    if (readiness !== 'waiting' && readiness !== 'ready') return readiness;
    const validation = entry.request.validateCurrent();
    if (validation !== 'valid') return validation;
    return 'delivery-error';
  }

  private hasNativeDeadlineElapsed(entry: NativeIdleEntry): boolean {
    return Date.now() >= entry.deadline;
  }

  private settleNativeDelivery(
    entry: NativeIdleEntry,
    delivery: Promise<SubmitKeystrokesResult>,
  ): void {
    void delivery.then(
      (result) => {
        if (this.nativeIdle.get(entry.request.taskId) !== entry || entry.terminalStatus) return;
        if (entry.phase === 'committed'
          && (result === undefined
            || (result.outcome !== 'failed' && result.outcome !== 'aborted'))) {
          this.finishNativeStatus(entry, { state: 'delivered' });
        } else {
          this.finishNativeStatus(entry, { state: 'cancelled', reason: 'delivery-error' });
        }
      },
      () => {
        if (this.nativeIdle.get(entry.request.taskId) !== entry || entry.terminalStatus) return;
        const snapshot = this.sessionManager.snapshotNativeIdle(entry.request.sessionId);
        const reason: LiveDeliveryCancellationReason = snapshot === null
          || snapshot.sessionGeneration !== entry.request.sessionGeneration
          ? 'session-exit'
          : 'delivery-error';
        this.finishNativeStatus(entry, { state: 'cancelled', reason });
      },
    ).finally(() => {
      entry.lease?.release();
      entry.lease = null;
      const successor = entry.successor;
      entry.successor = null;
      if (this.nativeIdle.get(entry.request.taskId) === entry) {
        this.nativeIdle.delete(entry.request.taskId);
      }
      if (!this.suppressNativeLateStatuses && successor) {
        this.startScheduledSubmission(entry.request.taskId, successor);
      }
      // Successor timeout 可先移除 owner 卻留下較新的 token；此時只在所有 owner 都結束後清 current token。
      this.cleanupTaskMutation(
        entry.request.taskId,
        this.taskMutations.get(entry.request.taskId),
      );
    });
  }

  private cancelNativeEntry(entry: NativeIdleEntry, reason: LiveDeliveryCancellationReason): void {
    const successor = entry.successor;
    entry.successor = null;
    if (entry.terminalStatus) {
      this.cancelScheduledNative(successor, reason);
      return;
    }
    if (entry.phase === 'committed' && reason !== 'shutdown') {
      this.cancelScheduledNative(successor, reason);
      return;
    }
    if (!this.closeNativeEntry(entry)) return;
    if (entry.phase !== 'committed') {
      entry.lease?.release();
      entry.lease = null;
      this.removeNativeEntryOwnership(entry);
    }
    this.emitNativeStatus(entry, { state: 'cancelled', reason });
    this.cancelScheduledNative(successor, reason);
    this.cleanupTaskMutation(entry.request.taskId, entry.token);
  }

  private finishNativeStatus(
    entry: NativeIdleEntry,
    status: { readonly state: 'delivered' }
      | { readonly state: 'cancelled'; readonly reason: LiveDeliveryCancellationReason },
  ): void {
    if (!this.closeNativeEntry(entry)) return;
    this.emitNativeStatus(entry, status);
  }

  private closeNativeEntry(entry: NativeIdleEntry): boolean {
    if (entry.terminalStatus) return false;
    entry.terminalStatus = true;
    entry.unsubscribe();
    entry.unsubscribe = () => undefined;
    if (entry.timeout !== null) clearTimeout(entry.timeout);
    entry.timeout = null;
    return true;
  }

  private emitNativeStatus(
    entry: NativeIdleEntry,
    status: { readonly state: 'waiting' | 'sending' | 'delivered' }
      | { readonly state: 'cancelled'; readonly reason: LiveDeliveryCancellationReason },
  ): void {
    if (this.suppressNativeLateStatuses) return;
    try {
      this.onLiveDeliveryStatus({
        projectId: entry.request.projectId,
        taskId: entry.request.taskId,
        sessionId: entry.request.sessionId,
        generation: entry.generation,
        at: new Date().toISOString(),
        ...status,
      });
    } catch {
      return;
    }
  }

  private isNativeEntryOwned(entry: NativeIdleEntry): boolean {
    if (this.nativeIdle.get(entry.request.taskId) === entry) return true;
    const content = this.content.get(entry.request.taskId)?.next;
    if (content?.kind === 'native-idle' && content.entry === entry) return true;
    const active = this.active.get(entry.request.taskId)?.successor;
    if (active?.kind === 'native-idle' && active.entry === entry) return true;
    const successor = this.nativeIdle.get(entry.request.taskId)?.successor;
    return successor?.kind === 'native-idle' && successor.entry === entry;
  }

  private removeNativeEntryOwnership(entry: NativeIdleEntry): void {
    const taskId = entry.request.taskId;
    if (this.nativeIdle.get(taskId) === entry) this.nativeIdle.delete(taskId);
    const content = this.content.get(taskId);
    if (content?.next?.kind === 'native-idle' && content.next.entry === entry) content.next = null;
    const active = this.active.get(taskId);
    if (active?.successor?.kind === 'native-idle' && active.successor.entry === entry) {
      active.successor = null;
    }
    const currentNative = this.nativeIdle.get(taskId);
    if (currentNative?.successor?.kind === 'native-idle'
      && currentNative.successor.entry === entry) currentNative.successor = null;
  }

  private scheduleContentReadiness(
    taskId: string,
    submission: Extract<ScheduledSubmission, { kind: 'content' }>,
    opts: ScheduleContentOptions,
    entry: PendingContent,
    isQueued: boolean,
  ): void {
    const readinessTimeoutMs = opts.readinessTimeoutMs ?? 120_000;
    let state: 'queued' | 'waiting' = isQueued ? 'queued' : 'waiting';
    let readinessTimer: ReturnType<typeof setTimeout> | null = null;
    let started = false;
    let readinessCleaned = false;
    let lifetimeCleaned = false;

    const cleanupReadiness = (): void => {
      if (readinessCleaned) return;
      readinessCleaned = true;
      this.sessionManager.off('first-output', onFirstOutput);
      this.sessionManager.off('session-changed', onSessionChanged);
      if (readinessTimer !== null) clearTimeout(readinessTimer);
    };

    const cleanupLifetime = (): void => {
      if (lifetimeCleaned) return;
      lifetimeCleaned = true;
      cleanupReadiness();
      this.sessionManager.off('exit', onExit);
    };

    const startContent = (): void => {
      if (!this.acceptingSubmissions || started || this.content.get(taskId) !== entry) return;
      started = true;
      // Readiness 結束後仍保留 exit listener；session ownership 必須持續到 submitContent() settle。
      cleanupReadiness();
      void this.runContent(taskId, submission, opts, entry);
    };

    const startFromCache = (): void => {
      if (this.sessionManager.getFirstOutputCache()[submission.sessionId] === true) {
        startContent();
      }
    };

    const startReadinessTimer = (): void => {
      if (readinessTimer !== null) return;
      readinessTimer = setTimeout(() => {
        if (this.content.get(taskId) !== entry) return;
        console.warn(
          `[TerminalSubmitScheduler] submit-content readiness timeout task=${taskId.slice(0, 8)} session=${submission.sessionId.slice(0, 8)}`,
        );
        this.cancel(taskId);
      }, readinessTimeoutMs);
    };

    const onFirstOutput = (eventSessionId: string): void => {
      if (eventSessionId !== submission.sessionId || state !== 'waiting') return;
      startContent();
    };

    const onSessionChanged = (eventSessionId: string, eventSession: { status: string }): void => {
      if (eventSessionId !== submission.sessionId) return;
      if (this.content.get(taskId) !== entry) return;
      if (state === 'queued' && eventSession.status === 'running') {
        state = 'waiting';
        startReadinessTimer();
        startFromCache();
      }
    };

    const onExit = (eventSessionId: string): void => {
      if (eventSessionId !== entry.sessionId) return;
      if (this.content.get(taskId) !== entry) return;
      console.log(
        `[TerminalSubmitScheduler] submit-content session exit task=${taskId.slice(0, 8)} session=${submission.sessionId.slice(0, 8)}`,
      );
      this.cancel(taskId);
    };

    entry.cleanupReadiness = cleanupReadiness;
    entry.cleanupLifetime = cleanupLifetime;
    this.sessionManager.on('first-output', onFirstOutput);
    this.sessionManager.on('session-changed', onSessionChanged);
    this.sessionManager.on('exit', onExit);

    if (!isQueued) {
      startReadinessTimer();
      startFromCache();
    }
  }

  private async runContent(
    taskId: string,
    submission: Extract<ScheduledSubmission, { kind: 'content' }>,
    opts: ScheduleContentOptions,
    entry: PendingContent,
  ): Promise<void> {
    try {
      await this.terminalSubmit.submitContent(submission.sessionId, submission.text, {
        signal: entry.controller.signal,
        source: `task:${taskId.slice(0, 8)}`,
        verifier: opts.verifier ?? undefined,
      });
    } catch {
      if (this.content.get(taskId) === entry) {
        console.error(
          `[TerminalSubmitScheduler] submit-content failed task=${taskId.slice(0, 8)} session=${submission.sessionId.slice(0, 8)}`,
        );
        this.cancel(taskId);
      }
      this.cleanupTaskMutation(taskId);
      return;
    }

    if (this.content.get(taskId) !== entry || entry.controller.signal.aborted) {
      this.cleanupTaskMutation(taskId);
      return;
    }

    const follower = entry.next;
    entry.next = null;
    this.content.delete(taskId);
    entry.cleanupLifetime();

    if (follower) {
      if (follower.kind === 'keystrokes') {
        this.startBurst(taskId, {
          sessionId: follower.sessionId,
          commands: follower.commands,
          opts: { ...follower.opts, freshlySpawned: true },
        });
      } else {
        this.startScheduledSubmission(taskId, follower);
      }
    }
    this.cleanupTaskMutation(taskId);
  }

  private startBurst(taskId: string, burst: QueuedBurst): void {
    if (!this.acceptingSubmissions) return;
    const entry: ActiveBurst = {
      controller: new AbortController(),
      queue: [],
      successor: null,
    };
    this.active.set(taskId, entry);
    void this.runBurst(taskId, burst, entry);
  }

  private async runBurst(taskId: string, burst: QueuedBurst, entry: ActiveBurst): Promise<void> {
    const commandTexts = burst.commands.map(commandText);
    let delivered = false;
    let report: InjectionReport = {
      taskId,
      sessionId: burst.sessionId,
      commands: commandTexts,
      outcome: 'failed',
      unconfirmedCommands: commandTexts,
      discardedDraft: null,
      interruptedTurn: false,
      escalated: false,
    };

    try {
      const activity = typeof this.sessionManager.getActivityCache === 'function'
        ? this.sessionManager.getActivityCache()[burst.sessionId]
        : undefined;
      const pendingDraft = typeof this.sessionManager.getPendingDraft === 'function'
        ? this.sessionManager.getPendingDraft(burst.sessionId)
        : null;
      const result: SubmitKeystrokesResult = await this.terminalSubmit.submitKeystrokes(
        burst.sessionId,
        burst.commands,
        {
          freshlySpawned: burst.opts.freshlySpawned,
          pendingDraft,
          // activity-state-ok: granular - only a genuinely thinking agent is
          // being interrupted, which is what we report to the user.
          interruptingTurn: activity === 'thinking',
          verifier: burst.opts.verifier,
          strictVerification: burst.opts.strictVerification,
          signal: entry.controller.signal,
          source: `task:${taskId.slice(0, 8)}`,
        },
      );

      if (result === undefined) {
        report = { ...report, outcome: 'unconfirmed', unconfirmedCommands: [] };
        delivered = true;
      } else {

        report = {
          ...report,
          outcome: result.outcome === 'aborted' ? 'cancelled' : result.outcome,
          unconfirmedCommands: result.unconfirmedCommands,
          discardedDraft: result.discardedDraft,
          interruptedTurn: result.interruptedTurn,
        };

        if (result.outcome === 'failed') {
          report = await this.escalate(taskId, burst, entry, report);
        }
        delivered = result.outcome !== 'failed' && result.outcome !== 'aborted';
        if (burst.opts.strictVerification && result.outcome === 'failed') {
          this.cancelStrictNativeSuccessor(entry);
        }
      }
    } catch (caughtError) {
      delivered = false;
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (message.includes('abort')) {
        report = { ...report, outcome: 'cancelled' };
      } else {
        console.error(`[TerminalSubmitScheduler] Burst failed for task ${taskId.slice(0, 8)}: ${message}`);
        report = { ...report, outcome: 'failed', reason: message };
      }
      if (burst.opts.strictVerification) {
        this.cancelStrictNativeSuccessor(entry);
      }
    }

    if (delivered && this.active.get(taskId) === entry && !entry.controller.signal.aborted) {
      try {
        await burst.opts.onDelivered?.();
      } catch (caughtError) {
        delivered = false;
        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        console.error(`[TerminalSubmitScheduler] Burst completion failed for task ${taskId.slice(0, 8)}: ${message}`);
        report = { ...report, outcome: 'failed', reason: message };
        this.cancelStrictNativeSuccessor(entry);
      }
    }

    this.report(burst.opts, report);

    // The burst slot is still ours - drain the FIFO before releasing it.
    const current = this.active.get(taskId);
    if (current === entry && entry.queue.length > 0) {
      const nextBurst = entry.queue.shift();
      if (nextBurst) {
        // Fresh AbortController so the new burst is independently cancellable,
        // and the NEXT burst's own sessionId, never this one's.
        const next: ActiveBurst = {
          controller: new AbortController(),
          queue: entry.queue,
          successor: entry.successor,
        };
        entry.successor = null;
        this.active.set(taskId, next);
        void this.runBurst(taskId, nextBurst, next);
        return;
      }
    }
    if (current === entry) {
      const successor = entry.successor;
      entry.successor = null;
      this.active.delete(taskId);
      if (successor) this.startScheduledSubmission(taskId, successor);
    }
    this.cleanupTaskMutation(taskId);
  }

  /**
   * Deferred mode on a live session: hold the burst until the agent's current
   * turn genuinely completes, then deliver.
   *
   * Uses the shared turn-completion predicate, so this waits out an API retry
   * backoff or a `Monitor` wait rather than firing into the middle of one -
   * both of which the activity engine reports as idle for minutes at a time.
   *
   * A timeout does NOT drop the command. Immediate mode is the fallback:
   * arriving late and interrupting is strictly better than never arriving,
   * and the interruption is reported to the user either way.
   */
  private scheduleAfterTurn(taskId: string, burst: QueuedBurst): void {
    const controller = new AbortController();
    const entry: PendingDeferred = { cleanup: (): void => controller.abort(), burst };
    this.deferred.set(taskId, entry);

    void waitForTurnCompletion(this.sessionManager, burst.sessionId, {
      signal: controller.signal,
      timeoutMs: burst.opts.timeoutMs,
    }).then((result) => {
      // Identity, NOT presence. `cancel()` aborts this wait synchronously, but
      // this callback only runs a microtask later - by which time a newer burst
      // may already hold the slot. A bare `has(taskId)` would then delete the
      // NEWER entry and strand it (its own continuation finds nothing and
      // returns silently), while delivering this stale burst in its place.
      // Same guard shape as `runBurst`'s `current === entry`.
      if (this.deferred.get(taskId) !== entry) return;
      this.deferred.delete(taskId);

      if (result === 'aborted') return;
      if (result === 'exited') {
        this.report(burst.opts, {
          taskId,
          sessionId: burst.sessionId,
          commands: burst.commands.map(commandText),
          outcome: 'failed',
          unconfirmedCommands: burst.commands.map(commandText),
          discardedDraft: null,
          interruptedTurn: false,
          escalated: false,
          reason: 'The session exited before its turn finished, so the command was not sent.',
        });
        return;
      }
      if (result === 'timeout') {
        console.warn(
          `[TerminalSubmitScheduler] Deferred wait timed out for task ${taskId.slice(0, 8)}, delivering immediately`,
        );
      }
      this.startBurst(taskId, burst);
    });
  }

  /**
   * Retire a deferred wait that a newer burst has replaced.
   *
   * The drop is reported as `cancelled` rather than being silent. A superseded
   * burst is still a command the board asked for and never sent, and the whole
   * point of the rebuild is that no delivery outcome is unobservable. It stays
   * quiet for the USER (`shouldNotify` treats `cancelled` as noise, since the
   * usual cause is their own second move) while landing in the durable record.
   */
  private supersedeDeferred(taskId: string): void {
    const pending = this.deferred.get(taskId);
    if (!pending) return;
    this.deferred.delete(taskId);
    pending.cleanup();
    const commandTexts = pending.burst.commands.map(commandText);
    this.report(pending.burst.opts, {
      taskId,
      sessionId: pending.burst.sessionId,
      commands: commandTexts,
      outcome: 'cancelled',
      unconfirmedCommands: commandTexts,
      discardedDraft: null,
      interruptedTurn: false,
      escalated: false,
      reason: 'A newer command for this task replaced it before it was sent.',
    });
  }

  /**
   * Rung 3: keystrokes could not be confirmed, so restart the session and
   * deliver the commands as the CLI's prompt argument instead - a path whose
   * delivery is guaranteed by the spawn rather than by TUI timing.
   *
   * Gated on the SAME turn-completion predicate deferred mode uses, not a
   * bare idle check: restarting during a 529 retry backoff or a Monitor wait
   * would destroy live work, and both of those read as idle.
   *
   * Attempted at most once. If the restart itself does not deliver, the
   * outcome stays `failed` and the user is told.
   */
  private async escalate(
    taskId: string,
    burst: QueuedBurst,
    entry: ActiveBurst,
    report: InjectionReport,
  ): Promise<InjectionReport> {
    const escalateHandler = burst.opts.escalate;
    if (!escalateHandler) {
      return { ...report, reason: 'The command could not be confirmed in the agent transcript.' };
    }

    // Only the USER's auto_command is worth a restart. An adapter-emitted
    // settings write must never ride along: joined into an argv prompt it stops
    // being a slash invocation and becomes literal text the agent reads as part
    // of the message. A settings change also has its own restart path, and
    // `--resume` preserves what was already applied, so a failed `/effort`
    // alone is not a reason to respawn a session.
    //
    // `escalatable !== false` is the CONFIRM-ONLY gate. An adapter that has not
    // proven its verifier end to end still gets one, because retry-on-Enter is
    // pure upside, but a false negative there would be a guess - and acting on
    // a guess here restarts a session and destroys live work. Those adapters
    // confirm and retry; they never authorize the restart.
    const escalatable = burst.commands
      .filter((command, commandIndex) => (
        commandVerifyMode(command, commandIndex, burst.opts, burst.commands.length) === 'submitted'
        && (typeof command === 'string' || command.escalatable !== false)
        && report.unconfirmedCommands.includes(commandText(command))
      ))
      .map(commandText);
    if (escalatable.length === 0) {
      return { ...report, reason: 'The command could not be confirmed in the agent transcript.' };
    }

    const completion = await waitForTurnCompletion(this.sessionManager, burst.sessionId, {
      signal: entry.controller.signal,
    });
    if (completion !== 'completed') {
      return {
        ...report,
        reason: `The command could not be confirmed, and the session was not safe to restart (${completion}).`,
      };
    }

    try {
      const restarted = await escalateHandler(escalatable);
      if (restarted) {
        console.log(
          `[TerminalSubmitScheduler] Escalated task ${taskId.slice(0, 8)}: restarted with the command as the prompt`,
        );
        // NOT `confirmed`. The handler resolving true means the restart was
        // ISSUED, not that a verifier saw the command land. Argv delivery is
        // guaranteed by the spawn, which is why this is not a failure either -
        // but claiming confirmation nothing checked would be the same silent
        // success this whole rebuild exists to remove.
        return { ...report, escalated: true, unconfirmedCommands: [] };
      }
      return { ...report, reason: 'The command could not be confirmed, and the session restart did not run.' };
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      return { ...report, reason: `The command could not be confirmed, and the retry failed: ${message}` };
    }
    this.cleanupTaskMutation(taskId);
  }

  /**
   * Wait for the right moment, then start the burst.
   *
   * Fresh spawn / queued: wait for the CLI's first `'thinking'` event (it is
   * alive and rendering), with a 30s fallback for adapters that have no
   * thinking hook and a hard timeout for a genuinely hung startup.
   */
  private scheduleDeferred(taskId: string, burst: QueuedBurst, isQueued: boolean): void {
    const { sessionId, opts } = burst;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let state: 'queued' | 'waiting' = isQueued ? 'queued' : 'waiting';
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    // Identity, not presence. `entry` is created at the foot of this function,
    // before any listener or timer below can fire. A bare
    // `this.deferred.has(taskId)` is equally satisfied by a NEWER wait that has
    // since taken the slot, which would let this stale burst deliver in its
    // place and strand the new one. See `PendingDeferred.burst`.
    const isCurrent = (): boolean => this.deferred.get(taskId) === entry;

    const hardTimer = setTimeout(() => {
      console.warn(`[TerminalSubmitScheduler] Hard timeout (${timeoutMs}ms) for task ${taskId.slice(0, 8)} -- cancelling`);
      this.cancel(taskId);
      this.report(opts, {
        taskId,
        sessionId,
        commands: burst.commands.map(commandText),
        outcome: 'failed',
        unconfirmedCommands: burst.commands.map(commandText),
        discardedDraft: null,
        interruptedTurn: false,
        escalated: false,
        reason: 'The agent never became ready, so the command was not sent.',
      });
    }, timeoutMs);

    const startFallbackTimer = (): void => {
      if (fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        if (!isCurrent()) return;
        console.log(`[TerminalSubmitScheduler] 30s fallback for task ${taskId.slice(0, 8)} -- delivering anyway`);
        detachAndDeliver();
      }, 30_000);
    };

    const detachAndDeliver = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('session-changed', onSessionChanged);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
      this.deferred.delete(taskId);
      this.startBurst(taskId, burst);
    };

    const onActivity = (evtSessionId: string, activityState: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!isCurrent()) return;
      if (state === 'waiting' && activityState === 'thinking') detachAndDeliver();
    };

    const onSessionChanged = (evtSessionId: string, evtSession: { status: string }): void => {
      if (evtSessionId !== sessionId) return;
      if (!isCurrent()) return;
      if (state === 'queued' && evtSession.status === 'running') {
        state = 'waiting';
        startFallbackTimer();
      }
    };

    const onExit = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!isCurrent()) return;
      console.log(`[TerminalSubmitScheduler] Session ${sessionId.slice(0, 8)} exited -- cancelling injection for task ${taskId.slice(0, 8)}`);
      this.cancel(taskId);
      this.report(opts, {
        taskId,
        sessionId,
        commands: burst.commands.map(commandText),
        outcome: 'failed',
        unconfirmedCommands: burst.commands.map(commandText),
        discardedDraft: null,
        interruptedTurn: false,
        escalated: false,
        reason: 'The session exited before the command could be sent.',
      });
    };

    this.sessionManager.on('activity', onActivity);
    this.sessionManager.on('session-changed', onSessionChanged);
    this.sessionManager.on('exit', onExit);

    if (!isQueued) startFallbackTimer();

    const entry: PendingDeferred = {
      cleanup: (): void => {
        this.sessionManager.off('activity', onActivity);
        this.sessionManager.off('session-changed', onSessionChanged);
        this.sessionManager.off('exit', onExit);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        clearTimeout(hardTimer);
      },
      burst,
    };
    this.deferred.set(taskId, entry);
  }

  private report(opts: ScheduleKeystrokesOptions, report: InjectionReport): void {
    if (!opts.onOutcome) return;
    try {
      opts.onOutcome(report);
    } catch (caughtError) {
      console.error('[TerminalSubmitScheduler] onOutcome handler threw:', caughtError);
    }
  }
}
