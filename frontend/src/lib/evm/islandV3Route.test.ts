import { describe, it, expect } from 'vitest';
import { islandV3LegFor, v3MidOut } from './islandV3Route';
import { swapTokensFor, defaultTokensFor, type TokenInfo } from '../tokenList';

const ETH: TokenInfo = { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: '', isNative: true };
const BNKR: TokenInfo = { address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', symbol: 'BNKR', name: 'BNKR', decimals: 18, logoURI: '' };
const USDC: TokenInfo = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '' };
const WETH = '0x4200000000000000000000000000000000000006';

describe('islandV3LegFor', () => {
  it('BNKR for ETH on Base is a sale in the pool the island lists for BNKR, through Uniswap', () => {
    expect(islandV3LegFor(8453, BNKR, ETH)).toEqual({
      side: 'sell', coin: '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b', pool: '0xAEC085E5A5CE8d96A7bDd3eB3A62445d4f6CE703',
      poolFee: 10000, quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', router: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    });
    expect(islandV3LegFor(8453, ETH, BNKR)?.side).toBe('buy');
  });

  it('no leg for a coin the island does not list, for two coins, or off Base', () => {
    expect(islandV3LegFor(8453, USDC, ETH)).toBeNull();
    expect(islandV3LegFor(8453, BNKR, USDC)).toBeNull();
    expect(islandV3LegFor(8453, ETH, ETH)).toBeNull();
    expect(islandV3LegFor(1, BNKR, ETH)).toBeNull();
  });
});

describe('v3MidOut', () => {
  // slot0 of the BNKR pool at Base block 53,364,275: 1.75M BNKR is ~0.2243 ETH at mid.
  const SQRT = 28_362_346_456_993_016_360_770_419n;
  it('prices token0 into token1 and back at the same mid', () => {
    const eth = v3MidOut(1_750_000n * 10n ** 18n, SQRT, BNKR.address as `0x${string}`, WETH);
    expect(eth).toBeGreaterThan(224_000_000_000_000_000n);
    expect(eth).toBeLessThan(224_500_000_000_000_000n);
    const back = v3MidOut(eth, SQRT, WETH, BNKR.address as `0x${string}`);
    expect(back / 10n ** 18n).toBe(1_749_999n);
  });
});

describe('swapTokensFor', () => {
  it('lists the island coins on the Base swap, and only there (the pool forms keep the default list)', () => {
    const swap = swapTokensFor(8453).map((t) => t.symbol);
    expect(swap).toEqual(expect.arrayContaining(['ETH', 'WETH', 'USDC', 'BNKR', 'DRB', 'QR', 'JBM', '$mfer', 'TOWELI', 'RIZZ']));
    expect(defaultTokensFor(8453).map((t) => t.symbol)).toEqual(['ETH', 'WETH', 'USDC']);
    expect(swapTokensFor(1)).toBe(defaultTokensFor(1));
  });
});
