import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { uniswapOn, type EvmLegQuote } from '../../lib/evm/islandBasketEvm';
import { swapVenueOn } from '../../lib/chains/swapVenue';

const h = vi.hoisted(() => ({
  account: { address: undefined as `0x${string}` | undefined, isConnected: false },
  balance: 10n ** 18n,
  send: vi.fn(),
  quotes: vi.fn(),
  receipt: vi.fn(),
  client: {
    estimateGas: vi.fn(async () => 100_000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1_000_000_000n })),
    readContract: vi.fn(),
    simulateContract: vi.fn(),
  },
}));

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: { value: h.balance }, refetch: vi.fn() }),
  usePublicClient: () => h.client,
  useSendTransaction: () => ({ sendTransactionAsync: h.send }),
}));
// A heartbeat-fresh round: the strict 300 s `ethUsd` is 0 (the feed is routinely older), the display price is set.
const price = vi.hoisted(() => ({ ethUsd: 0, ethUsdForDisplay: 2400 }));
vi.mock('../../contexts/PriceContext', () => ({ useTOWELIPriceOptional: () => price }));
vi.mock('../../lib/evm/islandBasketEvm', async (orig) => ({ ...(await orig<typeof import('../../lib/evm/islandBasketEvm')>()), quoteEvmLegs: h.quotes }));
vi.mock('../../lib/txErrors', async (orig) => ({ ...(await orig<typeof import('../../lib/txErrors')>()), waitForReceiptOutcome: h.receipt, surfaceReceiptNotice: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { IslandBasketEvm } from './IslandBasketEvm';

/** Every pool quotes `out`: on Base, $mfer's V2 pair wins the tie, so the order is the batch plus one V2 transaction. */
const quoting = (out: bigint) => async (_c: unknown, _v: unknown, legs: { coin: EvmLegQuote['coin']; amountIn: bigint }[]): Promise<EvmLegQuote[]> =>
  legs.map((l) => ({ coin: l.coin, amountIn: l.amountIn, outside: l.coin.pools.map((pool) => ({ pool, out })), ours: null, unread: false }));

const ME = '0x00000000000000000000000000000000000000aa' as const;
const row = (key: string) => screen.getByTestId(`island-basket-row-${key}`);
const open = async () => {
  fireEvent.click(screen.getByTestId('island-basket-open'));
  await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent(/Buy all 7|Connect/));
};

beforeEach(() => {
  vi.clearAllMocks();
  // A split moved in one test is kept in this browser: every test starts even.
  localStorage.removeItem('tegridy-island-split-v1');
  h.account = { address: ME, isConnected: true };
  h.balance = 10n ** 18n;
  h.quotes.mockImplementation(quoting(1_000_000n));
  h.send.mockImplementation(async ({ to }: { to: string }) => (to === uniswapOn(8453)!.swapRouter02 ? '0xbatch' : '0xsingle'));
  h.receipt.mockResolvedValue({ kind: 'success', receipt: {}, replacement: null });
});

describe('IslandBasketEvm', () => {
  it('draws nothing on a chain with no island coins', () => {
    renderWithProviders(<IslandBasketEvm chainId={4663} slippagePct={1} />);
    expect(screen.queryByTestId('island-basket-open')).toBeNull();
  });

  it('lists every Base coin, the bridged ones marked, and says the venue takes nothing through Uniswap', async () => {
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    expect(screen.getByTestId('island-basket-open')).toHaveTextContent('7');
    await open();
    for (const k of ['qr', 'mfer', 'bnkr', 'drb', 'jbm']) expect(row(`${k}-${(await import('../../lib/islandBasket')).EVM_BASKET.base.find((c) => c.room === k)!.token}`)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Coins in this order' });
    await waitFor(() => expect(within(list).getAllByText(/· Uniswap V3$/)).toHaveLength(6));
    expect(within(list).getByText(/^from Ethereum · Uniswap V3$/)).toBeInTheDocument();
    expect(within(list).getByText(/^from Solana · Uniswap V3$/)).toBeInTheDocument();
    expect(within(list).getByText(/^· Uniswap V2$/)).toBeInTheDocument();
    expect(screen.getByTestId('island-basket-fee')).toHaveTextContent(/No site fee.*venue earns nothing/);
  });

  it('sends the Uniswap batch, then the V2 coin, and marks every coin bought', async () => {
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 7'));
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.send.mock.calls[0]![0].to).toBe(uniswapOn(8453)!.swapRouter02);
    expect(h.send.mock.calls[1]![0].to).toBe(swapVenueOn(8453)!.uniswapV2Router);
    // The test run came first, as this wallet.
    expect(h.client.estimateGas).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(7));
  });

  it('buys in the split the sliders set: $mfer at 0% is left out, so its V2 transaction is never sent', async () => {
    const { EVM_BASKET } = await import('../../lib/islandBasket');
    const mfer = EVM_BASKET.base.find((c) => c.room === 'mfer')!;
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    fireEvent.change(screen.getByTestId(`island-basket-split-mfer-${mfer.token}`), { target: { value: '0' } });
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy 6 coins'));
    expect(within(row(`mfer-${mfer.token}`)).getByText(/Not in this order/)).toBeInTheDocument();
    const legs = h.quotes.mock.calls.at(-1)![2] as { coin: { room: string } }[];
    expect(legs.map((l) => l.coin.room)).not.toContain('mfer');
    expect(legs).toHaveLength(6);
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(6));
    // One Uniswap batch, and no V2 transaction for the coin left out.
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0].to).toBe(uniswapOn(8453)!.swapRouter02);
  });

  it('sends nothing when prices moved past slippage since they were shown', async () => {
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 7'));
    h.quotes.mockImplementation(quoting(989_999n));
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getByTestId('island-basket-notice')).toHaveTextContent(/Prices moved/));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.client.estimateGas).not.toHaveBeenCalled();
  });

  it('sends nothing when the test run fails', async () => {
    h.client.estimateGas.mockRejectedValueOnce(new Error('execution reverted: Too little received'));
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 7'));
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getByTestId('island-basket-notice')).toHaveTextContent(/failed its test run/));
    expect(h.send).not.toHaveBeenCalled();
  });

  it('stops at a declined prompt: the rest is not sent', async () => {
    h.send.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 7'));
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('You declined')).toHaveLength(6));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(within(row(`mfer-${(await import('../../lib/islandBasket')).EVM_BASKET.base[1]!.token}`)).getByText('Not sent')).toBeInTheDocument();
  });

  it('stops when a receipt cannot be read: nothing more is sent until the buyer checks', async () => {
    h.receipt.mockResolvedValueOnce({ kind: 'unreadable', error: new Error('timeout') });
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 7'));
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Sent, not confirmed')).toHaveLength(6));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('asks for at least a dollar a coin, and for a wallet', async () => {
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    fireEvent.change(screen.getByLabelText('Dollars to spend'), { target: { value: '5' } });
    expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Enter at least $7.00');
    expect(screen.getByTestId('island-basket-buy')).toBeDisabled();
  });

  it('sizes the order on a heartbeat-fresh ETH price, and says so plainly when there is none', async () => {
    renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 7'));
    price.ethUsdForDisplay = 0;
    fireEvent.change(screen.getByLabelText('Dollars to spend'), { target: { value: '25' } });
    await waitFor(() => expect(screen.getByTestId('island-basket-notice')).toHaveTextContent(/ETH price could not be read/));
    expect(screen.getByTestId('island-basket-buy')).toBeDisabled();
    price.ethUsdForDisplay = 2400;
  });

  it('opens over the whole page, outside the swap card: a transformed card would trap it under the bars', async () => {
    const { container } = renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
    await open();
    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});
