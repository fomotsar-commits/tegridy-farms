/**
 * How the wallet layer reaches what registry.ts serves: one viem Chain and one ranked
 * keyless-RPC transport per configured chain, keyed by id; wagmi.ts takes both from here.
 * A roster endpoint must answer a REAL read (eth_blockNumber with an Origin header, never
 * eth_chainId), send `access-control-allow-origin: *`, and sit in vercel.json's connect-src.
 */

import { fallback, http } from 'wagmi';
import { mainnet, base } from 'wagmi/chains';
import { defineChain, type Chain } from 'viem';
import type { Transport } from 'viem';
import { fetchWholeBody } from '../fetchWholeBody';
import { CONFIGURED_CHAIN_IDS } from './registry';

/**
 * Robinhood Chain (4663) — Arbitrum Orbit, ETH gas, Blockscout explorer. Not in
 * viem's registry, so defined here from facts verified against the chain itself
 * (chain id, Multicall3 code) and docs.robinhood.com/chain/connecting.
 */
export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: {
    // Canonical Multicall3 — `cast code` non-empty on 4663, verified 2026-08-20.
    // wagmi/viem batch reads route through this.
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

// wagmi's metaMask() sends a connected wallet's reads (eth_call, eth_estimateGas,
// receipts) to rpcUrls.default, never to TRANSPORTS, and viem's mainnet default is
// outside our CSP. So mainnet's default is the first host of our own roster.
const MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';

const VIEM_CHAINS: Record<number, Chain> = {
  [mainnet.id]: { ...mainnet, rpcUrls: { ...mainnet.rpcUrls, default: { http: [MAINNET_RPC] } } },
  [base.id]: base,
  [robinhoodChain.id]: robinhoodChain,
};

// viem's ranker pings net_listening every 4s at every endpoint. mainnet.base.org (403) and
// Robinhood (-32601) refuse it while serving real reads, so the default scored healthy
// hosts at zero and was 98% of all RPC traffic. The ping is therefore eth_blockNumber, every
// 60s: this picks an endpoint, the fallback still fails over on a real error. Verify a new
// endpoint under BOTH methods.
const RANK_OPTIONS = {
  interval: 60_000,
  timeout: 2_000,
  ping: ({ transport }: { transport: { request: (args: { method: string }) => Promise<unknown> } }) =>
    transport.request({ method: 'eth_blockNumber' }),
} as const;

// viem's timeout (10 s a read, 2 s a ranker ping) ends when the headers land. Every roster
// host is built here, so that clock runs until the body has been read as well.
const rpc = (url: string) => http(url, { fetchFn: fetchWholeBody });

const TRANSPORTS: Record<number, Transport> = {
  [mainnet.id]: fallback(
    [
      // Roster re-verified live 2026-06-14 via a REAL read; see wagmi.ts history
      // for why cloudflare-eth / ankr / llamarpc are out.
      rpc(MAINNET_RPC),
      rpc('https://eth.drpc.org'),
      // eth.merkle.io DROPPED 2026-08-25: 429s every request — dead third slot
      // that burned a retry per rotation. Re-verify with a real read before re-adding.
    ],
    { rank: RANK_OPTIONS },
  ),
  [base.id]: fallback(
    [
      rpc('https://base-rpc.publicnode.com'),
      rpc('https://base.drpc.org'),
      // KEPT DELIBERATELY. This host answers eth_blockNumber/eth_call with HTTP
      // 200 and `access-control-allow-origin: *`; it only rejects the ranker's
      // default net_listening probe with a 403. A console full of 403s from this
      // host is RANK_OPTIONS working, not a failed read — do not drop it on that
      // evidence. Re-verified with a browser Origin header 2026-09-03.
      rpc('https://mainnet.base.org'),
    ],
    { rank: RANK_OPTIONS },
  ),
  [robinhoodChain.id]: fallback(
    [
      // The one public endpoint the chain documents. Rate-limited but real; a
      // keyed Alchemy transport can be layered in front later without touching
      // consumers. No fake second entry — a roster is only as honest as its
      // weakest member.
      // Also -32601s net_listening (200, not 403) — same reason RANK_OPTIONS
      // overrides the ping.
      rpc('https://rpc.mainnet.chain.robinhood.com'),
    ],
    { rank: RANK_OPTIONS },
  ),
};

/**
 * The chains wagmi serves, in registry order — derived, not restated. A registry
 * entry with no viem chain (or vice versa) is a configuration bug and throws at
 * module load, where CI sees it, rather than at first wallet connect.
 */
export const WAGMI_CHAINS: readonly [Chain, ...Chain[]] = (() => {
  const chains = CONFIGURED_CHAIN_IDS.map((id) => {
    const chain = VIEM_CHAINS[id];
    if (!chain) throw new Error(`chains/viemChains.ts has no viem Chain for configured chain ${id}`);
    if (!TRANSPORTS[id]) throw new Error(`chains/viemChains.ts has no transport for configured chain ${id}`);
    return chain;
  });
  if (chains.length === 0) throw new Error('no configured chains');
  return chains as unknown as readonly [Chain, ...Chain[]];
})();

export const WAGMI_TRANSPORTS: Record<number, Transport> = CONFIGURED_CHAIN_IDS.reduce(
  (acc, id) => {
    acc[id] = TRANSPORTS[id]!; // presence proven by the WAGMI_CHAINS IIFE above
    return acc;
  },
  {} as Record<number, Transport>,
);
