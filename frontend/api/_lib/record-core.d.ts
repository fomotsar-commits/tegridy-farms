// Types for record-core.js — the shared birth-record core.
//
// The runtime lives in the sibling .js because a Vercel lambda cannot import a .ts
// module and the alternative was a hand-maintained JS fork. See record-core.js's header
// for the full reasoning. This file is erased at build time; it exists so the browser
// side keeps every type it had when this module was birthRecord.ts.

import type { LaunchFactSheet, FeeConstitutionLine } from '../../src/lib/launcher/factSheet';

export declare const BIRTH_RECORD_SCHEMA_VERSION: 1;
export declare const BIRTH_RECORD_STAMP: 'Every lock verifiable onchain.';

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
  /** Plain-language name: 'Public sale', 'Team allocation (on-chain vested)'. */
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
  creator: string | null;
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
  /** Null/absent when the creator could not be established. Never a zero address. */
  creator?: string | null;
  birthBlock?: number | null;
  birthTx?: string | null;
  gateDecisionId?: string | null;
  /**
   * The rail's decimals, already resolved by the caller — see `railDecimals`.
   * Passed in rather than inferred here, so this module never guesses a precision.
   */
  decimals?: number | null;
  /**
   * FALSE when the liquidity lock state was never queried at all.
   *
   * Defaults to true so every existing producer is unaffected. Set it false and the
   * record makes no claim about the lock either way, instead of inheriting the fact
   * sheet's "Liquidity is not locked" sentence — which, on a rail where the locker read
   * is inert, is an assertion about something nobody asked.
   */
  liquidityReadable?: boolean;
  /** Field names the caller could not read. Merged with the ones detected here. */
  unread?: readonly string[];
}

/**
 * Extract the implementation address from a known minimal-proxy runtime, or null.
 * Recognises both EIP-1167 and Solady LibClone — Doppler deploys the Solady layout.
 */
export declare function cloneImplTarget(code: `0x${string}` | undefined | null): `0x${string}` | null;

export declare const UNREAD_FIELD_BY_METHOD: Readonly<Record<string, string>>;
export declare function recordUnreadFrom(methodNames: readonly string[] | undefined): string[];
export declare function railDecimals(chain: BirthChain, snapshot?: number | null): number | null;
export declare function buildBirthRecord(input: BirthRecordInput): BirthRecord;
export declare function normaliseCa(address: string, chain: BirthChain): string;
export declare function birthRecordUrl(chain: BirthChain, ca: string, origin: string): string;
export declare function birthRecordFailure(payload: unknown): string | null;
