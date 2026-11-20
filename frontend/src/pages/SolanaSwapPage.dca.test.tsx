// The DCA tab (Jupiter Recurring, time-based).
//
// Jupiter's recurring program is older than Token-2022: an order for a Token-2022 token
// such as BAYLA fails Jupiter's own test run (error 3007), buying and selling. The tab
// offered it anyway. It now reads both mints' token program before anything is signed,
// refuses a Token-2022 token in one sentence, and says so when the read could not run.
// Jupiter also asks for at least $50 per buy (the hint said roughly $100 in total): the
// tab checks that from the price the page already has.
//
// Since 2026-11-17 (Phantom, ticket #467471) a DCA or limit order, placed or cancelled, is
// test-run as Jupiter built it, the wallet's SOL checked, the wallet asked only to SIGN, and
// the signed bytes sent by this page through our RPC with preflight on
// (lib/solana/walletWrite.ts sendBuiltTx). The wallet's own sendTransaction is never called.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import { base58 } from '@scure/base';

const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const ORDER = 'DcaOrderKey1111111111111111111111111111111';
/** The wallet's signature: what the page reads back off the signed transaction. */
const SIGNED = new Uint8Array(64).fill(5);
const SIG = base58.encode(SIGNED);

interface FakeTx {
  version: 0;
  message: { recentBlockhash: string; staticAccountKeys: PublicKey[]; compiledInstructions: { programIdIndex: number }[]; header: { numRequiredSignatures: number } };
  signatures: Uint8Array[];
  serialize(): Uint8Array;
}

const { toast, connection, wallet, jup, prices, built } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  connection: {
    getBalance: vi.fn(),
    getParsedTokenAccountsByOwner: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getMultipleAccountsInfo: vi.fn(),
    // The final test run before the wallet, and our own send of what it signed.
    simulateTransaction: vi.fn(),
    sendRawTransaction: vi.fn(),
  },
  // `canSign`: false is a wallet that offers the page no signTransaction.
  wallet: { sendTransaction: vi.fn(), signTransaction: vi.fn(), canSign: true },
  // Jupiter's order transaction: web3.js cannot serialize or sign under jsdom, so the page's
  // deserialize hands back this stand-in, the one object the wallet signs and the page reads back.
  built: { tx: null as unknown as FakeTx },
  jup: {
    getQuote: vi.fn(),
    createRecurringOrder: vi.fn(),
    getRecurringOrders: vi.fn(),
    cancelRecurringOrder: vi.fn(),
    createTriggerOrder: vi.fn(),
    getTriggerOrders: vi.fn(),
    cancelTriggerOrder: vi.fn(),
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
  useWallet: () => ({ publicKey: OWNER, sendTransaction: wallet.sendTransaction, signTransaction: wallet.canSign ? wallet.signTransaction : undefined }),
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
  getUsdPrices: async () => prices.value,
  getShield: async () => ({}),
}));

import { WalletNotConnectedError, WalletSignTransactionError } from '@solana/wallet-adapter-base';
import SolanaSwapPage from './SolanaSwapPage';
import { DECLINED_IN_WALLET } from '../lib/solana/swap/walletCopy';
import { notSignedCopy } from '../lib/solana/walletThrow';
import { RENT_EXEMPT_EMPTY_LAMPORTS, WALLET_FEE_ROOM_LAMPORTS, WRITE_COPY, solShortCopy } from '../lib/solana/walletWrite';

vi.setConfig({ testTimeout: 30_000 });

/** The token program that owns each mint, as the chain would answer. */
const owners: Record<string, string> = { [SOL_MINT]: LEGACY, [USDC_MINT]: LEGACY, [BAYLA_MINT]: T22 };

