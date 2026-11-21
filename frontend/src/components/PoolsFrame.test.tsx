/**
 * THE POOLS PAGE'S FIRST FRAME (law 2; the island's answer thirty-three, section 4). The build
 * writes dist/pools/index.html with the page's heading as static markup, and React's fallbacks
 * repeat it until PoolsPage draws the same heading in the same place. A static copy drifts, so
 * the words, each rule and the numbers above the page are pinned to their sources here.
 * e2e/pools-first-frame.spec.ts measures the same on a built page.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOOR_WAITING, FRAME_CSS, LP_DOOR, POOLS_HEADING, RULER_ZONES, poolsFrame, transform } from '../../scripts/render-pools-frame.mjs';
import { pageHashes } from '../../scripts/lib/csp-hashes.mjs';
import { CARD, CARD_STYLE } from './solana/curve/uiFormat';
import { LP_WRITES, lpWriteMode } from '../lib/launcher/solana/lpWriteFlag';
import { BUNGALOWS } from '../lib/bungalows';
import { deepLinkSheet, sheetRooms } from '../lib/sheet';
import { PoolsFrame } from './PoolsFrame';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(FRONTEND, path), 'utf8');
const shell = read('index.html');
const page = read('src/pages/PoolsPage.tsx');
const doorSource = read('src/components/solana/lp/LpDoorFrame.tsx');
const baylaLine = read('src/components/BaylaLine.tsx');
const topNav = read('src/components/layout/TopNav.tsx');
const indexCss = read('src/index.css');
const dwgCss = read('src/styles/dwg.css');
const poolsCss = read('src/styles/dwg-pools.css');
const themeInit = read('public/theme-init.js');

const out = transform(shell);
const doc = new DOMParser().parseFromString(out, 'text/html');
const frame = doc.getElementById('first-frame')!;
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tight = (s: string | undefined) => (s ?? '').replace(/\s+/g, '');
// A mint no room holds: the door on /pools, never the sheet over a room.
const COIN = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

// The frame's rules: below 768px, and what changes from 768px up (Tailwind's md).
const [narrow = '', wide = ''] = FRAME_CSS.split('@media (min-width:768px){');
/** One declaration of one rule, as written. */
const set = (sheet: string, selector: string, prop: string) => {
  const block = new RegExp(`(?:^|\\})${escaped(selector)}\\{([^}]*)\\}`).exec(sheet)?.[1] ?? '';
  return new RegExp(`(?:^|;)${escaped(prop)}:([^;]+)`).exec(block)?.[1];
};

/**
 * One declaration of one rule in a stylesheet as people write it (spaces, comments, !important),
 * outside any at-rule (`media` undefined) or inside any `@media (<media>) {` block.
 */
