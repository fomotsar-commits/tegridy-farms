import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOORS, HEADING_STYLE, LOT_FRAME, PILL_ROW_STYLE, transform } from '../../scripts/render-bungalow-doors.mjs';
import { BUNGALOWS, DEFAULT_BUNGALOW_ID, OPEN_LOT_HERO, TOWELI_HERO, type Bungalow, type BungalowIdentity } from '../lib/bungalows';
import { pageArt } from '../lib/artConfig';
import { DoorFrame, LotFrame } from './DoorFrame';
import { BungalowHero } from './bungalow/BungalowHero';
import { BungalowDoor } from './bungalow/BungalowDoor';
import { BungalowDoorLanding } from './bungalow/BungalowDoorLanding';

// A door's heading is on screen three times: the build's static frame, this fallback
// (React's first commit replaces the first), then the hero. All three read the same
// words in the same place, or the visitor watches the heading change as the page arrives.

const shell = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const cssText = (style: string) => {
  const probe = document.createElement('div');
  probe.setAttribute('style', style);
  return probe.style.cssText;
};

// The TOWELI room's hero is HomePage's classic cluster, and HomePage needs the whole
// provider tree to render, so its H1 is read from source: the two constants, the space
// at the joint, nothing else. e2e/door-first-frame.spec.ts watches the rendered one.
const homeSource = readFileSync(resolve(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8');
const CLASSIC_H1 =
  /<h1 className="([^"]+)">\s*\{TOWELI_HERO\.heroTitle\}\{' '\}<br \/><span className="text-white">\{TOWELI_HERO\.heroLine\}<\/span>\s*<\/h1>/g;

