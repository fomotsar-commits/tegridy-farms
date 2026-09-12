import { test, expect, type Page } from '@playwright/test';
import {
  CURTAIN_BUDGET_MS, DEADLINE_SLACK_MS, SKIP_DISSOLVE_MS, CURTAIN_DETACH_BUDGET_MS,
} from '../src/components/loader/constants';

// THE ARRIVAL, WALKED — wave seven, element A (and element E's overlay sweep).
//
// This is the spec every other guard on the curtain has been apologising for.
// The source guards pin decisions; only this can answer the two questions the
// element actually makes a promise about:
//
//   is the hero REACHABLE while the curtain is up, and
//   is the curtain GONE inside its budget?
//
// It matters because the last answer to the second question was wrong. A unit
// guard summed void + art + dissolve, called 2,000 ms "the budget pinned", and
// stayed green while the curtain really lived ~4,250 ms warm and ~6,100 ms
// behind a slow image. Two legs were missing from the sum. A measured number
// cannot be missing a leg.
//
// TWO OPT-OUTS, AND THE SPEC IS USELESS WITHOUT BOTH.
//   1. playwright.config.ts sets contextOptions.reducedMotion = 'reduce'
//      globally, and skip.ts treats reduced motion as a hard skip. Every other
//      spec therefore never sees a curtain at all.
//   2. The wallet fixture seeds `tf_loaded` (fixtures/wallet.ts), which is the
//      other hard skip. So this file is FIXTURE-FREE on purpose: the base test
//      from @playwright/test, and no seed of its own.
//
// Write a curtain assertion in any other spec and it passes vacuously.

test.use({
  contextOptions: {
    reducedMotion: 'no-preference',
    // Restated deliberately. A spec-level `use` REPLACES contextOptions rather
    // than merging into it, so anything that lived in there would be lost.
    // (`serviceWorkers` is actually set a level up in the config's `use`, so it
    // survives regardless — but stating it here means this file does not depend
    // on that staying true, and the route stubs keep working either way.)
    serviceWorkers: 'block',
  },
});

/** Mount-relative timings for the arrival overlay, stamped by the page itself. */
interface ArrivalClock {
  added?: number;
  removed?: number;
  variant?: string;
}

declare global {
  interface Window {
    __arrival?: ArrivalClock;
    __curtainContextDenied?: number;
    /** `__arrival.added` in epoch ms, so screencast frames can be placed against it. */
    __arrivalEpoch?: number;
  }
}

/**
 * Stamp the overlay's mount and unmount from inside the page.
 *
 * NOT `Date.now()` around a `goto`. That measures navigation + first paint +
 * the curtain, so a slow CI box fails a budget it never spent, and a slow
 * curtain hides behind a fast one. This clock starts when the overlay node is
 * ADDED and stops when it is REMOVED, which is the only interval the element
 * makes a promise about.
 */
async function armArrivalClock(page: Page) {
  await page.addInitScript(() => {
    window.__arrival = {};
    const seen = (node: Node): HTMLElement | null => {
      if (!(node instanceof HTMLElement)) return null;
      if (node.dataset?.arrival) return node;
      return node.querySelector?.('[data-arrival]') ?? null;
    };
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          const el = seen(n);
          if (el && window.__arrival!.added === undefined) {
            window.__arrival!.added = performance.now();
            window.__arrival!.variant = el.dataset.arrival;
          }
        }
        for (const n of Array.from(r.removedNodes)) {
          if (seen(n) && window.__arrival!.removed === undefined) {
            window.__arrival!.removed = performance.now();
          }
        }
      }
    // `document`, NOT `document.documentElement`. addInitScript runs before any
    // page script, and documentElement can still be null at that instant — the
    // observe() then throws and the whole init script dies SILENTLY, which is
    // how the first version of this clock read `undefined` while the overlay
    // was plainly in the DOM. `document` is always there.
    }).observe(document, { childList: true, subtree: true });
  });
}

