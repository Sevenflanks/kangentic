import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDeliveryStatus } from '../../src/shared/live-delivery-status';
import type { ElectronAPI } from '../../src/shared/types';

type StatusListener = (event: unknown, status: LiveDeliveryStatus) => void;

const ipcOn = vi.fn();
const ipcRemoveListener = vi.fn();
let exposedApi: ElectronAPI | null = null;
let schedulerStatusCallback: ((status: LiveDeliveryStatus) => void) | null = null;

vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false;
    readonly webContents = { send: vi.fn() };
    destroy(): void { this.destroyed = true; }
    isDestroyed(): boolean { return this.destroyed; }
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: ElectronAPI): void => { exposedApi = api; },
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: ipcOn,
    removeListener: ipcRemoveListener,
    send: vi.fn(),
    sendSync: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));

vi.mock('../../src/main/transition-engine/terminal-submit-scheduler', () => ({
  TerminalSubmitScheduler: class {
    constructor(
      _sessionManager: unknown,
      _terminalSubmit: unknown,
      onStatus: (status: LiveDeliveryStatus) => void,
    ) {
      schedulerStatusCallback = onStatus;
    }
  },
}));
vi.mock('../../src/main/pty/session-manager', () => ({ SessionManager: class {} }));
vi.mock('../../src/main/pty/paste-engine', () => ({ createPasteEngine: vi.fn(() => ({})) }));
vi.mock('../../src/main/pty/terminal-submit', () => ({ TerminalSubmit: class {} }));
vi.mock('../../src/main/config/config-manager', () => ({
  ConfigManager: class { getEffectiveConfig(): object { return {}; } },
}));
vi.mock('../../src/main/config/board-config-manager', () => ({ BoardConfigManager: class {} }));
vi.mock('../../src/main/git/diff-watcher', () => ({ DiffWatcher: class {} }));
vi.mock('../../src/main/git/git-detector', () => ({ GitDetector: class {} }));
vi.mock('../../src/main/pty/spawn/shell-resolver', () => ({ ShellResolver: class {} }));
vi.mock('../../src/main/db/repositories/project-repository', () => ({ ProjectRepository: class {} }));
vi.mock('../../src/main/db/repositories/project-group-repository', () => ({ ProjectGroupRepository: class {} }));
vi.mock('../../src/main/transcription/transcription-service', () => ({ TranscriptionService: class {} }));
vi.mock('../../src/main/mobile-bridge/mobile-bridge-service', () => ({
  MobileBridgeService: class {
    attachContext(): void {}
    reconcile(): void {}
  },
}));
vi.mock('../../src/main/mobile-bridge/board-event-bus', () => ({ BoardEventBus: class {} }));
vi.mock('../../src/main/retrieval/retrieval-service', () => ({
  retrievalService: { attach: vi.fn() },
}));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: vi.fn((message: string) => message),
}));

