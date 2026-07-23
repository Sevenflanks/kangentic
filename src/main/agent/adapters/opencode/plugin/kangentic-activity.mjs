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

const INITIAL_PROMPT_PATH_ENV = 'KANGENTIC_OPENCODE_INITIAL_PROMPT_PATH';

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
    const sessionInfo = properties.info ?? {};
    const sessionID = sessionInfo.id ?? properties.sessionID ?? null;
    const hookContext = sessionID
      ? JSON.stringify({ sessionID }).slice(0, 2048)
      : undefined;
    return {
      ts: now,
      type: 'session_start',
      ...(hookContext ? { hookContext } : {}),
    };
  }
  if (eventType === 'session.idle') {
    return { ts: now, type: 'idle' };
  }
  if (eventType === 'session.error') {
    return { ts: now, type: 'idle', detail: 'error' };
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
  return {
    ts: now,
    type: 'tool_start',
    ...(input?.tool ? { tool: input.tool } : {}),
    ...(detail ? { detail } : {}),
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

function appendEvent(eventsPath, event) {
  if (!eventsPath || !event) return false;
  try {
    fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n');
    return true;
  } catch {
    return false;
  }
}

function claimInitialPromptSource() {
  const sourcePath = process.env[INITIAL_PROMPT_PATH_ENV];
  if (!sourcePath) return null;
  const claimPath = `${sourcePath}.claim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(sourcePath, claimPath);
    return claimPath;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readInitialPromptPayload(rawText) {
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || payload.version !== 1 || typeof payload.prompt !== 'string' || payload.prompt.length === 0) {
    return null;
  }
  if (payload.mode === 'fresh') {
    const validAgent = payload.agent === undefined || typeof payload.agent === 'string';
    const validModel = payload.model === undefined || (
      payload.model
      && typeof payload.model === 'object'
      && typeof payload.model.providerID === 'string'
      && typeof payload.model.modelID === 'string'
    );
    return validAgent && validModel ? payload : null;
  }
  if (payload.mode === 'resume' && typeof payload.sessionId === 'string' && payload.sessionId.length > 0 && payload.agent === undefined && payload.model === undefined) {
    return payload;
  }
  return null;
}

function removeClaimPath(claimPath) {
  try {
    fs.unlinkSync(claimPath);
    return true;
  } catch {
    return false;
  }
}

function appendSanitizedError(eventsPath) {
  appendEvent(eventsPath, { ts: Date.now(), type: 'idle', detail: 'error' });
}

export const KangenticActivity = async ({ client, directory } = {}) => {
  const eventsPath = process.env.KANGENTIC_EVENTS_PATH;
  let bootstrapSessionID;
  let bootstrapSessionStartWritten = false;
  let claimPath;
  try {
    claimPath = claimInitialPromptSource();
  } catch {
    appendSanitizedError(eventsPath);
    claimPath = null;
  }
  if (claimPath) {
    try {
      const rawText = fs.readFileSync(claimPath, 'utf8');
      if (!removeClaimPath(claimPath)) {
        appendSanitizedError(eventsPath);
      } else {
        claimPath = null;
        const payload = readInitialPromptPayload(rawText);
        if (!payload) {
          appendSanitizedError(eventsPath);
        } else {
          let sessionID;
          if (payload.mode === 'fresh') {
            sessionID = (await client.session.create({ query: { directory }, body: {} })).id;
          } else {
            await client.session.get({ path: { id: payload.sessionId }, query: { directory } });
            sessionID = payload.sessionId;
          }
          bootstrapSessionID = sessionID;
          bootstrapSessionStartWritten = appendEvent(eventsPath, {
            ts: Date.now(),
            type: 'session_start',
            hookContext: JSON.stringify({ sessionID }),
          });
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory },
            body: {
              parts: [{ type: 'text', text: payload.prompt }],
              ...(payload.mode === 'fresh' && payload.agent ? { agent: payload.agent } : {}),
              ...(payload.mode === 'fresh' && payload.model ? { model: payload.model } : {}),
            },
          });
        }
      }
    } catch {
      if (claimPath) removeClaimPath(claimPath);
      appendSanitizedError(eventsPath);
    }
  }

  return {
    event: async ({ event }) => {
      const extracted = extractSessionEvent(event);
      if (extracted?.type === 'session_start' && extracted.hookContext) {
        try {
          const context = JSON.parse(extracted.hookContext);
          if (typeof context.sessionID === 'string') {
            if (context.sessionID === bootstrapSessionID) {
              if (bootstrapSessionStartWritten) return;
              bootstrapSessionStartWritten = appendEvent(eventsPath, extracted);
              return;
            }
          }
        } catch {
          return;
        }
      }
      appendEvent(eventsPath, extracted);
    },
    'tool.execute.before': async (input, output) => {
      appendEvent(eventsPath, extractToolStartEvent(input, output));
    },
    'tool.execute.after': async (input) => {
      appendEvent(eventsPath, extractToolEndEvent(input));
    },
  };
};
