/**
 * Tests for queued session status behavior in SessionManager.
 *
 * Verifies that:
 * - spawn() returns status='queued' when at concurrency limit
 * - queued sessions emit 'session-changed' with queued status on creation
 * - the session ID is preserved across queue promotion
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (command: string) => command,
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import type { Session } from '../../src/shared/types';
import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';

function createMockPty() {
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: (value: T) => resolvePromise(value),
    reject: (reason: unknown) => rejectPromise(reason),
  };
}

describe('SessionManager queued status', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    manager.setMaxConcurrent(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawn returns queued status when at concurrency limit', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    // Second spawn should be queued (max concurrent = 1)
    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    expect(queued.status).toBe('queued');
    expect(queued.pid).toBeNull();
    expect(manager.queuedCount).toBe(1);
  });

  it('spawn emits session-changed event with queued status', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const statusEvents: Array<{ sessionId: string; status: string }> = [];
    manager.on('session-changed', (sessionId: string, session: Session) => {
      statusEvents.push({ sessionId, status: session.status });
    });

    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const queuedEvent = statusEvents.find(
      (event) => event.sessionId === queued.id && event.status === 'queued',
    );
    expect(queuedEvent).toBeDefined();
  });

  it('queued session transitions to running on promotion and preserves session ID', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    const queuedId = queued.id;

    expect(queued.status).toBe('queued');

    // Collect status events for the queued session
    const statusEvents: string[] = [];
    manager.on('session-changed', (sessionId: string, session: Session) => {
      if (sessionId === queuedId) statusEvents.push(session.status);
    });

    // Kill first session to free a slot and trigger promotion
    firstMock.triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Queued session should now be running with the same ID
    const promoted = manager.getSession(queuedId);
    expect(promoted?.status).toBe('running');
    expect(promoted?.id).toBe(queuedId);
    expect(statusEvents).toContain('running');
    expect(manager.queuedCount).toBe(0);
  });

  it('transfers generic spawn cleanup through queue promotion before disposing it on exit', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    let cleanupCalls = 0;
    const queued = await manager.spawn({
      id: 'queued-kill-id',
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    firstMock.triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.getSession(queued.id)?.status).toBe('running');
    expect(cleanupCalls).toBe(0);

    secondMock.triggerExit(0);

    expect(cleanupCalls).toBe(1);
  });

  it('does not reinstall queued cleanup after kill during deferred promotion', async () => {
    const deferredShell = createDeferred<string>();
    const getShell = vi.spyOn(manager, 'getShell')
      .mockResolvedValueOnce('/bin/bash')
      .mockImplementationOnce(() => deferredShell.promise);
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    let cleanupCalls = 0;
    const queued = await manager.spawn({
      id: 'queued-kill-id',
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    firstMock.triggerExit(0);
    await Promise.resolve();
    expect(getShell).toHaveBeenCalledTimes(2);

    manager.kill(queued.id);
    expect(cleanupCalls).toBe(1);

    deferredShell.resolve('/bin/bash');
    await Promise.resolve();

    expect(manager.getSession(queued.id)?.status).toBe('exited');
    expect(pty.spawn).toHaveBeenCalledTimes(1);

    manager.kill(queued.id);
    expect(cleanupCalls).toBe(1);
  });

  it('keeps a same-ID running replacement when an older queued promotion resolves', async () => {
    // Given: Q begins promotion but pauses at shell resolution.
    const deferredShell = createDeferred<string>();
    const getShell = vi.spyOn(manager, 'getShell')
      .mockResolvedValueOnce('/bin/bash')
      .mockImplementationOnce(() => deferredShell.promise)
      .mockResolvedValueOnce('/bin/bash');
    const occupyingPty = createMockPty();
    const replacementPty = createMockPty();
    replacementPty.mockPty.pid = 23456;
    const stalePromotionPty = createMockPty();
    stalePromotionPty.mockPty.pid = 34567;
    vi.mocked(pty.spawn)
      .mockReturnValueOnce(occupyingPty.mockPty as unknown as pty.IPty)
      .mockReturnValueOnce(replacementPty.mockPty as unknown as pty.IPty)
      .mockReturnValue(stalePromotionPty.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    const queuedCleanup = { dispose: vi.fn() };
    const queued = await manager.spawn({
      id: 'queued-fixed-id',
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      spawnCleanup: queuedCleanup,
    });
    occupyingPty.triggerExit(0);
    await Promise.resolve();
    expect(getShell).toHaveBeenCalledTimes(2);

    const replacementCleanup = { dispose: vi.fn() };
    const replacement = await manager.spawn({
      id: queued.id,
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      spawnCleanup: replacementCleanup,
    });
    expect(replacement.pid).toBe(23456);
    expect(queuedCleanup.dispose).toHaveBeenCalledOnce();

    // When: the older promotion resumes after A already owns the same ID.
    deferredShell.resolve('/bin/bash');
    await deferredShell.promise;
    await Promise.resolve();

    // Then: no B is spawned, and A remains the registered, manageable owner.
    expect(pty.spawn).toHaveBeenCalledTimes(2);
    expect(manager.getSession(queued.id)?.pid).toBe(23456);
    expect(replacementCleanup.dispose).not.toHaveBeenCalled();

    manager.kill(queued.id);
    manager.kill(queued.id);

    expect(replacementPty.mockPty.kill).toHaveBeenCalledOnce();
    expect(stalePromotionPty.mockPty.kill).not.toHaveBeenCalled();
    expect(replacementCleanup.dispose).toHaveBeenCalledOnce();
  });

  it('finalizes the shifted placeholder when deferred promotion shell resolution rejects', async () => {
    // Given: the queue has shifted Q into promotion and is paused in getShell().
    const deferredShell = createDeferred<string>();
    const shellError = new Error('shell unavailable');
    const queueLog = createDeferred<void>();
    const queueError = vi.spyOn(console, 'error').mockImplementation(() => {
      queueLog.resolve(undefined);
    });
    const getShell = vi.spyOn(manager, 'getShell')
      .mockResolvedValueOnce('/bin/bash')
      .mockImplementationOnce(() => deferredShell.promise);
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const queuedAdapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(queuedAdapter, 'removeHooks');
    const cleanup = { dispose: vi.fn() };
    const queued = await manager.spawn({
      id: 'queued-shell-rejection-id',
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      agentParser: queuedAdapter,
      spawnCleanup: cleanup,
    });
    const exitEvents: unknown[][] = [];
    manager.on('exit', (...args: unknown[]) => {
      if (args[0] === queued.id) exitEvents.push(args);
    });

    firstMock.triggerExit(0);
    await Promise.resolve();
    expect(getShell).toHaveBeenCalledTimes(2);

    // When: shell resolution rejects after Q is no longer present in the queue.
    deferredShell.reject(shellError);
    await queueLog.promise;

    // Then: Q is finalized in place and the rejection still reaches the queue log.
    expect(manager.getSession(queued.id)).toMatchObject({ status: 'exited', exitCode: -1 });
    expect(cleanup.dispose).toHaveBeenCalledOnce();
    expect(removeHooks).toHaveBeenCalledOnce();
    expect(removeHooks).toHaveBeenCalledWith('/tmp/test', 'task-2', queued.id);
    expect(exitEvents).toEqual([[queued.id, -1]]);
    expect(pty.spawn).toHaveBeenCalledOnce();
    expect(manager.queuedCount).toBe(0);
    expect(queueError).toHaveBeenCalledWith(
      '[SessionQueue] Failed to spawn queued session for task task-2:',
      shellError,
    );

    // A later manual cleanup cannot release the owner or emit exit again.
    manager.kill(queued.id);
    manager.kill(queued.id);

    expect(cleanup.dispose).toHaveBeenCalledOnce();
    expect(removeHooks).toHaveBeenCalledOnce();
    expect(exitEvents).toEqual([[queued.id, -1]]);
  });

  it('kill() on a queued session emits exit event', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    // Second spawn is queued (concurrency limit = 1)
    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(queued.status).toBe('queued');

    // Listen for exit events
    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    // Kill the queued session - should emit exit event for DB cleanup
    manager.kill(queued.id);

    const exitEvent = exitEvents.find((event) => event.sessionId === queued.id);
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.exitCode).toBe(-1);
    expect(manager.queuedCount).toBe(0);
  });

  it('kill() on a queued session releases the adapter resources that were prepared before spawn', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const queuedAdapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(queuedAdapter, 'removeHooks');
    const queued = await manager.spawn({
      id: 'queued-kill-id',
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      agentParser: queuedAdapter,
    });

    manager.kill(queued.id);

    expect(removeHooks).toHaveBeenCalledWith('/tmp/test', 'task-2', queued.id);
  });

  it('disposes generic spawn cleanup exactly once when a queued session is killed', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    let cleanupCalls = 0;
    const queued = await manager.spawn({
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    manager.kill(queued.id);
    manager.kill(queued.id);

    expect(cleanupCalls).toBe(1);
  });

  it('disposes retained generic spawn cleanup when queued promotion fails', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn)
      .mockReturnValueOnce(firstMock.mockPty as unknown as pty.IPty)
      .mockImplementationOnce(() => {
        throw new Error('spawn ENOENT');
      });
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const queuedAdapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(queuedAdapter, 'removeHooks');
    let cleanupCalls = 0;
    const queued = await manager.spawn({
      id: 'queued-promotion-failure-id',
      taskId: 'task-2',
      projectId: 'project-1',
      command: '',
      cwd: '/tmp/test',
      agentParser: queuedAdapter,
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    firstMock.triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cleanupCalls).toBe(1);
    expect(removeHooks).toHaveBeenCalledWith('/tmp/test', 'task-2', queued.id);
  });

  it('removeByTaskId() on a queued session emits exit event', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });

    const secondMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(secondMock.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({ taskId: 'task-2', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(queued.status).toBe('queued');

    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    // removeByTaskId is the path used by handleTaskMove abort cleanup
    manager.removeByTaskId('task-2');

    const exitEvent = exitEvents.find((event) => event.sessionId === queued.id);
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.exitCode).toBe(-1);
    // Session should be fully removed from manager
    expect(manager.getSession(queued.id)).toBeUndefined();
  });

  it('kill() on a running session does NOT emit exit event synchronously', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    const running = await manager.spawn({ taskId: 'task-1', projectId: 'project-1', command: '', cwd: '/tmp/test' });
    expect(running.status).toBe('running');

    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    // Kill a running session - exit event comes async from PTY onExit, not synchronously
    manager.kill(running.id);

    // No synchronous exit event (PTY hasn't exited yet)
    const syncExitEvent = exitEvents.find((event) => event.sessionId === running.id);
    expect(syncExitEvent).toBeUndefined();
  });
});
