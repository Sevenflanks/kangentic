# Transition Engine

`src/main/transition-engine/transition-engine.ts`

The transition engine executes action chains when tasks move between swimlanes. It handles the logic that makes Kanban columns "active" -- spawning agents, sending commands, managing worktrees, and more.

## Split-Lock Task Move

`task:move` uses a three-phase flow for moves that need worktree preparation or an agent spawn. `withTaskLock(taskId, ...)` is a per-task FIFO lock, so operations on one task are serialized while different tasks can proceed concurrently.

1. **Phase 1, locked and short.** Move the task in the database, capture the source and destination state, and make the priority decision. Fast session lifecycle dispatch, including suspend or kill, stays here. Moves fully handled by To Do, Done, `auto_spawn=false`, or a live-session no-op end in this phase.
2. **Phase 2, unlocked and slow.** Create or prepare the worktree and check out a branch. This git I/O is serialized per project by `WorktreeManager.projectQueues`, not by the task lock. The move's `AbortSignal` reaches this work, so a newer move or explicit cancellation can stop stale work.
3. **Phase 3, locked and short.** Re-read the task and compare its current swimlane and `session_id` with the Phase 1 plan. A deleted task, changed destination, or existing session is a compare-and-swap mismatch, so the handler skips spawning. Otherwise it calls `spawnAgent()`.

Cancellation is requested before queueing on the task lock, allowing an in-flight holder to observe the signal and finish. If Phase 2 or Phase 3 fails or is cancelled, rollback and partial-session cleanup re-enter the task lock. The rollback only restores the original position when the task is still in this move's destination lane, so a newer move remains authoritative.

## Priority Rules on Task Move

When a task moves from one column to another, the IPC handler (`task:move`) checks these conditions in order. The first match wins:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Target is **To Do** (role=`todo`) | Kill session, delete session history and worktree, and delete the branch when `git.autoCleanup` is enabled |
| 2 | Target is **Done** (role=`done`) | Suspend session (resumable), archive task |
| 2.5 | Target has `auto_spawn=false` (non-todo, non-done) | Suspend session |
| 3 | Task has **active session** | Agent, model, session-track, or force-fresh changes can suspend and respawn. An adapter may live-swap an effort change. A permission-only change never restarts a live session. |
| 4 | Task has **no session** | Resume suspended session (with `auto_command` preloaded as resume prompt) OR create worktree (if enabled) + execute transition action chain |

### Priority 3: Active Session Handling

Priority 3 has five sub-cases, checked in order:

**a) Agent change (handoff):** If `resolveTargetAgent()` returns a different agent than the current session's agent, the session is suspended and the engine falls through to the `spawnAgent` path. The `agentOverride` parameter prevents the target session from resuming the old agent's session. Per-task `model_override` and `effort_override` are cleared on handoff because their values are agent-specific; this clear is skipped when `task.agent_override` locks the agent. Native-history handoff behavior additionally requires a prior session, project context, and enabled destination `handoff_context`. It then attempts to locate the source adapter's native history file and gives the target prompt an optional path reference. Without those conditions, the agent change still spawns normally with no history reference or handoff audit row. See [Cross-Agent Handoff](#cross-agent-handoff) below.

**b) Same agent + model change:** A model change is the restart marker. The handler suspends the session and continues through Phases 2 and 3, where the resumed spawn applies the destination model, effort, and permission as adapter-built command options. It does not try a live model swap.

**c) Same agent + effort change:** The adapter decides whether it can apply a concrete effort change live. A live-swap plan is scheduled through `TerminalSubmitScheduler.scheduleKeystrokes`, then its applied settings are persisted on the session record. Without a live-swap capability, a concrete effort delta suspends and respawns so the new setting reaches the adapter command. Deltas compare the session record's `applied_effort`, not the source lane. Entering a default-effort lane does not respawn because resume preserves the existing agent setting.

**d) Same agent + permission-only delta:** The live session remains running. A changed lane permission does not restart it, including the Planning to Executing path where the user already approved the plan in the same session. The spawn-time permission record is not a restart signal.

**e) Same agent, no restart condition:** The session stays alive. An adapter may still schedule a configured `auto_command` through its injection plan.

Transition action chains (priority 4) only fire when a task has no active session.

## Transition Lookup

Transitions are stored in the `swimlane_transitions` table with `from_swimlane_id` and `to_swimlane_id`.

Lookup order:
1. **Exact match** -- `from_swimlane_id = <source>` AND `to_swimlane_id = <target>`
2. **Wildcard source** -- `from_swimlane_id = '*'` AND `to_swimlane_id = <target>`

The wildcard `*` source is the common case. It means "from any column into this target." Most projects use wildcard transitions exclusively.

## Action Chain

A single transition lookup (`from_swimlane_id` + `to_swimlane_id`) returns multiple `swimlane_transitions` records, each pointing to one action via `action_id`. These records are ordered by `execution_order` and executed sequentially:

```
transition lookup (from → to)
  → swimlane_transitions[0] → action_id → kill_session  (execution_order: 0)
  → swimlane_transitions[1] → action_id → spawn_agent   (execution_order: 1)
  → swimlane_transitions[2] → action_id → send_command   (execution_order: 2)
```

