import { test, expect, type Page } from '@playwright/test';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';

// A PHONE BROWSER THAT DRAWS THE PAGE UNDER THE STATUS BAR reports a safe-area inset at
// the top and the bottom (seen on a Galaxy S25 inside the Phantom app: about 36px and
// 100px). No phone in the matrix reports one, so chrome that forgets the inset looks
// right in every other spec. This emulates it over CDP: phone Chromium only.
const INSETS = { top: 36, bottom: 100 };
// RouteTabs' own pt-3 sits between its anchor and the tab row; 1px for rounding.
const TAB_ROW_GAP_MAX = 13;

test.use({ viewport: { width: 360, height: 780 } });

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'mobile-chrome', 'safe-area insets are emulated over CDP, on the phone Chromium class');
});

async function openWithInsets(page: Page, path: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: INSETS });
  await gotoRoute(page, path);
  // The premise: with no inset reported, every assertion below passes on any code.
  const reported = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;height:env(safe-area-inset-top,0px);width:env(safe-area-inset-bottom,0px)';
    document.body.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return { top: r.height, bottom: r.width };
  });
  expect(reported, 'the browser is not reporting the emulated insets').toEqual(INSETS);
}

/** The header, the room band, the tab row and the bottom bar, read in one moment. */
const readChrome = (page: Page) => page.evaluate(() => {
  const edges = (el: Element | null | undefined) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  };
  const list = document.querySelector('[role="tablist"]');
  const listBox = list?.getBoundingClientRect();
  // A tab whose middle is on screen must be the thing a finger hits there.
  const covered = list && listBox
    ? Array.from(list.querySelectorAll('[role="tab"]')).filter((tab) => {
      const r = tab.getBoundingClientRect();
      const x = r.left + r.width / 2;
      if (x <= listBox.left || x >= listBox.right) return false;
      const hit = document.elementFromPoint(x, r.top + r.height / 2);
      return !hit || !tab.contains(hit);
    }).map((tab) => (tab.textContent ?? '').trim())
    : ['no tab row'];
  const bar = Array.from(document.querySelectorAll('nav[aria-label="Main navigation"]')).find((n) => n.getBoundingClientRect().height > 0);
  return {
    header: edges(document.querySelector('header')),
    band: edges(document.querySelector('[data-room="toweli"]')),
    tabs: edges(list),
    covered,
    bar: edges(bar),
    links: bar ? Array.from(bar.querySelectorAll('a')).map((a) => ({ label: a.getAttribute('aria-label') ?? '', ...edges(a)! })) : [],
  };
});

/** Where the tab row sits against the edge it hangs from, in words a red run can print. */
const placed = (tabsTop: number, anchorBottom: number, anchor: string) => {
  const gap = Math.round((tabsTop - anchorBottom) * 10) / 10;
  return gap >= 0 && gap <= TAB_ROW_GAP_MAX ? 'directly below' : `${gap}px from the lower edge of ${anchor}`;
};

test('with the insets, the tab row sits below the header and every tab can be pressed', async ({ page }) => {
  await openWithInsets(page, '/liquidity');
  await expect(page.getByRole('tablist').first()).toBeVisible();
  await expect.poll(async () => {
    const c = await readChrome(page);
    return c.header && c.tabs ? placed(c.tabs.top, c.header.bottom, 'the header') : 'no header or no tab row';
  }, { message: 'the tab row against the header' }).toBe('directly below');
  const c = await readChrome(page);
  expect(c.header!.bottom, 'the header is not taller by the top inset').toBeGreaterThanOrEqual(56 + INSETS.top);
  expect(c.covered, 'tabs with something else over their middle').toEqual([]);
});

test('with the insets, a TOWELI room page keeps its tab row directly below the band', async ({ page }) => {
  // /zap carries the room's band above the same tab row; the band's height is measured
  // against the header, so the inset must be counted once between the two.
  await openWithInsets(page, '/zap');
  await expect(page.locator('[data-room="toweli"]')).toBeVisible();
  await expect(page.getByRole('tablist').first()).toBeVisible();
  await expect.poll(async () => {
    const c = await readChrome(page);
    return c.band && c.tabs ? placed(c.tabs.top, c.band.bottom, 'the band') : 'no band or no tab row';
  }, { message: 'the tab row against the room band' }).toBe('directly below');
  expect((await readChrome(page)).covered, 'tabs with something else over their middle').toEqual([]);
});

test("with the insets, the bottom bar's icons stay inside the bar and above the inset", async ({ page }) => {
  await openWithInsets(page, '/');
  const c = await readChrome(page);
  expect(c.bar, 'no bottom bar on a phone').not.toBeNull();
  expect(c.links.length, 'the bar lists its sections').toBeGreaterThanOrEqual(4);
  for (const link of c.links) {
    expect.soft(link.top, `${link.label}: starts above the bar, over the page`).toBeGreaterThanOrEqual(c.bar!.top - 0.5);
    expect.soft(link.bottom, `${link.label}: reaches into the bottom inset`).toBeLessThanOrEqual(c.bar!.bottom - INSETS.bottom + 0.5);
    expect.soft(link.height, `${link.label}: press target`).toBeGreaterThanOrEqual(44);
  }
});

type Landing = { what: string; how: 'focus' | 'scroll'; edge: 'top' | 'foot'; top: number; bottom: number; chrome: [number, number]; behind: boolean; onTop: boolean };

