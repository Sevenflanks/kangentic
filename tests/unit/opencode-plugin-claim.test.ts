import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeferred,
  createOpenCodePluginFixture,
  EVENTS_PATH_ENV,
  INITIAL_PROMPT_PATH_ENV,
} from './helpers/opencode-plugin-fixture';

const { cleanup, loadPlugin, makeRootClient, makeTemporaryDirectory, readEvents, writePayload } = createOpenCodePluginFixture();

const expectCombinedError = (
  event: ReturnType<typeof readEvents>[number],
  nativeSessionId: string | null,
) => {
  const boundary = event.privateNativeBoundary;
  expect(event).toEqual({
    ts: expect.any(Number),
    type: 'idle',
    detail: 'error',
    privateNativeBoundary: {
      kind: 'error',
      nativeSessionId,
      occurredAt: expect.any(Number),
    },
  });
  if (typeof boundary !== 'object' || boundary === null || !('occurredAt' in boundary)) {
    throw new TypeError('combined error is missing privateNativeBoundary.occurredAt');
  }
  expect(event.ts).toBe(boundary.occurredAt);
};

function captureSanitizedErrorAppend() {
  const errorWritten = createDeferred<void>();
  const originalAppendFileSync = fs.appendFileSync.bind(fs);
  const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data) => {
    originalAppendFileSync(file, data);
    if (String(data).includes('"type":"idle"') && String(data).includes('"detail":"error"')) {
      errorWritten.resolve(undefined);
    }
  });
  return { appendSpy, errorWritten };
}

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers());

