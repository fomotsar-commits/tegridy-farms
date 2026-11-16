/**
 * cp-swap's keeper resignation of 2026-11-14 on a local validator. solana-ci.yml's
 * migration-rehearsal job runs it after the swap guard's and the keeper fee's files, on the same
 * deployed cp-swap (this wallet its admin) and with tests/cpi-caller's address in CPI_CALLER_ID.
 *
 * The rule (programs/cp-swap/src/lib.rs `resign_keeper`, update_config.rs `set_keeper`):
 *  - A tier's keeper can give the role up itself, at once, signing alone: the tier is then left
 *    with no keeper (the all-zero key), as the admin's param 9 would leave it. Its swaps pay the
 *    fee again, and the guard refuses them from inside another program again.
 *  - Nobody else can: not a stranger, not the admin (6016 NotKeeper). Not twice, and not on a
 *    tier with no keeper. Not another program, even with the keeper's signature (6016 too):
 *    only an instruction of the transaction itself. Other tiers it keeps are untouched.
 *  - The admin names only a wallet's key: a program's address is refused (6017 KeeperNotAWallet).
 *  - Every change of keeper or guard is logged: KeeperChanged (with who resigned) and
 *    SwapGuardChanged.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const AMM_CONFIG_SEED = Buffer.from("amm_config");
const POOL_SEED = Buffer.from("pool");
const POOL_VAULT_SEED = Buffer.from("pool_vault");
const POOL_LP_MINT_SEED = Buffer.from("pool_lp_mint");
const OBSERVATION_SEED = Buffer.from("observation");
const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");
/** Where the keeper sits in a tier's account (states/config.rs). */
const KEEPER_AT = 124;
const NOBODY = SystemProgram.programId.toBase58();

const failure = (e: unknown) => `${String(e)}\n${((e as { logs?: string[] }).logs ?? []).join("\n")}`;

/** Anchor's event discriminator: sha256("event:<Name>")[..8]. */
const eventTag = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
type KeeperChanged = { tier: string; oldKeeper: string; newKeeper: string; resigned: boolean };
type GuardChanged = { tier: string; guard: bigint };
/** The events a transaction logged, decoded by hand from its "Program data:" lines. */
function events(logs: string[]) {
  const keeper: KeeperChanged[] = [];
  const guard: GuardChanged[] = [];
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    const b = Buffer.from(m[1], "base64");
    const tag = b.subarray(0, 8);
    const key = (at: number) => new PublicKey(b.subarray(at, at + 32)).toBase58();
    if (tag.equals(eventTag("KeeperChanged"))) {
      assert.equal(b.length, 8 + 32 * 3 + 1, "KeeperChanged is a tier, two keys and a flag");
      keeper.push({ tier: key(8), oldKeeper: key(40), newKeeper: key(72), resigned: b[104] === 1 });
    } else if (tag.equals(eventTag("SwapGuardChanged"))) {
      assert.equal(b.length, 8 + 32 + 8, "SwapGuardChanged is a tier and a number");
      guard.push({ tier: key(8), guard: b.readBigUInt64LE(40) });
    }
  }
  return { keeper, guard };
}

const CALLER_ID = process.env.CPI_CALLER_ID;
if (!CALLER_ID) {
  if (process.env.CI) throw new Error("CPI_CALLER_ID is not set: the address tests/cpi-caller was deployed at");
  console.warn("cp-swap keeper resignation: SKIPPED, CPI_CALLER_ID is not set (tests/cpi-caller is not deployed on this chain)");
  describe.skip("cp-swap keeper resignation", () => {
    it("needs tests/cpi-caller deployed and its address in CPI_CALLER_ID");
  });
}

