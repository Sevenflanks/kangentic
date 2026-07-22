import { describe, it, expect } from 'vitest';
import { FirstOutputTracker } from '../../src/main/pty/lifecycle/first-output-tracker';

describe('FirstOutputTracker', () => {
  describe('consume', () => {
    it('fires true on the first qualifying chunk', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', 'hello')).toBe(true);
    });

    it('returns false on every subsequent chunk for the same session', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', 'first')).toBe(true);
      expect(tracker.consume('s1', 'second')).toBe(false);
      expect(tracker.consume('s1', 'third')).toBe(false);
    });

    it('treats empty data as not qualifying when no detector is provided', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', '')).toBe(false);
      expect(tracker.hasEmitted('s1')).toBe(false);
      expect(tracker.consume('s1', 'real')).toBe(true);
    });

    it('delegates the qualification decision to the adapter detector', () => {
      const tracker = new FirstOutputTracker();
      const claudeDetector = (chunk: string) => chunk.includes('\x1b[?1049h');
      // Prompt output before the alternate-screen escape should not qualify
      expect(tracker.consume('s1', 'bash$ claude --resume', claudeDetector)).toBe(false);
      expect(tracker.hasEmitted('s1')).toBe(false);
      // The first chunk containing the escape qualifies
      expect(tracker.consume('s1', '\x1b[?1049hCLI booting', claudeDetector)).toBe(true);
    });

    it('reconstructs detector input split across chunks', () => {
      const tracker = new FirstOutputTracker();
      const detector = (data: string) => data.includes('\x1b[?1049h');

      expect(tracker.consume('s1', '\x1b[?104', detector)).toBe(false);
      expect(tracker.consume('s1', '9hCLI booting', detector)).toBe(true);
    });

    it('emits exactly once after reconstructing split detector input', () => {
      const tracker = new FirstOutputTracker();
      const detector = (data: string) => data.includes('\x1b[?1049h');

      expect(tracker.consume('s1', '\x1b[?104', detector)).toBe(false);
      expect(tracker.consume('s1', '9hCLI booting', detector)).toBe(true);
      expect(tracker.consume('s1', '\x1b[?1049hagain', detector)).toBe(false);
      expect(tracker.consume('s1', 'later output', detector)).toBe(false);
    });

    it('does not combine detector input from different sessions', () => {
      const tracker = new FirstOutputTracker();
      const detector = (data: string) => data.includes('\x1b[?1049h');

      expect(tracker.consume('s1', '\x1b[?104', detector)).toBe(false);
      expect(tracker.consume('s2', '9hCLI booting', detector)).toBe(false);
      expect(tracker.consume('s1', '9hCLI booting', detector)).toBe(true);
    });

    it('tracks sessions independently', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.consume('s1', 'hello')).toBe(true);
      expect(tracker.consume('s2', 'hello')).toBe(true);
      expect(tracker.consume('s1', 'again')).toBe(false);
      expect(tracker.consume('s2', 'again')).toBe(false);
    });
  });

  describe('hasEmitted', () => {
    it('reflects consume outcome', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.hasEmitted('s1')).toBe(false);
      tracker.consume('s1', 'hello');
      expect(tracker.hasEmitted('s1')).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('removeSession lets a reused ID fire again', () => {
      const tracker = new FirstOutputTracker();
      tracker.consume('s1', 'hello');
      tracker.removeSession('s1');
      expect(tracker.hasEmitted('s1')).toBe(false);
      expect(tracker.consume('s1', 'hello again')).toBe(true);
    });

    it('removeSession discards partial detector input', () => {
      const tracker = new FirstOutputTracker();
      const detector = (data: string) => data.includes('\x1b[?1049h');

      expect(tracker.consume('s1', '\x1b[?104', detector)).toBe(false);
      tracker.removeSession('s1');
      expect(tracker.consume('s1', '9hCLI booting', detector)).toBe(false);
    });

    it('clear drops all sessions', () => {
      const tracker = new FirstOutputTracker();
      tracker.consume('s1', 'a');
      tracker.consume('s2', 'b');
      tracker.clear();
      expect(tracker.hasEmitted('s1')).toBe(false);
      expect(tracker.hasEmitted('s2')).toBe(false);
    });

    it('clear discards partial detector input for every session', () => {
      const tracker = new FirstOutputTracker();
      const detector = (data: string) => data.includes('\x1b[?1049h');

      expect(tracker.consume('s1', '\x1b[?104', detector)).toBe(false);
      expect(tracker.consume('s2', '\x1b[?104', detector)).toBe(false);
      tracker.clear();
      expect(tracker.consume('s1', '9hCLI booting', detector)).toBe(false);
      expect(tracker.consume('s2', '9hCLI booting', detector)).toBe(false);
    });
  });

  // snapshot() backs SessionManager.getFirstOutputCache(), which lets the
  // renderer rebuild sessionFirstOutput after an HMR reload.
  describe('snapshot', () => {
    it('reflects sessions that have emitted, and tracks removal/clear', () => {
      const tracker = new FirstOutputTracker();
      expect(tracker.snapshot()).toEqual([]);

      tracker.consume('s1', 'hello');
      tracker.consume('s2', 'world');
      expect(tracker.snapshot().sort()).toEqual(['s1', 's2']);

      tracker.removeSession('s1');
      expect(tracker.snapshot()).toEqual(['s2']);

      tracker.clear();
      expect(tracker.snapshot()).toEqual([]);
    });

    it('excludes a session whose chunk did not qualify', () => {
      const tracker = new FirstOutputTracker();
      tracker.consume('s1', '', () => false);
      expect(tracker.snapshot()).toEqual([]);
    });
  });
});
