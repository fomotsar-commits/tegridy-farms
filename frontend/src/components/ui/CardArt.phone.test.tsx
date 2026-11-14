import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CardArt } from './CardArt';
import { ArtImg } from '../ArtImg';

/**
 * A CARD'S BACKGROUND ON A PHONE MUST NOT FETCH THE ORIGINAL.
 *
 * Measured on the live site (2026-11-11, 390px wide, 3 device pixels per CSS pixel): a 356px
 * card wants 1068 pixels, the widest derivative is 960, so the browser took the original,
 * 400 to 590 KB a card, for art that sits under a dark scrim. CardArt now leaves the original
 * out of its candidates on a phone-width screen. This pins that, and that nothing else moved:
 * the same art on a desktop, and a plain ArtImg on a phone, still offer the original.
 */
// A source with a 960 derivative in the committed manifest.
vi.mock('../../lib/artConfig', () => ({
  pageArt: () => ({ src: '/art/ape-hug.jpg' }),
}));

function viewport(phone: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: phone && q.includes('max-width: 640px'), media: q, addEventListener() {}, removeEventListener() {} }));
}
const candidates = (c: HTMLElement) => (c.querySelector('img')!.getAttribute('srcset') ?? '').split(', ');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('CardArt on a phone', () => {
  it('offers the 960 webp as its widest candidate, and not the original', () => {
    vi.stubEnv('PROD', true);
    viewport(true);
    const { container } = render(<CardArt pageId="solana-lp" idx={7} />);
    const set = candidates(container);
    expect(set[set.length - 1]).toBe('/_derived/art/ape-hug-jpg-960.webp 960w');
    expect(set.some((c) => c.startsWith('/art/ape-hug.jpg '))).toBe(false);
    // `src` is still the original: a browser with no srcset support shows the art as before.
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/art/ape-hug.jpg');
  });

  it('on a wider screen it still offers the original', () => {
    vi.stubEnv('PROD', true);
    viewport(false);
    const { container } = render(<CardArt pageId="solana-lp" idx={7} />);
    expect(candidates(container).some((c) => c.startsWith('/art/ape-hug.jpg '))).toBe(true);
  });

  it('a plain ArtImg (a page backdrop, a hero) is untouched on a phone', () => {
    vi.stubEnv('PROD', true);
    viewport(true);
    const { container } = render(<ArtImg pageId="solana-lp" idx={0} />);
    expect(candidates(container).some((c) => c.startsWith('/art/ape-hug.jpg '))).toBe(true);
    // And the prop never reaches the DOM.
    expect(container.querySelector('img')!.hasAttribute('phonecard')).toBe(false);
  });
});
