import { describe, expect, it } from 'vitest';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

const nonDefaultPermissionModes = [
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'auto',
] as const satisfies readonly PermissionMode[];

describe('OpenCodeAdapter compatibility requirement', () => {
  it('declares preservation of the existing permission mode on agent selection', () => {
    // Given
    const adapter: AgentAdapter = new OpenCodeAdapter();

    // When
    const preserveLegacyPermissionOnAgentSelection = adapter.preserveLegacyPermissionOnAgentSelection;

    // Then
    expect(preserveLegacyPermissionOnAgentSelection).toBe(true);
  });

  it('returns no compatibility requirement for runtime default mode', () => {
    // Given
    const adapter: AgentAdapter = new OpenCodeAdapter();

    // When
    const requirement = adapter.getCompatibilityRequirement?.('default');

    // Then
    expect(requirement).toBeNull();
  });

  it.each(nonDefaultPermissionModes)('describes the resolved %s permission for runtime default mode', (permissionMode) => {
    // Given
    const adapter: AgentAdapter = new OpenCodeAdapter();

    // When
    const requirement = adapter.getCompatibilityRequirement?.(permissionMode);

    // Then
    expect(requirement).toMatchObject({
      acknowledgementId: 'opencode-runtime-default-v1',
      title: 'OpenCode runtime default',
      description: `OpenCode resolves ${permissionMode} to its runtime-configured default approval configuration instead of Kangentic permission-mode overrides.`,
    });
  });
});
