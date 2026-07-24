import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodePluginFixture, EVENTS_PATH_ENV, INITIAL_PROMPT_PATH_ENV } from './helpers/opencode-plugin-fixture';

const { cleanup, loadPlugin, makeRootClient, makeTemporaryDirectory, readEvents, writePayload } = createOpenCodePluginFixture();

afterEach(cleanup);

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

      await plugin({ client: root.client, directory });

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
      root.create.mockImplementation(async () => ({ id: 'ses_order_123' }));
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;

      await plugin({ client: root.client, directory });

      expect(payloadParseCount).toBe(1);
      expect(renameSpy).toHaveBeenCalledWith(sourcePath, expect.stringContaining('.claim-'));
      expect(root.create).toHaveBeenCalledWith({ query: { directory }, body: {} });
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

      await plugin({ client: root.client, directory });

      const claimPath = renameSpy.mock.calls.find(([from]) => from === sourcePath)?.[1];
      expect(claimPath).toEqual(expect.stringContaining('.claim-'));
      expect(unlinkSpy).toHaveBeenCalledWith(claimPath);
      expect(payloadParseCount).toBe(0);
      expect(root.create).not.toHaveBeenCalled();
      expect(root.get).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
      expect(readEvents(eventsPath)).toEqual([{ ts: expect.any(Number), type: 'idle', detail: 'error' }]);

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

      await plugin({ client: root.client, directory });

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

      await plugin({ client: root.client, directory });

      expect(root.create).not.toHaveBeenCalled();
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
      expect(readEvents(eventsPath)).toEqual([{ ts: expect.any(Number), type: 'idle', detail: 'error' }]);
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

      await plugin({ client: root.client, directory });

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
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: 'api failure prompt',
      });
      const root = makeRootClient();
      const renameSpy = vi.spyOn(fs, 'renameSync');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      root.create.mockRejectedValueOnce(new Error('network exploded'));
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      await plugin({ client: root.client, directory });

      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
      expect(root.promptAsync).not.toHaveBeenCalled();
      expect(root.command).not.toHaveBeenCalled();
      expect(readEvents(eventsPath)).toEqual([{ ts: expect.any(Number), type: 'idle', detail: 'error' }]);
      const claimPath = renameSpy.mock.calls.find(([from]) => from === sourcePath)?.[1];
      expect(unlinkSpy).toHaveBeenCalledOnce();
      expect(unlinkSpy).toHaveBeenCalledWith(claimPath);
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
      const firstHooks = await plugin({ client: firstRoot.client, directory: firstDirectory });
      process.env[INITIAL_PROMPT_PATH_ENV] = secondSourcePath;
      process.env[EVENTS_PATH_ENV] = secondEventsPath;
      const secondHooks = await plugin({ client: secondRoot.client, directory: secondDirectory });

      await firstHooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_first_123' } } },
      });
      await secondHooks.event({
        event: { type: 'session.created', properties: { info: { id: 'ses_second_123' } } },
      });
      await firstHooks.event({ event: { type: 'session.idle' } });
      await secondHooks.event({ event: { type: 'session.idle' } });

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
