import type {
  AutoCommandImmediateOutcome,
  AutoCommandSkipReason,
} from '../../shared/auto-command-outcome';
import type { LiveDeliveryRegistration } from '../transition-engine/terminal-submit-scheduler';
import type { AgentAdapter, LiveSubmissionPolicy } from './agent-adapter';

export type AutoCommandLifecycle =
  | { readonly kind: 'active-live' }
  | { readonly kind: 'fresh' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'handoff' }
  | { readonly kind: 'restart' };

export interface AutoCommandDispositionInput {
  readonly hasCommand: boolean;
  readonly destinationAutoSpawn: boolean;
  readonly lifecycle: AutoCommandLifecycle;
  readonly currentSessionRunning: boolean;
  readonly currentSessionWritable: boolean;
  readonly currentAgent: string | null;
  readonly destinationAgent: string;
  readonly currentTrack: string | null;
  readonly destinationTrack: string | null;
  readonly liveSubmissionPolicy: LiveSubmissionPolicy | undefined;
  readonly rootNativeSessionId: string | null;
  readonly sessionGeneration: number | null;
  readonly inputGeneration: number | null;
  readonly destinationLaneId: string;
  readonly sequence: readonly string[];
}

export type AutoCommandDisposition =
  | {
      readonly kind: 'deliver-live';
      readonly policy: Extract<LiveSubmissionPolicy, { mode: 'wait-for-native-idle' }>;
      readonly fingerprint: string;
    }
  | { readonly kind: 'skip'; readonly reason: AutoCommandSkipReason; readonly warning: string }
  | { readonly kind: 'not-applicable' };

export interface AutoCommandGateResult {
  readonly disposition: AutoCommandDisposition | null;
  readonly immediateOutcome: AutoCommandImmediateOutcome;
  readonly liveRegistration: LiveDeliveryRegistration | null;
}

export type AutoCommandGateFinalization =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'native-idle';
      readonly disposition: Extract<AutoCommandDisposition, { readonly kind: 'deliver-live' }>;
      readonly registration: LiveDeliveryRegistration;
    }
  | {
      readonly kind: 'not-dispatched';
      readonly disposition: AutoCommandDisposition | null;
    };

export function finalizeAutoCommandGate(
  finalization: AutoCommandGateFinalization,
): AutoCommandGateResult | undefined {
  switch (finalization.kind) {
    case 'legacy':
      return {
        disposition: null,
        immediateOutcome: { kind: 'scheduled', transport: 'legacy' },
        liveRegistration: null,
      };
    case 'native-idle':
      return {
        disposition: finalization.disposition,
        immediateOutcome: {
          kind: 'scheduled',
          transport: 'native-idle',
          generation: finalization.registration.generation,
        },
        liveRegistration: finalization.registration,
      };
    case 'not-dispatched': {
      const { disposition } = finalization;
      if (disposition === null) {
        return {
          disposition,
          immediateOutcome: { kind: 'not-applicable' },
          liveRegistration: null,
        };
      }

      switch (disposition.kind) {
        case 'skip':
          return {
            disposition,
            immediateOutcome: {
              kind: 'skipped',
              reason: disposition.reason,
              warning: disposition.warning,
            },
            liveRegistration: null,
          };
        case 'not-applicable':
          return {
            disposition,
            immediateOutcome: { kind: 'not-applicable' },
            liveRegistration: null,
          };
        case 'deliver-live':
          return undefined;
        default: {
          const exhaustiveDisposition: never = disposition;
          return exhaustiveDisposition;
        }
      }
    }
    default: {
      const exhaustiveFinalization: never = finalization;
      return exhaustiveFinalization;
    }
  }
}

export function evaluateAutoCommandDisposition(
  adapter: AgentAdapter | undefined,
  input: AutoCommandDispositionInput,
): AutoCommandDisposition | null {
  return adapter?.getAutoCommandDisposition?.(input) ?? null;
}
