// The heat door on /curve-launch. The island: "Resident opens the torches, the plant and
// the launches." A maker whose connected Solana wallet reads below the floor never reaches
// the create form, and nothing is put in front of the wallet; the list and lookup stay open.
// (Every other spec installs the warm stub; the create form's own call at submit is
// covered by src/components/solana/curve/LaunchCreateForm.heatGate.test.tsx.)
import { test, expect } from '@playwright/test';
import { fundedKeypair } from './fixtures/chain';
import { installTestWallet } from './fixtures/testWallet';
import { installRpcGuard } from './fixtures/rpcGuard';
import { installUploadStub } from './fixtures/uploadStub';
import { installHeatStub } from './fixtures/heatStub';
import { ui, connectWallet } from './fixtures/ui';

test('a cold maker never reaches the create form; the list and lookup stay open', async ({ browser }) => {
  const kp = await fundedKeypair(0.1);
  const ctx = await browser.newContext();
  const wallet = await installTestWallet(ctx, kp);
  const rpc = await installRpcGuard(ctx);
  await installUploadStub(ctx);
  const heat = await installHeatStub(ctx, 12);
  const page = await ctx.newPage();

  await page.goto('/curve-launch');
  await expect(ui.gateBanner(page)).toContainText('Open.', { timeout: 30_000 });
  await connectWallet(page, ui.door(page));
  const door = ui.door(page);
  await expect(door.getByText('COLD', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(door).toContainText('The door opens at 80°');
  expect(heat.asked).toContain(kp.publicKey.toBase58());

  await expect(ui.createForm(page)).toHaveCount(0);
  await expect(ui.form.reviewButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /prove this wallet is yours/i })).toHaveCount(0);
  await expect(ui.list(page)).toBeVisible();
  await expect(page.getByText('Open a launch by its address')).toBeVisible();
  expect(wallet.records, 'nothing was put in front of the wallet').toEqual([]);
  expect(rpc.violations).toEqual([]);
  await ctx.close();
});
