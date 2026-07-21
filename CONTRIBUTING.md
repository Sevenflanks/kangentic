# Contributing to Kangentic

感謝你有興趣為 Kangentic 貢獻。本指南說明此 fork 的來源建置、分支與驗證方式。

## Fork 貢獻授權政策

本 fork 只接受以 `AGPL-3.0-only` 授權的貢獻。提交 PR 即表示你同意以此授權提供該貢獻。

本 fork 不收集 upstream CLA，也不提供商業或雙重授權。若你要將獨立、乾淨的變更提交給 upstream，請依 upstream 當時的貢獻與 CLA 規則處理。

分支角色與 release 邊界以 [docs/fork-governance.md](docs/fork-governance.md) 為準。

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (building from source; CI runs on Node 22)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH
- Git 2.25+

Native modules (`better-sqlite3`) are compiled on install, so you also need a C/C++ toolchain:
Visual Studio Build Tools on Windows, Xcode Command Line Tools on macOS, or `build-essential` and
`python3` on Linux. See [docs/developer-guide.md](docs/developer-guide.md) for the full setup.

### Setup

```bash
git clone https://github.com/Sevenflanks/kangentic.git
cd kangentic
git checkout sevenflanks-main
npm ci
npm start
```

### Where the conventions live

Use [docs/developer-guide.md](docs/developer-guide.md) for setup and testing, and rely on executable
tests, ESLint, and CI for enforceable behavior. Fork roles, upstream synchronization, and release
boundaries are defined in [docs/fork-governance.md](docs/fork-governance.md).

### Project Structure

```
src/
  main/           # Electron main process
  preload/        # Context bridge (preload.ts)
  renderer/       # React UI (React 19, Zustand, Tailwind CSS 4)
  shared/         # Types and IPC channel constants
tests/
  unit/           # Vitest unit tests (fast, pure logic)
  ui/             # Headless Playwright tests (no Electron)
  e2e/            # Real Electron tests (opens windows)
docs/             # Architecture, developer guide, subsystem docs
```

## Making Changes

### Branch Naming

Use descriptive branch names:
- `fix/session-resume-crash`
- `feature/multi-agent-support`
- `docs/update-architecture`

Fork 的 feature 與 fix branch 必須從 `sevenflanks-main` 建立，並透過 PR 回到
`sevenflanks-main`。不要把個人 fork 工作放在 `main`。

若要貢獻 upstream，請從乾淨的 `main` checkout 建立 branch，並確保 branch 不含 fork
governance 或 `sevenflanks-main` 的變更。提交時請遵循 upstream 的獨立規則。

### Conventions

These are the conventions that most often need a maintainer follow-up when missed. Their enforcement
comes from executable tests, ESLint, CI, or review as noted below.

- **Text formatting.** No em-dashes (U+2014) and no `--` used as punctuation in anything you author
  (code, comments, tests, docs, commit messages). Use a single dash for inline separators or
  restructure with a period. Em-dashes render as garbled characters on Windows consoles.
  (Enforced by a CI unit test plus review.)
- **TypeScript style.** Strict mode, no `any` types (use proper types from `src/shared/types.ts`,
  `unknown` with type guards, or generics), and full descriptive names (`currentIndex` not `curIdx`,
  `session` not `sess`). (Enforced by ESLint `no-explicit-any` and `tsc`; names by review.)
- **UI conventions.** Use the shared primitives (`Select`, not a raw `<select>`; `CountBadge`;
  `ConfirmDialog`) and Lucide React icons (no inline SVGs). Respect the font floor (default
  `text-xs`, never below `text-[11px]`). Avoid hover-only controls. Use theme-adaptive semantic
  tokens, not hardcoded colors, so the UI re-colors across all themes. Prefer visual subtraction
  over addition. Add `data-testid` attributes for test selectors. (Enforced by review.)
- **Cross-platform parity.** Code and tests must behave identically on Windows, macOS, and Linux.
  No hardcoded OS paths (use `path.join` and runtime-derived directories), pass `{ force: true }` to
  `fs.rmSync`/`fs.rm` (Windows file locking), have tests write only under `os.tmpdir()`, and avoid
  pixel-exact or bare-timeout assertions. (Enforced by a CI unit test, the Linux CI run, and review.)
- **No personal info.** The repo is public. Never hardcode usernames, emails, or home-directory
  paths; use generic placeholders like `C:\Users\dev` in tests and examples. (Enforced by review.)
- **Reuse before reimplement (DRY).** Search for an existing utility before adding a new one, and
  extract duplicated logic into a shared module instead of copying it. (Enforced by review.)
