// Adding and removing liquidity on /pools, end to end, against the mainnet cp-swap binary
// on the local validator (SPEC_S2 5.6, E1-E19, with the addendum's amendments).
//
// The page is the thing under test, so every money assertion is made HERE, from the chain,
// in Node: what the review should say is worked out from a fresh read of the pool
// (liquidityMath's own plans, run on poolFacts), what was signed is read from the test
// wallet's records (its guard decoded the exact bytes), and what moved is read from the
// accounts and the landed transaction afterwards. Every button pressed is checked with
// elementFromPoint (expectClickable), never only toBeVisible, and every scenario ends with
// the RPC guard's violations empty (no getProgramAccounts, nothing production refuses).
//
// Group A runs on chromium AND mobile-chrome against one chain, so each project makes its
// own token and pools in its own beforeAll, and every expectation is computed from the
// chain at the time. Group B is chromium only: it is chain-heavy, and group A covers its
// layout.
import { test, expect, type Locator } from '@playwright/test';
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  WSOL, accountDataLength, accountOwner, ata, chain, fundedKeypair, graduateDirect, lamportDelta, lamports, landedTx, mintFacts, poolFacts,
  reassignAtaOwner, sol, swapDirect, tokenAmount, wrapSol, CP_SWAP_PROGRAM, LAUNCH_PROGRAM, type PoolFacts,
} from './fixtures/chain';
import {
  closeTokenAccount, createClassicToken, createSolPool, createToken2022MetadataOnly, freezeVault,
  squatStandard, transferLp, transferTokens, type CreatedPool,
} from './fixtures/lp';
import {
  actor, addAndReview, closeAll, connect, ensureConnected, esc, openAdd, openPools, openRemove, pct, pendingNotes, poolCard, positionRow, press, pressable,
  reviewDeposit, reviewRows, shareText, sidesOf, signConfirmed, signedSol, signedTok, solExact, tok, units, withdrawPlan, type Prices,
} from './fixtures/lpPage';
import { ui, expectPressableAtSizes } from './fixtures/ui';
import { formatSol, parseDecimalToBaseUnits } from '../src/lib/launcher/solana/curve/format';
import { poolStatePda } from '../src/lib/launcher/solana/curve/program';
import { withdrawIx } from '../src/lib/solana/cpswap/ix';
import { deriveAmmConfig, derivePool, sortMints } from '../src/lib/solana/cpswap/program';
import { feeSplit } from '../src/lib/solana/cpswap/venue';
import { feeRateText } from '../src/lib/solana/lp/format';
import { feeReserveFor, minLpForBothSides, spendableSol } from '../src/lib/solana/lp/liquidityMath';

const DEC = 6;
const UNIT = 10n ** BigInt(DEC);
/** Every priced token is quoted at 1 SOL per million tokens, and its pools are opened there. */
const FAIR = 1e-6;
const TEN_YEARS = 10 * 365 * 86_400;

const priced = (...mints: PublicKey[]): Prices => new Map(mints.map((m) => [m.toBase58(), { solPerToken: FAIR, decimals: DEC }]));

