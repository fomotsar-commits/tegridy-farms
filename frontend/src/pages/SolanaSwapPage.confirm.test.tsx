// What the Solana swap page says after a transaction is SENT.
//
// The page confirms by polling getSignatureStatuses (no websocket: /api/solrpc is
// HTTPS only). Its own poller threw on a timeout and let one RPC error escape, and every
// caller turned both into "Swap failed" / "Could not start the DCA" / "Could not place
// order" / "Could not cancel". Neither is a failure: the transaction is out there and
// may land, and someone told "failed" presses the button again and pays twice. A revert
// the network reported is the only failure, and it still says so.
//
// The page now uses the poller lib/ladder/write.ts already had right (moved to
// lib/solana/confirm.ts): an RPC error is one missed look, and a watch that runs out says
// "we can't tell, check before you send it again" with the signature.
//
// Each test that names a pre-fix failure fails on the pre-fix page.
//
// Since 2026-11-17 (Phantom, ticket #467471) the wallet here only SIGNS, as Phantom does: the
// page test-runs each transaction before the wallet is asked, then sends the signed bytes
// itself through our RPC with preflight on, and watches them (lib/solana/walletWrite.ts for
// the DCA and limit tabs, lib/solana/swap/walletSwapSend.ts for the swap). The wallet's own
// sendTransaction is never called.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import { base58 } from '@scure/base';

const { toast, connection, wallet, jup, built } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  connection: {
    getBalance: vi.fn(),
    getParsedTokenAccountsByOwner: vi.fn(),
    getSignatureStatuses: vi.fn(),
    // The DCA tab reads which token program owns each mint before it builds anything.
    getMultipleAccountsInfo: vi.fn(),
    // The final test run before the wallet, a fresh blockhash for the swap, and our own send.
    simulateTransaction: vi.fn(),
    getLatestBlockhashAndContext: vi.fn(),
    sendRawTransaction: vi.fn(),
  },
  wallet: { sendTransaction: vi.fn(), signTransaction: vi.fn() },
  // The transaction the page holds: web3.js cannot serialize or sign under jsdom, so the page's
  // deserialize hands back this stand-in, the one object the wallet signs and the page reads back.
  built: { tx: null as unknown as FakeTx },
  jup: {
    getQuote: vi.fn(),
    buildSwapTransaction: vi.fn(),
    simulateSwap: vi.fn(),
    createTriggerOrder: vi.fn(),
    getTriggerOrders: vi.fn(),
    cancelTriggerOrder: vi.fn(),
    createRecurringOrder: vi.fn(),
    getRecurringOrders: vi.fn(),
    cancelRecurringOrder: vi.fn(),
  },
}));

interface FakeTx {
  version: 0;
  message: { recentBlockhash: string; staticAccountKeys: PublicKey[]; compiledInstructions: { programIdIndex: number }[]; header: { numRequiredSignatures: number } };
  signatures: Uint8Array[];
  serialize(): Uint8Array;
}

const OWNER = new PublicKey('11111111111111111111111111111111');
/** The wallet's signature: what the page reads back off the signed transaction. */
const SIGNED = new Uint8Array(64).fill(5);
const SIG = base58.encode(SIGNED);
const FRESH_HASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', () => ({
  m: { div: ({ children, initial: _i, animate: _a, transition: _t, ...p }: { children?: ReactNode } & Record<string, unknown>) => <div {...p}>{children}</div> },
}));
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => ({ publicKey: OWNER, sendTransaction: wallet.sendTransaction, signTransaction: wallet.signTransaction }),
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

import SolanaSwapPage from './SolanaSwapPage';
import { reloadHeld } from '../lib/reloadHold';
import { clearReceipt, lastReceipt } from '../lib/receipt';

