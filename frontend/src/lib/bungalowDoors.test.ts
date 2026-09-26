import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID } from './bungalows';
import { pageArt } from './artConfig';
import { derivedUrl, naturalWidthOf, widthsFor } from './artSrcSet';
import { DOORS, transform } from '../../scripts/render-bungalow-doors.mjs';

// scripts/render-bungalow-doors.mjs is deliberately self-contained (it runs
// under Vercel's Node with no TS loader), which means its DOORS manifest can
// drift from the registry. These tests are the lock-step: a bungalow that
// gains a token-first identity must gain a door unfurl in the same change,
// and a door can never point at an id or an og image that doesn't exist.

const scriptPath = resolve(process.cwd(), 'scripts/render-bungalow-doors.mjs');
const script = readFileSync(scriptPath, 'utf8');
const doorPaths = [...script.matchAll(/^\s*path: '([a-z0-9-]+)',$/gm)].map((m) => m[1]!);
const ogImages = [...script.matchAll(/^\s*image: '([^']+)',$/gm)].map((m) => m[1]!);

describe('bungalow door unfurls (scripts/render-bungalow-doors.mjs)', () => {
  it('covers every non-default bungalow that carries a token-first identity', () => {
    const needDoors = BUNGALOWS
      .filter((b) => b.live && b.identity && b.id !== DEFAULT_BUNGALOW_ID)
      .map((b) => b.id);
    for (const id of needDoors) {
      expect(doorPaths, `identity bungalow '${id}' needs a DOORS entry in the postbuild script`).toContain(id);
    }
  });

  it('covers every ADDRESSED bungalow, live or not — a door with no unfurl ships no OG card', () => {
    // 2026-08-28: settled doors were landings, each with its own unfurl.
    // 2026-08-30 (placeholder-skin flip): every settled resident is LIVE, so
    // the old !live filter would match nothing and pin nothing. The invariant
    // that survives both worlds: any bungalow with an ADDRESS — whatever its
    // live state — has a DOORS entry, so a shared link always unfurls.
    const addressed = BUNGALOWS
      .filter((b) => b.address && b.id !== DEFAULT_BUNGALOW_ID)
      .map((b) => b.id);
    expect(addressed.length).toBeGreaterThan(0);
    for (const id of addressed) {
      expect(doorPaths, `addressed bungalow '${id}' needs a DOORS entry in the postbuild script`).toContain(id);
    }
  });

  it('never invents a door for an id outside the island registry', () => {
    const ids = new Set(BUNGALOWS.map((b) => b.id));
    for (const p of doorPaths) {
      expect(ids.has(p), `door '${p}' is not an island slug`).toBe(true);
    }
  });

  it('ships every og image it references', () => {
    expect(ogImages.length).toBeGreaterThanOrEqual(doorPaths.length);
    for (const img of ogImages) {
      expect(existsSync(resolve(process.cwd(), `public${img}`)), `${img} must exist in public/`).toBe(true);
    }
  });

  it('keeps the vercel door cache-headers rule in step with the registry slugs', () => {
    const vercel = readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8');
    const rule = vercel.match(/"source": "\/\(([a-z0-9|-]+)\)",\s*\n\s*"headers": \[\s*\n\s*\{ "key": "Cache-Control", "value": "no-cache/);
    expect(rule, 'door no-cache headers rule missing from vercel.json').toBeTruthy();
    const covered = new Set(rule![1]!.split('|'));
    for (const b of BUNGALOWS) {
      expect(covered.has(b.id), `vercel door headers rule misses '${b.id}'`).toBe(true);
    }
    expect(covered.has('towelie'), 'the towelie alias needs the no-cache rule too').toBe(true);
  });
});

type Door = (typeof DOORS)[number];

describe("a door's first frame is the hero its own page renders", () => {
  afterEach(() => localStorage.clear());

  it('reads the heading React renders for that door, word for word', () => {
    for (const door of DOORS) {
      const identity = BUNGALOWS.find((b) => b.id === door.path && b.live)?.identity;
      expect(identity, `${door.path} renders no hero of its own`).toBeTruthy();
      expect([door.heroTitle, door.heroLine], door.path).toEqual([identity!.heroTitle, identity!.heroLine]);
    }
  });

  it("paints the art React paints behind that door's hero, at the same crop", () => {
    for (const door of DOORS) {
      localStorage.setItem('tegridy-bungalow', door.path);
      const art = pageArt('home', 0);
      expect({ src: door.heroArt, position: door.heroPosition }, door.path).toEqual({ src: art.src, position: art.objectPosition });
      expect(art.scale ?? 1, `${door.path}: a zoomed hero the static frame cannot draw`).toBe(1);
    }
  });

  it('leaves the default room and the quiet slot on the stock shell', () => {
    for (const id of [DEFAULT_BUNGALOW_ID, 'towelie', 'nb1']) {
      expect(DOORS.map((d: Door) => d.path)).not.toContain(id);
    }
  });
});

const shell = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const spoken = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('transform writes the door its own first frame', () => {
  for (const door of DOORS) {
    it(`${door.path}: a crawler reads the door's heading and never the venue's`, () => {
      const doc = parse(transform(shell, door));
      const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(spoken);
      expect(headings).toEqual([`${door.heroTitle} ${door.heroLine}`]);
      expect(spoken(doc.body)).not.toContain('Held time counts here.');
      const h1 = doc.querySelector('h1')!;
      expect(h1.textContent, 'the title and the line run together').not.toContain(`${door.heroTitle}${door.heroLine}`);
      expect(h1.closest('#first-frame')?.parentElement?.id).toBe('root');
      expect(h1.className).toBe('ff-h1');
      expect(h1.getAttribute('elementtiming')).toBe('first-frame-h1');
      // The frame ships open: no script decides it, and theme-init keeps it.
      expect(doc.documentElement.getAttribute('data-first-frame')).toBe('venue');
    });

    it(`${door.path}: carries none of the venue's lines, form or dashes`, () => {
      const out = transform(shell, door);
      expect(out.split('<!-- first-frame -->')).toHaveLength(2);
      expect(out.split('<!-- /first-frame -->')).toHaveLength(2);
      const frame = parse(out).getElementById('first-frame')!;
      expect(frame.querySelectorAll('p, form, input, button')).toHaveLength(0);
      const values = Array.from(frame.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.value));
      expect([spoken(frame), ...values].filter((v) => v.includes('\u2014'))).toEqual([]);
      const inline = Array.from(parse(out).querySelectorAll('script:not([src])')).map((s) => s.getAttribute('type'));
      expect(inline).toEqual(['application/ld+json']);
    });

    it(`${door.path}: asks for its art the way ArtImg does, eagerly, so it is fetched once`, () => {
      const img = parse(transform(shell, door)).querySelector('#first-frame img')!;
      const src = door.heroArt;
      const widths = widthsFor(src);
      const srcset = widths.length
        ? [...widths.map((w) => `${derivedUrl(src, w)} ${w}w`), `${src} ${naturalWidthOf(src)}w`].join(', ')
        : null;
      expect(img.getAttribute('src')).toBe(src);
      expect(img.getAttribute('srcset')).toBe(srcset);
      expect(img.getAttribute('sizes')).toBe(srcset ? '100vw' : null);
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('loading')).toBeNull();
      expect(img.getAttribute('fetchpriority')).toBe('high');
      expect(img.getAttribute('style')).toBe(door.heroPosition ? `object-position:${door.heroPosition}` : null);
    });
  }

  it('keeps the no-script notice, as a paragraph', () => {
    const noscript = parse(transform(shell, DOORS[0]!)).querySelector('noscript')!;
    expect(noscript.querySelector('h1')).toBeNull();
    expect(spoken(noscript)).toContain(spoken(parse(shell).querySelector('noscript h1')));
  });

  it('escapes every field it writes, and expands no replacement pattern', () => {
    const hostile: Door = {
      ...DOORS[0]!,
      title: 'A "quoted" <b>title</b> & $& $1',
      heroTitle: '<script>alert(1)</script>',
      heroLine: '"&amp; $\' $`',
      heroPosition: '1% 2%" onload="x',
    };
    const out = transform(shell, hostile);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('onload="x');
    const doc = parse(out);
    expect(doc.title).toBe(hostile.title);
    expect(spoken(doc.querySelector('#first-frame h1'))).toBe(`${hostile.heroTitle} ${hostile.heroLine}`);
  });

  it('dies unless the shell carries exactly one first frame', () => {
    const block = shell.match(/<!-- first-frame -->[\s\S]*?<!-- \/first-frame -->/)![0];
    expect(() => transform(shell.replace(block, ''), DOORS[0]!)).toThrow(/first frame/);
    expect(() => transform(shell.replace(block, block + block), DOORS[0]!)).toThrow(/first frame/);
  });

  it('dies before it writes a door whose headings a crawler would misread', () => {
    const body = '<body>';
    expect(shell.split(body)).toHaveLength(2);
    const withVenueHeading = shell.replace(body, `${body}<h2 class="x">memetics.finance, the venue</h2>`);
    expect(() => transform(withVenueHeading, DOORS[0]!)).toThrow(/names MEMETICS\.FINANCE/);
    const withSecondH1 = shell.replace(body, `${body}<h1>Another heading</h1>`);
    expect(() => transform(withSecondH1, DOORS[0]!)).toThrow(/h1 outside the first frame/);
  });
});
