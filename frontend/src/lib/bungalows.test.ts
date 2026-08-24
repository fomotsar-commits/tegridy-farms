import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUNGALOWS,
  BAYLA_ART,
  BUNGALOW_STORAGE_KEY,
  DEFAULT_BUNGALOW_ID,
  getActiveBungalow,
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
