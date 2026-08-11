## What's New

- **Docking a window follows your cursor** - drag a task window by its header and wherever you point decides what happens. Run into the left, right, or bottom edge of the board to snap that half, into the top edge to maximize, or over another window to tile beside it: its left and right thirds dock to that side, the middle third docks above or below. A nudge just repositions, and Escape mid-drag puts the window back where it started. The separate tile-layout menu is gone, since the drag now expresses every layout it offered.
- **Click outside a task window to close it** - the old behavior only worked when a single window was open. Now the focused window closes on an outside click however many are open, and the first click still lands normally on a control, a task card, or a running terminal, so dismissing never costs you a click you meant for something else. Set it at Settings > Behavior > Close on Outside Click.
- **Pausing a session puts its window away** - pausing from the task detail header or kebab now closes the window too, instead of leaving you to dismiss it separately. The session stays paused and resumable from the board.
- **Agents can open their own Browser pane** - an agent that needs to look at your dev server can now open and close the embedded Browser pane for its own task over MCP, rather than stopping to ask you to click the Browser pill. Pane control is scoped to the agent's own project, panes survive a project switch, and the pane list reports each pane's live URL.
- **Agents can place and reorder tasks within a column** - task position is now something an agent can set, not just which column a task lands in.
- **Auto commands are verified, not fire-and-forget** - the delivery path for commands attached to a column transition was rebuilt so Kangentic can confirm the agent actually received one, and report it when that fails. Injection now uses Claude Code's documented keys and no longer interrupts an agent mid-turn.
- **A more consistent settings and dialog surface** - setting labels, descriptions, and input fills now come from shared components, so a dropdown, a text field, and a toggle card read as one family wherever they appear.
- **Snappier boards with many terminals** - terminal construction is serialized rather than done all at once, and the context bar's fill is composited.

## Bug Fixes

- An arriving terminal no longer steals focus from the one you are typing in when several open at once.
- A terminal revealed by opening a panel now fits the renderer it keeps, instead of drawing at the wrong width.
- A background shell left running by an agent no longer holds its session in the active state, so tasks stop showing as busy when they are waiting on you.
- Upgrading installs now get the new close-on-outside-click behavior rather than silently keeping the old single-window setting as if it had been chosen deliberately.
- The Browser pane list reports each pane's current URL instead of the one it was opened with.
- Control fills have a visible step against their background again, and description previews stay readable on them.
- The relay row in Mobile Devices is aligned properly and its Test connection result rebuilt to say what actually happened.