/**
 * Runs in the page. Each control in the content is put where the browser puts it, at
 * both ends of the screen: focus moves to it while 4px of it sits behind the chrome, and
 * a scroll brings it to that end. The top chrome is the pinned tab row, or the header on
 * a page with none; the foot's is the bottom bar.
 */
async function landings(): Promise<{ under: 'the tab row' | 'the header'; rows: Landing[] } | null> {
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  const still = async () => {
    for (let i = 0, last = NaN, same = 0; i < 40 && same < 2; i++) {
      await frame();
      same = window.scrollY === last ? same + 1 : 0;
      last = window.scrollY;
    }
  };
  const pinned = (el: Element | null): boolean =>
    !!el && (getComputedStyle(el).position === 'fixed' || pinned(el.parentElement));
  const main = document.querySelector('main#main-content');
  const strip = [...document.querySelectorAll('[role="tablist"]')].find(pinned);
  const above = strip ?? document.querySelector('header');
  const bar = [...document.querySelectorAll('nav[aria-label="Main navigation"]')].find((n) => n.getBoundingClientRect().height > 0);
  if (!main || !above || !bar) return null;

  const middleIsOwn = (el: Element) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && el.contains(hit);
  };
  const rows: Landing[] = [];
  const read = (el: Element, how: Landing['how'], edge: Landing['edge']) => {
    const b = el.getBoundingClientRect();
    const c = (edge === 'top' ? above : bar).getBoundingClientRect();
    rows.push({
      what: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.id || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`,
      how,
      edge,
      top: Math.round(b.top),
      bottom: Math.round(b.bottom),
      chrome: [Math.round(c.top), Math.round(c.bottom)],
      // Any part of the control inside the chrome's own box, half a pixel of rounding aside.
      behind: b.top < c.bottom - 0.5 && b.bottom > c.top + 0.5 && b.left < c.right && b.right > c.left,
      onTop: middleIsOwn(el),
    });
  };

  const controls = [...main.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex="0"]')].filter((el) => {
    if (above.contains(el) || pinned(el) || (el as HTMLButtonElement).disabled || (el as HTMLInputElement).type === 'hidden') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });

  // The gallery lists every piece, each the same tile: the first dozen controls say it.
  let measured = 0;
  for (const el of controls) {
    if (measured === 12) break;
    // In mid-screen first: a control that is not on top of its own middle there is
    // covered by its own page, by design, and says nothing about the chrome.
    el.scrollIntoView({ block: 'center' });
    await still();
    if (!middleIsOwn(el)) continue;
    measured += 1;

    for (const edge of ['top', 'foot'] as const) {
      // 4px behind the chrome's inner edge: with too little room kept clear the browser
      // counts the control as in view and leaves it there.
      const box = el.getBoundingClientRect();
      window.scrollBy(0, edge === 'top' ? box.top - (above.getBoundingClientRect().bottom - 4) : box.bottom - (bar.getBoundingClientRect().top + 4));
      await still();
      const moved = el.getBoundingClientRect();
      const there = edge === 'top' ? moved.top - (above.getBoundingClientRect().bottom - 4) : moved.bottom - (bar.getBoundingClientRect().top + 4);
      // A control too near the top or the foot of the page cannot be put there.
      if (Math.abs(there) <= 1) {
        el.focus();
        await still();
        if (document.activeElement === el) read(el, 'focus', edge);
        el.blur();
      }

      el.scrollIntoView({ block: edge === 'top' ? 'start' : 'end' });
      await still();
      read(el, 'scroll', edge);
    }
  }
  return { under: strip ? 'the tab row' : 'the header', rows };
}

// The header and the tab row move down by the top inset and the bottom bar grows by the
// bottom one, so the room index.css keeps clear for a scroll has to grow with them. One
// tabbed page and one with no tab row: the two top rules, and the bottom rule on both.
for (const [path, under] of [['/liquidity', 'the tab row'], ['/gallery', 'the header']] as const) {
  test(`with the insets, what the browser scrolls to on ${path} lands below ${under} and above the bottom bar`, async ({ page }) => {
    test.setTimeout(120_000);
    await openWithInsets(page, path);
    await page.evaluate(() => document.fonts.ready);
    await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });

    const found = await page.evaluate(landings);
    expect(found, 'no header, tab row or bottom bar: the page changed shape').not.toBeNull();
    expect(found!.under, 'the chrome the page keeps over its top').toBe(under);
    for (const edge of ['top', 'foot'] as const) {
      for (const how of ['focus', 'scroll'] as const) {
        const count = found!.rows.filter((l) => l.edge === edge && l.how === how).length;
        expect(count, `controls measured by ${how} at the ${edge}`).toBeGreaterThanOrEqual(3);
      }
    }

    const behind = found!.rows
      .filter((l) => l.behind || !l.onTop)
      .map((l) => `${l.what} by ${l.how} at the ${l.edge}: runs ${l.top} to ${l.bottom}px down, ${l.edge === 'top' ? under : 'the bottom bar'} is at ${l.chrome[0]} to ${l.chrome[1]}px${l.onTop ? '' : ', its middle is covered'}`);
    expect(behind, 'controls left behind the fixed chrome').toEqual([]);
  });
}
