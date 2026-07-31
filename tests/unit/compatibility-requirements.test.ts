import { describe, expect, it, vi } from 'vitest';
import {
  CompatibilityRequirementCoordinator,
  type CompatibilityRetryResult,
} from '../../src/main/compatibility/compatibility-requirement-coordinator';
import type { CompatibilityRequirement } from '../../src/shared/compatibility-requirement';

const requirement: CompatibilityRequirement = {
  requirementId: 'compatibility:project-1:task-1:runtime-default-v1',
  projectId: 'project-1',
  taskId: 'task-1',
  acknowledgementId: 'runtime-default-v1',
  title: 'Runtime default required',
  description: 'Acknowledge the runtime default before continuing.',
};

describe('CompatibilityRequirementCoordinator', () => {
  it('lists only the selected project and replaces a task acknowledgement deterministically', () => {
    // Given
    const changed = vi.fn();
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: changed });

    // When
    coordinator.replace({
      requirement,
      retry: async (): Promise<CompatibilityRetryResult> => ({ kind: 'completed' }),
    });
    coordinator.replace({
      requirement: { ...requirement, title: 'Updated runtime default required' },
      retry: async (): Promise<CompatibilityRetryResult> => ({ kind: 'completed' }),
    });

    // Then
    expect(coordinator.list('project-1')).toEqual([
      expect.objectContaining({ title: 'Updated runtime default required' }),
    ]);
    expect(coordinator.list('project-2')).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('returns null when no requirements belong to the task being cleared', () => {
    // Given
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    coordinator.replace({
      requirement,
      retry: async (): Promise<CompatibilityRetryResult> => ({ kind: 'completed' }),
    });

    // When
    const restore = coordinator.clearTask('project-1', 'other-task');

    // Then
    expect(restore).toBeNull();
    expect(coordinator.get('project-1', requirement.requirementId)).toEqual(requirement);
  });

  it('restores the cleared entry with its original retry exactly once', async () => {
    // Given
    const retry = vi.fn<() => Promise<CompatibilityRetryResult>>().mockResolvedValue({ kind: 'completed' });
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    coordinator.replace({ requirement, retry });
    const restore: unknown = coordinator.clearTask('project-1', requirement.taskId);

    expect(restore).toEqual(expect.any(Function));
    if (typeof restore !== 'function') return;

    // When
    restore();
    const result = await coordinator.resolve('project-1', requirement.requirementId);
    restore();

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(coordinator.get('project-1', requirement.requirementId)).toBeNull();
  });

  it('does not overwrite a replacement requirement when restoring a cleared task', async () => {
    // Given
    const originalRetry = vi.fn<() => Promise<CompatibilityRetryResult>>().mockResolvedValue({ kind: 'failed' });
    const replacementRetry = vi.fn<() => Promise<CompatibilityRetryResult>>().mockResolvedValue({ kind: 'completed' });
    const replacement = { ...requirement, title: 'Replacement acknowledgement' };
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    coordinator.replace({ requirement, retry: originalRetry });
    const restore: unknown = coordinator.clearTask('project-1', requirement.taskId);
    coordinator.replace({ requirement: replacement, retry: replacementRetry });

    expect(restore).toEqual(expect.any(Function));
    if (typeof restore !== 'function') return;

    // When
    restore();
    const result = await coordinator.resolve('project-1', requirement.requirementId);

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(originalRetry).not.toHaveBeenCalled();
    expect(replacementRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps a restored requirement when its prior single-flight retry completes', async () => {
    // Given
    let completeRetry: ((result: CompatibilityRetryResult) => void) | null = null;
    const retry = vi.fn<() => Promise<CompatibilityRetryResult>>().mockImplementation(
      () => new Promise(resolve => {
        completeRetry = resolve;
      }),
    );
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    coordinator.replace({ requirement, retry });
    const resolution = coordinator.resolve('project-1', requirement.requirementId);
    const restore: unknown = coordinator.clearTask('project-1', requirement.taskId);

    expect(restore).toEqual(expect.any(Function));
    expect(completeRetry).not.toBeNull();
    if (typeof restore !== 'function' || completeRetry === null) return;

    // When
    restore();
    completeRetry({ kind: 'completed' });
    const result = await resolution;

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(coordinator.get('project-1', requirement.requirementId)).toEqual(requirement);
  });

  it('retains a requirement when its retry fails and clears it only after completion', async () => {
    // Given
    const retry = vi.fn<() => Promise<CompatibilityRetryResult>>()
      .mockResolvedValueOnce({ kind: 'failed' })
      .mockResolvedValueOnce({ kind: 'completed' });
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    coordinator.replace({ requirement, retry });

    // When
    const failed = await coordinator.resolve('project-1', requirement.requirementId);
    const completed = await coordinator.resolve('project-1', requirement.requirementId);

    // Then
    expect(failed).toEqual({ kind: 'retry-failed' });
    expect(completed).toEqual({ kind: 'resolved' });
    expect(coordinator.list('project-1')).toEqual([]);
  });

  it('shares concurrent failed retries and permits a later retry', async () => {
    // Given
    const retry = vi.fn<() => Promise<CompatibilityRetryResult>>()
      .mockResolvedValueOnce({ kind: 'failed' })
      .mockResolvedValueOnce({ kind: 'completed' });
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    coordinator.replace({ requirement, retry });

    // When
    const first = coordinator.resolve('project-1', requirement.requirementId);
    const second = coordinator.resolve('project-1', requirement.requirementId);

    // Then
    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'retry-failed' },
      { kind: 'retry-failed' },
    ]);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(coordinator.get('project-1', requirement.requirementId)).toEqual(requirement);

    // When
    const retried = await coordinator.resolve('project-1', requirement.requirementId);

    // Then
    expect(retried).toEqual({ kind: 'resolved' });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(coordinator.list('project-1')).toEqual([]);
  });

  it.each(['completed', 'superseded'] as const)(
    'keeps a replacement entry when a %s retry completes',
    async (retryResult) => {
      // Given
      const replacement = { ...requirement, title: 'Replacement acknowledgement' };
      const replacementRetry = vi.fn<() => Promise<CompatibilityRetryResult>>().mockResolvedValue({ kind: 'failed' });
      const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
      coordinator.replace({
        requirement,
        retry: async (): Promise<CompatibilityRetryResult> => {
          coordinator.replace({ requirement: replacement, retry: replacementRetry });
          return { kind: retryResult };
        },
      });

      // When
      const result = await coordinator.resolve('project-1', requirement.requirementId);

      // Then
      expect(result).toEqual({ kind: 'resolved' });
      expect(coordinator.get('project-1', requirement.requirementId)).toEqual(replacement);
      expect(replacementRetry).not.toHaveBeenCalled();
    },
  );

  it('does not resolve a requirement through another project', async () => {
    // Given
    const retry = vi.fn<() => Promise<CompatibilityRetryResult>>();
    const coordinator = new CompatibilityRequirementCoordinator({ onChanged: vi.fn() });
    coordinator.replace({ requirement, retry });

    // When
    const result = await coordinator.resolve('project-2', requirement.requirementId);

    // Then
    expect(result).toEqual({ kind: 'not-found' });
    expect(retry).not.toHaveBeenCalled();
    expect(coordinator.get('project-1', requirement.requirementId)).toEqual(requirement);
  });
});
