<p align="center">
  <img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic Logo" width="128" />
</p>

<h1 align="center"><a href="https://github.com/Sevenflanks/kangentic">Kangentic</a></h1>

> **Fork notice**
>
> 此 repository 是 [Kangentic/kangentic](https://github.com/Kangentic/kangentic) 的修改版 fork，由 [Sevenflanks/kangentic](https://github.com/Sevenflanks/kangentic) 維護。它未獲 upstream 背書，與 upstream 沒有關聯，也不是官方發行版。Kangentic 名稱與既有品牌素材暫時保留，等待後續品牌決策。

<p align="center">
  <strong>Drag a card. An agent starts.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg?style=flat-square" alt="Platform" />
</p>

---

<p align="center">A Kanban board for AI coding agents. Spawn, suspend, and resume sessions through twelve supported agent adapters from one board, with your own backlog. Local, free, open source.</p>

<p align="center">AI coding agents can build features, fix bugs, and refactor entire modules autonomously. With git worktrees you can run many of them in parallel, but now the bottleneck is <strong>you</strong>: juggling terminals across projects to track which agents are stuck, finished, or waiting for approval. Kangentic replaces that with a Kanban command center. One board shows every agent's status, output, and progress. Respond when needed; let them work autonomously the rest of the time.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/social/og-image.png" alt="Kangentic: Kanban board for AI coding agents" width="800" />
</p>

## Features

- **Backlog, labels & priorities** - stage work in a dedicated backlog before it hits the board. Tag items with custom labels and colors, rank them on a fully-customizable priority scale, and batch-promote a week's worth of work to any column in one move.
- **Customizable workflows** - build pipelines like Plan, Execute, Review. Set permission modes, auto-commands, and transition actions per column. Configure a plan-exit target so cards advance automatically after planning, inject prompts on column entry, and chain scripts or PRs on the way out.
- **Real-time status** - see which agents are thinking or idle right on the card, with per-agent activity detection via native hooks where available and PTY fallbacks where not. Desktop notifications fire when an agent needs your attention.
- **Agent-to-board tools** - agents that self-organize. Every running session has MCP tools to create tasks, move cards, search prior sessions, and queue follow-up work, so a planning agent can hand a backlog to an executing agent without you touching the board.
- **Git worktrees & review** - each agent runs in its own git worktree for parallel development without branch conflicts. When work is ready, the built-in Changes panel opens a split or inline diff viewer with file tree, a commit graph, and a Markdown preview, one click from the task card.
- **Session persistence** - sessions survive restarts and crashes. Orphaned sessions are detected on startup and resumable. Suspend to Done, resume later with full context, nothing is lost.
- **Handoff context** - opt in to a native-history reference when work moves between agents. A handoff needs an agent change, an existing session, and the destination column's `handoff_context` option. The target's initial prompt receives a reference to the source adapter's resolved native history when available. Kangentic does not inline full history or synthesize transcript, git, or metrics context, and the target agent may not read the reference.
- **Terminal & activity log** - a built-in terminal for every session, plus a structured activity log that shows what each agent is doing without the noise.
- **Usage & cost analytics** - track tokens, cost, and burn rate across every project, agent, model, and effort level. Filter by any time range, watch spend by week or cumulatively, and drill into a per-project ledger with cost share, dollars per million tokens, and top agent.
- **Embedded browser** - point a sandboxed Chromium pane at any URL inside the task dialog, draw annotations, pick DOM elements, and submit the rendered frame plus context to the active agent as a multi-modal prompt, all without leaving the task.
- **Search & memory** - one overlay (Ctrl+Shift+F) searches everything on your machine: tasks, backlog, session events, projects, and every past agent conversation, by keyword or on-device semantic memory. Land on the exact turn where you solved something before, no API key required, and your agents can recall it too through the board's MCP tools.
- **Voice dictation** - hold a key, talk, release: local push-to-talk speech-to-text drops your words into the agent's terminal, transcribed on-device with a streaming preview and a refinement pass. Punctuation, language, and auto-submit are all configurable.
- **Model & effort routing** - use Opus for Planning, Sonnet for Code Review, change efforts for the harder steps. Only a concrete model target suspends and resumes with new launch flags; clearing a model to the default keeps the live session. Supported effort changes apply live, while unsupported concrete effort changes respawn.
- **Your tools, your machine** - runs entirely on your desktop (Windows, macOS, Linux, and WSL) with no cloud service and no data leaving your machine. Kangentic launches native agent CLIs where they apply, plus Ollama for local LLM chat, using your own logins and subscriptions.

## How It Works

1. **Create a task** - add a card with a title and prompt. Paste screenshots, choose a source branch, and toggle worktree isolation, all from the create dialog.
2. **Drag to run** - drag the card to any active column. Kangentic resolves an adapter through task, column, project, and global precedence, then uses the shared spawn pipeline to create a worktree, apply settings, and start the session. Columns ship preconfigured, To Do through Done; reshape the pipeline, adapters, and permissions per column anytime.
3. **Watch it code** - your agent starts writing immediately. Follow along in the live terminal: see diffs, test results, and tool calls as they happen. Drag between columns to steer, or drag to Done to pause and pick up later.

## Supported Agents

Twelve supported agent adapters on one Kanban board. Mix adapters per column and opt in to native-history references when handing off work:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic)
- [Codex CLI](https://developers.openai.com/codex/cli) (OpenAI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Google)
- [Qwen Code](https://github.com/QwenLM/qwen-code) (Alibaba)
- [Kimi Code](https://github.com/MoonshotAI/kimi-cli) (Moonshot AI)
- [OpenCode](https://opencode.ai/docs) (sst)
- [Droid](https://docs.factory.ai/cli/getting-started/overview) (Factory)
- [Cursor CLI](https://cursor.com/docs/cli/overview)
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)
- [Aider](https://aider.chat/)
- [Oz CLI](https://docs.warp.dev/reference/cli/cli) (Warp)
- [Ollama](https://ollama.com/)

## Supported Boards

Bring your own backlog. Pull tasks in from the tools your team already uses, including titles, descriptions, labels, and inline images. Already-imported items are detected automatically so re-syncing is safe:

| Board | Status |
|-------|--------|
| GitHub Issues | Supported |
| GitHub Projects | Supported |
| Azure DevOps | Supported |
| Asana | Supported |
| Jira | Coming soon |
| Linear | Coming soon |
| Trello | Coming soon |
| GitLab | Coming soon |
| Obsidian | Coming soon |

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Git 2.25+](https://git-scm.com/)
- At least one supported agent adapter (see [Supported Agents](#supported-agents))

## 從來源建置

```bash
git clone https://github.com/Sevenflanks/kangentic.git
cd kangentic
git checkout sevenflanks-main
npm ci
npm run dev
```

此 fork 的使用路徑只有從來源執行，以及在自己的 Windows 電腦建立本機 installer：

```bash
npm run make:win
```

此指令產生未簽署的 `out/Kangentic-Setup-X.Y.Z.exe`，不發布產物，也沒有 auto-update feed。封裝檔包含 `LICENSE` 與 `FORK-NOTICE.md`。完整步驟請見[安裝指南](docs/installation.md)。

`npx kangentic` 是 upstream 的安裝管道，不會下載或安裝此 fork。

## 文件

請從[本機文件索引](docs/README.md)開始，或直接閱讀[安裝指南](docs/installation.md)。

## Development

開發環境與來源建置使用相同的 Node.js 22+、fork checkout 與 `npm ci` 步驟。請參閱 [CONTRIBUTING.md](CONTRIBUTING.md) 取得專案結構、測試範圍與慣例。

## Contributing

請參閱 [CONTRIBUTING.md](CONTRIBUTING.md)。本 fork 的貢獻只以 `AGPL-3.0-only` 接受，不收集 upstream CLA。

## Support

- [GitHub Discussions](https://github.com/Sevenflanks/kangentic/discussions) 用於問題與功能建議
- [GitHub Issues](https://github.com/Sevenflanks/kangentic/issues) 用於錯誤回報

## License

此 fork 以 [AGPL-3.0-only](LICENSE) 授權，詳見 [FORK-NOTICE.md](FORK-NOTICE.md)。不提供商業或替代授權。

---

<h4 align="center">Built with</h4>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/xterm.js-000000?style=for-the-badge" alt="xterm.js" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" alt="Playwright" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/brandmark-small.svg" alt="Kangentic app icon" width="26" height="26" />
</p>
