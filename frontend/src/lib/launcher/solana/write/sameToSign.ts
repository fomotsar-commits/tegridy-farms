// Would a wallet be asked to sign the same thing? A review that outlived its blockhash
// is prepared again (useTxFlow), and the fresh transaction may skip a second read only
// when every instruction is the one reviewed, byte for byte.
//
// Web3-free (types only), like lpKinds.ts, so the flow imports it without the write layer.

import type { PreparedTx } from './types';

/**
 * The instructions as prepared (`check.body`: program, accounts, flags, data, in order).
 * The budget is not in it: each prepare sets its own from its test run, `decodeIntent`
 * caps the fee it makes, and the fee is a line of the review. Two unset bodies read alike.
 */
const body = (p: PreparedTx): string => JSON.stringify(p.check?.body ?? []);

/** Same kind, same payer, same message format, same instructions. A payer that is not set matches nothing. */
export function sameToSign(a: PreparedTx, b: PreparedTx): boolean {
  if (a.kind !== b.kind || !a.payer || !b.payer || !a.payer.equals(b.payer)) return false;
  if (a.wire?.version !== b.wire?.version) return false;
  return body(a) === body(b);
}
