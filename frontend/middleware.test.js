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

// ── THE MARKETPLACE'S UNFURLS FOR THE JUNGLE BAY FAMILY ─────────────────────
//
// A shared /nakamigos/<slug> link is the first thing most people see of a
// collection, and a crawler never runs the app that would correct it. So the
// card must say the same thing the page does: Gold Cards trades here (and
// has no rarity to advertise: its 123 tokens share one image and carry no
// traits); the five view-only collections are browsable here and trade on
// their own market, with no floor fetched from an Ethereum reader that cannot
// answer for Base, ERC-1155 or Solana.
describe('the marketplace collection cards', () => {
  const load = () => import('./middleware.js');
  const card = async (path) => (await (await middleware(req(path))).text());
  const meta = (html, prop) => {
    const m = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`).exec(html);
    return m ? m[1] : null;
  };
  const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

  it('the inline collection map matches the registry, key for key and name for name', async () => {
    const { OG_COLLECTIONS } = await load();
    const { COLLECTIONS } = await import('./src/nakamigos/constants.js');
    expect(Object.keys(OG_COLLECTIONS ?? {})).toEqual(Object.keys(COLLECTIONS));
    for (const [slug, c] of Object.entries(COLLECTIONS)) {
      expect(OG_COLLECTIONS[slug].name, slug).toBe(c.name);
    }
  });

  it('a view-only collection gets a view-only card, with no floor read', async () => {
    const html = await card('/nakamigos/bojungles');
    const d = decode(meta(html, 'og:description'));
    expect(d).toBe('250 items · On Base. Browse it on Tradermigos; it trades on OpenSea.');
    expect(d).not.toMatch(/Buy|bid|P2P|rarity|Floor/i);
    expect(decode(meta(html, 'og:title'))).toBe('Bojungles | Tradermigos');
    for (const [u] of fetchMock.mock.calls) expect(String(u)).not.toContain('/api/alchemy');
  });

  it('an ERC-1155 card omits a supply it cannot state as one number', async () => {
    const d = decode(meta(await card('/nakamigos/raretowelie'), 'og:description'));
    expect(d).toBe('On Ethereum. Browse it on Tradermigos; it trades on OpenSea.');
  });

  it('Junglets says Magic Eden', async () => {
    const d = decode(meta(await card('/nakamigos/junglets'), 'og:description'));
    expect(d).toBe('208 items · On Solana. Browse it on Tradermigos; it trades on Magic Eden.');
  });

  it('a token link on a view-only collection falls back to the collection card, with no fetch', async () => {
    const html = await card('/nakamigos/memeticseeds/gallery?token=86');
    expect(decode(meta(html, 'og:description'))).toMatch(/Browse it on Tradermigos; it trades on OpenSea\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Gold Cards gets the trading card, with its real supply and no rarity', async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ openSea: { floorPrice: null } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const html = await card('/nakamigos/junglebaygoldcards');
    const d = decode(meta(html, 'og:description'));
    expect(d).toMatch(/123 items/);
    expect(d).not.toMatch(/rarity/i);
    expect(decode(meta(html, 'og:title'))).toBe('Jungle Bay Gold Cards | Tradermigos');
  });

  it('control: the three that trade today keep their card copy', async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ openSea: { floorPrice: null } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const d = decode(meta(await card('/nakamigos/gnssart'), 'og:description'));
    expect(d).toMatch(/9,696 items/);
    expect(d).toMatch(/rarity/);
  });

  it('no collection or token card title carries an em dash', async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ openSea: { floorPrice: null }, nfts: [{ name: 'X #5' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { COLLECTIONS } = await import('./src/nakamigos/constants.js');
    for (const slug of Object.keys(COLLECTIONS)) {
      for (const path of [`/nakamigos/${slug}`, `/nakamigos/${slug}/gallery?token=5`]) {
        const title = decode(meta(await card(path), 'og:title'));
        expect(title, path).not.toMatch(/\u2014/);
        expect(title, path).toMatch(/\| Tradermigos$/);
      }
    }
  });
});
