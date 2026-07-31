import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeferred,
  createOpenCodePluginFixture,
  EVENTS_PATH_ENV,
  INITIAL_PROMPT_PATH_ENV,
  TUI_INITIAL_PROMPT_PATH_ENV,
} from './helpers/opencode-plugin-fixture';

const {
  cleanup,
  loadPlugin,
  makeRootClient,
  makeTemporaryDirectory,
  readEvents,
  writePayload,
} = createOpenCodePluginFixture();

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers());

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
