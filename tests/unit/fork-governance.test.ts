import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = path.resolve(__dirname, '../..');
const GOVERNANCE_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'fork-governance.md');
const OVERVIEW_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'overview.md');
const WORKTREE_STRATEGY_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'worktree-strategy.md');
const ARCHITECTURE_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'architecture.md');
const TRANSITION_ENGINE_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'transition-engine.md');
const COMMAND_INJECTION_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'command-injection.md');
const SESSION_LIFECYCLE_DOCUMENT_PATH = path.join(REPO_ROOT, 'docs', 'session-lifecycle.md');
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
    remoteConfigured: z.literal(true),
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
  const exists = fs.existsSync(filePath);

  expect(exists, `Required contract file is missing: ${filePath}`).toBe(true);

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

type ForbiddenOpenCodeDeliveryRelation = {
  readonly lifecycle: RegExp;
};

const forbiddenOpenCodeDeliveryRelations = [
  { lifecycle: /\b(?:new|fresh|freshly created) session\b/ },
  { lifecycle: /\bresume(?:s|d|ing)?\b/ },
  { lifecycle: /\b(?:after|post) spawn\b/ },
  { lifecycle: /\b(?:agent )?(?:handoff|switch(?:es|ed|ing)?)\b/ },
  { lifecycle: /\bpublic (?:activity|thinking)\b/ },
  { lifecycle: /\b(?:generic )?(?:timer|30 seconds?|30 second)\b/ },
] as const satisfies readonly ForbiddenOpenCodeDeliveryRelation[];

const commandAlias = '(?:auto command|configured (?:column )?command|column command|automation command)';
const deliveryAlias = '(?:send(?:s|ing)?|deliver(?:s|ed|ing)?|inject(?:s|ed|ing)?|schedul(?:e|es|ed|ing)|admit(?:s|ted|ting)|run(?:s|ning)?)';
const openCodeCommandPattern = new RegExp(`\\b${commandAlias}\\b`);
const deliveryOccurrencePattern = new RegExp(`\\b${deliveryAlias}\\b`, 'g');
const directlyNegatedDeliveryPattern = new RegExp(
  `\\b(?:(?:does|do|did|will) not|never)\\s+${deliveryAlias}\\b|\\b(?:is|was|are|were)\\s+not\\s+${deliveryAlias}\\b|\\bwill not be\\s+${deliveryAlias}\\b`,
  'g',
);

function normalizeGovernanceSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasUnnegatedPositiveDelivery(sentence: string): boolean {
  const directlyNegatedDeliverySpans = [...sentence.matchAll(directlyNegatedDeliveryPattern)]
    .flatMap((match) => match.index === undefined
      ? []
      : [{ start: match.index, end: match.index + match[0].length }]);

  return [...sentence.matchAll(deliveryOccurrencePattern)].some((match) => {
    if (match.index === undefined) return false;

    const start = match.index;
    const end = start + match[0].length;
    return !directlyNegatedDeliverySpans.some((span) => span.start <= start && end <= span.end);
  });
}

function hasForbiddenOpenCodeFallbackClaim(document: string): boolean {
  return document
    .split(/[.!?。]/)
    .map(normalizeGovernanceSentence)
    .some((sentence) => (
      sentence.includes('opencode')
      && openCodeCommandPattern.test(sentence)
      && hasUnnegatedPositiveDelivery(sentence)
      && forbiddenOpenCodeDeliveryRelations.some(({ lifecycle }) => lifecycle.test(sentence))
    ));
}

