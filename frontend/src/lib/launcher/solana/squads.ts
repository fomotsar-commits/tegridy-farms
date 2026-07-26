// On-chain Squads v4 vault verification — the real invariant behind dbc.ts's
// off-chain `SquadsVault` brand.
//
// DOCTRINE (dbc.ts §Squads-vault invariant + README): Meteora's
// `claimPartnerTradingFee` signer has FULL custody of accrued fees — an EOA fee
// claimer is a single-key drain of all Solana revenue. `asSquadsVault` in dbc.ts
// is a *shape + affirmation* gate only; it CANNOT prove multisig custody because
// that requires an RPC round-trip. This module adds that round-trip.
//
// THE ACTUAL SQUADS v4 LAYOUT (this is the subtle, load-bearing part):
//   • The `Multisig` CONFIG account is owned by the Squads program.
//   • The asset-holding, CPI-SIGNING account is a separate "vault" PDA derived from
//     that multisig (seeds ["multisig", multisigPda, "vault", u8 index]). Like any
//     signer PDA it is owned by the SYSTEM program.
//   • When a Squads multisig executes a transaction, the inner instructions are
//     invoke_signed with the VAULT PDA's seeds — so the vault PDA is the signer.
//     Therefore Meteora's `feeClaimer` MUST be the vault PDA (System-owned), NOT the
//     config account. A naive "owner == Squads program" check would REJECT the real
//     vault and only pass the config account, which can never sign a claim → a
//     funds-lock trap. We do NOT do that.
//
// CORRECT CHECK (what this module enforces): the operator supplies the fee address
// TOGETHER WITH its provenance (parent multisig + vault index). We (1) DERIVE the
// canonical vault PDA from that provenance and require the fee address to equal it —
// proving it is a real Squads vault PDA (off-curve, not an EOA), and (2) confirm the
// parent multisig account is owned by the Squads v4 program — proving the parent is a
// genuine Squads multisig, not a look-alike. Fail-closed: any mismatch returns false.
//
// THRESHOLD IS ENFORCED (2026-07-26 — previously an out-of-band manual check).
// -----------------------------------------------------------------------------
// `verifySquadsVault` now proves THREE things: (1) owner — the parent is a Squads-v4-owned
// account, (2) PDA binding — the fee address is that parent's canonical vault PDA, and
// (3) custody — the parent is a genuine `Multisig` account (verified by its 8-byte Anchor
// discriminator) whose threshold is >= 2. This closes two holes the owner-only check left
// open; both now FAIL CLOSED:
//   • a 1-of-1 Squads multisig (threshold = 1) — a SINGLE-KEY drain of ALL accrued Solana
//     fees — is rejected; and
//   • any OTHER Squads-program-owned account type (Proposal / VaultTransaction /
//     ProgramConfig) is rejected, because its discriminator is not the `Multisig` one.
// Done WITHOUT the `@sqds/multisig` SDK (no new dep) via a discriminator-GUARDED byte read
// (see `readMultisigThreshold`). The guard is what makes the hand-rolled offset safe — the
// earlier concern was that a wrong offset could ACCEPT a 1-of-1; here we only ever read the
// threshold offset of a real `Multisig` account, so a wrong account type returns null and
// is rejected, never accepted. Offset triple-confirmed (Anchor layout math, Squads v4
// state.rs, and the operator's on-chain read of the production vault). An independent
// Squads-tooling cross-check at go-live remains good practice.
// -----------------------------------------------------------------------------
//
// Program id verified 2026-07-17 against the Squads Protocol v4 deployment
// (github.com/Squads-Protocol/v4, docs.squads.so, Solscan) — mainnet-beta:
//   SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
// Vault seeds mirror the Squads v4 SDK `getVaultPda`. Both MUST be revalidated
// against a live Squads multisig during Solana go-live before the flag flips (a
// seed/id error fails closed — it rejects the real vault — so it surfaces in
// go-live testing, never as a silent misroute).

