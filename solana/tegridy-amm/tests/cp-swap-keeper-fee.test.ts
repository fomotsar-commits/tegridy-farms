/**
 * cp-swap's keeper fee of 2026-11-11 on a local validator. solana-ci.yml's migration-rehearsal
 * job runs it beside the swap guard's file, on the same deployed cp-swap (this wallet its admin).
 *
 * The rule (programs/cp-swap/src/states/config.rs `swap_fee_rates`), per fee tier:
 *  - With no keeper named, as every tier starts: every swap pays the tier's trade fee, and the
 *    protocol and the fund take their shares of it, as upstream.
 *  - The keeper the admin names (update_amm_config param 9, the swap guard's keeper) swaps free
 *    of the trade fee and the creator fee: the pool moves along its curve and no share accrues.
 *    Everyone else still pays, the guard on or off, and the keeper pays on every other tier.
 *  - A public pool takes its creator fee on both tokens, so on the input, where upstream's
 *    arithmetic splits the fee by the sum of the two rates; with both at 0 that divides by 0.
 *    The keeper's fee is therefore taken on the output, where 0 takes 0. Both swap kinds, both
 *    directions, run here on such a pool.
 *  - Naming the System Program's address (all zeros) as keeper ends it.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

const AMM_CONFIG_SEED = Buffer.from("amm_config");
const POOL_SEED = Buffer.from("pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const POOL_LP_MINT_SEED = Buffer.from("pool_lp_mint");
const OBSERVATION_SEED = Buffer.from("observation");
const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");

/** The 1% tier's shape (fee setting 1 on mainnet), in millionths. */
const TRADE_FEE = 10_000n;
const PROTOCOL_SHARE = 104_000n;
const FUND_SHARE = 56_000n;
const MILLION = 1_000_000n;
/** One swap: exactly 1 token in (6 decimals), or exactly 0.5 out for at most 10 in. */
const ONE_IN = 1_000_000n;
const HALF_OUT = 500_000n;

const failure = (e: unknown) => `${String(e)}\n${((e as { logs?: string[] }).logs ?? []).join("\n")}`;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