/** Jupiter's order transaction, unsigned: this wallet pays. */
function jupiterTx(): FakeTx {
  return {
    version: 0,
    message: {
      recentBlockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
      staticAccountKeys: [OWNER, new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')],
      compiledInstructions: [{ programIdIndex: 1 }],
      header: { numRequiredSignatures: 1 },
    },
    signatures: [new Uint8Array(64)],
    serialize: () => new Uint8Array([1, 2, 3]),
  };
}
/** A final test run's answer; by default it passes, with the wallet left holding 9 SOL. */
const testRun = (over: { err?: unknown; logs?: string[]; lamportsAfter?: number } = {}) => ({
  context: { slot: 1 },
  value: { err: over.err ?? null, logs: over.logs ?? [], accounts: [{ lamports: over.lamportsAfter ?? 9_000_000_000, data: ['', 'base64'] }] },
});
const notYet = { context: { slot: 9 }, value: [null] };

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
  connection.simulateTransaction.mockReset().mockResolvedValue(testRun());
  connection.sendRawTransaction.mockReset().mockResolvedValue('sent');
  built.tx = jupiterTx();
  wallet.canSign = true;
  wallet.sendTransaction.mockReset().mockRejectedValue(new Error('the wallet must not send: this page does'));
  wallet.signTransaction.mockReset().mockImplementation(async (tx: FakeTx) => {
    tx.signatures[0] = SIGNED;
    return tx;
  });
  jup.getQuote.mockReset().mockRejectedValue(new Error('not asked here'));
  jup.createRecurringOrder.mockReset().mockResolvedValue('AAAA');
  jup.getRecurringOrders.mockReset().mockResolvedValue([]);
  jup.cancelRecurringOrder.mockReset().mockResolvedValue('AAAA');
  jup.createTriggerOrder.mockReset().mockResolvedValue('AAAA');
  jup.getTriggerOrders.mockReset().mockResolvedValue([]);
  jup.cancelTriggerOrder.mockReset().mockResolvedValue('AAAA');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  // Whatever the ending, the wallet only ever signed: the page sends.
  expect(wallet.sendTransaction).not.toHaveBeenCalled();
});

async function openDca(search: string) {
  window.history.replaceState(null, '', `/solana${search}`);
  render(<SolanaSwapPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'DCA' }));
}
const total = (symbol: string) => screen.getByLabelText(`Total ${symbol} to invest`);
const REFUSED = "BAYLA is a Token-2022 token, and Jupiter's recurring orders cannot buy or sell it.";

