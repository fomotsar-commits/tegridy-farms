// "Open a pool" on /pools, end to end, against the mainnet cp-swap binary on the local
// validator (SPEC_S2_CREATE 5.5, P1-P19). Fee tier 1 is seeded with mainnet's own bytes
// (CapqvAA9…, byte-checked by global-setup.ts before any spec runs).
//
// As in lp-write.spec.ts, the page is the thing under test: what the review should say is
// worked out HERE from fresh reads (the tier, live rents, isqrt of the typed amounts, the
// stub's market price worked out the way the page works it out), what was signed is read
// from the test wallet's records (its guard decoded the exact bytes), and what moved is read
// from the chain afterwards. Every button pressed is checked with elementFromPoint, and
// every scenario ends with the RPC guard's violations empty.
//
// Group A runs on chromium AND mobile-chrome against one chain, so each project makes its
// own tokens in its own beforeAll. Group B is chromium only.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from '@solana/spl-token';
import {
  WSOL, accountDataLength, accountOwner, ata, chain, fundedKeypair, lamportDelta, lamports, landedTx, poolFacts, poolsFor, sol, tokenAmount, txAccountKeys,
  wrapSol, CP_SWAP_PROGRAM,
} from './fixtures/chain';
import {
  CREATE_POOL_FEE_RECEIVER, createClassicToken, createSolPool, createToken2022MetadataOnly, createTransferHookToken, freshPricedToken, squatStandard,
  transferTokens, type CreatedPool, type JupiterStub,
} from './fixtures/lp';
import {
  actor, closeAll, connect, ensureConnected, openPools, openRemove, pendingNotes, poolCard, positionRow, press, pressable, reviewDeposit, reviewRows,
  signConfirmed, signedSol, solExact, SOL, tok, units, withdrawPlan, openAdd, type Actor, type Prices,
} from './fixtures/lpPage';
import { ui, expectPressableAtSizes, tokensToInput } from './fixtures/ui';
import { formatSol, parseDecimalToBaseUnits } from '../src/lib/launcher/solana/curve/format';
import { initializeIx } from '../src/lib/solana/cpswap/ix';
import {
  AMM_CONFIG_OFFSETS, decodeAmmConfig, deriveAmmConfig, deriveLpMint, derivePool, deriveVault, publicTierConfig, sortMints, type AmmConfigView,
} from '../src/lib/solana/cpswap/program';
import { CREATOR_FEE_SWITCH, feeSplit } from '../src/lib/solana/cpswap/venue';
import { formatSolPrice, tradeCostText } from '../src/lib/solana/lp/format';
import { feeReserveFor, isqrt, planCreate, spendableSol } from '../src/lib/solana/lp/liquidityMath';
import { arbitrageLoss, matchMarket, openingSolPerToken } from '../src/lib/solana/lp/opening';

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);
/** Every priced token is quoted at 1 SOL per million tokens unless said. */
const FAIR = 1e-6;
const TEN_YEARS = 10 * 365 * 86_400;
/** The locked shares, as the page writes them (shares show in 9 decimals; see panelKit.ts LOCKED_SHARES_TEXT). */
const LOCKED_SHARES = '0.0000001 pool shares (100 of the smallest unit)';
const MONEY = 'Jupiter does not send trades to our pools';
const TIER1 = publicTierConfig(CP_SWAP_PROGRAM);

/** A price book a fixture can register a fresh token in before any browser exists. */
const bookOf = (prices: Prices): Pick<JupiterStub, 'setPrice'> => ({
  setPrice: (mint, solPerToken, decimals) => void prices.set(mint, { solPerToken, decimals: decimals ?? DEC }),
});

// ── what the page works out, worked out here ───────────────────────────────────

const PROBE_LAMPORTS = 50_000_000;
/**
 * The market price the page reads from the Jupiter stub: the stub's two quotes
 * (fixtures/lp.ts installJupiterStub: a buy of 0.05 SOL, then the sale back, each less
 * 0.5%), turned into a price the way lib/solana/lp/outsidePrice.ts readOutsidePrice does.
 */
function stubMarket(solPerToken: number, decimals = DEC): number {
  const fee = 0.995;
  const tokensOut = Math.floor((PROBE_LAMPORTS / 1e9 / solPerToken) * 10 ** decimals * fee);
  const lamportsBack = Math.floor((tokensOut / 10 ** decimals) * solPerToken * 1e9 * fee);
  const tokens = tokensOut / 10 ** decimals;
  const buy = PROBE_LAMPORTS / LAMPORTS_PER_SOL / tokens;
  const sell = lamportsBack / LAMPORTS_PER_SOL / tokens;
  return Math.sqrt(buy * sell);
}

async function tierView(index: 0 | 1): Promise<AmmConfigView> {
  const address = deriveAmmConfig(CP_SWAP_PROGRAM, index);
  const a = await chain().getAccountInfo(address, 'confirmed');
  const v = a ? decodeAmmConfig(address.toBase58(), a.data) : null;
  if (!v) throw new Error(`fee tier ${index} is not on the validator`);
  return v;
}
const tierText = (c: AmmConfigView) =>
  // A pool this site opens goes through `initialize`, which switches its creator fee off.
  `${c.index}: traders pay ${tradeCostText(c, CREATOR_FEE_SWITCH.publicOpen)}; LPs keep ${feeSplit(c).lpKeepsPct.toFixed(3)}% of each trade`;

interface Rents { r0: bigint; r165: bigint; neverRefunded: bigint }
/** Live rents: the pool (637), its price record (4075), its share mint (82) and its two 165-byte vaults never come back. */
async function liveRents(): Promise<Rents> {
  const [r0, r82, r165, r637, r4075] = (await Promise.all([0, 82, 165, 637, 4075].map((n) => chain().getMinimumBalanceForRentExemption(n)))).map(BigInt) as [bigint, bigint, bigint, bigint, bigint];
  return { r0, r165, neverRefunded: r637 + r4075 + r82 + r165 + r165 };
}

const standardOf = (mint: PublicKey) => {
  const { token0, token1 } = sortMints(WSOL, mint);
  return derivePool(CP_SWAP_PROGRAM, TIER1, token0, token1);
};

/** The opening the review should show, from the typed amounts and fresh reads. */
async function expectedOpening(mint: PublicKey, solIn: bigint, tokenIn: bigint, decimals = DEC) {
  const { token0 } = sortMints(WSOL, mint);
  const plan = planCreate({ quoteIsToken0: token0.equals(WSOL), sol: solIn, token: tokenIn, availableSol: null, availableToken: null });
  if ('problem' in plan) throw new Error(`opening plan: ${plan.problem}`);
  expect(plan.supply).toBe(isqrt(solIn * tokenIn));
  expect(plan.lp).toBe(plan.supply - 100n);
  return { plan, tier: await tierView(1), rents: await liveRents(), decimals };
}

