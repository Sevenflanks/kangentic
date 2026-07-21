# PR Integration

Kangentic links each task to its pull request and keeps that link fresh: it detects a PR from terminal scrollback or a task description, authoritatively resolves the PR's state through a hosting-provider CLI, and persists `pr_url` / `pr_number` / `pr_state` on the task so the board can show it. GitHub is the only provider wired today, but every provider is wrapped behind a common `PRConnector` interface so detection and resolution logic stays isolated to a single folder per platform.

This doc covers the connector system, the confidence ladder that picks the strongest anchor, the background refresh sweep, and how to add a new hosting provider.

## Layout

```
src/main/pr/
  shared/                 # PRConnector contract + platform-agnostic errors
    pr-connector.ts
    pr-errors.ts
  adapters/
    github/
      github-connector.ts # gitHubPRConnector (gh CLI)
  pr-registry.ts          # connector array + platform-agnostic dispatch API
  pr-linking.ts           # confidence ladder + persist (the backbone)
  pr-refresh.ts           # background refresh-and-discover sweep
  pr-refresh-scheduler.ts # per-project timer that arms the sweep
```

The pattern intentionally mirrors `src/main/boards/adapters/` and `src/main/agent/adapters/` (one folder per provider, a central registry, no provider-specific branching in shared code). See [Board Integration](board-integration.md) for the analogous board-import system.

## PRConnector Interface

`src/main/pr/shared/pr-connector.ts`

Every hosting provider implements this contract. The registry calls it without knowing which providers are registered.

| Member | Required | Purpose |
|--------|----------|---------|
| `name` | yes | Platform name for logging (e.g. `"GitHub"`). |
| `matchesCommand(commandDetail)` | yes | Whether a Bash command detail looks like a PR command for this platform (drives activity flagging). |
| `extract(scrollback)` | yes | Extract a PR URL + number from raw PTY scrollback text (no network). Returns the most recent match. |
| `extractCanonical?(text)` | optional | Extract the single canonical PR from authored text (a task description), or null when the text names zero or several distinct PRs. Deliberately conservative so a description is never guessed at. |
| `resolveForBranch?(repoCwd, branchName, baseBranch?)` | optional | Authoritatively resolve the PR for a branch via the platform API, run inside the repo/worktree at `repoCwd`. Returns null when no PR matches the head ref; throws `PRResolverUnavailableError` when the CLI is unavailable. |
| `resolveByNumber?(repoCwd, prNumber)` | optional | Resolve a PR by its number, the most exact anchor and immune to branch renames. Used to refresh an already-linked PR's state. |
| `resolveByCommit?(repoCwd, commitSha, branchHint?)` | optional | Resolve the PR associated with a commit SHA, an immutable anchor that survives worktree deletion and branch renames. `branchHint` disambiguates when a commit belongs to several PRs. |

### Verb taxonomy

The subsystem uses a consistent verb prefix across modules:

- `detect*` - parse a PR reference from text / scrollback (no network).
- `resolve*` - authoritative provider lookup (CLI / API).
- `link*` - resolve then persist to a task (see `pr-linking.ts`).
- `refresh*` - bulk re-link across a project (see `pr-refresh.ts`).

### `DetectedPR`

Result of a no-network detection (`extract` / `extractCanonical`).

| Field | Required | Purpose |
|-------|----------|---------|
| `url` | yes | The full PR URL parsed from text. |
| `number` | yes | The PR number parsed from the URL. |

### `ResolvedPR`

Result of an authoritative API resolve. Richer than `DetectedPR` because it comes from a structured query rather than scrollback text.

| Field | Required | Purpose |
|-------|----------|---------|
| `url` | yes | The PR URL. |
| `number` | yes | The PR number. |
| `state` | yes | Normalized `PRState` (`'open' \| 'draft' \| 'merged' \| 'closed'`). |
| `baseRefName` | optional | The PR's base branch, used to prefer a base-matching candidate during disambiguation. |
| `updatedAt` | optional | Last-updated timestamp, used as the final tiebreak when several PRs match. |

