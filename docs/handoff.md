# Cross-Agent Handoff

When a task changes to a different agent, Kangentic can give the receiving agent a reference to the source adapter's native conversation history. It does not synthesize a transcript, git summary, metrics packet, or `handoff-context.md` file.

## Overview

The handoff pipeline resolves an optional native history location through the source adapter, then prepends XML instructions and the location to the target agent's initial prompt. The target starts a new session. The reference is guidance, not a forced read, so the target agent might not consume the path.

| Component | File | Purpose |
|-----------|------|---------|
| Session History Reference | `src/main/agent/handoff/session-history-reference.ts` | Builds the XML reference and fallback guidance for the target prompt |
| Prompt XML | `src/main/agent/shared/prompt-xml.ts` | Renders `<handoff_context>` with the source agent and optional path |
| Handoff Repository | `src/main/db/repositories/handoff-repository.ts` | Stores the handoff audit metadata |

Native conversation history remains owned by each adapter in its user or project storage. Depending on the adapter and CLI version, that storage can be a file, project-level history, or a database. Adapter paths are empirical implementation details and can change between CLI releases.

## When Handoff Runs

`spawnAgent()` prepares a handoff only when all of these conditions hold:

1. Resolving the destination lane selects a different agent from the task's current agent.
2. The task has a prior session record.
3. The destination lane has `handoff_context` enabled.

The destination setting defaults to disabled. A new task, a task whose agent does not change, or a destination lane with handoff disabled starts through the normal spawn path without a handoff audit row.

## Handoff Flow

```
Task moves to a lane resolved to a different agent
    |
    v
spawnAgent() confirms prior session and enabled handoff_context
    |
    v
Source adapter attempts locateSessionHistoryFile(agent_session_id, cwd)
    |
    +-- path found: XML reference points to native history
    |
    +-- no path: XML reference advises checking git log
    |
    v
Insert handoffs audit row with metadata and nullable session_history_path
    |
    v
Start a new target PTY session with the XML reference before its task prompt
    |
    v
Update the audit row with the target session record ID when spawn succeeds
```

History lookup is best effort. A missing source adapter, missing `agent_session_id`, unsupported lookup, or absent history file still permits the handoff record to be written with `session_history_path = NULL`. The target prompt then advises the agent to inspect `git log` for prior branch changes.

## Identity and Storage Boundaries

Kangentic creates each runtime session directory at:

```
<project>/.kangentic/sessions/<ptySessionId>/
```

`ptySessionId` is the `sessions.id` database value and is distinct from `sessions.agent_session_id`. The latter is adapter-native, may be null, and is used for native history lookup and adapter-specific resume behavior. Kangentic-owned session files are:

```
.kangentic/sessions/<ptySessionId>/
  status.json
  events.jsonl
  settings.json       # present when the adapter writes merged settings
  mcp.json            # present when the adapter and MCP configuration use it
  commands.jsonl      # present only for adapters or features that use it
  responses/          # present only for adapters or features that use it
```

Only `status.json` and `events.jsonl` are the standard Kangentic telemetry outputs. The other entries are conditional. Native conversation history is not copied into this directory.

## Prompt Delivery

`buildSessionHistoryReference()` creates top-level instructions followed by a `<handoff_context>` XML element. When a native path is found, the prompt tells the target agent where to find it and asks it to read the prior history for context. Claude targets also receive the optional MCP hint `kangentic_get_session_history`.

The direct history hint is separate from `kangentic_get_transcript`. The former reads an adapter-native history source when it can be located. The latter is structured transcript tooling that parses supported native histories or returns raw PTY scrollback, depending on the requested format and adapter capability.

## Aider

Aider has no native resume ID and no per-session native history. Its adapter can locate the project-level `.aider.chat.history.md` when present, but that cumulative file is not tied to a specific session. Handoff therefore treats any Aider path as best-effort context, not a session-scoped resume artifact.

## Database Storage

Handoff records in `handoffs` provide an audit trail:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | Unique handoff ID |
| `task_id` | TEXT FK | Task being handed off |
| `from_session_id` | TEXT FK | Source PTY session record, nullable |
| `to_session_id` | TEXT FK | Target PTY session record, set after a successful spawn |
| `from_agent` | TEXT | Source adapter name |
| `to_agent` | TEXT | Target adapter name |
| `trigger` | TEXT | Handoff cause, currently `column_transition` |
| `session_history_path` | TEXT | Optional source adapter-native history location |
| `packet_json` | TEXT | Legacy schema field, not current runtime input or repository output |
| `created_at` | TEXT | ISO timestamp |

## MCP Access

`kangentic_get_handoff_context` returns the latest handoff metadata and its optional native-history path. `kangentic_get_session_history` is the direct native-history lookup. `kangentic_get_transcript` remains separate structured transcript tooling. See [MCP Server](mcp-server.md) for adapter support and format details.

## Disabling Handoff

The destination lane's handoff-context setting controls this behavior. When it is disabled, an agent change still selects and starts the destination adapter, but Kangentic does not resolve native history, build handoff XML, or create a handoff audit row. This supports independent review lanes that should begin from the task and repository state alone.

## See Also

- [Agent Integration](agent-integration.md)
- [Session Lifecycle](session-lifecycle.md)
- [Database](database.md)
- [MCP Server](mcp-server.md)