import { PublicKey, type Connection } from '@solana/web3.js';

/** Squads Protocol v4 program (mainnet-beta == the id used on devnet forks). */
export const SQUADS_V4_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

const SQUADS_V4_PROGRAM_PUBKEY = new PublicKey(SQUADS_V4_PROGRAM_ID);

// Squads v4 vault PDA seeds (SDK getVaultPda): ["multisig", <multisig>, "vault", u8].
const SEED_PREFIX = Buffer.from('multisig');
const SEED_VAULT = Buffer.from('vault');

// ── Squads v4 `Multisig` account layout (for the threshold check) ────────────
// Anchor account discriminator = sha256("account:Multisig")[0..8]. Computed and
// pinned 2026-07-26 (standard Anchor derivation for the v4 `Multisig` struct).
// Guards the threshold read below: without it, a DIFFERENT Squads-program account
// (Proposal / VaultTransaction / ProgramConfig) would be byte-parsed as a Multisig
// and yield a garbage "threshold".
const MULTISIG_DISCRIMINATOR = Uint8Array.from([224, 116, 121, 186, 68, 161, 79, 236]);
// Layout after the 8-byte discriminator (github.com/Squads-Protocol/v4 state.rs):
//   create_key: Pubkey(32) @8 · config_authority: Pubkey(32) @40 · threshold: u16 @72.
const THRESHOLD_OFFSET = 72;
// A threshold of 1 is a single-key drain of all accrued fees — the exact thing the
// vault gate exists to prevent. Genuine multisig custody requires >= 2 signers.
const MIN_MULTISIG_THRESHOLD = 2;

/**
 * The fee address the operator will set on-chain, WITH the provenance needed to
 * prove it is a Squads v4 vault PDA rather than an arbitrary account/EOA.
 */
export interface SquadsVaultRef {
  /** The fee address that goes on-chain as feeClaimer / leftoverReceiver / receiver. */
  address: string;
  /** The parent Squads v4 multisig (config account, owned by the Squads program). */
  multisig: string;
  /** The vault index under that multisig (u8, 0..255). */
  vaultIndex: number;
}

/**
 * Derive the Squads v4 VAULT PDA for a multisig + vault index. Mirrors the Squads v4
 * SDK `getVaultPda`: findProgramAddress(["multisig", multisig, "vault", u8(index)]).
 * The returned PDA is a SYSTEM-owned, off-curve signer account — the one that holds
 * assets and signs CPIs, i.e. what Meteora's `claimPartnerTradingFee` needs as the
 * fee-claim signer. Pure — no chain access.
 */
export function deriveSquadsVaultPda(multisig: string, vaultIndex: number): string {
  if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
    throw new Error(`deriveSquadsVaultPda: vaultIndex must be a u8 (0..255), got ${vaultIndex}`);
  }
  const multisigPk = new PublicKey((multisig ?? '').trim()); // throws on malformed base58
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_PREFIX, multisigPk.toBuffer(), SEED_VAULT, Uint8Array.from([vaultIndex])],
    SQUADS_V4_PROGRAM_PUBKEY,
  );
  return pda.toBase58();
}

/**
 * Parse the multisig threshold from raw Squads account data, but ONLY if the data is a
 * genuine Squads v4 `Multisig` account (proven by its 8-byte Anchor discriminator).
 * Returns the threshold, or `null` when the data is not a Multisig account / is too
 * short. A `null` result means "cannot prove multisig custody" and the caller MUST treat
 * it as fail-closed (reject).
 *
 * FAIL-CLOSED BY CONSTRUCTION — this is what makes the hand-rolled offset safe (the
 * concern the module header used to raise). The discriminator check guarantees we only
 * ever read offset 72 of an actual `Multisig` account, whose fixed layout puts the
 * threshold there; any other account type, or short data, returns `null` (reject) rather
 * than a spuriously-high threshold that would ACCEPT a bad vault. Never throws; pure.
 * Exported for unit testing.
 */
