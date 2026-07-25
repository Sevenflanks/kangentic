import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

describe('opencode-plugin', () => {
  describe('adapter-managed initial prompt delivery', () => {
    it('claims a fresh payload and submits its exact prompt through the root session API', async () => {
      const pluginModule = await loadPlugin();
      const plugin = pluginModule.KangenticActivity;
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
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
        return { data: { id: 'ses_fresh_123' } };
      });
      root.promptAsync.mockImplementation(async () => {
        const turnStart = pluginModule.extractToolStartEvent(
          { tool: 'bash', sessionID: 'ses_fresh_123' },
          { args: { command: 'pwd' } },
          1717000000001,
        );
        expect(turnStart.privateNativeBoundary).toEqual({
          kind: 'turn-start',
          nativeSessionId: 'ses_fresh_123',
          occurredAt: 1717000000001,
        });
      });
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      await plugin({ client: root.client, directory });

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
      expect(readEvents(eventsPath)).toEqual([{
        ts: expect.any(Number),
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_fresh_123' }),
        privateNativeBoundary: {
          kind: 'created',
          nativeSessionId: 'ses_fresh_123',
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

      const hooks = await plugin({ client: root.client, directory });
      await hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_recovered_123' } } },
      });

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

      const hooks = await plugin({ client: root.client, directory });
      await hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_bootstrap_123' } } },
      });
      await hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_later_123' } } },
      });
      await hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_later_123' } } },
      });

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

      await plugin({ client: root.client, directory });

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

      await plugin({ client: root.client, directory });

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

      await plugin({ client: root.client, directory });

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
