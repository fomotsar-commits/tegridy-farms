// Every selector the /curve-launch e2e uses, in one place.
//
// They follow set U's components (src/components/solana/curve/*, pages/CurveLaunchDetailPage.tsx):
// Card test ids, the inputs' aria-labels, and the buttons' visible words. If U renames
// one, this file is the only one to change. Buttons are always found by their words
// (what a person reads), never by a class.
//
// "Visible" is not "clickable" (this repo paid for that lesson): every button a spec
// presses goes through expectClickable, which asks the browser what is actually on top
// at the button's centre.
import { expect, type Locator, type Page } from '@playwright/test';
import { TEST_WALLET_NAME } from './testWallet';

export const ui = {
  gateBanner: (p: Page) => p.getByTestId('write-gate-banner'),
  createForm: (p: Page) => p.getByTestId('launch-create-form'),
  publicForever: (p: Page) => p.getByTestId('public-forever'),
  review: (p: Page) => p.getByTestId('tx-review'),
  outcome: (p: Page) => p.getByTestId('tx-outcome'),
  list: (p: Page) => p.getByTestId('launch-list'),
  listRows: (p: Page) => p.getByTestId('launch-row'),
  tradePanel: (p: Page) => p.getByTestId('curve-trade-panel'),
  graduationPanel: (p: Page) => p.getByTestId('graduation-panel'),
  poolPanel: (p: Page) => p.getByTestId('pool-swap-panel'),
  creatorStake: (p: Page) => p.getByTestId('creator-stake'),
  pendingLaunch: (p: Page) => p.getByTestId('pending-launch'),
  /** A trade sent from this tab before a reload that the chain has not answered for yet. */
  pendingTrade: (p: Page) => p.getByTestId('pending-trade'),
  beforeYouTrade: (p: Page) => p.getByTestId('before-you-trade'),
  /** The Launch hub's tab for this page (RouteTabs renders a tablist). */
  navTab: (p: Page) => p.getByRole('tab', { name: /Solana Curve/ }).first(),
  connectButton: (scope: Page | Locator) => scope.getByRole('button', { name: 'Connect Solana Wallet' }).first(),
  walletModal: (p: Page) => p.getByRole('dialog'),
  signButton: (p: Page) => p.getByRole('button', { name: 'Sign in wallet' }),
  form: {
    name: (p: Page) => p.getByLabel('Token name'),
    symbol: (p: Page) => p.getByLabel('Token symbol'),
    picture: (p: Page) => p.getByLabel('Token picture'),
    description: (p: Page) => p.getByLabel('Token description'),
    openingBuyToggle: (p: Page) => p.getByLabel(/Your opening buy \(optional\)/),
    openingBuy: (p: Page) => p.getByLabel('Opening buy in SOL'),
    reviewButton: (p: Page) => p.getByRole('button', { name: 'Review launch' }),
  },
  trade: {
    side: (p: Page, side: 'buy' | 'sell') => ui.tradePanel(p).getByRole('group', { name: 'Buy or sell' }).getByRole('button', { name: side }),
    amount: (p: Page, side: 'buy' | 'sell') => p.getByLabel(side === 'buy' ? 'Amount of SOL to spend' : 'Amount of tokens to sell'),
    reviewButton: (p: Page, side: 'buy' | 'sell') => ui.tradePanel(p).getByRole('button', { name: `Review ${side}` }),
  },
  pool: {
    side: (p: Page, side: 'buy' | 'sell') => ui.poolPanel(p).getByRole('group', { name: 'Buy or sell in the pool' }).getByRole('button', { name: side }),
    amount: (p: Page, side: 'buy' | 'sell') => p.getByLabel(side === 'buy' ? 'Amount of SOL to pay in the pool' : 'Amount of tokens to sell in the pool'),
    reviewButton: (p: Page, side: 'buy' | 'sell') => ui.poolPanel(p).getByRole('button', { name: `Review pool ${side}` }),
  },
  graduate: (p: Page) => p.getByRole('button', { name: 'Review: finish graduation' }),
  release: (p: Page) => p.getByRole('button', { name: 'Review: release platform reserve' }),
  checkAgain: (p: Page) => p.getByRole('button', { name: 'Check again' }),
};

