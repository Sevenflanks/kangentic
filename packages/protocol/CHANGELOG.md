# @kangentic/protocol Changelog

<!-- releases -->

## [protocol-v0.7.0] - 2026-07-20

### Breaking Changes
- five-category push taxonomy + wake-channel seam (5d4a67eb)

  `PUSH_CATEGORIES` is now exactly `input-required`, `turn-complete`,
  `session-failed`, `plan-complete`, `spawn-stalled`, replacing the prior
  four (`permission-needed`, `agent-question`, `idle`, `agent-crash`).
  `input-required` merges the old `permission-needed` and `agent-question`
  categories into one, sourced from A2A Protocol's `TaskState.INPUT_REQUIRED`
  / MCP's `input_required` rather than Claude-specific naming.
  `RegisterPushRequestPayload` gains an optional `categories` field so a
  device can register only the categories it wants pushed.

## [protocol-v0.5.0] - 2026-07-16

All additive; wire `PROTOCOL_VERSION` stays '2'. Includes everything since
protocol-v0.3.0 (the 0.4.0 terminal-geometry work shipped unpublished).

### Features
- terminal dimensions on the wire: `TerminalDimensionsWire`, optional
  `ptyDimensions` on the read-stream snapshot, the `terminal-resize` event,
  and the `interactive-terminal` action union (write / resize / release-size)
- session lifecycle: `session-ended` activity payload variant and optional
  `sessionStatus` on `ReadStreamResponsePayload`
- E2E push: the `register-push` capability verb, `RegisterPushRequestPayload`
  / `RegisterPushResponsePayload`, and `crypto/push-envelope.ts`
  (XChaCha20-Poly1305 sealed notification envelopes, AAD-bound to the
  recipient device key, with staleness bounds)
- project accents: optional `color` on `ReadBoardProjectSummary` and
  `projectColor` on the board snapshot

### Fixes
- `terminal-resize` accepted by the envelope decoder's event validator
  (`validateEvent`), not only `isBridgeEvent`

## [protocol-v0.1.1] - 2026-07-10

### Features
- add protocol package, device pairing, and secure relay transport (f5c97b9d)
