// Unit tests for src/main/pty/terminal-submit.ts.
//
// `TerminalSubmit` exposes two methods:
//
//  - `submitContent(sessionId, text, opts)` — bracketed-paste delivery for
//    free-form content (browser-pane Send). Thin wrapper around the
//    `PasteEngine.pasteAndSubmit` instance passed in the constructor; tests
//    here just confirm the forwarding contract (paste-engine internals are
//    covered by `paste-engine.test.ts`).
//
//  - `submitKeystrokes(sessionId, commands[], opts)` — manual `Ctrl+C? →
//    text → Esc → Enter` keystroke sequence for slash commands. Tests pin
//    the byte-level contract: ESCAPE is always between text and Enter so
//    Enter resolves to "submit" (not "select picker item"); commands are
//    sanitized; aborts stop the next write/wait; verifier integration
//    works for chained sequences.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalSubmit, type CommandVerifier, type TerminalKeystrokeWriter } from '../../src/main/pty/terminal-submit';
import type { PasteEngine, PasteOptions } from '../../src/main/pty/paste-engine';

class MockSessionManager extends EventEmitter {
  writes: Array<{ id: string; data: string }> = [];

  write(id: string, data: string): void {
    this.writes.push({ id, data });
  }

  writeRaw(id: string, data: string): void {
    this.writes.push({ id, data });
  }

  drain(_id: string): Promise<void> {
    return Promise.resolve();
  }
}

class MockPasteEngine implements PasteEngine {
  calls: Array<{ sessionId: string; text: string; options?: PasteOptions }> = [];

