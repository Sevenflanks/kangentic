/**
 * Comprehensive SessionManager unit tests covering scrollback, spawn failure,
 * shell arguments, environment filtering, data buffering, write/resize guards,
 * remove, suspendAll, killAll, query methods, and synthetic session_end.
 *
 * Follows the same mock/setup patterns as session-suspend.test.ts and
 * event-activity-derivation.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock node-pty before importing SessionManager
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
  adaptCommandForShell: (cmd: string) => cmd,
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import { ClaudeSessionHistoryParser } from '../../src/main/agent/adapters/claude/session-history-parser';
import { isShuttingDown } from '../../src/main/shutdown-state';

const claudeAdapter = new ClaudeAdapter();
import { EventType } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

let tmpDir: string;

/** Create a mock PTY with controllable onData/onExit callbacks. */
function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    // node-pty's IPty exposes the live cols/rows; track them so resize() reads
    // back the current size.
    cols: 120,
    rows: 30,
    onData: vi.fn((cb: (data: string) => void) => {
      dataHandler = cb;
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
    }),
    write: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      mockPty.cols = cols;
      mockPty.rows = rows;
    }),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isShuttingDown).mockReturnValue(false);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-session-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Scrollback
// ---------------------------------------------------------------------------

describe('Scrollback', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-scroll',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;
    return { session, ...mock };
  }

  it('truncates scrollback at 512KB limit', async () => {
    const { session, feedData } = await spawnSession();

    // Feed 600KB in one call
    const chunk = 'x'.repeat(600 * 1024);
    feedData(chunk);

    const scrollback = await manager.getScrollback(session.id);
    // getScrollback() prepends \x1b[0m (4 bytes) and findSafeStartIndex
    // may trim up to 32 bytes at the truncation boundary
    expect(scrollback.startsWith('\x1b[0m')).toBe(true);
    expect(scrollback.length).toBeLessThanOrEqual(512 * 1024 + 4);
    expect(scrollback.length).toBeGreaterThan(512 * 1024 - 32);
  });

  it('preserves scrollback under the limit', async () => {
    const { session, feedData } = await spawnSession();

    const chunk = 'y'.repeat(100 * 1024);
    feedData(chunk);

    const scrollback = await manager.getScrollback(session.id);
    // No truncation, so only the 4-byte SGR reset prefix is added
    expect(scrollback.startsWith('\x1b[0m')).toBe(true);
    expect(scrollback.length).toBe(100 * 1024 + 4);
  });

  it('accumulates scrollback across multiple onData calls', async () => {
    const { session, feedData } = await spawnSession();

    // 3 x 200KB = 600KB total -> should truncate to ~512KB
    const chunk = 'z'.repeat(200 * 1024);
    feedData(chunk);
    feedData(chunk);
    feedData(chunk);

    const scrollback = await manager.getScrollback(session.id);
    expect(scrollback.startsWith('\x1b[0m')).toBe(true);
    expect(scrollback.length).toBeLessThanOrEqual(512 * 1024 + 4);
    expect(scrollback.length).toBeGreaterThan(512 * 1024 - 32);
  });
});

// ---------------------------------------------------------------------------
// 2. Scrollback clearing on resize (width change)
// ---------------------------------------------------------------------------

describe('Scrollback clearing on resize', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;
  // Note: the buffer manager's first resize after initSession is the "initial"
  // resize that establishes real terminal dimensions without clearing scrollback.
  // spawnSession() calls resize(120, 30) to simulate that initial resize, so
  // subsequent test resizes trigger the mid-session clearing behavior.

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-resize-scroll',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;
    // Simulate the initial resize that the renderer sends on first connect.
    // This establishes real terminal dimensions (120 cols matches PTY spawn).
    manager.resize(session.id, 120, 30);
    return { session, ...mock };
  }

  it('preserves scrollback when cols stay the same', async () => {
    const { session, feedData } = await spawnSession();

    feedData('hello world');

    // Resize with same cols as initial (120) but different rows
    const result = manager.resize(session.id, 120, 50);
    expect(result).toEqual({ colsChanged: false });

    const scrollback = await manager.getScrollback(session.id);
    expect(scrollback).toContain('hello world');
  });

  it('preserves scrollback when cols change (no write-time clearing)', async () => {
    const { session, feedData } = await spawnSession();

    feedData('hello world');

    // Resize to different cols
    const result = manager.resize(session.id, 80, 24);
    expect(result).toEqual({ colsChanged: true });

    const scrollback = await manager.getScrollback(session.id);
    // Scrollback is preserved on resize (KISS read-time strip approach)
    expect(scrollback).toContain('hello world');
  });

  it('tracks lastCols correctly across multiple resizes', async () => {
    const { session, feedData } = await spawnSession();

    // Resize to 80 cols
    manager.resize(session.id, 80, 24);

    // Feed new data at 80 cols
    feedData('data at 80 cols');

    // Resize to same 80 cols (should preserve)
    manager.resize(session.id, 80, 30);
    expect(await manager.getScrollback(session.id)).toContain('data at 80 cols');

    // Resize to different cols - scrollback preserved (no write-time clearing)
    manager.resize(session.id, 100, 30);
    expect(await manager.getScrollback(session.id)).toContain('data at 80 cols');
  });

  it('clamps cols to minimum of 2', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, 0, 24);

    // Should have been clamped to 2
    expect(mockPty.resize).toHaveBeenCalledWith(2, 24);
  });

  it('clamps rows to minimum of 1', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, 80, 0);

    expect(mockPty.resize).toHaveBeenCalledWith(80, 1);
  });

  it('clamps negative values', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, -10, -5);

    expect(mockPty.resize).toHaveBeenCalledWith(2, 1);
  });

  it('floors fractional values', async () => {
    const { session, mockPty } = await spawnSession();

    manager.resize(session.id, 80.7, 24.9);

    expect(mockPty.resize).toHaveBeenCalledWith(80, 24);
  });

  it('accumulates scrollback across col changes', async () => {
    const { session, feedData } = await spawnSession();

    feedData('old data');

    // Change cols - scrollback preserved
    manager.resize(session.id, 80, 24);
    expect(await manager.getScrollback(session.id)).toContain('old data');

    // New data arrives at new width
    feedData('new data');
    expect(await manager.getScrollback(session.id)).toContain('new data');
    expect(await manager.getScrollback(session.id)).toContain('old data');
  });
});

// ---------------------------------------------------------------------------
// 2b. Pre-spawn resize queue (stale-width race on auto-resume)
// ---------------------------------------------------------------------------

describe('Pre-spawn resize queue', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('spawns a resumed session at dimensions from a resize that arrived while suspended', async () => {
    const mock1 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock1.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-pending-resize', command: '', cwd: tmpDir });

    // Suspend: the PTY is torn down (pty=null) but the record persists for resume.
    await manager.suspend(session.id);

    // A renderer resize arrives while suspended, before the resume spawn. It is
    // stashed rather than dropped (the secondary stale-width hole: xterm never
    // re-sends unchanged dims, so a dropped resize would strand the PTY at the
    // default width forever).
    expect(manager.resize(session.id, 190, 40)).toEqual({ colsChanged: false });

    // Resume: performSpawn consumes the stash and spawns the PTY at 190x40
    // instead of the 120x30 default, so the mount-time resize is a no-op and no
    // corrective repaint window opens.
    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    await manager.spawn({ id: session.id, taskId: 'task-pending-resize', command: '', cwd: tmpDir, resuming: true });

    expect(pty.spawn).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cols: 190, rows: 40 }),
    );

    manager.kill(session.id);
  });

  it('drops a queued resize when the session is killed before respawn', async () => {
    const mock1 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock1.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-killed-resize', command: '', cwd: tmpDir });

    await manager.suspend(session.id);
    manager.resize(session.id, 190, 40); // stashed while suspended
    manager.kill(session.id); // deliberate teardown clears the stash

    // A fresh spawn for the same task must NOT inherit the killed session's
    // stashed dims: it spawns at the default.
    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    const fresh = await manager.spawn({ taskId: 'task-killed-resize', command: '', cwd: tmpDir });

    expect(pty.spawn).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cols: 120, rows: 30 }),
    );

    manager.kill(fresh.id);
  });
});

// ---------------------------------------------------------------------------
// 3. Remove
// ---------------------------------------------------------------------------

