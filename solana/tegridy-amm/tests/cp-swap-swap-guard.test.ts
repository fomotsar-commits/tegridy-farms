/**
 * cp-swap's swap guard of 2026-11-10 on a local validator. solana-ci.yml's migration-rehearsal
 * job builds cp-swap with this wallet as `admin::ID`, builds and deploys tests/cpi-caller (a
 * program that calls the program it is handed, as an arbitrage bot's own program calls a pool),
 * and runs this file with its address in CPI_CALLER_ID.
 *
 * The rule (programs/cp-swap/src/states/config.rs `refuses_swap`), per fee tier:
 *  - Guard off, as every tier starts and as upstream: a swap runs wherever it is called from.
 *  - Guard on: a swap must be an instruction of the transaction itself. One that another
 *    program calls is refused (SwapNotDirect), swap_base_input and swap_base_output alike,
 *    unless the tier's keeper signs it. A wallet's own swap is untouched.
 *  - Only the admin sets the guard (0 or 1) and the keeper; the System Program's address,
 *    all zeros, is no keeper.
 *  - Only swaps are guarded: a deposit or a withdrawal another program calls goes through.
 *
 * Without CPI_CALLER_ID this file fails on CI, where the job always sets it, and is skipped
 * anywhere else: a plain `anchor test` runs tests/*.test.ts and deploys only the workspace's
 * own programs, so tests/cpi-caller is not on its chain.
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
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

const AMM_CONFIG_SEED = Buffer.from("amm_config");
const POOL_SEED = Buffer.from("pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const POOL_LP_MINT_SEED = Buffer.from("pool_lp_mint");
const OBSERVATION_SEED = Buffer.from("observation");
const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");
/** The SPL Memo program a withdrawal names. */
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Where the guard and the keeper sit in a tier's account: upstream's padding began at byte 116. */
const GUARD_AT = 116;
const KEEPER_AT = 124;

/** What a failed send says, its last logs included: a refused swap names its error there. */
const failure = (e: unknown) => `${String(e)}\n${((e as { logs?: string[] }).logs ?? []).join("\n")}`;

const CALLER_ID = process.env.CPI_CALLER_ID;
if (!CALLER_ID) {
  if (process.env.CI) throw new Error("CPI_CALLER_ID is not set: the address tests/cpi-caller was deployed at");
  console.warn("cp-swap swap guard: SKIPPED, CPI_CALLER_ID is not set (tests/cpi-caller is not deployed on this chain)");
  describe.skip("cp-swap swap guard", () => {
    it("needs tests/cpi-caller deployed and its address in CPI_CALLER_ID");
  });
}

