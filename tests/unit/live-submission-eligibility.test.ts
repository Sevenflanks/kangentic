import { describe, expect, it } from 'vitest';
import type { LiveSubmissionPolicy } from '../../src/main/agent/agent-adapter';
import {
  prepareLiveSubmission,
} from '../../src/main/transition-engine/live-submission-eligibility';
import type { AutoCommandDisposition } from '../../src/main/agent/auto-command-disposition';

const WAIT_POLICY = {
  mode: 'wait-for-native-idle',
  timeoutMs: 120_000,
  cancelOnUserInput: true,
  sendCtrlC: false,
} satisfies LiveSubmissionPolicy;

const DELIVER_LIVE_DISPOSITION = {
  kind: 'deliver-live',
  policy: WAIT_POLICY,
  fingerprint: 'live-submission-fingerprint-1',
} satisfies AutoCommandDisposition;

const SKIP_DISPOSITION = {
  kind: 'skip',
  reason: 'no-active-main-session',
  warning: 'warning',
} satisfies AutoCommandDisposition;

const NOT_APPLICABLE_DISPOSITION = {
  kind: 'not-applicable',
} satisfies AutoCommandDisposition;

describe('prepareLiveSubmission', () => {
  it('returns null when the disposition is null', () => {
    expect(prepareLiveSubmission(null)).toBeNull();
  });

  it('projects the deliver-live policy and fingerprint exactly', () => {
    expect(prepareLiveSubmission(DELIVER_LIVE_DISPOSITION)).toEqual({
      policy: WAIT_POLICY,
      fingerprint: 'live-submission-fingerprint-1',
    });
  });

  it.each([
    ['skip', SKIP_DISPOSITION],
    ['not-applicable', NOT_APPLICABLE_DISPOSITION],
  ] satisfies ReadonlyArray<readonly [string, AutoCommandDisposition]>) (
    'returns null when the disposition is %s',
    (_label, disposition) => {
      expect(prepareLiveSubmission(disposition)).toBeNull();
    },
  );
});
