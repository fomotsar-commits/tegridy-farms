import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT } from '../../../lib/launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../../lib/launcher/solana/write/plant';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { RangeRows } from './RangeRows';
import { TxReview } from './TxFlowView';
import { prepared } from './fakeWriteApi.fixture';
import type { RangeSummary } from './ports';
import type { RangeRewardPaid } from '../../../lib/launcher/solana/write/types';
import { reviewLines } from './reviewLines';

/** A range position's review says the fee, the venue's cut and where that cut goes, from the pool's tier. */

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const STRANGER = key(77).toBase58();

function opening(owners: { owner: string; fundOwner: string }, warnings: string[] = [], notices: string[] = [], quote = SOL_QUOTE): RangeSummary {
  return {
    kind: 'range-open',
    nftMint: key(1),
    max: { token: 5_000_000n, quote: 1_000_000n },
    quoted: { token: 5_000_000n, quote: 990_000n },
    rentLamports: 7_000_000n,
    unwrapsWsol: true,
    notices,
    warnings,
    price: { state: 'agrees', pool: 0.0003, reference: 0.0003, diff: 0 },
    poolLine: {
      feeCeiling: null,
      pool: key(2), tokenMint: key(3), tokenDecimals: 6, quote, tokenIsToken0: true,
      tradeFeeRate: 10_000, venueShareRate: 160_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, ...owners,
    },
    range: { tickLower: 0, tickUpper: 1200, minPrice: 0.0002, maxPrice: 0.0005, holds: 'both' },
  };
}

describe('the range review’s fee lines', () => {
  it('the agreed split is said plainly', () => {
    render(<RangeRows summary={opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() })} />);
    expect(screen.getByText(/it keeps 16% of each swap’s fee \(0\.16% of the swap\)/)).toBeInTheDocument();
    expect(screen.getByText(/The venue’s cut is split: 10\.4% of each fee \(0\.104% of the swap\) to the team’s shared wallet/)).toBeInTheDocument();
    expect(document.querySelector('strong')).toBeNull();
  });

  /** The review as a person meets it: heading, then whatever is said first, then the rows. */
  const review = (owners: { owner: string; fundOwner: string }) => render(<TxReview prepared={prepared(opening(owners))} decimals={6} display={(x) => x} />);
  /** True when `a` comes before `b` in the page. */
  const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('any other wallet is said in bold, with its address, at the top of the review, before every row', () => {
    review({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: STRANGER });
    const first = screen.getByTestId('tx-review-venue-elsewhere');
    expect(first.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split/);
    expect(first.textContent).toContain(STRANGER);
    expect(before(first, screen.getByText('Range pool'))).toBe(true);
    expect(before(first, screen.getByText('You put in about'))).toBe(true);
    // Said once: the rows do not repeat it.
    expect(document.querySelectorAll('strong')).toHaveLength(1);
    // A screen reader says it when the review opens.
    expect(screen.getByRole('heading').getAttribute('aria-describedby')).toContain(first.id);
  });

  it('the vault collecting the island’s part is said in bold too, first, with what each wallet gets', () => {
    review({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: PLATFORM_TREASURY_VAULT.toBase58() });
    const first = screen.getByTestId('tx-review-venue-elsewhere');
    expect(first.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split .* 16% of each fee \(0\.16% of the swap\) to the team’s shared wallet, 0% of each fee \(0% of the swap\) to the island’s Workshop\./);
    expect(before(first, screen.getByText('Range pool'))).toBe(true);
  });

  it('an opening’s own notices (its price check) are said first, above every row, once; the review says “this pool’s price”', () => {
    const off = 'This pool’s price is 9.1% below the outside price (Jupiter’s). Anyone can open a range pool at any price.';
    render(<TxReview prepared={prepared(opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }, [off]))} decimals={6} display={(x) => x} />);
    const box = screen.getByTestId('tx-review-warnings');
    expect(box).toHaveTextContent(off);
    expect(before(box, screen.getByText('Range pool'))).toBe(true);
    expect(screen.getAllByText(off)).toHaveLength(1);
    expect(screen.getByRole('heading').getAttribute('aria-describedby')).toContain(box.id);
  });

  it('a range off the price says it is off THIS POOL’s price, not the market’s', () => {
    const o = opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }) as Extract<RangeSummary, { kind: 'range-open' }>;
    render(<RangeRows summary={{ ...o, range: { ...o.range, holds: 'token-only' } }} />);
    expect(document.body.textContent).toContain('Above this pool’s price now, holding the token only');
  });

  it('an opening’s account notices are its own lines, among its rows, not in the warnings box', () => {
    const delegated = 'Your token account has a delegate who can move 5 of its tokens.';
    render(<TxReview prepared={prepared(opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }, [], [delegated]))} decimals={6} display={(x) => x} />);
    expect(screen.queryByTestId('tx-review-warnings')).toBeNull();
    const line = screen.getByText(delegated);
    expect(line.closest('[data-review-line]')).toBeNull();
  });

  it('a USDC range opening says Circle can freeze the pool’s USDC, first, once', () => {
    render(<TxReview prepared={prepared(opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }, [], [], USDC_QUOTE))} decimals={6} display={(x) => x} />);
    const box = screen.getByTestId('tx-review-warnings');
    expect(box).toHaveTextContent(USDC_QUOTE.risk!);
    expect(screen.getAllByText(USDC_QUOTE.risk!)).toHaveLength(1);
    expect(before(box, screen.getByText('Range pool'))).toBe(true);
  });

  it('a removal’s notices stay among its rows: nothing on a removal gives a reason to wait', () => {
    const removal: RangeSummary = {
      ...(opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }) as Extract<RangeSummary, { kind: 'range-open' }>),
      kind: 'range-remove', position: key(9), percent: 50, liquidity: 1n, min: { token: 1n, quote: 1n }, quoted: { token: 1n, quote: 1n }, fees: null, rewards: [], notices: ['A notice about your account.'],
    } as unknown as RangeSummary;
    render(<TxReview prepared={prepared(removal)} decimals={6} display={(x) => x} />);
    expect(screen.queryByTestId('tx-review-warnings')).toBeNull();
    expect(screen.getByText('A notice about your account.')).toBeInTheDocument();
  });

  it('a tier where nobody collects anything ends its bold line cleanly, with no stray period', () => {
    const none = opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }) as Extract<RangeSummary, { kind: 'range-open' }>;
    render(<TxReview prepared={prepared({ ...none, poolLine: { ...none.poolLine, protocolFeeRate: 0, fundFeeRate: 0, venueShareRate: 0 } })} decimals={6} display={(x) => x} />);
    const first = screen.getByTestId('tx-review-venue-elsewhere');
    expect(first.textContent).not.toMatch(/\s\.$/);
    expect(first.textContent?.trim().endsWith('to the island’s Workshop.')).toBe(true);
  });

  it('a pool with a dynamic fee: the review says the fee as a range and the venue’s cut as a floor', () => {
    const o = opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }) as Extract<RangeSummary, { kind: 'range-open' }>;
    render(<RangeRows summary={{ ...o, poolLine: { ...o.poolLine, feeCeiling: 40_000 } }} />);
    expect(screen.getByText(/^1% to 4% of each swap through your range\. .* it keeps 16% of each swap’s fee \(at least 0\.16% of the swap\)/)).toBeInTheDocument();
  });

  it('the agreed split puts nothing above the rows', () => {
    review({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() });
    expect(screen.queryByTestId('tx-review-venue-elsewhere')).toBeNull();
    expect(screen.getByText(/The venue’s cut is split: 10\.4% of each fee/)).toBeInTheDocument();
  });
});

