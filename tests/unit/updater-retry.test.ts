import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  autoUpdaterOn: vi.fn(),
  trackEvent: vi.fn(),
  sanitizeErrorMessage: vi.fn((message: string) => message),
  existsSync: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: class {
    isDestroyed() { return false; }
    webContents = { send: vi.fn() };
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: mocks.autoUpdaterOn,
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: mocks.trackEvent,
  sanitizeErrorMessage: mocks.sanitizeErrorMessage,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: mocks.existsSync };
});

Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
Object.defineProperty(process, 'resourcesPath', {
  value: '/fake/resources',
  configurable: true,
});

import { checkWithRetry, downloadWithRetry, initUpdater } from '../../src/main/updater';
import { BrowserWindow } from 'electron';

function makeError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code !== undefined) {
    (error as NodeJS.ErrnoException).code = code;
  }
  return error;
}

function getRegisteredListener(eventName: string): ((...args: unknown[]) => void) {
  const callEntry = mocks.autoUpdaterOn.mock.calls.find(
    (callArgs) => callArgs[0] === eventName,
  );
  if (!callEntry) throw new Error(`No autoUpdater.on('${eventName}') call found`);
  return callEntry[1] as (...args: unknown[]) => void;
}

describe('checkWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the first check succeeds', async () => {
    mocks.checkForUpdates.mockResolvedValueOnce(undefined);
    const promise = checkWithRetry();
    await vi.runAllTimersAsync();
    await promise;
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('retries after RETRY_DELAY_MS when the first check fails', async () => {
    mocks.checkForUpdates.mockRejectedValueOnce(makeError('DNS failure')).mockResolvedValueOnce(undefined);
    const promise = checkWithRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('logs a retry message and a console.error when both attempts fail', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.checkForUpdates.mockRejectedValueOnce(makeError('first failure')).mockRejectedValueOnce(makeError('second failure'));
    const promise = checkWithRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[UPDATER] Check failed, retrying in 30s...'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[UPDATER] Check failed after retry:'), expect.any(Error));
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('downloadWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the first download succeeds', async () => {
    mocks.downloadUpdate.mockResolvedValueOnce(undefined);
    const promise = downloadWithRetry();
    await vi.runAllTimersAsync();
    await promise;
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('retries after RETRY_DELAY_MS when the first download fails', async () => {
    mocks.downloadUpdate.mockRejectedValueOnce(makeError('ECONNRESET', 'ECONNRESET')).mockResolvedValueOnce(undefined);
    const promise = downloadWithRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it('logs a retry message and a console.error when both attempts fail', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.downloadUpdate.mockRejectedValueOnce(makeError('first download failure')).mockRejectedValueOnce(makeError('second download failure'));
    const promise = downloadWithRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[UPDATER] Download failed, retrying in 30s:'), expect.any(Error));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[UPDATER] Download failed after retry:'), expect.any(Error));
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe("autoUpdater.on('error') listener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const window = new BrowserWindow();
    initUpdater(window as unknown as import('electron').BrowserWindow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls trackEvent for a structural error when not retrying', () => {
    mocks.sanitizeErrorMessage.mockReturnValue('sanitized message');
    const errorListener = getRegisteredListener('error');
    const structuralError = makeError('ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_INVALID_SIGNATURE');
    errorListener(structuralError);
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('app_error', { source: 'updater', message: 'sanitized message' });
    expect(mocks.sanitizeErrorMessage).toHaveBeenCalledWith(structuralError.message);
  });

  it('does NOT call trackEvent for a transient error when not retrying', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorListener = getRegisteredListener('error');
    errorListener(makeError('network reset', 'ECONNRESET'));
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[UPDATER] Suppressing transient error telemetry:'), expect.any(String));
    consoleLogSpy.mockRestore();
  });

  it('does NOT call trackEvent while checkRetrying is true', async () => {
    mocks.checkForUpdates.mockRejectedValueOnce(makeError('DNS failure'));
    const retryPromise = checkWithRetry();
    await vi.advanceTimersByTimeAsync(0);
    getRegisteredListener('error')(makeError('ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_INVALID_SIGNATURE'));
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    mocks.checkForUpdates.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await retryPromise;
  });

  it('does NOT call trackEvent while downloadRetrying is true', async () => {
    mocks.downloadUpdate.mockRejectedValueOnce(makeError('ECONNRESET', 'ECONNRESET'));
    const retryPromise = downloadWithRetry();
    await vi.advanceTimersByTimeAsync(0);
    getRegisteredListener('error')(makeError('ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_INVALID_SIGNATURE'));
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    mocks.downloadUpdate.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await retryPromise;
  });
});
