/**
 * Unit tests for src/main/transition-engine/terminal-submit-scheduler.ts.
 *
 * `TerminalSubmit`. Its responsibilities:
 *
 *   1. Free-form content waits for first output, then submits before its latest
 *      same-session keystroke follower.
 *   2. Existing session, immediate mode: deliver now. If a burst is in flight,
 *      the new request QUEUES behind it - nothing is dropped.
 *   3. Existing session, deferred mode: hold until the agent's current turn
 *      genuinely completes, then deliver.
 *   4. Freshly spawned / queued: wait for the CLI's first `'thinking'` event,
 *      with a 30s fallback and a hard timeout.
 *   5. Cancel tears down listeners and timers and aborts in-flight delivery.
 *   6. Report a definite outcome for every scheduled burst, escalating a
 *      confirmed failure to a restart-with-prompt.
 *
 * The byte-pushing path (write order, prompt-state policy, verification) is
 * tested in `terminal-submit.test.ts`. These tests focus on scheduling
 * decisions, lifecycle, and reporting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  TerminalSubmitScheduler,
  type InjectionReport,
} from '../../src/main/transition-engine/terminal-submit-scheduler';
import type {
  InjectionCommand,
  SubmitContentOptions,
  SubmitKeystrokesOptions,
  SubmitKeystrokesResult,
  TerminalSubmit,
} from '../../src/main/pty/terminal-submit';
import type { ActivityState, SessionStatus, SubmissionVerifier } from '../../src/shared/types';

/** Build a plain unverifiable command, the common case in these tests. */
function plain(text: string): InjectionCommand {
  return { text, verify: 'none' };
}

class MockSessionManager extends EventEmitter {
  registry = new Map<string, { status: SessionStatus }>();
  activity: Record<string, ActivityState> = {};
  drafts = new Map<string, string>();
  firstOutput = new Set<string>();
  firstOutputListenerCounts: number[] = [];
  firstOutputDuringCacheRead: string | null = null;

  getSession(id: string): { status: SessionStatus } | undefined {
    return this.registry.get(id);
  }

  getFirstOutputCache(): Record<string, boolean> {
    this.firstOutputListenerCounts.push(this.listenerCount('first-output'));
    if (this.firstOutputDuringCacheRead !== null) {
      const sessionId = this.firstOutputDuringCacheRead;
      this.firstOutputDuringCacheRead = null;
      this.emitFirstOutput(sessionId);
    }
    return Object.fromEntries([...this.firstOutput].map((id) => [id, true]));
  }

  emitFirstOutput(id: string): void {
    this.firstOutput.add(id);
    this.emit('first-output', id);
  }

  getActivityCache(): Record<string, ActivityState> {
    return this.activity;
  }

  getPendingDraft(id: string): string | null {
    return this.drafts.get(id) ?? null;
  }

  emitActivity(id: string, state: ActivityState): void {
    this.activity[id] = state;
    this.emit('activity', id, state);
  }

  emitSessionChanged(id: string, session: { status: SessionStatus }): void {
    this.emit('session-changed', id, session);
  }

  emitExit(id: string): void {
    this.emit('exit', id);
  }

  emitOutput(id: string): void {
    this.emit('data-tap', id, 'x');
  }
}

class MockTerminalSubmit {
  /** Each call captures the args and a controllable resolve / abort hook. */
  calls: Array<{
    sessionId: string;
    commands: readonly (string | InjectionCommand)[];
    opts: SubmitKeystrokesOptions;
    resolve: (result: SubmitKeystrokesResult) => void;
    aborted: boolean;
    /** Tracked so `finishLatest` advances instead of re-resolving call 0. */
    settled: boolean;
  }> = [];
  contentCalls: Array<{
    sessionId: string;
    text: string;
    opts: SubmitContentOptions;
    resolve: () => void;
    reject: (error: Error) => void;
    aborted: boolean;
    settled: boolean;
  }> = [];
  observableOrder: Array<
    | { kind: 'content'; text: string }
    | { kind: 'keystrokes'; commands: string[] }
  > = [];

  /** Result handed to the next resolved call. */
  nextResult: SubmitKeystrokesResult = {
    outcome: 'unconfirmed',
    unconfirmedCommands: [],
    discardedDraft: null,
    interruptedTurn: false,
  };

