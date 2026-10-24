// The note of a swap sent through Jupiter: the wallet signs and sends it, so the page
// never sees the blockhash's last valid height that Jupiter's /swap answer carries.

/**
 * A blockhash lives 150 blocks. Jupiter took its blockhash before the read below
 * started, so the transaction cannot land past that read + 150; another 150 covers a
 * node of ours that is behind Jupiter's. Too high only holds Buy longer; too low would
 * call a swap that can still land "can no longer land".
 */
export const JUPITER_WINDOW_BLOCKS = 300;

/**
 * The last block height a transaction Jupiter built before this call can land at, at
 * most. Null when the height could not be read: the note then ends on the chain's
 * answer, or on its ten minutes, never on "can no longer land".
 */
export async function jupiterLastValidAtMost(readHeight: () => Promise<number>): Promise<number | null> {
  try {
    const h = await readHeight();
    return Number.isSafeInteger(h) && h > 0 ? h + JUPITER_WINDOW_BLOCKS : null;
  } catch {
    return null;
  }
}
