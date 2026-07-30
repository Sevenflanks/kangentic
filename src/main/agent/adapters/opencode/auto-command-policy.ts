import type {
  AutoCommandDisposition,
  AutoCommandDispositionInput,
} from '../../auto-command-disposition';
import type { LiveSubmissionPolicy } from '../../agent-adapter';
import type { AutoCommandSkipReason } from '../../../../shared/auto-command-outcome';

function skip(reason: AutoCommandSkipReason): AutoCommandDisposition {
  return {
    kind: 'skip',
    reason,
    warning: buildOpenCodeAutoCommandWarning(reason),
  };
}

function privateAuthorizationFingerprint(
  input: AutoCommandDispositionInput,
  policy: Extract<LiveSubmissionPolicy, { mode: 'wait-for-native-idle' }>,
): string {
  return JSON.stringify([
    input.hasCommand,
    input.destinationAutoSpawn,
    input.lifecycle.kind,
    input.currentAgent,
    input.destinationAgent,
    input.currentTrack,
    input.destinationTrack,
    policy.mode,
    policy.timeoutMs,
    policy.cancelOnUserInput,
    policy.sendCtrlC,
    input.destinationLaneId,
    input.sequence,
  ]);
}

export function buildOpenCodeAutoCommandWarning(reason: AutoCommandSkipReason): string {
  switch (reason) {
    case 'no-active-main-session':
      return 'Auto-command was skipped because no active Main OpenCode session is available.';
    case 'native-evidence-unavailable':
      return 'Auto-command was skipped because required OpenCode native session evidence is unavailable.';
    case 'resume-not-supported':
      return 'Auto-command was skipped because OpenCode resume delivery is not supported.';
    case 'fresh-not-supported':
      return 'Auto-command was skipped because OpenCode fresh-session delivery is not supported.';
    case 'handoff-not-supported':
      return 'Auto-command was skipped because OpenCode handoff delivery is not supported.';
    case 'restart-required':
      return 'Auto-command was skipped because the OpenCode session requires a restart.';
    case 'isolated-session':
      return 'Auto-command was skipped because isolated sessions do not support live delivery.';
    default: {
      const exhaustiveReason: never = reason;
      return exhaustiveReason;
    }
  }
}

export function getOpenCodeAutoCommandDisposition(
  input: AutoCommandDispositionInput,
): AutoCommandDisposition {
  if (!input.hasCommand || !input.destinationAutoSpawn) {
    return { kind: 'not-applicable' };
  }

  // `null` 才是 canonical Main track；任何 swimlane ID 都是 isolated，必須先排除。
  if (input.currentTrack !== null || input.destinationTrack !== null) {
    return skip('isolated-session');
  }

  switch (input.lifecycle.kind) {
    case 'active-live':
      break;
    case 'handoff':
      return skip('handoff-not-supported');
    case 'restart':
      return skip('restart-required');
    case 'fresh':
      return skip('fresh-not-supported');
    case 'resume':
      return skip('resume-not-supported');
    default: {
      const exhaustiveLifecycle: never = input.lifecycle;
      return exhaustiveLifecycle;
    }
  }

  if (!input.currentSessionRunning
    || !input.currentSessionWritable
    || input.currentAgent === null) {
    return skip('no-active-main-session');
  }

  if (input.currentAgent !== 'opencode' || input.destinationAgent !== 'opencode') {
    return skip('restart-required');
  }

  if (input.rootNativeSessionId === null
    || input.sessionGeneration === null
    || input.inputGeneration === null) {
    return skip('native-evidence-unavailable');
  }

  const policy = input.liveSubmissionPolicy;
  if (policy?.mode !== 'wait-for-native-idle') {
    return skip('no-active-main-session');
  }

  if (policy.timeoutMs !== 120_000
    || policy.cancelOnUserInput !== true
    || policy.sendCtrlC !== false) {
    return skip('no-active-main-session');
  }

  return {
    kind: 'deliver-live',
    policy,
    fingerprint: privateAuthorizationFingerprint(input, policy),
  };
}
