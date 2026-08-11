/** Module-scoped HMR detection flag.
 *  Returns false on cold start, true after any HMR cycle completes.
 *  Used to skip destructive re-initialization (shimmer overlays, scroll
 *  resets) when Vite hot-replaces a module during development. */

const isHmrReload: boolean = import.meta.hot?.data?.isHmrReload ?? false;

if (import.meta.hot) {
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.isHmrReload = true;
  });
}

export function getIsHmrReload(): boolean {
  return isHmrReload;
}
