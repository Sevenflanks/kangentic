import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeIdleSnapshot } from '../../src/main/activity-engine/native-idle-evidence';
import type { SubmitKeystrokesOptions } from '../../src/main/pty/terminal-submit';
import type { SubmissionLease } from '../../src/main/pty/session-write-coordinator';
import { TerminalSubmitScheduler } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { NativeIdleRequest } from '../../src/main/transition-engine/native-idle-waiter';

const PRIVATE_COMMAND = '/private-review-command';
const PUBLIC_STATUS_KEYS = ['at', 'generation', 'projectId', 'sessionId', 'state', 'taskId'];
const CANCELLED_STATUS_KEYS = [...PUBLIC_STATUS_KEYS, 'reason'].sort();

function expectPublicStatus(status: object, expectedKeys: readonly string[]): void {
  expect(Object.keys(status).sort()).toEqual(expectedKeys);
  expect(status).not.toHaveProperty('command');
  expect(status).not.toHaveProperty('fingerprint');
  expect(status).not.toHaveProperty('nativeSessionId');
  expect(status).not.toHaveProperty('transcript');
  expect(status).not.toHaveProperty('error');
}

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class NativeSessionManager extends EventEmitter {
  readonly registry = new Map([['s1', { status: 'running' as const }]]);
  readonly snapshots = new Map<string, NativeIdleSnapshot>(); readonly listeners = new Map<string, Set<() => void>>();
  readonly order: string[] = []; readonly writes: string[] = []; readonly releases: string[] = [];
  snapshotRace: (() => void) | null = null; onAcquire: (() => void) | null = null;
  leaseConflict = false; leaseActive = false; leaseCommitted = false; autoAcknowledge = true;
  acknowledgements: ReturnType<typeof deferred>[] = [];

  constructor() { super(); this.snapshots.set('s1', this.makeSnapshot()); }

  makeSnapshot(overrides: Partial<NativeIdleSnapshot> = {}): NativeIdleSnapshot {
    return { rootNativeSessionId: 'root-1', sessionGeneration: 1, inputGeneration: 0, cleanIdle: null, errorLatched: false, ...overrides };
  }

  getSession(id: string) { return this.registry.get(id); } getFirstOutputCache(): Record<string, boolean> { return {}; }
  snapshotNativeIdle(id: string): NativeIdleSnapshot | null { this.order.push('snapshot');
    const race = this.snapshotRace; this.snapshotRace = null;
    race?.(); return this.snapshots.get(id) ?? null;
  }

  subscribeNativeIdle(id: string, listener: () => void): () => void {
    this.order.push('subscribe');
    const listeners = this.listeners.get(id) ?? new Set<() => void>();
    listeners.add(listener); this.listeners.set(id, listeners); return () => listeners.delete(listener);
  }

  updateSnapshot(id: string, snapshot: NativeIdleSnapshot | null): void {
    if (snapshot) this.snapshots.set(id, snapshot); else this.snapshots.delete(id);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  acquireAutomation(
    _id: string,
    _expected: { sessionGeneration: number; inputGeneration: number },
    onFirstWrite: () => void,
  ): SubmissionLease | null {
    this.onAcquire?.();
    if (this.leaseConflict || this.leaseActive) return null;
    this.leaseActive = true; this.leaseCommitted = false;
    let active = true;
    return {
      sessionId: 's1', sessionGeneration: 1, inputGeneration: 0,
      write: (data: string): Promise<void> => {
        if (!active) return Promise.reject(new Error('inactive'));
        if (!this.leaseCommitted) { this.leaseCommitted = true; onFirstWrite(); }
        this.writes.push(data);
        if (this.autoAcknowledge) return Promise.resolve();
        const acknowledgement = deferred(); this.acknowledgements.push(acknowledgement);
        return acknowledgement.promise;
      },
      release: (): void => {
        if (!active) return;
        active = false; this.leaseActive = false; this.releases.push('release');
      },
    };
  }
}

class NativeTerminalSubmit {
  readonly calls: Array<{ commands: string[]; options: SubmitKeystrokesOptions }> = [];
  readonly contentCompletions: ReturnType<typeof deferred>[] = [];
  skipWrites = false; failure: Error | null = null;

  async submitKeystrokes(_id: string, commands: string[], options: SubmitKeystrokesOptions): Promise<void> {
    this.calls.push({ commands, options });
    if (this.skipWrites) return;
    const writer = options.writer;
    if (!writer) throw new Error('missing writer');
    await writer.write(commands[0]); await writer.write('\x1b'); await writer.write('\r');
    if (this.failure) throw this.failure;
  }

  submitContent(_id: string, _text: string): Promise<void> {
    const completion = deferred(); this.contentCompletions.push(completion);
    return completion.promise;
  }
}

const request = (overrides: Partial<NativeIdleRequest> = {}): NativeIdleRequest => ({
  projectId: 'p1', taskId: 't1', sessionId: 's1', nativeSessionId: 'root-1', sessionGeneration: 1, inputGeneration: 0, command: '/review',
  policy: { mode: 'wait-for-native-idle', timeoutMs: 120_000, cancelOnUserInput: true, sendCtrlC: false },
  validateCurrent: () => 'valid', ...overrides,
});

async function tick(): Promise<void> { for (let index = 0; index < 6; index++) await Promise.resolve(); }

describe('TerminalSubmitScheduler native-idle lifecycle', () => {
  let manager: NativeSessionManager; let submit: NativeTerminalSubmit;
  let statuses: Array<Record<string, unknown>>; let scheduler: TerminalSubmitScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    manager = new NativeSessionManager(); submit = new NativeTerminalSubmit(); statuses = [];
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => statuses.push(status));
  });

  afterEach(() => { scheduler.cancelAll(); vi.useRealTimers(); });

  it('returns an admission registration before root idle or timeout settles delivery', () => {
    const registration = scheduler.scheduleNativeIdleSubmission(request());

    expect(registration).toEqual({ accepted: true, generation: 1 });
    expect(statuses).toEqual([
      expect.objectContaining({ generation: 1, state: 'waiting' }),
    ]);
    expect(statuses.some((status) => status.state === 'delivered' || status.state === 'cancelled')).toBe(false);
    expect(submit.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('returns null when shutdown has closed scheduler admission', () => {
    scheduler.cancelAll('shutdown');

    const registration = scheduler.scheduleNativeIdleSubmission(request());

    expect(registration).toBeNull();
    expect(statuses).toHaveLength(0);
    expect(submit.calls).toHaveLength(0);
  });

  it('returns null when a cancellation callback takes ownership before admission completes', () => {
    let callbackRegistration: unknown;
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'cancelled' && status.generation === 1) {
        callbackRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/callback-owner' }));
      }
    });
    const firstRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/first-owner' }));

    const displacedRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/displaced-owner' }));

    expect(firstRegistration).toEqual({ accepted: true, generation: 1 });
    expect(displacedRegistration).toBeNull();
    expect(callbackRegistration).toEqual({ accepted: true, generation: 3 });
  });

  it('returns null when its waiting callback synchronously replaces the new owner', async () => {
    let replacementRegistration: ReturnType<TerminalSubmitScheduler['scheduleNativeIdleSubmission']> = null;
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'waiting' && status.generation === 1) {
        replacementRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/replacement-owner' }));
      }
    });

    const displacedRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/displaced-owner' }));

    expect(displacedRegistration).toBeNull();
    expect(replacementRegistration).toEqual({ accepted: true, generation: 2 });
    expect(manager.listeners.get('s1')?.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    await tick();
    expect(submit.calls.map((call) => call.commands)).toEqual([['/replacement-owner']]);
  });

  it('keeps delivery terminal status asynchronous after admission', async () => {
    manager.autoAcknowledge = false;
    const registration = scheduler.scheduleNativeIdleSubmission(request());

    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));

    expect(registration).toEqual({ accepted: true, generation: 1 });
    expect(statuses.at(-1)).toMatchObject({ generation: 1, state: 'sending' });
    expect(statuses.some((status) => status.state === 'delivered' || status.state === 'cancelled')).toBe(false);
    manager.acknowledgements[0]?.resolve(); await tick();
    manager.acknowledgements[1]?.resolve(); await tick();
    manager.acknowledgements[2]?.resolve(); await tick();
    expect(statuses.at(-1)).toMatchObject({ generation: 1, state: 'delivered' });
  });

  it.each([
    ['user input', 'user-input', () => manager.updateSnapshot('s1', manager.makeSnapshot({ inputGeneration: 1 }))],
    ['turn error', 'turn-error', () => manager.updateSnapshot('s1', manager.makeSnapshot({ errorLatched: true }))],
    ['timeout', 'timeout', () => vi.advanceTimersByTime(50)],
  ] as const)('emits %s cancellation after accepted admission', async (_event, reason, trigger) => {
    const registration = scheduler.scheduleNativeIdleSubmission(request({
      policy: { ...request().policy, timeoutMs: 50 },
    }));

    expect(registration).toEqual({ accepted: true, generation: 1 });
    expect(statuses.some((status) => status.state === 'delivered' || status.state === 'cancelled')).toBe(false);
    trigger(); await tick();
    expect(statuses.at(-1)).toMatchObject({ generation: 1, state: 'cancelled', reason });
  });

  it('emits delivery-error cancellation after accepted admission', async () => {
    submit.failure = new Error('delivery failed');
    const registration = scheduler.scheduleNativeIdleSubmission(request());

    expect(registration).toEqual({ accepted: true, generation: 1 });
    expect(statuses.some((status) => status.state === 'delivered' || status.state === 'cancelled')).toBe(false);
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    await tick();
    expect(statuses.at(-1)).toMatchObject({ generation: 1, state: 'cancelled', reason: 'delivery-error' });
  });

  it('subscribes before snapshot and sends once across cached/racing duplicate idle notifications', async () => {
    const ready = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });
    manager.snapshotRace = () => manager.updateSnapshot('s1', ready);
    scheduler.scheduleNativeIdleSubmission(request({ command: PRIVATE_COMMAND })); manager.updateSnapshot('s1', ready); await tick();
    expect(manager.order.slice(0, 2)).toEqual(['subscribe', 'snapshot']); expect(submit.calls).toHaveLength(1);
    const base = { projectId: 'p1', taskId: 't1', sessionId: 's1', generation: 1, at: '2026-07-22T00:00:00.000Z' };
    expect(statuses).toEqual(['waiting', 'sending', 'delivered'].map((state) => ({ ...base, state })));
    for (const status of statuses) expectPublicStatus(status, PUBLIC_STATUS_KEYS);
    expect(submit.calls[0].options).toMatchObject({ sendCtrlC: false, verifier: null, verifiedPrefixLength: 0 }); expect(submit.calls[0].options.signal).toBeUndefined();
  });

  it.each([
    ['user-input', { inputGeneration: 1 }, undefined], ['turn-error', { errorLatched: true }, undefined],
    ['session-exit', null, undefined], ['superseded', {}, 'superseded'], ['session-exit', {}, 'session-exit'],
  ] as const)('cancels once for %s before commitment', async (reason, nextSnapshot, validation) => {
    if (validation) scheduler.scheduleNativeIdleSubmission(request({ validateCurrent: () => validation }));
    else {
      scheduler.scheduleNativeIdleSubmission(request());
      manager.updateSnapshot('s1', nextSnapshot === null ? null : manager.makeSnapshot(nextSnapshot));
    }
    await tick();
    expect(statuses.filter((status) => status.state === 'cancelled')).toEqual([expect.objectContaining({ generation: 1, state: 'cancelled', reason })]);
    expect(submit.calls).toHaveLength(0);
  });

  it('times out once, ignores late idle, and rejects an already-expired cached idle', async () => {
    scheduler.scheduleNativeIdleSubmission(request({ policy: { ...request().policy, timeoutMs: 50 } }));
    vi.advanceTimersByTime(50); manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 60 } })); await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason: 'timeout' }); expect(submit.calls).toHaveLength(0);
    scheduler.scheduleNativeIdleSubmission(request({ taskId: 't2', policy: { ...request().policy, timeoutMs: 0 } })); await tick();
    expect(statuses.at(-1)).toMatchObject({ taskId: 't2', state: 'cancelled', reason: 'timeout' }); expect(submit.calls).toHaveLength(0);
  });

  it('reports valid-ready lease ownership conflict as delivery-error without retry', async () => {
    manager.leaseConflict = true;
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request({ command: PRIVATE_COMMAND })); await tick();
    const base = { projectId: 'p1', taskId: 't1', sessionId: 's1', generation: 1, at: '2026-07-22T00:00:00.000Z' };
    expect(statuses).toEqual([
      { ...base, state: 'waiting' },
      { ...base, state: 'cancelled', reason: 'delivery-error' },
    ]);
    expectPublicStatus(statuses[0], PUBLIC_STATUS_KEYS);
    expectPublicStatus(statuses[1], CANCELLED_STATUS_KEYS);
    expect(submit.calls).toHaveLength(0);
  });

  it.each([
    ['user-input', () => manager.updateSnapshot('s1', manager.makeSnapshot({ inputGeneration: 1 }))], ['turn-error', () => manager.updateSnapshot('s1', manager.makeSnapshot({ errorLatched: true }))], ['session-exit', () => manager.updateSnapshot('s1', null)],
  ] as const)('reclassifies lease acquisition failure as %s', async (reason, mutate) => {
    manager.leaseConflict = true; manager.onAcquire = mutate;
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request()); await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason });
  });

  it('reclassifies lease acquisition failure after configuration supersession', async () => {
    let validation: 'valid' | 'superseded' = 'valid';
    manager.leaseConflict = true; manager.onAcquire = () => { validation = 'superseded'; };
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request({ validateCurrent: () => validation })); await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason: 'superseded' });
  });

  it('isolates status callback exceptions from delivery', async () => {
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, () => { throw new Error('observer'); });
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    expect(() => scheduler.scheduleNativeIdleSubmission(request())).not.toThrow(); await tick();
    expect(submit.calls).toHaveLength(1);
  });

  it('rechecks ownership after a reentrant sending callback and preserves a zero-gap first write', async () => {
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'sending' && status.generation === 1) {
        scheduler.scheduleNativeIdleSubmission(request({ command: '/replacement' }));
      }
    });
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request()); await tick();
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 1, state: 'cancelled', reason: 'superseded' }));
    expect(submit.calls).toHaveLength(1); expect(submit.calls[0].commands).toEqual(['/replacement']); expect(manager.leaseCommitted).toBe(true);
  });

  it('waits for command, Escape, and Enter acknowledgements and rejects no-first-write completion', async () => {
    manager.autoAcknowledge = false; manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request());
    expect(statuses.at(-1)?.state).toBe('sending');
    manager.acknowledgements[0].resolve(); await tick();
    manager.acknowledgements[1].resolve(); await tick();
    expect(statuses.some((status) => status.state === 'delivered')).toBe(false);
    scheduler.scheduleKeystrokes('t1', 's1', ['/generic-successor']);
    manager.acknowledgements[2].resolve(); await tick();
    expect(statuses.at(-1)?.state).toBe('delivered');
    expect(submit.calls[1].commands).toEqual(['/generic-successor']);

    submit.skipWrites = true; scheduler.scheduleNativeIdleSubmission(request({ taskId: 't2' })); await tick();
    expect(statuses.at(-1)).toMatchObject({ taskId: 't2', state: 'cancelled', reason: 'delivery-error' });
  });

  it('supersedes pre-commit work and keeps only the latest post-commit successor', async () => {
    const oldRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/old' }));
    const currentRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/current' }));
    manager.autoAcknowledge = false;
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    const discardedSuccessorRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/discarded-successor' }));
    const latestSuccessorRegistration = scheduler.scheduleNativeIdleSubmission(request({ command: '/latest-successor' }));
    expect(oldRegistration).toEqual({ accepted: true, generation: 1 });
    expect(currentRegistration).toEqual({ accepted: true, generation: 2 });
    expect(discardedSuccessorRegistration).toEqual({ accepted: true, generation: 3 });
    expect(latestSuccessorRegistration).toEqual({ accepted: true, generation: 4 });
    expect(statuses.filter((status) => status.state === 'cancelled' && status.reason === 'superseded')).toHaveLength(2);
    manager.autoAcknowledge = true; for (const acknowledgement of manager.acknowledgements) acknowledgement.resolve(); await tick();
    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/current', '/latest-successor']);
    expect(manager.releases[0]).toBe('release');
  });

  it('expires a queued successor from its original request time and never starts it', async () => {
    manager.autoAcknowledge = false; manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request());
    scheduler.scheduleNativeIdleSubmission(request({
      command: '/expired', policy: { ...request().policy, timeoutMs: 10 },
    }));
    vi.advanceTimersByTime(10); manager.autoAcknowledge = true;
    for (const acknowledgement of manager.acknowledgements) acknowledgement.resolve(); await tick();
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 2, state: 'cancelled', reason: 'timeout' }));
    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/review']);
  });

  it('keeps committed delivery through user input and classifies rejection after evidence removal', async () => {
    submit.failure = new Error('private failure');
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request({ command: PRIVATE_COMMAND }));
    manager.updateSnapshot('s1', manager.makeSnapshot({ inputGeneration: 1 })); manager.updateSnapshot('s1', null); await tick();
    expect(manager.writes).toEqual([PRIVATE_COMMAND, '\x1b', '\r']);
    const terminalStatus = statuses.at(-1);
    expect(terminalStatus).toEqual({
      projectId: 'p1', taskId: 't1', sessionId: 's1', generation: 1,
      at: '2026-07-22T00:00:00.000Z', state: 'cancelled', reason: 'session-exit',
    });
    if (!terminalStatus) throw new Error('terminal status was not emitted');
    expectPublicStatus(terminalStatus, CANCELLED_STATUS_KEYS);
    expect(manager.releases).toEqual(['release']);
  });

  it('serializes native delivery behind generic work', async () => {
    let finishGeneric = (): void => undefined;
    const genericSubmit = vi.fn(() => new Promise<void>((resolve) => { finishGeneric = resolve; }));
    submit.submitKeystrokes = genericSubmit;
    scheduler.scheduleKeystrokes('t1', 's1', ['/generic']); manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    const registration = scheduler.scheduleNativeIdleSubmission(request());
    expect(registration).toEqual({ accepted: true, generation: 1 });
    expect(genericSubmit).toHaveBeenCalledTimes(1);
    finishGeneric(); await tick();
    expect(genericSubmit).toHaveBeenCalledTimes(2);
  });

  it('terminalizes a queued native successor when a strict prefix fails', async () => {
    submit.submitKeystrokes = vi.fn(async (_id, _commands, options) => {
      if (options.strictVerification) throw new Error('verification failed');
    });
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));

    scheduler.scheduleKeystrokes('t1', 's1', ['/effort high'], { strictVerification: true });
    scheduler.scheduleNativeIdleSubmission(request());
    await tick();

    expect(submit.submitKeystrokes).toHaveBeenCalledTimes(1);
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'cancelled', reason: 'delivery-error' }));
    expect([...manager.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes native delivery behind in-flight content', async () => {
    scheduler.scheduleContent('t1', 's1', 'content'); manager.emit('first-output', 's1'); await tick();
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    const registration = scheduler.scheduleNativeIdleSubmission(request());
    expect(registration).toEqual({ accepted: true, generation: 1 });
    expect(submit.calls).toHaveLength(0);
    submit.contentCompletions[0].resolve(); await tick();
    expect(submit.calls[0].commands).toEqual(['/review']);
  });

  it('shutdown during sending releases an uncommitted lease and prevents first write', () => {
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'sending') scheduler.cancelAll('shutdown');
    });
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } })); scheduler.scheduleNativeIdleSubmission(request());
    expect(submit.calls).toHaveLength(0); expect(manager.releases).toEqual(['release']);
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason: 'shutdown' });
  });

  it('shutdown cancels waiting, committed, and successor generations once and suppresses late completion', async () => {
    manager.autoAcknowledge = false; manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } }));
    scheduler.scheduleNativeIdleSubmission(request()); scheduler.scheduleNativeIdleSubmission(request({ command: '/successor' }));
    scheduler.cancelAll('shutdown');
    const terminalStatuses = statuses.filter((status) => status.state === 'cancelled');
    expect(terminalStatuses).toEqual([expect.objectContaining({ generation: 1, reason: 'shutdown' }), expect.objectContaining({ generation: 2, reason: 'shutdown' })]);
    for (const acknowledgement of manager.acknowledgements) acknowledgement.resolve(); await tick();
    expect(statuses.filter((status) => status.state === 'delivered')).toHaveLength(0);
  });

  it('shutdown detaches a waiting request before late idle', async () => {
    scheduler.scheduleNativeIdleSubmission(request()); scheduler.cancelAll('shutdown');
    manager.updateSnapshot('s1', manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } })); await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason: 'shutdown' });
    expect(submit.calls).toHaveLength(0);
  });
});
