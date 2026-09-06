// Edge middleware — the held-time card (/read/<address>), wave seven element M.
//
// This file had NO test before element M. That matters more here than usual: the
// card IS the product on this route. A share link whose unfurl reads "memetics.finance"
// instead of "Elder · 1,694 days held" has failed at the one job it had, and nothing
// in a unit suite or a browser walk would ever notice, because only a crawler ever
// sees it.
//
// The other half is the honesty boundary: a cold wallet and a failed read must both
// fall back to the generic card. "This wallet has no held time" and "we could not reach
// the island" are different facts, and NEITHER of them is "0°".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import middleware from './middleware.js';

const ORIGIN = 'https://memetics.finance';
const ADDR = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca';
const SOL = 'So11111111111111111111111111111111111111112';
const BOT = 'Mozilla/5.0 (compatible; Twitterbot/1.0)';
const HUMAN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const HELD_SINCE = 1_642_334_800;
const AS_OF = HELD_SINCE + 1694 * 86_400;

const WARM = {
  address: ADDR,
  degrees: 1785.14,
  tier: 'Elder',
  is_cold: false,
  held_since_unix: HELD_SINCE,
  as_of_unix: AS_OF,
  token_count: 18,
  breakdown: [],
};

function req(path, ua = BOT) {
  return new Request(`${ORIGIN}${path}`, { headers: { 'user-agent': ua } });
}

function upstream(body, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 502, json: async () => body }));
}

let fetchMock;

beforeEach(() => {
  fetchMock = upstream(WARM);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('who the card is for', () => {
  it('answers an unfurl bot', async () => {
    const res = await middleware(req(`/read/${ADDR}`));
    expect(res?.status).toBe(200);
  });

  it('lets a HUMAN fall through to the SPA, untouched', async () => {
    // The whole reason this lives at the edge rather than behind a redirect: a person
    // who clicks the card gets the app, not a meta-refresh stub.
    const res = await middleware(req(`/read/${ADDR}`, HUMAN));
    expect(res).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the card carries the number', () => {
  it('puts tier, days and degrees in the title', async () => {
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain(
      '<meta property="og:title" content="Elder · 1,694 days held · 1785.1° on Jungle Bay Island">',
    );
  });

  it('counts days from the island’s reckoning, not our clock', async () => {
    // as_of a day earlier is a day less held. If this read to Date.now() the number
    // would drift every time somebody re-fetched the card.
    fetchMock = upstream({ ...WARM, as_of_unix: AS_OF - 86_400 });
    vi.stubGlobal('fetch', fetchMock);
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain('1,693 days held');
  });

  it('points og:url at the read link itself', async () => {
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/read/${ADDR}">`);
  });

  it('asks a large-image card, so the number is legible in the feed', async () => {
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it('reads a Solana wallet too', async () => {
    const html = await (await middleware(req(`/read/${SOL}`))).text();
    expect(fetchMock.mock.calls[0][0]).toBe(`https://memetics.wtf/api/heat/${SOL}`);
    expect(html).toContain('1,694 days held');
  });

  it('keeps the shared read off search indexes', async () => {
    // ~10^47 addresses answer 200 here; this is a share surface, not a crawl surface.
    const res = await middleware(req(`/read/${ADDR}`));
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});

describe('a zero is never printed', () => {
  const generic = 'Read any wallet on Jungle Bay Island';

  it('falls back to the generic card for a COLD wallet', async () => {
    fetchMock = upstream({ ...WARM, is_cold: true, degrees: 0, tier: 'Drifter', held_since_unix: null, as_of_unix: null });
    vi.stubGlobal('fetch', fetchMock);
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain(generic);
    expect(html).not.toContain('0°');
    expect(html).not.toContain('Drifter');
  });

  it('falls back when the island is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain(generic);
    expect(html).not.toContain('0°');
  });

  it('falls back on an upstream error', async () => {
    vi.stubGlobal('fetch', upstream(null, false));
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain(generic);
  });

  it('falls back when the payload has no readable degrees', async () => {
    vi.stubGlobal('fetch', upstream({ ...WARM, degrees: 'warm' }));
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain(generic);
  });

  it('falls back when the island served no reckoning date', async () => {
    // Without as_of there is no measured span, and inventing one from our clock
    // would print a number the island never served.
    vi.stubGlobal('fetch', upstream({ ...WARM, as_of_unix: null }));
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain(generic);
  });

  it.each(['/read/not-an-address', '/read/', '/read'])(
    'shows the generic card for %s rather than no card at all',
    async (path) => {
      const res = await middleware(req(path));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(generic);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('the routes it does not own', () => {
  it('still answers /scan', async () => {
    const res = await middleware(req('/scan'));
    expect(res?.status).toBe(200);
    expect(await res.text()).toContain('Token Scanner');
  });
});
