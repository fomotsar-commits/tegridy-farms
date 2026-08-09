// THE BIRTH CERTIFICATE — the machine-readable twin of the per-token record page.
//
// "Locks, plates (every allocation named), fee instruction, and decimals on one record;
//  the stamp prints beneath: Every lock verifiable onchain. That route is the token's
//  birth certificate. The island reads it for enrollment, hygiene watch runs against it,
//  and certification state renders on it later. One build, four consumers."
//
// ## Why this module is pure
//
// Four consumers means four ways to get it wrong. So the SHAPE lives here, once, as a
// pure function over facts somebody else read — the page reads them with viem, the
// server route reads them with eth_call, and both produce the identical document. If
// this file ever starts fetching, that guarantee is gone.
//
// ## The honesty rule this inherits
//
// This repo has shipped the "unreadable rendered as zero" bug twice (a scam pool priced
// at "520607 ETH"; a "+10% NFT boost" no contract paid). A birth record is worse than a
// page, because it is consumed by machines that cannot see a caveat. So every field that
// could not be read is `null` and named in `unread`, and a consumer that ignores `unread`
// is reading an incomplete record on purpose. Zero NEVER stands in for unknown.

import type { LaunchFactSheet, FeeConstitutionLine } from './factSheet';

/** Bumped when a field changes meaning. Additive fields do not bump it. */
export const BIRTH_RECORD_SCHEMA_VERSION = 1;

/** The stamp the island's standard prints beneath every record. Verbatim. */
export const BIRTH_RECORD_STAMP = 'Every lock verifiable onchain.';

/** The chains the socket accepts, spelled exactly as it spells them. */
export type BirthChain = 'base' | 'ethereum' | 'solana';

/**
 * One named allocation — a "plate".
 *
 * EVERY allocation is named, including the sale itself. A record that lists only the
 * insider slice invites the reader to assume the rest is float; naming all of them means
 * the shares sum to the supply and a missing plate is visible as arithmetic.
 */
export interface BirthPlate {
  /** Plain-language name: 'Public sale', 'Team (vested)', 'Liquidity'. */
  name: string;
  /** Base units as a decimal string — never a JS number, which loses precision above 2^53. */
  amount: string;
  /** Share of total supply in basis points. */
  share_bps: number;
  /** Who holds it, when that is a specific address. */
  beneficiary: string | null;
  /** True when this plate is under an on-chain lock named in `locks`. */
  locked: boolean;
}

/** One on-chain lock. */
export interface BirthLock {
  /** 'liquidity' | 'vesting' — what is locked, not who locked it. */
  kind: 'liquidity' | 'vesting';
  /** The contract that holds it, so the claim is checkable. */
  locker: string | null;
  /** Base units as a decimal string; null when the amount is the whole LP position. */
  amount: string | null;
  /** Unix seconds. Null means perpetual, unknown, or burned — `note` says which. */
  unlock_at: number | null;
  beneficiary: string | null;
  /** Plain-language, and never reassuring. */
  note: string;
}

/** One line of the fee instruction — where trading fees are directed, and to whom. */
export interface BirthFeeLine {
  recipient: string;
  share_bps: number;
  role: FeeConstitutionLine['role'];
}

export interface BirthRecord {
  schema_version: number;
  /** Contract address / mint. Lower-cased on EVM; base58 verbatim on Solana. */
  ca: string;
  chain: BirthChain;
  creator: string;
  /** Chain truth, never approximated — the island anchors the birth from this. */
  birth_block: number | null;
  /** The create transaction, so birth_block is checkable rather than asserted. */
  birth_tx: string | null;
  /** Links this token to the gate audit row that permitted it. */
  gate_decision_id: string | null;

  name: string | null;
  symbol: string | null;
  /**
   * PINNED PER RAIL, and snapshotted. "Hard law: wrong precision voids comparability
   * across every record, chart, and plate the venue serves." Null only when unread —
   * a consumer must never default it to 18.
   */
  decimals: number | null;
  /** Base units as a decimal string. */
  total_supply: string | null;

  plates: BirthPlate[];
  locks: BirthLock[];
  fee_instruction: BirthFeeLine[];

