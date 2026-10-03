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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
// One stable wallet and connection: the page's effects key on their identity.
const connection = {
  getBalance: async () => 5_000_000_000,
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }),
};
const wallet = { publicKey: USER, sendTransaction: h.sendTransaction };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';

const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
const OTHER: SwapSimulation = { ok: false, reason: 'custom program error: 0x1771', jupiterIncorrectTokenProgram: false };

/** What the page showed at the moment the wallet was asked to sign. */
let atSign: { notice: string | null; receive: string | null; feeValue: string | null; infoToasts: unknown[][] } | null = null;

beforeEach(() => {
  atSign = null;
  window.history.replaceState(null, '', '/solana');
  h.getQuote.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? NO_FEE_QUOTE : FEE_QUOTE));
  h.buildSwapTransaction.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? TX_NO_FEE : TX_FEE));
  h.sendTransaction.mockImplementation(async () => {
    atSign = {
      notice: screen.queryByTestId('site-fee-waived')?.textContent ?? null,
      receive: document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? null,
      feeValue: screen.queryByTestId('site-fee-value')?.textContent ?? null,
      infoToasts: h.toast.info.mock.calls.map((c) => [...c]),
    };
    return '5'.repeat(88);
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