const readClock = (page: Page) => page.evaluate(() => window.__arrival ?? {});

const curtain = (page: Page) => page.locator('[data-arrival="curtain"]');

/** Timing claims run on the Chromium projects only — see the note in the config
 *  about the WebKit projects sharing this box and running a pruned list. The
 *  STRUCTURAL claims below run everywhere. */
const chromiumOnly = (browserName: string) =>
  test.skip(browserName !== 'chromium', 'timing asserted on the Chromium projects');

test.describe('the curtain, not the wall', () => {
  test('the hero is reachable while the curtain is still up', async ({ page }) => {
    await armArrivalClock(page);
    await page.goto('/');

    // The overlay is up. If it is not, this spec is not testing what it claims.
    await expect(curtain(page)).toBeAttached({ timeout: 10_000 });

    // The h1 is in the DOM underneath, from the first frame.
    const h1 = page.locator('h1').first();
    await expect(h1).toBeAttached();

    // The instrument's field is FOCUSABLE with the curtain up. focus() fires
    // neither keydown nor pointerdown, so it cannot lift the curtain — which is
    // what makes this a fair test of reachability rather than of dismissal.
    const field = page.getByPlaceholder('0x… or a Solana address').first();
    await field.focus();
    await expect(field).toBeFocused();
    await expect(curtain(page), 'focus() lifted the curtain, so this proves nothing').toBeAttached();

    // VISIBLE IS NOT CLICKABLE. The bug this element fixes was that the canvas
    // answered the hit-test over the whole page, so the only honest question is
    // what elementFromPoint returns.
    const box = await h1.boundingBox();
    expect(box).not.toBeNull();
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return { tag: el?.tagName ?? null, arrival: (el as HTMLElement | null)?.dataset?.arrival ?? null };
      },
      [box!.x + box!.width / 2, box!.y + box!.height / 2] as const,
    );
    expect(hit.arrival, 'the curtain is answering the hit-test over the hero').toBeNull();
    expect(hit.tag).not.toBe('CANVAS');
  });

  test('the curtain is out of sight by its budget with the main thread blocked solid', async ({ page, browserName, context }) => {
    chromiumOnly(browserName);
    // THE PROMISE, PUT TO THE ONLY THING THAT CAN KEEP IT.
    //
    // Every other timing test in this file ends up measuring a TIMER. The
    // budget was held by two setTimeouts and the React render that removes the
    // overlay -- all main-thread work -- so a machine with a busy thread moves
    // the deadline by however long the task in front of it runs. Measured on
    // the pre-fix build at 6x CPU throttle with the curtain's tick disabled, so
    // the deadline is the only ending and its lateness is the entire number:
    // 3,177 / 3,180 / 3,321 / 3,361 ms against a 2,900 ms deadline. Four runs
    // of four, every one over budget.
    //
    // So the curtain also fades out on a Web Animations opacity animation,
    // which runs on the COMPOSITOR and keeps its time while script is blocked.
    // This asserts that, and nothing softer.
    //
    // BLOCKED, NOT THROTTLED. A busy loop bounded by performance.now() is the
    // same 3,000 ms on every machine, so this means as much on a loaded CI box
    // as on an idle one -- and on the pre-fix build it CANNOT pass, because
    // neither timer can run inside the window it asserts on.
    //
    // SCREENCAST, NOT SCREENSHOT. Page.captureScreenshot is served by the same
    // blocked renderer and comes back late: the first version of this probe
    // used it and read every sample after the fact, which is how a screenshot
    // clock can agree with the bug. Page.screencastFrame is PUSHED by the
    // compositor as it produces frames, so it can see a thread it is not on.
    const BLOCK_FROM = 400;
    const BLOCK_FOR = 3_000;
    const MARKER = { r: 255, g: 0, b: 255 };

    // A KNOWN COLOUR UNDER THE CURTAIN. The claim is about the OVERLAY's
    // opacity, so what shows through must not depend on the art, the theme, or
    // whatever the hero has managed to paint by then.
    await page.addInitScript((m) => {
      const paint = () => {
        const el = document.createElement('div');
        el.id = '__curtainProbe';
        el.style.cssText =
          `position:fixed;inset:0;z-index:500;pointer-events:none;background:rgb(${m.r},${m.g},${m.b})`;
        document.body.appendChild(el);
      };
      if (document.body) paint();
      else document.addEventListener('DOMContentLoaded', paint);
    }, MARKER);

    await armArrivalClock(page);

    // Hold the main thread from +400 ms after the overlay mounts, straight
    // across the deadline. Bounded by performance.now() so it is wall-clock
    // exact rather than however many iterations this box gets through.
    await page.addInitScript(
      ({ from, forMs }) => {
        const wait = () => {
          if (window.__arrival?.added === undefined) { setTimeout(wait, 10); return; }
          window.__arrivalEpoch = performance.timeOrigin + window.__arrival.added;
          setTimeout(() => {
            const end = performance.now() + forMs;
            while (performance.now() < end) { /* the machine the deadline is for */ }
          }, from);
        };
        wait();
      },
      { from: BLOCK_FROM, forMs: BLOCK_FOR },
    );

    const cdp = await context.newCDPSession(page);
    const frames: Array<{ epochMs: number; data: string }> = [];
    cdp.on('Page.screencastFrame', (f) => {
      // The frame's OWN timestamp, not our receive time: delivery crosses a
      // process boundary and would smear the number being asserted on.
      const ts = f.metadata?.timestamp;
      if (ts) frames.push({ epochMs: ts * 1000, data: f.data });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

    await page.goto('/');
    await expect(curtain(page)).toBeAttached({ timeout: 10_000 });
    await expect(curtain(page)).toHaveCount(0, { timeout: CURTAIN_DETACH_BUDGET_MS + 6_000 });
    await cdp.send('Page.stopScreencast');

    const arrivalEpoch = await page.evaluate(() => window.__arrivalEpoch);
    expect(arrivalEpoch, 'the page never stamped the overlay mount in epoch time').toBeDefined();

    // Decode in a SECOND page. The page under test spent this run blocked, and
    // reusing it would make the reader wait on the very thread being accused.
    const reader = await context.newPage();
    await reader.setContent('<canvas id="k"></canvas>');
    const sampled: Array<{ at: number; rgb: number[] }> = [];
    for (const fr of frames) {
      const at = Math.round(fr.epochMs - arrivalEpoch!);
      if (at < 0 || at > CURTAIN_DETACH_BUDGET_MS) continue;
      const rgb = await reader.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const k = document.getElementById('k') as HTMLCanvasElement;
        k.width = img.width; k.height = img.height;
        const cx = k.getContext('2d')!;
        cx.drawImage(img, 0, 0);
        const d = cx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
        return [d[0]!, d[1]!, d[2]!];
      }, fr.data);
      sampled.push({ at, rgb });
    }
    await reader.close();

    const clock = await readClock(page);
    const lifetime = clock.removed! - clock.added!;
    console.log(`[arrival] blocked-thread run: ${sampled.length} frames, DOM lifetime ${Math.round(lifetime)} ms`);

    // THE INVARIANT THAT STOPS THIS PASSING FOR THE WRONG REASON. If the node
    // left the DOM inside the budget, the curtain ended the ordinary way and
    // the compositor proved nothing. The block exists to make that impossible;
    // this is what checks the block actually took.
    expect(
      lifetime,
      'the DOM removal was on time, so the main thread was never really blocked and this asserts nothing',
    ).toBeGreaterThan(CURTAIN_BUDGET_MS);

    const clear = (p: { rgb: number[] }) => p.rgb[0]! >= 240 && p.rgb[2]! >= 240 && p.rgb[1]! <= 40;
    const opaque = (p: { rgb: number[] }) => p.rgb[0]! <= 40 && p.rgb[2]! <= 40;

    // BOTH WAYS. Mid-arrival the curtain must still BE a curtain. An animation
    // that began fading at mount would sail through the assertion below and be
    // a bug: it would eat the arrival it exists to bound.
    const mid = sampled.filter((p) => p.at > 800 && p.at < CURTAIN_BUDGET_MS - SKIP_DISSOLVE_MS - 300);
    expect(mid.length, 'no frames mid-arrival, so the hold is untested').toBeGreaterThan(0);
    expect(
      mid.every(opaque),
      `the curtain is already fading mid-arrival: ${JSON.stringify(mid.slice(0, 4))}`,
    ).toBe(true);

    // THE ASSERTION. At the budget, WITH THE THREAD STILL HELD, the overlay is
    // transparent and the page shows through it.
    //
    // THE LAST FRAME AT OR BEFORE THE BUDGET, because that is what is on the
    // screen at the budget. A compositor emits a frame when something CHANGES;
    // once the fade is done it stops, so the window [budget, budget+400] is
    // routinely empty and asking for a frame inside it fails a curtain that is
    // already gone. Measured: the fade's last frame lands at ~2,918 ms and the
    // next one is at ~3,598 ms, after the block. What is painted at 3,000 ms is
    // the 2,918 ms frame.
    //
    // Two earlier versions of this assertion were wrong in opposite directions.
    // "First frame at or after the budget" was answered on one run by a frame
    // at +3,568 ms -- 168 ms after the thread came back -- so the ORDINARY
    // TIMERS satisfied it and it would have passed on the pre-fix build.
    // "Some frame inside [budget, end of block]" then failed a correct curtain
    // for the gap above. This reads the screen at the budget instead.
    const before = sampled.filter((p) => p.at <= CURTAIN_BUDGET_MS);
    expect(before.length, 'no frames at or before the budget, so nothing was measured').toBeGreaterThan(0);
    const onScreen = before[before.length - 1]!;

    // AND THAT FRAME MUST BE ONE THE BLOCK WITNESSED. If the compositor's last
    // word before the budget predates the block, the fade never ran during it
    // and this is reading a stale frame rather than a kept promise.
    expect(
      onScreen.at,
      `the last frame before the budget (+${onScreen.at} ms) predates the block, so the compositor was never tested`,
    ).toBeGreaterThan(BLOCK_FROM);

    console.log(`[arrival] on screen at the budget: the +${onScreen.at} ms frame, rgb(${onScreen.rgb.join(',')})`);
    expect(
      clear(onScreen),
      `the curtain was still on screen at ${CURTAIN_BUDGET_MS} ms with the thread held (frame +${onScreen.at} ms, rgb(${onScreen.rgb.join(',')}))`,
    ).toBe(true);

    // And the dead node does leave, once the thread it needs comes back.
    expect(lifetime).toBeLessThanOrEqual(CURTAIN_DETACH_BUDGET_MS);
  });

  test('the curtain is gone inside its budget with no input at all', async ({ page, browserName }) => {
    chromiumOnly(browserName);
    await armArrivalClock(page);
    await page.goto('/');

    await expect(curtain(page)).toBeAttached({ timeout: 10_000 });
    await expect(curtain(page)).toHaveCount(0, { timeout: CURTAIN_BUDGET_MS + 4_000 });

    const clock = await readClock(page);
    expect(clock.variant).toBe('curtain');
    expect(clock.added, 'the clock never saw the overlay mount').toBeDefined();
    expect(clock.removed, 'the clock never saw the overlay leave').toBeDefined();

    const lifetime = clock.removed! - clock.added!;
    // The number this whole element is judged on. Reported, not summed.
    console.log(`[arrival] curtain lifetime: ${Math.round(lifetime)} ms`);
    expect(lifetime).toBeLessThanOrEqual(CURTAIN_BUDGET_MS);
  });

  test('any key lifts it, and it is gone within 600 ms of the press', async ({ page, browserName }) => {
    chromiumOnly(browserName);
    await armArrivalClock(page);
    await page.goto('/');
    await expect(curtain(page)).toBeAttached({ timeout: 10_000 });

    await page.waitForTimeout(300);
    const pressedAt = await page.evaluate(() => performance.now());
    await page.keyboard.press('a');

    await expect(curtain(page)).toHaveCount(0, { timeout: 5_000 });
    const clock = await readClock(page);
    const sincePress = clock.removed! - pressedAt;
    const lifetime = clock.removed! - clock.added!;
    console.log(`[arrival] gone ${Math.round(sincePress)} ms after the press (lifetime ${Math.round(lifetime)} ms)`);

    // THE INVARIANT, which no machine can move: the KEYPRESS ended it, not the
    // deadline. Without this the assertion below could pass on a box slow
    // enough that the two endings converge, and the test would stop meaning
    // anything at exactly the moment it looks green.
    expect(lifetime, 'this ended on the deadline, not on the key').toBeLessThan(CURTAIN_BUDGET_MS - 500);

    // THE RULED NUMBER. 600, not 200: the dissolve itself spends 400, so a
    // 200 ms claim and a 400 ms dissolve cannot both be true. The island
    // measured 496.
    //
    // REPORTED TO THE ISLAND, because the ruling is theirs to keep or move: one
    // run of a full-file pass measured 967 ms while five runs in isolation
    // passed, on a box that is shared with other work. 600 leaves 200 ms for
    // the input round-trip and the frames around it, and since the preload gate
    // went the art can now decode DURING the arrival rather than before it. The
    // 400 ms is ours; the rest is the machine's.
    expect(sincePress).toBeLessThanOrEqual(600);
  });

  test('a slow picture does not turn the arrival into a black screen', async ({ page, browserName }) => {
    chromiumOnly(browserName);
    // THE OTHER HALF OF THE DEADLINE, AND THE REASON IT IS WORTH HAVING.
    //
    // Arming the deadline made the 3,000 ms true and made the slow arrival
    // EMPTY. The tick still waited on the preload for up to 2,500 ms before it
    // drew its first frame, so a stranger on a slow connection got two and a
    // half seconds of black, a few hundred milliseconds of the void, and the
    // dissolve. The island screenshotted it at +1,100 ms and +2,900 ms after
    // mount: 100% black pixels both times, the name never forming. The visitor
    // whose first impression is already worst got no arrival at all.
    //
    // The curtain now starts its void at mount and the picture lands into it, or
    // does not. Measured on the canvas's own pixels rather than on a screenshot
    // diff: "is anything drawn" is a question about pixel values, and reading
    // them is exact where an image comparison is a threshold nobody agreed on.
    await page.route('**/art/**', async (route) => {
      await new Promise((r) => setTimeout(r, 2_500));
      await route.continue();
    });

    await armArrivalClock(page);
    await page.goto('/');
    await expect(curtain(page)).toBeAttached({ timeout: 10_000 });

    // +800 ms FROM MOUNT, not from goto: navigation cost is not the curtain's.
    await page.waitForFunction(
      () => window.__arrival?.added !== undefined && performance.now() - window.__arrival.added >= 800,
      undefined,
      { timeout: 10_000 },
    );

    const drawn = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-arrival="curtain"] canvas');
      if (!canvas) return { found: false, lit: 0, sampled: 0 };
      const ctx = canvas.getContext('2d');
      if (!ctx) return { found: true, lit: 0, sampled: 0 };
      // A coarse grid over the whole canvas. The void's gold line is a thin
      // horizontal band, so a centre-only sample could miss it honestly.
      let lit = 0;
      let sampled = 0;
      const step = 8;
      for (let y = 0; y < canvas.height; y += step) {
        const row = ctx.getImageData(0, y, canvas.width, 1).data;
        for (let x = 0; x < canvas.width; x += step) {
          const i = x * 4;
          sampled++;
          if (row[i]! > 12 || row[i + 1]! > 12 || row[i + 2]! > 12) lit++;
        }
      }
      return { found: true, lit, sampled };
    });

    expect(drawn.found, 'no curtain canvas to read').toBe(true);
    expect(drawn.sampled, 'the canvas has no pixels, so this proves nothing').toBeGreaterThan(0);
    console.log(`[arrival] slow-art canvas at +800 ms: ${drawn.lit}/${drawn.sampled} pixels lit`);
    expect(drawn.lit, 'the arrival is a black screen 800 ms in, exactly as the island measured').toBeGreaterThan(0);

    // And the deadline still holds with the picture never arriving in time.
    await expect(curtain(page)).toHaveCount(0, { timeout: CURTAIN_BUDGET_MS + 4_000 });
    const clock = await readClock(page);
    const lifetime = clock.removed! - clock.added!;
    console.log(`[arrival] slow-art curtain lifetime: ${Math.round(lifetime)} ms`);
    expect(lifetime).toBeLessThanOrEqual(CURTAIN_BUDGET_MS);
  });

  test('the deadline alone ends it inside its budget, when the curtain draws nothing', async ({ page, browserName }) => {
    chromiumOnly(browserName);
    // THE PATH THAT WENT RED, TAKEN ON PURPOSE.
    //
    // The budget test above ends on whichever comes first, and on an unloaded
    // box that is the curtain's own choreography, ~2,880 ms. So it says nothing
    // about the deadline: delete the deadline timer and it stays green. The
    // deadline only ends the curtain when the choreography runs late, which is
    // when CI runs slow, and that is how the deadline's own lateness was found:
    // run 34581371972 read 3,002, 3,010 and 3,002 ms, three tries of three.
    //
    // So this one takes the deadline path every time. The curtain's canvas gets
    // no 2D context, the canvas effect returns early and the tick never starts,
    // so the curtain's own frames can end nothing; and no input is sent. The
    // deadline is all that is left, which is also the machine its comment in
    // AppLoader is written for.
    await page.addInitScript(() => {
      const real = HTMLCanvasElement.prototype.getContext;
      window.__curtainContextDenied = 0;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
        if (this.closest('[data-arrival="curtain"]')) {
          window.__curtainContextDenied = (window.__curtainContextDenied ?? 0) + 1;
          return null;
        }
        return Reflect.apply(real, this, args);
      } as typeof real;
    });
    await armArrivalClock(page);
    await page.goto('/');
    await expect(curtain(page)).toBeAttached({ timeout: 10_000 });
    await expect(curtain(page), 'nothing ended the curtain, so no deadline is armed')
      .toHaveCount(0, { timeout: CURTAIN_BUDGET_MS + 4_000 });

    expect(
      await page.evaluate(() => window.__curtainContextDenied ?? 0),
      'the curtain got a real 2D context, so its own frames could have ended it',
    ).toBeGreaterThan(0);

    const clock = await readClock(page);
    expect(clock.variant).toBe('curtain');
    const lifetime = clock.removed! - clock.added!;
    console.log(`[arrival] deadline-only curtain lifetime: ${Math.round(lifetime)} ms`);
    // Still up when the deadline began its dissolve, so nothing earlier ended
    // it and the number below is the deadline's.
    expect(lifetime, 'something ended the curtain before the deadline could, so this measured something else')
      .toBeGreaterThan(CURTAIN_BUDGET_MS - DEADLINE_SLACK_MS - SKIP_DISSOLVE_MS);
    expect(lifetime, 'the deadline ended the curtain past its own budget').toBeLessThanOrEqual(CURTAIN_BUDGET_MS);
  });

  test('it plays once per browser, after ending on the DEADLINE path', async ({ page, context }) => {
    // THE ONE THAT WAS GREEN WHILE THE VENUE WAS BROKEN.
    //
    // No gesture anywhere in this test, and that is the whole point. The mark
    // used to be written only by the animation tick's own ending frames, so a
    // keydown-then-reload check would have passed while every real visitor --
    // who presses nothing -- saw the curtain again on every single load. The
    // island measured five runs of five with `tf_loaded` null in all five.
    //
    // So: let it end by itself, then ask the browser to arrive again.
    await armArrivalClock(page);
    await page.goto('/');
    await expect(curtain(page)).toBeAttached({ timeout: 10_000 });
    await expect(curtain(page)).toHaveCount(0, { timeout: CURTAIN_BUDGET_MS + 4_000 });

    // The durable record, read rather than assumed.
    expect(
      await page.evaluate(() => localStorage.getItem('tf_loaded')),
      'the curtain ended without recording that this browser has arrived',
    ).toBe('1');

    // Same tab, second navigation.
    await page.goto('/');
    await page.waitForTimeout(1_500);
    await expect(curtain(page), 'a reload replays the arrival').toHaveCount(0);

    // A SECOND TAB, which is the half that says "per browser" rather than "per
    // tab": sessionStorage does not cross this line and localStorage does. The
    // arrival used to play in full for every new tab.
    const second = await context.newPage();
    await second.goto('/');
    await second.waitForTimeout(1_500);
    await expect(
      second.locator('[data-arrival="curtain"]'),
      'a new tab replays the arrival',
    ).toHaveCount(0);
    await second.close();
  });

  test('CLICK TO ENTER is gone from the arrival', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1').first()).toBeAttached({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText('CLICK TO ENTER');
    await expect(page.locator('body')).not.toContainText('TAP TO ENTER');
  });
});

