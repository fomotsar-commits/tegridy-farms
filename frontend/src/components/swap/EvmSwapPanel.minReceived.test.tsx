/**
 * The Ethereum swap's "Min. Received" is the floor the transaction enforces
 * (useSwapQuote's minimumReceived, sent as minOut). It is printed CUT, so it never
 * reads above that floor; "You receive" and each route's output are cut the same way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatUnits } from 'viem';

const h = vi.hoisted(() => ({ swap: {} as Record<string, unknown> }));

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: false }) }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../../hooks/useSwap', () => ({ useSwap: () => h.swap }));
vi.mock('../../contexts/PriceContext', () => ({ useTOWELIPriceOptional: () => null }));
vi.mock('../../hooks/useTowelie', () => ({ useTowelie: () => ({ say: vi.fn() }) }));
vi.mock('./CowSwapPanel', () => ({ CowSwapPanel: () => null }));
vi.mock('./MevProtectionPanel', () => ({ MevProtectionPanel: () => null }));
vi.mock('./TokenSelectModal', () => ({ TokenSelectModal: () => null }));
vi.mock('./IslandBasketEvm', () => ({ IslandBasketEvm: () => null }));
vi.mock('../RealYieldProof', () => ({ RealYieldProof: () => null }));
vi.mock('../ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../ui/CardArt', () => ({ CardArt: () => null }));

import { EvmSwapPanel } from './EvmSwapPanel';

const ETH = { symbol: 'ETH', name: 'Ether', address: '0x0000000000000000000000000000000000000000', decimals: 18, isNative: true };
const TOWELI = { symbol: 'TOWELI', name: 'Towelie', address: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D', decimals: 18 };

function swapWith(minimumReceivedRaw: bigint) {
  return {
    addCustomToken: vi.fn(), allAggQuotes: [], approve: vi.fn(), bestAggregatorName: null, customTokens: [],
    executeSwap: vi.fn(), flipDirection: vi.fn(), fromBalance: '2', fromToken: ETH, hasTegridyPair: false, impactBlocked: false,
    inputAmount: '1', insufficientBalance: false, isConfirming: false, isFromTokenCustom: false, isPending: false,
    isQuoteLoading: false, isSuccess: false, isToTokenCustom: false,
    minimumReceived: formatUnits(minimumReceivedRaw, 18), needsApproval: false, outputAmount: 10n ** 21n,
    outputFormatted: '1284.56789', priceImpact: 0.1, priceImpactUnread: false, routeLabel: 'Uniswap V2', selectedRoute: 'uniswap',
    setFromToken: vi.fn(), setInputAmount: vi.fn(), setSlippage: vi.fn(), setSupportsFeeOnTransfer: vi.fn(), setToToken: vi.fn(),
    slippage: 0.5, supportsFeeOnTransfer: false, swapChainId: 1, tegridyOutputFormatted: '', toBalance: '0', toToken: TOWELI,
    txHash: undefined, uniOutputFormatted: '', venue: { name: 'Ethereum' },
  };
}

/** The Min. Received row's figure, in wei. */
function minShownWei(): bigint {
  const row = screen.getByText('Min. Received').parentElement!;
  const said = /([\d,]+\.\d+)\s+TOWELI/.exec(row.textContent ?? '')![1]!.replace(/,/g, '');
  const [whole, frac] = said.split('.');
  return BigInt(whole! + frac!.padEnd(18, '0'));
}

beforeEach(() => {
  h.swap = swapWith(1_234_567_890_000_000_000_000n);
});

describe('EvmSwapPanel: Min. Received never reads above the floor the swap enforces', () => {
  it('cuts 1,234.56789 to 1,234.5678, never 1,234.5679', () => {
    render(<MemoryRouter><EvmSwapPanel chainId={1} /></MemoryRouter>);
    expect(screen.getByText('Min. Received').parentElement).toHaveTextContent('1,234.5678 TOWELI');
    expect(minShownWei()).toBeLessThanOrEqual(1_234_567_890_000_000_000_000n);
  });

  it('over floors with every last digit, the figure is at or under the floor and less than 0.0001 under it', () => {
    for (const raw of [999_999_999_999_999_999n, 1_000_000_049_999_999_999_999n, 75_000_000_999_999_999_999_999_999n, 10n ** 18n + 1n]) {
      h.swap = swapWith(raw);
      const { unmount } = render(<MemoryRouter><EvmSwapPanel chainId={1} /></MemoryRouter>);
      const shown = minShownWei();
      expect(shown, String(raw)).toBeLessThanOrEqual(raw);
      expect(raw - shown, String(raw)).toBeLessThan(10n ** 14n);
      unmount();
    }
  });
});
