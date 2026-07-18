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
// ⚠️⚠️  THRESHOLD IS NOT ENFORCED — HARD GO-LIVE REQUIREMENT  ⚠️⚠️
// -----------------------------------------------------------------------------
// `verifySquadsVault` proves ONLY (1) owner: the parent is a Squads-v4-owned account,
// and (2) PDA binding: the fee address is that parent's canonical vault PDA. It does
// NOT deserialize the multisig config, so it CANNOT and DOES NOT check the multisig
// THRESHOLD or member set. Consequences the current runtime check will happily pass:
//   • a 1-of-1 Squads multisig (threshold = 1) — functionally a SINGLE-KEY drain of
//     ALL accrued Solana fees, defeating the entire "multisig custody" invariant; and
//   • any OTHER Squads-program-owned account type (a Proposal / VaultTransaction /
//     ProgramConfig), since only the program-owner is checked, not the 8-byte anchor
//     discriminator that distinguishes a `Multisig` account.
// Closing this in-code needs the `@sqds/multisig` SDK (accounts.Multisig.fromAccountInfo
// → assert discriminator + threshold >= 2 over >= 2 distinct members). That dep is NOT
// installed and no new deps are permitted on this branch, so hand-rolled byte-offset
// parsing is deliberately AVOIDED — a wrong offset could ACCEPT a 1-of-1 (not fail
// closed), which is strictly worse than the honest gap documented here.
// THEREFORE, before the Solana launcher flag flips at go-live, the operator MUST
// verify with Squads tooling (Squads app / SDK) that the configured feeClaimer's parent
// is a genuine `Multisig` account with threshold >= 2. The `derive-vault` command in
// scripts/solana-dbc-operator.mjs prints this same warning at operate time.
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
 * Verify on-chain that `ref.address` is genuinely the Squads v4 vault PDA of a real
 * Squads multisig — the multisig-custodied account that can actually sign the Meteora
 * fee claim. Both checks are required:
 *   1. `ref.address === deriveSquadsVaultPda(ref.multisig, ref.vaultIndex)` — it IS
 *      that multisig's vault PDA (off-curve, System-owned by design), not an EOA or an
 *      unrelated account. This is a pure string compare (no fetch).
 *   2. the parent `ref.multisig` account exists and is owned by the Squads v4 program
 *      — proving the parent is a genuine Squads multisig config, not a look-alike.
 *
 * ⚠️ DOES NOT CHECK THRESHOLD: this proves owner + PDA binding ONLY. A 1-of-1 multisig
 * (threshold = 1) — a single-key drain — passes, as would a non-`Multisig` Squads
 * account type. Enforcing threshold >= 2 needs the `@sqds/multisig` SDK (not installed;
 * no new deps) and is a HARD go-live requirement verified out-of-band. See the module
 * header block for the full rationale.
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
  return info.owner.equals(SQUADS_V4_PROGRAM_PUBKEY);
}
