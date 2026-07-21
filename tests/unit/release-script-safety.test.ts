import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const WORKFLOWS_PATH = path.join(REPO_ROOT, '.github/workflows');
const LAUNCHER_PATH = path.join(REPO_ROOT, 'packages/launcher/bin/kangentic.js');
const PUBLICATION_SURFACE_PATHS = [
  '.github/workflows/release.yml',
  '.github/workflows/publish-release.yml',
  '.github/workflows/publish-protocol.yml',
  'scripts/assert-public-release-approved.js',
] as const;
const PUBLICATION_COMMAND_PATTERNS = [
  /\bnpm\s+publish\b/g,
  /\bgh\s+release\s+(?:create|upload|edit)\b/g,
  /\b(?:electron-builder|npm\s+run\s+(?:make(?::(?:win|mac|linux))?|package))\b[^\r\n]*--publish(?:=|\s+)(?!["']?never["']?(?:\s|$))\S+/g,
] as const;

const packageManifestSchema = z.object({
  scripts: z.record(z.string(), z.string()),
});

function readPackageManifest(): z.infer<typeof packageManifestSchema> {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  return packageManifestSchema.parse(packageJson);
}

describe('release script safety', () => {
  it('removes repository-owned publication surfaces', () => {
    // Given the publication paths previously owned by this repository
    const existingPublicationSurfaces = PUBLICATION_SURFACE_PATHS.filter((relativePath) => (
      fs.existsSync(path.join(REPO_ROOT, relativePath))
    ));

    // Then no publication workflow or public-release gate remains
    expect(existingPublicationSurfaces).toEqual([]);
  });

  it('keeps every workflow free of publication commands', () => {
    // Given every workflow YAML file, regardless of its filename
    const workflowPaths = fs.readdirSync(WORKFLOWS_PATH, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => path.join(WORKFLOWS_PATH, entry.name));

    // When non-comment workflow content is scanned for publication mutations
    const publicationCommands = workflowPaths.flatMap((workflowPath) => {
      const workflowSource = fs.readFileSync(workflowPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('#'))
        .map((line) => line.replace(/\s+#.*$/, ''))
        .join('\n');
      return PUBLICATION_COMMAND_PATTERNS.flatMap((pattern) => (
        (workflowSource.match(pattern) ?? []).map((command) => `${path.basename(workflowPath)}: ${command}`)
      ));
    });

    // Then renamed or newly added workflows cannot publish packages or releases
    expect(publicationCommands).toEqual([]);
  });

  it('makes the Windows package without publishing', () => {
    // Given the root package manifest parsed at the external file boundary
    const packageManifest = readPackageManifest();

    // When the Windows packaging command is inspected
    const windowsPackagingCommand = packageManifest.scripts['make:win'];

    // Then electron-builder is explicitly prevented from uploading
    expect(windowsPackagingCommand).toBe('npm run rebuild && npm run build && electron-builder --win --publish never');
  });

  it('keeps the launcher pointed at the upstream repository', () => {
    // Given the intentionally retained launcher implementation
    const launcherSource = fs.readFileSync(LAUNCHER_PATH, 'utf8');

    // When its repository owner is inspected
    const repositoryOwnerDeclaration = launcherSource.match(/^const REPO_OWNER = .+;$/m)?.[0];

    // Then the private workspace cannot redirect the public launcher to the fork
    expect(repositoryOwnerDeclaration).toBe("const REPO_OWNER = 'Kangentic';");
  });
});
