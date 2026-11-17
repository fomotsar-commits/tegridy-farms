import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Route } from '@playwright/test';
import { gotoRoute, waitForQuiescence, gotoNakamigos } from './fixtures/routes';
import { BAYLA_LADDER_RECORDING } from './fixtures/baylaLadderPool';
import { MAINNET_VENUE_RECORDING } from '../src/lib/solana/cpswap/mainnetVenue.fixture';

// The words a visitor sees on a route before pressing anything: `main`'s innerText (a closed
// details counts only its summary), Bayla skin, production build, desktop and phone width.
// Owner, 2026-10-14: "as little words as possible". A ceiling only comes down; raising one is
// the owner's call. A failure names the route's longest blocks.
// The unread ledger (data-unread-ledger) is network output, not copy, and is left out.

// Every read is fixed, so the count is the copy's and holds from run to run: Solana answers
// from mainnet recordings, every other /api path and outside host is refused. Read live, the
// home ranged 284 to 432 on one build as the public RPC answered or not (CI, 2026-11-03 to 14).
// A Solana call no recording holds fails the route by name. To record it, with port 4173 free:
// WORD_BUDGET_RECORD=1 npx playwright test e2e/word-budget.spec.ts --project=chromium --workers=1
const READS_FILE = fileURLToPath(new URL('./fixtures/word-budget-reads.json', import.meta.url));
const RECORD = process.env.WORD_BUDGET_RECORD === '1';

type Recording = { note: string; recordedAt: string; slot: number; answers: Record<string, unknown> };
const readsFile = (): Recording => JSON.parse(readFileSync(READS_FILE, 'utf8'));
const RECORDED: Record<string, unknown> = {
  ...BAYLA_LADDER_RECORDING.answers,
  ...MAINNET_VENUE_RECORDING.answers,
  ...readsFile().answers,
};

const PHONE = 390;

// Measured 2026-11-14 with every read fixed (desktop / phone): / 360 / 360, /earn 128 / 112,
// /liquidity 136 / 137, /pools 330 / 330, /zap 79 / 79, /nft-finance 252 / 248,
// /nakamigos 274 / 274, /bayla 389 / 388, /dashboard 197 / 197. /pools is over its ceiling once
// its venue reads: live, CI's reads of it failed (255 at most), so the overage never showed.
const BUDGET: Record<string, { desktop: number; phone: number }> = {
  '/': { desktop: 440, phone: 440 },
  '/earn': { desktop: 140, phone: 125 },
  '/liquidity': { desktop: 140, phone: 140 },
  '/pools': { desktop: 325, phone: 325 },
  '/zap': { desktop: 95, phone: 95 },
  '/nft-finance': { desktop: 275, phone: 260 },
  '/nakamigos': { desktop: 300, phone: 300 },
  '/bayla': { desktop: 500, phone: 500 },
  '/dashboard': { desktop: 225, phone: 225 },
};

type Call = { id?: unknown; method?: unknown; params?: unknown[] };

/** Fixes every read the page makes; returns the Solana calls no recording held. */
async function fixReads(page: Page): Promise<string[]> {
  const own = new URL(test.info().project.use.baseURL!).host;
  await page.route('**/api/**', (r) => r.abort());
  await page.route((url) => url.host !== own, (r) => r.abort());
  const unanswered: string[] = [];
  // Registered last, so it runs first.
  await page.route('**/api/solrpc', async (route) => {
    let body: unknown = null;
    try { body = route.request().postDataJSON(); } catch { /* not JSON: unanswered */ }
    const calls = (Array.isArray(body) ? body : [body]) as Call[];
    const keys = calls.map((c) => `${String(c?.method)}:${String(c?.params?.[0])}`);
    if (!keys.every((k) => k in RECORDED)) {
      if (RECORD && (await recordFromMainnet(route, keys))) return;
      unanswered.push(...keys.filter((k) => !(k in RECORDED)));
      return route.abort();
    }
    const replies = calls.map((c, i) => ({ jsonrpc: '2.0', id: c.id, result: RECORDED[keys[i]!] }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? replies : replies[0]) });
  });
  return unanswered;
}

/** Record mode: asks mainnet through the preview's proxy until it answers, and writes the answers down. */
async function recordFromMainnet(route: Route, keys: string[]): Promise<boolean> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await route.fetch();
    const json = res.status() === 200 ? await res.json().catch(() => null) : null;
    const replies = (Array.isArray(json) ? json : [json]) as { result?: unknown }[];
    if (json && replies.every((r) => r && 'result' in r)) {
      const file = readsFile();
      replies.forEach((r, i) => { file.answers[keys[i]!] = r.result; RECORDED[keys[i]!] = r.result; });
      file.recordedAt = new Date().toISOString().slice(0, 10);
      file.answers = Object.fromEntries(Object.entries(file.answers).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(READS_FILE, `${JSON.stringify(file, null, 1)}\n`);
      await route.fulfill({ response: res, json });
      return true;
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return false;
}

async function settle(page: Page, path: string) {
  if (path === '/nakamigos') await gotoNakamigos(page);
  else await gotoRoute(page, path);
  // Three passes down: a scrollTo lands before the sections it reveals have mounted.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }
  await waitForQuiescence(page, { quietMs: 600, timeout: 12_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Visible words in main, and the longest visible text blocks for the failure message. */
async function visibleWords(page: Page): Promise<{ words: number; longest: string[] }> {
  return page.evaluate(() => {
    const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
    const main = document.querySelector('main') ?? document.body;
    let total = words(main.innerText);
    main.querySelectorAll<HTMLElement>('[data-unread-ledger]').forEach((n) => { total -= words(n.innerText); });
    const blocks = [...main.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, span, div')]
      .filter((el) => el.children.length === 0 && !el.closest('details:not([open])') && el.getBoundingClientRect().height > 0)
      .map((el) => ({ n: words(el.innerText || ''), t: (el.innerText || '').trim().slice(0, 90) }))
      .filter((b) => b.n >= 12)
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
      .map((b) => `  [${b.n}] ${b.t}`);
    return { words: total, longest: blocks };
  });
}

for (const [path, ceiling] of Object.entries(BUDGET)) {
  for (const width of ['desktop', 'phone'] as const) {
    test(`${path} shows at most ${ceiling[width]} words on ${width}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium', 'one build, one browser: the desktop project measures both widths');
      test.slow();
      if (width === 'phone') await page.setViewportSize({ width: PHONE, height: 844 });
      await page.addInitScript(() => {
        try {
          localStorage.setItem('tegridy-onboarding-seen', '1');
          localStorage.setItem('tegridy_telemetry_consent', 'denied');
          // The live resident skin: its rooms are the ones the owner walks.
          localStorage.setItem('tegridy-bungalow', 'bayla');
        } catch { /* private mode */ }
      });
      const unanswered = await fixReads(page);
      await settle(page, path);
      expect(
        [...new Set(unanswered)],
        `${path} asked Solana for something no recording holds, so a card read nothing: record it (see the top of this file)`,
      ).toEqual([]);
      const { words, longest } = await visibleWords(page);
      console.log(`[word-budget] ${path} ${width} ${words}`);
      expect(
        words,
        `${path} (${width}) shows ${words} words, over its ceiling of ${ceiling[width]}. Move explanation into FinePrint. Longest blocks:\n${longest.join('\n')}`,
      ).toBeLessThanOrEqual(ceiling[width]);
    });
  }
}