const rule = (css: string, selector: string, prop: string, media?: string) => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Each top-level block: its prelude and its body, braces counted.
  const blocks: { head: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (text[i] === '}' && --depth === 0) {
      blocks.push({ head: text.slice(start, open).trim(), body: text.slice(open + 1, i) });
      start = i + 1;
    }
  }
  const scopes = media === undefined ? blocks.filter((b) => !b.head.startsWith('@')) : blocks.filter((b) => b.head === `@media (${media})`).flatMap((b) => [...b.body.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ head: m[1]!.trim(), body: m[2]! })));
  for (const b of scopes) {
    if (!b.head.split(',').map((s) => s.trim()).includes(selector)) continue;
    const decl = new RegExp(`(?:^|;)\\s*${escaped(prop)}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(b.body)?.[1];
    if (decl !== undefined) return decl.replace(/\s*!important$/, '');
  }
  return undefined;
};
/** A CSS value in the frame's spelling: no spaces, no leading zero before a point. */
const norm = (v: string | undefined) => (v ?? '').replace(/(^|[^\d.])0\./g, '$1.').replace(/\s+/g, '').replace(/'/g, '"');
/** A sheet token's value from dwg.css's `.dwg { … }` (sheet P keeps the base spot ink). */
const token = (name: string) => rule(dwgCss, '.dwg', name);

// The page's own classes. A change to one of these is a change to the frame's rule beside it.
const PAGE_ROOT = 'relative min-h-screen';
const PAGE_BACKDROP = 'fixed inset-0 z-0';
const PAGE_COLUMN = 'relative z-10 max-w-[1120px] mx-auto px-4 md:px-6 pt-8 pb-16';
const PAGE_SHEET = 'dwg dwg-sheet';
const PAGE_RULER = 'dwg-ruler';
const PAGE_HERO = 'mb-6';
const PAGE_H1 = 'dwg-word';
const DOOR_LINE = 'text-white/70 text-[13px]';
const HERO = ".dwg-sheet[data-sheet='P'] [data-dwg='hero']";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-first-frame');
  document.documentElement.removeAttribute('data-pools-frame');
  window.history.replaceState(null, '', '/');
});

describe('the pools page ships its heading in its own HTML', () => {
  it("puts the page's frame where the venue's was, inside #root, the gate open from the HTML", () => {
    expect(out.split('<!-- first-frame -->')).toHaveLength(2);
    expect(out.split('<!-- /first-frame -->')).toHaveLength(2);
    expect(frame.parentElement?.id).toBe('root');
    expect(frame.closest('main')).toBeNull();
    expect(doc.documentElement.getAttribute('data-first-frame')).toBe('venue');
  });

  it("is read by a crawler as one heading, the page's, with the no-script notice a paragraph", () => {
    expect(out.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
    expect(frame.querySelector('h1')?.textContent).toBe(POOLS_HEADING);
    expect(out).toMatch(/<noscript>[\s\S]*<p style="[^"]*;font-weight:700">MEMETICS\.FINANCE requires JavaScript<\/p>[\s\S]*<\/noscript>/);
  });

  it("carries none of the venue's frame: no field, no button, no picture, no venue heading", () => {
    expect(frame.querySelectorAll('form, input, button, img')).toHaveLength(0);
    expect(frame.textContent).not.toContain('MEMETICS.FINANCE');
  });

  it('never paints the word Loading, and no em dash', () => {
    expect(frame.textContent).not.toMatch(/loading/i);
    const values = Array.from(frame.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.value));
    expect([frame.textContent ?? '', FRAME_CSS, ...values].filter((v) => v.includes('\u2014'))).toEqual([]);
  });

  it('is drawn by its own rules alone, inline: the stylesheets have not arrived when it is painted', () => {
    expect(read('vite.config.ts')).toContain("name: 'first-frame-stylesheets'");
    expect(out).toContain(`${FRAME_CSS}</style>`);
    const classes = Array.from(frame.querySelectorAll('[class]')).flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/));
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(FRAME_CSS, `.${c} has no rule in the frame's own CSS`).toContain(`.${c}`);
    expect(Array.from(frame.querySelectorAll('[style]'))).toHaveLength(0);
  });

  it("adds no inline script, so the shell's CSP pins are the page's", () => {
    expect(pageHashes(out)).toEqual(pageHashes(shell));
  });

  it('dies unless the shell has exactly one first frame, one <html> and one style block to add to', () => {
    expect(() => transform(shell.replace('<!-- first-frame -->', ''))).toThrow(/first frame/);
    expect(() => transform(shell.replace('</head>', '<style></style></head>'))).toThrow(/frame styles/);
    expect(() => transform(shell.replace('<html lang="en">', '<html>'))).toThrow(/<html>/);
  });
});

