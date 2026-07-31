import type { CompatibilityRequirement } from './compatibility-requirement';

export type AutoCommandSkipReason =
  | 'no-active-main-session'
  | 'native-evidence-unavailable'
  | 'resume-not-supported'
  | 'fresh-not-supported'
  | 'handoff-not-supported'
  | 'restart-required'
  | 'isolated-session';

export type AutoCommandWarningReason =
  | AutoCommandSkipReason
  | 'delivery-error';

export interface AutoCommandWarning {
  readonly projectId: string;
  readonly taskId: string;
  readonly reason: AutoCommandWarningReason;
  readonly message: string;
  readonly at: string;
}

export type AutoCommandImmediateOutcome =
  | { readonly kind: 'scheduled'; readonly transport: 'native-idle'; readonly generation: number }
  | { readonly kind: 'scheduled'; readonly transport: 'legacy' }
  | { readonly kind: 'skipped'; readonly reason: AutoCommandSkipReason; readonly warning: string }
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'compatibility-required'; readonly requirement: CompatibilityRequirement };

export interface TaskMoveResult {
  readonly ok: true;
  readonly autoCommand: AutoCommandImmediateOutcome;
}
