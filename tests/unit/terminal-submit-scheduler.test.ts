/**
 * Unit tests for src/main/transition-engine/terminal-submit-scheduler.ts.
 *
 * `TerminalSubmitScheduler` adds task-keyed lifecycle on top of
 * `TerminalSubmit`. The scheduler's responsibilities:
 *
 *   1. Free-form content: wait listener-first/cache-second for first output,
 *      then submit once before the latest queued fresh keystroke follower.
 *   2. Existing session: deliver immediately. If a burst is in flight,
 *      stash the new request as `next` so rapid drag-through transitions
 *      coalesce (only the latest survives).
 *   3. Freshly spawned (`opts.freshlySpawned: true`): wait for the CLI's
 *      first `'thinking'` activity event. 30s fallback delivers anyway
 *      if hooks never fire. `opts.timeoutMs` (default 120s) hard-caps.
 *   4. Queued: wait for `status:running`, then apply the `'thinking'` wait.
 *   5. Cancel: tears down event listeners + timers AND aborts an in-flight
 *      burst via the per-task `AbortController` plumbed through.
 *
 * The byte-pushing path (write order, sanitize, verifier polling) is
 * tested in `terminal-submit.test.ts`. These tests focus on scheduling
 * decisions and lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalSubmitScheduler } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { TerminalSubmit } from '../../src/main/pty/terminal-submit';
import type { SubmitContentOptions, SubmitKeystrokesOptions } from '../../src/main/pty/terminal-submit';
import type { SubmissionVerifier } from '../../src/shared/types';

class MockSessionManager extends EventEmitter {
  registry = new Map<string, { status: string }>();
  firstOutput = new Set<string>();
  firstOutputListenerCounts: number[] = [];

  getSession(id: string): { status: string } | undefined {
    return this.registry.get(id);
  }

  getFirstOutputCache(): Record<string, boolean> {
    this.firstOutputListenerCounts.push(this.listenerCount('first-output'));
    return Object.fromEntries([...this.firstOutput].map((id) => [id, true]));
  }

  emitFirstOutput(id: string): void {
    this.firstOutput.add(id);
    this.emit('first-output', id);
  }

  emitActivity(id: string, state: string): void {
    this.emit('activity', id, state);
  }

  emitSessionChanged(id: string, session: { status: string }): void {
    this.emit('session-changed', id, session);
  }

  emitExit(id: string): void {
    this.emit('exit', id);
  }
}

class MockTerminalSubmit {
  /** Each call captures the args and a controllable resolve / abort hook. */
  calls: Array<{
    sessionId: string;
    commands: string[];
    opts: SubmitKeystrokesOptions;
    resolve: () => void;
    aborted: boolean;
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

  submitKeystrokes(
    sessionId: string,
    commands: string[],
    opts: SubmitKeystrokesOptions,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const call = { sessionId, commands, opts, resolve, aborted: false };
      this.calls.push(call);
      this.observableOrder.push({ kind: 'keystrokes', commands });
      if (opts.signal) {
        if (opts.signal.aborted) {
          call.aborted = true;
          resolve();
          return;
        }
        opts.signal.addEventListener('abort', () => {
          call.aborted = true;
          resolve();
        });
      }
    });
  }

  /** Resolve the most recent unresolved call - simulates a delivery finishing. */
  finishLatest(): void {
    const pending = this.calls.find((c) => !c.aborted);
    if (pending) pending.resolve();
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
      sessionManager.firstOutput.add('s1');

      scheduler.scheduleContent('task-1', 's1', 'cached content');
      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(sessionManager.firstOutputListenerCounts).toEqual([1]);
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
      scheduler.scheduleKeystrokes('task-1', 's1', ['/follow'], {
        verifier,
        verifiedPrefixLength: 1,
      });
      sessionManager.emitFirstOutput('s1');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
      expect(terminalSubmit.observableOrder).toEqual([
        { kind: 'content', text: 'content' },
      ]);

      terminalSubmit.finishContentLatest();
      await tick();

      expect(terminalSubmit.observableOrder).toEqual([
        { kind: 'content', text: 'content' },
        { kind: 'keystrokes', commands: ['/follow'] },
      ]);
      expect(terminalSubmit.calls[0].opts.sendCtrlC).toBe(false);
      expect(terminalSubmit.calls[0].opts.verifier).toBe(verifier);
      expect(terminalSubmit.calls[0].opts.verifiedPrefixLength).toBe(1);
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

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test']);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].sessionId).toBe('s1');
      expect(terminalSubmit.calls[0].commands).toEqual(['/test']);
    });

    it('delivers a chained sequence in one call', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/model opus', '/effort high']);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].commands).toEqual(['/model opus', '/effort high']);
    });

    it('forwards verifier and verifiedPrefixLength', async () => {
      sessionManager.registry.set('s1', { status: 'running' });
      const verifier = vi.fn();

      scheduler.scheduleKeystrokes('task-1', 's1', ['/model opus', 'auto'], {
        verifier,
        verifiedPrefixLength: 1,
      });
      await tick();

      expect(terminalSubmit.calls[0].opts.verifier).toBe(verifier);
      expect(terminalSubmit.calls[0].opts.verifiedPrefixLength).toBe(1);
    });
  });

  describe('drag-burst coalescing', () => {
    it('queues a follow-up while a burst is in flight, then drains it', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/first']);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);

      // Second schedule while first is still in flight - stashed as next.
      scheduler.scheduleKeystrokes('task-1', 's1', ['/second']);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1); // not started yet

      // Resolve the first - the second drains automatically.
      terminalSubmit.finishLatest();
      await tick();
      expect(terminalSubmit.calls).toHaveLength(2);
      expect(terminalSubmit.calls[1].commands).toEqual(['/second']);
    });

    it('overwrites prior queued sequence with the latest (drag-through)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/first']);
      await tick();
      // Two more arrive while first is in flight - only the latest survives.
      scheduler.scheduleKeystrokes('task-1', 's1', ['/second-discarded']);
      scheduler.scheduleKeystrokes('task-1', 's1', ['/third']);
      await tick();

      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls).toHaveLength(2);
      expect(terminalSubmit.calls[1].commands).toEqual(['/third']);
    });
  });

  describe('freshlySpawned: wait for thinking event', () => {
    it('does not deliver until activity:thinking fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      sessionManager.emitActivity('s1', 'thinking');
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
    });

    it('30s fallback delivers anyway when thinking never fires', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();

      vi.advanceTimersByTime(30_000);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      // Fallback delivery must also honor freshlySpawned -> sendCtrlC=false.
      expect(terminalSubmit.calls[0].opts.sendCtrlC).toBe(false);
    });

    it('hard timeout (default 120s) cancels when CLI never starts', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], {
        freshlySpawned: true,
        timeoutMs: 1000, // shorter for the test
      });
      await tick();

      vi.advanceTimersByTime(1500);
      await tick();
      // Even if thinking now arrives, the cancel already happened.
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    // Regression: when the scheduler hardcoded `sendCtrlC: true`, the leading
    // Ctrl+C on a freshly-spawned Claude Code session landed mid-render of the
    // initial CLI-arg prompt turn. The follow-up keystrokes then concatenated
    // onto the prompt as one user message (`<task>...</task>/test` glued
    // together). The fix derives sendCtrlC from `freshlySpawned` so the
    // documented `submitKeystrokes` contract is honored.
    it('passes sendCtrlC=false to submitKeystrokes for freshly-spawned bursts', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].opts.sendCtrlC).toBe(false);
    });

    it('keeps sendCtrlC=true for live-injection bursts (no freshlySpawned)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/model opus']);
      await tick();

      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].opts.sendCtrlC).toBe(true);
    });
  });

  describe('queued session: wait for running then thinking', () => {
    it('ignores activity:thinking before status:running', async () => {
      sessionManager.registry.set('s1', { status: 'queued' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
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

  describe('cancel', () => {
    it('aborts in-flight delivery via AbortController', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test']);
      await tick();
      expect(terminalSubmit.calls).toHaveLength(1);
      expect(terminalSubmit.calls[0].aborted).toBe(false);

      scheduler.cancel('task-1');
      await tick();

      expect(terminalSubmit.calls[0].aborted).toBe(true);
    });

    it('drops queued follow-up sequence', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/first']);
      await tick();
      scheduler.scheduleKeystrokes('task-1', 's1', ['/second']);
      await tick();

      scheduler.cancel('task-1');
      // Resolve the first delivery - the queued second should NOT run.
      terminalSubmit.finishLatest();
      await tick();

      expect(terminalSubmit.calls.filter((c) => !c.aborted)).toHaveLength(0);
      expect(terminalSubmit.calls.some((c) => c.commands.includes('/second'))).toBe(false);
    });

    it('removes deferred listeners (freshlySpawned was waiting)', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
      await tick();
      expect(terminalSubmit.calls).toHaveLength(0);

      scheduler.cancel('task-1');
      // Even after thinking event, nothing is delivered.
      sessionManager.emitActivity('s1', 'thinking');
      await tick();

      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('exit event during deferred wait cancels the injection', async () => {
      sessionManager.registry.set('s1', { status: 'running' });

      scheduler.scheduleKeystrokes('task-1', 's1', ['/test'], { freshlySpawned: true });
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

      scheduler.scheduleKeystrokes('task-a', 's1', ['/a']);
      scheduler.scheduleKeystrokes('task-b', 's2', ['/b'], { freshlySpawned: true });
      await tick();

      scheduler.cancelAll();
      sessionManager.emitActivity('s1', 'thinking');
      sessionManager.emitActivity('s2', 'thinking');
      await tick();

      // task-a was delivered then aborted; task-b never delivered.
      expect(terminalSubmit.calls.find((c) => c.commands.includes('/a'))?.aborted).toBe(true);
      expect(terminalSubmit.calls.some((c) => c.commands.includes('/b'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('skips when session does not exist', () => {
      scheduler.scheduleKeystrokes('task-1', 's1', ['/test']);
      expect(terminalSubmit.calls).toHaveLength(0);
    });

    it('skips when commands array is empty', () => {
      sessionManager.registry.set('s1', { status: 'running' });
      scheduler.scheduleKeystrokes('task-1', 's1', []);
      expect(terminalSubmit.calls).toHaveLength(0);
    });
  });
});
