import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = path.resolve(__dirname, '../..');
const GOVERNANCE_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'fork-governance.md');
const OVERVIEW_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'overview.md');
const WORKTREE_STRATEGY_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'worktree-strategy.md');
const BOARD_CONFIG_PATH = path.join(REPO_ROOT, 'kangentic.json');
const PACKAGE_MANIFEST_PATH = path.join(REPO_ROOT, 'package.json');
const LICENSE_PATH = path.join(REPO_ROOT, 'LICENSE');
const CLAUDE_DIRECTORY_PATH = path.join(REPO_ROOT, '.claude');
const UPSTREAM_CLA_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'cla.yml');
const UPSTREAM_CLA_DOCUMENT_PATH = path.join(REPO_ROOT, 'CLA.md');

const branchPolicySchema = z.object({
  upstreamMirror: z.object({
    name: z.literal('main'),
    locked: z.literal(true),
    remoteConfigured: z.literal(false),
  }),
  personalIntegration: z.object({
    name: z.literal('sevenflanks-main'),
    personalBranchesStartFrom: z.literal('sevenflanks-main'),
    personalBranchesReturnTo: z.literal('sevenflanks-main'),
  }),
  upstreamContribution: z.object({
    startsFrom: z.literal('main'),
    requiresCleanBase: z.literal(true),
  }),
});

const contributionPolicySchema = z.object({
  license: z.literal('AGPL-3.0-only'),
  upstreamClaAutomation: z.literal('disabled'),
  upstreamClaDocument: z.literal('absent'),
});

const governanceContractSchema = z.object({
  schemaVersion: z.literal(1),
  license: z.literal('AGPL-3.0-only'),
  branches: branchPolicySchema,
  boardConfig: z.object({
    defaultBaseBranch: z.literal('sevenflanks-main'),
    gitTrackingEffect: z.literal('none'),
  }),
  release: z.object({
    upstreamIdentity: z.literal('blocked'),
    blocker: z.literal('branding-decision'),
    distributionMode: z.literal('local-only'),
    windowsPackaging: z.literal('local-unsigned-only'),
    macosPackaging: z.literal('retained-upstream-development-only-unapproved'),
    linuxPackaging: z.literal('retained-upstream-development-only-unapproved'),
    publicArtifacts: z.literal('disabled'),
    npmPublication: z.literal('disabled'),
    autoUpdateFeed: z.literal('disabled'),
  }),
  repository: z.object({
    claudeDirectory: z.literal('intentionally-absent'),
    externalProjectClaudeContent: z.literal('supported'),
  }),
  contributions: contributionPolicySchema,
});

const boardConfigSchema = z.object({
  defaultBaseBranch: z.literal('sevenflanks-main'),
});

const packageManifestSchema = z.object({
  license: z.literal('AGPL-3.0-only'),
  scripts: z.object({
    'make:win': z.literal('npm run rebuild && npm run build && electron-builder --win --publish never'),
    'make:mac': z.literal('npm run rebuild && npm run build && electron-builder --mac'),
    'make:linux': z.literal('npm run rebuild && npm run build && electron-builder --linux'),
  }),
});

function readRequiredFile(filePath: string): string {
  // Given an explicit repository contract file
  const exists = fs.existsSync(filePath);

  // When the test loads that contract
  expect(exists, `Required contract file is missing: ${filePath}`).toBe(true);

  // Then the file is read without discovering or traversing other paths
  return fs.readFileSync(filePath, 'utf-8');
}