  /** When these facts were read. Facts are point-in-time; the chain is the backfill truth. */
  observed_at: number;
  /**
   * Field names that could not be read. NOT cosmetic: a consumer that ignores this is
   * treating "unknown" as "absent", which is the exact failure this repo has shipped
   * before.
   */
  unread: string[];
  stamp: string;
}

/** Everything the builder needs that a Fact Sheet does not already carry. */
export interface BirthRecordInput {
  sheet: LaunchFactSheet;
  chain: BirthChain;
  creator: string;
  birthBlock: number | null;
  birthTx: string | null;
  gateDecisionId: string | null;
  /**
   * The rail's decimals, already resolved by the caller — see `railDecimals`.
   * Passed in rather than inferred here, so this module never guesses a precision.
   */
  decimals: number | null;
  /** Field names the caller could not read. Merged with the ones detected here. */
  unread?: readonly string[];
}

/**
 * DECIMALS, PINNED PER RAIL.
 *
 * The ETH rail is FIXED at 18: every token it creates comes from Doppler's
 * DopplerERC20V1 template, which hardcodes 18 — it is not a per-launch choice, so there
 * is nothing to snapshot and nothing that can drift.
 *
 * The CURVE rail is NOT fixed: `mint.decimals` is a launch parameter (6 by default,
 * pump.fun-style, and 6–9 is the supported band). So it must be SNAPSHOTTED from the
 * mint at create and printed on the record, and this function refuses to invent one —
 * a Solana record without a read `decimals` is incomplete, not 18 and not 6.
 */
export function railDecimals(chain: BirthChain, snapshot?: number | null): number | null {
  if (chain === 'ethereum' || chain === 'base') return 18;
  return typeof snapshot === 'number' && Number.isInteger(snapshot) && snapshot >= 0 && snapshot <= 18
    ? snapshot
    : null;
}

/** Base units of a whole-token amount at `decimals`, as a decimal string. */
function toBaseUnits(whole: bigint): string {
  return whole.toString();
}

/**
 * Build the record. PURE — every input is a fact somebody else already read.
 *
 * The plates are derived from the sheet rather than restated: `teamAllocationBps` and the
 * vesting schedules are already the disclosure the Fact Sheet publishes, so a record that
 * disagreed with the page would mean one of them had been edited alone.
 */