describe("the frame's rules are what the page's classes compute to", () => {
  it("the heading: the page's words, in the sheet's word (styles/dwg.css .dwg-word), and its echo", () => {
    const h1 = /<h1 className="([^"]+)"([^>]*)>\s*([^<]+?)\s*<\/h1>/.exec(page);
    expect(h1?.[3]).toBe(POOLS_HEADING);
    expect(h1?.[1], 'the page restyled its heading: recut .pf-h1').toBe(PAGE_H1);
    // One text node, broken after its first word by its own width; the echo is drawn from data-echo.
    expect(h1?.[2]).toContain('data-break=""');
    expect(h1?.[2]).toContain(`data-echo="${POOLS_HEADING}"`);
    expect(frame.querySelector('h1')?.getAttribute('data-echo')).toBe(POOLS_HEADING);
    // Under 48rem: the sheet's word at 1.875rem on a line of 1.2, as tall as the heading was.
    expect(set(narrow, '.pf-h1', 'font-size')).toBe(rule(dwgCss, '.dwg-word', 'font-size'));
    expect(set(narrow, '.pf-h1', 'font-size')).toBe('1.875rem');
    expect(set(narrow, '.pf-h1', 'line-height')).toBe(rule(dwgCss, '.dwg-word', 'line-height'));
    expect(norm(set(narrow, '.pf-h1', 'margin'))).toBe(norm(rule(dwgCss, '.dwg-word', 'margin')));
    expect(norm(set(narrow, '.pf-h1', 'letter-spacing'))).toBe(norm(rule(dwgCss, '.dwg-word', 'letter-spacing')));
    expect(set(narrow, '.pf-h1', 'font-weight')).toBe(rule(dwgCss, '.dwg-word', 'font-weight'));
    expect(rule(dwgCss, '.dwg-word', 'color')).toBe('var(--dwg-ink)');
    expect(set(narrow, '.pf-h1', 'color')).toBe(token('--dwg-ink'));
    expect(rule(dwgCss, '.dwg-word', 'text-shadow')).toBe('none');
    expect(set(narrow, '.pf-h1', 'text-shadow')).toBe('none');
    expect(rule(dwgCss, '.dwg-word', 'font-family')).toBe('var(--font-family-heading)');
    expect(tight(set(narrow, '.pf-h1', 'font-family'))).toBe(tight(/--font-family-heading: ([^;]+);/.exec(indexCss)?.[1]));
    // From 48rem (Tailwind's md, 768px): the word large, tight, as narrow as its longest word.
    expect(norm(set(wide, '.pf-h1', 'font-size'))).toBe(norm(rule(dwgCss, '.dwg-word', 'font-size', 'min-width: 48rem')));
    expect(norm(set(wide, '.pf-h1', 'line-height'))).toBe(norm(rule(dwgCss, '.dwg-word', 'line-height', 'min-width: 48rem')));
    expect(norm(set(wide, '.pf-h1', 'letter-spacing'))).toBe(norm(rule(dwgCss, '.dwg-word', 'letter-spacing', 'min-width: 48rem')));
    expect(set(wide, '.pf-h1', 'width')).toBe(rule(dwgCss, ".dwg-word[data-break]", 'width', 'min-width: 48rem'));
    // The echo: the same words, outlined in the sheet's spot ink, behind and a step down and right.
    const echo = ".dwg-sheet[data-sheet='P'] .dwg-word[data-echo]::after";
    expect(set(narrow, '.pf-h1::after', 'content')).toBe(rule(poolsCss, echo, 'content'));
    expect(norm(set(narrow, '.pf-h1::after', 'transform'))).toBe(norm(rule(poolsCss, echo, 'transform')));
    expect(rule(poolsCss, echo, '-webkit-text-stroke')).toBe('1.5px var(--dwg-spot)');
    expect(set(narrow, '.pf-h1::after', '-webkit-text-stroke')).toBe(`1.5px ${token('--dwg-spot')}`);
    expect(set(narrow, '.pf-h1::after', 'z-index')).toBe(rule(poolsCss, echo, 'z-index'));
    // Drawing, not words: an empty alternative text, so the heading's name is said once.
    expect(FRAME_CSS).toContain('content:attr(data-echo);content:attr(data-echo) / ""');
    expect(poolsCss).toContain('content: attr(data-echo); content: attr(data-echo) / "";');
  });

  it("the body's text rules, which index.css brings after the frame is painted: smoothing and tabular figures", () => {
    const body = /\nbody \{([^}]*)\}/.exec(indexCss)?.[1] ?? '';
    expect(body).toContain('-webkit-font-smoothing: antialiased;');
    expect(body).toContain('-moz-osx-font-smoothing: grayscale;');
    expect(body, 'the body changed its figures: recut .pools-frame').toContain("font-feature-settings: 'tnum' 1;");
    expect(set(narrow, '.pools-frame', '-webkit-font-smoothing')).toBe('antialiased');
    expect(set(narrow, '.pools-frame', '-moz-osx-font-smoothing')).toBe('grayscale');
    // Without it the door's line is 5px wider until the sheet lands (e2e/pools-first-frame.spec.ts).
    expect(set(narrow, '.pools-frame', 'font-feature-settings')).toBe('"tnum" 1');
  });

  it("the shell: the page's root, its dark backdrop, its column, the sheet, its ruler and the hero block", () => {
    expect(page, 'the page changed its root: recut .pf-root').toContain(`<div className="${PAGE_ROOT}">`);
    expect(set(narrow, '.pf-root', 'min-height')).toBe('100vh');
    expect(page, 'the page changed its backdrop: recut .pf-bg').toContain(`<div className="${PAGE_BACKDROP}" style={{ background: '#060c1a' }}>`);
    expect(set(narrow, '.pf-bg', 'background')).toBe('#060c1a');
    expect(page, 'the page changed its column: recut .pf-col').toContain(`<div className="${PAGE_COLUMN}">`);
    expect(set(narrow, '.pf-col', 'max-width')).toBe('1120px');
    expect(set(narrow, '.pf-col', 'margin')).toBe('0 auto');
    expect(set(narrow, '.pf-col', 'padding')).toBe('2rem 1rem 4rem');
    expect([set(wide, '.pf-col', 'padding-left'), set(wide, '.pf-col', 'padding-right')]).toEqual(['1.5rem', '1.5rem']);
    // The sheet: its frame (styles/dwg.css .dwg-sheet), then its ruler, then the hero, in that order.
    expect(page, 'the page changed its sheet: recut .pf-sheet').toMatch(
      new RegExp(`<div className="${PAGE_SHEET}" data-sheet="P">\\s*<SheetRuler />\\s*<PoolField />\\s*<m\\.div className="${PAGE_HERO}" data-dwg="hero" `),
    );
    expect(norm(set(narrow, '.pf-sheet', 'border'))).toBe(norm(rule(dwgCss, '.dwg-sheet', 'border')));
    // The ruler: 15px tall from 48rem (its letters hang in it), none under; the frame counts its border in.
    expect(set(narrow, '.pf-ruler', 'height')).toBe(rule(dwgCss, '.dwg-ruler', 'height'));
    expect(set(narrow, '.pf-ruler', 'box-sizing')).toBe('border-box');
    expect(set(narrow, '.pf-ruler', 'display')).toBe(rule(dwgCss, '.dwg-ruler', 'display'));
    expect(set(wide, '.pf-ruler', 'display')).toBe(rule(dwgCss, '.dwg-ruler', 'display', 'min-width: 48rem'));
    // The hero: no margin (the sheet's parts stand flush), its padding the sheet's (dwg.css --dwg-pad).
    expect(page, 'the page changed its hero block: recut .pf-hero').toContain(`<m.div className="${PAGE_HERO}" `);
    expect(set(narrow, '.pf-hero', 'margin')).toBe(rule(poolsCss, HERO, 'margin'));
    const pad = token('--dwg-pad');
    expect(norm(set(narrow, '.pf-hero', 'padding'))).toBe(norm(rule(poolsCss, HERO, 'padding')?.replace('var(--dwg-pad)', pad!)));
    expect(norm(set(wide, '.pf-hero', 'padding'))).toBe(norm(rule(poolsCss, HERO, 'padding', 'min-width: 48rem')?.replace('var(--dwg-pad)', pad!)));
  });

  it("the LP door's waiting card, as LpDoorFrame draws it and the sheet flattens it", () => {
    expect(CARD, 'the card changed: recut .pf-door').toBe('rounded-2xl p-5 relative overflow-hidden');
    expect(doorSource).toContain('className={`${CARD} isolate mb-6`}');
    expect(doorSource).toContain('data-dwg="door"');
    expect(set(narrow, '.pf-door', 'padding')).toBe('1.25rem');
    expect(set(narrow, '.pf-door', 'margin')).toBe('0 0 1.5rem');
    // A flat hairline panel (styles/dwg-pools.css), over CARD_STYLE's inline border and fill.
    const door = "section[data-dwg='door']";
    expect(set(narrow, '.pf-door', 'border-radius')).toBe(rule(poolsCss, door, 'border-radius'));
    expect(tight(set(narrow, '.pf-door', 'border'))).toBe(tight(rule(poolsCss, door, 'border')));
    expect(tight(set(narrow, '.pf-door', 'background'))).toBe(tight(rule(poolsCss, door, 'background')));
    // Its line: white at 70%, 13px, on the body's own family, line and shadow.
    expect(doorSource).toMatch(new RegExp(`<p role="status" className="${escaped(DOOR_LINE)}">\\s*${escaped(DOOR_WAITING)}\\s*</p>`));
    expect(set(narrow, '.pf-door p', 'color')).toBe('rgba(255,255,255,0.7)');
    expect(set(narrow, '.pf-door p', 'font-size')).toBe('13px');
    expect(tight(set(narrow, '.pf-door p', 'font-family'))).toBe(tight(/--font-family-body: ([^;]+);/.exec(indexCss)?.[1]));
    expect(indexCss).toContain('text-shadow: 0 1px 4px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.6);');
    expect(tight(set(narrow, '.pf-door p', 'text-shadow'))).toBe(tight('0 1px 4px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.6)'));
    const card = frame.querySelector('.pf-door');
    expect(card?.querySelector('[role="status"]')?.textContent).toBe(DOOR_WAITING);
    expect(card?.nextElementSibling?.querySelector('h1'), 'the door stands above the heading, as on the page').not.toBeNull();
  });

  it('offers the door only while LP writes are on, as the page does', () => {
    expect(LP_DOOR).toBe(lpWriteMode({}, LP_WRITES) !== 'off');
    expect(poolsFrame().includes(DOOR_WAITING)).toBe(LP_DOOR);
    expect(page).toContain("lpMode !== 'off' && params.get('task') === 'add' ? params.get('mint') : null");
  });

  it('needs no room name on the card: every Solana room is one the sheet takes', () => {
    const rooms = BUNGALOWS.filter((b) => b.chain === 'solana' && b.address).map((b) => b.id);
    expect(rooms.length).toBeGreaterThan(0);
    expect(sheetRooms().map((b) => b.id)).toEqual(rooms);
  });
});