vi.mock('../../src/main/ipc/handlers/projects', () => ({
  registerProjectHandlers: vi.fn(), cleanupProject: vi.fn(), deleteProjectFromIndex: vi.fn(),
  pruneStaleWorktreeProjects: vi.fn(), openProjectByPath: vi.fn(), activateAllProjects: vi.fn(),
  getLastOpenedProject: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-crud', () => ({ registerTaskCrudHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-archive', () => ({ registerTaskArchiveHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ registerTaskMoveHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-branch', () => ({ registerTaskBranchHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-runtime-override', () => ({ registerTaskRuntimeOverrideHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/sessions', () => ({ registerSessionHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/transient-sessions', () => ({ registerTransientSessionHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/transcription', () => ({ registerTranscriptionHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/board', () => ({ registerBoardHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ registerSystemHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/backlog', () => ({ registerBacklogHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/git-diff', () => ({ registerGitDiffHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/browser', () => ({ registerBrowserHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/search', () => ({ registerSearchHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/transcripts', () => ({ registerTranscriptHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/mobile-bridge', () => ({ registerMobileBridgeHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/usage-stats', () => ({ registerUsageStatsHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/pop-out', () => ({ registerPopOutHandlers: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/metrics-snapshot-timer', () => ({
  startMetricsSnapshotTimer: vi.fn(),
}));
vi.mock('../../src/preload/diagnostics/console-capture', () => ({ installConsoleCapture: vi.fn() }));
vi.mock('../../src/devtools/preload/install-globals', () => ({ installDevtoolsPreloadHooks: vi.fn() }));

function requireExposedApi(): ElectronAPI {
  if (exposedApi === null) throw new Error('preload API was not exposed');
  return exposedApi;
}

function requireSchedulerStatusCallback(): (status: LiveDeliveryStatus) => void {
  if (schedulerStatusCallback === null) throw new Error('scheduler callback was not wired');
  return schedulerStatusCallback;
}

const cancelledStatus = {
  projectId: 'project-1',
  taskId: 'task-1',
  sessionId: 'session-1',
  generation: 2,
  at: '2026-07-22T00:00:00.000Z',
  state: 'cancelled',
  reason: 'timeout',
} satisfies LiveDeliveryStatus;

describe('project-scoped live delivery status IPC', () => {
  beforeEach(() => {
    exposedApi = null;
    schedulerStatusCallback = null;
    ipcOn.mockClear();
    ipcRemoveListener.mockClear();
    vi.resetModules();
  });

  it('keeps the public DTO project-scoped and private-safe for every state shape', () => {
    const deliveredStatus = {
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      generation: 2,
      at: '2026-07-22T00:00:00.000Z',
      state: 'delivered',
    } satisfies LiveDeliveryStatus;

    expect(Object.keys(cancelledStatus).sort()).toEqual([
      'at', 'generation', 'projectId', 'reason', 'sessionId', 'state', 'taskId',
    ]);
    expect(Object.keys(deliveredStatus).sort()).toEqual([
      'at', 'generation', 'projectId', 'sessionId', 'state', 'taskId',
    ]);
    expect(cancelledStatus).not.toHaveProperty('command');
    expect(cancelledStatus).not.toHaveProperty('fingerprint');
    expect(cancelledStatus).not.toHaveProperty('nativeSessionId');
    expect(cancelledStatus).not.toHaveProperty('transcript');
    expect(cancelledStatus).not.toHaveProperty('error');
  });

  it('publishes unchanged only to the current live window after idempotent replacement', async () => {
    const { BrowserWindow } = await import('electron');
    const { IPC } = await import('../../src/shared/ipc-channels');
    const { registerAllIpc } = await import('../../src/main/ipc/register-all');
    const firstWindow = new BrowserWindow();
    const secondWindow = new BrowserWindow();

    registerAllIpc(firstWindow);
    firstWindow.destroy();
    requireSchedulerStatusCallback()(cancelledStatus);
    expect(firstWindow.webContents.send).not.toHaveBeenCalled();

    registerAllIpc(secondWindow);
    requireSchedulerStatusCallback()(cancelledStatus);
    expect(firstWindow.webContents.send).not.toHaveBeenCalled();
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SESSION_LIVE_DELIVERY_STATUS,
      cancelledStatus,
    );

    secondWindow.destroy();
    requireSchedulerStatusCallback()(cancelledStatus);
    expect(secondWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('uses one preload listener and removes that exact handler on unsubscribe', async () => {
    const { IPC } = await import('../../src/shared/ipc-channels');
    await import('../../src/preload/preload');
    const callback = vi.fn();
    const unsubscribe = requireExposedApi().sessions.onLiveDeliveryStatus(callback);

    expect(ipcOn).toHaveBeenCalledTimes(1);
    const registered = ipcOn.mock.calls[0];
    expect(registered[0]).toBe(IPC.SESSION_LIVE_DELIVERY_STATUS);
    const handler: StatusListener = registered[1];
    handler({}, cancelledStatus);
    expect(callback).toHaveBeenCalledWith(cancelledStatus);

    unsubscribe();
    expect(ipcRemoveListener).toHaveBeenCalledWith(
      IPC.SESSION_LIVE_DELIVERY_STATUS,
      handler,
    );
  });

  it('keeps the channel push-only and the UI mock identity-based without renderer state', () => {
    const registerAllSource = readFileSync('src/main/ipc/register-all.ts', 'utf8');
    const preloadSource = readFileSync('src/preload/preload.ts', 'utf8');
    const mockSource = readFileSync('tests/ui/mock-electron-api.js', 'utf8');

    expect(registerAllSource).not.toContain('ipcMain.handle(IPC.SESSION_LIVE_DELIVERY_STATUS');
    expect(preloadSource).not.toContain('ipcRenderer.invoke(IPC.SESSION_LIVE_DELIVERY_STATUS');
    expect(mockSource).toContain('window.__mockLiveDeliveryStatusListeners');
    expect(mockSource).toContain('(window.__mockLiveDeliveryStatusListeners || []).slice()');
    expect(mockSource).toContain('listeners.indexOf(callback)');
    expect(mockSource).not.toMatch(/liveDelivery(Status)?(Snapshot|Replay|Cache|Store)/);
  });
});
