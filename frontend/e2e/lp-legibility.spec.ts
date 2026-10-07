import { test, expect } from './fixtures/wallet';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';
import { playLiveVenue } from './fixtures/playedVenue';
import { LP_SCRIM } from '../src/components/solana/curve/uiFormat';

/**
 * The LP text kit (components/solana/curve/ui.tsx) is legible on the production page: card
 * headings 15px or more, body, labels and notices 13px or more, hints and errors 12px or more,
 * every one at 4.5:1 or better,
 * measured on each text leaf the kit renders inside the LP section of /solana-lp at a phone
 * width and a desktop width. Each colour is measured over the LP scrim (uiFormat.ts LP_SCRIM,
 * black) laid over the page's own colour: the art under a card may not have painted, so the
 * scrim is the darkest ground a visitor meets. Text on its own background (a button, a chip)
 * and text a component sized itself are not measured here; both are named in the report.
 *
 * Red on the kit before 2026-10-06: card body 11px, field label 11px, field hint 10px, all
 * under [data-testid="lp-section"]. (Their colours passed: index.css's contrast floor renders
 * text-white/60 at 0.88 and /40 at 0.82.) Red again on 0c4a49c0: the card heading at 13px, the
 * same size as the body under it.
 */

const WIDTHS = [
  { name: '390x844 phone', size: { width: 390, height: 844 } },
  { name: '1280x900 desktop', size: { width: 1280, height: 900 } },
];

/** The page's own colour under every card (SolanaLpPage.tsx, #060c1a), as r, g, b. */
const PAGE_RGB: [number, number, number] = [6, 12, 26];

/** A heading stands over its body; body, labels and notices read as prose; hints and errors are the small print. */
const FLOORS = { head: 15, body: 13, label: 13, notice: 13, hint: 12, error: 12 } as const;
type Role = keyof typeof FLOORS;
/** Every Card in the LP section after one press of Create a pool has one kit heading. */
const HEADINGS_ON_PAGE = 4;
/** WCAG AA for text of this size, over the scrim. */
const RATIO = 4.5;

interface Leaf {
  role: string;
  text: string;
  px: number;
  ratio: number;
  /** Its size is the kit's: nothing between the leaf and the kit's element set a size of its own. */
  kitSized: boolean;
  /** Something between the leaf and the kit's element paints a background (a button, a chip). */
  painted: boolean;
}

/**
 * Every text leaf under one of the kit's elements inside the LP section, with its computed size
 * and its WCAG contrast over the scrim. Runs in the page. The browser does the compositing: a
 * one-pixel canvas is painted with the ground and then with the text colour, so Tailwind v4's
 * oklab and color() strings need no parser here.
 */
function readLeaves({ scrim, page }: { scrim: number; page: [number, number, number] }): { floor: number[]; leaves: Leaf[] } | { error: string } {
  const root = document.querySelector('[data-testid="lp-section"]');
  if (!root) return { error: 'no [data-testid="lp-section"] on the page' };
  const cv = document.createElement('canvas');
  cv.width = 1;
  cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { error: 'no 2d canvas' };
  const over = (ground: string, colour: string): [number, number, number] => {
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!];
  };
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const floor = over(`rgb(${page.join(',')})`, `rgba(0,0,0,${scrim})`);
  const floorCss = `rgb(${floor.join(',')})`;
  const floorL = lum(floor);

  const leaves: Leaf[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent ?? '').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el) continue;
    const kit = el.closest('[data-text-role]');
    if (!kit || !root.contains(kit)) continue;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    // Not on the page: hidden, or clipped to a point (sr-only).
    if (cs.display === 'none' || cs.visibility === 'hidden' || box.width < 2 || box.height < 2) continue;
    let painted = false;
    for (let e: Element | null = el; e && e !== kit.parentElement; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        painted = true;
        break;
      }
    }
    const textL = lum(over(floorCss, cs.color));
    const ratio = (Math.max(textL, floorL) + 0.05) / (Math.min(textL, floorL) + 0.05);
    leaves.push({
      role: kit.getAttribute('data-text-role') ?? '',
      text: text.slice(0, 70),
      px: parseFloat(cs.fontSize),
      ratio: Math.round(ratio * 100) / 100,
      kitSized: cs.fontSize === getComputedStyle(kit).fontSize,
      painted,
    });
  }
  return { floor, leaves };
}

test.describe('the LP text kit is legible on the production page', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'a size and a colour measure the same in every engine; chromium is the gate');

  for (const vp of WIDTHS) {
    test(`/solana-lp: the kit's headings are 15px, its body 13px and its hints 12px, all at 4.5:1 or better over the LP scrim, at ${vp.name}`, async ({ page, walletMock: _w }) => {
      test.slow();
      await page.setViewportSize(vp.size);
      const venue = await playLiveVenue(page, { gateOpen: true });
      await gotoRoute(page, '/solana-lp');
      await expect(page.getByTestId('lp-finder'), 'the LP section did not mount on the played venue').toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-testid="fee-tier"][data-state="live"]'), 'both played fee tiers read').toHaveCount(2);
      await expect(page.getByTestId('lp-gate-banner'), 'the played LP gate did not open').toHaveCount(0);
      // One press: the task line, the site's tokens and the address field come onto the page.
      await page.getByTestId('lp-tasks').getByRole('button', { name: 'Create a pool', exact: true }).click();
      await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
      await page.evaluate(() => document.fonts.ready);
      expect(venue.answered, 'the page asked the played venue').toContain('getMultipleAccounts');

      const read = await page.evaluate(readLeaves, { scrim: LP_SCRIM, page: PAGE_RGB });
      if ('error' in read) throw new Error(read.error);
      const measured = read.leaves.filter((l) => l.kitSized && !l.painted && l.role in FLOORS);
      const skipped = read.leaves.filter((l) => !measured.includes(l));
      test.info().annotations.push({
        type: 'ground',
        description: `the scrim over the page is rgb(${read.floor.join(', ')}); ${measured.length} leaves measured, ${skipped.length} not measured`,
      });
      if (skipped.length > 0) {
        test.info().annotations.push({
          type: 'not measured',
          description: skipped
            .map((l) => `${l.role} ${l.px}px ${l.ratio}:1${l.painted ? ' (own background)' : ' (its own size)'} "${l.text}"`)
            .join(' | '),
        });
      }

      // Enough of each kind, or this is not the page the floors are for.
      const count = (role: Role) => measured.filter((l) => l.role === role).length;
      expect(count('head'), 'card heading leaves measured').toBeGreaterThanOrEqual(HEADINGS_ON_PAGE);
      expect(count('body'), 'card body leaves measured').toBeGreaterThanOrEqual(6);
      expect(count('label'), 'field label leaves measured').toBeGreaterThanOrEqual(1);
      expect(count('hint'), 'field hint leaves measured').toBeGreaterThanOrEqual(1);
      expect(count('notice'), 'notice leaves measured').toBeGreaterThanOrEqual(1);

      const under = measured
        .filter((l) => l.px < FLOORS[l.role as Role] || l.ratio < RATIO)
        .map((l) => `${l.role}: ${l.px}px (floor ${FLOORS[l.role as Role]}px) at ${l.ratio}:1 (floor ${RATIO}:1) "${l.text}"`);
      expect(under, `kit text under its floor at ${vp.name}:\n  ${under.join('\n  ')}`).toEqual([]);
    });
  }
});