describe('the frame pads for what stands above the page in the app', () => {
  it("the bar and its edge, Bayla's line and the host's own padding, each read from where it is set", () => {
    // The bar: a 56px row (h-14) and a 1px bottom edge. Her line: 65px. The host: pt-14.
    expect(topNav).toContain('page-column mx-auto h-14 ');
    expect(topNav).toContain("? '1px solid rgba(255,255,255,0.10)'");
    expect(baylaLine).toContain('export const BAYLA_LINE_HEIGHT = 65;');
    expect(read('src/pages/SectionHost.tsx')).toContain('<div className="pt-14">');
    expect(set(narrow, '.pools-frame', 'padding-top')).toBe('calc(57px + 65px + 3.5rem + env(safe-area-inset-top,0px))');
  });

  it("stands her line down where BaylaLine does: a coin in the address of /pools, or the farm's voice asked for", () => {
    expect(baylaLine).toContain("if (location.pathname === '/pools' && new URLSearchParams(location.search).has('mint')) return null;");
    expect(baylaLine).toContain("if (voiceAt(location.pathname, location.search) === 'toweli') return null;");
    expect(read('src/lib/arrival.ts')).toContain("const q = new URLSearchParams(search).get('bungalow');\n    if (q === 'toweli') return 'toweli';");
    expect(set(narrow, 'html[data-pools-frame] .pools-frame', 'padding-top')).toBe('calc(57px + 3.5rem + env(safe-area-inset-top,0px))');
  });

  it('shows the door only when the address asks for an add', () => {
    expect(set(narrow, '.pf-door', 'display')).toBe('none');
    expect(set(narrow, 'html[data-pools-frame="door"] .pf-door', 'display')).toBe('block');
  });
});

