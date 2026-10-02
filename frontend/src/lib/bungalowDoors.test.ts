import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUNGALOWS, BUNGALOW_COUNT, DEFAULT_BUNGALOW_ID, OPEN_LOT_HERO, TOWELI_HERO, type Bungalow } from './bungalows';
import { ART, pageArt } from './artConfig';
import { derivedUrl, naturalWidthOf, widthsFor } from './artSrcSet';
import { DOORS, transform } from '../../scripts/render-bungalow-doors.mjs';
import { pageHashes, pinnedHashes } from '../../scripts/lib/csp-hashes.mjs';
import { expectedHashes } from '../../scripts/csp-hash.mjs';
import { SITE_URL } from './constants';

// scripts/render-bungalow-doors.mjs is deliberately self-contained (it runs
// under Vercel's Node with no TS loader), which means its DOORS manifest can
// drift from the registry. These tests are the lock-step: a bungalow that
// gains a token-first identity must gain a door unfurl in the same change,
// and a door can never point at an id or an og image that doesn't exist.

const scriptPath = resolve(process.cwd(), 'scripts/render-bungalow-doors.mjs');
const script = readFileSync(scriptPath, 'utf8');
const doorPaths = [...script.matchAll(/^\s*path: '([a-z0-9-]+)',$/gm)].map((m) => m[1]!);
const ogImages = [...script.matchAll(/^\s*image: '([^']+)',$/gm)].map((m) => m[1]!);

/** The heading a room's home page renders in its hero: its identity's, or for the TOWELI
 *  room the classic cluster's (HomePage). Undefined: a room with no hero of its own. */
const heroOf = (b: Bungalow | undefined) =>
  b?.identity ?? (b?.id === DEFAULT_BUNGALOW_ID ? TOWELI_HERO : undefined);

/** The open lot: not live, so its door renders the landing (BungalowDoor), and no address,
 *  so the landing heads it with the lot's words, OPEN_LOT_HERO (BungalowDoorLanding). */
const isLot = (b: Bungalow | undefined) => !!b && !b.live && !b.address;
const LOT_PATH = BUNGALOWS.find(isLot)!.id;

