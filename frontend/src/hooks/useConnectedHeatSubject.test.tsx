// The wallet the heat card and Bayla's line both read (the owner's phone, 2026-11-11): one wallet
// is itself; two are read and the warmest speaks; an Ethereum account waits for a Solana wallet
// this browser is still restoring. And his screen itself: the card and the line, mounted together.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HeatReading } from '../lib/heat/heatOracle';

const SOL = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw';
const EVM = '0x71be63f3384f5fb98995898a86b02fb2426c5788';

const h = vi.hoisted(() => ({
  evm: undefined as string | undefined,
  sol: null as string | null,
  /** The Solana connection as its code reports it with no wallet connected: null until that code has reported at all. */
  noWallet: null as null | { connecting: boolean },
  ownFailed: false,
  restore: false,
  fetchHeat: vi.fn(),
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ address: h.evm }) }));
vi.mock('../lib/solanaSurface', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/solanaSurface')>()),
  useSolanaSurface: () => ({
    surface: h.sol ? { address: h.sol, open: () => {}, connecting: false } : h.noWallet ? { address: null, open: () => {}, connecting: h.noWallet.connecting } : null,
    ownFailed: h.ownFailed,
  }),
  solanaToRestore: () => h.restore,
}));
vi.mock('../lib/heat/heatClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/heat/heatClient')>()),
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
}));
vi.mock('./useIslandTorches', () => ({ useIslandTorches: () => ({ warming: 32 }) }));
vi.mock('../lib/heat/flamesClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/heat/flamesClient')>()),
  fetchFlames: vi.fn(async () => []),
}));

import { SOLANA_RESTORE_LIMIT_MS, resetConnectedHeatSubjectForTests, useConnectedHeatSubject } from './useConnectedHeatSubject';
import { SOLANA_CONNECT_WAIT_NOTICE_MS } from '../lib/solanaSurface';
import { setLastReading } from '../lib/heat/heatStore';
import { __resetFire } from '../lib/fire';
import { clearLanded } from '../lib/landed';
import { clearScreenMoves } from '../lib/screenMove';
import { BaylaLine } from '../components/BaylaLine';
import { HeatCard } from '../components/HeatCard';

const NOW = Math.floor(Date.now() / 1000);
function reading(address: string, degrees: number): HeatReading {
  const cold = degrees === 0;
  return {
    address,
    degrees,
    tier: degrees >= 800 ? 'Elder' : degrees >= 80 ? 'Resident' : 'Drifter',
    isCold: cold,
    heldSinceUnix: cold ? null : 1_642_281_378,
    asOfUnix: cold ? null : NOW - 3_600,
    tokenCount: cold ? 0 : 14,
    breakdown: [],
    observedAt: NOW,
    xHandle: null,
    daysToNextTier: null,
    daysToPlant: cold ? null : 0,
  };
}
/** The island's answers on his phone: the Solana wallet an Elder, the Ethereum account empty. */
const hisPhone = async (address: string) => reading(address, address === SOL ? 1862.42 : 0);

