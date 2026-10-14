import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import type { ReactNode } from 'react';
import type { JupiterQuote, SwapSimulation } from '../lib/jupiter';

/**
 * THE FEE RETRY, ON THE PAGE.
 *
 * lib/solana/swap/jupiterFeeRetry.test.ts pins the decision. This file pins
 * what the trader meets: when the fee-bearing build fails with Jupiter's 6014
 * and the no-fee rebuild simulates clean, the wallet is asked to sign the
 * REBUILT transaction, and by the time it is asked the page already shows the
 * re-quoted amount and says in plain words that this route carries no site fee.
 * The result says it again. Any other failure never reaches the wallet.
 *
 * Before the fix the first test fails: the 6014 was a blocked swap and the
 * wallet was never opened.
 */

const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const COPY = 'No site fee on this route: the fee cannot be taken on it yet.';

// Two real serialized v0 transactions (payer USER, one instruction into the
// Jupiter program) that differ only in the instruction's single data byte: 1 for
// the fee build, 2 for the no-fee rebuild. Serialized once in Node and pasted,
// because web3.js cannot SERIALIZE under jsdom (Buffer and Uint8Array come from
// different realms); the page only ever DESERIALIZES, which works here.
const TX_HEAD =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABAkjAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTmBHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E48AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAE';
const TX_FEE = `${TX_HEAD}BAA==`;
const TX_NO_FEE = `${TX_HEAD}CAA==`;

function quote(over: Partial<JupiterQuote>): JupiterQuote {
  return {
    inputMint: SOL_MINT, outputMint: USDC_MINT, inAmount: '100000000', outAmount: '14925000', otherAmountThreshold: '14850375',
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], platformFee: { amount: '75000', feeBps: 50 },
    ...over,
  };
}
// 14.925 with the fee priced in; 15 without it.
const FEE_QUOTE = quote({});
const NO_FEE_QUOTE = quote({ outAmount: '15000000', otherAmountThreshold: '14925000', platformFee: null });

const h = vi.hoisted(() => ({
  getQuote: vi.fn(),
  buildSwapTransaction: vi.fn(),
  simulateSwap: vi.fn(),
  sendTransaction: vi.fn(),
  getSignatureStatuses: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: h.toast }));
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
vi.mock('../lib/solana', async (orig) => ({
  ...(await orig<typeof import('../lib/solana')>()),
  isSolanaFeeConfigured: () => true,
}));
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: h.getQuote,
  buildSwapTransaction: h.buildSwapTransaction,
  simulateSwap: h.simulateSwap,
  swapCarriesPlatformFee: () => true,
  getUsdPrices: vi.fn(async () => ({})),
  getShield: vi.fn(async () => ({})),
}));
// The real wait (the one shared poller, lib/solana/confirm.ts), on a clock the
// test owns: each 2 s beat moves it and nothing really sleeps, so a wait that
// never confirms is exactly 46 reads however loaded the machine is. The page's
// own time limit is passed through untouched: that count is what pins it.
vi.mock('../lib/solana/confirm', async (orig) => {
  const real = await orig<typeof import('../lib/solana/confirm')>();
  return {
    ...real,
    pollConfirm: (conn: Parameters<typeof real.pollConfirm>[0], sig: string, timeoutMs?: number) => {
      let t = 0;
      return real.pollConfirm(conn, sig, timeoutMs, async (ms: number) => { t += ms; }, () => t);
    },
  };
});
// One stable wallet and connection: the page's effects key on their identity.
const connection = {
  getBalance: async () => 5_000_000_000,
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  getSignatureStatuses: (sigs: string[]) => h.getSignatureStatuses(sigs) as Promise<unknown>,
};
const wallet = { publicKey: USER, sendTransaction: h.sendTransaction };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';
import { getActivity } from '../lib/solanaActivity';

// The first test here pays for the page's first render: 1.6 s to 3.3 s in seven full runs.
// Its sibling file (SolanaSwapPage.confirm.test.tsx) crossed the 5 s default once under
// load, so both get the same room. Nothing asserted changes.
vi.setConfig({ testTimeout: 30_000 });

const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
const OTHER: SwapSimulation = { ok: false, reason: 'custom program error: 0x1771', jupiterIncorrectTokenProgram: false };

/** What the page showed at the moment the wallet was asked to sign. */
let atSign: { notice: string | null; receive: string | null; feeValue: string | null; footer: string | null; infoToasts: unknown[][] } | null = null;
const SIG = '5'.repeat(88);

