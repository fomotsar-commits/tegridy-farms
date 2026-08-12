// TreasuryPage — "Public Transparency" must not omit the contract holding the money.
//
// THE BUG THIS PINS. The revenue-distribution card rendered ONE split:
// stakers / POL / treasury, read from SwapFeeRouter. Read live from mainnet on
// 2026-08-12, that card said "100% Stakers" while:
//
//   SwapFeeRouter.totalETHFees()        = 3_000_000_000_000 wei   (fees were collected)
//   SwapFeeRouter.accumulatedETHFees()  = 0                       (none reached the split)
//   ReferralSplitter balance            = 3_000_000_000_000 wei   (all of it, still there)
//     callerCredit[SwapFeeRouter]       = 2_400_000_000_000 wei   (80%, owed back, never pulled)
//     accumulatedTreasuryETH            =   600_000_000_000 wei   (20% referral slice)
//   RevenueDistributor.totalDistributed = 0                       (stakers got nothing, ever)
//
// ReferralSplitter appeared nowhere on the page — not in the bar, not in the
// legend, not in the address list. A transparency page that omits where the
// money is, while showing a 100%-to-stakers bar that has never paid out, is
// worse than showing nothing.
//
// WHAT IS PINNED, AND WHY IT IS AN INVARIANT NOT A STRING. The amount
// assertions parse the rendered text back into wei and compare against the
// on-chain value. That survives any reformatting (ETH / gwei / wei, more or
// fewer decimals) and fails on the thing that actually matters: a real balance
// being displayed as zero, or the wrong contract's number being shown.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  TREASURY_ADDRESS,
  REFERRAL_SPLITTER_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
} from '../lib/constants';

// ── Mainnet ground truth, read 2026-08-12. The page is driven with exactly
//    these values so the assertions describe the real world, not a fixture.
const LIFETIME_FEES = 3_000_000_000_000n;
const SPLITTER_BALANCE = 3_000_000_000_000n;
const ROUTER_CREDIT = 2_400_000_000_000n; // 80%, stranded
const SPLITTER_TREASURY = 600_000_000_000n; // 20% referral slice, unattributed
const DISTRIBUTED = 0n;

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
vi.mock('../lib/txHistory', () => ({ fetchAddressTxList: () => Promise.resolve([]) }));

import TreasuryPage from './TreasuryPage';

/**
 * Parse a rendered amount ("2400 gwei", "0.00000 ETH", "17 wei", "1.234 ETH")
 * back into wei. This is what makes the assertions format-agnostic: the test
 * pins the QUANTITY the page communicates, not the words it uses.
 */
function renderedWei(text: string): bigint {
  const match = text.match(/(-?[\d,]+(?:\.\d+)?)\s*(ETH|gwei|wei)/i);
  if (!match) throw new Error(`no amount found in ${JSON.stringify(text)}`);
  const digits = match[1].replace(/,/g, '');
  const unit = match[2].toLowerCase();
  if (unit === 'wei') return BigInt(digits);
  const scale = unit === 'eth' ? 18 : 9;
  const [whole, frac = ''] = digits.split('.');
  return BigInt(whole + frac.padEnd(scale, '0').slice(0, scale));
}

/** The amount rendered in one reconciliation row, in wei. */
function ledgerWei(id: string): bigint {
  const row = document.querySelector(`[data-testid="ledger-${id}"]`);
  if (!row) throw new Error(`ledger row "${id}" is not rendered`);
  return renderedWei(row.textContent ?? '');
}

function setChainState(overrides: Record<string, unknown> = {}) {
  reads.current = {
    // SwapFeeRouter
    stakerShareBps: 10_000n,
    polShareBps: 0n,
    totalETHFees: LIFETIME_FEES,
    accumulatedETHFees: 0n,
    paused: false,
    treasury: TREASURY_ADDRESS,
    // ReferralSplitter
    referralFeeBps: 2_000n,
    callerCredit: ROUTER_CREDIT,
    accumulatedTreasuryETH: SPLITTER_TREASURY,
    totalPendingETH: 0n,
    // RevenueDistributor
    totalDistributed: DISTRIBUTED,
    // POL LP balanceOf
    balanceOf: 0n,
    ...overrides,
  };
  balances.current = {
    [TREASURY_ADDRESS.toLowerCase()]: 0n,
    [REFERRAL_SPLITTER_ADDRESS.toLowerCase()]: SPLITTER_BALANCE,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setChainState();
});

