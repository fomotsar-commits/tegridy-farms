// The venue's pool list, end to end, against the mainnet cp-swap binary on the local
// validator (DESIGN 2.C3). Before a visitor types anything the page lists every pool on
// the venue: the real `/api/pools?all=1` handler runs in process (fixtures/lp.ts
// installPoolIndex), names addresses only, and the browser reads each pool on the chain.
//
// Fixtures are the shapes lp-read.spec.ts makes, built here again from Node: a clean pool
// on fee tier 1 (2 SOL); a squatter on a token's standard tier-1 address at a bad price
// with an open time ten years out (0.01 SOL), beside the real pool at a fresh address
// (3 SOL); a pool of a freezable token on tier 0 (1 SOL). Other specs' pools share the
// validator and may sit between these in the list: what is held is the ORDER of these four
// (deepest first within SOL), that no SOL row follows a USDC or BAYLA row, and that the
// squatter is an ordinary row. A list is not a verdict: the token check and the price
// check run in the finder on the press, which this file follows to the pool's card.
//
// What the validator cannot prove: the dollar lines (Jupiter; USD_LINES ships off, so the
// card carries none, and that absence is pinned here).
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { CP_SWAP_PROGRAM, chain, fundedKeypair, sol } from './fixtures/chain';
import { createClassicToken, createSolPool, installJupiterStub, installPoolIndex, type CreatedPool } from './fixtures/lp';
import { installRpcGuard, type RpcGuard } from './fixtures/rpcGuard';
import { ui, clickReal, expectClickable, expectNoSidewaysScroll } from './fixtures/ui';
import { decodeAmmConfig, deriveAmmConfig } from '../src/lib/solana/cpswap/program';
import { feeRateText, formatSolPrice, shortAddress } from '../src/lib/solana/lp/format';

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);
/** DESIGN 2.C3's ceiling for the list's own reads: the index fetch is not RPC; the pools in two rounds, the safety in one or two. */
const LIST_RPC_CEILING = 12;
/** A phone's first screen (DESIGN 2.C3: the first pool row ends inside it before any scroll). */
const PHONE = { width: 390, height: 844 };
const RANK = { SOL: 0, USDC: 1, BAYLA: 2 } as const;

let creator: Keypair;
let stranger: Keypair;
let clean: PublicKey;
let squatted: PublicKey;
let freezable: PublicKey;
let cleanPool: CreatedPool;
let squatPool: CreatedPool;
let realPool: CreatedPool;
let freezePool: CreatedPool;
/** "1% tier", read from each fee tier's own account on the validator. */
let tier1: string;
let tier0: string;

/** The tier word a row prints, from the chain, never from the page. */
async function tierLabelOf(index: 0 | 1): Promise<string> {
  const address = deriveAmmConfig(CP_SWAP_PROGRAM, index);
  const info = await chain().getAccountInfo(address, 'confirmed');
  const cfg = info && decodeAmmConfig(address.toBase58(), info.data);
  if (!cfg) throw new Error(`fee tier ${index} is not on the validator`);
  return `${feeRateText(cfg.tradeFeeRate)} tier`;
}