describe('a collect’s review', () => {
  const BAYLA = new PublicKey('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
  const paid = (o: Partial<RangeRewardPaid> = {}): RangeRewardPaid => ({ mint: BAYLA, owed: 48_200_000n, amount: 48_200_000n, decimals: 6, feeOnTransfer: false, ...o });
  const collect = (rewards: Extract<RangeSummary, { kind: 'range-remove' | 'range-close' }>['rewards']): RangeSummary => ({
    ...(opening({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }) as Extract<RangeSummary, { kind: 'range-open' }>),
    kind: 'range-remove', position: key(9), percent: 0, liquidity: 0n, min: { token: 0n, quote: 0n }, quoted: { token: 0n, quote: 0n },
    fees: { token: 0n, quote: 0n }, rewards, unwrapsWsol: true, notices: [],
  }) as unknown as RangeSummary;

  it('says each reward it pays, in its coin, and that it takes out the fees and rewards only', () => {
    render(<RangeRows summary={collect([paid()])} />);
    expect(screen.getByText('Rewards it pays').parentElement).toHaveTextContent('48.2 BAYLA');
    expect(screen.getByText('no liquidity: the fees and rewards only')).toBeInTheDocument();
  });

  it('a running reward’s row is a line the chain’s clock moves; nothing else on a collect is', () => {
    const got = reviewLines(<RangeRows summary={collect([paid()])} />);
    expect(got.clock).toEqual(['Rewards it pays: 48.2 BAYLA']);
    expect(got.lines.some((l) => l.startsWith('Rewards it pays'))).toBe(false);
  });

  it('a reward’s vault holding less than is owed: what it pays, by the coin’s ticker, and the rest stays owed', () => {
    render(<RangeRows summary={collect([paid({ owed: 999_999n, amount: 400_000n })])} />);
    expect(screen.getByText('This reward’s vault holds less than the position is owed, so it pays 0.4 BAYLA now and the rest stays owed to it.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(BAYLA.toBase58());
  });

  it('a reward coin that takes a fee out of each transfer says less arrives; one whose mint did not read says that is not known', () => {
    const { unmount } = render(<RangeRows summary={collect([paid({ feeOnTransfer: true })])} />);
    expect(screen.getByText('BAYLA takes its own fee out of each transfer, so less BAYLA than this arrives in your wallet.')).toBeInTheDocument();
    unmount();
    render(<RangeRows summary={collect([paid({ decimals: null, feeOnTransfer: null })])} />);
    expect(screen.getByText('BAYLA’s mint could not be read just now, so whether it takes a fee out of each transfer is not known.')).toBeInTheDocument();
  });

  it('a reward that could not be worked out is said, never 0; a pool with none says fees only', () => {
    const { unmount } = render(<RangeRows summary={collect(null)} />);
    expect(screen.getByText('Rewards it pays').parentElement).toHaveTextContent('could not be worked out just now; what it is owed is paid out all the same');
    unmount();
    render(<RangeRows summary={collect([])} />);
    expect(screen.queryByText('Rewards it pays')).toBeNull();
    expect(screen.getByText('no liquidity: the fees only')).toBeInTheDocument();
  });
});
