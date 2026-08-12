/**
 * @param {{
 *   runProbe: (signal: AbortSignal) => Promise<unknown>,
 *   createTimeoutResult: () => unknown,
 *   ceilingMs: number,
 * }} options
 */
export async function runWithProbeCeiling(options) {
  const { runProbe, createTimeoutResult, ceilingMs } = options;
  const controller = new AbortController();
  const probe = runProbe(controller.signal);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const ceilingTimer = setTimeout(async () => {
      timedOut = true;
      controller.abort();
      await probe.catch(() => undefined);
      resolve(createTimeoutResult());
    }, ceilingMs);

    probe.then(
      (result) => {
        if (timedOut) return;
        clearTimeout(ceilingTimer);
        resolve(result);
      },
      (error) => {
        if (timedOut) return;
        clearTimeout(ceilingTimer);
        reject(error);
      },
    );
  });
}