describe('fork governance contract', () => {
  it('locks main as the upstream mirror and uses sevenflanks-main as the personal integration trunk', () => {
    const branches = readGovernanceContract().branches;

    const policy = branchPolicySchema.parse(branches);

    expect(policy.upstreamMirror).toEqual({ name: 'main', locked: true, remoteConfigured: true });
    expect(policy.personalIntegration).toEqual({
      name: 'sevenflanks-main',
      personalBranchesStartFrom: 'sevenflanks-main',
      personalBranchesReturnTo: 'sevenflanks-main',
    });
    expect(policy.upstreamContribution).toEqual({ startsFrom: 'main', requiresCleanBase: true });
  });

  it('uses defaultBaseBranch only as the worktree base and never as Git tracking configuration', () => {
    const boardConfig = boardConfigSchema.parse(JSON.parse(readRequiredFile(BOARD_CONFIG_PATH)));
    const documentedConfig = readGovernanceContract().boardConfig;

    // When the configured default branch is compared with its governance semantics
    const configuredBranch = boardConfig.defaultBaseBranch;

    // Then the default targets the personal trunk without changing Git tracking
    expect(configuredBranch).toBe('sevenflanks-main');
    expect(documentedConfig).toEqual({ defaultBaseBranch: 'sevenflanks-main', gitTrackingEffect: 'none' });
  });

  it('keeps the fork and its governance changes AGPL-3.0-only', () => {
    const packageManifest = packageManifestSchema.parse(JSON.parse(readRequiredFile(PACKAGE_MANIFEST_PATH)));
    const license = readRequiredFile(LICENSE_PATH);
    const governanceLicense = readGovernanceContract().license;

    const hasAgplV3LicenseText = license.includes('GNU AFFERO GENERAL PUBLIC LICENSE')
      && license.includes('Version 3, 19 November 2007');

    expect(packageManifest.license).toBe('AGPL-3.0-only');
    expect(governanceLicense).toBe('AGPL-3.0-only');
    expect(hasAgplV3LicenseText).toBe(true);
  });

  it('blocks upstream-identity releases and locks distribution to local unsigned Windows packaging', () => {
    const release = readGovernanceContract().release;

    const distribution = release;

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

  it('keeps distribution and OpenCode active-session-only documentation within the fork contract', () => {
    const readme = readRequiredFile(path.join(REPO_ROOT, 'README.md'));
    const architecture = readRequiredFile(ARCHITECTURE_DOCUMENT_PATH);
    const transitionEngine = readRequiredFile(TRANSITION_ENGINE_DOCUMENT_PATH);
    const commandInjection = readRequiredFile(COMMAND_INJECTION_DOCUMENT_PATH);
    const sessionLifecycle = readRequiredFile(SESSION_LIFECYCLE_DOCUMENT_PATH);
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

    expect(readme).not.toContain('Model changes suspend and resume with new launch flags;');
    expect(transitionEngine).not.toContain('Transition action chains (priority 4) only fire when a task has no active session.');
    expect(readme).toContain('Only a changed, concrete effective model target restarts a live session; a null or unchanged target keeps it, while clearing an override can expose a changed project default.');
    expect(transitionEngine).toContain('The effective model target resolves task override, then lane override, then project default; only a changed, concrete result restarts a live session.');
    expect(overview).not.toContain('Native installers for Windows (NSIS), macOS (DMG), and Linux (deb/rpm).');
    expect(overview).toContain('Only approved fork distribution: local unsigned Windows `npm run make:win`.');
    expect(overview).toContain('Kangentic runs across Windows, macOS, and Linux');
    expect(overview).toContain('unsupported, unverified, and unapproved upstream development tooling.');
    expect(worktreeStrategy).not.toContain('suspend and resume with command as prompt');
    expect(worktreeStrategy).toMatch(
      /same-track, same-agent, same-model live session stays live and injects\s+supported auto_command and effort changes; an unsupported concrete effort target can\s+respawn, while permission-only changes or no setting delta stay live/,
    );

    const openCodeDocuments = [architecture, transitionEngine, commandInjection, sessionLifecycle];
    for (const document of openCodeDocuments) {
      expect(document).toMatch(/OpenCode[\s\S]{0,500}active[ -]writable[\s\S]{0,500}compatible[\s\S]{0,500}Main Session/i);
      expect(document).toMatch(/fresh[\s\S]{0,240}resume[\s\S]{0,240}handoff[\s\S]{0,240}restart[\s\S]{0,240}isolated[\s\S]{0,240}(?:skip|skipped)/i);
      expect(document).toMatch(/ordinary Task prompt[\s\S]{0,240}(?:separate|independent|intact)/i);
      expect(document).toMatch(/non-OpenCode[\s\S]{0,240}(?:legacy|existing)[\s\S]{0,240}(?:unchanged|intact)/i);
      expect(document).toMatch(/action-backed spawn[\s\S]{0,240}own prompt[\s\S]{0,240}central Auto-command disposition/i);
    }

    for (const document of openCodeDocuments) {
      expect(hasForbiddenOpenCodeFallbackClaim(document)).toBe(false);
    }

    expect(sessionLifecycle).toMatch(/non-OpenCode legacy[\s\S]{0,240}isolated reviewer/i);
    expect(sessionLifecycle).toMatch(/continuation prompt[\s\S]{0,240}intact/i);
  });

  it('rejects synonymous OpenCode lifecycle-to-delivery fallback claims', () => {
    const forbiddenFixtures = [
      'OpenCode sends the configured column command when it starts a fresh session.',
      'OpenCode delivers Auto-command when it resumes a session.',
      'OpenCode injects the configured column command after spawn.',
      'OpenCode schedules Auto-command during an agent handoff.',
      'OpenCode delivers the column command after public activity reports thinking.',
      'OpenCode admits Auto-command after a generic 30-second timer.',
      'OpenCode sends Auto-command after a fresh session, not through native idle.',
      'OpenCode schedules the configured column command after spawn while an unrelated safeguard is skipped.',
      'OpenCode runs the automation command after a freshly created session.',
      'OpenCode delivers Auto-command during agent switching.',
      'OpenCode Auto-command is delivered after a fresh session.',
      'OpenCode skips Auto-command for a fresh session but delivers it after a fresh session.',
      'OpenCode does not deliver Auto-command after a fresh session but schedules it after a fresh session.',
    ] as const;

    for (const fixture of forbiddenFixtures) {
      expect(hasForbiddenOpenCodeFallbackClaim(fixture)).toBe(true);
    }

    const compliantFixtures = [
      'OpenCode skips Auto-command for a fresh session.',
      'OpenCode does not deliver the configured column command after a handoff.',
      'OpenCode never injects the configured column command after public activity.',
      'OpenCode does not admit Auto-command after a generic 30-second timer.',
      'OpenCode never schedules the automation command after a freshly created session.',
      'OpenCode Auto-command is not delivered after a fresh session.',
    ] as const;

    for (const fixture of compliantFixtures) {
      expect(hasForbiddenOpenCodeFallbackClaim(fixture)).toBe(false);
    }
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