- **Bounded IPC payloads.** Cap large captured buffers (for example child-process stdout/stderr)
  before they cross IPC. Do not let an Error carry tens of megabytes; use a sensible per-stream cap.
  (Enforced by review.)
- **Docs stay in sync.** When you change an anchor source file (union types, IPC channels, DB
  migrations, adapter capabilities, or settings), update the matching docs under `docs/`.
  (Checked during review.)

### Testing

Tests run in three tiers. See [docs/developer-guide.md](docs/developer-guide.md) for the full
description of each tier and the headless mock.

- **Unit** (`tests/unit/`, Vitest, sub-second, pure logic)：執行直接受影響的檔案，例如
  `npx vitest run tests/unit/example.test.ts`
- **UI** (`tests/ui/`, headless Playwright, no Electron)：執行直接受影響的檔案，例如
  `npx playwright test tests/ui/example.spec.ts`
- **E2E** (`tests/e2e/`, real Electron, opens windows)：需要時執行直接受影響的檔案，並可先執行
  `npm run build`

迭代時只執行你新增、修改或直接影響的測試檔。開啟 PR 前，先執行直接受影響的測試檔，再執行：

```bash
npm run lint
npm run typecheck
```

若變更會影響 production bundle，或你需要在本機確認 bundle，可執行 `npm run build`。完整 CI 是權威 gate，因此不需要在本機執行每個測試層級。

### Commit Messages

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/): a
`commit-msg` git hook runs commitlint with `@commitlint/config-conventional` and rejects messages
that do not conform. The format is:

```
type(scope): subject
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. The scope is optional. Keep the subject short and in the imperative mood. Examples:

- `fix(session): resume when worktree branch is deleted`
- `feat(board): add keyboard shortcut for moving tasks between columns`
- `docs: clarify the E2E test setup`

## Pull Requests

1. 從 `sevenflanks-main` 建立 feature 或 fix branch
2. 完成變更，並新增或更新對應測試
3. 執行直接受影響的測試檔、`npm run lint` 與 `npm run typecheck`，必要時執行 build
4. 開啟目標為 `sevenflanks-main` 的 PR。模板會要求填寫 What / Why / How / Tests 與簡短 checklist
5. 連結相關 issue

### What to expect

- Your PR must be green on all of the CI checks before it can merge: **Lint (ESLint)**,
  **Type check (tsc)**, **Unit tests (Vitest)**, **Build (production bundle)**, **UI tests
  (Playwright)**, and **E2E tests (Electron)**. The lint check runs with `--max-warnings 0`, so any
  warning fails it.
- If a check fails, push a fix and CI re-runs automatically. Contributors cannot re-run checks
  directly (that requires write access), so to re-trigger a run for a failure unrelated to your
  change (for example a flaky test), push a new commit (an empty `git commit --allow-empty` is fine)
  or close and reopen the PR. You can also ask a maintainer to re-run it.
- A maintainer may push follow-up commits to your branch for design polish or hardening before
  merging. This is normal and not a reflection on your work; it is how we keep the bar consistent.
- Small, focused PRs are easier to review and merge faster.

### Approvals and merging

A maintainer reviews your PR and, once it is approved and green, **merges it**. Contributors do not
need write access to the repository and are not expected to merge their own PRs; opening the PR from
your fork is all that is required from you.

An approval means the PR is accepted. The maintainer handles the final merge, and may push small
follow-up commits or wait to batch it into a release first. If anything was applied to your branch,
the approval is a good moment to skim it. If you want to hold the merge (more changes are coming, or
you want a different squash), just say so in the PR thread.

Repeat contributors may be granted write access over time. If you have it, the flow shifts to the
common team convention: a maintainer approves and you merge your own PR once it is green. Until then,
the maintainer lands it for you.

### UI contributions

UI changes get a maintainer design review against the UI conventions above (shared primitives, font
floor, theme-adaptive colors, no hover-only controls, visual subtraction over addition). Including a
screenshot or short clip in the PR makes that review much faster and is always appreciated.

### How maintainers land your PR

不需要執行任何內部 maintainer workflow。Maintainer 會審查 PR、確認 CI 全數通過，並依一般 GitHub 流程合併。Upstream contribution 必須從乾淨的 `main` checkout 建立。Fork 專用的同步與 release 規則見 [docs/fork-governance.md](docs/fork-governance.md)。

## Finding Work

Look for issues labeled **good first issue** for approachable tasks. If you want to take on something larger, open an issue first to discuss the approach.

## Code of Conduct

Be respectful, constructive, and collaborative. We're all here to build something useful.

## Questions?

Open a [discussion](https://github.com/Sevenflanks/kangentic/discussions) or comment on the relevant issue.