Each action is a record in the `actions` table with a `type` and `config_json`.

## Action Types

### `spawn_agent`

Resolves the selected `AgentAdapter`, then detects its CLI, ensures trust, builds the command and optional environment, and starts a PTY session. If a compatible suspended session exists for the task, the adapter resumes it instead.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Agent identifier (default: `'claude'`) |
| `promptTemplate` | string | Template with `{{placeholders}}` |
| `nonInteractive` | boolean | Use `--print` mode (run and exit) |

### `send_command`

Writes interpolated text to the running PTY stdin. Used for injecting commands into an active Claude session.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Text to send (supports `{{placeholders}}`) |

The command is sanitized for PTY safety and terminated with `\r` (Enter).

### `run_script`

Spawns a one-off shell command in a new PTY session. Not persisted for resume.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `script` | string | Shell command to run (supports `{{placeholders}}`) |
| `workingDir` | `'worktree'` \| `'project'` | CWD for the script |

### `kill_session`

Suspends the session (marks as `suspended` in DB for resume capability), kills the PTY, and clears `task.session_id`.

Config: `{}` (no configuration needed)

Despite the name, `kill_session` actually performs a **suspend** -- the Claude conversation ID is preserved so the session can be resumed later. This enables workflows like "Planning → Running" where Planning kills the old session but Running's `spawn_agent` picks it up with `--resume`.

### `create_worktree`

Creates a git worktree for the task with sparse-checkout.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `baseBranch` | string | Override base branch (default: `config.git.defaultBaseBranch`) |
| `copyFiles` | string[] | Files to copy from repo root (default: `config.git.copyFiles`) |

See [Worktree Strategy](worktree-strategy.md) for full details.

### `cleanup_worktree`

Removes the task's worktree directory and optionally deletes the branch (if `config.git.autoCleanup` is true).

Config: `{}` (no configuration needed)

### `create_pr`

Reserved action type. Not yet implemented.

### `webhook`

POSTs to a URL with an interpolated body.

Config:
| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target URL (supports `{{placeholders}}`) |
| `method` | `'GET'` \| `'POST'` \| `'PUT'` | HTTP method (default: `POST`) |
| `body` | string | Request body (supports `{{placeholders}}`) |
| `headers` | Record<string, string> | Additional headers |

Content-Type defaults to `application/json`. Failures are logged but don't block the action chain.

## Template Variables

All action types that accept templates can use these placeholders:

| Variable | Value |
|----------|-------|
| `{{title}}` | Task title (PTY-sanitized) |
| `{{description}}` | Task description with `: ` prefix when non-empty |
| `{{task_xml}}` | Task title and description wrapped in a `<task>` envelope (`<title>` / `<description>` children). Default seeded prompt template is `{{task_xml}}{{attachments}}`, which gives the agent a structured envelope without forcing the user to template it manually. |
| `{{taskId}}` | Task UUID |
| `{{worktreePath}}` | Worktree directory path (empty if none) |
| `{{branchName}}` | Git branch name (empty if none) |
| `{{baseBranch}}` | Base branch the task forked from (empty if unset) |
| `{{prUrl}}` | Pull request URL (empty if none) |
| `{{prNumber}}` | Pull request number as string (empty if none) |
| `{{attachments}}` | Bare file paths (one per line) when present |

