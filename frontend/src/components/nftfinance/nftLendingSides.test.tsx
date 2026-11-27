// A loan has two sides, and every WETH figure on the lending tab is written from the viewer's:
// what they pay, owe or put up is rounded up at the last digit shown, what they receive or are
// owed is cut. The public offer list speaks to borrowers, the public request list to lenders.
// Each amount here runs past the last digit shown, so its cut and its round-up read differently.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { parseEther } from 'viem';
import { toast } from 'sonner';
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
// The calendar file is read here, not downloaded.
vi.mock('../../lib/gondi/calendar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/gondi/calendar')>()),
  downloadIcs: vi.fn(() => true),
}));

import { NFTLendingSection } from './NFTLendingSection';
import { downloadIcs } from '../../lib/gondi/calendar';
import { WETH_ADDRESS, ZERO_ADDRESS, wholeCollectionValidators, type LoanOfferJson } from '../../lib/gondi/loanOffer.js';
import type { LoanRequestJson } from '../../lib/gondi/loanRequest.js';
import { loanHash, loanFromJson, type LoanJson } from '../../lib/gondi/loanMath';

const LOAN = '0x5555555555555555555555555555555555555555';
const WALLET = '0x1111111111111111111111111111111111111111';
const LENDER = '0x4444444444444444444444444444444444444444';
const ASKER = '0x7777777777777777777777777777777777777777';
const NAKA = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';
const SIG = `0x${'ab'.repeat(65)}`;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

type Row<K extends string, T> = { [k in K]: T } & { signature: string; createdAt: string };
let offers: Row<'offer', LoanOfferJson>[];
let loans: unknown[];
let requests: Row<'request', LoanRequestJson>[];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, loans: [] }), { status: 201 });
  if (url.includes('action=loan-requests')) {
    const borrower = new URL(url, 'http://x').searchParams.get('borrower');
    const hit = requests.filter((r) => !borrower || r.request.borrower.toLowerCase() === borrower.toLowerCase());
    return new Response(JSON.stringify({ requests: hit, count: hit.length, live: true, open: true }));
  }
  if (url.includes('action=loans')) return new Response(JSON.stringify({ loans, live: true }));
  return new Response(JSON.stringify({ offers, count: offers.length, live: true }));
});
vi.stubGlobal('fetch', fetchMock);

function offerRow(over: Partial<LoanOfferJson> = {}): Row<'offer', LoanOfferJson> {
  const offer: LoanOfferJson = {
    offerId: '99',
    lender: LENDER,
    fee: '0',
    capacity: '0',
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: '0',
    principalAddress: WETH_ADDRESS,
    principalAmount: parseEther('1').toString(),
    aprBps: '1000',
    expirationTime: String(NOW + DAY),
    duration: String(30 * DAY),
    maxSeniorRepayment: '0',
    validators: wholeCollectionValidators(),
    lenderRefinanceDisabled: false,
    borrower: ZERO_ADDRESS,
    ...over,
  };
  return { offer, signature: SIG, createdAt: '' };
}

function requestRow(over: Partial<LoanRequestJson> = {}): Row<'request', LoanRequestJson> {
  const request: LoanRequestJson = {
    borrower: ASKER,
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: '321',
    principalAmount: parseEther('0.5').toString(),
    maxAprBps: '4050',
    duration: String(14 * DAY),
    expirationTime: String(NOW + DAY),
    nonce: '9',
    ...over,
  };
  return { request, signature: SIG, createdAt: new Date().toISOString() };
}

function weth(balance: bigint, allowance: bigint) {
  wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: balance });
  wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: allowance });
}

function offerChecks() {
  wagmiMock.setReadResult({ functionName: 'isOfferCancelled', address: LOAN, result: false });
  wagmiMock.setReadResult({ functionName: 'getUsedCapacity', address: LOAN, result: 0n });
}

/** The innermost element whose whole text matches: a sentence split across spans reads as one. */
function sentence(re: RegExp): string {
  const els = screen.getAllByText((_, el) => !!el && re.test(el.textContent ?? '') && ![...el.children].some((c) => re.test(c.textContent ?? '')));
  return els[0]!.textContent ?? '';
}

const primary = () => screen.getAllByRole('button').find((b) => /^(Wrap|Approve|Sign Offer)/.test(b.textContent ?? '')) as HTMLButtonElement;

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setNativeBalance(parseEther('10'));
  wagmiMock.signTypedData().mockResolvedValue(SIG);
  fetchMock.mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(downloadIcs).mockClear();
  offers = [];
  loans = [];
  requests = [];
});

