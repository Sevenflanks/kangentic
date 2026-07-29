import { describe, expect, it, vi } from 'vitest';
import { SessionWriteCoordinator } from '../../src/main/pty/session-write-coordinator';
import { createWriteQueue, type PtyWriteTarget } from '../../src/main/pty/write-queue';
import { createHarness } from './session-write-coordinator-test-harness';

describe('SessionWriteCoordinator user submission', () => {
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

  it('defers focus reports until an active user submission releases ownership', async () => {
    // Given
    const { coordinator, writes } = createHarness();
    coordinator.initialize('s1');
    const userSubmission = coordinator.acquireUserSubmission('s1');
    let resolveSubmit = (): void => undefined;
    const submit = vi.fn(() => new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    }));
    const submission = userSubmission?.run(submit);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(1);

    // When
    coordinator.recordFocusReport('s1', '\x1b[I');
    coordinator.recordFocusReport('s1', '\x1b[O');

    // Then
    expect(writes).toEqual([]);
    expect(coordinator.getInputGeneration('s1')).toBe(1);

    // When
    resolveSubmit();
    await expect(submission).resolves.toBeUndefined();

    // Then
    expect(writes).toEqual(['\x1b[I', '\x1b[O']);
    expect(coordinator.getInputGeneration('s1')).toBe(1);
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
});
