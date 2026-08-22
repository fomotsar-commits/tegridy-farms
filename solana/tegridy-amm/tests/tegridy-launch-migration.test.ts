/**
 * FULL LIFECYCLE REHEARSAL — create a launch, buy it to its graduation target,
 * migrate into a Tegridy CP-AMM pool, and prove the LP was burned.
 *
 * ## Why this exists
 *
 * `migrate_to_amm` is the highest-risk instruction in the program: it moves an
 * entire launch's raised balance in one call and CPIs a 20-account instruction.
 * TWO runtime-only defects were already found in it by reading mechanics, both of
 * which `cargo check` accepted without complaint:
 *
 *   1. `create_pool_fee` is charged as a NATIVE SOL transfer from the creator, and
 *      nothing budgeted for it — a curve that raised exactly its target could not
 *      afford to migrate.
 *   2. The SOL leg was wrapped with `system_program::transfer` FROM the curve PDA.
 *      The System program requires a System-owned source; the curve PDA holds this
 *      program's data, so it is owned by us. That would have failed on every
 *      single migration.
 *
 * Both were caught by inspection. Neither would have been caught by type-checking,
 * and there is no reason to believe inspection found the last one. So this file
 * exists to actually RUN the thing.
 *
 * ## What it asserts, and why each matters
 *
 *   - the pool exists and the curve records it       (otherwise nothing can find it)
 *   - `complete` is true                             (curve is closed exactly once)
 *   - **LP total supply is ZERO**                    (the burn — "liquidity
 *                                                     permanently locked" is a
 *                                                     published claim, and a
 *                                                     partial burn makes it false)
 *   - migrating twice fails                          (replay safety)
 *   - buy and sell both fail afterwards              (curve really is closed)
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  createMint,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

// create_launch now takes a curve mode: 0 = ConstantProduct (pump.fun shape),
// 1 = Segmented (Meteora shape). These tests exercise the constant-product path,
// which is the pre-existing behaviour they were written against.
const CURVE_MODE_CONSTANT_PRODUCT = 0;

type AnyProgram = Program<Idl>;

const GLOBAL_SEED = Buffer.from("global");
const CURVE_SEED = Buffer.from("curve");
const VAULT_SEED = Buffer.from("vault");
/** Data-less PDA that acts as cp-swap's creator — it must be System-owned to
 *  pay rent for the five accounts cp-swap inits. See MIGRATION_AUTH_SEED. */
const MIGRATION_AUTH_SEED = Buffer.from("migauth");
/** The pool address is derived from tegridy-launch, NOT from cp-swap's canonical
 *  [POOL_SEED, amm_config, mint0, mint1]. cp-swap's initialize is permissionless,
 *  so the canonical address can be occupied by anyone to brick a graduation; a PDA
 *  of the launch program cannot. See LAUNCH_POOL_SEED in state.rs. */
const LAUNCH_POOL_SEED = Buffer.from("launchpool");