beforeEach(() => {
  atSign = null;
  // The page opens SOL to $BAYLA; these tests are about a SOL to USDC swap, so the link names it.
  window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
  localStorage.clear();
  h.sendTransaction.mockReset();
  h.getSignatureStatuses.mockReset();
  h.getSignatureStatuses.mockImplementation(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }));
  h.getQuote.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? NO_FEE_QUOTE : FEE_QUOTE));
  h.buildSwapTransaction.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? TX_NO_FEE : TX_FEE));
  h.sendTransaction.mockImplementation(async () => {
    atSign = {
      notice: screen.queryByTestId('site-fee-waived')?.textContent ?? null,
      receive: document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? null,
      feeValue: screen.queryByTestId('site-fee-value')?.textContent ?? null,
      footer: screen.queryByTestId('swap-footer')?.textContent ?? null,
      infoToasts: h.toast.info.mock.calls.map((c) => [...c]),
    };
    return SIG;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function typeAmountAndBuy() {
  render(<SolanaSwapPage />);
  fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.1' } });
  const buy = await screen.findByRole('button', { name: 'Buy USDC' }, { timeout: 3000 });
  await waitFor(() => expect(buy).toBeEnabled());
  // The fee-bearing quote is what the trader sees before clicking.
  expect(screen.getByText(/% · in USDC$/)).toBeInTheDocument();
  expect(screen.queryByTestId('site-fee-waived')).toBeNull();
  fireEvent.click(buy);
}

function signedMarker(): number {
  const signed = h.sendTransaction.mock.calls[0]![0] as VersionedTransaction;
  return signed.message.compiledInstructions[0]!.data[0]!;
}

describe('SolanaSwapPage: Jupiter 6014 on the fee build -> one no-fee rebuild, said plainly', () => {
  it('signs the REBUILT transaction, and only after the page shows the re-quoted amount and the no-fee sentence', async () => {
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    await typeAmountAndBuy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));

    // The wallet got the no-fee rebuild, never the transaction that failed.
    expect(signedMarker()).toBe(2);
    // Both were simulated, the rebuild last.
    expect(h.simulateSwap.mock.calls.map((c) => c[0])).toEqual([TX_FEE, TX_NO_FEE]);
    // Exactly one no-fee re-quote.
    expect(h.getQuote.mock.calls.filter((c) => (c[0] as { noPlatformFee?: boolean }).noPlatformFee)).toHaveLength(1);

    // BEFORE signing: the sentence, the fee row, the toast, and the re-quoted 15 (not 14.925).
    expect(atSign).not.toBeNull();
    expect(atSign!.notice).toBe(COPY);
    expect(atSign!.feeValue).toBe('None on this route');
    expect(atSign!.receive).toBe('15');
    expect(atSign!.infoToasts).toHaveLength(1);
    expect(atSign!.infoToasts[0]![0]).toBe(COPY);
    expect(JSON.stringify(atSign!.infoToasts[0]![1])).toContain('15 USDC');

    // IN THE RESULT: the success toast says it again.
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Bought USDC', expect.objectContaining({ description: expect.stringContaining(COPY) })));
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('a fee build that simulates clean is signed as built, with no waiver said anywhere', async () => {
    h.simulateSwap.mockResolvedValue(OK);
    await typeAmountAndBuy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(signedMarker()).toBe(1);
    expect(atSign!.notice).toBeNull();
    expect(atSign!.receive).toBe('14.925');
    expect(h.toast.info).not.toHaveBeenCalled();
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Bought USDC', expect.anything()));
    const bought = h.toast.success.mock.calls.find((c) => c[0] === 'Bought USDC')!;
    expect(JSON.stringify(bought[1])).not.toMatch(/no site fee/i);
  });

  it('any other simulation failure is blocked exactly as before: no re-quote, no wallet', async () => {
    h.simulateSwap.mockResolvedValue(OTHER);
    await typeAmountAndBuy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Swap would fail — not sending', { description: 'custom program error: 0x1771' }));
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.getQuote.mock.calls.some((c) => (c[0] as { noPlatformFee?: boolean }).noPlatformFee)).toBe(false);
    expect(h.buildSwapTransaction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('site-fee-waived')).toBeNull();
  });

  it('a rebuild that fails its own simulation is blocked: the wallet is never opened', async () => {
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OTHER));
    await typeAmountAndBuy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Swap would fail — not sending', { description: 'custom program error: 0x1771' }));
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.simulateSwap).toHaveBeenCalledTimes(2);
    expect(h.toast.info).not.toHaveBeenCalled();
  });
});

