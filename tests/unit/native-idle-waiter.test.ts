import { describe, expect, it } from 'vitest';
import type { NativeIdleSnapshot } from '../../src/main/activity-engine/native-idle-evidence';
import {
  evaluateNativeIdleReadiness,
  type NativeIdleExpectation,
} from '../../src/main/transition-engine/native-idle-waiter';

const expectation: NativeIdleExpectation = {
  nativeSessionId: 'root-1',
  sessionGeneration: 7,
  inputGeneration: 3,
};

function snapshot(overrides: Partial<NativeIdleSnapshot> = {}): NativeIdleSnapshot {
  return {
    rootNativeSessionId: 'root-1',
    sessionGeneration: 7,
    inputGeneration: 3,
    cleanIdle: null,
    errorLatched: false,
    ...overrides,
  };
}

describe('evaluateNativeIdleReadiness', () => {
  it('returns ready only for cached clean idle from the expected native root', () => {
    expect(evaluateNativeIdleReadiness(snapshot({
      cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 },
    }), expectation)).toBe('ready');
  });

  it.each([
    { label: 'missing clean idle', cleanIdle: null },
    { label: 'child clean idle', cleanIdle: { nativeSessionId: 'child-1', occurredAt: 10 } },
  ])('keeps waiting for $label', ({ cleanIdle }) => {
    expect(evaluateNativeIdleReadiness(snapshot({ cleanIdle }), expectation)).toBe('waiting');
  });

  it('classifies missing evidence and session-generation mismatch as session exit', () => {
    expect(evaluateNativeIdleReadiness(null, expectation)).toBe('session-exit');
    expect(evaluateNativeIdleReadiness(snapshot({ sessionGeneration: 8 }), expectation)).toBe('session-exit');
  });

  it('gives input-generation mismatch precedence over a latched error and clean idle', () => {
    expect(evaluateNativeIdleReadiness(snapshot({
      inputGeneration: 4,
      errorLatched: true,
      cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 },
    }), expectation)).toBe('user-input');
  });

  it('gives a latched error precedence over matching clean idle', () => {
    expect(evaluateNativeIdleReadiness(snapshot({
      errorLatched: true,
      cleanIdle: { nativeSessionId: 'root-1', occurredAt: 10 },
    }), expectation)).toBe('turn-error');
  });
});
