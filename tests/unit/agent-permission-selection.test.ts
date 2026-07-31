import { describe, expect, it } from 'vitest';
import { resolvePermissionForAgent } from '../../src/shared/types';
import type { AgentDetectionInfo } from '../../src/shared/types';

function createAgent(overrides: Partial<AgentDetectionInfo> = {}): AgentDetectionInfo {
  return {
    name: 'runtime-default-agent',
    displayName: 'Runtime Default Agent',
    found: true,
    path: '/path/to/agent',
    version: '1.0.0',
    permissions: [{ mode: 'default', label: 'Runtime Default' }],
    defaultPermission: 'default',
    ...overrides,
  };
}

describe('resolvePermissionForAgent', () => {
  it('preserves a legacy permission mode when the selected agent declares the policy', () => {
    // Given
    const agents = [createAgent({ preserveLegacyPermissionOnAgentSelection: true })];

    // When
    const permissionMode = resolvePermissionForAgent(agents, 'runtime-default-agent', 'acceptEdits');

    // Then
    expect(permissionMode).toBe('acceptEdits');
  });

  it('uses the selected agent default when it lacks the policy and does not support the current mode', () => {
    // Given
    const agents = [createAgent()];

    // When
    const permissionMode = resolvePermissionForAgent(agents, 'runtime-default-agent', 'acceptEdits');

    // Then
    expect(permissionMode).toBe('default');
  });

  it('preserves a current mode supported by the selected agent without the policy', () => {
    // Given
    const agents = [createAgent({ permissions: [{ mode: 'acceptEdits', label: 'Accept Edits' }] })];

    // When
    const permissionMode = resolvePermissionForAgent(agents, 'runtime-default-agent', 'acceptEdits');

    // Then
    expect(permissionMode).toBe('acceptEdits');
  });
});
