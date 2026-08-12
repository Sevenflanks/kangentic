import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export const INITIAL_PROMPT_PATH_ENV = 'KANGENTIC_OPENCODE_INITIAL_PROMPT_PATH';
export const TUI_INITIAL_PROMPT_PATH_ENV = 'KANGENTIC_OPENCODE_TUI_INITIAL_PROMPT_PATH';
export const RESUME_SESSION_ID_ENV = 'KANGENTIC_OPENCODE_RESUME_SESSION_ID';
export const TUI_CONFIG_PATH_ENV = 'OPENCODE_TUI_CONFIG';
export const EVENTS_PATH_ENV = 'KANGENTIC_EVENTS_PATH';

const BOOTSTRAP_ENV_KEYS = [
  INITIAL_PROMPT_PATH_ENV,
  TUI_INITIAL_PROMPT_PATH_ENV,
  RESUME_SESSION_ID_ENV,
  TUI_CONFIG_PATH_ENV,
  EVENTS_PATH_ENV,
] as const;

type BootstrapEnvKey = (typeof BOOTSTRAP_ENV_KEYS)[number];

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] = () => undefined;
  let reject: Deferred<T>['reject'] = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type InitialPromptPayload = {
  readonly version: number;
  readonly mode: 'fresh' | 'resume';
  readonly prompt: string;
  readonly sessionId?: string;
  readonly model?: {
    readonly providerID: string;
    readonly modelID: string;
  };
};

export function createOpenCodePluginFixture() {
  const temporaryDirectories: string[] = [];
  const inheritedBootstrapEnvironment = new Map<BootstrapEnvKey, string | undefined>(
    BOOTSTRAP_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );

  function clearBootstrapEnvironment(): void {
    for (const key of BOOTSTRAP_ENV_KEYS) {
      delete process.env[key];
    }
  }

  function restoreBootstrapEnvironment(): void {
    for (const key of BOOTSTRAP_ENV_KEYS) {
      const inheritedValue = inheritedBootstrapEnvironment.get(key);
      if (inheritedValue === undefined) delete process.env[key];
      else process.env[key] = inheritedValue;
    }
  }

  clearBootstrapEnvironment();

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
    const createCalled = createDeferred<void>();
    const getCalled = createDeferred<void>();
    const promptCalled = createDeferred<void>();
    const publishCalled = createDeferred<void>();
    const create = vi.fn(async () => {
      createCalled.resolve(undefined);
      return { data: { id: createdSessionId } };
    });
    const get = vi.fn(async () => {
      getCalled.resolve(undefined);
      return { data: { id: createdSessionId } };
    });
    const promptAsync = vi.fn(async () => {
      promptCalled.resolve(undefined);
    });
    const publish = vi.fn(async () => {
      publishCalled.resolve(undefined);
      return { data: true };
    });
    const command = vi.fn(async () => undefined);

    return {
      client: {
        session: { create, get, promptAsync, command },
        tui: { publish },
      },
      create,
      createCalled,
      get,
      getCalled,
      promptAsync,
      promptCalled,
      publish,
      publishCalled,
      command,
    };
  }

  async function loadPlugin() {
    clearBootstrapEnvironment();
    vi.resetModules();
    return import('../../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs');
  }

  function cleanup(): void {
    restoreBootstrapEnvironment();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  }

  return {
    clearBootstrapEnvironment,
    cleanup,
    loadPlugin,
    makeRootClient,
    makeTemporaryDirectory,
    readEvents,
    writePayload,
  };
}
