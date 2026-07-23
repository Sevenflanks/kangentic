import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  useSessionStore.setState({ liveDeliveryByTaskId: {}, sessions: [], _sessionByTaskId: new Map() });
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
});
