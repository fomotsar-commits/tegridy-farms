// The honesty guard for per-source availability.
//
// THE BUG THIS PINS. The dashboard this replaces computed one sum in which
// `price.oracleStale ? 0 : ethBal * price.ethUsd` was a live branch: when the Chainlink
// ETH/USD feed missed its heartbeat, the user's ETH, their LP's WETH half, and their
// claimable ETH revenue were all marked at ZERO and folded into the headline figure. The
// portfolio dropped by the whole ETH side and stayed a confident, animated dollar amount,
// with a chip beside it. A chip does not undo a number: the number is what gets believed,
// screenshotted, and traded against.
//
// The rule these tests enforce is that an absent MARK removes a leg from the sum and
// names it, and never re-prices that leg at nothing. The corollary — a leg whose
// QUANTITY did not read is also never zero — is enforced alongside it, because the two
// failures produce the identical wrong output from opposite causes.

import { describe, it, expect } from 'vitest';
import { buildPortfolioSources, type PortfolioSnapshot } from './sources';
import { aggregatePortfolio } from './aggregate';
import type { PortfolioSourceId, PortfolioSourceReport } from './types';

const T = 1_800_000_000;

const LIVE = { asOf: T, isLoading: false, failed: false };

/** A wallet holding something on every leg, with both marks healthy. */
function snapshot(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    connected: true,
    onExpectedChain: true,
    price: { toweliUsd: 0.002, ethUsd: 3000, toweliPriceable: true, ethPriceable: true },
    base: { ...LIVE },
    position: { ...LIVE },
    wallet: { eth: 2, toweli: 1_000_000 },
    staking: { hasPosition: true, staked: 500_000, pending: 1_000, unsettled: 0 },
    lp: { toweli: 250_000, weth: 0.5, pendingRewards: 100 },
    claimable: { revenueEth: 0.25, referralEth: 0.05 },
    nft: { jbac: 3 },
    ...over,
  };
}

function byId(reports: PortfolioSourceReport[]): Record<PortfolioSourceId, PortfolioSourceReport> {
  return Object.fromEntries(reports.map((r) => [r.id, r])) as Record<PortfolioSourceId, PortfolioSourceReport>;
}

describe('a healthy wallet on healthy marks', () => {
  const s = byId(buildPortfolioSources(snapshot()));

  it('prices ETH from the feed', () => {
    expect(s['wallet-eth'].state).toBe('ok');
    expect(s['wallet-eth'].usd).toBe(6000);
  });

  it('prices the whole staking position — staked, pending and unsettled', () => {
    expect(s.staking.state).toBe('ok');
    expect(s.staking.usd).toBeCloseTo(501_000 * 0.002, 8);
  });

  it('prices both sides of the LP position plus its pending rewards', () => {
    expect(s.lp.state).toBe('ok');
    expect(s.lp.usd).toBeCloseTo(250_000 * 0.002 + 0.5 * 3000 + 100 * 0.002, 8);
  });

  it('dates the staking leg from the batch that actually read it', () => {
    const reports = buildPortfolioSources(
      snapshot({ position: { asOf: T - 45, isLoading: false, failed: false } }),
    );
    expect(byId(reports).staking.asOf).toBe(T - 45);
    // …and the aggregate must notice the two batches disagree rather than average them.
    expect(aggregatePortfolio(reports).mixedFreshness).toBe(true);
  });
});

describe('a missing mark removes a leg from the sum — it never marks it at zero', () => {
  it('does not value ETH at nothing when the ETH/USD feed is stale', () => {
    const reports = buildPortfolioSources(
      snapshot({ price: { toweliUsd: 0.002, ethUsd: 0, toweliPriceable: true, ethPriceable: false } }),
    );
    const s = byId(reports);
    expect(s['wallet-eth'].state).toBe('unpriced');
    expect(s['wallet-eth'].usd).toBeNull();
    // The quantity is still known and still said out loud — the user learns their ETH
    // was not lost, only unpriceable.
    expect(s['wallet-eth'].detail).toContain('2 ETH held');

    const total = aggregatePortfolio(reports);
    expect(total.completeness).toBe('partial');
    expect(total.omitted.map((o) => o.id)).toContain('wallet-eth');
  });

  it('takes the ENTIRE LP leg out when only the WETH half is unpriceable', () => {
    // Pricing the TOWELI half alone would emit a number that is confidently about half
    // right, and nothing on the surface would distinguish it from a whole one.
    const s = byId(buildPortfolioSources(
      snapshot({ price: { toweliUsd: 0.002, ethUsd: 0, toweliPriceable: true, ethPriceable: false } }),
    ));
    expect(s.lp.state).toBe('unpriced');
    expect(s.lp.usd).toBeNull();
  });

  it('drops every ETH-denominated leg together, and no TOWELI-denominated one', () => {
    const s = byId(buildPortfolioSources(
      snapshot({ price: { toweliUsd: 0.002, ethUsd: 0, toweliPriceable: true, ethPriceable: false } }),
    ));
    expect([s['wallet-eth'].state, s.lp.state, s.claimable.state]).toEqual(['unpriced', 'unpriced', 'unpriced']);
    expect([s['wallet-toweli'].state, s.staking.state]).toEqual(['ok', 'ok']);
  });

  it('drops every TOWELI-denominated leg when the TOWELI price is gone', () => {
    const s = byId(buildPortfolioSources(
      snapshot({ price: { toweliUsd: 0, ethUsd: 3000, toweliPriceable: false, ethPriceable: true } }),
    ));
    expect([s['wallet-toweli'].state, s.staking.state, s.lp.state]).toEqual(['unpriced', 'unpriced', 'unpriced']);
    expect([s['wallet-eth'].state, s.claimable.state]).toEqual(['ok', 'ok']);
  });

  it('publishes no total at all when both marks are gone', () => {
    const total = aggregatePortfolio(buildPortfolioSources(
      snapshot({ price: { toweliUsd: 0, ethUsd: 0, toweliPriceable: false, ethPriceable: false } }),
    ));
    expect(total.usd).toBeNull();
    expect(total.completeness).toBe('unavailable');
  });
});

