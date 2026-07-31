import type { StateCreator } from 'zustand';
import type {
  CompatibilityRequirement,
  CompatibilityResolveResult,
} from '../../../shared/compatibility-requirement';
import { useProjectStore } from '../project-store';
import type { SessionStore } from './types';

function indexRequirements(
  requirements: readonly CompatibilityRequirement[],
  projectId: string,
): Record<string, CompatibilityRequirement> {
  return Object.fromEntries(
    requirements
      .filter((requirement) => requirement.projectId === projectId)
      .map((requirement) => [requirement.taskId, requirement]),
  );
}

export interface SpawnCompatibilitySlice {
  compatibilityRequirementsByTaskId: Record<string, CompatibilityRequirement>;
  syncCompatibilityRequirements: () => Promise<boolean>;
  resolveCompatibilityRequirement: (
    requirement: CompatibilityRequirement,
  ) => Promise<CompatibilityResolveResult>;
  clearCompatibilityRequirements: () => void;
}

export const createSpawnCompatibilitySlice: StateCreator<
  SessionStore,
  [],
  [],
  SpawnCompatibilitySlice
> = (set, get) => ({
  compatibilityRequirementsByTaskId: {},

  syncCompatibilityRequirements: async () => {
    const projectId = useProjectStore.getState().currentProject?.id;
    if (!projectId) {
      set({ compatibilityRequirementsByTaskId: {} });
      return false;
    }

    const compatibility = window.electronAPI.compatibility;
    if (!compatibility?.list) return false;
    let requirements: readonly CompatibilityRequirement[];
    try {
      requirements = await compatibility.list(projectId);
    } catch (error) {
      console.warn('[syncCompatibilityRequirements] list failed (likely HMR / preload skew):', error);
      return false;
    }
    if (useProjectStore.getState().currentProject?.id !== projectId) return false;

    set({ compatibilityRequirementsByTaskId: indexRequirements(requirements, projectId) });
    return true;
  },

  resolveCompatibilityRequirement: async (requirement) => {
    const result = await window.electronAPI.compatibility.resolve(
      requirement.projectId,
      requirement.requirementId,
    );
    switch (result.kind) {
      case 'resolved':
      case 'not-found':
        if (useProjectStore.getState().currentProject?.id === requirement.projectId) {
          await get().syncCompatibilityRequirements();
        }
        return result;
      case 'retry-failed':
        return result;
    }
  },

  clearCompatibilityRequirements: () => set({ compatibilityRequirementsByTaskId: {} }),
});
