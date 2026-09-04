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

/**
 * HEALTH-RANKING OPTIONS — shared by every chain, and the reason this is not
 * just `{ rank: true }`.
 *
 * viem's ranker (clients/transports/fallback.js:101) defaults to pinging
 * `net_listening` every 4s, forever, against EVERY endpoint of EVERY configured
 * chain. Two things went wrong with that here, both measured 2026-09-03 with a
 * browser Origin header:
 *
 *   mainnet.base.org                 net_listening -> HTTP 403, err -32601
 *                                    eth_blockNumber -> HTTP 200, acao: *
 *   rpc.mainnet.chain.robinhood.com  net_listening -> HTTP 200, err -32601
 *                                    eth_blockNumber -> HTTP 200, acao: *
 *
 * Both endpoints serve real reads perfectly and simply do not implement
 * `net_listening`. So the ranker scored two working endpoints at zero stability
 * permanently, and filled devtools with 403s from a host that was never failing.
 * A field review read that console and concluded "mainnet.base.org refuses
 * browser origins outright — drop it". Dropping it would have removed a healthy
 * Base RPC and left the noise running, because the noise is ours.
 *
 * The volume was the larger half. Measured on an idle homepage, same 45s window,
 * only this option object changed:
 *
 *              rank: true          RANK_OPTIONS
 *   POSTs      157                 17
 *   methods    154 net_listening   0 net_listening, 14 eth_blockNumber
 *              3 eth_call          3 eth_call
 *   failures   22x 403 from        none
 *              mainnet.base.org
 *
 * So the ranker was 98.1% of all outbound RPC traffic and 100% of the visible
 * failures. It is also what kept tripping dRPC's rate limiter.
 *
 * `ping` therefore uses a method every Ethereum JSON-RPC endpoint implements, so
 * the check finally measures node liveness instead of a proxy's method
 * allowlist. `interval` is 60s rather than 4s: this picks a healthy endpoint, it
 * is not a monitoring system, and the fallback still fails over on a real error
 * the moment a request actually fails.
 *
 * BEFORE ADDING AN ENDPOINT: verify it under BOTH methods, not just one. An
 * endpoint that answers eth_blockNumber but not the ping is exactly the trap
 * above.
 */
const RANK_OPTIONS = {
  interval: 60_000,
  timeout: 2_000,
  ping: ({ transport }: { transport: { request: (args: { method: string }) => Promise<unknown> } }) =>
    transport.request({ method: 'eth_blockNumber' }),
} as const;

const TRANSPORTS: Record<number, Transport> = {
  [mainnet.id]: fallback(
    [
      // Roster re-verified live 2026-06-14 via a REAL read; see wagmi.ts history
      // for why cloudflare-eth / ankr / llamarpc are out.
      http('https://ethereum-rpc.publicnode.com'),
      http('https://eth.drpc.org'),
      // eth.merkle.io DROPPED 2026-08-25: 429s every request — dead third slot
      // that burned a retry per rotation. Re-verify with a real read before re-adding.
    ],
    { rank: RANK_OPTIONS },
  ),
  [base.id]: fallback(
    [
      http('https://base-rpc.publicnode.com'),
      http('https://base.drpc.org'),
      // KEPT DELIBERATELY. This host answers eth_blockNumber/eth_call with HTTP
      // 200 and `access-control-allow-origin: *`; it only rejects the ranker's
      // default net_listening probe with a 403. A console full of 403s from this
      // host is RANK_OPTIONS working, not a failed read — do not drop it on that
      // evidence. Re-verified with a browser Origin header 2026-09-03.
      http('https://mainnet.base.org'),
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
      http('https://rpc.mainnet.chain.robinhood.com'),
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
