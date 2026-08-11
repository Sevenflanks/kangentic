/**
 * In-memory scroll-position memory for the Changes view diff editor.
 *
 * The Monaco DiffEditor stays mounted across file switches, so scroll position
 * would otherwise bleed between files. This module remembers each file's scroll
 * position (keyed by a task-scoped scroll key plus the file path) so revisiting
 * a file restores where the user left off. The first time a file is opened the
 * map has no entry, and the caller falls back to revealing the first change.
 *
 * The map is module-scope and preserved across HMR (Pattern A in
 * `.claude/rules/hmr-patterns.md`), mirroring `savedScrollPositions` in
 * `src/renderer/hooks/useTerminal.ts`. It is intentionally NOT persisted to the
 * database: a fresh app start falls back to the first-change reveal.
 */

export interface DiffScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

/** What the diff viewer should do when a file's content first becomes visible. */
export type DiffScrollAction =
  | { kind: 'restore'; position: DiffScrollPosition }
  | { kind: 'revealLineInCenter'; lineNumber: number }
  | { kind: 'scrollToTop' };

/** A single computed line change, narrowed to the field the reveal needs. */
export interface DiffLineChangeLike {
  modifiedStartLineNumber: number;
}

const savedDiffScrollPositions: Map<string, DiffScrollPosition> = import.meta.hot?.data?.savedDiffScrollPositions ?? new Map<string, DiffScrollPosition>();

if (import.meta.hot) {
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.savedDiffScrollPositions = savedDiffScrollPositions;
  });
}

/** Build the map key from the task-scoped scroll key and the file path. */
export function makeDiffScrollKey(scrollKey: string, filePath: string): string {
  return `${scrollKey}:${filePath}`;
}

/** Read a saved scroll position, or undefined if the file has not been visited. */
export function getSavedDiffScroll(key: string): DiffScrollPosition | undefined {
  return savedDiffScrollPositions.get(key);
}

/** Remember a file's scroll position. */
export function saveDiffScroll(key: string, position: DiffScrollPosition): void {
  savedDiffScrollPositions.set(key, position);
}

/**
 * Decide how to position a file's diff when its content first becomes visible.
 *
 * - A saved position always wins (revisit): restore it.
 * - Otherwise the diff must be computed to reveal the first change. `null` line
 *   changes mean the computation has not finished, so return `null` and stay
 *   armed until it does.
 * - A non-empty result reveals the first hunk centered. Pure-deletion hunks
 *   report `modifiedStartLineNumber` 0, so clamp to line 1.
 * - An empty result (no detectable changes) falls back to the top of the file.
 */
export function resolveDiffScrollAction(
  saved: DiffScrollPosition | undefined,
  lineChanges: DiffLineChangeLike[] | null,
): DiffScrollAction | null {
  if (saved) {
    return { kind: 'restore', position: saved };
  }
  if (lineChanges === null) {
    return null;
  }
  if (lineChanges.length === 0) {
    return { kind: 'scrollToTop' };
  }
  return { kind: 'revealLineInCenter', lineNumber: Math.max(1, lineChanges[0].modifiedStartLineNumber) };
}
