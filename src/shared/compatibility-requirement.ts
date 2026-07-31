export interface CompatibilityRequirement {
  readonly requirementId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly acknowledgementId: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string;
}

export type CompatibilityResolveResult =
  | { readonly kind: 'resolved' }
  | { readonly kind: 'retry-failed' }
  | { readonly kind: 'not-found' };
