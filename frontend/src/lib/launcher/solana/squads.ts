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
// `verifySquadsVault` now proves FOUR things: (1) owner — the parent is a Squads-v4-owned
// account, (2) PDA binding — the fee address is that parent's canonical vault PDA,
// (3) custody — the parent is a genuine `Multisig` account (verified by its 8-byte Anchor
// discriminator) whose threshold is >= 2, and (4) DURABILITY of (3) — the block below.
// This closes two holes the owner-only check left open; both now FAIL CLOSED:
//   • a 1-of-1 Squads multisig (threshold = 1) — a SINGLE-KEY drain of ALL accrued Solana
//     fees — is rejected; and
//   • any OTHER Squads-program-owned account type (Proposal / VaultTransaction /
//     ProgramConfig) is rejected, because its discriminator is not the `Multisig` one.
// Done WITHOUT the `@sqds/multisig` SDK (no new dep) via a discriminator-GUARDED byte read
// (see `readMultisigConfig`). The guard is what makes the hand-rolled offsets safe — the
// earlier concern was that a wrong offset could ACCEPT a 1-of-1; here we only ever read the
// threshold offset of a real `Multisig` account, so a wrong account type returns null and
// is rejected, never accepted. Offsets triple-confirmed (Anchor layout math, Squads v4
// state.rs, and the operator's on-chain read of the production vault). An independent
// Squads-tooling cross-check at go-live remains good practice.
// -----------------------------------------------------------------------------
//
// …AND A THRESHOLD IS ONLY WORTH READING IF IT CANNOT MOVE (2026-09-10).
// -----------------------------------------------------------------------------
// The threshold check above is a POINT-IN-TIME read of a MUTABLE value, and until now
// nothing here said so. Squads v4 multisigs come in two shapes:
//   • AUTONOMOUS — `config_authority == Pubkey::default()` (32 zero bytes). Changing the
//     threshold, adding a member or removing one goes through the multisig's OWN proposal
//     process, i.e. it needs the very threshold this module just checked.
//   • CONTROLLED — `config_authority` is some key. That ONE key calls the config
//     instructions directly. A 3-of-5 read here becomes a 1-of-1 the moment the read
//     returns, at the sole discretion of a single signer, and the fee address we are about
//     to bless is then drainable by that signer alone — the EXACT outcome this module
//     exists to prevent, arrived at one transaction later.
// So the >= 2 rule only means anything on an AUTONOMOUS multisig, and `readMultisigConfig`
// returns the threshold and that fact TOGETHER out of one discriminator-guarded read. It
// deliberately REPLACES the old `readMultisigThreshold`: a decoder that hands back a
// threshold WITHOUT its mutability is a decoder a future caller can use to rebuild this
// hole, and this file's own doctrine is that an unprovable property must not be readable
// as a proven one.
//
// The live vault happens to be autonomous. That was never something this code KNEW — it
// was a property of the operator's configuration that the guard silently rode on. It is
// checked now, so a DIFFERENT multisig cannot be blessed on the strength of this one's
// configuration.
// -----------------------------------------------------------------------------
//
// ⚠️ NOTHING CALLS `verifySquadsVault` TODAY, AND THAT IS STATED HERE ON PURPOSE.
// -----------------------------------------------------------------------------
// Its only importers were the Meteora DBC modules, deleted 2026-08-23. Since then the
// export has had ZERO production callers — squads.test.ts is the only file that reaches
// it — so the hole fixed above was never live, and closing it is hardening, not an
// incident. Do not read the fix as "the guard now protects the treasury": the guard
// protects nothing until something calls it.
//
// WHERE IT BELONGS, precisely: `frontend/scripts/tegridy-launch-operator.mjs`, the
// `init-global` command. It takes `--fee-recipient <base58>` and its own help text says
// "mainnet: the treasury Squads vault" — then accepts any parseable pubkey, an EOA
// included. That value becomes `global.fee_recipient`, which is the account every trade
// fee on the own-venue curve accrues to, i.e. exactly the custody this module exists to
// prove. Wiring it is NOT a one-liner and is deliberately left out of the change that
// fixed the guard: `SquadsVaultRef` needs provenance the CLI does not collect yet (two
// new flags — the parent multisig and the vault index), the check must stay opt-in so a
// devnet ceremony can still point at a plain wallet, and that script has no test harness
// on this box to prove either behaviour. Wire it in a change that can verify it.
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

// ── Squads v4 `Multisig` account layout (for the custody checks) ─────────────
// Anchor account discriminator = sha256("account:Multisig")[0..8]. Computed and
// pinned 2026-07-26 (standard Anchor derivation for the v4 `Multisig` struct).
// Guards the reads below: without it, a DIFFERENT Squads-program account
// (Proposal / VaultTransaction / ProgramConfig) would be byte-parsed as a Multisig
// and yield a garbage "threshold" and a garbage "config_authority".
const MULTISIG_DISCRIMINATOR = Uint8Array.from([224, 116, 121, 186, 68, 161, 79, 236]);
// Layout after the 8-byte discriminator (github.com/Squads-Protocol/v4 state.rs):
//   create_key: Pubkey(32) @8 · config_authority: Pubkey(32) @40 · threshold: u16 @72.
const CONFIG_AUTHORITY_OFFSET = 40;
const CONFIG_AUTHORITY_LEN = 32;
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

