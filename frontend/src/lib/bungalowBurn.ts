// THE BURN LEDGER: how much of a bungalow token's supply is gone for good.
// Pure: no chain read happens here. The hook supplies a reading, this file does the sums.
import { BUNGALOWS, DEFAULT_BUNGALOW_ID, type Bungalow } from './bungalows';

/** The EVM burn address. Tokens sent here stay in totalSupply, so they are read as a balance. */
export const EVM_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

export interface BurnFact {
  /** Everything ever minted, in WHOLE tokens, digits only. Proven from the mint transaction. */
  minted: string;
  /** The token's decimals. The live read must agree or no figure is shown. */
  decimals: number;
  /** The one transaction that minted the whole supply (the token's creation). */
  mintTx: string;
  /** False when supply can also move through a bridge: a fall in supply is then not counted. */
  countsSupplyDrop: boolean;
  /** Set only where the token contract's balance of its own token is proven unable to ever
   *  move (its source has no way out, and its history shows none): it is then counted as burnt. */
  countsOwnBalance?: true;
}

// One row per token bungalow, keyed by bungalow id. Each `minted` is the single mint in
// `mintTx`, re-derived twice on 2026-10-03; none of these tokens has a live mint path.
// QR, DRB and JBM carry a dormant bridge mint and burn, so a fall in their supply is not counted.
// `countsOwnBalance`: each of the seven EVM contracts was read for any way out of its own
// balance and its whole history searched for one (2026-10-03). None has one. A new token starts off.
export const BUNGALOW_BURN_FACTS: Readonly<Record<string, BurnFact>> = {
  toweli: { minted: '1000000000', decimals: 18, countsSupplyDrop: true, countsOwnBalance: true, mintTx: '0x6cce8d54940c37fdfed3041daf76923d7adfd487f459b026ff456073a26a673b' },
  bayla: { minted: '1000000000', decimals: 6, countsSupplyDrop: true, mintTx: '57z5CJ5j5UhnQz5qBwvzxKPFJJUeRv3BiWNNgddF5XrjESivCqNUc2bqQN8HGTuLMxUFbZQX8BS6rc1kT5HNhzeQ' },
  pepe: { minted: '420690000000000', decimals: 18, countsSupplyDrop: true, countsOwnBalance: true, mintTx: '0x2afae7763487e60b893cb57803694810e6d3d136186a6de6719921afd7ca304a' },
  qr: { minted: '100000000000', decimals: 18, countsSupplyDrop: false, countsOwnBalance: true, mintTx: '0x18a677ce1fc39876aa2a75b9d78c77a0f58cf6a539e5edf30b2f15595cefa47f' },
  mfer: { minted: '1000000000', decimals: 18, countsSupplyDrop: true, countsOwnBalance: true, mintTx: '0xb23ea44e81cf3546ed2a4a13c1e6d27b6de21f419230bbc6a7ed67c3185b3912' },
  bnkr: { minted: '100000000000', decimals: 18, countsSupplyDrop: true, countsOwnBalance: true, mintTx: '0x661d7c8f088bb866b756bf17cf74ca43890c18260318deab861e37e8d7594662' },
  drb: { minted: '100000000000', decimals: 18, countsSupplyDrop: false, countsOwnBalance: true, mintTx: '0x2cf2f8330f8e1b72c5efdc1db80790e6f47ff0c3af6a33cec31186f2c7df795e' },
  bobo: { minted: '1000000000', decimals: 6, countsSupplyDrop: true, mintTx: '3w3NbHbcr2wXqBTSBrzjePECJS5FG8A8jYJLRCwevntYr4JzVWvsAaN1nHNjeegsb4KLBPA6vL9jm3VjJAy1ovf3' },
  jbm: { minted: '100000000000', decimals: 18, countsSupplyDrop: false, countsOwnBalance: true, mintTx: '0xb7c0d5dbc33584461b5dd5f9f45b6527d98869ab7918f19de7b9a04318cce6aa' },
  soy: { minted: '1000000000', decimals: 6, countsSupplyDrop: true, mintTx: '5LrYVwyf3xJkKWRn4CjDWc5YwZbdFTeC45nc9N8RQmwtxAGbp18PtLw6o6QacDsB9JAufj1fc3CqmcvMUTWnWdVn' },
  brainlet: { minted: '1000000000', decimals: 6, countsSupplyDrop: true, mintTx: '2htyuqizj1MEqaTL7QcoEbX6Le11XFUQ7QYG685FJ4QRzCzhPeDS1qfBGGDikL9hHrPkfcDNYGz1ZG8urJR8HqaW' },
  rizz: { minted: '1000000000', decimals: 6, countsSupplyDrop: true, mintTx: '4mKCtSuQtBgtFfpThuqgDxaVJzz7fhpkFTvbRj7xMYHysjPgNynzkYP5QU81Cs7b9hLuZBUATPbj3hazE8Vbs5Sc' },
};

