import type { CurveRpc, SolanaRpc } from '../../../lib/launcher/solana/curve';
import type { GateRpc } from './ports';

/**
 * The gate's reads over the same strict transport every other read on the page
 * uses (/api/solrpc through `browserRpc`, which throws on a non-answer rather than
 * returning a default), plus the one extra call the gate needs: which network this is.
 */
export function browserGateRpc(rpc: SolanaRpc, curveRpc: CurveRpc): GateRpc {
  return {
    getAccountInfo: (address) => curveRpc.getAccountInfo(address),
    getMinimumBalanceForRentExemption: (n) => curveRpc.getMinimumBalanceForRentExemption(n),
    getGenesisHash: async () => {
      const r = await rpc('getGenesisHash', []);
      if (typeof r !== 'string' || r === '') throw new Error('getGenesisHash: the answer was not a hash');
      return r;
    },
  };
}
