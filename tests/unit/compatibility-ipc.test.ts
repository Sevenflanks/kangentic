import { describe, expect, it, vi } from 'vitest';
import type { CompatibilityRequirement } from '../../src/shared/compatibility-requirement';

const handlers = new Map<string, (...args: readonly unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: readonly unknown[]) => unknown) => handlers.set(channel, handler)) },
}));

import { IPC } from '../../src/shared/ipc-channels';
import { registerCompatibilityHandlers } from '../../src/main/ipc/handlers/compatibility';

const requirement: CompatibilityRequirement = {
  requirementId: 'compatibility:project-a:task-a:runtime-default-v1',
  projectId: 'project-a',
  taskId: 'task-a',
  acknowledgementId: 'runtime-default-v1',
  title: 'Runtime default',
  description: 'Compatibility acknowledgement.',
};

describe('compatibility IPC resolve', () => {
  it('persists the explicit project acknowledgement before retrying', async () => {
    // Given
    const events: string[] = [];
    const context = {
      compatibilityRequirements: {
        list: vi.fn(),
        get: vi.fn(() => requirement),
        resolve: vi.fn(async () => {
          events.push('retry');
          return { kind: 'resolved' } as const;
        }),
      },
      projectRepo: { getById: vi.fn((projectId: string) => projectId === 'project-a' ? { path: '/project-a' } : null) },
      configManager: { acknowledgeProjectCompatibility: vi.fn(() => events.push('persist')) },
    };
    registerCompatibilityHandlers(context as never);
    const handler = handlers.get(IPC.COMPATIBILITY_RESOLVE);

    // When
    const result = await (handler as (event: unknown, projectId: string, requirementId: string) => Promise<unknown>)(
      {}, 'project-a', requirement.requirementId,
    );

    // Then
    expect(result).toEqual({ kind: 'resolved' });
    expect(context.configManager.acknowledgeProjectCompatibility).toHaveBeenCalledWith('/project-a', 'runtime-default-v1');
    expect(events).toEqual(['persist', 'retry']);
  });

  it('rejects a wrong project without persistence or retry', async () => {
    // Given
    const acknowledge = vi.fn();
    const resolve = vi.fn();
    const context = {
      compatibilityRequirements: { list: vi.fn(), get: vi.fn(() => null), resolve },
      projectRepo: { getById: vi.fn(() => null) },
      configManager: { acknowledgeProjectCompatibility: acknowledge },
    };
    registerCompatibilityHandlers(context as never);
    const handler = handlers.get(IPC.COMPATIBILITY_RESOLVE);

    // When
    const result = await (handler as (event: unknown, projectId: string, requirementId: string) => Promise<unknown>)(
      {}, 'project-b', requirement.requirementId,
    );

    // Then
    expect(result).toEqual({ kind: 'not-found' });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps a requirement retryable when acknowledgement persistence fails', async () => {
    // Given
    const events: string[] = [];
    let requirementVisible = true;
    const resolve = vi.fn(async () => {
      requirementVisible = false;
      events.push('retry');
      return { kind: 'resolved' } as const;
    });
    const acknowledge = vi.fn()
      .mockImplementationOnce(() => { throw new Error('persistence failed'); })
      .mockImplementationOnce(() => events.push('persist'));
    const context = {
      compatibilityRequirements: {
        list: vi.fn(),
        get: vi.fn(() => requirementVisible ? requirement : null),
        resolve,
      },
      projectRepo: { getById: vi.fn(() => ({ path: '/project-a' })) },
      configManager: { acknowledgeProjectCompatibility: acknowledge },
    };
    registerCompatibilityHandlers(context as never);
    const handler = handlers.get(IPC.COMPATIBILITY_RESOLVE);
    const invoke = () => (handler as (event: unknown, projectId: string, requirementId: string) => Promise<unknown>)(
      {}, 'project-a', requirement.requirementId,
    );

    // When
    await expect(invoke()).rejects.toThrow('persistence failed');
    const retryResult = await invoke();

    // Then
    expect(retryResult).toEqual({ kind: 'resolved' });
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['persist', 'retry']);
  });
});
