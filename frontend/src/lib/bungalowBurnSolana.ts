// The Solana half of the burn read: one getTokenSupply through the same-origin proxy.
// Built on the scanner's transport so "the node did not answer" can never become a zero.
import {
  expectBaseUnits,
  expectRpcObject,
  expectRpcValue,
  solrpcBatch,
  takeResult,
  unreadable,
} from './scanner/solanaAdapter';

const METHOD = 'getTokenSupply';

/** A mint's supply in base units and its decimals. Throws on anything short of a full answer. */
export async function readSolanaSupply(
  mint: string,
  signal?: AbortSignal,
): Promise<{ supplyRaw: bigint; decimals: number }> {
  const batch = await solrpcBatch([{ jsonrpc: '2.0', id: 1, method: METHOD, params: [mint] }], signal);
  const value = expectRpcObject(METHOD, expectRpcValue(METHOD, takeResult(batch, 1, METHOD)));
  if (typeof value.amount !== 'string') throw unreadable(METHOD, 'the supply carried no `amount`');
  const { decimals } = value;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw unreadable(METHOD, 'the supply carried no usable `decimals`');
  }
  return { supplyRaw: expectBaseUnits(METHOD, value.amount), decimals };
}
