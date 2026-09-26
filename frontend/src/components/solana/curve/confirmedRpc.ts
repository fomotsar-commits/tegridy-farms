import type { SolanaRpc } from '../../../lib/launcher/solana/curve';

// A launch page must show the chain as of the transaction it just confirmed.
//
// `browserRpc` sends no commitment, so the RPC answers at its default, FINALIZED,
// roughly 13 s behind what the wallet flow calls "confirmed". Read at that level
// right after a confirmed trade and the panel quotes the old curve; right after a
// create, the page says "not found yet" for a launch that has landed (the e2e found
// both on 2026-09-26). The write layer confirms at 'confirmed', so the page reads
// there too.

/** Account reads whose second parameter is the config object. */
const ACCOUNT_READS = new Set(['getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance']);

/**
 * Wrap a transport so account reads are made at `commitment`, unless the caller
 * already chose one. Every other call passes through untouched.
 */
export function withReadCommitment(rpc: SolanaRpc, commitment: 'confirmed' | 'finalized' = 'confirmed'): SolanaRpc {
  return (method, params) => {
    if (!ACCOUNT_READS.has(method)) return rpc(method, params);
    const cfg = params[1];
    if (cfg !== undefined && (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg))) return rpc(method, params);
    const merged = { commitment, ...((cfg as Record<string, unknown> | undefined) ?? {}) };
    return rpc(method, [params[0], merged, ...params.slice(2)]);
  };
}