  submitKeystrokes(
    sessionId: string,
    commands: readonly (string | InjectionCommand)[],
    opts: SubmitKeystrokesOptions,
  ): Promise<SubmitKeystrokesResult> {
    return new Promise<SubmitKeystrokesResult>((resolve) => {
      const call = { sessionId, commands, opts, resolve, aborted: false, settled: false };
      this.calls.push(call);
      this.observableOrder.push({ kind: 'keystrokes', commands: MockTerminalSubmit.texts(call) });
      if (opts.signal) {
        if (opts.signal.aborted) {
          call.aborted = true;
          call.settled = true;
          resolve({ ...this.nextResult, outcome: 'aborted' });
          return;
        }
        opts.signal.addEventListener('abort', () => {
          call.aborted = true;
          call.settled = true;
          resolve({ ...this.nextResult, outcome: 'aborted' });
        });
      }
    });
  }

  /** Resolve the oldest still-pending call - simulates a delivery finishing. */
  finishLatest(result?: Partial<SubmitKeystrokesResult>): void {
    const pending = this.calls.find((call) => !call.settled);
    if (!pending) return;
    pending.settled = true;
    pending.resolve({ ...this.nextResult, ...result });
  }

  /** Text of the commands a call received, for readable assertions. */
  static texts(call: { commands: readonly (string | InjectionCommand)[] }): string[] {
    return call.commands.map((entry) => (typeof entry === 'string' ? entry : entry.text));
  }