if (CALLER_ID) describe("cp-swap swap guard", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  /** cp-swap's admin in this build; it also opens the pool and pays every fee here. */
  const wallet = anchor.Wallet.local().payer;
  const cpSwap = new Program(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/raydium_cp_swap.json"), "utf8")) as Idl,
    provider
  ) as Program<Idl>;
  const CALLER = new PublicKey(CALLER_ID);
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpSwap.programId)[0];
  const INDEX = 40;
  const tier = pda([AMM_CONFIG_SEED, new BN(INDEX).toArrayLike(Buffer, "be", 2)]);
  const feeReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const own = (m: PublicKey, who: PublicKey) => getAssociatedTokenAddressSync(m, who);

  /** A wallet like any visitor's, and the one the admin will name the keeper. */
  const stranger = Keypair.generate();
  const keeper = Keypair.generate();
  let m0: PublicKey;
  let m1: PublicKey;
  let pool: PublicKey;
  let lp: PublicKey;
  let vault0: PublicKey;
  let vault1: PublicKey;
  let observationState: PublicKey;
  const authority = pda([AUTH_SEED]);

  /** One swap of token 0 for token 1 that `payer` signs: exactly 1 token in, or exactly 0.5 out. */
  const swapIx = (payer: PublicKey, kind: "in" | "out"): Promise<TransactionInstruction> => {
    const call = kind === "in" ? cpSwap.methods.swapBaseInput(new BN(1_000_000), new BN(0)) : cpSwap.methods.swapBaseOutput(new BN(10_000_000), new BN(500_000));
    return call
      .accountsPartial({
        payer,
        authority,
        ammConfig: tier,
        poolState: pool,
        inputTokenAccount: own(m0, payer),
        outputTokenAccount: own(m1, payer),
        inputVault: vault0,
        outputVault: vault1,
        inputTokenProgram: TOKEN_PROGRAM_ID,
        outputTokenProgram: TOKEN_PROGRAM_ID,
        inputTokenMint: m0,
        outputTokenMint: m1,
        observationState,
      })
      .instruction();
  };
  /** The same swap, called by another program: cpi-caller is handed cp-swap, then the swap's own accounts and data. */
  const called = (ix: TransactionInstruction) =>
    new TransactionInstruction({ programId: CALLER, keys: [{ pubkey: ix.programId, isSigner: false, isWritable: false }, ...ix.keys], data: ix.data });
  /** Sends one instruction `signer` signs (the wallet pays the fee); "" when it went through, else what refused it. */
  const send = async (ix: TransactionInstruction, signer: Keypair) => {
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), signer.publicKey.equals(wallet.publicKey) ? [] : [signer]);
      return "";
    } catch (e) {
      return failure(e) || "refused";
    }
  };
  /** A deposit for, or a withdrawal of, 1 LP token by the wallet, which holds the pool's first LP tokens. */
  const liquidityIx = (kind: "deposit" | "withdraw"): Promise<TransactionInstruction> => {
    const accounts = {
      owner: wallet.publicKey,
      authority,
      poolState: pool,
      ownerLpToken: own(lp, wallet.publicKey),
      token0Account: own(m0, wallet.publicKey),
      token1Account: own(m1, wallet.publicKey),
      token0Vault: vault0,
      token1Vault: vault1,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      vault0Mint: m0,
      vault1Mint: m1,
      lpMint: lp,
    };
    return kind === "deposit"
      ? cpSwap.methods.deposit(new BN(1_000_000), new BN(100_000_000), new BN(100_000_000)).accountsPartial(accounts).instruction()
      : cpSwap.methods.withdraw(new BN(1_000_000), new BN(0), new BN(0)).accountsPartial({ ...accounts, memoProgram: MEMO_PROGRAM }).instruction();
  };
  const lpHeld = async () => (await getAccount(conn, own(lp, wallet.publicKey))).amount;
  const direct = async (who: Keypair, kind: "in" | "out" = "in") => send(await swapIx(who.publicKey, kind), who);
  const viaProgram = async (who: Keypair, kind: "in" | "out" = "in") => send(called(await swapIx(who.publicKey, kind)), who);
  const held = async (who: Keypair) => [(await getAccount(conn, own(m0, who.publicKey))).amount, (await getAccount(conn, own(m1, who.publicKey))).amount];
  const setGuard = (value: number, signer: Keypair = wallet) =>
    cpSwap.methods
      .updateAmmConfig(8, new BN(value))
      .accountsPartial({ owner: signer.publicKey, ammConfig: tier })
      .signers(signer === wallet ? [] : [signer])
      .rpc()
      .then(() => "", (e) => failure(e) || "refused");
  const setKeeper = (who: PublicKey | null, signer: Keypair = wallet) =>
    cpSwap.methods
      .updateAmmConfig(9, new BN(0))
      .accountsPartial({ owner: signer.publicKey, ammConfig: tier })
      .remainingAccounts(who ? [{ pubkey: who, isSigner: false, isWritable: false }] : [])
      .signers(signer === wallet ? [] : [signer])
      .rpc()
      .then(() => "", (e) => failure(e) || "refused");
  const settings = async () => {
    const data = (await conn.getAccountInfo(tier))!.data;
    return { size: data.length, guard: data.readBigUInt64LE(GUARD_AT), keeper: new PublicKey(data.subarray(KEEPER_AT, KEEPER_AT + 32)).toBase58(), rest: data.subarray(KEEPER_AT + 32).every((b) => b === 0) };
  };

  before(async () => {
    try {
      await createAssociatedTokenAccount(conn, wallet, NATIVE_MINT, wallet.publicKey);
    } catch {
      /* another file in this run made it already */
    }
    // The 1% tier's shape (fee setting 1 on mainnet).
    await cpSwap.methods
      .createAmmConfig(INDEX, new BN(10_000), new BN(104_000), new BN(56_000), new BN(0), new BN(0))
      .accountsPartial({ owner: wallet.publicKey, ammConfig: tier, systemProgram: SystemProgram.programId })
      .rpc();
    const a = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const b = await createMint(conn, wallet, wallet.publicKey, null, 6);
    [m0, m1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
    for (const who of [wallet.publicKey, stranger.publicKey, keeper.publicKey]) {
      for (const m of [m0, m1]) {
        await createAssociatedTokenAccount(conn, wallet, m, who);
        await mintTo(conn, wallet, m, own(m, who), wallet, 10_000_000_000);
      }
    }
    pool = pda([POOL_SEED, tier.toBuffer(), m0.toBuffer(), m1.toBuffer()]);
    lp = pda([POOL_LP_MINT_SEED, pool.toBuffer()]);
    vault0 = pda([POOL_VAULT_SEED, pool.toBuffer(), m0.toBuffer()]);
    vault1 = pda([POOL_VAULT_SEED, pool.toBuffer(), m1.toBuffer()]);
    observationState = pda([OBSERVATION_SEED, pool.toBuffer()]);
    await cpSwap.methods
      .initialize(new BN(1_000_000_000), new BN(1_000_000_000), new BN(0))
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
    // A pool opens one second after it is made; swap once it has.
    const opens = Number((await (cpSwap.account as any).poolState.fetch(pool)).openTime);
    for (let i = 0; i < 40 && ((await conn.getBlockTime(await conn.getSlot())) ?? 0) < opens; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  it("a new tier holds the guard off and no keeper, in the bytes upstream left as padding", async () => {
    assert.deepEqual(await settings(), { size: 236, guard: 0n, keeper: SystemProgram.programId.toBase58(), rest: true });
  });

  // The control every refusal below rests on: cpi-caller does reach the swap, and it goes through.
  it("with the guard off, a swap another program calls goes through, as upstream", async () => {
    const before = await held(stranger);
    assert.equal(await viaProgram(stranger, "in"), "");
    assert.equal(await viaProgram(stranger, "out"), "");
    const after = await held(stranger);
    assert.isTrue(after[0] < before[0] && after[1] > before[1], "token 0 went in and token 1 came out");
    assert.equal(await direct(stranger), "");
  });

  it("only the admin switches the guard, and only to 0 or 1", async () => {
    assert.include(await setGuard(1, stranger), "InvalidOwner");
    assert.include(await setGuard(2), "InvalidInput");
    assert.equal((await settings()).guard, 0n);
    assert.equal(await setGuard(1), "");
    assert.equal((await settings()).guard, 1n);
  });

  it("with the guard on, a wallet's own swap goes through, either kind", async () => {
    const before = await held(stranger);
    assert.equal(await direct(stranger, "in"), "");
    assert.equal(await direct(stranger, "out"), "");
    const after = await held(stranger);
    assert.isTrue(after[0] < before[0] && after[1] > before[1], "token 0 went in and token 1 came out");
  });

  it("with the guard on, a swap another program calls is refused, either kind, and nothing moves", async () => {
    const before = await held(stranger);
    for (const kind of ["in", "out"] as const) {
      const why = await viaProgram(stranger, kind);
      assert.include(why, "SwapNotDirect", `swap_base_${kind}put: ${why}`);
      assert.include(why, "must be sent directly");
      // The number the site's error table will key on: the last of the list, after upstream's 6014.
      assert.include(why, "Error Number: 6015");
    }
    assert.deepEqual(await held(stranger), before);
  });

  it("with the guard on, a deposit and a withdrawal another program calls still go through: only swaps are guarded", async () => {
    assert.equal((await settings()).guard, 1n);
    const start = await lpHeld();
    assert.equal(await send(called(await liquidityIx("deposit")), wallet), "");
    assert.equal(await lpHeld(), start + 1_000_000n, "the called deposit minted its LP tokens");
    assert.equal(await send(called(await liquidityIx("withdraw")), wallet), "");
    assert.equal(await lpHeld(), start, "the called withdrawal burned them");
  });

  it("the keeper alone may be called by another program; only the admin names it", async () => {
    assert.include(await setKeeper(keeper.publicKey, stranger), "InvalidOwner");
    assert.include(await setKeeper(null), "InvalidInput", "a keeper must be handed in");
    assert.equal(await setKeeper(keeper.publicKey), "");
    assert.equal((await settings()).keeper, keeper.publicKey.toBase58());
    const before = await held(keeper);
    assert.equal(await viaProgram(keeper, "in"), "");
    assert.equal(await viaProgram(keeper, "out"), "");
    const after = await held(keeper);
    assert.isTrue(after[0] < before[0] && after[1] > before[1], "the keeper's swap went through");
    // Everyone else is still refused from inside a program, and still trades directly.
    assert.include(await viaProgram(stranger), "SwapNotDirect");
    assert.equal(await direct(stranger), "");
    assert.equal(await direct(keeper), "");
  });

  it("the System Program's address is no keeper: the one named before is refused again", async () => {
    assert.equal(await setKeeper(SystemProgram.programId), "");
    assert.equal((await settings()).keeper, SystemProgram.programId.toBase58());
    assert.include(await viaProgram(keeper), "SwapNotDirect");
    assert.equal(await direct(keeper), "");
  });

  it("switched off again, the tier is as upstream: another program's call goes through", async () => {
    assert.equal(await setGuard(0), "");
    assert.deepEqual(await settings(), { size: 236, guard: 0n, keeper: SystemProgram.programId.toBase58(), rest: true });
    assert.equal(await viaProgram(stranger), "");
  });
});
