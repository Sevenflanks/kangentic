import type { AutoCommandDisposition } from '../agent/auto-command-disposition';
import type { LiveSubmissionPolicy } from '../agent/agent-adapter';

export interface PreparedLiveSubmission {
  readonly policy: Extract<LiveSubmissionPolicy, { mode: 'wait-for-native-idle' }>;
  readonly fingerprint: string;
}

export function prepareLiveSubmission(
  disposition: AutoCommandDisposition | null,
): PreparedLiveSubmission | null {
  if (disposition === null) return null;

  switch (disposition.kind) {
    case 'deliver-live':
      return {
        policy: disposition.policy,
        fingerprint: disposition.fingerprint,
      };
    case 'not-applicable':
    case 'skip':
      return null;
    default: {
      const exhaustiveDisposition: never = disposition;
      return exhaustiveDisposition;
    }
  }
}
