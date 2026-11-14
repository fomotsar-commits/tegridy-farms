// Borrower requests on the NFT lending page: what each press actually signs and sends.
//
// A request must never be signable as anything a contract reads, so the ask form signs under
// the request's own domain (no verifying contract), only for an NFT the wallet holds, and sends
// no transaction. The Lend tab lists only requests whose borrower still holds the NFT, and
// "Offer this" fills the ordinary offer form for that one NFT.
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

import { NFTLendingSection } from './NFTLendingSection';
import { WETH_ADDRESS, type LoanOfferJson } from '../../lib/gondi/loanOffer.js';
import type { LoanRequestJson } from '../../lib/gondi/loanRequest.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const ASKER = '0x7777777777777777777777777777777777777777';
const NAKA = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';
const SIG = `0x${'ab'.repeat(65)}`;
const NOW = Math.floor(Date.now() / 1000);

let requests: { request: LoanRequestJson; signature: string; createdAt: string }[];
let offers: { offer: LoanOfferJson; signature: string; createdAt: string }[];
// False plays the book before its table exists (migration 032 not run yet).
let requestBookOpen: boolean;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, loans: [], status: 'closed' }), { status: 201 });
  if (url.includes('action=loan-requests')) {
    const borrower = new URL(url, 'http://x').searchParams.get('borrower');
    const hit = requestBookOpen ? requests.filter((r) => !borrower || r.request.borrower.toLowerCase() === borrower.toLowerCase()) : [];
    return new Response(JSON.stringify({ requests: hit, count: hit.length, live: true, open: requestBookOpen }));
  }
  if (url.includes('action=loans')) return new Response(JSON.stringify({ loans: [], live: true }));
  return new Response(JSON.stringify({ offers, count: offers.length, live: true }));
});
vi.stubGlobal('fetch', fetchMock);

function bookRequest(overrides: Partial<LoanRequestJson> = {}) {
  const request: LoanRequestJson = {
    borrower: ASKER,
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: '321',
    principalAmount: parseEther('0.5').toString(),
    maxAprBps: '4050',
    duration: String(14 * 86400),
    expirationTime: String(NOW + 86400),
    nonce: '9',
    ...overrides,
  };
  return { request, signature: SIG, createdAt: new Date().toISOString() };
}

/** A lender's whole-collection NAKA offer that answers bookRequest()'s terms. */
function bookOffer(overrides: Partial<LoanOfferJson> = {}) {
  const offer: LoanOfferJson = {
    offerId: '5',
    lender: '0x8888888888888888888888888888888888888888',
    fee: '0',
    capacity: '0',
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: '0',
    principalAddress: WETH_ADDRESS,
    principalAmount: parseEther('0.5').toString(),
    aprBps: '3000',
    expirationTime: String(NOW + 86400),
    duration: String(14 * 86400),
    maxSeniorRepayment: '0',
    validators: [{ validator: '0x0000000000000000000000000000000000000000', arguments: '0x' }],
    lenderRefinanceDisabled: false,
    borrower: '0x0000000000000000000000000000000000000000',
    ...overrides,
  };
  return { offer, signature: SIG, createdAt: new Date().toISOString() };
}

/** The chain's answers for one offer on the Borrow tab: unused, and backed by `weth`. */
function offerReads(weth: bigint) {
  wagmiMock.setReadResult({ functionName: 'isOfferCancelled', result: false });
  wagmiMock.setReadResult({ functionName: 'getUsedCapacity', result: 0n });
  wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: weth });
  wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: weth });
}

const writes = () => wagmiMock.writeContract().mock.calls;
const posts = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);
type Typed = { domain: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
const signed = () => wagmiMock.signTypedData().mock.calls.map(([t]) => t as Typed);

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setNativeBalance(parseEther('10'));
  wagmiMock.signTypedData().mockResolvedValue(SIG);
  fetchMock.mockClear();
  requests = [];
  offers = [];
  requestBookOpen = true;
});

