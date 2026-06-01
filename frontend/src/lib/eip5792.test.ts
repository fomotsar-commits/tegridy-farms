import { describe, it, expect, vi } from 'vitest';
import {
  isAtomicBatchSupported,
  getWalletCapabilities,
  sendCalls,
  type Eip1193Like,
} from './eip5792';

describe('isAtomicBatchSupported', () => {
  const chain = '0x1';

  it('returns true when atomic.status is "supported"', () => {
    expect(isAtomicBatchSupported({ '0x1': { atomic: { status: 'supported' } } }, chain)).toBe(true);
  });

  it('returns true when atomic.status is "ready" (pending one-time upgrade)', () => {
    expect(isAtomicBatchSupported({ '0x1': { atomic: { status: 'ready' } } }, chain)).toBe(true);
  });

  it('returns false when atomic.status is "unsupported"', () => {
    expect(isAtomicBatchSupported({ '0x1': { atomic: { status: 'unsupported' } } }, chain)).toBe(false);
  });

  it('matches the chain-id key case-insensitively', () => {
    expect(isAtomicBatchSupported({ '0X1': { atomic: { status: 'supported' } } }, '0x1')).toBe(true);
    expect(isAtomicBatchSupported({ '0x1': { atomic: { status: 'supported' } } }, '0X1')).toBe(true);
  });

  it('returns false when the chain is absent', () => {
    expect(isAtomicBatchSupported({ '0xa': { atomic: { status: 'supported' } } }, chain)).toBe(false);
  });

  it('returns false for malformed / empty capabilities', () => {
    expect(isAtomicBatchSupported({ '0x1': {} }, chain)).toBe(false);
    expect(isAtomicBatchSupported({ '0x1': { atomic: null } }, chain)).toBe(false);
    expect(isAtomicBatchSupported({}, chain)).toBe(false);
    expect(isAtomicBatchSupported(null, chain)).toBe(false);
    expect(isAtomicBatchSupported(undefined, chain)).toBe(false);
    expect(isAtomicBatchSupported('nope', chain)).toBe(false);
  });
});

describe('getWalletCapabilities / sendCalls', () => {
  const account = '0x1111111111111111111111111111111111111111' as const;

  it('calls wallet_getCapabilities with the account', async () => {
    const request = vi.fn().mockResolvedValue({});
    const provider: Eip1193Like = { request };
    await getWalletCapabilities(provider, account);
    expect(request).toHaveBeenCalledWith({ method: 'wallet_getCapabilities', params: [account] });
  });

  it('wraps wallet_sendCalls in the v2.0.0 envelope with atomicRequired defaulting to false', async () => {
    const request = vi.fn().mockResolvedValue({ id: '0xabc' });
    const provider: Eip1193Like = { request };
    await sendCalls(provider, {
      from: account,
      chainId: '0x1',
      calls: [{ to: '0x2222222222222222222222222222222222222222', data: '0xdead' }],
    });
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_sendCalls',
      params: [
        {
          version: '2.0.0',
          from: account,
          chainId: '0x1',
          atomicRequired: false,
          calls: [{ to: '0x2222222222222222222222222222222222222222', data: '0xdead' }],
        },
      ],
    });
  });

  it('passes atomicRequired through when set', async () => {
    const request = vi.fn().mockResolvedValue({ id: '0xabc' });
    const provider: Eip1193Like = { request };
    await sendCalls(provider, { from: account, chainId: '0x1', atomicRequired: true, calls: [] });
    const arg = request.mock.calls[0][0] as { params: [{ atomicRequired: boolean }] };
    expect(arg.params[0].atomicRequired).toBe(true);
  });
});
