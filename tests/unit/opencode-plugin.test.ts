import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createOpenCodePluginFixture, EVENTS_PATH_ENV } from './helpers/opencode-plugin-fixture';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'opencode-plugin-events.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

const FIXED_TIMESTAMP = new Date('2024-05-29T00:26:40.000Z');

const { cleanup, loadPlugin, makeTemporaryDirectory, readEvents } = createOpenCodePluginFixture();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_TIMESTAMP);
});
afterEach(cleanup);

async function createHooks() {
  const { KangenticActivity } = await loadPlugin();
  const directory = makeTemporaryDirectory();
  const eventsPath = path.join(directory, 'events.jsonl');
  process.env[EVENTS_PATH_ENV] = eventsPath;
  const hooks = KangenticActivity({ client: { session: {}, tui: {} }, directory });
  return { eventsPath, hooks };
}

describe('opencode-plugin', () => {
  it('exposes only KangenticActivity to legacy named factory discovery', async () => {
    // Given: the ESM namespace passed to OpenCode's legacy plugin loader
    const pluginModule = await loadPlugin();
    const directory = makeTemporaryDirectory();

    // When: the loader treats every named function export as a factory
    const factoryNames = Object.entries(pluginModule)
      .filter(([, exportedValue]) => typeof exportedValue === 'function')
      .map(([exportName]) => exportName);
    const hooks = pluginModule.KangenticActivity({ client: { session: {}, tui: {} }, directory });

    // Then: only the real plugin factory is discoverable
    expect(factoryNames).toEqual(['KangenticActivity']);
    expect(hooks).toEqual({
      event: expect.any(Function),
      'tool.execute.before': expect.any(Function),
      'tool.execute.after': expect.any(Function),
    });
  });

  it('writes synchronous callback telemetry through the returned hooks', async () => {
    // Given: a plugin factory configured with an event log
    const { eventsPath, hooks } = await createHooks();

    // When: OpenCode invokes an ignored event plus all hook categories
    expect(hooks.event({ event: { type: 'unknown' } })).toBeUndefined();
    expect(hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'pwd' } })).toBeUndefined();
    expect(hooks['tool.execute.after']({ tool: 'bash' })).toBeUndefined();

    // Then: hooks are synchronous and append their observable telemetry
    expect(hooks['tool.execute.after']({})).toBeUndefined();
    expect(hooks['tool.execute.after'](undefined)).toBeUndefined();
    expect(readEvents(eventsPath)).toEqual([
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', tool: 'bash', detail: 'pwd' },
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_end', tool: 'bash' },
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_end' },
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_end' },
    ]);
  });

  it('writes session lifecycle telemetry through the event hook', async () => {
    // Given: a plugin factory configured with an event log
    const { eventsPath, hooks } = await createHooks();

    // When: OpenCode reports created, idle, and error lifecycle events
    hooks.event({ event: fixtures.event_session_created });
    hooks.event({ event: fixtures.event_session_idle });
    hooks.event({ event: fixtures.event_session_error });

    // Then: the event log retains their public telemetry and native boundaries
    expect(readEvents(eventsPath)).toEqual([
      {
        ts: FIXED_TIMESTAMP.getTime(),
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' }),
        privateNativeBoundary: { kind: 'created', nativeSessionId: 'ses_2349b5c91ffeKd6qajuUTR4clq', occurredAt: FIXED_TIMESTAMP.getTime() },
      },
      {
        ts: FIXED_TIMESTAMP.getTime(),
        type: 'idle',
        privateNativeBoundary: { kind: 'idle', nativeSessionId: 'ses_2349b5c91ffeKd6qajuUTR4clq', occurredAt: FIXED_TIMESTAMP.getTime() },
      },
      {
        ts: FIXED_TIMESTAMP.getTime(),
        type: 'idle',
        detail: 'error',
        privateNativeBoundary: { kind: 'error', nativeSessionId: 'ses_2349b5c91ffeKd6qajuUTR4clq', occurredAt: FIXED_TIMESTAMP.getTime() },
      },
    ]);
  });

  it('omits unrecognized lifecycle events and preserves fallback session identities', async () => {
    // Given: a plugin factory configured with an event log
    const { eventsPath, hooks } = await createHooks();

    // When: OpenCode reports unsupported, incomplete, and fallback session events
    hooks.event({ event: fixtures.event_session_unknown });
    hooks.event({ event: null });
    hooks.event({ event: 'string' });
    hooks.event({ event: { type: 'session.created', properties: {} } });
    hooks.event({ event: { type: 'session.created', properties: { sessionID: 'ses_fallback123' } } });

    // Then: only valid sessions reach the event log with their available identity
    expect(readEvents(eventsPath)).toEqual([
      {
        ts: FIXED_TIMESTAMP.getTime(),
        type: 'session_start',
        privateNativeBoundary: { kind: 'created', nativeSessionId: null, occurredAt: FIXED_TIMESTAMP.getTime() },
      },
      {
        ts: FIXED_TIMESTAMP.getTime(),
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_fallback123' }),
        privateNativeBoundary: { kind: 'created', nativeSessionId: 'ses_fallback123', occurredAt: FIXED_TIMESTAMP.getTime() },
      },
    ]);
  });

  it('writes recognized tool details and omits unavailable details through the before hook', async () => {
    // Given: a plugin factory configured with an event log
    const { eventsPath, hooks } = await createHooks();

    // When: OpenCode invokes tools with command, file path, path, long, and absent arguments
    hooks['tool.execute.before'](fixtures.tool_before_read.input, fixtures.tool_before_read.output);
    hooks['tool.execute.before'](fixtures.tool_before_glob.input, fixtures.tool_before_glob.output);
    hooks['tool.execute.before'](fixtures.tool_before_long_command.input, fixtures.tool_before_long_command.output);
    hooks['tool.execute.before'](fixtures.tool_before_no_args.input, fixtures.tool_before_no_args.output);
    hooks['tool.execute.before']({ tool: 'bash' }, { args: null });
    hooks['tool.execute.before']({ tool: 'bash' }, undefined);

    // Then: events retain recognized detail only, with the documented truncation limit
    const events = readEvents(eventsPath);
    expect(events.slice(0, 2)).toEqual([
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', tool: 'read', detail: '/repo/src/main.ts' },
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', tool: 'glob', detail: '/repo' },
    ]);
    expect(events[2]).toEqual(expect.objectContaining({
      detail: expect.stringMatching(/^rg --multiline 'pattern' \/a\/very\/long\/path/),
      tool: 'bash',
      ts: FIXED_TIMESTAMP.getTime(),
      type: 'tool_start',
    }));
    expect(events[2]?.detail).toHaveLength(200);
    expect(events.slice(3)).toEqual([
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', tool: 'list' },
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', tool: 'bash' },
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', tool: 'bash' },
    ]);
  });

  it('preserves detail when the before hook input has no tool', async () => {
    // Given: a plugin factory configured with an event log
    const { eventsPath, hooks } = await createHooks();

    // When: OpenCode invokes a recognized tool detail without input.tool
    hooks['tool.execute.before']({}, { args: { command: 'echo hi' } });

    // Then: the tool event retains detail without adding a tool field
    expect(readEvents(eventsPath)).toEqual([
      { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', detail: 'echo hi' },
    ]);
  });

  it.each(['session.created', 'session.start'] as const)(
    'records %s as a root tool invocation private turn boundary',
    async (eventType) => {
      // Given: an accepted root-session event through the factory event hook
      const { eventsPath, hooks } = await createHooks();
      hooks.event({ event: { type: eventType, properties: { sessionID: 'ses_started123' } } });

      // When: OpenCode invokes one root tool and one child tool
      hooks['tool.execute.before'](
        { ...fixtures.tool_before_bash.input, sessionID: 'ses_started123' },
        fixtures.tool_before_bash.output,
      );
      hooks['tool.execute.before'](
        { ...fixtures.tool_before_bash.input, sessionID: 'ses_child123' },
        fixtures.tool_before_bash.output,
      );

      // Then: only the root event carries the private turn boundary
      expect(readEvents(eventsPath).slice(1)).toEqual([
        {
          ts: FIXED_TIMESTAMP.getTime(),
          type: 'tool_start',
          tool: 'bash',
          detail: 'ls -la /tmp',
          privateNativeBoundary: { kind: 'turn-start', nativeSessionId: 'ses_started123', occurredAt: FIXED_TIMESTAMP.getTime() },
        },
        { ts: FIXED_TIMESTAMP.getTime(), type: 'tool_start', tool: 'bash', detail: 'ls -la /tmp' },
      ]);
    },
  );
});
