// NFT lending on Gondi's v3.2 contracts: what each button actually sends.
//
// The lend tab signs Gondi's offer shape (whole collection by default, one NFT as the
// option) and only after the WETH is held and approved; the borrow tab shows only offers
// the chain still backs and sends the borrower's own token to emitLoan; My Loans offers a
// repay only for a loan whose record matches the contract's stored hash.
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
import { WETH_ADDRESS, ZERO_ADDRESS, wholeCollectionValidators, type LoanOfferJson } from '../../lib/gondi/loanOffer.js';
import { loanHash, loanFromJson, type LoanJson } from '../../lib/gondi/loanMath';

const LOAN = '0x5555555555555555555555555555555555555555';
const WALLET = '0x1111111111111111111111111111111111111111';
const LENDER = '0x4444444444444444444444444444444444444444';
const NAKA = '0xd774557b647330C91Bf44cfEAB205095f7E6c367';
const SIG = `0x${'ab'.repeat(65)}`;
const NOW = Math.floor(Date.now() / 1000);

let book: { offers: { offer: LoanOfferJson; signature: string; createdAt: string }[]; loans: unknown[] };
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, loans: [] }), { status: 201 });
  if (url.includes('action=loans')) return new Response(JSON.stringify({ loans: book.loans, live: true }));
  return new Response(JSON.stringify({ offers: book.offers, count: book.offers.length, live: true }));
});
vi.stubGlobal('fetch', fetchMock);

function bookOffer(overrides: Partial<LoanOfferJson> = {}): LoanOfferJson {
  return {
    offerId: '99',
    lender: LENDER,
    fee: '0',
    capacity: '0',
    nftCollateralAddress: NAKA,
    nftCollateralTokenId: '0',
    principalAddress: WETH_ADDRESS,
    principalAmount: parseEther('1').toString(),
    aprBps: '1000',
    expirationTime: String(NOW + 86400),
    duration: String(30 * 86400),
    maxSeniorRepayment: '0',
    validators: wholeCollectionValidators(),
    lenderRefinanceDisabled: false,
    borrower: ZERO_ADDRESS,
    ...overrides,
  };
}

function weth(balance: bigint | 'failure', allowance: bigint) {
  if (balance === 'failure') wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: undefined, status: 'failure' });
  else wagmiMock.setReadResult({ functionName: 'balanceOf', address: WETH_ADDRESS, result: balance });
  wagmiMock.setReadResult({ functionName: 'allowance', address: WETH_ADDRESS, result: allowance });
}

function offerChecks(over: { cancelled?: boolean; used?: bigint; failure?: boolean } = {}) {
  wagmiMock.setReadResult({ functionName: 'isOfferCancelled', address: LOAN, result: over.cancelled ?? false, status: over.failure ? 'failure' : 'success' });
  wagmiMock.setReadResult({ functionName: 'getUsedCapacity', address: LOAN, result: over.used ?? 0n });
}

type EmitArg = {
  borrower: string;
  borrowerOfferSignature: string;
  executionData: {
    tokenId: bigint;
    offerExecution: { amount: bigint; lenderOfferSignature: string; offer: Record<string, unknown> }[];
  } & Record<string, unknown>;
};
type RepayArg = { data: unknown; loan: unknown };

const writes = () => wagmiMock.writeContract().mock.calls.map(([c]) => c as { functionName: string; args?: unknown[]; value?: bigint; address?: string });
const posts = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(1);
  wagmiMock.setAccount({ address: WALLET, isConnected: true });
  wagmiMock.setNativeBalance(parseEther('10'));
  wagmiMock.signTypedData().mockResolvedValue(SIG);
  fetchMock.mockClear();
  book = { offers: [], loans: [] };
});

function fillLend(amount = '1', apr = '1000') {
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Loan amount (WETH)' }), { target: { value: amount } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'APR (bps)' }), { target: { value: apr } });
}

