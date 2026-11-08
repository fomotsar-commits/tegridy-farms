/**
 * The launch door (island answer twenty-six, 2026-11-03): no token launch is live on the venue
 * until the island says so, on any rail. Closed, /launch is the countdown for every wallet, warm
 * ones too, and no rail offers a launch form. Flipped only on the island's written word, and never
 * before the island's /api/attest route is live. The day it opens, the countdown's warm state
 * becomes the lane and each rail opens on the operator's word, by its own switch: config.ts
 * LAUNCHER_ENABLED, curveChains.ts CURVE_LAUNCH_OPEN, solana/curveWriteFlag.ts CURVE_WRITES_ENABLED.
 */
export const LAUNCH_DOOR_OPEN: boolean = false;

/**
 * Is the launch door open? Branch on this, as on the rails' isLauncherEnabled() and
 * isCurveLaunchOpen(), never on the constant: CodeQL reads a branch on an imported false constant
 * as dead code.
 */
export function isLaunchDoorOpen(): boolean {
  return LAUNCH_DOOR_OPEN;
}
