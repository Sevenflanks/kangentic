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

async function loadStartup() {
  vi.resetModules();
  const module = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-startup.mjs');
  return module.default;
}

function expectSanitizedError(eventsPath: string, nativeSessionId: string | null): void {
  const events = readEvents(eventsPath);
  const errorEvents = events.filter((event) => event.type === 'idle' && event.detail === 'error');
  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0]).toEqual({
    ts: expect.any(Number),
    type: 'idle',
    detail: 'error',
    privateNativeBoundary: {
      kind: 'error',
      nativeSessionId,
      occurredAt: expect.any(Number),
    },
  });
  const boundary = errorEvents[0]?.privateNativeBoundary;
  if (!boundary || typeof boundary !== 'object' || !('occurredAt' in boundary)) {
    throw new TypeError('sanitized error is missing privateNativeBoundary.occurredAt');
  }
  expect(errorEvents[0]?.ts).toBe(boundary.occurredAt);
}

function captureSanitizedErrorAppend() {
  const errorWritten = createDeferred<void>();
  const appendFileSync = fs.appendFileSync.bind(fs);
  vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data) => {
    appendFileSync(file, data);
    if (String(data).includes('"type":"idle"') && String(data).includes('"detail":"error"')) {
      errorWritten.resolve(undefined);
    }
  });
  return errorWritten;
}

