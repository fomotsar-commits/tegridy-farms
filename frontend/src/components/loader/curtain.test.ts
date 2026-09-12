// A CURTAIN, NOT A WALL - the DECISIONS behind element A, pinned at the source.
//
// This file used to open with an apology: it said the honest test was an e2e
// asserting elementFromPoint over the hero, that such a spec could not run
// because playwright.config sets reducedMotion 'reduce' globally and the wallet
// fixture pre-seeds the arrival key, and that this stood in until one landed.
//
// It has landed. e2e/arrival.spec.ts opts out of both and walks the real thing:
// the hero reachable under a live curtain, the curtain gone inside its budget
// by a MEASURED number, once per browser proved by loading the page twice, and
// a slow picture that still draws. Every claim about behaviour belongs there.
//
// The apology goes; the file stays, and its job is now stated rather than
// excused. These are DECISIONS, and a decision is cheapest to pin where it was
// made: the pass-through, the two-stage deadline, the phase wiring, the timings
// each variant is built from. An e2e can tell you the curtain went away in
// 2,886 ms. Only this can tell you that it went away because a deadline was
// armed rather than because that machine happened to be fast.
//
// Nothing here may assert a DURATION by adding constants together. That is the
// habit that produced a green guard over a curtain living twice as long as it
// claimed, and the number in the block comes from the e2e now, never from here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CURTAIN_TIMING, FILM_TIMING, CURTAIN_BUDGET_MS, SKIP_DISSOLVE_MS,
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

  it('renders Mute for the FILM only, because on the curtain it broke what it sat on', () => {
    // Counting opt-ins was the wrong question. Mute on the curtain was a control
    // for nothing that ALSO lifted the curtain: the window listeners are
    // pointerdown on capture, so they run before the button's click and its
    // stopPropagation cannot stop an event that already finished. The island
    // measured it. So this reads the decision -- Mute lives inside the `full`
    // branch -- rather than counting how many things opted in.
    // Anchored on the CALL, not the word: `indexOf('Mute')` finds the comment
    // ABOVE explaining Mute, which is how the first version of this assertion
    // failed. Third time on this file that a source grep matched prose instead
    // of code, so: match something only the button can contain.
    const muteAt = src.indexOf('toggleMute()');
    expect(muteAt, 'the Mute control is gone entirely').toBeGreaterThan(0);
    const before = src.slice(Math.max(0, muteAt - 900), muteAt);
    expect(before, 'Mute is not gated on the film').toContain('{full && (');
  });

  it('keeps Skip on both, because Skip lifting the curtain is what Skip is for', () => {
    expect(src).toContain("aria-label=\"Skip intro animation\"");
  });
});