/**
 * The element at the centre of `loc` must be `loc` or inside it. Returns nothing; fails
 * naming what covers it.
 */
export async function expectClickable(loc: Locator, what = 'element'): Promise<void> {
  // Visible first (bounded by the expect timeout): scrollIntoViewIfNeeded on a missing
  // element would wait out the whole test.
  await expect(loc, `${what} should be visible`).toBeVisible();
  await loc.scrollIntoViewIfNeeded();
  const hit = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top) return `nothing at (${x.toFixed(0)}, ${y.toFixed(0)})`;
    if (top === el || el.contains(top)) return null;
    const d = top as HTMLElement;
    return `<${d.tagName.toLowerCase()} class="${d.className}"> "${(d.textContent ?? '').trim().slice(0, 60)}" covers it at (${x.toFixed(0)}, ${y.toFixed(0)})`;
  });
  expect(hit, `${what} is visible but not clickable`).toBeNull();
}

export async function clickReal(loc: Locator, what: string): Promise<void> {
  await expectClickable(loc, what);
  // Fail with the reason, rather than let click() wait out the whole test on a disabled button.
  await expect(loc, `${what} is not enabled`).toBeEnabled({ timeout: 30_000 });
  await loc.click();
}

/** No horizontal page scroll at this width (the sr-only / wrapper trap). */
export async function expectNoSidewaysScroll(p: Page): Promise<void> {
  const { sw, iw } = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `page is ${sw}px wide in a ${iw}px window`).toBeLessThanOrEqual(iw);
}

/** The three sizes the owner checks: desktop, iPhone 14 and iPad (portrait). */
export const SHOT_SIZES = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'iphone14', width: 390, height: 844 },
  { name: 'ipad', width: 820, height: 1180 },
] as const;

/**
 * At each of SHOT_SIZES: no sideways scroll, every `pressable` is on top at its own
 * centre (elementFromPoint), and, when E2E_SHOTS_DIR is set, a full-page screenshot
 * `<label>-<size>.png`. Puts the viewport back afterwards.
 */
export async function checkAtSizes(p: Page, label: string, pressable: Array<[Locator, string]>): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  const original = p.viewportSize();
  for (const s of SHOT_SIZES) {
    await p.setViewportSize({ width: s.width, height: s.height });
    await expectNoSidewaysScroll(p);
    for (const [loc, what] of pressable) await expectClickable(loc, `${what} (${label}, ${s.name} ${s.width}px)`);
    if (dir) await p.screenshot({ path: `${dir.replace(/[\\/]+$/, '')}/${label}-${s.name}.png`, fullPage: true });
  }
  if (original) await p.setViewportSize(original);
}

/** Connect the injected wallet through the site's own Connect button and wallet list. */
export async function connectWallet(p: Page, scope: Page | Locator = p, walletName = TEST_WALLET_NAME): Promise<void> {
  await clickReal(ui.connectButton(scope), 'Connect Solana Wallet');
  const modal = ui.walletModal(p);
  await expect(modal).toBeVisible();
  await clickReal(modal.getByRole('button', { name: new RegExp(walletName) }), `the "${walletName}" row`);
  await expect(modal).toBeHidden({ timeout: 15_000 });
}

/** The address a panel's "Your wallet" row shows once connected. */
export async function expectConnected(scope: Page | Locator, address: string): Promise<void> {
  await expect(scope.getByText(address).first()).toBeVisible({ timeout: 15_000 });
}

/** Press Sign in wallet and wait for the outcome card. Returns its status. */
export async function signAndWait(p: Page, timeout = 120_000): Promise<string> {
  await expect(ui.review(p)).toBeVisible({ timeout: 60_000 });
  await clickReal(ui.signButton(p), 'Sign in wallet');
  const out = ui.outcome(p);
  await expect(out).toBeVisible({ timeout });
  return (await out.getAttribute('data-status')) ?? '';
}

/** Raw token units → the decimal string a person would type (6 decimals). */
export function tokensToInput(raw: bigint, decimals = 6): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
