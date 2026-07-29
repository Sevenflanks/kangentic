import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => listeners.set(channel, listener)),
  },
  systemPreferences: {
    askForMediaAccess: vi.fn(),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

import { registerTranscriptionHandlers } from '../../src/main/ipc/handlers/transcription';

function registerWith(sessionManager: object, terminalSubmit: object): void {
  const transcriptionService = {
    cancel: vi.fn(),
    downloadModel: vi.fn(),
    finalize: vi.fn(),
    getInfo: vi.fn(),
    ingest: vi.fn(),
    on: vi.fn(),
    prewarm: vi.fn(),
    start: vi.fn(),
  };
  Reflect.apply(registerTranscriptionHandlers, undefined, [{
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager,
    terminalSubmit,
    transcriptionService,
  }]);
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`${channel} handler was not registered`);
  return handler;
}

describe('transcription user ingress routing', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
  });

  it('routes live and committed dictation bytes through writeUserInput', () => {
    // Given
    const write = vi.fn();
    const writeUserInput = vi.fn();
    registerWith({ write, writeUserInput }, { submitContent: vi.fn() });
    const liveWrite = listeners.get(IPC.TRANSCRIBE_LIVE_WRITE);
    if (!liveWrite) throw new Error('TRANSCRIBE_LIVE_WRITE listener was not registered');

    // When
    liveWrite(undefined, 'session-1', 'partial');
    const result = getHandler(IPC.TRANSCRIBE_COMMIT)(undefined, 'session-1', ' final\ntext ');

    // Then
    expect(result).toBe(true);
    expect(writeUserInput).toHaveBeenNthCalledWith(1, 'session-1', 'partial');
    expect(writeUserInput).toHaveBeenNthCalledWith(2, 'session-1', 'final text');
    expect(write).not.toHaveBeenCalled();
  });

  it('acquires the user submission lease before erasing and runs submit once through it', async () => {
    // Given
    const events: string[] = [];
    const submitContent = vi.fn(async () => {
      events.push('submit');
    });
    const release = vi.fn(() => events.push('release'));
    const run = vi.fn(async (submit: () => Promise<unknown>) => {
      events.push('run');
      return submit();
    });
    const acquireUserSubmission = vi.fn(() => {
      events.push('acquire');
      return { release, run };
    });
    const writeUserInput = vi.fn(() => events.push('erase'));
    const write = vi.fn(() => events.push('legacy-write'));
    registerWith({ acquireUserSubmission, write, writeUserInput }, { submitContent });

    // When
    const result = await getHandler(IPC.TRANSCRIBE_SUBMIT)(undefined, 'session-1', ' final\ntext ', 3);

    // Then
    expect(result).toBe(true);
    expect(events).toEqual(['acquire', 'erase', 'run', 'submit', 'release']);
    expect(writeUserInput).toHaveBeenCalledWith('session-1', '\x7f\x7f\x7f');
    expect(acquireUserSubmission).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(submitContent).toHaveBeenCalledOnce();
    expect(submitContent).toHaveBeenCalledWith('session-1', 'final text', { source: 'dictation' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a missing lease without erasing', async () => {
    // Given
    const events: string[] = [];
    const writeUserInput = vi.fn(() => events.push('erase'));
    const acquireUserSubmission = vi.fn(() => {
      events.push('acquire');
      return null;
    });
    const write = vi.fn(() => events.push('legacy-write'));
    registerWith({ acquireUserSubmission, write, writeUserInput }, { submitContent: vi.fn() });

    // When
    const submission = getHandler(IPC.TRANSCRIBE_SUBMIT)(undefined, 'session-1', 'text', 1);

    // Then
    await expect(submission).rejects.toThrow('Session is not accepting input');
    expect(events).toEqual(['acquire']);
    expect(writeUserInput).not.toHaveBeenCalled();
  });

  it('preserves the false result and releases the lease when submit rejects', async () => {
    // Given
    const release = vi.fn();
    const run = vi.fn((submit: () => Promise<unknown>) => submit());
    registerWith(
      {
        acquireUserSubmission: vi.fn(() => ({ release, run })),
        writeUserInput: vi.fn(),
      },
      { submitContent: vi.fn(() => Promise.reject(new Error('submit failed'))) },
    );

    // When
    const result = await getHandler(IPC.TRANSCRIBE_SUBMIT)(undefined, 'session-1', 'text', 0);

    // Then
    expect(result).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
