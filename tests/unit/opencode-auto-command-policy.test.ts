import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeAutoCommandWarning,
  getOpenCodeAutoCommandDisposition,
} from '../../src/main/agent/adapters/opencode/auto-command-policy';
import type {
  AutoCommandDisposition,
  AutoCommandDispositionInput,
} from '../../src/main/agent/auto-command-disposition';
import type { LiveSubmissionPolicy } from '../../src/main/agent/agent-adapter';
import type { AutoCommandSkipReason } from '../../src/shared/auto-command-outcome';

const WAIT_FOR_NATIVE_IDLE_POLICY = {
  mode: 'wait-for-native-idle',
  timeoutMs: 120_000,
  cancelOnUserInput: true,
  sendCtrlC: false,
} as const satisfies LiveSubmissionPolicy;

const INTERRUPT_IMMEDIATELY_POLICY = {
  mode: 'interrupt-immediately',
  sendCtrlC: true,
} as const satisfies LiveSubmissionPolicy;

const LIFECYCLE_SESSION_EVIDENCE_FAILURE = {
  lifecycle: { kind: 'fresh' },
  currentSessionRunning: false,
  rootNativeSessionId: null,
} as const satisfies Partial<AutoCommandDispositionInput>;

function makeDeliverableInput(
  overrides: Partial<AutoCommandDispositionInput> = {},
): AutoCommandDispositionInput {
  return {
    hasCommand: true,
    destinationAutoSpawn: true,
    lifecycle: { kind: 'active-live' },
    currentSessionRunning: true,
    currentSessionWritable: true,
    currentAgent: 'opencode',
    destinationAgent: 'opencode',
    currentTrack: null,
    destinationTrack: null,
    liveSubmissionPolicy: WAIT_FOR_NATIVE_IDLE_POLICY,
    rootNativeSessionId: 'ses_root_123',
    sessionGeneration: 4,
    inputGeneration: 9,
    destinationLaneId: 'lane-build',
    sequence: ['review the current change'],
    ...overrides,
  };
}

function expectSkip(
  disposition: AutoCommandDisposition,
  reason: AutoCommandSkipReason,
): void {
  expect(disposition).toEqual({
    kind: 'skip',
    reason,
    warning: buildOpenCodeAutoCommandWarning(reason),
  });
}

function makeWrongWaitPolicy(
  property: 'timeoutMs' | 'cancelOnUserInput' | 'sendCtrlC',
  value: number | boolean,
): LiveSubmissionPolicy {
  const policy = { ...WAIT_FOR_NATIVE_IDLE_POLICY };
  Reflect.set(policy, property, value);
  return policy;
}

function getLiveFingerprint(input: AutoCommandDispositionInput): string {
  const disposition = getOpenCodeAutoCommandDisposition(input);
  if (disposition.kind !== 'deliver-live') {
    throw new Error('Expected a deliver-live disposition');
  }
  return disposition.fingerprint;
}

