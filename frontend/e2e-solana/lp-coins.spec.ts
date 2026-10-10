// Pairing coins and "any token" on /pools, end to end, against the mainnet cp-swap binary
// on the local validator.
//
// A pool pairs a token with SOL, USDC or BAYLA (owner ruling 2026-10-03), and any token
// may have a pool: a token its creator can freeze, and an opening price away from the
// market, are warnings now, not refusals (owner ruling 2026-10-04). Every step here goes
// through the site's own forms with the test wallet, and every step is then checked ON
// CHAIN.
//
// As in lp-write.spec.ts and lp-create.spec.ts the page is the thing under test, so
// nothing it says is taken on trust. The pool's address, its vaults and its share token are
// derived here from the program's own seed strings. USDC and BAYLA amounts are decoded by
// hand (fixtures/usdc.ts, fixtures/bayla.ts). The market price and the estimated loss are
// worked out by hand from the stub's own numbers (fixtures/market.ts). What was signed is
// read from the test wallet's records (its guard decoded the exact bytes, and refuses any
// wrapped-SOL instruction in a pool that is not paired with SOL).
//
// Chromium only: the BAYLA/USDC pool goes to its standard address, which exists once per
// chain, so the steps cannot run a second time as a phone. The forms' layout is checked
// here at a phone's, an iPad's and a desktop's width instead. For the same reason this
// file needs a validator that has not run it before (start-validator.sh wipes the ledger).
import { test, expect, type Locator, type Page } from '@playwright/test';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  CP_SWAP_PROGRAM, WSOL, accountDataLength, accountOwner, ata, chain, fundedKeypair, lamportDelta, landedTx, mintFacts, poolFacts, tokenAmount,
} from './fixtures/chain';
import { BAYLA_MINT, bayla, baylaAccount, baylaAmount, giveBayla } from './fixtures/bayla';
import { BAYLA_COIN, SOL_COIN, USDC_COIN, coinAbout, coinExact, type Coin } from './fixtures/coins';
import { COIN_SOL_PRICE, CREATE_POOL_FEE_RECEIVER, closeTokenAccount, createClassicToken, createPairPool, freshPricedToken, type JupiterStub } from './fixtures/lp';
import {
  actor, closeAll, connect, esc, openAdd, openPools, openRemove, poolCard, positionRow, press, reviewDeposit, reviewRows, sidesOf, signConfirmed, signedSol,
  signedTok, SOL, solExact, tok, units, waitPoolOpenByWallClock, withdrawPlan, type Actor, type Prices,
} from './fixtures/lpPage';
import { lossAtMarketUp, marketIn, matchAtMarket, priceOf } from './fixtures/market';
import { ui, expectPressableAtSizes, tokensToInput } from './fixtures/ui';
import { USDC_MINT, giveUsdc, usdc, usdcAccount, usdcAmount } from './fixtures/usdc';
import { parseDecimalToBaseUnits } from '../src/lib/launcher/solana/curve/format';
import { formatSolPrice } from '../src/lib/solana/lp/format';
import { isqrt } from '../src/lib/solana/lp/liquidityMath';

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);
/** Every fresh token here is quoted at 1 SOL per million tokens. */
const FAIR = 1e-6;
/** Fee tier 1's fee to open a pool: 0.15 SOL, mainnet's own bytes (global-setup.ts checks them). */
const FEE_TO_OPEN = 150_000_000n;
/** The account the pool program pays that fee into, written out. */
const FEE_ACCOUNT = '2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa';
/** The pool shares the pool program keeps in every new pool forever. */
const LOCKED = 100n;
const LOCKED_SHARES = '0.0000001 pool shares (100 of the smallest unit)';

// ── what the page says, written out ────────────────────────────────────────────

const USDC_RISK =
  'USDC’s issuer (Circle) can freeze any USDC account, including a pool’s own. While a pool’s USDC account is frozen, nobody can take liquidity out of that pool, you included.';
const REVIEW_WARNINGS_LEAD = 'Read these warnings first. Nothing here stops you signing, and each one is a risk to what you put in:';
/** The token's own warning, as its card and the Open-a-pool card say it. */
const freezeOnToken = (authority: PublicKey) =>
  `Its creator can freeze any account that holds it (freeze authority ${authority.toBase58()}), a pool’s own vault and your own account included. While a pool’s vault is frozen, nobody can take liquidity out of that pool.`;
/** The same risk said for the pool: above Review in the form and on the review, then on the pool's own card. */
const FREEZE_ON_OPENING =
  'Its creator can freeze the vault of the pool you open, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.';
const FREEZE_ON_POOL =
  'Its creator can freeze the vault of this pool, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.';
const offMarketLine = (gap: string) => `Your opening price is ${gap} the market price (Jupiter). The first trades would move it to the market price, at your cost.`;
const lossLine = (loss: string) => `At these amounts, a move back to the market price would take up to about ${loss} of what you put in. That is an estimate.`;
const spentFrom = (c: Coin) => `Your ${c.symbol} is spent straight from your own ${c.symbol} account. Nothing is wrapped.`;

// ── addresses, from the pool program's own seed strings ───────────────────────

const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, CP_SWAP_PROGRAM)[0];
/** Fee tier 1: the tier's number is a big-endian u16 in the seed. */
const TIER1 = pda(Buffer.from('amm_config'), Buffer.from([0, 1]));
/** The two mints in the pool program's order: byte order, smaller first. */
const inOrder = (a: PublicKey, b: PublicKey): [PublicKey, PublicKey] => (Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a]);
/** The standard tier-1 address of the pool that pairs `mint` with `coin`. */
function standardPool(coin: Coin, mint: PublicKey): PublicKey {
  const [t0, t1] = inOrder(coin.mint, mint);
  return pda(Buffer.from('pool'), TIER1.toBuffer(), t0.toBuffer(), t1.toBuffer());
}
const vaultOf = (pool: PublicKey, mint: PublicKey) => pda(Buffer.from('pool_vault'), pool.toBuffer(), mint.toBuffer());
const lpMintOf = (pool: PublicKey) => pda(Buffer.from('pool_lp_mint'), pool.toBuffer());

// ── balances, decoded by hand ──────────────────────────────────────────────────

/** A token as a pool holds it: its mint, the program that owns it, its decimals. */
interface TokenSide { mint: PublicKey; program: PublicKey; decimals: number }
const BAYLA_TOKEN: TokenSide = { mint: BAYLA_MINT, program: TOKEN_2022_PROGRAM_ID, decimals: DEC };
const classic = (mint: PublicKey): TokenSide => ({ mint, program: TOKEN_PROGRAM_ID, decimals: DEC });

