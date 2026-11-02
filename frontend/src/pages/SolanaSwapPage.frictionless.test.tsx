// Island answer twenty-four on the Solana swap: the token picker opens on SOL, USDC and USDT,
// every coin's name in it is a press that copies its whole address while the rest of its row
// picks, the pay field has amount chips, and the Buy press ticks the phone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
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
  getUsdPrices: async () => ({}),
  getShield: async () => ({}),
}));

import SolanaSwapPage from './SolanaSwapPage';

// The first render of this page takes seconds on a busy machine (SolanaSwapPage.confirm.test.tsx).
vi.setConfig({ testTimeout: 30_000 });

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
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
const tokenAccount = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } });

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
  // SOL to USDC, nothing typed: the form opens on the pair the link names.
  window.history.replaceState(null, '', `/solana?out=${USDC_MINT}`);
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const headTail = (a: string) => `${a.slice(0, 4)} … ${a.slice(-4)}`;
const rows = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>('[data-token-row]')];
const rowOf = (dialog: HTMLElement, mint: string) => dialog.querySelector<HTMLElement>(`[data-token-row="${mint}"]`);

async function openPicker(side: 'Pay with' | 'Buy') {
  render(<SolanaSwapPage />);
  fireEvent.click(await screen.findByRole('button', { name: side === 'Pay with' ? 'SOL' : 'USDC' }));
  return screen.findByRole('dialog', { name: side });
}

describe('the token picker', () => {
  it('Pay opens on SOL, USDC and USDT, each name a 44px press with its address, then the rest', async () => {
    const dialog = await openPicker('Pay with');
    expect(rows(dialog).map((r) => r.getAttribute('data-token-row'))).toEqual([SOL_MINT, USDC_MINT, USDT_MINT, BAYLA_MINT]);
    for (const mint of [SOL_MINT, USDC_MINT, USDT_MINT]) {
      const name = within(rowOf(dialog, mint)!).getByTestId('coin-name');
      expect(name).toHaveAccessibleName(new RegExp(`: copy its address ${mint}$`));
      expect(name).toHaveTextContent(headTail(mint));
      expect(name.className).toContain('min-h-[44px]');
    }
    // A coin the site does not name itself keeps its whole address in view (identity.ts).
    expect(rowOf(dialog, USDT_MINT)).toHaveTextContent(USDT_MINT);
  });

  it('Buy keeps the venue’s BAYLA on top (owner, 2026-10-08), then SOL, USDC and USDT', async () => {
    const dialog = await openPicker('Buy');
    expect(rows(dialog).map((r) => r.getAttribute('data-token-row')).slice(0, 4)).toEqual([BAYLA_MINT, SOL_MINT, USDC_MINT, USDT_MINT]);
  });

  it('a press on the name copies the whole address and picks nothing; the rest of the row picks', async () => {
    const dialog = await openPicker('Pay with');
    const usdt = rowOf(dialog, USDT_MINT)!;
    await act(async () => {
      fireEvent.click(within(usdt).getByTestId('coin-name'));
    });
    expect(writeText).toHaveBeenCalledWith(USDT_MINT);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(within(usdt).getByText('Copied')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Pay with' })).toBeInTheDocument();
    expect(screen.getByLabelText('Amount of SOL to pay')).toBeInTheDocument();
    // The row's own press comes first in it, under the name, and is a 44px target too.
    const pick = usdt.querySelector('button')!;
    expect(pick).not.toBe(within(usdt).getByTestId('coin-name'));
    expect(pick.className).toContain('min-h-[44px]');
    fireEvent.click(pick);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Amount of USDT to pay')).toBeInTheDocument();
  });
});

describe('the pay amount’s chips', () => {
  it('paying SOL: 0.05 SOL, 0.5 SOL and MAX, each 44px and a tick; MAX keeps 0.01 SOL back for fees', async () => {
    render(<SolanaSwapPage />);
    const box = screen.getByLabelText('Amount of SOL to pay') as HTMLInputElement;
    const max = await screen.findByRole('button', { name: 'MAX' });
    const chips = [screen.getByRole('button', { name: '0.05 SOL' }), screen.getByRole('button', { name: '0.5 SOL' }), max];
    for (const c of chips) expect(c.className).toContain('min-h-[44px]');
    fireEvent.click(chips[0]!);
    expect(box.value).toBe('0.05');
    fireEvent.click(chips[1]!);
    expect(box.value).toBe('0.5');
    fireEvent.click(max);
    expect(box.value).toBe('9.99');
    expect(vibrate).toHaveBeenCalledTimes(3);
  });

  it('paying another coin: MAX alone, the whole balance, and a tick', async () => {
    window.history.replaceState(null, '', `/solana?in=${USDC_MINT}&out=${SOL_MINT}`);
    connection.getParsedTokenAccountsByOwner.mockResolvedValue({ value: [tokenAccount('3000000')] });
    render(<SolanaSwapPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'MAX' }));
    expect((screen.getByLabelText('Amount of USDC to pay') as HTMLInputElement).value).toBe('3');
    expect(screen.queryByRole('button', { name: '0.05 SOL' })).toBeNull();
    expect(screen.queryByRole('button', { name: '0.5 SOL' })).toBeNull();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});

describe('the Buy press', () => {
  it('ticks the phone', async () => {
    window.history.replaceState(null, '', `/solana?amt=0.5&out=${USDC_MINT}`);
    render(<SolanaSwapPage />);
    const buy = await screen.findByRole('button', { name: 'Buy USDC' }, { timeout: 5_000 });
    vibrate.mockClear();
    fireEvent.click(buy);
    expect(vibrate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Bought USDC', expect.anything()));
  });
});
