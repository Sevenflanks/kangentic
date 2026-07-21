import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOW_PATH = path.resolve(__dirname, '../../.github/workflows/ci.yml');
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const STABLE_CHECKS = {
  lint: 'Lint (ESLint)',
  typecheck: 'Type check (tsc)',
  unit: 'Unit tests (Vitest)',
  build: 'Build (production bundle)',
  ui: 'UI tests (Playwright)',
  e2e: 'E2E tests (Electron)',
} as const;

function assertStableCheckNames(workflow: string): void {
  const normalizedWorkflow = workflow.replaceAll('\r\n', '\n');

  for (const [jobKey, checkName] of Object.entries(STABLE_CHECKS)) {
    expect(normalizedWorkflow).toContain(`\n  ${jobKey}:\n    name: ${checkName}\n`);
  }
}

describe('fork CI trigger contract', () => {
  it('runs push and pull request checks for both integration branches', () => {
    expect(WORKFLOW).toMatch(/push:\s*\r?\n\s+branches: \[main, sevenflanks-main\]/);
    expect(WORKFLOW).toMatch(/pull_request:\s*\r?\n\s+branches: \[main, sevenflanks-main\]/);
    expect(WORKFLOW).toMatch(/workflow_dispatch:/);
  });

  it('preserves the six stable required check names', () => {
    assertStableCheckNames(WORKFLOW);
  });

  it('rejects a copied workflow when a job-level check name is renamed', () => {
    const renamedWorkflow = WORKFLOW.replace(
      '  lint:\n    name: Lint (ESLint)',
      '  lint:\n    name: Lint (Renamed)',
    );

    expect(() => assertStableCheckNames(renamedWorkflow)).toThrow();
  });
});
