import type { LiveSubmissionPolicy } from '../agent/agent-adapter';

export interface PreparedLiveSubmission {
  readonly policy: Extract<LiveSubmissionPolicy, { mode: 'wait-for-native-idle' }>;
  readonly fingerprint: string;
}

export interface LiveSubmissionEligibilityInput {
  readonly destinationLaneId: string;
  readonly autoSpawn: boolean;
  readonly interpolatedLaneCommand: string;
  readonly resolvedAgent: string;
  readonly currentAgent: string;
  readonly currentTrack: string | null;
  readonly destinationTrack: string | null;
  readonly forceFresh: boolean;
  readonly restartNeededForModel: boolean;
  readonly restartNeededForEffort: boolean;
  readonly policy: LiveSubmissionPolicy;
  readonly sequence: readonly string[];
}

function privateConfigurationFingerprint(input: LiveSubmissionEligibilityInput): string {
  return JSON.stringify([
    input.destinationLaneId,
    input.autoSpawn,
    input.interpolatedLaneCommand,
    input.resolvedAgent,
    input.currentAgent,
    input.currentTrack,
    input.destinationTrack,
    input.forceFresh,
    input.restartNeededForModel,
    input.restartNeededForEffort,
    input.policy.mode,
    input.sequence,
  ]);
}

export function prepareLiveSubmission(
  input: LiveSubmissionEligibilityInput,
): PreparedLiveSubmission | null {
  if (!input.autoSpawn
    || input.interpolatedLaneCommand.trim() === ''
    || input.currentTrack !== input.destinationTrack
    || input.forceFresh
    || input.resolvedAgent !== input.currentAgent
    || input.restartNeededForModel
    || input.restartNeededForEffort
    || input.policy.mode !== 'wait-for-native-idle') {
    return null;
  }

  return {
    policy: input.policy,
    fingerprint: privateConfigurationFingerprint(input),
  };
}
