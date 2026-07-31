#!/usr/bin/env node
/**
 * Mock OpenCode CLI for E2E tests.
 *
 * OpenCode command shapes (see src/main/agent/adapters/opencode/command-builder.ts):
 *   opencode --version                              -> detector probe
 *   opencode --session <id>                         -> resume existing session
 *   opencode                                        -> new session
 *
 * Markers for test assertions:
 *   MOCK_OPENCODE_SESSION:<id>    -> new session created
 *   MOCK_OPENCODE_RESUMED:<id>    -> existing session resumed via --session
 *
 * Also prints `session id: <ses_*>` so the OpenCode adapter's runtime
 * `fromOutput` regex captures the session ID from PTY output.
 *
 * Env knobs:
 *   MOCK_OPENCODE_NO_HEADER=1  -> suppress the `session id:` header so tests
 *                                  can exercise the fromFilesystem fallback path.
 *
 * Stays alive for 30 seconds to simulate a running session, then exits cleanly.
 * Prints cursor-hide ESC `\x1b[?25l` so detectFirstOutput() fires and the
 * shimmer overlay clears.
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

// Version detection (called by AgentDetector)
if (args.includes('--version')) {
  console.log('opencode 1.14.25-mock');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: opencode [options]');
  process.exit(0);
}

const capturePath = process.env.MOCK_OPENCODE_CAPTURE_PATH;
const liveDeliveryDir = process.env.MOCK_OPENCODE_LIVE_DELIVERY === '1'
  ? process.env.MOCK_OPENCODE_LIVE_DELIVERY_DIR
  : null;
const livePaths = liveDeliveryDir ? {
  receipt: path.join(liveDeliveryDir, 'live-receipt.txt'),
  initialReceipt: path.join(liveDeliveryDir, 'initial-receipt.txt'),
  probeReceipt: path.join(liveDeliveryDir, 'probe-receipt.txt'),
  rootIdleTrigger: path.join(liveDeliveryDir, 'emit-root-idle'),
  childIdleTrigger: path.join(liveDeliveryDir, 'emit-child-idle'),
  errorTrigger: path.join(liveDeliveryDir, 'emit-error'),
  launchMarkers: path.join(liveDeliveryDir, 'launch-count.txt'),
  inputCapture: path.join(liveDeliveryDir, 'input-capture.bin'),
} : null;

if (livePaths) {
  fs.appendFileSync(livePaths.launchMarkers, 'launch\n', 'utf8');
}

function appendCapture(event) {
  if (!capturePath) return;
  fs.appendFileSync(capturePath, `${JSON.stringify(event)}\n`, 'utf8');
}

const relevantEnvKeys = [
  'KANGENTIC_OPENCODE_TUI_INITIAL_PROMPT_PATH',
  'KANGENTIC_OPENCODE_INITIAL_PROMPT_PATH',
  'OPENCODE_TUI_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
];
const relevantEnv = Object.fromEntries(
  relevantEnvKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
);
appendCapture({ kind: 'launch', argv: process.argv.slice(2), env: relevantEnv });

// Fixed session ID for new sessions - uses the native ses_* format
// (ses_<26 alphanumeric>) that the adapter's fromOutput regex matches.
const MOCK_SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';

async function activateInstalledPlugins() {
  const pluginPath = path.join(process.cwd(), '.opencode', 'plugins', 'kangentic-activity.js');
  // 以 data URL 固定用 ESM 解析，避免 disposable project 的 package type 將 installed `.js` 當成 CommonJS。
  const pluginBytes = fs.readFileSync(pluginPath);
  const pluginUrl = `data:text/javascript;base64,${pluginBytes.toString('base64')}`;
  const { KangenticActivity } = await import(pluginUrl);
  let activityHooks;
  const activityClient = {
    session: {
      get: async ({ path: requestPath }) => ({ data: { id: requestPath.id } }),
      promptAsync: async (request) => {
        const expectedKeys = ['body', 'path', 'query', 'throwOnError'];
        if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(expectedKeys)) {
          throw new TypeError('resume promptAsync requires the legacy server-plugin request shape');
        }
        const parts = request.body.parts;
        const textPart = parts.find((part) => part.type === 'text');
        if (textPart) appendCapture({ kind: 'prompt', text: textPart.text });
        if (livePaths) fs.writeFileSync(livePaths.initialReceipt, 'received\n', 'utf8');
        return undefined;
      },
    },
  };
  activityHooks = KangenticActivity({
    client: activityClient,
    directory: process.cwd(),
  });

  const startupConfigPath = process.env.OPENCODE_TUI_CONFIG;
  if (!startupConfigPath) return;
  const startupConfig = JSON.parse(fs.readFileSync(startupConfigPath, 'utf8'));
  appendCapture({ kind: 'tui-config', config: startupConfig });
  const startupPluginUrl = startupConfig.plugin[0];
  const { default: KangenticStartup } = await import(startupPluginUrl);
  const startupClient = {
    session: {
      create: async () => {
        activityHooks.event({
          event: {
            type: 'session.created',
            properties: { info: { id: MOCK_SESSION_ID } },
          },
        });
        return { data: { id: MOCK_SESSION_ID } };
      },
      promptAsync: async (request) => {
        const expectedKeys = request.model === undefined
          ? ['parts', 'sessionID']
          : ['model', 'parts', 'sessionID'];
        if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(expectedKeys)) {
          throw new TypeError('fresh promptAsync requires the flat TUI request shape');
        }
        const textPart = request.parts.find((part) => part.type === 'text');
        if (textPart) appendCapture({ kind: 'prompt', text: textPart.text });
        if (livePaths) fs.writeFileSync(livePaths.initialReceipt, 'received\n', 'utf8');
        return { data: undefined, error: undefined };
      },
    },
  };
  await KangenticStartup.tui({
    client: startupClient,
    directory: process.cwd(),
    route: {
      navigate: (destination, params) => {
        appendCapture({ kind: 'route', destination, sessionId: params.sessionID });
      },
    },
  });
}

let sessionId = null;
let resumed = false;

for (let i = 0; i < args.length; i++) {
  const argument = args[i];

  // --session <id> or --session=<id> (resume form)
  if (argument === '--session' || argument === '-s') {
    if (i + 1 < args.length) {
      sessionId = args[++i].replace(/^['"]|['"]$/g, '');
      resumed = true;
    }
    continue;
  }
  if (argument.startsWith('--session=')) {
    sessionId = argument.slice('--session='.length).replace(/^['"]|['"]$/g, '');
    resumed = true;
    continue;
  }

  // Skip other flags
  if (argument.startsWith('-')) continue;
}

// Use the fixed mock session ID for new sessions
if (!sessionId) {
  sessionId = MOCK_SESSION_ID;
}

// Print the session ID header so fromOutput captures it.
// The label format "session id: <id>" matches the LABELED_SESSION_ID_REGEX
// in opencode-adapter.ts.
if (!process.env.MOCK_OPENCODE_NO_HEADER) {
  console.log('session id: ' + sessionId);
}

// Output test assertion markers
if (resumed) {
  console.log('MOCK_OPENCODE_RESUMED:' + sessionId);
} else {
  console.log('MOCK_OPENCODE_SESSION:' + sessionId);
}

// 先送 shell 也會出現的 generic signals；只有 alternate-screen entry 代表 TUI ready。
process.stdout.write('\x1b[?25l\x1b[?2004h');
setImmediate(() => process.stdout.write('\x1b[?1049h'));

// Stay alive to simulate a running session (30s gives tests time to interact)
const timeout = setTimeout(() => { process.exit(0); }, livePaths ? 120000 : 30000);

function appendLiveEvent(event) {
  const eventsPath = process.env.KANGENTIC_EVENTS_PATH;
  if (!eventsPath) return;
  fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
}

function consumeTrigger(triggerPath, event) {
  if (!fs.existsSync(triggerPath)) return;
  appendLiveEvent(event);
  fs.unlinkSync(triggerPath);
}

const triggerInterval = livePaths ? setInterval(() => {
  const occurredAt = Date.now();
  consumeTrigger(livePaths.childIdleTrigger, {
    ts: occurredAt,
    type: 'idle',
    privateNativeBoundary: {
      kind: 'idle',
      nativeSessionId: 'ses_child2349b5c91ffeKd6qajuUT',
      occurredAt,
    },
  });
  consumeTrigger(livePaths.errorTrigger, {
    ts: occurredAt,
    type: 'idle',
    detail: 'error',
    privateNativeBoundary: {
      kind: 'error',
      nativeSessionId: sessionId,
      occurredAt,
    },
  });
  consumeTrigger(livePaths.rootIdleTrigger, {
    ts: occurredAt,
    type: 'idle',
    privateNativeBoundary: {
      kind: 'idle',
      nativeSessionId: sessionId,
      occurredAt,
    },
  });
}, 25) : null;

activateInstalledPlugins().catch((error) => {
  console.error('MOCK_OPENCODE_PLUGIN_ERROR:', error);
  clearTimeout(timeout);
  process.exit(1);
});

// Exit cleanly on SIGTERM/SIGINT
function stop() {
  clearTimeout(timeout);
  if (triggerInterval) clearInterval(triggerInterval);
}

process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('SIGINT', () => { stop(); process.exit(0); });

// Keep stdin open so PTY doesn't close.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
if (livePaths) {
  let pendingInput = '';
  process.stdin.on('data', (chunk) => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    fs.appendFileSync(livePaths.inputCapture, input);
    if (input.includes(0x03)) {
      stop();
      process.exit(0);
    }
    pendingInput += input.toString('utf8').replaceAll('\x1b', '');
    const lines = pendingInput.split('\r');
    pendingInput = lines.pop() ?? '';
    for (const line of lines) {
      if (line === 'live-command-canary') {
        fs.appendFileSync(livePaths.receipt, 'received\n', 'utf8');
      } else if (line === 'interactive-probe-canary') {
        fs.appendFileSync(livePaths.probeReceipt, 'received\n', 'utf8');
      }
    }
  });
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (chunk.includes('\x03')) {
      clearTimeout(timeout);
      process.exit(0);
    }
  });
}
process.stdin.resume();
