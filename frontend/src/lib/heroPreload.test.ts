// PERF-14. index.html preloaded 463,341 bytes of images at high priority on
// EVERY route: /art/bobowelie.jpg (a nav button and an avatar, never the LCP
// element) and the home hero. Both were unconditional, so the eight SOON routes,
// every prerendered bungalow door, and every bungalow visitor paid for images
// they never render.
//
// bobowelie is gone. The hero moved into /theme-init.js, which already runs
// synchronously in <head> and can read the two conditions a static tag cannot:
// that we are on `/`, and that the classic skin is active.
//
// THE LOCK-STEP THIS PINS: /theme-init.js hardcodes the hero's path and the
// default bungalow's id, because it is a plain classic script that cannot import
// the registry. A hardcoded value with no test is a value that drifts silently —
// the symptom would be a high-priority preload of an image the page does not
// render, which no error anywhere reports.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageArt } from './artConfig';
import { DEFAULT_BUNGALOW_ID } from './bungalows';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const themeInit = readFileSync(join(FRONTEND, 'public', 'theme-init.js'), 'utf8');
const indexHtml = readFileSync(join(FRONTEND, 'index.html'), 'utf8');

/** The value of a `var NAME = '…';` line in the bootstrap script. */
function literal(name: string): string {
  const m = new RegExp(`var ${name} = '([^']*)';`).exec(themeInit);
  if (!m) throw new Error(`theme-init.js no longer declares ${name}`);
  return m[1]!;
}

describe('the home hero preload', () => {
  it('names the image the classic home page actually renders', () => {
    // No bungalow stored in this environment, so this IS the classic resolution.
    expect(localStorage.getItem('tegridy-bungalow')).toBeNull();
    expect(literal('HERO_SRC')).toBe(pageArt('home', 0).src);
  });

  it('names the same default bungalow the registry does', () => {
    expect(literal('DEFAULT_BUNGALOW_ID')).toBe(DEFAULT_BUNGALOW_ID);
  });

  it('reads the storage key the registry writes', () => {
    expect(literal('BUNGALOW_STORAGE_KEY')).toBe('tegridy-bungalow');
  });

  it('is emitted only on the route that renders it', () => {
    expect(themeInit).toContain("window.location.pathname === '/'");
  });
});

describe('index.html preloads no image unconditionally', () => {
  it('has no rel=preload as=image tag left', () => {
    // A static tag cannot know the route or the skin, so any image preload here
    // is one that fires on all of them.
    expect(indexHtml).not.toMatch(/<link[^>]*rel="preload"[^>]*as="image"/);
  });

  it('no longer warms the nav button at first-paint priority', () => {
    expect(indexHtml).not.toContain('bobowelie.jpg');
  });

  it('still preloads the fonts, so this did not delete the wrong thing', () => {
    expect(indexHtml).toMatch(/<link rel="preload"[^>]*as="font"/);
  });
});


// The string checks above prove the VALUES are in lock-step. This runs the
// bootstrap for real and checks the DECISION, which is the half that can be
// wrong while every literal is right.
describe('theme-init.js emits the preload only where the hero is rendered', () => {
  function run(pathAndSearch: string): HTMLLinkElement | null {
    window.history.replaceState(null, '', pathAndSearch);
    document.head.querySelectorAll('link[rel="preload"][as="image"]').forEach((n) => n.remove());
    // Executed rather than pattern-matched: this file ships to browsers as-is.
    new Function(themeInit)();
    return document.head.querySelector('link[rel="preload"][as="image"]');
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    document.head.querySelectorAll('link[rel="preload"][as="image"]').forEach((n) => n.remove());
  });

  it('preloads the hero at high priority for a first-time visitor on /', () => {
    const link = run('/');
    expect(link?.getAttribute('href')).toBe(pageArt('home', 0).src);
    expect(link?.getAttribute('fetchpriority')).toBe('high');
  });

  it('preloads nothing on a route that does not render it', () => {
    // /soon, /swap, /farm and every prerendered bungalow door used to pay for
    // this image; none of them render it.
    expect(run('/swap')).toBeNull();
  });

  it('preloads nothing for a visitor wearing a bungalow skin', () => {
    // Their home:0 resolves into that bungalow's own pool, so this file is an
    // image they never see.
    localStorage.setItem('tegridy-bungalow', 'bayla');
    expect(run('/')).toBeNull();
  });

  it('still preloads for a visitor who chose the venue itself', () => {
    localStorage.setItem('tegridy-bungalow', DEFAULT_BUNGALOW_ID);
    expect(run('/')?.getAttribute('href')).toBe(pageArt('home', 0).src);
  });

  it('preloads nothing when a deep link names another bungalow', () => {
    expect(run('/?bungalow=bayla')).toBeNull();
  });
});
