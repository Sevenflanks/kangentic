import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type SourceFile = {
  readonly path: string;
  readonly contents: string;
};

const repositoryRoot = process.cwd();

function readSourceFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function sourceFiles(path: string): readonly SourceFile[] {
  const directory = resolve(repositoryRoot, path);

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    const relativePath = relative(repositoryRoot, entryPath);

    if (entry.isDirectory()) return sourceFiles(relativePath);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) return [];

    return [{ path: relativePath, contents: readFileSync(entryPath, 'utf8') }];
  });
}

function normalized(source: string): string {
  return source.replace(/\s+/g, ' ');
}

function interfaceFields(source: string, name: string): readonly string[] {
  const declaration = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`);
  const body = source.match(declaration)?.[1];

  if (body === undefined) throw new Error(`Missing ${name} declaration`);

  return [...body.matchAll(/readonly\s+(\w+)\??:/g)].map((match) => match[1]);
}

function importedTypeNames(source: string, moduleSpecifier: string): readonly string[] {
  const escapedModuleSpecifier = moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    `import type\\s*\\{([^{}]*)\\}\\s*from\\s*['"]${escapedModuleSpecifier}['"];?`,
  );
  const names = source.match(declaration)?.[1];

  return names === undefined
    ? []
    : names.split(',').map((name) => name.trim()).filter(Boolean).sort();
}

describe('agent adapter auto-command policy contract', () => {
  it('keeps main-private disposition imports out of shared production sources', () => {
    // Given
    const sharedFiles = sourceFiles('src/shared');
    const productionFiles = sourceFiles('src');

    // When
    const dispositionImporters = productionFiles
      .filter((file) => file.contents.includes('auto-command-disposition'))
      .map((file) => file.path);
    const mainImports = sharedFiles
      .filter((file) => /\bfrom\s+['"][^'"]*\/main\//.test(file.contents))
      .map((file) => file.path);

    // Then
    expect(dispositionImporters).toContain(join('src', 'main', 'agent', 'agent-adapter.ts'));
    expect(dispositionImporters.every((path) => path.replace(/\\/g, '/').startsWith('src/main/'))).toBe(true);
    expect(mainImports).toEqual([]);
  });

  it('defines the skip reason once in the shared safe module', () => {
    // Given
    const productionFiles = sourceFiles('src');

    // When
    const definitions = productionFiles
      .filter((file) => /(?:export\s+)?type\s+AutoCommandSkipReason\b/.test(file.contents))
      .map((file) => file.path);

    // Then
    expect(definitions).toEqual([join('src', 'shared', 'auto-command-outcome.ts')]);
  });

  it('limits immediate outcomes and shared DTOs to safe pre-settlement fields', () => {
    // Given
    const outcomeSource = readSourceFile('src/shared/auto-command-outcome.ts');

    // When
    const outcomeKinds = [...outcomeSource.matchAll(/kind:\s*'([^']+)'/g)]
      .map((match) => match[1])
      .sort();
    const transports = [...outcomeSource.matchAll(/transport:\s*'([^']+)'/g)]
      .map((match) => match[1])
      .sort();

    // Then
    expect(outcomeKinds).toEqual(['not-applicable', 'scheduled', 'scheduled', 'skipped']);
    expect(transports).toEqual(['legacy', 'native-idle']);
    expect(outcomeSource).not.toMatch(/\b(?:delivered|failed)\b/);
    expect(outcomeSource).not.toMatch(/\b(?:policy|fingerprint|nativeEvidence|nativeIdleEvidence|nativeSessionId|rootNativeSessionId|sessionGeneration|inputGeneration|sessionId|command|cwd|path|raw)\b/);
    expect(interfaceFields(outcomeSource, 'AutoCommandWarning')).toEqual([
      'projectId',
      'taskId',
      'reason',
      'message',
      'at',
    ]);
    expect(interfaceFields(outcomeSource, 'TaskMoveResult')).toEqual(['ok', 'autoCommand']);
  });

  it('reuses the existing task move input and exposes the structured result signature', () => {
    // Given
    const productionFiles = sourceFiles('src');
    const sharedTypesSource = readSourceFile('src/shared/types.ts');

    // When
    const taskMoveInputDefinitions = productionFiles
      .filter((file) => /\b(?:interface|type)\s+TaskMoveInput\b/.test(file.contents))
      .map((file) => file.path);

    // Then
    expect(taskMoveInputDefinitions).toEqual([join('src', 'shared', 'types.ts')]);
    expect(normalized(sharedTypesSource)).toContain(
      'move: (input: TaskMoveInput, projectId?: string | null) => Promise<TaskMoveResult>;',
    );
  });

  it('keeps the adapter disposition hook optional and main-private', () => {
    // Given
    const agentAdapterSource = readSourceFile('src/main/agent/agent-adapter.ts');
    const dispositionSource = readSourceFile('src/main/agent/auto-command-disposition.ts');

    // When
    const adapterContract = normalized(agentAdapterSource);
    const adapterDispositionTypes = importedTypeNames(agentAdapterSource, './auto-command-disposition');
    const dispositionSharedOutcomeTypes = importedTypeNames(
      dispositionSource,
      '../../shared/auto-command-outcome',
    );

    // Then
    expect(adapterContract).toContain(
      'getAutoCommandDisposition?(input: AutoCommandDispositionInput): AutoCommandDisposition;',
    );
    expect(adapterDispositionTypes).toEqual(['AutoCommandDisposition', 'AutoCommandDispositionInput']);
    expect(dispositionSharedOutcomeTypes).toEqual(['AutoCommandImmediateOutcome', 'AutoCommandSkipReason']);
    expect(adapterContract).not.toContain('AutoCommandGateResult');
    expect(adapterContract).not.toContain('LiveDeliveryRegistration');
  });
});
