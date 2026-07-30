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
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

type AnyProgram = Program<Idl>;

const GLOBAL_SEED = Buffer.from("global");
const CURVE_SEED = Buffer.from("curve");
const VAULT_SEED = Buffer.from("vault");
/** Data-less PDA that acts as cp-swap's creator — it must be System-owned to
 *  pay rent for the five accounts cp-swap inits. See MIGRATION_AUTH_SEED. */
const MIGRATION_AUTH_SEED = Buffer.from("migauth");

// cp-swap seeds — from programs/cp-swap/src/states/{config,pool}.rs and lib.rs.
const AMM_CONFIG_SEED = Buffer.from("amm_config");
const POOL_SEED = Buffer.from("pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const POOL_LP_MINT_SEED = Buffer.from("pool_lp_mint");
const OBSERVATION_SEED = Buffer.from("observation");
const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");

/** Deliberately small so the whole curve can be bought out inside a test. */
const V_SOL = new BN(30).mul(new BN(LAMPORTS_PER_SOL));
const V_TOK = new BN("1073000000000000");
const SUPPLY = new BN("1000000000000000");
const TRADE_FEE_BPS = new BN(100);
const GRAD_TARGET = new BN(2).mul(new BN(LAMPORTS_PER_SOL));
/** Must cover cp-swap's create_pool_fee + rent on the five accounts it creates. */
const MIGRATION_RESERVE = new BN(LAMPORTS_PER_SOL).div(new BN(4));

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
      .createAmmConfig(index, new BN(2500), new BN(120000), new BN(0), new BN(0), new BN(0))
      .accountsPartial({
        owner: wallet.publicKey,
        ammConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await launch.methods
      .initializeGlobal(
        TRADE_FEE_BPS,
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
      .createLaunch()
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
    const poolState = PublicKey.findProgramAddressSync(
      [
        POOL_SEED,
        ammConfig.toBuffer(),
        ...(NATIVE_MINT.toBuffer() < launchMint.toBuffer()
          ? [NATIVE_MINT.toBuffer(), launchMint.toBuffer()]
          : [launchMint.toBuffer(), NATIVE_MINT.toBuffer()]),
      ],
      cpSwap.programId
    )[0];
    const lpMint = pda([POOL_LP_MINT_SEED, poolState.toBuffer()], cpSwap.programId);
    const ammAuthority = pda([AUTH_SEED], cpSwap.programId);
    const [mint0, mint1] =
      NATIVE_MINT.toBuffer() < launchMint.toBuffer()
        ? [NATIVE_MINT, launchMint]
        : [launchMint, NATIVE_MINT];

    await launch.methods
      .migrateToAmm()
      .accountsPartial({
        payer: wallet.publicKey,
        global: globalKey,
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