test.describe('the arrival never plays where it is not the arrival', () => {
  for (const path of ['/bayla', '/pepe']) {
    test(`a cold ${path} deep link mounts no curtain`, async ({ page }) => {
      await armArrivalClock(page);
      await page.goto(path);
      await page.waitForTimeout(1_500);
      await expect(curtain(page), 'the room IS the arrival there').toHaveCount(0);
    });
  }

  test('a cold shared read opens on the number, not behind a film', async ({ page }) => {
    await armArrivalClock(page);
    await page.goto('/?heat=0x0000000000000000000000000000000000000000');
    await page.waitForTimeout(1_500);
    await expect(curtain(page)).toHaveCount(0);
  });
});

/**
 * ELEMENT E, MEASURED THE WAY THE ISLAND MEASURES IT. Runs INSIDE the page.
 *
 * The first version of this swept every `position: fixed` box and flagged any
 * that intersected a hero control. That is the wrong question twice over. It
 * flagged the consent bar for overlapping whatever footer link sat beneath it,
 * which is inherent to any bottom bar and is not a defect; and the island's own
 * run then found `position: fixed; inset: 0; z-index: 0; pointer-events: auto`
 * background layers on EVERY route — a box walk reds on those forever while they
 * cover precisely nothing.
 *
 * The honest question does not care what is fixed, or what is painted where. It
 * asks the browser: if a visitor puts a finger on this control, do they get this
 * control? Anything that opened itself over the page fails that, and a
 * full-viewport backdrop that yields the hit-test passes it, correctly.
 *
 * ONE FUNCTION, TWO JOBS, DELIBERATELY. `plant` inserts a panel over the first
 * hero control and reports which; the default measures. They must agree about
 * what a hero control IS, or the non-vacuity check below proves nothing about
 * the sweep it is vouching for — the first attempt at this planted a panel over
 * the off-screen skip link and then honestly reported nothing covered.
 */
