import type { SessionManager } from '../pty/session-manager';
import type { CommandVerifier, TerminalSubmit } from '../pty/terminal-submit';
import type { SubmissionLease } from '../pty/session-write-coordinator';
import type { SessionStatus, SubmissionVerifier } from '../../shared/types';
import {
  evaluateNativeIdleReadiness,
  type LiveDeliveryCancellationReason,
  type NativeIdleRequest,
} from './native-idle-waiter';

/**
 * Re-export so callers in injection-plan and slash-command-verifier can keep
 * importing `CommandVerifier` from the engine layer without reaching into
 * `pty/terminal-submit.ts` directly.
 */
export type { CommandVerifier } from '../pty/terminal-submit';

/** State for a task whose burst is in flight. `next` is the most-recently-
 *  scheduled follow-up that will run after the current one finishes; rapid
 *  drag-through transitions overwrite `next` so only the latest survives. */
interface ActiveBurst {
  controller: AbortController;
  next: ScheduledSubmission | null;
}

/** State for a task waiting on a fresh-spawn `'thinking'` event. */
interface PendingDeferred {
  cleanup: () => void;
}

type ScheduledSubmission =
  | { kind: 'content'; text: string; sessionId: string; opts: ScheduleContentOptions }
  | { kind: 'keystrokes'; commands: string[]; sessionId: string; opts: ScheduleKeystrokesOptions }
  | { kind: 'native-idle'; entry: NativeIdleEntry };

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

interface LiveDeliveryBase {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly at: string;
}

type LiveDeliveryStatus = LiveDeliveryBase & (
  | { readonly state: 'waiting' | 'sending' | 'delivered' }
  | { readonly state: 'cancelled'; readonly reason: LiveDeliveryCancellationReason }
);

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
  /**
   * Hard timeout for the fresh-spawn wait. When the CLI never emits
   * `'thinking'` (e.g. agent hung at startup), we cancel this task's
   * pending injection rather than wait forever. Default 120s.
   */
  timeoutMs?: number;
}

/** Options for first-output-gated free-form content delivery. */
export interface ScheduleContentOptions {
  readinessTimeoutMs?: number;
  verifier?: SubmissionVerifier | null;
}

/**
 * `TerminalSubmitScheduler` is the task-keyed lifecycle wrapper for terminal
 * delivery. Where `TerminalSubmit` answers "HOW the bytes go out", this
 * class answers "WHEN":
 *
 *   1. **Existing session** -- delivers immediately. If a burst is already
 *      in flight for this task, the new request stashes as `next`; only the
 *      most-recent stash runs after the current finishes (rapid drag-through
 *      transitions coalesce).
 *
 *   2. **Freshly spawned session** (`opts.freshlySpawned: true`) -- waits
 *      for the CLI's first `'thinking'` activity event before delivering.
 *      30s fallback delivers anyway if hooks never fire (CLI is up but the
 *      adapter has no thinking-state hook). `opts.timeoutMs` (default 120s)
 *      caps the total wait.
 *
 *   3. **Queued session** -- waits for `status:running`, then applies the
 *      `'thinking'` wait. Same fallback / hard-timeout structure.
 *
 *   4. **Free-form content** -- waits for first output with no fallback.
 *      Queue time is outside the readiness timeout, and event/cache readiness
 *      share one start guard. Content completion releases only the latest
 *      queued fresh-spawn keystroke follower.
 *
 * Cancellation tears down content and keystroke readiness listeners/timers,
 * drops queued content followers and burst follow-ups, and aborts in-flight
 * content or keystroke delivery through the per-task `AbortController`.
 * Re-scheduling for the same task cancels any prior pending injection.
 *
 * Used by every column-transition / lifecycle path that injects keystrokes:
 * auto_command on column move, `/model X` + `/effort Y` settings burst,
 * fresh-spawn auto_command, archive/un-archive flows.
 */