export function readMultisigThreshold(data: Uint8Array | null | undefined): number | null {
  if (!data || data.length < THRESHOLD_OFFSET + 2) return null;
  for (let i = 0; i < MULTISIG_DISCRIMINATOR.length; i++) {
    if (data[i] !== MULTISIG_DISCRIMINATOR[i]) return null; // not a `Multisig` account
  }
  // threshold: u16, little-endian, at offset 72.
  return data[THRESHOLD_OFFSET]! | (data[THRESHOLD_OFFSET + 1]! << 8);
}

/**
 * Verify on-chain that `ref.address` is genuinely the Squads v4 vault PDA of a real
 * Squads multisig — the multisig-custodied account that can actually sign the Meteora
 * fee claim. Both checks are required:
 *   1. `ref.address === deriveSquadsVaultPda(ref.multisig, ref.vaultIndex)` — it IS
 *      that multisig's vault PDA (off-curve, System-owned by design), not an EOA or an
 *      unrelated account. This is a pure string compare (no fetch).
 *   2. the parent `ref.multisig` account exists and is owned by the Squads v4 program
 *      — proving the parent is a genuine Squads multisig config, not a look-alike.
 *
 * CHECKS THRESHOLD (2026-07-26): also requires the parent to be a genuine `Multisig`
 * account (8-byte discriminator) whose threshold is >= 2, so a 1-of-1 (single-key drain)
 * or a non-`Multisig` Squads account is rejected fail-closed. See `readMultisigThreshold`
 * and the module header block for the discriminator-guarded rationale.
 *
 * Returns:
 *   • `true`  — both checks pass.
 *   • `false` — the address is not the derived vault PDA, or the multisig does not
 *               exist / is not Squads-owned. Fail-closed: the operator wrapper must
 *               refuse the launch on `false`.
 *
 * Throws only on malformed input (empty/invalid base58) or an RPC failure — a
 * transport error is NOT silently coerced to `false` (that would let a network blip
 * masquerade as "not a vault" and, worse, let a later retry pass). Uses a single
 * `getAccountInfo` (no WS subscription), so only an https RPC endpoint is required.
 */
export async function verifySquadsVault(connection: Connection, ref: SquadsVaultRef): Promise<boolean> {
  const address = (ref?.address ?? '').trim();
  const multisig = (ref?.multisig ?? '').trim();
  if (address.length === 0) {
    throw new Error('verifySquadsVault: address is empty');
  }
  if (multisig.length === 0) {
    throw new Error('verifySquadsVault: multisig is empty');
  }

  // (1) The fee address must be THIS multisig's canonical vault PDA. Pure derive +
  //     compare — an EOA or an unrelated account cannot match an off-curve PDA.
  const expectedVault = deriveSquadsVaultPda(multisig, ref.vaultIndex);
  if (address !== expectedVault) {
    return false;
  }

  // (2) The parent multisig must be a real Squads v4 program account.
  const multisigPk = new PublicKey(multisig); // throws on malformed → surfaced
  // Let RPC/transport errors propagate (see doc above).
  const info = await connection.getAccountInfo(multisigPk);
  if (!info) {
    return false; // multisig account not found — cannot be a Squads multisig
  }
  if (!info.owner.equals(SQUADS_V4_PROGRAM_PUBKEY)) {
    return false; // not Squads-owned — a look-alike
  }

  // (3) It must be a genuine `Multisig` account (discriminator) with threshold >= 2.
  //     A 1-of-1 multisig is a single-key drain of all accrued fees; a non-`Multisig`
  //     Squads account (Proposal / VaultTransaction) can never sign a claim. Both are
  //     fail-closed here: readMultisigThreshold returns null → reject.
  const threshold = readMultisigThreshold(info.data);
  return threshold !== null && threshold >= MIN_MULTISIG_THRESHOLD;
}
