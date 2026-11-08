/**
 * Opening a pool costs 0.006 ETH (owner ruling 2026-10-25). Once the fee factory is deployed,
 * the liquidity tab says so before any amount is typed, counts the fee in "enough ETH?", and
 * names the cost on its button. With no fee factory (today), none of it shows.
 *
 * Driven through the REAL hook; the wagmi mock answers each read by function and address.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
import { TOWELI_ADDRESS } from '../../lib/constants';

type Answer = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

const OPENING_FACTORY = '0x0fac000000000000000000000000000000000001';
const OPENING_ROUTER = '0x0be0000000000000000000000000000000000002';
const ZERO = '0x0000000000000000000000000000000000000000';

const h = vi.hoisted(() => ({
  reads: new Map<string, Answer>(),
  single: new Map<string, unknown>(),
  native: { value: 0n },
  opening: false,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xdddddddddddddddddddddddddddddddddddddddd', isConnected: true }),
  useChainId: () => 1,
  useWalletClient: () => ({ data: undefined }),
  useBalance: (opts: { query?: { enabled?: boolean } }) =>
    opts?.query?.enabled ? { data: { value: h.native.value, decimals: 18 }, isError: false } : { data: undefined, isError: false },
  useReadContract: (opts: { address?: string; functionName?: string; query?: { enabled?: boolean } }) => {
    if (opts?.query?.enabled === false) return { data: undefined, isError: false, refetch: vi.fn() };
    const key = `${opts.functionName}:${(opts.address ?? '').toLowerCase()}`;
    return { data: h.single.get(key), isError: false, refetch: vi.fn() };
  },
  useReadContracts: ({ contracts }: { contracts: Array<{ functionName: string; address: string }> }) => ({
    data: contracts.map(
      (c) => h.reads.get(`${c.functionName}:${c.address.toLowerCase()}`)
        ?? ({ status: 'failure', error: new Error('no stub') } as Answer),
    ),
    refetch: vi.fn(),
    isLoading: false,
  }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn(), error: null }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button type="button">Connect</button> }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('./TokenSelectModal', () => ({ TokenSelectModal: () => null }));
vi.mock('../../hooks/useUniswapV2MarketPrice', () => ({
  useUniswapV2MarketPrice: () => ({ price: { kind: 'none' } }),
  matchAtMarket: () => null,
  gapFromMarketBps: () => null,
  formatMarketPrice: () => '',
}));
vi.mock('../../lib/chains/liquidityVenue', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/chains/liquidityVenue')>();
  return {
    ...real,
    openingVenueOn: (chainId: number) => {
      const base = real.liquidityVenueOn(chainId);
      return h.opening && base ? { ...base, factory: OPENING_FACTORY, router: OPENING_ROUTER } : null;
    },
  };
});

import { LiquidityTab } from './LiquidityTab';
import { TEGRIDY_FACTORY_ADDRESS } from '../../lib/constants';

const TOWELI = TOWELI_ADDRESS.toLowerCase();

function renderAndType(amountEth: string, amountToweli: string) {
  render(<LiquidityTab />);
  const [a, b] = screen.getAllByRole('spinbutton');
  fireEvent.change(a!, { target: { value: amountEth } });
  fireEvent.change(b!, { target: { value: amountToweli } });
}
const cta = () => screen.getByTestId('liquidity-submit');
const feeNotice = () => screen.queryByTestId('liquidity-opening-fee');

beforeEach(() => {
  h.reads.clear();
  h.single.clear();
  h.opening = false;
  h.native.value = parseEther('1');
  // Default pair: native ETH (A) + TOWELI (B), on neither factory yet.
  h.single.set(`getPair:${TEGRIDY_FACTORY_ADDRESS.toLowerCase()}`, ZERO);
  h.single.set(`getPair:${OPENING_FACTORY}`, ZERO);
  h.single.set(`POOL_OPENING_FEE:${OPENING_FACTORY}`, parseEther('0.006'));
  h.reads.set(`allowance:${TOWELI}`, { status: 'success', result: 2n ** 255n });
  h.reads.set(`balanceOf:${TOWELI}`, { status: 'success', result: parseEther('1000') });
});

describe('LiquidityTab: the pool-opening fee', () => {
  it('with no fee factory deployed, nothing about a fee shows', () => {
    renderAndType('0.5', '100');
    expect(feeNotice()).toBeNull();
    expect(cta()).toHaveTextContent('Add liquidity');
  });

  it('says what opening costs, and names it on the button', () => {
    h.opening = true;
    renderAndType('0.5', '100');
    expect(feeNotice()).toHaveTextContent(
      'Opening this pool costs 0.006 ETH, paid to the Tegridy treasury on top of your deposit.',
    );
    expect(cta()).toHaveTextContent('Open pool (+0.006 ETH)');
    expect(cta()).toBeEnabled();
  });

  it('counts the fee in "enough ETH?"', () => {
    h.opening = true;
    h.native.value = parseEther('0.5'); // enough for 0.5 ETH of liquidity, not for the fee on top
    renderAndType('0.5', '100');
    expect(cta()).toHaveTextContent('Not enough ETH (incl. 0.006 ETH to open)');
    expect(cta()).toBeDisabled();
  });

  it('a pool already on the old factory shows no fee', () => {
    h.opening = true;
    h.single.set(`getPair:${TEGRIDY_FACTORY_ADDRESS.toLowerCase()}`, '0x9a19000000000000000000000000000000000003');
    renderAndType('0.5', '100');
    expect(feeNotice()).toBeNull();
  });
});