describe('theme-init.js says what the address moves, before the frame is painted', () => {
  const stamp = (pathAndSearch: string) => {
    window.history.replaceState(null, '', pathAndSearch);
    document.documentElement.removeAttribute('data-pools-frame');
    new Function(themeInit)();
    return document.documentElement.getAttribute('data-pools-frame');
  };

  it.each([
    ['/pools', null],
    ['/pools?task=add', null],
    [`/pools?mint=${COIN}`, 'noline'],
    [`/pools?mint=${COIN}&task=remove`, 'noline'],
    ['/pools?bungalow=toweli', 'noline'],
    ['/pools?bungalow=toweli&task=add', 'noline'],
    ['/pools?bungalow=bayla', null],
    [`/pools?mint=${COIN}&task=add`, 'door'],
    [`/pools?mint=${COIN}&task=add&bungalow=toweli`, 'door'],
    ['/pools?mint=&task=add', 'door'],
    [`/swap?mint=${COIN}&task=add`, null],
    [`/?mint=${COIN}&task=add`, null],
  ])('%s', (address, want) => {
    expect(stamp(address)).toBe(want);
  });
});

describe("theme-init.js leaves a room's add link to the app", () => {
  // The script makes no move for a room's add link: the frame holds the door's place, and the
  // app's own redirect (lib/sheet.ts) opens the sheet. Sent on before the paint, the room
  // shows sooner and the Add form later (the island's measure on the slow-phone profile).
  it.each(sheetRooms().map((b) => [b.id, b] as const))("%s: no move before the paint, the door's place held", (_id, room) => {
    const search = `?mint=${room.address}&task=add&pool=${room.venueSolPool}`;
    const replace = vi.fn();
    const assign = vi.fn();
    document.documentElement.setAttribute('data-first-frame', 'venue');
    document.documentElement.removeAttribute('data-pools-frame');
    new Function('window', themeInit)({ location: { pathname: '/pools', search, hash: '', replace, assign } });
    expect(replace).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute('data-first-frame')).toBe('venue');
    expect(document.documentElement.getAttribute('data-pools-frame')).toBe('door');
    expect(deepLinkSheet('/pools', search)).toBe(`/${room.id}?sheet=add`);
  });
});

