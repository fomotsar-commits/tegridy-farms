/**
 * A section strip too wide for a phone scrolls sideways. The tab for the page you
 * are on is whole and in view when you land on it, and an edge with tabs hidden
 * past it fades and shows a chevron, so the strip reads as one that scrolls at
 * every width. Measured from rendered boxes against the strip's visible (client)
 * box, the strip's computed mask, and the chevrons (`data-more`) in its frame.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false };
const PHONE_WIDTHS = [360, 375, 390, 430];

/** Sub-pixel rounding between a tab and its strip is not a cut. */
const TOLERANCE_PX = 0.5;

// The later tabs of the three strips that scroll on a phone. Each of these pages
// landed with its selected tab partly or wholly past the strip's right edge.
const LANDINGS = [
  { path: '/eth-curve', strip: 'Launch sections' },
  { path: '/launch-simulator', strip: 'Launch sections' },
  { path: '/copy-trading', strip: 'Earn sections' },
  { path: '/competitions', strip: 'Earn sections' },
  { path: '/checkout', strip: 'Earn sections' },
  { path: '/terminal', strip: 'Token-checking tools' },
  { path: '/chart', strip: 'Token-checking tools' },
  { path: '/alerts', strip: 'Token-checking tools' },
];

/** The strip's scroll state, its fade and chevrons, and where its selected tab sits. */
function readStrip(list: Element) {
  const box = list.getBoundingClientRect();
  const visL = box.left + list.clientLeft;
  const tab = list.querySelector('[role="tab"][aria-selected="true"]');
  const sel = tab?.getBoundingClientRect();
  const cs = getComputedStyle(list);
  // A chevron shows when it renders with a size, inside the strip's own box.
  // Its width is how much of that edge must be clear of tabs under it.
  const chevron = (side: string) => {
    const el = list.parentElement?.querySelector(`[data-more="${side}"]`);
    if (!el || getComputedStyle(el).display === 'none') return 0;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= box.left - 1 && r.right <= box.right + 1 ? r.width : 0;
  };
  return {
    mask: cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image') || 'none',
    chevronStart: chevron('start'),
    chevronEnd: chevron('end'),
    scrollLeft: list.scrollLeft,
    maxScroll: list.scrollWidth - list.clientWidth,
    visL,
    visR: visL + list.clientWidth,
    selected: tab?.id ?? null,
    selL: sel?.left ?? NaN,
    selR: sel?.right ?? NaN,
  };
}
type Strip = ReturnType<typeof readStrip>;

const round = (n: number) => Math.round(n * 10) / 10;

const frames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Re-reads the strip for up to ~1s until `check` finds nothing, and returns what it last found. */
async function settle(page: Page, list: Locator, check: (s: Strip) => string[]) {
  let found: string[] = [];
  for (let i = 0; i < 30; i++) {
    found = check(await list.evaluate(readStrip));
    if (!found.length) break;
    await frames(page);
  }
  return found;
}

async function land(page: Page, path: string, strip: string, width: number, height = PHONE.viewport.height) {
  await page.setViewportSize({ width, height });
  await gotoRoute(page, path);
  const list = page.getByRole('tablist', { name: strip });
  await expect(list.getByRole('tab', { selected: true })).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
  return list;
}

const selectedCut = (s: Strip) => {
  const cut = Math.max(s.visL - s.selL, s.selR - s.visR);
  return cut > TOLERANCE_PX ? [`${s.selected} is cut ${round(cut)}px by the strip's edge (scrollLeft ${round(s.scrollLeft)})`] : [];
};

test.describe('a phone lands with the selected tab in view', () => {
  test.use(PHONE);
  for (const { path, strip } of LANDINGS) {
    test(`${path}: the selected ${strip} tab is whole inside its strip at 360 to 430`, async ({
      page,
      walletMock: _w,
    }) => {
      const problems: string[] = [];
      for (const width of PHONE_WIDTHS) {
        const list = await land(page, path, strip, width);
        for (const p of await settle(page, list, selectedCut)) problems.push(`${width}px: ${p}`);
      }
      expect(problems, 'selected tabs out of view on landing').toEqual([]);
    });
  }
});

/**
 * Which edges a strip's mask fades: a gradient whose first or last stop is
 * transparent hides what is under that edge. `px` is the fade's full width, and
 * a band is how far in from its edge that transparent stop reaches.
 */
function fadedEdges(mask: string) {
  if (!mask.startsWith('linear-gradient(')) return { start: false, end: false, px: 0, startBand: 0, endBand: 0 };
  const inner = mask.slice(mask.indexOf('(') + 1, mask.lastIndexOf(')'));
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(part.trim());
      part = '';
    } else part += ch;
  }
  parts.push(part.trim());
  const stops = parts.filter((p) => !p.startsWith('to '));
  const clear = (stop = '') => /^(transparent|rgba\(0, 0, 0, 0\))/.test(stop);
  // "transparent 20px" at the start, "transparent calc(100% - 20px)" at the end.
  const band = (stop = '') => (clear(stop) ? Number(/([\d.]+)px\)?$/.exec(stop)?.[1] ?? 0) : 0);
  const first = stops[0];
  const last = stops[stops.length - 1];
  return {
    start: clear(first),
    end: clear(last),
    px: Math.max(0, ...[...inner.matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]))),
    startBand: band(first),
    endBand: band(last),
  };
}

