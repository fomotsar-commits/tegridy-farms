// TreasuryPage — the POL Holdings tile must not state that the protocol owns no
// liquidity on the strength of numbers it never read.
//
// THE BUG THIS PINS. The tile's share was
//
//     if (!polLpBal || !pool.lpSupply || pool.lpSupply === 0n) return 0;
//     const polUsd = polLpBal !== undefined ? polShare * pool.tvl : undefined;
//
// which turns three different unknowns into "$0.00" and "0.00% of LP supply":
//   - an unread LP totalSupply (usePoolTVL collapses it to 0n; its no-TVL path
//     also used to hardcode 0n, so a stale PRICE feed alone did it);
//   - an unloaded TVL (0 until the reserves and a display price land), via × tvl;
//   - an unread POL balance, which zeroed the share line even while the value
//     line correctly said "–".
// A transparency page asserting "no protocol-owned liquidity" during an outage is
// the repo's most repeated bug class. Both directions are pinned: a READ zero
// balance is a real zero holding and must still say so.
//
// Harness copied from TreasuryPage.split.test.tsx; usePoolTVL is driven directly
// so each unknown can be set on its own (its own flags are pinned in usePoolTVL.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TREASURY_ADDRESS, REFERRAL_SPLITTER_ADDRESS } from '../lib/constants';

const reads = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const balances = vi.hoisted(() => ({ current: {} as Record<string, bigint> }));
const pool = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

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
vi.mock('../hooks/usePoolTVL', () => ({ usePoolTVL: () => pool.current }));
vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ ethUsd: 3000, oracleStale: false }),
}));
vi.mock('../lib/txHistory', () => ({ fetchAddressTxList: () => Promise.resolve([]) }));

import TreasuryPage from './TreasuryPage';

/** The POL accumulator's LP balance — the page reads it with `balanceOf`. */
function polLp(balance: bigint | undefined) {
  reads.current = { ...reads.current, balanceOf: balance };
}
/** A loaded TOWELI/WETH pool: $14,000 TVL over 1,000 LP. Overrides layer on top. */
function lpPool(overrides: Record<string, unknown> = {}) {
  pool.current = { tvl: 14_000, tvlFormatted: '$14.0K', lpSupply: 1_000n, lpSupplyReadOk: true, isLoaded: true, ...overrides };
}
function polTile(): string {
  const tile = screen.getByText('POL Holdings').closest('.rounded-xl');
  if (!tile) throw new Error('POL Holdings tile is not rendered');
  return tile.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  // The rest of the page's reads, as TreasuryPage.split.test.tsx sets them.
  reads.current = {
    stakerShareBps: 10_000n, polShareBps: 0n, totalETHFees: 0n, accumulatedETHFees: 0n,
    paused: false, treasury: TREASURY_ADDRESS, referralFeeBps: 2_000n, callerCredit: 0n,
    accumulatedTreasuryETH: 0n, totalPendingETH: 0n, totalDistributed: 0n,
  };
  balances.current = {
    [TREASURY_ADDRESS.toLowerCase()]: 0n,
    [REFERRAL_SPLITTER_ADDRESS.toLowerCase()]: 0n,
  };
  lpPool();
  polLp(100n);
});

describe('TreasuryPage — POL Holdings: inputs UNREAD', () => {
  it('an unread LP supply is not a zero share', () => {
    // OLD: lpSupply 0n → share 0 → "$0.00" and "0.00% of LP supply".
    lpPool({ lpSupply: 0n, lpSupplyReadOk: false });
    render(<TreasuryPage />);

    expect(polTile()).not.toContain('0.00%');
    expect(polTile()).not.toContain('$0.00');
    expect(polTile()).toContain('– of LP supply');
  });

  it('an unloaded TVL is not a $0 holding — the share, which WAS read, still shows', () => {
    // OLD: share 0.1 × tvl 0 → "$0.00".
    lpPool({ tvl: 0, tvlFormatted: '–', isLoaded: false });
    render(<TreasuryPage />);

    expect(polTile()).not.toContain('$0.00');
    expect(polTile()).toContain('10.00% of LP supply');
  });

  it('an unread POL balance is not a zero share', () => {
    // OLD: the value line said "–" but the share line still said "0.00%".
    polLp(undefined);
    render(<TreasuryPage />);

    expect(polTile()).not.toContain('0.00%');
    expect(polTile()).toContain('– of LP supply');
  });
});

describe('TreasuryPage — POL Holdings: GENUINE', () => {
  // NOT DISCRIMINATING against the old code — identical before and after. They
  // fail if the fix is ever widened into treating a READ zero as unknown.
  it('a POL balance READ as 0 is a real zero holding, and says so', () => {
    polLp(0n);
    render(<TreasuryPage />);

    expect(polTile()).toContain('$0.00');
    expect(polTile()).toContain('0.00% of LP supply');
  });

  it('a read balance and a read supply price the holding', () => {
    render(<TreasuryPage />);

    expect(polTile()).toContain('$1.4K');
    expect(polTile()).toContain('10.00% of LP supply');
  });
});