Shortcut commands use a separate set of template variables. See [Configuration](configuration.md#shortcuts) for the full list.

## Stale Spawn Prevention (AbortSignal)

When a task moves rapidly between columns (e.g. user drags to the wrong column and immediately corrects), earlier transitions may still be in-flight when the new transition starts. Without cancellation, the old spawn would complete and create a PTY process that the new transition immediately supersedes.

The transition engine threads an `AbortSignal` through the execution chain:

- `executeTransition()` checks the signal before each action in the chain
- `executeAction()` checks the signal before dispatching to the action handler
- `executeSpawnAgent()` checks the signal as a final gate before creating the PTY process

If the signal is aborted, the method throws an `AbortError` which the caller catches and ignores (the newer transition takes over). This prevents orphaned PTY processes from accumulating.

## Task-Agent Spawn Chokepoints

Board-driven task-agent entry points, including task move, create into a spawning column, backlog promotion, MCP task creation, and unarchive, call `spawnAgent()` in `src/main/ipc/helpers/agent-spawn.ts`. Startup recovery and reconciliation call `prepareAgentSpawn()` in `src/main/transition-engine/session-startup/prepare-spawn.ts`.

Both chokepoints call `runSpawnPreamble()` in `src/main/transition-engine/spawn-preamble.ts`. The preamble first locks inherited Advanced overrides on the task's first spawn, then resolves the target agent. This keeps first-spawn override behavior and agent selection identical across board-driven and startup paths.

The transition engine receives that resolved agent and uses its `AgentAdapter` contract: `detect`, `ensureTrust`, `buildCommand`, and optional `buildEnv`. It does not build a Claude-specific command outside the adapter. Raw PTY spawns remain only for explicitly non-task-agent paths, including transient command terminals, the renderer-supplied raw session spawn, and the `run_script` transition action.

## Command Injection

When a task moves to a column with `auto_command` set, the command delivery depends on how the session was started:

**Resumed sessions** (priority 3 suspend-and-resume, or priority 4 resume from suspended):
- The `auto_command` is interpolated and passed as the resume prompt to `claude --resume <id>`
- This is deterministic: the command is the first thing the agent sees on resume

**Fresh spawns** (priority 4, no suspended session to resume):
- `TerminalSubmitScheduler.scheduleKeystrokes` schedules the command for deferred PTY injection
- Interpolates the `auto_command` template with task variables
- Waits for the CLI's first `'thinking'` activity event, then uses `sendCtrlC: false` to write text → Esc → Enter via `TerminalSubmit.submitKeystrokes`

This enables workflows like moving a task from "Running" to "Code Review" to automatically send a review prompt to the agent.

A per-task `auto_command` (MCP-only, `kangentic_create_task`'s `autoCommand` param) wins over the column's for that task. The unarchive handlers (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) and any other move out of Done suppress injection entirely via `spawnAgent`'s `suppressAutoCommand` (the recovery-move contract; see [Session Lifecycle](session-lifecycle.md#resume)).

When a `spawn_agent` transition action creates the session itself (a custom action wired onto the entry transition), that action's own prompt template runs and the fallback `auto_command` / continuation injection is skipped for that spawn. This is uniform across every entry point (move, create, promote, MCP create), since all route through `spawnAgent`, whose fallback delivery only fires when no action spawned the session. The default board is unaffected: its one action-backed column (Planning) has no `auto_command`.

## Swimlane Roles

Two special roles affect behavior:

| Role | Behavior |
|------|----------|
| `todo` | Task moves here → session killed (not suspended), session history and worktree deleted; branch deleted when `git.autoCleanup` is enabled |
| `done` | Task moves here → session suspended (resumable), task archived |

All other columns (including Planning, Running, Code Review, etc.) are custom columns with no special role. Their behavior is controlled by `auto_spawn`, `auto_command`, `permission_mode`, and `plan_exit_target_id`.

## auto_spawn Flag

Each swimlane has an `auto_spawn` boolean (default: `true`):
- `true` -- tasks in this column should have active sessions. Session recovery and reconciliation will spawn agents here.
- `false` -- tasks in this column should NOT have active sessions. Moving a task here suspends its session.

To Do and Done columns have `auto_spawn=false` by default.

## plan_exit_target_id

When a column has `permission_mode='plan'`, Claude runs in plan mode. When the agent completes planning and fires `ExitPlanMode`, Kangentic detects this via the event bridge and automatically moves the task to the column specified by `plan_exit_target_id`.

Default setup: Planning column has `plan_exit_target_id` pointing to the Executing column.

## Default Seed Configuration

New projects get:
- **Start Planning Agent** action (`spawn_agent` with template `{{task_xml}}{{attachments}}`)
- **Kill Session** action (`kill_session`)
- Transition: `* → Planning` = Kill Session (order 0), Start Planning Agent (order 1)
- Transition: `* → Done` = Kill Session (order 0)

## Cross-Agent Handoff

An agent change is necessary but not sufficient for native-history handoff. `spawnAgent()` takes the native-history path only when all of these conditions hold: the resolved target agent differs, a prior session record exists, project context is available, and the destination lane enables `handoff_context`. A task-level `agent_override` takes precedence over the lane and therefore prevents a column-driven agent change.

1. **Suspend and resolve.** Task Move suspends the source session, and `spawnAgent()` resolves the target adapter.
2. **Locate native history.** The source adapter attempts to locate its native history file from the prior agent session ID and CWD. The result may be null.
3. **Prepare the prompt and audit record.** `buildSessionHistoryReference()` supplies the target agent's initial prompt with an optional XML path reference. When the path is unavailable, the reference falls back to git-log guidance. A handoff audit row stores source and target metadata plus the nullable `session_history_path`.
4. **Spawn and link.** The transition engine starts the target adapter. After a successful spawn, the audit row is linked to the target session record.

There is no synthesized context package, transcript, git diff, metrics package, or generated handoff file. The runtime still emits `packaging-handoff` while preparing this path, followed by `detecting-agent` and `starting-agent`.

When `handoff_context` is disabled, or another eligibility condition is absent, the agent change follows the normal spawn path with no history reference and no handoff audit row. Create into a spawning column and unarchive share the same `spawnAgent()` eligibility and native-history reference semantics as task moves. The full entry-point table lives in [Session Lifecycle](session-lifecycle.md#spawn-entry-points).

## See Also

- [Session Lifecycle](session-lifecycle.md) -- spawn entry points, spawn flow, queue, suspend, resume
- [Agent Integration](agent-integration.md) -- command building, permission modes, per-agent CLI details
- [Worktree Strategy](worktree-strategy.md) -- worktree creation details
- [Database](database.md) -- schema for actions, transitions, swimlanes
