# Documentation

Kangentic is a cross-platform desktop Kanban for AI coding agents. Drag tasks between columns to spawn, suspend, and resume sessions through twelve supported agent adapters: Claude Code, Codex CLI, Gemini CLI, Aider, Cursor CLI, Oz CLI, GitHub Copilot CLI, OpenCode, Qwen Code, Kimi Code, Droid, and Ollama. Cross-agent history passthrough is opt in: it requires an agent change, an existing session, and the destination column's `handoff_context` option, then adds a reference to adapter-resolved native history to the target's initial prompt when available. It does not inline full history or synthesize transcript, git, or metrics context, and the target agent may not read the reference.

## Start Here

| Audience | Start with |
|----------|-----------|
| New user | [Installation](installation.md) |
| Evaluating the product | [Overview](overview.md) |
| Contributing code | [Developer Guide](developer-guide.md) |
| Understanding the system | [Architecture](architecture.md) |

## Reference

### Getting Started
- [Installation](installation.md) -- Fork source execution, local Windows installer, prerequisites, troubleshooting

### Product
- [Overview](overview.md) -- What Kangentic is, key features, positioning
- [User Guide](user-guide.md) -- End-user walkthrough of all features

### Architecture
- [Architecture](architecture.md) -- Process model, data flow, IPC channels, stores
- [Session Lifecycle](session-lifecycle.md) -- State machine, spawn flow, queue, suspend, resume, crash recovery
- [Transition Engine](transition-engine.md) -- Action types, templates, execution flow, priority rules, cross-agent handoff
- [Database](database.md) -- Schema (including session_transcripts and handoffs tables), migrations, repository pattern, connection management

### Integration
- [Agent Integration](agent-integration.md) -- Adapter interface, supported agent adapters, permission modes, detection, command building
- [Adapter Session History](adapter-session-history.md) - Native session-history file formats Kangentic reads for real-time telemetry; the authoritative reference for the sessionHistory hook
- [Command Injection](command-injection.md) -- Per-column auto-commands and model/effort injection, verifier contract, retry semantics
- [Board Integration](board-integration.md) -- BoardAdapter interface, registry, GitHub, Azure DevOps, Asana, and stub providers, plus guidance for adding a provider
- [PR Integration](pr-integration.md) - PRConnector interface, registry, GitHub connector, the confidence-ladder linker, background refresh, where PR state is stored
- [Mobile Bridge](mobile-bridge.md) - Desktop half of the mobile companion app: `@kangentic/protocol` package, pairing ceremony, signed device roster, capability verbs, relay transport
- [Handoff](handoff.md) -- Cross-agent native-history references, prompt delivery, and adapter constraints
- [MCP Server](mcp-server.md) -- Board management tools for agents, file-based command queue, .mcp.json safety
- [Embedded Browser](embedded-browser.md) - Browser pane architecture: webview capture, draw and inspect modes, the paste engine, multi-modal prompt submission
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state, subagent-aware transitions
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery, cleanup

### Operations
- [Analytics](analytics.md) -- Telemetry events, opt-out, privacy
- [Configuration](configuration.md) -- Config cascade, all settings keys, permission modes
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, local Windows packaging, security fuses
- [Deployment](deployment.md) -- Local Windows installer build, legal resources, update guard, QA
- [Developer Guide](developer-guide.md) -- Setup, build system, testing, conventions
- [Local Windows Installer QA](release-checklist.md) -- Local EXE verification, legal hashes, launch safety, no-publication checks
