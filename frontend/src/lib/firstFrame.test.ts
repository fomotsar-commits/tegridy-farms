/**
 * THE FIRST FRAME IS THE HERO (answer ten, ruling 2): index.html ships the venue hero
 * as static markup, because nothing React draws exists before the wallet stack loads.
 * A static copy drifts, so every sentence is pinned to the VENUE constant React renders,
 * the image to ArtImg's srcset, and the form to /?heat=. No inline <script> (the CSP
 * pins them by hash), and the block sits outside main#main-content.
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