describe('Remove', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  async function spawnSession(taskId = 'task-remove') {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
    });
    return { session, ...mock };
  }

  it('fully removes session from all internal maps', async () => {
    const { session, feedData } = await spawnSession();

    // Populate scrollback
    feedData('hello');

    manager.remove(session.id);

    expect(manager.getSession(session.id)).toBeUndefined();
    expect(await manager.getScrollback(session.id)).toBe('');
    expect(manager.getEventsForSession(session.id)).toEqual([]);
    expect(manager.getUsageCache()[session.id]).toBeUndefined();
    expect(manager.getActivityCache()[session.id]).toBeUndefined();
  });

  it('remove on non-existent session does not throw', () => {
    expect(() => manager.remove('nonexistent-id')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. SuspendAll
// ---------------------------------------------------------------------------

describe('SuspendAll', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  async function spawnSession(taskId: string) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
    });
    return { session, ...mock };
  }

  it('sends exit sequence to all running sessions', async () => {
    const { mockPty: pty1 } = await spawnSession('task-sa-1');
    const { mockPty: pty2 } = await spawnSession('task-sa-2');

    await manager.suspendAll(0);

    // Default exit sequence is ['\x03'] (Ctrl+C only) when no exitSequence is provided
    expect(pty1.write).toHaveBeenCalledWith('\x03');
    expect(pty2.write).toHaveBeenCalledWith('\x03');
  });

  it('returns task IDs of all sessions', async () => {
    await spawnSession('task-sa-a');
    await spawnSession('task-sa-b');

    const taskIds = await manager.suspendAll(0);

    expect(taskIds).toContain('task-sa-a');
    expect(taskIds).toContain('task-sa-b');
  });

  it('marks running sessions as exited', async () => {
    const { session } = await spawnSession('task-sa-exit');

    await manager.suspendAll(0);

    const result = manager.getSession(session.id);
    expect(result?.status).toBe('exited');
  });

  it('includes queued sessions in returned task IDs', async () => {
    manager.setMaxConcurrent(1);

    await spawnSession('task-sa-running');

    // Second session should be queued
    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    const queued = await manager.spawn({
      taskId: 'task-sa-queued',
      command: '',
      cwd: tmpDir,
    });
    expect(queued.status).toBe('queued');

    const taskIds = await manager.suspendAll(0);

    expect(taskIds).toContain('task-sa-running');
    expect(taskIds).toContain('task-sa-queued');
  });

  it('clears session queue', async () => {
    manager.setMaxConcurrent(1);
    await spawnSession('task-sa-q1');

    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-sa-q2', command: '', cwd: tmpDir });

    expect(manager.queuedCount).toBe(1);

    await manager.suspendAll(0);

    expect(manager.queuedCount).toBe(0);
  });

  it('disposes generic spawn cleanup for running and queued sessions', async () => {
    manager.setMaxConcurrent(1);
    let runningCleanupCalls = 0;
    let queuedCleanupCalls = 0;
    const runningCleanup = { dispose: () => { runningCleanupCalls++; } };
    const queuedCleanup = { dispose: () => { queuedCleanupCalls++; } };

    const runningMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(runningMock.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-sa-cleanup-running',
      command: '',
      cwd: tmpDir,
      spawnCleanup: runningCleanup,
    });
    await manager.spawn({
      taskId: 'task-sa-cleanup-queued',
      command: '',
      cwd: tmpDir,
      spawnCleanup: queuedCleanup,
    });

    await manager.suspendAll(0);

    expect(runningCleanupCalls).toBe(1);
    expect(queuedCleanupCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. KillAll
// ---------------------------------------------------------------------------

describe('KillAll', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  async function spawnSession(taskId: string) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
    });
    return { session, ...mock };
  }

  it('removes all sessions from the manager', async () => {
    const { session: session1 } = await spawnSession('task-ka-1');
    const { session: session2 } = await spawnSession('task-ka-2');

    manager.killAll();

    expect(manager.getSession(session1.id)).toBeUndefined();
    expect(manager.getSession(session2.id)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('kills all PTY processes', async () => {
    const { mockPty: pty1 } = await spawnSession('task-ka-k1');
    const { mockPty: pty2 } = await spawnSession('task-ka-k2');

    manager.killAll();

    expect(pty1.kill).toHaveBeenCalled();
    expect(pty2.kill).toHaveBeenCalled();
  });

  it('clears session queue', async () => {
    manager.setMaxConcurrent(1);
    await spawnSession('task-ka-q1');

    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    await manager.spawn({ taskId: 'task-ka-q2', command: '', cwd: tmpDir });

    expect(manager.queuedCount).toBe(1);

    manager.killAll();

    expect(manager.queuedCount).toBe(0);
  });

  it('synchronously disposes generic spawn cleanup for running and queued sessions', async () => {
    manager.setMaxConcurrent(1);
    let runningCleanupCalls = 0;
    let queuedCleanupCalls = 0;
    const runningCleanup = { dispose: () => { runningCleanupCalls++; } };
    const queuedCleanup = { dispose: () => { queuedCleanupCalls++; } };

    const runningMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(runningMock.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-ka-cleanup-running',
      command: '',
      cwd: tmpDir,
      spawnCleanup: runningCleanup,
    });
    await manager.spawn({
      taskId: 'task-ka-cleanup-queued',
      command: '',
      cwd: tmpDir,
      spawnCleanup: queuedCleanup,
    });

    manager.killAll();

    expect(runningCleanupCalls).toBe(1);
    expect(queuedCleanupCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5b. kill() tags exits intentional (self-maintaining false-crash suppression)
// ---------------------------------------------------------------------------

describe('kill() marks deliberate teardown intentional', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-kill', command: '', cwd: tmpDir });
    return { session, ...mock };
  }

  // Every kill() is a deliberate teardown, never a crash. The force-kill exits
  // non-zero, so without the intentional tag the renderer fires a false
  // "Session crashed" notification. kill() must mark the session so onExit tags
  // the 'exit' event intentional - and it must do so unconditionally, so no
  // current or future caller (SESSION_RESET, executeCleanupWorktree, MCP
  // onTaskDeleted, ...) can forget and reintroduce the false crash.
  it('emits the exit event with intentional=true after kill()', async () => {
    const { session } = await spawnSession();
    const exitEvents: unknown[][] = [];
    manager.on('exit', (...args: unknown[]) => exitEvents.push(args));

    manager.kill(session.id);
    // The mock PTY's kill() schedules its onExit callback on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const exitCall = exitEvents.find((call) => call[0] === session.id);
    expect(exitCall).toBeDefined();
    // Positional args: (sessionId, exitCode, intentional).
    expect(exitCall![2]).toBe(true);
  });

  it('disposes generic spawn cleanup once before the PTY exit callback', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    let cleanupCalls = 0;
    const session = await manager.spawn({
      taskId: 'task-kill-generic-cleanup',
      command: '',
      cwd: tmpDir,
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    manager.kill(session.id);
    expect(cleanupCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cleanupCalls).toBe(1);
  });

  it('disposes generic spawn cleanup once when suspending a session', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    let cleanupCalls = 0;
    const session = await manager.spawn({
      taskId: 'task-suspend-generic-cleanup',
      command: '',
      cwd: tmpDir,
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    const suspendPromise = manager.suspend(session.id);
    expect(cleanupCalls).toBe(1);

    await suspendPromise;

    expect(cleanupCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Pre-registration spawn cleanup
// ---------------------------------------------------------------------------

describe('Pre-registration spawn cleanup', () => {
  it('releases invocation-owned cleanup and exact hooks during shutdown before creating a session', async () => {
    // Given
    const manager = new SessionManager();
    const adapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(adapter, 'removeHooks').mockImplementation(() => {});
    let cleanupCalls = 0;
    const input = {
      id: 'shutdown-owner-id',
      taskId: 'task-shutdown-owner',
      projectId: 'project-shutdown-owner',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    };
    vi.mocked(isShuttingDown).mockReturnValue(true);

    // When
    await expect(manager.spawn(input)).rejects.toThrow('Cannot spawn session during shutdown');

    // Then
    expect(cleanupCalls).toBe(1);
    expect(removeHooks).toHaveBeenCalledOnce();
    expect(removeHooks).toHaveBeenCalledWith(tmpDir, input.taskId, input.id);
    expect(manager.getSession(input.id)).toBeUndefined();
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it('releases invocation-owned hooks before registration for explicit input shapes', async () => {
    // Given
    const adapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(adapter, 'removeHooks').mockImplementation(() => {});
    const inputShapes = [
      { id: 'startup-owner-id', taskId: 'task-startup-owner' },
      { id: 'recovery-owner-id', taskId: 'task-recovery-owner', resuming: true, agentSessionId: 'agent-recovery-id' },
      { id: 'transient-owner-id', taskId: 'task-transient-owner', transient: true },
    ];

    for (const [index, shape] of inputShapes.entries()) {
      const manager = new SessionManager();
      const shellError = new Error(`shell lookup failed ${index}`);
      const cleanup = { dispose: vi.fn() };
      vi.spyOn(manager, 'getShell').mockRejectedValue(shellError);
      const input = {
        ...shape,
        projectId: 'project-pre-registration-owner',
        command: '',
        cwd: tmpDir,
        agentParser: adapter,
        spawnCleanup: cleanup,
      };

      // When
      await expect(manager.spawn(input)).rejects.toBe(shellError);

      // Then
      expect(cleanup.dispose).toHaveBeenCalledOnce();
      expect(manager.getSession(input.id)).toBeUndefined();
    }

    expect(removeHooks).toHaveBeenCalledTimes(inputShapes.length);
    for (const [index, shape] of inputShapes.entries()) {
      expect(removeHooks).toHaveBeenNthCalledWith(index + 1, tmpDir, shape.taskId, shape.id);
    }
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it('preserves the original getShell error when exact hook cleanup throws', async () => {
    // Given
    const manager = new SessionManager();
    const adapter = new OpenCodeAdapter();
    const shellError = new Error('shell lookup failed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(adapter, 'removeHooks').mockImplementation(() => {
      throw new Error('hook cleanup failed with private details');
    });
    vi.spyOn(manager, 'getShell').mockRejectedValue(shellError);
    const input = {
      id: 'throwing-hook-owner-id',
      taskId: 'task-throwing-hook-owner',
      projectId: 'project-throwing-hook-owner',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
      spawnCleanup: { dispose: vi.fn() },
    };

    // When
    await expect(manager.spawn(input)).rejects.toBe(shellError);

    // Then
    expect(warning).toHaveBeenCalledWith('[SessionManager] adapter hook cleanup failed');
    warning.mockRestore();
  });

  it('leaves the registered lifecycle as the hook owner when a replacement rejects before spawning', async () => {
    // Given
    const manager = new SessionManager();
    const adapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(adapter, 'removeHooks').mockImplementation(() => {});
    const firstPty = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstPty.mockPty as unknown as pty.IPty);
    const registeredSession = await manager.spawn({
      id: 'registered-owner-id',
      taskId: 'task-registered-owner',
      projectId: 'project-registered-owner',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
    });
    removeHooks.mockClear();
    const shellError = new Error('replacement shell lookup failed');
    vi.spyOn(manager, 'getShell').mockRejectedValue(shellError);

    // When
    await expect(manager.spawn({
      id: registeredSession.id,
      taskId: registeredSession.taskId,
      projectId: registeredSession.projectId,
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
      spawnCleanup: { dispose: vi.fn() },
    })).rejects.toBe(shellError);

    // Then
    expect(removeHooks).not.toHaveBeenCalled();
    expect(manager.getSession(registeredSession.id)).toMatchObject({ id: registeredSession.id, status: 'running' });
    expect(pty.spawn).toHaveBeenCalledOnce();
  });

  it('disposes successor cleanup without releasing predecessor hooks when same-ID replacement teardown throws', async () => {
    const manager = new SessionManager();
    const predecessorDisposeError = new Error('predecessor attachment disposal failed');
    const predecessorDispose = vi.fn(() => { throw predecessorDisposeError; });
    const adapter = Object.assign(new OpenCodeAdapter(), {
      attachSession: () => ({ dispose: predecessorDispose }),
    });
    const removeHooks = vi.spyOn(adapter, 'removeHooks').mockImplementation(() => {});
    const firstPty = createMockPty();
    firstPty.mockPty.kill.mockImplementation(() => {});
    vi.mocked(pty.spawn).mockReturnValue(firstPty.mockPty as unknown as pty.IPty);
    const sessionId = 'same-id-throwing-predecessor';
    const taskId = 'task-same-id-throwing-predecessor';
    await manager.spawn({
      id: sessionId,
      taskId,
      projectId: 'project-same-id-throwing-predecessor',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
    });
    const registeredOwner = manager['registry'].get(sessionId);
    removeHooks.mockClear();
    const successorCleanup = { dispose: vi.fn() };

    await expect(manager.spawn({
      id: sessionId,
      taskId,
      projectId: 'project-same-id-throwing-predecessor',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
      spawnCleanup: successorCleanup,
    })).rejects.toBe(predecessorDisposeError);

    expect(successorCleanup.dispose).toHaveBeenCalledOnce();
    expect(manager['registry'].get(sessionId)).toBe(registeredOwner);
    expect(removeHooks).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. PTY Spawn Failure
// ---------------------------------------------------------------------------

describe('PTY spawn failure', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('returns dead session with exitCode -1 when PTY spawn throws', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const session = await manager.spawn({
      taskId: 'task-fail',
      command: '',
      cwd: tmpDir,
    });

    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(-1);
  });

  it('releases adapter resources when PTY spawn throws before onExit is attached', async () => {
    const adapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(adapter, 'removeHooks');
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    await manager.spawn({
      id: 'failed-pty-spawn-id',
      taskId: 'task-fail-cleanup',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
    });

    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'task-fail-cleanup', 'failed-pty-spawn-id');
  });

  it('releases adapter resources with the session identity on normal PTY exit', async () => {
    const adapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(adapter, 'removeHooks');
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    await manager.spawn({
      id: 'normal-pty-exit-id',
      taskId: 'task-normal-cleanup',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
    });

    mock.triggerExit(0);

    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'task-normal-cleanup', 'normal-pty-exit-id');
  });

  it('disposes generic spawn cleanup exactly once when PTY spawn throws', async () => {
    let cleanupCalls = 0;
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    await manager.spawn({
      taskId: 'task-fail-generic-cleanup',
      command: '',
      cwd: tmpDir,
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    expect(cleanupCalls).toBe(1);
  });

  it('emits exit event with code -1 on spawn failure', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const exitEvents: Array<{ sessionId: string; exitCode: number }> = [];
    manager.on('exit', (sessionId: string, exitCode: number) => {
      exitEvents.push({ sessionId, exitCode });
    });

    await manager.spawn({
      taskId: 'task-fail-event',
      command: '',
      cwd: tmpDir,
    });

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].exitCode).toBe(-1);
  });

  it('failed session is accessible via getSession', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const session = await manager.spawn({
      taskId: 'task-fail-get',
      command: '',
      cwd: tmpDir,
    });

    const retrieved = manager.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.status).toBe('exited');
    expect(retrieved?.exitCode).toBe(-1);
  });

  it('analytics includes diagnostic properties on spawn failure', async () => {
    const { trackEvent } = await import('../../src/main/analytics/analytics');
    const errnoError = new Error('posix_spawnp failed.') as NodeJS.ErrnoException;
    errnoError.code = 'ENOENT';

    vi.mocked(pty.spawn).mockImplementation(() => {
      throw errnoError;
    });

    await manager.spawn({
      taskId: 'task-fail-diag',
      command: '',
      cwd: tmpDir,
    });

    expect(trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'pty_spawn',
      shell: expect.any(String),
      cwdExists: expect.any(String),
      shellExists: expect.any(String),
      platform: process.platform,
      arch: process.arch,
    }));
  });

  it('falls back to home directory when CWD does not exist', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const nonExistentCwd = path.join(tmpDir, 'deleted-project');

    await manager.spawn({
      taskId: 'task-fail-cwd',
      command: '',
      cwd: nonExistentCwd,
    });

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    expect(spawnCall[2]?.cwd).toBe(os.homedir());

    // Clean up
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('CWD fallback tracks separate analytics event', async () => {
    const { trackEvent } = await import('../../src/main/analytics/analytics');
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const nonExistentCwd = path.join(tmpDir, 'missing-dir');

    await manager.spawn({
      taskId: 'task-fail-cwd-track',
      command: '',
      cwd: nonExistentCwd,
    });

    expect(trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'pty_spawn_cwd_missing',
      message: 'CWD does not exist, falling back to home directory',
      platform: process.platform,
    }));

    // Clean up
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('writes diagnostic scrollback on posix_spawnp failure', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('posix_spawnp failed.');
    });

    const session = await manager.spawn({
      taskId: 'task-fail-posix',
      command: '',
      cwd: tmpDir,
    });

    const scrollback = await manager.getScrollback(session.id);
    expect(scrollback).toContain('posix_spawnp');
    expect(scrollback).toContain('spawn-helper');

    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('does not write diagnostic scrollback for non-posix_spawnp errors', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const session = await manager.spawn({
      taskId: 'task-fail-nodiag',
      command: '',
      cwd: tmpDir,
    });

    const scrollback = await manager.getScrollback(session.id);
    expect(scrollback).not.toContain('posix_spawnp');
    expect(scrollback).not.toContain('spawn-helper');

    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('analytics includes errno code when available', async () => {
    const { trackEvent } = await import('../../src/main/analytics/analytics');
    const errnoError = new Error('spawn EACCES') as NodeJS.ErrnoException;
    errnoError.code = 'EACCES';
    errnoError.errno = -13;

    vi.mocked(pty.spawn).mockImplementation(() => {
      throw errnoError;
    });

    await manager.spawn({
      taskId: 'task-fail-errno',
      command: '',
      cwd: tmpDir,
    });

    expect(trackEvent).toHaveBeenCalledWith('app_error', expect.objectContaining({
      source: 'pty_spawn',
      errno: 'EACCES',
    }));
  });

  it('session record reflects fallback CWD when directory does not exist', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const nonExistentCwd = path.join(tmpDir, 'gone-project');

    const session = await manager.spawn({
      taskId: 'task-fail-cwd-record',
      command: '',
      cwd: nonExistentCwd,
    });

    expect(session.cwd).toBe(os.homedir());

    const retrieved = manager.getSession(session.id);
    expect(retrieved?.cwd).toBe(os.homedir());

    // Clean up
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

// ---------------------------------------------------------------------------
// 8. Shell Arguments
// ---------------------------------------------------------------------------

describe('Shell arguments', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    // Clean up any spawned sessions
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnWithShell(shell: string) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    manager.setShell(shell);
    await manager.spawn({
      taskId: `task-shell-${shell.replace(/\s+/g, '-')}`,
      command: '',
      cwd: tmpDir,
    });
    return vi.mocked(pty.spawn).mock.calls[vi.mocked(pty.spawn).mock.calls.length - 1];
  }

  it('WSL "wsl -d Ubuntu" → exe="wsl", args=["-d", "Ubuntu"]', async () => {
    const call = await spawnWithShell('wsl -d Ubuntu');
    expect(call[0]).toBe('wsl');
    expect(call[1]).toEqual(['-d', 'Ubuntu']);
  });

  it('cmd → args=[]', async () => {
    const call = await spawnWithShell('cmd');
    expect(call[0]).toBe('cmd');
    expect(call[1]).toEqual([]);
  });

  it('PowerShell → args=["-NoLogo"]', async () => {
    const call = await spawnWithShell('powershell');
    expect(call[0]).toBe('powershell');
    expect(call[1]).toEqual(['-NoLogo']);
  });

  it('pwsh → args=["-NoLogo"]', async () => {
    const call = await spawnWithShell('pwsh');
    expect(call[0]).toBe('pwsh');
    expect(call[1]).toEqual(['-NoLogo']);
  });

  it('fish → args=[]', async () => {
    const call = await spawnWithShell('fish');
    expect(call[0]).toBe('fish');
    expect(call[1]).toEqual([]);
  });

  it('nushell (nu) → args=[]', async () => {
    const call = await spawnWithShell('nu');
    expect(call[0]).toBe('nu');
    expect(call[1]).toEqual([]);
  });

  it('bash → args=["--login"]', async () => {
    const call = await spawnWithShell('/bin/bash');
    expect(call[0]).toBe('/bin/bash');
    expect(call[1]).toEqual(['--login']);
  });

  it('zsh → args=["--login"]', async () => {
    const call = await spawnWithShell('/bin/zsh');
    expect(call[0]).toBe('/bin/zsh');
    expect(call[1]).toEqual(['--login']);
  });
});

// ---------------------------------------------------------------------------
// 9. Environment Filtering
// ---------------------------------------------------------------------------

describe('Environment filtering', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete process.env.CLAUDECODE;
  });

  async function spawnWithEnv(inputEnv?: Record<string, string>) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-env',
      command: '',
      cwd: tmpDir,
      env: inputEnv,
    });
    const lastCall = vi.mocked(pty.spawn).mock.calls[vi.mocked(pty.spawn).mock.calls.length - 1];
    return lastCall[2]?.env as Record<string, string>;
  }

  it('strips CLAUDECODE from spawned PTY environment', async () => {
    process.env.CLAUDECODE = '1';

    const spawnedEnv = await spawnWithEnv();

    expect(spawnedEnv).not.toHaveProperty('CLAUDECODE');
  });

  it('merges input.env into spawned PTY environment', async () => {
    const spawnedEnv = await spawnWithEnv({ CUSTOM_VAR: 'hello' });

    expect(spawnedEnv.CUSTOM_VAR).toBe('hello');
  });

  it('input.env overrides process.env', async () => {
    process.env.MY_VAR = 'original';

    const spawnedEnv = await spawnWithEnv({ MY_VAR: 'overridden' });

    expect(spawnedEnv.MY_VAR).toBe('overridden');

    delete process.env.MY_VAR;
  });
});

// ---------------------------------------------------------------------------
// 10. Data Buffering
// ---------------------------------------------------------------------------

describe('Data buffering', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnSession() {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-buffer',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;
    return { session, ...mock };
  }

  it('batches multiple onData calls into single data emission', async () => {
    const { session, feedData } = await spawnSession();
    // The gate is default-closed: 'data' only fires for focused sessions.
    manager.setFocusedSessions([session.id]);

    const emissions: string[] = [];
    manager.on('data', (sessionId: string, data: string) => {
      if (sessionId === session.id) emissions.push(data);
    });

    // Three rapid onData calls within the 16ms flush window
    feedData('aaa');
    feedData('bbb');
    feedData('ccc');

    // Wait for the 16ms setTimeout to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toBe('aaabbbccc');
  });

  it('flush is skipped when session is removed during 16ms window', async () => {
    const { session, feedData } = await spawnSession();
    // Focus the session so a surviving flush WOULD emit - otherwise this
    // test passes vacuously under the default-closed gate.
    manager.setFocusedSessions([session.id]);

    const emissions: string[] = [];
    manager.on('data', (sessionId: string, data: string) => {
      if (sessionId === session.id) emissions.push(data);
    });

    feedData('data-before-remove');
    // Remove session before the 16ms flush fires
    manager.remove(session.id);
    spawnedSessionId = null; // already removed

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emissions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Write and Resize (null guards)
// ---------------------------------------------------------------------------

describe('Write and resize', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('write to non-existent session does not throw', () => {
    expect(() => manager.write('nonexistent', 'hello')).not.toThrow();
  });

  it('resize on non-existent session returns colsChanged false', () => {
    const result = manager.resize('nonexistent', 80, 24);
    expect(result).toEqual({ colsChanged: false });
  });

  it('write no-ops after session is killed', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-write-killed',
      command: '',
      cwd: tmpDir,
    });

    manager.kill(session.id);
    mock.mockPty.write.mockClear();

    manager.write(session.id, 'should-not-arrive');

    expect(mock.mockPty.write).not.toHaveBeenCalled();
  });

  it('resize no-ops after session is killed', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-resize-killed',
      command: '',
      cwd: tmpDir,
    });

    manager.kill(session.id);
    mock.mockPty.resize.mockClear();

    manager.resize(session.id, 80, 24);

    expect(mock.mockPty.resize).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10b. Dimension tracking (mobile fit-to-phone support)
// ---------------------------------------------------------------------------

describe('Dimension tracking', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('getDimensions reads the live PTY grid and returns null for an unknown session', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-dims', command: '', cwd: tmpDir });

    expect(manager.getDimensions(session.id)).toEqual({ cols: 120, rows: 30 });
    manager.resize(session.id, 80, 24);
    expect(manager.getDimensions(session.id)).toEqual({ cols: 80, rows: 24 });

    expect(manager.getDimensions('nonexistent')).toBeNull();
  });

  it('every resize emits pty-resize with the clamped grid', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-dims-emit', command: '', cwd: tmpDir });

    const resizes: Array<[string, number, number]> = [];
    manager.on('pty-resize', (sessionId: string, cols: number, rows: number) => resizes.push([sessionId, cols, rows]));

    manager.resize(session.id, 80.7, 0);
    expect(resizes).toEqual([[session.id, 80, 1]]);
  });

  it('a mobile resize snapshots the desktop grid as the restore target; desktop resizes update it', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-dims-origin', command: '', cwd: tmpDir });

    // Nothing recorded before any resize.
    expect(manager.getLastDesktopDimensions(session.id)).toBeNull();

    // First mobile resize of a never-desktop-resized session: the pre-resize
    // grid (the spawn default) becomes the restore target.
    manager.resize(session.id, 48, 26, 'mobile');
    expect(manager.getLastDesktopDimensions(session.id)).toEqual({ cols: 120, rows: 30 });
    expect(manager.getDimensions(session.id)).toEqual({ cols: 48, rows: 26 });

    // A repeat mobile resize does NOT move the restore target.
    manager.resize(session.id, 44, 24, 'mobile');
    expect(manager.getLastDesktopDimensions(session.id)).toEqual({ cols: 120, rows: 30 });

    // A desktop resize (default origin) wins and updates the restore target.
    manager.resize(session.id, 190, 50);
    expect(manager.getLastDesktopDimensions(session.id)).toEqual({ cols: 190, rows: 50 });
  });

  it('kill clears the desktop-dims restore target with the pending resizes', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({ taskId: 'task-dims-kill', command: '', cwd: tmpDir });

    manager.resize(session.id, 190, 50);
    expect(manager.getLastDesktopDimensions(session.id)).toEqual({ cols: 190, rows: 50 });

    manager.kill(session.id);
    expect(manager.getLastDesktopDimensions(session.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11b. Transcript-fallback handoff (background status.json fix)
// ---------------------------------------------------------------------------

describe('Transcript-fallback handoff', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.restoreAllMocks();
  });

  // A background (never-opened) Claude session never paints its statusline, so
  // status.json is never written and the card would stay on the spawn-time
  // model placeholder at 0%. The transcript-watch fallback (runtime.sessionHistory)
  // tails Claude's native session JSONL to derive the live model + context %.
  // Once status.json DOES flow (card opened / TUI painted), the fallback must
  // detach so status.json's full-replace cleanly wins and the two never race.
  // Regression guard for the board-card-stuck bug.
  it('attaches the transcript fallback at spawn and detaches it once status.json flows', async () => {
    // Mock locate to resolve to a temp transcript file immediately (the real
    // one would poll ~/.claude for up to 60s). Construct a fresh adapter AFTER
    // the spy so its runtime.sessionHistory.locate captures the mock.
    const historyFile = path.join(tmpDir, 'handoff-transcript.jsonl');
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 5000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
          },
        },
      }) + '\n',
    );
    vi.spyOn(ClaudeSessionHistoryParser, 'locate').mockResolvedValue(historyFile);
    const adapter = new ClaudeAdapter();

    const statusPath = path.join(tmpDir, 'handoff-status.json');
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-handoff',
      command: '',
      cwd: tmpDir,
      agentSessionId: 'handoff-session-uuid',
      statusOutputPath: statusPath,
      agentParser: adapter,
    });

    const priv = manager as unknown as {
      sessionHistoryReader: { isAttached(id: string): boolean };
      statusFileReader: { handleStatusChange(id: string): void };
    };

    // Let the fire-and-forget eager attach (awaits the mocked locate) settle.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(priv.sessionHistoryReader.isAttached(session.id)).toBe(true);
    // The fallback populated the card model + token occupancy from the
    // transcript, but NO window (it is not derivable from a model id): window
    // stays the 0 "unknown size" sentinel and the percentage stays 0, so the
    // card shows the model name only until status.json flows.
    const fallbackUsage = manager.getUsageCache()[session.id];
    expect(fallbackUsage?.model.displayName).toBe('Opus 4.8');
    expect(fallbackUsage?.contextWindow.usedTokens).toBe(5000);
    expect(fallbackUsage?.contextWindow.contextWindowSize).toBe(0);
    expect(fallbackUsage?.contextWindow.usedPercentage).toBe(0);

    // status.json now flows (Claude painted / card opened). Trigger the read;
    // onFirstStatus must detach the fallback reader.
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        context_window: {
          used_percentage: 12,
          total_input_tokens: 24000,
          total_output_tokens: 500,
          context_window_size: 200000,
          current_usage: { input_tokens: 24000 },
        },
        cost: { total_cost_usd: 0.02, total_duration_ms: 5000 },
        model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      }),
    );
    priv.statusFileReader.handleStatusChange(session.id);

    expect(priv.sessionHistoryReader.isAttached(session.id)).toBe(false);
  });

  // On a RESUME the transcript already holds the PRE-suspend conversation, whose
  // last entry is stale occupancy (Claude prunes/recomputes context on resume).
  // The eager attach passes startAtEnd, so the fallback starts at EOF and must
  // NOT surface that stale entry - the exact #286 failure (a 650k pre-suspend
  // snapshot rendered as an impossible percentage). Regression guard.
  it('does not surface stale pre-suspend occupancy on a resume (fallback starts at EOF)', async () => {
    const historyFile = path.join(tmpDir, 'resume-stale-transcript.jsonl');
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'stale',
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 446,
            cache_read_input_tokens: 649_950,
            output_tokens: 318,
          },
        },
      }) + '\n',
    );
    vi.spyOn(ClaudeSessionHistoryParser, 'locate').mockResolvedValue(historyFile);
    const adapter = new ClaudeAdapter();

    const statusPath = path.join(tmpDir, 'resume-stale-status.json');
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-resume-stale',
      command: '',
      cwd: tmpDir,
      agentSessionId: 'resume-stale-uuid',
      statusOutputPath: statusPath,
      agentParser: adapter,
      resuming: true,
    });

    // Let the fire-and-forget eager attach (awaits the mocked locate) settle.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The stale 650,398-token pre-suspend entry is behind the EOF cursor, so it
    // never reaches the usage cache. No stale tokens, and certainly no >100%.
    const usage = manager.getUsageCache()[session.id];
    expect(usage?.contextWindow.usedTokens ?? 0).not.toBe(650_398);
    expect(usage?.contextWindow.usedTokens ?? 0).toBe(0);
  });

  // The sibling test above never sets `session_id` in status.json, so
  // usage.sessionId is undefined and processStatusUpdate's one-shot capture
  // (session-telemetry.ts:315-321) never invokes onAgentSessionId. That means
  // the ENTIRE onAgentSessionId re-attach path in session-manager.ts (around
  // line 155-197 - the `!hasReceivedStatus` guard and
  // SessionHistoryReader.attach's idempotent early-return) goes completely
  // unexercised: the sibling test's final `isAttached() === false` assertion
  // passes purely from the unconditional onFirstStatus -> detach wiring, with
  // zero coverage of the nested re-attach in between. A real Claude
  // status.json always carries session_id (status-parser.ts:82), so this test
  // adds it to drive the full, realistic nested chain: handleStatusChange ->
  // onUsageParsed -> processStatusUpdate -> onAgentSessionId (nested
  // re-attach - a no-op here because the eager spawn-time attach already
  // holds the slot) -> firstStatusDelivered=true -> onFirstStatus -> detach.
  it('detaches the fallback after status.json (with session_id) drives a nested onAgentSessionId capture', async () => {
    const historyFile = path.join(tmpDir, 'handoff-transcript-nested.jsonl');
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 5000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10,
          },
        },
      }) + '\n',
    );
    vi.spyOn(ClaudeSessionHistoryParser, 'locate').mockResolvedValue(historyFile);
    const adapter = new ClaudeAdapter();

    const statusPath = path.join(tmpDir, 'handoff-status-nested.json');
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-handoff-nested',
      command: '',
      cwd: tmpDir,
      agentSessionId: 'handoff-session-uuid-nested',
      statusOutputPath: statusPath,
      agentParser: adapter,
    });

    const priv = manager as unknown as {
      sessionHistoryReader: { isAttached(id: string): boolean };
      statusFileReader: { handleStatusChange(id: string): void };
    };

    // Let the fire-and-forget eager attach (awaits the mocked locate) settle.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(priv.sessionHistoryReader.isAttached(session.id)).toBe(true);

    const capturedAgentSessionIds: string[] = [];
    manager.on('agent-session-id', (_sessionId: string, _taskId: string, _projectId: string, agentReportedId: string) => {
      capturedAgentSessionIds.push(agentReportedId);
    });

    // status.json now flows AND carries `session_id`, matching real Claude
    // output (status-parser.ts:82). This is the one payload difference from
    // the sibling test above.
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        session_id: 'handoff-session-uuid-nested',
        context_window: {
          used_percentage: 12,
          total_input_tokens: 24000,
          total_output_tokens: 500,
          context_window_size: 200000,
          current_usage: { input_tokens: 24000 },
        },
        cost: { total_cost_usd: 0.02, total_duration_ms: 5000 },
        model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      }),
    );
    priv.statusFileReader.handleStatusChange(session.id);

    // Proves the nested onAgentSessionId capture actually fired - without
    // this, the assertion below would pass for the wrong reason (like the
    // sibling test, purely from the unconditional detach wiring).
    expect(capturedAgentSessionIds).toContain('handoff-session-uuid-nested');
    // The fallback still ends up detached: onFirstStatus's detach (fired
    // immediately after onUsageParsed, in the same synchronous call stack)
    // must win over the nested re-attach.
    expect(priv.sessionHistoryReader.isAttached(session.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11c. Model name seeding (background card shows model before status.json)
// ---------------------------------------------------------------------------

describe('Model name seeding', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  // A background (never-opened) Claude session may never write status.json, so
  // the card would sit on "Starting agent..." indefinitely. We seed the model
  // display name from the spawn command's --model flag so the card shows the
  // model immediately; the agent's own status.json later overrides it.
  it('seeds the usage model display name from the spawn command --model', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-seed',
      command: 'claude --model claude-opus-4-8 --effort xhigh',
      cwd: tmpDir,
      agentParser: claudeAdapter,
    });

    const usage = manager.getUsageCache()[session.id];
    expect(usage?.model.displayName).toBe('Opus 4.8');
    expect(usage?.model.id).toBe('claude-opus-4-8');
  });

  it('does not seed when the command encodes no model (agent default)', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-noseed',
      command: 'claude --resume abc-123 --effort xhigh',
      cwd: tmpDir,
      agentParser: claudeAdapter,
    });

    expect(manager.getUsageCache()[session.id]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. Query Methods for Missing Sessions (consolidated)
// ---------------------------------------------------------------------------

describe('Query methods for missing sessions', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('returns empty/undefined for non-existent session ID', async () => {
    expect(manager.getSession('ghost')).toBeUndefined();
    expect(manager.getEventsForSession('ghost')).toEqual([]);
    expect(await manager.getScrollback('ghost')).toBe('');
  });

  it('returns empty objects when no sessions exist', () => {
    expect(manager.getUsageCache()).toEqual({});
    expect(manager.getActivityCache()).toEqual({});
    expect(manager.getEventsCache()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 13. Synthetic Session End
// ---------------------------------------------------------------------------

describe('Synthetic session_end', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  /** Append one JSONL event to the events file. */
  function appendEvent(filePath: string, event: Record<string, unknown>): void {
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }

  /** Wait for the file watcher debounce (50ms) + processing time. */
  function waitForWatcher(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function spawnWithEvents(taskId = 'task-synth') {
    const eventsPath = path.join(tmpDir, `${taskId}-events.jsonl`);
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
      eventsOutputPath: eventsPath,
      agentParser: claudeAdapter,
    });

    spawnedSessionId = session.id;
    return { session, eventsPath, ...mock };
  }

  it('suspend injects synthetic session_end into event cache', async () => {
    const { session, eventsPath } = await spawnWithEvents('task-synth-suspend');

    // Write a tool_start event so the cache has content
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    await manager.suspend(session.id);
    spawnedSessionId = null; // already suspended

    const events = manager.getEventsForSession(session.id);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe(EventType.SessionEnd);
  });

  it('suspend does not duplicate session_end if already present', async () => {
    const { session, eventsPath } = await spawnWithEvents('task-synth-nodup');

    // Write a session_end event from Claude Code's hook
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SessionEnd });
    await waitForWatcher();

    const eventsBefore = manager.getEventsForSession(session.id);
    const sessionEndCountBefore = eventsBefore.filter(
      (event) => event.type === EventType.SessionEnd
    ).length;

    await manager.suspend(session.id);
    spawnedSessionId = null;

    const eventsAfter = manager.getEventsForSession(session.id);
    const sessionEndCountAfter = eventsAfter.filter(
      (event) => event.type === EventType.SessionEnd
    ).length;

    // Should not have added another session_end
    expect(sessionEndCountAfter).toBe(sessionEndCountBefore);
  });

  it('suspend creates event cache entry if none existed', async () => {
    // Spawn without eventsOutputPath → no event watcher → no cache entry
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId: 'task-synth-nocache',
      command: '',
      cwd: tmpDir,
      // no eventsOutputPath
    });
    spawnedSessionId = session.id;

    // Verify no events cached yet
    expect(manager.getEventsForSession(session.id)).toEqual([]);

    await manager.suspend(session.id);
    spawnedSessionId = null;

    const events = manager.getEventsForSession(session.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.SessionEnd);
  });

  it('onExit emits synthetic session_end for running sessions', async () => {
    // Spawn without eventsOutputPath so there's no pre-existing event cache
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId: 'task-synth-exit',
      command: '',
      cwd: tmpDir,
    });
    spawnedSessionId = session.id;

    const emittedEvents: SessionEvent[] = [];
    manager.on('event', (sessionId: string, event: SessionEvent) => {
      if (sessionId === session.id) emittedEvents.push(event);
    });

    // Trigger PTY exit (simulates process ending)
    mock.triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // onExit should have injected a synthetic session_end
    const cached = manager.getEventsForSession(session.id);
    expect(cached.some((event) => event.type === EventType.SessionEnd)).toBe(true);
    expect(emittedEvents.some((event) => event.type === EventType.SessionEnd)).toBe(true);

    spawnedSessionId = null; // already exited
  });
});