describe('lend: signing Gondi offers', () => {
  it('opens on "Any NFT in the collection" and signs Gondi\'s whole-collection shape, then posts it', async () => {
    weth(parseEther('5'), parseEther('5'));
    renderWithProviders(<NFTLendingSection />);
    expect(screen.getByRole('button', { name: 'Any NFT in the collection' }).getAttribute('aria-pressed')).toBe('true');
    fillLend();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Offer (no gas)' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const [typed] = wagmiMock.signTypedData().mock.calls[0]! as [{ domain: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }];
    expect(typed.domain).toEqual({ name: 'GONDI_MULTI_SOURCE_LOAN', version: '3.2', chainId: 1, verifyingContract: LOAN });
    expect(typed.primaryType).toBe('LoanOffer');
    expect(typed.message).toMatchObject({
      lender: WALLET,
      nftCollateralTokenId: 0n,
      validators: [{ validator: ZERO_ADDRESS, arguments: '0x' }],
      principalAddress: WETH_ADDRESS,
      principalAmount: parseEther('1'),
      aprBps: 1000n,
      capacity: 0n,
      fee: 0n,
    });
    const body = posts()[0]!;
    expect(body.action).toBe('loan-offer-create');
    expect(body.signature).toBe(SIG);
    expect((body.offer as LoanOfferJson).nftCollateralTokenId).toBe('0');
    expect(writes()).toEqual([]); // a signature, not a transaction
  });

  it('keeps "One specific NFT" as the option: that token, no validators', async () => {
    weth(parseEther('5'), parseEther('5'));
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('button', { name: 'One specific NFT' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Token ID' }), { target: { value: '1234' } });
    fillLend();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Offer (no gas)' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [typed] = wagmiMock.signTypedData().mock.calls[0]! as [{ message: Record<string, unknown> }];
    expect(typed.message).toMatchObject({ nftCollateralTokenId: 1234n, validators: [] });
  });

  it('funds several loans with capacity = loans × amount', async () => {
    weth(parseEther('5'), parseEther('5'));
    renderWithProviders(<NFTLendingSection />);
    fillLend();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Loans this offer can fund' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign Offer (no gas)' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [typed] = wagmiMock.signTypedData().mock.calls[0]! as [{ message: Record<string, unknown> }];
    expect(typed.message.capacity).toBe(parseEther('3'));
  });

  it('wraps exactly the shortfall first, then approves exactly the amount', () => {
    weth(parseEther('0.4'), 0n);
    renderWithProviders(<NFTLendingSection />);
    fillLend();
    fireEvent.click(screen.getByRole('button', { name: 'Wrap 0.6000 ETH to WETH' }));
    expect(writes()[0]).toMatchObject({ address: WETH_ADDRESS, functionName: 'deposit', value: parseEther('0.6') });
    expect(wagmiMock.signTypedData()).not.toHaveBeenCalled();
  });

  it('asks for the WETH approval before any signature', () => {
    weth(parseEther('5'), parseEther('0.5'));
    renderWithProviders(<NFTLendingSection />);
    fillLend();
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1.0000 WETH' }));
    expect(writes()[0]).toMatchObject({ address: WETH_ADDRESS, functionName: 'approve', args: [LOAN, parseEther('1')] });
    expect(wagmiMock.signTypedData()).not.toHaveBeenCalled();
  });

  it('skips no step on an unread WETH balance', () => {
    weth('failure', parseEther('5'));
    renderWithProviders(<NFTLendingSection />);
    fillLend();
    const buttons = screen.getAllByRole('button').filter((b) => /Wrap|Approve|Sign Offer/.test(b.textContent ?? ''));
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('borrow: taking an offer', () => {
  async function openBorrow() {
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Borrow' }));
  }

  it('sends the borrower\'s own token with the lender\'s signed offer to emitLoan', async () => {
    book.offers = [{ offer: bookOffer(), signature: SIG, createdAt: '' }];
    weth(parseEther('5'), parseEther('5'));
    offerChecks();
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: WALLET });
    await openBorrow();
    fireEvent.click(await screen.findByText('NAKA · any NFT'));
    fireEvent.change(screen.getByRole('spinbutton', { name: /Your NAKA to lock/ }), { target: { value: '77' } });
    expect(screen.getByText('You own NAKA #77.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Approve NFT' }));
    expect(writes()[0]).toMatchObject({ address: NAKA, functionName: 'approve', args: [LOAN, 77n] });

    fireEvent.click(screen.getByRole('button', { name: 'Take Loan' }));
    const call = writes()[1]!;
    expect(call).toMatchObject({ address: LOAN, functionName: 'emitLoan' });
    const data = (call.args as [EmitArg])[0];
    expect(data.borrower).toBe(WALLET);
    expect(data.borrowerOfferSignature).toBe('0x');
    expect(data.executionData).toMatchObject({ tokenId: 77n, nftCollateralAddress: NAKA, principalReceiver: WALLET, loanId: 0n });
    expect(data.executionData.offerExecution[0]).toMatchObject({ amount: parseEther('1'), lenderOfferSignature: SIG });
    expect(data.executionData.offerExecution[0].offer).toMatchObject({ lender: LENDER, nftCollateralTokenId: 0n, offerId: 99n });
  });

  it('a one-NFT offer sends the lender\'s token, and refuses a borrower who does not hold it', async () => {
    book.offers = [{ offer: bookOffer({ nftCollateralTokenId: '55', validators: [] }), signature: SIG, createdAt: '' }];
    weth(parseEther('5'), parseEther('5'));
    offerChecks();
    wagmiMock.setReadResult({ functionName: 'ownerOf', address: NAKA, result: LENDER });
    await openBorrow();
    fireEvent.click(await screen.findByText('NAKA #55'));
    expect(screen.getByText('NAKA #55 is not in your wallet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Take Loan' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['cancelled or used', () => offerChecks({ cancelled: true })],
    ['no longer funded (allowance gone)', () => { offerChecks(); weth(parseEther('5'), 0n); }],
  ])('hides an offer the chain says is %s', async (_l, setup) => {
    book.offers = [{ offer: bookOffer(), signature: SIG, createdAt: '' }];
    weth(parseEther('5'), parseEther('5'));
    setup();
    await openBorrow();
    expect(await screen.findByText(/No offers yet/)).toBeTruthy();
    expect(screen.queryByText('NAKA · any NFT')).toBeNull();
  });

  it('an offer it could not check on chain is shown, but cannot be taken', async () => {
    book.offers = [{ offer: bookOffer(), signature: SIG, createdAt: '' }];
    weth(parseEther('5'), parseEther('5'));
    offerChecks({ failure: true });
    await openBorrow();
    fireEvent.click(await screen.findByText('NAKA · any NFT'));
    expect(screen.getByText(/Couldn.t check this offer on chain/)).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Your NAKA to lock/ }), { target: { value: '77' } });
    expect((screen.getByRole('button', { name: 'Take Loan' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('my loans: only a loan the chain confirms gets a button', () => {
  const loanJson: LoanJson = {
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

  async function openMyLoans(chainHash: string | 'failure') {
    book.loans = [{ loanId: '3', loan: loanJson, status: 'open', emitTx: `0x${'1'.repeat(64)}`, closeTx: null }];
    weth(parseEther('5'), parseEther('5'));
    if (chainHash === 'failure') wagmiMock.setReadResult({ functionName: 'getLoanHash', address: LOAN, result: undefined, status: 'failure' });
    else wagmiMock.setReadResult({ functionName: 'getLoanHash', address: LOAN, result: chainHash });
    renderWithProviders(<NFTLendingSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'My Loans' }));
    return screen.findByText('Loan #3');
  }

  it('a matching hash: repay sends the recorded loan back, whole', async () => {
    const card = (await openMyLoans(loanHash(loanFromJson(loanJson)))).closest('div.relative') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Repay Loan' }));
    const call = writes()[0]!;
    expect(call).toMatchObject({ address: LOAN, functionName: 'repayLoan' });
    const arg = (call.args as [RepayArg])[0];
    expect(arg.data).toEqual({ loanId: 3n, callbackData: '0x', shouldDelegate: false });
    expect(arg.loan).toEqual(loanFromJson(loanJson));
  });

  it.each([
    ['a different hash (the record is stale)', `0x${'9'.repeat(64)}`],
    ['an unread hash', 'failure' as const],
  ])('%s: no repay button', async (_l, h) => {
    const card = (await openMyLoans(h)).closest('div.relative') as HTMLElement;
    expect(within(card).queryByRole('button', { name: /Repay/ })).toBeNull();
    expect(within(card).getByText(/No action until it reads back/)).toBeTruthy();
  });
});