describe('SolanaSwapPage: while the waiver is on screen nothing else on the card says a fee applies', () => {
  it('the footer drops its "fee applies" sentence at sign time', async () => {
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    await typeAmountAndBuy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(atSign!.notice).toBe(COPY);
    expect(atSign!.footer).not.toBeNull();
    expect(atSign!.footer).not.toMatch(/fee applies/i);
    expect(atSign!.footer).toMatch(/no platform fee on this route/i);
  });

  it('a fee-bearing swap keeps the standing sentence', async () => {
    h.simulateSwap.mockResolvedValue(OK);
    await typeAmountAndBuy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(atSign!.footer).toMatch(/% platform fee applies on pairs that include SOL or USDC\./);
  });
});

describe('SolanaSwapPage: a no-fee re-quote that pays less than the trader agreed to is shown, not sent', () => {
  it('no wallet prompt, "Price moved", and the quote left on screen is the no-fee one, labelled', async () => {
    // The fee quote pays 14.925; at 0.50% the floor is 14.850375. The re-quote pays 14.8.
    const worse = quote({ outAmount: '14800000', otherAmountThreshold: '14726000', platformFee: null });
    h.getQuote.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? worse : FEE_QUOTE));
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    await typeAmountAndBuy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Price moved', expect.anything()));
    expect(h.sendTransaction).not.toHaveBeenCalled();
    // Only the fee build was ever built or simulated.
    expect(h.buildSwapTransaction).toHaveBeenCalledTimes(1);
    expect(h.simulateSwap).toHaveBeenCalledTimes(1);
    // What is on screen is the re-quote, and it says what it is.
    await waitFor(() => expect(screen.getByTestId('site-fee-waived')).toHaveTextContent(COPY));
    expect(screen.getByTestId('site-fee-value')).toHaveTextContent('None on this route');
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent).toBe('14.8');
    expect(h.toast.info).not.toHaveBeenCalled();
  });
});

describe('SolanaSwapPage: clicking again on a waived quote compares like with like', () => {
  it('after a wallet reject, the second click signs the rebuild: no false "Price moved"', async () => {
    // Mainnet shape: the fee quote sits EXACTLY on the no-fee quote's 0.50%
    // floor (15 -> 14.925), so one unit of ordinary movement used to trip the
    // display-vs-submit guard, which was comparing a no-fee quote with a
    // fee-bearing one.
    const FEE_TICKED = quote({ outAmount: '14924999', otherAmountThreshold: '14850374' });
    h.getQuote.mockImplementation(async (p: { noPlatformFee?: boolean }) =>
      p.noPlatformFee ? NO_FEE_QUOTE : h.sendTransaction.mock.calls.length > 0 ? FEE_TICKED : FEE_QUOTE,
    );
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    h.sendTransaction.mockImplementationOnce(async () => { throw new Error('User rejected the request.'); });
    h.sendTransaction.mockImplementationOnce(async () => SIG);
    await typeAmountAndBuy();
    // A decline is the trader's own "no": said as that, never as a failed swap.
    await waitFor(() => expect(h.toast.info).toHaveBeenCalledWith('Not sent', { description: 'You cancelled in your wallet. Nothing was sent.' }));
    expect(h.toast.error).not.toHaveBeenCalledWith('Swap failed', expect.anything());

    // Nothing was sent; the no-fee quote the trader was shown is still there.
    const buy = screen.getByRole('button', { name: 'Buy USDC' });
    await waitFor(() => expect(buy).toBeEnabled());
    expect(screen.getByTestId('site-fee-waived')).toHaveTextContent(COPY);
    fireEvent.click(buy);

    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(2));
    expect(h.toast.error).not.toHaveBeenCalledWith('Price moved', expect.anything());
    const second = h.sendTransaction.mock.calls[1]![0] as VersionedTransaction;
    expect(second.message.compiledInstructions[0]!.data[0]).toBe(2);
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Bought USDC', expect.objectContaining({ description: expect.stringContaining(COPY) })));
  });

  it('if the fee can be taken after all on the second click, the fee-bearing swap is shown, not signed', async () => {
    // The trader clicked a quote labelled "no site fee". A fee-bearing swap
    // pays them less than that label promised: it needs their own click.
    let feeSims = 0;
    h.simulateSwap.mockImplementation(async (b64: string) => {
      if (b64 !== TX_FEE) return OK;
      feeSims += 1;
      return feeSims === 1 ? JUP_6014 : OK;
    });
    h.sendTransaction.mockImplementationOnce(async () => { throw new Error('User rejected the request.'); });
    await typeAmountAndBuy();
    // A decline is the trader's own "no": said as that, never as a failed swap.
    await waitFor(() => expect(h.toast.info).toHaveBeenCalledWith('Not sent', { description: 'You cancelled in your wallet. Nothing was sent.' }));
    expect(h.toast.error).not.toHaveBeenCalledWith('Swap failed', expect.anything());
    const buy = screen.getByRole('button', { name: 'Buy USDC' });
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);

    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Quote changed', expect.anything()));
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('site-fee-waived')).toBeNull());
    expect(screen.getByTestId('site-fee-value')).toHaveTextContent(/% · in USDC$/);
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent).toBe('14.925');
  });
});

