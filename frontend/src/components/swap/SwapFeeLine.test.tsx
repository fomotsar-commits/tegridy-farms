// The Swap tab's money line on every chain (owner ruling 2026-11-15): the venue fee lands in that
// chain's treasury Safe, after the referral share where the chain has a ReferralSplitter.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SwapFeeLine } from './EvmSwapPanel';
import { getChainConfig } from '../../lib/chains/registry';
import { universalRouterOn } from '../../lib/evm/universalRouter';

afterEach(cleanup);

/** The line as the panel mounts it for a chain: every input comes from the chain's own records. */
const lineOn = (chainId: number) => {
  const config = getChainConfig(chainId)!;
  const { container } = render(
    <SwapFeeLine
      name={config.name}
      islandV3={universalRouterOn(chainId) !== null}
      referral={config.contracts.referralSplitter != null}
    />,
  );
  return container.querySelector('[data-testid="swap-fee-line"]')?.textContent ?? '';
};

describe('SwapFeeLine', () => {
  it('Ethereum: after the referral share, the fee goes to the treasury', () => {
    expect(lineOn(1)).toBe(
      "Where the fee goes on Ethereum. A swap through our pools pays the venue its fee. After a referral share, it goes to the venue's treasury on Ethereum. A swap routed to Uniswap pays the venue nothing.",
    );
  });

  it('Base: our pools and an island coin’s own V3 pool pay the fee to the treasury', () => {
    expect(lineOn(8453)).toBe(
      "Where the fee goes on Base. A swap through our pools, or through an island coin's own Uniswap V3 pool, pays the venue its fee, which goes to the venue's treasury on Base. A swap routed to Uniswap V2 pays the venue nothing.",
    );
  });

  it('Robinhood Chain: the fee goes to the treasury', () => {
    expect(lineOn(4663)).toBe(
      "Where the fee goes on Robinhood Chain. A swap through our pools pays the venue its fee, which goes to the venue's treasury on Robinhood Chain. A swap routed to Uniswap pays the venue nothing.",
    );
  });

  it('never names stakers, the old fee Safe, or an em dash', () => {
    for (const id of [1, 8453, 4663]) {
      const text = lineOn(id);
      expect(text).not.toMatch(/stakers|fee Safe/i);
      expect(text).not.toContain('—');
      cleanup();
    }
  });
});