function heroHitTest(plant: boolean): string[] {
  const fold = window.innerHeight / 2;
  const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href], button')).filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // "Hero" is the top half: the actions a visitor arrives to take without
    // scrolling. A bottom bar cannot reach them and nothing below the fold has
    // been scrolled to yet.
    if (r.top < 0 || r.bottom > fold) return false;
    // AND ITS CENTRE MUST BE ON SCREEN. `elementFromPoint` answers null for a
    // point outside the viewport, and the sr-only "Skip to main content" link is
    // parked at a negative x until it is focused — a control that is nowhere is
    // not a control anything can cover.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    // A control that has opted out of pointers itself is not one this element
    // makes a promise about.
    if (cs.pointerEvents === 'none') return false;
    return true;
  });

  if (plant) {
    const target = controls[0];
    if (!target) return [];
    const r = target.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.className = 'planted-overlay';
    panel.style.position = 'fixed';
    panel.style.left = r.left - 8 + 'px';
    panel.style.top = r.top - 8 + 'px';
    panel.style.width = r.width + 16 + 'px';
    panel.style.height = r.height + 16 + 'px';
    panel.style.zIndex = '9500';
    panel.style.pointerEvents = 'auto';
    panel.style.background = 'rgba(0,0,0,0.4)';
    document.body.appendChild(panel);
    return ['planted over "' + (target.textContent ?? '').trim().slice(0, 28) + '"'];
  }

  const covered: string[] = [];
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    // Its own label, icon or span answering for it IS the control answering.
    if (hit === c || c.contains(hit)) continue;
    const on = hit as HTMLElement | null;
    const who = on ? on.tagName + (on.id ? '#' + on.id : '') + '.' + (on.className || '(no class)') : 'nothing';
    covered.push(('"' + (c.textContent ?? '').trim().slice(0, 28) + '" answered by ' + who).slice(0, 160));
  }
  return covered;
}

