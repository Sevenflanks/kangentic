import { describe, expect, it } from 'vitest';
import type { LiveSubmissionPolicy } from '../../src/main/agent/agent-adapter';
import {
  prepareLiveSubmission,
  type LiveSubmissionEligibilityInput,
} from '../../src/main/transition-engine/live-submission-eligibility';

const WAIT_POLICY = {
  mode: 'wait-for-native-idle',
  timeoutMs: 120_000,
  cancelOnUserInput: true,
  sendCtrlC: false,
} satisfies LiveSubmissionPolicy;

const INTERRUPT_POLICY = {
  mode: 'interrupt-immediately',
  sendCtrlC: true,
} satisfies LiveSubmissionPolicy;

function eligibleInput(
  overrides: Partial<LiveSubmissionEligibilityInput> = {},
): LiveSubmissionEligibilityInput {
  return {
    destinationLaneId: 'lane-91',
    autoSpawn: true,
    interpolatedLaneCommand: '/go',
    resolvedAgent: 'opencode',
    currentAgent: 'opencode',
    currentTrack: null,
    destinationTrack: null,
    forceFresh: false,
    restartNeededForModel: false,
    restartNeededForEffort: false,
    policy: WAIT_POLICY,
    sequence: ['/go'],
    ...overrides,
  };
}

describe('prepareLiveSubmission', () => {
  it('prepares an arbitrary eligible destination lane independent of visual metadata', () => {
    const finalizeLane = {
      id: 'lane-91',
      name: 'Finalize',
      position: 7,
      color: '#123456',
      icon: 'check',
    };

    const beforeVisualEdit = prepareLiveSubmission(eligibleInput({
      destinationLaneId: finalizeLane.id,
    }));
    const afterVisualEdit = prepareLiveSubmission(eligibleInput({
      destinationLaneId: {
        ...finalizeLane,
        name: 'Release',
        position: 2,
        color: '#abcdef',
        icon: 'rocket',
      }.id,
    }));

    expect(beforeVisualEdit).not.toBeNull();
    expect(afterVisualEdit).toEqual(beforeVisualEdit);
  });

  it.each([
    ['auto spawn is disabled', { autoSpawn: false }],
    ['lane command is empty', { interpolatedLaneCommand: '   ' }],
    ['session track changes', { destinationTrack: 'lane-isolated' }],
    ['a fresh session is required', { forceFresh: true }],
    ['effective agent changes', { resolvedAgent: 'claude' }],
    ['model requires restart', { restartNeededForModel: true }],
    ['effort requires restart', { restartNeededForEffort: true }],
    ['policy interrupts immediately', { policy: INTERRUPT_POLICY }],
  ] satisfies ReadonlyArray<readonly [string, Partial<LiveSubmissionEligibilityInput>]>) (
    'returns null when %s',
    (_label, overrides) => {
      expect(prepareLiveSubmission(eligibleInput(overrides))).toBeNull();
    },
  );

  it('returns the approved native-idle policy', () => {
    expect(prepareLiveSubmission(eligibleInput())?.policy).toBe(WAIT_POLICY);
  });

  it('produces a stable deterministic fingerprint for identical configuration', () => {
    const first = prepareLiveSubmission(eligibleInput());
    const second = prepareLiveSubmission(eligibleInput());

    expect(first?.fingerprint).toBe(second?.fingerprint);
  });

  it.each([
    ['lane', { destinationLaneId: 'lane-92' }],
    ['command', { interpolatedLaneCommand: '/finish', sequence: ['/finish'] }],
    ['agent', { resolvedAgent: 'claude', currentAgent: 'claude' }],
    ['track', { currentTrack: 'lane-91', destinationTrack: 'lane-91' }],
    ['sequence', { sequence: ['/effort high', '/go'] }],
  ] satisfies ReadonlyArray<readonly [string, Partial<LiveSubmissionEligibilityInput>]>) (
    'changes the private fingerprint when %s configuration changes',
    (_label, overrides) => {
      const original = prepareLiveSubmission(eligibleInput());
      const changed = prepareLiveSubmission(eligibleInput(overrides));

      expect(changed).not.toBeNull();
      expect(changed?.fingerprint).not.toBe(original?.fingerprint);
    },
  );
});
