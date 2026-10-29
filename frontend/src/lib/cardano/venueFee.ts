// The venue's fee on a Cardano swap (owner, 2026-10-24: "our own fee line").
//
// HOW THE VENUE EARNS. The fee is its own output in the trader's swap transaction, in ADA,
// paid straight to the venue's own Cardano address. No aggregator holds it and nobody pays it
// out later: it is in the venue's wallet the moment the transaction lands. The trader sees the
// line before signing, and the transaction check (swapTx.ts) refuses any build whose fee
// output is not exactly this amount to exactly this address.
//
// THE BASIS. A share of the swap's ADA side, the way the Solana swap charges in SOL: the ADA
// paid in, or, selling a token for ADA, the ADA the pool quotes back. A token-for-token swap
// has no ADA side and is not offered yet.
//
// WHEN IT IS NOT CHARGED. Every Cardano output must hold a minimum of ADA (about 1 ADA for a
// plain payment). A fee smaller than that cannot be an output at all, so a small swap pays no
// venue fee, and the page says so rather than rounding the fee up to the minimum.
//
// WHEN IT IS PAID. With the order, not with the fill: the batcher fills the order a few blocks
// later, or returns it if the price moved past the trader's minimum. A returned order has
// still paid this fee, and the page says that before signing.

import { parseAddressBech32, type ParsedAddress } from './address';

/**
 * The venue's Cardano fee address, the whole bech32. NULL UNTIL THE OWNER REGISTERS ONE: with
 * no address the swap still works and charges no venue fee, and the fee line says why. Set it
 * in code, in a reviewed change, never from an env var a deploy could get wrong.
 */
export const CARDANO_VENUE_FEE_ADDRESS: string | null = null;

/** The rate, in basis points of the ADA side: 50 = 0.5%, the Solana swap's live rate. */
export const CARDANO_VENUE_FEE_BPS = 50;

/** No rate above 1% is accepted, whatever the constant says: the fee turns off instead. */
const MAX_FEE_BPS = 100;

export type VenueFee =
  | { kind: 'charged'; lovelace: bigint; bps: number; address: ParsedAddress }
  | { kind: 'none'; reason: 'no-address' | 'off' | 'below-minimum' | 'no-ada-side' };

/** The registered address, parsed, or null when there is none or it is not a mainnet address. */
export function venueFeeAddress(raw: string | null = CARDANO_VENUE_FEE_ADDRESS): ParsedAddress | null {
  if (raw === null) return null;
  const parsed = parseAddressBech32(raw);
  return parsed && parsed.network === 1 ? parsed : null;
}

/** The rate actually used: the constant when it is a whole number in [0, 1%], else off. */
export function venueFeeBps(raw: number = CARDANO_VENUE_FEE_BPS): number {
  return Number.isInteger(raw) && raw >= 0 && raw <= MAX_FEE_BPS ? raw : 0;
}

/**
 * The fee on a swap whose ADA side is `adaSide` lovelace (null: no ADA side), given the least
 * ADA a payment to the fee address must hold. Rounded down: the trader is never charged more
 * than the stated rate.
 */
export function venueFeeFor(
  adaSide: bigint | null,
  minOutputLovelace: bigint,
  opts: { address?: ParsedAddress | null; bps?: number } = {},
): VenueFee {
  const address = opts.address === undefined ? venueFeeAddress() : opts.address;
  const bps = opts.bps === undefined ? venueFeeBps() : venueFeeBps(opts.bps);
  if (address === null) return { kind: 'none', reason: 'no-address' };
  if (bps === 0) return { kind: 'none', reason: 'off' };
  if (adaSide === null) return { kind: 'none', reason: 'no-ada-side' };
  const lovelace = (adaSide * BigInt(bps)) / 10_000n;
  if (lovelace < minOutputLovelace) return { kind: 'none', reason: 'below-minimum' };
  return { kind: 'charged', lovelace, bps, address };
}

/** The fee line's words, as SiteFeeRow says them for Solana. */
export function venueFeeText(fee: VenueFee): string {
  if (fee.kind === 'charged') return `${fee.bps / 100}% of the ADA side · to the venue`;
  switch (fee.reason) {
    case 'no-address':
      return 'None: the venue has no Cardano fee address yet';
    case 'off':
      return 'None';
    case 'below-minimum':
      return 'None on this size (a fee under about 1 ADA cannot be sent on Cardano)';
    case 'no-ada-side':
      return 'None on this pair';
  }
}