// The first test here pays for the page's first render: 1.3 s alone, 2.1 s to 3.9 s in six
// full runs, and 5.2 s in a seventh on a busy machine. The 5 s default timed it out there,
// and its timers, still running, then broke the test after it. The limit says "the first
// render is slow under load"; it does not loosen what any test asserts.
vi.setConfig({ testTimeout: 30_000 });

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const quote = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  inAmount: '500000000',
  outAmount: '75000000',
  otherAmountThreshold: '74625000',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0',
  routePlan: [],
};

const confirmed = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] };
const notYet = { context: { slot: 9 }, value: [null] };
const reverted = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
const rpcDown = () => Promise.reject(new Error('fetch failed: 503'));

const toastTitles = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((c) => String(c[0]));

/** A transaction this wallet pays, unsigned: Jupiter's swap, or its DCA or limit order. */
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
/** The final test run passes; the wallet keeps plenty of SOL after it. */
const testRunPasses = { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ lamports: 9_000_000_000, data: ['', 'base64'] }] } };

beforeEach(() => {
  clearReceipt();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  // The page opens SOL to $BAYLA; these tests are about a SOL to USDC swap, so the link names it.
  window.history.replaceState(null, '', `/solana?amt=0.5&out=${USDC_MINT}`);
  Object.values(toast).forEach((fn) => fn.mockReset());
  connection.getBalance.mockReset().mockResolvedValue(10_000_000_000);
  connection.getParsedTokenAccountsByOwner.mockReset().mockResolvedValue({ value: [] });
  connection.getSignatureStatuses.mockReset();
  // SOL and USDC are both plain SPL tokens.
  connection.getMultipleAccountsInfo.mockReset().mockImplementation(async (keys: PublicKey[]) => keys.map(() => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })));
  connection.simulateTransaction.mockReset().mockResolvedValue(testRunPasses);
  connection.getLatestBlockhashAndContext.mockReset().mockResolvedValue({ context: { slot: 500 }, value: { blockhash: FRESH_HASH, lastValidBlockHeight: 1_150 } });
  connection.sendRawTransaction.mockReset().mockResolvedValue('sent');
  built.tx = jupiterTx();
  wallet.sendTransaction.mockReset().mockRejectedValue(new Error('the wallet must not send: this page does'));
  wallet.signTransaction.mockReset().mockImplementation(async (tx: FakeTx) => {
    tx.signatures[0] = SIGNED;
    return tx;
  });
  jup.getQuote.mockReset().mockResolvedValue(quote);
  jup.buildSwapTransaction.mockReset().mockResolvedValue('AAAA');
  jup.simulateSwap.mockReset().mockResolvedValue({ ok: true });
  jup.createTriggerOrder.mockReset().mockResolvedValue('AAAA');
  jup.getTriggerOrders.mockReset().mockResolvedValue([]);
  jup.cancelTriggerOrder.mockReset().mockResolvedValue('AAAA');
  jup.createRecurringOrder.mockReset().mockResolvedValue('AAAA');
  jup.getRecurringOrders.mockReset().mockResolvedValue([]);
  jup.cancelRecurringOrder.mockReset().mockResolvedValue('AAAA');
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  // Whatever the ending, the wallet only ever signed: the page sends.
  expect(wallet.sendTransaction).not.toHaveBeenCalled();
});

/** Long enough for any watch on the page to give up. */
const outlastTheWatch = () => act(async () => { await vi.advanceTimersByTimeAsync(130_000); });

async function swap() {
  render(<SolanaSwapPage />);
  const button = await screen.findByRole('button', { name: 'Buy USDC' }, { timeout: 5_000 });
  fireEvent.click(button);
  await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
}

/** The signed bytes went out through our own RPC, the network's own check first. */
function sentByThePage() {
  expect(connection.sendRawTransaction).toHaveBeenCalled();
  expect(connection.sendRawTransaction.mock.calls[0]![0]).toEqual(new Uint8Array([1, 2, 3]));
  expect(connection.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false });
}

