#!/usr/bin/env node
/**
 * MANUAL VALIDATION SCRIPT - not wired to CI or any npm script.
 *
 * Empirically validates how the real Claude Code CLI handles /clear:
 *   1. Does /clear fork the conversation to a NEW session id?
 *   2. Which hooks (SessionStart / SessionEnd / UserPromptSubmit / Stop) fire
 *      around the /clear, and with WHICH session_id in their payloads?
 *   3. Does the statusline payload (what Kangentic persists as status.json)
 *      flip to the new session id afterwards?
 *
 * Runs one real `claude` session (default model haiku, two one-line prompts,
 * ~cents of usage) inside a throwaway temp workspace, under node-pty, with a
 * logging statusline command and logging hooks. Prints an ordered report and
 * writes sanitized pre-/post-clear statusline payloads next to the logs for
 * use as pinned test fixtures.
 *
 * Usage:  node scripts/validate-clear-fork.mjs [--model <model>]
 * Output: the temp workspace path is printed and kept for inspection.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nodePty = require('node-pty');

const modelArgIndex = process.argv.indexOf('--model');
const model = modelArgIndex !== -1 ? process.argv[modelArgIndex + 1] : 'haiku';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-clear-fork-'));
const outDir = path.join(workspace, 'out');
fs.mkdirSync(outDir);
const hooksLogPath = path.join(outDir, 'hooks.jsonl');
const statusLogPath = path.join(outDir, 'status.jsonl');
const loggerPath = path.join(workspace, 'logger.mjs');
const settingsPath = path.join(workspace, 'settings.json');
const initialSessionId = randomUUID();

// Appending logger: a superset of status-bridge.js (which overwrites), so the
// full sequence of statusline payloads is retained and id flips stay visible.
fs.writeFileSync(loggerPath, `
import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { payload = { raw: input }; }
  const line = JSON.stringify({ loggedAt: new Date().toISOString(), kind: process.argv[3], payload });
  try { fs.appendFileSync(process.argv[2], line + '\\n'); } catch { /* ignore */ }
  process.stdout.write('');
});
`);

const loggerCommand = (logPath, kind) =>
  `node "${loggerPath.replaceAll('\\', '/')}" "${logPath.replaceAll('\\', '/')}" ${kind}`;
const hookEntry = (kind) => [
  { matcher: '', hooks: [{ type: 'command', command: loggerCommand(hooksLogPath, kind) }] },
];
fs.writeFileSync(settingsPath, JSON.stringify({
  statusLine: { type: 'command', command: loggerCommand(statusLogPath, 'status'), refreshInterval: 5 },
  hooks: {
    SessionStart: hookEntry('SessionStart'),
    SessionEnd: hookEntry('SessionEnd'),
    UserPromptSubmit: hookEntry('UserPromptSubmit'),
    Stop: hookEntry('Stop'),
  },
}, null, 2));

// Strip the parent Claude Code session's identity markers, mirroring
// buildSpawnEnv (src/main/pty/spawn/pty-spawn.ts): a child inheriting them
// does not persist its own transcript, which would corrupt this experiment.
const cleanEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
  cleanEnv[key] = value;
}

const claudeArgs = ['--session-id', initialSessionId, '--model', model, '--settings', settingsPath];
const pty = process.platform === 'win32'
  ? nodePty.spawn('cmd.exe', ['/c', 'claude', ...claudeArgs], { cwd: workspace, env: cleanEnv, cols: 120, rows: 40 })
  : nodePty.spawn('claude', claudeArgs, { cwd: workspace, env: cleanEnv, cols: 120, rows: 40 });

const scrollbackPath = path.join(outDir, 'scrollback.txt');
let scrollback = '';
let exited = false;
pty.onData((data) => {
  scrollback += data;
  try { fs.appendFileSync(scrollbackPath, data); } catch { /* ignore */ }
});
pty.onExit(() => { exited = true; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auto-accept the folder trust prompt shown for the fresh temp workspace.
// The TUI interleaves ANSI cursor/positioning sequences between letters, so
// the raw bytes must be stripped before text matching; the stripped text may
// also have its spaces collapsed. Match distinctive fragments once.
let trustPromptHandled = false;
function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '');
}
function maybeAcceptTrustPrompt() {
  if (trustPromptHandled) return;
  const recent = stripAnsi(scrollback.slice(-6000));
  if (/safety\s*check|trust\s*this\s*folder/i.test(recent)) {
    trustPromptHandled = true;
    console.log('[validator] accepting folder trust prompt');
    pty.write('\r');
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    maybeAcceptTrustPrompt();
    await sleep(250);
  }
  console.log(`TIMEOUT waiting for: ${label}`);
  console.log(`--- scrollback tail ---\n${stripAnsi(scrollback.slice(-1500))}\n--- end tail ---`);
  return false;
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const hookCount = (kind) => readLog(hooksLogPath).filter((entry) => entry.kind === kind).length;

async function typeSlowly(text) {
  for (const char of text) {
    pty.write(char);
    await sleep(40);
  }
}

async function main() {
  console.log(`workspace: ${workspace}`);
  console.log(`initial --session-id: ${initialSessionId}`);
  console.log(`model: ${model}\n`);

  await waitFor(() => hookCount('SessionStart') >= 1, 60_000, 'SessionStart hook (boot)');
  await sleep(3000);

  console.log('turn 1: sending prompt...');
  const stopsBeforeTurn1 = hookCount('Stop');
  await typeSlowly('Say OK and nothing else.');
  await sleep(400);
  pty.write('\r');
  await waitFor(() => hookCount('Stop') > stopsBeforeTurn1, 90_000, 'Stop hook (turn 1)');
  await sleep(2000);

  console.log('sending /clear...');
  await typeSlowly('/clear');
  await sleep(800);
  pty.write('\r');
  await sleep(6000);

  console.log('turn 2: sending prompt...');
  const stopsBeforeTurn2 = hookCount('Stop');
  await typeSlowly('Say OK again.');
  await sleep(400);
  pty.write('\r');
  await waitFor(() => hookCount('Stop') > stopsBeforeTurn2, 90_000, 'Stop hook (turn 2)');

  // Let the statusline refresh once more after the final turn, then exit.
  await sleep(7000);
  pty.write('\x03');
  await sleep(400);
  pty.write('\x03');
  await waitFor(() => exited, 15_000, 'CLI exit');
  if (!exited) pty.kill();
  await sleep(1000);

  report();
}

function shortId(value) {
  return typeof value === 'string' ? value.slice(0, 8) : String(value);
}

function report() {
  console.log('\n================ REPORT ================');

  const statusEntries = readLog(statusLogPath);
  console.log(`\nstatusline payloads: ${statusEntries.length}`);
  const orderedStatusIds = [];
  for (const entry of statusEntries) {
    const sessionId = entry.payload.session_id;
    const last = orderedStatusIds[orderedStatusIds.length - 1];
    if (!last || last.sessionId !== sessionId) {
      orderedStatusIds.push({ sessionId, firstSeen: entry.loggedAt, transcriptPath: entry.payload.transcript_path });
    }
  }
  console.log('ordered distinct statusline session_ids:');
  for (const item of orderedStatusIds) {
    console.log(`  ${shortId(item.sessionId)}  first seen ${item.firstSeen}  transcript ${path.basename(item.transcriptPath ?? '?')}`);
  }

  console.log('\nhook firings (ordered):');
  for (const entry of readLog(hooksLogPath)) {
    const payload = entry.payload;
    const extra = payload.source ? ` source=${payload.source}` : payload.reason ? ` reason=${payload.reason}` : '';
    console.log(`  ${entry.loggedAt}  ${entry.kind}${extra}  session_id=${shortId(payload.session_id)}  transcript=${path.basename(payload.transcript_path ?? '?')}`);
  }

  const anyTranscriptPath = statusEntries[0]?.payload.transcript_path
    ?? readLog(hooksLogPath)[0]?.payload.transcript_path;
  if (anyTranscriptPath) {
    const slugDir = path.dirname(anyTranscriptPath);
    console.log(`\ntranscripts in ${slugDir}:`);
    if (fs.existsSync(slugDir)) {
      for (const fileName of fs.readdirSync(slugDir).filter((name) => name.endsWith('.jsonl'))) {
        const stats = fs.statSync(path.join(slugDir, fileName));
        console.log(`  ${fileName}  ${stats.size} bytes  mtime ${stats.mtime.toISOString()}`);
      }
    }
  }

  const distinctIds = orderedStatusIds.map((item) => item.sessionId).filter(Boolean);
  console.log('\nVERDICT:');
  if (distinctIds.length > 1) {
    console.log(`  /clear FORKED the session: statusline moved ${distinctIds.map(shortId).join(' -> ')}`);
  } else if (distinctIds.length === 1) {
    console.log(`  statusline reported a single session id (${shortId(distinctIds[0])}): NO fork observed`);
  } else {
    console.log('  no statusline payload captured; inspect logs');
  }

  writeFixtures(statusEntries, distinctIds);
  console.log(`\nlogs kept at: ${outDir}`);
}

// Emit sanitized pre-/post-clear statusline payloads as fixture candidates
// (personal paths replaced per the no-personal-info rule).
function writeFixtures(statusEntries, distinctIds) {
  if (distinctIds.length < 2) return;
  const [originalId, forkedId] = [distinctIds[0], distinctIds[distinctIds.length - 1]];
  const preClear = [...statusEntries].reverse().find((entry) => entry.payload.session_id === originalId);
  const postClear = statusEntries.find((entry) => entry.payload.session_id === forkedId);
  const sanitize = (payload) => {
    const home = os.homedir();
    const mungedHome = home.replace(/[^a-zA-Z0-9]/g, '-');
    return JSON.parse(
      JSON.stringify(payload)
        .replaceAll(JSON.stringify(home).slice(1, -1), 'C:\\\\Users\\\\dev')
        .replaceAll(mungedHome, 'C--Users-dev'),
    );
  };
  if (preClear) fs.writeFileSync(path.join(outDir, 'fixture-pre-clear.json'), JSON.stringify(sanitize(preClear.payload), null, 2));
  if (postClear) fs.writeFileSync(path.join(outDir, 'fixture-post-clear.json'), JSON.stringify(sanitize(postClear.payload), null, 2));
  console.log('  fixture candidates written: fixture-pre-clear.json / fixture-post-clear.json');
}

main().then(() => {
  try { pty.kill(); } catch { /* already dead */ }
  process.exit(0);
}).catch((error) => {
  console.error(error);
  try { pty.kill(); } catch { /* already dead */ }
  process.exit(1);
});
