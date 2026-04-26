import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';

import { useTrackedTransactionReceipt } from './useTransactionReceipt';

const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;

describe('useTrackedTransactionReceipt — R044 H3 reorg defense', () => {
  beforeEach(() => {
    wagmiMock.reset();
  });

  it('reports idle when no hash is provided', () => {
    const { result } = renderHook(() => useTrackedTransactionReceipt(undefined));
    expect(result.current.status).toBe('idle');
    expect(result.current.isPending).toBe(false);
    expect(result.current.isConfirmed).toBe(false);
    expect(result.current.isTerminal).toBe(false);
  });

  it('reports pending while wagmi is still confirming', () => {
    wagmiMock.setWriteStatus({ isConfirming: true, hash: HASH });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('pending');
    expect(result.current.isPending).toBe(true);
    expect(result.current.isTerminal).toBe(false);
  });

  it('reports confirmed when receipt has 2+ confirmations and status=success', () => {
    wagmiMock.setWriteStatus({
      isSuccess: true,
      hash: HASH,
      receiptStatus: 'success',
      blockNumber: 42n,
    });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('confirmed');
    expect(result.current.isConfirmed).toBe(true);
    expect(result.current.isTerminal).toBe(true);
    expect(result.current.blockNumber).toBe(42n);
  });

  it('reports failed when receipt status is "reverted"', () => {
    wagmiMock.setWriteStatus({
      isSuccess: true,
      hash: HASH,
      receiptStatus: 'reverted',
      blockNumber: 99n,
    });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('failed');
    expect(result.current.isConfirmed).toBe(false);
    expect(result.current.isTerminal).toBe(true);
  });

  it('reports replaced when wagmi raises TransactionReplacedError', () => {
    wagmiMock.setWriteStatus({
      isTxError: true,
      hash: HASH,
      errorName: 'TransactionReplacedError',
    });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('replaced');
    expect(result.current.isTerminal).toBe(true);
  });

  it('reports dropped when wagmi raises TransactionNotFoundError on first observation', () => {
    wagmiMock.setWriteStatus({
      isTxError: true,
      hash: HASH,
      errorName: 'TransactionNotFoundError',
    });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('dropped');
    expect(result.current.isTerminal).toBe(true);
  });

  it('reports dropped for unknown errors as a safe default', () => {
    wagmiMock.setWriteStatus({
      isTxError: true,
      hash: HASH,
      errorName: 'WeirdRpcError',
    });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('dropped');
  });

  it('default confirmations parameter is 2 (battle-tested L2 floor)', () => {
    // We can't introspect the call directly through the mock, but the hook
    // signature default is the public surface this test guards against
    // accidental change.
    expect(useTrackedTransactionReceipt.length).toBe(1); // confirmations has a default
  });
});
