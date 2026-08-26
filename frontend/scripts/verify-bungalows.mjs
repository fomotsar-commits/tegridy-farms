// Visual verification for the Jungle Bay bungalow system (2026-08-24).
// Standalone playwright-core script (NOT the e2e runner — no anvil needed):
//   node scripts/verify-bungalows.mjs <outDir> [baseUrl]
//
// Covers:
//  A) Toweli baseline — desktop home/farm/swap/dashboard (classic art intact)
//  B) Bayla mode (storage-seeded) — same pages + iPhone/iPad, asserts every
//     data-art-surface img resolves under /art/bayla/ EXCEPT the shared
//     nav-logo button, and that all bayla images actually load (HTTP 200).
//  C) Fresh-visit flow under reduced motion — splash self-skips, the
//     BungalowPicker auto-opens, clicking Bayla persists + reloads into
//     bayla art. The end-to-end user path.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'bungalow-shots');
const BASE = process.argv[3] ?? 'http://localhost:5173';
mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const SEED_COMMON = `
  localStorage.setItem('tegridy-onboarding-seen', '1');
  localStorage.setItem('tegridy-onboarding-bayla-seen', '1');
  localStorage.setItem('tegridy_telemetry_consent', 'denied');
`;

async function settle(page, ms = 2500) {
  // The app never reaches networkidle (price polling, tickers) — fixed settle.
  await page.waitForTimeout(ms);
}

async function artSrcs(page) {
  // Lazy chunks + a busy dev server can mount art after the fixed settle —
  // wait for the first surface (not forever: pages legitimately without any
  // ArtImg fall through after the timeout and return []).
  await page.waitForSelector('img[data-art-surface]', { timeout: 12000 }).catch(() => {});
  return page.$$eval('img[data-art-surface]', (imgs) =>
    imgs.map((i) => ({ surface: i.getAttribute('data-art-surface'), src: i.getAttribute('src') })));
}

