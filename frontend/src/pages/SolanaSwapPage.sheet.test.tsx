// Island answer twenty-five, screen 1, the Buy state: the sheet hosts the swap page's form on SOL
// to the room's coin, drawn as the island drew it, with the form's own quote, route, notes and press.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';

const { toast, connection, wallet, jup } = vi.hoisted(() => ({
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
    buildSwapTransaction: vi.fn(),
    simulateSwap: vi.fn(),
    getTriggerOrders: vi.fn(),
    getRecurringOrders: vi.fn(),
  },
}));

const OWNER = new PublicKey('11111111111111111111111111111111');
const SIG = '5'.repeat(40) + 'Sig' + '7'.repeat(40);

vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', () => ({
  m: { div: ({ children, initial: _i, animate: _a, transition: _t, ...p }: { children?: ReactNode } & Record<string, unknown>) => <div {...p}>{children}</div> },
}));
const signedIn = vi.hoisted(() => ({ yes: true }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => ({ publicKey: signedIn.yes ? OWNER : null, sendTransaction: wallet.sendTransaction }),
}));
// The sheet's green button connects a wallet when none is: the press is seen here.
const connect = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../components/solana/useSolanaConnect', () => ({ useSolanaConnect: () => connect.open }));
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
  getUsdPrices: async () => ({}),
  getShield: async () => ({}),
}));

import { SolanaSwapInner } from './SolanaSwapPage';
import { SheetContext, type SheetPlace } from '../components/sheet/sheetContext';
import { BUNGALOWS } from '../lib/bungalows';

// The first render of this page takes seconds on a busy machine (SolanaSwapPage.confirm.test.tsx).
vi.setConfig({ testTimeout: 30_000 });

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

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

const writeText = vi.fn(async () => {});
const vibrate = vi.fn(() => true);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
  Object.values(toast).forEach((fn) => fn.mockReset());
  connection.getBalance.mockReset().mockResolvedValue(10_000_000_000);
  connection.getParsedTokenAccountsByOwner.mockReset().mockResolvedValue({ value: [] });
  connection.getSignatureStatuses.mockReset().mockResolvedValue(confirmed);
  connection.getMultipleAccountsInfo.mockReset().mockImplementation(async (keys: PublicKey[]) => keys.map(() => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })));
  wallet.sendTransaction.mockReset().mockResolvedValue(SIG);
  jup.getQuote.mockReset().mockResolvedValue(quote);
  jup.buildSwapTransaction.mockReset().mockResolvedValue('AAAA');
  jup.simulateSwap.mockReset().mockResolvedValue({ ok: true });
  jup.getTriggerOrders.mockReset().mockResolvedValue([]);
  jup.getRecurringOrders.mockReset().mockResolvedValue([]);
  signedIn.yes = true;
  connect.open.mockClear();
  // The room's page under the sheet: its address names no pair, and the sheet reads none from it.
  window.history.replaceState(null, '', `/bayla?sheet=buy&out=${USDC_MINT}`);
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});


const BAYLA = BUNGALOWS.find((b) => b.id === 'bayla')!;
const baylaQuote = { ...quote, outputMint: BAYLA_MINT, outAmount: '668500000', otherAmountThreshold: '665157500' };

function inSheet() {
  const place: SheetPlace = { kind: 'buy', room: BAYLA, bayla: <p data-testid="her-line">0° today. Hold any island coin and your clock starts tonight.</p> };
  return render(
    <SheetContext.Provider value={place}>
      <SolanaSwapInner sheet />
    </SheetContext.Provider>,
  );
}

describe('the sheet’s Buy', () => {
  it('opens on SOL to the room’s coin and holds only what was drawn: the amount, three chips, her line, one green button', async () => {
    inSheet();
    const buy = await screen.findByTestId('sheet-buy');
    expect(within(buy).getByTestId('sheet-amount')).toHaveAttribute('placeholder', '0');
    expect(within(buy).getByRole('group', { name: 'How much SOL' }).querySelectorAll('button')).toHaveLength(3);
    for (const chip of ['0.05 SOL', '0.5 SOL', 'Max SOL']) expect(within(buy).getByRole('button', { name: chip })).toBeInTheDocument();
    expect(within(buy).getByTestId('her-line')).toBeInTheDocument();
    expect(buy.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(within(buy).getByRole('button', { name: 'Buy BAYLA' })).toHaveClass('btn-primary');
    // Not the page's: no heading, no tabs, no pickers, no flip, no share, no slippage drawer.
    expect(screen.queryByRole('heading', { name: /Swap/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Instant swap' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Flip pay and receive tokens' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy a link to this trade' })).toBeNull();
    expect(screen.queryByText(/Slippage/)).toBeNull();
    // The address under the sheet is the room's: its ?out= is not this form's pair.
    expect(jup.getQuote).not.toHaveBeenCalled();
  });

  it('an amount asks the form’s own quote, and You get says it; the press is the form’s own Buy', async () => {
    jup.getQuote.mockResolvedValue(baylaQuote);
    inSheet();
    fireEvent.click(await screen.findByRole('button', { name: '0.5 SOL' }));
    expect(screen.getByTestId('sheet-amount')).toHaveValue('0.5');
    expect(screen.getByRole('button', { name: '0.5 SOL' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(jup.getQuote).toHaveBeenCalledWith(expect.objectContaining({ inputMint: SOL_MINT, outputMint: BAYLA_MINT, amount: '500000000' })), { timeout: 5_000 });
    const got = await screen.findByTestId('sheet-you-get', {}, { timeout: 5_000 });
    expect(got).toHaveTextContent(/You get\s*668\.5 BAYLA/);
    // Jupiter's route: the fee line is the swap's own sentence, not a pool's split.
    expect(screen.getByTestId('sheet-fee-line').textContent).toMatch(/platform fee|No platform fee/);
    const go = await screen.findByRole('button', { name: 'Buy BAYLA' });
    await waitFor(() => expect(go).toBeEnabled(), { timeout: 5_000 });
    fireEvent.click(go);
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    expect(jup.buildSwapTransaction).toHaveBeenCalledWith(expect.objectContaining({ quote: expect.objectContaining({ outputMint: BAYLA_MINT }) }));
  });

  it('with no wallet the green button connects one', async () => {
    signedIn.yes = false;
    inSheet();
    const go = await screen.findByRole('button', { name: 'Buy BAYLA' });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(connect.open).toHaveBeenCalledTimes(1);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
});
