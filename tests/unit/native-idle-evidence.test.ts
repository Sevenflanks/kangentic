import { describe, expect, it, vi } from 'vitest';
import { parseOpenCodeNativeBoundary } from '../../src/main/agent/adapters/opencode/native-boundary';
import { NativeIdleEvidence } from '../../src/main/activity-engine/native-idle-evidence';

describe('parseOpenCodeNativeBoundary', () => {
  it('parses only a valid private native boundary', () => {
    const boundary = parseOpenCodeNativeBoundary(JSON.stringify({
      ts: 10,
      type: 'idle',
      privateNativeBoundary: {
        kind: 'idle',
        nativeSessionId: 'root-a',
        occurredAt: 10,
      },
    }));

    expect(boundary).toEqual({ kind: 'idle', nativeSessionId: 'root-a', occurredAt: 10 });
  });

  it.each([
    'not-json',
    JSON.stringify(null),
    JSON.stringify({ privateNativeBoundary: { kind: 'unknown', nativeSessionId: 'root-a', occurredAt: 10 } }),
    JSON.stringify({ privateNativeBoundary: { kind: 'idle', nativeSessionId: 3, occurredAt: 10 } }),
    JSON.stringify({ privateNativeBoundary: { kind: 'idle', nativeSessionId: 'root-a', occurredAt: Number.POSITIVE_INFINITY } }),
  ])('rejects malformed or invalid boundary input', (line) => {
    expect(parseOpenCodeNativeBoundary(line)).toBeNull();
  });
});

