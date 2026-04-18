import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
// Importing this module installs the wagmi mock at the top level — Vitest
// hoists the vi.mock call so the hook under test picks it up.
import { wagmiMock } from '../test-utils/wagmi-mocks';

// Mock sonner toast so action paths don't touch real UI.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { useNFTDrop } from './useNFTDrop';

const DROP_ADDR = '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`;
const USER_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

describe('useNFTDrop', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER_ADDR, isConnected: true });
  });

  it('returns zeroes when contract reads fail', () => {
    // No read stubs registered — every read returns undefined.
    const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    expect(result.current.mintPrice).toBe(0n);
    expect(result.current.totalMinted).toBe(0);
    expect(result.current.maxSupply).toBe(0);
    expect(result.current.isSoldOut).toBe(false);
    expect(result.current.isCancelled).toBe(false);
    expect(result.current.canRefund).toBe(false);
    expect(result.current.paidByUser).toBe(0n);
  });

  it('derives phase labels from on-chain mintPhase enum', () => {
    // PUBLIC phase (=2)
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 2n });
    wagmiMock.setReadResult({ functionName: 'currentPrice', result: 10n ** 17n }); // 0.1 ETH
    wagmiMock.setReadResult({ functionName: 'totalMinted', result: 42n });
    wagmiMock.setReadResult({ functionName: 'maxSupply', result: 1000n });
    wagmiMock.setReadResult({ functionName: 'owner', result: USER_ADDR });
    wagmiMock.setReadResult({ functionName: 'maxPerWallet', result: 5n });
    wagmiMock.setReadResult({ functionName: 'paidPerWallet', result: 0n });

    const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    expect(result.current.currentPhase).toBe(2);
    expect(result.current.phaseLabel).toBe('Public');
    expect(result.current.totalMinted).toBe(42);
    expect(result.current.maxSupply).toBe(1000);
    expect(result.current.isOwner).toBe(true);
    expect(result.current.isCancelled).toBe(false);
  });

  it('maps every MintPhase value to the documented label', () => {
    const phases: Array<[bigint, string]> = [
      [0n, 'Paused'],
      [1n, 'Allowlist'],
      [2n, 'Public'],
      [3n, 'Dutch auction'],
      [4n, 'Closed'],
      [5n, 'Cancelled'],
    ];
    for (const [enumValue, label] of phases) {
      wagmiMock.reset();
      wagmiMock.setAccount({ address: USER_ADDR, isConnected: true });
      wagmiMock.setReadResult({ functionName: 'mintPhase', result: enumValue });
      const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
      expect(result.current.phaseLabel).toBe(label);
    }
  });

  it('flags isCancelled only when mintPhase is CANCELLED (5)', () => {
    // phase=3 (Dutch auction) → NOT cancelled
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 3n });
    let { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    expect(result.current.isCancelled).toBe(false);

    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER_ADDR, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 5n });
    ({ result } = renderHook(() => useNFTDrop(DROP_ADDR)));
    expect(result.current.isCancelled).toBe(true);
  });

  it('canRefund is true only when cancelled AND user paid in', () => {
    // Cancelled but user paid 0 → no refund owed
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 5n });
    wagmiMock.setReadResult({ functionName: 'paidPerWallet', result: 0n });
    let { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    expect(result.current.canRefund).toBe(false);

    // Cancelled + user paid → refund available
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER_ADDR, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 5n });
    wagmiMock.setReadResult({ functionName: 'paidPerWallet', result: 10n ** 18n }); // 1 ETH
    ({ result } = renderHook(() => useNFTDrop(DROP_ADDR)));
    expect(result.current.canRefund).toBe(true);
    expect(result.current.paidByUser).toBe(10n ** 18n);

    // Active phase + user paid → still no refund (sale isn't cancelled)
    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER_ADDR, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 2n });
    wagmiMock.setReadResult({ functionName: 'paidPerWallet', result: 10n ** 18n });
    ({ result } = renderHook(() => useNFTDrop(DROP_ADDR)));
    expect(result.current.canRefund).toBe(false);
  });

  it('mint() calls writeContract with the documented args', () => {
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 2n });
    wagmiMock.setReadResult({ functionName: 'currentPrice', result: 10n ** 17n });

    const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    act(() => result.current.mint(3));
    const writeFn = wagmiMock.writeContract();
    expect(writeFn).toHaveBeenCalledTimes(1);
    const call = writeFn.mock.calls[0][0];
    expect(call).toMatchObject({
      address: DROP_ADDR,
      functionName: 'mint',
    });
    // Cost = 3 × 0.1 ETH = 0.3 ETH
    expect(call.value).toBe(3n * 10n ** 17n);
    expect(call.args[0]).toBe(3n);
  });

  it('refund() refuses and no-ops when sale is not cancelled', () => {
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 2n }); // PUBLIC
    wagmiMock.setReadResult({ functionName: 'paidPerWallet', result: 10n ** 18n });

    const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    act(() => result.current.refund());

    // writeContract should NOT have been invoked.
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('refund() refuses and no-ops when paidPerWallet is zero', () => {
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 5n });
    wagmiMock.setReadResult({ functionName: 'paidPerWallet', result: 0n });

    const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    act(() => result.current.refund());
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });

  it('refund() fires writeContract when sale is cancelled AND user paid in', () => {
    wagmiMock.setReadResult({ functionName: 'mintPhase', result: 5n });
    wagmiMock.setReadResult({ functionName: 'paidPerWallet', result: 2n * 10n ** 17n });

    const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    act(() => result.current.refund());
    const writeFn = wagmiMock.writeContract();
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn.mock.calls[0][0]).toMatchObject({
      address: DROP_ADDR,
      functionName: 'refund',
    });
  });

  it('isSoldOut reflects totalMinted >= maxSupply', () => {
    wagmiMock.setReadResult({ functionName: 'totalMinted', result: 1000n });
    wagmiMock.setReadResult({ functionName: 'maxSupply', result: 1000n });
    let { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    expect(result.current.isSoldOut).toBe(true);

    wagmiMock.reset();
    wagmiMock.setAccount({ address: USER_ADDR, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'totalMinted', result: 999n });
    wagmiMock.setReadResult({ functionName: 'maxSupply', result: 1000n });
    ({ result } = renderHook(() => useNFTDrop(DROP_ADDR)));
    expect(result.current.isSoldOut).toBe(false);
  });

  it('isOwner correctly compares case-insensitively', () => {
    // Contract returns the owner in mixed case; hook should normalise.
    const mixedCase = '0xAaAaaAAAaaAAAaAaaaAAaAAAaaaAAAaaAaaAaAaa' as `0x${string}`;
    wagmiMock.setAccount({ address: USER_ADDR, isConnected: true });
    wagmiMock.setReadResult({ functionName: 'owner', result: mixedCase });
    const { result } = renderHook(() => useNFTDrop(DROP_ADDR));
    expect(result.current.isOwner).toBe(true);
  });
});
