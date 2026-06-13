import { describe, it, expect } from 'vitest';
import { swapSpenderFor } from './swapRouting';
import { SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, TEGRIDY_ROUTER_ADDRESS } from './constants';

// The approval spender returned here MUST equal the contract useSwap.ts actually
// calls (and that pulls the user's tokens) for the same route — otherwise the
// approve targets the wrong contract and the swap reverts at gas estimation.
describe('swapSpenderFor — approval spender == useSwap executor', () => {
  it('tegridy route → SwapFeeRouter (useSwap tegridy branch executes via SFR)', () => {
    expect(swapSpenderFor('tegridy', 'tegridy')).toBe(SWAP_FEE_ROUTER_ADDRESS);
    expect(swapSpenderFor('tegridy', 'uniswap')).toBe(SWAP_FEE_ROUTER_ADDRESS);
  });

  it('uniswap route → UniswapV2Router (useSwap else branch executes via Uniswap)', () => {
    expect(swapSpenderFor('uniswap', 'uniswap')).toBe(UNISWAP_V2_ROUTER);
    expect(swapSpenderFor('uniswap', 'tegridy')).toBe(UNISWAP_V2_ROUTER);
  });

  it('aggregator route → its on-chain fallback venue', () => {
    // selectedOnChainRoute.source === 'tegridy' → SFR; === 'uniswap' → Uniswap
    expect(swapSpenderFor('aggregator', 'tegridy')).toBe(SWAP_FEE_ROUTER_ADDRESS);
    expect(swapSpenderFor('aggregator', 'uniswap')).toBe(UNISWAP_V2_ROUTER);
  });

  it('never returns the bare TegridyRouter (the F186 wrong-spender)', () => {
    const routes = ['tegridy', 'uniswap', 'aggregator'] as const;
    const sources = ['tegridy', 'uniswap'] as const;
    for (const r of routes) {
      for (const s of sources) {
        const spender = swapSpenderFor(r, s);
        expect(spender).not.toBe(TEGRIDY_ROUTER_ADDRESS);
        expect([SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER]).toContain(spender);
      }
    }
  });
});
