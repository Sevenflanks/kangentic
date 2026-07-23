import { describe, expect, it, vi } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleAnswerPermissionPrompt } from '../../src/main/mobile-bridge/handlers/answer-permission-prompt';
import { handleInteractiveTerminal } from '../../src/main/mobile-bridge/handlers/interactive-terminal';
import { handleSendUserMessage } from '../../src/main/mobile-bridge/handlers/send-user-message';
import { SubscriptionRegistry } from '../../src/main/mobile-bridge/session/subscription-registry';

function request(verb: CapabilityRequestMessage['verb'], payload: CapabilityRequestMessage['payload']): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'request-1', verb, payload };
}

describe('mobile user ingress routing', () => {
  it('routes interactive terminal writes through writeUserInput', () => {
    // Given
    const write = vi.fn();
    const writeUserInput = vi.fn();
    const context = {
      sessionManager: {
        getSession: vi.fn(() => ({ id: 'session-1' })),
        isWritable: vi.fn(() => true),
        write,
        writeUserInput,
      },
    };

    // When
    const response = Reflect.apply(handleInteractiveTerminal, undefined, [
      request('interactive-terminal', { sessionId: 'session-1', data: 'typed' }),
      context,
      new SubscriptionRegistry(),
    ]);

    // Then
    expect(response).toMatchObject({ ok: true, payload: { written: true } });
    expect(writeUserInput).toHaveBeenCalledWith('session-1', 'typed');
    expect(write).not.toHaveBeenCalled();
  });

  it('routes matching permission keystrokes through writeUserInput', () => {
    // Given
    const write = vi.fn();
    const writeUserInput = vi.fn();
    const context = {
      sessionManager: {
        getActivityStatsSnapshot: vi.fn(() => ({
          permissionAwaitedToolId: 'tool-1',
          permissionPending: true,
        })),
        getSession: vi.fn(() => ({ id: 'session-1' })),
        isWritable: vi.fn(() => true),
        write,
        writeUserInput,
      },
    };

    // When
    const response = Reflect.apply(handleAnswerPermissionPrompt, undefined, [
      request('answer-permission-prompt', {
        keystrokes: '1\r',
        promptId: 'session-1:tool-1',
        sessionId: 'session-1',
      }),
      context,
    ]);

    // Then
    expect(response).toMatchObject({ ok: true, payload: { answered: true } });
    expect(writeUserInput).toHaveBeenCalledWith('session-1', '1\r');
    expect(write).not.toHaveBeenCalled();
  });

  it('runs mobile message submission once through one lease and releases it', async () => {
    // Given
    const events: string[] = [];
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
    const context = {
      sessionManager: {
        acquireUserSubmission,
        getSession: vi.fn(() => ({ id: 'session-1' })),
      },
      terminalSubmit: { submitContent },
    };

    // When
    const response = await Reflect.apply(handleSendUserMessage, undefined, [
      request('send-user-message', { sessionId: 'session-1', text: 'continue' }),
      context,
    ]);

    // Then
    expect(response).toMatchObject({ ok: true, payload: { delivered: true } });
    expect(events).toEqual(['acquire', 'run', 'submit', 'release']);
    expect(acquireUserSubmission).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(submitContent).toHaveBeenCalledOnce();
    expect(submitContent).toHaveBeenCalledWith('session-1', 'continue', { source: 'mobile-bridge' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects mobile message submission when no lease is available', async () => {
    // Given
    const submitContent = vi.fn();
    const context = {
      sessionManager: {
        acquireUserSubmission: vi.fn(() => null),
        getSession: vi.fn(() => ({ id: 'session-1' })),
      },
      terminalSubmit: { submitContent },
    };

    // When
    const submission = Reflect.apply(handleSendUserMessage, undefined, [
      request('send-user-message', { sessionId: 'session-1', text: 'continue' }),
      context,
    ]);

    // Then
    await expect(submission).rejects.toThrow('Session is not accepting input');
    expect(submitContent).not.toHaveBeenCalled();
  });

  it('releases the mobile submission lease when submit rejects', async () => {
    // Given
    const submitError = new Error('submit failed');
    const release = vi.fn();
    const run = vi.fn((submit: () => Promise<unknown>) => submit());
    const context = {
      sessionManager: {
        acquireUserSubmission: vi.fn(() => ({ release, run })),
        getSession: vi.fn(() => ({ id: 'session-1' })),
      },
      terminalSubmit: { submitContent: vi.fn(() => Promise.reject(submitError)) },
    };

    // When
    const submission = Reflect.apply(handleSendUserMessage, undefined, [
      request('send-user-message', { sessionId: 'session-1', text: 'continue' }),
      context,
    ]);

    // Then
    await expect(submission).rejects.toBe(submitError);
    expect(release).toHaveBeenCalledOnce();
  });
});
