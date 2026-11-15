// NFT lending, four things a pre-merge read found on 2026-11-14, each checked against Gondi's v3.2
// loan contract (contracts/vendor/gondi-v3.2):
//   - The takeover window ("15% to 85%" of the term) is MultiSourceLoan.getMinLockPeriod, which the
//     venue's Safe can change at once for open loans too. The tab prints what the chain says now.
//   - _baseLoanChecks refuses a repayment AT the deadline second (end <= now), so nothing may say a
//     loan is repayable "by" that moment or only "after" it.
//   - "About signed offers" sat bare on the page's art; it is a card like its neighbours.
//   - A loan taken over carries the interest so far (Tranche.accruedInterest), and the venue's cut of
//     it was taken at the takeover (_processOldTranche). "Where it goes" said the venue keeps 5% of
//     the interest and showed less: it now says the cut is of the interest since the loan moved.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../../test-utils/wagmi-mocks';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../../lib/gondi/loanOffer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/gondi/loanOffer.js')>()),
  GONDI_LOAN_ADDRESS: '0x5555555555555555555555555555555555555555',
}));
// The calendar file is built for real; only the download is caught, so its words can be read.
vi.mock('../../lib/gondi/calendar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/gondi/calendar')>();
  return { ...actual, loanDueIcs: vi.fn(actual.loanDueIcs), downloadIcs: vi.fn(() => true) };
});

import { NFTLendingSection } from './NFTLendingSection';
import { CARD_BG } from './nftLendingShared';
import { loanDueIcs } from '../../lib/gondi/calendar';
import { WETH_ADDRESS, ZERO_ADDRESS, wholeCollectionValidators, type LoanOfferJson } from '../../lib/gondi/loanOffer.js';
import { loanHash, loanFromJson, type LoanJson } from '../../lib/gondi/loanMath';

const LOAN = '0x5555555555555555555555555555555555555555';
const WALLET = '0x1111111111111111111111111111111111111111';
const LENDER = '0x4444444444444444444444444444444444444444';
const NAKA = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';
const NOW = Math.floor(Date.now() / 1000);

const offer: LoanOfferJson = {
  offerId: '99', lender: LENDER, fee: '0', capacity: '0', nftCollateralAddress: NAKA, nftCollateralTokenId: '0',
  principalAddress: WETH_ADDRESS, principalAmount: parseEther('1').toString(), aprBps: '1000', expirationTime: String(NOW + 86400),
  duration: String(30 * 86400), maxSeniorRepayment: '0', validators: wholeCollectionValidators(), lenderRefinanceDisabled: false, borrower: ZERO_ADDRESS,
};
let loans: unknown[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, loans: [] }), { status: 201 });
    if (url.includes('action=loans')) return new Response(JSON.stringify({ loans, live: true }));
    return new Response(JSON.stringify({ offers: [{ offer, signature: `0x${'ab'.repeat(65)}`, createdAt: '' }], count: 1, live: true }));
  }),
);

/** The loan contract's takeover window, in basis points of the term at each end, or a failed read. */
function lockPeriod(v: bigint | 'failure') {
  if (v === 'failure') wagmiMock.setReadResult({ functionName: 'getMinLockPeriod', address: LOAN, result: undefined, status: 'failure' });
  else wagmiMock.setReadResult({ functionName: 'getMinLockPeriod', address: LOAN, result: v });
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setReadResult({ functionName: 'getProtocolFee', address: LOAN, result: { recipient: LOAN, fraction: 500n } });
  wagmiMock.setReadResult({ functionName: 'isOfferCancelled', address: LOAN, result: false });
  wagmiMock.setReadResult({ functionName: 'getUsedCapacity', address: LOAN, result: 0n });
  wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: parseEther('5') });
  wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: parseEther('5') });
  loans = [];
  vi.mocked(loanDueIcs).mockClear();
});

const aboutOffers = () => screen.getByText('About signed offers').closest('details')!;

describe('the takeover window is the loan contract\'s, read now', () => {
  it('the lender reads the window the chain holds: 15% to 85% today, 20% to 80% after a change', () => {
    lockPeriod(1500n);
    const view = renderWithProviders(<NFTLendingSection />);
    expect(aboutOffers().textContent).toContain("From 15% to 85% of a loan's term, another lender can take the loan over at a lower rate without asking you or the borrower.");
    expect(aboutOffers().textContent).toContain("That window is the loan contract's setting, read just now. The venue's Safe can change it at once, for open loans too.");
    view.unmount();
    lockPeriod(2000n);
    renderWithProviders(<NFTLendingSection />);
    expect(aboutOffers().textContent).toContain("From 20% to 80% of a loan's term");
    expect(aboutOffers().textContent).not.toContain('15%');
  });

  it('no read, no number: the takeover is still said, and that the window could not be read', () => {
    lockPeriod('failure');
    renderWithProviders(<NFTLendingSection />);
    const text = aboutOffers().textContent ?? '';
    expect(text).not.toMatch(/\d+% to \d+%/);
    expect(text).toContain("For part of a loan's term, another lender can take the loan over at a lower rate without asking you or the borrower.");
    expect(text).toContain('it could not be read just now, so no number is shown');
  });

  it('the borrower reads the same window before taking a loan, and that it can change', async () => {
    lockPeriod(2500n);
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    fireEvent.click(await screen.findByText('NAKA · any NFT'));
    const text = screen.getAllByText('Details').map((s) => s.closest('details')!.textContent).join(' ');
    expect(text).toContain('From 25% to 75% of the term, another lender can take this loan over at a lower rate without asking you.');
    expect(text).toContain("The venue's Safe can change it at once, for open loans too.");
    expect(text).not.toMatch(/15% to 85%/);
    // Gondi refuses a repayment at the deadline second: "by then" took that second in.
    expect(text).toContain('If it is not repaid before then, the lender can take it, permanently.');
  });
});

