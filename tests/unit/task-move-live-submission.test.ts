import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { handleTaskMove as HandleTaskMove } from '../../src/main/ipc/handlers/task-move';
import {
  context,
  makeLane,
  makeRecord,
  makeSnapshot,
  makeTask,
  resetHarness,
  scheduler,
  sessionManager,
  spawnAgent,
  state,
} from './helpers/task-move-live-submission-harness';

let handleTaskMove: typeof HandleTaskMove;

async function moveToDestination(): Promise<void> {
  await handleTaskMove(context as never, {
    taskId: state.task.id,
    targetSwimlaneId: state.destinationLane.id,
    targetPosition: 0,
  });
}

describe('handleTaskMove live lane submission', () => {
  beforeAll(async () => {
    ({ handleTaskMove } = await import('../../src/main/ipc/handlers/task-move'));
  });

  beforeEach(() => {
    resetHarness();
  });

  it('schedules the settings prefix before the trailing lane command waits for native idle', async () => {
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = ['/effort high'];

    await moveToDestination();

    expect(scheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      state.task.id,
      'pty-live-1',
      ['/effort high'],
      expect.objectContaining({ verifiedPrefixLength: 1 }),
    );
    expect(scheduler.scheduleNativeIdleSubmission).toHaveBeenCalledTimes(1);
    const request = scheduler.scheduleNativeIdleSubmission.mock.calls[0]?.[0];
    expect(request?.command).toBe('/go');
    expect(request?.nativeSessionId).toBe('private-native-id');
    expect(scheduler.scheduleKeystrokes.mock.invocationCallOrder[0])
      .toBeLessThan(scheduler.scheduleNativeIdleSubmission.mock.invocationCallOrder[0] ?? 0);
    expect(request?.validateCurrent()).toBe('valid');
  });

  it('uses only destination lane auto_command even when task-level MCP autoCommand exists', async () => {
    state.task = makeTask({ auto_command: '/task-level-command' });
    state.destinationLane = makeLane('lane-91', { auto_command: '/lane-level-command' });

    await moveToDestination();

    const request = scheduler.scheduleNativeIdleSubmission.mock.calls[0]?.[0];
    expect(request?.command).toBe('/lane-level-command');
  });

  it('preserves generic full-sequence delivery for non-wait policies', async () => {
    state.task = makeTask({ agent: 'claude' });
    state.project = { ...state.project, default_agent: 'claude' };
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = ['/effort high'];

    await moveToDestination();

    expect(scheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      state.task.id,
      'pty-live-1',
      ['/effort high', '/go'],
      expect.objectContaining({ verifiedPrefixLength: 1 }),
    );
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
  });

  it('does not fall back to generic lane-command delivery without private native identity', async () => {
    state.snapshot = makeSnapshot({ rootNativeSessionId: null });
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = ['/effort high'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await moveToDestination();

    expect(scheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      state.task.id,
      'pty-live-1',
      ['/effort high'],
      expect.anything(),
    );
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.arrayContaining(['/go']), expect.anything(),
    );
    expect(log.mock.calls.flat().join(' ')).toContain('no lane command');
  });

  it('revalidates ownership, evidence generation, and current configuration before first byte', async () => {
    await moveToDestination();
    const request = scheduler.scheduleNativeIdleSubmission.mock.calls[0]?.[0];
    expect(request?.validateCurrent()).toBe('valid');

    state.destinationLane = { ...state.destinationLane, auto_command: '/changed' };
    expect(request?.validateCurrent()).toBe('superseded');

    state.destinationLane = { ...state.destinationLane, auto_command: '/go' };
    state.snapshot = makeSnapshot({ sessionGeneration: 4 });
    expect(request?.validateCurrent()).toBe('session-exit');

    state.snapshot = makeSnapshot();
    state.task = { ...state.task, session_id: 'replacement-pty' };
    expect(request?.validateCurrent()).toBe('session-exit');
  });

  it('restarts for unsupported concrete effort before an auto-only plan can schedule', async () => {
    state.record = makeRecord({ applied_effort: 'low' });
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = [];

    await moveToDestination();

    expect(sessionManager.suspend).toHaveBeenCalledWith('pty-live-1');
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('keeps auto_spawn role priority ahead of live routing', async () => {
    state.destinationLane = makeLane('lane-91', { auto_spawn: false, auto_command: '/go' });

    await moveToDestination();

    expect(sessionManager.suspend).toHaveBeenCalledWith('pty-live-1');
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('logs metadata only without command, fingerprint, or native identity', async () => {
    state.destinationLane = makeLane('lane-91', { auto_command: '/private-command' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await moveToDestination();

    const output = log.mock.calls.flat().join(' ');
    expect(output).not.toContain('/private-command');
    expect(output).not.toContain('private-native-id');
    const request = scheduler.scheduleNativeIdleSubmission.mock.calls[0]?.[0];
    expect(output).not.toContain(request?.command ?? '/private-command');
  });
});
