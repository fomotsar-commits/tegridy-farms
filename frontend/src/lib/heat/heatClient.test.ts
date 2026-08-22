// The network boundary's two jobs: never turn an outage into a score, and don't
// re-ask a third party's quota for the same wallet on every render.
//
// Directive §2: "hard timeout (<=6s), small TTL cache (minutes, never days),
// fail-closed for every gate path."

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchHeat, clearHeatCache, isSupportedHeatAddress, HeatUnavailableError } from './heatClient';

const ADDR = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const SOL = 'So11111111111111111111111111111111111111112';

const WARM_BODY = {
  address: ADDR,
  degrees: 195.54,
  tier: 'Builder',
  is_cold: false,
  held_since_unix: 1739235449,
  as_of_unix: 1786104024,
  token_count: 1,
  breakdown: [
    {
      token_address: '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca',
      chain: 'base',
      name: 'TOWELI',
      symbol: 'TOWELI',
      heat_degrees: 195.54,
      first_seen_at_unix: 1739235449,
      last_transfer_at_unix: 1786102091,
    },
  ],
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function status(code: number) {
  return { ok: false, status: code, json: async () => ({ error: 'nope' }) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearHeatCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchHeat — fail-closed', () => {
  it('a network error is an ERROR, never a zero-degree reading', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    await expect(fetchHeat(ADDR)).rejects.toBeInstanceOf(HeatUnavailableError);
  });

  it('a 502 from the proxy is an ERROR, never a cold wallet', async () => {
    fetchMock.mockResolvedValue(status(502));
    await expect(fetchHeat(ADDR)).rejects.toThrow(/unreachable/i);
  });

  it('a 200 carrying a malformed body is an OUTAGE, not a low score', async () => {
    // The exact shape that already shipped here once: a 200 with an error envelope.
    fetchMock.mockResolvedValue(ok({ error: 'upstream throttled' }));
    await expect(fetchHeat(ADDR)).rejects.toThrow(/upstream throttled/);
  });

  it('a WARM payload with no reckoning date is refused — the freshness law needs one', async () => {
    fetchMock.mockResolvedValue(ok({ ...WARM_BODY, as_of_unix: null }));
    await expect(fetchHeat(ADDR)).rejects.toThrow(/reckoning date/i);
  });

  it('rejects a non-address before it ever leaves the browser', async () => {
    await expect(fetchHeat('not-an-address')).rejects.toBeInstanceOf(HeatUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the TTL cache — minutes, never days', () => {
  it('serves a second read of the same wallet from cache', async () => {
    fetchMock.mockResolvedValue(ok(WARM_BODY));
    const a = await fetchHeat(ADDR);
    const b = await fetchHeat(ADDR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.degrees).toBe(a.degrees);
  });

  it('expires inside MINUTES, not days', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(ok(WARM_BODY));
    await fetchHeat(ADDR);
    // Four minutes later the entry must be gone. If someone ever "optimises" the TTL
    // up to hours or days, this is the test that says no.
    vi.advanceTimersByTime(4 * 60_000);
    await fetchHeat(ADDR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still holds just under the window', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(ok(WARM_BODY));
    await fetchHeat(ADDR);
    vi.advanceTimersByTime(60_000);
    await fetchHeat(ADDR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('NEVER caches a failure — an outage must not become a lockout', async () => {
    fetchMock.mockRejectedValueOnce(new Error('blip'));
    await expect(fetchHeat(ADDR)).rejects.toThrow();
    fetchMock.mockResolvedValue(ok(WARM_BODY));
    const r = await fetchHeat(ADDR);
    expect(r.degrees).toBe(195.54);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('{ fresh: true } bypasses the cache — the gate path never judges a cached reading', async () => {
    fetchMock.mockResolvedValue(ok(WARM_BODY));
    await fetchHeat(ADDR);
    await fetchHeat(ADDR, { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keys per wallet — one wallet’s reading is never served for another', async () => {
    const other = '0x0000000000000000000000000000000000000001';
    fetchMock.mockImplementation(async (url: string) =>
      ok(url.includes(other) ? { ...WARM_BODY, address: other, degrees: 3, tier: 'Drifter' } : WARM_BODY),
    );
    expect((await fetchHeat(ADDR)).degrees).toBe(195.54);
    expect((await fetchHeat(other)).degrees).toBe(3);
  });

  it('folds EVM case (checksummed and lower-case are one wallet)', async () => {
    fetchMock.mockResolvedValue(ok(WARM_BODY));
    await fetchHeat(ADDR);
    await fetchHeat(ADDR.toUpperCase().replace('0X', '0x'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fold Solana case — base58 is case-significant and two keys are two wallets', async () => {
    fetchMock.mockResolvedValue(ok({ ...WARM_BODY, address: SOL }));
    await fetchHeat(SOL);
    await fetchHeat(SOL.toLowerCase());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isSupportedHeatAddress', () => {
  it('accepts both rails and rejects everything else', () => {
    expect(isSupportedHeatAddress(ADDR)).toBe(true);
    expect(isSupportedHeatAddress(SOL)).toBe(true);
    expect(isSupportedHeatAddress('0xdeadbeef')).toBe(false);
    expect(isSupportedHeatAddress('')).toBe(false);
  });
});
