/**
 * Per-session serial write queue.
 *
 * `pty.write` on Windows ConPTY is fire-and-forget; sustained large writes
 * can saturate the input pipe and reorder bytes. To avoid that, every
 * `enqueue` for a given session appends a FIFO entry drained by one loop
 * that emits at most `chunkSize` bytes per tick, yielding via `setImmediate`
 * between chunks so libuv can flush the named pipe.
 *
 * Entries never coalesce across caller boundaries. The loop drains each entry
 * completely before advancing, so byte order is FIFO regardless of how many
 * callers (user input, terminal-submit keystrokes, paste) write to the same
 * session at once. This is the invariant that prevents bracketed-paste
 * sequences from being fragmented by interleaved writes - the regression that
 * caused Ctrl+V truncation.
 *
 * The queue is also surrogate-pair-safe: chunks never split a JavaScript
 * UTF-16 surrogate pair, which would otherwise produce U+FFFD replacement
 * characters when node-pty UTF-8-encodes the chunk.
 */

export interface PtyWriteTarget {
  write(data: string): void;
}

export class PtyWriteError extends Error {
  readonly name = 'PtyWriteError';

  constructor(readonly code: 'missing-pty' | 'write-failed' | 'disposed') {
    super(code);
  }
}

export interface WriteQueue {
  /** Append a fire-and-forget entry; starts the drain loop if idle. */
  enqueue(data: string): void;
  /** Resolve after this entry's final chunk passes `pty.write`. */
  enqueueAcknowledged(data: string): Promise<void>;
  /**
   * Resolve once the queue is empty and the drain loop has stopped.
   * Resolves immediately if already idle. Used by callers that need to
   * sequence follow-up writes (e.g. submit-keystrokes after a paste)
   * without racing the chunked drain.
   */
  drained(): Promise<void>;
  /** Drop pending entries and stop the drain loop. Idempotent. */
  dispose(): void;
}

export const DEFAULT_CHUNK_SIZE = 4096;

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
/**
 * Cap on extending a chunk to ship a whole paste packet atomically.
 * Above this size we fall back to default chunking with event-loop
 * yields so the main process stays responsive during huge pastes.
 * Modern Ink TUIs accumulate paste content across stdin reads, so
 * splitting the packet across multiple pty.write calls is safe.
 */
const MAX_ATOMIC_PASTE_SIZE = 16384;

/**
 * Pick a chunk boundary that doesn't split:
 *   1. A UTF-16 surrogate pair (would produce U+FFFD when node-pty
 *      UTF-8-encodes the chunk).
 *   2. A bracketed-paste packet between `\e[200~` and `\e[201~`.
 *      Ink's parser cannot reassemble paste content across stdin reads,
 *      so the close marker MUST arrive in the same write as the start.
 *
 * For pastes that would split the default chunkSize, we either defer
 * the whole paste to the next chunk (when there's prefix to send first)
 * or extend this chunk to include the entire packet (when the paste
 * begins at offset 0). The drain loop tolerates oversized chunks.
 */
function safeChunkEnd(buffer: string, chunkSize: number): number {
  if (chunkSize <= 1) return chunkSize;

  const pasteStartIdx = buffer.indexOf(BRACKETED_PASTE_START);
  if (pasteStartIdx >= 0 && pasteStartIdx < chunkSize) {
    const pasteEndIdx = buffer.indexOf(BRACKETED_PASTE_END, pasteStartIdx + BRACKETED_PASTE_START.length);
    if (pasteEndIdx >= 0) {
      const wholePasteEnd = pasteEndIdx + BRACKETED_PASTE_END.length;
      if (wholePasteEnd > chunkSize) {
        // Small pastes ship atomic; huge ones chunk so the main process
        // doesn't block on a single giant pty.write. Ink accumulates
        // paste content across reads, so splitting is safe above the cap.
        if (wholePasteEnd <= MAX_ATOMIC_PASTE_SIZE) {
          return pasteStartIdx > 0 ? pasteStartIdx : wholePasteEnd;
        }
        if (pasteStartIdx > 0) return pasteStartIdx;
        // Paste already begins at offset 0 - fall through to chunk at chunkSize.
      }
    } else if (pasteStartIdx > 0) {
      // Start marker without close marker yet. Defer until close arrives.
      return pasteStartIdx;
    }
  }

  // Surrogate-pair safety: don't end on a high surrogate.
  const code = buffer.charCodeAt(chunkSize - 1);
  if (code >= 0xd800 && code <= 0xdbff) return chunkSize - 1;
  return chunkSize;
}

