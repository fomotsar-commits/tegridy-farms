import { describe, it, expect } from 'vitest';
import { decodeRevertReason } from './revertDecoder';

describe('decodeRevertReason', () => {
  it('returns generic message for null/undefined', () => {
    expect(decodeRevertReason(null)).toBe('An unknown error occurred.');
    expect(decodeRevertReason(undefined)).toBe('An unknown error occurred.');
  });

  it('decodes INSUFFICIENT_OUTPUT_AMOUNT', () => {
    expect(decodeRevertReason({ message: 'INSUFFICIENT_OUTPUT_AMOUNT' }))
      .toBe('Price moved too much — try increasing slippage.');
  });

  it('decodes user rejected', () => {
    expect(decodeRevertReason({ shortMessage: 'user rejected the request' }))
      .toBe('Transaction was rejected in your wallet.');
  });

  it('decodes User denied', () => {
    expect(decodeRevertReason('User denied transaction signature'))
      .toBe('Transaction was rejected in your wallet.');
  });

  it('decodes LOCKED error', () => {
    expect(decodeRevertReason({ message: 'execution reverted: LOCKED' }))
      .toBe('Your tokens are still locked. Wait for the lock period to expire.');
  });

  it('decodes INSUFFICIENT_LIQUIDITY', () => {
    expect(decodeRevertReason({ shortMessage: 'INSUFFICIENT_LIQUIDITY' }))
      .toBe('Not enough liquidity for this trade.');
  });

  it('matches execution reverted with details as known pattern', () => {
    // 'execution reverted' is a known pattern, so even with extra detail it matches
    expect(decodeRevertReason({ message: 'execution reverted: CUSTOM_ERROR' }))
      .toBe('Transaction reverted — the on-chain conditions changed. Try again.');
  });

  it('prefers shortMessage over message', () => {
    const err = { shortMessage: 'user rejected', message: 'some long error' };
    expect(decodeRevertReason(err)).toBe('Transaction was rejected in your wallet.');
  });

  it('truncates very long messages', () => {
    const longMsg = 'A'.repeat(300);
    expect(decodeRevertReason(longMsg).length).toBeLessThan(200);
    expect(decodeRevertReason(longMsg)).toContain('…');
  });

  it('handles string errors', () => {
    expect(decodeRevertReason('execution reverted')).toBe(
      'Transaction reverted — the on-chain conditions changed. Try again.',
    );
  });

  it('handles NO_REWARDS', () => {
    expect(decodeRevertReason({ message: 'NO_REWARDS' }))
      .toBe('No rewards available to claim.');
  });

  it('handles ZERO_AMOUNT', () => {
    expect(decodeRevertReason({ message: 'ZERO_AMOUNT' }))
      .toBe('Amount must be greater than zero.');
  });
});