describe('opencode-plugin', () => {
  describe('adapter-managed initial prompt delivery', () => {
    it('deletes the exact claim after read failure', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'read failure prompt',
      });
      const root = makeRootClient();
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('read failed');
      });
      const renameSpy = vi.spyOn(fs, 'renameSync');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();

      expect(readSpy).toHaveBeenCalled();
      expect(renameSpy).toHaveBeenCalled();
      expect(fs.existsSync(String(renameSpy.mock.calls[0][1]))).toBe(false);
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
    });

    it('verifies the claim is gone before payload use at the JSON.parse boundary', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const uniquePrompt = 'ordered prompt at parse boundary';
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: uniquePrompt,
      });
      const root = makeRootClient('ses_order_123');
      const renameSpy = vi.spyOn(fs, 'renameSync');
      const originalParse = JSON.parse.bind(JSON);
      let payloadParseCount = 0;
      vi.spyOn(JSON, 'parse').mockImplementation((rawText, reviver) => {
        if (rawText.includes(uniquePrompt)) {
          payloadParseCount += 1;
          const claimPath = renameSpy.mock.calls.find(([from]) => from === sourcePath)?.[1];
          expect(claimPath).toEqual(expect.stringContaining('.claim-'));
          expect(fs.existsSync(sourcePath)).toBe(false);
          expect(fs.existsSync(String(claimPath))).toBe(false);
        }
        return originalParse(rawText, reviver);
      });
      root.create.mockImplementation(async () => ({
        data: { id: 'ses_order_123' },
      }));
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.promptCalled.promise;

      expect(payloadParseCount).toBe(1);
      expect(renameSpy).toHaveBeenCalledWith(sourcePath, expect.stringContaining('.claim-'));
      expect(root.create).toHaveBeenCalledWith({
        query: { directory },
        body: {},
        throwOnError: true,
      });
      expect(root.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
        body: { parts: [{ type: 'text', text: uniquePrompt }] },
      }));
    });

    it('sanitizes unlink failures after rename without leaking prompt, path, or raw error details', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'unlink failure prompt',
      });
      const root = makeRootClient();
      const appendSpy = vi.spyOn(fs, 'appendFileSync');
      const renameSpy = vi.spyOn(fs, 'renameSync');
      const originalParse = JSON.parse.bind(JSON);
      const originalUnlink = fs.unlinkSync.bind(fs);
      let payloadParseCount = 0;
      vi.spyOn(JSON, 'parse').mockImplementation((rawText, reviver) => {
        if (rawText.includes('unlink failure prompt')) payloadParseCount += 1;
        return originalParse(rawText, reviver);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
        const targetPath = String(target);
        if (targetPath.startsWith(`${sourcePath}.claim-`)) {
          throw new Error(`unlink failed for ${targetPath}`);
        }
        return originalUnlink(target);
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();

      const claimPath = renameSpy.mock.calls.find(([from]) => from === sourcePath)?.[1];
      expect(claimPath).toEqual(expect.stringContaining('.claim-'));
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
      expect(unlinkSpy).toHaveBeenCalledWith(claimPath);
      expect(payloadParseCount).toBe(0);
      expect(root.create).not.toHaveBeenCalled();
      expect(root.get).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
      const events = readEvents(eventsPath);
      expect(events).toHaveLength(1);
      const errorEvent = events.at(-1);
      expect(errorEvent).toBeDefined();
      if (!errorEvent) throw new TypeError('missing unlink failure event');
      expectCombinedError(errorEvent, null);

      const rendered = appendSpy.mock.calls.map(([, payload]) => String(payload)).join('\n');
      expect(rendered).toContain('"type":"idle"');
      expect(rendered).toContain('"detail":"error"');
      expect(rendered).not.toContain('unlink failure prompt');
      expect(rendered).not.toContain(sourcePath);
      expect(rendered).not.toContain(String(claimPath));
      expect(rendered).not.toContain('unlink failed');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('deletes the exact claim after malformed JSON', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const sourcePath = path.join(directory, 'opencode-initial-prompt.json');
      fs.writeFileSync(sourcePath, '{not json', 'utf8');
      const root = makeRootClient();
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();

      expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
    });

    it('rejects an unsupported payload version without exposing its content', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 2,
        mode: 'fresh',
        prompt: 'never submit this secret',
      });
      const root = makeRootClient();
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();

      expect(root.create).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
      const events = readEvents(eventsPath);
      expect(events).toHaveLength(1);
      const errorEvent = events.at(-1);
      expect(errorEvent).toBeDefined();
      if (!errorEvent) throw new TypeError('missing validation failure event');
      expectCombinedError(errorEvent, null);
    });

    it('deletes the exact claim before validation and API requests when validation fails', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const sourcePath = writePayload(directory, {
        version: 2,
        mode: 'fresh',
        prompt: 'invalid version prompt',
      });
      const root = makeRootClient();
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();

      expect(unlinkSpy).toHaveBeenCalled();
      expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
      expect(root.create).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
    });

    it('leaves no claim or source behind on API failure and only emits sanitized error output', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const promptCanary = `prompt-${Date.now()}`;
      const sdkErrorCanary = `sdk-error-${Date.now()}`;
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: promptCanary,
      });
      const root = makeRootClient();
      const renameSpy = vi.spyOn(fs, 'renameSync');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const { errorWritten } = captureSanitizedErrorAppend();
      root.create.mockRejectedValueOnce(new Error(sdkErrorCanary));
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await errorWritten.promise;

      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
      expect(root.publish).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
      const events = readEvents(eventsPath);
      expect(events).toHaveLength(1);
      const errorEvent = events.at(-1);
      expect(errorEvent).toBeDefined();
      if (!errorEvent) throw new TypeError('missing create failure event');
      expectCombinedError(errorEvent, null);
      const rendered = fs.readFileSync(eventsPath, 'utf8');
      expect(rendered).not.toContain(promptCanary);
      expect(rendered).not.toContain(sdkErrorCanary);
      const claimPath = renameSpy.mock.calls.find(([from]) => from === sourcePath)?.[1];
      expect(unlinkSpy).toHaveBeenCalledOnce();
      expect(unlinkSpy).toHaveBeenCalledWith(claimPath);
    });

    it('emits one known-identity combined error after fresh prompt rejection', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const root = makeRootClient('ses_prompt_123');
      const promptCanary = `prompt-${Date.now()}`;
      const sdkErrorCanary = `sdk-error-${Date.now()}`;
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: promptCanary,
      });
      const { errorWritten } = captureSanitizedErrorAppend();
      root.promptAsync.mockRejectedValueOnce(new Error(sdkErrorCanary));
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await errorWritten.promise;

      const events = readEvents(eventsPath);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(expect.objectContaining({
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_prompt_123' }),
      }));
      const errorEvent = events.at(-1);
      expect(errorEvent).toBeDefined();
      if (!errorEvent) throw new TypeError('missing prompt failure event');
      expectCombinedError(errorEvent, 'ses_prompt_123');
      const rendered = fs.readFileSync(eventsPath, 'utf8');
      expect(rendered).not.toContain(promptCanary);
      expect(rendered).not.toContain(sdkErrorCanary);
    });

    it('emits one known-identity combined error after fresh publish rejection', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const root = makeRootClient('ses_publish_123');
      const promptCanary = `prompt-${Date.now()}`;
      const sdkErrorCanary = `sdk-error-${Date.now()}`;
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: promptCanary,
      });
      const { errorWritten } = captureSanitizedErrorAppend();
      root.publish.mockRejectedValueOnce(new Error(sdkErrorCanary));
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await errorWritten.promise;

      expect(root.promptAsync).not.toHaveBeenCalled();
      const events = readEvents(eventsPath);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(expect.objectContaining({
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_publish_123' }),
      }));
      const errorEvent = events.at(-1);
      expect(errorEvent).toBeDefined();
      if (!errorEvent) throw new TypeError('missing publish failure event');
      expectCombinedError(errorEvent, 'ses_publish_123');
      const rendered = fs.readFileSync(eventsPath, 'utf8');
      expect(rendered).not.toContain(promptCanary);
      expect(rendered).not.toContain(sdkErrorCanary);
    });

    it('emits one known-identity combined error after resume get rejection', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const root = makeRootClient();
      const promptCanary = `prompt-${Date.now()}`;
      const sdkErrorCanary = `sdk-error-${Date.now()}`;
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'resume',
        sessionId: 'ses_resume_failure_123',
        prompt: promptCanary,
      });
      const { errorWritten } = captureSanitizedErrorAppend();
      root.get.mockRejectedValueOnce(new Error(sdkErrorCanary));
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await errorWritten.promise;

      expect(root.publish).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      const events = readEvents(eventsPath);
      expect(events).toHaveLength(1);
      const errorEvent = events.at(-1);
      expect(errorEvent).toBeDefined();
      if (!errorEvent) throw new TypeError('missing resume get failure event');
      expectCombinedError(errorEvent, 'ses_resume_failure_123');
      const rendered = fs.readFileSync(eventsPath, 'utf8');
      expect(rendered).not.toContain(promptCanary);
      expect(rendered).not.toContain(sdkErrorCanary);
    });

    it('replays buffered unrelated starts before one null-identity error when fresh create rejects', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'private create rejection prompt',
      });
      const root = makeRootClient();
      const createResult = createDeferred<{ readonly data: { readonly id: string } }>();
      const { errorWritten } = captureSanitizedErrorAppend();
      root.create.mockImplementation(() => {
        root.createCalled.resolve(undefined);
        return createResult.promise;
      });
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;
      const hooks = plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await root.createCalled.promise;

      expect(hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_unrelated_first' } } },
      })).toBeUndefined();
      expect(hooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_unrelated_second' } } },
      })).toBeUndefined();
      expect(readEvents(eventsPath)).toEqual([]);
      createResult.reject(new Error('private create rejection detail'));
      await errorWritten.promise;

      const events = readEvents(eventsPath);
      expect(events.map((event) => event.hookContext ?? event.detail)).toEqual([
        JSON.stringify({ sessionID: 'ses_unrelated_first' }),
        JSON.stringify({ sessionID: 'ses_unrelated_second' }),
        'error',
      ]);
      expectCombinedError(events[2], null);
      expect(root.create).toHaveBeenCalledTimes(1);
      expect(root.publish).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(fs.readFileSync(eventsPath, 'utf8')).not.toContain('private create rejection');
    });

    it('replays buffered starts before one sanitized error when malformed create success reaches terminal catch', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'private malformed envelope prompt',
      });
      const root = makeRootClient();
      const createResult = createDeferred<{ readonly data: { readonly id: string } }>();
      const { errorWritten } = captureSanitizedErrorAppend();
      const terminalErrorCanary = 'private malformed envelope value';
      const unhandledRejections: unknown[] = [];
      const recordUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
      const malformedEnvelope = {
        get data(): { readonly id: string } {
          throw new Error(terminalErrorCanary);
        },
      };
      root.create.mockImplementation(() => {
        root.createCalled.resolve(undefined);
        return createResult.promise;
      });
      process.on('unhandledRejection', recordUnhandledRejection);
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      try {
        const hooks = plugin({ client: root.client, directory });
        vi.runOnlyPendingTimers();
        await root.createCalled.promise;
        expect(hooks.event({
          event: { type: 'session.created', properties: { info: { id: 'ses_terminal_first' } } },
        })).toBeUndefined();
        expect(hooks.event({
          event: { type: 'session.created', properties: { info: { id: 'ses_terminal_second' } } },
        })).toBeUndefined();

        createResult.resolve(malformedEnvelope);
        await errorWritten.promise;

        const events = readEvents(eventsPath);
        expect(events.map((event) => event.hookContext ?? event.detail)).toEqual([
          JSON.stringify({ sessionID: 'ses_terminal_first' }),
          JSON.stringify({ sessionID: 'ses_terminal_second' }),
          'error',
        ]);
        const errorEvents = events.filter((event) => event.type === 'idle' && event.detail === 'error');
        expect(errorEvents).toHaveLength(1);
        expectCombinedError(errorEvents[0], null);
        expect(root.create).toHaveBeenCalledTimes(1);
        expect(root.publish).not.toHaveBeenCalled();
        expect(root.promptAsync).not.toHaveBeenCalled();
        expect(unhandledRejections).toEqual([]);
        const rendered = fs.readFileSync(eventsPath, 'utf8');
        expect(rendered).not.toContain(terminalErrorCanary);
        expect(rendered).not.toContain('private malformed envelope prompt');
        expect(rendered).not.toContain(sourcePath);
      } finally {
        process.off('unhandledRejection', recordUnhandledRejection);
      }
    });

    it.each([
      { stage: 'claim', mode: 'fresh', nativeSessionId: null },
      { stage: 'read', mode: 'fresh', nativeSessionId: null },
      { stage: 'unlink', mode: 'fresh', nativeSessionId: null },
      { stage: 'validation', mode: 'fresh', nativeSessionId: null },
      { stage: 'create', mode: 'fresh', nativeSessionId: null },
      { stage: 'get', mode: 'resume', nativeSessionId: 'ses_matrix_resume' },
      { stage: 'publish', mode: 'fresh', nativeSessionId: 'ses_created_123' },
      { stage: 'promptAsync', mode: 'fresh', nativeSessionId: 'ses_created_123' },
    ] as const)('reports one sanitized error without retry when $stage fails', async ({
      mode,
      nativeSessionId,
      stage,
    }) => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sourcePath = writePayload(directory, {
        version: stage === 'validation' ? 2 : 1,
        mode,
        prompt: 'matrix private prompt',
        ...(mode === 'resume' ? { sessionId: 'ses_matrix_resume' } : {}),
      });
      const root = makeRootClient();
      const createResult = createDeferred<{ readonly data: { readonly id: string } }>();
      const getResult = createDeferred<{ readonly data: { readonly id: string } }>();
      const publishResult = createDeferred<{ readonly data: boolean }>();
      const promptResult = createDeferred<void>();
      const { appendSpy, errorWritten } = captureSanitizedErrorAppend();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      if (stage === 'claim') {
        vi.spyOn(fs, 'renameSync').mockImplementation(() => {
          throw new Error('matrix private claim error');
        });
      } else if (stage === 'read') {
        vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
          throw new Error('matrix private read error');
        });
      } else if (stage === 'unlink') {
        vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
          throw new Error('matrix private unlink error');
        });
      } else if (stage === 'create') {
        root.create.mockImplementation(() => {
          root.createCalled.resolve(undefined);
          return createResult.promise;
        });
      } else if (stage === 'get') {
        root.get.mockImplementation(() => {
          root.getCalled.resolve(undefined);
          return getResult.promise;
        });
      } else if (stage === 'publish') {
        root.publish.mockImplementation(() => {
          root.publishCalled.resolve(undefined);
          return publishResult.promise;
        });
      } else if (stage === 'promptAsync') {
        root.promptAsync.mockImplementation(() => {
          root.promptCalled.resolve(undefined);
          return promptResult.promise;
        });
      }

      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;
      const hooks = plugin({ client: root.client, directory });
      expect(hooks).not.toBeInstanceOf(Promise);
      vi.runOnlyPendingTimers();

      if (stage === 'create') {
        await root.createCalled.promise;
        createResult.reject(new Error('matrix private create error'));
      } else if (stage === 'get') {
        await root.getCalled.promise;
        getResult.reject(new Error('matrix private get error'));
      } else if (stage === 'publish') {
        await root.publishCalled.promise;
        publishResult.reject(new Error('matrix private publish error'));
      } else if (stage === 'promptAsync') {
        await root.promptCalled.promise;
        promptResult.reject(new Error('matrix private prompt error'));
      }
      await errorWritten.promise;

      const events = readEvents(eventsPath);
      const errorEvents = events.filter((event) => event.type === 'idle' && event.detail === 'error');
      expect(errorEvents).toHaveLength(1);
      expectCombinedError(errorEvents[0], nativeSessionId);
      expect(root.create).toHaveBeenCalledTimes(
        stage === 'create' || stage === 'publish' || stage === 'promptAsync' ? 1 : 0,
      );
      expect(root.get).toHaveBeenCalledTimes(stage === 'get' ? 1 : 0);
      expect(root.publish).toHaveBeenCalledTimes(
        stage === 'publish' || stage === 'promptAsync' ? 1 : 0,
      );
      expect(root.promptAsync).toHaveBeenCalledTimes(stage === 'promptAsync' ? 1 : 0);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      const rendered = appendSpy.mock.calls.map(([, payload]) => String(payload)).join('\n');
      expect(rendered).not.toContain('matrix private prompt');
      expect(rendered).not.toContain('matrix private claim error');
      expect(rendered).not.toContain('matrix private read error');
      expect(rendered).not.toContain('matrix private unlink error');
      expect(rendered).not.toContain('matrix private create error');
      expect(rendered).not.toContain('matrix private get error');
      expect(rendered).not.toContain('matrix private publish error');
      expect(rendered).not.toContain('matrix private prompt error');
      expect(rendered).not.toContain(sourcePath);
    });

    it('keeps concurrent payloads independent and routes later events to each instance file', async () => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const firstDirectory = makeTemporaryDirectory();
      const secondDirectory = makeTemporaryDirectory();
      const firstEventsPath = path.join(firstDirectory, 'events.jsonl');
      const secondEventsPath = path.join(secondDirectory, 'events.jsonl');
      const firstSourcePath = writePayload(firstDirectory, {
        version: 1,
        mode: 'fresh',
        prompt: 'first session prompt',
      });
      const secondSourcePath = writePayload(secondDirectory, {
        version: 1,
        mode: 'fresh',
        prompt: 'second session prompt',
      });
      const firstRoot = makeRootClient('ses_first_123');
      const secondRoot = makeRootClient('ses_second_123');
      process.env[INITIAL_PROMPT_PATH_ENV] = firstSourcePath;
      process.env[EVENTS_PATH_ENV] = firstEventsPath;
      const firstHooks = plugin({ client: firstRoot.client, directory: firstDirectory });
      process.env[INITIAL_PROMPT_PATH_ENV] = secondSourcePath;
      process.env[EVENTS_PATH_ENV] = secondEventsPath;
      const secondHooks = plugin({ client: secondRoot.client, directory: secondDirectory });
      vi.runOnlyPendingTimers();
      await firstRoot.promptCalled.promise;
      await secondRoot.promptCalled.promise;

      firstHooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_first_123' } } },
      });
      secondHooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_second_123' } } },
      });
      firstHooks.event({ event: { type: 'session.idle' } });
      secondHooks.event({ event: { type: 'session.idle' } });

      const firstEvents = readEvents(firstEventsPath);
      const secondEvents = readEvents(secondEventsPath);
      expect(firstEvents).toEqual([
        {
          ts: expect.any(Number),
          type: 'session_start',
          hookContext: JSON.stringify({ sessionID: 'ses_first_123' }),
          privateNativeBoundary: {
            kind: 'created',
            nativeSessionId: 'ses_first_123',
            occurredAt: expect.any(Number),
          },
        },
        {
          ts: expect.any(Number),
          type: 'idle',
          privateNativeBoundary: {
            kind: 'idle',
            nativeSessionId: null,
            occurredAt: expect.any(Number),
          },
        },
      ]);
      expect(secondEvents).toEqual([
        {
          ts: expect.any(Number),
          type: 'session_start',
          hookContext: JSON.stringify({ sessionID: 'ses_second_123' }),
          privateNativeBoundary: {
            kind: 'created',
            nativeSessionId: 'ses_second_123',
            occurredAt: expect.any(Number),
          },
        },
        {
          ts: expect.any(Number),
          type: 'idle',
          privateNativeBoundary: {
            kind: 'idle',
            nativeSessionId: null,
            occurredAt: expect.any(Number),
          },
        },
      ]);
      expect(JSON.stringify(firstEvents)).not.toContain('ses_second_123');
      expect(JSON.stringify(secondEvents)).not.toContain('ses_first_123');
      expect(firstRoot.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
        body: { parts: [{ type: 'text', text: 'first session prompt' }] },
      }));
      expect(secondRoot.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
        body: { parts: [{ type: 'text', text: 'second session prompt' }] },
      }));
    });
  });
});
