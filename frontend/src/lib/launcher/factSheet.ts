// Launch Fact Sheet — machine-generated DISCLOSURE, not an endorsement.
//
// Red-team disposition F (docs/LAUNCHER_STRATEGY.md §8): a "certificate" reads
// as a signed safety endorsement and creates issuer liability. A Fact Sheet is
// the opposite: it states verifiable facts and enumerates residual powers in
// plain language. Nothing here is scored "safe"; a token that fails to qualify
// for a tier is not labelled "unsafe" — its disclosures simply show why it does
// not meet the tier's structural bar. All wording is neutral and factual.

import type { Address, Hex } from 'viem';

/** Tiers are STRUCTURAL gates, not quality ratings. See gate.ts. */
export type LaunchTier =
  | 'flagship' // Tier-F: structurally rug-impossible config (§2.3)
  | 'listable' // Tier-L: automated hygiene bar met (§2.3)
  | 'none'; // does not meet a tier bar — disclosures still published

/** A single residual power the token contract grants someone. Disclosure-only. */
export interface ResidualPower {
  power:
    | 'mint'
    | 'pause'
    | 'blacklist'
    | 'fee-on-transfer'
    | 'upgrade'
    | 'balance-limit'
    | 'owner-privileged';
  present: boolean;
  /** Who holds it, if present (owner / admin / timelock address). */
  holder?: Address | null;
  /** Plain-language, buyer-facing sentence. Always factual, never reassuring. */
  disclosure: string;
  /**
   * THE THIRD STATE for `present`. FALSE when the read behind this power never
   * landed — as opposed to landing and reporting the power absent.
   *
   * `present: false` had two meanings and one of them is a lie: a 429 on
   * `isBalanceLimitActive()` degrades to `false`, which reads out as "No maximum
   * wallet balance is enforced." — a statement about a contract nobody queried,
   * folded permanently into `disclosuresDigest`.
   *
   * Emitted ONLY when false. Absent means read, so every existing producer and
   * every already-computed digest is byte-for-byte unaffected.
   */
  readable?: boolean;
}

/** LP lock disclosure. */
export interface LiquidityDisclosure {
  locked: boolean;
  locker?: Address | null;
  /** Unix seconds; null = no lock / perpetual / unknown (see `note`). */
  unlockAt: number | null;
  note: string;
  /**
   * FALSE when the lock state was never read at all — as opposed to read and found
   * unlocked. Absent means read, so every existing producer is unaffected.
   *
   * This exists because `locked: false` had two meanings and only one of them was true.
   * `readMigrationStream` is inert against the V1 locker (no token -> position-tokenId
   * index exists), so it returns a hardcoded `locked: false` without touching the chain,
   * and `note` then read "Liquidity is not locked; it may be withdrawable by the
   * liquidity owner." — a claim about a locker nobody queried.
   *
   * That sentence is not cosmetic: `attestation.canonicalDisclosuresJson` folds this
   * whole object into `disclosuresDigest`, which is published ON-CHAIN. An unverified
   * assertion was being committed permanently.
   */
  readable?: boolean;
}

/** One line of the launch's fee constitution. Shares are basis points of the trade fee. */
export interface FeeConstitutionLine {
  recipient: string; // label or address
  shareBps: number;
  role: 'creator' | 'attention-beneficiary' | 'protocol-stakers' | 'protocol-pol' | 'doppler' | 'other';
}

/** One vesting schedule attached to an allocation. */
export interface VestingSchedule {
  beneficiary: Address;
  amount: bigint;
  cliffSeconds: number;
  durationSeconds: number;
}

/**
 * The full Fact Sheet. Produced by the automated collector + gate, attestable
 * to EAS (see FACT_SHEET_EAS_SCHEMA). Serialisable: bigints are stringified at
 * the attestation boundary, not here.
 */
