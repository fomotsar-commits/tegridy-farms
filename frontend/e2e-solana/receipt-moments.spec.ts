// The receipt card's moment, end to end, at a phone's width (island answers thirty and
// thirty-two, §3: "the e2e at 390"). A real signature on the local validator raises the card,
// the island's engine plays its moment, and the card is read where the moment ends, at rest:
//
//   a buy:  the shore. The ring is struck lit, the shore line is on, and neither leaves.
//   a sale: the shore, never struck. The ember stays and the cooling line is on at once.
//   an add: the pool. The ring and the card hold the pool's light (data-floor="lit"), the
//           floor line is on, the head is in view, and the one green button is Share on X.
//
// Each card is then closed with Back, and the screen-wide canvas its moment drew on must be
// gone from the body with it. The buy and the add run twice, with Reduce Motion off and on:
// the moment plays in both, by a different path through the engine.
//
// The size is 390 by 560, about an iPhone SE in Safari with its bars showing, and shorter than
// every card here (each walk checks that first). A card taller than the screen is where the
// focus trap once scrolled the card's head, where the moment plays, off the top (answer
// thirty-two, §4.3): at 664 high this run's cards fit (they carry no clock line), so a check
// of the head there passed with the fix taken out, and proved nothing.
//
// Every expected word is the app's own constant (RECEIPT_WORDS), so a copy change moves the
// card and this file together. What it checks is the card's STATE, which only the engine
// writes (data-shore, data-floor on the ring), never a class name a rename could keep.
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { RECEIPT_WORDS } from '../src/lib/arrival';
import { fundedKeypair, sol } from './fixtures/chain';
import { createSolPool, createToken2022MetadataOnly, transferTokens, type CreatedPool } from './fixtures/lp';
import { actor, addAndReview, connect, openPools, press, type Actor } from './fixtures/lpPage';
import { ui, clickReal, connectWallet } from './fixtures/ui';

const UNIT = 1_000_000n;
const SYMBOL = 'MOMENT';
/** The pool's own price: 0.00001 SOL a token. */
const POOL_PRICE = 1e-5;
const PHONE = { width: 390, height: 560 };
const MOTIONS = ['no-preference', 'reduce'] as const;
type Motion = (typeof MOTIONS)[number];

let creator: Keypair;
let mint: PublicKey;
let pool: CreatedPool;

const card = (p: Page) => p.getByTestId('receipt-card');
const flameRing = (p: Page) => card(p).getByTestId('flame-ring');
const floorRing = (p: Page) => card(p).getByTestId('floor-ring');
const shoreLine = (p: Page) => card(p).getByTestId('receipt-shore-line');
const floorLine = (p: Page) => card(p).getByTestId('receipt-floor-line');
/** Every canvas a moment puts on the body, outside the card: the shore's fire and the pool's fx. */
const bodyCanvases = (p: Page) => p.locator('body > canvas.receipt-fx, body > canvas.receipt-floor-fx');

/**
 * The moment's last beat lands about five seconds after the card is raised (the shore's at
 * ~4.9 s, the pool's at ~5.8 s, measured on the island's timelines). Read the card after
 * that, so "at rest" means after every beat, not only after the landing.
 */
const AFTER_THE_BEATS_MS = 3_000;

/** One person on a phone, with Reduce Motion as given. Jupiter quotes the token at `jupiterPrice` SOL. */
async function person(browser: Browser, kp: Keypair, motion: Motion, jupiterPrice = POOL_PRICE * 1.2): Promise<Actor> {
  const a = await actor(browser, kp, { prices: new Map([[mint.toBase58(), { solPerToken: jupiterPrice, decimals: 6 }]]) });
  // The token search the swap page uses to learn an unknown mint's decimals and ticker.
  await a.ctx.route('**/api/jupiter/tokens/v2/search?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: mint.toBase58(), symbol: SYMBOL, name: 'Moment Test', decimals: 6, isVerified: true, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }]),
    }),
  );
  await a.page.setViewportSize(PHONE);
  await a.page.emulateMedia({ reducedMotion: motion });
  return a;
}

