// The site's swap fee on a trade through one of OUR pools, and whether this build may
// compare or use those pools at all. Pure: no React, no write layer, no network.
//
// THE RULE (owner): the route a trade takes never changes the fee. Jupiter's route
// charges the platform fee from env (VITE_SOLANA_PLATFORM_FEE_BPS, paid to the account
// VITE_SOLANA_FEE_ACCOUNT owns). Our own route charges the COMMITTED rate below, to the
// team vault's wrapped-SOL account (siteFeeAccount.ts). So our route exists only on a
// build whose env AGREES with the committed values (`siteFeeAgrees`): the vault, and
// exactly 50 bps. An env edit can switch our route off; it can never change what our
// route charges or where the fee goes.
//
// The fee ACCOUNT lives in siteFeeAccount.ts, not here: it is derived when its module
// loads, and that derivation throws under jsdom (a realm mismatch inside web3.js). This
// file is the one pages and components import, so it must load anywhere.

import { hasProgramId } from '../cpswap/program';
import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { lpWriteMode, ownPoolRouteMode } from '../../launcher/solana/lpWriteFlag';
import { SOLANA_FEE_ACCOUNT, SOLANA_PLATFORM_FEE_BPS } from '../../solana';

/** The site's swap fee, committed. Env must AGREE with it (siteFeeAgrees) or our route is off. Never read from env. */
export const SITE_SWAP_FEE_BPS = 50n;

const BPS_DENOMINATOR = 10_000n;

/**
 * floor(x * 50 / 10000): Jupiter's own rounding for its platform fee (measured live:
 * 100,000,199 lamports -> 500,000). `x` must be 0 or more; a negative amount is a bug
 * in the caller, and it throws rather than return a "fee" that would pay the trader.
 */
export function siteFee(x: bigint): bigint {
  if (x < 0n) throw new RangeError('siteFee: the amount is negative');
  return (x * SITE_SWAP_FEE_BPS) / BPS_DENOMINATOR;
}

export type SiteFeeAgreement = { ok: true } | { ok: false; why: 'no-fee-account' | 'other-fee-account' | 'other-rate' };

/**
 * Does this build's fee env say what the committed fee says?
 *   - no account configured                      -> no-fee-account (Jupiter charges no fee at all);
 *   - anything but the team vault, key or not    -> other-fee-account;
 *   - any rate but exactly 50                    -> other-rate (a missing or malformed
 *     VITE_SOLANA_PLATFORM_FEE_BPS falls back to 100 in lib/solana.ts, so it lands here).
 * The account is compared as the exact base58 string of the committed vault key.
 */
export function siteFeeAgrees(
  env: { account: string; bps: number } = { account: SOLANA_FEE_ACCOUNT, bps: SOLANA_PLATFORM_FEE_BPS },
): SiteFeeAgreement {
  if (typeof env.account !== 'string' || env.account === '') return { ok: false, why: 'no-fee-account' };
  if (env.account !== PLATFORM_TREASURY_VAULT.toBase58()) return { ok: false, why: 'other-fee-account' };
  if (env.bps !== Number(SITE_SWAP_FEE_BPS)) return { ok: false, why: 'other-rate' };
  return { ok: true };
}

/**
 * Our pools can be COMPARED with Jupiter on this build: there is a pool program id, LP
 * is fully on (not 'withdraw-only', the emergency state), and the fee env agrees. This
 * is all the route line needs while the switch is off (shadow mode).
 */
export function ownPoolRouteComparable(env?: Record<string, unknown>): boolean {
  return hasProgramId() && lpWriteMode(env) === 'on' && siteFeeAgrees().ok;
}

/**
 * ...and a trade may EXECUTE through them: comparable, and the route's own switch is on
 * (lpWriteFlag.ts OWN_POOL_ROUTE). Every sentence that says trades go through our pools
 * is keyed on this.
 */
export function ownPoolRouteOffered(env?: Record<string, unknown>): boolean {
  return ownPoolRouteComparable(env) && ownPoolRouteMode(env) === 'on';
}