/** Every 4.4 row, checked against Node's numbers. Returns the pool address the review names. */
async function checkCreateReview(
  p: Page,
  rows: Record<string, string>,
  o: { mint: PublicKey; sol: bigint; token: bigint; origin: 'standard' | 'other'; market: number; decimals?: number },
): Promise<PublicKey> {
  const d = o.decimals ?? DEC;
  const { plan, tier, rents } = await expectedOpening(o.mint, o.sol, o.token, d);
  const pool = new PublicKey(rows['Pool']!);
  if (o.origin === 'standard') {
    expect(pool.equals(standardOf(o.mint)), 'the standard tier-1 address').toBe(true);
    expect(rows['Pool kind']).toBe('Standard address for fee tier 1');
  } else {
    expect(pool.equals(standardOf(o.mint)), 'not the standard address').toBe(false);
    expect(rows['Pool kind']).toBe('Its own address: the standard address is taken, so this pool gets a new address made in this browser');
    await expect(ui.review(p)).toContainText("Your wallet will show that this transaction needs a second signature. That is the new pool's own address: this page signs it after you, then forgets the key.");
  }
  expect(rows['Token (mint)']).toBe(o.mint.toBase58());
  expect(rows['Fee tier']).toBe(tierText(tier));
  expect(rows['You put in']).toBe(`${solExact(o.sol)} and ${units(o.token, d)} tokens, exactly`);
  expect(rows['Opening price']).toMatch(
    new RegExp(`^${esc(`1 token = ${formatSolPrice(openingSolPerToken(o.sol, o.token, d)!)} SOL. Market (Jupiter, read just now): ${formatSolPrice(o.market)} SOL, `)}\\d+\\.\\d% (above|below)$`),
  );
  expect(rows['Opens for trading']).toBe('At once (one second after it lands)');
  expect(rows['Fee to open the pool']).toBe(`${solExact(tier.createPoolFee)}, paid to the team's vault (into ${CREATE_POOL_FEE_RECEIVER.toBase58()}, the account the pool program fixes); not refundable`);
  expect(rows['Account deposits that never come back']).toBe(`${solExact(rents.neverRefunded)} (the pool, its price record, its share token and its two vaults; none can be closed)`);
  expect(rows['Your pool-share account']).toBe(`${solExact(rents.r165)} (it comes back if you close that account later)`);
  expect(rows['You get']).toBe(`${units(plan.lp, 9)} pool shares, exactly`);
  expect(rows['Locked in the pool forever']).toBe(`${LOCKED_SHARES}, worth about ${SOL(plan.locked.sol)} and ${tok(plan.locked.token, d)} tokens at these amounts`);
  const share = Number((plan.lp * 1_000_000n) / plan.supply) / 10_000;
  expect(rows['Your share of the pool']).toBe(share < 0.01 ? '<0.01%' : `${share.toFixed(2)}%`);
  expect(rows["Test run: the team's vault account gains, in SOL (the fee, plus any SOL that account was already holding)"]).toBe(`+${tok(tier.createPoolFee, 9)}`);
  await expect(ui.review(p).getByTestId('lp-review-disclosure')).toContainText(MONEY);
  return pool;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── the create card and panel ──────────────────────────────────────────────────

const createCard = (p: Page) => ui.lp.create.card(p);

/** The card says `offer`; open the panel and wait for the wallet's balances (Max SOL). */
async function openCreate(p: Page): Promise<Locator> {
  await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
  await press(ui.lp.create.openButton(p), 'Open a pool');
  const panel = ui.lp.create.panel(p);
  await expect(panel).toBeVisible();
  await expect(ui.lp.create.maxSol(p)).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Type `solText` SOL, press Match the market price, and read back the token box the page set. */
async function solThenMatch(p: Page, solText: string, decimals = DEC): Promise<{ sol: bigint; token: bigint }> {
  await ui.lp.create.solToPut(p).fill(solText);
  await press(ui.lp.create.match(p), 'Match the market price');
  await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'agrees');
  await expect(ui.lp.create.tokensToPut(p)).not.toHaveValue('');
  const solIn = parseDecimalToBaseUnits(solText, 9)!;
  const token = parseDecimalToBaseUnits(await ui.lp.create.tokensToPut(p).inputValue(), decimals)!;
  return { sol: solIn, token };
}

async function reviewCreate(p: Page): Promise<Record<string, string>> {
  await expect(ui.lp.create.review(p)).toBeEnabled({ timeout: 30_000 });
  await press(ui.lp.create.review(p), 'Review: open the pool');
  return reviewRows(p);
}

/** Read again until the pool is open by the WALL clock (the browser quotes on its own clock; see chain.ts waitForPoolOpenByWallClock). */
async function waitPoolOpen(pool: PublicKey, maxMs = 5 * 60_000): Promise<void> {
  const open = Number((await poolFacts(pool)).pool.openTime);
  const waitMs = Math.max(0, (open + 2) * 1000 - Date.now());
  if (waitMs > maxMs) throw new Error(`the pool opens ${Math.round(waitMs / 1000)} s from now by the wall clock: the validator clock has drifted too far, restart it`);
  await new Promise((r) => setTimeout(r, waitMs));
}

/** What a pool opened by the site holds, read in Node. */
async function checkOpenedPool(o: {
  pool: PublicKey; mint: PublicKey; owner: PublicKey; sol: bigint; token: bigint; tokenProgram?: PublicKey;
  signature: string; feeBefore: bigint; tokenBefore: bigint; fee: bigint;
}): Promise<void> {
  const f = await poolFacts(o.pool);
  const supply = isqrt(o.sol * o.token);
  expect(f.pool.ammConfig, 'the pool is on fee tier 1').toBe(TIER1.toBase58());
  expect(f.pool.lpSupply).toBe(supply);
  const t = await landedTx(o.signature);
  expect(Number(f.pool.openTime) <= (t.blockTime ?? 0) + 1, `open_time ${f.pool.openTime} ≤ landing ${t.blockTime} + 1`).toBe(true);
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const solVault = deriveVault(CP_SWAP_PROGRAM, o.pool, WSOL);
  const tokenVault = deriveVault(CP_SWAP_PROGRAM, o.pool, o.mint);
  expect(await tokenAmount(solVault)).toBe(o.sol);
  expect(await tokenAmount(tokenVault)).toBe(o.token);
  expect(await accountDataLength(solVault)).toBe(165);
  expect(await accountDataLength(tokenVault)).toBe(165);
  expect(await accountOwner(solVault)).toEqual(TOKEN_PROGRAM_ID);
  expect(await accountOwner(tokenVault)).toEqual(tokenProgram);
  const lpAccount = ata(deriveLpMint(CP_SWAP_PROGRAM, o.pool), o.owner);
  expect(await accountOwner(lpAccount), 'the pool-share account is classic').toEqual(TOKEN_PROGRAM_ID);
  expect(await tokenAmount(lpAccount)).toBe(supply - 100n);
  expect(o.tokenBefore - ((await tokenAmount(ata(o.mint, o.owner, tokenProgram))) ?? 0n), 'the tokens left by exactly the typed amount').toBe(o.token);
  expect((await tokenAmount(CREATE_POOL_FEE_RECEIVER))! - o.feeBefore, 'the fee account received exactly the fee').toBe(o.fee);
}

/**
 * The opener's SOL change, worked out in Node from fresh reads (SPEC_S2_CREATE 3.3, 5.5):
 * what went in, tier 1's fee, the pool's never-refunded deposits, the pool-share account's
 * rent and the landed network fee. A wrapped-SOL account the opening makes is closed in
 * the same transaction, and one the wallet already held ends as it began, so neither
 * moves SOL. Not the review's own test-run line: that comes from the same simulation the
 * page shows, so a change that took more SOL would show on both sides.
 */
async function checkOpenerSol(t: Awaited<ReturnType<typeof landedTx>>, owner: PublicKey, solIn: bigint, emptyWsolClosed = 0n): Promise<void> {
  const [tier, rents] = await Promise.all([tierView(1), liveRents()]);
  const networkFee = BigInt(t.meta!.fee);
  // `emptyWsolClosed`: the lamports of a wrapped-SOL account the opener already had,
  // empty, before the opening. The opening closes it (wsol.ts) and those come back.
  expect(lamportDelta(t, owner), "the opener's SOL change, worked out in Node").toBe(
    -(solIn + tier.createPoolFee + rents.neverRefunded + rents.r165 + networkFee) + emptyWsolClosed,
  );
}

/** What the wallet signed for an opening: one initialize, open_time 0, the fee account and tier 1 in their slots. */
function checkSignedOpening(a: Actor, pool: PublicKey, origin: 'standard' | 'co-signer') {
  const opens = a.wallet.lastSigned().instructions.filter((i) => i.program === 'cp-swap');
  expect(opens.map((i) => i.name)).toEqual(['initialize']);
  const init = opens[0]!;
  expect(init.args.openTime).toBe('0');
  expect(init.args.origin).toBe(origin);
  expect(init.accounts.create_pool_fee).toBe('2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa');
  expect(init.accounts.amm_config).toBe(TIER1.toBase58());
  expect(init.accounts.pool_state).toBe(pool.toBase58());
  return init;
}

// ── secrets in storage ─────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fromBase58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
/** Where, if anywhere, a stored value holds a 64-byte secret key whose public half is `pool`. */
function secretFor(values: string[], pool: PublicKey): string | null {
  const pk = Buffer.from(pool.toBytes());
  const isIt = (b: Uint8Array) => b.length === 64 && Buffer.from(b.subarray(32)).equals(pk);
  for (const v of values) {
    for (const m of v.matchAll(/\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/g)) if (isIt(Uint8Array.from(JSON.parse(m[0]) as number[]))) return 'a number array';
    for (const m of v.matchAll(/[0-9a-fA-F]{128}/g)) if (isIt(Buffer.from(m[0], 'hex'))) return 'hex';
    for (const m of v.matchAll(/[A-Za-z0-9+/_-]{85,88}={0,2}/g)) if (isIt(Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64'))) return 'base64';
    for (const m of v.matchAll(/[1-9A-HJ-NP-Za-km-z]{80,90}/g)) if (isIt(fromBase58(m[0]))) return 'base58';
  }
  return null;
}
const storageValues = (p: Page) =>
  p.evaluate(() => {
    const out: string[] = [];
    for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) { const k = s.key(i)!; out.push(k, s.getItem(k) ?? ''); }
    return out;
  });

// ════════════════════════════════════════════════════════════════════════════
// GROUP A: chromium AND mobile-chrome. Each project mints its own tokens.
// ════════════════════════════════════════════════════════════════════════════

const A = {} as { prices: Prices; opener: Keypair; t1: PublicKey; creator: Keypair; t2: PublicKey; t3: PublicKey; ta: PublicKey; poolA: CreatedPool };

test.describe('group A (chromium and mobile-chrome)', () => {
  test.beforeAll(async () => {
    test.setTimeout(8 * 60_000);
    A.prices = new Map();
    const book = bookOf(A.prices);
    [A.opener, A.creator] = await Promise.all([fundedKeypair(10), fundedKeypair(30)]);
    await Promise.all([
      (async () => { A.t1 = await freshPricedToken(A.opener, book); })(),
      (async () => {
        A.t2 = await freshPricedToken(A.creator, book);
        A.t3 = await freshPricedToken(A.creator, book);
      })(),
      (async () => {
        // Another token with a passing tier-1 pool, where the creator holds a share.
        A.ta = await freshPricedToken(A.creator, book);
        A.poolA = await createSolPool(A.creator, A.ta, { configIndex: 1, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' });
      })(),
    ]);
  });

  test('P1: opening on fee tier 1 at the standard address: the card offers, Match sets the market, the review is the opening, and the chain holds exactly that', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    expect(TIER1.toBase58(), 'tier 1 derives to mainnet\'s address').toBe('CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy');
    const a = await actor(browser, A.opener, { prices: A.prices });
    const p = a.page;
    await openPools(p, A.t1);
    await connect(p);
    const tier = await tierView(1);
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(createCard(p)).toContainText(
      `No pool for this token yet. You can open the first one on the public fee tier: ${tradeCostText(tier, CREATOR_FEE_SWITCH.publicOpen)}, ${formatSol(tier.createPoolFee, 9)} SOL to open (read just now).`,
    );
    await expect(createCard(p)).toContainText(MONEY);
    await openCreate(p);
    const market = stubMarket(FAIR);
    const { sol: solIn, token } = await solThenMatch(p, '1');
    expect(token, 'the token box is matchMarket at the page\'s market price').toBe(matchMarket({ keep: 'sol', amount: solIn, solPerToken: market, tokenDecimals: DEC }));
    await expect(ui.lp.create.panel(p)).toContainText(LOCKED_SHARES);
    await expect(ui.lp.create.panel(p)).toContainText(MONEY);
    await expectPressableAtSizes(p, 'P1 panel', [
      [ui.lp.create.openButton(p), 'Open a pool'],
      [ui.lp.create.match(p), 'Match the market price'],
      [ui.lp.create.maxSol(p), 'Max SOL'],
      [ui.lp.create.review(p), 'Review: open the pool'],
    ]);

    const rows = await reviewCreate(p);
    const pool = await checkCreateReview(p, rows, { mint: A.t1, sol: solIn, token, origin: 'standard', market });
    await expectPressableAtSizes(p, 'P1 review', [[ui.signButton(p), 'Sign in wallet']]);
    const testRunSol = rows['Test run: your SOL changes by'];
    const feeBefore = (await tokenAmount(CREATE_POOL_FEE_RECEIVER))!;
    const tokenBefore = (await tokenAmount(ata(A.t1, A.opener.publicKey)))!;
    expect(await tokenAmount(ata(WSOL, A.opener.publicKey)), 'no wrapped-SOL account before').toBeNull();

    const { signature, t } = await signConfirmed(a);
    await expect(ui.lp.create.panel(p)).toContainText(`Your pool is open at ${pool.toBase58()}. Swaps can start one second after it landed.`);
    checkSignedOpening(a, pool, 'standard');
    await checkOpenedPool({ pool, mint: A.t1, owner: A.opener.publicKey, sol: solIn, token, signature, feeBefore, tokenBefore, fee: tier.createPoolFee });
    expect(signedSol(lamportDelta(t, A.opener.publicKey)), 'the SOL change is the test run line').toBe(testRunSol);
    await checkOpenerSol(t, A.opener.publicKey, solIn);
    expect(await accountOwner(ata(WSOL, A.opener.publicKey)), 'no wrapped-SOL account left').toBeNull();

    // The outcome's Close goes back to the panel's form. The amounts it opened with are
    // gone, so a stray press of Review opens nothing: no second pool by accident. The card
    // points to the pool just opened and still offers another, which is the opener's
    // choice (owner ruling 2026-10-03; P16 opens one).
    await press(ui.outcome(p).getByRole('button', { name: 'Close' }), 'close the outcome');
    await expect(createCard(p)).toHaveAttribute('data-advice', 'opened-here', { timeout: 60_000 });
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer');
    await expect(ui.lp.create.solToPut(p)).toHaveValue('');
    await expect(ui.lp.create.review(p)).toBeDisabled();
    await expect(ui.lp.create.panel(p)).toContainText('You opened a pool for this token just now. Opening again makes a second, separate pool and pays the fee to open again.');
    expect(a.wallet.signed()).toHaveLength(1);
    await closeAll(p, ui.lp.create.panel(p));
    await expect(poolCard(p, pool)).toContainText("You opened this pool just now. Your share is under 'Your positions'.", { timeout: 60_000 });
    await expect(createCard(p)).toHaveAttribute('data-advice', 'opened-here', { timeout: 60_000 });
    await expect(createCard(p)).toContainText(pool.toBase58());
    await expect(createCard(p)).toContainText('You can still open another on the public fee tier');
    await expect(ui.lp.create.openButton(p)).toHaveCount(1);
    await expect(positionRow(p, pool)).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P2: a reload while an opening is unconfirmed never makes a second pool: Create is held on every token, Add and Remove are not, and Check again settles it', async ({ browser }) => {
    test.setTimeout(12 * 60_000);
    const a = await actor(browser, A.creator, { prices: A.prices });
    const p = a.page;
    await openPools(p, A.t2);
    await connect(p);
    await openCreate(p);
    const { sol: solIn, token } = await solThenMatch(p, '0.5');
    const rows = await reviewCreate(p);
    const pool = await checkCreateReview(p, rows, { mint: A.t2, sol: solIn, token, origin: 'standard', market: stubMarket(FAIR) });

    // From the moment it is signed, no status can be read until released.
    a.rpc.fail('getSignatureStatuses', 500, 10 * 60_000);
    await press(ui.signButton(p), 'Sign in wallet');
    const out = ui.outcome(p);
    await expect(out).toBeVisible({ timeout: 5 * 60_000 });
    await expect(out).toHaveAttribute('data-status', 'unknown');
    const signature = a.wallet.lastSigned().signature!;
    await expect(out).toContainText(signature);
    await expect(out).toContainText('It may still land. Opening a pool again now could open a second pool and pay the fee to open twice.');
    await expect(out).not.toContainText(/fail/i);
    // It did land: the chain says so.
    expect((await landedTx(signature)).meta?.err ?? null).toBeNull();

    await p.reload();
    const pending = ui.lp.pending(p);
    await expect(pending).toBeVisible({ timeout: 60_000 });
    await expect(pending).toContainText(signature);
    await expect(pending).toContainText('opening a pool. Opening another pool stays off until this is checked.');
    await expect(pending).not.toContainText(/fail/i);
    expect(await pendingNotes(p)).toContain(signature);
    await expect(createCard(p)).toHaveAttribute('data-create', 'held', { timeout: 60_000 });
    await expect(ui.lp.create.openButton(p)).toHaveCount(0);

    // Another token: Create is held there too; its pool's Add and the creator's Remove are not.
    await openPools(p, A.ta);
    await expect(createCard(p)).toHaveAttribute('data-create', 'held', { timeout: 60_000 });
    await expect(poolCard(p, A.poolA.address)).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
    await pressable(ui.lp.addButton(poolCard(p, A.poolA.address)), 'Add liquidity on another pool');
    await ensureConnected(p);
    await expect(positionRow(p, A.poolA.address)).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
    await pressable(ui.lp.removeButton(positionRow(p, A.poolA.address)), 'Remove liquidity on an existing position');

    // Check again while the status still cannot be read: still unknown, still held.
    const failedBefore = a.rpc.failedCount('getSignatureStatuses');
    await press(pending.getByRole('button', { name: 'Check again' }), 'Check again');
    await expect.poll(() => a.rpc.failedCount('getSignatureStatuses'), { timeout: 60_000 }).toBeGreaterThan(failedBefore);
    await expect(pending.getByRole('button', { name: 'Check again' })).toBeEnabled({ timeout: 60_000 });
    await expect(pending).toBeVisible();
    await expect(pending).not.toContainText(/fail/i);
    expect(await pendingNotes(p)).toContain(signature);
    await expect(createCard(p)).toHaveAttribute('data-create', 'held');

    // Released: Check again settles it, and the tab now knows the pool it opened.
    await openPools(p, A.t2);
    a.rpc.release('getSignatureStatuses');
    await press(ui.lp.pending(p).getByRole('button', { name: 'Check again' }), 'Check again');
    await expect(ui.lp.pending(p)).toHaveCount(0, { timeout: 60_000 });
    expect(await pendingNotes(p)).toBeNull();
    await expect(createCard(p)).toHaveAttribute('data-advice', 'opened-here', { timeout: 60_000 });
    await expect(createCard(p)).toContainText(pool.toBase58());
    expect(await poolsFor(A.t2, A.creator.publicKey), 'exactly one pool for the pair by this creator').toEqual([pool]);
    expect(a.wallet.signed()).toHaveLength(1);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P3: a link carrying create, amounts and a price opens nothing, fills nothing and signs nothing', async ({ browser }) => {
    const a = await actor(browser, A.creator, { prices: A.prices });
    const p = a.page;
    await openPools(p, A.t3, '&create=1&sol=5&tokens=9&price=1');
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(ui.lp.create.panel(p)).toHaveCount(0);
    await press(ui.lp.create.openButton(p), 'Open a pool');
    await expect(ui.lp.create.panel(p)).toBeVisible();
    await expect(ui.lp.create.solToPut(p)).toHaveValue('');
    await expect(ui.lp.create.tokensToPut(p)).toHaveValue('');
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'empty');
    await expect(ui.lp.create.review(p)).toBeDisabled();
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP B: chromium only.
// ════════════════════════════════════════════════════════════════════════════

const B = {} as {
  prices: Prices;
  stranger: Keypair;
  c4: Keypair; t4: PublicKey; squat4: CreatedPool;
  c5: Keypair; t5: PublicKey;
  c6: Keypair; t6: PublicKey; p6: CreatedPool;
  c8: Keypair; t8: PublicKey;
  c9: Keypair; t9: PublicKey;
  freezable: PublicKey; hooked: PublicKey; usdcCopy: PublicKey; boboCopy: PublicKey;
  c11: Keypair; t11: PublicKey; t11u: PublicKey; t11d: PublicKey;
  c12: Keypair; t12: PublicKey; b12: Keypair;
  c13: Keypair; t13: PublicKey; r13: Keypair; r13Spendable: bigint;
  c14: Keypair; t14: PublicKey; t14n: PublicKey;
  w15: Keypair; t15: PublicKey;
  c16: Keypair; t16: PublicKey; p16: CreatedPool;
  c17: Keypair; t17: PublicKey;
  c18: Keypair; t18: PublicKey; squat18: CreatedPool;
  c19: Keypair; t19: PublicKey;
};
/** P14's token is priced at one lamport per base unit, so tiny amounts can agree with the market. */
const FAIR14 = 1e-3;
/** Wallet R's spendable SOL (P13), exactly. */
const R13_SPENDABLE = sol(0.3);

test.describe('group B (chromium only)', () => {
  test.beforeAll(async () => {
    test.skip(test.info().project.name !== 'chromium', 'Group B is chain-heavy and runs on chromium only; group A covers its layout on the phone');
    test.setTimeout(15 * 60_000);
    B.prices = new Map();
    const book = bookOf(B.prices);
    const unpriced = bookOf(new Map());
    B.stranger = await fundedKeypair(30);
    await Promise.all([
      (async () => {
        B.c4 = await fundedKeypair(5);
        B.t4 = await freshPricedToken(B.c4, book);
        await transferTokens(B.c4, B.stranger.publicKey, B.t4, 1_000_000n * UNIT);
        B.squat4 = await squatStandard(B.stranger, B.t4, { priceX: 10, openTimeFromNow: TEN_YEARS });
      })(),
      (async () => {
        B.c5 = await fundedKeypair(5);
        B.t5 = await freshPricedToken(B.c5, book);
        await transferTokens(B.c5, B.stranger.publicKey, B.t5, 1_000_000n * UNIT);
      })(),
      (async () => {
        B.c6 = await fundedKeypair(5);
        B.t6 = await freshPricedToken(B.c6, book);
        B.p6 = await createSolPool(B.c6, B.t6, { configIndex: 0, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' });
      })(),
      (async () => {
        B.c8 = await fundedKeypair(5);
        B.t8 = await freshPricedToken(B.c8, book);
      })(),
      (async () => {
        B.c9 = await fundedKeypair(3);
        B.t9 = await createToken2022MetadataOnly(B.c9, { name: 'E2E Meta Only 2022', symbol: 'EMETA22', supply: 100_000n * UNIT });
        book.setPrice(B.t9.toBase58(), FAIR, DEC);
      })(),
      (async () => {
        const s = await fundedKeypair(2);
        B.freezable = await createClassicToken(s, { supply: 1_000_000n * UNIT, name: { name: 'E2E Create Freeze', symbol: 'ECFZ' }, freezable: true });
        B.hooked = await createTransferHookToken(s);
        B.usdcCopy = await createClassicToken(s, { supply: 1_000_000n * UNIT, name: { name: 'USD Coin', symbol: 'USDC' } });
        B.boboCopy = await createClassicToken(s, { supply: 1_000_000n * UNIT, name: { name: 'BOBO', symbol: 'BOBO' } });
      })(),
      (async () => {
        B.c11 = await fundedKeypair(5);
        B.t11 = await freshPricedToken(B.c11, book);
        B.t11u = await freshPricedToken(B.c11, unpriced);
        B.t11d = await freshPricedToken(B.c11, book);
      })(),
      (async () => {
        B.c12 = await fundedKeypair(5);
        B.b12 = await fundedKeypair(3);
        B.t12 = await freshPricedToken(B.c12, book);
        await transferTokens(B.c12, B.b12.publicKey, B.t12, 1_000_000n * UNIT);
      })(),
      (async () => {
        B.c13 = await fundedKeypair(3);
        B.t13 = await freshPricedToken(B.c13, book);
        // Wallet R: funded to the lamport, so that what it can put in is exactly R13_SPENDABLE.
        const [tier, rents] = await Promise.all([tierView(1), liveRents()]);
        const hold = rents.r165 > rents.r0 ? rents.r165 : rents.r0;
        const need = R13_SPENDABLE + feeReserveFor(2) + rents.r165 + tier.createPoolFee + rents.neverRefunded + hold;
        B.r13 = await fundedKeypair(Number(need) / 1e9);
        await transferTokens(B.c13, B.r13.publicKey, B.t13, 1_000_000n * UNIT);
      })(),
      (async () => {
        B.c14 = await fundedKeypair(3);
        B.t14 = await freshPricedToken(B.c14, book, { solPerToken: FAIR14 });
        B.t14n = await freshPricedToken(B.c14, unpriced);
      })(),
      (async () => {
        B.w15 = await fundedKeypair(3);
        B.t15 = await freshPricedToken(B.w15, book);
        await wrapSol(B.w15, sol(0.5));
      })(),
      (async () => {
        B.c16 = await fundedKeypair(5);
        B.t16 = await freshPricedToken(B.c16, book);
        B.p16 = await createSolPool(B.c16, B.t16, { configIndex: 1, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' });
      })(),
      (async () => {
        B.c17 = await fundedKeypair(5);
        B.t17 = await freshPricedToken(B.c17, book);
      })(),
      (async () => {
        B.c18 = await fundedKeypair(5);
        B.t18 = await freshPricedToken(B.c18, book);
        await transferTokens(B.c18, B.stranger.publicKey, B.t18, 1_000_000n * UNIT);
        B.squat18 = await squatStandard(B.stranger, B.t18, { priceX: 10, openTimeFromNow: TEN_YEARS });
      })(),
      (async () => {
        B.c19 = await fundedKeypair(3);
        B.t19 = await freshPricedToken(B.c19, book);
      })(),
    ]);
  });

  test('P4: a squatted standard address: the opening goes to a one-off key that signs after the wallet, and the key is never stored', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const omit = new Set<string>();
    const a = await actor(browser, B.c4, { prices: B.prices, indexOmit: omit });
    const p = a.page;
    expect(B.squat4.standard).toBe(true);
    const squatBytes = (await chain().getAccountInfo(B.squat4.address, 'confirmed'))!.data;
    await openPools(p, B.t4);
    await connect(p);
    await expect(poolCard(p, B.squat4.address)).toHaveAttribute('data-deposits', 'refused', { timeout: 60_000 });
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(createCard(p)).toContainText("None of this token's pools passes the checks above.");
    const panel = await openCreate(p);
    await expect(panel).toContainText('a new address of its own (the standard address is already taken)');
    const { sol: solIn, token } = await solThenMatch(p, '0.2');
    const rows = await reviewCreate(p);
    const pool = await checkCreateReview(p, rows, { mint: B.t4, sol: solIn, token, origin: 'other', market: stubMarket(FAIR) });
    // From here the index answers without the new pool: the page must still list it.
    omit.add(pool.toBase58());
    const feeBefore = (await tokenAmount(CREATE_POOL_FEE_RECEIVER))!;
    const tokenBefore = (await tokenAmount(ata(B.t4, B.c4.publicKey)))!;
    const { signature, t } = await signConfirmed(a);
    checkSignedOpening(a, pool, 'co-signer');
    // Two required signatures: the wallet's, then the new pool's own.
    const message = t.transaction.message as unknown as { header: { numRequiredSignatures: number } };
    expect(message.header.numRequiredSignatures).toBe(2);
    expect(txAccountKeys(t).slice(0, 2).map((k) => k.toBase58())).toEqual([B.c4.publicKey.toBase58(), pool.toBase58()]);
    await checkOpenedPool({ pool, mint: B.t4, owner: B.c4.publicKey, sol: solIn, token, signature, feeBefore, tokenBefore, fee: (await tierView(1)).createPoolFee });
    await checkOpenerSol(t, B.c4.publicKey, solIn);
    expect(Buffer.from((await chain().getAccountInfo(B.squat4.address, 'confirmed'))!.data).equals(Buffer.from(squatBytes)), "the squat pool's bytes are unchanged").toBe(true);

    await closeAll(p, ui.lp.create.panel(p));
    await expect(poolCard(p, pool)).toContainText("You opened this pool just now. Your share is under 'Your positions'.", { timeout: 60_000 });
    expect(a.index.calls.some((c) => c.includes(B.t4.toBase58())), 'the index was asked (and answered without the new pool)').toBe(true);
    await expect(createCard(p)).toHaveAttribute('data-advice', 'opened-here');
    const where = secretFor(await storageValues(p), pool);
    expect(where, `the pool's secret key is in storage (${where})`).toBeNull();
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P5: a front-run at the standard address after the review is turned away before running; Start over opens at a new address', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const a = await actor(browser, B.c5, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t5);
    await connect(p);
    await openCreate(p);
    const { sol: solIn, token } = await solThenMatch(p, '0.2');
    const rows = await reviewCreate(p);
    await checkCreateReview(p, rows, { mint: B.t5, sol: solIn, token, origin: 'standard', market: stubMarket(FAIR) });
    // While the review is on screen, someone opens the standard tier-1 pool first.
    const squat = await squatStandard(B.stranger, B.t5, { priceX: 10, openTimeFromNow: 0 });
    expect(squat.address.equals(standardOf(B.t5))).toBe(true);
    await press(ui.signButton(p), 'Sign in wallet');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 120_000 });
    await expect(out).toContainText('Not sent. The network turned it away before running it.');
    await expect(out).toContainText('Someone opened a pool at this address first. Nothing was opened. Start over: the site will use a new address.');
    await expect(out).toContainText('Nothing was sent.');
    expect(await pendingNotes(p)).toBeNull();

    await press(out.getByRole('button', { name: 'Start over' }), 'Start over');
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(ui.lp.create.panel(p)).toContainText('a new address of its own (the standard address is already taken)', { timeout: 60_000 });
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'agrees');
    const rows2 = await reviewCreate(p);
    const pool = await checkCreateReview(p, rows2, { mint: B.t5, sol: solIn, token, origin: 'other', market: stubMarket(FAIR) });
    await signConfirmed(a);
    checkSignedOpening(a, pool, 'co-signer');
    expect(await poolsFor(B.t5, B.c5.publicKey), 'one pool by this creator').toEqual([pool]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P6: with fee tier 1 missing from the page\'s reads, Create says "not created yet"; Remove lands and Add is offered (create facts never touch the gate)', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.c6, { prices: B.prices });
    const p = a.page;
    a.rpc.rewriteAccount(TIER1.toBase58(), () => null);
    await openPools(p, B.t6);
    await connect(p);
    const tier1Row = ui.lp.feeTiers(p).and(p.locator('[data-index="1"]'));
    await expect(tier1Row).toHaveAttribute('data-state', 'absent', { timeout: 60_000 });
    await expect(tier1Row).toContainText('Tier 1');
    await expect(tier1Row).toContainText('not created yet');
    await expect(createCard(p)).toHaveAttribute('data-create', 'tier-not-open', { timeout: 60_000 });
    await expect(createCard(p)).toContainText(
      "New pools from this site go on the public fee tier (tier 1), and that tier has not been created on the network yet. When the team's vault creates it, the Open a pool button appears here.",
    );
    await expect(ui.lp.create.openButton(p)).toHaveCount(0);
    await expect(poolCard(p, B.p6.address)).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
    await pressable(ui.lp.addButton(poolCard(p, B.p6.address)), 'Add liquidity');

    const row = positionRow(p, B.p6.address);
    const lpAcc = ata(B.p6.lpMint, B.c6.publicKey);
    const held = (await tokenAmount(lpAcc))!;
    const panel = await openRemove(row);
    await press(ui.lp.percent(panel, '25%'), '25%');
    await press(ui.lp.reviewRemove(panel), 'Review: remove liquidity');
    await reviewRows(p);
    const plan = withdrawPlan(await poolFacts(B.p6.address), held, 2_500n);
    await signConfirmed(a);
    expect(a.wallet.lastIx('withdraw').args.lpTokenAmount).toBe(String(plan.lp));
    expect(await tokenAmount(lpAcc)).toBe(held - plan.lp);
    expect(a.rpc.rewrittenCount(TIER1.toBase58())).toBeGreaterThan(0);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P7: the tier switched off, its fee above the limit, the fee account missing: each says why, offers no button, and Remove stays', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.c6, { prices: B.prices });
    const p = a.page;
    const tier1 = TIER1.toBase58();
    const edit = (f: (b: Buffer) => void) => (d: Uint8Array | null) => {
      if (!d) return null;
      const b = Buffer.from(d);
      f(b);
      return Uint8Array.from(b);
    };
    const cases: { name: string; set: () => void; offer: string; text: string }[] = [
      {
        name: 'switched off',
        set: () => a.rpc.rewriteAccount(tier1, edit((b) => { b[AMM_CONFIG_OFFSETS.disableCreatePool] = 1; })),
        offer: 'tier-off',
        text: "Opening new pools on the public fee tier is switched off right now by the pool program's admin (the team's vault).",
      },
      {
        name: 'fee too high',
        set: () => a.rpc.rewriteAccount(tier1, edit((b) => { b.writeBigUInt64LE(sol(2), AMM_CONFIG_OFFSETS.createPoolFee); })),
        offer: 'tier-fee-too-high',
        text: `The fee to open a pool on the public fee tier is set to ${formatSol(sol(2), 9)} SOL, above this site's limit of ${formatSol(sol(1), 9)} SOL, so this site will not open one.`,
      },
      {
        name: 'fee account missing',
        set: () => { a.rpc.clearRewrites(); a.rpc.rewriteAccount(CREATE_POOL_FEE_RECEIVER.toBase58(), () => null); },
        offer: 'fee-account',
        text: 'The account that receives the fee to open a pool is not set up (there is no account at its address), so opening a pool would fail.',
      },
    ];
    for (const c of cases) {
      c.set();
      await openPools(p, B.t6);
      if (c === cases[0]) await connect(p);
      else await ensureConnected(p);
      await expect(createCard(p), c.name).toHaveAttribute('data-create', c.offer, { timeout: 60_000 });
      await expect(createCard(p)).toContainText(c.text);
      await expect(ui.lp.create.openButton(p)).toHaveCount(0);
      await expect(positionRow(p, B.p6.address)).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
      await pressable(ui.lp.removeButton(positionRow(p, B.p6.address)), `Remove liquidity (${c.name})`);
    }
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P8: a tier read that lies about the fee (0.30 SOL against the chain\'s 0.15) is blocked at the test run, before any signature', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.c8, { prices: B.prices });
    const p = a.page;
    const lie = sol(0.3);
    const real = (await tierView(1)).createPoolFee;
    expect(real).not.toBe(lie);
    a.rpc.rewriteAccount(TIER1.toBase58(), (d) => {
      if (!d) return null;
      const b = Buffer.from(d);
      b.writeBigUInt64LE(lie, AMM_CONFIG_OFFSETS.createPoolFee);
      return Uint8Array.from(b);
    });
    await openPools(p, B.t8);
    await connect(p);
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(createCard(p)).toContainText(`${formatSol(lie, 9)} SOL to open`);
    const panel = await openCreate(p);
    await expect(panel).toContainText(`${formatSol(lie, 9)} SOL, paid to the team's vault (read just now)`);
    await solThenMatch(p, '0.2');
    await expect(panel.getByTestId('lp-create-preview')).toContainText(`${formatSol(lie, 9)} SOL, to the team's vault (not refundable)`);
    await press(ui.lp.create.review(p), 'Review: open the pool');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 120_000 });
    await expect(out).toContainText('Not sent. A test run of this transaction was refused, so we did not ask your wallet to sign it.');
    await expect(out).toContainText('Blocked: the simulation shows a different token amount than this screen says.');
    expect(a.wallet.records).toEqual([]);
    expect(await poolsFor(B.t8), 'no pool').toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P9: a Token-2022 metadata-only token: Max tokens then Match sets the SOL; the vaults are 165 bytes under each program, the share account classic', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.c9, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t9);
    await expect(ui.lp.safety(p)).toHaveAttribute('data-verdict', 'ok');
    await connect(p);
    const t22 = ata(B.t9, B.c9.publicKey, TOKEN_2022_PROGRAM_ID);
    const balance = (await tokenAmount(t22))!;
    await openCreate(p);
    await press(ui.lp.create.maxTokens(p), 'Max tokens');
    expect(parseDecimalToBaseUnits(await ui.lp.create.tokensToPut(p).inputValue(), DEC)).toBe(balance);
    await press(ui.lp.create.match(p), 'Match the market price');
    // Match kept the token box (typed last, by Max) and set the SOL box.
    expect(parseDecimalToBaseUnits(await ui.lp.create.tokensToPut(p).inputValue(), DEC)).toBe(balance);
    const solIn = parseDecimalToBaseUnits(await ui.lp.create.solToPut(p).inputValue(), 9)!;
    expect(solIn).toBe(matchMarket({ keep: 'token', amount: balance, solPerToken: stubMarket(FAIR), tokenDecimals: DEC }));
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'agrees');
    const rows = await reviewCreate(p);
    const pool = await checkCreateReview(p, rows, { mint: B.t9, sol: solIn, token: balance, origin: 'standard', market: stubMarket(FAIR) });
    const feeBefore = (await tokenAmount(CREATE_POOL_FEE_RECEIVER))!;
    const { signature, t } = await signConfirmed(a);
    await checkOpenedPool({ pool, mint: B.t9, owner: B.c9.publicKey, sol: solIn, token: balance, tokenProgram: TOKEN_2022_PROGRAM_ID, signature, feeBefore, tokenBefore: balance, fee: (await tierView(1)).createPoolFee });
    await checkOpenerSol(t, B.c9.publicKey, solIn);
    expect(a.wallet.signed().flatMap((r) => r.instructions).some((i) => i.program === 'token-2022'), 'no top-level Token-2022 instruction').toBe(false);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P10: blocked tokens and copies of well-known names get no button: a freezable token, a transfer hook, a "USDC" and a "BOBO" from other mints', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.stranger, { prices: B.prices });
    const p = a.page;
    const blocked = 'This site does not open pools for this token: This token is blocked on this site (see why above).';
    const copy = 'This site does not open pools for this token: It calls itself by a well-known token’s name but has a different mint. This site does not open pools for copies.';
    for (const [mint, line, why] of [
      [B.freezable, blocked, 'Its creator can still freeze token accounts'],
      [B.hooked, blocked, 'This site only accepts tokens whose only extras are their name and picture.'],
      [B.usdcCopy, copy, null],
      [B.boboCopy, copy, null],
    ] as const) {
      await openPools(p, mint);
      await expect(createCard(p)).toHaveAttribute('data-create', 'token-refused', { timeout: 60_000 });
      await expect(createCard(p)).toContainText(line);
      if (why) await expect(ui.lp.safety(p)).toContainText(why);
      await expect(ui.lp.create.openButton(p)).toHaveCount(0);
    }
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P11: an opening price far from Jupiter\'s: refused on screen, fixed by Match, refused at build after the market moves; no route, and Jupiter down', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.c11, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t11);
    await connect(p);
    await openCreate(p);
    const market = stubMarket(FAIR);
    // (a) 1.5x the market: 1 SOL against the tokens 1 SOL buys at 1.5x the price.
    const solIn = sol(1);
    const high = matchMarket({ keep: 'sol', amount: solIn, solPerToken: market * 1.5, tokenDecimals: DEC })!;
    await ui.lp.create.solToPut(p).fill('1');
    await ui.lp.create.tokensToPut(p).fill(tokensToInput(high));
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'disagrees');
    const loss = BigInt(Math.round(arbitrageLoss({ sol: solIn, token: high, tokenDecimals: DEC, marketSolPerToken: market })));
    await expect(ui.lp.create.panel(p).getByRole('alert')).toContainText(
      new RegExp(`^Your opening price is \\d+\\.\\d% above the market price\\. Bots would trade against your pool as soon as it opens, taking about ${esc(`${formatSol(loss, 4)} SOL`)} of what you put in\\. Pools opened from this site must start within 3% of the market\\.`),
    );
    await expect(ui.lp.create.review(p)).toBeDisabled();
    // (b) Match: agrees, and Review is offered.
    await press(ui.lp.create.match(p), 'Match the market price');
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'agrees');
    await expect(ui.lp.create.review(p)).toBeEnabled({ timeout: 30_000 });
    // (c) The market moves up 5% before Review: refused at build, with the gap.
    a.jup.setPrice(B.t11.toBase58(), FAIR * 1.05);
    await press(ui.lp.create.review(p), 'Review: open the pool');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 120_000 });
    await expect(out).toContainText('Not sent. We could not build this transaction.');
    const gap = (await out.innerText()).match(/Your opening price is now (\d+\.\d)% below the market price \(Jupiter, read just now\)\. Pools opened from this site must start within 3% of it\. Press Match the market price, then Review again\./);
    expect(gap, await out.innerText()).not.toBeNull();
    expect(Math.abs(Number(gap![1]) - 4.8) <= 0.3, `the gap ${gap![1]}% is about 5%`).toBe(true);
    // (d) A token Jupiter has no route for.
    await openPools(p, B.t11u);
    await expect(createCard(p)).toHaveAttribute('data-create', 'no-route', { timeout: 60_000 });
    await expect(createCard(p)).toContainText('Jupiter has no market price for this token.');
    await expect(ui.lp.create.openButton(p)).toHaveCount(0);
    // (e) Jupiter down for a priced token.
    a.jup.setDown(B.t11d.toBase58(), true);
    await openPools(p, B.t11d);
    await expect(createCard(p)).toHaveAttribute('data-create', 'price-unread', { timeout: 60_000 });
    await expect(createCard(p)).toContainText('HTTP 502');
    await expect(ui.lp.create.openButton(p)).toHaveCount(0);
    expect(a.wallet.records).toEqual([]);
    expect(await poolsFor(B.t11)).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P12: a pool opened through the site then takes another wallet\'s Add, and the opener\'s Remove', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const c = await actor(browser, B.c12, { prices: B.prices });
    await openPools(c.page, B.t12);
    await connect(c.page);
    await openCreate(c.page);
    const { sol: solIn, token } = await solThenMatch(c.page, '1');
    const rows = await reviewCreate(c.page);
    const pool = await checkCreateReview(c.page, rows, { mint: B.t12, sol: solIn, token, origin: 'standard', market: stubMarket(FAIR) });
    await signConfirmed(c);
    await closeAll(c.page, ui.lp.create.panel(c.page));
    await waitPoolOpen(pool);

    const b = await actor(browser, B.b12, { prices: B.prices });
    await openPools(b.page, B.t12);
    await connect(b.page);
    const lpMint = deriveLpMint(CP_SWAP_PROGRAM, pool);
    const { panel } = await openAdd(b.page, pool);
    await ui.lp.solToAdd(panel).fill('0.05');
    await expect(ui.lp.reviewAdd(panel)).toBeEnabled({ timeout: 30_000 });
    const { plan } = await reviewDeposit(b, panel, pool, 'sol', sol(0.05));
    await signConfirmed(b);
    expect(b.wallet.lastIx('deposit').args.lpTokenAmount).toBe(String(plan.lp));
    expect(await tokenAmount(ata(lpMint, B.b12.publicKey)), "wallet B's shares are exactly the review's").toBe(plan.lp);
    expect(b.rpc.violations).toEqual([]);
    await b.ctx.close();

    // The opener takes half out.
    await openPools(c.page);
    await ensureConnected(c.page);
    const lpAcc = ata(lpMint, B.c12.publicKey);
    const held = (await tokenAmount(lpAcc))!;
    expect(held).toBe(isqrt(solIn * token) - 100n);
    const rpanel = await openRemove(positionRow(c.page, pool));
    await press(ui.lp.percent(rpanel, '50%'), '50%');
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    await reviewRows(c.page);
    const f = await poolFacts(pool);
    const wplan = withdrawPlan(f, held, 5_000n);
    const tokenBefore = (await tokenAmount(ata(B.t12, B.c12.publicKey))) ?? 0n;
    const solVault = deriveVault(CP_SWAP_PROGRAM, pool, WSOL);
    const solVaultBefore = (await tokenAmount(solVault))!;
    await signConfirmed(c);
    expect(c.wallet.lastIx('withdraw').args.lpTokenAmount).toBe(String(wplan.lp));
    expect(held - (await tokenAmount(lpAcc))!, 'the shares burned are exactly the plan').toBe(wplan.lp);
    expect(((await tokenAmount(ata(B.t12, B.c12.publicKey))) ?? 0n) - tokenBefore >= wplan.minTok).toBe(true);
    expect(solVaultBefore - (await tokenAmount(solVault))! >= wplan.minSol).toBe(true);
    expect(c.rpc.violations).toEqual([]);
    await c.ctx.close();
  });

  test('P13: the rent band: Max SOL is exactly what can go in after the fee, the deposits and two signatures; it lands; a little more is refused on screen', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.r13, { prices: B.prices });
    const p = a.page;
    const [tier, rents] = await Promise.all([tierView(1), liveRents()]);
    const have = await lamports(B.r13.publicKey);
    const spendable = spendableSol({
      lamports: have, walletFloor: rents.r0, feeReserve: feeReserveFor(2), lpAccountRent: rents.r165, wsolCreateRent: rents.r165,
      alsoPaid: tier.createPoolFee + rents.neverRefunded,
    });
    expect(spendable).toBe(R13_SPENDABLE);
    expect(await tokenAmount(ata(WSOL, B.r13.publicKey)), 'wallet R holds no wrapped-SOL account').toBeNull();
    await openPools(p, B.t13);
    await connect(p);
    await openCreate(p);
    await press(ui.lp.create.maxSol(p), 'Max SOL');
    expect(parseDecimalToBaseUnits(await ui.lp.create.solToPut(p).inputValue(), 9)).toBe(spendable);
    await press(ui.lp.create.match(p), 'Match the market price');
    await expect(ui.lp.create.review(p)).toBeEnabled({ timeout: 30_000 });
    // 0.001 SOL more: the rent-band line, and no Review.
    await ui.lp.create.solToPut(p).fill(formatSol(spendable + sol(0.001), 9));
    await expect(ui.lp.create.panel(p).getByRole('alert')).toContainText(
      `That would leave your wallet with too little SOL to pay the fee to open, the account deposits and stay open on the network. The most you can put in from this wallet is ${solExact(spendable)}.`,
    );
    await expect(ui.lp.create.review(p)).toBeDisabled();
    // Max again, Match, and it lands.
    await press(ui.lp.create.maxSol(p), 'Max SOL');
    await press(ui.lp.create.match(p), 'Match the market price');
    const token = parseDecimalToBaseUnits(await ui.lp.create.tokensToPut(p).inputValue(), DEC)!;
    const rows = await reviewCreate(p);
    await checkCreateReview(p, rows, { mint: B.t13, sol: spendable, token, origin: 'standard', market: stubMarket(FAIR) });
    const { t } = await signConfirmed(a);
    await checkOpenerSol(t, B.r13.publicKey, spendable);
    expect((await lamports(B.r13.publicKey)) >= rents.r0, 'wallet R keeps at least the rent floor').toBe(true);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P14: too small, and the program\'s own trap: isqrt 100 and 50,000 are refused on screen; in Node, 99 fails with 6009 and exactly 100 lands with no shares', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.c14, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t14);
    await connect(p);
    await openCreate(p);
    const alert = ui.lp.create.panel(p).getByRole('alert');
    // 100 lamports against 100 base units: isqrt 100, at the market price (1 lamport a unit).
    expect(isqrt(100n * 100n)).toBe(100n);
    await ui.lp.create.solToPut(p).fill(formatSol(100n, 9));
    await ui.lp.create.tokensToPut(p).fill(tokensToInput(100n));
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'agrees');
    await expect(alert).toHaveText(`Too small: the pool program keeps ${LOCKED_SHARES} in every new pool forever, and this opening would not cover them. Put in more of either side.`);
    await expect(ui.lp.create.review(p)).toBeDisabled();
    // 50,000 each: isqrt 50,000, so the locked 100 would be 0.2% of the pool.
    await ui.lp.create.solToPut(p).fill(formatSol(50_000n, 9));
    await ui.lp.create.tokensToPut(p).fill(tokensToInput(50_000n));
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'agrees');
    await expect(alert).toHaveText(`Too small to be worth it: the ${LOCKED_SHARES} the pool program keeps forever would be 0.2% of this pool. Put in more, so that part is 0.1% or less.`);
    await expect(ui.lp.create.review(p)).toBeDisabled();
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();

    // The program itself, in Node: below 100 it refuses with InitLpAmountTooLess (6009)…
    const creator = B.c14;
    const mint = B.t14n;
    const { token0, token1, flipped } = sortMints(WSOL, mint);
    const solIs0 = !flipped;
    const wsolAta = ata(WSOL, creator.publicKey);
    const tokenAta = ata(mint, creator.publicKey);
    const opening = (amount: bigint) => {
      const pool = derivePool(CP_SWAP_PROGRAM, TIER1, token0, token1);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, wsolAta, creator.publicKey, WSOL),
        SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: wsolAta, lamports: amount }),
        createSyncNativeInstruction(wsolAta),
        initializeIx({
          programId: CP_SWAP_PROGRAM, creator: creator.publicKey, ammConfig: TIER1, token0Mint: token0, token1Mint: token1,
          creatorToken0: solIs0 ? wsolAta : tokenAta, creatorToken1: solIs0 ? tokenAta : wsolAta,
          creatorLpToken: ata(deriveLpMint(CP_SWAP_PROGRAM, pool), creator.publicKey),
          token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID, createPoolFee: CREATE_POOL_FEE_RECEIVER,
          initAmount0: amount, initAmount1: amount, openTime: 0n,
        }),
      );
      tx.feePayer = creator.publicKey;
      return { tx, pool };
    };
    const below = opening(99n);
    below.tx.recentBlockhash = (await chain().getLatestBlockhash('confirmed')).blockhash;
    const sim = await chain().simulateTransaction(new VersionedTransaction(below.tx.compileMessage()), { sigVerify: false, commitment: 'confirmed' });
    expect(sim.value.err, (sim.value.logs ?? []).join('\n')).toEqual({ InstructionError: [3, { Custom: 6009 }] });
    // …and at exactly 100 it LANDS and mints its creator nothing: why the site needs more.
    const exact = await createSolPool(creator, mint, { configIndex: 1, sol: 100n, tokens: 100n, at: 'standard' });
    expect(exact.address.equals(below.pool)).toBe(true);
    expect((await poolFacts(exact.address)).pool.lpSupply).toBe(100n);
    expect(await tokenAmount(ata(exact.lpMint, creator.publicKey)), 'the creator got no pool shares').toBe(0n);
  });

  test('P15: wrapped SOL the wallet already held is left exactly as it was', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.w15, { prices: B.prices });
    const p = a.page;
    const wsolAcc = ata(WSOL, B.w15.publicKey);
    expect(await tokenAmount(wsolAcc)).toBe(sol(0.5));
    await openPools(p, B.t15);
    await connect(p);
    const panel = await openCreate(p);
    await expect(panel).toContainText(`You already hold ${units(sol(0.5), 9)} wrapped SOL. None of it is spent.`, { timeout: 30_000 });
    const { sol: solIn, token } = await solThenMatch(p, '0.2');
    const rows = await reviewCreate(p);
    await checkCreateReview(p, rows, { mint: B.t15, sol: solIn, token, origin: 'standard', market: stubMarket(FAIR) });
    await expect(ui.review(p)).toContainText(`You already hold ${formatSol(sol(0.5), 9)} wrapped SOL. None of it is spent.`);
    const { t } = await signConfirmed(a);
    await checkOpenerSol(t, B.w15.publicKey, solIn);
    expect(await tokenAmount(wsolAcc), 'exactly the 0.5 SOL it held').toBe(sol(0.5));
    expect(a.wallet.signed().flatMap((r) => r.instructions).some((i) => i.name === 'close-wsol'), 'never unwrapped').toBe(false);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  // Owner ruling 2026-10-03: a token may have as many pools as people open. The card
  // points to the bigger pool first and still offers Create; a second pool then opens at
  // an address of its own, beside the first, and the first is untouched.
  test('P16: a passing tier-1 pool already exists: the card points to it, its Add is offered, and a second pool still opens beside it', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.c16, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t16);
    await connect(p);
    await expect(poolCard(p, B.p16.address)).toHaveAttribute('data-deposits', 'allowed', { timeout: 60_000 });
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(createCard(p)).toHaveAttribute('data-advice', 'exists');
    await expect(createCard(p)).toContainText(
      `This token already has a pool on the public fee tier that passes the checks (above). The biggest is ${B.p16.address.toBase58()}, holding 1 SOL. We suggest adding to it: liquidity in one place gives traders a better price.`,
    );
    await expect(createCard(p)).toContainText('You can still open your own on the public fee tier');
    await expect(poolCard(p, B.p16.address)).toHaveAttribute('data-add', 'offer');
    await pressable(ui.lp.addButton(poolCard(p, B.p16.address)), 'Add liquidity');
    expect(a.wallet.records).toEqual([]);

    // The second pool, by choice. The standard address holds the first, so it goes to a
    // one-off key, and the panel says a pool is already there next to Review.
    const firstBytes = (await chain().getAccountInfo(B.p16.address, 'confirmed'))!.data;
    const panel = await openCreate(p);
    await expect(panel).toContainText('a new address of its own (the standard address is already taken)');
    await expect(panel).toContainText('This token already has a pool that passes the checks (the card above names it). Opening here makes a separate pool');
    const { sol: solIn, token } = await solThenMatch(p, '0.2');
    const rows = await reviewCreate(p);
    const pool = await checkCreateReview(p, rows, { mint: B.t16, sol: solIn, token, origin: 'other', market: stubMarket(FAIR) });
    expect(pool.toBase58(), 'a different pool from the first').not.toBe(B.p16.address.toBase58());
    const feeBefore = (await tokenAmount(CREATE_POOL_FEE_RECEIVER))!;
    const tokenBefore = (await tokenAmount(ata(B.t16, B.c16.publicKey)))!;
    // The first pool was opened from Node (createSolPool), which leaves the opener's
    // wrapped-SOL account open and empty. This opening closes it, and its deposit comes back.
    const wsolAcc = ata(WSOL, B.c16.publicKey);
    expect(await tokenAmount(wsolAcc), 'an empty wrapped-SOL account before').toBe(0n);
    const wsolLamports = await lamports(wsolAcc);
    const { signature, t } = await signConfirmed(a);
    checkSignedOpening(a, pool, 'co-signer');
    await checkOpenedPool({ pool, mint: B.t16, owner: B.c16.publicKey, sol: solIn, token, signature, feeBefore, tokenBefore, fee: (await tierView(1)).createPoolFee });
    await checkOpenerSol(t, B.c16.publicKey, solIn, wsolLamports);
    expect(await accountOwner(wsolAcc), 'no wrapped-SOL account left').toBeNull();
    expect(Buffer.from((await chain().getAccountInfo(B.p16.address, 'confirmed'))!.data).equals(Buffer.from(firstBytes)), "the first pool's bytes are unchanged").toBe(true);

    // Both pools are listed, each with its own card.
    await closeAll(p, ui.lp.create.panel(p));
    await expect(poolCard(p, pool)).toContainText("You opened this pool just now. Your share is under 'Your positions'.", { timeout: 60_000 });
    await expect(poolCard(p, B.p16.address)).toHaveAttribute('data-deposits', 'allowed');
    expect(a.wallet.signed()).toHaveLength(1);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P17: with the pool index down, Create is off ("pools unread"); a position found on the chain still offers Remove', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    // Made here, not in beforeAll: the share is found from its own recent history.
    const pool = await createSolPool(B.c17, B.t17, { configIndex: 1, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' });
    const a = await actor(browser, B.c17, { prices: B.prices, indexDown: true });
    const p = a.page;
    await openPools(p, B.t17);
    await expect(createCard(p)).toHaveAttribute('data-create', 'pools-unread', { timeout: 60_000 });
    await expect(createCard(p)).toContainText('We could not read every pool for this token (our pool index could not be read');
    await expect(createCard(p)).toContainText('Opening a pool is off until we can.');
    await expect(ui.lp.create.openButton(p)).toHaveCount(0);
    await connect(p);
    // A share cannot be placed from the index while it is down (lp-write E11): placed from the chain here.
    const row = ui.lp.position(p).filter({ hasText: pool.lpMint.toBase58() });
    await expect(row).toHaveAttribute('data-placement', 'index-unread', { timeout: 60_000 });
    await press(ui.lp.findOnChain(row), "Find this share's pool on the chain");
    await expect(row).toHaveAttribute('data-placement', 'chain', { timeout: 60_000 });
    await expect(row).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
    await pressable(ui.lp.removeButton(row), 'Remove liquidity');
    await expect(createCard(p)).toHaveAttribute('data-create', 'pools-unread');
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P18: declined, then retried, on the one-off path: nothing the first time, and a fresh key the second', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.c18, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t18);
    await connect(p);
    await openCreate(p);
    const { sol: solIn, token } = await solThenMatch(p, '0.2');
    const first = await checkCreateReview(p, await reviewCreate(p), { mint: B.t18, sol: solIn, token, origin: 'other', market: stubMarket(FAIR) });
    a.wallet.setMode('decline');
    await press(ui.signButton(p), 'Sign in wallet');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 30_000 });
    await expect(out).toContainText('Not sent. Your wallet did not sign it.');
    expect(a.wallet.records.map((r) => r.outcome)).toEqual(['declined']);
    expect(await pendingNotes(p)).toBeNull();
    expect(await poolsFor(B.t18, B.c18.publicKey)).toEqual([]);
    expect(await accountOwner(first), 'no pool at the first key').toBeNull();

    a.wallet.setMode('approve');
    await press(out.getByRole('button', { name: 'Start over' }), 'Start over');
    const second = await checkCreateReview(p, await reviewCreate(p), { mint: B.t18, sol: solIn, token, origin: 'other', market: stubMarket(FAIR) });
    expect(second.equals(first), 'a fresh key for each Review').toBe(false);
    await signConfirmed(a);
    checkSignedOpening(a, second, 'co-signer');
    expect(await poolsFor(B.t18, B.c18.publicKey), 'exactly one pool by this creator, at the second key').toEqual([second]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('P19: copy guards: no yield claims, the money note on the card, the panel and the review, the page copy for "on", and tier 1\'s live rates on the review', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.c19, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t19);
    await connect(p);
    await expect(createCard(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(createCard(p)).toContainText(MONEY);
    const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(body).toContain('This site reads pools and shares, and below you can add liquidity to a pool whose checks pass, take yours out, or open a new pool on the public fee tier (the pools section says whether that can be done right now).');
    expect(body).toContain('This site can add and remove liquidity, and open new pools on the public fee tier (the pools section below says whether it can right now).');
    // Whether tier 1 exists is said only by the create card's live read, never by fixed page copy.
    expect(body).not.toMatch(/once (the public fee tier|that tier) exists/);
    expect(body).toContain('still goes through Jupiter');
    const panel = await openCreate(p);
    await expect(panel.getByTestId('lp-before-you-open')).toContainText(MONEY);
    await solThenMatch(p, '0.1');
    await press(ui.lp.create.review(p), 'Review: open the pool');
    const rows = await reviewRows(p);
    const [t0, t1] = await Promise.all([tierView(0), tierView(1)]);
    expect(rows['Fee tier']).toBe(tierText(t1));
    expect(tierText(t1)).not.toBe(tierText(t0));
    await expect(ui.review(p).getByTestId('lp-review-disclosure')).toContainText(MONEY);
    // The only "yield" in the section is the sentence that says none is shown.
    const section = (await ui.lp.section(p).innerText()).replace(/\s+/g, ' ');
    expect(section).not.toMatch(/APR|APY|yield of/i);
    expect(section.replace('This page shows no yield, because none has been measured.', '')).not.toMatch(/yield/i);
    expect(section).not.toMatch(/earn fees on every trade/i);
    await press(p.getByRole('button', { name: 'Cancel', exact: true }), 'Cancel');
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });
});
