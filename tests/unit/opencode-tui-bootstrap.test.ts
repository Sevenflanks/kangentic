import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenCodePluginFixture,
  EVENTS_PATH_ENV,
  TUI_INITIAL_PROMPT_PATH_ENV,
} from './helpers/opencode-plugin-fixture';

const {
  cleanup,
  makeTemporaryDirectory,
  writePayload,
} = createOpenCodePluginFixture();

afterEach(cleanup);

describe('OpenCode TUI bootstrap', () => {
  it('navigates to a freshly created session from the mounted TUI before submitting its prompt', async () => {
    const { default: KangenticStartup } = await import(
      '../../src/main/agent/adapters/opencode/plugin/kangentic-startup.mjs'
    );
    const directory = makeTemporaryDirectory();
    const sessionId = 'ses_tui_bootstrap_123';
    const callOrder: string[] = [];
    const create = vi.fn(async () => {
      callOrder.push('create');
      expect(fs.existsSync(sourcePath)).toBe(false);
      return { data: { id: sessionId } };
    });
    const promptAsync = vi.fn(async () => ({ data: undefined, error: undefined }));
    const navigate = vi.fn((destination: string, params: { readonly sessionID: string }) => {
      callOrder.push('route.navigate');
      expect(destination).toBe('session');
      expect(params.sessionID).toBe(sessionId);
    });
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque startup payload',
    });
    promptAsync.mockImplementation(async (request) => {
      callOrder.push('promptAsync');
      expect(request).toEqual({
        sessionID: sessionId,
        parts: [{ type: 'text', text: 'opaque startup payload' }],
      });
    });
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;

    await KangenticStartup.tui({
      client: { session: { create, promptAsync } },
      route: { navigate },
      directory,
    });

    expect(create).toHaveBeenCalledWith({ directory });
    expect(navigate).toHaveBeenCalledWith('session', { sessionID: sessionId });
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['create', 'route.navigate', 'promptAsync']);
  });

  it('uses the flat v2 request shape for model selection', async () => {
    const { default: KangenticStartup } = await import(
      '../../src/main/agent/adapters/opencode/plugin/kangentic-startup.mjs'
    );
    const directory = makeTemporaryDirectory();
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque model payload',
      model: { providerID: 'anthropic', modelID: 'model-id' },
    });
    const promptAsync = vi.fn(async () => undefined);
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;

    await KangenticStartup.tui({
      client: {
        session: {
          create: vi.fn(async () => ({ data: { id: 'ses_model_123' } })),
          promptAsync,
        },
      },
      route: { navigate: vi.fn(() => undefined) },
      directory,
    });

    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_model_123',
      model: { providerID: 'anthropic', modelID: 'model-id' },
    }));
  });

  it('stops before prompt submission when direct route navigation fails', async () => {
    const { default: KangenticStartup } = await import(
      '../../src/main/agent/adapters/opencode/plugin/kangentic-startup.mjs'
    );
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque route failure payload',
    });
    const promptAsync = vi.fn(async () => undefined);
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    await KangenticStartup.tui({
      client: {
        session: {
          create: vi.fn(async () => ({ data: { id: 'ses_route_failure_123' } })),
          promptAsync,
        },
      },
      route: { navigate: vi.fn(() => { throw new Error('route unavailable'); }) },
      directory,
    });

    expect(promptAsync).not.toHaveBeenCalled();
    const failureEvent = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    expect(failureEvent).toEqual(expect.objectContaining({ type: 'idle', detail: 'error' }));
    expect(JSON.stringify(failureEvent)).not.toContain('route unavailable');
  });

  it.each(['resolved error', 'rejection'] as const)(
    'reports one sanitized known-session failure without retry after promptAsync %s',
    async (failureMode) => {
      const { default: KangenticStartup } = await import(
        '../../src/main/agent/adapters/opencode/plugin/kangentic-startup.mjs'
      );
      const directory = makeTemporaryDirectory();
      const eventsPath = path.join(directory, 'events.jsonl');
      const sessionId = 'ses_prompt_failure_123';
      const promptCanary = 'opaque prompt failure payload';
      const errorCanary = 'private prompt failure detail';
      const sourcePath = writePayload(directory, {
        version: 1,
        mode: 'fresh',
        prompt: promptCanary,
      });
      const promptAsync = vi.fn(() => failureMode === 'resolved error'
        ? Promise.resolve({ error: { message: errorCanary } })
        : Promise.reject(new Error(errorCanary)));
      const create = vi.fn(async () => ({ data: { id: sessionId } }));
      const navigate = vi.fn(() => undefined);
      process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
      process.env[EVENTS_PATH_ENV] = eventsPath;

      await KangenticStartup.tui({
        client: { session: { create, promptAsync } },
        route: { navigate },
        directory,
      });

      expect(create).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledOnce();
      expect(promptAsync).toHaveBeenCalledOnce();
      const rendered = fs.readFileSync(eventsPath, 'utf8');
      const events = rendered.trim().split('\n').map((line) => JSON.parse(line));
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        ts: expect.any(Number),
        type: 'idle',
        detail: 'error',
        privateNativeBoundary: {
          kind: 'error',
          nativeSessionId: sessionId,
          occurredAt: expect.any(Number),
        },
      });
      expect(events[0].ts).toBe(events[0].privateNativeBoundary.occurredAt);
      expect(rendered).not.toContain(promptCanary);
      expect(rendered).not.toContain(errorCanary);
    },
  );

  it('does not call the client for a malformed or resume payload', async () => {
    const { default: KangenticStartup } = await import(
      '../../src/main/agent/adapters/opencode/plugin/kangentic-startup.mjs'
    );
    const directory = makeTemporaryDirectory();
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'resume',
      prompt: 'opaque resume payload',
      sessionId: 'ses_resume_123',
    });
    const create = vi.fn(async () => ({ data: { id: 'ses_unexpected' } }));
    const promptAsync = vi.fn(async () => undefined);
    const navigate = vi.fn(() => undefined);
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;

    await KangenticStartup.tui({
      client: { session: { create, promptAsync } },
      route: { navigate },
      directory,
    });

    expect(create).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing data', response: {} },
    { name: 'missing id', response: { data: {} } },
    { name: 'invalid id', response: { data: { id: '' } } },
  ])('sanitizes a create wrapper with $name and stops before navigation', async ({ response }) => {
    const { default: KangenticStartup } = await import(
      '../../src/main/agent/adapters/opencode/plugin/kangentic-startup.mjs'
    );
    const directory = makeTemporaryDirectory();
    const eventsPath = path.join(directory, 'events.jsonl');
    const sourcePath = writePayload(directory, {
      version: 1,
      mode: 'fresh',
      prompt: 'opaque invalid wrapper payload',
    });
    const navigate = vi.fn(() => undefined);
    const promptAsync = vi.fn(async () => undefined);
    process.env[TUI_INITIAL_PROMPT_PATH_ENV] = sourcePath;
    process.env[EVENTS_PATH_ENV] = eventsPath;

    await KangenticStartup.tui({
      client: { session: { create: vi.fn(async () => response), promptAsync } },
      route: { navigate },
      directory,
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
    const failureEvent = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    expect(failureEvent).toEqual(expect.objectContaining({
      type: 'idle',
      detail: 'error',
      privateNativeBoundary: expect.objectContaining({ nativeSessionId: null }),
    }));
    expect(JSON.stringify(failureEvent)).not.toContain('opaque invalid wrapper payload');
  });
});
