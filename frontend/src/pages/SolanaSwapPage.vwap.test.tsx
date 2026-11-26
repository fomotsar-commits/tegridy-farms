// The swap form's VWAP tab (owner, 2026-11-19): an order split into slices over a chosen
// time, each sent only while its price is within the person's limit of the pair's 24h
// average. Pinned on the whole page: Start asks the wallet for the first slice at once, the
// wallet only signs and the page sends, and the slice fills from what the chain says the
// wallet received; Stop while the wallet is open sends nothing; a price past the limit never
// reaches the wallet; a second tab of the site shows the order and sends nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';

const { toast, connection, wallet, jup, state, avg } = vi.hoisted(() => ({
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
    simulateTransaction: vi.fn(),
    getTransaction: vi.fn(),
  },
  wallet: { sendTransaction: vi.fn(), signTransaction: vi.fn() },
  jup: { getQuote: vi.fn(), buildSwapTransaction: vi.fn(), simulateSwap: vi.fn() },
  state: { tx: null as unknown as FakeTx, lockFree: true },
  avg: { fetchPairAverage: vi.fn(), fetchPairVolumeProfile: vi.fn() },
}));

interface FakeTx {
  version: 0;
  message: { recentBlockhash: string; staticAccountKeys: PublicKey[]; compiledInstructions: { programIdIndex: number }[]; header: { numRequiredSignatures: number } };
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
vi.mock('../lib/solana/swap/pairAverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/solana/swap/pairAverage')>()),
  ...avg,
}));

import SolanaSwapPage from './SolanaSwapPage';
import { clearReceipt } from '../lib/receipt';
import { orderStorageKey, type VwapOrder } from '../lib/solana/swap/vwapOrder';
import { WITHDRAWN_COPY } from '../lib/solana/swap/vwapRun';

vi.setConfig({ testTimeout: 30_000 });

const OWNER = new PublicKey('8nV9ksXZ1i2V1Hb9mJHDj8wAYNGfZPLpd2WT6Lt6bfHs');
const SIGNED = new Uint8Array(64).fill(5);
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FRESH_HASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
/** 1 SOL traded for 150 USDC on average over the last 24 hours. */
const AVERAGE = { kind: 'ok', baseMint: SOL_MINT, quoteMint: USDC_MINT, price: 150 };

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

/** Jupiter's price for `amount` lamports at `perSol` USDC a SOL. */
const quoteAt = (perSol: number) => async (p: { amount: string }) => ({
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  inAmount: p.amount,
  outAmount: ((BigInt(p.amount) * BigInt(perSol)) / 1_000n).toString(),
  // The least the swap can pay out: here the quote itself (no slippage), so the limit is tested at one figure.
  otherAmountThreshold: ((BigInt(p.amount) * BigInt(perSol)) / 1_000n).toString(),
  slippageBps: 100,
  priceImpactPct: '0',
  routePlan: [],
});

const confirmed = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] };

beforeEach(() => {
  clearReceipt();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
  Object.values(toast).forEach((fn) => fn.mockReset());
  connection.getBalance.mockReset().mockResolvedValue(10_000_000_000);
  connection.getParsedTokenAccountsByOwner.mockReset().mockResolvedValue({ value: [] });
  connection.getSignatureStatuses.mockReset().mockResolvedValue(confirmed);
  connection.getMultipleAccountsInfo.mockReset().mockImplementation(async (k: PublicKey[]) => k.map(() => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })));
  connection.getLatestBlockhashAndContext.mockReset().mockResolvedValue({ context: { slot: 500 }, value: { blockhash: FRESH_HASH, lastValidBlockHeight: 1_150 } });
  connection.getBlockHeight.mockReset().mockResolvedValue(1_000);
  connection.isBlockhashValid.mockReset().mockResolvedValue({ context: { slot: 600 }, value: true });
  connection.sendRawTransaction.mockReset().mockResolvedValue('sent');
  connection.simulateTransaction.mockReset().mockResolvedValue({ context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ lamports: 9_000_000_000, data: ['', 'base64'] }] } });
  // What the chain says the slice did: the wallet's USDC account gained 37.4 USDC.
  connection.getTransaction.mockReset().mockResolvedValue({
    meta: {
      err: null, fee: 5_000, logMessages: [], preBalances: [10_000_000_000], postBalances: [9_749_995_000],
      preTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: OWNER.toBase58(), uiTokenAmount: { amount: '0', decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: OWNER.toBase58(), uiTokenAmount: { amount: '37400000', decimals: 6 } }],
    },
    transaction: { message: { staticAccountKeys: [OWNER] } },
  });
  wallet.sendTransaction.mockReset().mockRejectedValue(new Error('the wallet must not send: this page does'));
  state.tx = jupiterTx();
  state.lockFree = true;
  wallet.signTransaction.mockReset().mockImplementation(async (tx: FakeTx) => {
    tx.signatures[0] = SIGNED;
    return tx;
  });
  jup.getQuote.mockReset().mockImplementation(quoteAt(150));
  jup.buildSwapTransaction.mockReset().mockResolvedValue('AAAA');
  jup.simulateSwap.mockReset().mockResolvedValue({ ok: true });
  avg.fetchPairAverage.mockReset().mockResolvedValue(AVERAGE);
  avg.fetchPairVolumeProfile.mockReset().mockResolvedValue(null);
  // The browser's lock for the order: free, or held by another tab of the site.
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: { request: vi.fn(async (_n: string, _o: unknown, cb: (lock: unknown) => unknown) => cb(state.lockFree ? { name: 'vwap', mode: 'exclusive' } : null)) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  expect(wallet.sendTransaction).not.toHaveBeenCalled();
});

