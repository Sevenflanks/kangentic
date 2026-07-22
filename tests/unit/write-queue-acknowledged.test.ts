import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWriteQueue,
  PtyWriteError,
  type PtyWriteTarget,
} from '../../src/main/pty/write-queue';

function createRecorder(): PtyWriteTarget & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    write(data: string): void {
      calls.push(data);
    },
  };
}

async function expectWriteError(
  promise: Promise<void>,
  code: PtyWriteError['code'],
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PtyWriteError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('createWriteQueue acknowledged entries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after a single-chunk entry passes pty.write', async () => {
    // Given
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty);

    // When
    const acknowledged = queue.enqueueAcknowledged('hello');

    // Then
    await expect(acknowledged).resolves.toBeUndefined();
    expect(pty.calls).toEqual(['hello']);
  });

  it('resolves after every chunk of its own entry but before a later entry', async () => {
    // Given
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty, 2);

    // When
    const acknowledged = queue.enqueueAcknowledged('ABCD');
    queue.enqueue('Z');
    vi.advanceTimersToNextTimer();

    // Then
    await expect(acknowledged).resolves.toBeUndefined();
    expect(pty.calls).toEqual(['AB', 'CD']);

    vi.advanceTimersToNextTimer();
    expect(pty.calls).toEqual(['AB', 'CD', 'Z']);
  });

  it('preserves strict FIFO entry boundaries across mixed enqueue modes', async () => {
    // Given
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty, 2);

    // When
    queue.enqueue('AAAA');
    const acknowledged = queue.enqueueAcknowledged('BBB');
    queue.enqueue('CC');
    vi.runAllTimers();

    // Then
    await expect(acknowledged).resolves.toBeUndefined();
    expect(pty.calls).toEqual(['AA', 'AA', 'BB', 'B', 'CC']);
  });

  it('rejects with missing-pty when no PTY is available', async () => {
    // Given
    const queue = createWriteQueue(() => null);

    // When
    const acknowledged = queue.enqueueAcknowledged('x');

    // Then
    await expectWriteError(acknowledged, 'missing-pty');
  });

  it('rejects every affected acknowledged entry when pty.write throws', async () => {
    // Given
    let writeCount = 0;
    const pty: PtyWriteTarget = {
      write(): void {
        writeCount += 1;
        if (writeCount === 2) throw new Error('pty handle gone');
      },
    };
    const onAutoDispose = vi.fn();
    const queue = createWriteQueue(() => pty, 2, { onAutoDispose });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const first = queue.enqueueAcknowledged('AAAA');
      const second = queue.enqueueAcknowledged('B');
      const firstAssertion = expectWriteError(first, 'write-failed');
      const secondAssertion = expectWriteError(second, 'write-failed');

      // When
      vi.advanceTimersToNextTimer();

      // Then
      await Promise.all([firstAssertion, secondAssertion]);
      expect(onAutoDispose).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects every pending acknowledged entry when disposed', async () => {
    // Given
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty, 2);
    const first = queue.enqueueAcknowledged('AAAA');
    const second = queue.enqueueAcknowledged('B');
    const firstAssertion = expectWriteError(first, 'disposed');
    const secondAssertion = expectWriteError(second, 'disposed');

    // When
    queue.dispose();

    // Then
    await Promise.all([firstAssertion, secondAssertion]);
    vi.runAllTimers();
    expect(pty.calls).toEqual(['AA']);
  });

  it('rejects acknowledged writes enqueued after disposal', async () => {
    // Given
    const queue = createWriteQueue(() => createRecorder());
    queue.dispose();

    // When
    const acknowledged = queue.enqueueAcknowledged('later');

    // Then
    await expectWriteError(acknowledged, 'disposed');
  });

  it('does not resolve before an earlier fire-and-forget entry completes', async () => {
    // Given
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty, 2);
    queue.enqueue('AAAA');
    let resolved = false;
    const acknowledged = queue.enqueueAcknowledged('B').then(() => {
      resolved = true;
    });

    // When
    await Promise.resolve();
    vi.advanceTimersToNextTimer();
    await Promise.resolve();

    // Then
    expect(pty.calls).toEqual(['AA', 'AA']);
    expect(resolved).toBe(false);

    vi.advanceTimersToNextTimer();
    await acknowledged;
    expect(pty.calls).toEqual(['AA', 'AA', 'B']);
    expect(resolved).toBe(true);
  });
});
