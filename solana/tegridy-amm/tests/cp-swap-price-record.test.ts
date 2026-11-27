/**
 * cp-swap's price record of 2026-11-24 on a local validator. solana-ci.yml's migration-rehearsal
 * job runs it beside the keeper fee's file, on the same deployed cp-swap (this wallet its admin).
 *
 * The rule (programs/cp-swap/src/states/pool.rs `recorded_price_x32`):
 *  - Every swap adds "a price, times the seconds since the record was last written" to the
 *    pool's price record (states/oracle.rs). Upstream reads that price from the vaults'
 *    balances as the swap finds them, so coins sent straight into a vault (a plain transfer,
 *    no swap) were booked for the whole quiet stretch before the next swap: an average anyone
 *    could set in one transaction.
 *  - Now each swap leaves the two balances it ended with, less the fees owed, in the pool's
 *    account (the first two words of its padding), and the next swap books THAT price for the
 *    stretch between them. Coins sent to a vault count from the next swap on, never before it.
 *  - Nothing else moves: the swap's own arithmetic still reads the balances, as upstream.
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
  transfer,
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
const TRADE_FEE = 10_000;
const PROTOCOL_SHARE = 104_000;
const FUND_SHARE = 56_000;
/** A tier no other file in this run opens. */
const TIER = 45;
const Q32 = 1n << 32n;
/** PoolState: where its padding begins (8 + 320 + 5 + 56 + 2 + 6 + 16). The first two words are the recorded balances. */
const POOL_RECORDED_AT = 413;
/** ObservationState: the newest entry's index, the entries (40 bytes each), and the second the record is good to. */
const OBS_INDEX_AT = 9;
const OBS_FIRST_AT = 43;
const OBS_SIZE = 40;
const OBS_LAST_UPDATE_AT = 43 + 40 * 100;

const failure = (e: unknown) => `${String(e)}\n${((e as { logs?: string[] }).logs ?? []).join("\n")}`;
const u128 = (d: Buffer, at: number) => d.readBigUInt64LE(at) + (d.readBigUInt64LE(at + 8) << 64n);
const MASK = (1n << 128n) - 1n;