const stored = (): VwapOrder | null => {
  const raw = localStorage.getItem(orderStorageKey(OWNER.toBase58()));
  return raw ? (JSON.parse(raw) as VwapOrder) : null;
};

async function startOrder(total = '2') {
  render(<SolanaSwapPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'VWAP' }, { timeout: 5_000 }));
  fireEvent.change(screen.getByLabelText('Total SOL to spend'), { target: { value: total } });
  const start = screen.getByRole('button', { name: 'Start the VWAP order' });
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);
}

describe('the VWAP tab', () => {
  it('Start: the wallet signs the first slice at once, the page sends it, and it fills from the chain', async () => {
    await startOrder();
    await waitFor(() => expect(stored()?.slices[0]?.state).toBe('filled'));
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalled();
    const o = stored()!;
    // 2 SOL over 4 hours in 8 even slices: 0.25 SOL now, the next one in 30 minutes.
    expect(o.slices).toHaveLength(8);
    expect(o.slices[0]).toMatchObject({ paid: '250000000', got: '37400000', gotExact: true });
    expect(o.slices[1]!.state).toBe('waiting');
    expect(await screen.findByTestId('vwap-spent')).toHaveTextContent('0.25 of 2 SOL · 1 of 8 slices');
    expect(toast.success).toHaveBeenCalledWith('VWAP order started', expect.anything());
  });

  it('Stop while the wallet is open: what it signs is not sent', async () => {
    let approve: () => void = () => {};
    wallet.signTransaction.mockImplementation(
      (tx: FakeTx) => new Promise((resolve) => { approve = () => { tx.signatures[0] = SIGNED; resolve(tx); }; }),
    );
    await startOrder();
    await waitFor(() => expect(wallet.signTransaction).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop the order' }));
    await act(async () => approve());
    await waitFor(() => expect(stored()?.slices[0]?.why).toBe(WITHDRAWN_COPY));
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(stored()!.stoppedAt).toBeDefined();
    expect(await screen.findByTestId('vwap-ending')).toHaveTextContent('Stopped. Nothing more is sent.');
  });

  it('a price past the limit never reaches the wallet, and the tab says why', async () => {
    // 0.25 SOL for 30 USDC: 20% under the 24h average, past the 1% limit.
    jup.getQuote.mockImplementation(quoteAt(120));
    await startOrder();
    expect(await screen.findByTestId('vwap-why')).toHaveTextContent('20.00% below the 24h average, past your 1%');
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(jup.buildSwapTransaction).not.toHaveBeenCalled();
    expect(stored()!.slices[0]).toMatchObject({ state: 'waiting' });
  });

  it('another tab of the site holds the order: this one shows it and sends nothing', async () => {
    state.lockFree = false;
    await startOrder();
    expect(await screen.findByTestId('vwap-where')).toHaveTextContent('Running in another tab of this site.');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(jup.getQuote).not.toHaveBeenCalled();
  });

  it('no 24h average to price it against: nothing starts', async () => {
    avg.fetchPairAverage.mockResolvedValue({ kind: 'thin' });
    await startOrder();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not started', expect.objectContaining({ description: expect.stringContaining('Too little trading') })));
    expect(stored()).toBeNull();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
});
