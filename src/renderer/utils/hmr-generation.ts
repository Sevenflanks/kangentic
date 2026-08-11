/** HMR generation counter.
 *
 *  Bumped from App.tsx's `vite:afterUpdate` handler after every Vite Fast
 *  Refresh cycle. Components that own stateful third-party integrations
 *  (currently every `<DndContext>`) read this counter via
 *  `useHmrGeneration()` and pass it as `key`. The new key value forces React
 *  to unmount and remount the entire subtree, which purges any per-droppable
 *  subscriptions or rect caches that dnd-kit kept alive across the Fast
 *  Refresh. End result: dev-mode behavior matches a fresh production boot.
 *
 *  In production `import.meta.hot` is undefined, the counter stays at 0
 *  forever, `bumpHmrGeneration` is a no-op, and the `key={0}` constants on
 *  consumers are inert.
 */

import { useSyncExternalStore } from 'react';

let generation: number = import.meta.hot?.data?.hmrGeneration ?? 0;
const listeners = new Set<() => void>();

if (import.meta.hot) {
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    // Preserve only; bumpHmrGeneration() in App.tsx's vite:afterUpdate
    // handler is the single source of increments. Adding +1 here would
    // double-remount every DndContext per HMR cycle (once from the new
    // module reading the pre-bumped value, again from afterUpdate).
    data.hmrGeneration = generation;
  });
}

export function bumpHmrGeneration(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return generation;
}

export function useHmrGeneration(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
