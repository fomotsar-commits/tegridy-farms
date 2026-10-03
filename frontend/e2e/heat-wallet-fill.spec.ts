import { test, expect, type Page } from '@playwright/test';

// THE HEAT READER'S WALLET BUTTON, INSIDE A WALLET'S OWN BROWSER. Trust Wallet's carries
// Ethereum at window.ethereum and Solana at window.trustwallet.solana, and a Solana
// visitor must never be handed an Ethereum prompt for it. The wallet here is a stand-in
// that records what it is asked; it holds no key.

// MUTATION CHECKS
//  - lib/heat/walletFill.ts: drop `w.trustwallet?.solana`. The first two tests fail.
//  - LaunchGate.tsx: drop `fillFrom`. The second test fails.
//  - HeatCard.tsx: drop `w-full` from the fill buttons' row. The third fails at phone width.
//  - HeatCard.tsx: drop the `solanaConnected` shortcut from `fill`. The fourth fails.

test.use({ serviceWorkers: 'block' });

const SOL = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw';
const ETH = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';

async function insideWalletBrowser(page: Page, carries: { solana: boolean }) {
  await page.addInitScript(
    ({ sol, eth, solana }) => {
      try {
        localStorage.setItem('tegridy-onboarding-seen', '1');
        localStorage.setItem('tegridy_telemetry_consent', 'denied');
        if (!localStorage.getItem('tegridy-bungalow')) localStorage.setItem('tegridy-bungalow', 'venue');
      } catch { /* private mode */ }
      const asked: string[] = [];
      const w = window as unknown as Record<string, unknown>;
      w.__walletAsked = asked;
      w.ethereum = {
        isTrust: true,
        request: async ({ method }: { method: string }) => {
          asked.push(`ethereum ${method}`);
          return method === 'eth_requestAccounts' ? [eth] : [];
        },
        on() {},
        removeListener() {},
      };
      if (!solana) return;
      w.trustwallet = {
        solana: {
          isTrust: true,
          publicKey: null,
          connect: async (options?: unknown) => {
            asked.push(`solana connect ${JSON.stringify(options ?? null)}`);
            return { publicKey: { toString: () => sol } };
          },
          on() {},
          off() {},
        },
      };
    },
    { sol: SOL, eth: ETH, solana: carries.solana },
  );
}

const field = (page: Page) => page.locator('#main-content').getByLabel(/Wallet address to read Heat for/).first();
const asked = (page: Page) => page.evaluate(() => (window as unknown as { __walletAsked: string[] }).__walletAsked);

test('on the home page, the reader offers the Solana address and asks the Solana wallet only', async ({ page }) => {
  await insideWalletBrowser(page, { solana: true });
  await page.goto('/');
  await expect(field(page)).toBeVisible({ timeout: 30_000 });
  const main = page.locator('#main-content');
  await expect(main.getByRole('button', { name: 'Use my Ethereum address' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Use my wallet' })).toHaveCount(0);

  await main.getByRole('button', { name: 'Use my Solana address' }).click();
  await expect(field(page)).toHaveValue(SOL);
  expect(await asked(page)).toEqual(['solana connect {"onlyIfTrusted":true}']);
});

test('the Solana launch door reads the Solana wallet and never asks the Ethereum one', async ({ page }) => {
  await insideWalletBrowser(page, { solana: true });
  await page.goto('/curve-launch');
  const door = page.getByRole('region', { name: 'Who may plant' });
  await expect(door).toBeVisible({ timeout: 30_000 });
  await expect(door.getByRole('button', { name: /Ethereum address/ })).toHaveCount(0);

  await door.getByRole('button', { name: 'Use my wallet' }).click();
  await expect(door.getByLabel(/Wallet address to read Heat for/)).toHaveValue(SOL);
  expect(await asked(page)).toEqual(['solana connect {"onlyIfTrusted":true}']);
});

test('after Solana is connected from the top bar, the Solana button fills that wallet and asks it nothing more', async ({ page }) => {
  await insideWalletBrowser(page, { solana: true });
  await page.goto('/');
  await expect(field(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Solana/ }).click();
  const list = page.getByRole('dialog', { name: /on Solana to continue/ });
  await list.getByRole('button', { name: /Trust/ }).click({ timeout: 30_000 });
  await expect(page.getByRole('banner').getByRole('button', { name: 'Your wallets' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The top bar's own connect is all the wallet has been asked.
  expect(await asked(page)).toEqual(['solana connect null']);

  // The card keeps the labels it was drawn with, and the Solana one now needs no wallet.
  const main = page.locator('#main-content');
  await expect(main.getByRole('button', { name: 'Use my Ethereum address' })).toBeVisible();
  await main.getByRole('button', { name: 'Use my Solana address' }).click();
  await expect(field(page)).toHaveValue(SOL);
  expect(await asked(page)).toEqual(['solana connect null']);
});

test('with a wallet button on the page, the field still shows its whole hint', async ({ page }) => {
  await insideWalletBrowser(page, { solana: false });
  await page.goto('/');
  await expect(field(page)).toBeVisible({ timeout: 30_000 });
  const button = page.locator('#main-content').getByRole('button', { name: 'Use my wallet' });
  await expect(button).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  // The hint's drawn width against the room the box has for it.
  const hint = await field(page).evaluate((el: HTMLInputElement) => {
    const cs = getComputedStyle(el);
    const pen = document.createElement('canvas').getContext('2d')!;
    pen.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return {
      needs: pen.measureText(el.placeholder).width,
      room: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    };
  });
  expect(hint.needs, `"0x… or a Solana address" needs ${hint.needs}px and the field has ${hint.room}px`).toBeLessThanOrEqual(hint.room);

  // On a phone the button has its own row, under the field.
  if ((page.viewportSize()?.width ?? 0) < 640) {
    const fieldBox = (await field(page).boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    expect(buttonBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
  }
});