describe('a leg that did not read is unavailable, never empty', () => {
  it('reports a failed call as unavailable rather than a zero balance', () => {
    const s = byId(buildPortfolioSources(snapshot({ wallet: { eth: null, toweli: 1_000_000 } })));
    expect(s['wallet-eth'].state).toBe('unavailable');
    expect(s['wallet-eth'].usd).toBeNull();
    expect(s['wallet-toweli'].state).toBe('ok');
  });

  it('fails the whole LP leg when any input to the share math is missing', () => {
    const s = byId(buildPortfolioSources(snapshot({ lp: { toweli: null, weth: null, pendingRewards: 100 } })));
    expect(s.lp.state).toBe('unavailable');
    expect(s.lp.usd).toBeNull();
  });

  it('marks every leg on a failed batch unavailable, with the cause', () => {
    const reports = buildPortfolioSources(snapshot({ base: { asOf: T, isLoading: false, failed: true } }));
    const onBase = reports.filter((r) => r.id !== 'launched-tokens');
    expect(onBase.every((r) => r.state === 'unavailable')).toBe(true);
    expect(onBase.every((r) => (r.detail ?? '').includes('network read failed'))).toBe(true);
    expect(aggregatePortfolio(reports).usd).toBeNull();
  });

  it('says "loading", not "zero", before the first read lands', () => {
    const reports = buildPortfolioSources(snapshot({ base: { asOf: null, isLoading: true, failed: false } }));
    expect(reports.filter((r) => r.id !== 'launched-tokens').every((r) => r.state === 'loading')).toBe(true);
    expect(aggregatePortfolio(reports).usd).toBeNull();
  });

  it('refuses to report anything for a disconnected wallet', () => {
    const total = aggregatePortfolio(buildPortfolioSources(snapshot({ connected: false })));
    expect(total.usd).toBeNull();
    expect(total.completeness).toBe('unavailable');
  });

  it('refuses to price another network’s balances as if they were this one’s', () => {
    const reports = buildPortfolioSources(snapshot({ onExpectedChain: false }));
    const total = aggregatePortfolio(reports);
    expect(total.usd).toBeNull();
    expect(reports[0]?.detail).toContain('different network');
  });
});

describe('the staking leg tracks which batch it depends on', () => {
  it('settles on the base batch when the wallet owns no staking NFT', () => {
    // No token id means there is no dependent read to wait for. Left waiting on a batch
    // that will never run, this leg would hold the whole total at PARTIAL forever.
    const s = byId(buildPortfolioSources(snapshot({
      staking: { hasPosition: false, staked: null, pending: null, unsettled: 0 },
      position: { asOf: null, isLoading: true, failed: false },
    })));
    expect(s.staking.state).toBe('ok');
    expect(s.staking.usd).toBe(0);
    expect(s.staking.asOf).toBe(T);
  });

  it('still surfaces unsettled rewards for a wallet with no position NFT', () => {
    const s = byId(buildPortfolioSources(snapshot({
      staking: { hasPosition: false, staked: null, pending: null, unsettled: 750 },
      position: { asOf: null, isLoading: true, failed: false },
    })));
    expect(s.staking.usd).toBeCloseTo(750 * 0.002, 8);
  });

  it('goes unavailable when the dependent batch fails, without dragging the base legs down', () => {
    const s = byId(buildPortfolioSources(snapshot({ position: { asOf: T, isLoading: false, failed: true } })));
    expect(s.staking.state).toBe('unavailable');
    expect(s['wallet-eth'].state).toBe('ok');
  });
});

describe('NFTs are counted and never marked', () => {
  it('counts held NFTs as unpriced, and says why the venue will not value them', () => {
    const s = byId(buildPortfolioSources(snapshot()));
    expect(s.nft.state).toBe('unpriced');
    expect(s.nft.usd).toBeNull();
    expect(s.nft.detail).toMatch(/floor is not a price/i);
  });

  it('treats a confirmed count of zero as a genuine zero contribution', () => {
    const s = byId(buildPortfolioSources(snapshot({ nft: { jbac: 0 } })));
    expect(s.nft.state).toBe('ok');
    expect(s.nft.usd).toBe(0);
  });

  it('never invents a floor price, however healthy the marks are', () => {
    const held = buildPortfolioSources(snapshot({ nft: { jbac: 12 } }));
    expect(byId(held).nft.usd).toBeNull();
    // …and the presence of an NFT therefore always downgrades the total.
    expect(aggregatePortfolio(held).completeness).toBe('partial');
  });
});

describe('what this build cannot see is declared, not inferred from silence', () => {
  const launched = byId(buildPortfolioSources(snapshot()))['launched-tokens'];

  it('names launched tokens and other wallet assets as outside the total', () => {
    expect(launched.state).toBe('out-of-scope');
    expect(launched.usd).toBeNull();
    expect(launched.detail).toMatch(/no per-wallet token index/i);
  });

  it('stays out of scope even on a fully healthy read — it is a gap, not an outage', () => {
    const total = aggregatePortfolio(buildPortfolioSources(snapshot({ nft: { jbac: 0 } })));
    expect(total.completeness).toBe('complete');
    expect(total.outOfScope.map((o) => o.id)).toEqual(['launched-tokens']);
  });
});
