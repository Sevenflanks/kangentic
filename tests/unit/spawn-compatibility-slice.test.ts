import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompatibilityRequirement } from '../../src/shared/compatibility-requirement';

const activeRequirement: CompatibilityRequirement = {
  requirementId: 'requirement-a',
  projectId: 'project-a',
  taskId: 'task-a',
  acknowledgementId: 'opencode-default-permissions',
  title: 'OpenCode needs acknowledgement',
  description: 'Allow the compatible permission mode before starting this task.',
  actionLabel: 'Allow permission mode',
};

let requirements: readonly CompatibilityRequirement[] = [];
let resolveResult = { kind: 'resolved' } as const;
const resolveCalls: Array<{ readonly projectId: string; readonly requirementId: string }> = [];

Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      compatibility: {
        list: vi.fn(async () => requirements),
        resolve: vi.fn(async (projectId: string, requirementId: string) => {
          resolveCalls.push({ projectId, requirementId });
          return resolveResult;
        }),
      },
      config: {
        set: vi.fn(),
        get: async () => ({}),
        getGlobal: async () => ({}),
        getProjectOverrides: async () => null,
      },
      projects: { list: async () => [] },
      sessions: {
        list: async () => [],
        spawn: async () => ({}),
        kill: async () => {},
        reset: async () => {},
        suspend: async () => {},
        resume: async () => ({}),
        reconcile: async () => null,
        getUsage: async () => ({}),
        getActivity: async () => ({}),
        getActivityReasons: async () => ({}),
        getEventsCache: async () => ({}),
        getFirstOutput: async () => ({}),
      },
      tasks: { getSpawnProgress: async () => ({}) },
    },
  },
  configurable: true,
});

import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';

function compatibilityAction(actionName: string): (...args: never[]) => Promise<unknown> {
  const action = Reflect.get(useSessionStore.getState(), actionName);
  if (typeof action !== 'function') throw new Error(`Missing ${actionName} session-store action`);
  return action.bind(useSessionStore.getState()) as (...args: never[]) => Promise<unknown>;
}

function requirementsByTask(): Record<string, CompatibilityRequirement> {
  const requirementsByTaskId = Reflect.get(useSessionStore.getState(), 'compatibilityRequirementsByTaskId');
  if (!requirementsByTaskId || typeof requirementsByTaskId !== 'object') {
    throw new Error('Missing compatibilityRequirementsByTaskId session-store state');
  }
  return requirementsByTaskId as Record<string, CompatibilityRequirement>;
}

describe('spawn compatibility session slice', () => {
  beforeEach(() => {
    requirements = [];
    resolveResult = { kind: 'resolved' };
    resolveCalls.length = 0;
    window.electronAPI.compatibility.list = vi.fn(async () => requirements);
    window.electronAPI.compatibility.resolve = vi.fn(async (projectId: string, requirementId: string) => {
      resolveCalls.push({ projectId, requirementId });
      return resolveResult;
    });
    useProjectStore.setState({ currentProject: { id: 'project-a' } });
    useSessionStore.setState({ compatibilityRequirementsByTaskId: {} });
  });

  it('hydrates only the active project requirements indexed by task', async () => {
    requirements = [activeRequirement, { ...activeRequirement, projectId: 'project-b', taskId: 'task-b' }];

    await compatibilityAction('syncCompatibilityRequirements')();

    expect(requirementsByTask()).toEqual({ 'task-a': activeRequirement });
  });

  it('rehydrates active requirements while sessions synchronize', async () => {
    requirements = [activeRequirement];

    await useSessionStore.getState().syncSessions();

    expect(requirementsByTask()).toEqual({ 'task-a': activeRequirement });
  });

  it('preserves active requirements when an older preload has no compatibility list method', async () => {
    useSessionStore.setState({ compatibilityRequirementsByTaskId: { 'task-a': activeRequirement } });
    Reflect.deleteProperty(window.electronAPI.compatibility, 'list');

    await expect(compatibilityAction('syncCompatibilityRequirements')()).resolves.toBe(false);

    expect(requirementsByTask()).toEqual({ 'task-a': activeRequirement });
  });

  it('lets session synchronization succeed when compatibility list transiently rejects', async () => {
    useSessionStore.setState({ compatibilityRequirementsByTaskId: { 'task-a': activeRequirement } });
    window.electronAPI.compatibility.list = vi.fn(async () => {
      throw new Error('IPC: handler not registered');
    });

    await expect(useSessionStore.getState().syncSessions()).resolves.toBe(true);

    expect(requirementsByTask()).toEqual({ 'task-a': activeRequirement });
  });

  it('does not apply a stale list response after the active project changes', async () => {
    let resolveList: ((value: readonly CompatibilityRequirement[]) => void) | undefined;
    window.electronAPI.compatibility.list = () => new Promise((resolve) => {
      resolveList = resolve;
    });

    const sync = compatibilityAction('syncCompatibilityRequirements')();
    useProjectStore.setState({ currentProject: { id: 'project-b' } });
    resolveList?.([activeRequirement]);

    await sync;

    expect(requirementsByTask()).toEqual({});
  });

  it('uses the captured requirement identity and retains a retryable notice', async () => {
    requirements = [activeRequirement];
    await compatibilityAction('syncCompatibilityRequirements')();
    resolveResult = { kind: 'retry-failed' };
    useProjectStore.setState({ currentProject: { id: 'project-b' } });

    await compatibilityAction('resolveCompatibilityRequirement')(activeRequirement);

    expect(resolveCalls).toEqual([{ projectId: 'project-a', requirementId: 'requirement-a' }]);
    expect(requirementsByTask()).toEqual({ 'task-a': activeRequirement });
  });

  it('reconciles the active project after a successful resolution', async () => {
    requirements = [activeRequirement];
    await compatibilityAction('syncCompatibilityRequirements')();
    requirements = [];

    await compatibilityAction('resolveCompatibilityRequirement')(activeRequirement);

    expect(requirementsByTask()).toEqual({});
  });

  it('reconciles the active project when the acknowledgement no longer exists', async () => {
    requirements = [activeRequirement];
    await compatibilityAction('syncCompatibilityRequirements')();
    resolveResult = { kind: 'not-found' };
    requirements = [];

    await compatibilityAction('resolveCompatibilityRequirement')(activeRequirement);

    expect(requirementsByTask()).toEqual({});
  });
});
