// kangentic-activity
// OpenCode plugin that emits structured activity events into the
// Kangentic events.jsonl pipeline. Discovered automatically by
// OpenCode via the PTY working directory's `.opencode/plugins/` directory.
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
// The pure event-extraction helpers stay private; their behavior is
// exercised through KangenticActivity's returned hooks against captured
// OpenCode event fixtures (tests/fixtures/opencode-plugin-events.json).
import fs from 'node:fs';

// allow: SIZE_OK - 單一安裝 asset 保留 bootstrap closure，避免 OpenCode plugin discovery 失配。
const INITIAL_PROMPT_PATH_ENV = 'KANGENTIC_OPENCODE_INITIAL_PROMPT_PATH';
const RESUME_SESSION_ID_ENV = 'KANGENTIC_OPENCODE_RESUME_SESSION_ID';

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
function extractSessionEvent(event, now = Date.now()) {
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
function extractToolDetail(args) {
  if (!args || typeof args !== 'object') return undefined;
  return truncate(args.command ?? args.filePath ?? args.path ?? args.pattern ?? null);
}

/**
 * Extract a `tool_start` event from OpenCode's `tool.execute.before`
 * (input, output) handler arguments.
 */
function extractToolStartEvent(input, output, now = Date.now()) {
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
function extractToolEndEvent(input, now = Date.now()) {
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

function claimInitialPromptSource(sourcePath) {
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
    const validModel = payload.model === undefined || (
      payload.model
      && typeof payload.model === 'object'
      && typeof payload.model.providerID === 'string'
      && typeof payload.model.modelID === 'string'
    );
    return payload.agent === undefined && validModel ? payload : null;
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

function appendSanitizedError(eventsPath, nativeSessionId = null) {
  const occurredAt = Date.now();
  appendEvent(eventsPath, {
    ts: occurredAt,
    type: 'idle',
    detail: 'error',
    privateNativeBoundary: privateBoundary('error', nativeSessionId, occurredAt),
  });
}

// 已發布的 OpenCode legacy loader 會把每個 named function export 當作 factory 呼叫，所以 helper 必須維持 private。
export const KangenticActivity = ({ client, directory } = {}) => {
  const eventsPath = process.env.KANGENTIC_EVENTS_PATH;
  const initialPromptSourcePath = process.env[INITIAL_PROMPT_PATH_ENV];
  const resumeSessionID = process.env[RESUME_SESSION_ID_ENV];
  const bootstrapOwnsSessionStart = Boolean(initialPromptSourcePath || resumeSessionID);
  let bootstrapTimerScheduled = false;
  // 已知的 promptless resume 可能在 timer 前送來 session.created；匹配 ID 必須等 session.get 成功後才可發布。
  let bootstrapSessionID = resumeSessionID;
  let pendingBootstrapSessionStart = null;
  let bootstrapSessionValidated = false;
  let bootstrapSessionStartWritten = false;
  let bootstrapFailureReported = false;

  const appendBootstrapSessionStart = (event) => {
    if (bootstrapSessionStartWritten) return;
    bootstrapSessionStartWritten = appendEvent(eventsPath, event);
  };

  const makeBootstrapSessionStart = (sessionID) => {
    const occurredAt = Date.now();
    return {
      ts: occurredAt,
      type: 'session_start',
      hookContext: JSON.stringify({ sessionID }),
      privateNativeBoundary: privateBoundary('created', sessionID, occurredAt),
    };
  };

  const reportSanitizedBootstrapFailure = (claimPath = null) => {
    if (bootstrapFailureReported) return;
    bootstrapFailureReported = true;
    if (claimPath) removeClaimPath(claimPath);
    appendSanitizedError(eventsPath, bootstrapSessionID ?? null);
  };

  const hooks = {
    event: ({ event }) => {
      const extracted = extractSessionEvent(event);
      if (extracted?.type === 'session_start' && bootstrapOwnsSessionStart) {
        const nativeSessionID = extracted.privateNativeBoundary?.nativeSessionId ?? null;
        if (!bootstrapSessionValidated) {
          if (nativeSessionID !== null) {
            bootstrapSessionID = nativeSessionID;
            pendingBootstrapSessionStart = extracted;
          }
          return;
        }
        if (nativeSessionID === bootstrapSessionID) appendBootstrapSessionStart(extracted);
        return;
      }
      appendEvent(eventsPath, extracted);
    },
    'tool.execute.before': (input, output) => {
      appendEvent(eventsPath, extractToolStartEvent(input, output));
    },
    'tool.execute.after': (input) => {
      appendEvent(eventsPath, extractToolEndEvent(input));
    },
  };

  // OpenCode 1.18.4 會 await factory，但不會 await event hooks；先回傳同步 hooks，避免 session.create reentrancy 卡住。
  if (!bootstrapTimerScheduled) {
    bootstrapTimerScheduled = true;
    setTimeout(() => {
      let claimPath = null;

      const runBootstrap = async () => {
        let payload = null;
        if (initialPromptSourcePath) {
          try {
            claimPath = claimInitialPromptSource(initialPromptSourcePath);
          } catch {
            reportSanitizedBootstrapFailure(claimPath);
            return;
          }
          if (!claimPath) return;

          let rawText;
          try {
            rawText = fs.readFileSync(claimPath, 'utf8');
          } catch {
            reportSanitizedBootstrapFailure(claimPath);
            return;
          }
          if (!removeClaimPath(claimPath)) {
            // 已嘗試刪除 claim；不可再交給 reporter，避免 failure handling 變成隱性 retry。
            reportSanitizedBootstrapFailure();
            return;
          }
          claimPath = null;

          payload = readInitialPromptPayload(rawText);
          if (!payload) {
            reportSanitizedBootstrapFailure();
            return;
          }
        }

        const requestedSessionID = payload?.sessionId ?? resumeSessionID;
        if (typeof requestedSessionID !== 'string' || requestedSessionID.length === 0) return;
        bootstrapSessionID ??= requestedSessionID;
        let sessionID = bootstrapSessionID;
        let firstValidationSucceeded = true;
        // 第一個 target 成功或失敗後都要比較最新 native identity；最多只驗證一次替代 ID，避免無界重試。
        try {
          await client.session.get({
            path: { id: sessionID },
            query: { directory },
            throwOnError: true,
          });
        } catch {
          firstValidationSucceeded = false;
        }
        if (bootstrapSessionID !== sessionID) {
          sessionID = bootstrapSessionID;
          try {
            await client.session.get({
              path: { id: sessionID },
              query: { directory },
              throwOnError: true,
            });
          } catch {
            reportSanitizedBootstrapFailure();
            return;
          }
          if (bootstrapSessionID !== sessionID) {
            reportSanitizedBootstrapFailure();
            return;
          }
        } else if (!firstValidationSucceeded) {
          reportSanitizedBootstrapFailure();
          return;
        }
        bootstrapSessionID = sessionID;
        rootSessionId = sessionID;
        bootstrapSessionValidated = true;
        const pendingNativeSessionID = pendingBootstrapSessionStart
          ?.privateNativeBoundary?.nativeSessionId ?? null;
        appendBootstrapSessionStart(
          pendingNativeSessionID === sessionID
            ? pendingBootstrapSessionStart
            : makeBootstrapSessionStart(sessionID),
        );

        if (!payload) return;

        try {
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory },
            body: {
              parts: [{ type: 'text', text: payload.prompt }],
            },
            throwOnError: true,
          });
        } catch {
          reportSanitizedBootstrapFailure();
        }
      };

      void runBootstrap().catch(() => reportSanitizedBootstrapFailure(claimPath));
    }, 0);
  }

  return hooks;
};
