import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoCommandWarning } from '../../src/shared/auto-command-outcome';
import type { LiveDeliveryStatus } from '../../src/shared/live-delivery-status';
import type { Session } from '../../src/shared/types';

Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      config: {
        set: vi.fn(),
        get: async () => ({}),
        getGlobal: async () => ({}),
        getProjectOverrides: async () => null,
      },
      projects: { list: async () => [] },
      sessions: {
        list: async () => [],
        spawn: async () => ({}),
        kill: async () => {},
        reset: async () => {},
        suspend: async () => {},
        resume: async () => ({}),
        reconcile: async () => null,
        getUsage: async () => ({}),
        getActivity: async () => ({}),
        getActivityReasons: async () => ({}),
        getEventsCache: async () => ({}),
        getFirstOutput: async () => ({}),
      },
      tasks: { getSpawnProgress: async () => ({}) },
    },
  },
  configurable: true,
});

import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';

function deliveryStatus(
  generation: number,
  state: LiveDeliveryStatus['state'],
  sessionId = 'session-1',
): LiveDeliveryStatus {
  if (state === 'cancelled') {
    return {
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId,
      generation,
      at: '2026-07-22T00:00:00.000Z',
      state,
      reason: 'timeout',
    };
  }

  return {
    projectId: 'project-1',
    taskId: 'task-1',
    sessionId,
    generation,
    at: '2026-07-22T00:00:00.000Z',
    state,
  };
}

function resetStore(): void {
  useProjectStore.setState({ currentProject: { id: 'project-1' } });
  useSessionStore.setState({
    autoCommandWarningsByTaskId: {},
    liveDeliveryByTaskId: {},
    sessions: [],
    _sessionByTaskId: new Map(),
  });
}

function autoCommandWarning(taskId = 'task-1', projectId = 'project-1'): AutoCommandWarning {
  return {
    projectId,
    taskId,
    reason: 'no-active-main-session',
    message: 'Lane command could not be scheduled for this task.',
    at: '2026-07-27T00:00:00.000Z',
  };
}

function session(status: Session['status']): Session {
  return {
    id: 'session-1',
    taskId: 'task-1',
    projectId: 'project-1',
    pid: 1,
    status,
    shell: 'bash',
    cwd: '/mock',
    startedAt: '2026-07-22T00:00:00.000Z',
    exitCode: null,
    resuming: false,
  };
}

