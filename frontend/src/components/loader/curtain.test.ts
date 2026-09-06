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
import {
  CURTAIN_TIMING, FILM_TIMING, CURTAIN_BUDGET_MS,
  T_VOID_END, T_ART_COUNT, T_ART_DURATION,
} from './constants';

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
  it('renders the ARRIVAL pass-through and the FILM clickable', () => {
    // The evidence this fixes, from AppLoader's own note: elementFromPoint over
    // the Connect button returned CANVAS at 1s, 3s, 6s and 10s, indefinitely.
    // The film opts back in because its click-to-crack exit is part of the art.
    expect(overlayStyle).toContain("pointerEvents: full ? 'auto' : 'none'");
  });

  it('gives the overlay no pointer cursor, because nothing there is clickable', () => {
    // The old overlay advertised itself as a click target for the whole page.
    expect(overlayStyle).not.toContain("cursor: 'pointer'");
  });

  it('opts BOTH controls back in, so Skip and Mute still work', () => {
    // Two standalone 'auto's, one per control, beneath the overlay's ternary.
    // If a control loses its opt-in it becomes unclickable while looking fine.
    const optIns = src.match(/^\s+pointerEvents: 'auto',$/gm) ?? [];
    expect(optIns).toHaveLength(2);
  });
});

describe('two arrivals, one component', () => {
  it('gives the curtain one art piece and the film all four', () => {
    expect(CURTAIN_TIMING.artCount).toBe(1);
    expect(FILM_TIMING.artCount).toBe(T_ART_COUNT);
    expect(T_ART_COUNT).toBe(4);
  });

  it('fits the curtain inside its stated budget with no input at all', () => {
    // The element's promise is that the curtain is gone by 3000 ms. void + art
    // + the 400 ms dissolve must leave room for the wordmark to form.
    const floor = CURTAIN_TIMING.voidEnd + CURTAIN_TIMING.artCount * CURTAIN_TIMING.artDuration + 400;
    expect(floor).toBeLessThan(CURTAIN_BUDGET_MS);
  });

  it('leaves the film exactly as it was', () => {
    // No art is removed by this element; it is re-homed. If the film's timings
    // ever drift from the originals, the four-piece arrival has been edited.
    expect(FILM_TIMING).toEqual({
      voidEnd: T_VOID_END,
      artCount: T_ART_COUNT,
      artDuration: T_ART_DURATION,
    });
  });

  it('routes the curtain past the shatter, and the film through it', () => {
    // SCOPED TO THE BRANCH, and that is the whole point of this assertion.
    // The first version checked that 'shatter' and 'textForm' both appeared
    // SOMEWHERE in the file — which is true however the branch is wired, so
    // routing the curtain into the shatter reddened nothing. The mutation run
    // caught it. Same lesson as the pointerEvents guard above: assert the
    // decision, never the vocabulary.
    const artEnd = src.slice(
      src.indexOf('if (pieceIdx >= s.images.length) {'),
      src.indexOf('const img = s.images[pieceIdx]!'),
    );
    const [filmBranch, curtainBranch] = artEnd.split('} else {');

    expect(filmBranch).toContain("s.phase = 'shatter';");
    expect(curtainBranch).toContain("s.phase = 'textForm';");
    expect(curtainBranch, 'the curtain must not route through the spectacle')
      .not.toContain("s.phase = 'shatter';");
  });

  it('ends the curtain on the dissolve and the film on the hold', () => {
    const textFormEnd = src.slice(
      src.indexOf('if (drawTextFormPhase('),
      src.indexOf("/* HOLD */"),
    );
    const [filmBranch, curtainBranch] = textFormEnd.split('} else {');

    expect(filmBranch).toContain("s.phase = 'hold';");
    expect(curtainBranch).toContain("s.phase = 'skip';");
    expect(curtainBranch, 'the curtain has nothing to wait for')
      .not.toContain("s.phase = 'hold';");
  });

  it('does not let a stray scroll dismiss a deliberate viewing', () => {
    // "Watch the arrival" is something somebody chose. Only Escape ends it.
    expect(src).toContain("? ['keydown']");
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
