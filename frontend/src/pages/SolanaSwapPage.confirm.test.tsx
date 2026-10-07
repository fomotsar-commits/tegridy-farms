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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';

const { toast, connection, wallet, jup } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  connection: {
    getBalance: vi.fn(),
    getParsedTokenAccountsByOwner: vi.fn(),
    getSignatureStatuses: vi.fn(),
  },
  wallet: { sendTransaction: vi.fn() },
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

const OWNER = new PublicKey('11111111111111111111111111111111');
const SIG = '5'.repeat(40) + 'Sig' + '7'.repeat(40);

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
// No pool program on this build: our pools take no part, and nothing reads the chain for them.
vi.mock('../components/swap/useOwnPoolRoute', () => ({ useOwnPoolRoute: () => ({ own: { kind: 'absent' }, quoteNow: async () => ({ kind: 'absent' }) }) }));
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
  slippageBps: 50,
  priceImpactPct: '0',
  routePlan: [],
};

const confirmed = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] };
const notYet = { context: { slot: 9 }, value: [null] };
const reverted = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 1, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
const rpcDown = () => Promise.reject(new Error('fetch failed: 503'));

const toastTitles = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  window.history.replaceState(null, '', '/solana?amt=0.5');
  Object.values(toast).forEach((fn) => fn.mockReset());
  connection.getBalance.mockReset().mockResolvedValue(10_000_000_000);
  connection.getParsedTokenAccountsByOwner.mockReset().mockResolvedValue({ value: [] });
  connection.getSignatureStatuses.mockReset();
  wallet.sendTransaction.mockReset().mockResolvedValue(SIG);
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
});

/** Long enough for any watch on the page to give up. */
const outlastTheWatch = () => act(async () => { await vi.advanceTimersByTimeAsync(130_000); });

async function swap() {
  render(<SolanaSwapPage />);
  const button = await screen.findByRole('button', { name: 'Buy USDC' }, { timeout: 5_000 });
  fireEvent.click(button);
  await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
}

describe('Instant swap: after the swap is sent', () => {
  it('a status read that errors once is not "Swap failed": it looks again, and the swap confirms', async () => {
    connection.getSignatureStatuses.mockImplementationOnce(rpcDown).mockResolvedValue(confirmed);
    await swap();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(toastTitles(toast.success)).toContain('Bought USDC'));
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
    expect(toastTitles(toast.success)).not.toContain('Bought USDC');
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
    expect(toastTitles(toast.success)).not.toContain('Bought USDC');
  });

  it('a failure seen only at "processed" is not a revert: the watch goes on, and the swap confirms', async () => {
    const failedAtProcessed = { context: { slot: 9 }, value: [{ slot: 9, confirmations: 0, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }] };
    connection.getSignatureStatuses.mockResolvedValueOnce(failedAtProcessed).mockResolvedValue(confirmed);
    await swap();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(toastTitles(toast.success)).toContain('Bought USDC'));
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
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    await outlastTheWatch();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.anything()));
    expect(toastTitles(toast.error)).not.toContain('Could not start the DCA');
  });

  it('DCA cancel: a status read that errors once is not "Could not cancel"', async () => {
    jup.getRecurringOrders.mockResolvedValue([{ orderKey: 'DcaOrderKey1111111111111111111111111111111' }]);
    connection.getSignatureStatuses.mockImplementationOnce(rpcDown).mockResolvedValue(confirmed);
    await openTab('DCA');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    await outlastTheWatch();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.anything()));
    expect(toastTitles(toast.error)).not.toContain('Could not place order');
  });

  it('Limit order cancel: a status read that errors once is not "Could not cancel"', async () => {
    jup.getTriggerOrders.mockResolvedValue([{ orderKey: 'LimitOrderKey11111111111111111111111111111' }]);
    connection.getSignatureStatuses.mockImplementationOnce(rpcDown).mockResolvedValue(confirmed);
    await openTab('Limit order');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(toastTitles(toast.success)).toContain('Order cancelled'));
    expect(toastTitles(toast.error)).not.toContain('Could not cancel');
  });
});
