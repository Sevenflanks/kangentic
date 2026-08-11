import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { createWriteBatcher } from '../../src/renderer/utils/write-batcher';
import { routeTerminalData } from '../../src/renderer/utils/terminal-data-router';

describe('routeTerminalData', () => {
  it('receives the exact DA1 terminal response produced by xterm for a primary device attributes query', async () => {
    const terminal = new Terminal();
    let response = '';
    const dataSubscription = terminal.onData((data) => { response += data; });

    await new Promise<void>((resolve) => terminal.write('\x1b[c', resolve));

    expect(response).toBe('\x1b[?1;2c');
    dataSubscription.dispose();
    terminal.dispose();
  });

  it('schedules ordinary terminal data as human input', () => {
    const schedule = vi.fn<(data: string) => void>();
    const flush = vi.fn<() => void>();
    const writeTerminalResponse = vi.fn<(data: string) => void>();

    routeTerminalData('typed', { schedule, flush }, writeTerminalResponse);

    expect(schedule).toHaveBeenCalledWith('typed');
    expect(flush).not.toHaveBeenCalled();
    expect(writeTerminalResponse).not.toHaveBeenCalled();
  });

  it.each(['\x1b[I', '\x1b[O', '\x1b[?1;2c'])('flushes pending human data before exact terminal response %j', async (terminalResponse) => {
    const writes: string[] = [];
    const batcher = createWriteBatcher((payload) => writes.push(payload));

    batcher.schedule('human');
    routeTerminalData(terminalResponse, batcher, (payload) => writes.push(payload));

    expect(writes).toEqual(['human', terminalResponse]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(writes).toEqual(['human', terminalResponse]);
  });

  it.each(['\x1b[Iextra', '\x1b[?1;2c0', '\x1b[c'])('keeps unknown terminal data %j in the human input batch', (data) => {
    const schedule = vi.fn<(data: string) => void>();
    const flush = vi.fn<() => void>();
    const writeTerminalResponse = vi.fn<(data: string) => void>();

    routeTerminalData(data, { schedule, flush }, writeTerminalResponse);

    expect(schedule).toHaveBeenCalledWith(data);
    expect(flush).not.toHaveBeenCalled();
    expect(writeTerminalResponse).not.toHaveBeenCalled();
  });
});
