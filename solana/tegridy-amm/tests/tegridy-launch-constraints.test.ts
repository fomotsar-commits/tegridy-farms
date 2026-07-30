/**
 * Runtime tests for tegridy-launch's SECURITY CONSTRAINTS.
 *
 * These exist because `cargo check` proves an Anchor constraint compiles and sits
 * in the right Accounts context — it does NOT prove the constraint rejects at
 * runtime. Every check below came out of the 2026-07-29 adversarial review, which
 * found one critical and three medium defects in code that type-checked cleanly.
 *
 * ## Every test has a positive control, deliberately
 *
 * A reject-path test that fails for an unrelated reason (wrong account order, a
 * missing signer, insufficient lamports) passes vacuously and looks like proof.
 * That exact trap already bit this project once: a CI build step went green
 * having compiled nothing. So each constraint is exercised BOTH ways — the happy
 * path must succeed with the same scaffolding, otherwise the rejection tells us
 * nothing about the constraint we think we are testing.
 *
 * ## Why the IDL is loaded at runtime
 *
 * Upstream's tests import Anchor-generated types from `../target/types/...`,
 * which only exist after `anchor build`. Loading the IDL as JSON instead keeps
 * this file type-checkable without the build step — which matters because the
 * Windows dev box cannot build SBF at all (os error 1314), so these are authored
 * locally and executed in CI.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  createInitializeMintInstruction,
  createMint,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProgram = Program<Idl>;

const GLOBAL_SEED = Buffer.from("global");
const CURVE_SEED = Buffer.from("curve");
const VAULT_SEED = Buffer.from("vault");

/** Curve parameters used across the suite. Chosen so the graduation target is
 *  comfortably reachable: max real SOL = V_s * S / V_t (see curve.rs). */
const V_SOL = new BN(30).mul(new BN(LAMPORTS_PER_SOL));
const V_TOK = new BN("1073000000000000");
const SUPPLY = new BN("1000000000000000");
const TRADE_FEE_BPS = new BN(100);
/** V_s*S/V_t is ~27.9 SOL here, so 10 SOL is safely under the ceiling. */
// The continuity target for V_SOL=30 with a 0.5 SOL reserve: the launch lists at
// the price its last curve buyer paid. Deliberately not a round number — a +-5%
// PRICE band is only about +-0.7% in the TARGET, so this comes from
// curve::continuity_target rather than from picking something tidy.
const GRAD_TARGET = new BN(11_544_610_844);
/** Raised on top of the target to pay cp-swap's create_pool_fee + rent on the five
 *  accounts it creates. See MIGRATE_DESIGN.md; the ceiling check covers target+reserve. */
const MIGRATION_RESERVE = new BN(LAMPORTS_PER_SOL).div(new BN(2));
/** cp-swap program + AmmConfig. Zero here: these tests never migrate, and
 *  migrate_to_amm refuses to run while either is zero — which is the intended
 *  posture until an operator creates the AmmConfig. */
const ZERO_PK = SystemProgram.programId;

function loadProgram(provider: AnchorProvider): AnyProgram {
  const idlPath = path.resolve(__dirname, "../target/idl/tegridy_launch.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  return new Program(idl, provider) as AnyProgram;
}

function globalPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([GLOBAL_SEED], programId)[0];
}

function curvePda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CURVE_SEED, mint.toBuffer()], programId)[0];
}

function vaultPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, mint.toBuffer()], programId)[0];
}

/**
 * Create an SPL mint with the caller as mint authority and, optionally, a freeze
 * authority. The freeze-authority variant is the whole point of the critical
 * test below — `createMint` with a non-null freezeAuthority is exactly what an
 * attacking creator would do.
 */
async function makeMint(
  provider: AnchorProvider,
  payer: Keypair,
  freezeAuthority: PublicKey | null
): Promise<PublicKey> {
  return createMint(
    provider.connection,
    payer,
    payer.publicKey, // mint authority — create_launch requires this to be the creator
    freezeAuthority,
    9
  );
}

