## What's New

- **Terminal color overhaul** - a near-black background, a real 16-color ANSI palette, and fully custom background/foreground/cursor colors, including a one-click preset that matches your app theme.
- **Task settings tab** - task-presentation settings now live in their own tab, and the terminal font is picked from your detected system fonts via an autocomplete.
- **Word-delete on Backspace** - an opt-in terminal setting so Backspace deletes the previous word instead of a single character.
- **Disable Codex's ChatGPT Apps connector** - a per-agent launch toggle that skips the optional cloud connector that can hang Codex startup.
- **Remote OpenCode servers** - point a task's worker at an OpenCode server you run instead of spawning a local process.
- **Configurable MCP server bind address** - choose the address the built-in MCP HTTP server listens on.
- **Better activity tracking** - a live idle-wait countdown, a durable history of active/idle intervals, and faster recovery from resume-picker turns.

## Bug Fixes

- The usage context bar now clamps to 100% instead of disappearing as you approach auto-compaction.
- The terminal launch overlay paints with the resolved terminal background, so there is no color flash on spawn.
- Linux rpm packages declare soname capabilities, so they install across distributions instead of failing on package-name mismatches.
- The `{{baseBranch}}` task-template variable now resolves to the effective default branch.