// ---------------------------------------------------------------------------
// 14. Spawning Count (concurrent spawn slot reservation)
// ---------------------------------------------------------------------------

describe('Spawning count', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('5 concurrent spawn calls with maxConcurrent=3 - exactly 3 running + 2 queued', async () => {
    manager.setMaxConcurrent(3);

    // Use a slow mock PTY that takes time to "spawn" so we can test concurrency
    const mocks: ReturnType<typeof createMockPty>[] = [];
    vi.mocked(pty.spawn).mockImplementation(() => {
      const mock = createMockPty();
      mocks.push(mock);
      return mock.mockPty as unknown as pty.IPty;
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        manager.spawn({
          taskId: `task-concurrent-${index}`,
          command: '',
          cwd: tmpDir,
        }),
      ),
    );

    const running = results.filter(session => session.status === 'running');
    const queued = results.filter(session => session.status === 'queued');

    expect(running).toHaveLength(3);
    expect(queued).toHaveLength(2);
  });

  it('failed doSpawn decrements spawningCount and promotes queued session', async () => {
    manager.setMaxConcurrent(1);

    let spawnCallCount = 0;
    vi.mocked(pty.spawn).mockImplementation(() => {
      spawnCallCount++;
      if (spawnCallCount === 1) {
        // First spawn fails
        throw new Error('spawn ENOENT');
      }
      // Subsequent spawns succeed
      const mock = createMockPty();
      return mock.mockPty as unknown as pty.IPty;
    });

    // First spawn will fail (but still occupy a slot temporarily)
    const firstSession = await manager.spawn({
      taskId: 'task-fail-slot',
      command: '',
      cwd: tmpDir,
    });
    expect(firstSession.status).toBe('exited');
    expect(firstSession.exitCode).toBe(-1);

    // Second spawn should NOT be queued since the failed spawn freed its slot
    const secondSession = await manager.spawn({
      taskId: 'task-after-fail',
      command: '',
      cwd: tmpDir,
    });
    expect(secondSession.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// 13. Caller-owned session IDs
// ---------------------------------------------------------------------------

describe('Caller-owned session IDs', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('spawn uses caller-provided id when given', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      id: 'caller-owned-id',
      taskId: 'task-caller-id',
      command: '',
      cwd: tmpDir,
    });

    expect(session.id).toBe('caller-owned-id');
    expect(session.status).toBe('running');
  });

  it('queued session preserves caller-provided id through promotion', async () => {
    manager.setMaxConcurrent(1);

    const mocks: ReturnType<typeof createMockPty>[] = [];
    vi.mocked(pty.spawn).mockImplementation(() => {
      const mock = createMockPty();
      mocks.push(mock);
      return mock.mockPty as unknown as pty.IPty;
    });

    // First spawn fills the only slot
    const firstSession = await manager.spawn({
      taskId: 'task-fill-slot',
      command: '',
      cwd: tmpDir,
    });
    expect(firstSession.status).toBe('running');

    // Second spawn gets queued with a caller-provided ID
    const queuedSession = await manager.spawn({
      id: 'stable-queued-id',
      taskId: 'task-queued',
      command: '',
      cwd: tmpDir,
    });
    expect(queuedSession.status).toBe('queued');
    expect(queuedSession.id).toBe('stable-queued-id');

    // Kill first session to free the slot and trigger queue promotion
    manager.kill(firstSession.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Promoted session should still have the same caller-provided ID
    const promotedSession = manager.getSession('stable-queued-id');
    expect(promotedSession).toBeDefined();
    expect(promotedSession!.status).toBe('running');
    expect(promotedSession!.id).toBe('stable-queued-id');
  });
});

// ---------------------------------------------------------------------------
// 14. fromFilesystem session-ID capture wiring
// ---------------------------------------------------------------------------

describe('fromFilesystem session-ID capture wiring', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('fires agent-session-id event when fromFilesystem resolves with a UUID', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const capturedIds: string[] = [];
    manager.on('agent-session-id', (_sessionId: string, _taskId: string, _projectId: string, agentReportedId: string) => {
      capturedIds.push(agentReportedId);
    });

    const expectedId = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const stubAdapter = {
      ...claudeAdapter,
      name: 'stub-fs',
      supportsCallerSessionId: false,
      detectFirstOutput: () => true,
      removeHooks: () => {},
      runtime: {
        activity: claudeAdapter.runtime.activity,
        sessionId: {
          fromFilesystem: () => Promise.resolve(expectedId),
        },
      },
    };

    await manager.spawn({
      taskId: 'task-fs-capture',
      projectId: 'project-fs',
      command: '',
      cwd: tmpDir,
      agentParser: stubAdapter as unknown as typeof claudeAdapter,
      agentName: 'stub-fs',
    });

    // fromFilesystem resolves immediately (microtask) but the callback
    // chain goes through SessionTelemetry -> SessionManager event -> here.
    // Allow one tick for the async chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedIds).toContain(expectedId);
  });

  it('does NOT fire agent-session-id when session is removed before fromFilesystem resolves', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const capturedIds: string[] = [];
    manager.on('agent-session-id', (_sessionId: string, _taskId: string, _projectId: string, agentReportedId: string) => {
      capturedIds.push(agentReportedId);
    });

    // Deferred promise that we resolve AFTER killing the session.
    let resolveCapture!: (value: string | null) => void;
    const capturePromise = new Promise<string | null>((resolve) => {
      resolveCapture = resolve;
    });

    const stubAdapter = {
      ...claudeAdapter,
      name: 'stub-fs-delayed',
      supportsCallerSessionId: false,
      detectFirstOutput: () => true,
      removeHooks: () => {},
      runtime: {
        activity: claudeAdapter.runtime.activity,
        sessionId: {
          fromFilesystem: () => capturePromise,
        },
      },
    };

    const session = await manager.spawn({
      taskId: 'task-fs-guard',
      projectId: 'project-fs-guard',
      command: '',
      cwd: tmpDir,
      agentParser: stubAdapter as unknown as typeof claudeAdapter,
      agentName: 'stub-fs-delayed',
    });

    // Fully remove the session BEFORE resolving the filesystem capture.
    // remove() deletes from the sessions Map (unlike kill which just
    // sets status=exited but keeps the entry). The guard we are testing
    // is `!this.sessions.has(id)` at session-manager.ts:565.
    manager.remove(session.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now resolve with a UUID - should be silently discarded.
    resolveCapture('bbbb2222-cccc-dddd-eeee-ffffffffffff');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedIds).not.toContain('bbbb2222-cccc-dddd-eeee-ffffffffffff');
  });
});

