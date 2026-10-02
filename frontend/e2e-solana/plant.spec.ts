// The plant is paid from the maker's own $BAYLA: a wallet holding less than 100,000 never
// gets a Review, is told why in plain words, and nothing is uploaded, signed or sent.
// (The full create, with the plant moving to the base unit, is launch-flow.spec.ts.)
import { test, expect } from '@playwright/test';
import { fundedKeypair } from './fixtures/chain';
import { bayla, baylaAccount, baylaAmount, baylaSupply, giveBayla, WORKSHOP_BAYLA_ACCOUNT } from './fixtures/bayla';
import { installTestWallet } from './fixtures/testWallet';
import { installRpcGuard } from './fixtures/rpcGuard';
import { installUploadStub, makePng } from './fixtures/uploadStub';
import { installHeatStub } from './fixtures/heatStub';
import { ui, connectWallet, expectConnected } from './fixtures/ui';

test('a maker holding 99,999 $BAYLA gets no Review, the plain reason, and nothing is sent', async ({ browser }) => {
  const kp = await fundedKeypair(1);
  await giveBayla(kp, bayla(99_999));
  const ctx = await browser.newContext();
  const wallet = await installTestWallet(ctx, kp);
  const rpc = await installRpcGuard(ctx);
  const upload = await installUploadStub(ctx);
  await installHeatStub(ctx);
  const page = await ctx.newPage();
  const before = { maker: await baylaAmount(baylaAccount(kp.publicKey)), workshop: await baylaAmount(WORKSHOP_BAYLA_ACCOUNT), supply: await baylaSupply() };
  expect(before.maker).toBe(bayla(99_999));

  await page.goto('/curve-launch');
  await connectWallet(page, ui.door(page));
  await expectConnected(ui.createForm(page), kp.publicKey.toBase58());
  // Everything else a launch needs is filled in, so the plant is the only thing missing.
  await ui.form.picture(page).setInputFiles({ name: 'corn.png', mimeType: 'image/png', buffer: makePng() });
  await ui.form.name(page).fill('Short Corn');
  await ui.form.symbol(page).fill('SCORN');
  await expect(ui.plantTerms(page)).toContainText('99,999 $BAYLA', { timeout: 30_000 });
  await expect(ui.reviewMissing(page)).toHaveText('Your wallet holds 99,999 $BAYLA. A launch plants 100,000.');
  await expect(ui.form.reviewButton(page)).toBeDisabled();
  // A press on the disabled button does nothing either.
  await ui.form.reviewButton(page).click({ force: true });
  await expect(ui.review(page)).toHaveCount(0);

  expect(wallet.records, 'nothing was put in front of the wallet').toEqual([]);
  expect(upload.uploads, 'nothing was uploaded').toEqual([]);
  expect(rpc.calls.filter((c) => c.method === 'sendTransaction' || c.method === 'simulateTransaction'), 'nothing was built or sent').toEqual([]);
  expect(await baylaAmount(baylaAccount(kp.publicKey))).toBe(before.maker);
  expect(await baylaAmount(WORKSHOP_BAYLA_ACCOUNT)).toBe(before.workshop);
  expect(await baylaSupply()).toBe(before.supply);
  expect(rpc.violations).toEqual([]);
  await ctx.close();
});
