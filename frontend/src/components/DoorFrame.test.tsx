import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOORS, HEADING_STYLE, PILL_ROW_STYLE, transform } from '../../scripts/render-bungalow-doors.mjs';
import { BUNGALOWS, type Bungalow, type BungalowIdentity } from '../lib/bungalows';
import { pageArt } from '../lib/artConfig';
import { DoorFrame } from './DoorFrame';
import { BungalowHero } from './bungalow/BungalowHero';

// A door's heading is on screen three times: the build's static frame, this fallback
// (React's first commit replaces the first), then the hero. All three read the same
// words in the same place, or the visitor watches the heading change as the page arrives.

const shell = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const cssText = (style: string) => {
  const probe = document.createElement('div');
  probe.setAttribute('style', style);
  return probe.style.cssText;
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("a door's fallback while its home page loads", () => {
  for (const door of DOORS) {
    it(`${door.path}: says what the static frame said and what the hero will say`, () => {
      localStorage.setItem('tegridy-bungalow', door.path);
      const bungalow = BUNGALOWS.find((b) => b.id === door.path) as Bungalow & { identity: BungalowIdentity };
      const frame = render(<DoorFrame id={door.path} />).container;
      const hero = render(<MemoryRouter><BungalowHero bungalow={bungalow} /></MemoryRouter>).container;
      const html = new DOMParser().parseFromString(transform(shell, door), 'text/html');

      const heading = frame.querySelector('h1')?.textContent;
      expect(heading).toBe(`${door.heroTitle} ${door.heroLine}`);
      expect(hero.querySelector('h1')?.textContent, 'the hero would change the words').toBe(heading);
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

  it('keeps the skeleton for a door with no hero of its own', () => {
    for (const id of ['toweli', 'nb1']) {
      localStorage.setItem('tegridy-bungalow', id);
      const frame = render(<DoorFrame id={id} />).container;
      expect(frame.querySelector('h1')).toBeNull();
      expect(frame.querySelector('[aria-busy="true"]')).not.toBeNull();
      cleanup();
    }
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
