import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeferred,
  createOpenCodePluginFixture,
  EVENTS_PATH_ENV,
  INITIAL_PROMPT_PATH_ENV,
  RESUME_SESSION_ID_ENV,
  TUI_CONFIG_PATH_ENV,
  TUI_INITIAL_PROMPT_PATH_ENV,
} from './helpers/opencode-plugin-fixture';

const {
  clearBootstrapEnvironment,
  cleanup,
  loadPlugin,
  makeRootClient,
  makeTemporaryDirectory,
  readEvents,
  writePayload,
} = createOpenCodePluginFixture();

afterEach(cleanup);
beforeEach(() => {
  clearBootstrapEnvironment();
  vi.useFakeTimers();
});

function makeControlledResumeClient(sessionId = 'ses_resume_123') {
  const getCalled = createDeferred<void>();
  const getResult = createDeferred<{ readonly data: { readonly id: string } }>();
  const promptCalled = createDeferred<void>();
  const promptResult = createDeferred<void>();
  const get = vi.fn(() => {
    getCalled.resolve(undefined);
    return getResult.promise;
  });
  const promptAsync = vi.fn(() => {
    promptCalled.resolve(undefined);
    return promptResult.promise;
  });
  return {
    client: {
      session: {
        create: vi.fn(async () => ({ data: { id: sessionId } })),
        get,
        promptAsync,
      },
    },
    get,
    getCalled,
    getResult,
    promptAsync,
    promptCalled,
    promptResult,
  };
}

