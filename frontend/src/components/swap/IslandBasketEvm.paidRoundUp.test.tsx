// The EVM basket's ETH figures are what the order pays, so they are rounded UP at the fifth
// decimal, never below: the order total, and what the order needs with the network fee.
// At $10 and ETH at $2,401 the order is 0.004164 ETH, where a cut or a nearest reads 0.00416.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { type EvmLegQuote } from '../../lib/evm/islandBasketEvm';
import { universalRouterOn } from '../../lib/evm/universalRouter';

const h = vi.hoisted(() => ({
  account: { address: '0x00000000000000000000000000000000000000aa' as `0x${string}` | undefined, isConnected: true },
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
const price = vi.hoisted(() => ({ ethUsd: 0, ethUsdForDisplay: 2401 }));
vi.mock('../../contexts/PriceContext', () => ({ useTOWELIPriceOptional: () => price }));
vi.mock('../../lib/evm/islandBasketEvm', async (orig) => ({ ...(await orig<typeof import('../../lib/evm/islandBasketEvm')>()), quoteEvmLegs: h.quotes }));
vi.mock('../../lib/txErrors', async (orig) => ({ ...(await orig<typeof import('../../lib/txErrors')>()), waitForReceiptOutcome: h.receipt, surfaceReceiptNotice: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { IslandBasketEvm } from './IslandBasketEvm';

const SAFE = '0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1' as const;
const quoting = (out: bigint) => async (_c: unknown, _v: unknown, legs: { coin: EvmLegQuote['coin']; amountIn: bigint }[]): Promise<EvmLegQuote[]> =>
  legs.map((l) => ({ coin: l.coin, amountIn: l.amountIn, outside: l.coin.pools.map((pool) => ({ pool, out })), ours: null, venueFee: { bps: 50n, recipient: SAFE }, unread: false }));

const APPROX = String.fromCodePoint(0x2248);
const ORDER_WEI = 4_164_000_000_000_000n;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('tegridy-island-split-v1');
  h.balance = 10n ** 18n;
  h.quotes.mockImplementation(quoting(1_000_000n));
  h.send.mockImplementation(async ({ to }: { to: string }) => (to === universalRouterOn(8453) ? '0xbatch' : '0xsingle'));
  h.receipt.mockResolvedValue({ kind: 'success', receipt: {}, replacement: null });
});

async function openBasket() {
  renderWithProviders(<IslandBasketEvm chainId={8453} slippagePct={1} />);
  fireEvent.click(screen.getByTestId('island-basket-open'));
  await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 6'));
}

describe('IslandBasketEvm: what the order pays is rounded up', () => {
  it('the order total reads 0.00417 ETH for 0.004164 ETH', async () => {
    await openBasket();
    expect(screen.getByText(new RegExp(`${APPROX} 0\\.0041\\d ETH$`)).textContent).toMatch(new RegExp(`${APPROX} 0\\.00417 ETH$`));
  });

  it('"needs about" reads 0.00437 ETH for 0.004364 ETH with the network fee', async () => {
    // The wallet holds the order exactly; two transactions at 100,000 gas and 1 gwei add 0.0002 ETH.
    h.balance = ORDER_WEI;
    await openBasket();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getByTestId('island-basket-notice')).toHaveTextContent(/Not enough ETH/));
    expect(screen.getByTestId('island-basket-notice')).toHaveTextContent('this order needs about 0.00437 ETH with the network fee.');
    expect(h.send).not.toHaveBeenCalled();
  });
});
