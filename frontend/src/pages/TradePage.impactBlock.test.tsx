// THE 15% BLOCK, PROVEN ON THE PAGE.
//
// useSwap.test.ts proves executeSwap refuses at or above BLOCKED_PRICE_IMPACT_PCT.
// This proves the page says so: the Swap button is off and names why, and the soft
// "High price impact!" line gives way to a plain refusal. 2026-11-01, Base: 1.75M BNKR
// quoted 0.0000011 ETH out of a dust Uniswap V2 pool (~0.22 ETH at market) and the
// button stayed live.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111' }),
  useChainId: () => 1,
  usePublicClient: () => ({ getCode: async () => '0x' }),
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
vi.mock('../contexts/PriceContext', () => ({ useTOWELIPriceOptional: () => null, useTOWELIPrice: () => ({ price: null, loading: false, error: null }) }));
vi.mock('../hooks/useTowelie', () => ({ useTowelie: () => ({ say: vi.fn() }) }));

const BNKR = { address: '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b', symbol: 'BNKR', name: 'BankrCoin', decimals: 18, logoURI: '' };
const ETH = { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: '', isNative: true };

const state = { priceImpact: 99.99 as number | null, impactBlocked: true };

vi.mock('../hooks/useSwap', () => ({
  useSwap: () => ({
    fromToken: BNKR,
    toToken: ETH,
    setFromToken: vi.fn(),
    setToToken: vi.fn(),
    inputAmount: '1750000',
    setInputAmount: vi.fn(),
    outputFormatted: '0.000001072065705933',
    outputAmount: 1_072_065_705_933n,
    slippage: 1,
    setSlippage: vi.fn(),
    priceImpact: state.priceImpact,
    priceImpactUnread: false,
    impactBlocked: state.impactBlocked,
    minimumReceived: '0.000001061345048873',
    routeLabel: 'Direct swap via Uniswap V2',
    selectedRoute: 'uniswap',
    bestAggregatorName: null,
    isQuoteLoading: false,
    needsApproval: false,
    insufficientBalance: false,
    isPending: false,
    isConfirming: false,
    isSuccess: false,
    txHash: undefined,
    executeSwap: vi.fn(),
    approve: vi.fn(),
    flipDirection: vi.fn(),
    fromBalance: '3500000',
    toBalance: '0.002',
    hasTegridyPair: false,
    tegridyOutputFormatted: null,
    uniOutputFormatted: '0.000001072065705933',
    allAggQuotes: [],
    customTokens: [],
    addCustomToken: vi.fn(),
    isFromTokenCustom: false,
    isToTokenCustom: false,
    supportsFeeOnTransfer: false,
    setSupportsFeeOnTransfer: vi.fn(),
    swapChainId: 8453,
    venue: { chainId: 8453, name: 'Base' },
  }),
}));

import TradePage from './TradePage';

function renderSwap() {
  return render(
    <MemoryRouter initialEntries={['/swap?c=8453']}>
      <TradePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the swap page at 15%+ price impact', () => {
  it('turns the Swap button off, names why, and refuses in plain words', () => {
    state.priceImpact = 99.99;
    state.impactBlocked = true;
    renderSwap();
    const button = screen.getByRole('button', { name: 'Price impact too high' });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('swap-impact-blocked').textContent).toContain('this pool is too thin');
    expect(screen.queryByText(/High price impact! Consider reducing/)).toBeNull();
  });

  it('under the block, Swap stays live and the 5% warning still shows', () => {
    state.priceImpact = 6;
    state.impactBlocked = false;
    renderSwap();
    expect(screen.getByRole('button', { name: 'Swap' })).toBeEnabled();
    expect(screen.queryByTestId('swap-impact-blocked')).toBeNull();
    expect(screen.getByText(/High price impact! Consider reducing/)).toBeInTheDocument();
  });
});