/** An element as a reader hears it: tag, role, name, its own text, and what it holds. */
const said = (el: Element): unknown => ({
  tag: el.tagName,
  role: el.getAttribute('role'),
  name: el.getAttribute('aria-label'),
  text: el.children.length ? null : el.textContent,
  kids: Array.from(el.children).map(said),
});

describe("React's fallback is the same frame, in the page's own classes", () => {
  const mount = (address: string) =>
    render(<MemoryRouter initialEntries={[address]}><PoolsFrame /></MemoryRouter>).container;
  const drawn = (address: string) => mount(address).querySelector('[aria-busy="true"] > div')!;
  const still = () => frame.querySelector('.pools-frame > div')!.cloneNode(true) as Element;

  it("is busy, under the host's padding, and never says Loading", () => {
    const fallback = mount('/pools').firstElementChild!;
    expect(fallback.getAttribute('aria-busy')).toBe('true');
    expect(fallback.getAttribute('class')).toBe('pt-14');
    expect(fallback.textContent).not.toMatch(/loading/i);
  });

  it('says what the static frame says on /pools, element for element', () => {
    const plain = still();
    plain.querySelector('.pf-door')?.remove();
    expect(said(drawn('/pools'))).toEqual(said(plain));
  });

  it('says the door above the heading when the address asks for an add, as the static frame does', () => {
    const react = drawn(`/pools?mint=${COIN}&task=add`);
    expect(react.querySelector('[role="status"]')?.textContent).toBe(DOOR_WAITING);
    expect(said(react)).toEqual(said(still()));
  });

  it.each(['/pools?task=add', `/pools?mint=${COIN}`, `/pools?mint=${COIN}&task=remove`])('draws no door on %s', (address) => {
    expect(mount(address).querySelector('[role="status"]')).toBeNull();
  });

  it("wears the page's classes, so the page takes its place without a move", () => {
    const react = drawn(`/pools?mint=${COIN}&task=add`);
    const heading = react.querySelector('h1')!;
    expect(react.getAttribute('class')).toBe(PAGE_ROOT);
    expect(react.firstElementChild?.getAttribute('class')).toBe(PAGE_BACKDROP);
    expect((react.firstElementChild as HTMLElement).style.background).toBe('rgb(6, 12, 26)');
    const hero = heading.parentElement!;
    const sheet = hero.parentElement!;
    expect(sheet.parentElement!.getAttribute('class')).toBe(PAGE_COLUMN);
    expect(sheet.getAttribute('class')).toBe(PAGE_SHEET);
    expect(sheet.getAttribute('data-sheet')).toBe('P');
    const ruler = sheet.firstElementChild!;
    expect(ruler.getAttribute('class')).toBe(PAGE_RULER);
    expect(Array.from(ruler.children).map((i) => i.getAttribute('data-z'))).toEqual(RULER_ZONES);
    expect(Array.from(frame.querySelectorAll('.pf-ruler > i')).map((i) => i.getAttribute('data-z'))).toEqual(RULER_ZONES);
    expect(hero.getAttribute('class')).toBe(PAGE_HERO);
    expect(hero.getAttribute('data-dwg')).toBe('hero');
    expect(heading.getAttribute('class')).toBe(PAGE_H1);
    expect(heading.getAttribute('data-echo')).toBe(POOLS_HEADING);
    expect(heading.hasAttribute('data-break')).toBe(true);
    const card = react.querySelector('section')!;
    expect(card.getAttribute('class')).toBe(`${CARD} isolate mb-6`);
    expect(card.getAttribute('data-dwg')).toBe('door');
    expect(tight(card.style.border)).toBe(tight(CARD_STYLE.border));
    expect(tight(card.style.background)).toBe(tight(CARD_STYLE.background));
    expect(card.querySelector('[role="status"]')!.getAttribute('class')).toBe(DOOR_LINE);
  });
});