// ─── Element E: nothing opens over the page unasked ─────────────────────────
//
// Cold loads, no seeds, no fixture. The curtain itself is position: fixed, so
// this is element A's budget asserted from the other side: by the time these
// run, nothing may be covering a hero button — including the curtain.

test.describe('zero unasked overlays', () => {
  for (const path of ['/', '/bayla', '/pepe', '/launch', '/liquidity', '/island']) {
    test(`${path} opens nothing over the page`, async ({ page }) => {
      await page.goto(path);
      await page.waitForTimeout(CURTAIN_BUDGET_MS);

      // No dialog opened itself. The room's welcome is invited now, and the
      // install offer and the consent ask are footer rows.
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);

      // And every hero control answers for itself.
      const covered = await page.evaluate(heroHitTest, false);

      expect(covered, `something is sitting on a control at ${path}`).toEqual([]);

      // ROW S. A cold load, so consent is unanswered and the ask IS on the page,
      // as a row in the footer's flow. That is why the sweep above is green with
      // it present rather than because it was absent.
      await expect(
        page.getByRole('group', { name: 'Analytics are anonymous and off until you say yes.' }),
      ).toHaveCount(1);
      // And the storage key it writes to is in no rendered text node.
      const keyNodes = await page.evaluate(() => {
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const found: string[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const el = node.parentElement;
          if (el && SKIP.has(el.tagName)) continue;
          const text = node.textContent ?? '';
          if (text.includes('telemetry_consent')) found.push(text.trim().slice(0, 80));
        }
        return found;
      });
      expect(keyNodes, `the consent storage key is printed at ${path}`).toEqual([]);
    });
  }

  test('the sweep can actually see a cover, so a green above means something', async ({ page }) => {
    // A PASSING SWEEP IS WORTHLESS UNTIL IT HAS FAILED ON PURPOSE.
    //
    // The island's two mutations are "restore the old install banner" and
    // "re-mount MuseBubble". Both are deletions from this branch, so reviving
    // either to prove a test would be a strange commit to live with. This plants
    // the same shape instead -- a fixed panel, over the hero, taking pointers,
    // which is exactly what both of those were -- and demands the sweep sees it.
    // If this ever passes with an empty list, every green above is vacuous.
    await page.goto('/');
    await page.waitForTimeout(CURTAIN_BUDGET_MS);

    const planted = await page.evaluate(heroHitTest, true);
    expect(planted, 'no hero control to plant over — the sweep has nothing to measure').not.toEqual([]);

    const covered = await page.evaluate(heroHitTest, false);
    expect(
      covered.join(' | '),
      'the sweep did not notice a panel sitting on a hero control',
    ).toContain('planted-overlay');
  });
});