async function openAskForm() {
  renderWithProviders(<NFTLendingSection />);
  fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Ask lenders' }));
  fireEvent.click(screen.getByRole('button', { name: 'NAKA' }));
}

function fillAsk(token = '321', amount = '0.5', apr = '40') {
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Your NAKA to borrow against' }), { target: { value: token } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Amount you want (WETH)' }), { target: { value: amount } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Highest APR you will pay (%)' }), { target: { value: apr } });
}

describe('borrow: asking for a loan', () => {
  it('offers no "Ask for a loan" until the request book is open, so nobody signs a request it cannot keep', async () => {
    requestBookOpen = false;
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('action=loan-requests'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('ask-for-loan')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask lenders' })).toBeNull();
  });

  it('a request says an offer matches only when that offer is live in the list above', async () => {
    requests = [bookRequest({ borrower: WALLET, nonce: '77' })];
    offers = [bookOffer()];
    // The lender holds no WETH: the chain says the offer cannot pay out, so the list hides it.
    offerReads(0n);
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    const mine = await screen.findByRole('list', { name: 'Your requests' });
    await new Promise((r) => setTimeout(r, 50));
    expect(within(mine).queryByText(/offers? match/)).toBeNull();
    expect(within(mine).getByText(/Waiting for a lender/)).toBeTruthy();
  });

  it('a live answering offer is counted, and it is the one the list above shows', async () => {
    requests = [bookRequest({ borrower: WALLET, nonce: '77' })];
    offers = [bookOffer()];
    offerReads(parseEther('5'));
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    const mine = await screen.findByRole('list', { name: 'Your requests' });
    await waitFor(() => expect(within(mine).getByText(/1 offer matches/)).toBeTruthy());
    expect(screen.getByText('NAKA · any NFT')).toBeTruthy();
  });

  it('with one collection picked, lists only the requests on that collection', async () => {
    requests = [bookRequest({ borrower: WALLET, nonce: '77' })];
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    await screen.findByRole('list', { name: 'Your requests' });
    // The JBAC filter: a NAKA request (and any offer for it) is not on screen above.
    fireEvent.click(screen.getAllByRole('button', { name: /Jungle Bay/ })[0]!);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Your requests' })).toBeNull());
  });

  it('signs the request under its own domain, for the NFT the wallet holds, and posts it with no transaction', async () => {
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: WALLET });
    await openAskForm();
    fillAsk();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Request (no gas)' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const typed = signed()[0]!;
    // Not Gondi's domain, and no verifying contract: nothing on chain reads this signature.
    expect(typed.domain).toEqual({ name: 'memetics.finance loan request', version: '1', chainId: 1 });
    expect(typed.primaryType).toBe('LoanRequest');
    expect(typed.message).toMatchObject({
      borrower: WALLET,
      nftCollateralAddress: NAKA,
      nftCollateralTokenId: 321n,
      principalAmount: parseEther('0.5'),
      maxAprBps: 4000n,
      duration: BigInt(30 * 86400),
    });
    const body = posts()[0]!;
    expect(body.action).toBe('loan-request-create');
    expect(body.signature).toBe(SIG);
    expect((body.request as LoanRequestJson).nftCollateralTokenId).toBe('321');
    expect(writes()).toEqual([]);
  });

  it('will not sign for an NFT that is in someone else\'s wallet', async () => {
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: ASKER });
    await openAskForm();
    fillAsk();
    expect(screen.getByTestId('ask-owner').textContent).toMatch(/not in your wallet/);
    const button = screen.getByRole('button', { name: 'Sign Request (no gas)' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(signed()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it('says what the loan costs at the highest rate before anything is signed', async () => {
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: WALLET });
    await openAskForm();
    fillAsk('321', '1', '36.5');
    // 1 WETH at 36.5% a year for 30 days = 0.03 WETH interest.
    expect(screen.getByTestId('ask-at-most').textContent).toMatch(/costs 1\.030000 WETH for 1\.0000 WETH borrowed/);
    // "Less" read as less WETH, which no answering offer can be: only the rate can be lower.
    expect(screen.getByTestId('ask-at-most').textContent).toMatch(/A lender may offer a lower rate\./);
  });

  it('lists the wallet\'s own open request and withdraws it with a signed cancel', async () => {
    requests = [bookRequest({ borrower: WALLET, nonce: '77' })];
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
    const mine = await screen.findByRole('list', { name: 'Your requests' });
    expect(within(mine).getByText('NAKA #321')).toBeTruthy();
    expect(within(mine).getByText(/0\.5000 WETH · up to 40\.50% APR · 14d/)).toBeTruthy();
    fireEvent.click(within(mine).getByRole('button', { name: 'Withdraw the request on NAKA #321' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const typed = signed()[0]!;
    expect(typed.primaryType).toBe('CancelLoanRequest');
    expect(typed.domain).toEqual({ name: 'memetics.finance loan request', version: '1', chainId: 1 });
    expect(typed.message).toEqual({ borrower: WALLET, nonce: 77n });
    expect(posts()[0]).toMatchObject({ action: 'loan-request-cancel', borrower: WALLET, nonce: '77', signature: SIG });
  });
});

describe('lend: borrowers asking', () => {
  const pickNaka = () => fireEvent.click(screen.getAllByRole('button', { name: /Nakamigos/ })[0]!);

  it('shows nothing while nobody has asked', async () => {
    renderWithProviders(<NFTLendingSection />);
    pickNaka();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('action=loan-requests'))).toBe(true));
    expect(screen.queryByTestId('borrower-requests')).toBeNull();
  });

  it('"Offer this" fills the offer form for that one NFT, and the offer signed is for it', async () => {
    requests = [bookRequest()];
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: ASKER });
    wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: parseEther('5') });
    wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: parseEther('5') });
    renderWithProviders(<NFTLendingSection />);
    pickNaka();
    const card = await screen.findByTestId('borrower-requests');
    expect(within(card).getByText(/0\.5000 WETH · up to 40\.50% APR · 14d/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Offer on NAKA #321' }));

    expect(screen.getByRole('button', { name: 'One specific NFT' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('spinbutton', { name: 'Token ID' }) as HTMLInputElement).value).toBe('321');
    expect((screen.getByRole('spinbutton', { name: 'Loan amount (WETH)' }) as HTMLInputElement).value).toBe('0.5');
    expect((screen.getByRole('spinbutton', { name: 'APR (%)' }) as HTMLInputElement).value).toBe('40.50');

    fireEvent.click(screen.getByRole('button', { name: 'Sign Offer (no gas)' }));
    await waitFor(() => expect(posts().some((p) => p.action === 'loan-offer-create')).toBe(true));
    const offer = posts().find((p) => p.action === 'loan-offer-create')!.offer as LoanOfferJson;
    expect(offer).toMatchObject({
      nftCollateralAddress: NAKA,
      nftCollateralTokenId: '321',
      validators: [],
      principalAmount: parseEther('0.5').toString(),
      aprBps: '4050',
      duration: String(14 * 86400),
      capacity: '0',
    });
  });

  it('hides a request whose NFT has left the borrower\'s wallet, and asks the book to close it', async () => {
    requests = [bookRequest()];
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: '0x9999999999999999999999999999999999999999' });
    renderWithProviders(<NFTLendingSection />);
    pickNaka();
    await waitFor(() => expect(posts()).toContainEqual({ action: 'loan-request-sync', collection: NAKA, tokenId: '321' }));
    expect(screen.queryByTestId('borrower-requests')).toBeNull();
  });

  it('does not list a request it could not check on chain', async () => {
    requests = [bookRequest()];
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: undefined, status: 'failure' });
    renderWithProviders(<NFTLendingSection />);
    pickNaka();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('action=loan-requests'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('borrower-requests')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('does not offer the lender their own request', async () => {
    requests = [bookRequest({ borrower: WALLET })];
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: WALLET });
    renderWithProviders(<NFTLendingSection />);
    pickNaka();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('action=loan-requests'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('borrower-requests')).toBeNull();
  });
});