function readGovernanceContractJson(): unknown {
  const document = readRequiredFile(GOVERNANCE_DOCUMENT_PATH);
  const contractBlock = document.match(/## 機器可驗證契約[\s\S]*?```json\s*([\s\S]*?)\s*```/);
  expect(contractBlock, 'fork-governance.md must contain its structured contract').not.toBeNull();
  return JSON.parse(contractBlock?.[1] ?? 'null');
}

function readGovernanceContract(): z.infer<typeof governanceContractSchema> {
  return governanceContractSchema.parse(readGovernanceContractJson());
}

describe('fork governance contract', () => {
  it('locks main as the upstream mirror and uses sevenflanks-main as the personal integration trunk', () => {
    // Given the documented branch policy
    const branches = readGovernanceContract().branches;

    // When each mainline role is evaluated
    const policy = branchPolicySchema.parse(branches);

    // Then personal and upstream work use separate, explicit branch flows
    expect(policy.upstreamMirror).toEqual({ name: 'main', locked: true, remoteConfigured: false });
    expect(policy.personalIntegration).toEqual({
      name: 'sevenflanks-main',
      personalBranchesStartFrom: 'sevenflanks-main',
      personalBranchesReturnTo: 'sevenflanks-main',
    });
    expect(policy.upstreamContribution).toEqual({ startsFrom: 'main', requiresCleanBase: true });
  });

  it('uses defaultBaseBranch only as the worktree base and never as Git tracking configuration', () => {
    // Given the board config and documented setting scope
    const boardConfig = boardConfigSchema.parse(JSON.parse(readRequiredFile(BOARD_CONFIG_PATH)));
    const documentedConfig = readGovernanceContract().boardConfig;

    // When the configured default branch is compared with its governance semantics
    const configuredBranch = boardConfig.defaultBaseBranch;

    // Then the default targets the personal trunk without changing Git tracking
    expect(configuredBranch).toBe('sevenflanks-main');
    expect(documentedConfig).toEqual({ defaultBaseBranch: 'sevenflanks-main', gitTrackingEffect: 'none' });
  });

  it('keeps the fork and its governance changes AGPL-3.0-only', () => {
    // Given the package manifest, root license, and governance contract
    const packageManifest = packageManifestSchema.parse(JSON.parse(readRequiredFile(PACKAGE_MANIFEST_PATH)));
    const license = readRequiredFile(LICENSE_PATH);
    const governanceLicense = readGovernanceContract().license;

    // When all explicit license declarations are evaluated
    const hasAgplV3LicenseText = license.includes('GNU AFFERO GENERAL PUBLIC LICENSE')
      && license.includes('Version 3, 19 November 2007');

    // Then no governance artifact introduces a different license
    expect(packageManifest.license).toBe('AGPL-3.0-only');
    expect(governanceLicense).toBe('AGPL-3.0-only');
    expect(hasAgplV3LicenseText).toBe(true);
  });

  it('blocks upstream-identity releases and locks distribution to local unsigned Windows packaging', () => {
    // Given the documented release policy
    const release = readGovernanceContract().release;

    // When the approved distribution boundary is evaluated
    const distribution = release;

    // Then only local unsigned Windows packaging remains enabled
    expect(distribution).toEqual({
      upstreamIdentity: 'blocked',
      blocker: 'branding-decision',
      distributionMode: 'local-only',
      windowsPackaging: 'local-unsigned-only',
      macosPackaging: 'retained-upstream-development-only-unapproved',
      linuxPackaging: 'retained-upstream-development-only-unapproved',
      publicArtifacts: 'disabled',
      npmPublication: 'disabled',
      autoUpdateFeed: 'disabled',
    });
  });

  it('retains upstream macOS and Linux packaging scripts without approving their distribution', () => {
    // Given the package scripts and documented release policy
    const packageManifest = packageManifestSchema.parse(JSON.parse(readRequiredFile(PACKAGE_MANIFEST_PATH)));
    const release = readGovernanceContract().release;

    // When retained platform tooling is evaluated
    const scripts = packageManifest.scripts;

    // Then the scripts remain exact while both platforms stay explicitly unapproved
    expect(scripts).toEqual({
      'make:win': 'npm run rebuild && npm run build && electron-builder --win --publish never',
      'make:mac': 'npm run rebuild && npm run build && electron-builder --mac',
      'make:linux': 'npm run rebuild && npm run build && electron-builder --linux',
    });
    expect(release.macosPackaging).toBe('retained-upstream-development-only-unapproved');
    expect(release.linuxPackaging).toBe('retained-upstream-development-only-unapproved');
  });

  it('keeps distribution and live-session transition documentation within the fork contract', () => {
    const overview = readRequiredFile(OVERVIEW_DOCUMENT_PATH);
    const worktreeStrategy = readRequiredFile(WORKTREE_STRATEGY_DOCUMENT_PATH);
    const falseLiveSettingsClaims = [
      ['README.md', /live-applies changes as cards cross columns: no restart/],
      ['docs/session-lifecycle.md', /permission mode\s+forces this suspend \+ respawn cycle/],
      ['docs/configuration.md', /model_override[^\n]*Live-applied via `\/model`/],
      ['docs/user-guide.md', /supports live model changes \(Claude's `\/model`\)/],
      ['docs/agent-integration.md', /changing model\/effort on a live session without respawn/],
      ['docs/command-injection.md', /which `\/model` \/ `\/effort`\s+slashes a column transition emits/],
      ['docs/database.md', /Live-applied to running sessions via adapter-specific slash injection/],
      ['docs/database.md', /a move injects `\/model` or `\/effort`/],
      ['docs/configuration.md', /switch models\/effort without restarting the session/],
      ['docs/transition-engine.md', /writes Ctrl\+C → text → Esc → Enter/],
    ] as const;
    for (const [relativePath, falseClaim] of falseLiveSettingsClaims) {
      expect.soft(readRequiredFile(path.join(REPO_ROOT, relativePath))).not.toMatch(falseClaim);
    }

    expect(overview).not.toContain('Native installers for Windows (NSIS), macOS (DMG), and Linux (deb/rpm).');
    expect(overview).toContain('Only approved fork distribution: local unsigned Windows `npm run make:win`.');
    expect(overview).toContain('Kangentic runs across Windows, macOS, and Linux');
    expect(overview).toContain('unsupported, unverified, and unapproved upstream development tooling.');
    expect(worktreeStrategy).not.toContain('suspend and resume with command as prompt');
    expect(worktreeStrategy).toMatch(
      /same-track, same-agent, same-model live session stays live and injects\s+supported auto_command and effort changes; an unsupported concrete effort target can\s+respawn, while permission-only changes or no setting delta stay live/,
    );
  });

  it('keeps repository-local .claude absent while supporting content in external user projects', () => {
    // Given the documented repository instruction policy
    const repository = readGovernanceContract().repository;

    // When repository-local and external-project support are evaluated separately
    const claudeDirectoryExists = fs.existsSync(CLAUDE_DIRECTORY_PATH);

    // Then this repository stays clean without removing the product feature
    expect(repository).toEqual({
      claudeDirectory: 'intentionally-absent',
      externalProjectClaudeContent: 'supported',
    });
    expect(claudeDirectoryExists).toBe(false);
  });

  it('accepts fork contributions under AGPL-3.0-only without upstream CLA artifacts', () => {
    // Given the documented contribution policy
    const contributionContract = z.object({ contributions: contributionPolicySchema })
      .safeParse(readGovernanceContractJson());

    // When the fork contribution contract and repository artifacts are evaluated
    const upstreamClaWorkflowExists = fs.existsSync(UPSTREAM_CLA_WORKFLOW_PATH);
    const upstreamClaDocumentExists = fs.existsSync(UPSTREAM_CLA_DOCUMENT_PATH);

    // Then the fork neither automates nor presents the upstream CLA
    expect.soft(contributionContract.success).toBe(true);
    expect.soft(upstreamClaWorkflowExists).toBe(false);
    expect.soft(upstreamClaDocumentExists).toBe(false);
    expect(contributionContract.success ? contributionContract.data.contributions : null).toEqual({
      license: 'AGPL-3.0-only',
      upstreamClaAutomation: 'disabled',
      upstreamClaDocument: 'absent',
    });
  });
});
