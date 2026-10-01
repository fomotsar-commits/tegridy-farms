// Every selector the /curve-launch e2e uses, in one place.
//
// They follow set U's components (src/components/solana/curve/*, pages/CurveLaunchDetailPage.tsx):
// Card test ids, the inputs' visible labels, and the buttons' visible words. If U renames
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
  /** Signed and on its way: the wait for the network, with the signature. */
  sent: (p: Page) => p.getByTestId('tx-sent'),
  /** Launches this browser sent before, on the create form. */
  earlierLaunch: (p: Page) => p.getByTestId('earlier-launch'),
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
    // Each field is named by its visible label (WCAG 2.5.3), so these are the words on screen.
    name: (p: Page) => p.getByLabel('Name', { exact: true }),
    symbol: (p: Page) => p.getByLabel('Symbol', { exact: true }),
    picture: (p: Page) => p.getByLabel('Picture', { exact: true }),
    description: (p: Page) => p.getByLabel('Description (optional)', { exact: true }),
    openingBuyToggle: (p: Page) => p.getByLabel(/Your opening buy \(optional\)/),
    openingBuy: (p: Page) => p.getByLabel('Opening buy (SOL)', { exact: true }),
    reviewButton: (p: Page) => p.getByRole('button', { name: 'Review launch' }),
  },
  trade: {
    side: (p: Page, side: 'buy' | 'sell') => ui.tradePanel(p).getByRole('group', { name: 'Buy or sell' }).getByRole('button', { name: side }),
    amount: (p: Page, side: 'buy' | 'sell') =>
      ui.tradePanel(p).getByLabel(side === 'buy' ? 'Spend at most (SOL)' : /^Sell \((tokens|token base units)\)$/),
    reviewButton: (p: Page, side: 'buy' | 'sell') => ui.tradePanel(p).getByRole('button', { name: `Review ${side}` }),
  },
  pool: {
    side: (p: Page, side: 'buy' | 'sell') => ui.poolPanel(p).getByRole('group', { name: 'Buy or sell in the pool' }).getByRole('button', { name: side }),
    amount: (p: Page, side: 'buy' | 'sell') =>
      ui.poolPanel(p).getByLabel(side === 'buy' ? 'Pay (SOL)' : /^Sell \((tokens|token base units)\)$/),
    reviewButton: (p: Page, side: 'buy' | 'sell') => ui.poolPanel(p).getByRole('button', { name: `Review pool ${side}` }),
  },
  /** The LP section on /pools (src/components/solana/lp/*). */
  lp: {
    section: (p: Page) => p.getByTestId('lp-section'),
    disclosure: (p: Page) => p.getByTestId('lp-disclosure'),
    finder: (p: Page) => p.getByTestId('lp-finder'),
    mintInput: (p: Page) => p.getByLabel('Token mint address', { exact: true }),
    findButton: (p: Page) => p.getByRole('button', { name: 'Find pools', exact: true }),
    safety: (p: Page) => p.getByTestId('token-safety'),
    pools: (p: Page) => p.getByTestId('lp-pool'),
    noPools: (p: Page) => p.getByTestId('lp-no-pools'),
    indexNote: (p: Page) => p.getByTestId('lp-index-note'),
    status: (p: Page) => p.getByTestId('lp-status'),
    feeTiers: (p: Page) => p.getByTestId('fee-tier'),
    positions: (p: Page) => p.getByTestId('lp-positions'),
    position: (p: Page) => p.getByTestId('lp-position'),
    // ── stage 2: adding and removing (src/components/solana/lp/*Panel.tsx). Each takes
    // a page, or a pool card / position row to stay inside it.
    addButton: (s: Page | Locator) => s.getByRole('button', { name: 'Add liquidity', exact: true }),
    addPanel: (s: Page | Locator) => s.getByTestId('lp-add-panel'),
    solToAdd: (s: Page | Locator) => s.getByLabel('SOL to add', { exact: true }),
    /** "Tokens to add", or "Tokens to add (base units)" when the token's decimals are unread. */
    tokensToAdd: (s: Page | Locator) => s.getByLabel(/^Tokens to add( \(base units\))?$/),
    maxSol: (s: Page | Locator) => s.getByRole('button', { name: 'Max SOL', exact: true }),
    maxTokens: (s: Page | Locator) => s.getByRole('button', { name: 'Max tokens', exact: true }),
    reviewAdd: (s: Page | Locator) => s.getByRole('button', { name: 'Review: add liquidity', exact: true }),
    removeButton: (s: Page | Locator) => s.getByRole('button', { name: 'Remove liquidity', exact: true }),
    removePanel: (s: Page | Locator) => s.getByTestId('lp-remove-panel'),
    /** 25%, 50%, 75% or All, inside the group "How much to take out". */
    percent: (s: Page | Locator, label: '25%' | '50%' | '75%' | 'All') =>
      s.getByRole('group', { name: 'How much to take out' }).getByRole('button', { name: label, exact: true }),
    otherPercent: (s: Page | Locator) => s.getByLabel('Other percent', { exact: true }),
    reviewRemove: (s: Page | Locator) => s.getByRole('button', { name: 'Review: remove liquidity', exact: true }),
    findOnChain: (s: Page | Locator) => s.getByRole('button', { name: "Find this share's pool on the chain", exact: true }),
    /** The LP note sent from this tab before a reload, not answered yet. */
    pending: (p: Page) => p.getByTestId('lp-pending'),
    /** "Open a new pool" (CreatePoolCard / CreatePoolPanel). Everything after `openButton` is inside the panel. */
    create: {
      card: (p: Page) => p.getByTestId('lp-create'),
      openButton: (p: Page) => p.getByTestId('lp-create').getByRole('button', { name: 'Open a pool', exact: true }),
      panel: (p: Page) => p.getByTestId('lp-create-panel'),
      solToPut: (p: Page) => p.getByTestId('lp-create-panel').getByLabel('SOL to put in', { exact: true }),
      tokensToPut: (p: Page) => p.getByTestId('lp-create-panel').getByLabel(/^Tokens to put in( \(base units\))?$/),
      maxSol: (p: Page) => p.getByTestId('lp-create-panel').getByRole('button', { name: 'Max SOL', exact: true }),
      maxTokens: (p: Page) => p.getByTestId('lp-create-panel').getByRole('button', { name: 'Max tokens', exact: true }),
      match: (p: Page) => p.getByTestId('lp-create-panel').getByTestId('lp-create-match'),
      /** The button under Match (the problems line can carry a second one with the same words, later in the panel). */
      mostBoth: (p: Page) => p.getByTestId('lp-create-panel').getByRole('button', { name: 'Use the most both balances allow', exact: true }).first(),
      review: (p: Page) => p.getByTestId('lp-create-panel').getByRole('button', { name: 'Review: open the pool', exact: true }),
      price: (p: Page) => p.getByTestId('lp-create-panel').getByTestId('lp-create-price'),
      market: (p: Page) => p.getByTestId('lp-create-panel').getByTestId('lp-create-market'),
    },
  },
  graduate: (p: Page) => p.getByRole('button', { name: 'Review: finish graduation' }),
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

