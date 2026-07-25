import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export const INITIAL_PROMPT_PATH_ENV = 'KANGENTIC_OPENCODE_INITIAL_PROMPT_PATH';
export const EVENTS_PATH_ENV = 'KANGENTIC_EVENTS_PATH';

type InitialPromptPayload = {
  readonly version: number;
  readonly mode: 'fresh' | 'resume';
  readonly prompt: string;
  readonly sessionId?: string;
  readonly agent?: string;
  readonly model?: {
    readonly providerID: string;
    readonly modelID: string;
  };
};

export function createOpenCodePluginFixture() {
  const temporaryDirectories: string[] = [];

  function makeTemporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-plugin-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  function writePayload(directory: string, payload: InitialPromptPayload): string {
    const sourcePath = path.join(directory, 'opencode-initial-prompt.json');
    fs.writeFileSync(sourcePath, JSON.stringify(payload), 'utf8');
    return sourcePath;
  }

  function readEvents(eventsPath: string): readonly Record<string, unknown>[] {
    if (!fs.existsSync(eventsPath)) return [];
    return fs.readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function makeRootClient(createdSessionId = 'ses_created_123') {
    const create = vi.fn(async () => ({ data: { id: createdSessionId } }));
    const get = vi.fn(async () => ({ data: { id: createdSessionId } }));
    const promptAsync = vi.fn(async () => undefined);
    const publish = vi.fn(async () => ({ data: true }));
    const command = vi.fn(async () => undefined);

    return {
      client: {
        session: { create, get, promptAsync, command },
        tui: { publish },
      },
      create,
      get,
      promptAsync,
      publish,
      command,
    };
  }

  async function loadPlugin() {
    vi.resetModules();
    return import('../../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs');
  }

  function cleanup(): void {
    delete process.env[INITIAL_PROMPT_PATH_ENV];
    delete process.env[EVENTS_PATH_ENV];
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  }

  return {
    cleanup,
    loadPlugin,
    makeRootClient,
    makeTemporaryDirectory,
    readEvents,
    writePayload,
  };
}
