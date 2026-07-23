import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

const { events, handlers } = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
  },
  session: { fromPartition: vi.fn() },
}));
vi.mock('node:fs', () => ({
  default: {
    promises: {
      mkdir: vi.fn(async () => events.push('mkdir')),
      writeFile: vi.fn(async () => events.push('write-file')),
    },
    readdirSync: vi.fn(() => []),
  },
}));
vi.mock('../../src/main/ipc/handlers/browser-payload', () => ({
  buildPromptPayload: vi.fn(() => {
    events.push('payload');
    return 'capture payload';
  }),
  isCrossDrivePath: vi.fn(() => false),
  isValidSessionId: vi.fn(() => true),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn(() => {
      events.push('verifier');
      return { getSubmissionVerifier: vi.fn(() => 'verification') };
    }),
  },
}));
vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: { clear: vi.fn(), get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { register: vi.fn(), unregister: vi.fn(), unregisterIfMatches: vi.fn() },
}));

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';

function captureHandler(): (...args: unknown[]) => unknown {
  const handler = handlers.get(IPC.BROWSER_CAPTURE_SEND);
  if (!handler) throw new Error('BROWSER_CAPTURE_SEND handler was not registered');
  return handler;
}

function captureInput(): object {
  return {
    cwd: '/project',
    pngBase64: 'cG5n',
    sessionId: '00000000-0000-4000-8000-000000000001',
  };
}

describe('browser capture user submission', () => {
  beforeEach(() => {
    events.length = 0;
    handlers.clear();
  });

  it('prepares the capture before running one submit through one lease', async () => {
    // Given
    const submitContent = vi.fn(async () => events.push('submit'));
    const release = vi.fn(() => events.push('release'));
    const run = vi.fn(async (submit: () => Promise<unknown>) => {
      events.push('run');
      return submit();
    });
    const acquireUserSubmission = vi.fn(() => {
      events.push('acquire');
      return { release, run };
    });
    Reflect.apply(registerBrowserHandlers, undefined, [{
      currentProjectPath: '/project',
      sessionManager: {
        acquireUserSubmission,
        getSessionAgentName: vi.fn(() => 'opencode'),
      },
      terminalSubmit: { submitContent },
    }]);

    // When
    const result = await captureHandler()(undefined, captureInput());

    // Then
    expect(result).toMatchObject({ filePath: expect.stringContaining('capture-') });
    expect(events).toEqual(['mkdir', 'write-file', 'payload', 'verifier', 'acquire', 'run', 'submit', 'release']);
    expect(acquireUserSubmission).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(submitContent).toHaveBeenCalledOnce();
    expect(submitContent).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'capture payload',
      { bracketed: true, source: 'browser-capture', verifier: 'verification' },
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a missing lease only after capture preparation', async () => {
    // Given
    const submitContent = vi.fn();
    const acquireUserSubmission = vi.fn(() => {
      events.push('acquire');
      return null;
    });
    Reflect.apply(registerBrowserHandlers, undefined, [{
      currentProjectPath: '/project',
      sessionManager: {
        acquireUserSubmission,
        getSessionAgentName: vi.fn(() => 'opencode'),
      },
      terminalSubmit: { submitContent },
    }]);

    // When
    const submission = captureHandler()(undefined, captureInput());

    // Then
    await expect(submission).rejects.toThrow('Session is not accepting input');
    expect(events).toEqual(['mkdir', 'write-file', 'payload', 'verifier', 'acquire']);
    expect(submitContent).not.toHaveBeenCalled();
  });

  it('releases the lease when terminal submission rejects', async () => {
    // Given
    const submitError = new Error('submit failed');
    const release = vi.fn();
    const run = vi.fn((submit: () => Promise<unknown>) => submit());
    Reflect.apply(registerBrowserHandlers, undefined, [{
      currentProjectPath: '/project',
      sessionManager: {
        acquireUserSubmission: vi.fn(() => ({ release, run })),
        getSessionAgentName: vi.fn(() => 'opencode'),
      },
      terminalSubmit: { submitContent: vi.fn(() => Promise.reject(submitError)) },
    }]);

    // When
    const submission = captureHandler()(undefined, captureInput());

    // Then
    await expect(submission).rejects.toBe(submitError);
    expect(release).toHaveBeenCalledOnce();
  });
});
