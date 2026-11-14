/**
 * The robot's start-up proof (keeper/lighthouse.ts: two test runs that lift the trip cap past $25),
 * asked again when it could not RUN, and kept being asked while the robot trades.
 *
 * Why (2026-11-14 08:15:50Z): the public RPC answered 429 two seconds into a start, the one try
 * the proof had was lost, and the robot ran capped at $25 where its setting was $100, until its
 * next restart. A proof that RAN and failed is another matter: that is the chain's answer, and it
 * is not asked again at the start.
 *
 * `prove()` answers null (proven), or why not as a string; one that starts with COULD_NOT_RUN
 * says the proof never ran (the RPC), not that it failed.
 */
export const COULD_NOT_RUN = 'the proof could not run';
export const couldNotRun = (proof) => typeof proof === 'string' && proof.startsWith(COULD_NOT_RUN);

/** At the start: up to `tries` in all, `waitMs` apart, while it could not run. Answers the last answer and how many tries it took. */
export async function proveAtStart(prove, { tries = 4, waitMs = 2_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let proof = await prove();
  let tried = 1;
  while (couldNotRun(proof) && tried < tries) {
    await sleep(waitMs);
    proof = await prove();
    tried++;
  }
  return { proof, tried };
}

/**
 * While the robot runs unproven: `prove()` asked again every `everyMs`, at most `most` times, until
 * it answers null; then `onProven()` once, and it stops. Any other answer (it could not run, or a
 * trip moved the balance between its two test runs) is only a reason to ask again: the cap is
 * lifted by a clean proof and by nothing else. `onGaveUp(last)` once if it never came. Returns a
 * function that stops it. `every(fn, ms)` is setInterval's shape (returns what `stop` takes).
 */
export function keepProving(prove, { onProven, onGaveUp = () => {}, everyMs = 60_000, most = 60, every = (fn, ms) => setInterval(fn, ms), stop = (h) => clearInterval(h) }) {
  let asked = 0;
  let busy = false;
  let done = false;
  const handle = every(async () => {
    if (busy || done) return;
    busy = true;
    try {
      asked++;
      const proof = await prove().catch((e) => `${COULD_NOT_RUN}: ${e instanceof Error ? e.message : String(e)}`);
      if (done) return;
      if (proof === null) {
        done = true;
        stop(handle);
        onProven(asked);
      } else if (asked >= most) {
        done = true;
        stop(handle);
        onGaveUp(proof);
      }
    } finally {
      busy = false;
    }
  }, everyMs);
  handle?.unref?.();
  return () => {
    done = true;
    stop(handle);
  };
}
