import { describe, it, expect } from 'vitest';
import { selectOnChainVenue } from './venueSelect';

const FEE = 50n;    // 0.5% SwapFeeRouter fee
const SLIP = 100n;  // 1% slippage

const net = (x: bigint) => (x * (10000n - FEE)) / 10000n;
const lessSlip = (x: bigint) => x - (x * SLIP) / 10000n;

describe('selectOnChainVenue — mirrors the Swap tab route selection', () => {
  it('native wins when it beats Uniswap even AFTER its fee', () => {
    // tegridy gross 1,000,000 -> net 995,000 >= uni 990,000
    const c = selectOnChainVenue(1_000_000n, 990_000n, FEE, SLIP);
    expect(c.source).toBe('tegridy');
    expect(c.netOut).toBe(net(1_000_000n));
    expect(c.minOut).toBe(lessSlip(net(1_000_000n)));
  });

  it('Uniswap wins when the native fee drags native below it (the bug case)', () => {
    // tegridy gross 1,000,000 -> net 995,000 < uni 998,000
    const c = selectOnChainVenue(1_000_000n, 998_000n, FEE, SLIP);
    expect(c.source).toBe('uniswap');
    expect(c.netOut).toBe(998_000n);
    expect(c.minOut).toBe(lessSlip(998_000n));
  });

  it('ties go to native (treasury earns, user equal)', () => {
    // choose uni so that net(tegridy) === uni exactly
    const gross = 1_000_000n;
    const c = selectOnChainVenue(gross, net(gross), FEE, SLIP);
    expect(c.source).toBe('tegridy');
  });

  it('falls back to Uniswap when the native pool cannot price (0)', () => {
    const c = selectOnChainVenue(0n, 500_000n, FEE, SLIP);
    expect(c.source).toBe('uniswap');
    expect(c.minOut).toBe(lessSlip(500_000n));
  });

  it('falls back to native when Uniswap has no pair (0)', () => {
    const c = selectOnChainVenue(700_000n, 0n, FEE, SLIP);
    expect(c.source).toBe('tegridy');
    expect(c.minOut).toBe(lessSlip(net(700_000n)));
  });

  it('REGRESSION: native-only (old DCA) would underprice vs Uniswap here', () => {
    // The old keeper always signed the native quote. When Uniswap is better,
    // selecting native leaves value on the table — assert the helper picks uni.
    const tegridyGross = 1_000_000n;
    const uni = 999_999n; // net(tegridy)=995,000 < uni
    expect(net(tegridyGross)).toBeLessThan(uni);
    expect(selectOnChainVenue(tegridyGross, uni, FEE, SLIP).source).toBe('uniswap');
  });
});
