import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { parseUnits, parseEther } from 'viem';

// ── Self-contained wagmi mock (useSwap uses useBalance which the shared
// scaffold at ../test-utils/wagmi-mocks doesn't export; rather than extend
// the scaffold and affect other tests, we inline a minimal mock here).
// `vi.hoisted` lets the factory reference state even though it's hoisted.
const wagmiState = vi.hoisted(() => {
  return {
    chainId: 1,
    account: { address: undefined as `0x${string}` | undefined, isConnected: false },
    writeStatus: { isPending: false, isConfirming: false, isSuccess: false, isTxError: false, hash: undefined as `0x${string}` | undefined },
    writeContractMock: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
    ethBalance: undefined as { value: bigint; decimals: number } | undefined,
    tokenBalance: 0n as bigint,
    // FE-HIGH-6: addCustomToken re-verifies symbol/decimals on-chain before
    // adding. Tests configure the "on-chain" ERC20 shape the mock returns.
    erc20Shape: { symbol: 'FOO', decimals: 18 } as { symbol: string; decimals: number },
  };
});

vi.mock('wagmi', async () => {
  const { vi: vitest } = await import('vitest');
  if (!wagmiState.writeContractMock) wagmiState.writeContractMock = vitest.fn();
  return {
    useAccount: () => ({
      address: wagmiState.account.address,
      isConnected: wagmiState.account.isConnected,
      chain: { id: wagmiState.chainId },
    }),
    useChainId: () => wagmiState.chainId,
    useReadContract: (opts: { functionName?: string }) => {
      if (opts?.functionName === 'balanceOf') {
        return { data: wagmiState.tokenBalance, error: undefined, isLoading: false, isError: false, refetch: vitest.fn() };
      }
      return { data: undefined, error: undefined, isLoading: false, isError: false, refetch: vitest.fn() };
    },
    useReadContracts: (opts: { contracts?: unknown[] }) => ({
      data: (opts?.contracts ?? []).map(() => ({ status: 'failure' as const, error: new Error('no stub') })),
      error: undefined,
      isLoading: false,
      isError: false,
      refetch: vitest.fn(),
    }),
    useBalance: () => ({ data: wagmiState.ethBalance, refetch: vitest.fn() }),
    useWriteContract: () => ({
      writeContract: wagmiState.writeContractMock,
      data: wagmiState.writeStatus.hash,
      isPending: wagmiState.writeStatus.isPending,
      error: wagmiState.writeStatus.isTxError ? new Error('write failed') : undefined,
      reset: vitest.fn(),
    }),
    useWaitForTransactionReceipt: () => ({
      isLoading: wagmiState.writeStatus.isConfirming,
      isSuccess: wagmiState.writeStatus.isSuccess,
      isError: wagmiState.writeStatus.isTxError,
    }),
    // AUDIT (Wave-2 2026-05-20): added when useSwap began consuming
    // `usePublicClient` for direct `viemClient.readContract` calls — the
    // mock previously omitted it, blowing up at hook construction.
    usePublicClient: () => ({
      // FE-HIGH-6 verification reads symbol()/decimals(); resolve them from
      // the configurable shape so import-verification can pass in tests.
      readContract: vitest.fn().mockImplementation(({ functionName }: { functionName?: string }) => {
        if (functionName === 'symbol') return Promise.resolve(wagmiState.erc20Shape.symbol);
        if (functionName === 'decimals') return Promise.resolve(wagmiState.erc20Shape.decimals);
        return Promise.resolve(0n);
      }),
      multicall: vitest.fn().mockResolvedValue([]),
    }),
  };
});

// ── Top-level stubs for modules imported by the hook ────────────────────
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));
vi.mock('../lib/analytics', () => ({ trackSwap: vi.fn() }));
vi.mock('../lib/revertDecoder', () => ({ decodeRevertReason: (e: Error) => e?.message ?? 'err' }));

