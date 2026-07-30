import type { SessionManager } from './session-manager';
import type { PasteEngine, PasteOptions } from './paste-engine';
import { sanitizeForPty } from '../../shared/paths';

const SUBMISSION_ABORTED = new Error('aborted');

function makeAbortableWait(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
  return (ms: number) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(SUBMISSION_ABORTED);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(SUBMISSION_ABORTED);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Re-export the PasteEngine error class so callers (`browser.ts`) can catch
 * specific submission failures without reaching into `pty/paste-engine.ts`
 * directly. PasteEngine is an implementation detail of TerminalSubmit; this
 * is the only public symbol it exposes.
 */
export { PasteSubmitError } from './paste-engine';

/**
 * Per-command verifier polled by `submitKeystrokes` between writes when
 * delivering a chained sequence (e.g. `/model X` then `/effort Y`). Returns
 * true when the agent confirmed the injected command was processed, false on
 * single-scan miss. Adapters supply this via
 * `getSubmissionVerifier('command-injection')`, with the `sentAt` of the
 * most recent Enter so the verifier can bound its scan window.
 *
 * Defined here so `terminal-submit-scheduler` (the lifecycle wrapper),
 * `injection-plan` (the builder), and `slash-command-verifier` (the impl)
 * can all import from one place.
 */
export type CommandVerifier = (command: string, sentAt: number) => Promise<boolean>;

export interface TerminalKeystrokeWriter { write(data: string): Promise<void>; }

/**
 * Free-form-content delivery options. Forwarded verbatim to PasteEngine.
 * Re-exported here as the public shape for `submitContent` callers.
 */
export type SubmitContentOptions = PasteOptions;

/** Manual-keystroke delivery options. */
export interface SubmitKeystrokesOptions {
  // Optional acknowledged sink. When present, it owns every emitted keystroke.
  writer?: TerminalKeystrokeWriter;
  /**
   * Send Ctrl+C before the first command to clear half-typed input or
   * interrupt thinking. Default true. Set false for paths that just spawned
   * the CLI and have nothing to interrupt (e.g. fresh-spawn auto_command).
   */
  sendCtrlC?: boolean;
  /**
   * Per-command verifier. When provided, each command in
   * `commands[0:verifiedPrefixLength]` is polled for confirmation in the
   * agent's transcript with retry-on-Enter. Trailing commands settle on a
   * fixed window. Defaults to verifying every command when supplied.
   */
  verifier?: CommandVerifier | null;
  /**
   * Number of leading commands to verify. Lets callers verify deterministic
   * adapter-emitted writes (`/model X`, `/effort Y`) while leaving
   * user-supplied auto_commands fire-and-forget - the verifier cannot know
   * whether a `/`-prefixed user command will produce a matching transcript
   * entry, so attempting to verify it risks dropping the user's intent.
   */
  verifiedPrefixLength?: number;
  strictVerification?: boolean;
  /**
   * Caller cancellation. The current wait stops; writes already accepted by
   * the selected sink cannot be undone. Aborting between commands is the
   * typical cancellation point.
   */
  signal?: AbortSignal;
  /** Diagnostic label for `[terminal-submit]` log lines. */
  source?: string;
}

/**
 * `TerminalSubmit` is the byte-pushing engine for getting user-facing text
 * into a PTY session. Two methods, two strategies:
 *
 * - **submitContent**: bracketed-paste delivery for free-form content (URLs,
 *   prompts, attachments). The TUI receives the text as a single paste event
 *   so special characters do not trigger key handlers. Browser-pane Send and
 *   future content-delivery paths use this.
 *
 * - **submitKeystrokes**: manual `Ctrl+C? → text → Esc → Enter` keystroke
 *   sequence for slash commands and anything the TUI must interpret. The Esc
 *   step dismisses any open autocomplete picker so Enter resolves to "submit
 *   typed text" rather than "select picker item". `auto_command`, `/model`,
 *   `/effort`, and `send_command` actions all use this.
 *
 * The two strategies are NOT interchangeable - bracket-pasting `/test` makes
 * the TUI treat it as literal text (slash-command parser never fires), and
 * sending a 2KB URL as keystrokes takes ~80 seconds and trips key handlers.
 * Callers must pick the right method for their content type. The
 * `TerminalSubmitScheduler` wrapper layered on top of `submitKeystrokes`
 * adds task-keyed lifecycle (cancel, fresh-spawn wait, drag-burst coalesce).
 */
export class TerminalSubmit {
  constructor(
    private sessionManager: SessionManager,
    private pasteEngine: PasteEngine,
  ) {}

  /**
   * Bracketed-paste delivery for free-form content. Delegates to PasteEngine
   * which handles drain → chunked write → output settle → \r → submission
   * evidence with retry. See `paste-engine.ts` for the underlying algorithm
   * and timing tunables.
   */
  async submitContent(
    sessionId: string,
    text: string,
    opts: SubmitContentOptions = {},
  ): Promise<void> {
    return this.pasteEngine.pasteAndSubmit(sessionId, text, opts);
  }

  /**
   * Manual keystroke sequence for one or more commands. Each command is
   * sanitized (CR/LF/Tab → space, then trim) and delivered as
   * `text → Esc → Enter` with `KEYPRESS_DELAY` ms between keypresses (see
   * the constant in the body for the current value and the rationale).
   * The leading Ctrl+C (default, opt-out via `sendCtrlC: false`) clears
   * any half-typed input before the first command.
   *
   * For chained bursts (e.g. `/model X` then `/effort Y` then auto_command):
   *   - Pass the whole sequence in `commands[]`.
   *   - Provide a `verifier` and `verifiedPrefixLength` to confirm each
   *     deterministic write reached the transcript. Trailing user-supplied
   *     commands settle on a fixed 500ms window (intentionally unverified -
   *     a `/`-prefixed user command may not produce a matching JSONL entry).
   *
   * Aborting via `opts.signal` stops the next write/wait. Writes already
   * accepted by the selected sink cannot be undone.
   */
  async submitKeystrokes(
    sessionId: string,
    commands: string[],
    opts: SubmitKeystrokesOptions = {},
  ): Promise<void> {
    const writer = opts.writer;
    const sanitized = commands.map((cmd) => sanitizeForPty(cmd)).filter((cmd) => cmd.length > 0);
    if (sanitized.length === 0) return;

    const sendCtrlC = opts.sendCtrlC ?? true;
    const verifier = opts.verifier ?? null;
    // Default to verifying every command when a verifier is provided; clamp
    // to the actual sanitized length so an over-large hint does not index
    // past the array. Filter-then-clamp is intentional: empty commands were
    // dropped, but the caller's prefix length still refers to the pre-filter
    // sequence; clamping is the safe interpretation.
    const verifiedPrefixLength = verifier
      ? Math.min(opts.verifiedPrefixLength ?? sanitized.length, sanitized.length)
      : 0;
    const source = opts.source ?? 'unknown';
    const write = async (data: string): Promise<void> => {
      if (writer) {
        // 第一個成功的 lease write 會提交 sink ownership；之後取消已無法安全歸還 lease。
        await writer.write(data);
        return;
      }
      this.sessionManager.write(sessionId, data);
    };

    // Tunables. KEYPRESS_DELAY at 100ms gives Claude Code's Ink TUI enough
    // time to render the slash-command autocomplete picker BEFORE the Esc
    // keypress arrives. Empirically 40ms was too aggressive -- under load
    // (ConPTY IPC overhead, React commit cycle for the picker overlay) the
    // Esc could arrive before the picker had rendered, becoming a no-op,
    // and the subsequent Enter would land while the picker was still
    // visible. The picker then ate the Enter (or Enter "selected" a partial
    // match), leaving the auto_command typed but never submitted -- the
    // exact regression we shipped fixes for. 100ms covers the worst
    // observed picker-render time on Windows ConPTY without making the
    // total burst (Ctrl+C + 3 keypresses + settle) feel sluggish.
    const CTRL_C_SETTLE = 100;
    const KEYPRESS_DELAY = 100;
    const COMMAND_SETTLE = 500;
    const VERIFY_POLL_MS = 25;
    const RETRY_INTERVAL_MS = 400;
    const MAX_RETRIES = 4;

    const wait = makeAbortableWait(opts.signal);

    try {
      if (sendCtrlC) {
        // Leading Ctrl+C clears any half-typed input or interrupts thinking.
        await write('\x03');
        await wait(CTRL_C_SETTLE);
      }

      for (let commandIndex = 0; commandIndex < sanitized.length; commandIndex++) {
        const command = sanitized[commandIndex];
        const shouldVerify = verifier !== null && commandIndex < verifiedPrefixLength;
        const sentAt = Date.now();

        await write(command);
        await wait(KEYPRESS_DELAY);
        // Escape dismisses any open slash-command autocomplete picker so the
        // following Enter resolves to "submit typed text" rather than "select
        // picker item" (or, if the picker is mid-render, getting swallowed).
        await write('\x1b');
        await wait(KEYPRESS_DELAY);
        await write('\r');

        if (shouldVerify && verifier) {
          const confirmed = await this.pollWithRetries(
            verifier,
            command,
            sentAt,
            { pollMs: VERIFY_POLL_MS, retryIntervalMs: RETRY_INTERVAL_MS, maxRetries: MAX_RETRIES },
            wait,
            write,
          );
          if (!confirmed) {
            // After exhausting retries, clear any stuck text from the prompt
            // buffer so the next command does not concatenate into the failed
            // one. Better to drop the command than produce a malformed
            // combined invocation.
            console.warn(`[terminal-submit] ${source}: verification failed after ${MAX_RETRIES} retries -- clearing prompt and continuing`);
            await write('\x03');
            await wait(50);
            if (opts.strictVerification) {
              throw new Error('strict command verification failed');
            }
          }
        } else {
          await wait(COMMAND_SETTLE);
        }
      }

      console.log(`[terminal-submit] ${source}: delivered ${sanitized.length} command(s) to session ${sessionId.slice(0, 8)}`);
    } catch (caughtError) {
      if (caughtError === SUBMISSION_ABORTED) return;
      console.error(`[terminal-submit] ${source}: keystroke delivery failed`);
      throw caughtError;
    }
  }

  /**
   * Poll a verifier with a tight loop and re-fire Enter periodically when
   * confirmation does not arrive. The reliability core of the verified path:
   * in the happy case the transcript entry appears within 50-100ms of the
   * initial Enter and we return immediately; in the "Enter eaten by overlay"
   * case we re-fire Enter every `retryIntervalMs` until either a write lands
   * cleanly or we exhaust the retry budget.
   */
  private async pollWithRetries(
    verifier: CommandVerifier,
    command: string,
    initialSentAt: number,
    opts: { pollMs: number; retryIntervalMs: number; maxRetries: number },
    wait: (ms: number) => Promise<void>,
    write: (data: string) => Promise<void>,
  ): Promise<boolean> {
    let sentAt = initialSentAt;
    let retries = 0;
    while (true) {
      const deadline = Date.now() + opts.retryIntervalMs;
      while (Date.now() < deadline) {
        if (await verifier(command, sentAt)) return true;
        await wait(opts.pollMs);
      }
      if (retries >= opts.maxRetries) return false;
      retries += 1;
      sentAt = Date.now();
      await write('\r');
    }
  }
}
