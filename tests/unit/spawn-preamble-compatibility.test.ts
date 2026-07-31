import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/shared/types';

const adapter = {
  getCompatibilityRequirement: vi.fn(() => ({
    acknowledgementId: 'runtime-default-v1',
    title: 'Runtime default required',
    description: 'Acknowledge the runtime default before continuing.',
  })),
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => adapter) },
}));

import { runSpawnPreamble } from '../../src/main/transition-engine/spawn-preamble';

const task = {
  id: 'task-1',
  agent: null,
  agent_override: 'opencode',
  model_override: null,
  effort_override: null,
  permission_mode: 'plan',
  run_mode: 'column_settings',
  profile_id: null,
} as Task;

describe('runSpawnPreamble compatibility gate', () => {
  it('returns compatibility-required after resolving the effective adapter and permission', () => {
    // Given
    const update = vi.fn();

    // When
    const result = runSpawnPreamble({
      task,
      projectId: 'project-1',
      hasSessionRecord: false,
      settingsLane: null,
      destinationLane: { agent_override: null, permission_mode: null },
      project: { default_agent: 'claude', default_model: null, default_effort: null },
      globalPermissionMode: () => 'default',
      compatibilityAcknowledgements: {},
      tasks: { update },
    });

    // Then
    expect(result).toEqual({
      kind: 'compatibility-required',
      agent: 'opencode',
      isHandoff: false,
      permissionMode: 'plan',
      requirement: {
        requirementId: 'compatibility:project-1:task-1:runtime-default-v1',
        projectId: 'project-1',
        taskId: 'task-1',
        acknowledgementId: 'runtime-default-v1',
        title: 'Runtime default required',
        description: 'Acknowledge the runtime default before continuing.',
      },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('does not create a public requirement when no project identity is available', () => {
    // Given
    const update = vi.fn();

    // When
    const result = runSpawnPreamble({
      task,
      projectId: null,
      hasSessionRecord: false,
      settingsLane: null,
      destinationLane: { agent_override: null, permission_mode: null },
      project: { default_agent: 'claude', default_model: null, default_effort: null },
      globalPermissionMode: () => 'default',
      compatibilityAcknowledgements: {},
      tasks: { update },
    });

    // Then
    expect(result).toMatchObject({ kind: 'ready', permissionMode: 'plan' });
  });

  it('keeps a non-default Codex permission ready when its resolved adapter has no requirement', () => {
    // Given
    adapter.getCompatibilityRequirement.mockReturnValueOnce(null);
    const update = vi.fn();

    // When
    const result = runSpawnPreamble({
      task: { ...task, agent_override: 'codex' },
      projectId: 'project-1',
      hasSessionRecord: false,
      settingsLane: null,
      destinationLane: { agent_override: null, permission_mode: null },
      project: { default_agent: 'claude', default_model: null, default_effort: null },
      globalPermissionMode: () => 'default',
      compatibilityAcknowledgements: {},
      tasks: { update },
    });

    // Then
    expect(result).toMatchObject({ kind: 'ready', agent: 'codex', permissionMode: 'plan' });
  });
});
