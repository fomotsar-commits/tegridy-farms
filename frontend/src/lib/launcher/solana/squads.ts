// On-chain Squads v4 ownership check — the real invariant behind dbc.ts's
// off-chain `SquadsVault` brand.
//
// DOCTRINE (dbc.ts §Squads-vault invariant + README): Meteora's
// `claimPartnerTradingFee` signer has FULL custody of accrued fees — an EOA fee
// claimer is a single-key drain of all Solana revenue. `asSquadsVault` in dbc.ts
// is a *shape + affirmation* gate only (it rejects empty / malformed / the
// default system pubkey and brands the string); it CANNOT prove multisig
// ownership because that requires an RPC round-trip. This module adds that
// round-trip: it asks the chain whether the account is owned by the Squads v4
// program before the operator's signing wrapper submits the first real launch.
//
// Program id verified 2026-07-17 against the Squads Protocol v4 deployment
// (github.com/Squads-Protocol/v4, docs.squads.so, Solscan) — mainnet-beta:
//   SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
//
// NUANCE the operator MUST understand (documented, not hidden):
//   In Squads v4 the on-chain `Multisig` CONFIG account is owned by the Squads
//   program (this check passes on it). The asset-holding "vault" is a PDA derived
//   from that multisig (seeds ["multisig", multisigPda, "vault", index]) and, like
//   any signer PDA, is owned by the SYSTEM program — so a raw vault-PDA address
//   will NOT pass this check. The intent of the invariant is to prove the fee
//   authority is governed by a Squads multisig (owner == Squads program), i.e. it
//   is NOT a lone EOA (owner == System program). The operator configures the
//   `feeClaimer` as the multisig-governed authority and routes claims through the
//   multisig; this function is the block-0 guard that the address is that, not an
//   EOA. See README "Why the fee claimer MUST be a Squads vault".

import { PublicKey, type Connection } from '@solana/web3.js';

/** Squads Protocol v4 program (mainnet-beta == the id used on devnet forks). */
export const SQUADS_V4_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

const SQUADS_V4_PROGRAM_PUBKEY = new PublicKey(SQUADS_V4_PROGRAM_ID);

/**
 * Verify on-chain that `address` is a Squads v4 program-owned account (a
 * multisig-governed authority), NOT an EOA.
 *
 * Returns:
 *   • `true`  — the account exists and its owner is the Squads v4 program.
 *   • `false` — the account does not exist, or exists but is owned by another
 *               program (e.g. the System program → a plain EOA/wallet). Fail-closed:
 *               the operator wrapper must refuse the launch on `false`.
 *
 * Throws only on a malformed address or an RPC failure — a transport error is NOT
 * silently coerced to `false` (that would let a network blip masquerade as "not a
 * vault" and, worse, a later retry pass); the operator sees the real failure and
 * retries deliberately. Uses a single `getAccountInfo` (no WS subscription), so
 * only an https RPC endpoint is required.
 */
export async function verifySquadsVault(connection: Connection, address: string): Promise<boolean> {
  const trimmed = (address ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error('verifySquadsVault: address is empty');
  }
  // Throws on malformed base58 — surfaced to the operator, not swallowed.
  const pubkey = new PublicKey(trimmed);

  // Let RPC/transport errors propagate (see doc above).
  const info = await connection.getAccountInfo(pubkey);
  if (!info) {
    return false; // account not found — cannot be a Squads multisig
  }
  return info.owner.equals(SQUADS_V4_PROGRAM_PUBKEY);
}