describe('"About signed offers" is a card over the art', () => {
  it('sits on the cards\' own dark backing, with the card art layer the neighbouring cards carry', () => {
    lockPeriod(1500n);
    renderWithProviders(<NFTLendingSection />);
    const card = screen.getByTestId('lend-about-offers');
    expect(card).toContainElement(aboutOffers());
    // CARD_BG, rgba(6, 12, 26, 0.80), as the browser reads the style back.
    expect(CARD_BG).toBe('rgba(6, 12, 26, 0.80)');
    expect(card.style.background).toMatch(/^rgba\(6, 12, 26, 0\.80?\)$/);
    expect(card.className).toMatch(/\brelative\b/);
    expect(card.className).toMatch(/\bisolate\b/);
    expect(card.firstElementChild).toHaveAttribute('data-card-art');
  });
});

describe('my loans: the deadline second, and where the money goes', () => {
  const base: LoanJson = {
    borrower: WALLET,
    nftCollateralTokenId: '77',
    nftCollateralAddress: NAKA,
    principalAddress: WETH_ADDRESS,
    principalAmount: parseEther('1').toString(),
    startTime: String(NOW - 86400),
    duration: String(30 * 86400),
    tranche: [{ loanId: '3', floor: '0', principalAmount: parseEther('1').toString(), lender: LENDER, accruedInterest: '0', startTime: String(NOW - 86400), aprBps: '1000' }],
    protocolFee: '500',
    lenderRefinanceDisabled: false,
  };

  async function card(loan: LoanJson) {
    loans = [{ loanId: '3', loan, status: 'open', emitTx: `0x${'1'.repeat(64)}`, closeTx: null }];
    wagmiMock.setReadResult({ functionName: 'getLoanHash', address: LOAN, result: loanHash(loanFromJson(loan)) });
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'My Loans' }));
    return (await screen.findByText('Loan #3')).closest('div.relative') as HTMLElement;
  }
  const whereItGoes = (c: HTMLElement) => within(c).getByText('Where it goes').closest('details')!.textContent ?? '';
  const weth = (text: string, re: RegExp) => Number(re.exec(text)?.[1]);

  it('the calendar file says to repay before the deadline moment, which is when the lender can take the NFT', async () => {
    const c = await card(base);
    fireEvent.click(within(c).getByRole('button', { name: 'Add due date to calendar' }));
    await waitFor(() => expect(loanDueIcs).toHaveBeenCalledTimes(1));
    const { description, dueSeconds } = vi.mocked(loanDueIcs).mock.calls[0]![0];
    expect(dueSeconds).toBe(NOW - 86400 + 30 * 86400);
    expect(description).toMatch(/^Loan #3: repay about \d+\.\d{6} WETH before this event ends\. From then, the loan cannot be repaid and the lender can take NAKA #77\.$/);
    expect(description).not.toMatch(/due by this moment|After it/);
    // And the reminders' small print says the same second.
    const reminders = within(c).getByText('About reminders').closest('details')!.textContent ?? '';
    expect(reminders).toContain('From the deadline on, the loan can no longer be repaid.');
    expect(reminders).not.toMatch(/Past the deadline/);
  });

  it('a loan with no carried interest: the venue keeps its share of all the interest shown', async () => {
    const text = whereItGoes(await card(base));
    expect(text).toMatch(/plus \d+\.\d{6} WETH interest so far\. The venue keeps 5\.00% of the interest \(\d+\.\d{6} WETH\); the lender gets the rest\./);
    const interest = weth(text, /plus (\d+\.\d{6}) WETH interest so far/);
    const venue = weth(text, /of the interest \((\d+\.\d{6}) WETH\)/);
    expect(Math.abs(venue - interest * 0.05)).toBeLessThanOrEqual(0.000002);
  });

  it('a loan taken over: says what was carried over, and the share is of the interest since then, so the figure agrees', async () => {
    const carried = parseEther('0.01');
    const moved: LoanJson = { ...base, tranche: [{ ...base.tranche[0]!, accruedInterest: carried.toString() }] };
    const text = whereItGoes(await card(moved));
    expect(text).toContain('WETH interest so far, 0.010000 WETH of it carried over when the loan moved.');
    expect(text).toMatch(/The venue keeps 5\.00% of the interest since then \(\d+\.\d{6} WETH\), and took its share of the carried part at the move; the lender gets the rest\./);
    const interest = weth(text, /plus (\d+\.\d{6}) WETH interest so far/);
    const venue = weth(text, /since then \((\d+\.\d{6}) WETH\)/);
    // 5% of the interest since the move, not of all the interest shown.
    expect(Math.abs(venue - (interest - 0.01) * 0.05)).toBeLessThanOrEqual(0.000002);
    expect(venue).toBeLessThan(interest * 0.05);
  });
});