/** Sign what is on review, and wait for the card to rise over the page. */
async function signAndRaise(a: Actor): Promise<void> {
  const p = a.page;
  await expect(ui.review(p)).toBeVisible({ timeout: 60_000 });
  await clickReal(ui.signButton(p), 'Sign in wallet');
  await expect.poll(() => a.wallet.signed().length, { timeout: 90_000 }).toBe(1);
  await expect(card(p)).toBeVisible({ timeout: 90_000 });
}

/**
 * The card's top, where its head and the moment are, is on the screen. First, that the card
 * really is taller than the screen (its layer scrolls): on a card that fits, nothing could
 * scroll its head away and this would pass whatever the page did. With the card's put-back
 * (ReceiptCard.tsx, `scrollTop = 0` at the rise) taken out, an add's card read -16 here and both
 * add walks failed; a buy's and a sale's card stayed on the screen without it in this browser,
 * so on those this guards what a person sees, not that line.
 */
async function headOnScreen(p: Page): Promise<void> {
  const layer = await p.getByTestId('receipt-layer').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(layer.scroll, `the card fits the ${PHONE.height} px screen, so this proves nothing`).toBeGreaterThan(layer.client);
  const box = await card(p).boundingBox();
  expect(box, 'the card has a box').not.toBeNull();
  expect(box!.y, 'the top of the card, its head, is on the screen').toBeGreaterThanOrEqual(0);
}

/** Back to the room: the card goes, and so does every canvas its moment put on the body. */
async function back(p: Page): Promise<void> {
  await clickReal(card(p).getByTestId('receipt-back'), 'Back to the room');
  await expect(p.getByTestId('receipt-layer')).toHaveCount(0);
  await expect(bodyCanvases(p), 'a canvas the moment drew on is left on the body').toHaveCount(0);
}

/** A swap on /solana in our own pool, signed, up to the card. */
async function swapToCard(a: Actor, query: string, amountLabel: string, amount: string, button: string): Promise<void> {
  const p = a.page;
  await p.goto(`/solana?${query}`);
  await expect(p.getByRole('heading', { name: 'Solana Swap' })).toBeVisible({ timeout: 60_000 });
  await connectWallet(p);
  await p.getByLabel(amountLabel).fill(amount);
  await expect(p.getByTestId('solana-route-line')).toContainText('Our pool pays', { timeout: 60_000 });
  await press(p.getByRole('button', { name: button, exact: true }), button);
  await signAndRaise(a);
}

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  creator = await fundedKeypair(40);
  mint = await createToken2022MetadataOnly(creator, { name: 'Moment Test', symbol: SYMBOL, supply: 10_000_000n * UNIT });
  pool = await createSolPool(creator, mint, { configIndex: 1, sol: sol(10), tokens: 1_000_000n * UNIT, at: 'standard', tokenProgram: TOKEN_2022_PROGRAM_ID });
  expect(pool.standard).toBe(true);
});

for (const motion of MOTIONS) {
  test(`a buy at 390, Reduce Motion ${motion}: the shore. The ring is struck lit, the shore line lands and stays, and Back takes the fire's canvas with it`, async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await person(browser, await fundedKeypair(3), motion);
    const p = a.page;
    await swapToCard(a, `out=${mint.toBase58()}`, 'Amount of SOL to pay', '0.05', `Buy ${SYMBOL}`);

    // A buy's head is the shore: the flame ring, never the pool.
    await expect(card(p)).toHaveAttribute('data-flame', 'catching');
    await expect(card(p)).not.toHaveAttribute('data-floor', /.*/);
    await expect(card(p).getByTestId('floor-head')).toHaveCount(0);
    await expect(floorLine(p)).toHaveCount(0);

    // The strike lights the ring; the light lands and the line comes on.
    await expect(flameRing(p)).toHaveAttribute('data-shore', 'lit', { timeout: 15_000 });
    await expect(shoreLine(p)).toHaveText(RECEIPT_WORDS.shore(SYMBOL), { timeout: 15_000 });

    // At rest, after the beats: still lit, the line still on, the share button the island's card.
    await p.waitForTimeout(AFTER_THE_BEATS_MS);
    await expect(flameRing(p)).toHaveAttribute('data-shore', 'lit');
    await expect(shoreLine(p)).toHaveText(RECEIPT_WORDS.shore(SYMBOL));
    await expect(card(p).getByTestId('receipt-share')).toHaveText(RECEIPT_WORDS.share);
    await expect(card(p).getByTestId('receipt-title')).toHaveText(new RegExp(`^Bought (.+ )?${SYMBOL}$`));
    await headOnScreen(p);

    await back(p);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });
}

