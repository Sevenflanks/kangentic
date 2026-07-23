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

  it('rejects an automation expectation from an earlier session generation', () => {
    // Given
    const { coordinator } = createHarness();
    const staleGeneration = coordinator.initialize('s1');
    coordinator.initialize('s1');

    // When
    const lease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: staleGeneration, inputGeneration: 0 },
      vi.fn(),
    );

    // Then
    expect(lease).toBeNull();
  });

  it('ignores empty automation writes and commits on the first non-empty write', async () => {
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
    await lease?.write('');

    // Then
    expect(writes).toEqual([]);
    expect(onFirstWrite).not.toHaveBeenCalled();

    // When
    await lease?.write('/review');
    await lease?.write('\x1b');

    // Then
    expect(writes).toEqual(['/review', '\x1b']);
    expect(onFirstWrite).toHaveBeenCalledTimes(1);
  });

  it('calls onFirstWrite synchronously before the first PTY write', async () => {
    // Given
    const order: string[] = [];
    const target: PtyWriteTarget = {
      write(): void {
        order.push('pty-write');
      },
    };
    const queue = createWriteQueue(() => target);
    const coordinator = new SessionWriteCoordinator(() => queue);
    coordinator.initialize('s1');
    const lease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      () => order.push('on-first-write'),
    );

    // When
    const write = lease?.write('automation');

    // Then
    expect(order).toEqual(['on-first-write', 'pty-write']);
    await expect(write).resolves.toBeUndefined();
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
    const staleWrite = lease?.write('/review');

    // Then
    await expect(staleWrite).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'inactive-automation-lease',
    });
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

  it('publishes the input marker before admitting deferred user bytes', async () => {
    // Given
    const events: string[] = [];
    const target: PtyWriteTarget = {
      write(data: string): void {
        events.push(`pty:${data}`);
      },
    };
    const queue = createWriteQueue(() => target);
    const coordinator = new SessionWriteCoordinator(
      () => queue,
      (_sessionId, marker) => events.push(`marker:${marker.inputGeneration}`),
    );
    coordinator.initialize('s1');
    const lease = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );
    await lease?.write('automation');

    // When
    coordinator.recordUserInput('s1', 'user', 20);

    // Then
    expect(events).toEqual(['pty:automation', 'marker:1']);

    // When
    lease?.release();

    // Then
    expect(events).toEqual(['pty:automation', 'marker:1', 'pty:user']);
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

  it('rejects writes after an automation lease is released', async () => {
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
    lease?.release();
    const write = lease?.write('stale');

    // Then
    await expect(write).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'inactive-automation-lease',
    });
    expect(writes).toEqual([]);
    expect(onFirstWrite).not.toHaveBeenCalled();
  });

  it('advances input generation once only for successful user submission acquisition', () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');

    // When
    const first = coordinator.acquireUserSubmission('s1');
    const generationAfterSuccess = coordinator.getInputGeneration('s1');
    const blocked = coordinator.acquireUserSubmission('s1');

    // Then
    expect(first).not.toBeNull();
    expect(generationAfterSuccess).toBe(1);
    expect(blocked).toBeNull();
    expect(coordinator.getInputGeneration('s1')).toBe(1);
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
    const staleWrite = automation?.write('/review');

    // Then
    expect(userSubmission).not.toBeNull();
    await expect(staleWrite).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'inactive-automation-lease',
    });
    expect(coordinator.getInputGeneration('s1')).toBe(1);
    expect(writes).toEqual([]);
  });

  it('delays a user submission behind committed automation and starts it after deferred user bytes', async () => {
    // Given
    const events: string[] = [];
    const target: PtyWriteTarget = {
      write(data: string): void {
        events.push(`pty:${data}`);
      },
    };
    const queue = createWriteQueue(() => target);
    const coordinator = new SessionWriteCoordinator(() => queue);
    coordinator.initialize('s1');
    const automation = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );
    await automation?.write('automation');
    const userSubmission = coordinator.acquireUserSubmission('s1');
    coordinator.recordUserInput('s1', 'direct-user', 20);
    const submit = vi.fn(async () => {
      events.push('submit');
    });

    // When
    const submission = userSubmission?.run(submit);

    // Then
    expect(userSubmission).not.toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(events).toEqual(['pty:automation']);

    // When
    automation?.release();

    // Then
    await expect(submission).resolves.toBeUndefined();
    expect(events).toEqual(['pty:automation', 'pty:direct-user', 'submit']);
    expect(submit).toHaveBeenCalledTimes(1);
  });

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

  it('does not invoke a user submission callback after explicit release', async () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');
    const lease = coordinator.acquireUserSubmission('s1');
    const submit = vi.fn(async () => undefined);

    // When
    lease?.release();
    const submission = lease?.run(submit);

    // Then
    await expect(submission).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'inactive-user-submission-lease',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('cancels a waiting user submission when its lease is released', async () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');
    const automation = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );
    await automation?.write('automation');
    const lease = coordinator.acquireUserSubmission('s1');
    const submit = vi.fn(async () => undefined);
    const submission = lease?.run(submit);
    expect(submit).not.toHaveBeenCalled();

    // When
    lease?.release();
    automation?.release();

    // Then
    await expect(submission).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'inactive-user-submission-lease',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('cancels a waiting user submission when its session is disposed', async () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');
    const automation = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );
    await automation?.write('automation');
    const lease = coordinator.acquireUserSubmission('s1');
    const submit = vi.fn(async () => undefined);
    const submission = lease?.run(submit);

    // When
    coordinator.disposeSession('s1');
    automation?.release();

    // Then
    await expect(submission).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'inactive-user-submission-lease',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('invokes a user submission callback at most once across concurrent and repeated run calls', async () => {
    // Given
    const { coordinator } = createHarness();
    coordinator.initialize('s1');
    const lease = coordinator.acquireUserSubmission('s1');
    const submit = vi.fn(async () => 'submitted');

    // When
    const first = lease?.run(submit);
    const concurrent = lease?.run(submit);

    // Then
    await expect(first).resolves.toBe('submitted');
    await expect(concurrent).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'user-submission-already-run',
    });
    const repeated = lease?.run(submit);
    await expect(repeated).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
    });
    expect(submit).toHaveBeenCalledTimes(1);
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
    expect(coordinator.getInputGeneration('s1')).toBe(1);
    expect(coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 1 },
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
    const staleWrite = lease?.write('stale-automation');

    // Then
    await expect(staleWrite).rejects.toMatchObject({
      name: 'SessionWriteOwnershipError',
      code: 'inactive-automation-lease',
    });
    expect(writes).toEqual(['automation']);
    expect(coordinator.getSessionGeneration('s1')).toBeNull();
    expect(coordinator.getInputGeneration('s1')).toBeNull();
  });
});
