// A SENT, UNCONFIRMED swap closes every way to send it again (owner, 2026-10-13).
//
// Before: a swap through Jupiter wrote nothing until its 90 s watch ended, so a reload or
// a trip away and back brought back a live Buy with the same amount; a swap in our own
// pool wrote one note for the tab, in sessionStorage, so a second tab was not held. Now a
// note is written the moment any swap has a signature, in storage every tab of the site
// reads, keyed by the wallet that signed, and Buy stays held for that wallet until the
// chain answers, or ten minutes pass, or the person turns it back on.
//
// Also here: the words a press ends on when it never reached the wallet, when the wallet
// said no (by words, or by code 4001 alone), and when its answer did not come back.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import { WalletNotConnectedError, WalletSendTransactionError } from '@solana/wallet-adapter-base';

const { toast, connection, wallet, jup, recheckOutcome, built } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  connection: {
    getBalance: vi.fn(),
    getParsedTokenAccountsByOwner: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getMultipleAccountsInfo: vi.fn(),
    getBlockHeight: vi.fn(),
    isBlockhashValid: vi.fn(),
  },
  wallet: { sendTransaction: vi.fn(), publicKey: null as unknown },
  jup: {
    getQuote: vi.fn(),
    buildSwapTransaction: vi.fn(),
    simulateSwap: vi.fn(),
  },
  recheckOutcome: vi.fn(),
  // What Jupiter's transaction deserializes to: none of its fields by default.
  built: { tx: {} as unknown },
}));

const OWNER = new PublicKey('11111111111111111111111111111111');
const OTHER = new PublicKey(new Uint8Array(32).fill(9));
const SIG = '5'.repeat(40) + 'Sig' + '7'.repeat(40);

vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', () => ({
  m: { div: ({ children, initial: _i, animate: _a, transition: _t, ...p }: { children?: ReactNode } & Record<string, unknown>) => <div {...p}>{children}</div> },
}));
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => ({ publicKey: wallet.publicKey, sendTransaction: wallet.sendTransaction }),
}));
vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  VersionedTransaction: { deserialize: () => built.tx },
}));
vi.mock('../components/solana/SolanaProviders', () => ({ SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../components/solana/SolanaConnectButton', () => ({ SolanaConnectButton: () => null }));
vi.mock('../components/solana/TokenDetail', () => ({ TokenDetail: () => null }));
vi.mock('../components/solana/PairChart', () => ({ PairChart: () => null }));
vi.mock('../components/ClockLine', () => ({ ClockLine: () => null }));
vi.mock('../components/swap/ChainSwitch', () => ({ ChainSwitch: () => null }));
vi.mock('../components/swap/SolanaRouteLine', () => ({ SolanaRouteLine: () => null }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../lib/analytics', () => ({ trackPageView: () => {} }));
vi.mock('../lib/solanaTokenList', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/solanaTokenList')>()),
  fetchTrending: async () => [],
  resolveMint: async () => null,
}));
vi.mock('../lib/jupiter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/jupiter')>()),
  ...jup,
  getUsdPrices: async () => ({}),
  getShield: async () => ({}),
}));
// Our pools hold nothing for this pair: every trade here is Jupiter's.
vi.mock('../lib/solana/swap/venuePools', () => ({
  readVenuePools: async () => ({ kind: 'ok' }),
  quoteVenuePools: () => ({ state: 'absent', candidates: [] }),
  rememberingFetch: () => fetch,
}));
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: async () => ({ kind: 'absent' }) }));
// A note is looked up through the swap code; only its lookup is used here.
vi.mock('../components/swap/venueSwapApi', () => ({
  loadVenueSwapApi: async () => ({
    swapWriteConfig: () => null,
    readSwapGate: async () => ({ kind: 'off' }),
    recheckOutcome: (...a: unknown[]) => recheckOutcome(...a),
    explorerTxUrl: (sig: string) => `https://solscan.io/tx/${sig}`,
  }),
}));

