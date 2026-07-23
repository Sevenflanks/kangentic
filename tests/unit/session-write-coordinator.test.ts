import { describe, expect, it, vi } from 'vitest';
import { SessionWriteCoordinator } from '../../src/main/pty/session-write-coordinator';
import { createWriteQueue, type PtyWriteTarget, type WriteQueue } from '../../src/main/pty/write-queue';

function createHarness(): {
  readonly coordinator: SessionWriteCoordinator;
  readonly writes: string[];
} {
  const writes: string[] = [];
  const target: PtyWriteTarget = {
    write(data: string): void {
      writes.push(data);
    },
  };
  const queue: WriteQueue = createWriteQueue(() => target);
  return {
    coordinator: new SessionWriteCoordinator(() => queue),
    writes,
  };
}

describe('SessionWriteCoordinator', () => {
  it('owns monotonic session generations and resets input generation on initialize', () => {
    // Given
    const { coordinator } = createHarness();

    // When
    const firstGeneration = coordinator.initialize('s1');
    coordinator.recordUserInput('s1', 'typed', 10);
    coordinator.disposeSession('s1');
    const secondGeneration = coordinator.initialize('s1');

    // Then
    expect(firstGeneration).toBe(1);
    expect(secondGeneration).toBe(2);
    expect(coordinator.getSessionGeneration('s1')).toBe(2);
    expect(coordinator.getInputGeneration('s1')).toBe(0);
  });

  it('commits on the first automation write and calls onFirstWrite exactly once', async () => {
    // Given
    const { coordinator, writes } = createHarness();
    coordinator.initialize('s1');
    const onFirstWrite = vi.fn();
    const lease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      onFirstWrite,
    );

    // When
    await lease?.write('/review');
    await lease?.write('\x1b');

    // Then
    expect(writes).toEqual(['/review', '\x1b']);
    expect(onFirstWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects stale expectations after user input advances the input generation', () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');

    // When
    const marker = coordinator.recordUserInput('s1', 'typed', 20);
    const staleLease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );

    // Then
    expect(marker).toEqual({ sessionGeneration: 1, inputGeneration: 1, occurredAt: 20 });
    expect(staleLease).toBeNull();
  });

  it('cancels uncommitted automation when user input arrives first', async () => {
    // Given
    const { coordinator, writes } = createHarness();
    coordinator.initialize('s1');
    const onFirstWrite = vi.fn();
    const lease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      onFirstWrite,
    );

    // When
    coordinator.recordUserInput('s1', 'typed', 20);
    await lease?.write('/review');

    // Then
    expect(writes).toEqual(['typed']);
    expect(onFirstWrite).not.toHaveBeenCalled();
  });

  it('buffers user bytes behind committed automation and flushes them in order on release', async () => {
    // Given
    const { coordinator, writes } = createHarness();
    coordinator.initialize('s1');
    const lease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );
    await lease?.write('automation-1');

    // When
    coordinator.recordUserInput('s1', 'user-1', 20);
    coordinator.recordUserInput('s1', 'user-2', 21);
    await lease?.write('automation-2');
    lease?.release();
    lease?.release();

    // Then
    expect(writes).toEqual(['automation-1', 'automation-2', 'user-1', 'user-2']);
  });

  it('allows only one automation owner at a time and releases ownership idempotently', () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');
    const expectation = { sessionGeneration: 1, inputGeneration: 0 };
    const firstLease = coordinator.acquireAutomation('s1', expectation, vi.fn());

    // When
    const concurrentLease = coordinator.acquireAutomation('s1', expectation, vi.fn());
    firstLease?.release();
    firstLease?.release();
    const nextLease = coordinator.acquireAutomation('s1', expectation, vi.fn());

    // Then
    expect(concurrentLease).toBeNull();
    expect(nextLease).not.toBeNull();
  });

  it('gives a user submission priority over uncommitted automation', async () => {
    // Given
    const { coordinator, writes } = createHarness();
    coordinator.initialize('s1');
    const automation = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );

    // When
    const userSubmission = coordinator.acquireUserSubmission('s1');
    coordinator.recordUserInput('s1', 'typed', 20);
    await automation?.write('/review');

    // Then
    expect(userSubmission).not.toBeNull();
    expect(writes).toEqual(['typed']);
  });

  it('releases a user submission in finally when submit rejects', async () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');
    const userSubmission = coordinator.acquireUserSubmission('s1');
    const submitError = new Error('submit failed');

    // When
    const submission = userSubmission?.run(async () => Promise.reject(submitError));

    // Then
    await expect(submission).rejects.toBe(submitError);
    expect(coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    )).not.toBeNull();
  });

  it('cancels active leases and drops deferred input when a session is disposed', async () => {
    // Given
    const { coordinator, writes } = createHarness();
    coordinator.initialize('s1');
    const lease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );
    await lease?.write('automation');
    coordinator.recordUserInput('s1', 'deferred-user', 20);

    // When
    coordinator.disposeSession('s1');
    lease?.release();
    await lease?.write('stale-automation');

    // Then
    expect(writes).toEqual(['automation']);
    expect(coordinator.getSessionGeneration('s1')).toBeNull();
    expect(coordinator.getInputGeneration('s1')).toBeNull();
  });
});