/** A JPEG's or PNG's own pixel size, read from its header. */
function pixelSize(file: string): [number, number] {
  const d = readFileSync(file);
  if (d[0] === 0x89) return [d.readUInt32BE(16), d.readUInt32BE(20)];
  for (let i = 2; i < d.length;) {
    if (d[i] !== 0xff) { i += 1; continue; }
    const m = d[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [d.readUInt16BE(i + 7), d.readUInt16BE(i + 5)];
    i += 2 + d.readUInt16BE(i + 2);
  }
  throw new Error(`${file}: no frame header`);
}

/** Every alias door App.tsx mounts for a room, as { path, id }. */
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const appAliases = [...appSource.matchAll(/\{ path: '([a-z0-9-]+)', id: '([a-z0-9-]+)' \}/g)].map((m) => ({ path: m[1]!, id: m[2]! }));

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
    // 2026-09-30 (answer fifteen, item 5): the default room is addressed too, and
    // its door is no longer the exception.
    const addressed = BUNGALOWS
      .filter((b) => b.address)
      .map((b) => b.id);
    expect(addressed).toContain(DEFAULT_BUNGALOW_ID);
    for (const id of addressed) {
      expect(doorPaths, `addressed bungalow '${id}' needs a DOORS entry in the postbuild script`).toContain(id);
    }
  });

  it('gives every live room whose home renders a hero of its own a door, the TOWELI room included', () => {
    // Answer fifteen, item 5: "The done-means was every door." A room left out serves the
    // stock shell, and a stranger reads the venue's no-script heading before the room's.
    const rooms = BUNGALOWS.filter((b) => b.live && heroOf(b)).map((b) => b.id);
    expect(rooms).toContain(DEFAULT_BUNGALOW_ID);
    for (const id of rooms) {
      expect(DOORS.map((d: Door) => d.path), `room '${id}' renders a hero but has no door page`).toContain(id);
    }
  });

  it('serves every alias door App.tsx mounts from its room, and invents none', () => {
    expect(appAliases, 'App.tsx no longer mounts /towelie the way this test reads it').toContainEqual({ path: 'towelie', id: DEFAULT_BUNGALOW_ID });
    const served = DOORS.flatMap((d: Door) => (d.aliases ?? []).map((path: string) => ({ path, id: d.path })));
    expect(served).toEqual(appAliases);
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

  it('declares each og image at its own pixel size and type', () => {
    for (const door of DOORS) {
      const [w, h] = pixelSize(resolve(process.cwd(), `public${door.image}`));
      expect([door.imageWidth, door.imageHeight], `${door.path}: ${door.image}`).toEqual([String(w), String(h)]);
      expect(door.imageType, door.path).toBe(door.image.endsWith('.png') ? 'image/png' : 'image/jpeg');
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
      const b = BUNGALOWS.find((x) => x.id === door.path);
      const hero = isLot(b) ? OPEN_LOT_HERO : heroOf(b?.live ? b : undefined);
      expect(hero, `${door.path} renders no hero of its own`).toBeTruthy();
      expect([door.heroTitle, door.heroLine], door.path).toEqual([hero!.heroTitle, hero!.heroLine]);
    }
  });

  it("paints the art React paints behind that door's hero, at the same crop", () => {
    for (const door of DOORS) {
      // The open lot's landing paints a fixed picture, not home:0: pinned below.
      if (door.path === LOT_PATH) continue;
      localStorage.setItem('tegridy-bungalow', door.path);
      const art = pageArt('home', 0);
      expect({ src: door.heroArt, position: door.heroPosition }, door.path).toEqual({ src: art.src, position: art.objectPosition });
      expect(art.scale ?? 1, `${door.path}: a zoomed hero the static frame cannot draw`).toBe(1);
    }
  });

  // Answer sixteen, ruling 9: "/nb1, the unmarked lot: yes, its own first frame. Every door
  // means every door. The lot's heading in its own words over the shore's art."
  it("gives the open lot its own door: its landing's heading, over the owner's pick", () => {
    expect(LOT_PATH).toBe('nb1');
    const lot = DOORS.find((d: Door) => d.path === LOT_PATH);
    expect(lot, 'the open lot has no door page: a stranger reads the stock shell').toBeTruthy();
    expect(OPEN_LOT_HERO.heroTitle).toBe('Unmarked.');
    expect(OPEN_LOT_HERO.heroLine).toBe(`Lot ${BUNGALOW_COUNT + 1}, for the next community.`);
    const { heroTitle, heroLine, heroArt, heroPosition } = lot!;
    expect({ heroTitle, heroLine, heroArt, heroPosition }).toEqual(OPEN_LOT_HERO);
    // The owner's pick, 2026-10-02: naka31 at 50% 28%, its door card's crop.
    expect([OPEN_LOT_HERO.heroArt, OPEN_LOT_HERO.heroPosition]).toEqual([ART.naka31.src, '50% 28%']);
    expect(lot!.image, 'its link preview shows the same picture').toBe(OPEN_LOT_HERO.heroArt);
  });

  it('numbers the lot after the bungalows wherever the script types its number', () => {
    // The script has no TS loader, so "13" is typed there: a 13th bungalow must move it.
    const lot = DOORS.find((d: Door) => d.path === LOT_PATH)!;
    const numbers = [lot.title, lot.description, lot.imageAlt, lot.heroLine]
      .flatMap((s) => [...s.matchAll(/\bLot (\d+)\b/g)].map((m) => Number(m[1])));
    expect(numbers.length).toBeGreaterThan(0);
    expect(new Set(numbers)).toEqual(new Set([BUNGALOW_COUNT + 1]));
  });
});

const shell = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const spoken = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const EM_DASH = String.fromCharCode(0x2014);
const CHAIN_WORD = { ethereum: 'Ethereum', base: 'Base', solana: 'Solana' } as const;
/** Every word a JSON-LD block says, under any key and at any depth, except an address.
 *  Not only name/alternateName/headline: `author: 'MEMETICS.FINANCE'` names the venue too,
 *  and a names-only read passed it. */
