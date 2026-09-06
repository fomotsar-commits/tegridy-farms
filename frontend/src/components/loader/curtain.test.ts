// A CURTAIN, NOT A WALL — the guard on element A's central claim.
//
// This is a SOURCE guard, and it is a stopgap with a reason. The honest test is
// an e2e that loads / cold and asserts `document.elementFromPoint` over the hero
// returns the hero and not the canvas — because in this repo "visible" and
// "clickable" are different questions and only the second one matters here. That
// e2e cannot run yet: playwright.config.ts sets `reducedMotion: 'reduce'`
// globally and the wallet fixture pre-seeds the arrival key, so every spec skips
// the curtain before it can look at it. Writing the assertion against a curtain
// that never mounts would be worse than this: it would pass vacuously and read
// like coverage.
//
// So this pins the three lines that decide it, at the source, until a spec that
// opts out of both lands. If somebody deletes the pass-through, this goes red.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'AppLoader.tsx'), 'utf8');

/**
 * The overlay's own style block, and nothing else.
 *
 * Scoped deliberately: a whole-file grep for `pointerEvents: 'none'` passes on
 * the COMMENT that explains it, so deleting the real line reds nothing. That is
 * not hypothetical — it is what the first version of this file did, and the
 * mutation run caught it. Assertions here read the element, not the prose about
 * the element.
 */
const overlayStyle = src.slice(src.indexOf('ref={overlayRef}'), src.indexOf('<canvas'));

describe('the curtain does not capture the page', () => {
  it('renders the overlay pass-through', () => {
    // The evidence this fixes, from AppLoader's own note: elementFromPoint over
    // the Connect button returned CANVAS at 1s, 3s, 6s and 10s, indefinitely.
    expect(overlayStyle).toContain("pointerEvents: 'none'");
  });

  it('gives the overlay no pointer cursor, because nothing there is clickable', () => {
    // The old overlay advertised itself as a click target for the whole page.
    expect(overlayStyle).not.toContain("cursor: 'pointer'");
  });

  it('opts BOTH controls back in, so Skip and Mute still work', () => {
    // One 'none' on the overlay and two 'auto's beneath it. If a control loses
    // its opt-in it becomes unclickable while looking perfectly fine.
    const optIns = src.match(/pointerEvents: 'auto'/g) ?? [];
    expect(optIns).toHaveLength(2);
  });
});

describe('any input lifts it at once', () => {
  it('listens for every input the element names, not just Escape', () => {
    // "Any pointerdown, touchstart, keydown, wheel or scroll anywhere on the
    // document lifts it at once." Escape alone was the old behaviour.
    for (const type of ['pointerdown', 'touchstart', 'keydown', 'wheel', 'scroll']) {
      expect(src, `${type} does not lift the curtain`).toContain(`'${type}'`);
    }
  });

  it('binds them passively, so the curtain can never block scrolling', () => {
    expect(src).toContain('passive: true');
  });

  it('binds them on capture, so a stopPropagation cannot strand the curtain up', () => {
    expect(src).toContain('capture: true');
  });

  it('removes them with the same capture flag, or they would leak', () => {
    // removeEventListener only matches a listener added with the same capture
    // value. Getting this wrong leaves a listener per mount, forever.
    expect(src).toContain('{ capture: true }');
  });
});
