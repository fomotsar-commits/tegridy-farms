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
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The picture. A wallet the island reads unfurls with the island's own painted card; a
// cold or unread wallet keeps the venue's card, because the island's cold card prints
// "DAY 0" and the venue never posts a zero.
describe('the picture is the island’s painted card, for a wallet it reads', () => {
  const VENUE_CARD = `${ORIGIN}/og.jpg`;
  const painted = (address) => `https://memetics.wtf/api/card?w=${address}`;
  const images = (html) =>
    [...html.matchAll(/<meta (?:property|name)="(og:image|twitter:image)" content="([^"]*)">/g)].map((m) => [m[1], m[2]]);

  it('carries the painted card on both image tags of a warm read', async () => {
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(images(html)).toEqual([
      ['og:image', painted(ADDR)],
      ['twitter:image', painted(ADDR)],
    ]);
  });

  it('asks the card for the wallet in the link, a Solana one with its capitals kept', async () => {
    const html = await (await middleware(req(`/read/${SOL}`))).text();
    expect(images(html)).toEqual([
      ['og:image', painted(SOL)],
      ['twitter:image', painted(SOL)],
    ]);
  });

  it('leaves the title of a warm read exactly as it was', async () => {
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(html).toContain('<title>Elder · 1,694 days held · 1785.1° on Jungle Bay Island</title>');
  });

  it('keeps the venue’s card for a COLD wallet', async () => {
    vi.stubGlobal('fetch', upstream({ ...WARM, is_cold: true, degrees: 0, tier: 'Drifter', held_since_unix: null, as_of_unix: null }));
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(images(html)).toEqual([['og:image', VENUE_CARD], ['twitter:image', VENUE_CARD]]);
  });

  it('keeps the venue’s card when the island could not be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(images(html)).toEqual([['og:image', VENUE_CARD], ['twitter:image', VENUE_CARD]]);
  });

  it('keeps the venue’s card on an upstream error', async () => {
    vi.stubGlobal('fetch', upstream(null, false));
    const html = await (await middleware(req(`/read/${ADDR}`))).text();
    expect(images(html)).toEqual([['og:image', VENUE_CARD], ['twitter:image', VENUE_CARD]]);
  });

  it.each(['/read/not-an-address', '/read/', '/read'])('keeps the venue’s card for %s', async (path) => {
    const html = await (await middleware(req(path))).text();
    expect(images(html)).toEqual([['og:image', VENUE_CARD], ['twitter:image', VENUE_CARD]]);
  });

  it('reads the island once, for the heat, and never fetches the picture itself', async () => {
    await middleware(req(`/read/${ADDR}`));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`https://memetics.wtf/api/heat/${ADDR}`]);
  });

  it('leaves the scan card on the venue’s own picture', async () => {
    const html = await (await middleware(req('/scan'))).text();
    expect(images(html)).toEqual([['og:image', VENUE_CARD], ['twitter:image', VENUE_CARD]]);
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
  // &amp; goes last, so "&amp;quot;" decodes once, to "&quot;", and never on to '"'.
  const decode = (s) => String(s ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

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

  // Every market link is OpenSea (owner ruling, 2026-10-02), and OpenSea has
  // no Junglets page, so its card names no market at all.
  it('Junglets names no market', async () => {
    const d = decode(meta(await card('/nakamigos/junglets'), 'og:description'));
    expect(d).toBe('208 items · On Solana. See it on Tradermigos.');
    expect(d).not.toMatch(/trades on/i);
  });

  it('every view-only card that names a market names OpenSea', async () => {
    const { OG_COLLECTIONS } = await load();
    for (const [slug, c] of Object.entries(OG_COLLECTIONS)) {
      if (!c.viewOnly) continue;
      expect([null, 'OpenSea'], slug).toContain(c.market);
    }
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

// \u2500\u2500 THE ADD'S SHARE LINK (island answer thirty-one) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// After an add, the receipt card posts memetics.finance/lp/<room> or /lp/<mint> to X. Two
// readers: X's crawler gets the island's card, the painting titled for the coin; a person is
// sent to the Add. The card states no figure of the venue's own.
describe('the add\u2019s share link', () => {
  const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
  const CARD = `${ORIGIN}/share/lp-card-v2.jpg`;
  const ALT = 'Bayla lays a glowing infinity brick on the island&#39;s plinth, under memetics.finance';
  const UNNAMED = 'Hold the floor. Every trade pays you.';
  const meta = (html, prop) => {
    const m = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`).exec(html);
    return m ? m[1] : null;
  };
  const card = async (path) => (await middleware(req(path))).text();
  const identity = (attributes) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { attributes } }) }));

  it('a room\u2019s card: the painting at 2048 by 1024 with its words, titled for the room\u2019s coin', async () => {
    const html = await card('/lp/bayla');
    expect(meta(html, 'og:title')).toBe('Hold $BAYLA&#39;s floor. Every trade pays you.');
    expect(meta(html, 'twitter:title')).toBe('Hold $BAYLA&#39;s floor. Every trade pays you.');
    expect(meta(html, 'og:description')).toBe('Add liquidity to $BAYLA&#39;s pool on memetics.finance. Every trade in the pool pays you.');
    expect(meta(html, 'og:image')).toBe(CARD);
    expect(meta(html, 'twitter:image')).toBe(CARD);
    expect(meta(html, 'og:image:width')).toBe('2048');
    expect(meta(html, 'og:image:height')).toBe('1024');
    expect(meta(html, 'og:image:alt')).toBe(ALT);
    expect(meta(html, 'twitter:image:alt')).toBe(ALT);
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'og:url')).toBe(`${ORIGIN}/lp/bayla`);
    expect(meta(html, 'og:site_name')).toBe('memetics.finance');
  });

  it('a room\u2019s card reads nothing upstream', async () => {
    const html = await card('/lp/brainlet');
    expect(meta(html, 'og:title')).toBe('Hold $BRAINLET&#39;s floor. Every trade pays you.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the edge runs on the road, so both readers reach it', async () => {
    const { config } = await import('./middleware.js');
    expect(config.matcher).toContain('/lp/:path*');
  });

  it('any other token\u2019s card is named from one identity read, and its person is sent to the LP door', async () => {
    fetchMock = identity({ name: 'dogwifhat', symbol: 'WIF' });
    vi.stubGlobal('fetch', fetchMock);
    const html = await card(`/lp/${WIF}`);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${WIF}`]);
    expect(meta(html, 'og:title')).toBe('Hold $WIF&#39;s floor. Every trade pays you.');
    expect(meta(html, 'og:description')).toBe('Add liquidity to $WIF&#39;s pool on memetics.finance. Every trade in the pool pays you.');
    expect(meta(html, 'og:url')).toBe(`${ORIGIN}/lp/${WIF}`);
    const res = await middleware(req(`/lp/${WIF}`, HUMAN));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/pools?mint=${WIF}&task=add`);
  });

  it('a token whose name cannot be read still gets the card, unnamed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const res = await middleware(req(`/lp/${WIF}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(meta(html, 'og:title')).toBe(UNNAMED);
    expect(meta(html, 'og:description')).toBe('Add liquidity to any pool on memetics.finance. Every trade in the pool pays you.');
    expect(meta(html, 'og:image')).toBe(CARD);
  });

  it('a symbol read with its own $ (WIF\u2019s reads "$WIF") is printed with one', async () => {
    vi.stubGlobal('fetch', identity({ name: 'dogwifhat', symbol: '$WIF' }));
    expect(meta(await card(`/lp/${WIF}`), 'og:title')).toBe('Hold $WIF&#39;s floor. Every trade pays you.');
  });

  it.each(['<b>WIF</b>', 'WIF \ud83d\ude80', '$$WIF', 'W$IF', 'W'.repeat(13), '$', '', 42])('a symbol that is not a plain ticker (%s) is not printed', async (symbol) => {
    vi.stubGlobal('fetch', identity({ name: 'x', symbol }));
    const html = await card(`/lp/${WIF}`);
    expect(meta(html, 'og:title')).toBe(UNNAMED);
    expect(html).not.toContain('<b>');
  });

  it('a person is sent to the room\u2019s Add sheet, on the deployment that served the link', async () => {
    const res = await middleware(req('/lp/bayla', HUMAN));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/bayla?sheet=add`);
    const preview = 'https://tegridy-farms-git-feat-x.vercel.app';
    const fromPreview = await middleware(new Request(`${preview}/lp/soy`, { headers: { 'user-agent': HUMAN } }));
    expect(fromPreview.headers.get('location')).toBe(`${preview}/soy?sheet=add`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/lp', '/lp/', '/lp/not-a-coin', '/lp/__proto__', '/lp/constructor', '/lp/0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca'])(
    'a link naming neither (%s): the card unnamed, nothing read; a person to /pools',
    async (path) => {
      const html = await card(path);
      expect(meta(html, 'og:title')).toBe(UNNAMED);
      expect(meta(html, 'og:url')).toBe(`${ORIGIN}/pools`);
      expect(fetchMock).not.toHaveBeenCalled();
      const res = await middleware(req(path, HUMAN));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/pools`);
    },
  );

  // Island answer thirty-four. A pool can pair a coin with USDC or an island coin (1155), so no
  // card says which coin goes in beside it.
  it('no card names a pairing coin: the description is the pool’s, whatever it pairs with', async () => {
    vi.stubGlobal('fetch', identity({ name: 'dogwifhat', symbol: 'WIF' }));
    for (const path of ['/lp/bayla', '/lp/bobo', '/lp/soy', '/lp/brainlet', '/lp/rizz', `/lp/${WIF}`, '/lp/nothing']) {
      const description = meta(await card(path), 'og:description');
      expect(description, path).not.toMatch(/SOL \+/);
      expect(description, path).toMatch(/Every trade in the pool pays you\.$/);
    }
  });

  // A link typed by hand: the room is the room in any case. A mint is never touched (base58 is cased).
  it.each(['/lp/BAYLA', '/lp/Bayla', '/lp/bAyLa'])('a room typed in any case (%s) is the room: its card, and its person on the Add sheet', async (path) => {
    const html = await card(path);
    expect(meta(html, 'og:title')).toBe('Hold $BAYLA&#39;s floor. Every trade pays you.');
    expect(meta(html, 'og:url')).toBe(`${ORIGIN}/lp/bayla`);
    expect(fetchMock).not.toHaveBeenCalled();
    const res = await middleware(req(path, HUMAN));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/bayla?sheet=add`);
  });

  it.each(['/lp/__PROTO__', '/lp/CONSTRUCTOR', '/lp/HASOWNPROPERTY'])('a cased word that is no room (%s) is still no room', async (path) => {
    expect(meta(await card(path), 'og:title')).toBe(UNNAMED);
    expect((await middleware(req(path, HUMAN))).headers.get('location')).toBe(`${ORIGIN}/pools`);
  });

  // A copy never heads the island's painting as the real coin. The venue's screens call it "fake BAYLA"
  // (src/lib/solana/lp/identity.ts); the card names no coin at all.
  describe('a copy’s card is unnamed', () => {
    const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it.each(['BAYLA', 'bayla', '$BAYLA', 'BAYLA2', 'BAYIA', '8AYLA', 'USDC', 'U5DC', 'USDCoin', 'SOL', 'S0L', 'WSOL', 'Solana', 'USDT', 'Tether', 'TOWELI', 'T0WELI', 'xTOWELI', 'BOBO', 'B0B0', 'SOY', 'BRAINLET', 'RIZZ', 'R1ZZ'])(
      'a coin at another mint calling itself %s: the card unnamed, its person still sent to that mint’s Add',
      async (symbol) => {
        vi.stubGlobal('fetch', identity({ name: 'x', symbol }));
        const html = await card(`/lp/${WIF}`);
        expect(meta(html, 'og:title')).toBe(UNNAMED);
        expect(meta(html, 'og:description')).toBe('Add liquidity to any pool on memetics.finance. Every trade in the pool pays you.');
        // No coin is named anywhere on it: an unnamed card prints no $TICKER at all.
        expect(html).not.toContain('$');
        expect(meta(html, 'og:url')).toBe(`${ORIGIN}/lp/${WIF}`);
        const res = await middleware(req(`/lp/${WIF}`, HUMAN));
        expect(res.headers.get('location')).toBe(`${ORIGIN}/pools?mint=${WIF}&task=add`);
      },
    );

    it('the real coin by its own mint keeps its name', async () => {
      vi.stubGlobal('fetch', identity({ name: 'BAYLA', symbol: 'BAYLA' }));
      expect(meta(await card(`/lp/${BAYLA}`), 'og:title')).toBe('Hold $BAYLA&#39;s floor. Every trade pays you.');
      vi.stubGlobal('fetch', identity({ name: 'USD Coin', symbol: 'USDC' }));
      expect(meta(await card(`/lp/${USDC}`), 'og:title')).toBe('Hold $USDC&#39;s floor. Every trade pays you.');
    });

    it.each(['WIF', 'BONK', 'PEPE', 'MOMENT', 'BAY', 'BAYL', 'SOLID', 'SOYA', 'USD', 'RIZ'])('a ticker that copies none of them (%s) is still named', async (symbol) => {
      vi.stubGlobal('fetch', identity({ name: 'x', symbol }));
      expect(meta(await card(`/lp/${WIF}`), 'og:title')).toBe(`Hold $${symbol}&#39;s floor. Every trade pays you.`);
    });

    it('the names and their mints are the pool pages’ own list, name for name', async () => {
      const { LP_KNOWN } = await import('./middleware.js');
      const { WELL_KNOWN_NAMES } = await import('./src/lib/solana/lp/tokenSafety.ts');
      expect(LP_KNOWN).toEqual(WELL_KNOWN_NAMES.map(({ label, mint, names }) => ({ label, mint, names: [...names] })));
    });

    it('the card reads a copy exactly as the screens do, for every plain ticker tried', async () => {
      const { lpCopy, LP_KNOWN } = await import('./middleware.js');
      const { copiedWellKnownName } = await import('./src/lib/solana/lp/tokenSafety.ts');
      const { displaySafe } = await import('./src/lib/launchMetadata/validate.js');
      // Each known name, and the spellings a copy uses: case, a digit for its lookalike letter, a tail, a head.
      const swap = (s) => [s.replace(/O/gi, '0'), s.replace(/[IL]/gi, '1'), s.replace(/E/gi, '3'), s.replace(/S/gi, '5'), s.replace(/B/gi, '8'), s.replace(/L/g, 'I'), s.replace(/I/g, 'l')];
      const spellings = (s) => [s, s.toLowerCase(), s[0] + s.slice(1).toLowerCase(), ...swap(s), `${s}2`, `${s}X`, `X${s}`, `1${s}`, s.slice(0, -1), s.slice(1)];
      const plain = (s) => /^[A-Za-z0-9]{1,12}$/.test(s);
      const tried = [...new Set([
        ...LP_KNOWN.flatMap((k) => k.names.flatMap((n) => spellings(n.replace(/[^A-Za-z0-9]/g, '')))),
        ...['WIF', 'BONK', 'JUP', 'PEPE', 'ETH', 'WETH', 'BTC', 'TEGRIDY', 'MEMETIC', 'MEMETICS', 'MOMENT', 'BAYLAGOON', 'BAYLEAF', 'SOLAR', 'SOLO', 'USD', 'USDS', 'DAI', 'A', '0', 'I'].flatMap(spellings),
      ])].filter(plain);
      expect(tried.length).toBeGreaterThan(300);
      const mints = [WIF, ...LP_KNOWN.map((k) => k.mint).filter(Boolean)];
      let copies = 0;
      for (const mint of mints) {
        for (const ticker of tried) {
          const screens = copiedWellKnownName(mint, [ticker, displaySafe(ticker, 12)]) !== null;
          expect(lpCopy(mint, ticker), `${ticker} at ${mint}`).toBe(screens);
          if (screens) copies += 1;
        }
      }
      expect(copies).toBeGreaterThan(300);
    });
  });

  it('the rooms match the sheet\u2019s rooms, id for id and coin for coin', async () => {
    const { LP_ROOMS } = await import('./middleware.js');
    const { sheetRooms } = await import('./src/lib/sheet.ts');
    expect(Object.entries(LP_ROOMS ?? {})).toEqual(sheetRooms().map((b) => [b.id, b.symbol]));
  });

  it('the picture on disk is a JPEG at 2048 by 1024, under X\u2019s 5 MB', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'public', 'share', 'lp-card-v2.jpg');
    const buf = readFileSync(file);
    expect([buf[0], buf[1]]).toEqual([0xff, 0xd8]);
    let size = null;
    for (let i = 2; i + 9 < buf.length && buf[i] === 0xff; i += 2 + buf.readUInt16BE(i + 2)) {
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        size = { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        break;
      }
    }
    expect(size).toEqual({ width: 2048, height: 1024 });
    expect(statSync(file).size).toBeLessThan(5 * 1024 * 1024);
  });

  // Island answer thirty-four. The first picture was cut from a mockup of X and carried X's own
  // "From memetics.finance" label into every card. This is the painting itself, by its bytes.
  it('the picture is the island\u2019s clean painting, byte for byte', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'public', 'share', 'lp-card-v2.jpg');
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe('c962d58663a40e11e0f713856f96b23f892f6f24469f1b018a909545a29ed5f7');
  });

  it('no card on the road carries an em dash', async () => {
    vi.stubGlobal('fetch', identity({ name: 'dogwifhat', symbol: 'WIF' }));
    for (const path of ['/lp/bayla', `/lp/${WIF}`, '/lp/nothing']) {
      expect(await card(path), path).not.toMatch(/\u2014/);
    }
  });

  it('/read still answers, and every other card prints no picture size or words', async () => {
    const read = await card(`/read/${ADDR}`);
    expect(read).toContain('1,694 days held');
    for (const html of [read, await card('/scan'), await card('/nakamigos/bojungles')]) {
      expect(html).not.toMatch(/og:image:(?:width|height|alt)|twitter:image:alt/);
    }
  });
});