export class TerminalSubmitScheduler {
  private content = new Map<string, PendingContent>();
  private deferred = new Map<string, PendingDeferred>();
  private active = new Map<string, ActiveBurst>();
  private nativeIdle = new Map<string, NativeIdleEntry>();
  private nextNativeGeneration = 1;
  private suppressNativeLateStatuses = false;

  constructor(
    private sessionManager: SessionManager,
    private terminalSubmit: TerminalSubmit,
    private onLiveDeliveryStatus: LiveDeliveryStatusCallback = () => undefined,
  ) {}

  scheduleContent(
    taskId: string,
    sessionId: string,
    text: string,
    opts: ScheduleContentOptions = {},
  ): void {
    if (text.length === 0) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    const submission: Extract<ScheduledSubmission, { kind: 'content' }> = {
      kind: 'content',
      sessionId,
      text,
      opts,
    };
    const nativeEntry = this.nativeIdle.get(taskId);
    if (nativeEntry?.phase === 'committed') {
      this.replaceSuccessor(nativeEntry, submission);
      return;
    }
    if (nativeEntry) this.cancelNativeEntry(nativeEntry, 'superseded');

    this.cancel(taskId);
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
   * Schedule a keystroke sequence for a task's PTY session. A single command
   * becomes `[command]`; chained bursts (e.g. `/model X`, `/effort Y`,
   * auto_command) pass them all in `commands[]` so the per-task coalesce
   * worker can pick up the whole burst as one unit.
   */
  scheduleKeystrokes(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions = {},
  ): void {
    if (commands.length === 0) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[TerminalSubmitScheduler] No session ${sessionId.slice(0, 8)} for task ${taskId.slice(0, 8)} -- skipping`);
      return;
    }

    const submission: Extract<ScheduledSubmission, { kind: 'keystrokes' }> = {
      kind: 'keystrokes',
      commands,
      sessionId,
      opts,
    };
    const nativeEntry = this.nativeIdle.get(taskId);
    if (nativeEntry?.phase === 'committed') {
      this.replaceSuccessor(nativeEntry, submission);
      return;
    }
    if (nativeEntry) this.cancelNativeEntry(nativeEntry, 'superseded');
    const pendingContent = this.content.get(taskId);
    if (pendingContent) {
      if (pendingContent.sessionId === sessionId) {
        this.replaceContentSuccessor(pendingContent, submission);
        return;
      }
      this.cancelContent(taskId);
    }

    this.scheduleKeystrokeBurst(taskId, submission, session.status === 'queued');
  }

  scheduleNativeIdleSubmission(request: NativeIdleRequest): void {
    if (this.suppressNativeLateStatuses) return;
    const entry: NativeIdleEntry = {
      token: {},
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
      this.replaceSuccessor(currentNative, { kind: 'native-idle', entry });
      this.watchNativeEntry(entry);
      return;
    }
    if (currentNative) this.cancelNativeEntry(currentNative, 'superseded');

    const pendingContent = this.content.get(request.taskId);
    if (pendingContent) {
      this.replaceContentSuccessor(pendingContent, { kind: 'native-idle', entry });
      this.watchNativeEntry(entry);
      return;
    }

    const activeBurst = this.active.get(request.taskId);
    if (activeBurst) {
      this.replaceActiveSuccessor(activeBurst, { kind: 'native-idle', entry });
      this.watchNativeEntry(entry);
      return;
    }

    this.cancelKeystrokeBurst(request.taskId);
    this.nativeIdle.set(request.taskId, entry);
    this.watchNativeEntry(entry);
  }

  private scheduleKeystrokeBurst(
    taskId: string,
    submission: Extract<ScheduledSubmission, { kind: 'keystrokes' }>,
    isQueued: boolean,
  ): void {
    const { sessionId, commands, opts } = submission;
    const freshlySpawned = opts.freshlySpawned ?? false;

    // Existing session, ready right now: try to claim the active-burst slot.
    if (!freshlySpawned && !isQueued) {
      const existing = this.active.get(taskId);
      if (existing) {
        // A burst is in flight. Stash this as "next"; the worker drains it
        // when the current burst finishes. Overwriting any previous "next"
        // intentionally coalesces transient drags.
        this.replaceActiveSuccessor(existing, submission);
        console.log(`[TerminalSubmitScheduler] Queueing burst for task ${taskId.slice(0, 8)} (in-flight burst running)`);
        return;
      }
      this.startBurst(taskId, sessionId, commands, opts);
      return;
    }

    // Fresh spawn or queued - wait for CLI to come alive, then start the burst.
    this.cancelKeystrokeBurst(taskId);
    this.scheduleDeferred(taskId, sessionId, commands, opts, isQueued);
  }

  private replaceContentSuccessor(entry: PendingContent, successor: ScheduledSubmission): void {
    this.cancelScheduledNative(entry.next, 'superseded');
    entry.next = successor;
  }

  private replaceActiveSuccessor(entry: ActiveBurst, successor: ScheduledSubmission): void {
    this.cancelScheduledNative(entry.next, 'superseded');
    entry.next = successor;
  }

  private replaceSuccessor(entry: NativeIdleEntry, successor: ScheduledSubmission): void {
    this.cancelScheduledNative(entry.successor, 'superseded');
    entry.successor = successor;
  }

  private cancelScheduledNative(
    submission: ScheduledSubmission | null,
    reason: LiveDeliveryCancellationReason,
  ): void {
    if (submission?.kind === 'native-idle') this.cancelNativeEntry(submission.entry, reason);
  }

  private startScheduledSubmission(taskId: string, submission: ScheduledSubmission): void {
    switch (submission.kind) {
      case 'content':
        this.scheduleContent(taskId, submission.sessionId, submission.text, submission.opts);
        return;
      case 'keystrokes': {
        const session = this.sessionManager.getSession(submission.sessionId);
        if (!session) return;
        this.scheduleKeystrokeBurst(taskId, submission, session.status === 'queued');
        return;
      }
      case 'native-idle':
        if (submission.entry.terminalStatus) return;
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
   * Cancel any pending or in-flight injection for a specific task. Content
   * cancellation also drops its follower; keystroke cancellation drops the
   * active worker's queued `next` sequence.
   */
  cancel(taskId: string): void {
    this.cancelContent(taskId, 'superseded');
    this.cancelKeystrokeBurst(taskId, 'superseded');
    const nativeEntry = this.nativeIdle.get(taskId);
    if (nativeEntry) this.cancelNativeEntry(nativeEntry, 'superseded');
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
      this.cancelScheduledNative(burst.next, nativeReason);
      burst.next = null;
      burst.controller.abort();
    }
  }

  /** Cancel all pending injections. Called on `killAll`/`suspendAll`. */
  cancelAll(reason?: 'shutdown'): void {
    const nativeReason: LiveDeliveryCancellationReason = reason ?? 'superseded';
    for (const taskId of [...this.content.keys()]) {
      this.cancelContent(taskId, nativeReason);
    }
    this.cancelAllKeystrokeBursts(nativeReason);
    for (const entry of [...this.nativeIdle.values()]) {
      this.cancelNativeEntry(entry, nativeReason);
    }
    if (reason === 'shutdown') this.suppressNativeLateStatuses = true;
  }

  private cancelAllKeystrokeBursts(nativeReason: LiveDeliveryCancellationReason): void {
    const pending = [...this.deferred.values()];
    this.deferred.clear();
    for (const entry of pending) entry.cleanup();
    for (const burst of this.active.values()) {
      this.cancelScheduledNative(burst.next, nativeReason);
      burst.next = null;
      burst.controller.abort();
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

  private evaluateNativeEntry(entry: NativeIdleEntry): void {
    if (!this.isNativeEntryOwned(entry) || entry.terminalStatus || entry.phase !== 'waiting') return;
    if (Date.now() >= entry.deadline) {
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
      this.cancelNativeEntry(entry, this.classifyNativeAdmissionFailure(entry));
      return;
    }

    this.emitNativeStatus(entry, { state: 'sending' });

    const readiness = evaluateNativeIdleReadiness(
      this.sessionManager.snapshotNativeIdle(entry.request.sessionId),
      entry.request,
    );
    const validation = entry.request.validateCurrent();
    const leaseMatches = lease.sessionId === entry.request.sessionId
      && lease.sessionGeneration === entry.request.sessionGeneration
      && lease.inputGeneration === entry.request.inputGeneration;
    if (this.nativeIdle.get(entry.request.taskId) !== entry
      || entry.terminalStatus
      || entry.phase !== 'leased-uncommitted'
      || entry.lease !== lease
      || !leaseMatches
      || readiness !== 'ready'
      || validation !== 'valid') {
      if (!entry.terminalStatus) {
        const reason = validation === 'valid'
          ? readiness === 'user-input' || readiness === 'turn-error' || readiness === 'session-exit'
            ? readiness
            : 'delivery-error'
          : validation;
        this.cancelNativeEntry(entry, reason);
      }
      return;
    }

    // final guard 後必須同 call stack 進入 writer；插入 await 會讓 user input 越過 first-byte commitment。
    const delivery = this.terminalSubmit.submitKeystrokes(entry.request.sessionId, [entry.request.command], {
      writer: lease,
      sendCtrlC: false,
      verifier: null,
      verifiedPrefixLength: 0,
      source: 'live-delivery',
    });
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

  private settleNativeDelivery(entry: NativeIdleEntry, delivery: Promise<void>): void {
    void delivery.then(
      () => {
        if (this.nativeIdle.get(entry.request.taskId) !== entry || entry.terminalStatus) return;
        if (entry.phase === 'committed') this.finishNativeStatus(entry, { state: 'delivered' });
        else this.finishNativeStatus(entry, { state: 'cancelled', reason: 'delivery-error' });
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
    });
  }

  private cancelNativeEntry(entry: NativeIdleEntry, reason: LiveDeliveryCancellationReason): void {
    if (entry.terminalStatus) return;
    const successor = entry.successor;
    entry.successor = null;
    this.finishNativeStatus(entry, { state: 'cancelled', reason });
    if (entry.phase !== 'committed') {
      entry.lease?.release();
      entry.lease = null;
      this.removeNativeEntryOwnership(entry);
    }
    this.cancelScheduledNative(successor, reason);
  }

  private finishNativeStatus(
    entry: NativeIdleEntry,
    status: { readonly state: 'delivered' }
      | { readonly state: 'cancelled'; readonly reason: LiveDeliveryCancellationReason },
  ): void {
    if (entry.terminalStatus) return;
    entry.terminalStatus = true;
    entry.unsubscribe();
    entry.unsubscribe = () => undefined;
    if (entry.timeout !== null) clearTimeout(entry.timeout);
    entry.timeout = null;
    this.emitNativeStatus(entry, status);
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
    const active = this.active.get(entry.request.taskId)?.next;
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
    if (active?.next?.kind === 'native-idle' && active.next.entry === entry) active.next = null;
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
      if (started || this.content.get(taskId) !== entry) return;
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
      return;
    }

    if (this.content.get(taskId) !== entry || entry.controller.signal.aborted) return;

    const follower = entry.next;
    entry.next = null;
    this.content.delete(taskId);
    entry.cleanupLifetime();

    if (follower) {
      if (follower.kind === 'keystrokes') {
        this.startBurst(taskId, follower.sessionId, follower.commands, {
          ...follower.opts,
          freshlySpawned: true,
        });
      } else {
        this.startScheduledSubmission(taskId, follower);
      }
    }
  }

  /**
   * Start a burst on the active map and run it through TerminalSubmit. When
   * the burst finishes (or aborts), drain any queued `next` sequence so a
   * rapid drag-through transition gets the last update applied.
   */
  private startBurst(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions,
  ): void {
    const controller = new AbortController();
    const entry: ActiveBurst = { controller, next: null };
    this.active.set(taskId, entry);
    void this.runBurst(taskId, sessionId, commands, opts, entry);
  }

  private async runBurst(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions,
    entry: ActiveBurst,
  ): Promise<void> {
    try {
      await this.terminalSubmit.submitKeystrokes(sessionId, commands, {
        // Fresh-spawn paths just consumed the CLI prompt arg and have nothing
        // to interrupt; sending Ctrl+C here on Windows ConPTY + Ink lands
        // mid-render of the initial turn and causes the next keystrokes to
        // concatenate onto the prompt as one user message (rendered as
        // `</task>/test` glued together). Live-injection paths (model/effort
        // live swap, board column-edit) keep the leading Ctrl+C so they can
        // interrupt mid-thinking and deliver new flags.
        sendCtrlC: !opts.freshlySpawned,
        verifier: opts.verifier,
        verifiedPrefixLength: opts.verifiedPrefixLength,
        signal: entry.controller.signal,
        source: `task:${taskId.slice(0, 8)}`,
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (!message.includes('abort')) {
        console.error(`[TerminalSubmitScheduler] Burst failed for task ${taskId.slice(0, 8)}: ${message}`);
      }
    }

    // The burst slot is still ours - check for a queued follow-up before
    // releasing the slot to a future scheduleKeystrokes call.
    const current = this.active.get(taskId);
    if (current === entry && entry.next) {
      const queued = entry.next;
      entry.next = null;
      this.active.delete(taskId);
      this.startScheduledSubmission(taskId, queued);
      return;
    }
    if (current === entry) {
      this.active.delete(taskId);
    }
  }

  /**
   * Wait for the CLI to come alive (via `'thinking'` event from adapter
   * hooks) before starting the burst. 30s fallback covers adapters with no
   * thinking-state hook; `timeoutMs` hard cap covers truly hung sessions.
   */
  private scheduleDeferred(
    taskId: string,
    sessionId: string,
    commands: string[],
    opts: ScheduleKeystrokesOptions,
    isQueued: boolean,
  ): void {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let state: 'queued' | 'waiting' = isQueued ? 'queued' : 'waiting';
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const hardTimer = setTimeout(() => {
      console.warn(`[TerminalSubmitScheduler] Hard timeout (${timeoutMs}ms) for task ${taskId.slice(0, 8)} -- cancelling`);
      this.cancel(taskId);
    }, timeoutMs);

    const startFallbackTimer = (): void => {
      if (fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        if (!this.deferred.has(taskId)) return;
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
      // Hand off to the active-burst path. If somehow another burst was
      // started for this task while we were waiting (unlikely - fresh-spawn
      // is exclusive), startBurst's caller handled the conflict.
      this.startBurst(taskId, sessionId, commands, opts);
    };

    const onActivity = (evtSessionId: string, activityState: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.deferred.has(taskId)) return;
      if (state === 'waiting' && activityState === 'thinking') {
        detachAndDeliver();
      }
    };

    const onSessionChanged = (evtSessionId: string, evtSession: { status: string }): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.deferred.has(taskId)) return;
      if (state === 'queued' && evtSession.status === 'running') {
        state = 'waiting';
        startFallbackTimer();
      }
    };

    const onExit = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      if (!this.deferred.has(taskId)) return;
      console.log(`[TerminalSubmitScheduler] Session ${sessionId.slice(0, 8)} exited -- cancelling injection for task ${taskId.slice(0, 8)}`);
      this.cancel(taskId);
    };

    this.sessionManager.on('activity', onActivity);
    this.sessionManager.on('session-changed', onSessionChanged);
    this.sessionManager.on('exit', onExit);

    if (!isQueued) {
      startFallbackTimer();
    }

    const cleanup = (): void => {
      this.sessionManager.off('activity', onActivity);
      this.sessionManager.off('session-changed', onSessionChanged);
      this.sessionManager.off('exit', onExit);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearTimeout(hardTimer);
    };

    this.deferred.set(taskId, { cleanup });
  }
}