  pasteAndSubmit(sessionId: string, text: string, options?: PasteOptions): Promise<void> {
    this.calls.push({ sessionId, text, options });
    return Promise.resolve();
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// Drive the timer chain in submitKeystrokes: each wait() in the sequence
// resolves at a different timer boundary, and each needs a microtask flush
// before the next-loop wait gets registered. Use small step sizes so every
// intervening setTimeout lands inside a flush window rather than getting
// jumped over in a single big advance.
async function advanceAndTick(ms: number, iterations = 30): Promise<void> {
  const stepSize = Math.max(1, Math.ceil(ms / iterations));
  for (let i = 0; i < iterations; i++) {
    vi.advanceTimersByTime(stepSize);
    await tick();
  }
}

describe('TerminalSubmit', () => {
  let sessionManager: MockSessionManager;
  let pasteEngine: MockPasteEngine;
  let submit: TerminalSubmit;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new MockSessionManager();
    pasteEngine = new MockPasteEngine();
    submit = new TerminalSubmit(sessionManager as never, pasteEngine);
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionManager.removeAllListeners();
  });

  describe('submitContent', () => {
    it('forwards to PasteEngine.pasteAndSubmit byte-for-byte', async () => {
      await submit.submitContent('s1', 'hello world', { bracketed: true, source: 'test' });

      expect(pasteEngine.calls).toHaveLength(1);
      expect(pasteEngine.calls[0].sessionId).toBe('s1');
      expect(pasteEngine.calls[0].text).toBe('hello world');
      expect(pasteEngine.calls[0].options).toEqual({ bracketed: true, source: 'test' });
    });

    it('passes through verifier and signal options', async () => {
      const stubVerifier = vi.fn().mockResolvedValue(true);
      const controller = new AbortController();

      await submit.submitContent('s1', 'payload', {
        verifier: stubVerifier,
        signal: controller.signal,
        source: 'browser-capture',
      });

      expect(pasteEngine.calls[0].options?.verifier).toBe(stubVerifier);
      expect(pasteEngine.calls[0].options?.signal).toBe(controller.signal);
      expect(pasteEngine.calls[0].options?.source).toBe('browser-capture');
    });
  });

  describe('submitKeystrokes', () => {
    it('writes Ctrl+C → text → Esc → Enter for a single command', async () => {
      const promise = submit.submitKeystrokes('s1', ['/test']);
      await advanceAndTick(1000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      expect(datas).toEqual(['\x03', '/test', '\x1b', '\r']);
    });

    it('skips the leading Ctrl+C when sendCtrlC is false', async () => {
      const promise = submit.submitKeystrokes('s1', ['/test'], { sendCtrlC: false });
      await advanceAndTick(1000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      expect(datas).toEqual(['/test', '\x1b', '\r']);
    });

    it('uses the writer exclusively for ordered text, Escape, and Enter', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const writer: TerminalKeystrokeWriter = { write: vi.fn(async () => undefined) };
      const promise = submit.submitKeystrokes('s1', ['/safe'], {
        writer, sendCtrlC: false, verifier: null, verifiedPrefixLength: 0,
      });
      await advanceAndTick(1000);
      await promise;

      expect(writer.write).toHaveBeenNthCalledWith(1, '/safe');
      expect(writer.write).toHaveBeenNthCalledWith(2, '\x1b');
      expect(writer.write).toHaveBeenNthCalledWith(3, '\r');
      expect(sessionManager.writes).toHaveLength(0);
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('/safe');
    });

    it('awaits each writer delivery before starting the next', async () => {
      const received: string[] = [];
      const releases: Array<() => void> = [];
      const writer: TerminalKeystrokeWriter = {
        write: vi.fn((data: string) => new Promise<void>((resolve) => {
          received.push(data);
          releases.push(resolve);
        })),
      };
      const promise = submit.submitKeystrokes('s1', ['/safe'], {
        writer, sendCtrlC: false, verifier: null, verifiedPrefixLength: 0,
      });
      await tick();

      await advanceAndTick(1000);
      expect(received).toEqual(['/safe']);
      releases[0]();
      await advanceAndTick(200);
      expect(received).toEqual(['/safe', '\x1b']);
      releases[1]();
      await advanceAndTick(200);
      expect(received).toEqual(['/safe', '\x1b', '\r']);
      releases[2]();
      await advanceAndTick(600);
      await promise;
    });

    it('keeps the original writer when caller options change during delivery', async () => {
      const originalWrites: string[] = [];
      let releaseFirstWrite = (): void => undefined;
      const originalWriter: TerminalKeystrokeWriter = {
        write: vi.fn((data: string) => {
          originalWrites.push(data);
          if (originalWrites.length > 1) return Promise.resolve();
          return new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
        }),
      };
      const replacementWriter: TerminalKeystrokeWriter = { write: vi.fn(async () => undefined) };
      const options = {
        writer: originalWriter, sendCtrlC: false, verifier: null, verifiedPrefixLength: 0,
      };
      const promise = submit.submitKeystrokes('s1', ['/safe'], options);
      await tick();

      options.writer = replacementWriter;
      releaseFirstWrite();
      await advanceAndTick(1000);
      await promise;

      expect(originalWrites).toEqual(['/safe', '\x1b', '\r']);
      expect(replacementWriter.write).not.toHaveBeenCalled();
      expect(sessionManager.writes).toHaveLength(0);
    });

    it('rethrows writer failure without sending later bytes or logging its message', async () => {
      const failure = new Error('aborted writer-error-private-marker');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const writer: TerminalKeystrokeWriter = { write: vi.fn(() => Promise.reject(failure)) };

      await expect(submit.submitKeystrokes('s1', ['/failure-secret'], {
        writer, sendCtrlC: false, verifier: null, verifiedPrefixLength: 0,
      })).rejects.toBe(failure);

      expect(writer.write).toHaveBeenCalledTimes(1);
      expect(sessionManager.writes).toHaveLength(0);
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('/failure-secret');
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('writer-error-private-marker');
    });

    it('writes each command in a chained sequence with Esc between', async () => {
      const promise = submit.submitKeystrokes('s1', ['/model opus', '/effort high']);
      await advanceAndTick(2000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      // Ctrl+C → cmd1 → Esc → \r → cmd2 → Esc → \r
      expect(datas).toEqual([
        '\x03',
        '/model opus', '\x1b', '\r',
        '/effort high', '\x1b', '\r',
      ]);
    });

    it('sanitizes commands: collapses CR/LF/Tab to spaces', async () => {
      const promise = submit.submitKeystrokes('s1', ['line\none\rtwo\tthree']);
      await advanceAndTick(1000);
      await promise;

      const datas = sessionManager.writes.map((w) => w.data);
      expect(datas).toContain('line one two three');
    });

    it('drops empty commands silently', async () => {
      const promise = submit.submitKeystrokes('s1', ['', '   ', '\n\t']);
      await advanceAndTick(1000);
      await promise;

      // No writes - all commands sanitized to empty.
      expect(sessionManager.writes).toHaveLength(0);
    });

    it('aborts in-flight via AbortSignal between writes', async () => {
      const controller = new AbortController();
      const promise = submit.submitKeystrokes('s1', ['/test'], { signal: controller.signal });

      // Advance through Ctrl+C settle so we are between commands.
      vi.advanceTimersByTime(100);
      await tick();
      const writesBeforeCancel = sessionManager.writes.length;

      controller.abort();
      await advanceAndTick(1000);
      await promise; // resolves cleanly on abort (logged, not thrown)

      // No additional writes after cancel.
      expect(sessionManager.writes.length).toBe(writesBeforeCancel);
    });

    it('verifier confirms via JSONL match within the first poll window', async () => {
      const verifier: CommandVerifier = vi.fn().mockResolvedValue(true);

      const promise = submit.submitKeystrokes('s1', ['/model opus'], {
        verifier,
        verifiedPrefixLength: 1,
      });
      // Verifier resolves before the retry interval fires.
      await advanceAndTick(500);
      await promise;

      expect(verifier).toHaveBeenCalled();
      const calls = (verifier as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe('/model opus');
    });

    it('verifier retry-on-Enter when first scan misses', async () => {
      let scanCount = 0;
      // Miss the first retry interval (~16 polls of 25ms = 400ms),
      // succeed before the second one fires its Enter so the test
      // observes exactly one retry write before resolving.
      const verifier: CommandVerifier = async (_command, _sentAt) => {
        scanCount += 1;
        return scanCount > 20;
      };

      const promise = submit.submitKeystrokes('s1', ['/model opus'], {
        verifier,
        verifiedPrefixLength: 1,
      });
      // Total ~1000ms to cover Ctrl+C settle (100ms) + keypress group (200ms)
      // + first retry interval (400ms) + a few more polls before success.
      await advanceAndTick(1200, 120);
      await promise;

      // The retry path fires extra `\r` writes when verifier keeps returning false.
      const enterCount = sessionManager.writes.filter((w) => w.data === '\r').length;
      expect(enterCount).toBeGreaterThan(1);
    });

    it('does not expose command text when verification fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const promise = submit.submitKeystrokes('s1', ['/verify-secret'], {
        sendCtrlC: false,
        verifier: vi.fn().mockResolvedValue(false),
        verifiedPrefixLength: 1,
      });
      await advanceAndTick(3000, 300);
      await promise;

      expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('/verify-secret');
    });

    it('time-settles trailing commands beyond verifiedPrefixLength', async () => {
      const verifier: CommandVerifier = vi.fn().mockResolvedValue(true);

      const promise = submit.submitKeystrokes(
        's1',
        ['/model opus', 'auto user prompt'],
        { verifier, verifiedPrefixLength: 1 },
      );
      await advanceAndTick(2500);
      await promise;

      // Verifier called only for the first (verified) command, not the
      // trailing user-supplied prompt.
      expect(verifier).toHaveBeenCalledTimes(1);
      const calls = (verifier as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe('/model opus');
    });
  });
});
