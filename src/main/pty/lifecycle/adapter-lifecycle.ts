import type { AgentParser, SessionAttachment, SessionContext } from '../../../shared/types';

/**
 * Minimal session shape required by the adapter lifecycle helpers. The
 * full ManagedSession type is private to session-manager; this interface
 * declares only the fields these helpers touch.
 */
export interface AdapterAttachable {
  id?: string;
  cwd: string;
  taskId: string;
  agentParser?: AgentParser;
  adapterAttachment?: SessionAttachment;
  hooksRemoved?: boolean;
}

/** Mutable owner for generic cleanup prepared before a PTY can be spawned. */
export interface SpawnCleanupOwner {
  spawnCleanup?: SessionAttachment;
}

/**
 * Release generic per-spawn cleanup without involving adapter attachments or
 * shared hook files. Clear ownership before dispose so repeated terminal paths
 * and re-entrant cleanup cannot invoke the same handle twice.
 */
export function disposeSpawnCleanup(owner: SpawnCleanupOwner): void {
  const cleanup = owner.spawnCleanup;
  owner.spawnCleanup = undefined;
  if (!cleanup) return;

  try {
    cleanup.dispose();
  } catch {
    console.warn('[SessionManager] generic spawn cleanup disposal failed');
  }
}

/**
 * Generic adapter attach hook. Adapters that need per-session orchestration
 * outside the declarative `runtime` surface (e.g. out-of-band CLI queries,
 * external event subscriptions) implement `attachSession(context)`. The
 * returned `SessionAttachment` is the adapter's private handle - callers
 * never inspect it, they only guarantee `dispose()` is invoked exactly
 * once when the session ends.
 *
 * No-op for adapters that do not implement `attachSession`.
 */
export function attachAdapter(session: AdapterAttachable, context: SessionContext): void {
  // Invoke via method syntax (`parser.attachSession(...)`) rather than via a
  // destructured reference so `this` stays bound to the adapter instance.
  // Cursor's attachSession calls `this.fetchAboutUsage()`; a destructured
  // invocation throws `Cannot read properties of undefined (reading 'fetchAboutUsage')`.
  const parser = session.agentParser;
  if (!parser?.attachSession) return;
  const attachment = parser.attachSession(context);
  if (attachment) session.adapterAttachment = attachment;
}

/**
 * Dispose the adapter attachment if present, then clear the reference.
 * Idempotent - safe to call from both the PTY exit handler and the
 * remove() cleanup path.
 */
export function disposeAdapterAttachment(session: AdapterAttachable): void {
  if (!session.adapterAttachment) return;
  session.adapterAttachment.dispose();
  session.adapterAttachment = undefined;
}

/**
 * Ask the adapter to strip its hooks from the project's settings file.
 *
 * Gemini and Codex write hooks to a shared project-level file
 * (`<cwd>/.gemini/settings.json` or equivalent) rather than a
 * session-specific override, so each session must clean up its own
 * hooks on exit. Without this they accumulate and the agent executes
 * N copies per event.
 *
 * The session id is the opaque owner identity, so the same instance can
 * safely release from both suspend() and its later PTY exit handler.
 * Without it, cleanup would fall back to taskId and could release another
 * concurrent spawn's hooks, so this helper does nothing.
 */
export function removeAdapterHooks(session: AdapterAttachable): void {
  if (session.id === undefined || session.hooksRemoved) return;
  session.hooksRemoved = true;

  try {
    session.agentParser?.removeHooks?.(session.cwd, session.taskId, session.id);
  } catch {
    console.warn('[SessionManager] adapter hook cleanup failed');
  }
}