## Error Types

`src/main/pr/shared/pr-errors.ts`

Both errors are platform-agnostic (a leaf module with no connector imports) so `pr-linking.ts` can catch them without importing any provider-specific error type. Connectors translate their own errors (e.g. GitHub's `GhUnavailableError`) into these.

| Error | Meaning | Caller behavior |
|-------|---------|-----------------|
| `PRResolverUnavailableError` | The platform resolver cannot run at all (CLI missing / unauthenticated, or no connector matches the remote). | Degrade to `detectPR` scrollback scraping; preserve any existing link; log a one-time hint. |
| `PRResolverTransientError` | Resolution failed transiently (network / 5xx / rate-limit / timeout) rather than because there is no PR. | Preserve the existing link and report `transient-error` instead of `not-found`. |

## Registry

`src/main/pr/pr-registry.ts`

The registry holds a plain `connectors` array populated at module import time, and exposes a platform-agnostic API that iterates connectors and returns the first match. There is no provider-name branching here, consistent with the adapter-boundary guardrail in root `CLAUDE.md`.

```ts
const connectors: PRConnector[] = [
  gitHubPRConnector,
  // Future: gitLabMRConnector, bitbucketPRConnector, azureDevOpsPRConnector
];
```

| Function | Purpose |
|----------|---------|
| `matchesPRCommand(commandDetail)` | True if any connector recognizes the Bash command as a PR command. |
| `detectPR(scrollback)` | Try every connector's `extract` against scrollback; return the first match. |
| `detectCanonicalPR(text)` | Return the single PR a task description names, via the first connector that finds an unambiguous match. |
| `resolvePRForBranch(repoCwd, branchName, baseBranch?)` | First connector that supports `resolveForBranch` and returns a match. |
| `resolvePRByNumber(repoCwd, prNumber)` | First connector that supports `resolveByNumber`. |
| `resolvePRByCommit(repoCwd, commitSha, branchHint?)` | First connector that supports `resolveByCommit`. |

The registry also re-exports the contract types and both error classes, so consumers have a single import surface.

## GitHub Connector

`src/main/pr/adapters/github/github-connector.ts`

`gitHubPRConnector` resolves PRs through the `gh` CLI and detects PR URLs from terminal output. It reuses the board importer's `gh` client (`GitHubImporter` from `boards/adapters/github-common/gh-client.ts`) so binary detection and auth plumbing are shared; a module-level singleton avoids re-probing `gh` per call.

**Detection.** `extract` strips ANSI escape sequences from the tail of scrollback (a 4096-byte scan window) and matches `https://github.com/<owner>/<repo>/pull/<number>`, returning the last (most recent) match. It handles `gh pr create` stdout, `gh pr view` TTY and non-TTY output, and `gh pr view --json`. It deliberately does not match `git push`'s `/pull/new/<branch>` output (no numeric id) or `gh pr merge`'s `owner/repo#123` short form (no full URL). `extractCanonical` collects every distinct full PR URL in the text and returns a match only when there is exactly one.

**Resolution.** The three resolve methods call the shared `gh` client (`resolvePRByBranch`, `resolvePRByNumber`, `resolvePRByCommit`) and normalize the result:

- `mapState` maps GitHub's `OPEN` / `CLOSED` / `MERGED` plus `isDraft` to the normalized `PRState`.
- `disambiguate` picks the best candidate for inferred (branch / commit) matches: it drops fork (cross-repository) PRs, restricts to PRs whose head ref matches `branchHint` (returning null rather than guessing when several remain), then prefers open/draft, then a matching base branch, then the most recently updated. `resolveByNumber` bypasses this guard because an explicit number is unambiguous.
- `resolveByCommit` additionally drops any PR whose merge commit IS the resolved commit, so a fresh worktree sitting on the base branch's tip is never magneted onto the last-merged sibling PR.

**Concurrency + error translation.** All resolves run through a global `p-queue` capped at `GH_CONCURRENCY = 3`, so a multi-card drag or board-load burst cannot fan out into dozens of concurrent `gh` processes. The `viaGh` wrapper translates `GhUnavailableError` into `PRResolverUnavailableError` and `GhTransientError` into `PRResolverTransientError`, keeping the generic layer free of provider-specific error types.

## PR Linking

`src/main/pr/pr-linking.ts`

`linkPRForTask` is the single backbone every trigger funnels through. It resolves a task's PR via a confidence ladder, short-circuiting on the first hit, and writes only on change. It is wrapped in `withTaskLock` because it crosses an await boundary and mutates per-task state, as required by root `CLAUDE.md`. `tests/unit/task-lifecycle-lock.test.ts` verifies the lock's serialization contract.

### The confidence ladder

`resolvePRViaLadder` tries the strongest available anchor first:

| Tier | Anchor | Why |
|------|--------|-----|
| 0 | Description PR URL | Authoritative for a code-review task, whose worktree sits on the base branch with no commits of its own, so the git tiers below would resolve the wrong PR. Resolved by number for fresh state; links url+number with unknown state if it cannot be confirmed, and never falls through to the git tiers. |
| 1 | `pr_number` | Exact and branch-independent, best for refreshing an existing link's state. |
| 2 | Worktree HEAD branch | The real branch while the task is actively worked. |
| 3 | Commit SHA | Immutable, survives Done / worktree deletion and branch renames. Guarded by a commits-ahead-of-base check so a fresh worktree on base's tip does not link the last-merged PR. |
| 4 | Stored slug branch | Weak last resort when there is no worktree. |

A `PRResolverUnavailableError` from any tier propagates so the caller can degrade.

### Persist and degrade behavior

- **Auto triggers** (non-force) skip terminal `merged` / `closed` PRs (they cannot change) and coalesce rapid re-resolves through a per-task 60s throttle (`RESOLVE_TTL_MS`, a bounded `Map` pruned on each run). Explicit user/agent actions pass `force: true` to bypass both.
- **Degradation.** When the resolver throws `PRResolverUnavailableError` or `PRResolverTransientError`, the linker records a `resolver-unavailable` / `transient-error` status, falls back to `detectPR` on any provided scrollback (url+number only), preserves a known state when the URL is unchanged, and logs a one-time hint. A degraded resolve never clears an existing link.
- **Confident not-found.** When the resolver ran cleanly and matched no PR yet the task still carries a link, the linker clears `pr_url` / `pr_number` / `pr_state` atomically so a stale `merged` never lingers.
- **SHA backfill.** It opportunistically persists the freshly-read worktree HEAD SHA so the commit anchor (Tier 3) is available later, after the worktree is reclaimed on Done.

### Entry points

- `linkPR(context, options)` is the IPC-side wrapper: it resolves the project + task (by id, else live session, else branch name) and wires the `TASK_UPDATED_BY_AGENT` renderer notification. Mapping by branch/session means exited or suspended sessions and human-created PRs still link.
- `autoLinkPRForTask(context, taskId, projectId)` is the fire-and-forget entry for implicit triggers. It gates on a non-To Do lane (To Do resets the task) and on having some anchor, then calls `linkPR` non-force so the 60s throttle coalesces bursts. It is called after a task-move returns, on the plan-exit auto-move, and when a session goes idle (a PR was likely just created). A `pr-candidate` session event (scrollback carrying a PR command) also routes through `linkPR` by session id.

## PR Refresh and Scheduler

`src/main/pr/pr-refresh.ts`, `src/main/pr/pr-refresh-scheduler.ts`

### The sweep

`refreshProjectPRs` re-resolves every eligible task through the `linkPR` backbone (unchanged, non-force). This both refreshes an already-linked PR's state (so an off-app merge/close shows on the board) and discovers a PR for a still-unlinked task with a live worktree (e.g. an agent created the PR mid-session on a renamed branch and no other trigger caught it).

A task is eligible when its PR can still change or be found: a non-terminal linked PR (`pr_number`), a live worktree (`worktree_path`), or a description PR anchor. Terminal `merged` / `closed` PRs are skipped first, and `head_sha` is deliberately not an anchor here (nearly every historical task has one, which would make the sweep unbounded). The sweep is sequential and best-effort: a per-task failure is swallowed, and the backbone's `onLinked` pushes `TASK_UPDATED_BY_AGENT` so cards update live.

### The scheduler

`prRefreshScheduler` keeps a single active timer (Kangentic focuses one project at a time):

- `startForProject(context, project)` tears down any prior timer, defers an immediate sweep off the IPC critical path (`setImmediate`), then arms a periodic `setInterval` from the per-project `git.prRefreshIntervalMinutes` config (null / `<= 0` means on-load sweep only, no timer). It is called on every `PROJECT_OPEN` (cold restart and warm switch-back), after a config change, and on system resume.
- `stop(projectId?)` clears the active timer. With a `projectId` it no-ops unless that project owns the active timer; with no argument it always stops (shutdown / unconditional). Called on project switch/delete and on shutdown.

Timer-leak safety: the interval is created outside `runWithProjectLogContext` (each tick wraps its own work inside it), is `.unref()`'d so it never blocks a clean quit, and is explicitly cleared on switch/delete/shutdown. A stale-switch guard skips a sweep whose project is no longer focused.

## Where PR State Is Persisted

PR state lives on three columns of the per-project `tasks` table (`src/main/db/migrations/project-schema.ts`; `pr_state` was added by a later idempotent migration):

| Column | Type | Purpose |
|--------|------|---------|
| `pr_number` | INTEGER | The PR number, the exact branch-independent anchor. |
| `pr_url` | TEXT | The full PR URL. |
| `pr_state` | TEXT | Normalized `PRState` (`open` / `draft` / `merged` / `closed`), null when no PR is linked or it predates state tracking. |

The companion `head_sha` column stores the last-captured worktree HEAD commit as the immutable Tier-3 anchor.

### IPC channel

`task:resolvePr` (`IPC.TASK_RESOLVE_PR`) is the renderer-facing, on-demand resolver behind the task detail header's "Link / refresh PR" control. Root `CLAUDE.md` requires it to forward an explicit interaction-time `projectId`, and `tests/unit/project-scoped-ipc.test.ts` enforces that IPC parity. The handler (in `src/main/ipc/handlers/sessions.ts`) calls `linkPR` with `force: true` and returns a `TaskResolvePrResult`:

| Field | Purpose |
|-------|---------|
| `task` | The task after resolution (latest `pr_url` / `pr_number` / `pr_state`), or null if not found. |
| `linked` | True when the task now has a linked PR (`linked` or `unchanged` status). |
| `reason` | The `PRLinkStatus` outcome, so the UI/MCP can show an accurate message. |
| `message` | Detail for `resolver-unavailable` / `transient-error`. |

`PRLinkStatus` is `'linked' | 'unchanged' | 'not-found' | 'no-anchor' | 'resolver-unavailable' | 'transient-error'`.

## Connector Status

| Provider | Status | CLI dependency | Notes |
|----------|--------|----------------|-------|
| GitHub | stable | `gh` | PRs via `gh pr` / `gh api`, reusing the board importer's `gh` client. The only registered connector. |
| GitLab | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |
| Bitbucket | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |
| Azure DevOps | planned | - | Noted in the `pr-registry.ts` connectors comment; not implemented. |

Only `gitHubPRConnector` is in the `connectors` array today. The planned providers are a source comment, not stub folders: adding one means implementing the `PRConnector` contract under `adapters/<provider>/` and appending it to the array, with no changes to the platform-agnostic registry API or its callers.

## See Also

- [Board Integration](board-integration.md) - the analogous adapter system for importing board issues.
- [Agent Integration](agent-integration.md) - the adapter system for AI coding agents that both patterns mirror.
- [Architecture](architecture.md) - the `task:resolvePr` IPC channel and task schema in the main architecture doc.
