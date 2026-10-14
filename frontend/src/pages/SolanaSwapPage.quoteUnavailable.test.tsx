import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, configure } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';
import type { JupiterQuote } from '../lib/jupiter';

/**
 * A QUOTE THAT COULD NOT BE FETCHED IS NOT "NO ROUTE".
 *
 * The page used to answer every rejected quote the same way: "No route for
 * this pair / amount.", a button reading "No route" and a receive amount of 0.
 * So when our quote proxy answered 429 or 502, or the request never arrived,
 * the trader was told the token cannot be bought here, with no way to ask again
 * short of editing the form.
 *
 * The rule now (the same one lib/solana/lp/outsidePrice.ts follows): only the
 * quote service's OWN no-route answer, which lib/jupiter.ts raises as
 * NoRouteError, may be worded "No route". Anything else is a quote that could
 * not be fetched just now: it says so, offers "Try again" for the same form,
 * and shows a dash where the amount would be. No number is printed for a quote
 * that did not answer, in either case.
 *
 * Nothing here reaches the wallet: with no quote the buy button stays disabled.
 */

// The first render of this page takes seconds when the whole suite runs in
// parallel on a busy machine. The default 5 s test budget and 1 s wait budget
// are not about what is tested here.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const QUOTE: JupiterQuote = {
  inputMint: SOL_MINT, outputMint: USDC_MINT, inAmount: '100000000', outAmount: '14925000', otherAmountThreshold: '14850375',
  swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], platformFee: { amount: '75000', feeBps: 50 },
};

const h = vi.hoisted(() => ({
  getQuote: vi.fn(),
  sendTransaction: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: vi.fn() }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/ClockLine', () => ({ ClockLine: () => null }));
vi.mock('../components/swap/ChainSwitch', () => ({ ChainSwitch: () => null }));
vi.mock('../components/swap/SolanaRouteLine', () => ({ SolanaRouteLine: () => null }));
vi.mock('../components/solana/PairChart', () => ({ PairChart: () => null }));
vi.mock('../components/solana/TokenDetail', () => ({ TokenDetail: () => null }));
vi.mock('../components/solana/SolanaConnectButton', () => ({ SolanaConnectButton: () => null }));
vi.mock('../components/solana/SolanaProviders', () => ({ SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/solanaTokenList', async (orig) => ({
  ...(await orig<typeof import('../lib/solanaTokenList')>()),
  fetchTrending: vi.fn(async () => []),
}));
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: h.getQuote,
  getUsdPrices: vi.fn(async () => ({})),
  getShield: vi.fn(async () => ({})),
}));
// One stable wallet and connection: the page's effects key on their identity.
const connection = {
  getBalance: async () => 5_000_000_000,
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  getSignatureStatuses: async () => ({ value: [null] }),
};
const wallet = { publicKey: USER, sendTransaction: h.sendTransaction };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';
// The real class: the mock above spreads the real module and replaces only the calls.
import { NoRouteError } from '../lib/jupiter';

/** The buy button, found by what it is, not by what it says. */
const cta = () => document.querySelector<HTMLButtonElement>('button.btn-primary')!;
/** The "You Receive" figure. */
const receive = () => document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? null;
const amountInput = () => screen.getByLabelText('Amount of SOL to pay');
const tryAgain = () => screen.queryByRole('button', { name: 'Try again' });

/** Type 0.1 SOL and wait until the quote the page asked for has ended, either way. */
async function typeAndLetTheQuoteEnd(calls = 1) {
  fireEvent.change(amountInput(), { target: { value: '0.1' } });
  await waitFor(() => expect(h.getQuote).toHaveBeenCalledTimes(calls));
  await waitFor(() => expect(cta()).not.toHaveTextContent('Fetching quote…'));
}