// ── Controllable mocks for the two composed sub-hooks ────────────────────
type RouteSource = 'tegridy' | 'uniswap' | 'aggregator';
interface QuoteShape {
  outputAmount: bigint;
  outputFormatted: string;
  priceImpact: number | null;
  priceImpactUnread: boolean;
  minimumReceived: bigint;
  minimumReceivedFormatted: string;
  isQuoteLoading: boolean;
  selectedRoute: RouteSource;
  selectedOnChainRoute: { source: 'tegridy' | 'uniswap'; output: bigint };
  hasTegridyPair: boolean;
  tegridyOutputFormatted: string | null;
  uniOutputFormatted: string | null;
  aggBetter: boolean;
  aggOutputFormatted: string | null;
  bestAggregatorName: string | null;
  allAggQuotes: never[];
  routeDescription: string[];
  routeLabel: string;
  hasDirectPair: boolean;
  intermediateAmount: bigint | undefined;
  path: `0x${string}`[];
}

const defaultQuote = (): QuoteShape => ({
  outputAmount: 1000n * 10n ** 18n,
  outputFormatted: '1000',
  priceImpact: 0.5,
  priceImpactUnread: false,
  minimumReceived: 990n * 10n ** 18n,
  minimumReceivedFormatted: '990',
  isQuoteLoading: false,
  selectedRoute: 'uniswap',
  selectedOnChainRoute: { source: 'uniswap', output: 1000n * 10n ** 18n },
  hasTegridyPair: true,
  tegridyOutputFormatted: '1000',
  uniOutputFormatted: '1000',
  aggBetter: false,
  aggOutputFormatted: null,
  bestAggregatorName: null,
  allAggQuotes: [],
  routeDescription: ['Uniswap V2'],
  routeLabel: 'Uniswap V2',
  hasDirectPair: true,
  intermediateAmount: undefined,
  path: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
});

const quoteState: { current: QuoteShape } = { current: defaultQuote() };

const allowanceState = {
  needsApproval: false,
  approveMock: vi.fn(),
  unlimitedApproval: false,
  toggleMock: vi.fn(),
  refetchMock: vi.fn(),
};

// AUDIT (Wave-2 2026-05-20): mock the full surface useSwap actually imports.
// `QUOTE_MAX_AGE_MS` was added as a named export on useSwapQuote after this
// mock was first written; without it the test fails at module load.
vi.mock('./useSwapQuote', () => ({
  useSwapQuote: () => quoteState.current,
  QUOTE_MAX_AGE_MS: 30_000,
}));

vi.mock('./useSwapAllowance', () => ({
  useSwapAllowance: () => ({
    needsApproval: allowanceState.needsApproval,
    approve: allowanceState.approveMock,
    unlimitedApproval: allowanceState.unlimitedApproval,
    toggleUnlimitedApproval: allowanceState.toggleMock,
    refetchAllowance: allowanceState.refetchMock,
  }),
}));

// ── Import hook + constants AFTER mocks ─────────────────────────────────
import { useSwap, BLOCKED_PRICE_IMPACT_PCT } from './useSwap';
import { DEFAULT_TOKENS } from '../lib/tokenList';
import {
  CHAIN_ID,
  SWAP_FEE_ROUTER_ADDRESS,
  UNISWAP_V2_ROUTER,
} from '../lib/constants';

const USER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const ETH = DEFAULT_TOKENS.find((t) => t.symbol === 'ETH')!;
const TOWELI = DEFAULT_TOKENS.find((t) => t.symbol === 'TOWELI')!;
const USDC = DEFAULT_TOKENS.find((t) => t.symbol === 'USDC')!;

function resetWagmi() {
  wagmiState.chainId = CHAIN_ID;
  wagmiState.account = { address: USER, isConnected: true };
  wagmiState.writeStatus = { isPending: false, isConfirming: false, isSuccess: false, isTxError: false, hash: undefined };
  wagmiState.ethBalance = { value: parseEther('5'), decimals: 18 };
  wagmiState.tokenBalance = parseUnits('1000000', 18); // plenty
  wagmiState.erc20Shape = { symbol: 'FOO', decimals: 18 };
  wagmiState.writeContractMock.mockReset();
}