export interface LaunchFactSheet {
  /**
   * Envelope version. Committed by the disclosures digest (see
   * attestation.canonicalDisclosuresJson) so a silently bumped schemaVersion is
   * tamper-evident even though it is not a flat ABI column.
   */
  schemaVersion: 1;
  // identity
  token: Address;
  chainId: number;
  name: string;
  symbol: string;
  totalSupply: bigint;
  // provenance
  tokenFactory: Address | null;
  /** codehash of the deployed token, for template-match auditing. */
  templateCodehash: Hex | null;
  /** true iff `tokenFactory` is in KNOWN_SAFE_TOKEN_FACTORIES. */
  knownSafeTemplate: boolean;
  // disclosures
  residualPowers: ResidualPower[];
  liquidity: LiquidityDisclosure;
  feeConstitution: FeeConstitutionLine[];
  vesting: VestingSchedule[];
  /**
   * THE THIRD STATE for `vesting`. FALSE when the per-beneficiary schedules were
   * never ENUMERATED — as opposed to enumerated and found to be none.
   *
   * `vesting: []` had two meanings and one of them is a lie. The on-chain collector
   * cannot enumerate schedules at all: DopplerERC20V1 exposes `vestedTotalAmount()`
   * (a single total) and `vestingStart()`, and there is no per-beneficiary index to
   * walk. So `collectTokenFacts` returns an empty array for every token, and
   * `canonicalDisclosuresJson` folds that empty array into the ON-CHAIN digest — an
   * unknown published as the value "none".
   *
   * Emitted ONLY when false. Absent means enumerated, so a caller that really does
   * know the schedules (the wizard projection, a graduated-locker read) is unchanged
   * and its digest does not move.
   */
  vestingReadable?: boolean;
  /** Basis points of supply held by team/insiders, and how much of that is on-chain-vested. */
  teamAllocationBps: number;
  teamAllocationVestedBps: number;
  // outcome
  tier: LaunchTier;
  /**
   * THE THIRD STATE for `tier`. FALSE when the gate could not actually DECIDE —
   * i.e. at least one check rested on an input nobody read, and the tier would flip
   * depending on how that unread input resolved.
   *
   * `tier: 'none'` had two meanings and one of them is a lie: "evaluated, does not
   * meet the bar" and "could not be evaluated". The launch-time attest path hits the
   * second one on every launch — it re-collects with no LockResolver, the LP-lock
   * checks fail on an unqueried locker, and a token the wizard rendered FLAGSHIP one
   * screen earlier encodes as `tier = 0` (see TIER_CODE) permanently, on someone
   * else's token.
   *
   * The uint8 `tier` column has no room for a third value, so the honest move is not
   * to encode a fourth code — it is to REFUSE. `attestation.attestationRefusal()`
   * reads this field and blocks the write. Same for the `uint64 liquidityUnlockAt`
   * column, whose 0 means both "no lock" and "not read".
   *
   * Emitted ONLY when false. Absent means the gate decided, so every existing
   * producer and every already-computed digest is byte-for-byte unaffected.
   */
  tierDeterminate?: boolean;
  /** Every gate check with its pass/fail and reason — the audit trail. */
  gateChecks: GateCheck[];
  /** When these facts were read (unix seconds). Facts are point-in-time. */
  observedAt: number;
}

/** One deterministic gate check. */
export interface GateCheck {
  id: string;
  /** Which tier this check is required for. */
  requiredFor: 'listable' | 'flagship';
  passed: boolean;
  detail: string;
  /**
   * THE THIRD STATE for `passed`. FALSE when this check's INPUT was never read, so
   * `passed` is the conservative fallback rather than a finding.
   *
   * A gate substitutes the value that CLOSES the gate when a read fails, which is
   * right for tiering and wrong for publishing — and in two places it is not even
   * gate-closing: an unread `owner()` degrades to `null` degrades to "ownership
   * renounced", which PASSES the flagship admin bar, and an unread
   * `vestedTotalAmount()` degrades to 0 bps, which PASSES the insider-float cap.
   * A fabricated pass and a fabricated fail are the same defect.
   *
   * Emitted ONLY when false, so a determinate audit trail digests exactly as before.
   */
  readable?: boolean;
}

/**
 * Canonical EAS schema string for on-chain Fact Sheets. Kept deliberately
 * flat + primitive so it encodes cleanly and stays cheap. The disclosuresDigest
 * column commits to the ENTIRE sheet — the flat columns here AND everything else
 * (the rich arrays residualPowers / liquidity / feeConstitution / vesting, plus
 * gateChecks / totalSupply / tokenFactory / name / symbol / schemaVersion) are all
 * folded into the keccak digest of the canonical JSON (see
 * attestation.canonicalDisclosuresJson). Folding the flat columns in too is
 * belt-and-suspenders: a consumer verifying tamper-evidence by recomputing the
 * digest alone still catches a forged flat field. The full JSON is published
 * off-chain and pinned, so the attestation commits to the WHOLE sheet (a forged
 * gate check, an altered supply, or a swapped tier changes the digest) without
 * bloating calldata.
 *
 * Revocable by design (red-team F): if facts change or an error is found, the
 * attester revokes. An attestation is a timestamped disclosure, not a warranty.
 */
export const FACT_SHEET_EAS_SCHEMA =
  'address token,uint256 chainId,bytes32 templateCodehash,bool knownSafeTemplate,uint8 tier,uint16 teamAllocationBps,uint16 teamAllocationVestedBps,uint64 liquidityUnlockAt,bytes32 disclosuresDigest,uint64 observedAt';

export const TIER_CODE: Record<LaunchTier, number> = {
  none: 0,
  listable: 1,
  flagship: 2,
};
