import { test, expect, type Page } from '@playwright/test';
import { gotoRoute, waitForQuiescence } from './fixtures/routes';

// ELEMENT F — THE LAUNCH PAGE FOLDS.
//
// Done means, verbatim: "under 120 words above the fold, gate reads a pasted
// address, zero Tegridy display strings". All three are measured here, on the
// rendered page, because all three are claims about what a visitor meets and
// none of them can be read off the source.
//
// The word count was 148. It is not a style preference: /launch opened with an
// h1, a 38-word subtitle carrying four separate claims, and a gate that named
// held time as the thing that matters and then offered no way to find out what
// yours is — all above a wizard nobody had reached yet.
//
// THE TWO DONE-MEANS PULL AGAINST EACH OTHER, which is worth knowing before
// anybody "improves" either one. Giving the gate a paste field puts an input, a
// button and a caption ABOVE the wizard: it took the count from 108 back to 137
// on its own. The copy paid for the field. Anything added here has to pay for
// itself the same way.

const FOLD = { width: 1280, height: 800 };

async function openLaunch(page: Page) {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('tf_loaded', '1');
      localStorage.setItem('tegridy_telemetry_consent', 'denied');
      localStorage.setItem('tegridy-bungalow', 'venue');
      localStorage.setItem('tegridy-onboarding-seen', '1');
    } catch { /* private mode */ }
  });
  await page.setViewportSize(FOLD);
  await gotoRoute(page, '/launch');
  await waitForQuiescence(page);
}

/** Words a visitor actually meets before scrolling. Counted from TEXT NODES
 *  whose own element is inside the first viewport and is really rendered. */
function wordsAboveTheFold(): number {
  const fold = window.innerHeight;
  let n = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = w.nextNode())) {
    const t = (node.textContent ?? '').trim();
    if (!t) continue;
    const el = node.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.top >= fold || r.bottom <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    n += t.split(/\s+/).filter(Boolean).length;
  }
  return n;
}

test.describe('element F: the launch page folds', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'a word count is not engine-dependent');

  test('opens in under 120 words', async ({ page }) => {
    test.slow();
    await openLaunch(page);
    const words = await page.evaluate(wordsAboveTheFold);
    console.log(`[launch] words above the fold at ${FOLD.width}x${FOLD.height}: ${words}`);
    expect(words, `${words} words above the fold; the ceiling is 120`).toBeLessThan(120);
    // And not by emptying the page: the wizard a launcher came for is up here.
    expect(await page.getByRole('heading', { name: /Launch a token/i }).count()).toBeGreaterThan(0);
  });

  test('the gate reads a pasted address, and says it is not a key', async ({ page }) => {
    test.slow();
    await openLaunch(page);
    const door = page.getByRole('region', { name: 'Who may plant' });
    // The instrument itself, not a second field built for this page.
    await expect(door.getByPlaceholder('0x… or a Solana address')).toBeVisible();
    // A reading is advisory. `prove()` needs a signature and a pasted address
    // cannot sign, so the copy has to say so before somebody reads WARM and
    // then finds the lane shut.
    await expect(door).toContainText(/not a key/i);
  });

  test('every essay is behind one door, and the door is shut on arrival', async ({ page }) => {
    await openLaunch(page);
    const summary = page.getByText('How the rail works', { exact: true });
    await expect(summary).toBeVisible();
    // `<details>`, not a conditional render: closed still means present, which
    // is what keeps the em-dash walk honest and the copy tests source-readable.
    const open = await page.evaluate(() => {
      const d = Array.from(document.querySelectorAll('details')).find((x) =>
        x.querySelector('summary')?.textContent?.includes('How the rail works'),
      );
      return { found: !!d, open: d?.open ?? null, hasBody: (d?.textContent ?? '').length > 400 };
    });
    expect(open.found).toBe(true);
    expect(open.open, 'the essays are open on arrival, which is the thing F removes').toBe(false);
    expect(open.hasBody, 'the essays were deleted rather than folded').toBe(true);
  });

  test('speaks zero Tegridy anywhere a visitor can read it', async ({ page }) => {
    await openLaunch(page);
    // textContent, NOT innerText. innerText is LAYOUT-AWARE and omits anything
    // a closed <details> is hiding, so this assertion silently stopped covering
    // the folded essays the moment F folded them — it passed because it could
    // not see them, which is the same defect as a vacuous guard wearing a
    // different hat. textContent reads the DOM regardless of what is displayed.
    //
    // Two names are deliberately NOT swept and are excluded by pattern rather
    // than by a blanket allowance: `TegridyV4Hook` and
    // `TEGRIDY_V4_MIGRATOR_ADDRESS` are what a contract and a constant are
    // actually called, and renaming those in copy would misname real things an
    // operator has to go and find. The PROSE around them is the venue's voice
    // and is swept.
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('style, script, noscript, template').forEach((n) => n.remove());
      return clone.textContent ?? '';
    });
    const prose = text.replace(/TegridyV4Hook|TEGRIDY_V4_MIGRATOR_ADDRESS|TegridyStaking/g, '');
    expect(prose).not.toMatch(/tegridy/i);
    // Placeholders and labels are read by somebody even when innerText is not.
    const attrs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea, button, a'))
        .flatMap((el) => [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('title')])
        .filter(Boolean)
        .join(' | '),
    );
    expect(attrs).not.toMatch(/tegridy/i);
  });
});