describe('which fallback /pools gets', () => {
  /** The app's modules, loaded as on a fresh document that opened on `address`. */
  async function opened(address: string, framePainted: boolean) {
    vi.resetModules();
    window.history.replaceState(null, '', address);
    if (framePainted) document.documentElement.setAttribute('data-first-frame', 'venue');
    else document.documentElement.removeAttribute('data-first-frame');
    const { PoolsFallback } = await import('./PoolsFrame');
    const { poolsFrameReplaced } = await import('../lib/poolsFrame');
    const draw = (panel = false) =>
      render(<MemoryRouter initialEntries={['/pools']}><PoolsFallback panel={panel} /></MemoryRouter>).container;
    return { draw, poolsFrameReplaced };
  }

  it.each(['/pools', '/pools/', `/pools?mint=${COIN}`])('the frame, for the route and for the host, when the document opened on %s', async (address) => {
    const { draw } = await opened(address, true);
    for (const panel of [false, true]) {
      const fallback = draw(panel);
      expect(fallback.querySelector('h1')?.textContent).toBe(POOLS_HEADING);
      expect(fallback.textContent).not.toMatch(/loading/i);
      cleanup();
    }
  });

  it.each([
    ['/pools', false, 'no static frame was painted (the stock shell)'],
    ['/swap', true, 'the document opened elsewhere'],
    ['/', true, "the venue's own frame was the one painted"],
  ])('the skeleton each place had, when the document opened on %s (frame painted: %s): %s', async (address, painted) => {
    const { draw } = await opened(address, painted);
    expect(draw().querySelector('[aria-label="Loading swap"]')).not.toBeNull();
    cleanup();
    expect(draw(true).querySelector('[aria-label="Loading page"]')).not.toBeNull();
  });

  it('the skeleton again once the page has drawn its own heading', async () => {
    const { draw, poolsFrameReplaced } = await opened('/pools', true);
    poolsFrameReplaced();
    const fallback = draw();
    expect(fallback.querySelector('h1')).toBeNull();
    expect(fallback.querySelector('[aria-label="Loading swap"]')).not.toBeNull();
  });
});

