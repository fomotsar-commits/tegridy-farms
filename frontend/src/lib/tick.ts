/**
 * A short tick on a press, where the browser allows it (the LP door, island answer twenty:
 * "a short tick on each press"). Android Chrome vibrates; iPhone Safari has no vibration
 * API, so there the press's own motion carries it. Never throws, never blocks the press.
 */
export function tick(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(8);
  } catch {
    /* a blocked vibration changes nothing */
  }
}
