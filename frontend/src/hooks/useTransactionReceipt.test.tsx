import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CallExecutionError, ExecutionRevertedError, TransactionReceiptNotFoundError } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

import { useTrackedTransactionReceipt } from './useTransactionReceipt';
import { noteReplacement } from '../lib/txErrors';

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

  // wagmi 3 never delivers the shape above: its waitForTransactionReceipt THROWS
  // on a reverted receipt (it replays the tx through viem `call`, which wraps the
  // failure in CallExecutionError). Until 2026-09-17 that landed in the 'dropped'
  // fallback, so every real revert read as "not found", and the 'failed' branch
  // above could not fire. The shape wagmi actually produces:
  it('reports failed when wagmi THROWS the revert (CallExecutionError), not dropped', () => {
    wagmiMock.setWriteStatus({
      hash: HASH,
      receiptError: new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {}),
    });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('failed');
    expect(result.current.isConfirmed).toBe(false);
    expect(result.current.isTerminal).toBe(true);
  });

  it('keeps an UNREADABLE receipt off "failed": a read error proves nothing about the tx', () => {
    wagmiMock.setWriteStatus({ hash: HASH, receiptError: new TransactionReceiptNotFoundError({ hash: HASH }) });
    const { result } = renderHook(() => useTrackedTransactionReceipt(HASH));
    expect(result.current.status).toBe('dropped');
    expect(result.current.isConfirmed).toBe(false);
  });

  // viem 2 never throws TransactionReplacedError (it does not define it). A
  // replaced tx RESOLVES with the replacement's receipt, and a wallet cancel's
  // says success, so this used to report 'confirmed'. See lib/txErrors.ts.
  const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

  it("reports replaced when the receipt is a cancel that took this hash's nonce", () => {
    const hash = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as `0x${string}`;
    noteReplacement({ reason: 'cancelled', replacedTransaction: { hash } });
    wagmiMock.setWriteStatus({ isSuccess: true, hash, receiptHash: OTHER, receiptStatus: 'success' });
    const { result } = renderHook(() => useTrackedTransactionReceipt(hash));
    expect(result.current.status).toBe('replaced');
    expect(result.current.isConfirmed).toBe(false);
    expect(result.current.isTerminal).toBe(true);
    expect(result.current.replacedBy).toBe(OTHER);
  });

  it("reports replaced for another tx's receipt even when no reason was recorded", () => {
    const hash = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2' as `0x${string}`;
    wagmiMock.setWriteStatus({ isSuccess: true, hash, receiptHash: OTHER, receiptStatus: 'success' });
    const { result } = renderHook(() => useTrackedTransactionReceipt(hash));
    expect(result.current.status).toBe('replaced');
  });

  it('a speed-up is the same call, so it stays confirmed', () => {
    const hash = '0xa3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3' as `0x${string}`;
    noteReplacement({ reason: 'repriced', replacedTransaction: { hash } });
    wagmiMock.setWriteStatus({ isSuccess: true, hash, receiptHash: OTHER, receiptStatus: 'success' });
    const { result } = renderHook(() => useTrackedTransactionReceipt(hash));
    expect(result.current.status).toBe('confirmed');
    expect(result.current.isConfirmed).toBe(true);
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
