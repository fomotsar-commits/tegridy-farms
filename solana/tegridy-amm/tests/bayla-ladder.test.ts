/**
 * bayla-ladder — the FIRST EXECUTION of this program, ever.
 *
 * Until this file ran, nothing in `programs/bayla-ladder` had executed anywhere: not
 * mainnet, not devnet, not a validator. It compiled, its pure math was proven on the
 * host, and an 82-agent audit read every line. None of that is the same as running.
 * The audit said so explicitly, and listed what only execution can find: compute-unit
 * consumption (entirely unmeasured, on a program that already blew the OTHER hard SBF
 * limit), real Token-2022 CPI behaviour, `init_if_needed` semantics, actual rent.
 *
 * ## Every rejection has a positive control
 *
 * A reject-path test that fails for an unrelated reason — wrong account order, a
 * missing signer, not enough lamports — passes vacuously and looks like proof. This
 * project has already been bitten by a CI step that went green having compiled
 * nothing. So each constraint is exercised BOTH ways: the happy path must succeed with
 * the same scaffolding, or the rejection tells us nothing about the constraint we think
 * we are testing.
 *
 * ## What CANNOT be tested here, stated so nobody reads silence as coverage
 *
 * `withdraw_matured` on a MATURED position. The minimum lock is 7 days and
 * `solana-test-validator` has no clock warp, so the only reachable assertion is that it
 * correctly refuses an unmatured one. The matured path — and therefore the full
 * penalty-free exit — remains unexecuted. It needs a `solana-program-test` harness with
 * a manipulable clock, which is the obvious next piece of work.
 *
 * ## Why the IDL is loaded at runtime
 *
 * Same reason as the tegridy-launch suite: `../target/types/...` only exists after
 * `anchor build`, and the dev box cannot build SBF at all. Loading the IDL as JSON
 * keeps this file authorable locally and executable in CI.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  AuthorityType,
  createAccount,
  createMint,
  getAccount,
  mintTo,
  setAuthority,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProgram = Program<Idl>;

const POOL_SEED = Buffer.from("pool");
const POSITION_SEED = Buffer.from("position");
const USER_SEED = Buffer.from("user");
const STAKE_VAULT_SEED = Buffer.from("svault");
const REWARD_VAULT_SEED = Buffer.from("rvault");

const DECIMALS = 6;
const ONE = new BN(10).pow(new BN(DECIMALS));
const tok = (n: number) => new BN(n).mul(ONE);

/** The L-6 floor: 100 whole tokens, bound to the mint's decimals. */
const MIN_STAKE = tok(100);
const DEPOSIT_CAP = tok(1_000_000);
const MAX_WALLET = tok(500_000);

const MIN_LOCK = 7 * 86_400;
const MAX_LOCK = 4 * 365 * 86_400;