beforeEach(() => {
  // The page opens SOL to $BAYLA; these tests are about a SOL to USDC swap, so the link names it.
  window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
  localStorage.clear();
  h.getQuote.mockReset();
  h.sendTransaction.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SolanaSwapPage: a quote that could not be FETCHED is never worded as "no route"', () => {
  it.each([
    ['the proxy answered 502', new Error('Quote unavailable (502)')],
    ['the rate limit answered 429', new Error('Quote unavailable (429)')],
    ['a 404 that is not the proxy’s NO_ROUTE answer', new Error('Quote unavailable (404)')],
    ['the request never arrived', new TypeError('Failed to fetch')],
  ])('%s: says a quote could not be fetched, offers Try again, and prints no amount', async (_name, failure) => {
    h.getQuote.mockRejectedValue(failure);
    render(<SolanaSwapPage />);
    await typeAndLetTheQuoteEnd();

    // The invariant: nothing on the page says "no route" unless the quote service said it.
    expect(document.body.textContent).not.toMatch(/no route/i);
    // Nor is a figure printed for a quote that did not answer.
    expect(receive()).not.toMatch(/\d/);
    expect(receive()).toBe('–');
    // What it does say, and the way out that does not need the form edited.
    expect(screen.getByTestId('solana-quote-unavailable')).toHaveTextContent(/could not get a quote just now/i);
    expect(tryAgain()).not.toBeNull();
    // Nothing can be bought on a quote that did not answer.
    expect(cta()).toBeDisabled();
    expect(cta()).toHaveTextContent('Quote unavailable');
  });

  it('Try again asks for the same quote again, with the amount untouched', async () => {
    h.getQuote.mockRejectedValueOnce(new Error('Quote unavailable (502)'));
    h.getQuote.mockResolvedValue(QUOTE);
    render(<SolanaSwapPage />);
    await typeAndLetTheQuoteEnd();
    expect(tryAgain()).not.toBeNull();

    fireEvent.click(tryAgain()!);
    await waitFor(() => expect(h.getQuote).toHaveBeenCalledTimes(2));

    // The same request, not a different one.
    const [first, second] = h.getQuote.mock.calls.map((c) => c[0] as { inputMint: string; outputMint: string; amount: string; slippageBps: number });
    expect(second).toMatchObject({ inputMint: first!.inputMint, outputMint: first!.outputMint, amount: first!.amount, slippageBps: first!.slippageBps });
    expect(second).toMatchObject({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: '100000000' });

    // The quote that landed is on screen, the amount was never edited, and the failure is gone.
    await waitFor(() => expect(receive()).toBe('14.925'));
    expect(amountInput()).toHaveValue('0.1');
    expect(screen.queryByTestId('solana-quote-unavailable')).toBeNull();
    expect(tryAgain()).toBeNull();
    await waitFor(() => expect(cta()).toBeEnabled());
    expect(cta()).toHaveTextContent('Buy USDC');
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('a retry that fails again says so again, still without "no route"', async () => {
    h.getQuote.mockRejectedValue(new Error('Quote unavailable (429)'));
    render(<SolanaSwapPage />);
    await typeAndLetTheQuoteEnd();

    fireEvent.click(tryAgain()!);
    await waitFor(() => expect(h.getQuote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(cta()).not.toHaveTextContent('Fetching quote…'));

    expect(document.body.textContent).not.toMatch(/no route/i);
    expect(screen.getByTestId('solana-quote-unavailable')).toBeInTheDocument();
    expect(tryAgain()).not.toBeNull();
    expect(receive()).toBe('–');
  });

  it('a re-quote that fails takes the old quote off the screen and disarms the buy', async () => {
    // The page keeps the last quote for the same pair on screen while it asks
    // for a new one. If the new one does not come back, nothing of the old one
    // may be left to press Buy on: it was priced for a different amount.
    h.getQuote.mockResolvedValueOnce(QUOTE);
    h.getQuote.mockRejectedValue(new Error('Quote unavailable (502)'));
    render(<SolanaSwapPage />);
    await typeAndLetTheQuoteEnd();
    await waitFor(() => expect(cta()).toBeEnabled());
    expect(receive()).toBe('14.925');
    expect(document.body.textContent).toContain('Minimum received');

    fireEvent.change(amountInput(), { target: { value: '0.2' } });
    // Off for the whole time the new quote is being asked for.
    expect(cta()).toBeDisabled();
    await waitFor(() => expect(h.getQuote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(cta()).not.toHaveTextContent('Fetching quote…'));

    expect(receive()).toBe('–');
    expect(document.body.textContent).not.toContain('14.925');
    expect(document.body.textContent).not.toContain('Minimum received');
    expect(cta()).toBeDisabled();
    expect(cta()).toHaveTextContent('Quote unavailable');
    expect(tryAgain()).not.toBeNull();
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('SolanaSwapPage: only the quote service’s own answer says "No route"', () => {
  it('NoRouteError: "No route" in words and on the button, no Try again, and still no amount', async () => {
    h.getQuote.mockRejectedValue(new NoRouteError());
    render(<SolanaSwapPage />);
    await typeAndLetTheQuoteEnd();

    expect(screen.getByText('No route for this pair / amount.')).toBeInTheDocument();
    expect(cta()).toHaveTextContent('No route');
    expect(cta()).toBeDisabled();
    // A different answer from the same service is the trader's to ask for by changing the form.
    expect(tryAgain()).toBeNull();
    expect(screen.queryByTestId('solana-quote-unavailable')).toBeNull();
    // Not a figure either: no quote answered with one.
    expect(receive()).not.toMatch(/\d/);
  });

  it('two of the same token: no quote is asked for, so nothing may say "No route"', async () => {
    window.history.replaceState(null, '', `/solana?in=${SOL_MINT}&out=${SOL_MINT}`);
    h.getQuote.mockRejectedValue(new Error('must not be asked'));
    render(<SolanaSwapPage />);
    fireEvent.change(amountInput(), { target: { value: '0.1' } });
    // Longer than the 400 ms the page waits before it asks.
    await new Promise((r) => setTimeout(r, 700));

    expect(h.getQuote).not.toHaveBeenCalled();
    expect(screen.getByText('Pick two different tokens.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/no route/i);
    expect(cta()).toBeDisabled();
  });
});

describe('SolanaSwapPage: a quote that answered is shown as before', () => {
  // Identical before and after: fails if the fix ever hides a real quote.
  it('prints the amount and arms the buy', async () => {
    h.getQuote.mockResolvedValue(QUOTE);
    render(<SolanaSwapPage />);
    await typeAndLetTheQuoteEnd();

    expect(receive()).toBe('14.925');
    await waitFor(() => expect(cta()).toBeEnabled());
    expect(cta()).toHaveTextContent('Buy USDC');
    expect(document.body.textContent).not.toMatch(/no route/i);
    expect(tryAgain()).toBeNull();
  });

  it('before an amount is typed the receive side reads 0 and nothing is asked', () => {
    render(<SolanaSwapPage />);
    expect(receive()).toBe('0');
    expect(cta()).toHaveTextContent('Enter an amount');
    expect(h.getQuote).not.toHaveBeenCalled();
  });
});