describe("cp-swap keeper fee", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  /** cp-swap's admin in this build; it also opens the pools and pays every network fee here. */
  const wallet = anchor.Wallet.local().payer;
  const cpSwap = new Program(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/raydium_cp_swap.json"), "utf8")) as Idl,
    provider
  ) as Program<Idl>;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpSwap.programId)[0];
  const tierAt = (index: number) => pda([AMM_CONFIG_SEED, new BN(index).toArrayLike(Buffer, "be", 2)]);
  const feeReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const own = (m: PublicKey, who: PublicKey) => getAssociatedTokenAddressSync(m, who);
  const authority = pda([AUTH_SEED]);

  /** A wallet like any visitor's, and the one the admin will name the keeper (our robot). */
  const stranger = Keypair.generate();
  const keeper = Keypair.generate();
  let m0: PublicKey;
  let m1: PublicKey;

  type Pool = { tier: PublicKey; pool: PublicKey; vault0: PublicKey; vault1: PublicKey; observationState: PublicKey };
  /** The pool these tests trade on (tier 41, where the keeper is named), and the same pair on tier 42, where it never is. */
  let main: Pool;
  let other: Pool;

  type Dir = "0to1" | "1to0";
  type Kind = "in" | "out";

  /** The vaults, the shares the pool has set aside per token, and what `who` holds of each token. */
  const state = async (who: Keypair, p: Pool) => {
    const ps = await (cpSwap.account as any).poolState.fetch(p.pool);
    const n = (b: BN) => BigInt(b.toString());
    return {
      vault: [(await getAccount(conn, p.vault0)).amount, (await getAccount(conn, p.vault1)).amount],
      protocol: [n(ps.protocolFeesToken0), n(ps.protocolFeesToken1)],
      fund: [n(ps.fundFeesToken0), n(ps.fundFeesToken1)],
      creator: [n(ps.creatorFeesToken0), n(ps.creatorFeesToken1)],
      held: [(await getAccount(conn, own(m0, who.publicKey))).amount, (await getAccount(conn, own(m1, who.publicKey))).amount],
    };
  };
  type State = Awaited<ReturnType<typeof state>>;
  /** What the curve holds of token i: the vault less the shares set aside in it (pool.rs vault_amount_without_fee). */
  const curve = (s: State, i: number) => s.vault[i] - s.protocol[i] - s.fund[i] - s.creator[i];

  /** One swap that `who` signs, sent directly; "" when it went through, else what refused it. */
  const swap = async (who: Keypair, kind: Kind, dir: Dir, p: Pool) => {
    const [inM, outM, inV, outV] = dir === "0to1" ? [m0, m1, p.vault0, p.vault1] : [m1, m0, p.vault1, p.vault0];
    const call =
      kind === "in"
        ? cpSwap.methods.swapBaseInput(new BN(ONE_IN.toString()), new BN(0))
        : cpSwap.methods.swapBaseOutput(new BN(10_000_000), new BN(HALF_OUT.toString()));
    const ix = await call
      .accountsPartial({
        payer: who.publicKey,
        authority,
        ammConfig: p.tier,
        poolState: p.pool,
        inputTokenAccount: own(inM, who.publicKey),
        outputTokenAccount: own(outM, who.publicKey),
        inputVault: inV,
        outputVault: outV,
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_PROGRAM_ID,
        inputTokenMint: inM,
        outputTokenMint: outM,
        observationState: p.observationState,
      })
      .instruction();
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [who]);
      return "";
    } catch (e) {
      return failure(e) || "refused";
    }
  };

  /**
   * Runs one swap and checks it to the unit against the curve: what went in and came out, and
   * what the pool set aside. Free, it is the bare constant-product step and nothing accrues.
   * Paying, the trade fee comes off the input first and the protocol and fund take their shares.
   * Returns the fee the swap paid.
   */
  const swapAndCheck = async (who: Keypair, kind: Kind, dir: Dir, free: boolean, p: Pool = main) => {
    const [i, o] = dir === "0to1" ? [0, 1] : [1, 0];
    const before = await state(who, p);
    assert.equal(await swap(who, kind, dir, p), "", `swap_base_${kind}put ${dir}`);
    const after = await state(who, p);
    const x = curve(before, i);
    const y = curve(before, o);
    const paid = before.held[i] - after.held[i];
    const got = after.held[o] - before.held[o];
    let fee: bigint;
    if (kind === "in") {
      fee = free ? 0n : ceilDiv(ONE_IN * TRADE_FEE, MILLION);
      assert.equal(paid, ONE_IN, "exactly the amount asked went in");
      assert.equal(got, ((ONE_IN - fee) * y) / (x + ONE_IN - fee), "out, to the unit");
    } else {
      const bare = ceilDiv(x * HALF_OUT, y - HALF_OUT);
      const withFee = free ? bare : ceilDiv(bare * MILLION, MILLION - TRADE_FEE);
      fee = withFee - bare;
      assert.equal(got, HALF_OUT, "exactly the amount asked came out");
      assert.equal(paid, withFee, "in, to the unit");
    }
    assert.equal(after.vault[i] - before.vault[i], paid, "all of it went to the pool's vault");
    assert.equal(after.protocol[i] - before.protocol[i], (fee * PROTOCOL_SHARE) / MILLION, "the venue's share");
    assert.equal(after.fund[i] - before.fund[i], (fee * FUND_SHARE) / MILLION, "the island's share");
    // Nothing is ever set aside in the output token, nor for a creator (public pools charge none).
    assert.equal(after.protocol[o], before.protocol[o]);
    assert.equal(after.fund[o], before.fund[o]);
    assert.deepEqual(after.creator, before.creator);
    return fee;
  };

  const setOn = (param: 8 | 9, value: number, keeperKey: PublicKey | null, signer: Keypair = wallet) =>
    cpSwap.methods
      .updateAmmConfig(param, new BN(value))
      .accountsPartial({ owner: signer.publicKey, ammConfig: main.tier })
      .remainingAccounts(keeperKey ? [{ pubkey: keeperKey, isSigner: false, isWritable: false }] : [])
      .signers(signer === wallet ? [] : [signer])
      .rpc()
      .then(() => "", (e) => failure(e) || "refused");
  const setKeeper = (who: PublicKey, signer: Keypair = wallet) => setOn(9, 0, who, signer);
  const setGuard = (value: number) => setOn(8, value, null);

  /** A 1% tier at `index` and a public pool of the pair on it, open for swaps. */
  const openPool = async (index: number): Promise<Pool> => {
    const tier = tierAt(index);
    await cpSwap.methods
      .createAmmConfig(index, new BN(TRADE_FEE.toString()), new BN(PROTOCOL_SHARE.toString()), new BN(FUND_SHARE.toString()), new BN(0), new BN(0))
      .accountsPartial({ owner: wallet.publicKey, ammConfig: tier, systemProgram: SystemProgram.programId })
      .rpc();
    const pool = pda([POOL_SEED, tier.toBuffer(), m0.toBuffer(), m1.toBuffer()]);
    const lp = pda([POOL_LP_MINT_SEED, pool.toBuffer()]);
    const p: Pool = {
      tier,
      pool,
      vault0: pda([POOL_VAULT_SEED, pool.toBuffer(), m0.toBuffer()]),
      vault1: pda([POOL_VAULT_SEED, pool.toBuffer(), m1.toBuffer()]),
      observationState: pda([OBSERVATION_SEED, pool.toBuffer()]),
    };
    await cpSwap.methods
      .initialize(new BN(1_000_000_000), new BN(2_000_000_000), new BN(0))
      .accountsPartial({
        creator: wallet.publicKey,
        ammConfig: tier,
        authority,
        poolState: pool,
        token0Mint: m0,
        token1Mint: m1,
        lpMint: lp,
        creatorToken0: own(m0, wallet.publicKey),
        creatorToken1: own(m1, wallet.publicKey),
        creatorLpToken: own(lp, wallet.publicKey),
        token0Vault: p.vault0,
        token1Vault: p.vault1,
        createPoolFee: feeReceiver,
        observationState: p.observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        token0Program: TOKEN_PROGRAM_ID,
        token1Program: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    const opens = Number((await (cpSwap.account as any).poolState.fetch(pool)).openTime);
    for (let i = 0; i < 40 && ((await conn.getBlockTime(await conn.getSlot())) ?? 0) < opens; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return p;
  };

  before(async () => {
    try {
      await createAssociatedTokenAccount(conn, wallet, NATIVE_MINT, wallet.publicKey);
    } catch {
      /* another file in this run made it already */
    }
    const a = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const b = await createMint(conn, wallet, wallet.publicKey, null, 6);
    [m0, m1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
    for (const who of [wallet.publicKey, stranger.publicKey, keeper.publicKey]) {
      for (const m of [m0, m1]) {
        await createAssociatedTokenAccount(conn, wallet, m, who);
        await mintTo(conn, wallet, m, own(m, who), wallet, 10_000_000_000);
      }
    }
    main = await openPool(41);
    other = await openPool(42);
  });

  it("a public pool takes its creator fee on both tokens: the case where upstream's split would divide by 0", async () => {
    const p = await (cpSwap.account as any).poolState.fetch(main.pool);
    assert.equal(p.creatorFeeOn, 0, "CreatorFeeOn::BothToken");
    assert.isFalse(p.enableCreatorFee);
  });

  it("with no keeper named, the robot-to-be pays the 1% fee and its shares like anyone", async () => {
    for (const kind of ["in", "out"] as const) assert.isAbove(Number(await swapAndCheck(keeper, kind, "0to1", false)), 0);
  });

  it("only the admin names the keeper", async () => {
    assert.include(await setKeeper(keeper.publicKey, stranger), "InvalidOwner");
    assert.equal(await setKeeper(keeper.publicKey), "");
  });

  it("the keeper's swaps, either kind and either direction, pay no fee: the pool moves along its curve and nothing accrues", async () => {
    for (const kind of ["in", "out"] as const) {
      for (const dir of ["0to1", "1to0"] as const) assert.equal(await swapAndCheck(keeper, kind, dir, true), 0n, `${kind} ${dir}`);
    }
  });

  it("anyone else still pays the tier's fee and its shares, either kind and either direction", async () => {
    for (const kind of ["in", "out"] as const) {
      for (const dir of ["0to1", "1to0"] as const) assert.isAbove(Number(await swapAndCheck(stranger, kind, dir, false)), 0);
    }
  });

  it("named on one tier, the keeper still pays on another tier's pool of the same pair", async () => {
    for (const kind of ["in", "out"] as const) assert.isAbove(Number(await swapAndCheck(keeper, kind, "0to1", false, other)), 0);
  });

  it("with the swap guard on, the same: the keeper's own swap is free and a wallet's own swap pays", async () => {
    assert.equal(await setGuard(1), "");
    assert.equal(await swapAndCheck(keeper, "in", "0to1", true), 0n);
    assert.isAbove(Number(await swapAndCheck(stranger, "in", "0to1", false)), 0);
    assert.equal(await setGuard(0), "");
  });

  it("naming the System Program's address ends it: the keeper named before pays again", async () => {
    assert.equal(await setKeeper(SystemProgram.programId), "");
    for (const kind of ["in", "out"] as const) assert.isAbove(Number(await swapAndCheck(keeper, kind, "1to0", false)), 0);
  });
});