// ---------------------------------------------------------------------------
// 14. safeKillPty behavior (tested via observable effects on public API)
// ---------------------------------------------------------------------------

/**
 * Create a mock PTY whose .kill() throws a synthetic errno error.
 *
 * Used to exercise safeKillPty's error-swallowing logic without importing the
 * private helper directly. The factory returns the same shape as createMockPty
 * but never auto-fires the exit handler on kill - callers must trigger it
 * manually if they need the exit event, or simply observe that the public
 * method (killAll / suspend) did not throw.
 */
function createAlreadyDeadPty(errnoCode: string) {
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;

  const killError = new Error(`kill ESRCH`) as NodeJS.ErrnoException;
  killError.code = errnoCode;
  killError.syscall = 'kill';

  const mockPty = {
    pid: 99999,
    onData: vi.fn((_cb: (data: string) => void) => {}),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      throw killError;
    }),
  };

  return {
    mockPty,
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

describe('safeKillPty behavior', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  // -- killAll surface tests (EACCES, ESRCH, EPERM) -------------------------

  it('killAll does not throw when PTY.kill() raises EACCES (already dead - Windows)', async () => {
    const dead = createAlreadyDeadPty('EACCES');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-eacces', command: '', cwd: tmpDir });

    // If safeKillPty propagated the error, killAll() would throw here.
    expect(() => manager.killAll()).not.toThrow();
  });

  it('killAll does not throw when PTY.kill() raises ESRCH (already dead - POSIX)', async () => {
    const dead = createAlreadyDeadPty('ESRCH');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-esrch', command: '', cwd: tmpDir });

    expect(() => manager.killAll()).not.toThrow();
  });

  it('killAll does not throw on unexpected errno (EPERM) but emits console.warn', async () => {
    const dead = createAlreadyDeadPty('EPERM');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-eperm', command: '', cwd: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => manager.killAll()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SESSION]'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('killAll does NOT emit console.warn for EACCES (expected errno)', async () => {
    const dead = createAlreadyDeadPty('EACCES');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-eacces-quiet', command: '', cwd: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      manager.killAll();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('killAll does NOT emit console.warn for ESRCH (expected errno)', async () => {
    const dead = createAlreadyDeadPty('ESRCH');
    vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

    await manager.spawn({ taskId: 'task-dead-esrch-quiet', command: '', cwd: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      manager.killAll();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // -- suspend() skips 1500ms post-kill wait when kill returns false --------

  /**
   * The regression this test locks in:
   *
   * suspend() sends the exit sequence, waits up to 1500ms for a natural exit,
   * then force-kills. If the PTY is already dead (EACCES/ESRCH), safeKillPty
   * returns false and the second 1500ms wait must be SKIPPED entirely.
   * Without the `if (killLanded)` guard, suspend() would burn a full 1500ms
   * on every shutdown operation involving an already-dead process.
   *
   * We verify this by measuring wall-clock time: if the wait is skipped,
   * suspend() resolves well under 200ms. If the wait is not skipped it would
   * take at least 1500ms - a 7x difference that is not attributable to
   * timer jitter.
   */
  /**
   * Authoritative timing test using fake timers.
   *
   * Sequence of events inside suspend() after the PTY's exit sequence is sent:
   *  T+0ms    natural-exit wait starts (1500ms timeout)
   *  T+1500ms timeout fires, exitedNaturally=false
   *  T+1500ms force-kill attempted: PTY.kill() throws EACCES -> killLanded=false
   *  T+1500ms `if (killLanded)` is false -> second wait SKIPPED -> suspend() returns
   *
   * With real timers: suspend() resolves at T+1500ms.
   * With fake timers advanced by 1500ms: suspend() resolves immediately after
   *   the advance, with no further timer pending.
   *
   * We advance fake time by 1500ms and then confirm suspend() has settled.
   * If the second wait were NOT skipped, a further 1500ms advance would be
   * required - the test would hang waiting on the unresolved promise.
   */
  it('suspend() skips 1500ms post-kill wait when PTY.kill() throws EACCES (killLanded=false)', async () => {
    vi.useFakeTimers();
    try {
      const dead = createAlreadyDeadPty('EACCES');
      vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

      const freshManager = new SessionManager();

      const session = await freshManager.spawn({ taskId: 'task-kill-skip-eacces', command: '', cwd: tmpDir });

      // Start suspend() - it will block on the natural-exit wait (1500ms timer).
      // Do NOT emit the 'exit' event - we want exitedNaturally=false so the
      // force-kill path runs.
      let settled = false;
      const suspendPromise = freshManager.suspend(session.id).then(() => { settled = true; });

      // Advance past the natural-exit timeout only. If killLanded=false correctly
      // skips the second 1500ms wait, the promise resolves after this advance.
      await vi.advanceTimersByTimeAsync(1500);

      // Flush any queued microtasks.
      await Promise.resolve();

      expect(settled).toBe(true);

      // Advance another 1500ms to confirm no second wait is pending.
      await vi.advanceTimersByTimeAsync(1500);
      await suspendPromise;

      freshManager.killAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suspend() skips 1500ms post-kill wait when PTY.kill() throws ESRCH (killLanded=false)', async () => {
    vi.useFakeTimers();
    try {
      const dead = createAlreadyDeadPty('ESRCH');
      vi.mocked(pty.spawn).mockReturnValue(dead.mockPty as unknown as pty.IPty);

      const freshManager = new SessionManager();

      const session = await freshManager.spawn({ taskId: 'task-kill-skip-esrch', command: '', cwd: tmpDir });

      let settled = false;
      const suspendPromise = freshManager.suspend(session.id).then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(1500);
      await Promise.resolve();

      expect(settled).toBe(true);

      await vi.advanceTimersByTimeAsync(1500);
      await suspendPromise;

      freshManager.killAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 15. attachSession dispatch contract
// ---------------------------------------------------------------------------

describe('attachSession dispatch contract', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  async function spawnWithAdapter(
    taskId: string,
    adapter: import('../../src/shared/types').AgentParser & {
      attachSession?(context: import('../../src/shared/types').SessionContext): import('../../src/shared/types').SessionAttachment | void;
    },
  ) {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId,
      projectId: 'project-attach-test',
      command: '',
      cwd: tmpDir,
      agentParser: adapter as unknown as Parameters<typeof manager.spawn>[0]['agentParser'],
    });
    return { session, ...mock };
  }

  it('calls attachSession with a SessionContext whose sessionId matches the spawned session', async () => {
    const capturedContexts: import('../../src/shared/types').SessionContext[] = [];

    const adapter = {
      ...claudeAdapter,
      attachSession(context: import('../../src/shared/types').SessionContext) {
        capturedContexts.push(context);
        return { dispose: vi.fn() };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-context', adapter);

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0].sessionId).toBe(session.id);
    expect(typeof capturedContexts[0].applyUsage).toBe('function');
  });

  it('stores the returned attachment on the session (dispose called when session exits via onExit)', async () => {
    const disposeSpy = vi.fn();

    const adapter = {
      ...claudeAdapter,
      attachSession() {
        return { dispose: disposeSpy };
      },
    };

    const { triggerExit } = await spawnWithAdapter('task-attach-dispose-exit', adapter);

    expect(disposeSpy).not.toHaveBeenCalled();

    triggerExit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('releases generic cleanup and exact hooks once when the PTY exit callback repeats', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const adapter = new OpenCodeAdapter();
    const removeHooks = vi.spyOn(adapter, 'removeHooks').mockImplementation(() => {});
    let cleanupCalls = 0;
    await manager.spawn({
      id: 'generic-cleanup-exit-id',
      taskId: 'task-generic-cleanup-exit',
      projectId: 'project-attach-test',
      command: '',
      cwd: tmpDir,
      agentParser: adapter,
      spawnCleanup: { dispose: () => { cleanupCalls++; } },
    });

    mock.triggerExit(0);
    mock.triggerExit(0);

    expect(cleanupCalls).toBe(1);
    expect(removeHooks).toHaveBeenCalledOnce();
    expect(removeHooks).toHaveBeenCalledWith(tmpDir, 'task-generic-cleanup-exit', 'generic-cleanup-exit-id');
  });

  it('applyUsage inside the context calls usageTracker.setSessionUsage and emits usage event', async () => {
    let capturedContext: import('../../src/shared/types').SessionContext | null = null;

    const adapter = {
      ...claudeAdapter,
      attachSession(context: import('../../src/shared/types').SessionContext) {
        capturedContext = context;
        return { dispose: vi.fn() };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-apply-usage', adapter);

    const usageEvents: Array<{ sessionId: string; usage: Partial<import('../../src/shared/types').SessionUsage> }> = [];
    manager.on('usage', (sessionId: string, usage: import('../../src/shared/types').SessionUsage) => {
      usageEvents.push({ sessionId, usage });
    });

    expect(capturedContext).not.toBeNull();

    capturedContext!.applyUsage({ model: { id: 'cursor-small', displayName: 'Cursor Small' } });

    // SessionTelemetry.setSessionUsage triggers the onUsageChange callback which emits 'usage'
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(usageEvents.some((e) => e.sessionId === session.id)).toBe(true);
    const usageCache = manager.getUsageCache();
    expect(usageCache[session.id]?.model?.id).toBe('cursor-small');
  });

  it('applyUsage is a no-op once the session has been removed (torn-down guard)', async () => {
    let capturedContext: import('../../src/shared/types').SessionContext | null = null;

    const adapter = {
      ...claudeAdapter,
      attachSession(context: import('../../src/shared/types').SessionContext) {
        capturedContext = context;
        return { dispose: vi.fn() };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-noop-after-remove', adapter);

    manager.remove(session.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // This should not throw and should not write to any tracker
    expect(() => capturedContext!.applyUsage({ model: { id: 'zombie', displayName: 'Zombie' } })).not.toThrow();

    // Session is gone - usage cache entry must not exist
    expect(manager.getUsageCache()['zombie']).toBeUndefined();
  });

  it('adapterAttachment.dispose called on remove()', async () => {
    const disposeSpy = vi.fn();

    const adapter = {
      ...claudeAdapter,
      attachSession() {
        return { dispose: disposeSpy };
      },
    };

    const { session } = await spawnWithAdapter('task-attach-dispose-remove', adapter);

    expect(disposeSpy).not.toHaveBeenCalled();

    manager.remove(session.id);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('adapterAttachment.dispose called on respawn (replace-existing path) before second attachSession fires', async () => {
    const callOrder: string[] = [];
    const disposeFirstSpy = vi.fn(() => { callOrder.push('dispose-first'); });

    let attachCallCount = 0;
    const adapter = {
      ...claudeAdapter,
      attachSession() {
        attachCallCount++;
        if (attachCallCount === 1) {
          callOrder.push('attach-first');
          return { dispose: disposeFirstSpy };
        }
        callOrder.push('attach-second');
        return { dispose: vi.fn() };
      },
    };

    // First spawn
    const { session: firstSession } = await spawnWithAdapter('task-attach-respawn', adapter);
    expect(firstSession.taskId).toBe('task-attach-respawn');
    expect(attachCallCount).toBe(1);

    // Respawn (same taskId, triggers replace-existing path)
    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-attach-respawn',
      projectId: 'project-attach-test',
      command: '',
      cwd: tmpDir,
      agentParser: adapter as unknown as Parameters<typeof manager.spawn>[0]['agentParser'],
    });

    expect(attachCallCount).toBe(2);
    // dispose must have been called before the second attachSession fires
    const disposeIdx = callOrder.indexOf('dispose-first');
    const attachSecondIdx = callOrder.indexOf('attach-second');
    expect(disposeFirstSpy).toHaveBeenCalledTimes(1);
    expect(disposeIdx).toBeLessThan(attachSecondIdx);
  });

  it('disposes only the predecessor generic spawn cleanup when a task is superseded', async () => {
    const firstMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(firstMock.mockPty as unknown as pty.IPty);
    let predecessorCleanupCalls = 0;
    let successorCleanupCalls = 0;
    await manager.spawn({
      taskId: 'task-generic-cleanup-superseded',
      projectId: 'project-attach-test',
      command: '',
      cwd: tmpDir,
      spawnCleanup: { dispose: () => { predecessorCleanupCalls++; } },
    });

    const successorMock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(successorMock.mockPty as unknown as pty.IPty);
    await manager.spawn({
      taskId: 'task-generic-cleanup-superseded',
      projectId: 'project-attach-test',
      command: '',
      cwd: tmpDir,
      spawnCleanup: { dispose: () => { successorCleanupCalls++; } },
    });

    expect(predecessorCleanupCalls).toBe(1);
    expect(successorCleanupCalls).toBe(0);

    successorMock.triggerExit(0);

    expect(successorCleanupCalls).toBe(1);
  });

  it('adapter WITHOUT attachSession method spawns without error (optional-chain regression guard)', async () => {
    // Use a minimal adapter that explicitly has no attachSession property
    const adapterWithoutAttach = {
      ...claudeAdapter,
      attachSession: undefined,
    };

    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    let spawnError: unknown = null;
    try {
      await manager.spawn({
        taskId: 'task-no-attach',
        projectId: 'project-no-attach',
        command: '',
        cwd: tmpDir,
        agentParser: adapterWithoutAttach as unknown as Parameters<typeof manager.spawn>[0]['agentParser'],
      });
    } catch (error) {
      spawnError = error;
    }

    expect(spawnError).toBeNull();
    // Session should be running
    const sessions = manager.listSessions();
    const spawnedSession = sessions.find((s) => s.taskId === 'task-no-attach');
    expect(spawnedSession?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// 15b. getFirstOutputCache() wrapper
//
// Contract:
//  - Empty object when no session has emitted first output.
//  - { [sessionId]: true } for every session that has produced first output.
//  - Reflects remove(): a removed session no longer appears.
// ---------------------------------------------------------------------------

describe('getFirstOutputCache', () => {
  let manager: SessionManager;
  // Track sessions that need cleanup in afterEach.
  const spawnedIds: string[] = [];

  beforeEach(() => {
    manager = new SessionManager();
    spawnedIds.length = 0;
  });

  afterEach(async () => {
    // Kill any lingering PTYs created during the test.
    for (const sessionId of spawnedIds) {
      manager.kill(sessionId);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('returns an empty object when no session has emitted first output', () => {
    expect(manager.getFirstOutputCache()).toEqual({});
  });

  it('includes a session ID once the session emits a qualifying PTY chunk', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-first-output-1',
      command: '',
      cwd: tmpDir,
    });
    spawnedIds.push(session.id);

    // Before any data - not in cache.
    expect(manager.getFirstOutputCache()[session.id]).toBeUndefined();

    // Feed a qualifying chunk (non-empty, no custom detector).
    mock.feedData('hello from PTY');

    // Allow the 16ms flush debounce to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const cache = manager.getFirstOutputCache();
    expect(cache[session.id]).toBe(true);
    expect(Object.keys(cache)).toEqual([session.id]);
  });

  it('returns true for each of multiple sessions that have emitted', async () => {
    const mock1 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock1.mockPty as unknown as pty.IPty);
    const session1 = await manager.spawn({
      taskId: 'task-first-output-multi-1',
      command: '',
      cwd: tmpDir,
    });
    spawnedIds.push(session1.id);

    const mock2 = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock2.mockPty as unknown as pty.IPty);
    const session2 = await manager.spawn({
      taskId: 'task-first-output-multi-2',
      command: '',
      cwd: tmpDir,
    });
    spawnedIds.push(session2.id);

    mock1.feedData('output-from-session-1');
    mock2.feedData('output-from-session-2');

    await new Promise((resolve) => setTimeout(resolve, 50));

    const cache = manager.getFirstOutputCache();
    expect(cache[session1.id]).toBe(true);
    expect(cache[session2.id]).toBe(true);
    expect(Object.keys(cache).sort()).toEqual([session1.id, session2.id].sort());
  });

  it('removes a session from the cache after remove() is called', async () => {
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: 'task-first-output-remove',
      command: '',
      cwd: tmpDir,
    });
    // Do NOT push to spawnedIds: we call remove() explicitly in the test.

    mock.feedData('data');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.getFirstOutputCache()[session.id]).toBe(true);

    manager.remove(session.id);

    expect(manager.getFirstOutputCache()[session.id]).toBeUndefined();
    expect(manager.getFirstOutputCache()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 16. findLiveSessionByTaskId delegate
// ---------------------------------------------------------------------------

describe('findLiveSessionByTaskId delegate', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('forwards the call to the registry and passes through the return value', async () => {
    // Spawn a running session so the registry has a live entry for the task.
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId: 'task-delegate-live',
      command: '',
      cwd: tmpDir,
    });

    // The delegate must return the same session DTO as querying by id directly.
    const result = manager.findLiveSessionByTaskId('task-delegate-live');

    expect(result).toBeDefined();
    expect(result!.id).toBe(session.id);
    expect(result!.taskId).toBe('task-delegate-live');
    expect(result!.status).toBe('running');
    // Confirm the DTO does not expose internal ManagedSession fields.
    expect('pty' in result!).toBe(false);
  });

  it('returns undefined when no live session exists for the taskId', () => {
    // Empty registry - delegate must pass through undefined without throwing.
    const result = manager.findLiveSessionByTaskId('task-delegate-missing');
    expect(result).toBeUndefined();
  });
});

function createCoordinationPty(): {
  readonly pty: pty.IPty;
  readonly writes: string[];
  readonly triggerExit: (exitCode?: number) => void;
} {
  const writes: string[] = [];
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const ptyProcess: pty.IPty = {
    pid: 54321,
    cols: 120,
    rows: 30,
    process: 'mock-shell',
    handleFlowControl: false,
    onData: vi.fn((_listener: (data: string) => void) => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitHandler = listener;
      return { dispose: vi.fn() };
    }),
    resize: vi.fn(),
    clear: vi.fn(),
    write: vi.fn((data: string | Buffer) => {
      writes.push(typeof data === 'string' ? data : data.toString());
    }),
    kill: vi.fn(() => exitHandler?.({ exitCode: 0 })),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return {
    pty: ptyProcess,
    writes,
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

describe('Input coordination', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.restoreAllMocks();
  });

  async function spawnCoordinatedSession(taskId: string) {
    const mock = createCoordinationPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.pty);
    const session = await manager.spawn({ taskId, command: '', cwd: tmpDir });
    return { session, ...mock };
  }

  function expectInputCoordinationRemoved(sessionId: string): void {
    expect(manager.getSessionGeneration(sessionId)).toBeNull();
    expect(manager.getInputGeneration(sessionId)).toBeNull();
    expect(manager['nativeIdleEvidence'].snapshot(sessionId)).toBeNull();
  }

  it('exposes a readonly native idle snapshot and returns null for an unknown session', async () => {
    const { session } = await spawnCoordinatedSession('task-native-idle-snapshot');

    expect(manager.snapshotNativeIdle('missing-session')).toBeNull();
    expect(manager.snapshotNativeIdle(session.id)).toMatchObject({
      sessionGeneration: 1,
      inputGeneration: 0,
      cleanIdle: null,
      errorLatched: false,
    });
  });

  it('forwards native idle notifications until the returned unsubscribe is called', async () => {
    const { session } = await spawnCoordinatedSession('task-native-idle-subscribe');
    const listener = vi.fn();
    const unsubscribe = manager.subscribeNativeIdle(session.id, listener);

    manager.writeUserInput(session.id, 'first', 20);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager.writeUserInput(session.id, 'second', 21);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('uses Date.now for the two-argument writeUserInput shape', async () => {
    // Given
    const { session, writes } = await spawnCoordinatedSession('task-coordination-default-time');
    vi.spyOn(Date, 'now').mockReturnValue(123_456);
    const evidenceWrite = vi.spyOn(manager['nativeIdleEvidence'], 'recordUserInput');

    // When
    manager.writeUserInput(session.id, 'user');

    // Then
    expect(evidenceWrite).toHaveBeenCalledWith(session.id, 1, 123_456);
    expect(writes).toEqual(['user']);
  });

  it('updates native idle evidence before user bytes reach the PTY', async () => {
    // Given
    const { session, pty: ptyProcess, writes } = await spawnCoordinatedSession('task-coordination-evidence-order');
    const order: string[] = [];
    const evidence = manager['nativeIdleEvidence'];
    const recordEvidence = evidence.recordUserInput.bind(evidence);
    vi.spyOn(evidence, 'recordUserInput').mockImplementation((sessionId, generation, occurredAt) => {
      order.push('evidence');
      recordEvidence(sessionId, generation, occurredAt);
    });
    vi.mocked(ptyProcess.write).mockImplementation((data: string | Buffer) => {
      order.push('pty-write');
      writes.push(typeof data === 'string' ? data : data.toString());
    });

    // When
    manager.writeUserInput(session.id, 'user', 20);

    // Then
    expect(order).toEqual(['evidence', 'pty-write']);
    expect(writes).toEqual(['user']);
  });

  it('advances user-submission generation and evidence before acquisition returns', async () => {
    // Given
    const { session } = await spawnCoordinatedSession('task-coordination-user-marker');
    vi.spyOn(Date, 'now').mockReturnValue(654_321);
    const evidenceWrite = vi.spyOn(manager['nativeIdleEvidence'], 'recordUserInput');

    // When
    const lease = manager.acquireUserSubmission(session.id);

    // Then
    expect(lease).not.toBeNull();
    expect(manager.getInputGeneration(session.id)).toBe(1);
    expect(evidenceWrite).toHaveBeenCalledWith(session.id, 1, 654_321);
    expect(manager['nativeIdleEvidence'].snapshot(session.id)).toMatchObject({
      inputGeneration: 1,
    });
    lease?.release();
  });

  it('exposes generations after spawn and advances input generation through writeUserInput', async () => {
    // Given
    const { session, writes } = await spawnCoordinatedSession('task-coordination-write');
    const sessionGeneration = manager.getSessionGeneration(session.id);

    // When
    manager.write(session.id, 'legacy');
    manager.writeUserInput(session.id, 'user', 20);

    // Then
    expect(sessionGeneration).toBe(1);
    expect(manager.getInputGeneration(session.id)).toBe(1);
    expect(writes).toEqual(['legacy', 'user']);
    expect(manager['nativeIdleEvidence'].snapshot(session.id)).toMatchObject({
      sessionGeneration,
      inputGeneration: 1,
    });
  });

  it('buffers manager user input behind committed automation until release', async () => {
    // Given
    const { session, writes } = await spawnCoordinatedSession('task-coordination-automation');
    const sessionGeneration = manager.getSessionGeneration(session.id);
    const inputGeneration = manager.getInputGeneration(session.id);
    const lease = sessionGeneration === null || inputGeneration === null
      ? null
      : manager.acquireAutomation(
          session.id,
          { sessionGeneration, inputGeneration },
          vi.fn(),
        );
    await lease?.write('automation');

    // When
    manager.writeUserInput(session.id, 'user', 20);

    // Then
    expect(writes).toEqual(['automation']);
    lease?.release();
    expect(writes).toEqual(['automation', 'user']);
  });

  it('keeps focus reports in mixed deferred FIFO order without recording user input evidence', async () => {
    // Given
    const { session, writes } = await spawnCoordinatedSession('task-coordination-focus-report');
    const sessionGeneration = manager.getSessionGeneration(session.id);
    const inputGeneration = manager.getInputGeneration(session.id);
    const automation = sessionGeneration === null || inputGeneration === null
      ? null
      : manager.acquireAutomation(
          session.id,
          { sessionGeneration, inputGeneration },
          vi.fn(),
        );
    await automation?.write('automation');

    // When
    manager.writeUserInput(session.id, 'human-1', 20);
    manager.writeFocusReport(session.id, '\x1b[I');
    manager.writeUserInput(session.id, 'human-2', 21);
    manager.writeFocusReport(session.id, '\x1b[O');
    automation?.release();

    // Then
    expect(writes).toEqual(['automation', 'human-1', '\x1b[I', 'human-2', '\x1b[O']);
    expect(manager.getInputGeneration(session.id)).toBe(2);
  });

  it('blocks automation while a user submission lease is active', async () => {
    // Given
    const { session } = await spawnCoordinatedSession('task-coordination-user-submission');
    const sessionGeneration = manager.getSessionGeneration(session.id);
    const inputGeneration = manager.getInputGeneration(session.id);
    const expectation = sessionGeneration === null || inputGeneration === null
      ? null
      : { sessionGeneration, inputGeneration };

    // When
    const userSubmission = manager.acquireUserSubmission(session.id);
    const blockedAutomation = expectation
      ? manager.acquireAutomation(session.id, expectation, vi.fn())
      : null;
    await userSubmission?.run(async () => Promise.resolve());
    const releasedAutomation = expectation
      ? manager.acquireAutomation(
          session.id,
          { ...expectation, inputGeneration: expectation.inputGeneration + 1 },
          vi.fn(),
        )
      : null;

    // Then
    expect(blockedAutomation).toBeNull();
    expect(releasedAutomation).not.toBeNull();
  });

  it('uses one shared queue for legacy, multi-chunk automation, and deferred user writes', async () => {
    vi.useFakeTimers();
    try {
      // Given
      const { session, writes } = await spawnCoordinatedSession('task-coordination-shared-queue');
      const legacy = 'L'.repeat(5_000);
      const automation = 'A'.repeat(5_000);
      manager.write(session.id, legacy);
      await vi.runAllTimersAsync();
      await manager.drain(session.id);
      const sessionGeneration = manager.getSessionGeneration(session.id);
      const inputGeneration = manager.getInputGeneration(session.id);
      const lease = sessionGeneration === null || inputGeneration === null
        ? null
        : manager.acquireAutomation(
            session.id,
            { sessionGeneration, inputGeneration },
            vi.fn(),
          );

      // When
      const automationWrite = lease?.write(automation);
      await vi.runAllTimersAsync();
      await automationWrite;
      manager.writeUserInput(session.id, 'user-1', 20);
      manager.writeUserInput(session.id, 'user-2', 21);
      lease?.release();
      await vi.runAllTimersAsync();
      await manager.drain(session.id);

      // Then
      expect(manager['writeQueues'].size).toBe(1);
      expect(writes.join('')).toBe(`${legacy}${automation}user-1user-2`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears generations immediately on suspend and on explicit kill', async () => {
    // Given
    const first = await spawnCoordinatedSession('task-coordination-suspend');

    // When
    const suspension = manager.suspend(first.session.id);

    // Then
    expectInputCoordinationRemoved(first.session.id);
    first.triggerExit(0);
    await suspension;

    const second = await spawnCoordinatedSession('task-coordination-kill');
    manager.kill(second.session.id);
    expectInputCoordinationRemoved(second.session.id);
  });

  it('clears generations on natural exit and synchronous killAll', async () => {
    // Given
    const natural = await spawnCoordinatedSession('task-coordination-exit');

    // When
    natural.triggerExit(0);

    // Then
    expectInputCoordinationRemoved(natural.session.id);

    const shutdown = await spawnCoordinatedSession('task-coordination-kill-all');
    manager.killAll();
    expectInputCoordinationRemoved(shutdown.session.id);
  });

  it('clears coordinator and evidence together on remove', async () => {
    // Given
    const { session } = await spawnCoordinatedSession('task-coordination-remove');

    // When
    manager.remove(session.id);

    // Then
    expectInputCoordinationRemoved(session.id);
  });

  it('clears coordinator and evidence synchronously when suspendAll starts', async () => {
    // Given
    const { session } = await spawnCoordinatedSession('task-coordination-suspend-all');

    // When
    const suspension = manager.suspendAll(0);

    // Then
    expectInputCoordinationRemoved(session.id);
    await suspension;
  });
});
