// Island answer twenty-five, screen 1, the Buy state: the sheet hosts the swap page's form on SOL
// to the room's coin, drawn as the island drew it, with the form's own quote, route, notes and press.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
// The venue's fee account: off as the test build has none, on as the live site has one.
const fee = vi.hoisted(() => ({ on: false }));
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
vi.mock('../lib/solana', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/solana')>()),
  isSolanaFeeConfigured: () => fee.on,
}));
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
  fee.on = false;
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

/** The address the sheet is at, as the router holds it: a chip's pick names its coin there. */
function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function inSheet(room: SheetPlace['room'] = BAYLA, at = '/bayla?sheet=buy') {
  const place: SheetPlace = { kind: 'buy', room, bayla: <p data-testid="her-line">0° today. Hold any island coin and your clock starts tonight.</p> };
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <SheetContext.Provider value={place}>
        <SolanaSwapInner sheet />
      </SheetContext.Provider>
    </MemoryRouter>,
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
    // As drawn: the quote is an estimate, so it reads "≈".
    expect(got).toHaveTextContent(/You get\s*≈ 668\.5 BAYLA/);
    // Jupiter's route, and this build has no fee account: the venue's take from this trade, none.
    expect(screen.getByTestId('sheet-fee-line')).toHaveTextContent(/^The venue takes no fee on this trade\.$/);
    const go = await screen.findByRole('button', { name: 'Buy BAYLA' });
    await waitFor(() => expect(go).toBeEnabled(), { timeout: 5_000 });
    fireEvent.click(go);
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    expect(jup.buildSwapTransaction).toHaveBeenCalledWith(expect.objectContaining({ quote: expect.objectContaining({ outputMint: BAYLA_MINT }) }));
  });

  it('on Jupiter’s route the fee line is the venue’s own take from this trade, in the coin it is taken in', async () => {
    fee.on = true;
    jup.getQuote.mockResolvedValue(baylaQuote);
    inSheet();
    fireEvent.click(await screen.findByRole('button', { name: '0.5 SOL' }));
    const line = await screen.findByTestId('sheet-fee-line', {}, { timeout: 5_000 });
    // In the Add sheet's own words ("the venue 0.160%"), not a rule about pairs.
    expect(line).toHaveTextContent(/^The venue takes \d+\.\d{2}% of this trade, in SOL\.$/);
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

// Island answer twenty-seven: the Buy sheet carries the bungalow row above the amount, so the bar's
// Swap inside a room is not a one-coin app. The swap that is signed stays SOL to the coin picked,
// through the form's own press.
describe('the sheet’s bungalow row', () => {
  const row = () => within(screen.getByTestId('sheet-buy')).getByRole('group', { name: 'Pick a coin' });
  const chip = (name: string) => within(row()).getByRole('button', { name });
  const pickInPicker = async (mint: string) => {
    const picker = await screen.findByRole('dialog', { name: 'Buy' });
    fireEvent.click(picker.querySelector(`[data-token-row="${mint}"] button`)!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Buy' })).toBeNull());
  };

  it('stands above the amount: the five rooms’ coins in the hall’s order, the room’s lit, then Any coin', async () => {
    inSheet();
    await screen.findByTestId('sheet-buy');
    expect(within(row()).getAllByRole('button').map((b) => b.textContent)).toEqual(['BAYLA', 'BOBO', 'SOY', 'BRAINLET', 'RIZZ', 'Any coin']);
    expect(chip('BAYLA')).toHaveAttribute('aria-pressed', 'true');
    for (const other of ['BOBO', 'SOY', 'BRAINLET', 'RIZZ', 'Any coin']) expect(chip(other)).toHaveAttribute('aria-pressed', 'false');
    // Above the amount, and every chip a 44 px target; the row wraps at a phone's width.
    expect(row().compareDocumentPosition(screen.getByTestId('sheet-amount')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const b of within(row()).getAllByRole('button')) expect(b.className).toContain('min-h-[44px]');
    expect(row().className).toContain('flex-wrap');
    // The coin on the sheet, by its ticker and its whole address.
    expect(within(screen.getByTestId('sheet-buy')).getByRole('button', { name: `BAYLA: copy its address ${BAYLA_MINT}` })).toBeInTheDocument();
  });

  it('a tap on BOBO names it in the address over the same room, so Back and a reload hold it', async () => {
    inSheet();
    await screen.findByTestId('sheet-buy');
    fireEvent.click(chip('BOBO'));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/bayla\?sheet=buy&coin=bobo$/);
  });

  it('Any coin opens the swap’s own picker inside the sheet, majors first; the pick is bought with SOL through the form’s own press', async () => {
    inSheet();
    await screen.findByTestId('sheet-buy');
    fireEvent.click(chip('Any coin'));
    const picker = await screen.findByRole('dialog', { name: 'Buy' });
    expect(screen.getByTestId('sheet-buy').contains(picker), 'the picker rises inside the sheet').toBe(true);
    const rows = [...picker.querySelectorAll('[data-token-row]')].map((r) => r.getAttribute('data-token-row'));
    expect(rows.slice(0, 4)).toEqual([BAYLA_MINT, SOL_MINT, USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
    expect(within(picker).getByRole('button', { name: `USDC: copy its address ${USDC_MINT}` })).toBeInTheDocument();
    await pickInPicker(USDC_MINT);
    expect(chip('Any coin')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('BAYLA')).toHaveAttribute('aria-pressed', 'false');
    // The room behind it is unchanged.
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/bayla\?sheet=buy$/);
    expect(within(screen.getByTestId('sheet-buy')).getByRole('button', { name: `USDC: copy its address ${USDC_MINT}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '0.5 SOL' }));
    await waitFor(() => expect(jup.getQuote).toHaveBeenCalledWith(expect.objectContaining({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: '500000000' })), { timeout: 5_000 });
    const go = await screen.findByRole('button', { name: 'Buy USDC' });
    await waitFor(() => expect(go).toBeEnabled(), { timeout: 5_000 });
    fireEvent.click(go);
    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalledTimes(1));
    expect(jup.buildSwapTransaction).toHaveBeenCalledWith(expect.objectContaining({ quote: expect.objectContaining({ inputMint: SOL_MINT, outputMint: USDC_MINT }) }));
  });

  it('after a pick from Any coin, the room’s own chip opens the form on the room’s coin again', async () => {
    const reopen = vi.fn();
    const place: SheetPlace = { kind: 'buy', room: BAYLA, bayla: null, reopen };
    render(
      <MemoryRouter initialEntries={['/bayla?sheet=buy']}>
        <Where />
        <SheetContext.Provider value={place}>
          <SolanaSwapInner sheet />
        </SheetContext.Provider>
      </MemoryRouter>,
    );
    await screen.findByTestId('sheet-buy');
    fireEvent.click(chip('BAYLA'));
    expect(reopen, 'a lit chip is already the coin').not.toHaveBeenCalled();
    fireEvent.click(chip('Any coin'));
    await pickInPicker(USDC_MINT);
    fireEvent.click(chip('BAYLA'));
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/bayla\?sheet=buy&coin=bayla$/);
  });

  it('with no room: nothing lit, her line reads “Pick a coin.”, and the one green button is off until a coin is picked', async () => {
    jup.getQuote.mockResolvedValue(quote);
    inSheet(null, '/?sheet=buy');
    await screen.findByTestId('sheet-buy');
    for (const b of within(row()).getAllByRole('button')) expect(b, b.textContent!).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByTestId('sheet-buy')).getByText('Pick a coin.')).toBeInTheDocument();
    expect(screen.queryByTestId('her-line')).toBeNull();
    const buy = screen.getByTestId('sheet-buy');
    expect(buy.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(screen.getByTestId('sheet-go')).toHaveTextContent(/^Buy$/);
    expect(screen.getByTestId('sheet-go')).toBeDisabled();
    // No coin, no quote: an amount waits for the pick.
    fireEvent.click(screen.getByRole('button', { name: '0.5 SOL' }));
    await new Promise((r) => setTimeout(r, 600));
    expect(jup.getQuote).not.toHaveBeenCalled();
    fireEvent.click(chip('Any coin'));
    await pickInPicker(USDC_MINT);
    expect(screen.queryByText('Pick a coin.')).toBeNull();
    await waitFor(() => expect(jup.getQuote).toHaveBeenCalledWith(expect.objectContaining({ inputMint: SOL_MINT, outputMint: USDC_MINT })), { timeout: 5_000 });
    await waitFor(() => expect(screen.getByTestId('sheet-go')).toBeEnabled(), { timeout: 5_000 });
    expect(screen.getByTestId('sheet-go')).toHaveTextContent('Buy USDC');
  });

  it('with no room and no wallet, the green button still waits for a pick before it connects', async () => {
    signedIn.yes = false;
    inSheet(null, '/?sheet=buy');
    await screen.findByTestId('sheet-buy');
    expect(screen.getByTestId('sheet-go')).toBeDisabled();
    fireEvent.click(chip('BOBO'));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/\?sheet=buy&coin=bobo$/);
  });
});
