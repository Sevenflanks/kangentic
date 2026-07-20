import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type ExtraResourceEntry = {
  readonly from: string;
  readonly to: string;
};

const REPO_ROOT = path.resolve(__dirname, '../..');
const ELECTRON_BUILDER_CONFIG_PATH = path.join(REPO_ROOT, 'electron-builder.yml');
const WINDOWS_SIGNER_PATH = path.join(REPO_ROOT, 'build/windowsSign.js');

function extractTopLevelBlock(yamlSource: string, topLevelKey: string): string {
  const match = yamlSource.match(new RegExp(`\\n${topLevelKey}:\\n((?:[ \\t].*\\n?)*)`));
  if (!match) {
    throw new Error(`electron-builder.yml: could not find top-level key "${topLevelKey}:"`);
  }
  return match[1];
}

function extractExtraResourcesEntries(yamlSource: string): readonly ExtraResourceEntry[] {
  const block = extractTopLevelBlock(yamlSource, 'extraResources');
  const entries: ExtraResourceEntry[] = [];
  const entryPattern = /-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    entries.push({ from: match[1], to: match[2] });
  }
  return entries;
}

describe('desktop package license compliance', () => {
  it('copies the canonical license and fork notice into readable resources', () => {
    // Given
    const electronBuilderConfig = fs.readFileSync(ELECTRON_BUILDER_CONFIG_PATH, 'utf-8');

    // When
    const extraResources = extractExtraResourcesEntries(electronBuilderConfig);

    // Then
    expect(extraResources).toContainEqual({ from: 'LICENSE', to: 'LICENSE' });
    expect(extraResources).toContainEqual({ from: 'FORK-NOTICE.md', to: 'FORK-NOTICE.md' });
  });

  it('disables electron-builder publication metadata', () => {
    // Given
    const electronBuilderConfig = fs.readFileSync(ELECTRON_BUILDER_CONFIG_PATH, 'utf-8');

    // When
    const publicationMetadata = {
      topLevelPublishLines: electronBuilderConfig.match(/^publish:.*$/gm) ?? [],
      indentedPublishLines: electronBuilderConfig.match(/^[ \t]+publish\s*:/gm) ?? [],
      providerLines: electronBuilderConfig.match(/^[ \t]*provider\s*:/gm) ?? [],
    };

    // Then
    expect(publicationMetadata).toEqual({
      topLevelPublishLines: ['publish: null'],
      indentedPublishLines: [],
      providerLines: [],
    });
  });

  it('keeps Windows packaging unsigned', () => {
    // Given the Windows packaging configuration and signer implementation path
    const electronBuilderConfig = fs.readFileSync(ELECTRON_BUILDER_CONFIG_PATH, 'utf-8');
    const winBlock = extractTopLevelBlock(electronBuilderConfig, 'win');

    // When signing surfaces are inspected
    const windowsSigningSurfaces = {
      signExtsBlocks: (winBlock.match(/^  signExts:\n(?:    - .*\n?)*/gm) ?? []).map((block) => block.trimEnd()),
      signtoolOptionsLines: electronBuilderConfig.match(/^[ \t]*signtoolOptions\s*:/gm) ?? [],
      signHookLines: electronBuilderConfig.match(/^[ \t]*sign\s*:/gm) ?? [],
      signerImplementationExists: fs.existsSync(WINDOWS_SIGNER_PATH),
    };

    // Then neither configuration nor environment variables can enable signing
    expect(windowsSigningSurfaces).toEqual({
      signExtsBlocks: ['  signExts:\n    - "!.exe"'],
      signtoolOptionsLines: [],
      signHookLines: [],
      signerImplementationExists: false,
    });
  });
});
