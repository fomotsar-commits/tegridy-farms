import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT } from '../../../lib/launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../../lib/launcher/solana/write/plant';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { BAYLA_MINT } from '../../../lib/solana/lp/tokenSafety';
import { RangeRows } from './RangeRows';
import { TxReview } from './TxFlowView';
import { prepared } from './fakeWriteApi.fixture';
import type { RangeCreateSummary, RangeSummary } from './ports';

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
      kind: 'range-remove', position: key(9), percent: 50, liquidity: 1n, min: { token: 1n, quote: 1n }, quoted: { token: 1n, quote: 1n }, fees: null, notices: ['A notice about your account.'],
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

describe('the review of a new range pool and its first position', () => {
  const creating = (owners: { owner: string; fundOwner: string }): RangeCreateSummary => {
    const base = opening(owners) as Extract<RangeSummary, { kind: 'range-open' }>;
    return {
      kind: 'range-create',
      nftMint: base.nftMint,
      max: { token: 2_500_000n, quote: 750_000n },
      startPrice: 0.0003,
      createFee: 500_000_000n,
      feeReceiver: PLATFORM_TREASURY_VAULT,
      neverBack: 200_000_000n,
      backOnClose: 6_000_000n,
      unwrapsWsol: true,
      notices: [],
      warnings: [],
      price: { state: 'agrees', pool: 0.0003, reference: 0.0003, diff: 0 },
      poolLine: { ...base.poolLine, tokenMint: new PublicKey(BAYLA_MINT) },
      range: base.range,
    };
  };
  const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('says the 0.5 SOL to the vault and the deposits first, then how a position earns, each coin by ticker and whole address', () => {
    render(<TxReview prepared={prepared(creating({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: WORKSHOP_WALLET.toBase58() }))} decimals={6} display={(x) => x} />);
    expect(screen.getByRole('heading').textContent).toBe('Review: open the pool and your position');
    const fee = screen.getByText(`0.5 SOL, to the venue’s vault (${PLATFORM_TREASURY_VAULT.toBase58()}). Not refunded.`);
    expect(screen.getByText('0.2 SOL: the pool, its two vaults, its price record, its far-band map and its new price bands. A pool cannot be closed.')).toBeInTheDocument();
    expect(screen.getByText('0.006 SOL: its record, its NFT and the NFT’s account.')).toBeInTheDocument();
    const earns = screen.getByText(/^Positions whose range the price is in share 84% of each 1% swap fee \(0\.84% of the swap\)/);
    expect(earns.textContent).toContain('The venue keeps 16% of each swap’s fee (0.16% of the swap).');
    expect(screen.getByText(/10\.4% of each fee \(0\.104% of the swap\) to the team’s shared wallet, .* 5\.6% of each fee \(0\.056% of the swap\) to the island’s Workshop/)).toBeInTheDocument();
    expect(before(fee, earns)).toBe(true);
    expect(before(earns, screen.getByText('You put in'))).toBe(true);
    expect(screen.getByText(`BAYLA · ${BAYLA_MINT}`)).toBeInTheDocument();
    expect(screen.getByText(`SOL · ${SOL_QUOTE.mint}`)).toBeInTheDocument();
    // The opening price, and the market's read just now.
    expect(screen.getAllByText('0.0003 SOL per BAYLA')).toHaveLength(2);
    expect(screen.getByText(/2\.5 BAYLA and 0\.00075 SOL, exactly/)).toBeInTheDocument();
    expect(screen.getByText(/the pool and your position land together, or neither does/)).toBeInTheDocument();
  });

  it('a tier off the agreed split is said in bold, first, as on every range review', () => {
    render(<TxReview prepared={prepared(creating({ owner: PLATFORM_TREASURY_VAULT.toBase58(), fundOwner: STRANGER }))} decimals={6} display={(x) => x} />);
    const first = screen.getByTestId('tx-review-venue-elsewhere');
    expect(first.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split/);
    expect(before(first, screen.getByText('Fee to open the pool'))).toBe(true);
  });
});