describe('OpenCode private prompt claims', () => {
  it('reports one sanitized error without retry when the TUI claim fails', async () => {
    const startup = await loadStartup();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque claim failure payload',
    });
    const create = vi.fn(async () => ({ data: { id: 'ses_unexpected' } }));
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('private claim failure');
    });
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    await startup.tui({
      client: { session: { create, promptAsync: vi.fn(async () => undefined) } },
      route: { navigate: vi.fn(() => undefined) },
      directory,
    });

    expect(renameSpy).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expectSanitizedError(eventsPath, null);
    expect(fs.readFileSync(eventsPath, 'utf8')).not.toContain('private claim failure');
  });

  it('deletes the exact TUI claim after read failure', async () => {
    const startup = await loadStartup();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque read failure payload',
    });
    const readFileSync = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((target, options) => {
      if (String(target).startsWith(`${sourcePath}.claim-`)) throw new Error('private read failure');
      return readFileSync(target, options);
    });
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const create = vi.fn(async () => ({ data: { id: 'ses_unexpected' } }));
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    await startup.tui({
      client: { session: { create, promptAsync: vi.fn(async () => undefined) } },
      route: { navigate: vi.fn(() => undefined) },
      directory,
    });

    const claimPath = renameSpy.mock.calls[0]?.[1];
    expect(readSpy).toHaveBeenCalled();
    expect(claimPath).toEqual(expect.stringContaining('.claim-'));
    expect(fs.existsSync(String(claimPath))).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expectSanitizedError(eventsPath, null);
  });

  it('removes the TUI claim before parsing and client use', async () => {
    const startup = await loadStartup();
    const directory = makeTemporaryDirectory();
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque ordered payload',
    });
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const originalParse = JSON.parse.bind(JSON);
    let claimRemovedAtParse = false;
    vi.spyOn(JSON, 'parse').mockImplementation((rawText, reviver) => {
      if (rawText.includes('opaque ordered payload')) {
        const claimPath = renameSpy.mock.calls[0]?.[1];
        claimRemovedAtParse = !fs.existsSync(sourcePath) && !fs.existsSync(String(claimPath));
      }
      return originalParse(rawText, reviver);
    });
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;

    await startup.tui({
      client: {
        session: {
          create: vi.fn(async () => ({ data: { id: 'ses_ordered_123' } })),
          promptAsync: vi.fn(async () => undefined),
        },
      },
      route: { navigate: vi.fn(() => undefined) },
      directory,
    });

    expect(claimRemovedAtParse).toBe(true);
  });

  it('sanitizes claim deletion failures without using the client', async () => {
    const startup = await loadStartup();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque unlink failure payload',
    });
    const unlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (String(target).startsWith(`${sourcePath}.claim-`)) throw new Error('private unlink failure');
      unlinkSync(target);
    });
    const create = vi.fn(async () => ({ data: { id: 'ses_unexpected' } }));
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    await startup.tui({
      client: { session: { create, promptAsync: vi.fn(async () => undefined) } },
      route: { navigate: vi.fn(() => undefined) },
      directory,
    });

    expect(create).not.toHaveBeenCalled();
    expectSanitizedError(eventsPath, null);
    expect(fs.readFileSync(eventsPath, 'utf8')).not.toContain('private unlink failure');
  });

  it('rejects malformed fresh payloads after claim deletion', async () => {
    const startup = await loadStartup();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = path.join(directory, 'opencode-initial-prompt.json');
    fs.writeFileSync(sourcePath, '{not json', 'utf8');
    const create = vi.fn(async () => ({ data: { id: 'ses_unexpected' } }));
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    await startup.tui({
      client: { session: { create, promptAsync: vi.fn(async () => undefined) } },
      route: { navigate: vi.fn(() => undefined) },
      directory,
    });

    expect(create).not.toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
    expectSanitizedError(eventsPath, null);
  });

  it.each([
    { stage: 'create', expectedSessionId: null },
    { stage: 'navigate', expectedSessionId: 'ses_failure_123' },
    { stage: 'prompt', expectedSessionId: 'ses_failure_123' },
  ] as const)('reports one sanitized error without retry when $stage fails', async ({
    stage,
    expectedSessionId,
  }) => {
    const startup = await loadStartup();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque failure matrix payload',
    });
    const create = stage === 'create'
      ? vi.fn(async () => { throw new Error('private create error'); })
      : vi.fn(async () => ({ data: { id: 'ses_failure_123' } }));
    const navigate = stage === 'navigate'
      ? vi.fn(() => { throw new Error('private navigate error'); })
      : vi.fn(() => undefined);
    const promptAsync = stage === 'prompt'
      ? vi.fn(async () => { throw new Error('private prompt error'); })
      : vi.fn(async () => undefined);
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    await startup.tui({
      client: { session: { create, promptAsync } },
      route: { navigate },
      directory,
    });

    expect(create).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledTimes(stage === 'create' ? 0 : 1);
    expect(promptAsync).toHaveBeenCalledTimes(stage === 'prompt' ? 1 : 0);
    expectSanitizedError(eventsPath, expectedSessionId);
    const rendered = fs.readFileSync(eventsPath, 'utf8');
    expect(rendered).not.toContain('opaque failure matrix payload');
    expect(rendered).not.toContain('private create error');
    expect(rendered).not.toContain('private navigate error');
    expect(rendered).not.toContain('private prompt error');
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readdirSync(directory).some((entry) => entry.includes('.claim-'))).toBe(false);
  });

  it.each(['claim', 'read', 'unlink', 'validation', 'promptAsync'] as const)(
    'reports one sanitized resume error without retry when %s fails',
    async (stage) => {
      const { KangenticActivity: plugin } = await loadPlugin();
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sessionId = 'ses_resume_matrix_123';
      const promptCanary = 'opaque resume matrix payload';
      const errorCanary = `private resume ${stage} error`;
      const sourcePath = writePayload(directory, {
        version: stage === 'validation' ? 2 : 1,
        mode: 'resume',
        prompt: promptCanary,
        sessionId,
      });
      const root = makeRootClient(sessionId);
      const renameSpy = vi.spyOn(fs, 'renameSync');
      const readSpy = vi.spyOn(fs, 'readFileSync');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      if (stage === 'claim') renameSpy.mockImplementationOnce(() => { throw new Error(errorCanary); });
      if (stage === 'read') readSpy.mockImplementationOnce(() => { throw new Error(errorCanary); });
      if (stage === 'unlink') unlinkSpy.mockImplementationOnce(() => { throw new Error(errorCanary); });
      if (stage === 'promptAsync') root.promptAsync.mockRejectedValueOnce(new Error(errorCanary));
      const errorWritten = captureSanitizedErrorAppend();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      plugin({ client: root.client, directory });
      vi.runOnlyPendingTimers();
      await errorWritten.promise;

      const claimEntries = fs.readdirSync(directory).filter((entry) => entry.includes('.claim-'));
      expect(root.get).toHaveBeenCalledTimes(stage === 'promptAsync' ? 1 : 0);
      expect(root.promptAsync).toHaveBeenCalledTimes(stage === 'promptAsync' ? 1 : 0);
      expect(renameSpy).toHaveBeenCalledOnce();
      expect(readSpy).toHaveBeenCalledTimes(stage === 'claim' ? 0 : 1);
      expect(unlinkSpy).toHaveBeenCalledTimes(stage === 'claim' ? 0 : 1);
      expect(fs.existsSync(sourcePath)).toBe(stage === 'claim');
      expect(claimEntries).toHaveLength(stage === 'unlink' ? 1 : 0);
      expectSanitizedError(eventsPath, stage === 'promptAsync' ? sessionId : null);
      const rendered = fs.readFileSync(eventsPath, 'utf8');
      expect(rendered).not.toContain(promptCanary);
      expect(rendered).not.toContain(errorCanary);
      expect(rendered).not.toContain(sourcePath);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    },
  );

  it('keeps concurrent fresh payloads and telemetry files independent', async () => {
    const startup = await loadStartup();
    const firstDirectory = makeTemporaryDirectory();
    const secondDirectory = makeTemporaryDirectory();
    const firstEventsPath = path.join(firstDirectory, 'events.jsonl');
    const secondEventsPath = path.join(secondDirectory, 'events.jsonl');
    const firstSourcePath = writePayload(firstDirectory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque first payload',
    });
    const secondSourcePath = writePayload(secondDirectory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque second payload',
    });
    const firstPrompt = vi.fn(async () => { throw new Error('first private failure'); });
    const secondPrompt = vi.fn(async () => { throw new Error('second private failure'); });

    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = firstSourcePath;
    process.env[EVENTS_PATH_ENV] = firstEventsPath;
    await startup.tui({
      client: {
        session: {
          create: vi.fn(async () => ({ data: { id: 'ses_first_123' } })),
          promptAsync: firstPrompt,
        },
      },
      route: { navigate: vi.fn(() => undefined) },
      directory: firstDirectory,
    });

    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = secondSourcePath;
    process.env[EVENTS_PATH_ENV] = secondEventsPath;
    await startup.tui({
      client: {
        session: {
          create: vi.fn(async () => ({ data: { id: 'ses_second_123' } })),
          promptAsync: secondPrompt,
        },
      },
      route: { navigate: vi.fn(() => undefined) },
      directory: secondDirectory,
    });

    expectSanitizedError(firstEventsPath, 'ses_first_123');
    expectSanitizedError(secondEventsPath, 'ses_second_123');
    expect(fs.readFileSync(firstEventsPath, 'utf8')).not.toContain('ses_second_123');
    expect(fs.readFileSync(secondEventsPath, 'utf8')).not.toContain('ses_first_123');
  });

  it('keeps resume get failure on the server plugin with known identity', async () => {
    const { KangenticActivity: plugin } = await loadPlugin();
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'resume',
      prompt: 'opaque resume failure payload',
      sessionId: 'ses_resume_failure_123',
    });
    const root = makeRootClient();
    root.get.mockRejectedValueOnce(new Error('private resume error'));
    process.env[INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    plugin({ client: root.client, directory });
    vi.runOnlyPendingTimers();
    await vi.waitFor(() => expect(readEvents(eventsPath)).toHaveLength(1));

    expect(root.create).not.toHaveBeenCalled();
    expect(root.promptAsync).not.toHaveBeenCalled();
    expectSanitizedError(eventsPath, 'ses_resume_failure_123');
    expect(fs.readFileSync(eventsPath, 'utf8')).not.toContain('private resume error');
  });
});
