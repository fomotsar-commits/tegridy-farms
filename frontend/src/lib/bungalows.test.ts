import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
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

  it('ships the LIVE lighthouse pool address (created on mainnet 2026-08-26)', () => {
    const bayla = BUNGALOWS.find((b) => b.id === 'bayla')!;
    // Hardcoded fallback — no env var is load-bearing for the live pool.
    expect(bayla.stakePool).toBe('4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp');
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