describe('NativeIdleEvidence', () => {
  it('authorizes only a matching-root idle', () => {
    const evidence = new NativeIdleEvidence();
    evidence.initializeSession('pty-a', 1);
    evidence.recordBoundary('pty-a', { kind: 'created', nativeSessionId: 'root-a', occurredAt: 1 });

    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'child-a', occurredAt: 2 });
    expect(evidence.snapshot('pty-a')?.cleanIdle).toBeNull();

    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: null, occurredAt: 3 });
    expect(evidence.snapshot('pty-a')?.cleanIdle).toBeNull();

    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 4 });
    expect(evidence.snapshot('pty-a')?.cleanIdle).toEqual({
      nativeSessionId: 'root-a',
      occurredAt: 4,
    });
  });

  it('a matching-root error clears clean idle and latches only its PTY', () => {
    const evidence = new NativeIdleEvidence();
    evidence.initializeSession('pty-a', 1);
    evidence.initializeSession('pty-b', 2);
    evidence.recordBoundary('pty-a', { kind: 'created', nativeSessionId: 'root-a', occurredAt: 1 });
    evidence.recordBoundary('pty-b', { kind: 'created', nativeSessionId: 'root-b', occurredAt: 1 });
    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 2 });
    evidence.recordBoundary('pty-b', { kind: 'idle', nativeSessionId: 'root-b', occurredAt: 2 });

    evidence.recordBoundary('pty-a', { kind: 'error', nativeSessionId: 'root-a', occurredAt: 3 });
    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 4 });

    expect(evidence.snapshot('pty-a')).toMatchObject({ errorLatched: true, cleanIdle: null });
    expect(evidence.snapshot('pty-b')).toMatchObject({
      errorLatched: false,
      cleanIdle: { nativeSessionId: 'root-b', occurredAt: 2 },
    });
  });

  it('a missing-id error clears clean idle and latches only its PTY', () => {
    const evidence = new NativeIdleEvidence();
    evidence.initializeSession('pty-a', 1);
    evidence.initializeSession('pty-b', 2);
    evidence.recordBoundary('pty-a', { kind: 'created', nativeSessionId: 'root-a', occurredAt: 1 });
    evidence.recordBoundary('pty-b', { kind: 'created', nativeSessionId: 'root-b', occurredAt: 1 });
    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 2 });
    evidence.recordBoundary('pty-b', { kind: 'idle', nativeSessionId: 'root-b', occurredAt: 2 });

    evidence.recordBoundary('pty-a', { kind: 'error', nativeSessionId: null, occurredAt: 3 });
    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 4 });

    expect(evidence.snapshot('pty-a')).toMatchObject({ errorLatched: true, cleanIdle: null });
    expect(evidence.snapshot('pty-b')).toMatchObject({
      errorLatched: false,
      cleanIdle: { nativeSessionId: 'root-b', occurredAt: 2 },
    });
  });

  it('subsequent user input clears an error latch and permits a newer root idle', () => {
    const evidence = new NativeIdleEvidence();
    evidence.initializeSession('pty-a', 1);
    evidence.recordBoundary('pty-a', { kind: 'created', nativeSessionId: 'root-a', occurredAt: 1 });
    evidence.recordBoundary('pty-a', { kind: 'error', nativeSessionId: 'root-a', occurredAt: 2 });

    expect(evidence.snapshot('pty-a')?.errorLatched).toBe(true);

    evidence.recordUserInput('pty-a', 1, 3);

    expect(evidence.snapshot('pty-a')).toMatchObject({ errorLatched: false, inputGeneration: 1 });

    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 4 });
    expect(evidence.snapshot('pty-a')?.cleanIdle?.occurredAt).toBe(4);
  });

  it.each([
    { nativeSessionId: 'root-a', label: 'matching-root' },
    { nativeSessionId: null, label: 'missing-id' },
  ])('ignores a delayed $label error older than subsequent user input', ({ nativeSessionId }) => {
    const evidence = new NativeIdleEvidence();
    evidence.initializeSession('pty-a', 1);
    evidence.recordBoundary('pty-a', { kind: 'created', nativeSessionId: 'root-a', occurredAt: 10 });
    evidence.recordUserInput('pty-a', 1, 30);

    evidence.recordBoundary('pty-a', { kind: 'error', nativeSessionId, occurredAt: 20 });

    expect(evidence.snapshot('pty-a')).toMatchObject({ errorLatched: false, cleanIdle: null });

    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 31 });
    expect(evidence.snapshot('pty-a')?.cleanIdle?.occurredAt).toBe(31);
  });

  it('invalidates idle on user input and rejects an earlier delayed idle', () => {
    const evidence = new NativeIdleEvidence();
    evidence.initializeSession('pty-a', 7);
    evidence.recordBoundary('pty-a', { kind: 'created', nativeSessionId: 'root-a', occurredAt: 10 });
    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 20 });

    evidence.recordUserInput('pty-a', 3, 30);
    expect(evidence.snapshot('pty-a')).toMatchObject({
      sessionGeneration: 7,
      inputGeneration: 3,
      cleanIdle: null,
      errorLatched: false,
    });

    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 25 });
    expect(evidence.snapshot('pty-a')?.cleanIdle).toBeNull();

    evidence.recordBoundary('pty-a', { kind: 'idle', nativeSessionId: 'root-a', occurredAt: 31 });
    expect(evidence.snapshot('pty-a')?.cleanIdle?.occurredAt).toBe(31);
  });

  it('supports listener-first snapshot-second across initialization and state changes', () => {
    const evidence = new NativeIdleEvidence();
    const listener = vi.fn();
    const unsubscribe = evidence.subscribe('pty-a', listener);

    expect(evidence.snapshot('pty-a')).toBeNull();

    evidence.initializeSession('pty-a', 1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(evidence.snapshot('pty-a')).toMatchObject({
      rootNativeSessionId: null,
      sessionGeneration: 1,
    });

    evidence.recordBoundary('pty-a', { kind: 'created', nativeSessionId: 'root-a', occurredAt: 1 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(evidence.snapshot('pty-a')?.rootNativeSessionId).toBe('root-a');

    unsubscribe();
  });

  it('notifies an existing listener and clears the snapshot when removing a session', () => {
    const evidence = new NativeIdleEvidence();
    const listener = vi.fn();
    const unsubscribe = evidence.subscribe('pty-a', listener);
    evidence.initializeSession('pty-a', 1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(evidence.snapshot('pty-a')).not.toBeNull();

    evidence.removeSession('pty-a');

    expect(listener).toHaveBeenCalledTimes(2);
    expect(evidence.snapshot('pty-a')).toBeNull();

    unsubscribe();
  });
});
