import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FORK_REPOSITORY_URL = 'git+https://github.com/Sevenflanks/kangentic.git';

const repositorySchema = z.object({
  type: z.literal('git'),
  url: z.literal(FORK_REPOSITORY_URL),
  directory: z.string().optional(),
});

const authorSchema = z
  .object({
    name: z.literal('Kangentic'),
    url: z.literal('https://github.com/Kangentic'),
  })
  .strict();

const rootManifestSchema = z.object({
  private: z.literal(true),
  workspaces: z.array(z.string()),
  repository: repositorySchema,
  author: authorSchema,
  license: z.literal('AGPL-3.0-only'),
});

const workspaceManifestSchema = z.object({
  private: z.literal(true),
  repository: repositorySchema,
  author: authorSchema,
  license: z.literal('AGPL-3.0-only'),
  files: z.array(z.string()),
});

const PACKAGE_CONTRACTS = [
  {
    directory: 'packages/launcher',
    files: ['bin/', 'LICENSE', 'FORK-NOTICE.md', 'README.md'],
  },
  {
    directory: 'packages/protocol',
    files: ['dist/', 'LICENSE', 'FORK-NOTICE.md', 'README.md'],
  },
] as const;

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

describe('npm package license compliance', () => {
  it('declares exactly the governed workspace set', () => {
    // Given the root package manifest and governed workspace contracts
    const rootManifest = rootManifestSchema.parse(readJson('package.json'));

    // When the npm workspace list is inspected
    const workspaceDirectories = PACKAGE_CONTRACTS.map(({ directory }) => directory);

    // Then every workspace is governed and no undeclared workspace exists
    expect(rootManifest.workspaces).toEqual(workspaceDirectories);
  });

  it('keeps the root and every workspace private', () => {
    // Given the root and workspace package manifests
    const packageManifests = [
      rootManifestSchema.parse(readJson('package.json')),
      ...PACKAGE_CONTRACTS.map(({ directory }) => (
        workspaceManifestSchema.parse(readJson(path.join(directory, 'package.json')))
      )),
    ];

    // When package privacy is evaluated
    const privacyFlags = packageManifests.map((manifest) => manifest.private);

    // Then no package can be published to npm
    expect(privacyFlags).toEqual([true, true, true]);
  });

  it('declares the fork repository and AGPL license in every package manifest', () => {
    // Given the root and workspace package manifests
    const rootManifest = rootManifestSchema.parse(readJson('package.json'));

    // When repository metadata is parsed at the package boundary
    const workspaceManifests = PACKAGE_CONTRACTS.map(({ directory }) => ({
      directory,
      manifest: workspaceManifestSchema.parse(readJson(path.join(directory, 'package.json'))),
    }));

    // Then every package points to the fork and each workspace identifies its monorepo directory
    expect(rootManifest.repository).toEqual({ type: 'git', url: FORK_REPOSITORY_URL });
    expect(rootManifest.license).toBe('AGPL-3.0-only');
    for (const { directory, manifest } of workspaceManifests) {
      expect(manifest.repository).toEqual({ type: 'git', url: FORK_REPOSITORY_URL, directory });
      expect(manifest.license).toBe('AGPL-3.0-only');
    }
  });

  it('declares the canonical author identity without email in every package manifest', () => {
    // Given the root and workspace package manifests
    const packageManifests = [
      rootManifestSchema.parse(readJson('package.json')),
      ...PACKAGE_CONTRACTS.map(({ directory }) => (
        workspaceManifestSchema.parse(readJson(path.join(directory, 'package.json')))
      )),
    ];

    // When the package author metadata is parsed at the boundary
    const authorIdentities = packageManifests.map((manifest) => manifest.author);

    // Then every package carries only the canonical name and URL
    expect(authorIdentities).toEqual([
      { name: 'Kangentic', url: 'https://github.com/Kangentic' },
      { name: 'Kangentic', url: 'https://github.com/Kangentic' },
      { name: 'Kangentic', url: 'https://github.com/Kangentic' },
    ]);
  });

  it('allows exactly the governed legal and runtime package files', () => {
    // Given each workspace package contract
    const workspaceManifests = PACKAGE_CONTRACTS.map((packageContract) => ({
      ...packageContract,
      manifest: workspaceManifestSchema.parse(readJson(path.join(packageContract.directory, 'package.json'))),
    }));

    // When the npm files allowlists are evaluated
    const packageFiles = workspaceManifests.map(({ directory, files, manifest }) => ({
      directory,
      expectedFiles: files,
      actualFiles: manifest.files,
    }));

    // Then every package explicitly includes its legal, README, and runtime files
    for (const { directory, expectedFiles, actualFiles } of packageFiles) {
      expect(actualFiles, `${directory} package files`).toEqual(expectedFiles);
    }
  });

  it('copies the canonical license and fork notice bytes into each workspace package', () => {
    // Given the canonical root legal artifacts
    const canonicalArtifacts = ['LICENSE', 'FORK-NOTICE.md'].map((fileName) => ({
      fileName,
      bytes: fs.readFileSync(path.join(REPO_ROOT, fileName)),
    }));

    // When each workspace legal artifact is located
    const packageArtifacts = PACKAGE_CONTRACTS.flatMap(({ directory }) => canonicalArtifacts.map((artifact) => ({
      ...artifact,
      directory,
      packagePath: path.join(REPO_ROOT, directory, artifact.fileName),
    })));

    // Then every package carries a byte-for-byte copy of the canonical artifact
    for (const artifact of packageArtifacts) {
      const exists = fs.existsSync(artifact.packagePath);
      expect(exists, `${artifact.directory}/${artifact.fileName} must exist`).toBe(true);
      if (exists) {
        expect(fs.readFileSync(artifact.packagePath).equals(artifact.bytes)).toBe(true);
      }
    }
  });
});
