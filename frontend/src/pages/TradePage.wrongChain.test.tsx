// THE SWAP PAGE FOLLOWS THE NETWORK PICKED, AND SAYS SO TO A WALLET LEFT BEHIND.
//
// `?c=` names the page's network over a connected wallet (useSwapChainId). Swap signs on
// that network; DCA, Limit, TWAP and Trigger sign on Ethereum only. So the wrong-network
// banner speaks for the Swap tab wherever it is, and for the other tabs only on Ethereum:
// off Ethereum those tabs are ChainSwapAvailability's ("Only Swap runs on Base"), and a
// banner there would tell a wallet on Ethereum, which can use them, to leave.
//
// The mocks are TradePage.trigger.test.tsx's, with the wallet's network made settable.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const wallet = vi.hoisted(() => ({ chainId: 1 }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111' }),
  useChainId: () => wallet.chainId,
  useChains: () => [{ id: 1, name: 'Ethereum' }, { id: 8453, name: 'Base' }, { id: 4663, name: 'Robinhood Chain' }],
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
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false, chains: [] }),
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
// What the DCA form says is its own suite's; here only the page around it matters.
vi.mock('../components/swap/DCATab', () => ({ DCATab: () => <p>the DCA form</p> }));

vi.mock('../hooks/useSwap', () => ({
  useSwap: ({ chainId }: { chainId: number }) => ({
    swapChainId: chainId,
    fromToken: null,
    toToken: null,
    setFromToken: vi.fn(),
    setToToken: vi.fn(),
    inputAmount: '',
    outputFormatted: '',
    slippage: 0.5,
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

function renderTrade(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TradePage />
    </MemoryRouter>,
  );
}

const banner = () => screen.queryByText('Your wallet is on another network. Switch it to trade here.');

beforeEach(() => {
  wallet.chainId = 1;
});

describe('the swap page follows the network picked', () => {
  it('tells a wallet on Ethereum to switch to the Base it picked, on the Swap tab', () => {
    renderTrade('/swap?c=8453');
    expect(banner()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Base' })).toBeInTheDocument();
  });

  it('says nothing when the wallet is on the network picked', () => {
    wallet.chainId = 8453;
    renderTrade('/swap?c=8453');
    expect(banner()).toBeNull();
  });

  it('on DCA with Ethereum picked, tells a wallet on Base to switch to Ethereum', () => {
    wallet.chainId = 8453;
    renderTrade('/swap?c=1&tab=dca');
    expect(banner()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Ethereum' })).toBeInTheDocument();
  });

  it('on DCA with Base picked, leaves it to the "Only Swap runs on Base" notice', () => {
    renderTrade('/swap?c=8453&tab=dca');
    expect(screen.getByText('Only Swap runs on Base')).toBeInTheDocument();
    expect(banner()).toBeNull();
  });
});
