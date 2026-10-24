// The DCA tab (Jupiter Recurring, time-based).
//
// Jupiter's recurring program is older than Token-2022: an order for a Token-2022 token
// such as BAYLA fails Jupiter's own test run (error 3007), buying and selling. The tab
// offered it anyway. It now reads both mints' token program before anything is signed,
// refuses a Token-2022 token in one sentence, and says so when the read could not run.
// Jupiter also asks for at least $50 per buy (the hint said roughly $100 in total): the
// tab checks that from the price the page already has.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';

const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const ORDER = 'DcaOrderKey1111111111111111111111111111111';
const SIG = '5'.repeat(40) + 'Sig' + '7'.repeat(40);

const { toast, connection, wallet, jup, prices } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  connection: {
    getBalance: vi.fn(),
    getParsedTokenAccountsByOwner: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getMultipleAccountsInfo: vi.fn(),
  },
  wallet: { sendTransaction: vi.fn() },
  jup: {
    getQuote: vi.fn(),
    createRecurringOrder: vi.fn(),
    getRecurringOrders: vi.fn(),
    cancelRecurringOrder: vi.fn(),
    createTriggerOrder: vi.fn(),
    getTriggerOrders: vi.fn(),
  },
  prices: { value: {} as Record<string, number> },
}));

const OWNER = new PublicKey('11111111111111111111111111111111');

vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', () => ({
  m: { div: ({ children, initial: _i, animate: _a, transition: _t, ...p }: { children?: ReactNode } & Record<string, unknown>) => <div {...p}>{children}</div> },
}));
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => ({ publicKey: OWNER, sendTransaction: wallet.sendTransaction }),
}));
vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  VersionedTransaction: { deserialize: () => ({}) },
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
  getUsdPrices: async () => prices.value,
  getShield: async () => ({}),
}));

import { WalletNotConnectedError, WalletSendTransactionError } from '@solana/wallet-adapter-base';
import SolanaSwapPage from './SolanaSwapPage';
import { DECLINED_IN_WALLET, LOST_ANSWER_TITLE, lostAnswerCopy } from '../lib/solana/swap/walletCopy';
import { notSignedCopy } from '../lib/solana/walletThrow';

vi.setConfig({ testTimeout: 30_000 });

/** The token program that owns each mint, as the chain would answer. */
const owners: Record<string, string> = { [SOL_MINT]: LEGACY, [USDC_MINT]: LEGACY, [BAYLA_MINT]: T22 };

