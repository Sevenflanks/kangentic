import type {
  CompatibilityRequirement,
  CompatibilityResolveResult,
} from '../../shared/compatibility-requirement';

export type CompatibilityRetryResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'failed' };

type CompatibilityRequirementEntry = {
  readonly requirement: CompatibilityRequirement;
  readonly retry: () => Promise<CompatibilityRetryResult>;
};

export class CompatibilityRequirementCoordinator {
  private readonly entries = new Map<string, CompatibilityRequirementEntry>();
  private readonly inFlightResolutions = new Map<string, Promise<CompatibilityResolveResult>>();

  constructor(private readonly options: { readonly onChanged: (projectId: string) => void }) {}

  list(projectId: string): readonly CompatibilityRequirement[] {
    return [...this.entries.values()]
      .map((entry) => entry.requirement)
      .filter((requirement) => requirement.projectId === projectId);
  }

  get(projectId: string, requirementId: string): CompatibilityRequirement | null {
    const requirement = this.entries.get(requirementId)?.requirement;
    return requirement?.projectId === projectId ? requirement : null;
  }

  replace(entry: CompatibilityRequirementEntry): void {
    this.entries.set(entry.requirement.requirementId, entry);
    this.options.onChanged(entry.requirement.projectId);
  }

  clear(projectId: string, requirementId: string): void {
    const requirement = this.get(projectId, requirementId);
    if (requirement === null) return;
    this.entries.delete(requirementId);
    this.options.onChanged(projectId);
  }

  clearTask(projectId: string, taskId: string): (() => void) | null {
    const removedEntries = [...this.entries.entries()].filter(([, entry]) => (
      entry.requirement.projectId === projectId && entry.requirement.taskId === taskId
    ));
    if (removedEntries.length === 0) return null;
    for (const [requirementId] of removedEntries) this.entries.delete(requirementId);
    this.options.onChanged(projectId);

    let restored = false;
    return () => {
      if (restored) return;
      restored = true;

      let didRestore = false;
      for (const [requirementId, entry] of removedEntries) {
        if (!this.entries.has(requirementId)) {
          this.entries.set(requirementId, {
            requirement: entry.requirement,
            retry: entry.retry,
          });
          didRestore = true;
        }
      }
      if (didRestore) this.options.onChanged(projectId);
    };
  }

  resolve(projectId: string, requirementId: string): Promise<CompatibilityResolveResult> {
    const entry = this.entries.get(requirementId);
    if (!entry || entry.requirement.projectId !== projectId) return Promise.resolve({ kind: 'not-found' });

    const existingResolution = this.inFlightResolutions.get(requirementId);
    if (existingResolution) return existingResolution;

    const inFlightResolution = (async (): Promise<CompatibilityResolveResult> => {
      try {
        const retry = await entry.retry();
        switch (retry.kind) {
          case 'completed':
          case 'superseded':
            if (this.entries.get(requirementId) === entry) {
              this.entries.delete(requirementId);
              this.options.onChanged(projectId);
            }
            return { kind: 'resolved' };
          case 'failed':
            return { kind: 'retry-failed' };
          default: {
            const exhaustiveRetry: never = retry;
            return exhaustiveRetry;
          }
        }
      } catch {
        // Retry work crosses lifecycle boundaries; keep the requirement visible so acknowledgement can be retried.
        return { kind: 'retry-failed' };
      }
    })().finally(() => {
      // 僅移除本次 resolve 登錄的 Promise，避免晚到的 finally 清掉後續 retry。
      if (this.inFlightResolutions.get(requirementId) === inFlightResolution) {
        this.inFlightResolutions.delete(requirementId);
      }
    });
    this.inFlightResolutions.set(requirementId, inFlightResolution);
    return inFlightResolution;
  }
}