describe('Instant swap: after the swap is sent', () => {
  it('a status read that errors once is not "Swap failed": it looks again, and the swap confirms', async () => {
    connection.getSignatureStatuses.mockImplementationOnce(rpcDown).mockResolvedValue(confirmed);
    await swap();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(lastReceipt()).toMatchObject({ action: 'bought', coin: { symbol: 'USDC' } }));
    expect(toastTitles(toast.error)).not.toContain('Swap failed');
  });

  it('not confirmed while the page watched: "we can\'t tell", with the signature, never "Swap failed"', async () => {
    connection.getSignatureStatuses.mockResolvedValue(notYet);
    await swap();
    await outlastTheWatch();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
      description: expect.stringContaining(SIG.slice(0, 10)),
    })));
    expect(toastTitles(toast.error)).not.toContain('Swap failed');
    expect(lastReceipt()).toBeNull();
    sentByThePage();
  });

  it('not confirmed: the amount is cleared, so one more click does not send the same swap again', async () => {
    connection.getSignatureStatuses.mockResolvedValue(notYet);
    await swap();
    await outlastTheWatch();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect((screen.getByLabelText('Amount of SOL to pay') as HTMLInputElement).value).toBe('');
  });

  // The words are #703's ("Swap refused on chain", with the signature and a link), which
  // reached trunk first. What this pins is unchanged: a revert the network reported is
  // an ERROR, never softened into the "we can't tell" warning, and never "Bought".
  it('a revert the network reported is still an error: "Swap refused on chain", never the warning', async () => {
    connection.getSignatureStatuses.mockResolvedValue(reverted);
    await swap();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Swap refused on chain', expect.objectContaining({
      description: expect.stringContaining('Only the network fee was spent'),
    })));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(lastReceipt()).toBeNull();
  });

  it('a failure seen only at "processed" is not a revert: the watch goes on, and the swap confirms', async () => {
    const failedAtProcessed = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 0, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }] };
    connection.getSignatureStatuses.mockResolvedValueOnce(failedAtProcessed).mockResolvedValue(confirmed);
    await swap();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(lastReceipt()).toMatchObject({ action: 'bought', coin: { symbol: 'USDC' } }));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('the swap is watched for 90 seconds, not 60, before the page says it cannot tell', async () => {
    connection.getSignatureStatuses.mockResolvedValue(notYet);
    await swap();
    // 65 s: past a 60 s watch, and 25 s short of the real one, because the fake clock
    // also moves with real time here (shouldAdvanceTime) and a loaded machine is slow.
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
    expect(toast.warning).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.anything()));
  });
});

describe('DCA and limit orders: after the transaction is sent', () => {
  async function openTab(name: 'DCA' | 'Limit order') {
    render(<SolanaSwapPage />);
    fireEvent.click(await screen.findByRole('button', { name }));
  }

  it('DCA: not confirmed while watching is "we can\'t tell", not "Could not start the DCA"', async () => {
    connection.getSignatureStatuses.mockResolvedValue(notYet);
    await openTab('DCA');
    fireEvent.change(screen.getByLabelText('Total SOL to invest'), { target: { value: '1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    await outlastTheWatch();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
      description: expect.stringContaining(SIG.slice(0, 10)),
    })));
    expect(toastTitles(toast.error)).not.toContain('Could not start the DCA');
    sentByThePage();
    // It may be running: the form is cleared, so one more click does not start another.
    expect((screen.getByLabelText('Total SOL to invest') as HTMLInputElement).value).toBe('');
  });

  it('DCA cancel: a status read that errors once is not "Could not cancel"', async () => {
    jup.getRecurringOrders.mockResolvedValue([{ orderKey: 'DcaOrderKey1111111111111111111111111111111' }]);
    connection.getSignatureStatuses.mockImplementationOnce(rpcDown).mockResolvedValue(confirmed);
    await openTab('DCA');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(toastTitles(toast.success).some((t) => /DCA cancelled/.test(t))).toBe(true));
    expect(toastTitles(toast.error)).not.toContain('Could not cancel');
  });

  it('Limit order: not confirmed while watching is "we can\'t tell", not "Could not place order"', async () => {
    connection.getSignatureStatuses.mockResolvedValue(notYet);
    await openTab('Limit order');
    fireEvent.change(screen.getByLabelText('Amount of SOL to sell'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Target price in USDC'), { target: { value: '200' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Place limit order' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    await outlastTheWatch();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
      description: expect.stringContaining(SIG.slice(0, 10)),
    })));
    expect(toastTitles(toast.error)).not.toContain('Could not place order');
    sentByThePage();
    // It may be open: the form is cleared, so one more click does not place another.
    expect((screen.getByLabelText('Amount of SOL to sell') as HTMLInputElement).value).toBe('');
  });

  it('Limit order cancel: a status read that errors once is not "Could not cancel"', async () => {
    jup.getTriggerOrders.mockResolvedValue([{ orderKey: 'LimitOrderKey11111111111111111111111111111' }]);
    connection.getSignatureStatuses.mockImplementationOnce(rpcDown).mockResolvedValue(confirmed);
    await openTab('Limit order');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(toastTitles(toast.success)).toContain('Order cancelled'));
    expect(toastTitles(toast.error)).not.toContain('Could not cancel');
  });
});