beforeEach(() => {
  localStorage.clear();
  prices.value = {};
  Object.values(toast).forEach((fn) => fn.mockReset());
  connection.getBalance.mockReset().mockResolvedValue(10_000_000_000);
  connection.getParsedTokenAccountsByOwner.mockReset().mockResolvedValue({ value: [] });
  connection.getSignatureStatuses.mockReset().mockResolvedValue({ context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
  connection.getMultipleAccountsInfo.mockReset().mockImplementation(async (keys: PublicKey[]) =>
    keys.map((k) => (owners[k.toBase58()] ? { owner: new PublicKey(owners[k.toBase58()]!) } : null)),
  );
  wallet.sendTransaction.mockReset().mockResolvedValue(SIG);
  jup.getQuote.mockReset().mockRejectedValue(new Error('not asked here'));
  jup.createRecurringOrder.mockReset().mockResolvedValue('AAAA');
  jup.getRecurringOrders.mockReset().mockResolvedValue([]);
  jup.cancelRecurringOrder.mockReset().mockResolvedValue('AAAA');
  jup.createTriggerOrder.mockReset().mockResolvedValue('AAAA');
  jup.getTriggerOrders.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

async function openDca(search: string) {
  window.history.replaceState(null, '', `/solana${search}`);
  render(<SolanaSwapPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'DCA' }));
}
const total = (symbol: string) => screen.getByLabelText(`Total ${symbol} to invest`);
const REFUSED = "BAYLA is a Token-2022 token, and Jupiter's recurring orders cannot buy or sell it.";

describe('DCA: a Token-2022 token on either side is refused before anything is signed', () => {
  it.each([
    ['buying BAYLA with SOL', `?out=${BAYLA_MINT}`, 'SOL'],
    ['selling BAYLA for USDC', `?in=${BAYLA_MINT}&out=${USDC_MINT}`, 'BAYLA'],
  ])('%s: one sentence says why, and Start is never live', async (_name, search, paySymbol) => {
    await openDca(search);
    expect(await screen.findByText(REFUSED)).toBeInTheDocument();
    fireEvent.change(total(paySymbol), { target: { value: '5' } });
    const start = screen.getByRole('button', { name: 'Not available for BAYLA' });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    await new Promise((r) => setTimeout(r, 200));
    expect(jup.createRecurringOrder).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('the press reads the tokens again: a Token-2022 token found only then sends nothing', async () => {
    // The tab's first read could not run; the press reads again and finds BAYLA's program.
    connection.getMultipleAccountsInfo.mockRejectedValueOnce(new Error('fetch failed: 503'));
    await openDca(`?out=${BAYLA_MINT}`);
    expect(await screen.findByText('The two tokens could not be checked just now. Start the DCA checks them again.')).toBeInTheDocument();
    fireEvent.change(total('SOL'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('DCA not started', { description: REFUSED }));
    expect(jup.createRecurringOrder).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(await screen.findByText(REFUSED)).toBeInTheDocument();
  });

  it('a press whose read cannot run sends nothing and says so; the next press reads again and goes on', async () => {
    connection.getMultipleAccountsInfo.mockRejectedValue(new Error('fetch failed: 503'));
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('DCA not started', { description: 'The two tokens could not be checked just now, so nothing was sent. Press again.' }));
    expect(jup.createRecurringOrder).not.toHaveBeenCalled();
    // Never said as a refusal: nothing was found.
    expect(screen.queryByText(/Token-2022/)).toBeNull();
    connection.getMultipleAccountsInfo.mockImplementation(async (keys: PublicKey[]) => keys.map((k) => ({ owner: new PublicKey(owners[k.toBase58()]!) })));
    fireEvent.click(screen.getByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    expect(jup.createRecurringOrder).toHaveBeenCalledTimes(1);
  });

  it('two plain tokens: no sentence, and Start sends the order', async () => {
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Token-2022/)).toBeNull();
    expect(jup.createRecurringOrder).toHaveBeenCalledWith(expect.objectContaining({ inputMint: SOL_MINT, outputMint: USDC_MINT }));
  });

  it('Cancel on an order already running still works with BAYLA on the form', async () => {
    jup.getRecurringOrders.mockResolvedValue([{ orderKey: ORDER, inputMint: SOL_MINT, outputMint: BAYLA_MINT }]);
    await openDca(`?out=${BAYLA_MINT}`);
    expect(await screen.findByText(REFUSED)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    expect(jup.cancelRecurringOrder).toHaveBeenCalledWith(OWNER.toBase58(), ORDER);
    await waitFor(() => expect(toast.success.mock.calls.some((c) => /DCA cancelled/.test(String(c[0])))).toBe(true));
  });
});

// One wallet behaviour, one wording (owner, 2026-10-13): the DCA and limit tabs send
// through the wallet's sendTransaction, and read its throw as every Solana write does.
describe('DCA and limit orders: the wallet’s throw is said for what it is', () => {
  const trustDecline = () => new WalletSendTransactionError('4001', Object.assign(new Error('4001'), { code: 4001 }));
  const lost = () => new WalletSendTransactionError('failed to send transaction: fetch failed', new TypeError('fetch failed'));

  it('Trust’s code-only decline on Start is a cancel, not "Could not start the DCA"', async () => {
    wallet.sendTransaction.mockRejectedValue(trustDecline());
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Not sent', { description: DECLINED_IN_WALLET }));
    expect(toast.error).not.toHaveBeenCalled();
    expect((total('SOL') as HTMLInputElement).value).toBe('5');
  });

  it('an answer that did not come back may have started it: "we cannot tell", and the form is cleared', async () => {
    wallet.sendTransaction.mockRejectedValue(lost());
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(LOST_ANSWER_TITLE, { description: lostAnswerCopy('failed to send transaction: fetch failed', 'the DCA was started') }));
    expect(toast.error).not.toHaveBeenCalled();
    expect((total('SOL') as HTMLInputElement).value).toBe('');
  });

  it('a page no longer connected to the wallet: its reason, and nothing was sent', async () => {
    wallet.sendTransaction.mockRejectedValue(new WalletNotConnectedError());
    jup.getRecurringOrders.mockResolvedValue([{ orderKey: ORDER, inputMint: SOL_MINT, outputMint: USDC_MINT }]);
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: notSignedCopy('this page is no longer connected to it, so it was never asked') }));
    expect(toast.error).not.toHaveBeenCalledWith('Could not cancel', expect.anything());
  });

  it('a limit order whose answer did not come back: "we cannot tell", and the form is cleared', async () => {
    wallet.sendTransaction.mockRejectedValue(lost());
    window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
    render(<SolanaSwapPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Limit order' }));
    fireEvent.change(screen.getByLabelText('Amount of SOL to sell'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Target price in USDC'), { target: { value: '200' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Place limit order' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(LOST_ANSWER_TITLE, { description: lostAnswerCopy('failed to send transaction: fetch failed', 'the order was placed') }));
    expect(toast.error).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Amount of SOL to sell') as HTMLInputElement).value).toBe('');
  });
});

describe('DCA: Jupiter asks for at least $50 per buy', () => {
  it('the hint names the per-buy minimum, not a total', async () => {
    await openDca(`?out=${USDC_MINT}`);
    expect(await screen.findByText(/Jupiter requires at least \$50 per buy\./)).toBeInTheDocument();
    expect(screen.queryByText(/\$100/)).toBeNull();
  });

  it('with the price read: a buy under $50 is said with its figure and Start is held; at $50 or more it is live', async () => {
    prices.value = { [SOL_MINT]: 150 };
    await openDca(`?out=${USDC_MINT}`);
    // 1 SOL in 4 buys: 0.25 SOL, $37.50 a buy.
    fireEvent.change(total('SOL'), { target: { value: '1' } });
    expect(await screen.findByText('Each buy is about $37.50, and Jupiter requires at least $50 per buy.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Under $50 per buy' })).toBeDisabled();
    // 2 buys of 0.5 SOL: $75 each.
    fireEvent.change(screen.getByLabelText('Number of buys'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start the DCA' })).toBeEnabled());
    expect(screen.queryByText(/Each buy is about/)).toBeNull();
  });

  it('with no price read, no figure is made up and Start is not held for it', async () => {
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start the DCA' })).toBeEnabled());
    expect(screen.queryByText(/Each buy is about/)).toBeNull();
  });
});

describe('DCA: at most one amber line at a time', () => {
  /** Every amber line the tab draws (its warnings), by its words. */
  const amberLines = () => [...document.querySelectorAll('p.text-amber-300')].map((p) => p.textContent);

  it('a Token-2022 token outranks "Insufficient" and the under-$50 line', async () => {
    // 2 SOL held, 3 SOL typed: short. At $10 a SOL, 4 buys of 0.75 SOL are $7.50 each: under $50.
    prices.value = { [SOL_MINT]: 10 };
    connection.getBalance.mockResolvedValue(2_000_000_000);
    await openDca(`?out=${BAYLA_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '3' } });
    expect(await screen.findByText(REFUSED)).toBeInTheDocument();
    await waitFor(() => expect(amberLines()).toEqual([REFUSED]));
  });

  it('with a plain pair, "Insufficient" outranks the under-$50 line', async () => {
    prices.value = { [SOL_MINT]: 10 };
    connection.getBalance.mockResolvedValue(2_000_000_000);
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '3' } });
    await waitFor(() => expect(amberLines()).toEqual(['Insufficient SOL balance.']));
  });
});
