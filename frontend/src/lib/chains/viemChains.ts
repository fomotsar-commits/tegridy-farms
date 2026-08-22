/**
 * The wagmi/viem side of the chain registry: one viem `Chain` object and one
 * ranked keyless-RPC transport per configured chain.
 *
 * `registry.ts` says WHAT we serve; this file says HOW the wallet layer reaches
 * it. They are keyed to each other by chain id, and `wagmi.ts` derives its
 * `chains`/`transports` from here so the served set has exactly one author.
 *
 * RPC ROSTER RULES (learned the hard way — see reference_rpc_roster):
 *   - every endpoint below was verified with a REAL read (eth_blockNumber, with
 *     an Origin header) on 2026-08-20, never the eth_chainId trap;
 *   - every endpoint answered `access-control-allow-origin: *`, so the browser
 *     can actually use it;
 *   - every non-publicnode host must ALSO be in vercel.json's CSP connect-src
 *     (`*.publicnode.com` is already wildcarded there).
 */

import { fallback, http } from 'wagmi';
import { mainnet, base } from 'wagmi/chains';
import { defineChain, type Chain } from 'viem';
import type { Transport } from 'viem';
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

const VIEM_CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [robinhoodChain.id]: robinhoodChain,
};

const TRANSPORTS: Record<number, Transport> = {
  [mainnet.id]: fallback(
    [
      // Roster re-verified live 2026-06-14 via a REAL read; see wagmi.ts history
      // for why cloudflare-eth / ankr / llamarpc are out.
      http('https://ethereum-rpc.publicnode.com'),
      http('https://eth.drpc.org'),
      http('https://eth.merkle.io'),
    ],
    { rank: true },
  ),
  [base.id]: fallback(
    [
      http('https://base-rpc.publicnode.com'),
      http('https://base.drpc.org'),
      http('https://mainnet.base.org'),
    ],
    { rank: true },
  ),
  [robinhoodChain.id]: fallback(
    [
      // The one public endpoint the chain documents. Rate-limited but real; a
      // keyed Alchemy transport can be layered in front later without touching
      // consumers. No fake second entry — a roster is only as honest as its
      // weakest member.
      http('https://rpc.mainnet.chain.robinhood.com'),
    ],
    { rank: true },
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
    acc[id] = TRANSPORTS[id]; // presence proven by the WAGMI_CHAINS IIFE above
    return acc;
  },
  {} as Record<number, Transport>,
);
