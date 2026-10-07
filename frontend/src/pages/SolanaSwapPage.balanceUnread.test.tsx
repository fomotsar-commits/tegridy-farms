import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, configure } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';

/**
 * A BALANCE NOBODY READ IS NOT A ZERO: the "Balance:" line on the Solana swap.
 *
 * The wallet balance is read through /api/solrpc. When that read failed (a 429
 * from the rate limit, a 502, a dropped request) the hook kept `null`, and the
 * page printed '0' for null: "Balance: 0" with no MAX, which is exactly what an
 * empty or drained wallet looks like. The EVM swap already says "Balance: –"
 * for a balance it could not read (components/swap/LiquidityTab.balanceUnread
 * .test.tsx); this file holds the Solana page to the same words.
 *
 * Both directions are pinned. A failed read prints no number, offers a way to
 * read again and keeps MAX off. A read that RETURNED zero is a real empty
 * wallet and still says 0.
 *
 * The first block fails on the code before the fix (it printed "Balance: 0").
 */

// The first render of this page takes seconds when the whole suite runs in
// parallel on a busy machine. The default 5 s test budget and 1 s wait budget
// are not about what is tested here.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const h = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getTokenAccounts: vi.fn(),
  getQuote: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: vi.fn() }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/ClockLine', () => ({ ClockLine: () => null }));
vi.mock('../components/swap/ChainSwitch', () => ({ ChainSwitch: () => null }));
vi.mock('../components/swap/SolanaRouteLine', () => ({ SolanaRouteLine: () => null }));
// No pool program on this build: our pools take no part, and nothing reads the chain for them.
vi.mock('../components/swap/useOwnPoolRoute', () => ({ useOwnPoolRoute: () => ({ own: { kind: 'absent' }, quoteNow: async () => ({ kind: 'absent' }) }) }));
vi.mock('../components/solana/PairChart', () => ({ PairChart: () => null }));
vi.mock('../components/solana/TokenDetail', () => ({ TokenDetail: () => null }));
vi.mock('../components/solana/SolanaConnectButton', () => ({ SolanaConnectButton: () => null }));
vi.mock('../components/solana/SolanaProviders', () => ({ SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/solanaTokenList', async (orig) => ({
  ...(await orig<typeof import('../lib/solanaTokenList')>()),
  fetchTrending: vi.fn(async () => []),
}));
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: h.getQuote,
  getUsdPrices: vi.fn(async () => ({})),
  getShield: vi.fn(async () => ({})),
  getTriggerOrders: vi.fn(async () => []),
  getRecurringOrders: vi.fn(async () => []),
}));
// One stable wallet and connection: the page's effects key on their identity.
const connection = {
  getBalance: () => h.getBalance() as Promise<number>,
  getParsedTokenAccountsByOwner: () => h.getTokenAccounts() as Promise<unknown>,
  getSignatureStatuses: async () => ({ value: [null] }),
};
const wallet = { publicKey: USER, sendTransaction: vi.fn() };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';

/** A parsed token account holding `amount` base units, as the RPC returns it. */
function tokenAccount(amount: string | undefined) {
  return { account: { data: { parsed: { info: { tokenAmount: amount === undefined ? {} : { amount } } } } } };
}

/** The words beside "You Pay": the line's own text, without the buttons inside it. */
function balanceLine(): string {
  const el = screen.getByText(/^Balance:/);
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join('');
}
/** The line once the read has ended, either way. */
async function readEnded(): Promise<string> {
  await waitFor(() => expect(balanceLine()).not.toBe('Balance: …'));
  return balanceLine();
}
const maxButton = () => screen.queryByRole('button', { name: 'MAX' });
const retryButton = () => screen.queryByRole('button', { name: /^retry reading your \w+ balance$/i });
const notice = () => screen.queryByTestId('solana-balance-unread');

/** Open the page paying with SOL (the default) or with USDC, an SPL token. */
function open(pay: 'SOL' | 'USDC') {
  window.history.replaceState(null, '', pay === 'SOL' ? '/solana' : `/solana?in=${USDC_MINT}&out=${SOL_MINT}`);
  render(<SolanaSwapPage />);
}

