import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeIdleSnapshot } from '../../src/main/activity-engine/native-idle-evidence';
import type { SubmitContentOptions, SubmitKeystrokesOptions } from '../../src/main/pty/terminal-submit';
import type { SubmissionLease } from '../../src/main/pty/session-write-coordinator';
import { TerminalSubmitScheduler } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { NativeIdleRequest } from '../../src/main/transition-engine/native-idle-waiter';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class FollowUpSessionManager extends EventEmitter {
  readonly registry = new Map([
    ['s-a', { status: 'running' as const }],
    ['s-b', { status: 'running' as const }],
  ]);
  readonly snapshots = new Map<string, NativeIdleSnapshot>();
  readonly listeners = new Map<string, Set<() => void>>();
  readonly writes: string[] = [];
  readonly releases: string[] = [];
  rejectLease = false;
  onAcquire: (() => void) | null = null;

  constructor() {
    super();
    this.snapshots.set('s-a', this.makeSnapshot('s-a'));
    this.snapshots.set('s-b', this.makeSnapshot('s-b'));
  }

  makeSnapshot(sessionId: string, ready = false): NativeIdleSnapshot {
    return {
      rootNativeSessionId: `root-${sessionId}`,
      sessionGeneration: 1,
      inputGeneration: 0,
      cleanIdle: ready ? { nativeSessionId: `root-${sessionId}`, occurredAt: 10 } : null,
      errorLatched: false,
    };
  }

  getSession(sessionId: string) { return this.registry.get(sessionId); }
  getFirstOutputCache(): Record<string, boolean> { return {}; }
  snapshotNativeIdle(sessionId: string): NativeIdleSnapshot | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  subscribeNativeIdle(sessionId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }

  updateSnapshot(sessionId: string, snapshot: NativeIdleSnapshot): void {
    this.snapshots.set(sessionId, snapshot);
    for (const listener of this.listeners.get(sessionId) ?? []) listener();
  }

  acquireAutomation(
    sessionId: string,
    expected: { readonly sessionGeneration: number; readonly inputGeneration: number },
    onFirstWrite: () => void,
  ): SubmissionLease | null {
    this.onAcquire?.();
    if (this.rejectLease) return null;
    let active = true;
    let committed = false;
    return {
      sessionId,
      sessionGeneration: expected.sessionGeneration,
      inputGeneration: expected.inputGeneration,
      write: (data: string): Promise<void> => {
        if (!active) return Promise.reject(new Error('inactive lease'));
        if (!committed) {
          committed = true;
          onFirstWrite();
        }
        this.writes.push(data);
        return Promise.resolve();
      },
      release: (): void => {
        if (!active) return;
        active = false;
        this.releases.push(sessionId);
      },
    };
  }
}

class FollowUpTerminalSubmit {
  readonly nativeCalls: string[] = [];
  readonly nativeCompletions: Array<ReturnType<typeof deferred>> = [];
  readonly contentCalls: string[] = [];

  constructor(private readonly manager: FollowUpSessionManager) {}

  async submitKeystrokes(
    _sessionId: string,
    commands: string[],
    options: SubmitKeystrokesOptions,
  ): Promise<void> {
    this.nativeCalls.push(commands[0]);
    const completion = deferred();
    this.nativeCompletions.push(completion);
    const writer = options.writer;
    if (!writer) throw new Error('missing writer');
    await writer.write(commands[0]);
    await completion.promise;
  }

  submitContent(
    _sessionId: string,
    text: string,
    options: SubmitContentOptions,
  ): Promise<void> {
    this.contentCalls.push(text);
    return new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        if (text === 'owner') this.manager.emit('first-output', 's-b');
        reject(new Error('aborted'));
      }, { once: true });
    });
  }
}

function request(taskId: string, sessionId: string, command: string): NativeIdleRequest {
  return {
    projectId: 'p1',
    taskId,
    sessionId,
    nativeSessionId: `root-${sessionId}`,
    sessionGeneration: 1,
    inputGeneration: 0,
    command,
    policy: {
      mode: 'wait-for-native-idle',
      timeoutMs: 120_000,
      cancelOnUserInput: true,
      sendCtrlC: false,
    },
    validateCurrent: () => 'valid',
  };
}

async function tick(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('TerminalSubmitScheduler review follow-up', () => {
  let manager: FollowUpSessionManager;
  let submit: FollowUpTerminalSubmit;
  let scheduler: TerminalSubmitScheduler;
  let statuses: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T00:00:00.000Z'));
    manager = new FollowUpSessionManager();
    submit = new FollowUpTerminalSubmit(manager);
    statuses = [];
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => statuses.push(status));
  });

  afterEach(() => {
    scheduler.cancelAll();
    vi.useRealTimers();
  });

  it('blocks another task native readiness triggered by a shutdown callback', () => {
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.taskId === 'task-a' && status.state === 'cancelled') {
        manager.updateSnapshot('s-b', manager.makeSnapshot('s-b', true));
      }
    });
    scheduler.scheduleNativeIdleSubmission(request('task-a', 's-a', 'owner'));
    scheduler.scheduleNativeIdleSubmission(request('task-b', 's-b', 'nested'));

    scheduler.cancelAll('shutdown');

    expect(submit.nativeCalls).toEqual([]);
    expect(statuses).toContainEqual(expect.objectContaining({ taskId: 'task-b', reason: 'shutdown' }));
  });

  it('blocks another task content readiness triggered by shutdown abort', async () => {
    scheduler.scheduleContent('task-a', 's-a', 'owner');
    scheduler.scheduleContent('task-b', 's-b', 'nested');
    manager.emit('first-output', 's-a');
    await tick();

    scheduler.cancelAll('shutdown');
    await tick();

    expect(submit.contentCalls).toEqual(['owner']);
  });

  it('cleans the mutation token after explicitly cancelled committed work settles', async () => {
    manager.updateSnapshot('s-a', manager.makeSnapshot('s-a', true));
    scheduler.scheduleNativeIdleSubmission(request('task-a', 's-a', 'owner'));
    scheduler.cancel('task-a');

    submit.nativeCompletions[0]?.resolve();
    await tick();

    expect(scheduler['taskMutations'].size).toBe(0);
  });

  it('does not let an old committed completion delete its successor token', async () => {
    manager.updateSnapshot('s-a', manager.makeSnapshot('s-a', true));
    scheduler.scheduleNativeIdleSubmission(request('task-a', 's-a', 'owner'));
    scheduler.cancel('task-a');
    scheduler.scheduleNativeIdleSubmission(request('task-a', 's-a', 'successor'));

    submit.nativeCompletions[0]?.resolve();
    await tick();

    expect(submit.nativeCalls).toEqual(['owner', 'successor']);
    expect(scheduler['taskMutations'].size).toBe(1);
    submit.nativeCompletions[1]?.resolve();
    await tick();
    expect(scheduler['taskMutations'].size).toBe(0);
  });

  it('classifies a null lease returned after the deadline as timeout', () => {
    manager.rejectLease = true;
    manager.onAcquire = () => vi.setSystemTime(new Date('2026-07-23T00:00:00.010Z'));
    manager.updateSnapshot('s-a', manager.makeSnapshot('s-a', true));
    const expiring = request('task-a', 's-a', 'owner');

    scheduler.scheduleNativeIdleSubmission({
      ...expiring,
      policy: { ...expiring.policy, timeoutMs: 10 },
    });

    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason: 'timeout' });
  });
});