describe('OpenCode server activity plugin', () => {
  it('clears inherited bootstrap environment and restores exact host values on cleanup', () => {
    const inheritedEnvironment = {
      [INITIAL_PROMPT_PATH_ENV]: 'host-initial-prompt',
      [TUI_INITIAL_PROMPT_PATH_ENV]: 'host-tui-prompt',
      [RESUME_SESSION_ID_ENV]: 'host-resume-session',
      [TUI_CONFIG_PATH_ENV]: 'host-tui-config',
      [EVENTS_PATH_ENV]: 'host-events',
    };
    for (const [key, value] of Object.entries(inheritedEnvironment)) {
      process.env[key] = value;
    }

    const hostFixture = createOpenCodePluginFixture();

    for (const key of Object.keys(inheritedEnvironment)) {
      expect(process.env[key]).toBeUndefined();
    }

    hostFixture.cleanup();

    for (const [key, value] of Object.entries(inheritedEnvironment)) {
      expect(process.env[key]).toBe(value);
    }
  });

  it('loads the installed .js asset through the same ESM envelope as mock OpenCode', async () => {
    const directory = makeTemporaryDirectory();
    const pluginDirectory = path.join(directory, '.opencode', 'plugins');
    const installedPath = path.join(pluginDirectory, 'kangentic-activity.js');
    const sourcePath = path.join(
      process.cwd(),
      'src',
      'main',
      'agent',
      'adapters',
      'opencode',
      'plugin',
      'kangentic-activity.mjs',
    );
    fs.mkdirSync(pluginDirectory, { recursive: true });
    fs.copyFileSync(sourcePath, installedPath);
    const pluginUrl = `data:text/javascript;base64,${fs.readFileSync(installedPath).toString('base64')}`;

    const installedModule = await import(pluginUrl);

    expect(installedModule.KangenticActivity).toEqual(expect.any(Function));
  });

  it('returns synchronous telemetry hooks without starting a fresh bootstrap', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque fresh payload',
    });
    const root = makeRootClient();
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;

    const hooks = plugin({ client: root.client, directory });
    vi.runOnlyPendingTimers();

    expect(hooks).not.toBeInstanceOf(Promise);
    expect(hooks.event({ event: { type: 'unrecognized' } })).toBeUndefined();
    expect(hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'pwd' } })).toBeUndefined();
    expect(hooks['tool.execute.after']({ tool: 'bash' })).toBeUndefined();
    expect(root.create).not.toHaveBeenCalled();
    expect(root.promptAsync).not.toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it('emits native fresh-session telemetry without taking bootstrap ownership', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const root = makeRootClient();
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: root.client, directory });
    hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'ses_tui_telemetry_123' } } },
    });

    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: 'ses_tui_telemetry_123' }),
    })]);
  });

  it('validates a resume session and submits through the server-plugin client path', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'resume',
      prompt: 'resume payload',
      sessionId: 'ses_resume_123',
    });
    const root = makeControlledResumeClient();
    process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    plugin({ client: root.client, directory });
    vi.runOnlyPendingTimers();
    await root.getCalled.promise;
    root.getResult.resolve({ data: { id: 'ses_resume_123' } });
    await root.promptCalled.promise;

    expect(root.get).toHaveBeenCalledWith({
      path: { id: 'ses_resume_123' },
      query: { directory },
      throwOnError: true,
    });
    expect(root.promptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_resume_123' },
      query: { directory },
      body: { parts: [{ type: 'text', text: 'resume payload' }] },
      throwOnError: true,
    });
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: 'ses_resume_123' }),
    })]);
    root.promptResult.resolve(undefined);
  });

  it('validates a promptless local resume environment and emits one session_start without submitting', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sessionId = 'ses_promptless_resume_123';
    const root = makeRootClient(sessionId);
    process.env[RESUME_SESSION_ID_ENV] = sessionId;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: root.client, directory });
    vi.runOnlyPendingTimers();
    await vi.runAllTimersAsync();

    hooks.event({
      event: { type: 'session.created', properties: { info: { id: sessionId } } },
    });

    expect(root.get).toHaveBeenCalledWith({
      path: { id: sessionId },
      query: { directory },
      throwOnError: true,
    });
    expect(root.promptAsync).not.toHaveBeenCalled();
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: sessionId }),
    })]);
  });

  it('defers a synchronous matching promptless resume session.created event until validation', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sessionId = 'ses_promptless_sync_123';
    const root = makeControlledResumeClient(sessionId);
    process.env[RESUME_SESSION_ID_ENV] = sessionId;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: root.client, directory });
    hooks.event({
      event: { type: 'session.created', properties: { info: { id: sessionId } } },
    });

    expect(readEvents(eventsPath)).toEqual([]);

    vi.runOnlyPendingTimers();
    await root.getCalled.promise;

    expect(readEvents(eventsPath)).toEqual([]);

    root.getResult.resolve({ data: { id: sessionId } });
    await vi.runAllTimersAsync();

    expect(root.get).toHaveBeenCalledOnce();
    expect(root.promptAsync).not.toHaveBeenCalled();
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: sessionId }),
    })]);
  });

  it('uses an observed resume ID that differs before validation starts', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const requestedSessionId = 'ses_requested_before_123';
    const observedSessionId = 'ses_observed_before_456';
    const root = makeControlledResumeClient(observedSessionId);
    process.env[RESUME_SESSION_ID_ENV] = requestedSessionId;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: root.client, directory });
    hooks.event({
      event: { type: 'session.created', properties: { info: { id: observedSessionId } } },
    });
    vi.runOnlyPendingTimers();
    await root.getCalled.promise;

    expect(root.get).toHaveBeenCalledWith({
      path: { id: observedSessionId },
      query: { directory },
      throwOnError: true,
    });
    expect(readEvents(eventsPath)).toEqual([]);

    root.getResult.resolve({ data: { id: observedSessionId } });
    await vi.runAllTimersAsync();

    expect(root.promptAsync).not.toHaveBeenCalled();
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: observedSessionId }),
    })]);
  });

  it('revalidates an observed resume ID that changes while validation is pending', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const requestedSessionId = 'ses_requested_during_123';
    const observedSessionId = 'ses_observed_during_456';
    const requestedResult = createDeferred<{ readonly data: { readonly id: string } }>();
    const observedResult = createDeferred<{ readonly data: { readonly id: string } }>();
    const observedGetCalled = createDeferred<void>();
    const get = vi.fn()
      .mockImplementationOnce(() => requestedResult.promise)
      .mockImplementationOnce(() => {
        observedGetCalled.resolve(undefined);
        return observedResult.promise;
      });
    const promptAsync = vi.fn(async () => undefined);
    process.env[RESUME_SESSION_ID_ENV] = requestedSessionId;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: { session: { get, promptAsync } }, directory });
    vi.runOnlyPendingTimers();
    expect(get).toHaveBeenCalledWith({
      path: { id: requestedSessionId },
      query: { directory },
      throwOnError: true,
    });

    hooks.event({
      event: { type: 'session.created', properties: { info: { id: observedSessionId } } },
    });
    requestedResult.resolve({ data: { id: requestedSessionId } });
    await observedGetCalled.promise;

    expect(get).toHaveBeenLastCalledWith({
      path: { id: observedSessionId },
      query: { directory },
      throwOnError: true,
    });
    expect(readEvents(eventsPath)).toEqual([]);

    observedResult.resolve({ data: { id: observedSessionId } });
    await vi.runAllTimersAsync();

    expect(promptAsync).not.toHaveBeenCalled();
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: observedSessionId }),
    })]);
  });

  it('revalidates an observed promptless resume ID when requested validation rejects', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const requestedSessionId = 'ses_requested_rejected_promptless_123';
    const observedSessionId = 'ses_observed_rejected_promptless_456';
    const requestedResult = createDeferred<{ readonly data: { readonly id: string } }>();
    const observedResult = createDeferred<{ readonly data: { readonly id: string } }>();
    const get = vi.fn()
      .mockImplementationOnce(() => requestedResult.promise)
      .mockImplementationOnce(() => observedResult.promise);
    const promptAsync = vi.fn(async () => undefined);
    process.env[RESUME_SESSION_ID_ENV] = requestedSessionId;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: { session: { get, promptAsync } }, directory });
    vi.runOnlyPendingTimers();
    hooks.event({
      event: { type: 'session.created', properties: { info: { id: observedSessionId } } },
    });
    requestedResult.reject(new Error('requested session is unavailable'));
    await Promise.resolve();

    expect(get).toHaveBeenLastCalledWith({
      path: { id: observedSessionId },
      query: { directory },
      throwOnError: true,
    });
    expect(readEvents(eventsPath)).toEqual([]);

    observedResult.resolve({ data: { id: observedSessionId } });
    await vi.runAllTimersAsync();

    expect(get).toHaveBeenCalledTimes(2);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: observedSessionId }),
    })]);
  });

  it('submits a prompt to an observed resume ID when requested validation rejects', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const requestedSessionId = 'ses_requested_rejected_prompt_123';
    const observedSessionId = 'ses_observed_rejected_prompt_456';
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'resume',
      prompt: 'continue observed session',
      sessionId: requestedSessionId,
    });
    const requestedResult = createDeferred<{ readonly data: { readonly id: string } }>();
    const observedResult = createDeferred<{ readonly data: { readonly id: string } }>();
    const promptCalled = createDeferred<void>();
    const promptResult = createDeferred<void>();
    const get = vi.fn()
      .mockImplementationOnce(() => requestedResult.promise)
      .mockImplementationOnce(() => observedResult.promise);
    const promptAsync = vi.fn(() => {
      promptCalled.resolve(undefined);
      return promptResult.promise;
    });
    process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: { session: { get, promptAsync } }, directory });
    vi.runOnlyPendingTimers();
    hooks.event({
      event: { type: 'session.created', properties: { info: { id: observedSessionId } } },
    });
    requestedResult.reject(new Error('requested session is unavailable'));
    await Promise.resolve();

    expect(get).toHaveBeenLastCalledWith({
      path: { id: observedSessionId },
      query: { directory },
      throwOnError: true,
    });
    expect(readEvents(eventsPath)).toEqual([]);

    observedResult.resolve({ data: { id: observedSessionId } });
    await promptCalled.promise;

    expect(get).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: observedSessionId },
      query: { directory },
      body: { parts: [{ type: 'text', text: 'continue observed session' }] },
      throwOnError: true,
    });
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: observedSessionId }),
    })]);
    promptResult.resolve(undefined);
  });

  it('keeps the validated resume root when a different session is observed after bootstrap', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sessionId = 'ses_validated_resume_123';
    const root = makeRootClient(sessionId);
    process.env[RESUME_SESSION_ID_ENV] = sessionId;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    const hooks = plugin({ client: root.client, directory });
    vi.runOnlyPendingTimers();
    await vi.runAllTimersAsync();

    hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'ses_post_bootstrap_456' } } },
    });

    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: sessionId }),
    })]);
  });

  it('deduplicates an early matching resume session.created event', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sessionId = 'ses_resume_early_123';
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'resume',
      prompt: 'opaque resume early-event payload',
      sessionId,
    });
    const root = makeControlledResumeClient(sessionId);
    process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;
    const hooks = plugin({ client: root.client, directory });
    vi.runOnlyPendingTimers();
    await root.getCalled.promise;

    hooks.event({
      event: { type: 'session.created', properties: { info: { id: sessionId } } },
    });
    root.getResult.resolve({ data: { id: sessionId } });
    await root.promptCalled.promise;

    expect(root.get).toHaveBeenCalledOnce();
    expect(root.promptAsync).toHaveBeenCalledOnce();
    expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID: sessionId }),
    })]);
    root.promptResult.resolve(undefined);
  });
});
