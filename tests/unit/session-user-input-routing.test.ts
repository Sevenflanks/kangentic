import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    on: vi.fn(),
  },
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({ UsageHistoryRepository: class {} }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/ipc/helpers', () => ({
  createTransitionEngine: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  getProjectRepos: vi.fn(),
  resolveSpawnOverrides: vi.fn(),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({ autoLinkPRForTask: vi.fn(), linkPR: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ resolveProjectContext: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-title-cache', () => ({ getCachedTaskTitle: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: vi.fn(),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/git-stats-capture', () => ({
  captureGitChurn: vi.fn(),
  resolveDefaultBaseBranch: vi.fn(),
}));
vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
  promoteRecord: vi.fn(),
  recoverStaleSessionId: vi.fn(),
}));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));
vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  applySuspendDbWrites: vi.fn(),
  reconcileTaskSessionRef: vi.fn(() => ({ liveSession: null })),
}));
vi.mock('../../src/main/ipc/handlers/session-resume-controllers', () => ({
  abortInFlightResume: vi.fn(),
  registerResumeController: vi.fn(),
  releaseResumeController: vi.fn(),
}));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));

import { registerSessionHandlers } from '../../src/main/ipc/handlers/sessions';

describe('SESSION_WRITE user ingress routing', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('routes renderer terminal bytes through writeUserInput', () => {
    // Given
    const write = vi.fn();
    const writeUserInput = vi.fn();
    const sessionManager = new Proxy(
      { write, writeUserInput },
      { get: (target, property) => Reflect.get(target, property) ?? vi.fn() },
    );
    const context = new Proxy(
      { sessionManager },
      { get: (target, property) => Reflect.get(target, property) ?? vi.fn() },
    );
    Reflect.apply(registerSessionHandlers, undefined, [context]);
    const handler = handlers.get(IPC.SESSION_WRITE);
    if (!handler) throw new Error('SESSION_WRITE handler was not registered');

    // When
    handler(undefined, 'session-1', 'typed');

    // Then
    expect(writeUserInput).toHaveBeenCalledOnce();
    expect(writeUserInput).toHaveBeenCalledWith('session-1', 'typed');
    expect(write).not.toHaveBeenCalled();
  });

  it('routes exact focus reports through writeFocusReport without advancing user input', () => {
    // Given
    const writeFocusReport = vi.fn();
    const writeUserInput = vi.fn();
    const sessionManager = new Proxy(
      { writeFocusReport, writeUserInput },
      { get: (target, property) => Reflect.get(target, property) ?? vi.fn() },
    );
    const context = new Proxy(
      { sessionManager },
      { get: (target, property) => Reflect.get(target, property) ?? vi.fn() },
    );
    Reflect.apply(registerSessionHandlers, undefined, [context]);
    const handler = handlers.get(IPC.SESSION_WRITE_FOCUS_REPORT);
    if (!handler) throw new Error('SESSION_WRITE_FOCUS_REPORT handler was not registered');

    // When
    handler(undefined, 'session-1', '\x1b[I');

    // Then
    expect(writeFocusReport).toHaveBeenCalledOnce();
    expect(writeFocusReport).toHaveBeenCalledWith('session-1', '\x1b[I');
    expect(writeUserInput).not.toHaveBeenCalled();
  });

  it('routes non-focus strings through writeUserInput and rejects non-string focus payloads', () => {
    // Given
    const writeFocusReport = vi.fn();
    const writeUserInput = vi.fn();
    const sessionManager = new Proxy(
      { writeFocusReport, writeUserInput },
      { get: (target, property) => Reflect.get(target, property) ?? vi.fn() },
    );
    const context = new Proxy(
      { sessionManager },
      { get: (target, property) => Reflect.get(target, property) ?? vi.fn() },
    );
    Reflect.apply(registerSessionHandlers, undefined, [context]);
    const handler = handlers.get(IPC.SESSION_WRITE_FOCUS_REPORT);
    if (!handler) throw new Error('SESSION_WRITE_FOCUS_REPORT handler was not registered');

    // When
    handler(undefined, 'session-1', '\x1b[Iextra');

    // Then
    expect(writeUserInput).toHaveBeenCalledWith('session-1', '\x1b[Iextra');
    expect(writeFocusReport).not.toHaveBeenCalled();
    expect(() => handler(undefined, 'session-1', 42)).toThrow(TypeError);
  });
});
