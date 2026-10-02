/**
 * THE POSITION MARKET, OFF MAINNET: one read un-gated, two kept, one left as it is.
 *
 * Every read in usePositionMarket.ts and usePositionMarketFillability.ts is
 * pinned to mainnet and was ALSO gated on `useChainId() === CHAIN_ID`. The sweep
 * that un-gated the display reads (walletChainReads.test.ts) asked of each gate
 * whether it hides a figure or disarms a write:
 *   - usePositionMarketCapacity: a public fact about the book that arms nothing.
 *     Un-gated. Off mainnet it said the size "could not be read".
 *   - usePositionMarketEscrowRewards: `owed` renders the Claim button, and
 *     claimEscrowRewards() has no chain guard of its own. KEPT.
 *   - usePositionMarketFillability: the verdict disarms Buy, and fill() sends the
 *     price as value. KEPT, and held twice (the read gate and toFillVerdict's
 *     branch), so its mutation deletes both.
 *   - usePositionMarketOrder: already says "Switch to Ethereum mainnet." Left.
 * The market is not deployed, so a stand-in address is mocked in, as the
 * restaking cases in walletChainReads.test.ts do.
 *
 * The wagmi mock is local because CapacityLine reads `isSuccess`, which the
 * shared mock does not model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, render, screen, cleanup } from '@testing-library/react';

const state = vi.hoisted(() => ({
  chainId: 1,
  address: '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}` | undefined,
  results: {} as Record<string, unknown>,
}));

vi.mock('wagmi', () => {
  // A DISABLED query never runs: no data, not loading, not an error -- as in wagmi.
  const idle = { data: undefined, isError: false, isLoading: false, isSuccess: false };
  return {
    useAccount: () => ({ address: state.address, isConnected: !!state.address }),
    useChainId: () => state.chainId,
    useReadContract: (opts: { functionName: string; query?: { enabled?: boolean } }) =>
      opts.query?.enabled === false
        ? idle
        : { data: state.results[opts.functionName], isError: false, isLoading: false, isSuccess: true },
    useReadContracts: (opts: { contracts: { functionName: string }[]; query?: { enabled?: boolean } }) =>
      opts.query?.enabled === false
        ? idle
        : {
            data: opts.contracts.map((c) => ({ status: 'success', result: state.results[c.functionName] })),
            isError: false,
            isLoading: false,
            isSuccess: true,
          },
    useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  };
});
vi.mock('../lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/constants')>()),
  POSITION_MARKET_ADDRESS: '0x3333333333333333333333333333333333333333' as const,
}));

import {
  usePositionMarketCapacity,
  usePositionMarketEscrowRewards,
  usePositionMarketOrder,
} from './usePositionMarket';
import { BLOCKER, usePositionMarketFillability } from './usePositionMarketFillability';
import { PositionMarketPanel } from '../components/positionMarket/PositionMarketPanel';
import { CHAIN_ID } from '../lib/constants';

const E18 = 10n ** 18n;
const USER = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;
const SELLER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const OFF_MAINNET = [['Base', 8453], ['Robinhood Chain', 4663]] as const;

/** A live book on mainnet: 3 of 50 slots, order 0 open at 1 ETH, 2 TOWELI owed, a clear fill. */
function stubMainnetMarket() {
  state.results = {
    escrowedCount: 3n,
    MAX_ESCROWED_POSITIONS: 50n,
    orders: [SELLER, E18, 1_800_000_000n, 0, 1, ZERO, 7n],
    escrowRewardsOwed: 2n * E18,
    fillability: [BLOCKER.None, true, 1_800_000_000n],
  };
}

/** What `useHook` reports to a wallet whose chain is `chainId`. */
function reportOn<T>(useHook: () => T, chainId: number): T {
  state.chainId = chainId;
  const { result, unmount } = renderHook(useHook);
  const report = result.current;
  unmount();
  return report;
}

beforeEach(() => {
  state.chainId = CHAIN_ID;
  state.address = USER;
  stubMainnetMarket();
});
afterEach(cleanup);

describe.each(OFF_MAINNET)('a wallet on %s', (_label, chainId) => {
  it('usePositionMarketCapacity reports the book size it reports on mainnet', () => {
    const off = reportOn(usePositionMarketCapacity, chainId);
    expect(off).toEqual({ known: true, used: 3, cap: 50, full: false });
    expect(off).toEqual(reportOn(usePositionMarketCapacity, CHAIN_ID));
  });

  it('usePositionMarketOrder asks for a switch rather than showing no listing', () => {
    const useOrder = () => usePositionMarketOrder(0n);
    expect(reportOn(useOrder, CHAIN_ID).order?.price).toBe(E18);
    expect(reportOn(useOrder, chainId)).toEqual({ order: null, unavailableReason: 'Switch to Ethereum mainnet.' });
  });

  it('usePositionMarketEscrowRewards reads no claim there, so nothing can arm Claim', () => {
    expect(reportOn(usePositionMarketEscrowRewards, CHAIN_ID)).toEqual({ owed: 2n * E18, unavailableReason: null });
    const off = reportOn(usePositionMarketEscrowRewards, chainId);
    expect(off.owed).toBeNull();
    expect(off.unavailableReason).toMatch(/Ethereum mainnet/);
  });

  it('usePositionMarketFillability gives no verdict there that could arm Buy', () => {
    const useVerdict = () => usePositionMarketFillability(0n, USER);
    expect(reportOn(useVerdict, CHAIN_ID).kind).toBe('clear');
    expect(reportOn(useVerdict, chainId)).toEqual({
      kind: 'unavailable',
      reason: 'Switch to Ethereum mainnet to check this listing.',
    });
  });

  it('the panel shows the book there but offers neither Claim nor Buy', () => {
    render(<PositionMarketPanel orderId={0n} />);
    // Mainnet first: both controls arm, so their absence below means something.
    expect(screen.getByRole('button', { name: 'Claim' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Buy for 1 ETH' }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    state.chainId = chainId;
    render(<PositionMarketPanel orderId={0n} />);
    expect(screen.getByText(/3 of 50 escrow slots in use/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Claim' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Buy for/ })).toBeNull();
  });
});