/** Start a DCA of 5 SOL into USDC. */
async function placeDca() {
  await openDca(`?out=${USDC_MINT}`);
  fireEvent.change(total('SOL'), { target: { value: '5' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
}
/** Place a limit order selling 1 SOL at 200 USDC. */
async function placeLimit() {
  window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
  render(<SolanaSwapPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Limit order' }));
  fireEvent.change(screen.getByLabelText('Amount of SOL to sell'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Target price in USDC'), { target: { value: '200' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Place limit order' }));
}
/** The two placements: how each is pressed, its amount box, and its own words. */
const PLACES = [
  {
    name: 'DCA', place: placeDca, amount: () => total('SOL') as HTMLInputElement, typed: '5', placed: 'DCA started',
    repeatCost: 'if it landed, starting it again opens a second DCA that deposits the same total again.',
  },
  {
    name: 'Limit order', place: placeLimit, amount: () => screen.getByLabelText('Amount of SOL to sell') as HTMLInputElement, typed: '1', placed: 'Limit order placed',
    repeatCost: 'if it landed, placing it again opens a second order that sells the same amount again.',
  },
];

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
    expect(wallet.signTransaction).not.toHaveBeenCalled();
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
    expect(wallet.signTransaction).not.toHaveBeenCalled();
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
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    expect(jup.createRecurringOrder).toHaveBeenCalledTimes(1);
  });

  it('two plain tokens: no sentence, and Start sends the order', async () => {
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.change(total('SOL'), { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Token-2022/)).toBeNull();
    expect(jup.createRecurringOrder).toHaveBeenCalledWith(expect.objectContaining({ inputMint: SOL_MINT, outputMint: USDC_MINT }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('DCA started', expect.anything()));
    expect(connection.sendRawTransaction.mock.calls[0]![0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('Cancel on an order already running still works with BAYLA on the form', async () => {
    jup.getRecurringOrders.mockResolvedValue([{ orderKey: ORDER, inputMint: SOL_MINT, outputMint: BAYLA_MINT }]);
    await openDca(`?out=${BAYLA_MINT}`);
    expect(await screen.findByText(REFUSED)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    expect(jup.cancelRecurringOrder).toHaveBeenCalledWith(OWNER.toBase58(), ORDER);
    await waitFor(() => expect(toast.success.mock.calls.some((c) => /DCA cancelled/.test(String(c[0])))).toBe(true));
  });
});

// One wallet behaviour, one wording (owner, 2026-10-13): the DCA and limit tabs have the
// wallet SIGN only (Phantom, ticket #467471) and read its throw as every Solana write does.
// A throw from signing alone means nothing left the page, whatever it says. The one ending
// that cannot tell is our own send whose confirmation never came.
describe('DCA and limit orders: the wallet’s throw is said for what it is', () => {
  const trustDecline = () => new WalletSignTransactionError('4001', Object.assign(new Error('4001'), { code: 4001 }));

  it('Trust’s code-only decline on Start is a cancel, not "Could not start the DCA"', async () => {
    wallet.signTransaction.mockRejectedValue(trustDecline());
    await placeDca();
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Not sent', { description: DECLINED_IN_WALLET }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect((total('SOL') as HTMLInputElement).value).toBe('5');
  });

  it('any other throw while signing is "Not sent" in the wallet’s words, never "we cannot tell"', async () => {
    wallet.signTransaction.mockRejectedValue(new WalletSignTransactionError('Unexpected error', new Error('Unexpected error')));
    await placeDca();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: notSignedCopy('Unexpected error') }));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalledWith('Could not start the DCA', expect.anything());
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect((total('SOL') as HTMLInputElement).value).toBe('5');
  });

  it.each(PLACES)('$name: our send whose confirmation never came may have placed it: "we can\'t tell", with its signature, and the form is cleared', async (t) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    connection.getSignatureStatuses.mockResolvedValue(notYet);
    await t.place();
    await waitFor(() => expect(connection.sendRawTransaction).toHaveBeenCalled());
    // Past the 60 s the page watches our send for.
    await act(async () => { await vi.advanceTimersByTimeAsync(70_000); });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
      description: expect.stringContaining(t.repeatCost),
    })));
    const [, said] = toast.warning.mock.calls[0]! as [string, { description: string }];
    expect(said.description).toContain(SIG.slice(0, 10));
    // Never "failed", never "placed", never "not sent": it may be out there. No em dash either.
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    for (const fn of Object.values(toast)) for (const c of fn.mock.calls) expect(JSON.stringify(c)).not.toMatch(/failed|\u2014/i);
    // It may be open: one more click must not place another.
    expect(t.amount().value).toBe('');
  });

  it('a page no longer connected to the wallet: its reason, and nothing was sent', async () => {
    wallet.signTransaction.mockRejectedValue(new WalletNotConnectedError());
    jup.getRecurringOrders.mockResolvedValue([{ orderKey: ORDER, inputMint: SOL_MINT, outputMint: USDC_MINT }]);
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: notSignedCopy('this page is no longer connected to it, so it was never asked') }));
    expect(toast.error).not.toHaveBeenCalledWith('Could not cancel', expect.anything());
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a wallet that cannot sign for this page to send is not asked: "Not sent", and why', async () => {
    wallet.canSign = false;
    await placeDca();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: 'This wallet cannot sign a transaction for this page to send, so nothing was sent.' }));
    expect(toast.error).not.toHaveBeenCalledWith('Could not start the DCA', expect.anything());
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect((total('SOL') as HTMLInputElement).value).toBe('5');
  });

  it('a signed order our RPC’s own check refuses at the first send is "Not sent", in the network’s words', async () => {
    const message = 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1';
    connection.sendRawTransaction.mockRejectedValue(Object.assign(new Error(`failed to send transaction: ${message}`), { transactionMessage: message, transactionLogs: ['Program log: order refused'] }));
    await placeLimit();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: 'The network refused it before sending it (Program log: order refused). Nothing was sent.' }));
    expect(toast.error).not.toHaveBeenCalledWith('Could not place order', expect.anything());
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // Nothing reached the chain: nothing is watched, and the form stands.
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Amount of SOL to sell') as HTMLInputElement).value).toBe('1');
  });
});

