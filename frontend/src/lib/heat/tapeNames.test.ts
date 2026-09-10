// The named tape's client half — wave seven, element N.
//
// The rule this file protects is FAILURE LEAVES THE ROW, and it is a rule about
// what the venue is willing to SAY. "This buyer has no name" and "we could not
// ask the island" are different facts, and only one of them is ever true during
// an outage. Every failure path below therefore resolves to an empty map, which
// renders the address the row always had — never a blank, never "unnamed".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchTapeNames, daysBetween } from './tapeNames';

const A1 = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca';
const A2 = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';

function ok(names: Record<string, unknown>) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ names }) }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('daysBetween — the island reckons, not our clock', () => {
  it('counts whole days from held_since to the island as_of', () => {
    expect(daysBetween(1_000_000, 1_000_000 + 5 * 86_400)).toBe(5);
  });

  it('is null when either end is missing, never zero', () => {
    // A zero would read as "bought today", which is a claim. A missing reckoning
    // is not a claim about anything.
    expect(daysBetween(null, 1_000_000)).toBeNull();
    expect(daysBetween(1_000_000, null)).toBeNull();
  });

  it('is null rather than negative when as_of precedes held_since', () => {
    expect(daysBetween(2_000_000, 1_000_000)).toBeNull();
  });
});

describe('fetchTapeNames — failure leaves the row', () => {
  it('names the wallets the island knows', async () => {
    vi.stubGlobal('fetch', ok({
      [A1]: { x_handle: '_seacasa', tier: 'Elder', held_since_unix: 1_000_000, as_of_unix: 1_000_000 + 400 * 86_400 },
    }));
    const out = await fetchTapeNames([A1, A2]);
    expect(out[A1]).toEqual({ xHandle: '_seacasa', tier: 'Elder', days: 400 });
    expect(out[A2]).toBeUndefined();
  });

  it('returns nothing when the call fails, and does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(fetchTapeNames([A1])).resolves.toEqual({});
  });

  it('returns nothing on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    expect(await fetchTapeNames([A1])).toEqual({});
  });

  it('returns nothing when the body is not the shape it promised', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) })));
    expect(await fetchTapeNames([A1])).toEqual({});
  });

  it('never calls the island for a tape with no wallets', async () => {
    const fn = ok({});
    vi.stubGlobal('fetch', fn);
    expect(await fetchTapeNames([null, null])).toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('fetchTapeNames — what it refuses to accept from the wire', () => {
  it('refuses a handle that is not a handle', async () => {
    // The handle becomes an href. This is the same validation the instrument
    // applies, applied again at the boundary rather than trusted from upstream.
    vi.stubGlobal('fetch', ok({
      [A1]: { x_handle: 'javascript:alert(1)', tier: 'Elder', held_since_unix: 1, as_of_unix: 2 },
    }));
    expect(await fetchTapeNames([A1])).toEqual({});
  });

  it('refuses a tier with no handle, rather than publishing standing nobody claimed', async () => {
    vi.stubGlobal('fetch', ok({ [A1]: { tier: 'Elder', held_since_unix: 1, as_of_unix: 2 } }));
    expect(await fetchTapeNames([A1])).toEqual({});
  });

  it('strips a leading @ so one form reaches the render', async () => {
    vi.stubGlobal('fetch', ok({
      [A1]: { x_handle: '@_seacasa', tier: 'Elder', held_since_unix: 1, as_of_unix: 1 },
    }));
    expect((await fetchTapeNames([A1]))[A1]!.xHandle).toBe('_seacasa');
  });

  it('de-duplicates and caps at twelve before it asks', async () => {
    const fn = ok({});
    vi.stubGlobal('fetch', fn);
    const many = Array.from({ length: 40 }, (_, i) => `0x${String(i).padStart(40, 'c')}`);
    await fetchTapeNames([...many, A1, A1, A1]);
    const url = String(fn.mock.calls[0][0]);
    const sent = decodeURIComponent(url.split('addresses=')[1]!).split(',');
    expect(sent).toHaveLength(12);
    expect(new Set(sent).size).toBe(12);
  });
});
