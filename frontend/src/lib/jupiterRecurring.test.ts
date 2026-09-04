// @vitest-environment node
//
// DCA (Jupiter Recurring) client — unit tests with a mocked fetch. Pins the
// verified upstream contract (2026-09-01, developers.jup.ag/docs/recurring +
// live lite-api probe): createOrder takes params.time.{inAmount,numberOfOrders,
// interval} as JSON NUMBERS and answers { transaction }; getRecurringOrders
// REQUIRES recurringType + includeFailedTx and keys its array `time`, not
// `orders`; cancelOrder takes { user, order, recurringType }.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRecurringOrder,
  getRecurringOrders,
  cancelRecurringOrder,
  recurringOrderKeyOf,
  type RecurringOrder,
} from './jupiter';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('createRecurringOrder', () => {
  const params = {
    user: 'UserPubkey111',
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmount: '1000000000',
    numberOfOrders: 10,
    intervalSeconds: 3600,
  };

  it('POSTs the exact time-strategy body shape and returns the transaction', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ requestId: 'req-1', transaction: 'b64-create' }));
    await expect(createRecurringOrder(params)).resolves.toBe('b64-create');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/jupiter/recurring/v1/createOrder');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      user: params.user,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      // Jupiter's u64 params are JSON numbers — a string here is rejected upstream.
      params: { time: { inAmount: 1000000000, numberOfOrders: 10, interval: 3600 } },
    });
  });

  it('throws with status on non-ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    await expect(createRecurringOrder(params)).rejects.toThrow('Could not create DCA (502)');
  });

  it('throws when the response carries no transaction', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ requestId: 'req-1' }));
    await expect(createRecurringOrder(params)).rejects.toThrow('No DCA transaction returned');
  });

  it('refuses an amount past 2^53 instead of silently losing precision', async () => {
    await expect(
      createRecurringOrder({ ...params, inAmount: '9007199254740993' }),
    ).rejects.toThrow('DCA amount not representable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getRecurringOrders', () => {
  it('GETs with the required recurringType + includeFailedTx and reads the `time` array', async () => {
    const order: RecurringOrder = { orderKey: 'ord-1', inputMint: 'A', outputMint: 'B' };
    fetchMock.mockResolvedValueOnce(okJson({ user: 'u', orderStatus: 'active', time: [order], totalPages: 1, page: 1 }));
    await expect(getRecurringOrders('UserPubkey111')).resolves.toEqual([order]);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      '/api/jupiter/recurring/v1/getRecurringOrders?user=UserPubkey111&orderStatus=active&recurringType=time&includeFailedTx=false',
    );
  });

  it('returns [] when the array is absent or malformed', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ user: 'u', orderStatus: 'active' }));
    await expect(getRecurringOrders('u')).resolves.toEqual([]);
    fetchMock.mockResolvedValueOnce(okJson({ time: 'not-an-array' }));
    await expect(getRecurringOrders('u')).resolves.toEqual([]);
  });

  it('throws with status on non-ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(getRecurringOrders('u')).rejects.toThrow('Could not load DCAs (500)');
  });
});

describe('cancelRecurringOrder', () => {
  it('POSTs { user, order, recurringType: time } and returns the transaction', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ requestId: 'req-2', transaction: 'b64-cancel' }));
    await expect(cancelRecurringOrder('UserPubkey111', 'OrderKey111')).resolves.toBe('b64-cancel');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/jupiter/recurring/v1/cancelOrder');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ user: 'UserPubkey111', order: 'OrderKey111', recurringType: 'time' });
  });

  it('throws with status on non-ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    await expect(cancelRecurringOrder('u', 'o')).rejects.toThrow('Could not cancel DCA (429)');
  });

  it('throws when the response carries no transaction', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ requestId: 'req-2' }));
    await expect(cancelRecurringOrder('u', 'o')).rejects.toThrow('No cancel transaction returned');
  });
});

describe('recurringOrderKeyOf', () => {
  it('reads orderKey, then publicKey, then account.orderKey, else null', () => {
    expect(recurringOrderKeyOf({ orderKey: 'k1', publicKey: 'k2' })).toBe('k1');
    expect(recurringOrderKeyOf({ publicKey: 'k2' })).toBe('k2');
    expect(recurringOrderKeyOf({ account: { orderKey: 'k3' } })).toBe('k3');
    expect(recurringOrderKeyOf({})).toBeNull();
  });
});
