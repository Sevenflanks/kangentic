import type Database from 'better-sqlite3';
import type { Task, Swimlane, TaskMoveInput } from '../../../shared/types';
import type { AutoCommandImmediateOutcome, TaskMoveResult } from '../../../shared/auto-command-outcome';

export interface CommandContext {
  getProjectDb: () => Database.Database;
  getProjectPath: () => string;
  onTaskCreated: (task: Task, columnName: string, swimlaneId: string) => void;
  onTaskUpdated: (task: Task) => void;
  onTaskDeleted: (task: Task) => void;
  onTaskMove: (input: TaskMoveInput) => Promise<TaskMoveResult>;
  onTaskAutoSpawn: (task: Pick<Task, 'id' | 'title'>, swimlaneId: string) => Promise<AutoCommandImmediateOutcome>;
  onSwimlaneUpdated: (swimlane: Swimlane) => void;
  onBacklogChanged: () => void;
  onLabelColorsChanged: (colors: Record<string, string>) => void;
}

export interface CommandResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

/**
 * Handlers may be sync or async. Most are sync (DB-only operations via the
 * synchronous better-sqlite3 driver), but some need to await I/O - e.g.
 * `get_transcript`'s structured branch reads Claude Code's native session
 * JSONL from disk. CommandBridge dispatches sync handlers inline so test
 * harnesses that read response files immediately after invocation keep
 * working; only Promise-returning handlers go through async dispatch.
 *
 * Do not narrow this back to `CommandResponse` without first migrating
 * every async handler.
 */
export type CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
) => CommandResponse | Promise<CommandResponse>;
