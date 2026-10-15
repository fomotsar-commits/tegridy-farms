// Would a wallet be asked to sign the same thing? A review that outlived its blockhash
// is prepared again (useTxFlow), and the fresh transaction may skip a second read only
// when every instruction is the one reviewed, byte for byte.
//
// Web3-free (types only), like lpKinds.ts, so the flow imports it without the write layer.

import type { PreparedTx } from './types';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

/**
 * Every instruction but the compute budget pair, with its program, accounts, flags and
 * data, in order. That pair is left out: each prepare sets it from its own test run,
 * `decodeIntent` caps the fee it makes, and the fee is a line of the review.
 */
function body(p: PreparedTx): string {
  return JSON.stringify(
    p.tx.instructions
      .filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET)
      .map((ix) => [ix.programId.toBase58(), ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), Array.from(ix.data)]),
  );
}

/** Same kind, same payer, same instructions. A payer that is not set matches nothing. */
export function sameToSign(a: PreparedTx, b: PreparedTx): boolean {
  const payer = a.tx.feePayer;
  const other = b.tx.feePayer;
  if (a.kind !== b.kind || !payer || !other || !payer.equals(other)) return false;
  return body(a) === body(b);
}