test('a sale at 390: the shore, never struck. The ember stays in the ring and the cooling line is on at once', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const me = await fundedKeypair(3);
  await transferTokens(creator, me.publicKey, mint, 20_000n * UNIT);
  // Jupiter pays 20% less SOL than our pool, so the sale is ours.
  const a = await person(browser, me, 'no-preference', POOL_PRICE * 0.8);
  const p = a.page;
  await swapToCard(a, `in=${mint.toBase58()}&out=So11111111111111111111111111111111111111112`, `Amount of ${SYMBOL} to pay`, '2000', `Sell ${SYMBOL}`);

  await expect(card(p)).toHaveAttribute('data-flame', 'ember');
  await expect(card(p).getByTestId('floor-head')).toHaveCount(0);
  // The cooling line needs no landing: it is on as the card rises.
  await expect(shoreLine(p)).toHaveText(RECEIPT_WORDS.shoreCooling, { timeout: 5_000 });

  // Past the moment a buy's strike would have come, and its beats: never struck.
  await p.waitForTimeout(AFTER_THE_BEATS_MS + 3_000);
  await expect(flameRing(p)).toHaveAttribute('data-flame', 'ember');
  await expect(flameRing(p)).not.toHaveAttribute('data-shore', /.*/);
  await expect(shoreLine(p)).toHaveText(RECEIPT_WORDS.shoreCooling);
  await expect(card(p).getByTestId('receipt-title')).toHaveText(new RegExp(`^Sold (.+ )?${SYMBOL}$`));
  await headOnScreen(p);

  await back(p);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

for (const motion of MOTIONS) {
  test(`an add at 390, Reduce Motion ${motion}: the pool. The ring and the card hold its light, the floor line is on, the head is in view, Share on X names the coin's link`, async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const me = await fundedKeypair(5);
    await transferTokens(creator, me.publicKey, mint, 100_000n * UNIT);
    const a = await person(browser, me, motion);
    const p = a.page;
    await openPools(p, mint);
    await connect(p);
    const { panel } = await addAndReview(a, pool.address, '0.2');
    await press(ui.lp.reviewAdd(panel), 'Review: add liquidity');
    await signAndRaise(a);

    // An add's head is the pool: never the flame ring, never the shore line.
    await expect(card(p).getByTestId('floor-head')).toBeVisible();
    await expect(card(p)).not.toHaveAttribute('data-flame', /.*/);
    await expect(card(p).getByTestId('flame-ring')).toHaveCount(0);
    await expect(card(p).getByTestId('receipt-shore-slot')).toHaveCount(0);

    // The flash lights the ring and the card's edge; the brick lands and the line comes on.
    await expect(floorRing(p)).toHaveAttribute('data-floor', 'lit', { timeout: 15_000 });
    await expect(card(p)).toHaveAttribute('data-floor', 'lit');
    await expect(floorLine(p)).toHaveAttribute('data-on', '1', { timeout: 15_000 });

    // At rest, after the beats.
    await p.waitForTimeout(AFTER_THE_BEATS_MS);
    await expect(floorRing(p)).toHaveAttribute('data-floor', 'lit');
    await expect(card(p)).toHaveAttribute('data-floor', 'lit');
    await expect(floorLine(p)).toHaveAttribute('data-on', '1');
    await expect(floorLine(p)).toHaveText(RECEIPT_WORDS.floor(SYMBOL));
    await headOnScreen(p);
    // The one green button: Share on X, the post written, the link naming this coin's mint (no room).
    const share = card(p).getByTestId('receipt-share');
    await expect(share).toHaveText(RECEIPT_WORDS.shareX);
    await expect(share).toHaveAttribute('href', RECEIPT_WORDS.lpIntent(SYMBOL, mint.toBase58()));
    await expect(card(p).getByTestId('receipt-title')).toHaveText(new RegExp(`^Added (.+ )?SOL \\+ (.+ )?${SYMBOL}$`));

    await back(p);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });
}