describe('two arrivals, one component', () => {
  it('gives the curtain one art piece and the film all four', () => {
    expect(CURTAIN_TIMING.artCount).toBe(1);
    expect(FILM_TIMING.artCount).toBe(T_ART_COUNT);
    expect(T_ART_COUNT).toBe(4);
  });

  it('fits the curtain inside its budget counting EVERY leg', () => {
    // The first version of this summed void + art + dissolve and called it the
    // floor. It left out the wordmark's own time — which lived as a literal
    // inside phases/textForm.ts and was the LONGEST leg — so it read 2,000 ms
    // while the island measured the curtain alive at 4,250. A sum is only ever
    // as honest as the terms somebody remembered, which is why the real promise
    // is now a timer (see curtainDeadline.test.tsx) and this is a sanity check
    // on the choreography rather than the guarantee.
    const sum =
      CURTAIN_TIMING.voidEnd +
      CURTAIN_TIMING.artCount * CURTAIN_TIMING.artDuration +
      CURTAIN_TIMING.textForm +
      SKIP_DISSOLVE_MS;
    expect(sum).toBe(2800);
    expect(sum).toBeLessThanOrEqual(CURTAIN_BUDGET_MS);
  });

  it('counts the same legs the loader actually spends', () => {
    // Each leg must be spent from the config, not re-typed at a call site. If a
    // literal creeps back the sum above silently stops describing the run.
    expect(src).toContain('timing.voidEnd');
    expect(src).toContain('timing.artDuration');
    expect(src).toContain('timing.artCount');
    expect(src).toContain('timing.textForm');
    expect(src).toContain('SKIP_DISSOLVE_MS');
    const textForm = readFileSync(join(here, 'phases', 'textForm.ts'), 'utf8');
    // POSITIVE, deliberately. The negative form (`not /const textDuration = \d/`)
    // matched this file's own comment quoting the retired literal. Asserting the
    // parameter EXISTS cannot be satisfied by prose about the parameter.
    expect(textForm, 'the wordmark does not take its duration as a leg')
      .toMatch(/textDuration: number,/);
  });

  it('leaves the film exactly as it was', () => {
    // No art is removed by this element; it is re-homed. If the film's timings
    // ever drift from the originals, the four-piece arrival has been edited.
    expect(FILM_TIMING).toEqual({
      voidEnd: T_VOID_END,
      artCount: T_ART_COUNT,
      artDuration: T_ART_DURATION,
      // The literal that used to live inside phases/textForm.ts, unchanged.
      textForm: 2000,
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

  it(`does not build an audio engine on the curtain's way out`, () => {
    // The island's Mute ruling, one line further in: on a curtain the only
    // gesture that reaches skipIntro is the one dismissing it, so an
    // AudioContext would be constructed and an ambient loop fetched for an
    // overlay 400 ms from gone, then disposed unheard.
    //
    // It is not free, and the e2e caught the price. Constructing an
    // AudioContext blocks the main thread while Chromium starts its audio
    // thread, at exactly the moment the dissolve needs frames: gone 711 ms and
    // 967 ms after the press against a ruled 600, then 448 ms with this gate.
    //
    // Scoped to skipIntro's own body. A whole-file assertion would pass on
    // `handleClick`'s unconditional call, which is a different decision on a
    // path the curtain cannot reach.
    const skipIntro = src.slice(src.indexOf('const skipIntro'), src.indexOf('}, [visible, initAudio, full]'));
    expect(skipIntro).toContain('if (full) initAudio();');
    expect(skipIntro).not.toMatch(/^\s+initAudio\(\);$/m);
  });
});

describe('the deadline counts from the commit that shows the curtain', () => {
  const lines = src.split(String.fromCharCode(10));
  const opensAnEffect = (l: string) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*')) return false;
    return t.includes('useEffect(') || t.includes('useLayoutEffect(');
  };

  it('is armed in a LAYOUT effect, not a passive one', () => {
    // A passive effect runs after the browser paints, so a deadline armed there
    // starts its clock after the curtain is already on screen, while the e2e
    // measures from the overlay entering the DOM. curtainDeadline.test.tsx
    // cannot see the difference (render flushes both kinds inside act), so this
    // one reads the source.
    //
    // It reads the effect that ACTUALLY encloses the timer: the nearest opener
    // above it, skipping comment lines. A whole-file "is there a layout effect
    // before this" test would pass on a passive deadline that merely had one
    // somewhere above, and the comments in this very effect name both kinds.
    const timer = lines.findIndex((l) => l.includes('window.setTimeout(finalize'));
    expect(timer, 'the deadline timer is gone').toBeGreaterThan(-1);
    const opener = [...lines.slice(0, timer)].reverse().find(opensAnEffect);
    expect(opener, 'nothing opens an effect above the deadline timer').toBeDefined();
    expect(opener, 'the deadline is armed in a passive effect, so it starts counting after paint')
      .toContain('useLayoutEffect(');
  });

  it('arms the dissolve as well, one SKIP_DISSOLVE_MS before the end', () => {
    // NO BEHAVIOUR TEST CAN SEE THIS ONE. In jsdom the canvas has no 2D
    // context, so the tick never runs and the dissolve draws nothing; delete
    // the first timer and every test still passes, because the unconditional
    // end still fires. What is lost is what a visitor sees: the curtain cuts
    // instead of dissolving. So the two timers are pinned as a pair, with the
    // arithmetic that keeps the dissolve inside the budget.
    expect(src).toContain('const goneBy = CURTAIN_BUDGET_MS - DEADLINE_SLACK_MS;');
    expect(src, 'the dissolve is no longer armed a dissolve before the end')
      .toContain('window.setTimeout(skipIntro, goneBy - SKIP_DISSOLVE_MS)');
    expect(src, 'the unconditional end is no longer armed at goneBy')
      .toContain('window.setTimeout(finalize, goneBy)');
  });

  it('keeps the budget the island ruled, as a literal', () => {
    // Every other assertion in these files derives from the constant, so
    // raising it would leave the whole suite green while the promise changed.
    // 3,000 ms is the island's number; moving it is their decision to make.
    expect(CURTAIN_BUDGET_MS).toBe(3000);
  });
});