describe('SolanaSwapPage: a swap that was SENT is never called "failed" for want of a confirmation', () => {
  // The words are the site's one shared "we can't tell" warning (surfaceUnconfirmedTx
  // in lib/txErrors.ts), the same one the DCA and limit tabs raise; this path's own
  // "Sent, not confirmed yet" toast went when the two confirm modules became one.
  it('never confirmed, on the waived route: "we can\'t tell", the no-fee sentence, an explorer link, and a pending row', async () => {
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    h.getSignatureStatuses.mockImplementation(async () => ({ value: [null] }));
    await typeAmountAndBuy();
    await waitFor(() => expect(h.toast.warning).toHaveBeenCalledTimes(1));

    const [title, opts] = h.toast.warning.mock.calls[0]! as [string, { description: string; action: { label: string } }];
    expect(title).toBe("We couldn't confirm this transaction");
    expect(opts.description).toContain(SIG.slice(0, 10));
    expect(opts.description).toMatch(/we can't tell whether it went through/);
    expect(opts.description).toMatch(/before you send it again: if it landed, swapping again buys a second time\./);
    expect(opts.description).toContain(COPY);
    expect(opts.action.label).toBe('Check on Explorer');
    // Never "failed", never "bought".
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalledWith('Bought USDC', expect.anything());
    // It was asked every 2 s for the whole 90 s (0 s to 90 s inclusive) before giving up.
    expect(h.getSignatureStatuses).toHaveBeenCalledTimes(46);
    // The activity list keeps the signature, marked as not confirmed, with the waiver.
    const rows = getActivity(USER.toBase58());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sig).toBe(SIG);
    expect(rows[0]!.summary).toMatch(/^Sent, not confirmed: /);
    expect(rows[0]!.summary).toMatch(/no site fee on this route/);
    // The form is cleared, so the same buy is not one click away.
    await waitFor(() => expect(screen.getByLabelText('Amount of SOL to pay')).toHaveValue(''));
  });

  it('a status read that keeps throwing, on a fee-bearing swap: the same neutral result, with no waiver said', async () => {
    h.simulateSwap.mockResolvedValue(OK);
    h.getSignatureStatuses.mockImplementation(async () => { throw new Error('429 Too Many Requests'); });
    await typeAmountAndBuy();
    await waitFor(() => expect(h.toast.warning).toHaveBeenCalledTimes(1));
    const [title, opts] = h.toast.warning.mock.calls[0]! as [string, { description: string }];
    expect(title).toBe("We couldn't confirm this transaction");
    expect(opts.description).toMatch(/if it landed, swapping again buys a second time\.$/);
    expect(opts.description).not.toMatch(/no site fee/i);
    expect(h.toast.error).not.toHaveBeenCalled();
    const rows = getActivity(USER.toBase58());
    expect(rows[0]!.summary).toMatch(/^Sent, not confirmed: /);
    expect(rows[0]!.summary).not.toMatch(/no site fee/);
  });

  it('refused on chain is said as that, with the View link, and is not recorded as a buy', async () => {
    h.simulateSwap.mockResolvedValue(OK);
    h.getSignatureStatuses.mockImplementation(async () => ({ value: [{ err: { InstructionError: [2, { Custom: 6001 }] }, confirmationStatus: 'confirmed' }] }));
    await typeAmountAndBuy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledTimes(1));
    const [title, opts] = h.toast.error.mock.calls[0]! as [string, { description: string; action: { label: string } }];
    expect(title).toBe('Swap refused on chain');
    expect(opts.description).toMatch(/Only the network fee was spent/);
    expect(opts.action.label).toBe('View');
    expect(h.toast.warning).not.toHaveBeenCalled();
    expect(getActivity(USER.toBase58())).toHaveLength(0);
  });

  // The rule the shared poller took from this path's own one: a failure seen at
  // 'processed' can be on a fork that is dropped, and the same swap can then land.
  it('an error seen only at processed is not "refused": the wait goes on and the swap is bought', async () => {
    h.simulateSwap.mockResolvedValue(OK);
    let reads = 0;
    h.getSignatureStatuses.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { value: [{ err: { InstructionError: [2, { Custom: 6001 }] }, confirmationStatus: 'processed' }] }
        : { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    });
    await typeAmountAndBuy();
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Bought USDC', expect.anything()));
    expect(reads).toBe(2);
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.warning).not.toHaveBeenCalled();
  });
});