  submitContent(
    sessionId: string,
    text: string,
    opts: SubmitContentOptions,
  ): Promise<void> {
    let completePromise: () => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      completePromise = resolve;
      rejectPromise = reject;
    });
    const call = {
      sessionId,
      text,
      opts,
      aborted: false,
      settled: false,
      resolve: (): void => {
        if (call.settled) return;
        call.settled = true;
        completePromise();
      },
      reject: (error: Error): void => {
        if (call.settled) return;
        call.settled = true;
        rejectPromise(error);
      },
    };
    this.contentCalls.push(call);
    this.observableOrder.push({ kind: 'content', text });
    if (opts.signal) {
      if (opts.signal.aborted) {
        call.aborted = true;
        call.resolve();
      } else {
        opts.signal.addEventListener('abort', () => {
          call.aborted = true;
          call.resolve();
        });
      }
    }
    return promise;
  }

  finishContentLatest(): void {
    this.contentCalls.find((call) => !call.settled)?.resolve();
  }

  rejectContentLatest(error: Error): void {
    this.contentCalls.find((call) => !call.settled)?.reject(error);
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalSubmitScheduler', () => {
  let sessionManager: MockSessionManager;
  let terminalSubmit: MockTerminalSubmit;
  let scheduler: TerminalSubmitScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new MockSessionManager();
    terminalSubmit = new MockTerminalSubmit();
    scheduler = new TerminalSubmitScheduler(
      sessionManager as never,
      terminalSubmit as unknown as TerminalSubmit,
    );
  });

  afterEach(() => {
    scheduler.cancelAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionManager.removeAllListeners();
  });

  describe('ready-gated content', () => {
    describe('session status', () => {
      it('submits cached content for a running session', async () => {
        sessionManager.registry.set('s1', { status: 'running' });
        sessionManager.firstOutput.add('s1');

        scheduler.scheduleContent('task-1', 's1', 'content');
        await tick();

        expect(terminalSubmit.contentCalls).toHaveLength(1);
      });

      it('waits for a queued session to become running before using its cache', async () => {
        sessionManager.registry.set('s1', { status: 'queued' });
        sessionManager.firstOutput.add('s1');

        scheduler.scheduleContent('task-1', 's1', 'content');
        await tick();

        expect(terminalSubmit.contentCalls).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);

        sessionManager.emitSessionChanged('s1', { status: 'running' });
        await tick();

        expect(terminalSubmit.contentCalls).toHaveLength(1);
      });

      it.each([
        'exited',
        'suspended',
      ] satisfies readonly SessionStatus[])('ignores cached content for inactive %s status without scheduler state', async (status) => {
        sessionManager.registry.set('s1', { status });
        sessionManager.firstOutput.add('s1');

        scheduler.scheduleContent('task-1', 's1', 'content');
        await tick();

        expect(terminalSubmit.contentCalls).toHaveLength(0);
        expect(sessionManager.eventNames()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);

        sessionManager.registry.set('s1', { status: 'running' });
        scheduler.scheduleKeystrokes('task-1', 's1', ['/standalone']);
        await tick();

        expect(terminalSubmit.calls).toHaveLength(1);
      });
    });

    it('waits for matching first-output without a fallback and submits once', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      vi.advanceTimersByTime(30_000);
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);

      sessionManager.emitFirstOutput('other-session');
      sessionManager.emitFirstOutput('s1');
      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(1);
      expect(terminalSubmit.contentCalls[0].text).toBe('content');
    });

    it('attaches the listener before checking cache and shares one start guard', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.firstOutputDuringCacheRead = 's1';

      scheduler.scheduleContent('task-1', 's1', 'cached content');
      await tick();

      expect(sessionManager.firstOutputListenerCounts).toEqual([1]);
      expect(sessionManager.firstOutput.has('s1')).toBe(true);
      expect(terminalSubmit.contentCalls).toHaveLength(1);
    });

    it('ignores stale first-output cache entries for another session', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.firstOutput.add('stale-session');

      scheduler.scheduleContent('task-1', 's1', 'content');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);
    });

    it('finishes content before directly sending the fresh latest follower', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const verifier = vi.fn(async () => true);

      scheduler.scheduleContent('task-1', 's1', 'content');
      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/follow', verify: 'command-match' },
      ], { verifier });

      expect(sessionManager.listenerCount('first-output')).toBe(1);
      expect(sessionManager.listenerCount('session-changed')).toBe(1);
      expect(sessionManager.listenerCount('exit')).toBe(1);

      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
      expect(terminalSubmit.observableOrder).toEqual([
        { kind: 'content', text: 'content' },
      ]);
      expect(sessionManager.listenerCount('first-output')).toBe(0);
      expect(sessionManager.listenerCount('session-changed')).toBe(0);
      expect(sessionManager.listenerCount('exit')).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      terminalSubmit.finishContentLatest();
      await tick();

      expect(terminalSubmit.observableOrder).toEqual([
        { kind: 'content', text: 'content' },
        { kind: 'keystrokes', commands: ['/follow'] },
      ]);
      expect(terminalSubmit.calls[0].opts.freshlySpawned).toBe(true);
      expect(terminalSubmit.calls[0].opts.verifier).toBe(verifier);
      expect(sessionManager.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps only the latest keystroke follower', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/discarded']);
      scheduler.scheduleKeystrokes('task-1', 's1', ['/latest']);
      sessionManager.emitFirstOutput('s1');
      await tick();

      terminalSubmit.finishContentLatest();
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].commands).toEqual(['/latest']);
    });

    it('excludes queued time from the readiness timeout budget', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      sessionManager.registry.set('s1', { status: 'queued' });

      scheduler.scheduleContent('task-1', 's1', 'content', { readinessTimeoutMs: 1_000 });
      scheduler.scheduleKeystrokes('task-1', 's1', ['/follow']);
      vi.advanceTimersByTime(5_000);
      await tick();

      sessionManager.emitSessionChanged('s1', { status: 'running' });
      vi.advanceTimersByTime(999);
      await tick();

      expect(sessionManager.listenerCount('first-output')).toBe(1);
      expect(terminalSubmit.contentCalls).toHaveLength(0);

      vi.advanceTimersByTime(1);
      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('checks first-output cache when a queued session becomes running', async () => {
      sessionManager.registry.set('s1', { status: 'queued' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      sessionManager.firstOutput.add('s1');
      sessionManager.emitSessionChanged('s1', { status: 'running' });
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(1);
    });

    it('uses a 120-second readiness timeout by default', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      vi.advanceTimersByTime(119_999);
      await tick();

      expect(sessionManager.listenerCount('first-output')).toBe(1);

      vi.advanceTimersByTime(1);
      await tick();

      expect(sessionManager.listenerCount('first-output')).toBe(0);
      expect(terminalSubmit.contentCalls).toHaveLength(0);
    });

    it('drops content and its follower when the session exits before readiness', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/follow']);
      sessionManager.emitExit('s1');
      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('aborts in-flight content and drops its same-session follower when the session exits', async () => {
      // Given: matching content has passed readiness but has not settled.
      sessionManager.registry.set('s1', { status: 'running' });
      scheduler.scheduleContent('task-1', 's1', 'content');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/follow']);
      sessionManager.emitFirstOutput('s1');
      await tick();
      const exitListenersWhilePending = sessionManager.listenerCount('exit');

      // When: the owning session exits.
      sessionManager.emitExit('s1');
      await tick();

      // Then: content ownership ends without releasing its follower.
      expect(terminalSubmit.contentCalls[0].aborted).toBe(true);
      expect(exitListenersWhilePending).toBe(1);
      expect(terminalSubmit.calls).toHaveLength(0);
      expect(sessionManager.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('drops content and its follower on explicit cancel before readiness', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/follow']);
      scheduler.cancel('task-1');
      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('drops every content job and follower on cancelAll', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.registry.set('s2', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'first');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/first-follow']);
      scheduler.scheduleContent('task-2', 's2', 'second');
      scheduler.scheduleKeystrokes('task-2', 's2', ['/second-follow']);
      scheduler.cancelAll();
      sessionManager.emitFirstOutput('s1');
      sessionManager.emitFirstOutput('s2');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('aborts in-flight content and drops its follower on cancel', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/follow']);
      sessionManager.emitFirstOutput('s1');
      await tick();

      scheduler.cancel('task-1');
      await tick();

      expect(terminalSubmit.contentCalls[0].aborted).toBe(true);
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('replaces pending content for the same task', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'discarded');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/discarded-follow']);
      scheduler.scheduleContent('task-1', 's1', 'latest');
      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(1);
      expect(terminalSubmit.contentCalls[0].text).toBe('latest');
      terminalSubmit.finishContentLatest();
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('aborts in-flight content when content is rescheduled for the same task', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'discarded');
      sessionManager.emitFirstOutput('s1');
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', ['/discarded-follow']);

      scheduler.scheduleContent('task-1', 's1', 'latest');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(2);
      expect(terminalSubmit.contentCalls[0].aborted).toBe(true);
      expect(terminalSubmit.contentCalls[1].text).toBe('latest');
      terminalSubmit.finishContentLatest();
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('keeps replacement content owned only by its new session', async () => {
      // Given: old-session content is in flight for a task.
      sessionManager.registry.set('old-session', { status: 'running' });
      sessionManager.registry.set('new-session', { status: 'running' });
      scheduler.scheduleContent('task-1', 'old-session', 'old content');
      sessionManager.emitFirstOutput('old-session');
      await tick();
      const oldContent = terminalSubmit.contentCalls[0];

      // When: new-session content replaces it and the old session exits late.
      scheduler.scheduleContent('task-1', 'new-session', 'new content');
      sessionManager.emitFirstOutput('new-session');
      await tick();
      const newContent = terminalSubmit.contentCalls[1];
      sessionManager.emitExit('old-session');
      await tick();

      // Then: replacement aborts the old owner, while the late exit cannot abort the new owner.
      expect(oldContent.aborted).toBe(true);
      expect(newContent.aborted).toBe(false);
      expect(sessionManager.listenerCount('exit')).toBe(1);

      terminalSubmit.finishContentLatest();
      await tick();
      expect(sessionManager.eventNames()).toEqual([]);
    });

    it('routes a different-session keystroke normally instead of attaching it as a content follower', async () => {
      // Given: old-session content is in flight when the task has a new running session.
      sessionManager.registry.set('old-session', { status: 'running' });
      sessionManager.registry.set('new-session', { status: 'running' });
      scheduler.scheduleContent('task-1', 'old-session', 'old content');
      sessionManager.emitFirstOutput('old-session');
      await tick();

      // When: a keystroke arrives for the new session.
      scheduler.scheduleKeystrokes('task-1', 'new-session', ['/new-session']);
      await tick();

      // Then: stale content is cancelled and normal live-injection semantics apply.
      expect(terminalSubmit.contentCalls[0].aborted).toBe(true);
      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].sessionId).toBe('new-session');
      expect(terminalSubmit.calls[0].commands).toEqual(['/new-session']);
      expect(terminalSubmit.calls[0].opts.freshlySpawned).toBeUndefined();
      expect(sessionManager.listenerCount('exit')).toBe(0);
    });

    it.each([
      'exited',
      'suspended',
    ] satisfies readonly SessionStatus[])('cancels pending content and its follower when the same task reruns against %s status', async (status) => {
      sessionManager.registry.set('running-session', { status: 'running' });
      sessionManager.registry.set('inactive-session', { status });

      scheduler.scheduleContent('task-1', 'running-session', 'old content');
      scheduler.scheduleKeystrokes('task-1', 'running-session', ['/old-follower']);

      scheduler.scheduleContent('task-1', 'inactive-session', 'inactive rerun');
      sessionManager.emitFirstOutput('running-session');
      await tick();
      terminalSubmit.finishContentLatest();
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);
      expect(terminalSubmit.calls).toHaveLength(0);
      expect(sessionManager.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      'exited',
      'suspended',
    ] satisfies readonly SessionStatus[])('aborts in-flight content and drops its follower when the same task reruns against %s status', async (status) => {
      sessionManager.registry.set('running-session', { status: 'running' });
      sessionManager.registry.set('inactive-session', { status });

      scheduler.scheduleContent('task-1', 'running-session', 'old content');
      sessionManager.emitFirstOutput('running-session');
      await tick();
      scheduler.scheduleKeystrokes('task-1', 'running-session', ['/old-follower']);
      const oldContent = terminalSubmit.contentCalls[0];

      scheduler.scheduleContent('task-1', 'inactive-session', 'inactive rerun');
      terminalSubmit.finishContentLatest();
      await tick();

      expect(oldContent.aborted).toBe(true);
      expect(terminalSubmit.contentCalls).toHaveLength(1);
      expect(terminalSubmit.calls).toHaveLength(0);
      expect(sessionManager.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('drops the follower and cleans task state when submitContent fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', 'content');
      scheduler.scheduleKeystrokes('task-1', 's1', ['/discarded-follow']);
      sessionManager.emitFirstOutput('s1');
      await tick();
      terminalSubmit.rejectContentLatest(new Error('submission failed'));
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);

      scheduler.scheduleKeystrokes('task-1', 's1', ['/after-failure']);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].commands).toEqual(['/after-failure']);
    });

    it('forwards free-form content byte-for-byte', async () => {
      const text = '第一行\r\n第二行「引號」 "quotes" & | < > ^ %';
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.firstOutput.add('s1');

      scheduler.scheduleContent('task-1', 's1', text);
      await tick();

      expect(terminalSubmit.contentCalls[0].text).toBe(text);
    });

    it('forwards a non-null SubmissionVerifier unchanged', async () => {
      const verifier: SubmissionVerifier = async () => true;
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.firstOutput.add('s1');

      scheduler.scheduleContent('task-1', 's1', 'content', { verifier });
      await tick();

      expect(terminalSubmit.contentCalls[0].opts.verifier).toBe(verifier);
    });

    it('forwards an explicit null verifier as undefined', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.firstOutput.add('s1');

      scheduler.scheduleContent('task-1', 's1', 'content', { verifier: null });
      await tick();

      expect(terminalSubmit.contentCalls[0].opts.verifier).toBeUndefined();
    });

    it('keeps submit failure logs metadata-only', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const text = '內容 & <task>';
      sessionManager.registry.set('session-123456789', { status: 'running' });
      sessionManager.firstOutput.add('session-123456789');

      scheduler.scheduleContent('task-123456789', 'session-123456789', text);
      await tick();
      terminalSubmit.rejectContentLatest(new Error(`failed: ${text}`));
      await tick();

      const logged = errorSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('submit-content failed');
      expect(logged).toContain('task-123');
      expect(logged).toContain('session=session-');
      expect(logged).not.toContain('內容');
      expect(logged).not.toContain('&');
      expect(logged).not.toContain('<task>');
    });

    it('keeps readiness timeout logs metadata-only', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const text = '內容 & <task>';
      sessionManager.registry.set('session-123456789', { status: 'running' });

      scheduler.scheduleContent('task-123456789', 'session-123456789', text, {
        readinessTimeoutMs: 10,
      });
      vi.advanceTimersByTime(10);
      await tick();

      const logged = warnSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('submit-content readiness timeout');
      expect(logged).toContain('task-123');
      expect(logged).toContain('session=session-');
      expect(logged).not.toContain('內容');
      expect(logged).not.toContain('&');
      expect(logged).not.toContain('<task>');
    });

    it('has no side effects for empty content or a missing session', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleContent('task-1', 's1', '');
      scheduler.scheduleContent('task-2', 'missing', 'content');
      await tick();

      expect(terminalSubmit.contentCalls).toHaveLength(0);
      expect(terminalSubmit.calls).toHaveLength(0);
      expect(sessionManager.eventNames()).toEqual([]);
    });
  });

  describe('existing session (immediate delivery)', () => {
    it('delivers a single command immediately', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')]);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].sessionId).toBe('s1');
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[0])).toEqual(['/test']);
    });

    it('delivers a chained sequence in one call', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/model opus'), plain('/effort high')]);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[0])).toEqual(['/model opus', '/effort high']);
    });

    it('forwards the verifier and the session draft', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.drafts.set('s1', 'instead can we');
      const verifier = vi.fn();

      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/effort high', verify: 'command-match' },
        { text: '/code-review', verify: 'submitted' },
      ], { verifier });
      await tick();

      expect(terminalSubmit.calls[0].opts.verifier).toBe(verifier);
      expect(terminalSubmit.calls[0].opts.pendingDraft).toBe('instead can we');
    });

    it('flags an interrupted turn when the agent is thinking', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')]);
      await tick();

      expect(terminalSubmit.calls[0].opts.interruptingTurn).toBe(true);
    });

    it('forwards strict verification for a settings prefix', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/effort high', verify: 'command-match' },
      ], { strictVerification: true });
      await tick();

      expect(terminalSubmit.calls[0].opts.strictVerification).toBe(true);
    });
  });

  describe('drag-burst queueing', () => {
    it('queues a follow-up while a burst is in flight, then drains it', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')]);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1); // not started yet

      terminalSubmit.finishLatest();
      await tick();
      expect(terminalSubmit.calls).toHaveLength(2);
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[1])).toEqual(['/second']);
    });

    it('delivers EVERY burst of a drag-through, dropping none', async () => {
      // Regression: the scheduler used to keep a single overwritable `next`
      // slot, so dragging a task through two auto_command columns in quick
      // succession silently discarded the middle command with no record
      // anywhere. A queue is the whole point.
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')]);
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/third')]);
      await tick();

      terminalSubmit.finishLatest();
      await tick();
      terminalSubmit.finishLatest();
      await tick();
      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls.map((call) => MockTerminalSubmit.texts(call)[0])).toEqual([
        '/first',
        '/second',
        '/third',
      ]);
    });

    it('delivers a queued burst against ITS OWN session id', async () => {
      // The old stash dropped sessionId and the drain recursed with the
      // original closure's id, which would misdeliver to a dead session the
      // moment a respawn stopped taking the fresh-spawn branch.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.registry.set('s2', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's2', [plain('/second')]);
      await tick();

      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls[1].sessionId).toBe('s2');
    });
  });

  describe('freshlySpawned: wait for thinking event', () => {
    it('does not deliver until activity:thinking fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('30s fallback delivers anyway when thinking never fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();

      vi.advanceTimersByTime(30_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].opts.freshlySpawned).toBe(true);
    });

    it('hard timeout cancels and reports a failure when the CLI never starts', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], {
        freshlySpawned: true,
        timeoutMs: 1000,
        onOutcome: (report) => reports.push(report),
      });
      await tick();

      vi.advanceTimersByTime(1500);
      await tick();
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
      // The old code cancelled with only a console.warn, so the user saw a task
      // that had quietly not run its command.
      expect(reports).toHaveLength(1);
      expect(reports[0].outcome).toBe('failed');
      expect(reports[0].reason).toContain('never became ready');
    });

    it('forwards freshlySpawned so the byte layer can skip the clear', async () => {
      // Regression: the scheduler used to hardcode a leading Ctrl+C, which on a
      // freshly-spawned Claude Code session landed mid-render of the initial
      // prompt turn and glued the next keystrokes onto it. The clear decision
      // now lives in submitKeystrokes; the scheduler only reports the context.
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls[0].opts.freshlySpawned).toBe(true);
    });
  });

  describe('queued session: wait for running then thinking', () => {
    it('ignores activity:thinking before status:running', async () => {
      sessionManager.registry.set('s1', { status: 'queued' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();

      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      sessionManager.emitSessionChanged('s1', { status: 'running' });
      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });
  });

  describe('deferred mode', () => {
    it('holds delivery while the agent is thinking', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();
      vi.advanceTimersByTime(10_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('delivers once the turn completes and the PTY goes quiet', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();

      sessionManager.emitActivity('s1', 'idle');
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('does NOT deliver while output keeps arriving, even though activity says idle', async () => {
      // The sustained false-idle cases: an API retry backoff and a `Monitor`
      // wait both read as idle for minutes while the CLI keeps painting. A
      // stability window alone expires inside both; requiring PTY silence as a
      // second, independent signal is what actually holds delivery.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();

      for (let index = 0; index < 10; index++) {
        vi.advanceTimersByTime(500);
        sessionManager.emitOutput('s1');
        await tick();
      }

      expect(terminalSubmit.calls).toHaveLength(0);

      // Once the repainting stops, delivery proceeds.
      vi.advanceTimersByTime(1600);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('never delivers into a pending permission prompt', async () => {
      // Injecting here would answer the prompt with the command text.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'permission';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/code-review')], { mode: 'deferred' });
      await tick();
      vi.advanceTimersByTime(10_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('delivers the newer burst, not the older, when two deferred bursts target the same task', async () => {
      // Regression: `PendingDeferred` used to carry no identity, so the two
      // waits raced on a bare `has(taskId)` presence check. Whichever turn-
      // completion promise settled first deleted the OTHER wait's map entry
      // and delivered its OWN (stale) burst, silently dropping the newer one.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')], { mode: 'deferred' });
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')], { mode: 'deferred' });
      await tick();

      sessionManager.emitActivity('s1', 'idle');
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[0])).toEqual(['/second']);
    });

    it('reports both bursts of a same-task deferred double-schedule, never just one', async () => {
      // The pre-fix bug produced exactly ONE onOutcome call total: the second
      // burst's continuation found no map entry and returned without ever
      // reporting. This is the assertion that most directly pins the fix,
      // since "delivers the newer burst" alone would also pass on a design
      // that dropped the older burst's report entirely.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')], {
        mode: 'deferred',
        onOutcome: (report) => reports.push(report),
      });
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')], {
        mode: 'deferred',
        onOutcome: (report) => reports.push(report),
      });
      await tick();

      // The older burst is reported synchronously, the moment the newer one
      // supersedes it - well before the turn ever completes.
      expect(reports).toHaveLength(1);
      expect(reports[0].outcome).toBe('cancelled');
      expect(reports[0].commands).toEqual(['/first']);

      sessionManager.emitActivity('s1', 'idle');
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();
      terminalSubmit.finishLatest({ outcome: 'confirmed' });
      await tick();

      expect(reports).toHaveLength(2);
      expect(reports[1].outcome).toBe('confirmed');
      expect(reports[1].commands).toEqual(['/second']);
    });

    it('still delivers the newer burst when a cancel intervenes between the two schedule calls', async () => {
      // The subtler half of the race: `cancel()` aborts the first wait
      // synchronously, but its `.then` continuation only runs a microtask
      // LATER - by which time the second `scheduleKeystrokes` call has already
      // installed the newer entry. A bare `has(taskId)` guard cannot tell its
      // own (now-stale) wait from the newer one that took its slot, so it
      // deleted the newer entry out from under it. All three calls here run
      // synchronously, exactly as they would from one drag-through, and the
      // microtask flush happens only afterward so the stale continuation is
      // actually exercised.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'thinking';

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')], { mode: 'deferred' });
      scheduler.cancel('task-1');
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')], { mode: 'deferred' });
      await tick();

      sessionManager.emitActivity('s1', 'idle');
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(MockTerminalSubmit.texts(terminalSubmit.calls[0])).toEqual(['/second']);
    });
  });

  describe('outcome reporting and escalation', () => {
    it('reports a confirmed delivery', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], {
        onOutcome: (report) => reports.push(report),
      });
      await tick();
      terminalSubmit.finishLatest({ outcome: 'confirmed' });
      await tick();

      expect(reports).toHaveLength(1);
      expect(reports[0].outcome).toBe('confirmed');
      expect(reports[0].escalated).toBe(false);
    });

    it('escalates a failed delivery once the turn is complete', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';
      const reports: InjectionReport[] = [];
      const escalate = vi.fn(async () => true);

      scheduler.scheduleKeystrokes('task-1', 's1', [{ text: '/code-review', verify: 'submitted' }], {
        escalate,
        onOutcome: (report) => reports.push(report),
      });
      await tick();
      terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/code-review'] });
      await tick();
      // Let the turn-completion quiet window elapse.
      vi.advanceTimersByTime(1600);
      await tick();

      expect(escalate).toHaveBeenCalledWith(['/code-review']);
      expect(reports).toHaveLength(1);
      expect(reports[0].escalated).toBe(true);
      // NOT 'confirmed': the restart was issued, but no verifier saw the
      // command land. Claiming confirmation here would be the same silent
      // success this rebuild exists to remove.
      expect(reports[0].outcome).not.toBe('confirmed');
    });

    it('escalates ONLY the user auto_command, never the settings prefix', async () => {
      // A settings write joined into an argv prompt stops being a slash
      // invocation and becomes literal text the agent reads as message content.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';
      const escalate = vi.fn(async () => true);

      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/effort xhigh', verify: 'command-match' },
        { text: '/code-review', verify: 'submitted' },
      ], { escalate });
      await tick();
      terminalSubmit.finishLatest({
        outcome: 'failed',
        unconfirmedCommands: ['/effort xhigh', '/code-review'],
      });
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(escalate).toHaveBeenCalledWith(['/code-review']);
    });

    it('does not restart the session for a failed settings write alone', async () => {
      // `--resume` preserves already-applied settings and a model change has its
      // own restart path, so respawning here would be churn for nothing.
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.activity.s1 = 'idle';
      const escalate = vi.fn(async () => true);
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [
        { text: '/effort xhigh', verify: 'command-match' },
      ], { escalate, onOutcome: (report) => reports.push(report) });
      await tick();
      terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/effort xhigh'] });
      await tick();
      vi.advanceTimersByTime(1600);
      await tick();

      expect(escalate).not.toHaveBeenCalled();
      expect(reports[0].outcome).toBe('failed');
    });

    it('reports failed without escalating when no handler is supplied', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const reports: InjectionReport[] = [];

      scheduler.scheduleKeystrokes('task-1', 's1', [{ text: '/code-review', verify: 'submitted' }], {
        onOutcome: (report) => reports.push(report),
      });
      await tick();
      terminalSubmit.finishLatest({ outcome: 'failed', unconfirmedCommands: ['/code-review'] });
      await tick();

      expect(reports[0].outcome).toBe('failed');
      expect(reports[0].escalated).toBe(false);
    });

    it('reports a failure when the session is gone', () => {
      const reports: InjectionReport[] = [];
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], {
        onOutcome: (report) => reports.push(report),
      });

      expect(terminalSubmit.calls).toHaveLength(0);
      expect(reports).toHaveLength(1);
      expect(reports[0].outcome).toBe('failed');
    });
  });

  describe('cancel', () => {
    it('aborts in-flight delivery via AbortController', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')]);
      await tick();
      expect(terminalSubmit.calls[0].aborted).toBe(false);

      scheduler.cancel('task-1');
      await tick();

      expect(terminalSubmit.calls[0].aborted).toBe(true);
    });

    it('drops queued follow-up sequences', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/first')]);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/second')]);
      await tick();

      scheduler.cancel('task-1');
      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls.some((call) => MockTerminalSubmit.texts(call).includes('/second'))).toBe(false);
    });

    it('removes deferred listeners (freshlySpawned was waiting)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();

      scheduler.cancel('task-1');
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('exit event during deferred wait cancels the injection', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', [plain('/test')], { freshlySpawned: true });
      await tick();
      sessionManager.emitExit('s1');
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });
  });

  describe('cancelAll', () => {
    it('aborts every pending and in-flight injection', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      sessionManager.registry.set('s2', { status: 'running' });

      scheduler.scheduleKeystrokes('task-a', 's1', [plain('/a')]);
      scheduler.scheduleKeystrokes('task-b', 's2', [plain('/b')], { freshlySpawned: true });
      await tick();

      scheduler.cancelAll();
      sessionManager.emitActivity('s1', 'thinking');
      sessionManager.emitActivity('s2', 'thinking');
      await tick();

      expect(terminalSubmit.calls.find((call) => MockTerminalSubmit.texts(call).includes('/a'))?.aborted).toBe(true);
      expect(terminalSubmit.calls.some((call) => MockTerminalSubmit.texts(call).includes('/b'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('skips when commands array is empty', () => {
      sessionManager.registry.set('s1', { status: 'running' });
      scheduler.scheduleKeystrokes('task-1', 's1', []);
      expect(terminalSubmit.calls).toHaveLength(0);
    });
  });
});
