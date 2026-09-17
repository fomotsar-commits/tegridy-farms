import { test, expect, type Page } from '@playwright/test';

// THE ARRIVAL, WALKED - answer ten, ruling 1: THE VENUE OPENS STRAIGHT TO THE PAGE.
//
// This spec used to walk the CURTAIN: a short arrival overlay the layout mounted
// over every cold visit, with a 3,000 ms budget it measured to the millisecond,
// through a held main thread, a slow image and a denied canvas. The island ruled
// the curtain off the arrival ("a page that offers to skip itself is telling the
// visitor it is in the way"), so the file is rewritten to the new truth rather
// than deleted: its clock survives, and now proves an overlay NEVER mounts.
//
// THE CLOCK IS WHY THIS IS NOT VACUOUS. `toHaveCount(0)` after a wait passes on
// an overlay that mounted and left again. The MutationObserver below stamps the
// moment any arrival node is ADDED to the document, however briefly, so a
// transient mount still fails.
//
// TWO OPT-OUTS, STILL NEEDED. playwright.config.ts runs every other spec under
// reducedMotion 'reduce', which the old loader treated as a hard skip, so a
// regression that brought the curtain back would hide from all of them. This file
// runs 'no-preference' and without the wallet fixture (which seeded the old
// arrival record), so it is the one place a returning curtain would actually show.
//
// DISCRIMINATING ROUTES, NAMED. Before the fix, cold '/', '/farm', '/launch',
// '/tokenomics' and '/island' all mounted the curtain. '/bayla' and a '?heat='
// read were exempt even then, so they are kept because the island named /bayla,
// not because they could catch a regression on their own.

test.use({
  contextOptions: {
    reducedMotion: 'no-preference',
    // Restated: a spec-level `use` REPLACES contextOptions rather than merging.
    serviceWorkers: 'block',
  },
});

/** How long a cold route is watched: the island's own clock, "within 5 s". */
const WATCH_MS = 5_000;
/** How long the overlay sweep lets a cold page settle before hit-testing. */
const SETTLE_MS = 3_000;

interface ArrivalClock {
  added?: number;
  skipIntroPainted?: number;
}

declare global {
  interface Window {
    __arrival?: ArrivalClock;
  }
}

/**
 * Stamp, from inside the page, the first moment an arrival overlay or the words
 * "Skip intro" enter the document. Observes `document`, not documentElement:
 * addInitScript runs before any page script, when documentElement can be null,
 * and a throwing observe() kills the init script silently.
 */
async function armArrivalClock(page: Page) {
  await page.addInitScript(() => {
    window.__arrival = {};
    const check = (node: Node) => {
      const clock = window.__arrival!;
      if (node instanceof HTMLElement) {
        if (clock.added === undefined && (node.dataset?.arrival || node.querySelector?.('[data-arrival]'))) {
          clock.added = performance.now();
        }
        if (clock.skipIntroPainted === undefined && (node.textContent ?? '').includes('Skip intro')) {
          clock.skipIntroPainted = performance.now();
        }
      } else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').includes('Skip intro')) {
        if (clock.skipIntroPainted === undefined) clock.skipIntroPainted = performance.now();
      }
    };
    new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) check(n);
    }).observe(document, { childList: true, subtree: true });
  });
}

const readClock = (page: Page) => page.evaluate(() => window.__arrival ?? {});

test.describe('the venue opens straight to the page (ruling 1)', () => {
  for (const path of ['/', '/tokenomics', '/bayla', '/farm', '/launch', '/island', '/?heat=0x0000000000000000000000000000000000000000']) {
    test(`a cold ${path} mounts no arrival overlay and never paints "Skip intro"`, async ({ page }) => {
      await armArrivalClock(page);
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeAttached({ timeout: 20_000 });
      await page.waitForTimeout(WATCH_MS);
      const clock = await readClock(page);
      expect(clock.added, `an arrival overlay mounted on ${path}`).toBeUndefined();
      expect(clock.skipIntroPainted, `"Skip intro" painted on ${path}`).toBeUndefined();
    });
  }

  test('CLICK TO ENTER is gone from the arrival', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1').first()).toBeAttached({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText('CLICK TO ENTER');
    await expect(page.locator('body')).not.toContainText('TAP TO ENTER');
  });
});

test.describe('the film keeps its home on /island', () => {
  test('the tap plays it, a stray key does not end it, and Escape clears it', async ({ page }) => {
    await armArrivalClock(page);
    await page.goto('/island');
    const tap = page.getByRole('button', { name: 'Watch the arrival' });
    await expect(tap).toBeVisible({ timeout: 20_000 });
    expect((await readClock(page)).added, 'the film played before anyone asked').toBeUndefined();

    await tap.click();
    const film = page.locator('[data-arrival="film"]');
    await expect(film).toBeAttached({ timeout: 10_000 });
    // "Skip intro" is allowed here, and only here: this is a viewing somebody chose.
    await expect(page.getByRole('button', { name: 'Skip intro animation' })).toBeVisible({ timeout: 5_000 });

    // A deliberate viewing does not flinch at an ordinary key.
    await page.keyboard.press('a');
    await page.waitForTimeout(800);
    await expect(film, 'an ordinary key dismissed the film').toBeAttached();

    await page.keyboard.press('Escape');
    await expect(film, 'Escape did not clear the film').toHaveCount(0, { timeout: 5_000 });
  });
});

test.describe('nothing opens unasked on a cold TOWELI route, and the welcomes open on a tap', () => {
  test('a cold /toweli opens no picker and no welcome, and its tour link opens the welcome', async ({ page }) => {
    // Cold for the welcome (its seen-key absent) and wearing the TOWELI skin, so
    // this is exactly the visitor the old auto-open picker leg and the TOWELI
    // welcome both used to open over.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('tegridy-onboarding-seen');
        localStorage.setItem('tegridy-bungalow', 'toweli');
      } catch { /* private mode */ }
    });
    await page.goto('/toweli');
    await expect(page.locator('h1').first()).toBeAttached({ timeout: 20_000 });
    await page.waitForTimeout(WATCH_MS);
    await expect(page.locator('[role="dialog"]'), 'something opened unasked on a cold TOWELI route').toHaveCount(0);

    await page.getByRole('button', { name: 'First time here? Take the tour' }).click();
    await expect(
      page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /^welcome to/i }) }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('the venue tour opens the venue welcome on a tap', async ({ page }) => {
    await page.goto('/');
    const tour = page.getByRole('button', { name: 'First time on the island? Take the tour' });
    await expect(tour).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await tour.click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1, { timeout: 5_000 });
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
// Cold loads, no seeds, no fixture. By the time these run, nothing may be
// covering a hero button.

test.describe('zero unasked overlays', () => {
  for (const path of ['/', '/tokenomics', '/bayla', '/pepe', '/launch', '/liquidity', '/island']) {
    test(`${path} opens nothing over the page`, async ({ page }) => {
      await page.goto(path);
      await page.waitForTimeout(SETTLE_MS);

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
    await page.waitForTimeout(SETTLE_MS);

    const planted = await page.evaluate(heroHitTest, true);
    expect(planted, 'no hero control to plant over — the sweep has nothing to measure').not.toEqual([]);

    const covered = await page.evaluate(heroHitTest, false);
    expect(
      covered.join(' | '),
      'the sweep did not notice a panel sitting on a hero control',
    ).toContain('planted-overlay');
  });
});