beforeEach(() => {
  localStorage.clear();
  h.evm = undefined;
  h.sol = null;
  h.noWallet = null;
  h.ownFailed = false;
  h.restore = false;
  h.fetchHeat.mockReset();
  h.fetchHeat.mockImplementation(hisPhone);
  resetConnectedHeatSubjectForTests();
  setLastReading(null);
  clearLanded();
  clearScreenMoves();
  __resetFire();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"sealed"}', { status: 502 })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useConnectedHeatSubject', () => {
  it('no wallet: nothing', () => {
    expect(renderHook(() => useConnectedHeatSubject()).result.current).toBeNull();
  });

  it('one wallet is itself, and nothing is read to say so', () => {
    h.evm = EVM;
    expect(renderHook(() => useConnectedHeatSubject()).result.current).toBe(EVM);
    cleanup();
    h.evm = undefined;
    h.sol = SOL;
    expect(renderHook(() => useConnectedHeatSubject()).result.current).toBe(SOL);
    expect(h.fetchHeat).not.toHaveBeenCalled();
  });

  it('two wallets: nothing until both are read, then the warmest, whichever network it is on', async () => {
    h.evm = EVM;
    h.sol = SOL;
    const first = renderHook(() => useConnectedHeatSubject());
    expect(first.result.current).toBeNull();
    await waitFor(() => expect(first.result.current).toBe(SOL));
    cleanup();
    h.fetchHeat.mockImplementation(async (address: string) => reading(address, address === EVM ? 412.5 : 0));
    const second = renderHook(() => useConnectedHeatSubject());
    await waitFor(() => expect(second.result.current).toBe(EVM));
  });

  // THE WAIT ENDS WHEN THE RESTORE DOES (seen 2026-11-11 evening, WebKit, a box under full load): the saved
  // wallet took longer than the top bar's 4 s, the Ethereum account spoke, and an Elder read "0° today" and
  // "about half a year" until the Solana wallet arrived. A fixed wait is a guess at a slow phone's speed.
  it('an Ethereum account waits for the saved Solana wallet for as long as its restore is on its way, past the top bar’s 4 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.restore = true;
    h.evm = EVM;
    const { result, rerender } = renderHook(() => useConnectedHeatSubject());
    // Its code has not reported yet.
    expect(result.current).toBeNull();
    act(() => { vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS + 1_000); });
    expect(result.current).toBeNull();
    // Its code is here and it is connecting.
    h.noWallet = { connecting: true };
    rerender();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(result.current).toBeNull();
    // It arrives: both are read, and the Elder's wallet speaks. The empty account never spoke alone.
    h.sol = SOL;
    rerender();
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(SOL));
  });

  it('a restore that ends with no wallet lets the Ethereum account speak at once, with no wait', () => {
    vi.useFakeTimers();
    h.restore = true;
    h.evm = EVM;
    h.noWallet = { connecting: true };
    const { result, rerender } = renderHook(() => useConnectedHeatSubject());
    expect(result.current).toBeNull();
    h.noWallet = { connecting: false };
    rerender();
    expect(result.current).toBe(EVM);
  });

  it('a connect that does not end (a locked wallet’s) holds the Ethereum account only as long as the top bar waits on one', () => {
    vi.useFakeTimers();
    h.restore = true;
    h.evm = EVM;
    const { result, rerender } = renderHook(() => useConnectedHeatSubject());
    // Its code takes 5 s to arrive; the connect's own wait starts then, not at the page's start.
    act(() => { vi.advanceTimersByTime(5_000); });
    h.noWallet = { connecting: true };
    rerender();
    act(() => { vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS - 1); });
    expect(result.current).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(EVM);
  });

  it('a Solana code that did not load lets the Ethereum account speak at once', () => {
    vi.useFakeTimers();
    h.restore = true;
    h.evm = EVM;
    const { result, rerender } = renderHook(() => useConnectedHeatSubject());
    expect(result.current).toBeNull();
    h.ownFailed = true;
    rerender();
    expect(result.current).toBe(EVM);
  });

  it('a saved wallet whose code never reports at all: the Ethereum account speaks at the limit, the last resort', () => {
    vi.useFakeTimers();
    h.restore = true;
    h.evm = EVM;
    const { result } = renderHook(() => useConnectedHeatSubject());
    act(() => { vi.advanceTimersByTime(SOLANA_RESTORE_LIMIT_MS - 1); });
    expect(result.current).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(EVM);
  });

  it('once the Ethereum account has spoken, a Solana connect opened by hand does not silence it', () => {
    vi.useFakeTimers();
    h.restore = true;
    h.evm = EVM;
    h.noWallet = { connecting: false };
    const { result, rerender } = renderHook(() => useConnectedHeatSubject());
    expect(result.current).toBe(EVM);
    h.noWallet = { connecting: true };
    rerender();
    expect(result.current).toBe(EVM);
  });

  it('with nothing to restore the Ethereum account speaks at once', () => {
    h.evm = EVM;
    expect(renderHook(() => useConnectedHeatSubject()).result.current).toBe(EVM);
  });

  it('a page about one network reads that network’s wallet only, at once, and reads nothing to choose', () => {
    vi.useFakeTimers();
    h.restore = true;
    h.evm = EVM;
    h.sol = SOL;
    expect(renderHook(() => useConnectedHeatSubject('ethereum')).result.current).toBe(EVM);
    expect(renderHook(() => useConnectedHeatSubject('solana')).result.current).toBe(SOL);
    cleanup();
    // The other network's wallet alone is not this page's wallet.
    h.evm = undefined;
    expect(renderHook(() => useConnectedHeatSubject('ethereum')).result.current).toBeNull();
    h.evm = EVM;
    h.sol = null;
    expect(renderHook(() => useConnectedHeatSubject('solana')).result.current).toBeNull();
    // The Ethereum door does not wait on a Solana wallet being restored.
    expect(renderHook(() => useConnectedHeatSubject('ethereum')).result.current).toBe(EVM);
    expect(h.fetchHeat).not.toHaveBeenCalled();
  });

  it('the limit is one moment for every card and line: a card that mounts late does not start it again', () => {
    vi.useFakeTimers();
    h.restore = true;
    h.evm = EVM;
    const line = renderHook(() => useConnectedHeatSubject());
    act(() => { vi.advanceTimersByTime(SOLANA_RESTORE_LIMIT_MS - 500); });
    const card = renderHook(() => useConnectedHeatSubject());
    expect(card.result.current).toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    expect(line.result.current).toBe(EVM);
    expect(card.result.current).toBe(EVM);
  });
});

describe('his screen: an Ethereum account and a Solana wallet in one hand, the card and the line together', () => {
  const mount = () =>
    render(
      <MemoryRouter initialEntries={['/']}>
        <BaylaLine />
        <HeatCard />
      </MemoryRouter>,
    );

  it('an Elder’s Solana wallet beside an empty Ethereum account: both speak from the Elder’s wallet', async () => {
    h.evm = EVM;
    h.sol = SOL;
    mount();
    await waitFor(() => expect(screen.getByTestId('bayla-line-text')).toHaveTextContent(/^1862\.42° Elder\./));
    // The card read the same wallet: its countdown is the warm one, with the wallet's own degrees.
    const countdown = await screen.findByTestId('countdown');
    expect(countdown).toHaveAttribute('data-state', 'warm');
    expect(countdown).toHaveTextContent('1862.42°');
    expect(countdown).not.toHaveTextContent('about half a year');
    expect(screen.getByLabelText(/Wallet address to read Heat for/)).toHaveValue(SOL);
    expect(document.body).not.toHaveTextContent('0° today');
    // Every heat read of the empty account was the one that chose between the two: the card never read it for itself.
    await act(async () => {});
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent(/^1862\.42° Elder\./);
  });

  it('whichever answer lands last, the line stays on the wallet the card reads', async () => {
    h.evm = EVM;
    h.sol = SOL;
    // The empty account's answer lands well after the Elder's.
    h.fetchHeat.mockImplementation(async (address: string) => {
      if (address !== SOL) await new Promise((r) => setTimeout(r, 60));
      return hisPhone(address);
    });
    mount();
    const countdown = await screen.findByTestId('countdown');
    await waitFor(() => expect(countdown).toHaveAttribute('data-state', 'warm'));
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent(/^1862\.42° Elder\./);
    expect(screen.getByTestId('countdown')).toHaveAttribute('data-state', 'warm');
  });
});
