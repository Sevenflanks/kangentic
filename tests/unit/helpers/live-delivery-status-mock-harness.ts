import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { LiveDeliveryStatus } from '../../../src/shared/live-delivery-status';
import type { ElectronAPI } from '../../../src/shared/types';

type LiveStatusMockWindow = {
  readonly electronAPI: {
    readonly sessions: Pick<ElectronAPI['sessions'], 'onLiveDeliveryStatus'>;
  };
};

type LiveStatusMockHarness = {
  readonly window: LiveStatusMockWindow;
  readonly fire: (status: LiveDeliveryStatus) => void;
};

function isLiveStatusMockWindow(
  value: Record<string, unknown>,
): value is Record<string, unknown> & LiveStatusMockWindow {
  const electronApi = value.electronAPI;
  if (typeof electronApi !== 'object' || electronApi === null || !('sessions' in electronApi)) return false;
  const sessions = electronApi.sessions;
  return typeof sessions === 'object'
    && sessions !== null
    && 'onLiveDeliveryStatus' in sessions
    && typeof sessions.onLiveDeliveryStatus === 'function';
}

export function loadLiveDeliveryStatusMockHarness(): LiveStatusMockHarness {
  const mockSource = readFileSync('tests/ui/mock-electron-api.js', 'utf8');
  const windowObject: Record<string, unknown> = {};
  runInNewContext(mockSource, { window: windowObject });
  if (!isLiveStatusMockWindow(windowObject)) throw new TypeError('live status mock API was not installed');
  return {
    window: windowObject,
    fire: (status) => {
      const fire = windowObject.__mockFireLiveDeliveryStatus;
      if (typeof fire !== 'function') throw new TypeError('live status mock fire hook was not installed');
      fire(status);
    },
  };
}
