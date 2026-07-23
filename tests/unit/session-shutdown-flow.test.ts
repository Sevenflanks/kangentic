import { describe, it, expect, vi } from 'vitest';
import type * as pty from 'node-pty';
import { writeExitSequence, killAllSessions } from '../../src/main/pty/shutdown/session-shutdown';
import type { ShutdownSession, ShutdownContext } from '../../src/main/pty/shutdown/session-shutdown';

describe('writeExitSequence', () => {
  it('writes every command in order', () => {
    const writes: string[] = [];
    const ptyRef = { write: (d: string) => { writes.push(d); } } as unknown as pty.IPty;
    writeExitSequence(ptyRef, ['\x03', '/exit\r']);
    expect(writes).toEqual(['\x03', '/exit\r']);
  });

  it('swallows individual write errors and keeps trying subsequent commands', () => {
    let callCount = 0;
    const writes: string[] = [];
    const ptyRef = {
      write: (d: string) => {
        callCount++;
        if (callCount === 1) throw new Error('EIO: PTY dead');
        writes.push(d);
      },
    } as unknown as pty.IPty;
    expect(() => writeExitSequence(ptyRef, ['\x03', '/exit\r'])).not.toThrow();
    // First write threw; second write still attempted
    expect(writes).toEqual(['/exit\r']);
  });

  it('is a no-op for an empty exit sequence', () => {
    const ptyRef = { write: vi.fn() } as unknown as pty.IPty;
    writeExitSequence(ptyRef, []);
    expect((ptyRef.write as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// Note: suspendAllSessions is covered end-to-end via
// tests/unit/session-suspend.test.ts and session-manager.test.ts integration paths.

describe('killAllSessions', () => {
  function makeDisposable() {
    return { dispose: vi.fn() };
  }

  function makeSession(overrides: Partial<ShutdownSession> = {}): ShutdownSession {
    return {
      id: 'sess-1',
      taskId: 'task-1',
      cwd: '/project/cwd',
      pty: { write: vi.fn(), kill: vi.fn() } as unknown as pty.IPty,
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      exitSequence: [],
      ...overrides,
    };
  }

  function makeContext(sessions: ShutdownSession[]) {
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const detachAndDelete = vi.fn();
    const killPty = vi.fn(() => true);
    const sessionQueueClear = vi.fn();
    const firstOutputClear = vi.fn();
    const context = {
      sessions: sessionMap,
      sessionQueue: { clear: sessionQueueClear },
      sessionFiles: { detachAndDelete },
      firstOutputTracker: { clear: firstOutputClear },
      killPty,
    } as unknown as ShutdownContext;
    return { context, sessionMap, detachAndDelete, killPty, sessionQueueClear, firstOutputClear };
  }

  it('disposes each retained PTY listener so node-pty stops invoking callbacks after kill', () => {
    const dataDisposable = makeDisposable();
    const exitDisposable = makeDisposable();
    const session = makeSession({
      ptyDisposables: [dataDisposable, exitDisposable] as unknown as pty.IDisposable[],
    });
    const { context, killPty } = makeContext([session]);

    killAllSessions(context);

    expect(killPty).toHaveBeenCalledTimes(1);
    expect(dataDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(exitDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes generic spawn cleanup synchronously after clearing its owner field', () => {
    const session = makeSession();
    let cleanupCalls = 0;
    let ownerClearedBeforeDispose = false;
    const cleanup = {
      dispose: () => {
        cleanupCalls++;
        ownerClearedBeforeDispose = session.spawnCleanup === undefined;
      },
    };
    session.spawnCleanup = cleanup;
    const { context } = makeContext([session]);

    killAllSessions(context);

    expect(cleanupCalls).toBe(1);
    expect(ownerClearedBeforeDispose).toBe(true);
  });

  it('releases adapter hooks with the session identity before synchronous shutdown clears sessions', () => {
    const removeHooks = vi.fn();
    const session = Object.assign(makeSession(), {
      cwd: '/project/cwd',
      agentParser: { removeHooks },
    });
    const { context } = makeContext([session]);

    killAllSessions(context);

    expect(removeHooks).toHaveBeenCalledWith('/project/cwd', 'task-1', 'sess-1');
  });

  it('keeps synchronous shutdown non-throwing when generic spawn cleanup fails', () => {
    const session = makeSession({
      spawnCleanup: { dispose: () => { throw new Error('cleanup failed'); } },
    });
    const { context, detachAndDelete } = makeContext([session]);

    expect(() => killAllSessions(context)).not.toThrow();
    expect(detachAndDelete).toHaveBeenCalledWith('sess-1');
  });

  it('is a no-op for a session that never retained disposables', () => {
    const session = makeSession({ ptyDisposables: undefined });
    const { context, detachAndDelete } = makeContext([session]);

    expect(() => killAllSessions(context)).not.toThrow();
    expect(detachAndDelete).toHaveBeenCalledWith('sess-1');
  });

  it('keeps tearing down when one disposable throws (best-effort)', () => {
    const throwing = { dispose: vi.fn(() => { throw new Error('emitter already gone'); }) };
    const healthy = makeDisposable();
    const session = makeSession({
      ptyDisposables: [throwing, healthy] as unknown as pty.IDisposable[],
    });
    const { context, detachAndDelete } = makeContext([session]);

    expect(() => killAllSessions(context)).not.toThrow();
    expect(healthy.dispose).toHaveBeenCalledTimes(1);
    expect(detachAndDelete).toHaveBeenCalledWith('sess-1');
  });

  it('clears the session, queue, and first-output maps', () => {
    const session = makeSession();
    const { context, sessionMap, sessionQueueClear, firstOutputClear } = makeContext([session]);

    killAllSessions(context);

    expect(sessionMap.size).toBe(0);
    expect(sessionQueueClear).toHaveBeenCalledTimes(1);
    expect(firstOutputClear).toHaveBeenCalledTimes(1);
  });
});
