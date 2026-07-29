import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { handleTaskMove as HandleTaskMove } from '../../src/main/ipc/handlers/task-move';
import type { TaskMoveResult } from '../../src/shared/auto-command-outcome';
import {
  context,
  getLatestForTask,
  makeLane,
  makeRecord,
  makeSnapshot,
  makeTask,
  resetHarness,
  scheduler,
  sessionManager,
  setPhaseThreeSpawnOutcome,
  spawnAgent,
  state,
  taskAutoCommandConsumptionLockCounts,
  updateAppliedSettings,
} from './helpers/task-move-live-submission-harness';

let handleTaskMove: typeof HandleTaskMove;

async function moveToDestination(): Promise<TaskMoveResult> {
  return handleTaskMove(context as never, {
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
    expect(updateAppliedSettings).not.toHaveBeenCalled();
    const prefixOptions = scheduler.scheduleKeystrokes.mock.calls[0]?.[3];
    expect(prefixOptions).toMatchObject({ strictVerification: true });
    await prefixOptions?.onDelivered?.();
    expect(updateAppliedSettings).toHaveBeenCalledWith('pty-live-1', { effort: 'high' });
    expect(request?.validateCurrent()).toBe('valid');
  });

  it('returns the accepted native-idle registration generation for a task-level command', async () => {
    scheduler.scheduleNativeIdleSubmission.mockReturnValue({ accepted: true, generation: 47 });
    state.task = makeTask({ auto_command: '/task-level-command' });
    state.destinationLane = makeLane('lane-91', { auto_command: '/lane-level-command' });

    const result = await moveToDestination();

    const request = scheduler.scheduleNativeIdleSubmission.mock.calls[0]?.[0];
    expect(request?.command).toBe('/task-level-command');
    expect(result).toEqual({
      ok: true,
      autoCommand: { kind: 'scheduled', transport: 'native-idle', generation: 47 },
    });
  });

  it('consumes a task-level command after native registration while preserving the lane command', async () => {
    state.task = makeTask({ auto_command: '/task-level-command' });
    state.destinationLane = makeLane('lane-91', { auto_command: '/lane-level-command' });

    await moveToDestination();

    expect(state.task.auto_command).toBeNull();
    expect(state.destinationLane.auto_command).toBe('/lane-level-command');
    expect(taskAutoCommandConsumptionLockCounts).toEqual([1]);
  });

  it('preserves generic full-sequence delivery for non-wait policies', async () => {
    state.task = makeTask({ agent: 'claude', auto_command: '/task-level-command' });
    state.project = { ...state.project, default_agent: 'claude' };
    state.destinationLane = makeLane('lane-91', { auto_command: '/lane-level-command', effort_override: 'high' });
    state.settingsSequence = ['/effort high'];

    const result = await moveToDestination();

    expect(scheduler.scheduleKeystrokes).toHaveBeenCalledWith(
      state.task.id,
      'pty-live-1',
      ['/effort high', '/task-level-command'],
      expect.objectContaining({ verifiedPrefixLength: 1 }),
    );
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      autoCommand: { kind: 'scheduled', transport: 'legacy' },
    });
    expect(state.task.auto_command).toBe('/task-level-command');
  });

  it.each([
    ['root identity', { rootNativeSessionId: null }],
    ['session generation', { sessionGeneration: null }],
    ['input generation', { inputGeneration: null }],
  ])('returns a finalized native-evidence skip when the %s is missing', async (_name, snapshot) => {
    state.task = makeTask({ auto_command: '/task-level-command' });
    state.destinationLane = makeLane('lane-91', { auto_command: '/lane-level-command' });
    state.snapshot = makeSnapshot(snapshot);

    const result = await moveToDestination();

    expect(result).toEqual({
      ok: true,
      autoCommand: {
        kind: 'skipped',
        reason: 'native-evidence-unavailable',
        warning: 'Auto-command was skipped because required OpenCode native session evidence is unavailable.',
      },
    });
    expect(state.task.auto_command).toBeNull();
    expect(state.destinationLane.auto_command).toBe('/lane-level-command');
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
  });

  it('returns no-active-main-session and consumes the task command when live ownership is missing', async () => {
    state.task = makeTask({ auto_command: '/task-level-command' });
    state.sessionStatus = 'suspended';

    const result = await moveToDestination();

    expect(result).toEqual({
      ok: true,
      autoCommand: {
        kind: 'skipped',
        reason: 'no-active-main-session',
        warning: 'Auto-command was skipped because no active Main OpenCode session is available.',
      },
    });
    expect(state.task.auto_command).toBeNull();
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
  });

  it('consumes a finalized Phase 3 skip while the caller-held lock is active', async () => {
    state.task = makeTask({ session_id: null, auto_command: '/task-level-command' });
    state.sourceLane = makeLane('lane-source', { role: 'todo' });
    state.destinationLane = makeLane('lane-91', { auto_command: '/lane-level-command' });
    setPhaseThreeSpawnOutcome({
      kind: 'skipped',
      reason: 'fresh-not-supported',
      warning: 'Auto-command was skipped because OpenCode fresh-session delivery is not supported.',
    });

    const result = await moveToDestination();

    expect(result).toEqual({
      ok: true,
      autoCommand: {
        kind: 'skipped',
        reason: 'fresh-not-supported',
        warning: 'Auto-command was skipped because OpenCode fresh-session delivery is not supported.',
      },
    });
    expect(state.task.auto_command).toBeNull();
    expect(state.destinationLane.auto_command).toBe('/lane-level-command');
    expect(taskAutoCommandConsumptionLockCounts).toEqual([1]);
  });

  it('rolls back a Phase 3 failure without consuming the task command', async () => {
    state.task = makeTask({ session_id: null, auto_command: '/task-level-command' });
    state.sourceLane = makeLane('lane-source', { role: 'todo' });
    spawnAgent.mockRejectedValue(new Error('spawn failed'));

    await expect(moveToDestination()).rejects.toThrow('spawn failed');

    expect(state.task.swimlane_id).toBe(state.sourceLane.id);
    expect(state.task.auto_command).toBe('/task-level-command');
  });

  it('does not represent a rejected native registration as scheduled or consume the task command', async () => {
    state.task = makeTask({ auto_command: '/task-level-command' });
    scheduler.scheduleNativeIdleSubmission.mockReturnValue(null);

    const result = await moveToDestination();

    expect(result).toEqual({ ok: true, autoCommand: { kind: 'not-applicable' } });
    expect(state.task.auto_command).toBe('/task-level-command');
  });

  it('keeps the returned immediate native outcome unchanged when later validation rejects delivery', async () => {
    const result = await moveToDestination();
    const request = scheduler.scheduleNativeIdleSubmission.mock.calls[0]?.[0];
    state.sessionExists = false;

    expect(request?.validateCurrent()).toBe('session-exit');
    expect(result).toEqual({
      ok: true,
      autoCommand: { kind: 'scheduled', transport: 'native-idle', generation: 1 },
    });
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

  it('suppresses the active OpenCode auto_command for an isolated session while retaining its normal lifecycle', async () => {
    state.destinationLane = makeLane('lane-91', {
      auto_command: '/go',
      session_target: 'isolated',
    });
    state.record = makeRecord({ isolated_swimlane_id: 'lane-91' });

    await moveToDestination();

    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it('does not schedule live delivery when the captured record is not running', async () => {
    state.record = makeRecord({ status: 'suspended' });

    await moveToDestination();

    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
  });

  it('does not fall back to an unrelated latest record when the exact PTY record is absent', async () => {
    state.exactRecordExists = false;
    state.latestRecord = makeRecord({
      id: 'unrelated-latest', applied_model: 'latest-model', applied_effort: 'low',
      agent_session_id: 'latest-agent', cwd: '/latest',
    });
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = ['/effort high'];

    await moveToDestination();

    expect(getLatestForTask).not.toHaveBeenCalled();
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong task', () => { state.sessionTaskId = 'other-task'; }],
    ['wrong project', () => { state.sessionProjectId = 'other-project'; }],
    ['non-running session', () => { state.sessionStatus = 'suspended'; }],
    ['non-writable PTY', () => { state.writable = false; }],
  ])('does not route live delivery for a %s captured session', async (_name, mutate) => {
    mutate();

    await moveToDestination();

    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
  });

  it('keeps exact captured model and effort routing when a newer task record differs', async () => {
    state.destinationLane = makeLane('lane-91', {
      auto_command: '/go', model_override: 'destination-model', effort_override: 'high',
    });
    state.record = makeRecord({
      applied_model: 'destination-model', applied_effort: 'high',
      agent_session_id: 'captured-agent', cwd: '/captured',
    });
    state.latestRecord = makeRecord({
      id: 'newer-other-track', applied_model: 'latest-model', applied_effort: 'low',
      agent_session_id: 'latest-agent', cwd: '/latest',
    });
    await moveToDestination();
    const request = scheduler.scheduleNativeIdleSubmission.mock.calls[0]?.[0];

    expect(sessionManager.suspend).not.toHaveBeenCalled();
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(scheduler.scheduleNativeIdleSubmission).toHaveBeenCalledTimes(1);
    expect(request?.command).toBe('/go');
    expect(request?.validateCurrent()).toBe('valid');
  });

  it('does not persist an old prefix after a newer runtime effort override wins', async () => {
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = ['/effort high'];
    await moveToDestination();
    const options = scheduler.scheduleKeystrokes.mock.calls[0]?.[3];
    state.task = { ...state.task, effort_override: 'low' };
    state.record = makeRecord({ applied_effort: 'low' });

    await expect(options?.onDelivered?.()).rejects.toThrow('superseded');
    expect(updateAppliedSettings).not.toHaveBeenCalled();
  });

  it('does not persist a delayed prefix after captured PTY ownership is lost', async () => {
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = ['/effort high'];
    await moveToDestination();
    const options = scheduler.scheduleKeystrokes.mock.calls[0]?.[3];
    state.writable = false;

    await expect(options?.onDelivered?.()).rejects.toThrow('superseded');
    expect(updateAppliedSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['id', () => { state.record = makeRecord({ id: 'other-pty' }); }],
    ['task', () => { state.record = makeRecord({ task_id: 'other-task' }); }],
    ['session type', () => { state.record = makeRecord({ session_type: 'claude_agent' }); }],
    ['isolation', () => { state.record = makeRecord({ isolated_swimlane_id: 'other-track' }); }],
  ])('rejects a mismatched captured record %s', async (_name, mutate) => {
    mutate();

    await moveToDestination();

    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
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

  it('marks a settings-driven respawn as restart for adapter-owned auto-command policy', async () => {
    state.record = makeRecord({ applied_effort: 'low' });
    state.destinationLane = makeLane('lane-91', { auto_command: '/go', effort_override: 'high' });
    state.settingsSequence = [];

    await moveToDestination();

    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      autoCommandLifecycle: { kind: 'restart' },
    }));
  });

  it('keeps auto_spawn role priority ahead of live routing', async () => {
    state.task = makeTask({ auto_command: '/task-level-command' });
    state.destinationLane = makeLane('lane-91', { auto_spawn: false, auto_command: '/go' });

    const result = await moveToDestination();

    expect(sessionManager.suspend).toHaveBeenCalledWith('pty-live-1');
    expect(scheduler.scheduleNativeIdleSubmission).not.toHaveBeenCalled();
    expect(scheduler.scheduleKeystrokes).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, autoCommand: { kind: 'not-applicable' } });
    expect(state.task.auto_command).toBe('/task-level-command');
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
