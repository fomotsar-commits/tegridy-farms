// OUTAGE-AS-FREE (incident 2026-09-04). `currentPrice` collapses to 0n on a
// failed read, which is also the honest price of a genuinely free mint. The
// Mint button armed on it and mint() sent `value: 0` on a paid drop — a
// signature on a number the app invented. These tests pin the two halves that
// must stay distinguishable: an unread price, and a real zero.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../lib/explorer', () => ({ getTxUrl: () => 'https://example.test/tx' }));

import { useNFTDropV2 } from './useNFTDropV2';
import { toast } from 'sonner';
import { CHAIN_ID } from '../lib/constants';

const USER = '0xdddddddddddddddddddddddddddddddddddddddd' as `0x${string}`;
const DROP = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Every read the Mint button gates on, landed: a live PUBLIC sale at 0.01 ETH
 * with room left. Overrides layer on top (the mock's last match wins).
 */
function stubLiveSale(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    mintPhase: 2,
    currentPrice: parseEther('0.01'),
    totalSupply: 10n,
    maxSupply: 100n,
    maxPerWallet: 5n,
    paused: false,
  };
  for (const [functionName, result] of Object.entries({ ...base, ...overrides })) {
    wagmiMock.setReadResult({ functionName, result });
  }
}

describe('useNFTDropV2 — price read is never confused with a free mint', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
    vi.mocked(toast.error).mockClear();
  });

  it('an unstubbed (failed) currentPrice read is unread, not free', () => {
    const { result } = renderHook(() => useNFTDropV2(DROP));
    expect(result.current.priceReadOk).toBe(false);
    expect(result.current.priceUnread).toBe(true);
    // The collapsed value is still 0n — that is deliberate, and exactly why the
    // second channel has to exist.
    expect(result.current.currentPrice).toBe(0n);
  });

  it('a SUCCESSFUL on-chain price of 0 is a real free mint', () => {
    wagmiMock.setReadResult({ functionName: 'currentPrice', result: 0n });
    const { result } = renderHook(() => useNFTDropV2(DROP));
    expect(result.current.priceReadOk).toBe(true);
    expect(result.current.priceUnread).toBe(false);
    expect(result.current.currentPriceFormatted).toBe(0);
  });

  it('a successful non-zero price reads ok', () => {
    wagmiMock.setReadResult({ functionName: 'currentPrice', result: parseEther('0.08') });
    const { result } = renderHook(() => useNFTDropV2(DROP));
    expect(result.current.priceReadOk).toBe(true);
    expect(result.current.priceUnread).toBe(false);
    expect(result.current.currentPriceFormatted).toBeCloseTo(0.08, 6);
  });

  it('off mainnet is not an outage — the read was never issued', () => {
    wagmiMock.setChainId(11155111);
    const { result } = renderHook(() => useNFTDropV2(DROP));
    // Nothing to arm a signature with...
    expect(result.current.priceReadOk).toBe(false);
    // ...but no "the network did not answer" claim either.
    expect(result.current.priceUnread).toBe(false);
    expect(result.current.onMainnet).toBe(false);
  });

  it('a placeholder drop address is not an outage', () => {
    const { result } = renderHook(() => useNFTDropV2(ZERO));
    expect(result.current.priceUnread).toBe(false);
  });

  it('mint() refuses to spend a price it could not read', () => {
    const { result } = renderHook(() => useNFTDropV2(DROP));
    act(() => result.current.mint(1));
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
    const msg = String(vi.mocked(toast.error).mock.calls[0][0]);
    expect(msg).toMatch(/price could not be read/i);
  });

  it('mint() proceeds on a successful read of a genuinely free mint', () => {
    stubLiveSale({ currentPrice: 0n });
    const { result } = renderHook(() => useNFTDropV2(DROP));
    act(() => result.current.mint(1));
    expect(wagmiMock.writeContract()).toHaveBeenCalledTimes(1);
    const call = wagmiMock.writeContract().mock.calls[0][0];
    expect(call).toMatchObject({ functionName: 'mint' });
    expect(call.value).toBe(0n);
  });
});

// OUTAGE-AS-OPEN (2026-09-10). The price was the only one of the Mint button's
// reads with a signal. The other five collapse too, and each lands on the side
// that DISARMS a guard: unread paused -> false, unread maxSupply -> 0 (so
// `isSoldOut = maxSupply > 0 && …` reads "not sold out"), unread maxPerWallet ->
// 0 (the contract's "no cap"), unread mintPhase -> 0 (CLOSED, stated to buyers).
describe('useNFTDropV2 — an unread sale is never confused with an open one', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
    wagmiMock.setAccount({ address: USER, isConnected: true });
    vi.mocked(toast.error).mockClear();
  });

  // One case per index, so dropping any read from the set fails exactly one.
  it.each(['mintPhase', 'totalSupply', 'maxSupply', 'maxPerWallet', 'paused'])(
    'an unread %s is an unread sale, and mint() refuses to sign against it',
    (functionName) => {
      stubLiveSale();
      wagmiMock.setReadResult({ functionName, result: undefined, status: 'failure' });
      const { result } = renderHook(() => useNFTDropV2(DROP));
      // The price DID land, so the old gate would have armed.
      expect(result.current.priceReadOk).toBe(true);
      expect(result.current.saleStateReadOk).toBe(false);
      expect(result.current.saleStateUnread).toBe(true);

      act(() => result.current.mint(1));
      expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
      expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toMatch(/sale state could not be read/i);
    },
  );

  it('real zeros are real state: nothing minted yet, no wallet cap, not paused', () => {
    // The cheap fix — treat every 0 as an outage — would refuse this sale.
    stubLiveSale({ totalSupply: 0n, maxPerWallet: 0n, paused: false });
    const { result } = renderHook(() => useNFTDropV2(DROP));
    expect(result.current.saleStateReadOk).toBe(true);
    expect(result.current.saleStateUnread).toBe(false);

    act(() => result.current.mint(2));
    expect(wagmiMock.writeContract()).toHaveBeenCalledTimes(1);
    expect(wagmiMock.writeContract().mock.calls[0][0].value).toBe(parseEther('0.02'));
  });

  it('a CLOSED phase that was read is a known state, not an outage', () => {
    stubLiveSale({ mintPhase: 0 });
    const { result } = renderHook(() => useNFTDropV2(DROP));
    expect(result.current.saleStateReadOk).toBe(true);
    expect(result.current.saleStateUnread).toBe(false);
    expect(result.current.phaseLabel).toBe('Closed');
  });

  it('a sale that was never read is not an outage — off mainnet, or a placeholder address', () => {
    wagmiMock.setChainId(11155111);
    const off = renderHook(() => useNFTDropV2(DROP)).result.current;
    expect(off.saleStateReadOk).toBe(false);
    expect(off.saleStateUnread).toBe(false);

    wagmiMock.setChainId(CHAIN_ID);
    const placeholder = renderHook(() => useNFTDropV2(ZERO)).result.current;
    expect(placeholder.saleStateUnread).toBe(false);
  });
});
