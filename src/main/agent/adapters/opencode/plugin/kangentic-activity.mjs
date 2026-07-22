// kangentic-activity
// OpenCode plugin that emits structured activity events into the
// Kangentic events.jsonl pipeline. Discovered automatically by
// OpenCode via the project-shared `.opencode/plugins/` directory.
//
// The plugin runs inline in the OpenCode process and writes JSONL
// entries that match the shape produced by Kangentic's other agent
// adapters (see src/main/agent/event-bridge.js). The events file path
// is supplied via the KANGENTIC_EVENTS_PATH env var, which Kangentic's
// PTY spawn flow exports whenever a session has an events output path.
//
// The leading sentinel comment ("// kangentic-activity") is required:
// hook-manager.ts uses it to identify files it authored before
// deletion, so it never removes user-authored plugins.
//
// The pure event-extraction helpers (extractSessionEvent /
// extractToolStartEvent / extractToolEndEvent) are exported so they
// can be unit-tested against captured OpenCode event fixtures
// (tests/fixtures/opencode-plugin-events.json).
import fs from 'node:fs';

function nativeSessionIdFrom(properties) {
  const value = properties?.sessionID ?? properties?.info?.id ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function privateBoundary(kind, nativeSessionId, occurredAt) {
  return { kind, nativeSessionId, occurredAt };
}

// 這個 module instance 只屬於單一 OpenCode process；root identity 只用來辨識 child event，不可投影到 public SessionEvent。
let rootSessionId = null;

/**
 * Extract a Kangentic JSONL event from an OpenCode `event` payload.
 * Returns null when the event type is not one we surface.
 *
 * Recognized OpenCode event types (from https://opencode.ai/docs/plugins/,
 * verified against the cmux reference plugin):
 *  - `session.created`: emit a `session_start` with the OpenCode
 *    session id captured into hookContext for resume support.
 *  - `session.idle`:    emit `idle` (the agent has stopped working).
 *  - `session.error`:   emit `idle` with `detail: 'error'`.
 */
export function extractSessionEvent(event, now = Date.now()) {
  if (!event || typeof event !== 'object') return null;
  const eventType = event.type;
  if (eventType === 'session.created' || eventType === 'session.start') {
    const properties = event.properties ?? {};
    const sessionID = nativeSessionIdFrom(properties);
    rootSessionId ??= sessionID;
    const hookContext = sessionID
      ? JSON.stringify({ sessionID }).slice(0, 2048)
      : undefined;
    return {
      ts: now,
      type: 'session_start',
      ...(hookContext ? { hookContext } : {}),
      privateNativeBoundary: privateBoundary('created', sessionID, now),
    };
  }
  if (eventType === 'session.idle') {
    return {
      ts: now,
      type: 'idle',
      privateNativeBoundary: privateBoundary(
        'idle',
        nativeSessionIdFrom(event.properties),
        now,
      ),
    };
  }
  if (eventType === 'session.error') {
    return {
      ts: now,
      type: 'idle',
      detail: 'error',
      privateNativeBoundary: privateBoundary(
        'error',
        nativeSessionIdFrom(event.properties),
        now,
      ),
    };
  }
  return null;
}

function truncate(value) {
  if (value == null) return undefined;
  return String(value).slice(0, 200);
}

/**
 * Build the per-tool detail string from OpenCode's `output.args` payload.
 * Tries common arg field names in priority order; falls back to undefined
 * for unknown tools (the consumer is fine with no detail).
 */
export function extractToolDetail(args) {
  if (!args || typeof args !== 'object') return undefined;
  return truncate(args.command ?? args.filePath ?? args.path ?? args.pattern ?? null);
}

/**
 * Extract a `tool_start` event from OpenCode's `tool.execute.before`
 * (input, output) handler arguments.
 */
export function extractToolStartEvent(input, output, now = Date.now()) {
  const detail = extractToolDetail(output?.args);
  const nativeSessionId = nativeSessionIdFrom(input);
  const isRootTurn = rootSessionId !== null && nativeSessionId === rootSessionId;
  return {
    ts: now,
    type: 'tool_start',
    ...(input?.tool ? { tool: input.tool } : {}),
    ...(detail ? { detail } : {}),
    ...(isRootTurn
      ? { privateNativeBoundary: privateBoundary('turn-start', nativeSessionId, now) }
      : {}),
  };
}

/**
 * Extract a `tool_end` event from OpenCode's `tool.execute.after` input.
 */
export function extractToolEndEvent(input, now = Date.now()) {
  return {
    ts: now,
    type: 'tool_end',
    ...(input?.tool ? { tool: input.tool } : {}),
  };
}

const eventsPath = process.env.KANGENTIC_EVENTS_PATH;

function appendEvent(event) {
  if (!eventsPath || !event) return;
  try {
    fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort. The file may have been removed when the session ended.
  }
}

export const KangenticActivity = async () => ({
  event: async ({ event }) => {
    appendEvent(extractSessionEvent(event));
  },
  'tool.execute.before': async (input, output) => {
    appendEvent(extractToolStartEvent(input, output));
  },
  'tool.execute.after': async (input) => {
    appendEvent(extractToolEndEvent(input));
  },
});