/** The burn fact for a bungalow, or null for a lot with no token or no record. */
export function burnFactFor(bungalow: Pick<Bungalow, 'id' | 'address'>): BurnFact | null {
  if (!bungalow.address) return null;
  return BUNGALOW_BURN_FACTS[bungalow.id] ?? null;
}

/** The bungalow whose burn the home page shows: the room being worn, else TOWELI in its own
 *  room (it has no identity), else none. The venue's own front door shows no burn card. */
export function homeBurnRoom(identity: Bungalow | null, isToweliArrival: boolean): Bungalow | null {
  if (identity) return identity;
  if (!isToweliArrival) return null;
  return BUNGALOWS.find((b) => b.id === DEFAULT_BUNGALOW_ID) ?? null;
}

/** Everything ever minted, in base units. */
export function mintedRawOf(fact: BurnFact): bigint {
  return BigInt(fact.minted) * 10n ** BigInt(fact.decimals);
}

/** One complete chain reading. Build it only from answers that landed: there is no default. */
export interface BurnReading {
  /** totalSupply() on EVM, getTokenSupply on Solana, in base units. */
  supplyRaw: bigint;
  /** Decimals as the chain reports them. */
  decimals: number;
  /** Balance at the burn address. Left out on Solana, where a burn always lowers the supply. */
  atBurnAddressRaw?: bigint;
  /** The token contract's balance of its own token. Counted only where the record says so. */
  inOwnContractRaw?: bigint;
}

export type BurnMismatch = 'decimals' | 'supply-above-minted' | 'balances-above-supply';

export type BurnTally =
  | {
      ok: true;
      decimals: number;
      mintedRaw: bigint;
      /** Minted minus today's supply. Absent when a supply fall is not counted for this token. */
      destroyedRaw?: bigint;
      /** The same fall, for a token where it is NOT counted. Shown beside the burn, never in it. */
      uncountedFallRaw?: bigint;
      /** Held at the burn address. Absent on a chain where none is read. */
      atBurnAddressRaw?: bigint;
      /** Stuck in the token's own contract. Absent unless the record counts it. */
      inOwnContractRaw?: bigint;
      burntRaw: bigint;
      /** Absent while an uncounted fall is above zero: it may be a burn or a bridge-out. */
      notBurntRaw?: bigint;
      /** Burnt per million minted, rounded down. */
      burntPpm: number;
    }
  | { ok: false; reason: BurnMismatch };

/**
 * The burn, from one reading. A reading that contradicts the record (other decimals, more
 * supply than was ever minted, counted balances larger than the supply) yields no figure:
 * the record is wrong or the token changed, and either way a number would be a guess.
 */
