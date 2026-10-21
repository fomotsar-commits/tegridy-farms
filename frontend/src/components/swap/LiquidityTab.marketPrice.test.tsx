/**
 * "Match the market price" on the add form (2026-10-20, owner: "setting the liquidity pool to
 * market price isn't available on Base and Robinhood"). A NEW pool opens at the price its two
 * amounts set; the form now reads the Uniswap V2 pool for the same pair on the same chain,
 * shows that price, fills the other box from it, and says how far a typed price is from it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { matchAtMarket, gapFromMarketBps, formatMarketPrice } from '../../hooks/useUniswapV2MarketPrice';

const ZERO = '0x0000000000000000000000000000000000000000';
const UNI_FACTORY: Record<number, string> = {
  8453: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  4663: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
};
const UNI_PAIR = '0x7b7e7a86bb5c39769f8385f403e1d3fc83678225';
const OUR_PAIR = '0x1111111111111111111111111111111111111111';
const WETH = '0x4200000000000000000000000000000000000006';

// What the chain answers, per test. `ourPair: undefined` = our factory's read still out.
const chain: {
  ourPair: string | undefined;
  ourReserves: readonly [bigint, bigint, number];
  uniPair: string | undefined;
  uniReserves: readonly [bigint, bigint, number];
  uniToken0: string;
  uniPairFails: boolean;
} = {} as never;

const refetch = vi.fn();
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xdddddddddddddddddddddddddddddddddddddddd', isConnected: true }),
  useChainId: () => 8453,
  useWalletClient: () => ({ data: undefined }),
  useBalance: () => ({ data: undefined, isError: false }),
  useReadContract: ({ address, functionName, query }: { address: string; functionName: string; query?: { enabled?: boolean } }) => {
    if (query?.enabled === false || functionName !== 'getPair') return { data: undefined, isError: false, refetch };
    const isUniswap = Object.values(UNI_FACTORY).includes(address.toLowerCase());
    if (isUniswap && chain.uniPairFails) return { data: undefined, isError: true, refetch };
    return { data: isUniswap ? chain.uniPair : chain.ourPair, isError: false, refetch };
  },
  useReadContracts: ({ contracts, query }: { contracts: unknown[]; query?: { enabled?: boolean } }) => {
    if (query?.enabled === false) return { data: undefined, isError: false, isLoading: false, refetch };
    // The market read: getReserves + token0 on the Uniswap V2 pair.
    if (contracts.length === 2) {
      return { data: [{ status: 'success', result: chain.uniReserves }, { status: 'success', result: chain.uniToken0 }], isError: false, refetch };
    }
    // useAddLiquidity's nine reads on OUR pair, then balances and allowances.
    const pairKnown = !!chain.ourPair && chain.ourPair !== ZERO;
    return {
      data: contracts.map((_, i) => {
        if (i === 0) return pairKnown ? { status: 'success', result: chain.ourReserves } : { status: 'failure' };
        if (i === 1) return pairKnown ? { status: 'success', result: WETH } : { status: 'failure' };
        if (i < 5) return pairKnown ? { status: 'success', result: 0n } : { status: 'failure' };
        return { status: 'success', result: 0n };
      }),
      isLoading: false,
      refetch,
    };
  },
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn(), error: null }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button type="button">Connect</button> }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('./TokenSelectModal', () => ({ TokenSelectModal: () => null }));

import { LiquidityTab } from './LiquidityTab';

const boxes = () => screen.getAllByPlaceholderText('0.0') as HTMLInputElement[];

beforeEach(() => {
  // A brand-new pool on our venue; Uniswap V2 holds 100 WETH and 250,000 USDC: 1 ETH = 2,500 USDC.
  Object.assign(chain, {
    ourPair: ZERO,
    ourReserves: [0n, 0n, 0] as const,
    uniPair: UNI_PAIR,
    uniReserves: [100n * 10n ** 18n, 250_000n * 10n ** 6n, 0] as const,
    uniToken0: WETH,
    uniPairFails: false,
  });
});

describe('Match the market price, on a new pool', () => {
  it('on Base: shows the Uniswap V2 price and fills Token B from Token A', () => {
    render(<LiquidityTab chainId={8453} />);
    expect(screen.getByTestId('liquidity-market')).toHaveTextContent('Market price (Uniswap V2 on Base): 1 ETH = 2,500 USDC');
    const match = screen.getByTestId('liquidity-match');
    expect(match).toBeDisabled();
    fireEvent.change(boxes()[0], { target: { value: '2' } });
    fireEvent.click(match);
    expect(boxes()[1].value).toBe('5000');
    expect(screen.getByTestId('liquidity-market-gap')).toHaveTextContent('Your price matches the market.');
  });

  it('fills Token A when Token B was typed last', () => {
    render(<LiquidityTab chainId={8453} />);
    fireEvent.change(boxes()[1], { target: { value: '1250' } });
    fireEvent.click(screen.getByTestId('liquidity-match'));
    expect(boxes()[0].value).toBe('0.5');
  });

  it('reads the pair the other way round when Uniswap lists the token first', () => {
    // Same pool, token0 = USDC: the reserves arrive swapped and must be swapped back.
    chain.uniToken0 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    chain.uniReserves = [250_000n * 10n ** 6n, 100n * 10n ** 18n, 0] as const;
    render(<LiquidityTab chainId={8453} />);
    expect(screen.getByTestId('liquidity-market')).toHaveTextContent('1 ETH = 2,500 USDC');
  });

  it('says how far a typed price is from the market, and what that costs past 3%', () => {
    render(<LiquidityTab chainId={8453} />);
    fireEvent.change(boxes()[0], { target: { value: '1' } });
    fireEvent.change(boxes()[1], { target: { value: '2550' } });
    expect(screen.getByTestId('liquidity-market-gap')).toHaveTextContent('Your price is 2.0% above the market.');
    expect(screen.getByTestId('liquidity-market-gap')).not.toHaveTextContent('Traders');
    fireEvent.change(boxes()[1], { target: { value: '2000' } });
    expect(screen.getByTestId('liquidity-market-gap')).toHaveTextContent('Your price is 20.0% below the market. Traders will trade your pool back to the market price, and you lose the difference.');
  });

  it('on Robinhood Chain: reads Robinhood\'s Uniswap V2 and names the chain', () => {
    chain.uniToken0 = WETH;
    render(<LiquidityTab chainId={4663} />);
    expect(screen.getByTestId('liquidity-market')).toHaveTextContent('Market price (Uniswap V2 on Robinhood Chain): 1 ETH =');
    expect(screen.getByTestId('liquidity-match')).toBeInTheDocument();
  });

  it('with no Uniswap V2 pool: says there is no market price, and draws no Match', () => {
    chain.uniPair = ZERO;
    render(<LiquidityTab chainId={8453} />);
    expect(screen.getByTestId('liquidity-market')).toHaveTextContent('No Uniswap V2 pool for ETH/USDC on Base, so there is no market price to match.');
    expect(screen.queryByTestId('liquidity-match')).toBeNull();
  });

  it('a failed read is said as one, never as "no pool", and can be read again', () => {
    chain.uniPairFails = true;
    render(<LiquidityTab chainId={8453} />);
    expect(screen.getByTestId('liquidity-market')).toHaveTextContent('The market price could not be read from Uniswap V2 on Base.');
    expect(screen.getByTestId('liquidity-market')).not.toHaveTextContent('No Uniswap V2 pool');
    expect(screen.queryByTestId('liquidity-match')).toBeNull();
    refetch.mockClear();
    fireEvent.click(screen.getByText('Read the market price again'));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('not offered where the pool already has a price, or nothing is known yet', () => {
  it('a pool with reserves: no market block (the amounts follow the pool)', () => {
    chain.ourPair = OUR_PAIR;
    chain.ourReserves = [10n ** 18n, 2_000n * 10n ** 6n, 0] as const;
    render(<LiquidityTab chainId={8453} />);
    expect(screen.queryByTestId('liquidity-market')).toBeNull();
  });

  it('while our factory has not answered: no market block', () => {
    chain.ourPair = undefined;
    render(<LiquidityTab chainId={8453} />);
    expect(screen.queryByTestId('liquidity-market')).toBeNull();
  });
});

describe('the maths', () => {
  it('matchAtMarket is amount × to ÷ from, in whole units', () => {
    expect(matchAtMarket(2n * 10n ** 18n, 100n * 10n ** 18n, 250_000n * 10n ** 6n)).toBe(5_000n * 10n ** 6n);
    expect(matchAtMarket(5n, 0n, 7n)).toBe(0n);
  });

  it('gapFromMarketBps is signed: above the market positive, below negative, none without both amounts', () => {
    const rA = 100n, rB = 250_000n;
    expect(gapFromMarketBps(1n, 2_500n, rA, rB)).toBe(0);
    expect(gapFromMarketBps(1n, 2_750n, rA, rB)).toBe(1_000);
    expect(gapFromMarketBps(1n, 2_250n, rA, rB)).toBe(-1_000);
    expect(gapFromMarketBps(0n, 2_250n, rA, rB)).toBeNull();
  });

  it('formatMarketPrice never prints scientific notation or a rounded-away price', () => {
    expect(formatMarketPrice(0.00000001234)).toBe('0.00000001234');
    expect(formatMarketPrice(2500)).toBe('2,500');
    expect(formatMarketPrice(0)).toBe('–');
  });
});
