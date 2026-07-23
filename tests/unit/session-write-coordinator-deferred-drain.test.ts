import { describe, expect, it, vi } from 'vitest';
import { SessionWriteCoordinator } from '../../src/main/pty/session-write-coordinator';
import { createWriteQueue } from '../../src/main/pty/write-queue';

async function createDeferredDrainHarness() {
  const writes: string[] = [];
  const queue = createWriteQueue(() => ({
    write(data: string): void {
      writes.push(data);
    },
  }));
  const coordinator = new SessionWriteCoordinator(() => queue);
  coordinator.initialize('s1');
  const automation = coordinator.acquireAutomation(
    's1',
    { sessionGeneration: 1, inputGeneration: 0 },
    vi.fn(),
  );
  await automation?.write('automation');
  const userSubmission = coordinator.acquireUserSubmission('s1');
  const deferred = 'u'.repeat(5_000);
  coordinator.recordUserInput('s1', deferred, 20);
  const submit = vi.fn(async () => {
    writes.push('submit');
  });
  return { coordinator, automation, userSubmission, deferred, writes, submit };
}

describe('SessionWriteCoordinator deferred input drain', () => {
  it('waits for multi-chunk deferred input to drain when run is pending before automation release', async () => {
    vi.useFakeTimers();
    try {
      // Given
      const { writes, automation, userSubmission, deferred, submit } = await createDeferredDrainHarness();
      const submission = userSubmission?.run(submit);

      // When
      automation?.release();
      await Promise.resolve();
      await Promise.resolve();

      // Then
      expect(writes).toEqual(['automation', deferred.slice(0, 4_096)]);
      expect(submit).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();
      await expect(submission).resolves.toBeUndefined();
      expect(writes.join('')).toBe(`automation${deferred}submit`);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for multi-chunk deferred input to drain when run starts after automation release', async () => {
    vi.useFakeTimers();
    try {
      // Given
      const { writes, automation, userSubmission, deferred, submit } = await createDeferredDrainHarness();
      automation?.release();

      // When
      const submission = userSubmission?.run(submit);
      await Promise.resolve();
      await Promise.resolve();

      // Then
      expect(writes).toEqual(['automation', deferred.slice(0, 4_096)]);
      expect(submit).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();
      await expect(submission).resolves.toBeUndefined();
      expect(writes.join('')).toBe(`automation${deferred}submit`);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invoke a waiting callback released while deferred input drains', async () => {
    vi.useFakeTimers();
    try {
      // Given
      const { automation, userSubmission, submit } = await createDeferredDrainHarness();
      const submission = userSubmission?.run(submit);
      automation?.release();
      const rejection = expect(submission).rejects.toMatchObject({
        name: 'SessionWriteOwnershipError',
        code: 'inactive-user-submission-lease',
      });

      // When
      userSubmission?.release();
      await vi.runAllTimersAsync();

      // Then
      await rejection;
      expect(submit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invoke a waiting callback after session disposal during deferred drain', async () => {
    vi.useFakeTimers();
    try {
      // Given
      const { coordinator, automation, userSubmission, submit } = await createDeferredDrainHarness();
      const submission = userSubmission?.run(submit);
      automation?.release();
      const rejection = expect(submission).rejects.toMatchObject({
        name: 'SessionWriteOwnershipError',
        code: 'inactive-user-submission-lease',
      });

      // When
      coordinator.disposeSession('s1');
      await vi.runAllTimersAsync();

      // Then
      await rejection;
      expect(submit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
