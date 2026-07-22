/**
 * Per-session latch that fires exactly once when an agent first produces
 * "meaningful" PTY output. Used by SessionManager to lift the shimmer
 * overlay in the renderer and to clear the `resuming` flag on resumed
 * sessions.
 *
 * What counts as meaningful is adapter-specific. The tracker never interprets
 * marker content: it delegates that decision to the `detectFirstOutput`
 * callback passed to `consume()`. For custom detectors, it only reconstructs
 * input across chunk boundaries using a bounded per-session tail. When no
 * detector is given, any non-empty chunk qualifies.
 *
 * Call `removeSession()` when a session is fully cleaned up, or `clear()`
 * during killAll(), so both emitted and partial-input state are discarded.
 */
export class FirstOutputTracker {
  private readonly emitted = new Set<string>();
  private readonly carry = new Map<string, string>();

  /**
   * Feed a fresh PTY chunk. If the session has not yet emitted first
   * output and the current detector input qualifies, mark it emitted and
   * return true. Returns false if the session already emitted or the input
   * does not qualify.
   */
  consume(
    sessionId: string,
    data: string,
    detectFirstOutput?: (data: string) => boolean,
  ): boolean {
    if (this.emitted.has(sessionId)) return false;
    if (detectFirstOutput) {
      const detectorInput = `${this.carry.get(sessionId) ?? ''}${data}`;
      if (!detectFirstOutput(detectorInput)) {
        this.carry.set(sessionId, detectorInput.slice(-64));
        return false;
      }
    } else if (data.length === 0) {
      return false;
    }
    this.carry.delete(sessionId);
    this.emitted.add(sessionId);
    return true;
  }

  /** True if `consume()` has ever returned true for this session. */
  hasEmitted(sessionId: string): boolean {
    return this.emitted.has(sessionId);
  }

  /**
   * Snapshot of the session IDs that have emitted first output. Used to
   * rebuild the renderer's `sessionFirstOutput` map after an HMR reload (the
   * renderer state resets to {} on module re-evaluation, which would otherwise
   * flash a running session back to "Starting agent..." until its next chunk).
   */
  snapshot(): string[] {
    return Array.from(this.emitted);
  }

  /** Drop per-session state. Called from SessionManager.remove(). */
  removeSession(sessionId: string): void {
    this.emitted.delete(sessionId);
    this.carry.delete(sessionId);
  }

  /** Drop all state. Called from SessionManager.killAll(). */
  clear(): void {
    this.emitted.clear();
    this.carry.clear();
  }
}
