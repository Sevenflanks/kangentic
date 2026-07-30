import { SessionWriteCoordinator } from '../../src/main/pty/session-write-coordinator';
import { createWriteQueue, type PtyWriteTarget, type WriteQueue } from '../../src/main/pty/write-queue';

export function createHarness(): {
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
