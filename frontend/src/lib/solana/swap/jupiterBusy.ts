// Jupiter's keyless tier refuses calls it has not run ("too many requests"), counted per
// source address, and our relay shares its address with other sites on Vercel: refusals land
// at random. The relay answers one as 502, and its own per-visitor limit as 429. A press makes
// up to four Jupiter calls (quote, build, and jupiterFeeRetry.ts's no-fee re-quote and
// rebuild), and one refusal must not end it: a refusal is a wait, not an answer.

/** Jupiter, or our relay in front of it, refused the call before it ran. */
export class JupiterBusyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'JupiterBusyError';
    this.status = status;
  }
}

/** The relay's two refusals: Jupiter's (502) and its own per-visitor limit (429). */
export function jupiterBusy(status: number): boolean {
  return status === 502 || status === 429;
}

/** The waits a press gives Jupiter: the first two of the island order's (IslandBasketSolana.tsx). */
export const PRESS_WAITS_MS: readonly number[] = [2_500, 5_000];

/**
 * `fn`, asked again after each wait in `waitsMs` while Jupiter is busy. Any other failure
 * (no route, a bad request, an abort) ends it at once, as before.
 */
export function whileJupiterBusy<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
  waitsMs: readonly number[] = PRESS_WAITS_MS,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): (...a: A) => Promise<R> {
  return async (...a) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(...a);
      } catch (e) {
        if (!(e instanceof JupiterBusyError) || attempt >= waitsMs.length) throw e;
        await sleep(waitsMs[attempt]!);
      }
    }
  };
}