// cp-swap seeds — from programs/cp-swap/src/states/{config,pool}.rs and lib.rs.
const AMM_CONFIG_SEED = Buffer.from("amm_config");
const POOL_SEED = Buffer.from("pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const POOL_LP_MINT_SEED = Buffer.from("pool_lp_mint");
const OBSERVATION_SEED = Buffer.from("observation");
const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");

/** Deliberately small so the whole curve can be bought out inside a test. */
// Virtual SOL is chosen so the 2 SOL target lists at EXACTLY the curve's final
// price (9999/10000 bps). The target is not a free parameter — see
// curve::continuity_target. 30 SOL here with a 2 SOL target opened the pool at
// 14% of the curve price, a ~7x listing gap, and is now rejected at config time.
const V_SOL = new BN(5_329_495_216);
const V_TOK = new BN("1073000000000000");
const SUPPLY = new BN("1000000000000000");
const TRADE_FEE_BPS = new BN(100);
/** Creator's share OF THE FEE (bps of the fee, not the trade). 4,800 = exact
 *  parity with the live Meteora partner config's 48 bps (CREATOR_FEE_SPEC.md §1).
 *  A curve that pays creators zero loses every launch to the rails that pay. */
const CREATOR_FEE_SHARE_BPS = new BN(4800);
const GRAD_TARGET = new BN(2).mul(new BN(LAMPORTS_PER_SOL));
/** Must cover cp-swap's create_pool_fee + rent on the five accounts it creates. */
const MIGRATION_RESERVE = new BN(LAMPORTS_PER_SOL).div(new BN(4));
/**
 * Raydium charges 0.15 SOL to create a pool on mainnet, taken as a NATIVE SOL
 * transfer from the `creator` and then `sync_native`d (initialize.rs, gated on
 * `create_pool_fee != 0`).
 *
 * This ran at ZERO here for a long time, which meant the one mainnet cost that
 * `migration_reserve_lamports` exists to cover was never exercised — the reserve
 * could have been undersized and CI would still have been green. Charge it for
 * real, at the mainnet number, so the reserve is actually proven.
 */
const CREATE_POOL_FEE = new BN(15).mul(new BN(LAMPORTS_PER_SOL)).div(new BN(100));

function loadIdlProgram(provider: AnchorProvider, name: string): AnyProgram {
  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../target/idl/${name}.json`), "utf8")
  ) as Idl;
  return new Program(idl, provider) as AnyProgram;
}

const pda = (seeds: Buffer[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

describe("tegridy-launch full migration rehearsal", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const wallet = anchor.Wallet.local().payer;

  let launch: AnyProgram;
  let cpSwap: AnyProgram;
  let ammConfig: PublicKey;
  let feeReceiver: PublicKey;
  // The config's fee recipient. Also the destination of the unspent migration
  // reserve since 2026-08-08 — see `migrate_to_amm`'s residual sweep.
  let cfgFeeRecipient: PublicKey;

  let launchMint: PublicKey;
  let curve: PublicKey;
  let curveVault: PublicKey;

  before(async () => {
    launch = loadIdlProgram(provider, "tegridy_launch");
    cpSwap = loadIdlProgram(provider, "raydium_cp_swap");

    // cp-swap's create_pool_fee receiver is a HARDCODED address in the fork, and
    // CI patches it to this wallet's WSOL ATA before building. Create it now — the
    // address must exist on-chain or pool creation reverts.
    feeReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
    try {
      await createAssociatedTokenAccount(provider.connection, wallet, NATIVE_MINT, wallet.publicKey);
    } catch {
      /* already exists — fine */
    }

    // AmmConfig, created by the cp-swap admin (also patched to this wallet in CI).
    const index = 0;
    ammConfig = PublicKey.findProgramAddressSync(
      [AMM_CONFIG_SEED, new BN(index).toArrayLike(Buffer, "be", 2)],
      cpSwap.programId
    )[0];
    await cpSwap.methods
      // (index, trade_fee_rate, protocol_fee_rate, fund_fee_rate, create_pool_fee,
      //  creator_fee_rate) — note the 6th arg, which the fork's own docs omit.
      .createAmmConfig(index, new BN(2500), new BN(120000), new BN(0), CREATE_POOL_FEE, new BN(0))
      .accountsPartial({
        owner: wallet.publicKey,
        ammConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await launch.methods
      .initializeGlobal(
        TRADE_FEE_BPS,
        CREATOR_FEE_SHARE_BPS,
        V_SOL,
        V_TOK,
        SUPPLY,
        GRAD_TARGET,
        MIGRATION_RESERVE,
        cpSwap.programId,
        ammConfig
      )
      .accountsPartial({
        authority: wallet.publicKey,
        feeRecipient: Keypair.generate().publicKey,
        global: pda([GLOBAL_SEED], launch.programId),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("creates a launch, buys it to target, migrates, and BURNS the LP", async () => {
    // ── create ────────────────────────────────────────────────────────────────
    launchMint = await createMint(provider.connection, wallet, wallet.publicKey, null, 9);
    curve = pda([CURVE_SEED, launchMint.toBuffer()], launch.programId);
    curveVault = pda([VAULT_SEED, launchMint.toBuffer()], launch.programId);

    await launch.methods
      .createLaunch(CURVE_MODE_CONSTANT_PRODUCT)
      .accountsPartial({
        creator: wallet.publicKey,
        global: pda([GLOBAL_SEED], launch.programId),
        mint: launchMint,
        curve,
        curveVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // ── buy past the target, so the reserve is funded too ─────────────────────
    const buyerAta = getAssociatedTokenAddressSync(launchMint, wallet.publicKey);
    await createAssociatedTokenAccount(provider.connection, wallet, launchMint, wallet.publicKey);

    const globalKey = pda([GLOBAL_SEED], launch.programId);
    const g: any = await (launch.account as any).globalConfig.fetch(globalKey);
    cfgFeeRecipient = g.feeRecipient;

    // ── exercise `sell` once, while the curve is still open ──────────────────
    // `sell` is the holders' ONLY exit, and it carries the same direct
    // lamport-mutation idiom as migration — safe there only because no CPI follows
    // it. Nothing in this repo had ever executed it successfully, which means a
    // future CPI appended after that mutation would break the exit silently and no
    // test would notice. Cover it here.
    const tradeAccounts = {
      trader: wallet.publicKey,
      global: globalKey,
      feeRecipient: g.feeRecipient,
      // The launch creator (the wallet here) — every trade pays it the creator
      // share of the fee, pinned by `address = curve.creator`.
      creator: wallet.publicKey,
      mint: launchMint,
      curve,
      curveVault,
      traderTokenAccount: buyerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    await launch.methods
      .buy(new BN(LAMPORTS_PER_SOL).div(new BN(2)), new BN(0))
      .accountsPartial(tradeAccounts)
      .rpc();
    // The protocol must receive exactly the fee MINUS the creator's share — a
    // 0.5 SOL buy at the 1% fee charges 5,000,000 lamports. Derived from the share
    // constant, not typed in. Pre-split code sent the FULL fee here, so this
    // assertion fails on it (the mutation check).
    {
      const fee = (LAMPORTS_PER_SOL / 2) * (TRADE_FEE_BPS.toNumber() / 10_000);
      const creatorLeg = Math.floor((fee * CREATOR_FEE_SHARE_BPS.toNumber()) / 10_000);
      assert.equal(
        (await provider.connection.getAccountInfo(g.feeRecipient))?.lamports ?? 0,
        fee - creatorLeg,
        "protocol fee leg must be the fee minus the creator's share"
      );
    }
    const tokensBeforeSell = BigInt(
      (await provider.connection.getTokenAccountBalance(buyerAta)).value.amount
    );
    assert.isTrue(tokensBeforeSell > 0n, "the buy must have delivered tokens to sell");
    const curveLamportsBeforeSell = (await provider.connection.getAccountInfo(curve))!.lamports;
    await launch.methods
      .sell(new BN((tokensBeforeSell / 4n).toString()), new BN(0))
      .accountsPartial(tradeAccounts)
      .rpc();
    assert.isTrue(
      BigInt((await provider.connection.getTokenAccountBalance(buyerAta)).value.amount) <
        tokensBeforeSell,
      "sell must take tokens from the seller"
    );
    assert.isBelow(
      (await provider.connection.getAccountInfo(curve))!.lamports,
      curveLamportsBeforeSell,
      "sell must pay SOL out of the curve"
    );

    // Buy in chunks: a single oversized buy quotes more tokens than the curve holds
    // as REAL reserves (quotes price on virtual+real, pay from real) and is rejected.
    for (let i = 0; i < 24; i++) {
      const c: any = await (launch.account as any).bondingCurve.fetch(curve);
      if (c.realSolReserves.gte(GRAD_TARGET.add(MIGRATION_RESERVE))) break;
      // Once the curve is fully funded (target + reserve) `buy` returns
      // AwaitingMigration — that is the SUCCESS terminator for this loop, not a
      // failure. An earlier program version returned AlreadyComplete here, which
      // made "full" and "graduated" indistinguishable.
      try {
      await launch.methods
        .buy(new BN(LAMPORTS_PER_SOL).div(new BN(2)), new BN(0))
        .accountsPartial({
          trader: wallet.publicKey,
          global: globalKey,
          feeRecipient: g.feeRecipient,
          creator: wallet.publicKey,
          mint: launchMint,
          curve,
          curveVault,
          traderTokenAccount: buyerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      } catch (e) {
        if (!String(e).includes("AwaitingMigration")) throw e;
        break;
      }
    }

    const preMigrate: any = await (launch.account as any).bondingCurve.fetch(curve);
    assert.isTrue(
      preMigrate.realSolReserves.gte(GRAD_TARGET),
      `curve did not reach the target: ${preMigrate.realSolReserves.toString()}`
    );
    assert.isFalse(preMigrate.complete, "curve should still be open before migrating");

    // ── migrate ──────────────────────────────────────────────────────────────
    const migAuth = pda([MIGRATION_AUTH_SEED, launchMint.toBuffer()], launch.programId);
    const poolState = pda([LAUNCH_POOL_SEED, launchMint.toBuffer()], launch.programId);
    const lpMint = pda([POOL_LP_MINT_SEED, poolState.toBuffer()], cpSwap.programId);
    const ammAuthority = pda([AUTH_SEED], cpSwap.programId);
    const [mint0, mint1] =
      NATIVE_MINT.toBuffer() < launchMint.toBuffer()
        ? [NATIVE_MINT, launchMint]
        : [launchMint, NATIVE_MINT];

    // ── ADVERSARIAL PRECONDITION 1: dust the migration authority's token ATA ─
    // `auth_token`'s address is derivable from the launch mint the moment the launch
    // is created, and the Associated Token Program lets ANYONE create an ATA for any
    // owner, PDA or not. SPL Token then refuses to close a NON-NATIVE account holding
    // a balance (TokenError::NonNativeHasBalance), so a single donated token unit
    // survives cp-swap's exact-amount pull and made the unconditional close revert —
    // a permissionless, ~0.002 SOL, PERMANENT graduation brick, with no path in the
    // program to ever empty that account.
    //
    // The handler now drains any residual to the curve vault before closing. Donate
    // the unit here so that regression turns this test red instead of shipping.
    const authTokenAta = getAssociatedTokenAddressSync(launchMint, migAuth, true);
    await provider.sendAndConfirm(
      new Transaction()
        .add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            authTokenAta,
            migAuth,
            launchMint
          )
        )
        .add(createTransferInstruction(buyerAta, authTokenAta, wallet.publicKey, 1)),
      []
    );
    assert.equal(
      (await provider.connection.getTokenAccountBalance(authTokenAta)).value.amount,
      "1",
      "the dust donation must really be in place or this test proves nothing"
    );

    // ── ADVERSARIAL PRECONDITION 2: occupy cp-swap's canonical pool ──────────
    // cp-swap's `initialize` is permissionless (its `creator` is documented "Can be
    // anyone") and `create_pool` refuses a `pool_state` that is no longer
    // System-owned (initialize.rs:372-374). So the canonical
    // [POOL_SEED, amm_config, mint0, mint1] address is a PUBLIC BRICK: buy one token
    // off a curve, wrap dust SOL, create that pool, and the launch could never
    // graduate. `migrate_to_amm` therefore graduates into a PDA of the LAUNCH
    // program, which nobody else can sign for.
    //
    // Occupying the canonical address here is the whole point of this block: if the
    // pool derivation ever reverts to cp-swap's canonical one, this test reverts
    // with NotApproved instead of the defect reaching mainnet.
    const squattedPool = PublicKey.findProgramAddressSync(
      [POOL_SEED, ammConfig.toBuffer(), mint0.toBuffer(), mint1.toBuffer()],
      cpSwap.programId
    )[0];
    {
      // The squatter needs both legs: launch tokens (already bought off the curve
      // above) and a little wrapped SOL.
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
      await provider.sendAndConfirm(
        new Transaction()
          .add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: wsolAta,
              lamports: LAMPORTS_PER_SOL / 100,
            })
          )
          .add(createSyncNativeInstruction(wsolAta)),
        []
      );
      const squattedLp = pda([POOL_LP_MINT_SEED, squattedPool.toBuffer()], cpSwap.programId);
      await cpSwap.methods
        .initialize(new BN(1_000_000), new BN(1_000_000), new BN(0))
        .accountsPartial({
          creator: wallet.publicKey,
          ammConfig,
          authority: ammAuthority,
          poolState: squattedPool,
          token0Mint: mint0,
          token1Mint: mint1,
          lpMint: squattedLp,
          creatorToken0: getAssociatedTokenAddressSync(mint0, wallet.publicKey),
          creatorToken1: getAssociatedTokenAddressSync(mint1, wallet.publicKey),
          creatorLpToken: getAssociatedTokenAddressSync(squattedLp, wallet.publicKey),
          token0Vault: pda(
            [POOL_VAULT_SEED, squattedPool.toBuffer(), mint0.toBuffer()],
            cpSwap.programId
          ),
          token1Vault: pda(
            [POOL_VAULT_SEED, squattedPool.toBuffer(), mint1.toBuffer()],
            cpSwap.programId
          ),
          createPoolFee: feeReceiver,
          observationState: pda([OBSERVATION_SEED, squattedPool.toBuffer()], cpSwap.programId),
          tokenProgram: TOKEN_PROGRAM_ID,
          token0Program: TOKEN_PROGRAM_ID,
          token1Program: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      assert.isNotNull(
        await provider.connection.getAccountInfo(squattedPool),
        "the canonical pool must really be occupied for this test to prove anything"
      );
      assert.notEqual(
        squattedPool.toBase58(),
        poolState.toBase58(),
        "the launch must NOT graduate into the address anyone can occupy"
      );
    }

    const rentExemptZero = await provider.connection.getMinimumBalanceForRentExemption(0);
    // cp-swap takes create_pool_fee as a native SOL transfer out of the `creator` —
    // our migration authority — and the migration reserve is what funds it. Measure
    // it across the migration specifically, so a reserve too small to cover the real
    // mainnet fee fails here instead of on mainnet.
    const feeReceiverBefore = BigInt(
      (await provider.connection.getTokenAccountBalance(feeReceiver)).value.amount
    );
    // AUDIT 2026-08-08: the unspent migration reserve used to be swept to `payer`,
    // and migration is permissionless — so any bot could call this and pocket the
    // surplus, which is money BUYERS raised (the reserve sits on top of the
    // graduation target). Capture both balances so the regression assertions below
    // can prove the surplus goes to the protocol and not to the caller.
    const payerLamportsPre =
      (await provider.connection.getAccountInfo(wallet.publicKey))!.lamports;
    const cfgFeeRecipientPre =
      (await provider.connection.getAccountInfo(cfgFeeRecipient))?.lamports ?? 0;

    const curveInfoPre = await provider.connection.getAccountInfo(curve);
    const curveLamportsPre = curveInfoPre!.lamports;
    const curveRentFloor = await provider.connection.getMinimumBalanceForRentExemption(
      curveInfoPre!.data.length
    );

    const migrateSig: string = await launch.methods
      .migrateToAmm()
      // Nothing had ever executed past the WSOL transfer before the reconciliation
      // barrier landed, so the FULL cost of this instruction (2 ATA creates, 4 of
      // our CPIs, cp-swap `initialize` creating five accounts, the LP burn) has
      // never been measured. Raise the ceiling explicitly so a compute exhaustion
      // can never be mistaken for the lamport-reconciliation bug coming back.
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .accountsPartial({
        payer: wallet.publicKey,
        global: globalKey,
        feeRecipient: cfgFeeRecipient,
        launchMint,
        curve,
        curveVault,
        wsolMint: NATIVE_MINT,
        migrationAuthority: migAuth,
        authWsol: getAssociatedTokenAddressSync(NATIVE_MINT, migAuth, true),
        authToken: getAssociatedTokenAddressSync(launchMint, migAuth, true),
        authLp: getAssociatedTokenAddressSync(lpMint, migAuth, true),
        cpSwapProgram: cpSwap.programId,
        ammConfig,
        ammAuthority,
        poolState,
        lpMint,
        token0Vault: pda([POOL_VAULT_SEED, poolState.toBuffer(), mint0.toBuffer()], cpSwap.programId),
        token1Vault: pda([POOL_VAULT_SEED, poolState.toBuffer(), mint1.toBuffer()], cpSwap.programId),
        createPoolFee: feeReceiver,
        observationState: pda([OBSERVATION_SEED, poolState.toBuffer()], cpSwap.programId),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc({ skipPreflight: false });

    // ── assert ───────────────────────────────────────────────────────────────
    const post: any = await (launch.account as any).bondingCurve.fetch(curve);
    assert.isTrue(post.complete, "curve must be closed by migration");
    assert.equal(post.pool.toBase58(), poolState.toBase58(), "curve must record its pool");
    assert.equal(post.realTokenReserves.toString(), "0", "all tokens should have moved to the pool");

    const poolAccount = await provider.connection.getAccountInfo(poolState);
    assert.isNotNull(poolAccount, "the pool must exist on-chain");

    // ── the migration reserve must not be MEV ────────────────────────────────
    // Regression test for the audit finding. The unspent reserve belongs to the
    // protocol, not to whoever won the race to call a permissionless instruction.
    const cfgFeeRecipientPost =
      (await provider.connection.getAccountInfo(cfgFeeRecipient))?.lamports ?? 0;
    const payerLamportsPost =
      (await provider.connection.getAccountInfo(wallet.publicKey))!.lamports;

    const residualToProtocol = cfgFeeRecipientPost - cfgFeeRecipientPre;
    assert.isAbove(
      residualToProtocol,
      0,
      "the unspent migration reserve must reach the config's fee recipient"
    );

    // The caller fronts a seed top-up plus two ATA rents and gets three ATA rents
    // back, so it ends slightly up — but by RENT, not by a share of the reserve.
    // Anything near the reserve size means the sweep is paying the caller again.
    const payerDelta = payerLamportsPost - payerLamportsPre;
    assert.isBelow(
      payerDelta,
      residualToProtocol,
      "the caller must never gain more than the protocol does — that is the leak"
    );
    assert.isBelow(
      payerDelta,
      MIGRATION_RESERVE.toNumber() / 2,
      "the caller's gain must be rent-scale, not reserve-scale"
    );

    // ── report the REAL compute cost ─────────────────────────────────────────
    // A green run prints no program logs, so pinning an explicit CU limit above
    // silently made consumption unobservable — "it passed" says nothing about how
    // close to the ceiling it ran. Read it off the confirmed transaction instead,
    // so the mainnet limit can be set from a measurement rather than a guess, and
    // so a change that inflates this shows up as a number moving.
    let migrateCu: number | undefined;
    for (let i = 0; i < 10 && migrateCu === undefined; i++) {
      const tx = await provider.connection.getTransaction(migrateSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      migrateCu = tx?.meta?.computeUnitsConsumed;
      if (migrateCu === undefined) await new Promise((r) => setTimeout(r, 400));
    }
    assert.isDefined(migrateCu, "compute units must be observable for the migration tx");
    console.log(`      migrate_to_amm consumed ${migrateCu} CU (limit 400,000)`);
    assert.isBelow(
      migrateCu!,
      400_000,
      "migration must fit its declared compute limit, with room to spare"
    );

    // ── the lamport move actually landed, and landed EXACTLY ──────────────────
    // `migrate_to_amm` moves `graduation_target + migration_reserve` off the curve
    // by DIRECT lamport mutation, which the runtime only sees once reconciled. A
    // wrong reconciliation is a hard revert, but a wrong AMOUNT is silent, so pin
    // it: the curve must be lighter by exactly that, and never below its rent floor.
    const curveInfoPost = await provider.connection.getAccountInfo(curve);
    assert.equal(
      curveLamportsPre - curveInfoPost!.lamports,
      GRAD_TARGET.add(MIGRATION_RESERVE).toNumber(),
      "the curve must be debited exactly target+reserve"
    );
    assert.isAtLeast(
      curveInfoPost!.lamports,
      curveRentFloor,
      "the curve must stay rent-exempt or the runtime purges it mid-life"
    );

    // The real mainnet pool-creation fee was charged, and the reserve covered it.
    // A zero here means cp-swap skipped its fee branch and the reserve is still
    // unproven, which is the state this test was silently in before.
    assert.equal(
      (
        BigInt((await provider.connection.getTokenAccountBalance(feeReceiver)).value.amount) -
        feeReceiverBefore
      ).toString(),
      CREATE_POOL_FEE.toString(),
      "cp-swap must have charged the full create_pool_fee out of the migration reserve"
    );

    // ── nothing recoverable is left stranded ─────────────────────────────────
    // Migration is permissionless, so `payer` fronts rent on two ATAs plus the
    // authority's floor, and the authority also absorbs whatever the migration
    // reserve over-provisioned. After migration NONE of it is reachable — only the
    // program signs for the authority, and a `complete` curve never releases
    // lamports — so the handler closes the three token accounts and sweeps the
    // authority to zero. Assert it actually happened: a silent regression here is a
    // permanent leak and it makes calling this instruction lose money.
    const authInfo = await provider.connection.getAccountInfo(migAuth);
    assert.isTrue(
      authInfo === null || authInfo.lamports === 0,
      `migration authority must be swept to zero, holds ${authInfo?.lamports ?? 0}`
    );
    // Belt and braces: had the sweep left a partial balance instead, it would have
    // to be rent-exempt or the SVM aborts the whole transaction after the pool was
    // already created.
    if (authInfo !== null && authInfo.lamports > 0) {
      assert.isAtLeast(authInfo.lamports, rentExemptZero, "residual must be rent-exempt");
    }
    for (const [name, addr] of [
      ["auth_wsol", getAssociatedTokenAddressSync(NATIVE_MINT, migAuth, true)],
      ["auth_token", getAssociatedTokenAddressSync(launchMint, migAuth, true)],
      ["auth_lp", getAssociatedTokenAddressSync(lpMint, migAuth, true)],
    ] as [string, PublicKey][]) {
      assert.isNull(
        await provider.connection.getAccountInfo(addr),
        `${name} must be closed so its rent goes back to the caller`
      );
    }

    // The donated dust was drained rather than left to block the close. Asserting
    // where it LANDED, not merely that migration survived: a close made conditional
    // instead of draining would also pass the checks above while silently stranding
    // the rent, so pin the actual destination.
    assert.equal(
      (await provider.connection.getTokenAccountBalance(curveVault)).value.amount,
      "1",
      "the donated token unit must be swept into the curve vault before the close"
    );

    // THE ASSERTION THIS FILE EXISTS FOR. Operator decision: burn the LP so
    // liquidity is permanently locked. A partial burn would leave the published
    // claim false while everything else looked correct.
    const lp = await getMint(provider.connection, lpMint);
    assert.equal(lp.supply.toString(), "0", "LP supply MUST be zero — the burn is the lock");
  });

  it("cannot be migrated twice", async () => {
    // Replay safety. `complete` is set by migration and migrate requires !complete,
    // so a second attempt must be refused. Re-derive the same accounts and try.
    const post: any = await (launch.account as any).bondingCurve.fetch(curve);
    assert.isTrue(post.complete, "precondition: the curve is already migrated");

    const poolState: PublicKey = post.pool;
    const lpMint = pda([POOL_LP_MINT_SEED, poolState.toBuffer()], cpSwap.programId);
    const [mint0, mint1] =
      NATIVE_MINT.toBuffer() < launchMint.toBuffer()
        ? [NATIVE_MINT, launchMint]
        : [launchMint, NATIVE_MINT];

    let rejected = false;
    try {
      await launch.methods
        .migrateToAmm()
        .accountsPartial({
          payer: wallet.publicKey,
          global: pda([GLOBAL_SEED], launch.programId),
          feeRecipient: cfgFeeRecipient,
          launchMint,
          curve,
          curveVault,
          wsolMint: NATIVE_MINT,
          migrationAuthority: pda([MIGRATION_AUTH_SEED, launchMint.toBuffer()], launch.programId),
          authWsol: getAssociatedTokenAddressSync(NATIVE_MINT, pda([MIGRATION_AUTH_SEED, launchMint.toBuffer()], launch.programId), true),
          authToken: getAssociatedTokenAddressSync(launchMint, pda([MIGRATION_AUTH_SEED, launchMint.toBuffer()], launch.programId), true),
          authLp: getAssociatedTokenAddressSync(lpMint, pda([MIGRATION_AUTH_SEED, launchMint.toBuffer()], launch.programId), true),
          cpSwapProgram: cpSwap.programId,
          ammConfig,
          ammAuthority: pda([AUTH_SEED], cpSwap.programId),
          poolState,
          lpMint,
          token0Vault: pda([POOL_VAULT_SEED, poolState.toBuffer(), mint0.toBuffer()], cpSwap.programId),
          token1Vault: pda([POOL_VAULT_SEED, poolState.toBuffer(), mint1.toBuffer()], cpSwap.programId),
          createPoolFee: feeReceiver,
          observationState: pda([OBSERVATION_SEED, poolState.toBuffer()], cpSwap.programId),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    } catch (e) {
      rejected = true;
      assert.include(
        String(e),
        "AlreadyComplete",
        `rejected, but not with AlreadyComplete — the replay guard may not be what fired. Got: ${e}`
      );
    }
    assert.isTrue(rejected, "a second migration must be refused");
  });

  it("refuses buys and sells once migrated", async () => {
    const globalKey = pda([GLOBAL_SEED], launch.programId);
    const g: any = await (launch.account as any).globalConfig.fetch(globalKey);
    const buyerAta = getAssociatedTokenAddressSync(launchMint, wallet.publicKey);

    let buyFailed = false;
    try {
      await launch.methods
        .buy(new BN(1000), new BN(0))
        .accountsPartial({
          trader: wallet.publicKey,
          global: globalKey,
          feeRecipient: g.feeRecipient,
          creator: wallet.publicKey,
          mint: launchMint,
          curve,
          curveVault,
          traderTokenAccount: buyerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e) {
      // Must be refused BECAUSE the curve is complete. A fully-funded but
      // un-migrated curve also refuses buys (AwaitingMigration), so accepting any
      // failure here would pass even if migration never happened — which is
      // exactly what this test did before.
      buyFailed = String(e).includes("AlreadyComplete");
      if (!buyFailed) throw new Error(`buy failed for the WRONG reason: ${e}`);
    }
    assert.isTrue(buyFailed, "buy must be refused with AlreadyComplete");

    let sellFailed = false;
    try {
      await launch.methods
        .sell(new BN(1000), new BN(0))
        .accountsPartial({
          trader: wallet.publicKey,
          global: globalKey,
          feeRecipient: g.feeRecipient,
          creator: wallet.publicKey,
          mint: launchMint,
          curve,
          curveVault,
          traderTokenAccount: buyerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e) {
      sellFailed = String(e).includes("AlreadyComplete");
      if (!sellFailed) throw new Error(`sell failed for the WRONG reason: ${e}`);
    }
    assert.isTrue(sellFailed, "sell must be refused with AlreadyComplete");
  });
});
