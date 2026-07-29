/**
 * Unit tests for resolving and moving a task to the Done column via MCP
 * (kangentic_move_task with column: "Done").
 *
 * The Done swimlane is always seeded/persisted `is_archived: 1`, and
 * resolveColumn's default lookup filters archived lanes out - so before this
 * fix, `handleMoveTask` could not resolve "Done" by name even though the
 * downstream id-based handleTaskMove already handles the archive correctly.
 *
 * Uses a real in-memory better-sqlite3 DB run through the actual project
 * migrations (which seed the default swimlane set, including the archived
 * Done lane), mirroring the ABI-probe pattern from
 * mcp-move-task-to-project.test.ts so the suite skips cleanly if
 * better-sqlite3 cannot load under the test runner's Node ABI.
 *
 * Covers:
 *   - resolveColumn resolves "Done" by name only when includeArchivedDone is set
 *   - resolveColumn still rejects "Done" by name without the flag (regression
 *     for create_task / move_task_to_project, which keep the active-only filter)
 *   - handleMoveTask moves a task to Done, dispatching to onTaskMove with the
 *     archived Done lane's id
 *   - handleCreateTask still rejects column: "Done" (regression)
 *   - includeArchivedDone does NOT expose a non-Done archived lane by name -
 *     the fix's carve-out is scoped to role 'done', not "any archived lane"
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors mcp-move-task-to-project.test.ts / swimlane-repository.test.ts.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { resolveColumn } from '../../src/main/agent/commands/column-resolver';
import { handleMoveTask, handleCreateTask } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { AutoCommandImmediateOutcome, TaskMoveResult } from '../../src/shared/auto-command-outcome';

function makeContext(db: InstanceType<typeof DatabaseType>, projectPath: string): CommandContext & {
  onTaskCreated: ReturnType<typeof vi.fn>;
  onTaskMove: ReturnType<typeof vi.fn>;
  onTaskAutoSpawn: ReturnType<typeof vi.fn>;
} {
  return {
    getProjectDb: () => db as unknown as ReturnType<CommandContext['getProjectDb']>,
    getProjectPath: () => projectPath,
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async (): Promise<TaskMoveResult> => ({
      ok: true,
      autoCommand: { kind: 'not-applicable' },
    })),
    onTaskAutoSpawn: vi.fn(async (): Promise<AutoCommandImmediateOutcome> => ({ kind: 'not-applicable' })),
    onSwimlaneUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

describe.runIf(CAN_RUN)('resolving and moving a task to the Done column', () => {
  let db: InstanceType<typeof DatabaseType>;
  let context: ReturnType<typeof makeContext>;
  let todoLane: { id: string; name: string };
  let doneLane: { id: string; name: string; is_archived: boolean };

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);

    const swimlanes = new SwimlaneRepository(db).list();
    const foundTodo = swimlanes.find((lane) => lane.role === 'todo');
    const foundDone = swimlanes.find((lane) => lane.role === 'done');
    if (!foundTodo) throw new Error('Seeded To Do swimlane not found');
    if (!foundDone) throw new Error('Seeded Done swimlane not found');
    todoLane = foundTodo;
    doneLane = foundDone;
    expect(doneLane.is_archived).toBe(true);

    context = makeContext(db, '/mock/project');
  });

  afterEach(() => {
    db?.close();
  });

  it('resolves "Done" by name when includeArchivedDone is set', () => {
    const resolution = resolveColumn(db, 'Done', 'todo', { includeArchivedDone: true });

    expect('error' in resolution).toBe(false);
    if (!('error' in resolution)) {
      expect(resolution.swimlane.id).toBe(doneLane.id);
    }
  });

  it('still rejects "Done" by name without the flag', () => {
    const resolution = resolveColumn(db, 'Done');

    expect('error' in resolution).toBe(true);
    if ('error' in resolution) {
      expect(resolution.error).toContain('Column "Done" not found');
      const availableColumns = resolution.error.split('Available columns: ')[1]?.split('.')[0] ?? '';
      expect(availableColumns.split(', ')).not.toContain('Done');
    }
  });

  it('moves a task to Done, dispatching onTaskMove with the archived Done lane id', async () => {
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Finish the thing', description: '', swimlane_id: todoLane.id });

    const response = await handleMoveTask({ taskId: task.id, column: 'Done' }, context);

    expect(response.success).toBe(true);
    expect(context.onTaskMove).toHaveBeenCalledWith({
      taskId: task.id,
      targetSwimlaneId: doneLane.id,
      targetPosition: 0,
    });
  });

  it('surfaces Done in the "Available columns" list on a bad column name', async () => {
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Task', description: '', swimlane_id: todoLane.id });

    const response = await handleMoveTask({ taskId: task.id, column: 'Nonexistent' }, context);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('Done');
    }
  });

  it('handleCreateTask still rejects column: "Done" by name', async () => {
    const response = await handleCreateTask({ title: 'New task', column: 'Done' }, context);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('Column "Done" not found');
    }
  });

  it('awaits board Auto-command lifecycle after notification and returns its safe skipped warning', async () => {
    let releaseAutoSpawn: (() => void) | undefined;
    const autoSpawnReady = new Promise<void>((resolve) => {
      releaseAutoSpawn = resolve;
    });
    context.onTaskAutoSpawn.mockImplementation(async (): Promise<AutoCommandImmediateOutcome> => {
      await autoSpawnReady;
      return {
        kind: 'skipped',
        reason: 'native-evidence-unavailable',
        warning: 'Native idle evidence was unavailable.',
      };
    });

    let responseCompleted = false;
    const responsePromise = Promise.resolve(handleCreateTask({ title: 'Created with task command', autoCommand: '/review' }, context))
      .then((response) => {
        responseCompleted = true;
        return response;
      });

    await Promise.resolve();
    expect(context.onTaskCreated).toHaveBeenCalledOnce();
    expect(responseCompleted).toBe(false);
    if (!releaseAutoSpawn) throw new Error('Auto-spawn lifecycle did not begin');

    releaseAutoSpawn();
    const response = await responsePromise;

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      id: expect.any(String),
      displayId: expect.any(Number),
      column: todoLane.name,
      autoCommand: {
        kind: 'skipped',
        reason: 'native-evidence-unavailable',
        warning: 'Native idle evidence was unavailable.',
      },
      warning: 'Native idle evidence was unavailable.',
    });
  });

  it('does not start an Auto-command lifecycle for a Backlog creation', async () => {
    const response = await handleCreateTask({ title: 'Backlog only', column: 'Backlog' }, context);

    expect(response.success).toBe(true);
    expect(context.onTaskAutoSpawn).not.toHaveBeenCalled();
  });

  it('does not expose a non-Done archived lane by name, even with includeArchivedDone set', async () => {
    // A user can archive a custom column deliberately to hide it (distinct
    // from the Done lane, which is archived by design). The fix's carve-out
    // is `swimlane.role === 'done'`, not "any archived lane" - assert the
    // narrower condition directly so a future refactor that widens the OR to
    // just `includeArchivedDone` (leaking every hidden archived lane through
    // move_task) fails this test.
    const swimlaneRepo = new SwimlaneRepository(db);
    const hiddenLane = swimlaneRepo.create({ name: 'Retired Column', auto_spawn: false, is_archived: true });

    const withFlag = resolveColumn(db, 'Retired Column', 'todo', { includeArchivedDone: true });
    expect('error' in withFlag).toBe(true);
    if ('error' in withFlag) {
      expect(withFlag.error).toContain('Column "Retired Column" not found');
    }

    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Task', description: '', swimlane_id: todoLane.id });
    const response = await handleMoveTask({ taskId: task.id, column: 'Retired Column' }, context);
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).not.toContain(hiddenLane.id);
    }
    expect(context.onTaskMove).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'scheduled native-idle outcome',
      autoCommand: { kind: 'scheduled', transport: 'native-idle', generation: 7 },
      expectedData: { autoCommand: { kind: 'scheduled', transport: 'native-idle', generation: 7 } },
    },
    {
      name: 'scheduled legacy outcome',
      autoCommand: { kind: 'scheduled', transport: 'legacy' },
      expectedData: { autoCommand: { kind: 'scheduled', transport: 'legacy' } },
    },
    {
      name: 'finalized skipped outcome with its sanitized warning',
      autoCommand: { kind: 'skipped', reason: 'native-evidence-unavailable', warning: 'Native idle evidence was unavailable.' },
      expectedData: {
        autoCommand: { kind: 'skipped', reason: 'native-evidence-unavailable', warning: 'Native idle evidence was unavailable.' },
        warning: 'Native idle evidence was unavailable.',
      },
    },
    {
      name: 'not-applicable outcome',
      autoCommand: { kind: 'not-applicable' },
      expectedData: { autoCommand: { kind: 'not-applicable' } },
    },
  ] as const)('returns required move data for $name', async ({ autoCommand, expectedData }) => {
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Move with immediate outcome', description: '', swimlane_id: todoLane.id });

    context.onTaskMove.mockResolvedValue({ ok: true, autoCommand });

    const response = await handleMoveTask({ taskId: task.id, column: 'Done' }, context);

    expect(response).toMatchObject({ success: true });
    expect(response.data).toEqual({
      id: task.id,
      displayId: task.display_id,
      column: doneLane.name,
      ...expectedData,
    });
  });

  it('awaits normal move lifecycle completion but not later terminal settlement', async () => {
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Awaited immediate move', description: '', swimlane_id: todoLane.id });
    let releaseNormalLifecycle: (() => void) | undefined;
    const normalLifecycle = new Promise<void>((resolve) => {
      releaseNormalLifecycle = resolve;
    });
    let normalLifecycleCompleted = false;
    let terminalSettlementCompleted = false;
    const terminalSettlement = new Promise<void>(() => {
      terminalSettlementCompleted = false;
    });

    context.onTaskMove.mockImplementation(async (): Promise<TaskMoveResult> => {
      await normalLifecycle;
      normalLifecycleCompleted = true;
      void terminalSettlement;
      return {
        ok: true,
        autoCommand: { kind: 'scheduled', transport: 'native-idle', generation: 11 },
      };
    });

    let responseCompleted = false;
    const responsePromise = Promise.resolve(handleMoveTask({ taskId: task.id, column: 'Done' }, context))
      .then((response) => {
        responseCompleted = true;
        return response;
      });

    await Promise.resolve();
    expect(normalLifecycleCompleted).toBe(false);
    expect(responseCompleted).toBe(false);
    if (!releaseNormalLifecycle) throw new Error('Normal lifecycle did not begin');

    releaseNormalLifecycle();
    const response = await responsePromise;

    expect(normalLifecycleCompleted).toBe(true);
    expect(terminalSettlementCompleted).toBe(false);
    expect(response.data).toEqual({
      id: task.id,
      displayId: task.display_id,
      column: doneLane.name,
      autoCommand: { kind: 'scheduled', transport: 'native-idle', generation: 11 },
    });
  });

  it('returns not-applicable data without calling the lifecycle for a same-column move', async () => {
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Already in To Do', description: '', swimlane_id: todoLane.id });

    const response = await handleMoveTask({ taskId: task.id, column: 'To Do' }, context);

    expect(response.data).toEqual({
      id: task.id,
      displayId: task.display_id,
      column: todoLane.name,
      autoCommand: { kind: 'not-applicable' },
    });
    expect(context.onTaskMove).not.toHaveBeenCalled();
  });
});

it('returns Option B without serializing a rejected startup error after durable creation', async () => {
  const rawErrorCanary = 'synthetic-command=internal-only;synthetic-path=/not-a-real-private-path;synthetic-credential=NOT_A_SECRET';
  const warning = 'Task was created, but the agent could not be started. The task remains on the board.';
  const createdTask = { id: 'created-task-1', title: 'Task with rejected startup', display_id: 41 };
  const taskCreateInputs: Array<Record<string, unknown>> = [];
  const callbackOrder: string[] = [];

  vi.resetModules();
  vi.doMock('../../src/main/db/repositories/task-repository', () => ({
    TaskRepository: class {
      create(input: Record<string, unknown>) {
        taskCreateInputs.push(input);
        return createdTask;
      }
    },
  }));
  vi.doMock('../../src/main/agent/commands/column-resolver', () => ({
    resolveColumn: () => ({ swimlane: { id: 'todo-lane', name: 'To Do' } }),
  }));

  try {
    const { handleCreateTask: isolatedHandleCreateTask } = await import('../../src/main/agent/commands/task-commands');
    const context: CommandContext = {
      getProjectDb: vi.fn(() => ({}) as never),
      getProjectPath: () => '/mock/project',
      onTaskCreated: () => callbackOrder.push('created'),
      onTaskUpdated: () => {},
      onTaskDeleted: () => {},
      onTaskMove: () => Promise.resolve({ ok: true, autoCommand: { kind: 'not-applicable' } } as const),
      onTaskAutoSpawn: async () => {
        callbackOrder.push('auto-spawn');
        throw new Error(rawErrorCanary);
      },
      onSwimlaneUpdated: () => {},
      onBacklogChanged: () => {},
      onLabelColorsChanged: () => {},
    };

    const outcome = await isolatedHandleCreateTask({ title: createdTask.title, autoCommand: '/review' }, context).then(
      (response) => ({ kind: 'response' as const, response }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );

    expect(taskCreateInputs).toEqual([expect.objectContaining({ auto_command: '/review' })]);
    expect(callbackOrder).toEqual(['created', 'auto-spawn']);
    expect(outcome.kind).toBe('response');
    if (outcome.kind === 'error') {
      if (!(outcome.error instanceof Error)) throw new Error('Startup rejection was not an Error');
      expect(outcome.error.message).toBe(rawErrorCanary);
      return;
    }

    expect(outcome.response).toEqual({
      success: true,
      data: {
        id: createdTask.id,
        taskId: createdTask.id,
        title: createdTask.title,
        displayId: createdTask.display_id,
        column: 'To Do',
        warning,
      },
      message: `Created task "${createdTask.title}" in To Do column (#${createdTask.display_id}, id: ${createdTask.id}) ${warning}`,
    });
    const serialized = JSON.stringify(outcome.response);
    expect(serialized).toContain(warning);
    expect(serialized).not.toContain(rawErrorCanary);
    expect(serialized).not.toContain('"error"');
    expect(serialized).not.toContain('autoCommand');
    expect(serialized).not.toContain('isError');
  } finally {
    vi.doUnmock('../../src/main/db/repositories/task-repository');
    vi.doUnmock('../../src/main/agent/commands/column-resolver');
    vi.resetModules();
  }
});