/**
 * An edge fades and shows a chevron exactly while tabs are hidden past it; on
 * landing, the selected tab is never under a fade. A fade alone can land on a
 * tab's empty padding and change nothing a reader sees; the chevron cannot.
 */
const fadeFollowsScroll = (onLanding: boolean) => (s: Strip) => {
  const fade = fadedEdges(s.mask);
  const at = `scrollLeft ${round(s.scrollLeft)} of ${round(s.maxScroll)}`;
  const out: string[] = [];
  const hiddenStart = s.scrollLeft > 1;
  const hiddenEnd = s.scrollLeft < s.maxScroll - 1;
  if (fade.start !== hiddenStart) out.push(`the start edge ${fade.start ? 'fades with nothing' : 'does not fade with tabs'} hidden past it (${at})`);
  if (fade.end !== hiddenEnd) out.push(`the end edge ${fade.end ? 'fades with nothing' : 'does not fade with tabs'} hidden past it (${at})`);
  if (!!s.chevronStart !== hiddenStart) out.push(`the start edge ${s.chevronStart ? 'shows a chevron with nothing' : 'shows no chevron with tabs'} hidden past it (${at})`);
  if (!!s.chevronEnd !== hiddenEnd) out.push(`the end edge ${s.chevronEnd ? 'shows a chevron with nothing' : 'shows no chevron with tabs'} hidden past it (${at})`);
  // Under a chevron the mask is fully clear, so no half-faded label runs into it.
  if (s.chevronStart > fade.startBand + TOLERANCE_PX) out.push(`the ${round(s.chevronStart)}px start chevron has only ${fade.startBand}px clear under it (${at})`);
  if (s.chevronEnd > fade.endBand + TOLERANCE_PX) out.push(`the ${round(s.chevronEnd)}px end chevron has only ${fade.endBand}px clear under it (${at})`);
  if (onLanding) {
    const under = Math.max(s.visL + (fade.start ? fade.px : 0) - s.selL, s.selR - (s.visR - (fade.end ? fade.px : 0)));
    if (under > TOLERANCE_PX) out.push(`${s.selected} is ${round(under)}px under a fade or past the edge (${at})`);
  }
  return out;
};

// Every strip that scrolls on a phone, landing on a first, a middle and a last tab.
const SCROLLING = [
  { path: '/farm', strip: 'Earn sections' },
  { path: '/copy-trading', strip: 'Earn sections' },
  { path: '/checkout', strip: 'Earn sections' },
  { path: '/launch', strip: 'Launch sections' },
  { path: '/trust', strip: 'Token-checking tools' },
];

test.describe('a strip that scrolls fades and marks the edge more tabs wait behind', () => {
  test.use(PHONE);
  for (const { path, strip } of SCROLLING) {
    test(`${path}: at 360 to 430 each ${strip} edge fades and shows a chevron exactly while tabs are hidden past it`, async ({
      page,
      walletMock: _w,
    }) => {
      const problems: string[] = [];
      for (const width of [360, 375, 390, 393, 402, 430]) {
        const list = await land(page, path, strip, width);
        for (const p of await settle(page, list, fadeFollowsScroll(true))) problems.push(`${width}px on landing: ${p}`);
        if ((await list.evaluate(readStrip)).maxScroll <= 1) {
          problems.push(`${width}px: the strip fits, so this case no longer tests a strip that scrolls`);
          continue;
        }
        for (const [when, share] of [['scrolled to the end', 1], ['scrolled halfway', 0.5], ['scrolled back to the start', 0]] as const) {
          await list.evaluate((el, f) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) * f; }, share);
          for (const p of await settle(page, list, fadeFollowsScroll(false))) problems.push(`${width}px ${when}: ${p}`);
        }
      }
      expect(problems, 'strip edges that hide tabs unmarked, or mark nothing').toEqual([]);
    });
  }
});

test.describe('a strip that fits neither fades nor shows a chevron', () => {
  test.use(DESKTOP);
  for (const { path, strip } of [
    { path: '/farm', strip: 'Earn sections' },
    { path: '/launch', strip: 'Launch sections' },
    { path: '/trust', strip: 'Token-checking tools' },
  ]) {
    test(`${path}: the ${strip} strip fits at 1440 with neither edge faded or marked`, async ({ page, walletMock: _w }) => {
      const list = await land(page, path, strip, DESKTOP.viewport.width, DESKTOP.viewport.height);
      const s = await list.evaluate(readStrip);
      expect(s.maxScroll, 'the strip scrolls at 1440').toBeLessThanOrEqual(1);
      expect(fadedEdges(s.mask), `mask ${s.mask}`).toEqual({ start: false, end: false, px: 0, startBand: 0, endBand: 0 });
      expect({ start: s.chevronStart, end: s.chevronEnd }, 'chevron widths shown').toEqual({ start: 0, end: 0 });
    });
  }
});
