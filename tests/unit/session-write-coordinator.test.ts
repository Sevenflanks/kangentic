import { describe, expect, it, vi } from 'vitest';
import { SessionWriteCoordinator } from '../../src/main/pty/session-write-coordinator';
import { createWriteQueue, type PtyWriteTarget } from '../../src/main/pty/write-queue';
import { createHarness } from './session-write-coordinator-test-harness';

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

  it('preserves mixed deferred user input and focus reports in FIFO order without advancing focus generations', async () => {
    // Given
    const { coordinator, writes } = createHarness();
    coordinator.initialize('s1');
    const automation = coordinator.acquireAutomation(
      's1',
      { sessionGeneration: 1, inputGeneration: 0 },
      vi.fn(),
    );
    await automation?.write('automation');

    // When
    coordinator.recordUserInput('s1', 'human-1', 20);
    coordinator.recordFocusReport('s1', '\x1b[I');
    coordinator.recordUserInput('s1', 'human-2', 21);
    coordinator.recordFocusReport('s1', '\x1b[O');
    automation?.release();

    // Then
    expect(writes).toEqual(['automation', 'human-1', '\x1b[I', 'human-2', '\x1b[O']);
    expect(coordinator.getInputGeneration('s1')).toBe(2);
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
