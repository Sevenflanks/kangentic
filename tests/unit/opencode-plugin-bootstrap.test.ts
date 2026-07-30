import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeferred,
  createOpenCodePluginFixture,
  EVENTS_PATH_ENV,
  INITIAL_PROMPT_PATH_ENV,
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

function makeControlledClient(createdSessionId = 'ses_created_123') {
  const createCalled = createDeferred<void>();
  const createResult = createDeferred<{ readonly data: { readonly id: string } }>();
  const getCalled = createDeferred<void>();
  const getResult = createDeferred<{ readonly data: { readonly id: string } }>();
  const publishCalled = createDeferred<void>();
  const publishResult = createDeferred<{ readonly data: boolean }>();
  const promptCalled = createDeferred<void>();
  const promptResult = createDeferred<void>();
  const create = vi.fn(() => {
    createCalled.resolve(undefined);
    return createResult.promise;
  });
  const get = vi.fn(() => {
    getCalled.resolve(undefined);
    return getResult.promise;
  });
  const publish = vi.fn(() => {
    publishCalled.resolve(undefined);
    return publishResult.promise;
  });
  const promptAsync = vi.fn(() => {
    promptCalled.resolve(undefined);
    return promptResult.promise;
  });
  const command = vi.fn(async () => undefined);

  return {
    client: {
      session: { command, create, get, promptAsync },
      tui: { publish },
    },
    command,
    create,
    createCalled,
    createResult,
    createdSessionId,
    get,
    getCalled,
    getResult,
    promptAsync,
    promptCalled,
    promptResult,
    publish,
    publishCalled,
    publishResult,
  };
}

