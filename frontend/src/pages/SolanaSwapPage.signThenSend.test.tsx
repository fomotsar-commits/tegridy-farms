// The swap's Buy with a wallet that can sign alone (2026-11-15): the wallet signs, this page
// sends (lib/solana/swap/walletSwapSend.ts).
//
// The owner's screens of 11-15: a sell that "won't go through" showed "A swap may have been
// sent ... your wallet did not hand one back" with Buy held, press after press, and two buys
// the network never saw showed "We couldn't confirm this transaction" with Buy held ten
// minutes. The wallet signed AND sent then: a send of its that threw was "may have been
// sent", whatever it was, and a send that never reached a block was sent by no one again.
//
// Pinned here, each failing on the pre-fix page (which asked wallet.sendTransaction): the
// wallet is asked to sign only and the page sends the bytes it signed; a refusal at that
// first send is "Not sent" in the network's words (Phantom's own guard named), with no
// hold and the amount kept; a swap that lands ends on its receipt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';

const { toast, connection, wallet, jup, state } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  connection: {
    getBalance: vi.fn(),
    getParsedTokenAccountsByOwner: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getMultipleAccountsInfo: vi.fn(),
    getLatestBlockhashAndContext: vi.fn(),
    getBlockHeight: vi.fn(),
    isBlockhashValid: vi.fn(),
    sendRawTransaction: vi.fn(),
  },
  wallet: { sendTransaction: vi.fn(), signTransaction: vi.fn() },
  jup: { getQuote: vi.fn(), buildSwapTransaction: vi.fn(), simulateSwap: vi.fn() },
  // The transaction the page holds: web3.js cannot serialize or sign under jsdom, so the page's
  // deserialize hands back this stand-in, the one object the wallet signs and the page reads back.
  state: { tx: null as unknown as FakeTx },
}));

interface FakeTx {
  version: 0;
  message: { recentBlockhash: string; staticAccountKeys: PublicKey[]; compiledInstructions: { programIdIndex: number }[] };
  signatures: Uint8Array[];
  serialize(): Uint8Array;
}

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
  VersionedTransaction: { deserialize: () => state.tx },
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
import { clearReceipt, lastReceipt } from '../lib/receipt';
import { LIGHTHOUSE_PROGRAM } from '../lib/solana/swap/walletSwapSend';

vi.setConfig({ testTimeout: 30_000 });

const OWNER = new PublicKey('8nV9ksXZ1i2V1Hb9mJHDj8wAYNGfZPLpd2WT6Lt6bfHs');
const SIGNED = new Uint8Array(64).fill(5);
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FRESH_HASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

const quote = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  inAmount: '500000000',
  outAmount: '75000000',
  otherAmountThreshold: '74625000',
  slippageBps: 50,
  priceImpactPct: '0',
  routePlan: [],
};

/** Jupiter's swap: this wallet pays; instruction 1 is Phantom's guard, as Phantom adds it. */
function jupiterTx(): FakeTx {
  return {
    version: 0,
    message: {
      recentBlockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
      staticAccountKeys: [OWNER, new PublicKey('ComputeBudget111111111111111111111111111111'), new PublicKey(LIGHTHOUSE_PROGRAM)],
      compiledInstructions: [{ programIdIndex: 1 }, { programIdIndex: 2 }],
    },
    signatures: [new Uint8Array(64)],
    serialize: () => new Uint8Array([1, 2, 3]),
  };
}

const confirmed = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] };

beforeEach(() => {
  clearReceipt();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  window.history.replaceState(null, '', `/solana?amt=0.5&out=${USDC_MINT}`);
  Object.values(toast).forEach((fn) => fn.mockReset());
  connection.getBalance.mockReset().mockResolvedValue(10_000_000_000);
  connection.getParsedTokenAccountsByOwner.mockReset().mockResolvedValue({ value: [] });
  connection.getSignatureStatuses.mockReset().mockResolvedValue(confirmed);
  connection.getMultipleAccountsInfo.mockReset().mockImplementation(async (k: PublicKey[]) => k.map(() => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })));
  connection.getLatestBlockhashAndContext.mockReset().mockResolvedValue({ context: { slot: 500 }, value: { blockhash: FRESH_HASH, lastValidBlockHeight: 1_150 } });
  connection.getBlockHeight.mockReset().mockResolvedValue(1_000);
  connection.isBlockhashValid.mockReset().mockResolvedValue({ context: { slot: 600 }, value: true });
  connection.sendRawTransaction.mockReset().mockResolvedValue('sent');
  wallet.sendTransaction.mockReset().mockRejectedValue(new Error('the wallet must not send: this page does'));
  state.tx = jupiterTx();
  wallet.signTransaction.mockReset().mockImplementation(async (tx: FakeTx) => {
    tx.signatures[0] = SIGNED;
    return tx;
  });
  jup.getQuote.mockReset().mockResolvedValue(quote);
  jup.buildSwapTransaction.mockReset().mockResolvedValue('AAAA');
  jup.simulateSwap.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

async function press() {
  render(<SolanaSwapPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Buy USDC' }, { timeout: 5_000 }));
  await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
}

describe('a wallet that can sign alone: it signs, this page sends', () => {
  it('sends the bytes the wallet signed, on a fresh blockhash, and a swap that lands ends on its receipt', async () => {
    await press();
    await waitFor(() => expect(lastReceipt()).toMatchObject({ action: 'bought', coin: { symbol: 'USDC' } }));
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    // Signed on the fresh blockhash put on before the wallet, not Jupiter's.
    expect((wallet.signTransaction.mock.calls[0]![0] as FakeTx).message.recentBlockhash).toBe(FRESH_HASH);
    // The page sent the signed bytes itself, through the network's own check first.
    expect(connection.sendRawTransaction.mock.calls[0]![0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(connection.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false });
  });

  it('refused at the first send by the wallet’s own guard: "Not sent" with why, no hold, the amount kept', async () => {
    const msg = 'Transaction simulation failed: Error processing Instruction 1: Computational budget exceeded';
    connection.sendRawTransaction.mockRejectedValue(Object.assign(new Error(`Simulation failed. \nMessage: ${msg}.`), { transactionMessage: msg, transactionLogs: [] }));
    await press();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', expect.objectContaining({
      description: expect.stringMatching(/wallet’s own safety check stopped it.*Nothing was sent/),
    })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    // Not "may have been sent", not "couldn't confirm", and Buy is not held for this wallet.
    expect(toast.warning).not.toHaveBeenCalled();
    expect(screen.queryByText(/A swap may have been sent|A swap you sent is not confirmed yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Buy USDC' })).not.toBeDisabled();
    expect((screen.getByLabelText('Amount of SOL to pay') as HTMLInputElement).value).toBe('0.5');
    expect(lastReceipt()).toBeNull();
  });

  it('the wallet throwing while it signs is "Not sent", never "may have been sent"', async () => {
    wallet.signTransaction.mockRejectedValue(new Error('Unexpected error'));
    await press();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not sent', expect.objectContaining({
      description: expect.stringMatching(/Unexpected error.*Nothing was sent/),
    })));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(screen.queryByText(/A swap may have been sent/)).toBeNull();
  });
});