const browser = await chromium.launch();
try {
  // ---------- A) Toweli baseline, desktop ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(`sessionStorage.setItem('tf_loaded','1');${SEED_COMMON}localStorage.setItem('tegridy-bungalow','toweli');`);
    const page = await ctx.newPage();
    for (const [route, name] of [['/', 'home'], ['/farm', 'farm'], ['/swap', 'swap'], ['/dashboard', 'dashboard']]) {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.screenshot({ path: `${OUT}/toweli-${name}-desktop.png` });
      if (name === 'home') {
        ok('A: toweli home keeps the classic hero', await page.locator('h1:has-text("Farm TOWELI.")').count() === 1);
      }
    }
    const srcs = await artSrcs(page);
    ok('A: toweli mode shows zero bayla art', srcs.every((s) => !s.src?.includes('/art/bayla/')),
      `${srcs.length} art surfaces checked`);
    await ctx.close();
  }

  // ---------- B) Bayla mode ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(`sessionStorage.setItem('tf_loaded','1');${SEED_COMMON}localStorage.setItem('tegridy-bungalow','bayla');`);
    const page = await ctx.newPage();
    const failedImages = [];
    page.on('response', (r) => {
      if (r.url().includes('/art/bayla/') && r.status() >= 400) failedImages.push(`${r.status()} ${r.url()}`);
    });
    for (const [route, name] of [['/', 'home'], ['/farm', 'farm'], ['/swap', 'swap'], ['/dashboard', 'dashboard']]) {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.screenshot({ path: `${OUT}/bayla-${name}-desktop.png` });
      const srcs = await artSrcs(page);
      const nonShared = srcs.filter((s) => !s.surface?.startsWith('nav-logo'));
      const swapped = nonShared.filter((s) => s.src?.includes('/art/bayla/'));
      ok(`B: ${name} art surfaces swapped to bayla`, nonShared.length > 0 && swapped.length === nonShared.length,
        `${swapped.length}/${nonShared.length}`);
      // Token-first identity assertions (the "no TOWELI focus" contract).
      if (name === 'home') {
        ok('B: home hero speaks BAYLA', await page.locator('h1:has-text("BAYLA.")').count() === 1);
        ok('B: home hero drops the TOWELI headline', await page.locator('h1:has-text("Farm TOWELI.")').count() === 0);
        ok('B: the muse line replaces the Towelie ticker',
          await page.locator('text=The work is yours. The light is hers.').count() >= 1
          && await page.locator('text=— Towelie').count() === 0);
        ok('B: Towelie assistant is muted in bayla mode', await page.locator('text=Ask me').count() === 0);
      }
      if (name === 'farm') {
        ok('B: farm renders the BAYLA panel', await page.locator('h1:has-text("Stake BAYLA.")').count() === 1);
        ok('B: farm panel self-gates honestly', await page.locator('text=Not deployed yet').count() === 1);
        ok('B: farm drops the TOWELI stack', await page.locator('text=TOWELI Price').count() === 0);
        ok('B: heat oracle card present', await page.locator('text=Check your heat').count() >= 1);
      }
      if (name === 'dashboard') {
        ok('B: dashboard is her standing page',
          await page.locator('h1:has-text("BAYLA Dashboard.")').count() === 1
          && await page.locator('button:has-text("Connect Solana Wallet")').count() === 1);
        await page.screenshot({ path: `${OUT}/bayla-dashboard-desktop.png` });
      }
      if (name === 'home') {
        ok('B: muse lore section present', await page.locator('text=The muse of Jungle Bay Island').count() >= 1);
        ok('B: TOWELI fee-economy sections hidden',
          await page.locator('text=How the Farm Works').count() === 0
          && await page.locator('text=TVL').count() === 0);
        const tradeHrefs = await page.$$eval('a[href*="jup.ag"], a[href*="/solana?out="]', (as) => as.map((a) => a.getAttribute('href')));
        ok('B: Trade BAYLA routes in-venue or to Jupiter', tradeHrefs.length >= 1, tradeHrefs[0] ?? 'none');
      }
    }
    // The nav-logo replay button is a BUTTON — must keep classic art.
    const navLogo = await page.$eval('button[title^="Replay splash"] img', (i) => i.getAttribute('src'));
    ok('B: nav-logo button art is NOT bayla', !!navLogo && !navLogo.includes('/art/bayla/'), navLogo ?? 'missing');
    ok('B: every bayla image request succeeded', failedImages.length === 0, failedImages.join('; ') || 'no 4xx/5xx');

    // Footer shows the active bungalow + reopens the picker.
    await page.locator('footer button:has-text("Bungalows")').scrollIntoViewIfNeeded();
    ok('B: footer names the active bungalow', await page.locator('footer button:has-text("Bayla")').count() > 0);
    await page.locator('footer button:has-text("Bungalows")').click();
    const pickerVisible = await page.locator('text=Thirteen bungalows').isVisible({ timeout: 5000 }).catch(() => false);
    ok('B: footer button reopens picker', pickerVisible);
    if (pickerVisible) await page.screenshot({ path: `${OUT}/bayla-picker-reopened.png` });
    await ctx.close();

    // Responsive: iPhone 14 Pro + iPad portrait on home/farm.
    for (const [label, vp, scale, mobile] of [
      ['iphone', { width: 393, height: 852 }, 3, true],
      ['ipad', { width: 820, height: 1180 }, 2, false],
    ]) {
      const mctx = await browser.newContext({ viewport: vp, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile });
      await mctx.addInitScript(`sessionStorage.setItem('tf_loaded','1');${SEED_COMMON}localStorage.setItem('tegridy-bungalow','bayla');`);
      const mp = await mctx.newPage();
      for (const [route, name] of [['/', 'home'], ['/farm', 'farm']]) {
        await mp.goto(BASE + route, { waitUntil: 'domcontentloaded' });
        await settle(mp);
        await mp.screenshot({ path: `${OUT}/bayla-${name}-${label}.png` });
      }
      const msrcs = (await artSrcs(mp)).filter((s) => !s.surface?.startsWith('nav-logo'));
      ok(`B: ${label} art swapped`, msrcs.length > 0 && msrcs.every((s) => s.src?.includes('/art/bayla/')),
        `${msrcs.length} surfaces`);
      await mctx.close();
    }
  }

  // ---------- D) The door format: memetics.finance/<bungalow> ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(SEED_COMMON); // no tf_loaded, no bungalow choice — a cold shared link
    const page = await ctx.newPage();
    await page.goto(BASE + '/bayla', { waitUntil: 'domcontentloaded' });
    await settle(page, 4000); // door persists + reloads in place
    ok('D: /bayla keeps its address', new URL(page.url()).pathname === '/bayla');
    ok('D: /bayla enters the bungalow', await page.evaluate(() => localStorage.getItem('tegridy-bungalow')) === 'bayla');
    ok('D: /bayla wears her skin', await page.locator('h1:has-text("BAYLA.")').count() === 1);
    await page.screenshot({ path: `${OUT}/door-bayla.png` });
    // The towelie spelling is an alias for the toweli slug.
    await page.goto(BASE + '/towelie', { waitUntil: 'domcontentloaded' });
    await settle(page, 4000);
    ok('D: /towelie flips back to the default', await page.evaluate(() => localStorage.getItem('tegridy-bungalow')) === 'toweli');
    ok('D: /towelie wears the classic hero', await page.locator('h1:has-text("Farm TOWELI.")').count() === 1);
    ok('D: /towelie keeps its address', new URL(page.url()).pathname === '/towelie');
    await ctx.close();
  }

  // ---------- C) Fresh visit → picker → enter Bayla ----------
  {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce', // splash self-skips; picker should follow immediately
    });
    await ctx.addInitScript(SEED_COMMON); // NO tf_loaded, NO bungalow choice
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    const picker = page.locator('text=Thirteen bungalows');
    const appeared = await picker.isVisible({ timeout: 15000 }).catch(() => false)
      || await picker.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    ok('C: picker auto-opens after (skipped) intro on first visit', appeared);
    if (appeared) {
      await page.screenshot({ path: `${OUT}/first-visit-picker.png` });
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        page.locator('button:has-text("Bayla")').first().click(),
      ]);
      await settle(page, 3500);
      const chosen = await page.evaluate(() => localStorage.getItem('tegridy-bungalow'));
      ok('C: clicking Bayla persists the choice', chosen === 'bayla', String(chosen));
      const srcs = (await artSrcs(page)).filter((s) => !s.surface?.startsWith('nav-logo'));
      ok('C: post-reload backgrounds are bayla', srcs.length > 0 && srcs.every((s) => s.src?.includes('/art/bayla/')),
        `${srcs.length} surfaces`);
      await page.screenshot({ path: `${OUT}/first-visit-after-enter-bayla.png` });
      // Dismissing must not nag on next load: picker stays closed.
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await settle(page, 2000);
      ok('C: picker does not reopen once a choice exists', !(await picker.isVisible().catch(() => false)));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
