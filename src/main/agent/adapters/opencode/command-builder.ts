import { quoteArg } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { buildHooks } from './hook-manager';
import type { PermissionMode } from '../../../../shared/types';

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
 *   OpenCode's autonomy model is "agents" (Build, Plan, custom) cycled
 *   at runtime via Tab. We map Kangentic's permission-mode dropdown to
 *   the `--agent <name>` flag for the initial spawn only - resume
 *   preserves the user's runtime Tab selection rather than overriding
 *   it. See `mapPermissionModeToAgent` below for the mode-to-agent
 *   table.
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

    // Install the activity-stream plugin into the project's
    // `.opencode/plugins/` directory before the CLI launches. OpenCode
    // auto-discovers plugins from that directory at TUI startup, so no
    // CLI flag or `opencode.json` mutation is required. Mirrors the
    // `buildHooks` side effect in CodexCommandBuilder.buildCodexCommand.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      buildHooks(projectRoot);
    }

    const parts: string[] = [quoteArg(options.opencodePath, shell)];

    if (options.resume && options.sessionId) {
      parts.push('--session', quoteArg(options.sessionId, shell));
      // Resume carries no prompt in the command. `initialPromptDelivery`
      // routes current prompt content through terminal submission after
      // the TUI is ready. We also omit --agent because the saved session
      // may have a user-selected agent that this command must not shadow.
      return parts.join(' ');
    }

    // Map Kangentic's permission-mode dropdown to OpenCode's --agent
    // flag for fresh spawns. Once the TUI is running the user controls
    // autonomy via Tab, so this only sets the initial state.
    const agentName = mapPermissionModeToAgent(options.permissionMode);
    if (agentName) {
      parts.push('--agent', quoteArg(agentName, shell));
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
   * Returns `null` when MCP wiring is disabled or any of the required
   * URL / token values are missing.
   */
  buildOpenCodeEnv(options: OpenCodeCommandOptions): Record<string, string> | null {
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
 * Map Kangentic's `PermissionMode` to the OpenCode primary-agent name
 * passed via `--agent <name>` on fresh spawn.
 *
 *   plan              -> "plan"  (built-in: read-only, no edits/bash)
 *   default           -> null    (omit flag - defer to user's `default_agent` config, falls back to "build")
 *   acceptEdits       -> "build" (built-in: full tool access)
 *   bypassPermissions -> "build" (closest built-in - users wanting full bypass define their own agent and set it as `default_agent`)
 *   dontAsk / auto    -> null    (Claude/Gemini-shaped modes that can leak through; safe to defer)
 *
 * OpenCode's primary agents define their own per-tool permissions, so
 * we do not need to (and should not) inject a global `permission` block.
 * The Tab keybind cycles agents at runtime; this only sets the initial
 * pick. See `runtime.activity.kind = 'hooks_and_pty'` in the adapter
 * for the broader OpenCode integration model.
 */
function mapPermissionModeToAgent(mode: PermissionMode): string | null {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
    case 'bypassPermissions':
      return 'build';
    case 'default':
    case 'dontAsk':
    case 'auto':
    default:
      return null;
  }
}