beforeEach(() => {
  localStorage.clear();
  h.getBalance.mockReset();
  h.getTokenAccounts.mockReset();
  h.getQuote.mockReset();
  // No quote is needed by this file; a hanging one keeps the CTA out of the way.
  h.getQuote.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SolanaSwapPage: a balance read that FAILED is not printed as 0', () => {
  it.each([
    ['SOL', 'getBalance'],
    ['USDC', 'getParsedTokenAccountsByOwner'],
  ] as const)('%s: a %s that throws reads "Balance: –", never a number, with MAX off', async (pay, read) => {
    h.getBalance.mockRejectedValue(new Error('429 Too Many Requests'));
    h.getTokenAccounts.mockRejectedValue(new Error('502 Bad Gateway'));
    open(pay);

    const line = await readEnded();
    // The read that failed is the one this token's balance comes from.
    expect(read === 'getBalance' ? h.getBalance : h.getTokenAccounts).toHaveBeenCalledTimes(1);
    // The invariant: no figure is printed for a balance nobody read.
    expect(line).not.toMatch(/\d/);
    // The same words the EVM swap uses for the same state.
    expect(line).toBe('Balance: –');
    expect(maxButton()).toBeNull();
    // Said plainly, as the EVM swap says it.
    expect(notice()).toHaveTextContent(new RegExp(`your ${pay} balance could not be read`, 'i'));
    expect(notice()).toHaveTextContent(/not a statement that you hold none/i);
  });

  it('a token account that came back without an amount is unread too, not a silent 0', async () => {
    // Two accounts for the mint: one readable, one with no amount. The sum is not known.
    h.getTokenAccounts.mockResolvedValue({ value: [tokenAccount('2500000'), tokenAccount(undefined)] });
    open('USDC');

    const line = await readEnded();
    expect(line).not.toMatch(/\d/);
    expect(line).toBe('Balance: –');
    expect(maxButton()).toBeNull();
  });

  it.each([
    // BigInt('') is 0n and BigInt('0x10') is 16n: neither is an amount the RPC
    // sent, so neither may be added up as one.
    ['an empty string', ''],
    ['a string that is not plain digits', '0x10'],
  ])('a token account whose amount is %s is unread too, never summed as a number', async (_name, amount) => {
    h.getTokenAccounts.mockResolvedValue({ value: [tokenAccount('2500000'), tokenAccount(amount)] });
    open('USDC');

    const line = await readEnded();
    expect(line).not.toMatch(/\d/);
    expect(line).toBe('Balance: –');
    expect(maxButton()).toBeNull();
    expect(notice()).not.toBeNull();
  });

  it('Retry reads again, and a read that lands prints the number and brings MAX back', async () => {
    h.getBalance.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    h.getBalance.mockResolvedValue(5_000_000_000);
    open('SOL');

    expect(await readEnded()).toBe('Balance: –');
    expect(h.getBalance).toHaveBeenCalledTimes(1);
    const retry = retryButton();
    expect(retry).not.toBeNull();
    fireEvent.click(retry!);

    await waitFor(() => expect(h.getBalance).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(balanceLine()).toBe('Balance: 5'));
    expect(maxButton()).not.toBeNull();
    expect(retryButton()).toBeNull();
    expect(notice()).toBeNull();
  });

  it('nothing says "Insufficient" about a balance it could not read', async () => {
    // Identical before and after the fix: it fails if the fix is ever widened
    // into treating an unread balance as an empty one.
    h.getBalance.mockRejectedValue(new Error('429 Too Many Requests'));
    open('SOL');
    await readEnded();
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '1000' } });
    expect(document.body.textContent).not.toMatch(/insufficient/i);
  });
});

describe('SolanaSwapPage: a balance that WAS read', () => {
  // Not discriminating against the old code: identical before and after. These
  // fail if the fix is ever widened into treating a READ 0 as unknown.
  it('SOL read as 0 is a real empty wallet: "Balance: 0", no retry, no notice, no MAX', async () => {
    h.getBalance.mockResolvedValue(0);
    open('SOL');

    expect(await readEnded()).toBe('Balance: 0');
    expect(retryButton()).toBeNull();
    expect(notice()).toBeNull();
    expect(maxButton()).toBeNull();
  });

  it('no token account for the mint is a real 0 too', async () => {
    h.getTokenAccounts.mockResolvedValue({ value: [] });
    open('USDC');

    expect(await readEnded()).toBe('Balance: 0');
    expect(retryButton()).toBeNull();
    expect(notice()).toBeNull();
  });

  it('a balance that was read prints, sums its accounts, and offers MAX', async () => {
    h.getTokenAccounts.mockResolvedValue({ value: [tokenAccount('2500000'), tokenAccount('500000')] });
    open('USDC');

    expect(await readEnded()).toBe('Balance: 3');
    expect(maxButton()).not.toBeNull();
    expect(retryButton()).toBeNull();
    expect(notice()).toBeNull();
  });

  it('a read balance smaller than the amount still says Insufficient', async () => {
    h.getBalance.mockResolvedValue(1_000_000_000);
    open('SOL');
    expect(await readEnded()).toBe('Balance: 1');
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '2' } });
    expect(await screen.findByText('Insufficient SOL balance.')).toBeInTheDocument();
  });
});

describe('SolanaSwapPage: the limit and DCA tabs make no claim about a balance they could not read', () => {
  // Neither tab prints a balance, so neither can print a false 0. Pinned so a
  // balance line added to them later has to face the same rule.
  it.each([
    ['Limit order', 'Amount of SOL to sell'],
    ['DCA', 'Total SOL to invest'],
  ] as const)('%s: no balance figure and no "Insufficient" while the read is failing', async (tab, amountLabel) => {
    h.getBalance.mockRejectedValue(new Error('429 Too Many Requests'));
    open('SOL');
    await readEnded();
    fireEvent.click(screen.getByRole('button', { name: tab }));
    fireEvent.change(await screen.findByLabelText(amountLabel), { target: { value: '1000' } });
    await waitFor(() => expect(h.getBalance.mock.calls.length).toBeGreaterThanOrEqual(2));

    expect(document.body.textContent).not.toMatch(/Balance: ?0/);
    expect(document.body.textContent).not.toMatch(/insufficient/i);
  });
});
