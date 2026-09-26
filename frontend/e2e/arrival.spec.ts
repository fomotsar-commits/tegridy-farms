import { test, expect, type Page } from '@playwright/test';

// THE VENUE OPENS STRAIGHT TO THE PAGE (answer ten, ruling 1): no arrival overlay
// mounts on a cold visit. A MutationObserver stamps any arrival node ADDED, however
// briefly, so a mount that left again still fails. Runs with reducedMotion
// 'no-preference' and no wallet fixture, the one place a returning curtain would show.
// '/bayla' and the '?heat=' read are kept because the island named them.

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
 * Stamps the first moment an arrival overlay or "Skip intro" enters the document.
 * Observes `document`: documentElement can be null this early, and a throw is silent.
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
      // The watch starts once the app is on screen: a door's static heading and its
      // busy fallback are both there before any overlay could mount.
      await expect(page.locator('main#main-content h1').first()).toBeAttached({ timeout: 20_000 });
      await expect(page.locator('main#main-content [aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
      await page.waitForTimeout(WATCH_MS);
      const clock = await readClock(page);
      expect(clock.added, `an arrival overlay mounted on ${path}`).toBeUndefined();
      expect(clock.skipIntroPainted, `"Skip intro" painted on ${path}`).toBeUndefined();
    });
  }
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
    // Truly cold: nothing stored, and the door writes its choice on its first render.
    // Every dialog insertion is stamped, so one that opened and closed still counts.
    await page.addInitScript(() => {
      try { localStorage.removeItem('tegridy-onboarding-seen'); } catch { /* private mode */ }
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (n instanceof HTMLElement && (n.matches('[role="dialog"]') || n.querySelector('[role="dialog"]'))) {
              try { sessionStorage.setItem('e2e-dialog-opened', location.pathname); } catch { /* ignore */ }
            }
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/toweli');
    await expect(page.locator('h1').first()).toBeAttached({ timeout: 20_000 });
    await page.waitForTimeout(WATCH_MS);
    expect(
      await page.evaluate(() => localStorage.getItem('tegridy-bungalow')),
      'the door never persisted its choice, so this was not the cold path',
    ).toBe('toweli');
    await expect(page.locator('[role="dialog"]'), 'something opened unasked on a cold TOWELI route').toHaveCount(0);
    expect(
      await page.evaluate(() => sessionStorage.getItem('e2e-dialog-opened')),
      'a dialog opened unasked and left again on a cold TOWELI route',
    ).toBeNull();

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
 * Element E, measured as the island measures it, inside the page: does a finger on
 * each hero control get that control (elementFromPoint)? A backdrop that yields the
 * hit-test passes; anything opened over the page fails. `plant` puts a panel over the
 * first hero control instead, so the non-vacuity check and the sweep agree on what a
 * hero control is.
 */
function heroHitTest(plant: boolean): string[] {
  const fold = window.innerHeight / 2;
  const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href], button')).filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // "Hero" is the top half: what a visitor arrives to take without scrolling.
    if (r.top < 0 || r.bottom > fold) return false;
    // Its centre on screen: elementFromPoint is null off-viewport (the sr-only skip link).
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    // A control that opted out of pointers itself is not covered by anything.
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

// Element E: nothing opens over the page unasked. Cold loads, no seeds, no fixture.

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

      // Row S: consent is unanswered, so its ask IS on the page, as a footer row
      // the sweep above passes with.
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
    // A sweep is worthless until it has failed on purpose. This plants the shape of
    // the island's two mutations (a fixed panel over the hero, taking pointers) and
    // demands the sweep sees it; an empty list here makes every green above vacuous.
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
