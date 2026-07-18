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
}

/** LP lock disclosure. */
export interface LiquidityDisclosure {
  locked: boolean;
  locker?: Address | null;
  /** Unix seconds; null = no lock / perpetual / unknown (see `note`). */
  unlockAt: number | null;
  note: string;
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
  /** Basis points of supply held by team/insiders, and how much of that is on-chain-vested. */
  teamAllocationBps: number;
  teamAllocationVestedBps: number;
  // outcome
  tier: LaunchTier;
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
