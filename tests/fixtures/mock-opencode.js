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

let pending = '';
let pastedText = null;
let awaitingEnter = false;
const capturePath = process.env.MOCK_OPENCODE_CAPTURE_PATH;

function appendCapture(event) {
  if (!capturePath) return;
  fs.appendFileSync(capturePath, `${JSON.stringify(event)}\n`, 'utf8');
}

appendCapture({ kind: 'launch', argv: process.argv.slice(2) });

// Fixed session ID for new sessions - uses the native ses_* format
// (ses_<26 alphanumeric>) that the adapter's fromOutput regex matches.
const MOCK_SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';

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
const timeout = setTimeout(() => { process.exit(0); }, 30000);

// Exit cleanly on SIGTERM/SIGINT
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

// Keep stdin open so PTY doesn't close
// Real OpenCode 以 raw TTY 接收 bracketed paste；Windows ConPTY 的 cooked mode 不會逐 chunk 交付控制序列。
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03')) {
    clearTimeout(timeout);
    process.exit(0);
    return;
  }

  pending += chunk;
  if (pastedText === null) {
    const start = pending.indexOf('\x1b[200~');
    const end = pending.indexOf('\x1b[201~', start + 6);
    if (start < 0 || end < 0) return;
    pastedText = pending.slice(start + 6, end);
    pending = pending.slice(end + 6);
    awaitingEnter = true;
  }
  if (awaitingEnter && pending.startsWith('\r')) {
    appendCapture({ kind: 'prompt', text: pastedText });
    pending = pending.slice(1);
    pastedText = null;
    awaitingEnter = false;
  }
});
process.stdin.resume();