describe('the Lend tab: the lender puts the principal up', () => {
  function fillLend(amount: string, apr: string, count = '1') {
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Loan amount (WETH)' }), { target: { value: amount } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'APR (%)' }), { target: { value: apr } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Loans this offer can fund' }), { target: { value: count } });
  }

  it('the wrap, the shortfall toast and every line naming the principal round up', () => {
    // 0.100049 a loan, 0.300147 for three: rounded up 0.1001 and 0.3002, to the nearest 0.1000 and 0.3001.
    weth(0n, 0n);
    wagmiMock.setNativeBalance(parseEther('0.05'));
    renderWithProviders(<NFTLendingSection />);
    fillLend('0.100049', '10', '3');
    expect(primary().textContent).toBe('Wrap 0.3002 ETH to WETH');
    expect(sentence(/WETH at 10\.00% APR for 30d/)).toBe('0.1001 WETH at 10.00% APR for 30d');
    expect(screen.getByTestId('lend-default-outcome').textContent).toBe('Not repaid: you own a JBAC for 0.1001 WETH, and no interest.');
    expect(sentence(/^You offer/)).toMatch(/^You offer 0\.1001 WETH to anyone holding a JBAC, up to 3 loans \(0\.3002 WETH in all\)\./);
    fireEvent.click(primary());
    expect(toast.error).toHaveBeenCalledWith('You need 0.3002 more ETH to wrap.');
  });

  it('the approval rounds up', () => {
    weth(parseEther('5'), 0n);
    renderWithProviders(<NFTLendingSection />);
    fillLend('0.100049', '10', '3');
    expect(primary().textContent).toBe('Approve 0.3002 WETH');
  });

  it.each([
    // 1 WETH at 14% for 30 days: 0.011506849... interest, 0.010931506... after the venue's 5%.
    ['unread', null, '0.011506 WETH'],
    ['read at 5%', 500n, '0.010931 WETH'],
  ] as const)('the interest a loan earns is what the lender receives: cut (venue share %s)', (_l, fraction, shown) => {
    weth(parseEther('5'), parseEther('5'));
    if (fraction !== null) wagmiMock.setReadResult({ functionName: 'getProtocolFee', address: LOAN, result: { recipient: LOAN, fraction } });
    renderWithProviders(<NFTLendingSection />);
    fillLend('1', '14');
    expect(screen.getByText('Interest a loan earns, repaid at term').nextElementSibling!.textContent).toBe(shown);
  });
});

describe('the Borrow tab: the public offer list speaks to the borrower', () => {
  it('the loan amount and the largest loan are what a borrower would receive: cut; the cost at term rounds up', async () => {
    // 0.10697 WETH at 10% for 30 days costs 0.107849205... at term.
    offers = [offerRow({ principalAmount: parseEther('0.10697').toString() })];
    weth(parseEther('5'), parseEther('5'));
    offerChecks();
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    fireEvent.click(await screen.findByText('NAKA · any NFT'));
    expect(screen.getByText('Largest: 0.1069 WETH')).toBeTruthy();
    expect(screen.getByText('Loan amount').previousElementSibling!.textContent).toBe('0.1069 WETH');
    expect(sentence(/^You lock .* and receive/)).toMatch(/receive 0\.1069 WETH\. Repaid at the end it costs 0\.107850 WETH, due about/);
  });
});