describe('useSwap', () => {
  beforeEach(() => {
    resetWagmi();
    quoteState.current = defaultQuote();
    allowanceState.needsApproval = false;
    allowanceState.unlimitedApproval = false;
    allowanceState.approveMock.mockReset();
    allowanceState.toggleMock.mockReset();
    allowanceState.refetchMock.mockReset();
    try { window.localStorage.clear(); } catch { /* jsdom only */ }
  });

  // ────────────── Read-side / state ──────────────────────────────────────

  it('initializes with ETH → TOWELI default pair', () => {
    const { result } = renderHook(() => useSwap());
    expect(result.current.fromToken?.symbol).toBe('ETH');
    expect(result.current.toToken?.symbol).toBe('TOWELI');
    expect(result.current.swapType).toBe('ethForTokens');
    expect(result.current.inputAmount).toBe('');
  });

  it('propagates quote fields from useSwapQuote', () => {
    quoteState.current = {
      ...defaultQuote(),
      outputFormatted: '42.5',
      priceImpact: 1.23,
      minimumReceivedFormatted: '41.9',
      routeLabel: 'Tegridy DEX',
      selectedRoute: 'tegridy',
    };
    const { result } = renderHook(() => useSwap());
    expect(result.current.outputFormatted).toBe('42.5');
    expect(result.current.priceImpact).toBe(1.23);
    expect(result.current.minimumReceived).toBe('41.9');
    expect(result.current.routeLabel).toBe('Tegridy DEX');
    expect(result.current.selectedRoute).toBe('tegridy');
  });

  it('clamps slippage above 20% to the 20 cap', () => {
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setSlippage(49));
    expect(result.current.slippage).toBe(20);
  });

  it('clamps negative slippage to 0', () => {
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setSlippage(-5));
    expect(result.current.slippage).toBe(0);
  });

  it('accepts slippage inside the allowed range', () => {
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setSlippage(2.5));
    expect(result.current.slippage).toBe(2.5);
  });

  it('flipDirection swaps from/to and carries the entered amount (F240)', () => {
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1.5'));
    expect(result.current.inputAmount).toBe('1.5');
    act(() => result.current.flipDirection());
    expect(result.current.fromToken?.symbol).toBe('TOWELI');
    expect(result.current.toToken?.symbol).toBe('ETH');
    // F240: the amount is transposed across the flip (Uniswap behavior) instead
    // of being cleared to placeholder, so the trade intent is preserved.
    expect(result.current.inputAmount).toBe('1.5');
  });

  it('swapType reflects token selection (tokensForEth)', () => {
    const { result } = renderHook(() => useSwap());
    act(() => {
      result.current.setFromToken(TOWELI);
      result.current.setToToken(ETH);
    });
    expect(result.current.swapType).toBe('tokensForEth');
  });

  it('swapType reflects token selection (tokensForTokens)', () => {
    const { result } = renderHook(() => useSwap());
    act(() => {
      result.current.setFromToken(TOWELI);
      result.current.setToToken(USDC);
    });
    expect(result.current.swapType).toBe('tokensForTokens');
  });

  it('addCustomToken appends unique token and dedupes by address', async () => {
    // FE-HIGH-6 made addCustomToken async (on-chain symbol/decimals
    // re-verification before adding) — both calls must be awaited inside
    // act, or the floating verification promise leaks act() scope into
    // every subsequent test and nulls their renders.
    const { result } = renderHook(() => useSwap());
    const token = {
      address: '0x1234567890123456789012345678901234567890',
      symbol: 'FOO',
      name: 'Foo Token',
      decimals: 18,
      logoURI: '',
    };
    await act(async () => { await result.current.addCustomToken(token); });
    await act(async () => { await result.current.addCustomToken({ ...token, address: token.address.toUpperCase() }); });
    expect(result.current.customTokens).toHaveLength(1);
    expect(result.current.customTokens[0].symbol).toBe('FOO');
  });

  it('addCustomToken REFUSES a token whose on-chain shape mismatches (FE-HIGH-6)', async () => {
    const { result } = renderHook(() => useSwap());
    wagmiState.erc20Shape = { symbol: 'NOT-FOO', decimals: 18 };
    await act(async () => {
      await result.current.addCustomToken({
        address: '0x1234567890123456789012345678901234567890',
        symbol: 'FOO',
        name: 'Foo Token',
        decimals: 18,
        logoURI: '',
      });
    });
    expect(result.current.customTokens).toHaveLength(0);
  });

  // ────────────── Guards: do-nothing paths ──────────────────────────────

  it('executeSwap no-ops when inputAmount is empty', () => {
    const { result } = renderHook(() => useSwap());
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();
  });

  it('executeSwap no-ops on wrong network', () => {
    wagmiState.chainId = 11155111; // sepolia
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();
  });

  it('executeSwap no-ops when needsApproval is true', () => {
    allowanceState.needsApproval = true;
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();
  });

  it('executeSwap no-ops when outputAmount is zero (no quote)', () => {
    quoteState.current = { ...defaultQuote(), outputAmount: 0n, minimumReceived: 0n };
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();
  });

  it('executeSwap no-ops when swapping a token for itself', () => {
    const { result } = renderHook(() => useSwap());
    act(() => {
      result.current.setFromToken(TOWELI);
      result.current.setToToken(TOWELI);
      result.current.setInputAmount('1');
    });
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();
  });

  // 2026-11-01: Base's BNKR V2 pool quoted 1.75M BNKR at 99.99% impact and the
  // swap still signed. Uniswap's interface refuses at 15%; so does this.
  it('executeSwap refuses at or above 15% price impact, and says so', () => {
    quoteState.current = { ...defaultQuote(), priceImpact: 99.99 };
    const { result } = renderHook(() => useSwap());
    expect(result.current.impactBlocked).toBe(true);
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();

    quoteState.current = { ...defaultQuote(), priceImpact: BLOCKED_PRICE_IMPACT_PCT };
    const edge = renderHook(() => useSwap());
    expect(edge.result.current.impactBlocked).toBe(true);
  });

  it('executeSwap still signs just under 15%, and an unread impact is not a block', () => {
    quoteState.current = { ...defaultQuote(), priceImpact: 14.99 };
    const { result } = renderHook(() => useSwap());
    expect(result.current.impactBlocked).toBe(false);
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).toHaveBeenCalledTimes(1);

    quoteState.current = { ...defaultQuote(), priceImpact: null, priceImpactUnread: true };
    expect(renderHook(() => useSwap()).result.current.impactBlocked).toBe(false);
  });

  // ────────────── Action-side: writeContract args ───────────────────────

  it('ETH→TOKEN via uniswap route targets the real Uniswap router with value and no maxFeeBps', () => {
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('0.5'));
    act(() => result.current.executeSwap());
    const write = wagmiState.writeContractMock;
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0][0];
    expect(call.address).toBe(UNISWAP_V2_ROUTER);
    expect(call.functionName).toBe('swapExactETHForTokens');
    expect(call.value).toBe(parseEther('0.5'));
    expect(call.args[0]).toBe(990n * 10n ** 18n); // minimumReceived from quote
    expect(call.args[2]).toBe(USER);
    expect(call.args).toHaveLength(4); // Uniswap router takes no maxFeeBps
  });

  it('ETH→TOKEN via tegridy route targets SWAP_FEE_ROUTER with maxFeeBps (fee capture)', () => {
    quoteState.current = {
      ...defaultQuote(),
      selectedRoute: 'tegridy',
      selectedOnChainRoute: { source: 'tegridy', output: 1000n * 10n ** 18n },
    };
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    const write = wagmiState.writeContractMock;
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0][0];
    expect(call.address).toBe(SWAP_FEE_ROUTER_ADDRESS);
    expect(call.functionName).toBe('swapExactETHForTokens');
    expect(call.value).toBe(parseEther('1'));
    expect(call.args).toHaveLength(5); // [minOut, path, to, deadline, maxFeeBps]
    expect(call.args[4]).toBe(100n);
  });

  it('TOKEN→ETH via uniswap route uses swapExactTokensForETH on the real Uniswap router', () => {
    const { result } = renderHook(() => useSwap());
    act(() => {
      result.current.setFromToken(TOWELI);
      result.current.setToToken(ETH);
      result.current.setInputAmount('10');
    });
    act(() => result.current.executeSwap());
    const call = wagmiState.writeContractMock.mock.calls[0][0];
    expect(call.address).toBe(UNISWAP_V2_ROUTER);
    expect(call.functionName).toBe('swapExactTokensForETH');
    expect(call.value).toBeUndefined();
    expect(call.args[0]).toBe(parseUnits('10', 18));
    expect(call.args).toHaveLength(5); // [amountIn, minOut, path, to, deadline] — no maxFeeBps
  });

  it('TOKEN→TOKEN via tegridy uses swapExactTokensForTokens on SWAP_FEE_ROUTER (fee capture)', () => {
    quoteState.current = {
      ...defaultQuote(),
      selectedRoute: 'tegridy',
      selectedOnChainRoute: { source: 'tegridy', output: 500n * 10n ** 18n },
    };
    const { result } = renderHook(() => useSwap());
    act(() => {
      result.current.setFromToken(TOWELI);
      result.current.setToToken(USDC);
      result.current.setInputAmount('3.25');
    });
    act(() => result.current.executeSwap());
    const call = wagmiState.writeContractMock.mock.calls[0][0];
    expect(call.address).toBe(SWAP_FEE_ROUTER_ADDRESS);
    expect(call.functionName).toBe('swapExactTokensForTokens');
    expect(call.args[0]).toBe(parseUnits('3.25', 18));
    expect(call.args).toHaveLength(6); // [amountIn, minOut, path, to, deadline, maxFeeBps]
    expect(call.args[5]).toBe(100n);
  });

  it('aggregator route with tegridy on-chain source routes through SWAP_FEE_ROUTER (fee capture)', () => {
    quoteState.current = {
      ...defaultQuote(),
      selectedRoute: 'aggregator',
      selectedOnChainRoute: { source: 'tegridy', output: 2000n * 10n ** 18n },
      outputAmount: 2100n * 10n ** 18n,
      minimumReceived: 2079n * 10n ** 18n,
    };
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    const call = wagmiState.writeContractMock.mock.calls[0][0];
    expect(call.address).toBe(SWAP_FEE_ROUTER_ADDRESS);
    expect(call.functionName).toBe('swapExactETHForTokens');
    expect(call.args).toHaveLength(5); // [minOut, path, to, deadline, maxFeeBps]
    expect(call.args[4]).toBe(100n);
  });

  it('aggregator route with uniswap on-chain source routes through the real Uniswap router', () => {
    quoteState.current = {
      ...defaultQuote(),
      selectedRoute: 'aggregator',
      selectedOnChainRoute: { source: 'uniswap', output: 2000n * 10n ** 18n },
    };
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    const call = wagmiState.writeContractMock.mock.calls[0][0];
    expect(call.address).toBe(UNISWAP_V2_ROUTER);
    expect(call.args).toHaveLength(4); // ethForTokens on Uniswap — no maxFeeBps
  });

  it('aggregator route recomputes minimumReceived from on-chain output using slippage', () => {
    quoteState.current = {
      ...defaultQuote(),
      selectedRoute: 'aggregator',
      selectedOnChainRoute: { source: 'uniswap', output: 1000n * 10n ** 18n },
    };
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setSlippage(1)); // 1% = 100 bps
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    const call = wagmiState.writeContractMock.mock.calls[0][0];
    // onChainOutput (1000e18) * (10000 - 100) / 10000 = 990e18
    expect(call.args[0]).toBe(990n * 10n ** 18n);
  });

  // ────────────── Passthroughs / misc ───────────────────────────────────

  it('exposes allowance helpers from the sub-hook', () => {
    const { result } = renderHook(() => useSwap());
    act(() => result.current.approve());
    expect(allowanceState.approveMock).toHaveBeenCalledTimes(1);
    act(() => result.current.refetchAllowance());
    expect(allowanceState.refetchMock).toHaveBeenCalledTimes(1);
  });

  it('exposes write status flags from the wagmi mock (isPending)', () => {
    wagmiState.writeStatus.isPending = true;
    const { result } = renderHook(() => useSwap());
    expect(result.current.isPending).toBe(true);
    expect(result.current.isConfirming).toBe(false);
  });
});