describe('live delivery status store', () => {
  beforeEach(resetStore);

  it('starts with no transient auto-command warnings', () => {
    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({});
  });

  it('stores warnings only for the active project and dismisses one task only', () => {
    const firstWarning = autoCommandWarning();
    const secondWarning = autoCommandWarning('task-2');

    useSessionStore.getState().setAutoCommandWarning({ ...firstWarning, projectId: 'project-2' });
    useSessionStore.getState().setAutoCommandWarning(firstWarning);
    useSessionStore.getState().setAutoCommandWarning(secondWarning);
    useSessionStore.getState().clearAutoCommandWarningForTask('task-1');

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({
      'task-2': secondWarning,
    });
  });

  it('replaces a prior warning when live delivery progresses or is cancelled', () => {
    for (const state of ['waiting', 'sending', 'delivered', 'cancelled'] as const) {
      useSessionStore.setState({ autoCommandWarningsByTaskId: { 'task-1': autoCommandWarning() } });

      useSessionStore.getState().setLiveDeliveryStatus(deliveryStatus(1, state));

      expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({});
    }
  });

  it('creates a safe sessionless warning for an asynchronous delivery error', () => {
    const status = {
      ...deliveryStatus(1, 'cancelled'),
      reason: 'delivery-error',
      at: '2026-07-27T00:00:00.000Z',
    } satisfies LiveDeliveryStatus;

    useSessionStore.getState().setLiveDeliveryStatus(status);

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({
      'task-1': {
        projectId: 'project-1',
        taskId: 'task-1',
        reason: 'delivery-error',
        message: 'Lane command could not be delivered safely.',
        at: status.at,
      },
    });
  });

  it('clears warnings when a task receives a replacement session or task lifecycle cleanup', () => {
    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning());
    useSessionStore.getState().upsertSession(session('running'));

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({});

    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning('task-1'));
    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning('task-2'));
    useSessionStore.getState().clearAutoCommandWarningsForTasks(['task-1']);

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({
      'task-2': autoCommandWarning('task-2'),
    });

    useSessionStore.getState().clearAutoCommandWarnings();

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({});
  });

  it('keeps the newest generation for the current project', () => {
    const generationTwo = deliveryStatus(2, 'waiting');
    const generationOne = deliveryStatus(1, 'waiting');

    useSessionStore.getState().setLiveDeliveryStatus(generationTwo);
    useSessionStore.getState().setLiveDeliveryStatus(generationOne);

    expect(useSessionStore.getState().liveDeliveryByTaskId['task-1']).toEqual(generationTwo);
  });

  it('rejects statuses for a project other than the project active at mutation time', () => {
    const otherProject = { ...deliveryStatus(1, 'waiting'), projectId: 'project-2' };

    useSessionStore.getState().setLiveDeliveryStatus(otherProject);

    expect(useSessionStore.getState().liveDeliveryByTaskId).toEqual({});
  });

  it('accepts same-session state progression but rejects a same-generation session replacement', () => {
    const waiting = deliveryStatus(4, 'waiting');
    const sending = deliveryStatus(4, 'sending');
    const differentSession = deliveryStatus(4, 'delivered', 'session-2');

    useSessionStore.getState().setLiveDeliveryStatus(waiting);
    useSessionStore.getState().setLiveDeliveryStatus(sending);
    useSessionStore.getState().setLiveDeliveryStatus(differentSession);

    expect(useSessionStore.getState().liveDeliveryByTaskId['task-1']).toEqual(sending);
  });

  it('clears a delivered entry only when the matching delivery is still current', () => {
    const delivered = deliveryStatus(5, 'delivered');
    const newer = deliveryStatus(6, 'sending', 'session-2');

    useSessionStore.getState().setLiveDeliveryStatus(delivered);
    useSessionStore.getState().setLiveDeliveryStatus(newer);
    useSessionStore.getState().clearDeliveredLiveDeliveryStatus(delivered);

    expect(useSessionStore.getState().liveDeliveryByTaskId['task-1']).toEqual(newer);
  });

  it('clears entries when their task or session lifecycle ends', () => {
    useSessionStore.getState().setLiveDeliveryStatus(deliveryStatus(1, 'waiting'));
    useSessionStore.getState().clearLiveDeliveryStatusForSession('session-1');

    expect(useSessionStore.getState().liveDeliveryByTaskId).toEqual({});

    useSessionStore.getState().setLiveDeliveryStatus(deliveryStatus(2, 'waiting'));
    useSessionStore.getState().clearLiveDeliveryStatusForTask('task-1');

    expect(useSessionStore.getState().liveDeliveryByTaskId).toEqual({});
  });

  it('drops invisible terminal cancellations without retaining stale feedback', () => {
    const shutdown = {
      ...deliveryStatus(3, 'cancelled'),
      reason: 'shutdown',
    } satisfies LiveDeliveryStatus;

    useSessionStore.getState().setLiveDeliveryStatus(shutdown);

    expect(useSessionStore.getState().liveDeliveryByTaskId).toEqual({});
  });

  it('clears feedback when a status push reports a terminal session', () => {
    useSessionStore.getState().setLiveDeliveryStatus(deliveryStatus(4, 'waiting'));

    useSessionStore.getState().upsertSession(session('exited'));

    expect(useSessionStore.getState().liveDeliveryByTaskId).toEqual({});
  });

  it('prunes feedback for sessions absent from the live-session sync result', async () => {
    useSessionStore.getState().setLiveDeliveryStatus(deliveryStatus(5, 'waiting'));
    window.electronAPI.sessions.list = async () => [session('exited')];

    await useSessionStore.getState().syncSessions();

    expect(useSessionStore.getState().liveDeliveryByTaskId).toEqual({});
  });

  it('preserves a warning when sync confirms the same live session', async () => {
    useSessionStore.setState({ sessions: [session('running')] });
    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning());
    window.electronAPI.sessions.list = async () => [session('running')];

    await useSessionStore.getState().syncSessions();

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({
      'task-1': autoCommandWarning(),
    });
  });

  it('preserves a warning delivered while a same-session sync is in flight', async () => {
    useSessionStore.setState({ sessions: [session('running')] });
    let resolveList: ((sessions: Session[]) => void) | undefined;
    window.electronAPI.sessions.list = () => new Promise<Session[]>((resolve) => {
      resolveList = resolve;
    });

    const sync = useSessionStore.getState().syncSessions();
    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning());
    resolveList?.([session('running')]);

    await sync;

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({
      'task-1': autoCommandWarning(),
    });
  });

  it('clears a pre-existing warning when sync replaces its session identity', async () => {
    useSessionStore.setState({ sessions: [{ ...session('running'), id: 'old-session' }] });
    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning());
    window.electronAPI.sessions.list = async () => [{ ...session('running'), id: 'replacement-session' }];

    await useSessionStore.getState().syncSessions();

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({});
  });

  it('clears a pre-existing warning when sync first discovers a task session', async () => {
    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning());
    window.electronAPI.sessions.list = async () => [session('running')];

    await useSessionStore.getState().syncSessions();

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({});
  });

  it('preserves a warning created during sync when it first discovers a task session', async () => {
    let resolveList: ((sessions: Session[]) => void) | undefined;
    window.electronAPI.sessions.list = () => new Promise<Session[]>((resolve) => {
      resolveList = resolve;
    });

    const sync = useSessionStore.getState().syncSessions();
    useSessionStore.getState().setAutoCommandWarning(autoCommandWarning());
    resolveList?.([session('running')]);

    await sync;

    expect(useSessionStore.getState().autoCommandWarningsByTaskId).toEqual({
      'task-1': autoCommandWarning(),
    });
  });
});
