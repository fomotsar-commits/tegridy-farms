/**
 * THE AMBIENT BUBBLES MUST NOT EAT THE PAGE'S TAPS.
 *
 * <TowelieAssistant> and <MuseBubble> both float a panel in the bottom-right
 * corner, and on a phone both sit at `bottom-20` to clear <BottomNav> — which
 * parks an opaque ~100-150px panel squarely OVER page content rather than in a
 * margin beside it. While that panel was `pointer-events-auto`, every tap that
 * landed on it was a tap the page never received, and neither bubble has anything
 * on its body to receive one: the text is there to be read.
 *
 * This was not theoretical. `heat-gate.spec.ts` on `mobile-chrome` lost 5 of 25
 * and then 8 of 25 runs (two independent samples, 2026-09-03) to exactly this,
 * with Playwright naming the bubble as the interceptor of a click aimed at the
 * audit toggle underneath — and `Footer.tsx` had already routed AROUND it, moving
 * the Bungalows button out of the bottom bar because the bubble "intercepts clicks
 * there". A user gets the same swallow with no error and no way to name it.
 *
 * So each panel is inert and only its CONTROLS re-arm themselves.
 *
 * WHAT THESE TESTS PIN, AND WHY IT IS NOT A CLASS ASSERTION. Asserting
 * `pointer-events-none` is on the panel would pass while some later rule put the
 * interception back. So instead they ask the BROWSER what it would hand a tap to,
 * across a grid of points covering the whole panel, and require every one of them
 * to be answered either by the page underneath or by a real control — never by the
 * panel itself. The dismiss is checked in the same breath, because "nothing here
 * is tappable" would be just as wrong an outcome as the swallow.
 *
 * WHY NOT ASSERT ON heat-gate's FLAKE INSTEAD: a rate is not a gate. Reverting the
 * fix reds these tests every run; it reds heat-gate about one run in four.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/wallet';

type Probe = {
  found: boolean;
  panelArea: number;
  /** Points answered by the panel itself — every one of these is a swallowed tap. */
  swallowed: string[];
  /** Points that reached the page under the bubble. */
  reachedPage: number;
  /** Points answered by a control inside the bubble — legitimate, and expected. */
  hitOwnControl: number;
  dismissTapReachesControl: boolean;
};

/**
 * Grid-probe the bubble whose dismiss matches `dismissSelector`. The panel is
 * found FROM that button (its parent) and the floating container by walking up to
 * the nearest `position: fixed` ancestor, so nothing here is coupled to a class.
 */
async function probeBubble(page: Page, dismissSelector: string): Promise<Probe> {
  return page.evaluate((sel) => {
    const empty = { found: false, panelArea: 0, swallowed: [], reachedPage: 0, hitOwnControl: 0, dismissTapReachesControl: false };
    const dismiss = document.querySelector(sel) as HTMLElement | null;
    if (!dismiss) return empty;
    const panel = dismiss.parentElement as HTMLElement;

    let container: HTMLElement = panel;
    while (container.parentElement && getComputedStyle(container).position !== 'fixed') {
      container = container.parentElement;
    }

    const r = panel.getBoundingClientRect();
    const swallowed: string[] = [];
    let reachedPage = 0;
    let hitOwnControl = 0;

    // 5×5 interior grid — the whole panel, not one lucky point.
    for (let i = 1; i <= 5; i++) {
      for (let j = 1; j <= 5; j++) {
        const x = r.left + (r.width * i) / 6;
        const y = r.top + (r.height * j) / 6;
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!hit || !container.contains(hit)) { reachedPage++; continue; }
        // Inside the bubble: only a real control may answer.
        if (hit.closest('button, input, textarea, select, a, form')) { hitOwnControl++; continue; }
        swallowed.push(`(${Math.round(x)},${Math.round(y)}) -> ${hit.tagName}.${String(hit.className).slice(0, 40)}`);
      }
    }

    const dr = dismiss.getBoundingClientRect();
    const dHit = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);

    return {
      found: true,
      panelArea: Math.round(r.width) * Math.round(r.height),
      swallowed,
      reachedPage,
      hitOwnControl,
      dismissTapReachesControl: dismiss === dHit || dismiss.contains(dHit as Node),
    };
  }, dismissSelector);
}

function assertBubbleIsInert(probe: Probe) {
  expect(probe.found, 'the bubble rendered').toBe(true);
  // Guards the guard: a collapsed panel would satisfy the pass-through check for
  // the wrong reason. This is a real panel, really covering the page.
  expect(probe.panelArea, 'the bubble is a real panel over the page').toBeGreaterThan(5_000);
  expect(probe.swallowed, 'no point on the bubble may be answered by the bubble itself').toEqual([]);
  expect(probe.reachedPage, 'most of the panel must pass taps through').toBeGreaterThan(10);
  expect(probe.dismissTapReachesControl, 'the dismiss must still take its own tap').toBe(true);
}

test.describe('the ambient bubbles are read, not pressed', () => {
  test('TowelieAssistant passes taps through its body and keeps its own controls', async ({ page, walletMock }) => {
    await walletMock.connect();          // the fixture pins the toweli bungalow, so the assistant mounts
    await page.goto('/launch');

    // Click the avatar for a bubble on demand — the event-driven and idle bubbles
    // are timing-dependent by design and would make this test a race.
    const avatar = page.getByRole('button', { name: 'Towelie says hi' });
    await expect(avatar).toBeVisible({ timeout: 30_000 });
    await avatar.click();
    await expect(page.getByRole('button', { name: 'Dismiss Towelie' })).toBeVisible({ timeout: 10_000 });

    assertBubbleIsInert(await probeBubble(page, '[aria-label="Dismiss Towelie"]'));
  });

  // WAVE SEVEN, element E: the MuseBubble test that lived here is REMOVED,
  // because the component it tested no longer mounts. The bubble floated
  // bottom-right over every room on arrival, unasked, which is the class
  // element E exists to remove. Its line was not lost with it: museLine
  // renders in the room's own hero pill, where a visitor reads it without
  // anything appearing over their content.
  //
  // TowelieAssistant above still mounts in his own farm and keeps its test.
  // If a room ever wants an invited muse, it gets the treatment the room's
  // welcome just got: behind a tap, with a test for the tap.
});