describe('TreasuryPage — the revenue split names every contract the money passes through', () => {
  it('puts ReferralSplitter in the split and in the address list', () => {
    render(<TreasuryPage />);
    // In the split itself, not merely somewhere on the page.
    expect(screen.getAllByText(/ReferralSplitter/).length).toBeGreaterThan(0);
    // And auditable: its real address is listed with the other fee contracts.
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '');
    expect(
      links.some((h) => h.toLowerCase().includes(REFERRAL_SPLITTER_ADDRESS.toLowerCase())),
      'ReferralSplitter must be linkable from the transparency page',
    ).toBe(true);
    expect(
      links.some((h) => h.toLowerCase().includes(REVENUE_DISTRIBUTOR_ADDRESS.toLowerCase())),
      'RevenueDistributor must be linkable from the transparency page',
    ).toBe(true);
  });

  it('shows the stranded 80% as a real quantity, not as zero', () => {
    render(<TreasuryPage />);
    // THE core assertion. Pre-fix this number was nowhere on the page at all;
    // a naive re-add that formatted 2.4e12 wei with 5 ETH decimals would print
    // "0.00000 ETH" and fail here, which is the point.
    expect(ledgerWei('router-credit')).toBe(ROUTER_CREDIT);
    expect(ledgerWei('router-credit')).toBeGreaterThan(0n);
  });

  it('reconciles: what was collected equals what the splitter still holds', () => {
    render(<TreasuryPage />);
    expect(ledgerWei('collected')).toBe(LIFETIME_FEES);
    expect(ledgerWei('splitter-held')).toBe(SPLITTER_BALANCE);
    // The two slices inside the splitter account for the whole balance.
    expect(ledgerWei('router-credit') + ledgerWei('splitter-treasury')).toBe(ledgerWei('splitter-held'));
    // And nothing has moved downstream.
    expect(ledgerWei('router-accrued')).toBe(0n);
    expect(ledgerWei('distributed')).toBe(0n);
  });

  it('says out loud that stakers have never been paid, while fees exist', () => {
    render(<TreasuryPage />);
    expect(screen.getByText(/stakers have not been paid/i)).toBeTruthy();
    // …and it is announced, not buried as decorative prose.
    expect(
      screen.getAllByRole('status').some((el) => /stakers have not been paid/i.test(el.textContent ?? '')),
      'the never-paid statement must be an announced status',
    ).toBe(true);
  });

  it('withdraws that accusation the moment a distribution actually happens', () => {
    // BREADTH, the other way. The warning must be driven by the chain, not
    // hardcoded — otherwise it becomes the next stale claim on this page.
    setChainState({ totalDistributed: 1_000_000_000_000n });
    render(<TreasuryPage />);
    expect(screen.queryByText(/stakers have not been paid/i)).toBeNull();
    expect(ledgerWei('distributed')).toBe(1_000_000_000_000n);
  });

  it('keeps the original stakers / POL / treasury split — it is corrected, not deleted', () => {
    // HARD RULE: additive only. The Stage 2 bar and its legend stay exactly as
    // they were; what changed is that they are now labelled as stage two and
    // sit under the stage that precedes them.
    render(<TreasuryPage />);
    expect(screen.getByText('Stakers')).toBeTruthy();
    expect(screen.getByText('Protocol-Owned Liquidity')).toBeTruthy();
    // 'Treasury' also labels a row in the address list, hence getAllByText.
    expect(screen.getAllByText('Treasury').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /revenue distribution split/i })).toBeTruthy();
    // …and the stage-one bar now precedes it.
    expect(screen.getByRole('img', { name: /stage 1 split at collection/i })).toBeTruthy();
  });

  it('does not render a real, non-zero lifetime fee take as "0"', () => {
    // The stat tile said "0.0000 ETH routed" for a genuinely non-zero balance.
    render(<TreasuryPage />);
    const tile = screen.getByText(/routed$/);
    expect(renderedWei(tile.textContent ?? '')).toBe(LIFETIME_FEES);
  });
});