export interface CreateWriteQueueOptions {
  /** Optional callback fired when the queue auto-disposes after a thrown
   *  `pty.write`. Lets the owner remove its map entry so the next enqueue
   *  for the same session creates a fresh queue rather than reusing a
   *  permanently disposed one. Not called for explicit `dispose()`
   *  invocations - those callers already manage their own state. */
  onAutoDispose?: () => void;
}

interface WriteAcknowledgement {
  settled: boolean;
  readonly resolve: () => void;
  readonly reject: (error: PtyWriteError) => void;
}

interface WriteEntry {
  remaining: string;
  readonly acknowledgement?: WriteAcknowledgement;
}

export function createWriteQueue(
  getPty: () => PtyWriteTarget | null,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  options: CreateWriteQueueOptions = {},
): WriteQueue {
  const entries: WriteEntry[] = [];
  let draining = false;
  let disposed = false;
  const drainResolvers: Array<() => void> = [];

  function fireDrainResolvers(): void {
    if (drainResolvers.length === 0) return;
    const pending = drainResolvers.splice(0, drainResolvers.length);
    for (const resolve of pending) resolve();
  }

  function stopDraining(): void {
    draining = false;
    fireDrainResolvers();
  }

  function resolveAcknowledgement(entry: WriteEntry): void {
    const acknowledgement = entry.acknowledgement;
    if (!acknowledgement || acknowledgement.settled) return;
    acknowledgement.settled = true;
    acknowledgement.resolve();
  }

  function rejectEntries(code: PtyWriteError['code']): void {
    const error = new PtyWriteError(code);
    const pending = entries.splice(0, entries.length);
    for (const entry of pending) {
      const acknowledgement = entry.acknowledgement;
      if (!acknowledgement || acknowledgement.settled) continue;
      acknowledgement.settled = true;
      acknowledgement.reject(error);
    }
  }

  const drain = (): void => {
    if (disposed) {
      rejectEntries('disposed');
      stopDraining();
      return;
    }
    const pty = getPty();
    if (!pty) {
      // Session ended mid-drain. Drop pending bytes; the renderer will not
      // be notified - matching the existing fire-and-forget IPC contract.
      rejectEntries('missing-pty');
      stopDraining();
      return;
    }
    const entry = entries[0];
    if (!entry) {
      stopDraining();
      return;
    }
    const end = entry.remaining.length > chunkSize
      ? safeChunkEnd(entry.remaining, chunkSize)
      : entry.remaining.length;
    const chunk = entry.remaining.slice(0, end);
    entry.remaining = entry.remaining.slice(end);
    try {
      pty.write(chunk);
    } catch (error) {
      // pty.write can throw if the underlying handle was torn down between
      // our null check and the call. Stop the loop and drop pending bytes
      // rather than re-entering and looping on the same failure. Notify
      // the owner so it can clear its map entry; otherwise the next write
      // for this session would silently reuse a disposed queue.
      disposed = true;
      rejectEntries('write-failed');
      stopDraining();
      options.onAutoDispose?.();
      const genericError = new Error('pty.write threw a non-Error value');
      try {
        const loggedError = error instanceof Error ? error : genericError;
        console.error('[write-queue] pty.write threw, dropping pending bytes:', loggedError);
      } catch {
        console.error('[write-queue] pty.write threw, dropping pending bytes:', genericError);
      }
      return;
    }

    if (entry.remaining.length === 0) {
      entries.shift();
      resolveAcknowledgement(entry);
    }
    if (entries.length === 0) {
      stopDraining();
      return;
    }
    setImmediate(drain);
  };

  function enqueueEntry(entry: WriteEntry): void {
    entries.push(entry);
    if (draining) return;
    draining = true;
    drain();
  }

  return {
    enqueue(data: string): void {
      if (disposed || data.length === 0) return;
      enqueueEntry({ remaining: data });
    },
    enqueueAcknowledged(data: string): Promise<void> {
      if (disposed) return Promise.reject(new PtyWriteError('disposed'));
      if (data.length === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        enqueueEntry({
          remaining: data,
          acknowledgement: { settled: false, resolve, reject },
        });
      });
    },
    drained(): Promise<void> {
      if (disposed || (!draining && entries.length === 0)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rejectEntries('disposed');
      stopDraining();
    },
  };
}
