// SCRATCH, UNCOMMITTED: what each width ruler reads, per route, width and project.
import { appendFileSync } from 'node:fs';
import { test } from '../e2e/fixtures/wallet';
import { AUDITABLE_ROUTES, gotoNakamigos, gotoRoute, navigablePath, waitForQuiescence } from '../e2e/fixtures/routes';

const OUT = process.env.MEASURE_OUT!;
const WIDTHS = (process.env.MEASURE_WIDTHS ?? '390,768,820,1024').split(',').map(Number);
const ONLY = process.env.MEASURE_ROUTES?.split(',');

function read() {
  const de = document.documentElement;
  window.scrollTo(500, 0);
  const slid = window.scrollX;
  window.scrollTo(0, 0);
  const limit = de.clientWidth;
  const clippedBy = (el: Element): boolean => {
    let abs = getComputedStyle(el).position === 'absolute';
    if (getComputedStyle(el).position === 'fixed') return true;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const positioned = cs.position !== 'static';
      if (cs.position === 'fixed') return true;
      if (cs.overflowX !== 'visible' && (!abs || positioned) && p.getBoundingClientRect().right <= limit + 1) return true;
      if (abs && positioned) abs = cs.position === 'absolute';
    }
    return false;
  };
  const offenders: { right: number; left: number; what: string }[] = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= limit + 1) continue;
    if (clippedBy(el)) continue;
    const cls = typeof el.className === 'string' ? el.className.slice(0, 110) : '';
    offenders.push({
      right: Math.round(r.right),
      left: Math.round(r.left),
      what: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : ''}${el.getAttribute('data-testid') ? '[testid=' + el.getAttribute('data-testid') + ']' : ''} .${cls} "${(el.textContent ?? '').trim().slice(0, 40)}"`,
    });
  }
  offenders.sort((a, b) => b.right - a.right);
  return {
    innerWidth: window.innerWidth,
    clientWidth: de.clientWidth,
    scrollWidth: de.scrollWidth,
    height: de.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    vvWidth: window.visualViewport ? Math.round(window.visualViewport.width) : null,
    vvScale: window.visualViewport ? Number(window.visualViewport.scale.toFixed(3)) : null,
    slid,
    htmlOverflowX: getComputedStyle(de).overflowX,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    offenders: offenders.slice(0, 4),
    offenderCount: offenders.length,
  };
}

for (const route of AUDITABLE_ROUTES) {
  if (ONLY && !ONLY.includes(route.path)) continue;
  test(`measure ${route.path}`, async ({ page, walletMock: _w }, info) => {
    test.setTimeout(240_000);
    const isNakamigos = route.path === '/nakamigos';
    if (route.path === '/') {
      await page.addInitScript(() => {
        try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
      });
    }
    for (const width of WIDTHS) {
      const row: Record<string, unknown> = { project: info.project.name, path: route.path, asked: width };
      try {
        await page.setViewportSize({ width, height: 900 });
        if (isNakamigos) { await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* ignore */ } }).catch(() => {}); await gotoNakamigos(page); }
        else await gotoRoute(page, navigablePath(route));
        await waitForQuiescence(page, { quietMs: 600, timeout: 8_000 });
        await page.evaluate(() => document.fonts.ready);
        Object.assign(row, await page.evaluate(read));
        if (process.env.MEASURE_SCROLL) {
          for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(400); }
          await waitForQuiescence(page, { quietMs: 500, timeout: 6_000 });
          const after = await page.evaluate(read);
          row.afterScroll = { scrollWidth: after.scrollWidth, clientWidth: after.clientWidth, slid: after.slid, height: await page.evaluate(() => document.documentElement.scrollHeight), offenders: after.offenders };
        }
      } catch (e) {
        row.error = String(e).slice(0, 300);
      }
      appendFileSync(OUT, JSON.stringify(row) + '\n');
    }
  });
}
