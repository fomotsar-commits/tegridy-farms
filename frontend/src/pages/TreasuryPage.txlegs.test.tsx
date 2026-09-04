// The treasury transaction feed reads TWO explorer legs. Half a read is not a
// fact about the chain.
//
// THE BUG THIS PINS. `RecentTreasuryTransactions` declared an error only when
// BOTH `txlist` and `txlistinternal` rejected. So the asymmetric case — the
// normal list returning an explicit empty page while the internal list errored
// — fell through to the empty branch and told the reader, in plain words, that
// the treasury has never received or sent ETH. That sentence was manufactured
// from a read that did not happen, on the page whose entire purpose is
// transparency.
//
// `fetchAddressTxList` throws on a failed read and resolves `[]` only on an
// explicit empty page (lib/txHistory.ts:463-472), so the two cases ARE
// distinguishable at the call site — the page simply was not distinguishing
// them.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TREASURY_ADDRESS, REFERRAL_SPLITTER_ADDRESS } from '../lib/constants';

const legs = vi.hoisted(() => ({
  txlist: 'empty' as 'empty' | 'reject' | 'rows',
  txlistinternal: 'empty' as 'empty' | 'reject' | 'rows',
}));

const reads = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const balances = vi.hoisted(() => ({ current: {} as Record<string, bigint> }));

vi.mock('wagmi', () => ({
  useBalance: ({ address }: { address: string }) => {
    const v = balances.current[String(address).toLowerCase()];
    return { data: v === undefined ? undefined : { value: v } };
  },
  useBlockNumber: () => ({ data: 23_400_000n }),
  useReadContract: ({ functionName }: { functionName: string }) => ({
    data: reads.current[functionName],
  }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../hooks/usePoolTVL', () => ({
  usePoolTVL: () => ({ tvl: 14, tvlFormatted: '$14.00', lpSupply: 1_000n }),
}));
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ ethUsd: 3000, oracleStale: false }),
}));

const ROW = {
  hash: '0xaa',
  from: '0x000000000000000000000000000000000000dEaD',
  to: TREASURY_ADDRESS,
  value: '1000000000000000000',
  timeStamp: '1750000000',
  isError: '0',
};

vi.mock('../lib/txHistory', () => ({
  fetchAddressTxList: (_addr: string, _signal: AbortSignal, action: 'txlist' | 'txlistinternal') => {
    const mode = legs[action];
    if (mode === 'reject') return Promise.reject(new Error('explorer 503'));
    return Promise.resolve(mode === 'rows' ? [ROW] : []);
  },
}));

import TreasuryPage from './TreasuryPage';

beforeEach(() => {
  vi.clearAllMocks();
  legs.txlist = 'empty';
  legs.txlistinternal = 'empty';
  reads.current = {
    stakerShareBps: 10_000n, polShareBps: 0n, totalETHFees: 0n, accumulatedETHFees: 0n,
    paused: false, treasury: TREASURY_ADDRESS, referralFeeBps: 2_000n, callerCredit: 0n,
    accumulatedTreasuryETH: 0n, totalPendingETH: 0n, totalDistributed: 0n, balanceOf: 0n,
  };
  balances.current = {
    [TREASURY_ADDRESS.toLowerCase()]: 0n,
    [REFERRAL_SPLITTER_ADDRESS.toLowerCase()]: 0n,
  };
});

describe('recent treasury transactions — one leg failed', () => {
  it('never says "no transfers recorded" when the internal leg failed', async () => {
    legs.txlistinternal = 'reject';
    render(<TreasuryPage />);
    await waitFor(() =>
      expect(screen.getByText(/internal transfer list could not be read/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/No ETH transfers recorded yet/i)).toBeNull();
    expect(screen.getByText(/the list below is incomplete/i)).toBeTruthy();
  });

  it('still renders the rows that DID read, with the incompleteness named', async () => {
    legs.txlist = 'rows';
    legs.txlistinternal = 'reject';
    render(<TreasuryPage />);
    await waitFor(() => expect(screen.getByText('IN')).toBeTruthy());
    // Withholding real rows would be its own dishonesty — the fix is a
    // disclosure alongside them, not a blank panel.
    expect(screen.getByText(/the list below is incomplete/i)).toBeTruthy();
  });

  it('names the normal list when THAT is the leg that failed', async () => {
    legs.txlist = 'reject';
    legs.txlistinternal = 'empty';
    render(<TreasuryPage />);
    await waitFor(() =>
      expect(screen.getByText(/normal transfer list could not be read/i)).toBeTruthy(),
    );
  });
});

describe('recent treasury transactions — the unambiguous cases survive', () => {
  it('says "no transfers recorded" only when BOTH legs returned an explicit empty', async () => {
    render(<TreasuryPage />);
    await waitFor(() => expect(screen.getByText(/No ETH transfers recorded yet/i)).toBeTruthy());
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it('declares an outage, not an empty treasury, when BOTH legs failed', async () => {
    legs.txlist = 'reject';
    legs.txlistinternal = 'reject';
    render(<TreasuryPage />);
    await waitFor(() =>
      expect(screen.getByText(/momentarily unavailable/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/No ETH transfers recorded yet/i)).toBeNull();
  });
});