describe("cp-swap price record", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  /** cp-swap's admin in this build; it also opens the pool and pays every network fee here. */
  const wallet = anchor.Wallet.local().payer;
  const cpSwap = new Program(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/raydium_cp_swap.json"), "utf8")) as Idl,
    provider
  ) as Program<Idl>;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpSwap.programId)[0];
  const feeReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const own = (m: PublicKey, who: PublicKey) => getAssociatedTokenAddressSync(m, who);
  const authority = pda([AUTH_SEED]);
  const stranger = Keypair.generate();
  let m0: PublicKey;
  let m1: PublicKey;
  let tier: PublicKey;
  let pool: PublicKey;
  let vault0: PublicKey;
  let vault1: PublicKey;
  let observationState: PublicKey;

  type Dir = "0to1" | "1to0";
  type Kind = "in" | "out";

  /** One swap the stranger signs, sent directly: 1 token in, or 0.5 out for at most 10 in. */
  const swap = async (kind: Kind, dir: Dir) => {
    const [inM, outM, inV, outV] = dir === "0to1" ? [m0, m1, vault0, vault1] : [m1, m0, vault1, vault0];
    const call =
      kind === "in"
        ? cpSwap.methods.swapBaseInput(new BN(1_000_000), new BN(0))
        : cpSwap.methods.swapBaseOutput(new BN(10_000_000), new BN(500_000));
    const ix = await call
      .accountsPartial({
        payer: stranger.publicKey,
        authority,
        ammConfig: tier,
        poolState: pool,
        inputTokenAccount: own(inM, stranger.publicKey),
        outputTokenAccount: own(outM, stranger.publicKey),
        inputVault: inV,
        outputVault: outV,
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_PROGRAM_ID,
        inputTokenMint: inM,
        outputTokenMint: outM,
        observationState,
      })
      .instruction();
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stranger]);
      return "";
    } catch (e) {
      return failure(e) || "refused";
    }
  };

  /** What the curve holds of each token now (the vault less the fees owed in it), and what the last swap left on record. */
  const balances = async () => {
    const ps = await (cpSwap.account as any).poolState.fetch(pool);
    const n = (b: BN) => BigInt(b.toString());
    const v = [(await getAccount(conn, vault0)).amount, (await getAccount(conn, vault1)).amount];
    const owed = [
      n(ps.protocolFeesToken0) + n(ps.fundFeesToken0) + n(ps.creatorFeesToken0),
      n(ps.protocolFeesToken1) + n(ps.fundFeesToken1) + n(ps.creatorFeesToken1),
    ];
    const d = (await conn.getAccountInfo(pool))!.data;
    return {
      curve: [v[0] - owed[0], v[1] - owed[1]],
      recorded: [d.readBigUInt64LE(POOL_RECORDED_AT), d.readBigUInt64LE(POOL_RECORDED_AT + 8)],
      // The rest of the padding is still nobody's.
      restOfPadding: d.subarray(POOL_RECORDED_AT + 16, POOL_RECORDED_AT + 8 * 28),
    };
  };

  /** The price record's two running totals, and the second they are good to. */
  const record = async () => {
    const d = (await conn.getAccountInfo(observationState))!.data;
    const at = OBS_FIRST_AT + OBS_SIZE * d.readUInt16LE(OBS_INDEX_AT);
    return { total0: u128(d, at + 8), total1: u128(d, at + 24), goodTo: d.readBigUInt64LE(OBS_LAST_UPDATE_AT) };
  };

  /** Waits until the chain's clock is at least `seconds` past `since`. */
  const waitPast = async (since: bigint, seconds: number) => {
    for (let i = 0; i < 120; i++) {
      const now = BigInt((await conn.getBlockTime(await conn.getSlot())) ?? 0);
      if (now >= since + BigInt(seconds)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the chain's clock did not move");
  };

  /** Token 0's price in token 1, and token 1's in token 0, as pool.rs token_price_x32 rounds them. */
  const priceOf = (b: bigint[]) => [(b[1] * Q32) / b[0], (b[0] * Q32) / b[1]];

  before(async () => {
    try {
      await createAssociatedTokenAccount(conn, wallet, NATIVE_MINT, wallet.publicKey);
    } catch {
      /* another file in this run made it already */
    }
    const a = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const b = await createMint(conn, wallet, wallet.publicKey, null, 6);
    [m0, m1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
    for (const who of [wallet.publicKey, stranger.publicKey]) {
      for (const m of [m0, m1]) {
        await createAssociatedTokenAccount(conn, wallet, m, who);
        await mintTo(conn, wallet, m, own(m, who), wallet, 10_000_000_000);
      }
    }
    tier = pda([AMM_CONFIG_SEED, new BN(TIER).toArrayLike(Buffer, "be", 2)]);
    await cpSwap.methods
      .createAmmConfig(TIER, new BN(TRADE_FEE), new BN(PROTOCOL_SHARE), new BN(FUND_SHARE), new BN(0), new BN(0))
      .accountsPartial({ owner: wallet.publicKey, ammConfig: tier, systemProgram: SystemProgram.programId })
      .rpc();
    pool = pda([POOL_SEED, tier.toBuffer(), m0.toBuffer(), m1.toBuffer()]);
    const lp = pda([POOL_LP_MINT_SEED, pool.toBuffer()]);
    vault0 = pda([POOL_VAULT_SEED, pool.toBuffer(), m0.toBuffer()]);
    vault1 = pda([POOL_VAULT_SEED, pool.toBuffer(), m1.toBuffer()]);
    observationState = pda([OBSERVATION_SEED, pool.toBuffer()]);
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
        token0Vault: vault0,
        token1Vault: vault1,
        createPoolFee: feeReceiver,
        observationState,
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
  });

  it("a pool that has not swapped yet has nothing on record", async () => {
    assert.deepEqual((await balances()).recorded, [0n, 0n]);
  });

  it("every swap, either kind and either direction, leaves the balances it ended with, less the fees owed", async () => {
    for (const kind of ["in", "out"] as const) {
      for (const dir of ["0to1", "1to0"] as const) {
        assert.equal(await swap(kind, dir), "", `swap_base_${kind}put ${dir}`);
        const b = await balances();
        assert.deepEqual(b.recorded, b.curve, `${kind} ${dir}`);
        assert.isTrue(b.restOfPadding.every((x) => x === 0), "only the first two words are used");
      }
    }
  });

  it("coins sent straight into a vault are in no price for the time before the next swap, and in every price after it", async () => {
    assert.equal(await swap("in", "0to1"), "");
    const left = await balances();
    const r0 = await record();
    // A gift of half the pool's token 0, by a plain transfer: the balances move, no swap runs.
    await transfer(conn, wallet, own(m0, wallet.publicKey), vault0, wallet, 500_000_000);
    const gifted = await balances();
    assert.deepEqual(gifted.recorded, left.recorded, "a transfer writes nothing to the pool");
    assert.equal(gifted.curve[0], left.curve[0] + 500_000_000n);

    await waitPast(r0.goodTo, 2);
    assert.equal(await swap("in", "0to1"), "");
    const r1 = await record();
    const seconds = r1.goodTo - r0.goodTo;
    assert.isAbove(Number(seconds), 0);
    // The stretch is booked at the price the last swap left, to the unit; the gifted price is nowhere in it.
    const [p0, p1] = priceOf(left.recorded);
    const [g0] = priceOf(gifted.curve);
    assert.equal((r1.total0 - r0.total0) & MASK, p0 * seconds, "token 0's price for the stretch");
    assert.equal((r1.total1 - r0.total1) & MASK, p1 * seconds, "token 1's price for the stretch");
    assert.notEqual(p0, g0);
    assert.notEqual((r1.total0 - r0.total0) & MASK, g0 * seconds, "not the price the gift made");

    // From that swap on the gift is the pool's own: the next stretch is booked with it.
    const after = await balances();
    assert.deepEqual(after.recorded, after.curve);
    assert.isAbove(Number(after.recorded[0]), Number(left.recorded[0] + 500_000_000n));
    await waitPast(r1.goodTo, 2);
    assert.equal(await swap("in", "1to0"), "");
    const r2 = await record();
    const [q0, q1] = priceOf(after.recorded);
    assert.equal((r2.total0 - r1.total0) & MASK, q0 * (r2.goodTo - r1.goodTo));
    assert.equal((r2.total1 - r1.total1) & MASK, q1 * (r2.goodTo - r1.goodTo));
  });
});
