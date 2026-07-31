import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDirectory: string;

beforeEach(() => {
  dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-compatibility-config-'));
  process.env.KANGENTIC_DATA_DIR = dataDirectory;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KANGENTIC_DATA_DIR;
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

async function createConfigManager() {
  const { ConfigManager } = await import('../../src/main/config/config-manager');
  return new ConfigManager();
}

function writeProjectOverrides(projectPath: string, overrides: Record<string, unknown>): void {
  const configDirectory = path.join(projectPath, '.kangentic');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, 'config.json'), JSON.stringify(overrides));
}

describe('ConfigManager compatibility acknowledgements', () => {
  it('initializes compatibility acknowledgements as an empty dictionary', async () => {
    // Given
    const configManager = await createConfigManager();

    // When
    const config = configManager.load();

    // Then
    expect(config.compatibilityAcknowledgements).toEqual({});
  });

  it('replaces the acknowledgement dictionary during a full config save', async () => {
    // Given
    const configManager = await createConfigManager();
    configManager.save({ compatibilityAcknowledgements: { 'previous-notice': true } });

    // When
    configManager.save({ compatibilityAcknowledgements: { 'current-notice': true } });

    // Then
    expect(configManager.load().compatibilityAcknowledgements).toEqual({ 'current-notice': true });
  });

  it('inherits global acknowledgements into effective project config when the project omits them', async () => {
    // Given
    const projectPath = path.join(dataDirectory, 'project-without-acknowledgements');
    writeProjectOverrides(projectPath, {
      theme: 'forest',
      agent: { permissionMode: 'bypassPermissions' },
      git: { worktreesEnabled: false },
    });
    const configManager = await createConfigManager();
    configManager.save({ compatibilityAcknowledgements: { 'global-notice': true } });

    // When
    const effectiveConfig = configManager.getEffectiveConfig(projectPath);

    // Then
    expect(effectiveConfig.compatibilityAcknowledgements).toEqual({ 'global-notice': true });
  });

  it('merges project acknowledgement entries over global acknowledgements using dictionary semantics', async () => {
    // Given
    const projectPath = path.join(dataDirectory, 'project-with-acknowledgements');
    writeProjectOverrides(projectPath, {
      theme: 'forest',
      agent: { permissionMode: 'bypassPermissions' },
      git: { worktreesEnabled: false },
      compatibilityAcknowledgements: {
        'shared-notice': false,
      },
    });
    const configManager = await createConfigManager();
    configManager.save({
      compatibilityAcknowledgements: {
        'global-notice': true,
        'shared-notice': true,
      },
    });
    configManager.acknowledgeProjectCompatibility(projectPath, 'project-notice');

    // When
    vi.resetModules();
    const reloadedConfigManager = await createConfigManager();
    const projectOverrides = reloadedConfigManager.loadProjectOverrides(projectPath);
    const effectiveConfig = reloadedConfigManager.getEffectiveConfig(projectPath);

    // Then
    expect(projectOverrides).toMatchObject({
      theme: 'forest',
      agent: { permissionMode: 'bypassPermissions' },
      git: { worktreesEnabled: false },
      compatibilityAcknowledgements: {
        'shared-notice': false,
        'project-notice': true,
      },
    });
    expect(effectiveConfig.agent.permissionMode).toBe('bypassPermissions');
    expect(effectiveConfig.compatibilityAcknowledgements).toEqual({
      'global-notice': true,
      'shared-notice': false,
      'project-notice': true,
    });

    const otherProjectPath = path.join(dataDirectory, 'other-project');
    writeProjectOverrides(otherProjectPath, {
      theme: 'sky',
      agent: { permissionMode: 'plan' },
      compatibilityAcknowledgements: { 'other-notice': true },
    });
    const otherOverrides = reloadedConfigManager.loadProjectOverrides(otherProjectPath);
    expect(otherOverrides).toEqual({
      theme: 'sky',
      agent: { permissionMode: 'plan' },
      compatibilityAcknowledgements: { 'other-notice': true },
    });
  });
});