/** An owner's own account for a coin: the wrapped-SOL account for SOL. */
const coinAccount = (c: Coin, owner: PublicKey) => (c.symbol === 'USDC' ? usdcAccount(owner) : c.symbol === 'BAYLA' ? baylaAccount(owner) : ata(WSOL, owner));
/** Raw units of a coin in an account; null when the account does not exist. USDC and BAYLA check the mint and the program too. */
const coinHeld = (c: Coin, account: PublicKey) => (c.symbol === 'USDC' ? usdcAmount(account) : c.symbol === 'BAYLA' ? baylaAmount(account) : tokenAmount(account));
const tokenAccountOf = (t: TokenSide, owner: PublicKey) => ata(t.mint, owner, t.program);
const tokenHeld = (t: TokenSide, account: PublicKey) => (t.mint.equals(BAYLA_MINT) ? baylaAmount(account) : tokenAmount(account));

interface Rents { r165: bigint; poolAccounts: bigint }
/**
 * Live rents. An opening pays for five accounts that can never be closed: the pool (637
 * bytes), its price record (4075), its share token (82) and its two vaults (165 each,
 * under either token program).
 */
async function liveRents(): Promise<Rents> {
  const [r82, r165, r637, r4075] = (await Promise.all([82, 165, 637, 4075].map((n) => chain().getMinimumBalanceForRentExemption(n)))).map(BigInt) as [bigint, bigint, bigint, bigint];
  return { r165, poolAccounts: r637 + r4075 + r82 + r165 + r165 };
}

/** A price book a fixture can register a fresh token in before any browser exists. */
const bookOf = (prices: Prices): Pick<JupiterStub, 'setPrice'> => ({
  setPrice: (mint, solPerToken, decimals) => void prices.set(mint, { solPerToken, decimals: decimals ?? DEC }),
});

/** What the wallet signed, without the compute-budget lines every transaction carries. */
const signedBody = (a: Actor) => a.wallet.lastSigned().instructions.filter((i) => i.program !== 'compute-budget');
/** A SOL opening wraps the SOL, opens the pool and closes the wrapped-SOL account again. Any other coin is the pool instruction alone. */
const SOL_OPENING = ['create-idempotent', 'wrap-sol', 'sync-native', 'initialize', 'close-wsol'];

// ── opening a pool through the form ────────────────────────────────────────────

