import fs from 'node:fs';

const INITIAL_PROMPT_PATH_ENV = 'KANGENTIC_OPENCODE_TUI_INITIAL_PROMPT_PATH';
const EVENTS_PATH_ENV = 'KANGENTIC_EVENTS_PATH';

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

function readFreshPayload(rawText) {
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || payload.version !== 1 || payload.mode !== 'fresh' || typeof payload.prompt !== 'string' || payload.prompt.length === 0) {
    return null;
  }
  const validModel = payload.model === undefined || (
    payload.model
    && typeof payload.model === 'object'
    && typeof payload.model.providerID === 'string'
    && typeof payload.model.modelID === 'string'
  );
  return payload.agent === undefined && validModel ? payload : null;
}

function removeClaimPath(claimPath) {
  try {
    fs.unlinkSync(claimPath);
    return true;
  } catch {
    return false;
  }
}

function appendSanitizedFailure(nativeSessionId = null) {
  const occurredAt = Date.now();
  try {
    fs.appendFileSync(process.env[EVENTS_PATH_ENV], `${JSON.stringify({
      ts: occurredAt,
      type: 'idle',
      detail: 'error',
      privateNativeBoundary: {
        kind: 'error',
        nativeSessionId,
        occurredAt,
      },
    })}\n`);
  } catch {
    return false;
  }
  return true;
}

// TUI mount owns navigation because `tui.session.select` is lossy before this route exists.
export default {
  id: 'kangentic-startup',
  async tui(api) {
    let claimPath;
    try {
      claimPath = claimInitialPromptSource(process.env[INITIAL_PROMPT_PATH_ENV]);
    } catch {
      appendSanitizedFailure();
      return;
    }
    if (!claimPath) return;

    let rawText;
    try {
      rawText = fs.readFileSync(claimPath, 'utf8');
    } catch {
      removeClaimPath(claimPath);
      appendSanitizedFailure();
      return;
    }
    if (!removeClaimPath(claimPath)) {
      appendSanitizedFailure();
      return;
    }

    const payload = readFreshPayload(rawText);
    if (!payload) {
      appendSanitizedFailure();
      return;
    }

    let nativeSessionId = null;
    try {
      const result = await api.client.session.create({ directory: api.directory });
      const session = result?.data;
      if (!session || typeof session !== 'object' || typeof session.id !== 'string' || session.id.length === 0) {
        appendSanitizedFailure();
        return;
      }
      nativeSessionId = session.id;
      api.route.navigate('session', { sessionID: session.id });
      const promptResult = await api.client.session.promptAsync({
        sessionID: session.id,
        parts: [{ type: 'text', text: payload.prompt }],
        ...(payload.model ? { model: payload.model } : {}),
      });
      if (promptResult?.error !== undefined) {
        appendSanitizedFailure(nativeSessionId);
      }
    } catch {
      appendSanitizedFailure(nativeSessionId);
    }
  },
};
