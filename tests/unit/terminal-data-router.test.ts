import { describe, expect, it, vi } from 'vitest';
import { createWriteBatcher } from '../../src/renderer/utils/write-batcher';
import { routeTerminalData } from '../../src/renderer/utils/terminal-data-router';

describe('routeTerminalData', () => {
  it('schedules ordinary terminal data as human input', () => {
    const schedule = vi.fn<(data: string) => void>();
    const flush = vi.fn<() => void>();
    const writeFocusReport = vi.fn<(data: string) => void>();

    routeTerminalData('typed', { schedule, flush }, writeFocusReport);

    expect(schedule).toHaveBeenCalledWith('typed');
    expect(flush).not.toHaveBeenCalled();
    expect(writeFocusReport).not.toHaveBeenCalled();
  });

  it.each(['\x1b[I', '\x1b[O'])('flushes pending human data before exact focus response %j', async (focusResponse) => {
    const writes: string[] = [];
    const batcher = createWriteBatcher((payload) => writes.push(payload));

    batcher.schedule('human');
    routeTerminalData(focusResponse, batcher, (payload) => writes.push(payload));

    expect(writes).toEqual(['human', focusResponse]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(writes).toEqual(['human', focusResponse]);
  });

  it('keeps near-match focus data in the human input batch', () => {
    const schedule = vi.fn<(data: string) => void>();
    const flush = vi.fn<() => void>();
    const writeFocusReport = vi.fn<(data: string) => void>();

    routeTerminalData('\x1b[Iextra', { schedule, flush }, writeFocusReport);

    expect(schedule).toHaveBeenCalledWith('\x1b[Iextra');
    expect(flush).not.toHaveBeenCalled();
    expect(writeFocusReport).not.toHaveBeenCalled();
  });
});