describe('useSwap on Base and Robinhood Chain (2026-10-17)', () => {
  const BASE_SFR = '0xa24C7287eC56A7DEFDc70033803451240e267a52';
  const BASE_UNI = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
  const RH_SFR = '0xE9F83A07b071748E795d2489651d5310fA098Db8';
  const RH_UNI = '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba';
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  beforeEach(() => {
    resetWagmi();
    quoteState.current = defaultQuote();
    allowanceState.needsApproval = false;
    try { window.localStorage.clear(); } catch { /* jsdom only */ }
  });

  it.each([
    [8453, 'tegridy', BASE_SFR, 5],
    [8453, 'uniswap', BASE_UNI, 4],
    [4663, 'tegridy', RH_SFR, 5],
    [4663, 'uniswap', RH_UNI, 4],
  ] as const)('chain %i, %s route: signs on that chain at that chain\'s router', (chain, route, router, argCount) => {
    wagmiState.chainId = chain;
    quoteState.current = { ...defaultQuote(), selectedRoute: route, selectedOnChainRoute: { source: route, output: 1000n * 10n ** 18n } };
    const { result } = renderHook(() => useSwap({ chainId: chain }));
    // Robinhood opens with nothing to receive; pick a token on both chains alike.
    act(() => result.current.setToToken({ address: '0x4444444444444444444444444444444444444444', symbol: 'FOO', name: 'Foo', decimals: 18, logoURI: '' }));
    act(() => result.current.setInputAmount('0.5'));
    act(() => result.current.executeSwap());
    const write = wagmiState.writeContractMock;
    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0][0];
    expect(call.chainId).toBe(chain);
    expect(call.address).toBe(router);
    expect(call.functionName).toBe('swapExactETHForTokens');
    expect(call.args).toHaveLength(argCount);
  });

  it('refuses a wallet on Ethereum when the form is on Base, naming Base', async () => {
    const { toast } = await import('sonner');
    wagmiState.chainId = 1;
    const { result } = renderHook(() => useSwap({ chainId: 8453 }));
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Please switch to Base');
  });

  it('opens Base on ETH to Circle USDC, and Robinhood on ETH to Global Dollar (USDG)', () => {
    wagmiState.chainId = 8453;
    const base = renderHook(() => useSwap({ chainId: 8453 })).result.current;
    expect(base.fromToken?.isNative).toBe(true);
    expect(base.toToken?.address).toBe(BASE_USDC);
    expect(base.swapChainId).toBe(8453);
    wagmiState.chainId = 4663;
    const rh = renderHook(() => useSwap({ chainId: 4663 })).result.current;
    expect(rh.fromToken?.isNative).toBe(true);
    // From the Uniswap Labs Default list, read on chain 2026-10-18 (lib/tokenList.ts).
    expect(rh.toToken?.address).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    expect(rh.toToken?.symbol).toBe('USDG');
  });

  it('resets the pair and the amount when the form moves to another chain', () => {
    const { result, rerender } = renderHook(({ chain }: { chain: number }) => useSwap({ chainId: chain }), { initialProps: { chain: 1 } });
    expect(result.current.toToken?.symbol).toBe('TOWELI');
    act(() => result.current.setInputAmount('2'));
    rerender({ chain: 8453 });
    expect(result.current.toToken?.address).toBe(BASE_USDC);
    expect(result.current.inputAmount).toBe('');
    expect(result.current.swapChainId).toBe(8453);
  });

  it('keeps each chain\'s imported tokens under that chain\'s own key', () => {
    window.localStorage.setItem('tegridy_custom_tokens_v2_8453', JSON.stringify([{ address: '0x3333333333333333333333333333333333333333', symbol: 'BASEFOO', name: 'Base Foo', decimals: 18, logoURI: '' }]));
    const { result, rerender } = renderHook(({ chain }: { chain: number }) => useSwap({ chainId: chain }), { initialProps: { chain: 1 } });
    expect(result.current.customTokens).toEqual([]);
    rerender({ chain: 8453 });
    expect(result.current.customTokens.map((t) => t.symbol)).toEqual(['BASEFOO']);
    // Ethereum's key was never written with Base's list.
    expect(window.localStorage.getItem('tegridy_custom_tokens_v2_1')).toBe('[]');
  });

  it('without a chain, still swaps on Ethereum only, as the quick-buy panel relies on', () => {
    wagmiState.chainId = 8453;
    const { result } = renderHook(() => useSwap());
    act(() => result.current.setInputAmount('1'));
    act(() => result.current.executeSwap());
    expect(wagmiState.writeContractMock).not.toHaveBeenCalled();
    expect(result.current.swapChainId).toBe(CHAIN_ID);
  });
});