/**
 * The LP section's layout rule, at a phone (390), an iPad (820) and a desktop (1280):
 * no sideways page scroll; each of `controls` scrolled to the middle of the screen (as a
 * thumb scrolls, so nothing sticky sits over it) and then on top at its own centre
 * (elementFromPoint); every input in the LP section at least 16px (no zoom on focus);
 * every visible button in it at least 44px tall. Puts the viewport back afterwards.
 */
export async function expectPressableAtSizes(p: Page, label: string, controls: Array<[Locator, string]>): Promise<void> {
  const original = p.viewportSize();
  const heights: Record<number, number> = { 390: 844, 820: 1180, 1280: 900 };
  const section = ui.lp.section(p);
  for (const width of [390, 820, 1280] as const) {
    await p.setViewportSize({ width, height: heights[width] });
    await expectNoSidewaysScroll(p);
    for (const [loc, what] of controls) {
      await expect(loc, `${what} should be visible (${label}, ${width}px)`).toBeVisible();
      await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await expectClickable(loc, `${what} (${label}, ${width}px)`);
    }
    const fields = await section.locator('input').evaluateAll((els) => els.map((e) => ({ n: e.getAttribute('aria-label') ?? e.id, px: parseFloat(getComputedStyle(e).fontSize) })));
    for (const f of fields) expect(f.px, `input "${f.n}" font (${label}, ${width}px)`).toBeGreaterThanOrEqual(16);
    const buttons = await section.locator('button:visible').evaluateAll((els) => els.map((e) => ({ t: (e.textContent ?? '').trim().slice(0, 30), h: e.getBoundingClientRect().height })));
    for (const b of buttons) expect(b.h, `button "${b.t}" height (${label}, ${width}px)`).toBeGreaterThanOrEqual(44);
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