/** Every token balance a liquidity change can move, for one wallet and one pool. */
interface Books { lamports: bigint; token: bigint; lp: bigint; wsol: bigint | null; solVault: bigint; tokenVault: bigint }
async function books(owner: PublicKey, f: PoolFacts): Promise<Books> {
  const s = sidesOf(f);
  return {
    lamports: await lamports(owner),
    token: (await tokenAmount(ata(s.tokenMint, owner, s.tokenProgram))) ?? 0n,
    lp: (await tokenAmount(ata(s.lpMint, owner))) ?? 0n,
    wsol: await tokenAmount(ata(WSOL, owner)),
    solVault: (await tokenAmount(s.solVault)) ?? 0n,
    tokenVault: (await tokenAmount(s.tokenVault)) ?? 0n,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// GROUP A: chromium AND mobile-chrome. One clean classic token, its pools on tier 1
// ("pool A") and tier 0 ("pool B") at the stub price, opened by the creator; wallet B.
// ════════════════════════════════════════════════════════════════════════════

const A = {} as { creator: Keypair; walletB: Keypair; mint: PublicKey; poolA: CreatedPool; poolB: CreatedPool; prices: Prices };

test.describe('group A (chromium and mobile-chrome)', () => {
  test.beforeAll(async () => {
    test.setTimeout(8 * 60_000);
    A.creator = await fundedKeypair(20);
    A.walletB = await fundedKeypair(10);
    A.mint = await createClassicToken(A.creator, { supply: 10_000_000n * UNIT, name: { name: 'E2E Write A', symbol: 'EWRA' } });
    A.poolA = await createSolPool(A.creator, A.mint, { configIndex: 1, sol: sol(2), tokens: 2_000_000n * UNIT, at: 'standard' });
    A.poolB = await createSolPool(A.creator, A.mint, { configIndex: 0, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'standard' });
    await transferTokens(A.creator, A.walletB.publicKey, A.mint, 2_000_000n * UNIT);
    A.prices = priced(A.mint);
  });

  test('E1: wallet B adds to pool A by typing SOL; the review is the plan, the chain moves exactly that, and the position appears', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, A.walletB, { prices: A.prices });
    const p = a.page;
    await openPools(p, A.mint);
    await connect(p);
    const { card, panel } = await addAndReview(a, A.poolA.address, '0.5');
    await expectPressableAtSizes(p, 'E1 add', [[ui.lp.addButton(card), 'Add liquidity'], [ui.lp.maxSol(panel), 'Max SOL'], [ui.lp.reviewAdd(panel), 'Review: add liquidity']]);

    const { rows, f, plan, s } = await reviewDeposit(a, panel, A.poolA.address, 'sol', sol(0.5));
    expect(rows['Pool kind']).toBe('Standard address for fee tier 1');
    expect(rows['Your share of the pool']).toBe(`none → ${shareText(pct(plan.lp, f.pool.lpSupply + plan.lp))}`);
    expect(rows['Pool fee to add']).toBe('none');
    await expectPressableAtSizes(p, 'E1 review', [[ui.signButton(p), 'Sign in wallet']]);
    const testRunSol = rows['Test run: your SOL changes by'];
    const before = await books(A.walletB.publicKey, f);
    expect(before.wsol, 'wallet B holds no wrapped-SOL account before').toBeNull();

    const { t } = await signConfirmed(a);
    // What was signed is the plan, to the unit.
    const d = a.wallet.lastIx('deposit');
    expect(d.accounts.pool_state).toBe(A.poolA.address.toBase58());
    expect(d.args).toEqual({
      lpTokenAmount: String(plan.lp),
      maximumToken0Amount: String(s.solIs0 ? plan.maxSol : plan.maxTok),
      maximumToken1Amount: String(s.solIs0 ? plan.maxTok : plan.maxSol),
    });
    // What moved, read from the chain.
    const after = await books(A.walletB.publicKey, f);
    expect(after.lp - before.lp).toBe(plan.lp);
    expect(before.token - after.token).toBe(plan.costTok);
    expect(before.token - after.token <= plan.maxTok).toBe(true);
    expect(after.solVault - before.solVault).toBe(plan.costSol);
    expect(signedSol(lamportDelta(t, A.walletB.publicKey)), 'the SOL change is the test run line').toBe(testRunSol);
    expect(after.wsol, 'the wrapped-SOL account is closed again').toBeNull();
    expect(await accountOwner(ata(WSOL, A.walletB.publicKey))).toBeNull();

    // Back to the page: the position is there, with its share of the pool.
    await closeAll(p, panel);
    const supply = (await poolFacts(A.poolA.address)).pool.lpSupply;
    const row = positionRow(p, A.poolA.address);
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await expect(row).toContainText(`${pct(after.lp, supply).toFixed(4)}%`, { timeout: 60_000 });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E2: wallet B removes 50%, then All, from that position; the shares burned are exact and the payouts at least the minimums', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, A.walletB, { prices: A.prices });
    const p = a.page;
    await openPools(p);
    await connect(p);
    const row = positionRow(p, A.poolA.address);

    for (const [label, bps] of [['50%', 5_000n], ['All', 10_000n]] as const) {
      const panel = await openRemove(row);
      await press(ui.lp.percent(panel, label), label);
      await expect(ui.lp.reviewRemove(panel)).toBeEnabled({ timeout: 30_000 });
      if (label === '50%') {
        await expectPressableAtSizes(p, 'E2 remove', [
          ...(['25%', '50%', '75%', 'All'] as const).map((l) => [ui.lp.percent(panel, l), l] as [Locator, string]),
          [ui.lp.reviewRemove(panel), 'Review: remove liquidity'],
        ]);
      }
      await press(ui.lp.reviewRemove(panel), 'Review: remove liquidity');
      const rows = await reviewRows(p);
      const f = await poolFacts(A.poolA.address);
      const s = sidesOf(f);
      const held = (await tokenAmount(ata(s.lpMint, A.walletB.publicKey)))!;
      const plan = withdrawPlan(f, held, bps);
      expect(rows['Pool']).toBe(A.poolA.address.toBase58());
      expect(rows['Pool shares you give back']).toMatch(new RegExp(`^${esc(units(plan.lp, 9))}`));
      expect(rows['You get at least']).toBe(`${solExact(plan.minSol)} and ${units(plan.minTok, DEC)} tokens`);
      expect(rows['You keep']).toBe(plan.keep > 0n ? `${units(plan.keep, 9)} pool shares` : 'none in this pool');
      if (label === 'All') await expect(ui.review(p)).toContainText('This is all of your share in this pool.');
      else await expectPressableAtSizes(p, 'E2 review', [[ui.signButton(p), 'Sign in wallet']]);

      const before = await books(A.walletB.publicKey, f);
      await signConfirmed(a);
      const w = a.wallet.lastIx('withdraw');
      expect(w.args).toEqual({
        lpTokenAmount: String(plan.lp),
        minimumToken0Amount: String(s.solIs0 ? plan.minSol : plan.minTok),
        minimumToken1Amount: String(s.solIs0 ? plan.minTok : plan.minSol),
      });
      const after = await books(A.walletB.publicKey, f);
      expect(before.lp - after.lp, 'the shares burned are exactly the plan').toBe(plan.lp);
      expect(after.token - before.token >= plan.minTok).toBe(true);
      expect(before.solVault - after.solVault >= plan.minSol).toBe(true);
      expect(after.token - before.token).toBe(before.tokenVault - after.tokenVault);
      await closeAll(p, panel, { rowGoes: label === 'All' });
      // The positions are read again; the row shows what is left before it is used again.
      if (after.lp > 0n) await expect(row).toContainText(tok(after.lp, 9), { timeout: 60_000 });
    }
    // Nothing left in pool A for wallet B.
    expect((await tokenAmount(ata(new PublicKey((await poolFacts(A.poolA.address)).pool.lpMint), A.walletB.publicKey))) ?? 0n).toBe(0n);
    await expect(row).toHaveCount(0, { timeout: 60_000 });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E12: a reload while a deposit is unconfirmed holds Add on that pool only; Remove and the other pool stay open; Check again settles it', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const a = await actor(browser, A.creator, { prices: A.prices });
    const p = a.page;
    await openPools(p, A.mint);
    await connect(p);
    const { panel } = await addAndReview(a, A.poolA.address, '0.1');
    const { plan, f } = await reviewDeposit(a, panel, A.poolA.address, 'sol', sol(0.1));
    const before = await books(A.creator.publicKey, f);

    // From the moment it is signed, no status can be read until released.
    a.rpc.fail('getSignatureStatuses', 500, 10 * 60_000);
    await press(ui.signButton(p), 'Sign in wallet');
    const out = ui.outcome(p);
    await expect(out).toBeVisible({ timeout: 5 * 60_000 });
    await expect(out).toHaveAttribute('data-status', 'unknown');
    const signature = a.wallet.lastSigned().signature!;
    await expect(out).toContainText(signature);
    await expect(out).toContainText('Sent, not confirmed yet');
    await expect(out).not.toContainText(/fail/i);
    expect(a.rpc.failedCount('getSignatureStatuses')).toBeGreaterThan(0);
    // It did land: the chain says so.
    expect((await landedTx(signature)).meta?.err ?? null).toBeNull();
    expect((await books(A.creator.publicKey, f)).lp - before.lp).toBe(plan.lp);

    await p.reload();
    const pending = ui.lp.pending(p);
    await expect(pending).toBeVisible({ timeout: 60_000 });
    await expect(pending).toContainText(signature);
    await expect(pending).toContainText('adding liquidity');
    await expect(pending).not.toContainText(/fail/i);
    // At the top of the section: above the pool finder.
    const top = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(await top(pending)).toBeLessThan(await top(ui.lp.finder(p)));
    expect(await pendingNotes(p)).toContain(signature);
    // Add is held on pool A only; pool B still offers it.
    await expect(poolCard(p, A.poolA.address)).toHaveAttribute('data-add', 'held', { timeout: 60_000 });
    await expect(ui.lp.addButton(poolCard(p, A.poolA.address))).toHaveCount(0);
    await expect(poolCard(p, A.poolB.address)).toHaveAttribute('data-add', 'offer');
    // The lock is per direction: the creator's share in pool A can still be taken out.
    await ensureConnected(p);
    await expect(positionRow(p, A.poolA.address)).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
    await pressable(ui.lp.removeButton(positionRow(p, A.poolA.address)), 'Remove liquidity on pool A');

    a.rpc.release('getSignatureStatuses');
    await press(pending.getByRole('button', { name: 'Check again' }), 'Check again');
    await expect(pending).toHaveCount(0, { timeout: 60_000 });
    expect(await pendingNotes(p)).toBeNull();
    await expect(poolCard(p, A.poolA.address)).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E17: a link carrying an amount, a side and a slippage fills nothing, opens nothing and signs nothing', async ({ browser }) => {
    const a = await actor(browser, A.walletB, { prices: A.prices });
    const p = a.page;
    await openPools(p, A.mint, '&amount=5&slippage=500&side=token');
    await connect(p);
    const card = poolCard(p, A.poolA.address);
    await expect(card).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
    await expect(ui.lp.addPanel(p)).toHaveCount(0);
    await expect(ui.lp.removePanel(p)).toHaveCount(0);
    await expect(ui.lp.create.panel(p)).toHaveCount(0);
    const { panel } = await openAdd(p, A.poolA.address);
    await expect(ui.lp.solToAdd(panel)).toHaveValue('');
    await expect(ui.lp.tokensToAdd(panel)).toHaveValue('');
    await expect(panel.getByRole('button', { name: '1%', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByLabel('Other slippage percent')).toHaveValue('');
    await expect(ui.lp.reviewAdd(panel)).toBeDisabled();
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
  pusher: Keypair;
  stranger: Keypair;
  // T1: a tier-1 pool and a tier-0 pool of one token (E6, E13, E14, E19).
  creator1: Keypair; t1: PublicKey; a1: CreatedPool; b1: CreatedPool; w6: Keypair; w13: Keypair; r14: Keypair;
  // E3: the Token-2022 metadata-only token.
  creator3: Keypair; t3: PublicKey; p3: CreatedPool; w3: Keypair;
  // E4: a graduated launch.
  launchCreator: Keypair; buyer: Keypair; launchMint: PublicKey; launchPool: PublicKey;
  // E5 / E16: creator A's pool, wallet B (legacy only).
  creatorA: Keypair; t5: PublicKey; p5: CreatedPool; b5: Keypair;
  // E7, E8: pools whose price is pushed.
  creator7: Keypair; t7: PublicKey; p7: CreatedPool;
  creator8: Keypair; t8: PublicKey; p8: CreatedPool; w8: Keypair;
  // E9, E10: the stranger's squat pool and freezable pools.
  ts: PublicKey; squat: CreatedPool; tf: PublicKey; pf: CreatedPool; tf2: PublicKey; pf2: CreatedPool;
  // E11: a pool at its own address (opened in the test itself).
  creator11: Keypair; t11: PublicKey; p11: CreatedPool;
  // E15: the dust pool.
  creator15: Keypair; t15: PublicKey; p15: CreatedPool; b15: Keypair;
  // E18: an unpriced token's pool, and a priced one Jupiter routes through our own pool.
  creator18: Keypair; tu: PublicKey; pu: CreatedPool; tr: PublicKey; pr: CreatedPool;
};

/** Wallet R's lamports: exactly 0.2 SOL above what the panel and prepare hold back. */
const R14_SPENDABLE = sol(0.2);

test.describe('group B (chromium only)', () => {
  test.beforeAll(async () => {
    test.skip(test.info().project.name !== 'chromium', 'Group B is chain-heavy and runs on chromium only; group A covers its layout on the phone');
    test.setTimeout(15 * 60_000);
    const name = (n: string, s: string) => ({ name: n, symbol: s });
    const classic = (owner: Keypair, n: string, s: string, supply = 10_000_000n * UNIT, o: { freezable?: boolean } = {}) =>
      createClassicToken(owner, { supply, name: name(n, s), freezable: o.freezable });
    const pool = (c: Keypair, m: PublicKey, configIndex: 0 | 1, s: number, t: bigint, at: 'standard' | 'fresh' = 'standard', tokenProgram?: PublicKey) =>
      createSolPool(c, m, { configIndex, sol: sol(s), tokens: t * UNIT, at, tokenProgram });

    B.pusher = await fundedKeypair(20);
    B.stranger = await fundedKeypair(30);
    // Independent fixtures, made side by side: each has its own payer.
    await Promise.all([
      (async () => {
        B.creator1 = await fundedKeypair(20);
        B.t1 = await classic(B.creator1, 'E2E Write B1', 'EWB1');
        B.a1 = await pool(B.creator1, B.t1, 1, 2, 2_000_000n);
        B.b1 = await pool(B.creator1, B.t1, 0, 1, 1_000_000n);
        B.w6 = await fundedKeypair(3);
        B.w13 = await fundedKeypair(2);
        await transferTokens(B.creator1, B.w6.publicKey, B.t1, 1_000_000n * UNIT);
        await transferTokens(B.creator1, B.w13.publicKey, B.t1, 500_000n * UNIT);
        await wrapSol(B.w6, sol(0.5));
        // Wallet R: funded to the lamport, so its spendable SOL is exactly R14_SPENDABLE.
        const conn = chain();
        const [rent0, rent165] = await Promise.all([conn.getMinimumBalanceForRentExemption(0), conn.getMinimumBalanceForRentExemption(165)]);
        const hold = BigInt(rent165 > rent0 ? rent165 : rent0);
        const need = R14_SPENDABLE + feeReserveFor(1) + BigInt(rent165) + hold;
        B.r14 = await fundedKeypair(Number(need) / 1e9);
        await transferTokens(B.creator1, B.r14.publicKey, B.t1, 1_000_000n * UNIT);
      })(),
      (async () => {
        B.creator3 = await fundedKeypair(5);
        B.t3 = await createToken2022MetadataOnly(B.creator3, { name: 'E2E Bayla-like', symbol: 'EBAYLK', supply: 10_000_000n * UNIT });
        B.p3 = await pool(B.creator3, B.t3, 0, 1, 1_000_000n, 'standard', TOKEN_2022_PROGRAM_ID);
        B.w3 = await fundedKeypair(3);
        await transferTokens(B.creator3, B.w3.publicKey, B.t3, 100_000n * UNIT);
      })(),
      (async () => {
        B.launchCreator = await fundedKeypair(1);
        B.buyer = await fundedKeypair(5);
        const g = await graduateDirect(B.launchCreator, B.buyer);
        B.launchMint = g.mint;
        B.launchPool = g.pool;
      })(),
      (async () => {
        B.creatorA = await fundedKeypair(5);
        B.t5 = await classic(B.creatorA, 'E2E Write B5', 'EWB5');
        B.p5 = await pool(B.creatorA, B.t5, 1, 1, 1_000_000n);
        B.b5 = await fundedKeypair(3);
        await transferTokens(B.creatorA, B.b5.publicKey, B.t5, 500_000n * UNIT);
      })(),
      (async () => {
        B.creator7 = await fundedKeypair(5);
        B.t7 = await classic(B.creator7, 'E2E Write B7', 'EWB7');
        B.p7 = await pool(B.creator7, B.t7, 1, 1, 1_000_000n);
      })(),
      (async () => {
        B.creator8 = await fundedKeypair(5);
        B.t8 = await classic(B.creator8, 'E2E Write B8', 'EWB8');
        B.p8 = await pool(B.creator8, B.t8, 1, 2, 2_000_000n);
        B.w8 = await fundedKeypair(3);
        await transferTokens(B.creator8, B.w8.publicKey, B.t8, 1_000_000n * UNIT);
      })(),
      (async () => {
        B.ts = await classic(B.stranger, 'E2E Write Squat', 'EWSQ');
        B.squat = await squatStandard(B.stranger, B.ts, { priceX: 100, openTimeFromNow: TEN_YEARS });
        B.tf = await classic(B.stranger, 'E2E Write Freeze', 'EWFZ', 10_000_000n * UNIT, { freezable: true });
        B.pf = await pool(B.stranger, B.tf, 0, 1, 1_000_000n);
        B.tf2 = await classic(B.stranger, 'E2E Write Freeze 2', 'EWFZ2', 10_000_000n * UNIT, { freezable: true });
        B.pf2 = await pool(B.stranger, B.tf2, 0, 0.5, 500_000n);
      })(),
      (async () => {
        B.creator11 = await fundedKeypair(5);
        B.t11 = await classic(B.creator11, 'E2E Write B11', 'EWB11');
      })(),
      (async () => {
        B.creator15 = await fundedKeypair(3);
        B.t15 = await classic(B.creator15, 'E2E Write Dust', 'EWDUST', 2_000_000n * UNIT);
        // 0.0001 SOL against 10^12 token units: the fewest shares that pay both sides is about 3,163.
        B.p15 = await createSolPool(B.creator15, B.t15, { configIndex: 0, sol: 100_000n, tokens: 1_000_000_000_000n, at: 'standard' });
        B.b15 = await fundedKeypair(1);
      })(),
      (async () => {
        B.creator18 = await fundedKeypair(5);
        B.tu = await classic(B.creator18, 'E2E Write Unpriced', 'EWUNP');
        B.pu = await pool(B.creator18, B.tu, 1, 1, 1_000_000n);
        B.tr = await classic(B.creator18, 'E2E Write Routed', 'EWRTD');
        B.pr = await pool(B.creator18, B.tr, 1, 1, 1_000_000n);
      })(),
    ]);
    // The launch mint and the unpriced token are NOT priced: the stub says "no route".
    B.prices = priced(B.t1, B.t3, B.t5, B.t7, B.t8, B.ts, B.tf, B.tf2, B.t11, B.tr);
  });

  test('E3: a Token-2022 metadata-only pool: Max tokens drives the whole balance in; a withdrawal re-creates the 170-byte Token-2022 account', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.w3, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t3);
    await expect(ui.lp.safety(p)).toHaveAttribute('data-verdict', 'ok');
    await connect(p);
    const t22Account = ata(B.t3, B.w3.publicKey, TOKEN_2022_PROGRAM_ID);
    const balance = (await tokenAmount(t22Account))!;
    expect(balance).toBe(100_000n * UNIT);
    const { panel } = await openAdd(p, B.p3.address);
    await press(ui.lp.maxTokens(panel), 'Max tokens');
    await expect(ui.lp.tokensToAdd(panel)).toHaveAttribute('data-driving', 'true');
    expect(parseDecimalToBaseUnits(await ui.lp.tokensToAdd(panel).inputValue(), DEC)).toBe(balance);
    await expect(ui.lp.reviewAdd(panel)).toBeEnabled({ timeout: 30_000 });
    const { rows, plan } = await reviewDeposit(a, panel, B.p3.address, 'token', balance);
    // Max made the token box drive: its maximum is the whole balance.
    expect(plan.maxTok).toBe(balance);
    expect(rows['At most']).toContain(`and ${units(balance, DEC)} tokens`);
    await signConfirmed(a);
    expect(a.wallet.lastIx('deposit').args.lpTokenAmount).toBe(String(plan.lp));

    // In Node: the leftover tokens go elsewhere and the Token-2022 account is closed.
    await closeAll(p, panel);
    await closeTokenAccount(B.w3, B.t3, TOKEN_2022_PROGRAM_ID);
    expect(await accountOwner(t22Account)).toBeNull();

    const rpanel = await openRemove(positionRow(p, B.p3.address));
    await press(ui.lp.percent(rpanel, '50%'), '50%');
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    const rrows = await reviewRows(p);
    const rent170 = BigInt(await chain().getMinimumBalanceForRentExemption(170));
    expect(rrows['The tokens arrive in']).toBe(`${t22Account.toBase58()} (opened for you; its deposit of ${solExact(rent170)} stays in that account)`);
    await signConfirmed(a);
    expect(await accountOwner(t22Account)).toEqual(TOKEN_2022_PROGRAM_ID);
    expect(await accountDataLength(t22Account)).toBe(170);
    expect(((await tokenAmount(t22Account)) ?? 0n) > 0n).toBe(true);
    // The wallet saw the Token-2022 account opened through the ATA program, and no top-level Token-2022 instruction.
    const signed = a.wallet.lastSigned().instructions;
    expect(signed.some((i) => i.name === 'create-idempotent' && i.accounts.account === t22Account.toBase58() && i.args.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58())).toBe(true);
    expect(a.wallet.signed().flatMap((r) => r.instructions).some((i) => i.program === 'token-2022')).toBe(false);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E4: a graduated launch pool; with Jupiter down it is unchecked (E4a), with "no route" it takes a deposit; Add, then Remove All', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const launch = B.launchMint.toBase58();
    const a = await actor(browser, B.buyer, { prices: B.prices, down: new Set([launch]) });
    const p = a.page;
    expect(B.launchPool.equals(poolStatePda(B.launchMint, LAUNCH_PROGRAM))).toBe(true);
    await openPools(p, B.launchMint);
    // E4a: Jupiter down is not "no route": no Add.
    const card = poolCard(p, B.launchPool);
    await expect(card).toHaveAttribute('data-origin', 'launch-pool', { timeout: 60_000 });
    await expect(card).toHaveAttribute('data-deposits', 'unchecked', { timeout: 60_000 });
    await expect(card).toHaveAttribute('data-add', 'checks', { timeout: 60_000 });
    await expect(card).toContainText('HTTP 502');
    await expect(ui.lp.addButton(card)).toHaveCount(0);
    // Jupiter answers again ("no route": the stub does not price this mint).
    a.jup.setDown(launch, false);
    await press(ui.lp.findButton(p), 'Find pools');
    await expect(card).toHaveAttribute('data-price', 'no-trades-yet', { timeout: 60_000 });
    await expect(card).toHaveAttribute('data-deposits', 'allowed');
    await connect(p);

    const { panel } = await addAndReview(a, B.launchPool, '0.1');
    const { rows, f, plan } = await reviewDeposit(a, panel, B.launchPool, 'sol', sol(0.1));
    expect(rows['Pool kind']).toBe('Launch pool: opened by the launch program at graduation');
    await expect(ui.review(p)).toContainText("burned the launch's own pool shares");
    // The share is against the pool's own lp_supply, not the share mint's supply (the launch burned its part).
    const mintSupply = (await mintFacts(new PublicKey(f.pool.lpMint))).supply;
    expect(mintSupply).not.toBe(f.pool.lpSupply);
    expect(rows['Your share of the pool']).toBe(`none → ${shareText(pct(plan.lp, f.pool.lpSupply + plan.lp))}`);
    await signConfirmed(a);
    expect(a.wallet.lastIx('deposit').accounts.pool_state).toBe(B.launchPool.toBase58());
    const { token0, token1 } = sortMints(WSOL, B.launchMint);
    expect(B.launchPool.equals(derivePool(CP_SWAP_PROGRAM, deriveAmmConfig(CP_SWAP_PROGRAM, 0), token0, token1))).toBe(false);
    const lpAta = ata(new PublicKey(f.pool.lpMint), B.buyer.publicKey);
    expect(await tokenAmount(lpAta)).toBe(plan.lp);

    await closeAll(p, panel);
    const rpanel = await openRemove(positionRow(p, B.launchPool));
    await press(ui.lp.percent(rpanel, 'All'), 'All');
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    await expect(ui.review(p)).toContainText('This is all of your share in this pool.');
    await signConfirmed(a);
    expect(a.wallet.lastIx('withdraw').args.lpTokenAmount).toBe(String(plan.lp));
    expect(await tokenAmount(lpAta)).toBe(0n);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E5: a legacy-only wallet B adds to creator A\'s pool; each sees only its own share, against lp_supply; A takes 25% out', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const b = await actor(browser, B.b5, { prices: B.prices, versions: ['legacy'] });
    await openPools(b.page, B.t5);
    await connect(b.page);
    const { panel } = await addAndReview(b, B.p5.address, '0.1');
    const { plan } = await reviewDeposit(b, panel, B.p5.address, 'sol', sol(0.1));
    await signConfirmed(b);
    expect(b.wallet.lastSigned().version).toBe('legacy');
    await closeAll(b.page, panel);
    const f = await poolFacts(B.p5.address);
    const lpMint = new PublicKey(f.pool.lpMint);
    const lpB = (await tokenAmount(ata(lpMint, B.b5.publicKey)))!;
    const lpA = (await tokenAmount(ata(lpMint, B.creatorA.publicKey)))!;
    expect(lpB).toBe(plan.lp);
    await expect(ui.lp.position(b.page)).toHaveCount(1, { timeout: 60_000 });
    await expect(positionRow(b.page, B.p5.address)).toContainText(`${pct(lpB, f.pool.lpSupply).toFixed(4)}%`, { timeout: 60_000 });
    expect(b.rpc.violations).toEqual([]);
    await b.ctx.close();

    const a = await actor(browser, B.creatorA, { prices: B.prices });
    await openPools(a.page);
    await connect(a.page);
    await expect(ui.lp.position(a.page)).toHaveCount(1, { timeout: 60_000 });
    const row = positionRow(a.page, B.p5.address);
    await expect(row).toContainText(`${pct(lpA, f.pool.lpSupply).toFixed(4)}%`);
    const rpanel = await openRemove(row);
    await press(ui.lp.percent(rpanel, '25%'), '25%');
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    await reviewRows(a.page);
    const wplan = withdrawPlan(await poolFacts(B.p5.address), lpA, 2_500n);
    await signConfirmed(a);
    expect(a.wallet.lastIx('withdraw').args.lpTokenAmount).toBe(String(wplan.lp));
    expect(await tokenAmount(ata(lpMint, B.creatorA.publicKey))).toBe(lpA - wplan.lp);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E6: wrapped SOL the wallet already held is left alone through an Add and a Remove All; that account only grows, by each test run', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.w6, { prices: B.prices });
    const p = a.page;
    const wsolAcc = ata(WSOL, B.w6.publicKey);
    const held0 = (await tokenAmount(wsolAcc))!;
    expect(held0).toBe(sol(0.5));
    await openPools(p, B.t1);
    await connect(p);
    const { panel } = await addAndReview(a, B.a1.address, '0.2');
    const { rows, plan } = await reviewDeposit(a, panel, B.a1.address, 'sol', sol(0.2));
    await expect(ui.review(p)).toContainText(`You already hold ${formatSol(held0, 9)} wrapped SOL. None of it is spent.`);
    const depositLine = rows['Test run: your wrapped SOL changes by'];
    await signConfirmed(a);
    const held1 = (await tokenAmount(wsolAcc))!;
    // Wrapped in: the deposit's SOL maximum; taken by the pool: its cost. The rest stays.
    expect(held1 - held0).toBe(plan.maxSol - plan.costSol);
    expect(signedTok(held1 - held0, 9)).toBe(depositLine);

    await closeAll(p, panel);
    const rpanel = await openRemove(positionRow(p, B.a1.address));
    await press(ui.lp.percent(rpanel, 'All'), 'All');
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    const rrows = await reviewRows(p);
    expect(rrows['The SOL arrives']).toBe('as wrapped SOL in the account you already hold');
    const withdrawLine = rrows['Test run: your wrapped SOL changes by'];
    const f = await poolFacts(B.a1.address);
    const vaultBefore = (await tokenAmount(sidesOf(f).solVault))!;
    await signConfirmed(a);
    const held2 = (await tokenAmount(wsolAcc))!;
    const paid = vaultBefore - (await tokenAmount(sidesOf(f).solVault))!;
    expect(held2 - held1, 'the SOL paid out arrived as wrapped SOL').toBe(paid);
    expect(signedTok(held2 - held1, 9)).toBe(withdrawLine);
    expect(held2 > held1 && held1 > held0).toBe(true);
    expect(a.wallet.signed().flatMap((r) => r.instructions).some((i) => i.name === 'close-wsol'), 'never unwrapped').toBe(false);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E7: a price pushed more than 3% before Review is refused at build, signs nothing, and the card then says refused; the creator still leaves', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.creator7, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t7);
    await connect(p);
    const card = poolCard(p, B.p7.address);
    await expect(card).toHaveAttribute('data-deposits', 'allowed', { timeout: 60_000 });
    const { panel } = await addAndReview(a, B.p7.address, '0.1');
    // In Node: about 5% of the pool's SOL bought in, so its price rises about 10%.
    const f = await poolFacts(B.p7.address);
    const solReserve = sidesOf(f).solIs0 ? f.snapshot.reserve0 : f.snapshot.reserve1;
    await swapDirect(B.pusher, B.p7.address, WSOL, solReserve / 20n);
    await press(ui.lp.reviewAdd(panel), 'Review: add liquidity');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 60_000 });
    await expect(out).toContainText('Not sent. We could not build this transaction.');
    await expect(out).toContainText(/Its price is \d+\.\d% above the outside price/);
    expect(a.wallet.records).toEqual([]);
    await press(out.getByRole('button', { name: 'Start over' }), 'Start over');
    await expect(card).toHaveAttribute('data-deposits', 'refused', { timeout: 60_000 });
    await press(panel.getByRole('button', { name: 'Close', exact: true }), 'close the panel');

    const rpanel = await openRemove(positionRow(p, B.p7.address));
    await press(ui.lp.percent(rpanel, '25%'), '25%');
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    await reviewRows(p);
    await signConfirmed(a);
    expect(a.wallet.lastIx('withdraw').accounts.pool_state).toBe(B.p7.address.toBase58());
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E8: a price pushed past a 0.5% tolerance after the review is turned away before running: not sent, nothing moved, no note', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.w8, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t8);
    await connect(p);
    const { panel } = await addAndReview(a, B.p8.address, '0.5', 50n);
    const { f } = await reviewDeposit(a, panel, B.p8.address, 'sol', sol(0.5), 50n);
    const before = await books(B.w8.publicKey, f);
    // About 1% of the pool's SOL bought in: about 2% on the price (inside the 3% check), past 0.5%.
    const solReserve = sidesOf(f).solIs0 ? f.snapshot.reserve0 : f.snapshot.reserve1;
    await swapDirect(B.pusher, B.p8.address, WSOL, solReserve / 100n, { settle: 'finalized' });
    await press(ui.signButton(p), 'Sign in wallet');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 120_000 });
    await expect(out).toContainText('Not sent. The network turned it away before running it.');
    await expect(out).toContainText("The pool's price moved past your tolerance before this ran, so it would have cost more than your maximum.");
    await expect(out).toContainText('Nothing was sent.');
    await expect(out).toContainText('Nothing was charged.');
    const after = await books(B.w8.publicKey, f);
    expect({ lamports: after.lamports, token: after.token, lp: after.lp, wsol: after.wsol }).toEqual({ lamports: before.lamports, token: before.token, lp: before.lp, wsol: before.wsol });
    expect(await pendingNotes(p)).toBeNull();
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E9: leaving with deposits refused: a squat pool opening in ten years, and a blocked token\'s share set aside; no Add, and both Removes land', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const a = await actor(browser, B.stranger, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.ts);
    const squat = poolCard(p, B.squat.address);
    await expect(squat).toHaveAttribute('data-deposits', 'refused', { timeout: 60_000 });
    await expect(squat).toHaveAttribute('data-add', 'checks');
    await expect(ui.lp.addButton(squat)).toHaveCount(0);
    await openPools(p, B.tf);
    const frozenish = poolCard(p, B.pf.address);
    await expect(frozenish).toHaveAttribute('data-deposits', 'refused', { timeout: 60_000 });
    await expect(ui.lp.addButton(frozenish)).toHaveCount(0);
    await connect(p);

    for (const pool of [B.squat, B.pf]) {
      const row = positionRow(p, pool.address);
      if (pool === B.pf) {
        const aside = p.getByTestId('lp-positions-set-aside');
        await expect(aside).toBeVisible({ timeout: 60_000 });
        if (!(await aside.evaluate((el) => (el as HTMLDetailsElement).open))) await press(aside.locator('summary'), 'set-aside list');
        await expect(row).toContainText('Set aside: its token is blocked on this site.');
      }
      const lpAcc = ata(pool.lpMint, B.stranger.publicKey);
      const held = (await tokenAmount(lpAcc))!;
      const rpanel = await openRemove(row);
      await press(ui.lp.percent(rpanel, '50%'), '50%');
      await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
      await reviewRows(p);
      const plan = withdrawPlan(await poolFacts(pool.address), held, 5_000n);
      await signConfirmed(a);
      expect(await tokenAmount(lpAcc)).toBe(held - plan.lp);
      await closeAll(p, rpanel);
    }
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E10: a pool vault frozen by the token\'s issuer: the row says so, offers no Remove, and nothing is signed', async ({ browser }) => {
    const a = await actor(browser, B.stranger, { prices: B.prices });
    const p = a.page;
    await freezeVault(B.pf2.address, B.tf2, B.stranger);
    await openPools(p);
    await connect(p);
    const row = positionRow(p, B.pf2.address);
    await expect(row).toHaveAttribute('data-remove', 'vault-frozen', { timeout: 60_000 });
    await expect(row).toContainText("The token's issuer has frozen one of this pool's vaults, so nothing can move in or out, for anyone.");
    await expect(ui.lp.removeButton(row)).toHaveCount(0);
    await expect(ui.lp.reviewRemove(row)).toHaveCount(0);
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E11: with the pool index down, a share is found on the chain, stays found after a withdrawal, and every Remove lands', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    // Made here, not in beforeAll: the local validator keeps only about a thousand slots of
    // transaction history, and the search below reads the share's own history.
    B.p11 = await createSolPool(B.creator11, B.t11, { configIndex: 1, sol: sol(1), tokens: 1_000_000n * UNIT, at: 'fresh' });
    const a = await actor(browser, B.creator11, { prices: B.prices, indexDown: true });
    const p = a.page;
    expect(B.p11.standard).toBe(false);
    await openPools(p);
    await connect(p);
    const lpMint = B.p11.lpMint.toBase58();
    const row = ui.lp.position(p).filter({ hasText: lpMint });
    await expect(row).toHaveAttribute('data-placement', 'index-unread', { timeout: 60_000 });
    await expect(row).toHaveAttribute('data-remove', 'unplaced');
    // The fixture, not the page: the share's opening must still be in the local ledger's window.
    const history = await chain().getSignaturesForAddress(ata(B.p11.lpMint, B.creator11.publicKey), { limit: 20 }, 'confirmed');
    expect(history.length, `the local validator no longer holds the opening (first block ${await chain().getFirstAvailableBlock()})`).toBeGreaterThan(0);
    await press(ui.lp.findOnChain(row), "Find this share's pool on the chain");
    await expect(row).toHaveAttribute('data-placement', 'chain', { timeout: 60_000 });
    await expect(row).toHaveAttribute('data-pool', B.p11.address.toBase58());
    const lpAcc = ata(B.p11.lpMint, B.creator11.publicKey);

    for (const [label, bps] of [['50%', 5_000n], ['All', 10_000n]] as const) {
      const held = (await tokenAmount(lpAcc))!;
      const rpanel = await openRemove(row);
      await press(ui.lp.percent(rpanel, label), label);
      await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
      await reviewRows(p);
      const plan = withdrawPlan(await poolFacts(B.p11.address), held, bps);
      await signConfirmed(a);
      expect(await tokenAmount(lpAcc)).toBe(held - plan.lp);
      const lookups = a.index.calls.filter((c) => c.includes(lpMint)).length;
      await closeAll(p, rpanel, { rowGoes: label === 'All' });
      if (label === '50%') {
        // Read again with the index still down: still placed from the chain, Remove still there, the index not asked.
        await expect(row).toContainText(tok(held - plan.lp, 9), { timeout: 60_000 });
        await expect(row).toHaveAttribute('data-placement', 'chain');
        await expect(row).toHaveAttribute('data-remove', 'offer');
        expect(a.index.calls.filter((c) => c.includes(lpMint)).length).toBe(lookups);
      }
    }
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E13: declined in the wallet: not sent, nothing charged, no note', async ({ browser }) => {
    const a = await actor(browser, B.w13, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t1);
    await connect(p);
    const { panel } = await addAndReview(a, B.a1.address, '0.1');
    const { f } = await reviewDeposit(a, panel, B.a1.address, 'sol', sol(0.1));
    const before = await books(B.w13.publicKey, f);
    a.wallet.setMode('decline');
    await press(ui.signButton(p), 'Sign in wallet');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 30_000 });
    await expect(out).toContainText('Not sent. Your wallet did not sign it.');
    await expect(out).toContainText('Nothing was charged.');
    expect(a.wallet.records.map((r) => r.outcome)).toEqual(['declined']);
    expect(await pendingNotes(p)).toBeNull();
    const after = await books(B.w13.publicKey, f);
    expect({ lamports: after.lamports, token: after.token, lp: after.lp }).toEqual({ lamports: before.lamports, token: before.token, lp: before.lp });
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E14: the rent band: Max SOL is exactly the spendable SOL worked out from live rents, it lands, and a little more is refused on screen', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.r14, { prices: B.prices });
    const p = a.page;
    const conn = chain();
    const [rent0, rent165] = (await Promise.all([conn.getMinimumBalanceForRentExemption(0), conn.getMinimumBalanceForRentExemption(165)])).map(BigInt);
    const have = await lamports(B.r14.publicKey);
    const spendable = spendableSol({ lamports: have, walletFloor: rent0!, feeReserve: feeReserveFor(1), lpAccountRent: rent165!, wsolCreateRent: rent165! });
    expect(spendable).toBe(R14_SPENDABLE);
    await openPools(p, B.t1);
    await connect(p);
    const { panel } = await openAdd(p, B.a1.address);
    await press(ui.lp.maxSol(panel), 'Max SOL');
    expect(parseDecimalToBaseUnits(await ui.lp.solToAdd(panel).inputValue(), 9)).toBe(spendable);
    await expect(ui.lp.reviewAdd(panel)).toBeEnabled({ timeout: 30_000 });
    // 0.001 SOL more: the rent-band line, and no Review.
    await ui.lp.solToAdd(panel).fill(formatSol(spendable + sol(0.001), 9));
    await expect(panel.getByText('That would leave your wallet with too little SOL to stay open on the network.')).toBeVisible();
    await expect(ui.lp.reviewAdd(panel)).toBeDisabled();
    // Max again, and it lands.
    await press(ui.lp.maxSol(panel), 'Max SOL');
    await expect(ui.lp.reviewAdd(panel)).toBeEnabled({ timeout: 30_000 });
    const { plan } = await reviewDeposit(a, panel, B.a1.address, 'sol', spendable);
    await signConfirmed(a);
    expect(a.wallet.lastIx('deposit').args.lpTokenAmount).toBe(String(plan.lp));
    expect((await lamports(B.r14.publicKey)) >= rent0!).toBe(true);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E15: dust: a share below the program\'s minimum offers nothing; at 5,000 shares, 50% is too small, 70% leaves dust, and All lands', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const f0 = await poolFacts(B.p15.address);
    const minLp = minLpForBothSides(f0.snapshot)!;
    expect(minLp > 2_000n && minLp < 5_000n, `the fewest shares that pay both sides is ${minLp}`).toBe(true);
    await transferLp(B.creator15, B.b15.publicKey, B.p15.lpMint, 2_000n);
    const a = await actor(browser, B.b15, { prices: B.prices });
    const p = a.page;
    await openPools(p);
    await connect(p);
    const row = positionRow(p, B.p15.address);
    await expect(row).toHaveAttribute('data-remove', 'dust', { timeout: 60_000 });
    await expect(row).toContainText("This share is too small to take out at the pool's current size: one side would round to zero (the pool program's rule).");
    await expect(ui.lp.removeButton(row)).toHaveCount(0);

    await transferLp(B.creator15, B.b15.publicKey, B.p15.lpMint, 3_000n);
    await press(ui.lp.positions(p).getByRole('button', { name: 'Read my positions again' }), 'Read my positions again');
    const rpanel = await openRemove(row);
    await press(ui.lp.percent(rpanel, '50%'), '50%');
    await expect(rpanel.getByText('Too small: one side would round to zero.')).toBeVisible();
    await expect(ui.lp.reviewRemove(rpanel)).toBeDisabled();
    await ui.lp.otherPercent(rpanel).fill('70');
    await expect(rpanel.getByText('too few to ever take out')).toBeVisible();
    await expect(ui.lp.reviewRemove(rpanel)).toBeDisabled();
    await press(rpanel.getByRole('button', { name: 'Take out all of it' }), 'Take out all of it');
    await expect(ui.lp.reviewRemove(rpanel)).toBeEnabled();
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    await expect(ui.review(p)).toContainText('This is all of your share in this pool.');
    const f = await poolFacts(B.p15.address);
    const vaultBefore = (await tokenAmount(sidesOf(f).solVault))!;
    await signConfirmed(a);
    expect(a.wallet.lastIx('withdraw').args.lpTokenAmount).toBe('5000');
    expect((await tokenAmount(ata(B.p15.lpMint, B.b15.publicKey))) ?? 0n).toBe(0n);
    const solPaid = vaultBefore - (await tokenAmount(sidesOf(f).solVault))!;
    expect(solPaid >= 1n, `the SOL side paid ${solPaid} lamports`).toBe(true);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E18: pools whose price cannot be checked offer no Add (no route; a route through our own pool); the creator\'s Remove stays', async ({ browser }) => {
    const a = await actor(browser, B.creator18, { prices: B.prices, routeThrough: B.pr.address });
    const p = a.page;
    await openPools(p, B.tu);
    const unpriced = poolCard(p, B.pu.address);
    await expect(unpriced).toHaveAttribute('data-deposits', 'unchecked', { timeout: 60_000 });
    await expect(unpriced).toHaveAttribute('data-add', 'checks');
    await expect(unpriced).toContainText('Jupiter has no route for this token');
    await expect(unpriced).toContainText("We offer adding liquidity only after checking the pool's price against a price from outside it, and we could not get one.");
    await expect(ui.lp.addButton(unpriced)).toHaveCount(0);

    await openPools(p, B.tr);
    const routed = poolCard(p, B.pr.address);
    await expect(routed).toHaveAttribute('data-deposits', 'unchecked', { timeout: 60_000 });
    await expect(routed).toHaveAttribute('data-add', 'checks');
    await expect(routed).toContainText('came through our own pools');
    await expect(ui.lp.addButton(routed)).toHaveCount(0);

    await connect(p);
    for (const pool of [B.pu, B.pr]) {
      const row = positionRow(p, pool.address);
      await expect(row).toHaveAttribute('data-remove', 'offer', { timeout: 60_000 });
      await pressable(ui.lp.removeButton(row), 'Remove liquidity');
    }
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  test('E19: copy guards: no yield claims in the LP section, the routing copy is true in this build, and the fee-tier row is each pool\'s live tier', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const a = await actor(browser, B.creator1, { prices: B.prices });
    const p = a.page;
    await openPools(p, B.t1);
    await connect(p);
    await expect(poolCard(p, B.a1.address)).toHaveAttribute('data-add', 'offer', { timeout: 60_000 });
    const page = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    for (const bad of [/takes (whichever|the one)/i, /unless elsewhere is better/i, /whichever is better/i]) expect(page).not.toMatch(bad);
    expect(page).toContain('still goes through Jupiter');
    expect(page).not.toContain('adding and removing liquidity from here is not switched on yet');

    const tierText = (f: PoolFacts) =>
      `${f.ammConfig.index}: traders pay ${feeRateText(f.ammConfig.tradeFeeRate)} a trade; LPs keep ${feeSplit(f.ammConfig).lpKeepsPct.toFixed(3)}% of each trade`;
    const seen: string[] = [];
    for (const pool of [B.a1, B.b1]) {
      const { panel } = await addAndReview(a, pool.address, '0.05');
      const { rows, f } = await reviewDeposit(a, panel, pool.address, 'sol', sol(0.05));
      expect(rows['Fee tier']).toBe(tierText(f));
      seen.push(rows['Fee tier']!);
      expect((await ui.lp.section(p).innerText())).not.toMatch(/APR|APY|yield of/i);
      await press(p.getByRole('button', { name: 'Cancel', exact: true }), 'Cancel');
      await press(panel.getByRole('button', { name: 'Close', exact: true }), 'close the panel');
    }
    expect(seen[0]).not.toBe(seen[1]);
    expect(await ui.lp.section(p).innerText()).not.toMatch(/APR|APY|yield of/i);
    expect(a.wallet.records).toEqual([]);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });

  // LAST for wallet B5: its token account is unusable afterwards.
  test('E16: a token account handed to another wallet (the drainer pattern) is refused before signing, by name; on chain the ATA program refuses it too', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const tokenAcc = ata(B.t5, B.b5.publicKey);
    // Wallet B's share from E5. A failed test restarts the worker, and a new worker makes
    // fresh fixtures without it: say so rather than fail somewhere less clear.
    expect((await tokenAmount(ata(B.p5.lpMint, B.b5.publicKey))) ?? 0n, "E16 needs wallet B's share from E5 in the same worker").toBeGreaterThan(0n);
    await reassignAtaOwner(B.b5, tokenAcc, B.stranger.publicKey);
    const a = await actor(browser, B.b5, { prices: B.prices, versions: ['legacy'] });
    const p = a.page;
    await openPools(p);
    await connect(p);
    const rpanel = await openRemove(positionRow(p, B.p5.address));
    await press(ui.lp.percent(rpanel, '25%'), '25%');
    await press(ui.lp.reviewRemove(rpanel), 'Review: remove liquidity');
    const out = ui.outcome(p);
    await expect(out).toHaveAttribute('data-status', 'not-sent', { timeout: 60_000 });
    await expect(out).toContainText('Not sent. We could not build this transaction.');
    await expect(out).toContainText(`Your account at ${tokenAcc.toBase58()} now belongs to another wallet (${B.stranger.publicKey.toBase58()}).`);
    expect(a.wallet.records).toEqual([]);

    // The same withdrawal, built in Node and simulated: the ATA program's create-if-missing refuses it (custom 0, InvalidOwner).
    const f = await poolFacts(B.p5.address);
    const s = sidesOf(f);
    const lpAcc = ata(s.lpMint, B.b5.publicKey);
    const plan = withdrawPlan(f, (await tokenAmount(lpAcc))!, 2_500n);
    const owner = B.b5.publicKey;
    const m0 = new PublicKey(f.pool.token0Mint);
    const m1 = new PublicKey(f.pool.token1Mint);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(owner, tokenAcc, owner, B.t5, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(owner, ata(WSOL, owner), owner, WSOL, TOKEN_PROGRAM_ID),
      withdrawIx({
        programId: CP_SWAP_PROGRAM, owner, poolState: B.p5.address, ownerLpToken: lpAcc,
        token0Account: ata(m0, owner), token1Account: ata(m1, owner),
        token0Vault: new PublicKey(f.pool.token0Vault), token1Vault: new PublicKey(f.pool.token1Vault),
        vault0Mint: m0, vault1Mint: m1, lpMint: s.lpMint,
        lpTokenAmount: plan.lp, minimumToken0Amount: plan.min0, minimumToken1Amount: plan.min1,
      }),
    );
    tx.feePayer = owner;
    tx.recentBlockhash = (await chain().getLatestBlockhash('confirmed')).blockhash;
    const sim = await chain().simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: 'confirmed' });
    expect(sim.value.err).toEqual({ InstructionError: [0, { Custom: 0 }] });
    expect((sim.value.logs ?? []).join('\n')).toContain(`Program ${ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()} failed`);
    expect(a.rpc.violations).toEqual([]);
    await a.ctx.close();
  });
});
