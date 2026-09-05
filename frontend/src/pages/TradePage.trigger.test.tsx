// THE MOUNT, PROVEN AT THE TAB.
//
// TriggerOrderTab.test.tsx proves the panel refuses honestly. This proves the panel is
// REACHABLE: that `?tab=trigger` resolves, that the tab bar offers it, and that what
// renders inside it is still the refusal — because a mount is the one change that can
// turn a well-tested honest component into a live-looking surface, and nothing in the
// panel's own suite would notice if the page arrived, say, with the arm state faked or
// with a sixth tab in the bar that keyboard navigation never reaches.
//
// The wallet is a plain EOA on mainnet (no bytecode), which is both the most common
// visitor and the one for whom NOTHING on this surface can fire until the venue keeper in
// F4 exists. So the reachable state and the gated state are the same state here, which is
// exactly the property that had to survive routing it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The trigger panel needs four of these; the rest are here because the DEFAULT (swap) tab
// is rendered by one test below, and CowSwapPanel / MevProtectionPanel reach for their own
// wagmi hooks. Every one answers "nothing read, nothing pending", which is the
// disconnected-chain shape.
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111' }),
  useChainId: () => 1,
  usePublicClient: () => ({ getCode: async () => '0x' }), // no bytecode → EOA → keeper path
  useWriteContract: () => ({
    writeContract: vi.fn(),
    writeContractAsync: vi.fn(),
    data: undefined,
    isPending: false,
    reset: vi.fn(),
    error: null,
  }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn(), sendTransaction: vi.fn() }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, refetch: vi.fn(), isLoading: false, isError: false, error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
  useBalance: () => ({ data: undefined, refetch: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn(), chains: [] }),
  useConfig: () => ({}),
}));

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
// useTOWELIPrice rides for RealYieldProof, mounted on the swap tab since 2026-08-28.
vi.mock('../contexts/PriceContext', () => ({ useTOWELIPriceOptional: () => null, useTOWELIPrice: () => ({ price: null, loading: false, error: null }) }));
vi.mock('../hooks/useTowelie', () => ({ useTowelie: () => ({ say: vi.fn() }) }));

// The swap tab's own machinery is not what this file is about, and none of it renders
// while `?tab=trigger` is active — but the page body reads these fields on every render.
vi.mock('../hooks/useSwap', () => ({
  useSwap: () => ({
    fromToken: null,
    toToken: null,
    setFromToken: vi.fn(),
    setToToken: vi.fn(),
    inputAmount: '',
    outputFormatted: '',
    slippage: 0.5,
    // A MEASURED zero, not an unread one: the pair reads landed and the impact
    // really is 0. Unread is the other fact, and it is false here.
    priceImpact: 0,
    priceImpactUnread: false,
    hasTegridyPair: false,
    tegridyOutputFormatted: '',
    uniOutputFormatted: '',
    allAggQuotes: [],
    customTokens: [],
    addCustomToken: vi.fn(),
  }),
}));

import TradePage from './TradePage';
import { TRIGGER_KIND_LABELS } from '../lib/triggers/triggerPlan';

function renderTrade(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TradePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the trigger tab is reachable', () => {
  it('resolves ?tab=trigger and selects the tab', async () => {
    renderTrade('/swap?tab=trigger');
    const tab = await screen.findByRole('tab', { name: 'Trigger' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Trigger Order');
  });

  it('renders the panel inside the trigger tabpanel', async () => {
    renderTrade('/swap?tab=trigger');
    const panel = await screen.findByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'trade-panel-trigger');
    // The panel's own control set, so this is the real component and not a placeholder.
    expect(within(panel).getByRole('button', { name: TRIGGER_KIND_LABELS['stop-loss'] })).toBeInTheDocument();
  });

  it('offers every valid tab in the bar, so keyboard navigation cannot land on nothing', async () => {
    // `useTabListKeys` roves over VALID_TABS. The buttons used to be a second hardcoded
    // list; a tab in one and not the other is either an unreachable panel or an arrow
    // key that focuses a tab that does not exist.
    renderTrade('/swap?tab=trigger');
    const bar = await screen.findByRole('tablist');
    const labels = within(bar)
      .getAllByRole('tab')
      .map((b) => b.textContent);
    // 2026-09-03: 'Alerts' -> 'Limit'. That label was set while this tab WAS a
    // browser-only price watcher; it is now a real on-chain CoW order whose own
    // heading says "Limit Order", and /alerts in the nav is a different product.
    expect(labels).toEqual(['Swap', 'Liquidity', 'DCA', 'Limit', 'TWAP', 'Trigger']);
  });

  it('does not steal the default tab', () => {
    renderTrade('/swap');
    expect(screen.getByRole('tab', { name: 'Swap' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Trigger' })).toHaveAttribute('aria-selected', 'false');
  });
});

describe('mounting it did not arm it', () => {
  it('still says Not armed, with the reason in the panel body', async () => {
    renderTrade('/swap?tab=trigger');
    await waitFor(() => expect(screen.getByText(/runs no keeper yet/i)).toBeInTheDocument());
    expect(screen.getAllByText(/Not armed/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/It would not fire/i)).toBeInTheDocument();
  });

  it('offers no working placement button', async () => {
    renderTrade('/swap?tab=trigger');
    const button = await screen.findByRole('button', { name: /cannot be armed/i });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^arm /i })).toBeNull();
  });

  it('never describes the order as armed, monitoring or watching — including the page copy', async () => {
    // The page contributes a heading and a description above the panel, which the panel's
    // own suite never sees. They are held to the same rule.
    const { container } = renderTrade('/swap?tab=trigger');
    await waitFor(() => expect(screen.getByText(/runs no keeper yet/i)).toBeInTheDocument());
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\bmonitoring\b/i);
    expect(text).not.toMatch(/\bwatching the market\b/i);
    for (const m of text.matchAll(/armed/gi)) {
      const before = text.slice(Math.max(0, m.index! - 12), m.index!);
      expect(before, `"armed" used as a claim: …${before}`).toMatch(/not |be /i);
    }
  });
});