import SolanaSwapPage from './SolanaSwapPage';
import { readPendingTrades, savePendingTrade, swapPendingScope, LOST_ANSWER_TTL_MS, PENDING_TRADE_TTL_MS } from '../components/solana/curve/pendingTrade';
import {
  CHECK_KEEPS_FAILING,
  DECLINED_IN_WALLET,
  HELD_UNTIL,
  HOLD_DISMISS_LABEL,
  HOLD_DISMISS_MEANS,
  LOST_ANSWER_TITLE,
  LOST_HELD_UNTIL,
  LOST_HOLD_TITLE,
  LOST_NO_SIGNATURE,
  nothingSentCopy,
} from '../lib/solana/swap/walletCopy';
import { NOT_TEST_RUN_COPY } from '../lib/solana/swap/jupiterFeeRetry';
import { JUPITER_WINDOW_BLOCKS } from '../lib/solana/swap/jupiterNote';
import { notSignedCopy } from '../lib/solana/walletThrow';

vi.setConfig({ testTimeout: 30_000 });

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const quote = {
  inputMint: SOL_MINT, outputMint: USDC_MINT, inAmount: '500000000', outAmount: '75000000',
  otherAmountThreshold: '74625000', slippageBps: 50, priceImpactPct: '0', routePlan: [],
};
const notYet = { context: { slot: 9 }, value: [null] };
const HEIGHT = 1_000;
const mine = () => swapPendingScope(OWNER.toBase58());

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
  // A link with the amount in it: a reload brings the same amount back.
  window.history.replaceState(null, '', `/solana?amt=0.5&out=${USDC_MINT}`);
  wallet.publicKey = OWNER;
  Object.values(toast).forEach((fn) => fn.mockReset());
  connection.getBalance.mockReset().mockResolvedValue(10_000_000_000);
  connection.getParsedTokenAccountsByOwner.mockReset().mockResolvedValue({ value: [] });
  connection.getSignatureStatuses.mockReset().mockResolvedValue(notYet);
  connection.getMultipleAccountsInfo.mockReset().mockResolvedValue([]);
  connection.getBlockHeight.mockReset().mockResolvedValue(HEIGHT);
  connection.isBlockhashValid.mockReset().mockRejectedValue(new Error('not asked here'));
  built.tx = {};
  wallet.sendTransaction.mockReset().mockResolvedValue(SIG);
  jup.getQuote.mockReset().mockResolvedValue(quote);
  jup.buildSwapTransaction.mockReset().mockResolvedValue('AAAA');
  jup.simulateSwap.mockReset().mockResolvedValue({ ok: true });
  recheckOutcome.mockReset().mockImplementation(async (_c: unknown, signature: string) => ({ status: 'unknown', signature, message: 'The network has no record of it yet. It may still be landing.' }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const buyButton = () => screen.findByRole('button', { name: /^(Buy USDC|Swapping…)$/ }, { timeout: 5_000 });
const amountBox = () => screen.getByLabelText('Amount of SOL to pay') as HTMLInputElement;
const outlastTheWatch = () => act(async () => { await vi.advanceTimersByTimeAsync(100_000); });

async function readyToBuy() {
  render(<SolanaSwapPage />);
  const buy = await screen.findByRole('button', { name: 'Buy USDC' }, { timeout: 5_000 });
  await waitFor(() => expect(buy).toBeEnabled());
  return buy;
}

describe('a swap through Jupiter, sent and not confirmed', () => {
  it('its note is written the moment it has a signature, for the wallet that signed, with its last valid height', async () => {
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    // The watch is still on: the note is already there, in storage every tab reads.
    await waitFor(() => expect(readPendingTrades(mine())).toHaveLength(1));
    expect(readPendingTrades(mine())[0]).toMatchObject({ kind: 'jupiter-swap', signature: SIG, lastValidBlockHeight: HEIGHT + JUPITER_WINDOW_BLOCKS });
    expect(localStorage.getItem(mine())).not.toBeNull();
    // And the page says so: the signature, a link to look it up, and what holds Buy.
    const card = await screen.findByTestId('venue-swap-pending');
    expect(within(card).getByText(SIG)).toBeInTheDocument();
    expect(within(card).getByRole('link').getAttribute('href')).toBe(`https://solscan.io/tx/${SIG}`);
    expect(within(card).getByText(HELD_UNTIL)).toBeInTheDocument();
    expect(within(card).getByText('Through Jupiter')).toBeInTheDocument();
  });

  it('a reload after the watch ran out brings back the hold, not a live Buy with the same amount', async () => {
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    await outlastTheWatch();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    cleanup();
    // The reload: the link brings the same 0.5 SOL back.
    render(<SolanaSwapPage />);
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(amountBox().value).toBe('0.5');
    expect(await buyButton()).toBeDisabled();
    // It was looked up on arrival, with the height it can land until.
    await waitFor(() => expect(recheckOutcome).toHaveBeenCalledWith(connection, SIG, { lastValidBlockHeight: HEIGHT + JUPITER_WINDOW_BLOCKS }));
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('landed: the note goes as soon as the chain says so, and Buy is free', async () => {
    connection.getSignatureStatuses.mockResolvedValue({ context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Bought USDC', expect.anything()));
    expect(readPendingTrades(mine())).toEqual([]);
    expect(screen.queryByTestId('venue-swap-pending')).toBeNull();
  });
});

describe('the hold, wherever the note came from', () => {
  it('another tab of the site writes one: this tab holds Buy without a reload', async () => {
    const buy = await readyToBuy();
    // Another tab sent a swap from the same wallet.
    savePendingTrade(mine(), { kind: 'jupiter-swap', signature: SIG, lastValidBlockHeight: HEIGHT + JUPITER_WINDOW_BLOCKS });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: mine() })); });
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    await waitFor(() => expect(buy).toBeDisabled());
  });

  it('a note of another wallet holds nothing; the wallet that signed it is held', async () => {
    savePendingTrade(swapPendingScope(OTHER.toBase58()), { kind: 'jupiter-swap', signature: SIG, lastValidBlockHeight: 5 });
    const buy = await readyToBuy();
    expect(screen.queryByTestId('venue-swap-pending')).toBeNull();
    expect(buy).toBeEnabled();
    cleanup();
    wallet.publicKey = OTHER;
    render(<SolanaSwapPage />);
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    expect(await buyButton()).toBeDisabled();
  });

  it.each([
    ['landed', 'confirmed'],
    ['refused', 'reverted'],
    ['can no longer land', 'expired'],
  ])('the chain says it %s: the hold ends', async (_name, status) => {
    recheckOutcome.mockImplementation(async (_c: unknown, signature: string) => ({ status, signature, message: '' }));
    savePendingTrade(mine(), { kind: 'venue-swap', signature: SIG, lastValidBlockHeight: 5 });
    render(<SolanaSwapPage />);
    await waitFor(() => expect(recheckOutcome).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('venue-swap-pending')).toBeNull());
    expect(readPendingTrades(mine())).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buy USDC' })).toBeEnabled());
  });

  it('an unread answer is not an answer: the hold stays, and it is asked again on its own', async () => {
    recheckOutcome.mockImplementation(async () => { throw new Error('fetch failed: 503'); });
    savePendingTrade(mine(), { kind: 'jupiter-swap', signature: SIG, lastValidBlockHeight: 5 });
    render(<SolanaSwapPage />);
    const card = await screen.findByTestId('venue-swap-pending');
    await waitFor(() => expect(within(card).getByRole('status').textContent).toMatch(/^Could not check just now/));
    const asked = recheckOutcome.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(recheckOutcome.mock.calls.length).toBeGreaterThan(asked);
    expect(screen.getByTestId('venue-swap-pending')).toBeInTheDocument();
    expect(await buyButton()).toBeDisabled();
  });

  it('“Turn Buy back on now” says it does not cancel the swap, and frees Buy for this wallet', async () => {
    savePendingTrade(mine(), { kind: 'jupiter-swap', signature: SIG, lastValidBlockHeight: 5 });
    render(<SolanaSwapPage />);
    const card = await screen.findByTestId('venue-swap-pending');
    expect(within(card).getByText(HOLD_DISMISS_MEANS)).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByRole('button', { name: HOLD_DISMISS_LABEL }).getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(within(card).getByRole('button', { name: HOLD_DISMISS_LABEL }));
    await waitFor(() => expect(screen.queryByTestId('venue-swap-pending')).toBeNull());
    expect(readPendingTrades(mine())).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buy USDC' })).toBeEnabled());
  });

  it('ten minutes after it was sent, the hold ends on its own, while the page is open', async () => {
    savePendingTrade(mine(), { kind: 'jupiter-swap', signature: SIG, lastValidBlockHeight: 5 }, Date.now() - PENDING_TRADE_TTL_MS + 3_000);
    render(<SolanaSwapPage />);
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    await waitFor(() => expect(screen.queryByTestId('venue-swap-pending')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buy USDC' })).toBeEnabled());
  });
});

describe('a press that ends before a signature says what happened', () => {
  it('the price could not be fetched at the press: nothing was sent, and the form is as it was', async () => {
    const buy = await readyToBuy();
    jup.getQuote.mockRejectedValue(new Error('Quote unavailable (502)'));
    fireEvent.click(buy);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: nothingSentCopy('Jupiter’s price', 'Quote unavailable (502)') }));
    expect(toast.error).not.toHaveBeenCalledWith('Swap failed', expect.anything());
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(amountBox().value).toBe('0.5');
  });

  it('Jupiter’s transaction could not be fetched: nothing was sent, and the form is as it was', async () => {
    jup.buildSwapTransaction.mockRejectedValue(new Error('Could not build swap (502)'));
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: nothingSentCopy('Jupiter’s transaction for this trade', 'Could not build swap (502)') }));
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(amountBox().value).toBe('0.5');
  });

  it('the wallet’s answer did not come back: "sent or not, we cannot tell", never "Swap failed"', async () => {
    wallet.sendTransaction.mockRejectedValue(new WalletSendTransactionError('failed to send transaction: fetch failed', new TypeError('fetch failed')));
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(LOST_ANSWER_TITLE, {
      description: expect.stringMatching(/^Your wallet stopped without handing back a signature \(failed to send transaction: fetch failed\)\. This page cannot tell whether it sent ≈75 USDC with 0\.5 SOL\. Check your wallet's activity before you press again\.$/),
    }));
    expect(toast.error).not.toHaveBeenCalled();
    // The same buy is not one click away.
    expect(amountBox().value).toBe('');
  });

  it.each([
    ['Solflare’s decline, in its words', new WalletSendTransactionError('Transaction cancelled', new Error('Transaction cancelled'))],
    ['Trust’s decline, code 4001 and the message "4001" only', new WalletSendTransactionError('4001', Object.assign(new Error('4001'), { code: 4001 }))],
    ['a decline that is an object with no message', new WalletSendTransactionError(undefined, { code: 4001 })],
  ])('%s is a cancel, as on our own pool’s route', async (_name, thrown) => {
    wallet.sendTransaction.mockRejectedValue(thrown);
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Not sent', { description: DECLINED_IN_WALLET }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(readPendingTrades(mine())).toEqual([]);
    expect(amountBox().value).toBe('0.5');
  });

  it('a wallet that was never asked gets its reason, and nothing was sent', async () => {
    wallet.sendTransaction.mockRejectedValue(new WalletNotConnectedError());
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: notSignedCopy('this page is no longer connected to it, so it was never asked') }));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(amountBox().value).toBe('0.5');
  });

  it('"Swap submitted" carries no em dash', async () => {
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Swap submitted', { description: expect.stringMatching(/\. Confirming…$/) }));
    for (const [, o] of toast.success.mock.calls) expect(JSON.stringify(o)).not.toContain('—');
  });
});