describe('OpenCode auto-command disposition policy', () => {
  it.each([
    ['the command is empty', { hasCommand: false }],
    ['Auto-spawn is disabled', { destinationAutoSpawn: false }],
  ] as const)('returns not-applicable when %s', (_caseName, overrides) => {
    // Given
    const input = makeDeliverableInput(overrides);

    // When
    const disposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    expect(disposition).toEqual({ kind: 'not-applicable' });
  });

  it.each([
    [
      'the current track is isolated',
      { currentTrack: 'lane-isolated', lifecycle: { kind: 'handoff' } },
      'isolated-session',
    ],
    [
      'the destination track is isolated',
      { destinationTrack: 'lane-isolated', lifecycle: { kind: 'restart' } },
      'isolated-session',
    ],
    ['the lifecycle is handoff', { lifecycle: { kind: 'handoff' } }, 'handoff-not-supported'],
    ['the lifecycle is restart', { lifecycle: { kind: 'restart' } }, 'restart-required'],
    ['the lifecycle is fresh', { lifecycle: { kind: 'fresh' } }, 'fresh-not-supported'],
    ['the lifecycle is resume', { lifecycle: { kind: 'resume' } }, 'resume-not-supported'],
  ] as const)('applies lifecycle priority when %s', (_caseName, overrides, reason) => {
    // Given
    const input = makeDeliverableInput({
      ...overrides,
      currentSessionRunning: false,
      rootNativeSessionId: null,
    });

    // When
    const disposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    expectSkip(disposition, reason);
  });

  it.each([
    ['there is no running session', { currentSessionRunning: false }],
    ['the session is not writable', { currentSessionWritable: false }],
    ['the active session has no current agent', { currentAgent: null }],
  ] as const)('skips with no-active-main-session when %s', (_caseName, overrides) => {
    // Given
    const input = makeDeliverableInput(overrides);

    // When
    const disposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    expectSkip(disposition, 'no-active-main-session');
  });

  it.each([
    [
      'not-applicable over isolated, lifecycle, and session failures',
      makeDeliverableInput({ ...LIFECYCLE_SESSION_EVIDENCE_FAILURE, hasCommand: false, currentTrack: 'lane-isolated' }),
      'not-applicable',
    ],
    [
      'isolated over lifecycle, session, and evidence failures',
      makeDeliverableInput({ ...LIFECYCLE_SESSION_EVIDENCE_FAILURE, destinationTrack: 'lane-isolated' }),
      'isolated-session',
    ],
    [
      'a lifecycle exclusion over session and evidence failures',
      makeDeliverableInput(LIFECYCLE_SESSION_EVIDENCE_FAILURE),
      'fresh-not-supported',
    ],
    ['no active session over an agent mismatch', makeDeliverableInput({ currentSessionRunning: false, currentAgent: 'claude' }), 'no-active-main-session'],
    ['an agent mismatch over missing evidence', makeDeliverableInput({ currentAgent: 'claude', rootNativeSessionId: null }), 'restart-required'],
    ['missing evidence over a policy mismatch', makeDeliverableInput({ rootNativeSessionId: null, liveSubmissionPolicy: INTERRUPT_IMMEDIATELY_POLICY }), 'native-evidence-unavailable'],
  ] as const)('prioritizes %s', (_description, input, expected) => {
    // Given
    // When
    const disposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    if (expected === 'not-applicable') {
      expect(disposition).toEqual({ kind: 'not-applicable' });
      return;
    }
    expectSkip(disposition, expected);
  });

  it.each([
    ['the current agent differs', { currentAgent: 'claude' }],
    ['the destination agent is not OpenCode', { destinationAgent: 'claude' }],
  ] as const)('requires a same OpenCode agent when %s', (_caseName, overrides) => {
    // Given
    const input = makeDeliverableInput(overrides);

    // When
    const disposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    expectSkip(disposition, 'restart-required');
  });

  it.each([
    ['the root native session ID is unavailable', { rootNativeSessionId: null }],
    ['the session generation is unavailable', { sessionGeneration: null }],
    ['the input generation is unavailable', { inputGeneration: null }],
  ] as const)('requires native evidence when %s', (_caseName, overrides) => {
    // Given
    const input = makeDeliverableInput(overrides);

    // When
    const disposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    expectSkip(disposition, 'native-evidence-unavailable');
  });

  it.each([
    ['there is no live policy', undefined],
    ['the policy interrupts immediately', INTERRUPT_IMMEDIATELY_POLICY],
    ['the wait timeout is not exact', makeWrongWaitPolicy('timeoutMs', 1)],
    ['the policy does not cancel on user input', makeWrongWaitPolicy('cancelOnUserInput', false)],
    ['the policy sends Ctrl+C', makeWrongWaitPolicy('sendCtrlC', true)],
  ] as const)('rejects live delivery when %s', (_caseName, liveSubmissionPolicy) => {
    // Given
    const input = makeDeliverableInput({ liveSubmissionPolicy });

    // When
    const disposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    expectSkip(disposition, 'no-active-main-session');
  });

  it('returns a deterministic native-idle delivery disposition for canonical Main tracks', () => {
    // Given
    const input = makeDeliverableInput();

    // When
    const firstFingerprint = getLiveFingerprint(input);
    const secondFingerprint = getLiveFingerprint(input);

    // Then
    expect(firstFingerprint).toBe(secondFingerprint);
  });

  it.each([
    ['removing the command', makeDeliverableInput({ hasCommand: false }), 'stops-live'],
    ['disabling Auto-spawn', makeDeliverableInput({ destinationAutoSpawn: false }), 'stops-live'],
    ['changing lifecycle', makeDeliverableInput({ lifecycle: { kind: 'fresh' } }), 'stops-live'],
    ['changing the current agent', makeDeliverableInput({ currentAgent: 'claude' }), 'stops-live'],
    ['changing the destination agent', makeDeliverableInput({ destinationAgent: 'claude' }), 'stops-live'],
    ['isolating the current track', makeDeliverableInput({ currentTrack: 'lane-isolated' }), 'stops-live'],
    ['isolating the destination track', makeDeliverableInput({ destinationTrack: 'lane-isolated' }), 'stops-live'],
    ['removing the live policy', makeDeliverableInput({ liveSubmissionPolicy: undefined }), 'stops-live'],
    ['interrupting the live policy', makeDeliverableInput({ liveSubmissionPolicy: INTERRUPT_IMMEDIATELY_POLICY }), 'stops-live'],
    ['changing the wait timeout', makeDeliverableInput({ liveSubmissionPolicy: makeWrongWaitPolicy('timeoutMs', 1) }), 'stops-live'],
    ['disabling user-input cancellation', makeDeliverableInput({ liveSubmissionPolicy: makeWrongWaitPolicy('cancelOnUserInput', false) }), 'stops-live'],
    ['enabling Ctrl+C', makeDeliverableInput({ liveSubmissionPolicy: makeWrongWaitPolicy('sendCtrlC', true) }), 'stops-live'],
    ['changing the destination lane', makeDeliverableInput({ destinationLaneId: 'lane-review' }), 'changes-fingerprint'],
    ['changing the sequence', makeDeliverableInput({ sequence: ['run focused tests'] }), 'changes-fingerprint'],
  ] as const)('protects stale-plan authorization when %s', (_description, changedInput, expected) => {
    // Given
    const baselineFingerprint = getLiveFingerprint(makeDeliverableInput());

    // When
    const disposition = getOpenCodeAutoCommandDisposition(changedInput);

    // Then
    if (expected === 'stops-live') {
      expect(disposition.kind).not.toBe('deliver-live');
      return;
    }
    expect(disposition.kind).toBe('deliver-live');
    if (disposition.kind === 'deliver-live') {
      expect(disposition.fingerprint).not.toBe(baselineFingerprint);
    }
  });

  it.each([
    'no-active-main-session',
    'native-evidence-unavailable',
    'resume-not-supported',
    'fresh-not-supported',
    'handoff-not-supported',
    'restart-required',
    'isolated-session',
  ] as const)('creates a stable warning for %s', (reason) => {
    // Given
    // When
    const warning = buildOpenCodeAutoCommandWarning(reason);

    // Then
    expect(warning).toEqual(expect.any(String));
    expect(warning.length).toBeGreaterThan(0);
  });

  it('does not interpolate private policy input into a warning', () => {
    // Given
    const privateLaneId = 'lane-private-7f3c';
    const privateSequenceEntry = 'command-private-d4a1';
    const input = makeDeliverableInput({
      destinationLaneId: privateLaneId,
      sequence: [privateSequenceEntry],
      rootNativeSessionId: null,
    });

    // When
    const disposition: AutoCommandDisposition = getOpenCodeAutoCommandDisposition(input);

    // Then
    expect(disposition).toEqual({
      kind: 'skip',
      reason: 'native-evidence-unavailable',
      warning: buildOpenCodeAutoCommandWarning('native-evidence-unavailable'),
    });
    if (disposition.kind === 'skip') {
      expect(disposition.warning).not.toContain(privateLaneId);
      expect(disposition.warning).not.toContain(privateSequenceEntry);
    }
  });
});