describe("a room's add link keeps the frame up while the app sends it to the room", () => {
  const room = sheetRooms()[0]!;
  const link = `/pools?mint=${room.address}&task=add&pool=${room.venueSolPool}`;
  /** The app's modules, loaded as on a fresh document that opened on `address`. */
  async function opened(address: string, framePainted: boolean) {
    vi.resetModules();
    window.history.replaceState(null, '', address);
    if (framePainted) document.documentElement.setAttribute('data-first-frame', 'venue');
    else document.documentElement.removeAttribute('data-first-frame');
    const { PoolsLeaving, PoolsFallback } = await import('./PoolsFrame');
    const leaving = (at: string) => render(<MemoryRouter initialEntries={[at]}><PoolsLeaving /></MemoryRouter>).container;
    const fallback = () => render(<MemoryRouter initialEntries={['/pools']}><PoolsFallback /></MemoryRouter>).container;
    return { leaving, fallback };
  }

  it('the frame, the door above the heading, when the document opened on the link with its frame painted', async () => {
    expect(deepLinkSheet('/pools', link.slice('/pools'.length))).toBe(`/${room.id}?sheet=add`);
    const { leaving } = await opened(link, true);
    const drawn = leaving(link);
    expect(drawn.querySelector('[aria-busy="true"] h1')?.textContent).toBe(POOLS_HEADING);
    expect(drawn.querySelector('[role="status"]')?.textContent).toBe(DOOR_WAITING);
    expect(drawn.textContent).not.toMatch(/loading/i);
  });

  it('once: a later press of the link draws nothing, and a later visit to /pools has its skeleton', async () => {
    const { leaving, fallback } = await opened(link, true);
    expect(leaving(link).querySelector('h1')).not.toBeNull();
    cleanup();
    expect(leaving(link).innerHTML).toBe('');
    cleanup();
    const later = fallback();
    expect(later.querySelector('h1')).toBeNull();
    expect(later.querySelector('[aria-label="Loading swap"]')).not.toBeNull();
  });

  it("is mounted by the sheet's redirect alone, so the page's own addresses never draw it", () => {
    const sheet = read('src/components/sheet/ActionSheet.tsx');
    expect(sheet).toContain('return to ? <><PoolsLeaving /><Navigate to={to} replace /></> : <>{children}</>;');
    expect(sheet.match(/<PoolsLeaving \/>/g)).toHaveLength(1);
    expect(read('src/App.tsx')).not.toContain('PoolsLeaving');
  });

  it('nothing when no frame was painted, or the document opened on another page', async () => {
    expect((await opened(link, false)).leaving(link).innerHTML).toBe('');
    cleanup();
    expect((await opened('/swap', true)).leaving(link).innerHTML).toBe('');
  });
});
