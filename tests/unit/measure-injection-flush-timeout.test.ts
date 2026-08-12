import { describe, expect, it, vi } from 'vitest';
import { runWithProbeCeiling } from '../../scripts/lib/measure-injection-flush-timeout.mjs';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolveDeferred = resolvePromise;
  });
  if (!resolveDeferred) throw new Error('Deferred promise did not expose its resolver');
  return { promise, resolve: resolveDeferred };
}

describe('measure-injection-flush probe ceiling', () => {
  it('clears the ceiling timer when the probe completes normally', async () => {
    vi.useFakeTimers();
    const createTimeoutResult = vi.fn(() => ({ error: 'probe exceeded the 240s ceiling' }));

    await expect(runWithProbeCeiling({
      ceilingMs: 60_000,
      createTimeoutResult,
      runProbe: async () => ({ error: null }),
    })).resolves.toEqual({ error: null });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createTimeoutResult).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clears the ceiling timer and propagates a rejected probe', async () => {
    vi.useFakeTimers();
    const failure = new Error('probe failed');
    const createTimeoutResult = vi.fn(() => ({ error: 'probe exceeded the 240s ceiling' }));

    await expect(runWithProbeCeiling({
      ceilingMs: 60_000,
      createTimeoutResult,
      runProbe: async () => { throw failure; },
    })).rejects.toThrow(failure);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createTimeoutResult).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels the probe and waits for its PTY cleanup before returning the timeout result', async () => {
    vi.useFakeTimers();
    const cleanup = deferred<void>();
    const pty = { kill: vi.fn(), write: vi.fn() };
    let resultSettled = false;

    const result = runWithProbeCeiling({
      ceilingMs: 1,
      createTimeoutResult: () => ({ error: 'probe exceeded the 240s ceiling' }),
      runProbe: async (signal: AbortSignal) => {
        signal.addEventListener('abort', () => pty.kill(), { once: true });
        await cleanup.promise;
        if (!signal.aborted) pty.write('late probe output');
        return { error: null };
      },
    }).then((value) => {
      resultSettled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(pty.kill).toHaveBeenCalledOnce();
    expect(resultSettled).toBe(false);

    cleanup.resolve();
    await expect(result).resolves.toEqual({ error: 'probe exceeded the 240s ceiling' });
    expect(pty.write).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