export function tallyBurn(fact: BurnFact, reading: BurnReading): BurnTally {
  if (reading.decimals !== fact.decimals) return { ok: false, reason: 'decimals' };
  const mintedRaw = mintedRawOf(fact);
  if (reading.supplyRaw > mintedRaw) return { ok: false, reason: 'supply-above-minted' };
  const { atBurnAddressRaw } = reading;
  // An own balance handed in for a token whose record does not count it is left out.
  const inOwnContractRaw = fact.countsOwnBalance ? reading.inOwnContractRaw : undefined;
  let heldRaw = 0n;
  if (atBurnAddressRaw !== undefined) heldRaw += atBurnAddressRaw;
  if (inOwnContractRaw !== undefined) heldRaw += inOwnContractRaw;
  if (heldRaw > reading.supplyRaw) return { ok: false, reason: 'balances-above-supply' };
  const fallRaw = mintedRaw - reading.supplyRaw;
  const destroyedRaw = fact.countsSupplyDrop ? fallRaw : undefined;
  const uncountedFallRaw = fact.countsSupplyDrop ? undefined : fallRaw;
  let burntRaw = heldRaw;
  if (destroyedRaw !== undefined) burntRaw += destroyedRaw;
  return {
    ok: true,
    decimals: fact.decimals,
    mintedRaw,
    destroyedRaw,
    uncountedFallRaw,
    atBurnAddressRaw,
    inOwnContractRaw,
    burntRaw,
    notBurntRaw: uncountedFallRaw !== undefined && uncountedFallRaw > 0n ? undefined : mintedRaw - burntRaw,
    burntPpm: Number((burntRaw * 1_000_000n) / mintedRaw),
  };
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Whole tokens, rounded down, with thousands commas. The same string in every locale.
 *  A real amount below one token says so: 0 is printed only for a read zero. */
export function formatWholeTokens(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  if (whole === 0n && raw > 0n) return 'under 1';
  return group(whole.toString());
}

/** What is left, as whole Ever minted minus whole Burnt, so those two rows add up to the third.
 *  Null when the tally cannot say what is not burnt. */
export function formatNotBurnt(tally: Extract<BurnTally, { ok: true }>): string | null {
  if (tally.notBurntRaw === undefined) return null;
  const unit = 10n ** BigInt(tally.decimals);
  return group((tally.mintedRaw / unit - tally.burntRaw / unit).toString());
}

const COMPACT_STEPS: readonly { floor: bigint; suffix: string }[] = [
  { floor: 1_000_000_000_000n, suffix: 'T' },
  { floor: 1_000_000_000n, suffix: 'B' },
  { floor: 1_000_000n, suffix: 'M' },
];

/** A short figure for a headline: 6.91T, 257.62M, 7,165. Rounded DOWN, so it never overstates. */
export function formatCompactTokens(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  if (whole === 0n && raw > 0n) return 'under 1';
  for (const { floor, suffix } of COMPACT_STEPS) {
    if (whole < floor) continue;
    const hundredths = (whole * 100n) / floor;
    return `${group((hundredths / 100n).toString())}.${(hundredths % 100n).toString().padStart(2, '0')}${suffix}`;
  }
  return group(whole.toString());
}

/** The burnt percent, rounded DOWN. A burn too small for four decimals says so, never "0%". */
export function formatBurnPercent(tally: Extract<BurnTally, { ok: true }>): string {
  if (tally.burntRaw === 0n) return '0%';
  const ppm = tally.burntPpm;
  if (ppm < 1) return 'under 0.0001%';
  if (ppm < 10_000) return `0.${String(ppm).padStart(4, '0').replace(/0+$/, '')}%`;
  const hundredths = Math.floor(ppm / 100);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}%`;
}

/** Where a reader can check the burn: the burn address's holding on EVM, the mint on Solana. */
export function burnProofUrl(bungalow: Pick<Bungalow, 'chain' | 'address'>): string | null {
  if (!bungalow.address) return null;
  switch (bungalow.chain) {
    case 'ethereum': return `https://etherscan.io/token/${bungalow.address}?a=${EVM_BURN_ADDRESS}`;
    case 'base': return `https://basescan.org/token/${bungalow.address}?a=${EVM_BURN_ADDRESS}`;
    case 'solana': return `https://solscan.io/token/${bungalow.address}`;
    default: return null;
  }
}
