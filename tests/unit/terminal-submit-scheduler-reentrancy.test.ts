import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeIdleSnapshot } from '../../src/main/activity-engine/native-idle-evidence';
import type { SubmitContentOptions, SubmitKeystrokesOptions } from '../../src/main/pty/terminal-submit';
import type { SubmissionLease } from '../../src/main/pty/session-write-coordinator';
import { TerminalSubmitScheduler } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { NativeIdleRequest } from '../../src/main/transition-engine/native-idle-waiter';

function deferred() {
  let resolve = (): void => undefined; let reject = (_error: Error): void => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise; reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ReentrantSessionManager extends EventEmitter {
  readonly registry = new Map([['s1', { status: 'running' as const }]]);
  readonly listeners = new Set<() => void>(); readonly writes: string[] = []; readonly releases: string[] = [];
  snapshot: NativeIdleSnapshot = this.makeSnapshot(); onAcquire: (() => void) | null = null; leaseActive = false;

  makeSnapshot(overrides: Partial<NativeIdleSnapshot> = {}): NativeIdleSnapshot {
    return { rootNativeSessionId: 'root-1', sessionGeneration: 1, inputGeneration: 0,
      cleanIdle: null, errorLatched: false, ...overrides };
  }

  getSession(id: string) { return this.registry.get(id); }
  getFirstOutputCache(): Record<string, boolean> { return {}; }
  snapshotNativeIdle(): NativeIdleSnapshot { return this.snapshot; }
  subscribeNativeIdle(_id: string, listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acquireAutomation(
    _id: string,
    _expected: { readonly sessionGeneration: number; readonly inputGeneration: number },
    onFirstWrite: () => void,
  ): SubmissionLease | null {
    this.onAcquire?.();
    if (this.leaseActive) return null;
    this.leaseActive = true;
    let active = true;
    let committed = false;
    return {
      sessionId: 's1', sessionGeneration: 1, inputGeneration: 0,
      write: (data: string): Promise<void> => {
        if (!active) return Promise.reject(new Error('inactive'));
        if (!committed) { committed = true; onFirstWrite(); }
        this.writes.push(data);
        return Promise.resolve();
      },
      release: (): void => {
        if (!active) return;
        active = false;
        this.leaseActive = false;
        this.releases.push('release');
      },
    };
  }
}

class ReentrantTerminalSubmit {
  readonly keystrokes: Array<{ readonly commands: string[]; readonly options: SubmitKeystrokesOptions }> = [];
  readonly contents: Array<{ readonly text: string; readonly options: SubmitContentOptions }> = [];
  acknowledgements: ReturnType<typeof deferred>[] = [];
  autoAcknowledge = true;
  failure: Error | null = null;

  async submitKeystrokes(_id: string, commands: string[], options: SubmitKeystrokesOptions): Promise<void> {
    this.keystrokes.push({ commands, options });
    if (!options.writer) return;
    for (const data of [commands[0], '\x1b', '\r']) {
      await options.writer.write(data);
      if (this.autoAcknowledge) continue;
      const acknowledgement = deferred();
      this.acknowledgements.push(acknowledgement);
      await acknowledgement.promise;
    }
    if (this.failure) throw this.failure;
  }

  submitContent(_id: string, text: string, options: SubmitContentOptions): Promise<void> {
    this.contents.push({ text, options });
    return Promise.resolve();
  }
}

const request = (command: string, overrides: Partial<NativeIdleRequest> = {}): NativeIdleRequest => ({
  projectId: 'p1', taskId: 't1', sessionId: 's1', nativeSessionId: 'root-1',
  sessionGeneration: 1, inputGeneration: 0, command,
  policy: { mode: 'wait-for-native-idle', timeoutMs: 120_000, cancelOnUserInput: true, sendCtrlC: false },
  validateCurrent: () => 'valid', ...overrides,
});

async function tick(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function acknowledgeAll(submit: ReentrantTerminalSubmit): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await tick();
    expect(submit.acknowledgements[index]).toBeDefined();
    submit.acknowledgements[index]?.resolve();
  }
  await tick();
}

describe('TerminalSubmitScheduler callback reentrancy', () => {
  let manager: ReentrantSessionManager; let submit: ReentrantTerminalSubmit;
  let statuses: Array<Record<string, unknown>>; let scheduler: TerminalSubmitScheduler;

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    manager = new ReentrantSessionManager(); submit = new ReentrantTerminalSubmit(); statuses = [];
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => statuses.push(status));
  });

  afterEach(() => {
    scheduler.cancelAll();
    vi.useRealTimers();
  });

  it('blocks native, content, and generic admission from a shutdown cancellation callback', async () => {
    // Given
    submit.autoAcknowledge = false;
    manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });
    let attempted = false;
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state !== 'cancelled' || status.reason !== 'shutdown' || attempted) return;
      attempted = true;
      scheduler.scheduleNativeIdleSubmission(request('nested-native'));
      scheduler.scheduleContent('t1', 's1', 'nested-content');
      scheduler.scheduleKeystrokes('t1', 's1', ['nested-generic']);
    });
    scheduler.scheduleNativeIdleSubmission(request('committed'));
    scheduler.scheduleNativeIdleSubmission(request('queued-successor'));

    // When
    scheduler.cancelAll('shutdown');
    manager.emit('first-output', 's1');
    await acknowledgeAll(submit);

    // Then
    expect(submit.keystrokes.map((call) => call.commands[0])).toEqual(['committed']);
    expect(submit.contents).toHaveLength(0);
    expect(statuses.filter((status) => status.state === 'waiting')).toHaveLength(2);
    expect(statuses.filter((status) => status.state === 'cancelled')).toEqual([
      expect.objectContaining({ generation: 1, reason: 'shutdown' }),
      expect.objectContaining({ generation: 2, reason: 'shutdown' }),
    ]);
    expect(statuses.some((status) => status.state === 'delivered')).toBe(false);
    expect(manager.releases).toEqual(['release']);
    expect(manager.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler['taskMutations'].size).toBe(0);
  });

  it('keeps callback-scheduled C newer than outer replacement B', async () => {
    // Given
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'cancelled' && status.generation === 1) {
        scheduler.scheduleNativeIdleSubmission(request('C'));
      }
    });
    scheduler.scheduleNativeIdleSubmission(request('A'));
    manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });

    // When
    scheduler.scheduleNativeIdleSubmission(request('B'));
    for (const acknowledgement of submit.acknowledgements) acknowledgement.resolve();
    await tick();

    // Then
    expect(submit.keystrokes.map((call) => call.commands[0])).toEqual(['C']);
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 2, state: 'cancelled', reason: 'superseded' }));
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 3, state: 'delivered' }));
  });

  it('terminalizes an outer successor displaced by its cancellation callback', async () => {
    // Given
    submit.autoAcknowledge = false; manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'cancelled' && status.generation === 2) scheduler.scheduleNativeIdleSubmission(request('D'));
    });
    scheduler.scheduleNativeIdleSubmission(request('A')); scheduler.scheduleNativeIdleSubmission(request('B'));

    // When
    scheduler.scheduleNativeIdleSubmission(request('C'));
    submit.autoAcknowledge = true; submit.acknowledgements[0]?.resolve(); await tick(); await tick();

    // Then
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 3, state: 'cancelled', reason: 'superseded' }));
    expect(submit.keystrokes.map((call) => call.commands[0])).toEqual(['A', 'D']);
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 4, state: 'delivered' }));
  });

  it('drops a successor when delivered callback explicitly cancels the task', async () => {
    // Given
    submit.autoAcknowledge = false; manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'delivered' && status.generation === 1) scheduler.cancel('t1');
    });
    scheduler.scheduleNativeIdleSubmission(request('current')); scheduler.scheduleNativeIdleSubmission(request('successor'));

    // When
    submit.autoAcknowledge = true; submit.acknowledgements[0]?.resolve(); await tick(); await tick();

    // Then
    expect(submit.keystrokes.map((call) => call.commands[0])).toEqual(['current']);
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 2, state: 'cancelled', reason: 'superseded' }));
    expect(manager.releases).toEqual(['release']);
  });

  it('keeps a request scheduled from waiting newer than the waiting outer request', async () => {
    // Given
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'waiting' && status.generation === 1) {
        scheduler.scheduleNativeIdleSubmission(request('newer'));
      }
    });
    manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });

    // When
    scheduler.scheduleNativeIdleSubmission(request('outer'));
    for (const acknowledgement of submit.acknowledgements) acknowledgement.resolve();
    await tick();

    // Then
    expect(submit.keystrokes.map((call) => call.commands[0])).toEqual(['newer']);
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 1, state: 'cancelled', reason: 'superseded' }));
    expect(statuses).toContainEqual(expect.objectContaining({ generation: 2, state: 'delivered' }));
  });

  it('keeps a committed request truthful through explicit cancel', async () => {
    // Given
    submit.autoAcknowledge = false;
    manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });
    scheduler.scheduleNativeIdleSubmission(request('committed'));
    expect(manager.writes).toEqual(['committed']);

    // When
    scheduler.cancel('t1');
    scheduler.scheduleNativeIdleSubmission(request('successor'));

    // Then
    expect(statuses.some((status) => status.state === 'cancelled')).toBe(false);
    expect(manager.releases).toHaveLength(0);
    submit.autoAcknowledge = true;
    submit.acknowledgements[0]?.resolve();
    await tick();
    expect(submit.keystrokes.map((call) => call.commands[0])).toEqual(['committed', 'successor']);
    expect(statuses.filter((status) => status.state === 'delivered')).toEqual([
      expect.objectContaining({ generation: 1 }),
      expect.objectContaining({ generation: 2 }),
    ]);
    await tick();
    expect(manager.releases).toEqual(['release', 'release']);
  });

  it('reports delivery-error after explicit cancel when committed delivery fails', async () => {
    // Given
    submit.autoAcknowledge = false;
    submit.failure = new Error('delivery failed');
    manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });
    scheduler.scheduleNativeIdleSubmission(request('committed-failure'));

    // When
    scheduler.cancel('t1');
    await acknowledgeAll(submit);

    // Then
    expect(statuses.filter((status) => status.state === 'cancelled')).toEqual([
      expect.objectContaining({ reason: 'delivery-error' }),
    ]);
    expect(manager.releases).toEqual(['release']);
  });

  it('times out when lease acquisition crosses the deadline before sending', () => {
    // Given
    manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });
    manager.onAcquire = () => vi.setSystemTime(new Date('2026-07-22T00:00:00.010Z'));

    // When
    scheduler.scheduleNativeIdleSubmission(request('expired-acquire', {
      policy: { ...request('x').policy, timeoutMs: 10 },
    }));

    // Then
    expect(manager.writes).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason: 'timeout' });
    expect(manager.releases).toEqual(['release']);
  });

  it('times out when the sending callback crosses the deadline before first write', () => {
    // Given
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'sending') vi.setSystemTime(new Date('2026-07-22T00:00:00.010Z'));
    });
    manager.snapshot = manager.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 } });

    // When
    scheduler.scheduleNativeIdleSubmission(request('expired-sending', {
      policy: { ...request('x').policy, timeoutMs: 10 },
    }));

    // Then
    expect(manager.writes).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({ state: 'cancelled', reason: 'timeout' });
    expect(manager.releases).toEqual(['release']);
  });
});
