import fs from 'node:fs';
import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { resolvePluginScript } from '../../shared/bridge-utils';
import { isGitRepo } from '../../../git/git-checks';

/**
 * OpenCode plugin events mapped to event-bridge event types. Documented
 * here to give tests a canonical mapping to assert against. The actual
 * event-handler logic lives inside the plugin file
 * (`plugin/kangentic-activity.mjs`), because OpenCode plugins run inline
 * in the OpenCode process and write JSONL directly rather than shelling
 * out to event-bridge.
 *
 * OpenCode plugin event names (verified against
 * https://opencode.ai/docs/plugins/, April 2026):
 *  - `event` with `event.type === 'session.created'` -> session_start
 *  - `event` with `event.type === 'session.start'`   -> session_start
 *  - `event` with `event.type === 'session.idle'`    -> idle
 *  - `event` with `event.type === 'session.error'`   -> idle (detail: 'error')
 *  - `tool.execute.before`                           -> tool_start + private root turn boundary
 *  - `tool.execute.after`                            -> tool_end
 */
export const OPENCODE_HOOK_EVENTS: Array<{
  hook: string;
  bridgeEventType: EventType;
  notes?: string;
}> = [
  { hook: 'event:session.created', bridgeEventType: EventType.SessionStart, notes: 'captures sessionID and private native boundary' },
  { hook: 'event:session.start', bridgeEventType: EventType.SessionStart, notes: 'captures sessionID and private native boundary' },
  { hook: 'event:session.idle', bridgeEventType: EventType.Idle },
  { hook: 'event:session.error', bridgeEventType: EventType.Idle, notes: "detail: 'error'" },
  { hook: 'tool.execute.before', bridgeEventType: EventType.ToolStart, notes: 'private turn-start only for the process root' },
  { hook: 'tool.execute.after', bridgeEventType: EventType.ToolEnd },
];

const PLUGIN_FILENAME = 'kangentic-activity.mjs';
const PLUGIN_SENTINEL = '// kangentic-activity';
const PLUGIN_GITIGNORE_ENTRY = '.opencode/plugins/kangentic-activity.mjs';

/** Directory under a project root where OpenCode auto-loads plugins. */
function pluginsDir(projectRoot: string): string {
  return path.join(projectRoot, '.opencode', 'plugins');
}

function pluginPath(projectRoot: string): string {
  return path.join(pluginsDir(projectRoot), PLUGIN_FILENAME);
}

/**
 * Add `.opencode/plugins/kangentic-activity.mjs` to the project's
 * `.gitignore` so the auto-installed plugin file is not committed by
 * mistake. Only runs when the project is a git repo - in non-git
 * directories there is nothing to ignore. Idempotent: skips the write
 * if the entry is already present. Wrapped in try/catch so a read-only
 * directory cannot break the spawn path.
 */
function ensurePluginGitignored(projectRoot: string): void {
  if (!isGitRepo(projectRoot)) return;
  try {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    let content = '';
    try {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    } catch {
      // No .gitignore yet - we'll create one.
    }

    const alreadyIgnored = content
      .split('\n')
      .some((line) => line.trim() === PLUGIN_GITIGNORE_ENTRY);
    if (alreadyIgnored) return;

    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, content + separator + PLUGIN_GITIGNORE_ENTRY + '\n');
  } catch (error) {
    console.warn(`[opencode-hooks] Could not update .gitignore at ${projectRoot}:`, error);
  }
}

/**
 * Copy the Kangentic OpenCode plugin into `<projectRoot>/.opencode/plugins/`.
 * OpenCode auto-discovers plugins in this directory at TUI startup, so no
 * mutation of `opencode.json` is required.
 *
 * The plugin reads its events output path from the `KANGENTIC_EVENTS_PATH`
 * env var (exported by the PTY spawn flow); the path is therefore not a
 * parameter of this function. Idempotent: skips the copy when the
 * destination file is byte-identical to the packaged source. Concurrent
 * OpenCode sessions in the same project share one plugin file (refcount
 * in `OpenCodeAdapter.hookHolders`).
 */
export function buildHooks(projectRoot: string): void {
  const sourcePath = resolvePluginScript('opencode', 'kangentic-activity');
  if (!fs.existsSync(sourcePath)) {
    console.warn(`[opencode-hooks] Plugin source not found at ${sourcePath}; skipping install.`);
    return;
  }

  const destinationDir = pluginsDir(projectRoot);
  const destinationFile = pluginPath(projectRoot);

  try {
    fs.mkdirSync(destinationDir, { recursive: true });
  } catch (error) {
    console.error(`[opencode-hooks] Failed to create ${destinationDir}:`, error);
    return;
  }

  let needsCopy = true;
  if (fs.existsSync(destinationFile)) {
    try {
      const sourceContents = fs.readFileSync(sourcePath);
      const destinationContents = fs.readFileSync(destinationFile);
      if (sourceContents.equals(destinationContents)) {
        needsCopy = false;
      }
    } catch {
      // Fall through to overwrite.
    }
  }

  if (needsCopy) {
    try {
      fs.copyFileSync(sourcePath, destinationFile);
    } catch (error) {
      console.error(`[opencode-hooks] Failed to copy plugin to ${destinationFile}:`, error);
    }
  }

  // Only ignore the plugin file once it actually exists at the destination.
  // This covers both "we just copied it" and "it was already there from a
  // previous spawn", and skips cleanly when the copy/mkdir failed - so the
  // gitignore entry is never written ahead of the file it ignores.
  if (fs.existsSync(destinationFile)) {
    ensurePluginGitignored(projectRoot);
  }
}

/**
 * Remove the Kangentic-authored plugin file from a project's
 * `.opencode/plugins/` directory. Verifies the sentinel comment on
 * line 1 before deletion so user-authored plugins are never touched.
 *
 * Best-effort cleanup of empty `.opencode/plugins/` and `.opencode/`
 * directories: leaves them in place if other files exist.
 */
export function removeHooks(directory: string): void {
  const file = pluginPath(directory);
  if (!fs.existsSync(file)) return;

  try {
    const contents = fs.readFileSync(file, 'utf-8');
    const firstLine = contents.split('\n', 1)[0] ?? '';
    if (!firstLine.includes(PLUGIN_SENTINEL)) {
      // Not our file. Leave it alone.
      return;
    }
    fs.unlinkSync(file);
  } catch (error) {
    console.error(`[opencode-hooks] Failed to remove ${file}:`, error);
    return;
  }

  // Best-effort directory cleanup. Ignore errors: a non-empty directory
  // means the user has other plugins or assets we should not touch.
  try { fs.rmdirSync(pluginsDir(directory)); } catch { /* not empty or already gone */ }
  try { fs.rmdirSync(path.join(directory, '.opencode')); } catch { /* not empty or already gone */ }
}