test.beforeAll(async () => {
  test.setTimeout(6 * 60_000);
  creator = await fundedKeypair(10);
  stranger = await fundedKeypair(20);
  clean = await createClassicToken(creator, { supply: 10_000_000n * UNIT, name: { name: 'E2E List Clean', symbol: 'ELIST' } });
  cleanPool = await createSolPool(creator, clean, { configIndex: 1, sol: sol(2), tokens: 2_000_000n * UNIT, at: 'standard' });
  squatted = await createClassicToken(stranger, { supply: 10_000_000n * UNIT, name: { name: 'E2E List Squatted', symbol: 'ELSQ' } });
  const slot = await chain().getSlot('confirmed');
  const now = BigInt((await chain().getBlockTime(slot)) ?? Math.floor(Date.now() / 1000));
  squatPool = await createSolPool(stranger, squatted, { configIndex: 1, sol: sol(0.01), tokens: 100n * UNIT, openTime: now + 10n * 365n * 86_400n, at: 'standard' });
  realPool = await createSolPool(stranger, squatted, { configIndex: 1, sol: sol(3), tokens: 3_000_000n * UNIT, at: 'fresh' });
  freezable = await createClassicToken(stranger, { freezable: true, supply: 10_000_000n * UNIT, name: { name: 'E2E List Freezable', symbol: 'ELFRZ' } });
  freezePool = await createSolPool(stranger, freezable, { configIndex: 0, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' });
  [tier1, tier0] = await Promise.all([tierLabelOf(1), tierLabelOf(0)]);
});

interface Actor { ctx: BrowserContext; page: Page; rpc: RpcGuard; jup: { asked: string[] }; index: { calls: string[] } }

/** No wallet: the list is read by anyone. The Jupiter stub knows no token here, and must never be asked. */
async function actor(browser: Browser, o: { indexDown?: boolean; viewport?: { width: number; height: number } } = {}): Promise<Actor> {
  const ctx = await browser.newContext(o.viewport ? { viewport: o.viewport } : {});
  const rpc = await installRpcGuard(ctx);
  const index = await installPoolIndex(ctx, { down: o.indexDown });
  const jup = await installJupiterStub(ctx, new Map());
  const page = await ctx.newPage();
  return { ctx, page, rpc, jup, index };
}

const venueCard = (p: Page) => p.getByTestId('lp-venue-pools');
const rows = (p: Page) => p.getByTestId('lp-venue-pool');
const row = (p: Page, pool: PublicKey) => p.locator(`[data-testid="lp-venue-pool"][data-pool="${pool.toBase58()}"]`);
const poolCard = (p: Page, address: PublicKey) => p.locator(`[data-testid="lp-pool"][data-pool="${address.toBase58()}"]`);
const readAgain = (p: Page) => venueCard(p).getByRole('button', { name: 'Read again', exact: true });

async function openVenue(p: Page, path = '/pools'): Promise<void> {
  await p.goto(path);
  await expect(ui.lp.section(p)).toBeVisible({ timeout: 60_000 });
  await expect(venueCard(p)).toBeVisible({ timeout: 60_000 });
}

test('the fixtures are what they claim, on chain', async () => {
  expect(cleanPool.standard).toBe(true);
  expect(squatPool.standard).toBe(true);
  expect(realPool.standard).toBe(false);
  expect(freezePool.standard).toBe(true);
  const raw = await chain().getAccountInfo(realPool.address, 'confirmed');
  expect(raw?.owner.equals(CP_SWAP_PROGRAM)).toBe(true);
});

test('the real pool index lists the fixture pools grouped by coin and deepest first; the squatter is an ordinary row; no outside price; the list’s own reads fit the budget', async ({ browser }) => {
  const a = await actor(browser);
  const p = a.page;
  await openVenue(p);
  for (const pool of [cleanPool, realPool, squatPool, freezePool]) await expect(row(p, pool.address)).toBeVisible({ timeout: 60_000 });
  // The index was asked the venue question, once, and nothing else was asked of it on load.
  expect(a.index.calls.filter((c) => c === '?all=1')).toHaveLength(1);

  // Every row the page lists, in its order.
  const listed = await rows(p).evaluateAll((els) =>
    els.map((e) => ({ pool: e.getAttribute('data-pool'), quote: e.getAttribute('data-quote'), blocked: e.getAttribute('data-blocked'), text: e.textContent ?? '' })),
  );
  expect(listed.length).toBeGreaterThanOrEqual(4);
  // Grouped by coin: a SOL row never follows a USDC or BAYLA row; a USDC row never follows a BAYLA row.
  const ranks = listed.map((r) => RANK[r.quote as keyof typeof RANK]);
  for (let i = 1; i < ranks.length; i++) expect(ranks[i], `row ${i} (${listed[i]!.pool}) sits in coin order after row ${i - 1}`).toBeGreaterThanOrEqual(ranks[i - 1]!);
  // Deepest first within SOL: 3 SOL (the real pool), 2 SOL, 1 SOL, 0.01 SOL (the squatter).
  const at = (pool: CreatedPool) => listed.findIndex((r) => r.pool === pool.address.toBase58());
  expect(at(realPool)).toBeLessThan(at(cleanPool));
  expect(at(cleanPool)).toBeLessThan(at(freezePool));
  expect(at(freezePool)).toBeLessThan(at(squatPool));

  // Headed by registry: none of these tokens has a room here, so each is its short mint, the tier from the chain, the depth beside it, the origin word under it.
  const cleanRow = row(p, cleanPool.address);
  await expect(cleanRow).toContainText(`${shortAddress(clean.toBase58())} / SOL · ${tier1}`);
  await expect(cleanRow).toContainText('2 SOL');
  await expect(cleanRow).toContainText('standard address');
  // Its price, from its own reserves: 2 SOL over 2,000,000 tokens.
  await expect(cleanRow).toContainText(`1 ${shortAddress(clean.toBase58())} = ${formatSolPrice(2 / 2_000_000)} SOL`);
  await expect(row(p, realPool.address)).toContainText('3 SOL');
  await expect(row(p, realPool.address)).toContainText('own address');
  await expect(row(p, freezePool.address)).toContainText(`${shortAddress(freezable.toBase58())} / SOL · ${tier0}`);
  await expect(row(p, freezePool.address)).toContainText('1 SOL');
  // The squatter is an ordinary row: a list is not a verdict. Its depth is what the chain says; the finder judges it on a press.
  const squat = row(p, squatPool.address);
  await expect(squat).toHaveAttribute('data-blocked', 'false');
  await expect(squat).toContainText('0.01 SOL');
  await expect(squat).not.toContainText(/cannot trade|refused|blocked|earns nothing/);
  // Nothing in a row that belongs on the card: no 32-to-44 character address in any row.
  for (const r of listed) expect(r.text, `row ${r.pool} prints no full address`).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);

  // No outside price was read for the list, for any row.
  expect(a.jup.asked).toEqual([]);
  // The footnote; and no dollar line, since USD_LINES ships off.
  await expect(venueCard(p)).toContainText('Listed from our pool index, then each pool read and checked on the chain. The index can leave a pool out; it cannot add one that is not on the chain.');
  await expect(venueCard(p)).not.toContainText('about $');

  // The budget, measured on the list's own Read again: the page's first load also carries the finder's and the fee tiers' reads.
  await expect(readAgain(p)).toHaveAttribute('aria-disabled', 'false');
  const indexCallsBefore = a.index.calls.length;
  a.rpc.view('list');
  await clickReal(readAgain(p), 'Read again');
  await expect.poll(() => a.index.calls.length, { timeout: 30_000 }).toBeGreaterThan(indexCallsBefore);
  await expect(venueCard(p).getByTestId('lp-venue-reading')).toHaveCount(0, { timeout: 60_000 });
  await expect(venueCard(p).getByTestId('lp-read-at-text')).toHaveText('Read just now');
  expect(a.rpc.count('list'), `the list's own reads: ${a.rpc.calls.filter((c) => c.view === 'list').map((c) => c.method).join(', ')}`).toBeLessThanOrEqual(LIST_RPC_CEILING);
  // Ten seconds between presses, said on the button.
  await expect(venueCard(p).getByRole('button', { name: /^Read again in \d+ s$/ })).toBeVisible();
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('with the pool index down, the card says the venue’s pools could not be listed, never that there are none, with a Read again', async ({ browser }) => {
  const a = await actor(browser, { indexDown: true });
  const p = a.page;
  await openVenue(p);
  const unread = venueCard(p).getByTestId('lp-venue-unread');
  await expect(unread).toBeVisible({ timeout: 60_000 });
  await expect(unread).toContainText('The venue’s pools could not be listed (the pool index answered HTTP 502). That says nothing about how many there are.');
  await expect(venueCard(p)).not.toContainText('No pool is open');
  await expect(rows(p)).toHaveCount(0);
  await expectClickable(readAgain(p), 'Read again');
  // The finder keeps working with the index down (lp-read.spec.ts holds that path): nothing here signed or scanned.
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('a press on a row lands on that pool’s card, its heading focused, with no form open', async ({ browser }) => {
  const a = await actor(browser);
  const p = a.page;
  await openVenue(p);
  const r = row(p, cleanPool.address);
  await expect(r).toBeVisible({ timeout: 60_000 });
  const button = r.getByRole('button');
  await expect(button).toHaveAccessibleName(`Open the ${shortAddress(clean.toBase58())} / SOL pool, ${tier1}, 2 SOL deep, at ${shortAddress(cleanPool.address.toBase58())}`);
  await clickReal(button, 'the clean pool’s row');
  // The finder looked the token up with its checks, and ended on the pool's card.
  await expect(ui.lp.safety(p)).toBeVisible({ timeout: 60_000 });
  await expect(ui.lp.safety(p)).toContainText(clean.toBase58());
  const card = poolCard(p, cleanPool.address);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('heading').first()).toBeFocused();
  await expect(ui.lp.addPanel(p)).toHaveCount(0);
  await expect(ui.lp.create.panel(p)).toHaveCount(0);
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});

test('at 390x844 on /solana-lp the first pool row ends inside the first screen before any scroll, and is one 56px press', async ({ browser }) => {
  const a = await actor(browser, { viewport: PHONE });
  const p = a.page;
  await openVenue(p, '/solana-lp');
  const first = rows(p).first();
  await expect(first).toBeVisible({ timeout: 60_000 });
  expect(await p.evaluate(() => window.scrollY), 'nothing scrolled the page').toBe(0);
  const box = await first.boundingBox();
  expect(box, 'the first row has a box').not.toBeNull();
  expect(box!.y + box!.height, `the first pool row ends at ${box!.y + box!.height}px, inside the ${PHONE.height}px screen`).toBeLessThanOrEqual(PHONE.height);
  await expectNoSidewaysScroll(p);
  const button = first.getByRole('button');
  await expectClickable(button, 'the first pool row');
  expect(await button.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(56);
  const dir = process.env.E2E_SHOTS_DIR;
  if (dir) await p.screenshot({ path: `${dir.replace(/[\\/]+$/, '')}/lp-list-${test.info().project.name}-390.png` });
  expect(a.rpc.violations).toEqual([]);
  await a.ctx.close();
});