// The page reloads itself after a deploy (lib/staleBuild.ts), and never under a
// transaction. These three panels have the wallet sign, then send it themselves, so each
// holds the page from the wallet's turn until the transaction is answered.
describe('no reload by itself while a transaction is at the wallet or on its way', () => {
  /** A wallet prompt left open: resolves when the test signs. */
  function walletPromptOpen() {
    let sign: () => void = () => undefined;
    let decline: (e: Error) => void = () => undefined;
    wallet.signTransaction.mockImplementation((tx: FakeTx) => new Promise<FakeTx>((res, rej) => {
      sign = () => { tx.signatures[0] = SIGNED; res(tx); };
      decline = rej;
    }));
    return { sign: () => act(async () => { sign(); }), decline: () => act(async () => { decline(new Error('User rejected the request.')); }) };
  }

  it('Instant swap: held at the wallet, held while sent, free once it confirms', async () => {
    const prompt = walletPromptOpen();
    connection.getSignatureStatuses.mockResolvedValueOnce(notYet).mockResolvedValue(confirmed);
    expect(reloadHeld()).toBe(false);
    await swap();
    expect(reloadHeld()).toBe(true);
    await prompt.sign();
    expect(reloadHeld()).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(lastReceipt()).toMatchObject({ action: 'bought', coin: { symbol: 'USDC' } }));
    expect(reloadHeld()).toBe(false);
  });

  it('Instant swap: declined in the wallet, the page is free again', async () => {
    const prompt = walletPromptOpen();
    await swap();
    expect(reloadHeld()).toBe(true);
    await prompt.decline();
    await waitFor(() => expect(reloadHeld()).toBe(false));
  });

  it('DCA: held from the wallet until the order is answered', async () => {
    const prompt = walletPromptOpen();
    connection.getSignatureStatuses.mockResolvedValue(confirmed);
    render(<SolanaSwapPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'DCA' }));
    fireEvent.change(screen.getByLabelText('Total SOL to invest'), { target: { value: '1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start the DCA' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    expect(reloadHeld()).toBe(true);
    await prompt.sign();
    await waitFor(() => expect(toastTitles(toast.success)).toContain('DCA started'));
    expect(reloadHeld()).toBe(false);
  });

  it('Limit order cancel: held from the wallet until the cancel is answered', async () => {
    const prompt = walletPromptOpen();
    jup.getTriggerOrders.mockResolvedValue([{ orderKey: 'LimitOrderKey11111111111111111111111111111' }]);
    connection.getSignatureStatuses.mockResolvedValue(confirmed);
    render(<SolanaSwapPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Limit order' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    expect(reloadHeld()).toBe(true);
    await prompt.sign();
    await waitFor(() => expect(toastTitles(toast.success)).toContain('Order cancelled'));
    expect(reloadHeld()).toBe(false);
  });
});
