import { fetchHeat } from './heatClient';
import type { HeatReading } from './heatOracle';

/**
 * ONE HAND CAN HOLD TWO WALLETS (the owner's phone, 2026-11-11). A wallet's own browser connects an
 * Ethereum account and a Solana wallet at once (Phantom's does), and a holder's coins sit on one of
 * them. The heat card read the Ethereum account and Bayla's line the Solana wallet, so one screen
 * told an Elder "1862.42° Elder" at the top and "0.00°, about half a year to the door" under it.
 *
 * Every connected wallet is read once, and the card and the line speak from the same one:
 *   - the warmest, when any is warm. Each reading is that wallet's own, as the island served it:
 *     nothing is added up, and the card still prints the address it read;
 *   - with none warm, a wallet the venue could not ask. The card reads it again and says so:
 *     "we could not ask" is never shown as cold (heatClient.ts);
 *   - with every wallet read and cold, the first one asked.
 * The launch gate is not this: it reads the wallet that signs (lib/heat/launchGate.ts).
 */
export async function warmestOf(
  addresses: readonly string[],
  read: (address: string) => Promise<HeatReading> = fetchHeat,
): Promise<string> {
  const settled = await Promise.allSettled(addresses.map((address) => read(address)));
  let warmest: string | null = null;
  let warmestDegrees = 0;
  let unread: string | null = null;
  for (const [i, answer] of settled.entries()) {
    const address = addresses[i]!;
    if (answer.status === 'rejected') {
      unread ??= address;
      continue;
    }
    const degrees = answer.value.isCold ? 0 : answer.value.degrees;
    if (degrees > warmestDegrees) {
      warmest = address;
      warmestDegrees = degrees;
    }
  }
  return warmest ?? unread ?? addresses[0]!;
}

const inFlight = new Map<string, Promise<string>>();

/** `warmestOf`, asked once however many cards and lines on the page ask while it is in flight.
 *  Afterwards fetchHeat's own cache answers (minutes, successes only). */
export function warmestConnected(addresses: readonly string[]): Promise<string> {
  const key = addresses.join('|');
  let asking = inFlight.get(key);
  if (!asking) {
    asking = warmestOf(addresses).finally(() => inFlight.delete(key));
    inFlight.set(key, asking);
  }
  return asking;
}