// Phantom, ticket #467471: one transaction per approval, asked with signTransaction and sent
// by us through our RPC with preflight on, never by the wallet; the SOL checked and a final
// test run passed BEFORE the wallet is asked; a run that fails, or cannot complete, stops it there.
describe('DCA and limit orders: tested before the wallet, signed by it, sent by this page', () => {
  it.each(PLACES)('$name: the test run comes before the wallet, which only signs; this page sends the bytes it signed', async (t) => {
    await t.place();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.placed, expect.objectContaining({ description: `${SIG.slice(0, 6)}…${SIG.slice(-6)}` })));
    // The final test run: Jupiter's bytes as built, signature checks off, its blockhash left alone, the wallet's SOL read after it.
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
    const [wire, options] = connection.simulateTransaction.mock.calls[0]! as [{ serialize(): Uint8Array }, unknown];
    expect(wire.serialize()).toEqual(new Uint8Array([1, 2, 3]));
    expect(options).toEqual({ sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [OWNER.toBase58()] } });
    // The wallet signs that very transaction, once, after the test run.
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction.mock.calls[0]![0]).toBe(built.tx);
    expect(connection.simulateTransaction.mock.invocationCallOrder[0]!).toBeLessThan(wallet.signTransaction.mock.invocationCallOrder[0]!);
    // This page sends what it signed, the network's own check first; the wallet never sends.
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction.mock.calls[0]).toEqual([new Uint8Array([1, 2, 3]), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }]);
    expect(wallet.signTransaction.mock.invocationCallOrder[0]!).toBeLessThan(connection.sendRawTransaction.mock.invocationCallOrder[0]!);
    expect(t.amount().value).toBe('');
  });

  it.each(PLACES)('$name: a final test run that fails: the wallet is never asked, and "Not sent" says why', async (t) => {
    connection.simulateTransaction.mockResolvedValue(testRun({ err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: custom program error: 0x1'] }));
    await t.place();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: 'It did not pass its test run (Program log: custom program error: 0x1), so your wallet was not asked. Nothing was sent.' }));
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(t.amount().value).toBe(t.typed);
  });

  it.each(PLACES)('$name: a final test run that cannot finish stops it there too: the wallet is never asked', async (t) => {
    connection.simulateTransaction.mockRejectedValue(new Error('fetch failed: 503'));
    await t.place();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: WRITE_COPY.noAnswer }));
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(t.amount().value).toBe(t.typed);
  });

  it('a node behind its own blockhash is no verdict either: a cancel is not put to the wallet', async () => {
    jup.getTriggerOrders.mockResolvedValue([{ orderKey: ORDER, inputMint: SOL_MINT, outputMint: USDC_MINT }]);
    connection.simulateTransaction.mockResolvedValue(testRun({ err: 'BlockhashNotFound' }));
    window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
    render(<SolanaSwapPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Limit order' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: WRITE_COPY.noAnswer }));
    expect(toast.error).not.toHaveBeenCalledWith('Could not cancel', expect.anything());
    expect(jup.cancelTriggerOrder).toHaveBeenCalledWith(OWNER.toBase58(), ORDER);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a DCA cancel whose test run fails is not put to the wallet either', async () => {
    jup.getRecurringOrders.mockResolvedValue([{ orderKey: ORDER, inputMint: SOL_MINT, outputMint: USDC_MINT }]);
    connection.simulateTransaction.mockResolvedValue(testRun({ err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: custom program error: 0x1'] }));
    await openDca(`?out=${USDC_MINT}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: 'It did not pass its test run (Program log: custom program error: 0x1), so your wallet was not asked. Nothing was sent.' }));
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each(PLACES)('$name: not enough SOL for the fee and the rent: the wallet is never asked, and the figures are said', async (t) => {
    // The run leaves the wallet 0.0005 SOL: with the fee, room for the wallet's own fee, and
    // the wallet left rent-exempt, its 10 SOL is short.
    connection.simulateTransaction.mockResolvedValue(testRun({ lamportsAfter: 500_000 }));
    await t.place();
    const need = 10_000_000_000n - 500_000n + 5_000n + WALLET_FEE_ROOM_LAMPORTS + RENT_EXEMPT_EMPTY_LAMPORTS;
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', { description: solShortCopy(need, 10_000_000_000n) }));
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(t.amount().value).toBe(t.typed);
  });
});

// A wallet's order list that could not be read is said as that, with a way to read it
// again. It never reads "No open orders" (a failed read once did).
describe('Open orders and active DCAs: a list that could not be read says so', () => {
  const LIMIT = { tab: 'Limit order', read: jup.getTriggerOrders, none: 'No open orders.', unread: 'Your open orders could not be read just now.' };
  const DCA = { tab: 'DCA', read: jup.getRecurringOrders, none: 'No active DCAs.', unread: 'Your DCAs could not be read just now.' };
  async function openTab(tab: string) {
    window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
    render(<SolanaSwapPage />);
    fireEvent.click(await screen.findByRole('button', { name: tab }));
  }

  it.each([['limit', LIMIT], ['DCA', DCA]])('%s: a failed read is said, never an empty list; Try again reads it again', async (_n, t) => {
    t.read.mockRejectedValueOnce(new Error('Could not load orders (503)'));
    t.read.mockResolvedValue([{ orderKey: ORDER, inputMint: SOL_MINT, outputMint: USDC_MINT }]);
    await openTab(t.tab);
    expect(await screen.findByText(t.unread)).toBeInTheDocument();
    expect(screen.queryByText(t.none)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByText(t.unread)).toBeNull();
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it.each([['limit', LIMIT], ['DCA', DCA]])('%s: a read that answered with no orders still says there are none', async (_n, t) => {
    await openTab(t.tab);
    expect(await screen.findByText(t.none)).toBeInTheDocument();
    expect(screen.queryByText(t.unread)).toBeNull();
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