/** Press Open a pool, choose `coin` under "Pair with", and wait for the wallet's balance of it (its Max button). */
async function openCreateForm(p: Page, coin: Coin): Promise<Locator> {
  await expect(ui.lp.create.card(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
  await press(ui.lp.create.openButton(p), 'Open a pool');
  const panel = ui.lp.create.panel(p);
  await expect(panel).toBeVisible();
  // The form starts on SOL, the first coin.
  await expect(ui.lp.create.pair(p)).toHaveAttribute('data-coin', 'SOL');
  if (!coin.native) await press(ui.lp.create.pairWith(p, coin.symbol), `Pair with ${coin.symbol}`);
  await expect(ui.lp.create.pair(p)).toHaveAttribute('data-coin', coin.symbol);
  await expect(ui.lp.create.pairWith(p, coin.symbol)).toBeChecked();
  await expect(ui.lp.create.maxCoin(p, coin.symbol)).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Type the coin amount, press Match the market price, and read back the token box the page set. */
async function typeCoinThenMatch(p: Page, coin: Coin, text: string): Promise<{ coinIn: bigint; tokenIn: bigint }> {
  await ui.lp.create.coinToPut(p, coin.symbol).fill(text);
  await press(ui.lp.create.match(p), 'Match the market price');
  await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'agrees');
  await expect(ui.lp.create.tokensToPut(p)).not.toHaveValue('');
  return { coinIn: parseDecimalToBaseUnits(text, coin.decimals)!, tokenIn: parseDecimalToBaseUnits(await ui.lp.create.tokensToPut(p).inputValue(), DEC)! };
}

interface Opening { coin: Coin; token: TokenSide; coinIn: bigint; tokenIn: bigint }

/**
 * Every row of an opening's review, against Node's numbers: where the pool goes, what
 * goes in (in the pool's own coin), the fee and the deposits (always SOL), the shares.
 * `gap` is said for an opening away from the market ("10.0% above"): its price row then
 * says so and an estimated cost follows; at the market neither may be there.
 */
async function checkOpeningRows(rows: Record<string, string>, o: Opening & { market: number; gap?: string }): Promise<{ pool: PublicKey; rents: Rents; supply: bigint }> {
  const rents = await liveRents();
  const { coin, token } = o;
  const d = token.decimals;
  const pool = standardPool(coin, token.mint);
  const supply = isqrt(o.coinIn * o.tokenIn);
  expect(rows['Pool']).toBe(pool.toBase58());
  expect(rows['Pool kind']).toBe('Standard address for fee tier 1');
  expect(rows['Token (mint)']).toBe(token.mint.toBase58());
  expect(rows['Paired with']).toBe(coin.symbol);
  expect(rows['Fee tier']).toMatch(/^1: traders pay /);
  expect(rows['You put in']).toBe(`${coinExact(o.coinIn, coin)} and ${units(o.tokenIn, d)} tokens, exactly`);
  const price = `1 token = ${formatSolPrice(priceOf(o.coinIn, o.tokenIn, d, coin))} ${coin.symbol}. Market (Jupiter, read just now): ${formatSolPrice(o.market)} ${coin.symbol}, `;
  if (o.gap) {
    expect(rows['Opening price']).toBe(`${price}${o.gap}. That is off by more than 3%.`);
    const loss = lossAtMarketUp({ coinAmount: o.coinIn, tokenAmount: o.tokenIn, tokenDecimals: d, marketPricePerToken: o.market, coin });
    expect(rows['Estimated cost of that gap']).toBe(`up to about ${coinExact(loss, coin)} of what you put in`);
  } else {
    expect(rows['Opening price']).toMatch(new RegExp(`^${esc(price)}\\d+\\.\\d% (above|below)$`));
    expect(rows['Estimated cost of that gap'], 'no estimated loss on an opening at the market').toBeUndefined();
  }
  expect(rows['Opens for trading']).toBe('At once (one second after it lands)');
  // The fee and the deposits are SOL, whatever the pool is paired with.
  expect(rows['Fee to open the pool']).toBe(`${solExact(FEE_TO_OPEN)}, paid to the team's vault (into ${FEE_ACCOUNT}, the account the pool program fixes); not refundable`);
  expect(rows['Account deposits that never come back']).toBe(`${solExact(rents.poolAccounts)} (the pool, its price record, its share token and its two vaults; none can be closed)`);
  expect(rows['Your pool-share account']).toBe(`${solExact(rents.r165)} (it comes back if you close that account later)`);
  expect(rows['You get']).toBe(`${units(supply - LOCKED, 9)} pool shares, exactly`);
  // What stays behind on each side, by hand: what went in, less what the opener's own
  // shares (the supply less the locked 100) pay out, rounded down the pool program's way.
  // So it rounds UP and is never 0 (it was floor(100 x put / supply), which said "0 tokens"
  // of a whole-unit token when one whole token stayed behind).
  const stays = (put: bigint) => put - ((supply - LOCKED) * put) / supply;
  expect(stays(o.coinIn) >= 1n && stays(o.tokenIn) >= 1n, 'something stays behind on each side').toBe(true);
  expect(rows['Locked in the pool forever']).toBe(
    `${LOCKED_SHARES}, worth about ${coinAbout(stays(o.coinIn), coin)} and ${tok(stays(o.tokenIn), d)} tokens at these amounts`,
  );
  // The test run, in each thing's own units.
  expect(rows["Test run: the team's vault account gains, in SOL (the fee, plus any SOL that account was already holding)"]).toBe(`+${tok(FEE_TO_OPEN, 9)}`);
  expect(rows['Test run: your pool shares change by']).toBe(signedTok(supply - LOCKED, 9));
  expect(rows['Test run: your tokens change by']).toBe(signedTok(-o.tokenIn, d));
  if (coin.native) {
    // Wrapped in and spent in one transaction: the wrapped-SOL account ends where it began.
    expect(rows['Test run: your wrapped SOL changes by']).toBeUndefined();
  } else {
    expect(rows[`Test run: your ${coin.symbol} changes by`]).toBe(signedTok(-o.coinIn, coin.decimals));
    expect(rows['Test run: your wrapped SOL changes by'], 'nothing is wrapped for a pool that is not paired with SOL').toBeUndefined();
  }
  return { pool, rents, supply };
}

interface Before { token: bigint; coin: bigint | null; fee: bigint }
/** What the opener and the fee account hold just before signing. A SOL opening has no coin account to read. */
async function beforeOpening(owner: PublicKey, o: Opening): Promise<Before> {
  expect(await accountOwner(ata(WSOL, owner)), 'no wrapped-SOL account before').toBeNull();
  return {
    token: (await tokenHeld(o.token, tokenAccountOf(o.token, owner)))!,
    coin: o.coin.native ? null : await coinHeld(o.coin, coinAccount(o.coin, owner)),
    fee: (await tokenAmount(new PublicKey(FEE_ACCOUNT)))!,
  };
}

/**
 * What a landed opening left on chain, read in Node: the pool on fee tier 1 with these two
 * mints, each vault holding exactly what the review said (in its own program), the shares,
 * the fee in SOL in the fee account, the wallet's SOL down by exactly the sum on the
 * review, and no wrapped-SOL account left behind.
 */
async function checkOpenedOnChain(o: Opening & { pool: PublicKey; rents: Rents; supply: bigint; owner: PublicKey; signature: string; before: Before; reviewSolLine: string }): Promise<void> {
  const { coin, token, pool, owner } = o;
  expect(CREATE_POOL_FEE_RECEIVER.toBase58()).toBe(FEE_ACCOUNT);
  const f = await poolFacts(pool);
  const [t0, t1] = inOrder(coin.mint, token.mint);
  expect(f.pool.ammConfig, 'the pool is on fee tier 1').toBe(TIER1.toBase58());
  expect([f.pool.token0Mint, f.pool.token1Mint]).toEqual([t0.toBase58(), t1.toBase58()]);
  expect(f.pool.lpSupply).toBe(o.supply);
  // The vaults: exactly what the review said, each under its own mint's program.
  const coinVault = vaultOf(pool, coin.mint);
  const tokenVault = vaultOf(pool, token.mint);
  expect(await accountOwner(coinVault)).toEqual(coin.program);
  expect(await accountOwner(tokenVault)).toEqual(token.program);
  expect(await accountDataLength(coinVault)).toBe(165);
  expect(await accountDataLength(tokenVault)).toBe(165);
  expect(await coinHeld(coin, coinVault), `the ${coin.symbol} vault`).toBe(o.coinIn);
  expect(await tokenHeld(token, tokenVault), 'the token vault').toBe(o.tokenIn);
  // The shares: classic, and exactly isqrt less the locked 100.
  const lpAccount = ata(lpMintOf(pool), owner);
  expect(await accountOwner(lpAccount), 'the pool-share account is classic').toEqual(TOKEN_PROGRAM_ID);
  expect(await tokenAmount(lpAccount)).toBe(o.supply - LOCKED);
  // What left the wallet.
  expect(o.before.token - (await tokenHeld(token, tokenAccountOf(token, owner)))!, 'the tokens left by exactly the amount on the review').toBe(o.tokenIn);
  if (!coin.native) expect(o.before.coin! - (await coinHeld(coin, coinAccount(coin, owner)))!, `the ${coin.symbol} left by exactly the amount on the review`).toBe(o.coinIn);
  // The fee to open: SOL, into the fee account, whatever the pool is paired with.
  expect((await tokenAmount(new PublicKey(FEE_ACCOUNT)))! - o.before.fee, 'the fee account received exactly the fee, in SOL').toBe(FEE_TO_OPEN);
  // The wallet's SOL: the fee, the five accounts that never close, the pool-share account,
  // the network fee, and (only for a SOL pool) what went into the pool.
  const t = await landedTx(o.signature);
  const delta = lamportDelta(t, owner);
  expect(delta, "the opener's SOL change, worked out in Node").toBe(-((coin.native ? o.coinIn : 0n) + FEE_TO_OPEN + o.rents.poolAccounts + o.rents.r165 + BigInt(t.meta!.fee)));
  expect(signedSol(delta), 'the SOL change is the review\'s test run line').toBe(o.reviewSolLine);
  expect(await accountOwner(ata(WSOL, owner)), 'no wrapped-SOL account after').toBeNull();
}

// ════════════════════════════════════════════════════════════════════════════
// One BAYLA/USDC pool, from its opening to a second deposit made from the position.
// Each step needs the one before it, so they run in order and stop at the first failure.
// ════════════════════════════════════════════════════════════════════════════

const S = {} as { prices: Prices; opener: Keypair; adder: Keypair; stranger: Keypair; market: number; pool: PublicKey };

/** Everything a liquidity change in the BAYLA/USDC pool can move, for one wallet: each amount decoded by hand. */
interface Held { usdc: bigint | null; bayla: bigint; lp: bigint; usdcVault: bigint; baylaVault: bigint; wsol: PublicKey | null }
async function held(owner: PublicKey, pool: PublicKey): Promise<Held> {
  return {
    usdc: await usdcAmount(usdcAccount(owner)),
    bayla: (await baylaAmount(baylaAccount(owner))) ?? 0n,
    lp: (await tokenAmount(ata(lpMintOf(pool), owner))) ?? 0n,
    usdcVault: (await usdcAmount(vaultOf(pool, USDC_MINT)))!,
    baylaVault: (await baylaAmount(vaultOf(pool, BAYLA_MINT)))!,
    wsol: await accountOwner(ata(WSOL, owner)),
  };
}

test.describe('a BAYLA/USDC pool (chromium only)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.skip(test.info().project.name !== 'chromium', 'the standard BAYLA/USDC address exists once per chain, so these steps run once, on chromium');
    test.setTimeout(6 * 60_000);
    const standard = standardPool(USDC_COIN, BAYLA_MINT);
    if (await accountOwner(standard)) {
      throw new Error(`a pool already sits at the standard BAYLA/USDC address ${standard.toBase58()}: this file opens it, so it needs a validator that has not run it before (start-validator.sh wipes the ledger)`);
    }
    // The stub prices USDC and BAYLA in SOL by itself (fixtures/lp.ts COIN_SOL_PRICE).
    S.prices = new Map();
    S.market = marketIn(USDC_COIN, { solPerToken: COIN_SOL_PRICE.BAYLA, decimals: BAYLA_COIN.decimals }, COIN_SOL_PRICE.USDC);
    [S.opener, S.adder, S.stranger] = await Promise.all([fundedKeypair(3), fundedKeypair(2), fundedKeypair(3)]);
    await Promise.all([
      (async () => { await giveBayla(S.opener, bayla(2_000_000)); await giveUsdc(S.opener, usdc(1_000)); })(),
      (async () => { await giveBayla(S.adder, bayla(1_000_000)); await giveUsdc(S.adder, usdc(200)); })(),
      (async () => { await giveBayla(S.stranger, bayla(10_000_000)); await giveUsdc(S.stranger, usdc(5_000)); })(),
    ]);
  });

  test('C1: opening BAYLA/USDC: Pair with USDC, amounts at the market, a review in USDC, and the chain holds exactly that, with nothing wrapped', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    expect(TIER1.toBase58(), 'tier 1 derives to mainnet\'s address').toBe('CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy');
    const a = await actor(browser, S.opener, { prices: S.prices });
    const p = a.page;
    await openPools(p, BAYLA_MINT);
    await connect(p);
    await expect(ui.lp.create.card(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    // BAYLA is itself a pairing coin, so its lookup searched only the coins that outrank
    // it, and the card names them: "no SOL or USDC pool", never a bare "no pool" (a pair
    // that was not looked for is not said to have none).
    await expect(ui.lp.create.card(p)).toContainText('There is no SOL or USDC pool to add liquidity to yet. Opening one is how the first liquidity goes in.');
    await expect(ui.lp.create.card(p)).toContainText('No SOL or USDC pool for this token yet. You can open the first one on the public fee tier:');
    await expect(ui.lp.noPools(p)).toHaveText('No pools pairing this token with SOL or USDC found.');

    const panel = await openCreateForm(p, USDC_COIN);
    // BAYLA is priced in the coins that outrank it: SOL and USDC, never itself.
    await expect(ui.lp.create.pair(p).getByRole('radio')).toHaveCount(2);
    await expect(ui.lp.create.pairWith(p, 'BAYLA')).toHaveCount(0);
    await expect(panel.getByTestId('lp-coin-risk')).toContainText(USDC_RISK);
    await expect(panel.getByTestId('lp-create-first')).toHaveText('No pool pairs this token with USDC yet. Yours would be the first.');
    await expect(ui.lp.create.market(p)).toContainText(`1 token = ${formatSolPrice(S.market)} USDC.`, { timeout: 60_000 });
    const paidInSol = panel.getByTestId('lp-create-paid-in-sol');
    await expect(paidInSol).toContainText('The fee to open (0.15 SOL), the account deposits and the network fee are paid in SOL, whatever the pool is paired with.');
    await expect(paidInSol).toContainText('Only your USDC and your tokens go into the pool.');
    await expect(panel).toContainText(`You have ${coinExact(usdc(1_000), USDC_COIN)}.`, { timeout: 30_000 });

    const { coinIn, tokenIn } = await typeCoinThenMatch(p, USDC_COIN, '100');
    expect(coinIn).toBe(usdc(100));
    expect(tokenIn, 'the token box is the USDC typed, at the market price in USDC').toBe(matchAtMarket({ keep: 'coin', amount: coinIn, pricePerToken: S.market, tokenDecimals: DEC, coin: USDC_COIN }));
    await expect(panel.getByTestId('lp-create-preview')).toContainText(`${coinExact(coinIn, USDC_COIN)} and ${units(tokenIn, DEC)} tokens, exactly`);
    await expect(panel).toContainText(spentFrom(USDC_COIN));
    await expectPressableAtSizes(p, 'C1 form', [
      [ui.lp.create.pairWith(p, 'SOL'), 'Pair with SOL'],
      [ui.lp.create.pairWith(p, 'USDC'), 'Pair with USDC'],
      [ui.lp.create.maxCoin(p, 'USDC'), 'Max USDC'],
      [ui.lp.create.match(p), 'Match the market price'],
      [ui.lp.create.review(p), 'Review: open the pool'],
    ]);

    await expect(ui.lp.create.review(p)).toBeEnabled({ timeout: 30_000 });
    await press(ui.lp.create.review(p), 'Review: open the pool');
    const rows = await reviewRows(p);
    const o: Opening = { coin: USDC_COIN, token: BAYLA_TOKEN, coinIn, tokenIn };
    const { pool, rents, supply } = await checkOpeningRows(rows, { ...o, market: S.market });
    await expect(ui.review(p)).toContainText(`${spentFrom(USDC_COIN)} The fee to open and the account deposits are paid in SOL.`);
    // At the market, and BAYLA cannot be frozen and copies no name: the token and the
    // price give nothing to warn of. What USDC itself adds to the risks is the one warning,
    // first on the review with the others' lead-in, and said once: no row below repeats it.
    await expect(ui.reviewWarnings(p)).toContainText(REVIEW_WARNINGS_LEAD);
    await expect(ui.reviewWarnings(p).getByRole('listitem')).toHaveText([USDC_RISK]);
    await expect(ui.review(p).getByText(USDC_RISK, { exact: true })).toHaveCount(1);
    const reviewSolLine = rows['Test run: your SOL changes by']!;
    const before = await beforeOpening(S.opener.publicKey, o);

    const { signature } = await signConfirmed(a);
    // What was signed: the pool instruction alone. Nothing wrapped, no account opened.
    const body = signedBody(a);
    expect(body.map((i) => i.name)).toEqual(['initialize']);
    const init = body[0]!;
    expect(init.args).toMatchObject({ pairedWith: 'USDC', origin: 'standard', openTime: '0' });
    expect(init.accounts.pool_state).toBe(pool.toBase58());
    expect(init.accounts.amm_config).toBe(TIER1.toBase58());
    expect(init.accounts.create_pool_fee).toBe(FEE_ACCOUNT);
    const usdcIs0 = inOrder(USDC_MINT, BAYLA_MINT)[0].equals(USDC_MINT);
    expect([init.args.initAmount0, init.args.initAmount1]).toEqual((usdcIs0 ? [coinIn, tokenIn] : [tokenIn, coinIn]).map(String));
    expect(a.wallet.signed().flatMap((r) => r.instructions).some((i) => i.program === 'token-2022'), 'no top-level Token-2022 instruction').toBe(false);
    await checkOpenedOnChain({ ...o, pool, rents, supply, owner: S.opener.publicKey, signature, before, reviewSolLine });
    S.pool = pool;

    // The page afterwards: the pool is listed as a USDC pool, and the share has both buttons.
    await expect(panel).toContainText(`Your pool is open at ${pool.toBase58()}. Swaps can start one second after it landed.`);
    await closeAll(p, panel);
    const card = poolCard(p, pool);
    await expect(card).toHaveAttribute('data-quote', 'USDC', { timeout: 60_000 });
    await expect(card).toContainText("You opened this pool just now. Your share is under 'Your positions'.");
    await expect(ui.lp.create.card(p).getByTestId('lp-create-opened')).toContainText(`You opened a USDC pool for this token just now (${pool.toBase58()}).`);
    const row = positionRow(p, pool);
    await expect(row).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
    await expect(ui.lp.addMore(row)).toBeVisible();
    expect(a.wallet.signed()).toHaveLength(1);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('C2: a second wallet adds to it by typing USDC: the review is in USDC, and the chain moves exactly that', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    await waitPoolOpenByWallClock(S.pool);
    const owner = S.adder.publicKey;
    const a = await actor(browser, S.adder, { prices: S.prices });
    const p = a.page;
    await openPools(p, BAYLA_MINT);
    await connect(p);
    const card = poolCard(p, S.pool);
    await expect(card).toHaveAttribute('data-quote', 'USDC', { timeout: 60_000 });
    await expect(card).toHaveAttribute('data-origin', 'standard');
    await expect(card).toHaveAttribute('data-price', 'agrees');
    await expect(card).toHaveAttribute('data-deposits', 'allowed');
    await expect(card).toContainText(`1 token = ${formatSolPrice(S.market)} USDC`);

    const { panel } = await openAdd(p, S.pool, USDC_COIN);
    await expect(panel.getByTestId('lp-add-coin-risk')).toContainText(USDC_RISK);
    await expect(panel).toContainText(`You have ${coinExact(usdc(200), USDC_COIN)}.`);
    await ui.lp.coinToAdd(panel, 'USDC').fill('10');
    await expect(ui.lp.reviewAdd(panel)).toBeEnabled({ timeout: 30_000 });
    await expectPressableAtSizes(p, 'C2 add', [[ui.lp.maxCoin(panel, 'USDC'), 'Max USDC'], [ui.lp.reviewAdd(panel), 'Review: add liquidity']]);

    const typed = usdc(10);
    const { rows, plan, s } = await reviewDeposit(a, panel, S.pool, 'coin', typed);
    expect(s.coin.symbol).toBe('USDC');
    expect(rows['Pool kind']).toBe('Standard address for fee tier 1');
    // The typed amount is the most USDC that can leave, to the last unit.
    expect(plan.maxSol).toBe(typed);
    expect(rows['At most']).toBe(`${coinExact(typed, USDC_COIN)} and ${units(plan.maxTok, DEC)} tokens`);
    expect(rows['Price check']).toMatch(/^\d+\.\d% (above|below) the outside price \(Jupiter\), read just now$/);
    expect(rows['Test run: your USDC changes by']).toBe(signedTok(-plan.costSol, USDC_COIN.decimals));
    expect(rows['Test run: your tokens change by']).toBe(signedTok(-plan.costTok, DEC));
    expect(rows['Test run: your pool shares change by']).toBe(signedTok(plan.lp, 9));
    expect(rows['Test run: your wrapped SOL changes by']).toBeUndefined();
    await expect(ui.review(p)).toContainText(`${spentFrom(USDC_COIN).replace(/\.$/, '')}, and what the pool does not use never leaves that account.`);
    // The pool is at the market: the one warning on the review is USDC's own, said once.
    await expect(ui.reviewWarnings(p).getByRole('listitem')).toHaveText([USDC_RISK]);
    await expect(ui.review(p).getByText(USDC_RISK, { exact: true })).toHaveCount(1);
    const reviewSolLine = rows['Test run: your SOL changes by']!;
    const before = await held(owner, S.pool);
    expect(before.wsol, 'no wrapped-SOL account before').toBeNull();
    expect(before.lp).toBe(0n);

    const { t } = await signConfirmed(a);
    // What was signed: its pool-share account opened, then the deposit. Nothing wrapped.
    const body = signedBody(a);
    expect(body.map((i) => i.name)).toEqual(['create-idempotent', 'deposit']);
    expect(body[0]!.accounts.mint).toBe(lpMintOf(S.pool).toBase58());
    const d = a.wallet.lastIx('deposit');
    expect(d.accounts.pool_state).toBe(S.pool.toBase58());
    expect(d.args).toEqual({
      lpTokenAmount: String(plan.lp),
      maximumToken0Amount: String(s.coinIs0 ? plan.maxSol : plan.maxTok),
      maximumToken1Amount: String(s.coinIs0 ? plan.maxTok : plan.maxSol),
      pairedWith: 'USDC',
    });
    // What moved, read from the chain.
    const after = await held(owner, S.pool);
    expect(before.usdc! - after.usdc!, 'the USDC that left the wallet').toBe(plan.costSol);
    expect(plan.costSol <= typed, 'never more than the USDC typed').toBe(true);
    expect(after.usdcVault - before.usdcVault, 'the USDC the pool received').toBe(plan.costSol);
    expect(before.bayla - after.bayla).toBe(plan.costTok);
    expect(after.baylaVault - before.baylaVault).toBe(plan.costTok);
    expect(after.lp, 'the shares are exactly the review\'s').toBe(plan.lp);
    // The only SOL that left: the pool-share account's deposit and the network fee.
    const delta = lamportDelta(t, owner);
    expect(delta).toBe(-((await liveRents()).r165 + BigInt(t.meta!.fee)));
    expect(signedSol(delta), 'the SOL change is the test run line').toBe(reviewSolLine);
    expect(after.wsol, 'no wrapped-SOL account after').toBeNull();

    await closeAll(p, panel);
    await expect(positionRow(p, S.pool)).toHaveCount(1, { timeout: 60_000 });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('C3: it takes 50% out, then all of it: the USDC arrives in its own USDC account, opened again when it is missing, never as wrapped SOL', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    const owner = S.adder.publicKey;
    const usdcAcc = usdcAccount(owner);
    const { r165 } = await liveRents();
    const a = await actor(browser, S.adder, { prices: S.prices });
    const p = a.page;
    await openPools(p);
    await connect(p);
    const row = positionRow(p, S.pool);

    for (const [label, bps] of [['50%', 5_000n], ['All', 10_000n]] as const) {
      const missing = label === 'All';
      if (missing) {
        // In Node: the wallet's USDC goes elsewhere and its USDC account is closed, so the
        // withdrawal has to open it again.
        await closeTokenAccount(S.adder, USDC_MINT, TOKEN_PROGRAM_ID);
        expect(await accountOwner(usdcAcc), 'the USDC account is gone').toBeNull();
      }
      const panel = await openRemove(row);
      await press(ui.lp.percent(panel, label), label);
      await expect(ui.lp.reviewRemove(panel)).toBeEnabled({ timeout: 30_000 });
      await press(ui.lp.reviewRemove(panel), 'Review: remove liquidity');
      const rows = await reviewRows(p);
      const f = await poolFacts(S.pool);
      const s = sidesOf(f);
      const before = await held(owner, S.pool);
      const plan = withdrawPlan(f, before.lp, bps);
      expect(rows['Pool']).toBe(S.pool.toBase58());
      expect(rows['Paired with']).toBe('USDC');
      expect(rows['Pool shares you give back']).toMatch(new RegExp(`^${esc(units(plan.lp, 9))}`));
      expect(rows['You get about']).toBe(`${coinAbout(plan.outSol, USDC_COIN)} and ${tok(plan.outTok, DEC)} tokens`);
      expect(rows['You get at least']).toBe(`${coinExact(plan.minSol, USDC_COIN)} and ${units(plan.minTok, DEC)} tokens`);
      expect(rows['You keep']).toBe(plan.keep > 0n ? `${units(plan.keep, 9)} pool shares` : 'none in this pool');
      // Where each side lands: the wallet's own accounts. A USDC pool never says "The SOL arrives".
      expect(rows['The SOL arrives']).toBeUndefined();
      expect(rows['The tokens arrive in']).toBe(baylaAccount(owner).toBase58());
      expect(rows['The USDC arrives in']).toBe(missing ? `${usdcAcc.toBase58()} (opened for you; its deposit of ${solExact(r165)} stays in that account)` : usdcAcc.toBase58());
      expect(rows['One-time deposit for your new USDC account (it stays in that account)']).toBe(missing ? SOL(r165) : undefined);
      expect(rows['Test run: your USDC changes by']).toMatch(/^\+/);
      expect(rows['Test run: your wrapped SOL changes by']).toBeUndefined();
      if (missing) await expect(ui.review(p)).toContainText('This is all of your share in this pool.');
      const reviewSolLine = rows['Test run: your SOL changes by']!;

      const { t } = await signConfirmed(a);
      // What was signed: both payout accounts opened if missing, then the withdrawal.
      const body = signedBody(a);
      expect(body.map((i) => i.name)).toEqual(['create-idempotent', 'create-idempotent', 'withdraw']);
      expect(body.slice(0, 2).map((i) => i.accounts.account).sort()).toEqual([baylaAccount(owner).toBase58(), usdcAcc.toBase58()].sort());
      expect(a.wallet.lastIx('withdraw').args).toEqual({
        lpTokenAmount: String(plan.lp),
        minimumToken0Amount: String(s.coinIs0 ? plan.minSol : plan.minTok),
        minimumToken1Amount: String(s.coinIs0 ? plan.minTok : plan.minSol),
        pairedWith: 'USDC',
      });
      // What moved, read from the chain.
      const after = await held(owner, S.pool);
      expect(before.lp - after.lp, 'the shares burned are exactly the plan').toBe(plan.lp);
      const paidUsdc = before.usdcVault - after.usdcVault;
      const paidBayla = before.baylaVault - after.baylaVault;
      expect(paidUsdc, 'the pool paid the USDC the review worked out').toBe(plan.outSol);
      expect(paidBayla).toBe(plan.outTok);
      expect(paidUsdc >= plan.minSol && paidBayla >= plan.minTok, 'at least the minimums').toBe(true);
      expect(await accountOwner(usdcAcc), 'the USDC account is a classic token account of this wallet').toEqual(TOKEN_PROGRAM_ID);
      expect(after.usdc! - (before.usdc ?? 0n), 'the USDC arrived in the wallet\'s own USDC account').toBe(paidUsdc);
      expect(after.bayla - before.bayla).toBe(paidBayla);
      // SOL: the network fee, and the new USDC account's deposit when it had to be opened.
      const delta = lamportDelta(t, owner);
      expect(delta).toBe(-(BigInt(t.meta!.fee) + (missing ? r165 : 0n)));
      expect(signedSol(delta), 'the SOL change is the test run line').toBe(reviewSolLine);
      expect(after.wsol, 'no wrapped-SOL account, before or after').toBeNull();

      await closeAll(p, panel, { rowGoes: missing });
      if (!missing) await expect(row).toContainText(tok(after.lp, 9), { timeout: 60_000 });
    }
    expect((await held(owner, S.pool)).lp).toBe(0n);
    await expect(row).toHaveCount(0, { timeout: 60_000 });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('C4: Add more liquidity on the position ends in that pool\'s own Add form, not the deeper pool\'s, and the deposit lands there', async ({ browser }) => {
    test.setTimeout(8 * 60_000);
    // A second BAYLA/USDC pool at its own address, twenty times deeper and at the same
    // price: it takes deposits too, and is listed first. A press that forgot which pool the
    // position is in would open the Add form there.
    const deepUsdc = usdc(2_000);
    const deepBayla = matchAtMarket({ keep: 'coin', amount: deepUsdc, pricePerToken: S.market, tokenDecimals: DEC, coin: USDC_COIN });
    const deeper = await createPairPool(S.stranger, BAYLA_MINT, { coin: USDC_COIN, configIndex: 1, coinAmount: deepUsdc, tokens: deepBayla, at: 'fresh', tokenProgram: TOKEN_2022_PROGRAM_ID });
    expect(deeper.standard).toBe(false);
    expect((await usdcAmount(vaultOf(deeper.address, USDC_MINT)))! > (await usdcAmount(vaultOf(S.pool, USDC_MINT)))!, 'the other pool is the deeper one').toBe(true);
    await waitPoolOpenByWallClock(deeper.address);

    const owner = S.opener.publicKey;
    const a = await actor(browser, S.opener, { prices: S.prices });
    const p = a.page;
    await openPools(p);
    await connect(p);
    const row = positionRow(p, S.pool);
    await expect(row).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
    await expectPressableAtSizes(p, 'C4 position', [[ui.lp.removeButton(row), 'Remove liquidity'], [ui.lp.addMore(row), 'Add more liquidity']]);
    await press(ui.lp.addMore(row), 'Add more liquidity');

    // The finder looked BAYLA up. Both pools are listed, the deeper one first, and it offers Add as well.
    await expect(ui.lp.safety(p)).toContainText(BAYLA_MINT.toBase58(), { timeout: 60_000 });
    const mine = poolCard(p, S.pool);
    const other = poolCard(p, deeper.address);
    await expect(mine).toBeVisible({ timeout: 60_000 });
    await expect(other).toBeVisible();
    await expect(other).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
    const listed = await ui.lp.pools(p).evaluateAll((els) => els.map((e) => e.getAttribute('data-pool')));
    expect(listed.indexOf(deeper.address.toBase58()), 'the deeper pool is listed first').toBeLessThan(listed.indexOf(S.pool.toBase58()));
    // The Add form is open on the position's own pool, and nowhere else.
    const panel = ui.lp.addPanel(mine);
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(ui.lp.addPanel(p)).toHaveCount(1);
    await expect(ui.lp.addPanel(other)).toHaveCount(0);
    await expect(panel).toContainText(S.pool.toBase58());
    await expect(panel).not.toContainText(deeper.address.toBase58());

    // And the deposit made there goes to that pool.
    await expect(ui.lp.maxCoin(panel, 'USDC')).toBeVisible({ timeout: 30_000 });
    await ui.lp.coinToAdd(panel, 'USDC').fill('5');
    await expect(ui.lp.reviewAdd(panel)).toBeEnabled({ timeout: 30_000 });
    const { plan } = await reviewDeposit(a, panel, S.pool, 'coin', usdc(5));
    const before = await held(owner, S.pool);
    const otherBefore = (await usdcAmount(vaultOf(deeper.address, USDC_MINT)))!;
    await signConfirmed(a);
    expect(a.wallet.lastIx('deposit').accounts.pool_state).toBe(S.pool.toBase58());
    const after = await held(owner, S.pool);
    expect(after.usdcVault - before.usdcVault, 'the position\'s own pool received the USDC').toBe(plan.costSol);
    expect(before.usdc! - after.usdc!).toBe(plan.costSol);
    expect(after.lp - before.lp).toBe(plan.lp);
    expect(await usdcAmount(vaultOf(deeper.address, USDC_MINT)), 'the deeper pool is untouched').toBe(otherBefore);
    expect(after.wsol).toBeNull();

    // The control. The same page, asked to add WITHOUT naming a pool (the finder's own Add
    // liquidity button, with BAYLA already looked up), opens the form on the deeper pool.
    // So that is where a press that forgot its pool would have ended, and the position's
    // button did carry its pool.
    await closeAll(p, panel);
    await press(p.getByTestId('lp-tasks').getByRole('button', { name: 'Add liquidity', exact: true }), 'Add liquidity, no pool named');
    await expect(ui.lp.addPanel(other)).toBeVisible({ timeout: 60_000 });
    await expect(ui.lp.addPanel(p)).toHaveCount(1);
    await expect(ui.lp.addPanel(mine)).toHaveCount(0);
    expect(a.wallet.signed()).toHaveLength(1);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Openings that stand alone: the third coin, and the two warnings that used to be refusals.
// ════════════════════════════════════════════════════════════════════════════

const T = {} as {
  prices: Prices;
  c5: Keypair; t5: PublicKey;
  c6: Keypair; t6: PublicKey;
  c7: Keypair; t7: PublicKey;
};

test.describe('one opening each (chromium only)', () => {
  test.beforeAll(async () => {
    test.skip(test.info().project.name !== 'chromium', 'chain-heavy, and the forms\' layout is checked at three widths inside the tests');
    test.setTimeout(6 * 60_000);
    T.prices = new Map();
    const book = bookOf(T.prices);
    await Promise.all([
      (async () => {
        T.c5 = await fundedKeypair(3);
        T.t5 = await freshPricedToken(T.c5, book);
        await giveBayla(T.c5, bayla(100_000));
      })(),
      (async () => {
        T.c6 = await fundedKeypair(3);
        // Its creator keeps the freeze authority: the token the site used to block.
        T.t6 = await createClassicToken(T.c6, { supply: 10_000_000n * UNIT, freezable: true, name: { name: 'E2E Coins Freezable', symbol: 'ECFRZ' } });
        book.setPrice(T.t6.toBase58(), FAIR, DEC);
      })(),
      (async () => {
        T.c7 = await fundedKeypair(3);
        T.t7 = await freshPricedToken(T.c7, book);
      })(),
    ]);
  });

  test('C5: an opening paired with BAYLA: a token priced in BAYLA, the BAYLA spent from its own account under the newer token program', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const owner = T.c5.publicKey;
    const a = await actor(browser, T.c5, { prices: T.prices });
    const p = a.page;
    await openPools(p, T.t5);
    await connect(p);
    const panel = await openCreateForm(p, BAYLA_COIN);
    // An ordinary token can be paired with all three.
    await expect(ui.lp.create.pair(p).getByRole('radio')).toHaveCount(3);
    const market = marketIn(BAYLA_COIN, { solPerToken: FAIR, decimals: DEC }, COIN_SOL_PRICE.BAYLA);
    await expect(ui.lp.create.market(p)).toContainText(`1 token = ${formatSolPrice(market)} BAYLA.`, { timeout: 60_000 });
    await expect(panel.getByTestId('lp-create-first')).toHaveText('No pool pairs this token with BAYLA yet. Yours would be the first.');
    await expect(panel).toContainText(`You have ${coinExact(bayla(100_000), BAYLA_COIN)}.`, { timeout: 30_000 });

    const { coinIn, tokenIn } = await typeCoinThenMatch(p, BAYLA_COIN, '1000');
    expect(coinIn).toBe(bayla(1_000));
    expect(tokenIn, 'the token box is the BAYLA typed, at the market price in BAYLA').toBe(matchAtMarket({ keep: 'coin', amount: coinIn, pricePerToken: market, tokenDecimals: DEC, coin: BAYLA_COIN }));
    await expect(ui.lp.create.review(p)).toBeEnabled({ timeout: 30_000 });
    await press(ui.lp.create.review(p), 'Review: open the pool');
    const rows = await reviewRows(p);
    const o: Opening = { coin: BAYLA_COIN, token: classic(T.t5), coinIn, tokenIn };
    const { pool, rents, supply } = await checkOpeningRows(rows, { ...o, market });
    await expect(ui.review(p)).toContainText(`${spentFrom(BAYLA_COIN)} The fee to open and the account deposits are paid in SOL.`);
    // The freeze warning is USDC's own: BAYLA has no issuer who can freeze a pool's account.
    await expect(ui.review(p)).not.toContainText('Circle');
    const reviewSolLine = rows['Test run: your SOL changes by']!;
    const before = await beforeOpening(owner, o);

    const { signature } = await signConfirmed(a);
    const body = signedBody(a);
    expect(body.map((i) => i.name)).toEqual(['initialize']);
    expect(body[0]!.args).toMatchObject({ pairedWith: 'BAYLA', origin: 'standard', openTime: '0' });
    expect(body[0]!.accounts.pool_state).toBe(pool.toBase58());
    // The BAYLA moves inside the pool instruction: the wallet is never asked for a Token-2022 instruction of its own.
    expect(a.wallet.signed().flatMap((r) => r.instructions).some((i) => i.program === 'token-2022'), 'no top-level Token-2022 instruction').toBe(false);
    await checkOpenedOnChain({ ...o, pool, rents, supply, owner, signature, before, reviewSolLine });

    await closeAll(p, panel);
    await expect(poolCard(p, pool)).toHaveAttribute('data-quote', 'BAYLA', { timeout: 60_000 });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('C6: a token its creator can freeze: the warning is on the card, in the form and on the review, and the pool opens', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const owner = T.c6.publicKey;
    expect((await mintFacts(T.t6)).freezeAuthority?.toBase58(), 'the creator still holds the freeze authority').toBe(owner.toBase58());
    const a = await actor(browser, T.c6, { prices: T.prices });
    const p = a.page;
    await openPools(p, T.t6);
    // Allowed, with warnings: not blocked.
    await expect(ui.lp.safety(p)).toHaveAttribute('data-verdict', 'warn');
    await expect(ui.lp.safety(p)).toContainText(freezeOnToken(owner));
    await connect(p);
    // 1. On the card, before its button.
    await expect(ui.lp.create.card(p)).toHaveAttribute('data-create', 'offer', { timeout: 60_000 });
    await expect(ui.lp.create.cautions(p)).toContainText('Read these about this token first:');
    await expect(ui.lp.create.cautions(p)).toContainText(freezeOnToken(owner));
    // 2. In the form, above Review, which stays on.
    const panel = await openCreateForm(p, SOL_COIN);
    const market = marketIn(SOL_COIN, { solPerToken: FAIR, decimals: DEC }, 1);
    const { coinIn, tokenIn } = await typeCoinThenMatch(p, SOL_COIN, '0.5');
    await expect(ui.lp.create.warnings(p)).toContainText(FREEZE_ON_OPENING);
    await expect(ui.lp.create.review(p)).toBeEnabled({ timeout: 30_000 });
    await expectPressableAtSizes(p, 'C6 form', [[ui.lp.create.review(p), 'Review: open the pool']]);
    // 3. On the review, first, from the builder's own fresh read of the token.
    await press(ui.lp.create.review(p), 'Review: open the pool');
    const rows = await reviewRows(p);
    const o: Opening = { coin: SOL_COIN, token: classic(T.t6), coinIn, tokenIn };
    const { pool, rents, supply } = await checkOpeningRows(rows, { ...o, market });
    await expect(ui.reviewWarnings(p)).toContainText(REVIEW_WARNINGS_LEAD);
    await expect(ui.reviewWarnings(p)).toContainText(FREEZE_ON_OPENING);
    await expect(ui.review(p)).toContainText(freezeOnToken(owner));
    const reviewSolLine = rows['Test run: your SOL changes by']!;
    const before = await beforeOpening(owner, o);

    const { signature } = await signConfirmed(a);
    expect(signedBody(a).map((i) => i.name)).toEqual(SOL_OPENING);
    expect(a.wallet.lastIx('initialize').args).toMatchObject({ pairedWith: 'SOL', origin: 'standard' });
    await checkOpenedOnChain({ ...o, pool, rents, supply, owner, signature, before, reviewSolLine });
    // Still a token its creator can freeze: the site opened the pool knowing it.
    expect((await mintFacts(T.t6)).freezeAuthority?.toBase58()).toBe(owner.toBase58());

    // Its pool then takes deposits, and says the same risk on its own card.
    await closeAll(p, panel);
    await waitPoolOpenByWallClock(pool);
    await press(ui.lp.findButton(p), 'Find pools');
    const card = poolCard(p, pool);
    await expect(card).toHaveAttribute('data-deposits', 'allowed', { timeout: 60_000 });
    await expect(card).toHaveAttribute('data-add', 'offer');
    await expect(card).toContainText('Deposits: the checks pass, with warnings');
    await expect(ui.lp.poolWarnings(card)).toContainText(FREEZE_ON_POOL);
    expect(a.wallet.signed()).toHaveLength(1);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('C7: an opening 10% above the market: the estimated loss is in the form and on the review, Review stays on, and it lands at that price', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const owner = T.c7.publicKey;
    const a = await actor(browser, T.c7, { prices: T.prices });
    const p = a.page;
    await openPools(p, T.t7);
    await connect(p);
    const panel = await openCreateForm(p, SOL_COIN);
    const market = marketIn(SOL_COIN, { solPerToken: FAIR, decimals: DEC }, 1);
    // 1 SOL against the tokens 1 SOL buys at 1.1 times the market price.
    const coinIn = 1_000_000_000n;
    const tokenIn = matchAtMarket({ keep: 'coin', amount: coinIn, pricePerToken: market * 1.1, tokenDecimals: DEC, coin: SOL_COIN });
    await ui.lp.create.solToPut(p).fill('1');
    await ui.lp.create.tokensToPut(p).fill(tokensToInput(tokenIn));
    const gap = '10.0% above';
    expect(`${((priceOf(coinIn, tokenIn, DEC, SOL_COIN) / market - 1) * 100).toFixed(1)}% above`).toBe(gap);
    const loss = lossAtMarketUp({ coinAmount: coinIn, tokenAmount: tokenIn, tokenDecimals: DEC, marketPricePerToken: market, coin: SOL_COIN });
    expect(loss > 2_000_000n && loss < 2_400_000n, `about 0.0022 SOL on 1 SOL, worked out here as ${loss} lamports`).toBe(true);

    // In the form: the price line says how far off, and the warnings say what it may cost.
    await expect(ui.lp.create.price(p)).toHaveAttribute('data-price', 'disagrees');
    await expect(ui.lp.create.price(p)).toHaveText(
      `Your opening price: 1 token = ${formatSolPrice(priceOf(coinIn, tokenIn, DEC, SOL_COIN))} SOL. Market: ${formatSolPrice(market)} SOL. Yours is ${gap} the market.`,
    );
    const warnings = ui.lp.create.warnings(p);
    await expect(warnings).toContainText(offMarketLine(gap));
    await expect(warnings).toContainText(lossLine(coinExact(loss, SOL_COIN)));
    await expect(warnings).toContainText('Match the market price to avoid that, or go on at your own price.');
    // A warning, not a stop.
    await expect(ui.lp.create.review(p)).toBeEnabled({ timeout: 30_000 });
    await expectPressableAtSizes(p, 'C7 form', [[ui.lp.create.review(p), 'Review: open the pool']]);

    // On the review: the same two sentences first, the price row says it is off, and the cost has its own row.
    await press(ui.lp.create.review(p), 'Review: open the pool');
    const rows = await reviewRows(p);
    const o: Opening = { coin: SOL_COIN, token: classic(T.t7), coinIn, tokenIn };
    const { pool, rents, supply } = await checkOpeningRows(rows, { ...o, market, gap });
    await expect(ui.reviewWarnings(p)).toContainText(REVIEW_WARNINGS_LEAD);
    await expect(ui.reviewWarnings(p)).toContainText(offMarketLine(gap));
    await expect(ui.reviewWarnings(p)).toContainText(lossLine(coinExact(loss, SOL_COIN)));
    const reviewSolLine = rows['Test run: your SOL changes by']!;
    const before = await beforeOpening(owner, o);

    const { signature } = await signConfirmed(a);
    expect(signedBody(a).map((i) => i.name)).toEqual(SOL_OPENING);
    // It landed at the price typed: the vaults hold exactly the two amounts.
    await checkOpenedOnChain({ ...o, pool, rents, supply, owner, signature, before, reviewSolLine });

    // The pool's own card then carries the gap as a warning, and still takes deposits.
    await closeAll(p, panel);
    await waitPoolOpenByWallClock(pool);
    await press(ui.lp.findButton(p), 'Find pools');
    const card = poolCard(p, pool);
    await expect(card).toHaveAttribute('data-price', 'disagrees', { timeout: 60_000 });
    await expect(card).toHaveAttribute('data-deposits', 'allowed');
    await expect(ui.lp.poolWarnings(card)).toContainText(`Its price is ${gap} the outside price. A deposit here would hand that gap to the first arbitrage trade.`);
    expect(a.wallet.signed()).toHaveLength(1);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });
});
