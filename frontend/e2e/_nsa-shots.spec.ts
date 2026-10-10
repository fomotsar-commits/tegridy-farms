// Scratch: screenshots of the /nft-finance strip for a human to look at. Not committed.
import { test, expect } from './fixtures/wallet';
import { gotoRoute } from './fixtures/routes';

const OUT = 'C:/Users/jimbo/dev/wt/_nsa-shots';
const MOTION = process.env.NSA_MOTION === '1';
if (MOTION) test.use({ contextOptions: { reducedMotion: 'no-preference' } });

for (const width of [390, 820]) {
  test(`shots at ${width}`, async ({ page, walletMock: _w }, info) => {
    const tag = `${info.project.name}-${width}${MOTION ? '-motion' : ''}`;
    await page.setViewportSize({ width, height: 900 });
    await gotoRoute(page, '/nft-finance');
    const list = page.getByRole('tablist', { name: 'NFT Finance sections' });
    await expect(list.getByRole('tab').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const read = () =>
      list.evaluate((el) => {
        const wrap = el.parentElement!;
        const r = (b: DOMRect) => `${Math.round(b.left)}..${Math.round(b.right)} (${Math.round(b.width)}x${Math.round(b.height)})`;
        return {
          clientWidth: document.documentElement.clientWidth,
          strip: r(el.getBoundingClientRect()),
          scrollLeft: el.scrollLeft,
          max: el.scrollWidth - el.clientWidth,
          tabs: Array.from(el.children, (t) => `${t.id.replace('nft-finance-tab-', '')} ${r(t.getBoundingClientRect())}`),
          arrows: Array.from(wrap.querySelectorAll('[data-strip-arrow]'), (a) => `${a.getAttribute('data-strip-arrow')} ${r(a.getBoundingClientRect())}`),
          focus: document.activeElement?.tagName + ':' + (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id ?? ''),
        };
      });
    const log: unknown[] = [];
    const shot = async (name: string) => {
      await list.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await page.waitForTimeout(700);
      const box = (await list.boundingBox())!;
      await page.screenshot({ path: `${OUT}/${tag}-${name}-page.png` });
      await page.screenshot({
        path: `${OUT}/${tag}-${name}-strip.png`,
        clip: { x: 0, y: Math.max(0, box.y - 30), width, height: box.height + 60 },
      });
      log.push({ name, ...(await read()) });
    };
    await shot('1-landing');
    const next = page.getByRole('button', { name: 'More sections', exact: true });
    const prev = page.getByRole('button', { name: 'Earlier sections', exact: true });
    let n = 0;
    while ((await next.count()) && n < 8) {
      const b = (await next.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      if (n === 0) {
        await page.waitForTimeout(300);
        await shot('2-hover-next');
      }
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      n++;
      await page.mouse.move(5, 5);
      await shot(`3-next-${n}`);
    }
    let p = 0;
    while ((await prev.count()) && p < 8) {
      const b = (await prev.boundingBox())!;
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      p++;
      await page.mouse.move(5, 5);
      await shot(`4-prev-${p}`);
    }
    // A deep link to the middle: both arrows, the selected tab between them.
    await gotoRoute(page, '/nft-finance?section=bnpl');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    await shot('5-bnpl');
    await gotoRoute(page, '/nft-finance?section=launchpad');
    await page.waitForTimeout(1500);
    await shot('6-launchpad');
    console.log(`NSA ${tag} presses next=${n} prev=${p}\n` + JSON.stringify(log, null, 1));
  });
}