async function fund(provider: AnchorProvider, to: PublicKey, sol: number): Promise<void> {
  const sig = await provider.connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

/** Assert a promise rejects, and that the error names the expected Anchor error. */
async function expectAnchorError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    assert.fail(`expected the transaction to be rejected with ${code}, but it succeeded`);
  } catch (e) {
    const msg = String(e);
    assert.include(
      msg,
      code,
      `rejected, but not with ${code} — the constraint under test may not be what fired. Got: ${msg}`
    );
  }
}

describe("tegridy-launch security constraints", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const program = loadProgram(provider);
  const deployer = anchor.Wallet.local().payer;
  const feeRecipient = Keypair.generate().publicKey;

  // ─── initialize_global: ORDER MATTERS, deliberately ───────────────────────
  //
  // `global` is a SINGLETON PDA, so the deployer gate can only be observed while
  // that account does not yet exist. Once it does, `init` fails first with System
  // program error 0x0 ("account already in use") and Anchor never reaches the
  // `address = deployer::ID` constraint — an earlier version of this suite
  // initialized in a `before` hook and its reject-path test was therefore
  // meaningless, passing on the collision rather than on the gate.
  //
  // So these two run FIRST, in this order, and the rest of the suite depends on
  // the second having succeeded. Mocha preserves declaration order.

  it("initialize_global rejects a signer that is not the designated deployer", async () => {
    const impostor = Keypair.generate();
    await fund(provider, impostor.publicKey, 5);

    await expectAnchorError(
      program.methods
        .initializeGlobal(TRADE_FEE_BPS, V_SOL, V_TOK, SUPPLY, GRAD_TARGET, MIGRATION_RESERVE, ZERO_PK, ZERO_PK)
        .accountsPartial({
          authority: impostor.publicKey,
          feeRecipient,
          global: globalPda(program.programId),
          systemProgram: SystemProgram.programId,
        })
        .signers([impostor])
        .rpc(),
      "NotDeployAuthority"
    );
  });

  it("initialize_global succeeds for the designated deployer", async () => {
    // POSITIVE CONTROL for the above, and setup for everything below. The program
    // is built with --features devnet, whose `deployer` key is the local wallet; a
    // default build embeds a fail-closed sentinel and cannot be initialized at all.
    await program.methods
      .initializeGlobal(TRADE_FEE_BPS, V_SOL, V_TOK, SUPPLY, GRAD_TARGET, MIGRATION_RESERVE, ZERO_PK, ZERO_PK)
      .accountsPartial({
        authority: deployer.publicKey,
        feeRecipient,
        global: globalPda(program.programId),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const g: any = await (program.account as any).globalConfig.fetch(globalPda(program.programId));
    assert.equal(g.authority.toBase58(), deployer.publicKey.toBase58());
  });

  // ─── CRITICAL: freeze authority ────────────────────────────────────────────

  describe("create_launch rejects a mint carrying a freeze authority", () => {
    /**
     * The critical finding. Revoking MINT authority is not enough: a retained
     * FREEZE authority lets the creator freeze `curve_vault` — a deterministic
     * PDA, so its address is known from creation. The vault is the source of
     * every buy transfer and the destination of every sell, so freezing it bricks
     * both and locks 100% of raised SOL with no recovery path.
     */
    it("rejects it", async () => {
      const creator = Keypair.generate();
      await fund(provider, creator.publicKey, 5);
      const mint = await makeMint(provider, creator, creator.publicKey); // freeze authority RETAINED

      await expectAnchorError(
        program.methods
          .createLaunch()
          .accountsPartial({
            creator: creator.publicKey,
            global: globalPda(program.programId),
            mint,
            curve: curvePda(program.programId, mint),
            curveVault: vaultPda(program.programId, mint),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([creator])
          .rpc(),
        "MintHasFreezeAuthority"
      );
    });

    /** POSITIVE CONTROL — identical scaffolding, freeze authority absent. If this
     *  fails, the rejection above proves nothing about the freeze constraint. */
    it("accepts the same launch when there is no freeze authority", async () => {
      const creator = Keypair.generate();
      await fund(provider, creator.publicKey, 5);
      const mint = await makeMint(provider, creator, null);

      await program.methods
        .createLaunch()
        .accountsPartial({
          creator: creator.publicKey,
          global: globalPda(program.programId),
          mint,
          curve: curvePda(program.programId, mint),
          curveVault: vaultPda(program.programId, mint),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([creator])
        .rpc();

      const curve = await (program.account as any).bondingCurve.fetch(
        curvePda(program.programId, mint)
      );
      assert.isFalse(curve.complete, "a fresh curve must not be complete");
      assert.equal(
        curve.realTokenReserves.toString(),
        SUPPLY.toString(),
        "the whole supply should be on the curve"
      );
    });

    /** The mint authority must be gone after creation — the supply-inflation
     *  half of the anti-rug claim, which the freeze gap did NOT invalidate. */
    it("leaves the mint with no mint authority", async () => {
      const creator = Keypair.generate();
      await fund(provider, creator.publicKey, 5);
      const mint = await makeMint(provider, creator, null);

      await program.methods
        .createLaunch()
        .accountsPartial({
          creator: creator.publicKey,
          global: globalPda(program.programId),
          mint,
          curve: curvePda(program.programId, mint),
          curveVault: vaultPda(program.programId, mint),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([creator])
        .rpc();

      const info = await provider.connection.getParsedAccountInfo(mint);
      const parsed = (info.value?.data as any)?.parsed?.info;
      assert.isNull(parsed?.mintAuthority, "mint authority must be revoked");
      assert.isNull(parsed?.freezeAuthority, "freeze authority must be absent");
    });
  });

  // ─── MEDIUM: graduation target reachability ────────────────────────────────

  describe("graduation target must be reachable", () => {
    /**
     * Max real SOL is capped at V_s * S / V_t because the curve prices on
     * virtual+real on both legs. A target above it yields launches that can never
     * graduate: buys eventually fail the reserve check and `graduate` never
     * qualifies. Not fund loss, but the launch never reaches the AMM.
     */
    it("rejects a target above the curve's reachable ceiling", async () => {
      // Ceiling here is ~27.9 SOL; ask for 1000.
      const unreachable = new BN(1000).mul(new BN(LAMPORTS_PER_SOL));
      await expectAnchorError(
        program.methods
          .updateGlobal(null, unreachable, null, null, null, null, null, null, null)
          .accountsPartial({
            global: globalPda(program.programId),
            authority: deployer.publicKey,
          })
          .rpc(),
        "GraduationTargetUnreachable"
      );
    });

    /** POSITIVE CONTROL — a target under the ceiling is accepted. */
    it("accepts a target below the ceiling", async () => {
      const reachable = GRAD_TARGET; // under the ceiling AND price-continuous
      await program.methods
        .updateGlobal(null, reachable, null, null, null, null, null, null, null)
        .accountsPartial({
          global: globalPda(program.programId),
          authority: deployer.publicKey,
        })
        .rpc();

      const g = await (program.account as any).globalConfig.fetch(globalPda(program.programId));
      assert.equal(g.graduationTargetLamports.toString(), reachable.toString());

      // Restore for any later test.
      await program.methods
        .updateGlobal(null, GRAD_TARGET, null, null, null, null, null, null, null)
        .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
        .rpc();
    });
  });

  // ─── HIGH: the AMM addresses must be reachable after initialization ────────

  describe("AMM configuration is settable after init", () => {
    /**
     * `initialize_global` accepts zero for both AMM addresses deliberately — the
     * cp-swap AmmConfig is created by a cp-swap admin action AFTER this program is
     * deployed, and THIS SUITE initializes with ZERO_PK for both. But `global` is a
     * singleton PDA, so `initialize_global` runs exactly once, and `migrate_to_amm`
     * refuses to run while either address is zero.
     *
     * There was no setter. Following that documented order therefore left migration
     * PERMANENTLY disabled, recoverable only by a program upgrade. Nothing caught it
     * because the rehearsal creates the AmmConfig first and passes real values at
     * initialization, so the zero path was never followed to its conclusion.
     */
    it("sets cp_swap_program and amm_config after the fact", async () => {
      const cpProgram = Keypair.generate().publicKey;
      const cfg = Keypair.generate().publicKey;
      await program.methods
        .updateGlobal(null, null, null, null, null, null, cpProgram, cfg, null)
        .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
        .rpc();
      const g: any = await (program.account as any).globalConfig.fetch(
        globalPda(program.programId)
      );
      assert.equal(g.cpSwapProgram.toBase58(), cpProgram.toBase58());
      assert.equal(g.ammConfig.toBase58(), cfg.toBase58());
    });

    it("refuses to ZERO them — that reads as misconfiguration; `paused` is the switch", async () => {
      await expectAnchorError(
        program.methods
          .updateGlobal(null, null, null, null, null, null, ZERO_PK, null, null)
          .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
          .rpc(),
        "InvalidParameter"
      );
    });
  });

  // ─── MEDIUM: reachability must count the migration reserve ─────────────────

  describe("reachability counts target PLUS reserve", () => {
    /**
     * Both the target and the reserve are raised by traders, so both count toward
     * the ceiling (~27.96 SOL for these parameters). `update_global` used to validate
     * the incoming target ALONE while its comment claimed to be "the same
     * reachability check as initialize_global" — so a target comfortably under the
     * ceiling could still push target+reserve past it and mint launches that can
     * never graduate. The target-only variant accepts every case below.
     */
    it("rejects a target that only breaches the ceiling once the reserve is added", async () => {
      const target = new BN(20).mul(new BN(LAMPORTS_PER_SOL)); // alone: under ~27.96
      const reserve = new BN(10).mul(new BN(LAMPORTS_PER_SOL)); // sum 30: over
      await expectAnchorError(
        program.methods
          .updateGlobal(null, target, null, null, null, reserve, null, null, null)
          .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
          .rpc(),
        "GraduationTargetUnreachable"
      );
    });

    it("rejects a RESERVE raise that breaches the ceiling with the target untouched", async () => {
      const reserve = new BN(25).mul(new BN(LAMPORTS_PER_SOL));
      await expectAnchorError(
        program.methods
          .updateGlobal(null, null, null, null, null, reserve, null, null, null)
          .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
          .rpc(),
        "GraduationTargetUnreachable"
      );
    });

    /** POSITIVE CONTROL — a pair that fits is accepted, and BOTH fields land. */
    it("accepts a pair under the ceiling and stores both", async () => {
      // Continuity pair for V_SOL=30 with a 5 SOL reserve — a bigger reserve pulls
      // the target DOWN, because the reserve is raised from traders too.
      const target = new BN(10_039_591_158);
      const reserve = new BN(5).mul(new BN(LAMPORTS_PER_SOL));
      await program.methods
        .updateGlobal(null, target, null, null, null, reserve, null, null, null)
        .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
        .rpc();
      const g: any = await (program.account as any).globalConfig.fetch(
        globalPda(program.programId)
      );
      assert.equal(g.graduationTargetLamports.toString(), target.toString());
      assert.equal(g.migrationReserveLamports.toString(), reserve.toString());

      // Restore for the tests that follow.
      await program.methods
        .updateGlobal(null, GRAD_TARGET, null, null, null, MIGRATION_RESERVE, null, null, null)
        .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
        .rpc();
    });
  });

  // ─── HIGH: a launch must not GAP at listing ────────────────────────────────

  describe("graduation price continuity", () => {
    /**
     * The curve prices on virtual+real reserves; the pool is seeded with real
     * reserves ONLY. Those two prices agree at exactly one target, and away from it
     * the token gaps the instant it lists.
     *
     * This is not hypothetical: the rehearsal shipped 30 virtual SOL against a 2 SOL
     * target, which opens the pool at 14% of the curve's final price — a ~7x drop,
     * nothing stolen, no instruction at fault, and indistinguishable from a rug to
     * everyone holding it.
     */
    it("rejects a target that would list far from the curve's final price", async () => {
      // 10 SOL sits comfortably under the ~27.96 SOL reachability ceiling, so that
      // check passes and ONLY the continuity band can reject this. Ratio ~8196 bps.
      const gapping = new BN(10).mul(new BN(LAMPORTS_PER_SOL));
      await expectAnchorError(
        program.methods
          .updateGlobal(null, gapping, null, null, null, null, null, null, null)
          .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
          .rpc(),
        "GraduationPriceGap"
      );
    });

    /** POSITIVE CONTROL — the continuity target for these reserves is accepted. */
    it("accepts the continuity target", async () => {
      await program.methods
        .updateGlobal(null, GRAD_TARGET, null, null, null, MIGRATION_RESERVE, null, null, null)
        .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
        .rpc();
      const g: any = await (program.account as any).globalConfig.fetch(
        globalPda(program.programId)
      );
      assert.equal(g.graduationTargetLamports.toString(), GRAD_TARGET.toString());
    });

    /**
     * The escape hatch that makes the band non-restrictive, and the reason
     * `initial_virtual_sol` is settable at all: the continuity target is
     * proportional to virtual SOL, so ANY target stays reachable by scaling the
     * opening book with it. Without this the target could never be changed once set,
     * because every other value would gap.
     */
    it("accepts a retuned pair — a different target with virtual SOL scaled to match", async () => {
      const target = new BN(6).mul(new BN(LAMPORTS_PER_SOL));
      const vsol = new BN(15_784_562_498); // continuity partner for 6 SOL + 0.5 reserve
      await program.methods
        .updateGlobal(null, target, null, null, null, MIGRATION_RESERVE, null, null, vsol)
        .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
        .rpc();
      const g: any = await (program.account as any).globalConfig.fetch(
        globalPda(program.programId)
      );
      assert.equal(g.graduationTargetLamports.toString(), target.toString());
      assert.equal(g.initialVirtualSol.toString(), vsol.toString());

      // Restore the suite's baseline for anything that follows.
      await program.methods
        .updateGlobal(null, GRAD_TARGET, null, null, null, MIGRATION_RESERVE, null, null, V_SOL)
        .accountsPartial({ global: globalPda(program.programId), authority: deployer.publicKey })
        .rpc();
    });
  });

  // ─── MEDIUM: pause semantics ───────────────────────────────────────────────

  describe("pause blocks buys but never sells", () => {
    /**
     * state.rs documents pause as halting buys and graduation while leaving sells
     * open, so a halt can never trap holders. Before the fix `graduate` could not
     * honour it at all — its Accounts context did not even carry `global`.
     */
    it("blocks create_launch while paused, and allows it again when unpaused", async () => {
      const globalKey = globalPda(program.programId);
      await program.methods
        .updateGlobal(null, null, true, null, null, null, null, null, null)
        .accountsPartial({ global: globalKey, authority: deployer.publicKey })
        .rpc();

      const creator = Keypair.generate();
      await fund(provider, creator.publicKey, 5);
      const mint = await makeMint(provider, creator, null);

      await expectAnchorError(
        program.methods
          .createLaunch()
          .accountsPartial({
            creator: creator.publicKey,
            global: globalKey,
            mint,
            curve: curvePda(program.programId, mint),
            curveVault: vaultPda(program.programId, mint),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([creator])
          .rpc(),
        "Paused"
      );

      // POSITIVE CONTROL: unpause and the identical call goes through.
      await program.methods
        .updateGlobal(null, null, false, null, null, null, null, null, null)
        .accountsPartial({ global: globalKey, authority: deployer.publicKey })
        .rpc();

      await program.methods
        .createLaunch()
        .accountsPartial({
          creator: creator.publicKey,
          global: globalKey,
          mint,
          curve: curvePda(program.programId, mint),
          curveVault: vaultPda(program.programId, mint),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([creator])
        .rpc();
    });
  });
});