/** The hero H1 HomePage renders behind this door: its text and its class (which sets its place). */
function heroH1(b: Bungalow): { text: string | null | undefined; className: string | undefined } {
  if (b.identity) {
    const h1 = render(<MemoryRouter><BungalowHero bungalow={b as Bungalow & { identity: BungalowIdentity }} /></MemoryRouter>)
      .container.querySelector('h1');
    return { text: h1?.textContent, className: h1?.className };
  }
  if (b.id !== DEFAULT_BUNGALOW_ID) return { text: undefined, className: undefined };
  const found = [...homeSource.matchAll(CLASSIC_H1)];
  expect(found, "HomePage's classic H1 no longer reads TOWELI_HERO, once").toHaveLength(1);
  return { text: `${TOWELI_HERO.heroTitle} ${TOWELI_HERO.heroLine}`, className: found[0]![1] };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

// Every door but the open lot opens a live room's home; the lot opens its landing.
const HOME_DOORS = DOORS.filter((d) => BUNGALOWS.find((b) => b.id === d.path)?.live);

describe("a door's fallback while its home page loads", () => {
  it('covers every door but the open lot, which has a fallback of its own', () => {
    expect(DOORS.filter((d) => !HOME_DOORS.includes(d)).map((d) => d.path)).toEqual(['nb1']);
  });

  for (const door of HOME_DOORS) {
    it(`${door.path}: says what the static frame said and what the hero will say`, () => {
      localStorage.setItem('tegridy-bungalow', door.path);
      const bungalow = BUNGALOWS.find((b) => b.id === door.path)!;
      const frame = render(<DoorFrame id={door.path} />).container;
      const hero = heroH1(bungalow);
      const html = new DOMParser().parseFromString(transform(shell, door), 'text/html');

      const heading = frame.querySelector('h1')?.textContent;
      expect(heading).toBe(`${door.heroTitle} ${door.heroLine}`);
      expect(hero.text, 'the hero would change the words').toBe(heading);
      expect(html.querySelector('#first-frame h1')?.textContent, 'the static frame says something else').toBe(heading);
      expect(frame.textContent).not.toMatch(/loading/i);
      const spacer = frame.querySelector('.ff-col > div[aria-hidden="true"]') as HTMLElement | null;
      const staticSpacer = html.querySelector('#first-frame .ff-col > div[aria-hidden="true"]') as HTMLElement | null;
      expect(spacer?.style.cssText, 'the pill-row spacer differs from the static one').toBe(cssText(PILL_ROW_STYLE));
      expect(staticSpacer?.style.cssText).toBe(cssText(PILL_ROW_STYLE));
      expect(spacer?.nextElementSibling?.tagName).toBe('H1');
      expect(frame.querySelector('h1')?.style.cssText, 'the fallback spaces its letters differently').toBe(cssText(HEADING_STYLE));
      expect(html.querySelector('#first-frame h1')?.getAttribute('style')).toBe(HEADING_STYLE);
    });

    it(`${door.path}: is busy, and draws the hero's own art at its crop`, () => {
      localStorage.setItem('tegridy-bungalow', door.path);
      const frame = render(<DoorFrame id={door.path} />).container;
      expect(frame.firstElementChild?.getAttribute('aria-busy')).toBe('true');
      const art = pageArt('home', 0);
      const img = frame.querySelector('img');
      expect(img?.getAttribute('src')).toBe(art.src);
      expect(img?.getAttribute('alt')).toBe('');
      expect(img?.getAttribute('loading')).toBeNull();
      expect(img?.getAttribute('fetchpriority')).toBe('high');
      expect(img?.style.objectPosition ?? '').toBe(art.objectPosition ?? '');
    });
  }

  it('keeps the skeleton for a door with no hero of its own (BungalowDoor gives the lot LotFrame)', () => {
    localStorage.setItem('tegridy-bungalow', 'nb1');
    const frame = render(<DoorFrame id="nb1" />).container;
    expect(frame.querySelector('h1')).toBeNull();
    expect(frame.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('holds the TOWELI heading at /toweli and /towelie, where the classic hero will render it', () => {
    for (const path of ['/toweli', '/towelie']) {
      window.history.replaceState(null, '', path);
      localStorage.setItem('tegridy-bungalow', DEFAULT_BUNGALOW_ID);
      const frame = render(<DoorFrame id={DEFAULT_BUNGALOW_ID} />).container;
      expect(frame.querySelector('h1')?.textContent, path).toBe(`${TOWELI_HERO.heroTitle} ${TOWELI_HERO.heroLine}`);
      expect(frame.firstElementChild?.getAttribute('aria-busy')).toBe('true');
      cleanup();
    }
  });

  it("sets the TOWELI heading where every other room's hero sets its own", () => {
    const toweli = heroH1(BUNGALOWS.find((b) => b.id === DEFAULT_BUNGALOW_ID)!);
    const bayla = heroH1(BUNGALOWS.find((b) => b.id === 'bayla')!);
    expect(bayla.className).toBeTruthy();
    expect(toweli.className, 'the static frame is placed for the room hero H1, so this one would jump').toBe(bayla.className);
  });

  it('never names TOWELI when another room is the one that will render', () => {
    window.history.replaceState(null, '', '/toweli');
    localStorage.setItem('tegridy-bungalow', 'bayla');
    expect(render(<DoorFrame id={DEFAULT_BUNGALOW_ID} />).container.querySelector('h1')).toBeNull();
  });

  it("never names a door the hero will not render (no skin written, or another one)", () => {
    for (const stored of [null, 'pepe']) {
      localStorage.clear();
      if (stored) localStorage.setItem('tegridy-bungalow', stored);
      const frame = render(<DoorFrame id="bayla" />).container;
      expect(frame.querySelector('h1'), `stored skin ${stored}`).toBeNull();
      cleanup();
    }
  });
});

// Answer sixteen, ruling 9: the open lot's heading in its own words over its own picture,
// the same bar as the twelve. Its page is the landing, so its frame sits where the
// landing's plaque sits (LOT_FRAME), and the picture is fixed (OPEN_LOT_HERO).
describe("the open lot's fallback while its landing loads", () => {
  const lotDoor = DOORS.find((d) => d.path === 'nb1')!;
  const lot = BUNGALOWS.find((b) => b.id === 'nb1')!;
  const heading = `${OPEN_LOT_HERO.heroTitle} ${OPEN_LOT_HERO.heroLine}`;
  const staticFrame = () => new DOMParser().parseFromString(transform(shell, lotDoor), 'text/html').getElementById('first-frame')!;
  const landing = () => render(<MemoryRouter><BungalowDoorLanding bungalow={lot} /></MemoryRouter>).container;

  it('is what BungalowDoor shows for the lot until the landing arrives: never nothing, never the skeleton', async () => {
    const view = render(<MemoryRouter><BungalowDoor id="nb1"><div>home</div></BungalowDoor></MemoryRouter>);
    const busy = view.container.querySelector('[aria-busy="true"]');
    expect(busy, 'the heading leaves the screen while the landing chunk loads').not.toBeNull();
    expect(busy!.querySelector('h1')?.textContent).toBe(heading);
    expect(view.container.querySelector('[aria-label="Loading page"]')).toBeNull();
    await view.findByRole('link', { name: /How a community gets a bungalow here\./ });
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(view.container.querySelector('h1')?.textContent).toBe(heading);
  });

  it('says what the static frame said and what the landing will say', () => {
    const frame = render(<LotFrame />).container;
    expect(frame.firstElementChild?.getAttribute('aria-busy')).toBe('true');
    expect(frame.querySelector('h1')?.textContent).toBe(heading);
    expect(frame.textContent).not.toMatch(/loading/i);
    expect(staticFrame().querySelector('h1')?.textContent).toBe(heading);
    expect(landing().querySelector('h1')?.textContent).toBe(heading);
  });

  it("holds the landing's place, as the static frame does", () => {
    const frame = render(<LotFrame />).container;
    const html = staticFrame();
    const placed = (root: ParentNode) => ({
      wrap: (root.querySelector('.ff-wrap') as HTMLElement).style.cssText,
      col: (root.querySelector('.ff-col') as HTMLElement).style.cssText,
      spacer: (root.querySelector('.ff-col > div[aria-hidden="true"]') as HTMLElement).style.cssText,
      veil: (root.querySelector('.ff-bg > div') as HTMLElement | null)?.style.cssText,
      h1: (root.querySelector('h1') as HTMLElement).style.cssText,
    });
    const want = {
      wrap: cssText(LOT_FRAME.wrap),
      col: cssText(LOT_FRAME.col),
      spacer: cssText(LOT_FRAME.spacer),
      veil: cssText(LOT_FRAME.veil),
      h1: cssText(HEADING_STYLE),
    };
    expect(placed(frame), 'the fallback').toEqual(want);
    expect(placed(html), 'the static frame').toEqual(want);
    expect(html.querySelector('.ff-col > div[aria-hidden="true"]')?.nextElementSibling?.tagName).toBe('H1');
    // The landing's own veil, so the picture does not darken at the swap.
    const veil = landing().querySelector('.fixed > div.absolute') as HTMLElement;
    expect(veil.style.background).toBe((frame.querySelector('.ff-bg > div') as HTMLElement).style.background);
  });

  it('draws the lot its own picture, eagerly, whatever skin is stored', () => {
    const html = staticFrame().querySelector('img')!;
    expect([html.getAttribute('src'), html.style.objectPosition]).toEqual([OPEN_LOT_HERO.heroArt, OPEN_LOT_HERO.heroPosition]);
    for (const stored of [null, 'venue', 'bayla', 'pepe', DEFAULT_BUNGALOW_ID]) {
      localStorage.clear();
      if (stored) localStorage.setItem('tegridy-bungalow', stored);
      for (const [who, img] of [
        ['the fallback', render(<LotFrame />).container.querySelector('.ff-bg img')],
        ['the landing', landing().querySelector('.fixed img')],
      ] as const) {
        const what = `${who}, stored skin ${stored}`;
        expect(img?.getAttribute('src'), what).toBe(OPEN_LOT_HERO.heroArt);
        expect((img as HTMLElement | null)?.style.objectPosition, what).toBe(OPEN_LOT_HERO.heroPosition);
        expect(img?.getAttribute('alt'), what).toBe('');
        expect(img?.getAttribute('loading'), what).toBeNull();
        expect(img?.getAttribute('fetchpriority'), what).toBe('high');
      }
      cleanup();
    }
  });

  it("is the lot's alone: every other door's frame keeps the hero's place", () => {
    for (const door of HOME_DOORS) {
      const html = new DOMParser().parseFromString(transform(shell, door), 'text/html');
      expect(html.querySelector('.ff-wrap')?.getAttribute('style'), door.path).toBeNull();
      expect(html.querySelector('.ff-col')?.getAttribute('style'), door.path).toBeNull();
      expect(html.querySelectorAll('.ff-bg > *'), door.path).toHaveLength(1);
    }
  });
});