describe('opencode-plugin', () => {
  describe('adapter-managed initial prompt delivery', () => {
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
      const pluginBytes = fs.readFileSync(installedPath);
      const pluginUrl = `data:text/javascript;base64,${pluginBytes.toString('base64')}`;

      const installedModule = await import(pluginUrl);

      expect(installedModule.KangenticActivity).toEqual(expect.any(Function));
    });

    it('returns plain hooks synchronously and every hook returns undefined', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const root = makeRootClient();

      const hooks = plugin({ client: root.client, directory: makeTemporaryDirectory() });

      expect(hooks).not.toBeInstanceOf(Promise);
      expect(hooks.event({ event: { type: 'unrecognized' } })).toBeUndefined();
      expect(hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'pwd' } })).toBeUndefined();
      expect(hooks['tool.execute.after']({ tool: 'bash' })).toBeUndefined();
    });

    it('defers all bootstrap I/O until the single zero-delay timer runs', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'deferred bootstrap prompt',
      });
      const root = makeControlledClient();
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      const hooks = plugin({ client: root.client, directory });

      expect(hooks).not.toBeInstanceOf(Promise);
      expect(root.create).not.toHaveBeenCalled();
      expect(root.get).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(readEvents(eventsPath)).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('claims an early matching native start before bootstrap telemetry and prompts once', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'early matching prompt',
      });
      const root = makeControlledClient('ses_early_match');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;
      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.createCalled.promise;

      expect(hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_early_match' } } },
      })).toBeUndefined();
      expect(readEvents(eventsPath)).toEqual([]);
      root.createResult.resolve({ data: { id: 'ses_early_match' } });
      await root.publishCalled.promise;

      expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_early_match' }),
      })]);
      root.publishResult.resolve({ data: true });
      await root.promptCalled.promise;
      expect(root.promptAsync).toHaveBeenCalledTimes(1);
      root.promptResult.resolve(undefined);
    });

    it('keeps one late matching start and preserves unrelated duplicates', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'late matching prompt',
      });
      const root = makeControlledClient('ses_late_match');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;
      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.createCalled.promise;
      root.createResult.resolve({ data: { id: 'ses_late_match' } });
      await root.publishCalled.promise;

      hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_late_match' } } } });
      hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_unrelated' } } } });
      hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_unrelated' } } } });

      const sessionIds = readEvents(eventsPath).map((event) => event.hookContext);
      expect(sessionIds).toEqual([
        JSON.stringify({ sessionID: 'ses_late_match' }),
        JSON.stringify({ sessionID: 'ses_unrelated' }),
        JSON.stringify({ sessionID: 'ses_unrelated' }),
      ]);
      root.publishResult.resolve({ data: true });
      await root.promptCalled.promise;
      root.promptResult.resolve(undefined);
    });

    it('replays unrelated early starts in order after claiming only the first matching start', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'ordered replay prompt',
      });
      const root = makeControlledClient('ses_claimed');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;
      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.createCalled.promise;

      hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_first_unrelated' } } } });
      hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_claimed' } } } });
      hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_second_unrelated' } } } });
      hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_claimed' } } } });
      root.createResult.resolve({ data: { id: 'ses_claimed' } });
      await root.publishCalled.promise;

      expect(readEvents(eventsPath).map((event) => event.hookContext)).toEqual([
        JSON.stringify({ sessionID: 'ses_claimed' }),
        JSON.stringify({ sessionID: 'ses_first_unrelated' }),
        JSON.stringify({ sessionID: 'ses_second_unrelated' }),
      ]);
      root.publishResult.resolve({ data: true });
      await root.promptCalled.promise;
      root.promptResult.resolve(undefined);
    });

    it('recovers a failed synthetic append from a later matching native start without SDK retry', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'append recovery prompt',
      });
      const root = makeControlledClient('ses_append_recovery');
      vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
        throw new Error('expected append failure');
      });
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;
      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.createCalled.promise;
      root.createResult.resolve({ data: { id: 'ses_append_recovery' } });
      await root.publishCalled.promise;

      expect(readEvents(eventsPath)).toEqual([]);
      hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_append_recovery' } } },
      });

      expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_append_recovery' }),
      })]);
      expect(root.create).toHaveBeenCalledTimes(1);
      root.publishResult.resolve({ data: true });
      await root.promptCalled.promise;
      expect(root.promptAsync).toHaveBeenCalledTimes(1);
      root.promptResult.resolve(undefined);
    });

    it('sets resume identity before get so an early native start replaces the synthetic start', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'resume',
        prompt: 'resume early start prompt',
        sessionId: 'ses_resume_early',
      });
      const root = makeControlledClient();
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;
      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.getCalled.promise;

      hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_resume_early' } } },
      });
      root.getResult.resolve({ data: { id: 'ses_resume_early' } });
      await root.promptCalled.promise;

      expect(root.create).not.toHaveBeenCalled();
      expect(root.publish).not.toHaveBeenCalled();
      expect(root.get).toHaveBeenCalledTimes(1);
      expect(root.promptAsync).toHaveBeenCalledTimes(1);
      expect(readEvents(eventsPath)).toEqual([expect.objectContaining({
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_resume_early' }),
      })]);
      root.promptResult.resolve(undefined);
    });

    it('claims a fresh payload and submits its exact prompt through the root session API', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'fresh payload text',
        agent: 'plan',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      });
      const root = makeRootClient();
      const appendSpy = vi.spyOn(fs, 'appendFileSync');
      const renameSpy = vi.spyOn(fs, 'renameSync');
      root.create.mockImplementation(async () => {
        root.createCalled.resolve(undefined);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
        return { data: { id: 'ses_fresh_123' } };
      });
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      const hooks = plugin({ client: root.client, directory });
      expect(hooks).not.toBeInstanceOf(Promise);
      vi.runOnlyPendingTimers();
      await root.promptCalled.promise;
      hooks['tool.execute.before'](
        { tool: 'bash', sessionID: 'ses_fresh_123' },
        { args: { command: 'pwd' } },
      );

      expect(renameSpy).toHaveBeenCalledWith(sourcePath, expect.stringContaining('.claim-'));
      expect(root.create).toHaveBeenCalledWith({
        query: { directory },
        body: {},
        throwOnError: true,
      });
      expect(root.publish).toHaveBeenCalledWith({
        query: { directory },
        body: {
          type: 'tui.session.select',
          properties: { sessionID: 'ses_fresh_123' },
        },
        throwOnError: true,
      });
      expect(root.promptAsync).toHaveBeenCalledWith({
        path: { id: 'ses_fresh_123' },
        query: { directory },
        body: {
          parts: [{ type: 'text', text: 'fresh payload text' }],
          agent: 'plan',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
        },
        throwOnError: true,
      });
      expect(root.command).not.toHaveBeenCalled();
      expect(readEvents(eventsPath)).toEqual([
        {
          ts: expect.any(Number),
          type: 'session_start',
          hookContext: JSON.stringify({ sessionID: 'ses_fresh_123' }),
          privateNativeBoundary: {
            kind: 'created',
            nativeSessionId: 'ses_fresh_123',
            occurredAt: expect.any(Number),
          },
        },
        {
          ts: expect.any(Number),
          type: 'tool_start',
          tool: 'bash',
          detail: 'pwd',
          privateNativeBoundary: {
            kind: 'turn-start',
            nativeSessionId: 'ses_fresh_123',
            occurredAt: expect.any(Number),
          },
        },
      ]);
      const sessionStartAppendIndex = appendSpy.mock.calls.findIndex(([, payload]) => (
        String(payload).includes('"type":"session_start"')
      ));
      const sessionStartCallOrder = appendSpy.mock.invocationCallOrder[sessionStartAppendIndex];
      const promptCallOrder = root.promptAsync.mock.invocationCallOrder[0];
      expect(sessionStartCallOrder).toBeDefined();
      expect(promptCallOrder).toBeDefined();
      if (sessionStartCallOrder === undefined || promptCallOrder === undefined) return;
      expect(sessionStartCallOrder).toBeLessThan(promptCallOrder);
    });

    it('writes native session.created exactly once after synthetic session_start append fails', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'recover session_start after transient append failure',
      });
      const root = makeRootClient('ses_recovered_123');
      const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
        throw new Error('transient append failure');
      });
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.promptCalled.promise;
      expect(hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_recovered_123' } } },
      })).toBeUndefined();

      expect(root.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
        path: { id: 'ses_recovered_123' },
      }));
      expect(appendSpy).toHaveBeenCalledTimes(2);
      expect(readEvents(eventsPath)).toEqual([{
        ts: expect.any(Number),
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_recovered_123' }),
        privateNativeBoundary: {
          kind: 'created',
          nativeSessionId: 'ses_recovered_123',
          occurredAt: expect.any(Number),
        },
      }]);
    });

    it('suppresses only the successful bootstrap duplicate and appends repeated later sessions', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'bootstrap session followed by later native sessions',
      });
      const root = makeRootClient('ses_bootstrap_123');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.promptCalled.promise;
      expect(hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_bootstrap_123' } } },
      })).toBeUndefined();
      expect(hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_later_123' } } },
      })).toBeUndefined();
      expect(hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_later_123' } } },
      })).toBeUndefined();

      expect(readEvents(eventsPath)).toEqual([
        {
          ts: expect.any(Number),
          type: 'session_start',
          hookContext: JSON.stringify({ sessionID: 'ses_bootstrap_123' }),
          privateNativeBoundary: {
            kind: 'created',
            nativeSessionId: 'ses_bootstrap_123',
            occurredAt: expect.any(Number),
          },
        },
        {
          ts: expect.any(Number),
          type: 'session_start',
          hookContext: JSON.stringify({ sessionID: 'ses_later_123' }),
          privateNativeBoundary: {
            kind: 'created',
            nativeSessionId: 'ses_later_123',
            occurredAt: expect.any(Number),
          },
        },
        {
          ts: expect.any(Number),
          type: 'session_start',
          hookContext: JSON.stringify({ sessionID: 'ses_later_123' }),
          privateNativeBoundary: {
            kind: 'created',
            nativeSessionId: 'ses_later_123',
            occurredAt: expect.any(Number),
          },
        },
      ]);
    });

    it('gets the native resume session before submitting without fresh overrides', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'resume',
        prompt: 'resume payload text',
        sessionId: 'ses_resume_123',
      });
      const root = makeRootClient();
      const appendSpy = vi.spyOn(fs, 'appendFileSync');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.promptCalled.promise;

      expect(root.create).not.toHaveBeenCalled();
      expect(root.get).toHaveBeenCalledWith({
        path: { id: 'ses_resume_123' },
        query: { directory },
        throwOnError: true,
      });
      expect(root.publish).not.toHaveBeenCalled();
      expect(root.promptAsync).toHaveBeenCalledWith({
        path: { id: 'ses_resume_123' },
        query: { directory },
        body: { parts: [{ type: 'text', text: 'resume payload text' }] },
        throwOnError: true,
      });
      expect(readEvents(eventsPath)).toEqual([{
        ts: expect.any(Number),
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_resume_123' }),
        privateNativeBoundary: {
          kind: 'created',
          nativeSessionId: 'ses_resume_123',
          occurredAt: expect.any(Number),
        },
      }]);
      const sessionStartAppendIndex = appendSpy.mock.calls.findIndex(([, payload]) => (
        String(payload).includes('"type":"session_start"')
      ));
      const sessionStartCallOrder = appendSpy.mock.invocationCallOrder[sessionStartAppendIndex];
      const promptCallOrder = root.promptAsync.mock.invocationCallOrder[0];
      expect(sessionStartCallOrder).toBeDefined();
      expect(promptCallOrder).toBeDefined();
      if (sessionStartCallOrder === undefined || promptCallOrder === undefined) return;
      expect(sessionStartCallOrder).toBeLessThan(promptCallOrder);
    });

    it('passes a valid initial slash prompt through promptAsync as text and never command', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: '/compact retain task context',
      });
      const root = makeRootClient('ses_command_123');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.promptCalled.promise;

      expect(root.command).not.toHaveBeenCalled();
      expect(root.promptAsync).toHaveBeenCalledWith({
        path: { id: 'ses_command_123' },
        query: { directory },
        body: { parts: [{ type: 'text', text: '/compact retain task context' }] },
        throwOnError: true,
      });
    });

    it('passes a malformed slash bootstrap prompt through as plain text', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: '/   ',
      });
      const root = makeRootClient();
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.promptCalled.promise;

      expect(root.create).toHaveBeenCalledTimes(1);
      expect(root.promptAsync).toHaveBeenCalledWith({
        path: { id: 'ses_created_123' },
        query: { directory },
        body: { parts: [{ type: 'text', text: '/   ' }] },
        throwOnError: true,
      });
      expect(root.command).not.toHaveBeenCalled();
    });
  });
});