const wordsIn = (v: unknown): string[] =>
  typeof v === 'string' ? (/^https?:\/\//.test(v) ? [] : [v])
  : Array.isArray(v) ? v.flatMap(wordsIn)
  : v && typeof v === 'object' ? Object.values(v).flatMap(wordsIn)
  : [];
const NAMES_THE_VENUE = /memetics[\s.]?finance/i;

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

    // Answer fifteen, item 8: "the door link previews and the structured data naming
    // MEMETICS.FINANCE." What an unfurler reads is the head, before any script runs.
    it(`${door.path}: its link preview reads the door's own words, without an em dash`, () => {
      const doc = parse(transform(shell, door));
      const content = (sel: string) => doc.querySelector(sel)?.getAttribute('content');
      expect(['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]'].map(content))
        .toEqual([door.description, door.description, door.description]);
      expect(['meta[property="og:image:alt"]', 'meta[name="twitter:image:alt"]'].map(content)).toEqual([door.imageAlt, door.imageAlt]);
      const read = [doc.title, ...Array.from(doc.querySelectorAll('meta[content]'), (m) => m.getAttribute('content')!)];
      expect(read.filter((v) => v.includes(EM_DASH))).toEqual([]);
    });

    it(`${door.path}: its structured data is about the room, and never names MEMETICS.FINANCE`, () => {
      const doc = parse(transform(shell, door));
      const blocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'), (s) => JSON.parse(s.textContent ?? ''));
      expect(blocks).toHaveLength(1);
      const ld = blocks[0];
      // The page is the subject: a WebPage named and described as the door, at its own address.
      expect(ld).toMatchObject({ '@context': 'https://schema.org', '@type': 'WebPage', name: door.title, description: door.description });
      expect(ld.url).toBe(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'));
      expect(ld.url).toBe(`${SITE_URL}/${door.path}`);
      // The venue is only the site the page belongs to, the WebApplication index.html
      // declares, pointed at by its address.
      expect(ld.isPartOf).toEqual({ '@type': 'WebApplication', url: SITE_URL });
      expect(wordsIn(ld).filter((w) => NAMES_THE_VENUE.test(w))).toEqual([]);
      expect(JSON.stringify(ld)).not.toContain(EM_DASH);
    });

    it(`${door.path}: its preview names its room's own chain, and no other`, () => {
      const room = BUNGALOWS.find((b) => b.id === door.path)!;
      const words = `${door.description} ${door.imageAlt}`;
      const said = Object.values(CHAIN_WORD).filter((w) => new RegExp(`\\b${w}\\b`).test(words));
      // The open lot (chain 'tbd') lives on no chain yet, so its preview names none.
      const own = CHAIN_WORD[room.chain as keyof typeof CHAIN_WORD];
      expect(said).toEqual(own ? [own] : []);
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
      description: '</script><script>alert(2)</script><!-- & "q" $&',
      heroTitle: '<script>alert(1)</script>',
      heroLine: '"&amp; $\' $`',
      heroPosition: '1% 2%" onload="x',
    };
    const out = transform(shell, hostile);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('<script>alert(2)</script>');
    expect(out).not.toContain('onload="x');
    const doc = parse(out);
    expect(doc.title).toBe(hostile.title);
    expect(spoken(doc.querySelector('#first-frame h1'))).toBe(`${hostile.heroTitle} ${hostile.heroLine}`);
    // The JSON-LD is a script's text, where HTML escapes mean nothing: it must hold the
    // field as written and still never close its own element.
    const ld = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'), (s) => JSON.parse(s.textContent ?? ''));
    expect(ld.map((x) => [x.name, x.description])).toEqual([[hostile.title, hostile.description]]);
    expect(doc.querySelectorAll('script:not([src])')).toHaveLength(1);
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

  it("dies unless the shell carries exactly one JSON-LD block to replace", () => {
    const block = shell.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/)![0];
    expect(() => transform(shell.replace(block, ''), DOORS[0]!)).toThrow(/JSON-LD/);
    expect(() => transform(shell.replace(block, block + block), DOORS[0]!)).toThrow(/JSON-LD/);
  });
});

// Each door page carries its own JSON-LD, so its own inline-script hash. vercel.json's CSP
// pins every one, computed by scripts/csp-hash.mjs --write and never typed by hand.
describe("vercel.json's CSP pins what every door page serves", () => {
  const vercelJson = readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8');
  const pinned = pinnedHashes(vercelJson);
  const fix = 'run `node scripts/csp-hash.mjs --write` and commit vercel.json';

  it('pins every inline script each door page carries', () => {
    for (const door of DOORS) {
      const hashes = pageHashes(transform(shell, door));
      expect(hashes, `${door.path}: one inline script, its JSON-LD`).toHaveLength(1);
      for (const h of hashes) expect(pinned, `${door.path}: vercel.json does not pin ${h}; ${fix}`).toContain(h);
    }
  });

  it('pins nothing that no page carries, each once', () => {
    const served = new Set([shell, ...DOORS.map((d: Door) => transform(shell, d))].flatMap(pageHashes));
    expect(pinned.filter((h) => !served.has(h)), `stale pins; ${fix}`).toEqual([]);
    expect(new Set(pinned).size, 'a hash pinned twice').toBe(pinned.length);
  });

  it('is what csp-hash.mjs --write would pin: the venue page, then each door', () => {
    const want = [...new Set([shell, ...DOORS.map((d: Door) => transform(shell, d))].flatMap(pageHashes))];
    expect(expectedHashes(shell)).toEqual(want);
    expect(pinned, fix).toEqual(want);
  });
});