/** What one discriminator-guarded read of a Squads v4 `Multisig` account yields. */
export interface MultisigConfig {
  /** `threshold`: u16 LE @72 — how many members must sign a vault transaction. */
  threshold: number;
  /**
   * `config_authority == Pubkey::default()` — i.e. NOBODY can rewrite this multisig's
   * config unilaterally, so `threshold` above is a property of the multisig rather than
   * of one key's current goodwill. `false` means a single signer can set the threshold
   * to 1 whenever it likes, which makes the threshold read meaningless.
   */
  autonomous: boolean;
}

/**
 * Parse a Squads v4 `Multisig`'s threshold AND its mutability from raw account data, but
 * ONLY if the data is a genuine `Multisig` account (proven by its 8-byte Anchor
 * discriminator). Returns `null` when the data is not a Multisig account / is too short.
 * A `null` result means "cannot prove multisig custody" and the caller MUST treat it as
 * fail-closed (reject).
 *
 * THE TWO FIELDS COME BACK TOGETHER ON PURPOSE. This replaced `readMultisigThreshold`,
 * which returned the threshold alone — and a threshold alone is a point-in-time read of a
 * value one key may be free to change (see the module header). Handing both out of a
 * single call is what stops a caller from checking `>= 2` and believing it will hold.
 *
 * FAIL-CLOSED BY CONSTRUCTION — this is what makes the hand-rolled offsets safe (the
 * concern the module header used to raise). The discriminator check guarantees we only
 * ever read offsets 40 and 72 of an actual `Multisig` account, whose fixed layout puts
 * `config_authority` and `threshold` there; any other account type, or short data,
 * returns `null` (reject) rather than a spuriously-high threshold — or a spurious
 * "autonomous" — that would ACCEPT a bad vault. Never throws; pure. Exported for unit
 * testing.
 */
export function readMultisigConfig(data: Uint8Array | null | undefined): MultisigConfig | null {
  if (!data || data.length < THRESHOLD_OFFSET + 2) return null;
  for (let i = 0; i < MULTISIG_DISCRIMINATOR.length; i++) {
    if (data[i] !== MULTISIG_DISCRIMINATOR[i]) return null; // not a `Multisig` account
  }
  // config_authority: Pubkey(32) @40. All-zero is Pubkey::default(), i.e. "no authority".
  let autonomous = true;
  for (let i = CONFIG_AUTHORITY_OFFSET; i < CONFIG_AUTHORITY_OFFSET + CONFIG_AUTHORITY_LEN; i++) {
    if (data[i] !== 0) {
      autonomous = false;
      break;
    }
  }
  // threshold: u16, little-endian, at offset 72.
  const threshold = data[THRESHOLD_OFFSET]! | (data[THRESHOLD_OFFSET + 1]! << 8);
  return { threshold, autonomous };
}

/**
 * Verify on-chain that `ref.address` is genuinely the Squads v4 vault PDA of a real
 * Squads multisig — the multisig-custodied account that can actually sign the Meteora
 * fee claim. Every check below is required; any one of them failing returns false:
 *   1. `ref.address === deriveSquadsVaultPda(ref.multisig, ref.vaultIndex)` — it IS
 *      that multisig's vault PDA (off-curve, System-owned by design), not an EOA or an
 *      unrelated account. This is a pure string compare (no fetch).
 *   2. the parent `ref.multisig` account exists and is owned by the Squads v4 program
 *      — proving the parent is a genuine Squads multisig config, not a look-alike.
 *
 * CHECKS THRESHOLD (2026-07-26): also requires the parent to be a genuine `Multisig`
 * account (8-byte discriminator) whose threshold is >= 2, so a 1-of-1 (single-key drain)
 * or a non-`Multisig` Squads account is rejected fail-closed. See `readMultisigConfig`
 * and the module header block for the discriminator-guarded rationale.
 *
 * CHECKS THAT THE THRESHOLD CANNOT MOVE (2026-09-10): and requires the multisig to be
 * AUTONOMOUS — `config_authority == Pubkey::default()`. A CONTROLLED multisig's threshold
 * is one transaction, by one key, away from 1, so a >= 2 read on it proves nothing about
 * the moment the fee address is actually used. This is the difference between "the vault
 * is safe" and "the vault is safe as long as its current owner keeps choosing to be";
 * only the first is something a guard can assert. See the module header.
 *
 * Returns:
 *   • `true`  — all four checks pass.
 *   • `false` — the address is not the derived vault PDA, or the multisig does not
 *               exist / is not Squads-owned / is not a `Multisig` account / is 1-of-1 /
 *               is CONTROLLED. Fail-closed: the operator wrapper must refuse the launch
 *               on `false`.
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

  // (3) It must be a genuine `Multisig` account (discriminator) with threshold >= 2, and
  //     (4) that threshold must be beyond any single key's reach — an AUTONOMOUS multisig.
  //     A 1-of-1 multisig is a single-key drain of all accrued fees; a CONTROLLED one is
  //     the same drain one config transaction later; a non-`Multisig` Squads account
  //     (Proposal / VaultTransaction) can never sign a claim at all. All three are
  //     fail-closed here: readMultisigConfig returns null → reject.
  const config = readMultisigConfig(info.data);
  return config !== null && config.autonomous && config.threshold >= MIN_MULTISIG_THRESHOLD;
}
