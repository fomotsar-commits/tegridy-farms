/**
 * WAVE SEVEN, answer ten, ruling 2: THE FIRST FRAME IS THE HERO.
 *
 * Measured by the island on a production build with a phone throttle: `/` painted
 * nothing until 6.7 s, then "Loading..." for a second, then the H1 at 7.8 s. The
 * cause was structural. index.html shipped an empty #root, and nothing React draws
 * can exist before the wallet stack loads, because every eagerly mounted component
 * sits under the wallet provider. So the hero ships in the HTML itself: the H1, the
 * lines, the door art and a read field that works as a plain GET form before any
 * script runs. React's first commit replaces it in place.
 *
 * WHAT THIS FILE PINS. A static copy of the hero is a second copy, and a second copy
 * drifts. Every sentence in index.html's first frame is asserted equal to the VENUE
 * constant React renders, the image is asserted to request exactly the srcset
 * ArtImg requests (or phones download the hero twice), and the form is asserted to
 * land on the one deep link that already reads a wallet: /?heat=<address>.
 *
 * AND WHAT IT MUST NOT BREAK. No inline <script> (the CSP pins every inline script
 * by hash; siteIdentity.test.ts guards that), and the block sits OUTSIDE
 * main#main-content, which the e2e readiness probe treats as "the app has mounted".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VENUE } from './arrival';
import { pageArt } from './artConfig';
import { derivedUrl, naturalWidthOf, widthsFor } from './artSrcSet';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(FRONTEND, 'index.html'), 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const frame = doc.getElementById('first-frame');

/** Text as a reader hears it: <br> contributes nothing, whitespace collapses. */
const spoken = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the first frame ships in the HTML', () => {
  it('exists, inside #root, between the markers the door prerender strips', () => {
    expect(frame, 'index.html carries no first frame').not.toBeNull();
    expect(frame!.parentElement?.id).toBe('root');
    expect(html).toContain('<!-- first-frame -->');
    expect(html).toContain('<!-- /first-frame -->');
    expect(html.indexOf('<!-- first-frame -->')).toBeLessThan(html.indexOf('id="first-frame"'));
  });

  it('is not main#main-content, so the e2e readiness probe cannot mistake it for the app', () => {
    expect(frame!.closest('main')).toBeNull();
    expect(frame!.querySelector('#main-content')).toBeNull();
  });

  it('says exactly what React says: the title, a real space, and the line', () => {
    const h1 = frame!.querySelector('h1');
    expect(spoken(h1)).toBe(`${VENUE.heroTitle} ${VENUE.heroLine}`);
    // The ruling-3 joint, in the HTML too: a raw text read must not run the two together.
    expect(h1?.textContent).not.toContain(`${VENUE.heroTitle}${VENUE.heroLine}`);
  });

  it('carries the two hero lines verbatim', () => {
    const lines = Array.from(frame!.querySelectorAll('p')).map(spoken);
    expect(lines).toContain(VENUE.heroPlain);
    expect(lines).toContain(VENUE.heroHook);
  });

  it('reads a wallet with no JavaScript at all: GET / with the address named heat', () => {
    const form = frame!.querySelector('form');
    expect(form?.getAttribute('method')).toBe('get');
    expect(form?.getAttribute('action')).toBe('/');
    const inputs = form!.querySelectorAll('input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.getAttribute('name')).toBe('heat');
    expect(inputs[0]!.getAttribute('aria-label')).toBe('Wallet address to read Heat for (Ethereum or Solana)');
    expect(form!.querySelector('button[type="submit"]')?.textContent?.trim()).toBe('Read Heat');
  });

  it('asks for the door art with exactly the srcset ArtImg asks for, so it is fetched once', () => {
    const img = frame!.querySelector('img');
    const src = pageArt('venue-home', 0).src;
    expect(img?.getAttribute('src')).toBe(src);
    const expected = [
      ...widthsFor(src).map((w) => `${derivedUrl(src, w)} ${w}w`),
      `${src} ${naturalWidthOf(src)}w`,
    ].join(', ');
    expect(img?.getAttribute('srcset')).toBe(expected);
    expect(img?.getAttribute('sizes')).toBe('100vw');
    // Lazy, so the gated-off frame on every other route fetches nothing.
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('is hidden unless theme-init opens the gate, by an inline style and no inline script', () => {
    const style = Array.from(doc.querySelectorAll('head style')).map((s) => s.textContent ?? '').join('\n');
    expect(style).toMatch(/#first-frame\s*\{\s*display:\s*none/);
    expect(style).toMatch(/html\[data-first-frame="venue"\]\s+#first-frame\s*\{\s*display:\s*block/);
    // Inline <script> needs a CSP hash; the only one allowed stays the JSON-LD.
    const inline = Array.from(doc.querySelectorAll('script:not([src])')).map((s) => s.getAttribute('type'));
    expect(inline).toEqual(['application/ld+json']);
  });

  it('never paints the word Loading', () => {
    expect(spoken(frame)).not.toMatch(/loading/i);
  });
});
