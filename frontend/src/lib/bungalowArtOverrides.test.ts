import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The bungalow branch of pageArt() — the half /bayla-studio writes.
 *
 * Before this existed, an active bungalow painted every surface straight from
 * a hash of the pageId: no way to say WHICH piece went WHERE, and no way to
 * pan or zoom it. These tests pin the four things the studio depends on:
 *   1. a matching override wins over the rotation;
 *   2. objectPosition / scale ride along;
 *   3. overrides are keyed per bungalow, so one skin can't read another's;
 *   4. an unresolvable artId degrades to the rotation instead of throwing.
 *
 * The overrides map is module state, so each case re-imports artConfig with a
 * mocked bungalowArtOverrides module.
 */

const KEY = 'tegridy-bungalow';

async function loadPageArt(overrides: Record<string, { artId: string; objectPosition?: string; scale?: number }>) {
  vi.resetModules();
  vi.doMock('./bungalowArtOverrides', () => ({
    BUNGALOW_ART_OVERRIDES: overrides,
    bungalowOverrideKey: (b: string, p: string, i: number) => `${b}|${p}:${i}`,
  }));
  const mod = await import('./artConfig');
  return mod.pageArt;
}

describe('bungalow art overrides (pageArt bungalow branch)', () => {
  beforeEach(() => {
    localStorage.setItem(KEY, 'bayla');
  });
  afterEach(() => {
    localStorage.removeItem(KEY);
    vi.doUnmock('./bungalowArtOverrides');
    vi.resetModules();
  });

  it('falls back to the deterministic rotation when nothing is overridden', async () => {
    const pageArt = await loadPageArt({});
    const piece = pageArt('farm', 0);
    // Her pool is SCANNED from public/art/bayla/ (the 08-24 drop plus the
    // 08-31 folder), so pinning one drop's filename convention here would
    // fail the moment the curator adds a piece. The property that matters:
    // the rotation draws from HER folder and is stable per surface.
    expect(piece.src).toMatch(/^\/art\/bayla\/[^/]+\.(jpe?g|png|webp|avif)$/i);
    // Deterministic: the same surface resolves to the same piece every time.
    expect(pageArt('farm', 0).id).toBe(piece.id);
  });

  it('a matching override wins over the rotation', async () => {
    const rotated = (await loadPageArt({}))('farm', 0).id;
    const target = rotated === 'bayla-01' ? 'bayla-02' : 'bayla-01';
    const pageArt = await loadPageArt({ 'bayla|farm:0': { artId: target } });
    expect(pageArt('farm', 0).id).toBe(target);
  });

  it('carries objectPosition and scale onto the resolved piece', async () => {
    const pageArt = await loadPageArt({
      'bayla|farm:0': { artId: 'bayla-05', objectPosition: '25% 80%', scale: 1.4 },
    });
    const piece = pageArt('farm', 0);
    expect(piece.id).toBe('bayla-05');
    expect(piece.objectPosition).toBe('25% 80%');
    expect(piece.scale).toBe(1.4);
  });

  it('resolves a classic artId too, so a bungalow can borrow one piece', async () => {
    const pageArt = await loadPageArt({ 'bayla|farm:1': { artId: 'mumu-bull' } });
    expect(pageArt('farm', 1).src).toBe('/art/mumu-bull.jpg');
  });

  it('is keyed per bungalow — another skin\'s key does not apply', async () => {
    const rotated = (await loadPageArt({}))('farm', 0).id;
    const other = rotated === 'bayla-01' ? 'bayla-02' : 'bayla-01';
    const pageArt = await loadPageArt({ 'toweli|farm:0': { artId: other } });
    expect(pageArt('farm', 0).id).toBe(rotated);
  });

  it('degrades to the rotation when the artId no longer exists', async () => {
    const rotated = (await loadPageArt({}))('farm', 0).id;
    const pageArt = await loadPageArt({ 'bayla|farm:0': { artId: 'deleted-piece' } });
    expect(pageArt('farm', 0).id).toBe(rotated);
  });

  it('leaves shared surfaces (nav-logo, loader) on the classic system', async () => {
    const pageArt = await loadPageArt({ 'bayla|nav-logo:0': { artId: 'bayla-01' } });
    expect(pageArt('nav-logo', 0).src).not.toMatch(/\/art\/bayla\//);
  });

  it('does not touch the classic skin', async () => {
    localStorage.removeItem(KEY);
    const pageArt = await loadPageArt({ 'bayla|farm:0': { artId: 'bayla-01' } });
    expect(pageArt('farm', 0).src).not.toMatch(/\/art\/bayla\//);
  });
});
