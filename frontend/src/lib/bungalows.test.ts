import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUNGALOWS,
  BAYLA_ART,
  BUNGALOW_STORAGE_KEY,
  DEFAULT_BUNGALOW_ID,
  getActiveBungalow,
  getBungalowIdentity,
  hasChosenBungalow,
  setActiveBungalow,
  bungalowArtPool,
  bungalowTradeRoute,
  bungalowScanRoute,
} from './bungalows';
import { pageArt } from './artConfig';

// Jungle Bay Island (2026-08-24): 13 bungalows, each a community token whose
// art pool re-skins every pageArt() background surface. These tests pin:
//  - the registry shape (13 slots, stable ids, the two live bungalows),
//  - the Bayla pool's integrity (24 real files on disk — a typo'd src here
//    renders as a broken fullscreen background on every page at once),
//  - pageArt()'s swap rules (bungalow pool wins, shared surfaces don't swap,
//    /art-studio overrides are bypassed while a bungalow is active),
//  - resolution order (?bungalow= deep link > persisted choice > default).

afterEach(() => {
  localStorage.removeItem(BUNGALOW_STORAGE_KEY);
  window.history.replaceState({}, '', '/');
});

describe('bungalow registry', () => {
  it('has exactly 13 bungalows with unique ids', () => {
    expect(BUNGALOWS).toHaveLength(13);
    expect(new Set(BUNGALOWS.map((b) => b.id)).size).toBe(13);
  });

  it('keeps Toweli as the live default and Bayla live on Solana with the pump.fun mint', () => {
    const toweli = BUNGALOWS.find((b) => b.id === DEFAULT_BUNGALOW_ID);
    expect(toweli?.live).toBe(true);
    expect(toweli?.artPool, 'default bungalow uses the classic art system, not a pool').toBeUndefined();

    const bayla = BUNGALOWS.find((b) => b.id === 'bayla');
    expect(bayla?.live).toBe(true);
    expect(bayla?.chain).toBe('solana');
    expect(bayla?.address).toBe('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(bayla?.artPool).toBe(BAYLA_ART);
  });

  it('marks every unconfirmed bungalow as not live so the picker cannot select it', () => {
    for (const b of BUNGALOWS.filter((x) => !x.live)) {
      expect(b.artPool, `${b.id} has no art pool until it goes live`).toBeUndefined();
    }
  });

  it('carries the island canon roster (memetics.wtf SPOTS + SIGNSV2, read 2026-08-24)', () => {
    // Slug → [chain, address]. Addresses are the painter SIGNS canon verbatim —
    // this test exists so a typo'd or "helpfully fixed" address cannot land.
    const CANON: Record<string, [string, string | undefined]> = {
      toweli: ['ethereum', '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D'],
      bayla: ['solana', '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump'],
      pepe: ['ethereum', '0x6982508145454ce325ddbe47a25d4ec3d2311933'],
      qr: ['base', '0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf'],
      mfer: ['base', '0xe3086852a4b125803c815a158249ae468a3254ca'],
      bnkr: ['base', '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b'],
      drb: ['base', '0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2'],
      bobo: ['solana', '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump'],
      jbm: ['base', '0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d'],
      soy: ['solana', '4G3kNxwaA2UQHDpaQtJWQm1SReXcUD7LkT14v2oEs7rV'],
      brainlet: ['solana', '8NNXWrWVctNw1UFeaBypffimTdcLCcD8XJzHvYsmgwpF'],
      rizz: ['base', '0x58d6e314755c2668f3d7358cc7a7a06c4314b238'],
      nb1: ['tbd', undefined],
    };
    expect(new Set(BUNGALOWS.map((b) => b.id))).toEqual(new Set(Object.keys(CANON)));
    for (const b of BUNGALOWS) {
      const [chain, address] = CANON[b.id]!;
      expect(b.chain, `${b.id} chain`).toBe(chain);
      expect(b.address, `${b.id} address`).toBe(address);
    }
  });

  it('gives Bayla her token-first identity and the default none', () => {
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    expect(bayla.identity?.museLine).toBe('The work is yours. The light is hers.');
    expect(bayla.swapUrl).toContain('jup.ag');
    expect(BUNGALOWS.find((b) => b.id === DEFAULT_BUNGALOW_ID)!.identity).toBeUndefined();
  });

  it('ships the LIVE lighthouse pool address (replacement pool, mainnet 2026-08-30)', () => {
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    // Hardcoded fallback — no env var is load-bearing for the live pool.
    // This is the nonce-1 pool that actually weights duration (1.00x → 5.00x).
    // The original (4WCpdeQ2…GXPp) shipped flat and is abandoned.
    expect(bayla.stakePool).toBe('EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f');
    expect(bayla.stakePool).not.toBe('4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp');
  });
});

describe('Bayla art pool', () => {
  it('holds 24 unique pieces under /art/bayla/', () => {
    expect(BAYLA_ART).toHaveLength(24);
    expect(new Set(BAYLA_ART.map((p) => p.id)).size).toBe(24);
    expect(new Set(BAYLA_ART.map((p) => p.src)).size).toBe(24);
    for (const p of BAYLA_ART) {
      expect(p.src).toMatch(/^\/art\/bayla\/bayla-\d{2}\.jpg$/);
    }
  });

  it('ships every pool file in public/ (a missing file is a broken fullscreen bg)', () => {
    // vitest cwd is frontend/ — jsdom's import.meta.url is http://, so
    // resolve from cwd rather than the module URL.
    const publicDir = resolve(process.cwd(), 'public');
    for (const p of BAYLA_ART) {
      expect(existsSync(resolve(publicDir, `.${p.src}`)), `${p.src} must exist`).toBe(true);
    }
  });
});

describe('pageArt() bungalow swap', () => {
  it('uses the classic system when no bungalow is chosen', () => {
    expect(hasChosenBungalow()).toBe(false);
    expect(getActiveBungalow()).toBeNull();
    expect(pageArt('farm', 0).src).not.toMatch(/^\/art\/bayla\//);
  });

  it('swaps background surfaces to the Bayla pool when Bayla is active', () => {
    setActiveBungalow('bayla');
    expect(pageArt('farm', 0).src).toMatch(/^\/art\/bayla\//);
    // Overridden surfaces swap too — ART_OVERRIDES reference classic ids only.
    expect(pageArt('dashboard', 0).src).toMatch(/^\/art\/bayla\//);
    // Consecutive idx on one page get distinct pieces (same guarantee the
    // classic rotation makes).
    expect(pageArt('farm', 0).src).not.toBe(pageArt('farm', 1).src);
  });

  it('never swaps shared surfaces (nav-logo button, intro loader)', () => {
    setActiveBungalow('bayla');
    expect(bungalowArtPool('nav-logo')).toBeNull();
    expect(bungalowArtPool('loader')).toBeNull();
    expect(pageArt('nav-logo', 0).src).not.toMatch(/^\/art\/bayla\//);
    expect(pageArt('loader', 0).src).not.toMatch(/^\/art\/bayla\//);
  });

  it('treats a non-live or unknown stored id as the classic default', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'drb');
    expect(getActiveBungalow()).toBeNull();
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'not-a-bungalow');
    expect(getActiveBungalow()).toBeNull();
    expect(pageArt('farm', 0).src).not.toMatch(/^\/art\/bayla\//);
  });
});

describe('resolution order', () => {
  it('honors ?bungalow= deep links and persists them', () => {
    window.history.replaceState({}, '', '/?bungalow=bayla');
    expect(getActiveBungalow()?.id).toBe('bayla');
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBe('bayla');
    // Sticks after the param is gone.
    window.history.replaceState({}, '', '/');
    expect(getActiveBungalow()?.id).toBe('bayla');
  });

  it('ignores deep links to bungalows that are not live', () => {
    window.history.replaceState({}, '', '/?bungalow=drb');
    expect(getActiveBungalow()).toBeNull();
    expect(localStorage.getItem(BUNGALOW_STORAGE_KEY)).toBeNull();
  });

  it('getBungalowIdentity gates token-first surfaces: bayla yes, default and no-choice no', () => {
    expect(getBungalowIdentity()).toBeNull();
    setActiveBungalow('bayla');
    expect(getBungalowIdentity()?.symbol).toBe('BAYLA');
    setActiveBungalow(DEFAULT_BUNGALOW_ID);
    expect(getBungalowIdentity()).toBeNull();
  });

  it('labels dexscreener fallbacks CHART, real swap venues swap, and prefers the in-venue Solana preset', () => {
    const drb = BUNGALOWS.find((b) => b.id === 'drb')!;
    const bobo = BUNGALOWS.find((b) => b.id === 'bobo')!;
    // A Dexscreener token page is an info/chart page — calling it "Trade"
    // hands a courted community a button that trades nothing (JBM/RIZZ had
    // no indexed pair at all on 2026-08-25).
    const drbRoute = bungalowTradeRoute(drb, true);
    expect(drbRoute && 'kind' in drbRoute ? drbRoute.kind : null).toBe('chart');
    const boboVenue = bungalowTradeRoute(bobo, true);
    expect(boboVenue && 'to' in boboVenue ? boboVenue.to : null).toBe(`/solana?out=${bobo.address}`);
    const boboExt = bungalowTradeRoute(bobo, false);
    expect(boboExt && 'kind' in boboExt ? boboExt.kind : null).toBe('swap');
  });

  it('pins every settled market pool (GeckoTerminal ids, deepest ACTIVE pool, read 2026-08-30)', () => {
    // A wrong pool id draws another token's chart under this ticker with no
    // error anywhere — the exact bug the OHLCV cache-key fix guarded against.
    const MARKETS: Record<string, [string, string]> = {
      pepe: ['eth', '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f'],
      qr: ['base', '0xf02c421e15abdf2008bb6577336b0f3d7aec98f0'],
      mfer: ['base', '0xb08a99ab559e5456907278727a3b0d968c0a313b'],
      bnkr: ['base', '0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703'],
      drb: ['base', '0x5116773e18a9c7bb03ebb961b38678e45e238923'],
      bobo: ['solana', '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX'],
      jbm: ['base', '0xbc6156458bc948cba71dd0be99bfa472bd636331'],
      soy: ['solana', 'DtTkLBvYUaYBZ7PC4vCwWfu56Zkgbf7ycEXxLhAP7Xx8'],
      brainlet: ['solana', 'CW9DFoTWEUiwxyxVGnQFYhbrYEfGkvaqXEgxKZG7d7X1'],
      rizz: ['base', '0x05cdb532193b8732ebc65aff0ad207186628a3be'],
    };
    for (const [id, [network, pool]] of Object.entries(MARKETS)) {
      const b = BUNGALOWS.find((x) => x.id === id)!;
      expect(b.market?.network, `${id} market network`).toBe(network);
      expect(b.market?.pool, `${id} market pool`).toBe(pool);
      expect(b.market?.label, `${id} market label`).toBeTruthy();
    }
    // The quiet slot never grows a market.
    expect(BUNGALOWS.find((x) => x.id === 'nb1')!.market).toBeUndefined();
  });

  it("keeps Bayla's canon voice in the registry (lore + muse pool)", () => {
    // The HomePage lore card and the MuseBubble are registry-driven now; if
    // her canon copy is ever dropped from the registry, both surfaces go
    // silent with no compile error. Pin presence + the load-bearing shape.
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    expect(bayla.identity?.lore?.title).toBe('The muse of Jungle Bay Island');
    expect(bayla.identity?.lore?.paragraphs.length).toBe(2);
    expect(bayla.identity?.lore?.links.map((l) => l.href)).toEqual([
      'https://memetics.wtf/',
      'https://opensea.io/collection/junglebay',
      'https://x.com/JungleBayAC',
    ]);
    expect(bayla.identity?.museLines?.length).toBe(5);
    expect(bayla.identity?.museVoice).toBe('the muse');
  });

  it('keeps the sitemap in lock-step with the island registry', () => {
    // The rule, not a snapshot: every non-default bungalow WITH an address
    // has its door in the sitemap (the crawlable landing shipped in WO-4);
    // the quiet no-address slot and the venue-default door (whose home is /)
    // stay out. A new resident added to the registry without a sitemap entry
    // fails here instead of silently shipping an unindexed door.
    const xml = readFileSync(resolve(__dirname, '../../public/sitemap.xml'), 'utf-8');
    for (const b of BUNGALOWS) {
      const inMap = xml.includes(`<loc>https://memetic.fun/${b.id}</loc>`);
      if (b.address && b.id !== DEFAULT_BUNGALOW_ID) {
        expect(inMap, `${b.id} settled door missing from sitemap.xml`).toBe(true);
      } else {
        expect(inMap, `${b.id} should not be in sitemap.xml`).toBe(false);
      }
    }
  });

  it('scan routes carry the explicit chain for Base (0x is format-ambiguous) and exist for all island chains', () => {
    const drb = BUNGALOWS.find((b) => b.id === 'drb')!;
    const pepe = BUNGALOWS.find((b) => b.id === 'pepe')!;
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    const nb1 = BUNGALOWS.find((b) => b.id === 'nb1')!;
    expect(bungalowScanRoute(drb)).toBe(`/scan?token=${drb.address}&chain=base`);
    expect(bungalowScanRoute(pepe)).toBe(`/scan?token=${pepe.address}`);
    expect(bungalowScanRoute(bayla)).toBe(`/scan?token=${bayla.address}`);
    expect(bungalowScanRoute(nb1)).toBeNull();
  });

  it('ships BAYLA decimals in the registry (verified against the live mint 2026-08-28: Token-2022, 6dp, no transfer fee)', () => {
    expect(BUNGALOWS.find((b) => b.id === 'bayla')!.decimals).toBe(6);
  });

  it('switching back to the default restores classic art everywhere', () => {
    setActiveBungalow('bayla');
    expect(bungalowArtPool('farm')).not.toBeNull();
    setActiveBungalow(DEFAULT_BUNGALOW_ID);
    expect(hasChosenBungalow()).toBe(true);
    // An explicit Toweli choice resolves to the bungalow object (the footer
    // shows its name) but carries no pool — classic art stays in charge.
    expect(getActiveBungalow()?.id).toBe(DEFAULT_BUNGALOW_ID);
    expect(bungalowArtPool('farm')).toBeNull();
  });
});
