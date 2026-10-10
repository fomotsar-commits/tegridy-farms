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
  it('exists, inside #root, between the markers a door prerender replaces with its own', () => {
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

  it('starts the clock where the island does: at a first hold, never a first buy', () => {
    expect(VENUE.heroHook).toBe('Your heat already exists. Your clock on a token starts at your first hold.');
  });

  it('reads a wallet with no JavaScript at all: GET / with the address named heat', () => {
    const form = frame!.querySelector('form');
    expect(form?.getAttribute('method')).toBe('get');
    expect(form?.getAttribute('action')).toBe('/');
    const inputs = form!.querySelectorAll('input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.getAttribute('name')).toBe('heat');
    expect(inputs[0]!.getAttribute('aria-label')).toBe('Wallet address to read Heat for (Ethereum, Base, or Solana)');
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

// The frame and the React fallback draw their heading with .ff-h1; one of these four
// headings then takes its place: `/`, a bungalow door, /toweli, an open lot. If the two
// size rules differ at any width, the heading moves as the page loads.
// e2e/door-first-frame.spec.ts measures that on three doors on a built page, phone
// Chromium only; this compares the rules themselves, at every hero.
const HEROES = [
  'src/components/VenueHero.tsx',
  'src/components/bungalow/BungalowHero.tsx',
  'src/pages/HomePage.tsx',
  'src/components/bungalow/BungalowDoorLanding.tsx',
];
const NAMED_SIZE: Record<string, string> = { '3xl': '1.875rem', '6xl': '3.75rem' };
const SIZE_CLASS = /^(md:)?text-(\[.+\]|xs|sm|base|lg|\d?xl)$/;
const cssSize = (cls: string) => {
  const v = cls.replace(/^(md:)?text-/, '');
  return (v.startsWith('[') ? v.slice(1, -1).replace(/_/g, ' ') : NAMED_SIZE[v] ?? `unknown size ${v}`).replace(/\s+/g, '');
};

describe("the frame's heading is sized by the rule of the hero that replaces it", () => {
  const style = Array.from(doc.querySelectorAll('head style')).map((s) => s.textContent ?? '').join('\n').replace(/\s+/g, '');
  const frameBase = /\.ff-h1\{[^}]*?font-size:([^;}]+)/.exec(style)?.[1];
  const frameWide = /@media\(min-width:768px\)\{(?:[^{}]*\{[^}]*\})*?\.ff-h1\{[^}]*?font-size:([^;}]+)/.exec(style)?.[1];

  it('the frame states a size below 768px and one from 768px up', () => {
    expect(frameBase).toBeTruthy();
    expect(frameWide).toBeTruthy();
  });

  it.each(HEROES)('%s', (file) => {
    const src = readFileSync(join(FRONTEND, file), 'utf8');
    const heads = Array.from(src.matchAll(/<h1 className="([^"]*\bheading-luxury\b[^"]*)"/g));
    expect(heads, `${file}: exactly one hero heading`).toHaveLength(1);
    const sizes = heads[0]![1]!.split(/\s+/).filter((c) => SIZE_CLASS.test(c));
    const base = sizes.filter((c) => !c.startsWith('md:'));
    const wide = sizes.filter((c) => c.startsWith('md:'));
    expect([base.length, wide.length], `${file}: one size below 768px, one from 768px up (${sizes.join(' ')})`).toEqual([1, 1]);
    expect(cssSize(base[0]!), `${file}: the frame's heading is another size below 768px`).toBe(frameBase);
    expect(cssSize(wide[0]!), `${file}: the frame's heading is another size from 768px up`).toBe(frameWide);
  });
});
