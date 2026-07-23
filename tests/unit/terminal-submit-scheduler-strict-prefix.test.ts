import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeIdleSnapshot } from '../../src/main/activity-engine/native-idle-evidence';
import type { SubmitKeystrokesOptions } from '../../src/main/pty/terminal-submit';
import type { SubmissionLease } from '../../src/main/pty/session-write-coordinator';
import { TerminalSubmitScheduler } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { NativeIdleRequest } from '../../src/main/transition-engine/native-idle-waiter';

class PrefixManager extends EventEmitter {
  readonly listeners = new Set<() => void>();
  readonly writes: string[] = [];
  snapshot: NativeIdleSnapshot;

  constructor() {
    super();
    this.snapshot = this.makeSnapshot();
  }

  makeSnapshot(overrides: Partial<NativeIdleSnapshot> = {}): NativeIdleSnapshot {
    return { rootNativeSessionId: 'root-1', sessionGeneration: 1, inputGeneration: 0, cleanIdle: null, errorLatched: false, ...overrides };
  }

  getSession(): { readonly status: 'running' } { return { status: 'running' }; }
  snapshotNativeIdle(): NativeIdleSnapshot { return this.snapshot; }
  subscribeNativeIdle(_sessionId: string, listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emitIdle(): void {
    this.snapshot = this.makeSnapshot({ cleanIdle: { nativeSessionId: 'root-1', occurredAt: 1 } });
    for (const listener of this.listeners) listener();
  }
  acquireAutomation(_sessionId: string, _expected: { readonly sessionGeneration: number; readonly inputGeneration: number }, onFirstWrite: () => void): SubmissionLease {
    let active = true;
    return {
      sessionId: 's1', sessionGeneration: 1, inputGeneration: 0,
      write: async (data: string) => { if (!active) throw new Error('inactive'); onFirstWrite(); this.writes.push(data); },
      release: () => { active = false; },
    };
  }
}

class PrefixSubmit {
  readonly calls: Array<{ readonly commands: readonly string[]; readonly options: SubmitKeystrokesOptions }> = [];
  failPrefix = false;

  async submitKeystrokes(_sessionId: string, commands: string[], options: SubmitKeystrokesOptions): Promise<void> {
    this.calls.push({ commands, options });
    if (options.strictVerification && this.failPrefix) throw new Error('verification failed');
    if (options.writer) {
      await options.writer.write(commands[0] ?? '');
      await options.writer.write('\x1b');
      await options.writer.write('\r');
    }
  }
}

function request(onDelivered: () => void): NativeIdleRequest {
  return {
    projectId: 'p1', taskId: 't1', sessionId: 's1', nativeSessionId: 'root-1', sessionGeneration: 1, inputGeneration: 0,
    command: '/lane', policy: { mode: 'wait-for-native-idle', timeoutMs: 100, cancelOnUserInput: true, sendCtrlC: false },
    validateCurrent: () => 'valid',
  };
}

async function tick(): Promise<void> { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

describe('TerminalSubmitScheduler strict prefix successors', () => {
  let manager: PrefixManager;
  let submit: PrefixSubmit;
  let scheduler: TerminalSubmitScheduler;
  let statuses: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PrefixManager();
    submit = new PrefixSubmit();
    statuses = [];
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => statuses.push(status));
  });

  afterEach(() => { scheduler.cancelAll(); vi.useRealTimers(); });

  it('watches a successful strict prefix successor until later native idle', async () => {
    scheduler.scheduleKeystrokes('t1', 's1', ['/effort high'], { strictVerification: true });
    scheduler.scheduleNativeIdleSubmission(request(() => undefined));
    await tick();

    expect(manager.listeners.size).toBe(1);
    expect(submit.calls).toHaveLength(1);
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'waiting' }));

    manager.emitIdle();
    await tick();

    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/effort high', '/lane']);
    expect(statuses.map((status) => status.state)).toEqual(['waiting', 'sending', 'delivered']);
    expect(manager.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not persist when a strict prefix terminalizes its native successor', async () => {
    const persist = vi.fn();
    submit.failPrefix = true;

    scheduler.scheduleKeystrokes('t1', 's1', ['/effort high'], { strictVerification: true, onDelivered: persist });
    scheduler.scheduleNativeIdleSubmission(request(persist));
    await tick();

    expect(persist).not.toHaveBeenCalled();
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'cancelled', reason: 'delivery-error' }));
    expect(manager.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps newer generic work scheduled by a failure status callback', async () => {
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'cancelled' && status.reason === 'delivery-error') {
        scheduler.scheduleKeystrokes('t1', 's1', ['/replacement']);
      }
    });
    submit.failPrefix = true;

    scheduler.scheduleKeystrokes('t1', 's1', ['/effort high'], { strictVerification: true });
    scheduler.scheduleNativeIdleSubmission(request(() => undefined));
    await tick();

    expect(statuses.filter((status) => status.state === 'cancelled')).toEqual([
      expect.objectContaining({ state: 'cancelled', reason: 'delivery-error' }),
    ]);
    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/effort high', '/replacement']);
  });

  it('retains an already queued generic successor after a strict prefix failure', async () => {
    submit.failPrefix = true;

    scheduler.scheduleKeystrokes('t1', 's1', ['/effort high'], { strictVerification: true });
    scheduler.scheduleKeystrokes('t1', 's1', ['/generic-successor']);
    await tick();

    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/effort high', '/generic-successor']);
  });

  it('awaits an async completion gate before releasing a generic successor', async () => {
    let release = (): void => undefined;
    const completion = new Promise<void>((resolve) => { release = resolve; });

    scheduler.scheduleKeystrokes('t1', 's1', ['/effort high'], { onDelivered: () => completion });
    scheduler.scheduleKeystrokes('t1', 's1', ['/generic-successor']);
    await tick();

    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/effort high']);
    release();
    await tick();
    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/effort high', '/generic-successor']);
  });

  it('keeps newer generic work when an async completion gate rejects', async () => {
    scheduler = new TerminalSubmitScheduler(manager as never, submit as never, (status) => {
      statuses.push(status);
      if (status.state === 'cancelled' && status.reason === 'delivery-error') {
        scheduler.scheduleKeystrokes('t1', 's1', ['/replacement']);
      }
    });

    scheduler.scheduleKeystrokes('t1', 's1', ['/effort high'], {
      onDelivered: async () => Promise.reject(new Error('stale completion')),
    });
    scheduler.scheduleNativeIdleSubmission(request(() => undefined));
    await tick();

    expect(submit.calls.map((call) => call.commands[0])).toEqual(['/effort high', '/replacement']);
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'cancelled', reason: 'delivery-error' }));
  });
});
