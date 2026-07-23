import type { LiveSubmissionPolicy } from '../agent/agent-adapter';
import type { NativeIdleSnapshot } from '../activity-engine/native-idle-evidence';

export type LiveDeliveryCancellationReason =
  | 'user-input'
  | 'timeout'
  | 'session-exit'
  | 'turn-error'
  | 'delivery-error'
  | 'superseded'
  | 'shutdown';

export interface NativeIdleExpectation {
  readonly nativeSessionId: string;
  readonly sessionGeneration: number;
  readonly inputGeneration: number;
}

export type NativeIdleReadiness =
  | 'waiting'
  | 'ready'
  | 'user-input'
  | 'turn-error'
  | 'session-exit'
  | 'superseded';

export function evaluateNativeIdleReadiness(
  snapshot: NativeIdleSnapshot | null,
  expectation: NativeIdleExpectation,
): NativeIdleReadiness {
  if (snapshot === null) return 'session-exit';
  if (snapshot.sessionGeneration !== expectation.sessionGeneration) return 'session-exit';
  if (snapshot.inputGeneration !== expectation.inputGeneration) return 'user-input';
  if (snapshot.errorLatched) return 'turn-error';
  if (snapshot.cleanIdle?.nativeSessionId !== expectation.nativeSessionId) return 'waiting';
  return 'ready';
}

export interface NativeIdleRequest extends NativeIdleExpectation {
  readonly taskId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly command: string;
  readonly policy: Extract<LiveSubmissionPolicy, { mode: 'wait-for-native-idle' }>;
  readonly validateCurrent: () => 'valid' | 'superseded' | 'session-exit';
}