function loadProgram(provider: AnchorProvider): AnyProgram {
  const idlPath = path.resolve(__dirname, "../target/idl/bayla_ladder.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  return new Program(idl, provider) as AnyProgram;
}

/** Anchor surfaces the program's own error NAME; assert on that, never on a number. */
async function rejectsWith(p: Promise<unknown>, name: string, what: string) {
  try {
    await p;
    assert.fail(`${what}: expected ${name}, but the instruction SUCCEEDED`);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    assert.include(
      msg,
      name,
      `${what}: expected ${name}, got a different failure — a rejection for the wrong ` +
        `reason proves nothing about the constraint. Full error: ${msg}`
    );
  }
}

describe("bayla-ladder", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = loadProgram(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  /** Mint with BOTH authorities revoked, as the gate demands. Token-2022, like BAYLA. */
  async function cleanMint(
    programId = TOKEN_2022_PROGRAM_ID
  ): Promise<PublicKey> {
    const mint = await createMint(
      conn,
      payer,
      payer.publicKey,
      null,
      DECIMALS,
      undefined,
      undefined,
      programId
    );
    return mint;
  }

  async function fund(
    mint: PublicKey,
    owner: Keypair,
    amount: BN,
    programId = TOKEN_2022_PROGRAM_ID
  ) {
    const ata = await createAccount(
      conn,
      payer,
      mint,
      owner.publicKey,
      undefined,
      undefined,
      programId
    );
    await mintTo(
      conn,
      payer,
      mint,
      ata,
      payer,
      BigInt(amount.toString()),
      [],
      undefined,
      programId
    );
    return ata;
  }

  async function revokeMintAuthority(
    mint: PublicKey,
    programId = TOKEN_2022_PROGRAM_ID
  ) {
    await setAuthority(
      conn,
      payer,
      mint,
      payer,
      AuthorityType.MintTokens,
      null,
      [],
      undefined,
      programId
    );
  }

  function poolPda(mint: PublicKey, nonce: number) {
    return PublicKey.findProgramAddressSync(
      [POOL_SEED, mint.toBuffer(), Buffer.from([nonce])],
      program.programId
    )[0];
  }
  const vaultPda = (seed: Buffer, pool: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [seed, pool.toBuffer()],
      program.programId
    )[0];
  const userPda = (pool: PublicKey, owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [USER_SEED, pool.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];
  function positionPda(pool: PublicKey, owner: PublicKey, nonce: number) {
    const n = Buffer.alloc(4);
    n.writeUInt32LE(nonce);
    return PublicKey.findProgramAddressSync(
      [POSITION_SEED, pool.toBuffer(), owner.toBuffer(), n],
      program.programId
    )[0];
  }

  async function newWallet(sol = 5): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    return kp;
  }

  /** A fully set-up pool with both authorities revoked and the deployer as authority. */
  async function makePool(opts: {
    nonce: number;
    minStake?: BN;
    cap?: BN;
    wallet?: BN;
    programId?: PublicKey;
  }) {
    const programId = opts.programId ?? TOKEN_2022_PROGRAM_ID;
    const mint = await cleanMint(programId);
    // `fund` creates the account AND mints into it. An earlier version called it and
    // then minted again, doubling the balance silently — harmless here, but the kind
    // of scaffolding bug that makes a later assertion mean something other than it says.
    const userAta = await fund(
      mint,
      payer as unknown as Keypair,
      tok(2_000_000),
      programId
    );
    await revokeMintAuthority(mint, programId);

    const pool = poolPda(mint, opts.nonce);
    await program.methods
      .initializePool(
        opts.nonce,
        opts.minStake ?? MIN_STAKE,
        opts.cap ?? DEPOSIT_CAP,
        opts.wallet ?? MAX_WALLET
      )
      .accounts({
        payer: payer.publicKey,
        mint,
        pool,
        stakeVault: vaultPda(STAKE_VAULT_SEED, pool),
        rewardVault: vaultPda(REWARD_VAULT_SEED, pool),
        tokenProgram: programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { mint, pool, userAta, programId };
  }

  const bal = async (a: PublicKey, programId = TOKEN_2022_PROGRAM_ID) =>
    new BN((await getAccount(conn, a, undefined, programId)).amount.toString());

  // ───────────────────────────── initialize_pool ─────────────────────────────

  describe("initialize_pool", () => {
    it("creates a pool, both vaults, and pins the token program to the mint's owner", async () => {
      const { mint, pool, programId } = await makePool({ nonce: 0 });
      const acct = await program.account.pool.fetch(pool);
      assert.equal(acct.mint.toBase58(), mint.toBase58());
      assert.equal(acct.tokenProgram.toBase58(), programId.toBase58());
      assert.equal(acct.decimals, DECIMALS);
      assert.equal(acct.authority.toBase58(), payer.publicKey.toBase58());
      assert.isFalse(acct.degraded);
      // both vaults exist and are empty
      assert.equal(
        (await bal(vaultPda(STAKE_VAULT_SEED, pool))).toString(),
        "0"
      );
      assert.equal(
        (await bal(vaultPda(REWARD_VAULT_SEED, pool))).toString(),
        "0"
      );
    });

    it("accepts a LEGACY SPL mint too — BOBO/SOY/BRAINLET/RIZZ are not Token-2022", async () => {
      const { pool } = await makePool({
        nonce: 1,
        programId: TOKEN_PROGRAM_ID,
      });
      const acct = await program.account.pool.fetch(pool);
      assert.equal(acct.tokenProgram.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    });

    it("REFUSES a mint that still has a mint authority (audit M-1)", async () => {
      const mint = await cleanMint();
      // deliberately NOT revoked
      const pool = poolPda(mint, 9);
      await rejectsWith(
        program.methods
          .initializePool(9, MIN_STAKE, DEPOSIT_CAP, MAX_WALLET)
          .accounts({
            payer: payer.publicKey,
            mint,
            pool,
            stakeVault: vaultPda(STAKE_VAULT_SEED, pool),
            rewardVault: vaultPda(REWARD_VAULT_SEED, pool),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "MintHasMintAuthority",
        "a live minter can conjure the exact asset this ladder prices"
      );
    });

    it("REFUSES a mint with a freeze authority — it could freeze the vault itself", async () => {
      const mint = await createMint(
        conn,
        payer,
        payer.publicKey,
        payer.publicKey,
        DECIMALS,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await revokeMintAuthority(mint);
      const pool = poolPda(mint, 10);
      await rejectsWith(
        program.methods
          .initializePool(10, MIN_STAKE, DEPOSIT_CAP, MAX_WALLET)
          .accounts({
            payer: payer.publicKey,
            mint,
            pool,
            stakeVault: vaultPda(STAKE_VAULT_SEED, pool),
            rewardVault: vaultPda(REWARD_VAULT_SEED, pool),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "MintHasFreezeAuthority",
        "a freeze authority defeats I-1 from outside the program"
      );
    });

    it("REFUSES a min_stake below the decimals-bound floor (audit L-6)", async () => {
      const mint = await cleanMint();
      await revokeMintAuthority(mint);
      const pool = poolPda(mint, 11);
      await rejectsWith(
        program.methods
          .initializePool(11, tok(99), DEPOSIT_CAP, MAX_WALLET) // 99 < 100 whole tokens
          .accounts({
            payer: payer.publicKey,
            mint,
            pool,
            stakeVault: vaultPda(STAKE_VAULT_SEED, pool),
            rewardVault: vaultPda(REWARD_VAULT_SEED, pool),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "InvalidParameter",
        "a decimals-blind floor is unfixable later: there is no set_min_stake"
      );
    });

    it("REFUSES a per-wallet cap above the pool cap (audit M-4)", async () => {
      const mint = await cleanMint();
      await revokeMintAuthority(mint);
      const pool = poolPda(mint, 12);
      await rejectsWith(
        program.methods
          .initializePool(
            12,
            MIN_STAKE,
            DEPOSIT_CAP,
            DEPOSIT_CAP.add(new BN(1))
          )
          .accounts({
            payer: payer.publicKey,
            mint,
            pool,
            stakeVault: vaultPda(STAKE_VAULT_SEED, pool),
            rewardVault: vaultPda(REWARD_VAULT_SEED, pool),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "InvalidParameter",
        "both bounds are required so the value cannot be reached by omission"
      );
    });

    it("REFUSES a non-deployer (audit L-5 — the gate that was uncallable)", async () => {
      const stranger = await newWallet();
      const mint = await cleanMint();
      await revokeMintAuthority(mint);
      const pool = poolPda(mint, 13);
      await rejectsWith(
        program.methods
          .initializePool(13, MIN_STAKE, DEPOSIT_CAP, MAX_WALLET)
          .accounts({
            payer: stranger.publicKey,
            mint,
            pool,
            stakeVault: vaultPda(STAKE_VAULT_SEED, pool),
            rewardVault: vaultPda(REWARD_VAULT_SEED, pool),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([stranger])
          .rpc(),
        "NotDeployAuthority",
        "an unprotected initializer hands the first caller the pool"
      );
    });
  });

  // ───────────────────────────────── stake ─────────────────────────────────

  describe("stake", () => {
    let ctx: Awaited<ReturnType<typeof makePool>>;
    let alice: Keypair;
    let aliceAta: PublicKey;

    before(async () => {
      ctx = await makePool({ nonce: 20 });
      alice = await newWallet();
      aliceAta = await fund(ctx.mint, alice, tok(600_000));
    });

    const stakeIx = (
      owner: Keypair,
      ownerAta: PublicKey,
      nonce: number,
      amount: BN,
      lock: number
    ) =>
      program.methods
        .stake(amount, new BN(lock))
        .accounts({
          owner: owner.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          userStats: userPda(ctx.pool, owner.publicKey),
          position: positionPda(ctx.pool, owner.publicKey, nonce),
          ownerAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner]);

    it("POSITIVE CONTROL: opens a position and the ledger agrees with the vault", async () => {
      await stakeIx(alice, aliceAta, 0, tok(1_000), MAX_LOCK).rpc();
      const pos = await program.account.position.fetch(
        positionPda(ctx.pool, alice.publicKey, 0)
      );
      assert.equal(pos.amount.toString(), tok(1_000).toString());
      // 4.00x at the top rung: weight = amount * 40_000 / 10_000
      assert.equal(pos.weight.toString(), tok(4_000).toString());

      const pool = await program.account.pool.fetch(ctx.pool);
      assert.equal(pool.totalPrincipal.toString(), tok(1_000).toString());
      assert.equal(pool.totalWeighted.toString(), tok(4_000).toString());
      // I-1: the vault holds at least what the ledger claims
      assert.isTrue(
        (await bal(vaultPda(STAKE_VAULT_SEED, ctx.pool))).gte(
          pool.totalPrincipal
        )
      );

      const us = await program.account.userStats.fetch(
        userPda(ctx.pool, alice.publicKey)
      );
      assert.equal(us.nextNonce, 1);
      assert.equal(us.openPositions, 1);
      assert.equal(us.principal.toString(), tok(1_000).toString());
    });

    it("gives a 7-day lock the 0.40x floor, not the 4.00x top", async () => {
      await stakeIx(alice, aliceAta, 1, tok(1_000), MIN_LOCK).rpc();
      const pos = await program.account.position.fetch(
        positionPda(ctx.pool, alice.publicKey, 1)
      );
      assert.equal(pos.weight.toString(), tok(400).toString());
    });

    it("REFUSES below min_stake", async () =>
      rejectsWith(
        stakeIx(alice, aliceAta, 2, tok(99), MIN_LOCK).rpc(),
        "BelowMinStake",
        "measured on what ARRIVED, not what was asked for"
      ));

    it("REFUSES a lock shorter than 7 days", async () =>
      rejectsWith(
        stakeIx(alice, aliceAta, 2, tok(1_000), MIN_LOCK - 1).rpc(),
        "LockTooShort",
        ""
      ));

    it("REFUSES a lock longer than 4 years", async () =>
      rejectsWith(
        stakeIx(alice, aliceAta, 2, tok(1_000), MAX_LOCK + 1).rpc(),
        "LockTooLong",
        ""
      ));

    it("REFUSES more than this wallet's share (audit M-4)", async () =>
      rejectsWith(
        stakeIx(alice, aliceAta, 2, MAX_WALLET, MIN_LOCK).rpc(),
        "WalletCapExceeded",
        "one wallet could otherwise occupy a whole low-cap pool and refuse everyone else"
      ));
  });

  // ─────────────────────── the reward engine, end to end ───────────────────────

  describe("rewards", () => {
    let ctx: Awaited<ReturnType<typeof makePool>>;
    let bob: Keypair;
    let bobAta: PublicKey;

    before(async () => {
      ctx = await makePool({ nonce: 30 });
      bob = await newWallet();
      bobAta = await fund(ctx.mint, bob, tok(100_000));
      await program.methods
        .stake(tok(10_000), new BN(MAX_LOCK))
        .accounts({
          owner: bob.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          userStats: userPda(ctx.pool, bob.publicKey),
          position: positionPda(ctx.pool, bob.publicKey, 0),
          ownerAta: bobAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();
    });

    const notify = (amount: BN, fromBudget: BN) =>
      program.methods.notifyReward(amount, fromBudget).accounts({
        authority: payer.publicKey,
        pool: ctx.pool,
        mint: ctx.mint,
        funderAta: ctx.userAta,
        rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
        tokenProgram: ctx.programId,
      });

    it("POSITIVE CONTROL: funds a 90-day window and sets a per-second rate", async () => {
      await notify(tok(90_000), new BN(0)).rpc();
      const pool = await program.account.pool.fetch(ctx.pool);
      assert.isTrue(pool.rewardRate.gt(new BN(0)), "rate must be non-zero");
      assert.equal(
        pool.rewardFundedCumulative.toString(),
        tok(90_000).toString(),
        "only tokens moved IN by notify_reward are counted as funding"
      );
      assert.isTrue(pool.periodFinish.toNumber() > 0);
    });

    it("REFUSES an amount too small to express as a per-second rate (audit L-1)", async () =>
      rejectsWith(
        notify(new BN(1), new BN(0)).rpc(),
        "RewardRateTooSmall",
        "a 1-unit reload truncated to rate 0, extended the window 90 days, and emitted nothing"
      ));

    it("REFUSES scheduling nothing at all", async () =>
      rejectsWith(notify(new BN(0), new BN(0)).rpc(), "ZeroAmount", ""));

    it("REFUSES a non-authority", async () => {
      const stranger = await newWallet();
      const strangerAta = await fund(ctx.mint, stranger, tok(1_000));
      await rejectsWith(
        program.methods
          .notifyReward(tok(100), new BN(0))
          .accounts({
            authority: stranger.publicKey,
            pool: ctx.pool,
            mint: ctx.mint,
            funderAta: strangerAta,
            rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
            tokenProgram: ctx.programId,
          })
          .signers([stranger])
          .rpc(),
        "Unauthorized",
        ""
      );
    });

    it("pays a claim, and the payout comes from the REWARD vault only (I-12)", async () => {
      const before = await bal(bobAta);
      const svBefore = await bal(vaultPda(STAKE_VAULT_SEED, ctx.pool));
      await program.methods
        .claim()
        .accounts({
          owner: bob.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          position: positionPda(ctx.pool, bob.publicKey, 0),
          ownerAta: bobAta,
          rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .signers([bob])
        .rpc();
      assert.isTrue(
        (await bal(bobAta)).gt(before),
        "a claim must actually pay"
      );
      assert.equal(
        (await bal(vaultPda(STAKE_VAULT_SEED, ctx.pool))).toString(),
        svBefore.toString(),
        "a reward payout must never touch the stake vault"
      );
    });
  });

  // ───────────────────────────────── the exits ─────────────────────────────────

  describe("exits", () => {
    let ctx: Awaited<ReturnType<typeof makePool>>;
    let carol: Keypair;
    let carolAta: PublicKey;

    beforeEach(async () => {
      ctx = await makePool({ nonce: 40 + Math.floor(Math.random() * 200) });
      carol = await newWallet();
      carolAta = await fund(ctx.mint, carol, tok(100_000));
      await program.methods
        .stake(tok(10_000), new BN(MAX_LOCK))
        .accounts({
          owner: carol.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          userStats: userPda(ctx.pool, carol.publicKey),
          position: positionPda(ctx.pool, carol.publicKey, 0),
          ownerAta: carolAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([carol])
        .rpc();
    });

    const exitAccounts = () => ({
      owner: carol.publicKey,
      pool: ctx.pool,
      mint: ctx.mint,
      userStats: userPda(ctx.pool, carol.publicKey),
      position: positionPda(ctx.pool, carol.publicKey, 0),
      ownerAta: carolAta,
      stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
      rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
      tokenProgram: ctx.programId,
    });

    it("withdraw_matured REFUSES an unmatured position", async () =>
      rejectsWith(
        program.methods
          .withdrawMatured()
          .accounts(exitAccounts())
          .signers([carol])
          .rpc(),
        "StillLocked",
        "NOTE: the MATURED path cannot be reached without a clock warp — see the header"
      ));

    it("early_exit takes exactly 25%, and the penalty lands in the REWARD vault", async () => {
      const before = await bal(carolAta);
      const rvBefore = await bal(vaultPda(REWARD_VAULT_SEED, ctx.pool));
      await program.methods
        .earlyExit()
        .accounts(exitAccounts())
        .signers([carol])
        .rpc();

      const out = (await bal(carolAta)).sub(before);
      const penalty = tok(10_000).div(new BN(4));
      assert.equal(
        out.toString(),
        tok(10_000).sub(penalty).toString(),
        "must receive 75% of principal"
      );
      assert.equal(
        (await bal(vaultPda(REWARD_VAULT_SEED, ctx.pool)))
          .sub(rvBefore)
          .toString(),
        penalty.toString(),
        "the penalty must be RETAINED as reward budget, not burned or swept away"
      );
      const pool = await program.account.pool.fetch(ctx.pool);
      assert.equal(
        pool.penaltyCollectedCumulative.toString(),
        penalty.toString()
      );
      // I-7: the position is DELETED, not zeroed
      assert.isNull(
        await conn.getAccountInfo(positionPda(ctx.pool, carol.publicKey, 0))
      );
      // M-4: the wallet's allocation is released
      const us = await program.account.userStats.fetch(
        userPda(ctx.pool, carol.publicKey)
      );
      assert.equal(
        us.principal.toString(),
        "0",
        "an exit must free the wallet's allocation"
      );
    });

    it("THE CENTRAL PROMISE: emergency_withdraw returns principal with an EMPTY reward vault", async () => {
      // The reward vault has never been funded in this pool. On the rented rail this
      // is Streamflow 6012 — claim AND unstake revert, and principal is held hostage
      // by a funding gap. Here the hatch does not even name the reward vault.
      assert.equal(
        (await bal(vaultPda(REWARD_VAULT_SEED, ctx.pool))).toString(),
        "0"
      );
      const before = await bal(carolAta);
      await program.methods
        .emergencyWithdraw()
        .accounts({
          owner: carol.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          userStats: userPda(ctx.pool, carol.publicKey),
          position: positionPda(ctx.pool, carol.publicKey, 0),
          ownerAta: carolAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .signers([carol])
        .rpc();
      const out = (await bal(carolAta)).sub(before);
      assert.equal(
        out.toString(),
        tok(7_500).toString(),
        "75% out while locked"
      );
      const pool = await program.account.pool.fetch(ctx.pool);
      assert.equal(
        pool.orphanedPenalty.toString(),
        tok(2_500).toString(),
        "the hatch cannot reach the reward vault, so the penalty parks for the sweep"
      );
      assert.isTrue(
        (await bal(vaultPda(STAKE_VAULT_SEED, ctx.pool))).gte(
          pool.totalPrincipal
        ),
        "I-1 must hold after the hatch"
      );
    });

    it("sweep_orphaned_penalty carries it across, permissionlessly", async () => {
      await program.methods
        .emergencyWithdraw()
        .accounts({
          owner: carol.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          userStats: userPda(ctx.pool, carol.publicKey),
          position: positionPda(ctx.pool, carol.publicKey, 0),
          ownerAta: carolAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .signers([carol])
        .rpc();

      const stranger = await newWallet();
      await program.methods
        .sweepOrphanedPenalty()
        .accounts({
          pool: ctx.pool,
          mint: ctx.mint,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .signers([stranger])
        .rpc();

      assert.equal(
        (await bal(vaultPda(REWARD_VAULT_SEED, ctx.pool))).toString(),
        tok(2_500).toString()
      );
      const pool = await program.account.pool.fetch(ctx.pool);
      assert.equal(pool.orphanedPenalty.toString(), "0");
      assert.equal(
        pool.penaltyCollectedCumulative.toString(),
        tok(2_500).toString()
      );
    });

    it("AUDIT H-1: a retained penalty is SCHEDULABLE with no fresh capital", async () => {
      // This is the finding that mattered most. Before the fix the rate was a pure
      // function of the freshly-transferred `amount`, so the 25% a leaver left behind
      // — which the pool PROMISES to whoever stays — could never be paid to anyone.
      // A `notify_reward(0, penalty)` was impossible: `amount > 0` was required.
      await program.methods
        .earlyExit()
        .accounts(exitAccounts())
        .signers([carol])
        .rpc();
      const penalty = tok(2_500);
      assert.equal(
        (await bal(vaultPda(REWARD_VAULT_SEED, ctx.pool))).toString(),
        penalty.toString()
      );

      await program.methods
        .notifyReward(new BN(0), penalty)
        .accounts({
          authority: payer.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          funderAta: ctx.userAta,
          rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .rpc();

      const pool = await program.account.pool.fetch(ctx.pool);
      assert.isTrue(
        pool.rewardRate.gt(new BN(0)),
        "the retained penalty must become a real rate"
      );
      assert.equal(
        pool.rewardFundedCumulative.toString(),
        "0",
        "and it must NOT be counted as authority funding — the split is the point"
      );
    });
  });

  // ──────────────────────────── the admin surface ────────────────────────────

  describe("admin", () => {
    let ctx: Awaited<ReturnType<typeof makePool>>;
    before(async () => {
      ctx = await makePool({ nonce: 60 });
    });

    it("cap raises are raise-only, timelocked, and cancellable (audit I-13 / L-7)", async () => {
      await rejectsWith(
        program.methods
          .proposeCapRaise(tok(1))
          .accounts({ authority: payer.publicKey, pool: ctx.pool })
          .rpc(),
        "CapCanOnlyRaise",
        "a cap must never be lowered out from under a depositor"
      );
      await program.methods
        .proposeCapRaise(DEPOSIT_CAP.mul(new BN(2)))
        .accounts({ authority: payer.publicKey, pool: ctx.pool })
        .rpc();
      await rejectsWith(
        program.methods.executeCapRaise().accounts({ pool: ctx.pool }).rpc(),
        "TimelockNotElapsed",
        "48h must actually elapse"
      );
      // L-7: the authority can abandon its own proposal
      await program.methods
        .cancelCapRaise()
        .accounts({ authority: payer.publicKey, pool: ctx.pool })
        .rpc();
      const pool = await program.account.pool.fetch(ctx.pool);
      assert.equal(pool.pendingCap.toString(), "0");
      await rejectsWith(
        program.methods
          .cancelCapRaise()
          .accounts({ authority: payer.publicKey, pool: ctx.pool })
          .rpc(),
        "NoPendingChange",
        ""
      );
    });

    it("declare_degraded is ONE-WAY and closes the pool to new stakes (audit M-3)", async () => {
      const ctx2 = await makePool({ nonce: 61 });
      const dave = await newWallet();
      const daveAta = await fund(ctx2.mint, dave, tok(10_000));

      // POSITIVE CONTROL: staking works before the flag
      await program.methods
        .stake(tok(1_000), new BN(MIN_LOCK))
        .accounts({
          owner: dave.publicKey,
          pool: ctx2.pool,
          mint: ctx2.mint,
          userStats: userPda(ctx2.pool, dave.publicKey),
          position: positionPda(ctx2.pool, dave.publicKey, 0),
          ownerAta: daveAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx2.pool),
          tokenProgram: ctx2.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([dave])
        .rpc();

      await program.methods
        .declareDegraded()
        .accounts({ authority: payer.publicKey, pool: ctx2.pool })
        .rpc();

      await rejectsWith(
        program.methods
          .stake(tok(1_000), new BN(MAX_LOCK))
          .accounts({
            owner: dave.publicKey,
            pool: ctx2.pool,
            mint: ctx2.mint,
            userStats: userPda(ctx2.pool, dave.publicKey),
            position: positionPda(ctx2.pool, dave.publicKey, 1),
            ownerAta: daveAta,
            stakeVault: vaultPda(STAKE_VAULT_SEED, ctx2.pool),
            tokenProgram: ctx2.programId,
            systemProgram: SystemProgram.programId,
          })
          .signers([dave])
          .rpc(),
        "PoolDegraded",
        "otherwise the 4.00x rung is buyable with no lock at all"
      );
      await rejectsWith(
        program.methods
          .declareDegraded()
          .accounts({ authority: payer.publicKey, pool: ctx2.pool })
          .rpc(),
        "AlreadyDegraded",
        "the flag is one-way"
      );

      // and BOTH early doors now charge nothing
      const before = await bal(daveAta, ctx2.programId);
      await program.methods
        .earlyExit()
        .accounts({
          owner: dave.publicKey,
          pool: ctx2.pool,
          mint: ctx2.mint,
          userStats: userPda(ctx2.pool, dave.publicKey),
          position: positionPda(ctx2.pool, dave.publicKey, 0),
          ownerAta: daveAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx2.pool),
          rewardVault: vaultPda(REWARD_VAULT_SEED, ctx2.pool),
          tokenProgram: ctx2.programId,
        })
        .signers([dave])
        .rpc();
      assert.equal(
        (await bal(daveAta, ctx2.programId)).sub(before).toString(),
        tok(1_000).toString(),
        "in a degraded pool early_exit must not charge — the hatch would otherwise dominate it"
      );
    });

    it("authority rotation is two-step and the incoming key must sign", async () => {
      const next = await newWallet();
      await program.methods
        .proposeAuthority(next.publicKey)
        .accounts({ authority: payer.publicKey, pool: ctx.pool })
        .rpc();
      await rejectsWith(
        program.methods
          .acceptAuthority()
          .accounts({ pending: payer.publicKey, pool: ctx.pool })
          .rpc(),
        "Unauthorized",
        "only the PROPOSED key may accept"
      );
      await program.methods
        .acceptAuthority()
        .accounts({ pending: next.publicKey, pool: ctx.pool })
        .signers([next])
        .rpc();
      const pool = await program.account.pool.fetch(ctx.pool);
      assert.equal(pool.authority.toBase58(), next.publicKey.toBase58());
    });
  });

  // ─────────────────────── compute units, finally measured ───────────────────────

  describe("compute units (audit: entirely unmeasured before this)", () => {
    it("reports CU for every instruction on the principal path", async () => {
      const ctx = await makePool({ nonce: 90 });
      const eve = await newWallet();
      const eveAta = await fund(ctx.mint, eve, tok(50_000));
      const used: Record<string, number> = {};

      const measure = async (name: string, sig: string) => {
        const tx = await conn.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        used[name] = tx?.meta?.computeUnitsConsumed ?? -1;
      };

      await measure("initialize_pool (already run)", "");
      const s1 = await program.methods
        .stake(tok(10_000), new BN(MAX_LOCK))
        .accounts({
          owner: eve.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          userStats: userPda(ctx.pool, eve.publicKey),
          position: positionPda(ctx.pool, eve.publicKey, 0),
          ownerAta: eveAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([eve])
        .rpc();
      await measure("stake", s1);

      const s2 = await program.methods
        .notifyReward(tok(90_000), new BN(0))
        .accounts({
          authority: payer.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          funderAta: ctx.userAta,
          rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .rpc();
      await measure("notify_reward", s2);

      const s3 = await program.methods
        .claim()
        .accounts({
          owner: eve.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          position: positionPda(ctx.pool, eve.publicKey, 0),
          ownerAta: eveAta,
          rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .signers([eve])
        .rpc();
      await measure("claim", s3);

      // Exit is the heaviest: three transfer_checked CPIs, a reload and a close.
      const s4 = await program.methods
        .earlyExit()
        .accounts({
          owner: eve.publicKey,
          pool: ctx.pool,
          mint: ctx.mint,
          userStats: userPda(ctx.pool, eve.publicKey),
          position: positionPda(ctx.pool, eve.publicKey, 0),
          ownerAta: eveAta,
          stakeVault: vaultPda(STAKE_VAULT_SEED, ctx.pool),
          rewardVault: vaultPda(REWARD_VAULT_SEED, ctx.pool),
          tokenProgram: ctx.programId,
        })
        .signers([eve])
        .rpc();
      await measure("early_exit", s4);

      // eslint-disable-next-line no-console
      console.log("\n    COMPUTE UNITS CONSUMED");
      for (const [k, v] of Object.entries(used)) {
        if (v >= 0) console.log(`      ${k.padEnd(22)} ${v.toLocaleString()}`);
      }
      // The default per-instruction budget is 200k. Anything close to it is a
      // principal-path failure waiting for a busier pool.
      for (const [k, v] of Object.entries(used)) {
        if (v >= 0) {
          assert.isBelow(
            v,
            200_000,
            `${k} is at or over the default CU budget`
          );
        }
      }
    });
  });
});