export function buildBirthRecord(input: BirthRecordInput): BirthRecord {
  const { sheet, chain } = input;
  const unread = new Set(input.unread ?? []);

  const supply = sheet.totalSupply;
  const teamBps = sheet.teamAllocationBps;
  const teamAmount = (supply * BigInt(teamBps)) / 10_000n;
  const saleAmount = supply - teamAmount;

  const plates: BirthPlate[] = [];
  // The sale is a plate. Naming it is what makes the shares sum to the supply.
  if (saleAmount > 0n) {
    plates.push({
      name: 'Public sale',
      amount: toBaseUnits(saleAmount),
      share_bps: 10_000 - teamBps,
      beneficiary: null,
      locked: false,
    });
  }
  for (const v of sheet.vesting) {
    plates.push({
      name: 'Team allocation (on-chain vested)',
      amount: toBaseUnits(v.amount),
      share_bps: supply > 0n ? Number((v.amount * 10_000n) / supply) : 0,
      beneficiary: v.beneficiary,
      locked: true,
    });
  }
  // A team allocation the sheet declares but for which no vesting schedule was read is
  // an UNVESTED insider slice. It is named, and it is named as unlocked — silence here
  // would read as "there is no insider allocation", which is the opposite of the truth.
  const vestedTotal = sheet.vesting.reduce((a, v) => a + v.amount, 0n);
  const unvested = teamAmount - vestedTotal;
  if (unvested > 0n) {
    plates.push({
      name: 'Team allocation (no on-chain vesting schedule was read)',
      amount: toBaseUnits(unvested),
      share_bps: supply > 0n ? Number((unvested * 10_000n) / supply) : 0,
      beneficiary: null,
      locked: false,
    });
  }

  const locks: BirthLock[] = [];
  locks.push({
    kind: 'liquidity',
    locker: sheet.liquidity.locker ?? null,
    amount: null,
    unlock_at: sheet.liquidity.unlockAt,
    beneficiary: null,
    note: sheet.liquidity.note,
  });
  for (const v of sheet.vesting) {
    locks.push({
      kind: 'vesting',
      locker: sheet.liquidity.locker ?? null,
      amount: toBaseUnits(v.amount),
      unlock_at: v.cliffSeconds + v.durationSeconds > 0 ? sheet.observedAt + v.cliffSeconds + v.durationSeconds : null,
      beneficiary: v.beneficiary,
      note: `Vests over ${Math.round(v.durationSeconds / 86_400)} days${v.cliffSeconds > 0 ? ` after a ${Math.round(v.cliffSeconds / 86_400)}-day cliff` : ''}.`,
    });
  }

  const fee_instruction: BirthFeeLine[] = sheet.feeConstitution.map((l) => ({
    recipient: l.recipient,
    share_bps: l.shareBps,
    role: l.role,
  }));
  // An EMPTY fee instruction is a real state on this rail — the launch-time split is a
  // config input that cannot be proven for an arbitrary token, and the real one is only
  // readable from the locker after graduation. Say so rather than publishing `[]` as if
  // it meant "no fees are charged".
  if (fee_instruction.length === 0) unread.add('fee_instruction');

  const decimals = input.decimals;
  if (decimals === null) unread.add('decimals');
  if (input.birthBlock === null) unread.add('birth_block');
  if (sheet.liquidity.unlockAt === null && !sheet.liquidity.locked) unread.add('locks.liquidity.unlock_at');

  return {
    schema_version: BIRTH_RECORD_SCHEMA_VERSION,
    ca: normaliseCa(sheet.token, chain),
    chain,
    creator: normaliseCa(input.creator, chain),
    birth_block: input.birthBlock,
    birth_tx: input.birthTx,
    gate_decision_id: input.gateDecisionId,
    name: sheet.name || null,
    symbol: sheet.symbol || null,
    decimals,
    total_supply: supply > 0n ? toBaseUnits(supply) : null,
    plates,
    locks,
    fee_instruction,
    observed_at: sheet.observedAt,
    unread: [...unread].sort(),
    stamp: BIRTH_RECORD_STAMP,
  };
}

/**
 * EVM addresses are case-insensitive, so they are folded; Solana base58 is NOT, and
 * folding it would produce an address that does not exist. Getting this backwards
 * silently corrupts every record on one rail, so it lives in one function.
 */
export function normaliseCa(address: string, chain: BirthChain): string {
  return chain === 'solana' ? address.trim() : address.trim().toLowerCase();
}

/**
 * The stable per-token route. THIS IS THE `record_url` ON THE WIRE, so it must not move:
 * the island stores it at enrollment and re-reads it later for hygiene and certification.
 *
 * Absolute, because the consumer is a server on somebody else's machine — a relative path
 * would be unresolvable to every one of the four consumers except the page itself.
 */
export function birthRecordUrl(chain: BirthChain, ca: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/record/${chain}/${normaliseCa(ca, chain)}.json`;
}

/**
 * Validate a record read back from the wire. Returns a human-readable reason, or null.
 *
 * Used by the page (to refuse to render a malformed twin) and by tests. Deliberately
 * strict about the things the island depends on and quiet about the rest.
 */
export function birthRecordFailure(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return 'The record is not an object.';
  const r = payload as Record<string, unknown>;
  if (r.schema_version !== BIRTH_RECORD_SCHEMA_VERSION) return `Unsupported record schema version: ${String(r.schema_version)}`;
  if (typeof r.ca !== 'string' || !r.ca) return 'The record names no contract address.';
  if (r.chain !== 'base' && r.chain !== 'ethereum' && r.chain !== 'solana') return 'The record names no known chain.';
  if (!Array.isArray(r.plates)) return 'The record has no plates.';
  if (!Array.isArray(r.locks)) return 'The record has no locks.';
  if (!Array.isArray(r.fee_instruction)) return 'The record has no fee instruction.';
  if (!Array.isArray(r.unread)) return 'The record does not say what it could not read.';
  if (r.stamp !== BIRTH_RECORD_STAMP) return 'The record is missing its stamp.';
  return null;
}