// A lost answer: the wallet threw in a way that can come after it signed, with no signature
// (owner, 2026-10-14, D1). Buy is held for that wallet until the swap's blockhash can no
// longer land, 2 minutes at most, or "Turn Buy back on now".
describe('a wallet answer lost before a signature came back', () => {
  const BH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
  const lost = () => new WalletSendTransactionError('failed to send transaction: fetch failed', new TypeError('fetch failed'));
  /** Seen valid at slot 100 by the probe; a later check (minContextSlot) answers `later`. */
  const blockhashAnswers = (later: { context: { slot: number }; value: boolean }) => {
    built.tx = { message: { recentBlockhash: BH } };
    connection.isBlockhashValid.mockImplementation(async (_h: string, o?: { minContextSlot?: number }) =>
      o?.minContextSlot ? later : { context: { slot: 100 }, value: true });
  };
  /** The amount typed again, as a trader would after the form was cleared. */
  const typeAgain = async () => {
    fireEvent.change(amountBox(), { target: { value: '0.5' } });
    return buyButton();
  };

  it('holds Buy for this wallet with no signature known, in every tab and after a reload', async () => {
    wallet.sendTransaction.mockRejectedValue(lost());
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(LOST_ANSWER_TITLE, expect.anything()));
    expect(readPendingTrades(mine())).toEqual([expect.objectContaining({ kind: 'jupiter-swap', signature: null })]);
    const card = await screen.findByTestId('venue-swap-pending');
    expect(within(card).getByText(LOST_HOLD_TITLE)).toBeInTheDocument();
    expect(within(card).getByText(LOST_NO_SIGNATURE)).toBeInTheDocument();
    expect(within(card).getByText(LOST_HELD_UNTIL)).toBeInTheDocument();
    expect(within(card).queryByRole('link')).toBeNull();
    // The same buy typed again is not sent.
    const buy = await typeAgain();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(buy).toBeDisabled();
    cleanup();
    render(<SolanaSwapPage />);
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    expect(await buyButton()).toBeDisabled();
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('ends once its blockhash can no longer land, by a server past the slot it was seen valid at', async () => {
    blockhashAnswers({ context: { slot: 200 }, value: false });
    wallet.sendTransaction.mockRejectedValue(lost());
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(readPendingTrades(mine())[0]?.blockhash).toEqual({ hash: BH, validAt: 100 }));
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
    await waitFor(() => expect(screen.queryByTestId('venue-swap-pending')).toBeNull());
    expect(readPendingTrades(mine())).toEqual([]);
    const buy = await typeAgain();
    await waitFor(() => expect(buy).toBeEnabled());
  });

  it('"not valid" from a server behind that slot does not end it; 2 minutes do', async () => {
    blockhashAnswers({ context: { slot: 90 }, value: false });
    wallet.sendTransaction.mockRejectedValue(lost());
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(readPendingTrades(mine())[0]?.blockhash).toEqual({ hash: BH, validAt: 100 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(screen.getByTestId('venue-swap-pending')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(LOST_ANSWER_TTL_MS - 61_000 + 2_000); });
    await waitFor(() => expect(screen.queryByTestId('venue-swap-pending')).toBeNull());
    expect(readPendingTrades(mine())).toEqual([]);
  });

  it('a swap that did get a signature keeps its blockhash, and its check asks the blockhash first', async () => {
    blockhashAnswers({ context: { slot: 200 }, value: true });
    fireEvent.click(await readyToBuy());
    await waitFor(() => expect(readPendingTrades(mine())[0]).toMatchObject({ signature: SIG, blockhash: { hash: BH, validAt: 100 } }));
    await outlastTheWatch();
    cleanup();
    render(<SolanaSwapPage />);
    await waitFor(() => expect(recheckOutcome).toHaveBeenCalledWith(connection, SIG, {
      lastValidBlockHeight: HEIGHT + JUPITER_WINDOW_BLOCKS,
      blockhash: { hash: BH, validAt: 100 },
    }));
  });
});

// Jupiter's test run runs through our own RPC. While it cannot run, every press stops before
// the wallet; from the second in a row the page says the fault is likely ours (D2).
describe('a test run that could not run, press after press', () => {
  it('the first press says "press again"; the second says the check keeps failing on our side; one that answers starts the count again', async () => {
    jup.simulateSwap.mockRejectedValue(new Error('fetch failed: 503'));
    const buy = await readyToBuy();
    fireEvent.click(buy);
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith('Swap not checked', { description: NOT_TEST_RUN_COPY }));
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith('Swap not checked', { description: CHECK_KEEPS_FAILING }));
    // A test run that answers (here it refuses) ends the run.
    await waitFor(() => expect(buy).toBeEnabled());
    jup.simulateSwap.mockResolvedValueOnce({ ok: false, reason: 'custom program error: 0x1', jupiterIncorrectTokenProgram: false });
    fireEvent.click(buy);
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith('Swap would fail', expect.anything()));
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith('Swap not checked', { description: NOT_TEST_RUN_COPY }));
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
});
