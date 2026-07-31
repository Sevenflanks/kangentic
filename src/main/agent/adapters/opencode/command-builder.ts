import { quoteArg } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { buildHooks } from './hook-manager';
import type { PermissionMode, ResolvedExecutionTarget } from '../../../../shared/types';

export interface OpenCodeCommandOptions {
  opencodePath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  nonInteractive?: boolean;
  statusOutputPath?: string;
  eventsOutputPath?: string;
  shell?: string;
  mcpServerEnabled?: boolean;
  mcpServerUrl?: string;
  mcpServerToken?: string;
  model?: string;
  effort?: string;
  /** Present only when this project's OpenCode execution mode is 'remote'. */
  executionTarget?: ResolvedExecutionTarget;
}

/**
 * Build the shell command string that spawns OpenCode in interactive
 * TUI mode. CLI surface (verified against /anomalyco/opencode docs):
 *
 *   opencode [--session <id>] [--model <provider/model>]
 *
 * Important shape constraints:
 *
 * - Resume uses `--session <id>` (alias `-s`). The flag is part of the
 *   TUI command (the docs list it under "TUI - Terminal User
 *   Interface"), not the `run` subcommand.
 *
 * - There is no `--dangerously-skip-permissions` flag in TUI mode.
 *   That flag is only documented for `opencode run` (non-interactive).
 *   OpenCode 的 agent 由 runtime config 與 Tab 管理。Kangentic 仍儲存
 *   通用 `PermissionMode` 供其他 adapter 使用，但這裡絕不轉成 `--agent`，
 *   避免覆寫 runtime default。
 *
 * - There is no merged settings file and no `--mcp-config` CLI flag.
 *   OpenCode reads MCP and provider config from `opencode.json` (project)
 *   or `~/.config/opencode/opencode.json` (global), plus the
 *   `OPENCODE_CONFIG_CONTENT` env var for inline overrides. The Kangentic
 *   MCP server is wired via `buildOpenCodeEnv()` below, which emits
 *   `OPENCODE_CONFIG_CONTENT` per PTY spawn so we never have to touch
 *   the user's checked-in `opencode.json`. Configs are deep-merged across
 *   sources, so user-defined `mcp.*` entries are preserved.
 */
export class OpenCodeCommandBuilder {
  buildOpenCodeCommand(options: OpenCodeCommandOptions): string {
    const { shell } = options;

    // Remote mode: attach to the user-run server instead of spawning a local
    // session. The server owns providers/models/MCP/tools (per the task's
    // acceptance criteria), so - unlike the local branch below - this never
    // emits --model or installs the activity plugin (there is no local
    // project directory to write it into; the server's filesystem is not
    // ours to touch).
    if (options.executionTarget) {
      return buildOpenCodeAttachCommand(options, options.executionTarget, shell);
    }

    // Install the activity-stream plugin into the PTY working directory's
    // `.opencode/plugins/` directory before the CLI launches. OpenCode
    // auto-discovers plugins from that directory at TUI startup, so no
    // CLI flag or `opencode.json` mutation is required. Mirrors the
    // `buildHooks` side effect in CodexCommandBuilder.buildCodexCommand.
    if (options.eventsOutputPath) {
      buildHooks(options.cwd);
    }

    const parts: string[] = [quoteArg(options.opencodePath, shell)];

    if (options.resume && options.sessionId) {
      parts.push('--session', quoteArg(options.sessionId, shell));
      // Resume carries no prompt in the command; OpenCode runtime config owns agent selection.
      return parts.join(' ');
    }

    // Per-column model override (format: provider/model, e.g., anthropic/claude-sonnet)
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    return parts.join(' ');
  }

  /**
   * Build env vars that inject the Kangentic MCP server into OpenCode.
   *
   * OpenCode loads config from multiple sources and deep-merges them by
   * key. The `OPENCODE_CONFIG_CONTENT` env var is one of those sources,
   * with higher precedence than the project's `opencode.json`, so the
   * launch-fresh URL + token always win. Because the merge is per-key,
   * any user-defined `mcp.*` entries (filesystem, github, etc.) are
   * preserved alongside our `mcp.kangentic` entry.
   *
   * Schema verified against /anomalyco/opencode docs: remote MCP servers
   * use `type: "remote"` (not Claude's `"http"`), `url`, and optional
   * `headers`. We pass the per-launch token via the `X-Kangentic-Token`
   * header that the in-process MCP HTTP server expects.
   *
   * This only wires MCP for a LOCAL spawn (`opencode [project]`), where
   * the process we spawn is the server itself and legitimately reads its
   * own `OPENCODE_CONFIG_CONTENT` at startup. Returns `null` when MCP
   * wiring is disabled or any of the required URL / token values are
   * missing.
   */
  buildOpenCodeEnv(options: OpenCodeCommandOptions): Record<string, string> | null {
    // Remote mode (`options.executionTarget` set): the process Kangentic
    // spawns is `opencode attach <url>`, a stateless HTTP client to a
    // server that was started - and had its config, including any `mcp.*`
    // entries, fixed - independently and earlier. `attach`'s CLI surface
    // has no config-push flags (`--dir`, `--continue`, `--session`,
    // `--fork`, `--username`, `--password` only; verified against
    // `opencode attach --help`), so env vars set on the attach process,
    // including OPENCODE_CONFIG_CONTENT, are never read by the already-
    // running server and cannot wire MCP into it - this holds whether the
    // target host is loopback or genuinely remote. There is currently no
    // way for Kangentic to deliver its MCP tools to a remote OpenCode
    // session; see the `remoteModeCaveat` on the adapter.
    if (options.executionTarget) return null;
    if (!options.mcpServerEnabled) return null;
    if (!options.mcpServerUrl || !options.mcpServerToken) return null;

    const inlineConfig = {
      mcp: {
        kangentic: {
          type: 'remote',
          url: options.mcpServerUrl,
          enabled: true,
          headers: {
            'X-Kangentic-Token': options.mcpServerToken,
          },
        },
      },
    };

    return { OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig) };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}

/**
 * Build `opencode attach <url> [--dir <serverPath>] [--username u] [--password p]
 * [--session <id>]`.
 *
 * Verified against the OpenCode CLI docs: `attach` accepts `--dir`,
 * `--continue`/`-c`, `--session`/`-s`, `--fork`, `--username`/`-u`,
 * `--password`/`-p`. Fresh prompts use the existing post-attach terminal
 * submission path after the TUI is writable. Attach 不解讀 Kangentic 的
 * `PermissionMode`；remote server runtime config 決定 agent。
 *
 * No `--model` is ever emitted here: per the task's acceptance criteria the
 * remote server is the authority for providers and models.
 */
function buildOpenCodeAttachCommand(
  options: OpenCodeCommandOptions,
  target: ResolvedExecutionTarget,
  shell?: string,
): string {
  const parts: string[] = [quoteArg(options.opencodePath, shell), 'attach', quoteArg(target.url, shell)];

  if (target.workingDirectory) {
    parts.push('--dir', quoteArg(target.workingDirectory, shell));
  }
  if (target.auth.kind === 'basic') {
    parts.push('--username', quoteArg(target.auth.username, shell));
    parts.push('--password', quoteArg(target.auth.password, shell));
  }

  if (options.resume && options.sessionId) {
    parts.push('--session', quoteArg(options.sessionId, shell));
    // No prompt on resume, mirroring the local --session resume convention.
    return parts.join(' ');
  }

  return parts.join(' ');
}