describe('My Loans: each side reads its own rounding', () => {
  // Pinned: what is owed grows every second. 906,000 s in, every figure below separates.
  const FIXED = 1_800_000_000;
  const START = FIXED - 906_000;
  const loanJson = (principal: string, borrower: `0x${string}`, lender: `0x${string}`): LoanJson => ({
    borrower,
    nftCollateralTokenId: '77',
    nftCollateralAddress: NAKA,
    principalAddress: WETH_ADDRESS,
    principalAmount: parseEther(principal).toString(),
    startTime: String(START),
    duration: String(30 * DAY),
    tranche: [{ loanId: '3', floor: '0', principalAmount: parseEther(principal).toString(), lender, accruedInterest: '0', startTime: String(START), aprBps: '1000' }],
    protocolFee: '500',
    lenderRefinanceDisabled: false,
  });

  async function openMyLoans(loan: LoanJson) {
    loans = [{ loanId: '3', loan, status: 'open', emitTx: `0x${'1'.repeat(64)}`, closeTx: null }];
    wagmiMock.setReadResult({ functionName: 'getLoanHash', address: LOAN, result: loanHash(loanFromJson(loan)) });
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'My Loans' }));
    return (await screen.findByText('Loan #3')).closest('[data-kind="loan"]') as HTMLElement;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it('the borrower owes: the total, the loan amount, the repay figure, its parts, the wrap and the calendar round up', async () => {
    weth(0n, 0n);
    offers = [offerRow({ lender: WALLET, principalAmount: parseEther('0.100049').toString(), expirationTime: String(FIXED + DAY) })];
    const card = await openMyLoans(loanJson('0.1000490003', WALLET, LENDER));
    const totals = screen.getByTestId('loan-totals');
    expect(within(totals).getByText('You owe now').nextElementSibling!.textContent).toBe('0.1004 WETH');
    expect(within(card).getByText('Loan amount').previousElementSibling!.textContent).toBe('0.1001 WETH');
    const owed = card.querySelector('[data-dwg="owed"]') as HTMLElement;
    expect(within(owed).getByText('To repay now').nextElementSibling!.textContent).toBe('0.100337 WETH');
    expect(within(owed).getByText(/back to the lender/).textContent).toBe(
      "0.100050 WETH back to the lender, plus 0.000288 WETH interest so far. The venue keeps 5.00% of the interest (0.000015 WETH); the lender gets the rest.",
    );
    expect(within(card).getByRole('button', { name: 'Wrap 0.1004 ETH to WETH' })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Add due date to calendar' }));
    expect(vi.mocked(downloadIcs).mock.calls[0]![1]).toContain('repay about 0.100872 WETH before this event ends.');
    // The wallet's own open offer: WETH it would put up.
    await waitFor(() => expect(document.querySelector('[data-dwg="offer-row"] p')!.textContent).toBe('0.1001 WETH · 10.00% · 30d'));
  });

  it('the lender is owed: the total, the loan amount and what comes back are cut; the venue share rounds up', async () => {
    const card = await openMyLoans(loanJson('0.1000777', ASKER, WALLET));
    const totals = screen.getByTestId('loan-totals');
    expect(within(totals).getByText('Owed to you now').nextElementSibling!.textContent).toBe('0.1003 WETH');
    expect(within(card).getByText('Loan amount').previousElementSibling!.textContent).toBe('0.1000 WETH');
    const owed = card.querySelector('[data-dwg="owed"]') as HTMLElement;
    expect(within(owed).getByText('Owed to you now').nextElementSibling!.textContent).toBe('0.100350 WETH');
    expect(within(owed).getByText(/back to the lender/).textContent).toBe(
      "0.100077 WETH back to the lender, plus 0.000287 WETH interest so far. The venue keeps 5.00% of the interest (0.000015 WETH); the lender gets the rest.",
    );
  });
});

describe('requests: your own speak to you as the borrower, the public list to lenders', () => {
  it('your own request names what you would receive: cut', async () => {
    requests = [requestRow({ borrower: WALLET, nonce: '77', principalAmount: parseEther('0.50007').toString() })];
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    const mine = await screen.findByRole('list', { name: 'Your requests' });
    expect(within(mine).getByText('0.5000 WETH · up to 40.50% APR · 14d')).toBeTruthy();
  });

  it('a borrower asking names what a lender would put up: rounded up', async () => {
    requests = [requestRow({ principalAmount: parseEther('0.500049').toString() })];
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: ASKER });
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getAllByRole('button', { name: /Nakamigos/ })[0]!);
    const card = await screen.findByTestId('borrower-requests');
    expect(within(card).getByText('0.5001 WETH · up to 40.50% APR · 14d')).toBeTruthy();
  });

  it('the ask form: the most it costs rounds up, the amount borrowed is cut', async () => {
    // 1.00007 WETH at 36.5% for 30 days: 0.0300021 interest, 1.0300721 at most.
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: WALLET });
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask lenders' }));
    fireEvent.click(screen.getByRole('button', { name: 'NAKA' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Your NAKA to borrow against' }), { target: { value: '321' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Amount you want (WETH)' }), { target: { value: '1.00007' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Highest APR you will pay (%)' }), { target: { value: '36.5' } });
    expect(screen.getByTestId('ask-at-most').textContent).toMatch(/costs 1\.030073 WETH for 1\.0000 WETH borrowed/);
  });
});