if (CALLER_ID) describe("cp-swap keeper resignation", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  /** cp-swap's admin in this build; it also opens the pool. */
  const wallet = anchor.Wallet.local().payer;
  const cpSwap = new Program(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/raydium_cp_swap.json"), "utf8")) as Idl,
    provider
  ) as Program<Idl>;
  const CALLER = new PublicKey(CALLER_ID);
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpSwap.programId)[0];
  const tierAt = (index: number) => pda([AMM_CONFIG_SEED, new BN(index).toArrayLike(Buffer, "be", 2)]);
  /** The tier its pool trades on, and a second tier the same keeper keeps. */
  const tier = tierAt(43);
  const second = tierAt(44);
  const feeReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const own = (m: PublicKey, who: PublicKey) => getAssociatedTokenAddressSync(m, who);
  const authority = pda([AUTH_SEED]);

  /** A visitor's wallet, and the wallet the admin names keeper (our robot). */
  const stranger = Keypair.generate();
  const keeper = Keypair.generate();
  let m0: PublicKey;
  let m1: PublicKey;
  let pool: PublicKey;
  let vault0: PublicKey;
  let vault1: PublicKey;
  let observationState: PublicKey;

  const keeperOf = async (t: PublicKey) => new PublicKey((await conn.getAccountInfo(t))!.data.subarray(KEEPER_AT, KEEPER_AT + 32)).toBase58();
  /** Logs of a confirmed transaction. */
  const logsOf = async (sig: string) =>
    (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages ?? [];
  /** Sends `ixs` paid and signed by `signers[0]` alone (plus the rest); the signature, or what refused it. */
  const sendAs = async (ixs: TransactionInstruction[], ...signers: Keypair[]): Promise<{ sig: string; why: string }> => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    try {
      const sig = await anchor.web3.sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
      return { sig, why: "" };
    } catch (e) {
      return { sig: "", why: failure(e) || "refused" };
    }
  };
  const resignIx = (who: PublicKey, t: PublicKey) =>
    cpSwap.methods.resignKeeper().accountsPartial({ keeper: who, ammConfig: t }).instruction();
  const setKeeperIx = (who: PublicKey, t: PublicKey) =>
    cpSwap.methods
      .updateAmmConfig(9, new BN(0))
      .accountsPartial({ owner: wallet.publicKey, ammConfig: t })
      .remainingAccounts([{ pubkey: who, isSigner: false, isWritable: false }])
      .instruction();
  const setGuardIx = (value: number, t: PublicKey) =>
    cpSwap.methods.updateAmmConfig(8, new BN(value)).accountsPartial({ owner: wallet.publicKey, ammConfig: t }).instruction();

  /** One swap of exactly 1 token 0 in, signed by `payer`. */
  const swapIx = (payer: PublicKey) =>
    cpSwap.methods
      .swapBaseInput(new BN(1_000_000), new BN(0))
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
  const called = (ix: TransactionInstruction) =>
    new TransactionInstruction({ programId: CALLER, keys: [{ pubkey: ix.programId, isSigner: false, isWritable: false }, ...ix.keys], data: ix.data });
  /** The protocol fee the pool has set aside in token 0: it grows only on a swap that pays the fee. */
  const protocolFee0 = async () => BigInt((await (cpSwap.account as any).poolState.fetch(pool)).protocolFeesToken0.toString());

  before(async () => {
    try {
      await createAssociatedTokenAccount(conn, wallet, NATIVE_MINT, wallet.publicKey);
    } catch {
      /* another file in this run made it already */
    }
    for (const t of [43, 44]) {
      // The 1% tier's shape (fee setting 1 on mainnet).
      await cpSwap.methods
        .createAmmConfig(t, new BN(10_000), new BN(104_000), new BN(56_000), new BN(0), new BN(0))
        .accountsPartial({ owner: wallet.publicKey, ammConfig: tierAt(t), systemProgram: SystemProgram.programId })
        .rpc();
    }
    // The keeper and the stranger pay their own network fees here.
    for (const who of [keeper, stranger]) {
      await provider.sendAndConfirm(
        new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: who.publicKey, lamports: LAMPORTS_PER_SOL }))
      );
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
    pool = pda([POOL_SEED, tier.toBuffer(), m0.toBuffer(), m1.toBuffer()]);
    const lp = pda([POOL_LP_MINT_SEED, pool.toBuffer()]);
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
    const opens = Number((await (cpSwap.account as any).poolState.fetch(pool)).openTime);
    for (let i = 0; i < 40 && ((await conn.getBlockTime(await conn.getSlot())) ?? 0) < opens; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  it("the admin's guard and keeper changes are logged, with the keeper before and after", async () => {
    const { sig, why } = await sendAs([await setGuardIx(1, tier), await setKeeperIx(keeper.publicKey, tier), await setKeeperIx(keeper.publicKey, second)], wallet);
    assert.equal(why, "");
    const ev = events(await logsOf(sig));
    assert.deepEqual(ev.guard, [{ tier: tier.toBase58(), guard: 1n }]);
    assert.deepEqual(ev.keeper, [
      { tier: tier.toBase58(), oldKeeper: NOBODY, newKeeper: keeper.publicKey.toBase58(), resigned: false },
      { tier: second.toBase58(), oldKeeper: NOBODY, newKeeper: keeper.publicKey.toBase58(), resigned: false },
    ]);
    assert.equal(await keeperOf(tier), keeper.publicKey.toBase58());
    assert.equal(await keeperOf(second), keeper.publicKey.toBase58());
  });

  // The control the resignation is measured against: while named, the keeper swaps free and is
  // let through the guard from inside another program.
  it("while named, the keeper swaps free and another program may call its swap", async () => {
    const fee = await protocolFee0();
    assert.equal((await sendAs([await swapIx(keeper.publicKey)], keeper)).why, "");
    assert.equal(await protocolFee0(), fee, "the keeper's swap set no protocol fee aside");
    assert.equal((await sendAs([called(await swapIx(keeper.publicKey))], keeper)).why, "");
    assert.include((await sendAs([called(await swapIx(stranger.publicKey))], stranger)).why, "SwapNotDirect");
  });

  it("the admin cannot name a program's address keeper, and nothing changes", async () => {
    const { why } = await sendAs([await setKeeperIx(authority, tier)], wallet);
    assert.include(why, "KeeperNotAWallet");
    assert.include(why, "Error Number: 6017");
    assert.equal(await keeperOf(tier), keeper.publicKey.toBase58());
  });

  it("nobody but the keeper can resign it: not a stranger, not the admin", async () => {
    for (const who of [stranger, wallet]) {
      const { why } = await sendAs([await resignIx(who.publicKey, tier)], who);
      assert.include(why, "NotKeeper", `${who === wallet ? "the admin" : "a stranger"}: ${why}`);
      assert.include(why, "Error Number: 6016");
    }
    assert.equal(await keeperOf(tier), keeper.publicKey.toBase58());
  });

  // The keeper signs routes other programs build: one of them, handed its signature, must not
  // be able to end the role (the Solana audit of 2026-11-15, CPS-13).
  it("another program cannot resign it, even with the keeper's signature", async () => {
    const { why } = await sendAs([called(await resignIx(keeper.publicKey, tier))], keeper);
    assert.include(why, "NotKeeper", why);
    assert.include(why, "Error Number: 6016");
    assert.equal(await keeperOf(tier), keeper.publicKey.toBase58());
  });

  it("the keeper resigns alone, paying its own fee, at once; the tier has no keeper and says who resigned", async () => {
    const { sig, why } = await sendAs([await resignIx(keeper.publicKey, tier)], keeper);
    assert.equal(why, "");
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys;
    const signers = keys.slice(0, tx!.transaction.message.header.numRequiredSignatures).map((k) => k.toBase58());
    assert.deepEqual(signers, [keeper.publicKey.toBase58()], "the keeper was the only signer");
    assert.deepEqual(events(tx!.meta!.logMessages ?? []).keeper, [
      { tier: tier.toBase58(), oldKeeper: keeper.publicKey.toBase58(), newKeeper: NOBODY, resigned: true },
    ]);
    assert.equal(await keeperOf(tier), NOBODY);
    // Nothing else of the tier moved: the guard is still on.
    assert.equal((await conn.getAccountInfo(tier))!.data.readBigUInt64LE(116), 1n);
  });

  it("resigned, its swaps pay the fee again and the guard refuses another program's call of them", async () => {
    const fee = await protocolFee0();
    assert.equal((await sendAs([await swapIx(keeper.publicKey)], keeper)).why, "");
    assert.isTrue((await protocolFee0()) > fee, "the swap set a protocol fee aside");
    assert.include((await sendAs([called(await swapIx(keeper.publicKey))], keeper)).why, "SwapNotDirect");
  });

  it("the other tier it keeps is untouched", async () => {
    assert.equal(await keeperOf(second), keeper.publicKey.toBase58());
  });

  it("it cannot resign twice, and nobody can resign a tier with no keeper", async () => {
    for (const who of [keeper, stranger]) {
      assert.include((await sendAs([await resignIx(who.publicKey, tier)], who)).why, "NotKeeper");
    }
    assert.equal(await keeperOf(tier), NOBODY);
  });

  it("the keeper gives up every tier it keeps in one transaction of its own", async () => {
    assert.equal((await sendAs([await setKeeperIx(keeper.publicKey, tier)], wallet)).why, "", "the admin may name it again");
    const { sig, why } = await sendAs([await resignIx(keeper.publicKey, tier), await resignIx(keeper.publicKey, second)], keeper);
    assert.equal(why, "");
    assert.deepEqual(
      events(await logsOf(sig)).keeper.map((e) => [e.tier, e.resigned]),
      [
        [tier.toBase58(), true],
        [second.toBase58(), true],
      ]
    );
    assert.equal(await keeperOf(tier), NOBODY);
    assert.equal(await keeperOf(second), NOBODY);
  });

  it("the admin clearing a keeper is logged as the admin's, not as a resignation", async () => {
    assert.equal((await sendAs([await setKeeperIx(keeper.publicKey, second)], wallet)).why, "");
    const { sig, why } = await sendAs([await setKeeperIx(SystemProgram.programId, second), await setGuardIx(0, tier)], wallet);
    assert.equal(why, "");
    const ev = events(await logsOf(sig));
    assert.deepEqual(ev.keeper, [{ tier: second.toBase58(), oldKeeper: keeper.publicKey.toBase58(), newKeeper: NOBODY, resigned: false }]);
    assert.deepEqual(ev.guard, [{ tier: tier.toBase58(), guard: 0n }]);
  });
});
