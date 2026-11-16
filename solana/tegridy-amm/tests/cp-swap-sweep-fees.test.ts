/**
 * cp-swap's sweep of 2026-11-15 on a local validator. solana-ci.yml's migration-rehearsal job runs
 * it after the keeper's files, on the same deployed cp-swap (this wallet its admin). It opens its
 * own tiers (71 and 72), so it needs no other file.
 *
 * The rule (programs/cp-swap/src/lib.rs `sweep_fees`):
 *  - Anyone may call it, paying only the network fee. It moves ALL of a pool's protocol share to
 *    the protocol owner's own associated token accounts and ALL of its fund share to the fund
 *    owner's, and the four counts to zero. Nothing else moves: the curve (the vaults less every
 *    share set aside) is the same before and after, so the price does not move.
 *  - Each destination must be that owner's associated token account for the coin, under the
 *    coin's own token program, and still owned by that owner. Anything else is refused (6018
 *    NotFeeOwnersAccount): a stranger's account, the other owner's, a second account the owner
 *    holds, one the owner handed over. A refused sweep moves nothing.
 *  - The destinations follow the tier: when the admin names a new protocol owner, the sweep pays
 *    the new one and refuses the old one.
 *  - A coin of the Token-2022 program is swept to its owner's Token-2022 account.
 *  - With nothing set aside it moves nothing and still succeeds.
 *  - The hand collect is unchanged: a stranger still cannot call collect_protocol_fee.
 *  - Every sweep is logged (FeesSwept) with what it moved.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  createAccount,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  NATIVE_MINT,
  setAuthority,
  TOKEN_2022_PROGRAM_ID,
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

/** The 1% tier's shape (fee setting 1 on mainnet), in millionths. */
const TRADE_FEE = 10_000n;
const PROTOCOL_SHARE = 104_000n;
const FUND_SHARE = 56_000n;
/** One swap: exactly 1 token in (6 decimals). */
const ONE_IN = 1_000_000n;

const failure = (e: unknown) => `${String(e)}\n${((e as { logs?: string[] }).logs ?? []).join("\n")}`;
/** Refused with 6018 NotFeeOwnersAccount: by name when the simulation refuses it, by number when the network does. */
const refusedNotOwners = (err: string, what?: string) =>
  assert.match(err, /NotFeeOwnersAccount|"Custom":6018\b|custom program error: 0x1782\b/, what);

/** Anchor's event discriminator: sha256("event:<Name>")[..8]. */
const eventTag = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
type Swept = {
  pool: string;
  protocolOwner: string;
  fundOwner: string;
  protocol: [bigint, bigint];
  fund: [bigint, bigint];
};
/** The FeesSwept events a transaction logged, decoded by hand from its "Program data:" lines. */
function swept(logs: string[]): Swept[] {
  const out: Swept[] = [];
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    const b = Buffer.from(m[1], "base64");
    if (!b.subarray(0, 8).equals(eventTag("FeesSwept"))) continue;
    assert.equal(b.length, 8 + 32 * 3 + 8 * 4, "FeesSwept is a pool, two owners and four amounts");
    const key = (at: number) => new PublicKey(b.subarray(at, at + 32)).toBase58();
    out.push({
      pool: key(8),
      protocolOwner: key(40),
      fundOwner: key(72),
      protocol: [b.readBigUInt64LE(104), b.readBigUInt64LE(112)],
      fund: [b.readBigUInt64LE(120), b.readBigUInt64LE(128)],
    });
  }
  return out;
}

describe("cp-swap sweep_fees", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  /** cp-swap's admin in this build; it also opens the pools and mints the test coins. */
  const wallet = anchor.Wallet.local().payer;
  const cpSwap = new Program(
    JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/raydium_cp_swap.json"), "utf8")) as Idl,
    provider
  ) as Program<Idl>;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpSwap.programId)[0];
  const tierAt = (index: number) => pda([AMM_CONFIG_SEED, new BN(index).toArrayLike(Buffer, "be", 2)]);
  const feeReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const authority = pda([AUTH_SEED]);
  const ata = (mint: PublicKey, owner: PublicKey, program: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, program, ASSOCIATED_TOKEN_PROGRAM_ID);

  /** The venue (protocol owner), the island (fund owner), a later venue, and a visitor who sweeps. */
  const venue = Keypair.generate();
  const island = Keypair.generate();
  const venue2 = Keypair.generate();
  const stranger = Keypair.generate();

  type Pool = {
    tier: PublicKey;
    pool: PublicKey;
    mints: [PublicKey, PublicKey];
    programs: [PublicKey, PublicKey];
    vaults: [PublicKey, PublicKey];
    observationState: PublicKey;
  };
  /** Two classic coins on tier 71, and a classic coin against a Token-2022 coin on tier 72. */
  let classic: Pool;
  let t22: Pool;

  const n = (b: BN) => BigInt(b.toString());
  /** The four shares the pool has set aside, its creator fee, and its two vaults. */
  const state = async (p: Pool) => {
    const ps = await (cpSwap.account as any).poolState.fetch(p.pool);
    return {
      protocol: [n(ps.protocolFeesToken0), n(ps.protocolFeesToken1)],
      fund: [n(ps.fundFeesToken0), n(ps.fundFeesToken1)],
      creator: [n(ps.creatorFeesToken0), n(ps.creatorFeesToken1)],
      vault: [
        (await getAccount(conn, p.vaults[0], "confirmed", p.programs[0])).amount,
        (await getAccount(conn, p.vaults[1], "confirmed", p.programs[1])).amount,
      ],
    };
  };
  type State = Awaited<ReturnType<typeof state>>;
  /** What the curve holds of token i: the vault less the shares set aside in it (pool.rs vault_amount_without_fee). */
  const curve = (s: State, i: number) => s.vault[i] - s.protocol[i] - s.fund[i] - s.creator[i];
  const held = async (owner: PublicKey, p: Pool) => [
    (await getAccount(conn, ata(p.mints[0], owner, p.programs[0]), "confirmed", p.programs[0])).amount,
    (await getAccount(conn, ata(p.mints[1], owner, p.programs[1]), "confirmed", p.programs[1])).amount,
  ];

  /**
   * Sends `ixs` with `payer` paying the network fee; "" and the signature, or what refused it.
   * The simulation reads "processed" state, the level the spl-token and Anchor helpers confirm at: read at
   * "confirmed", a change made a moment before (an account handed over, a new owner) can be missing, the
   * simulation passes, and the network refuses it instead (11-15: a flaky pair of failures).
   */
  const send = async (ixs: TransactionInstruction[], payer: Keypair, others: Keypair[] = []) => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = payer.publicKey;
    try {
      const sig = await anchor.web3.sendAndConfirmTransaction(conn, tx, [payer, ...others], {
        commitment: "confirmed",
        preflightCommitment: "processed",
      });
      return { err: "", sig };
    } catch (e) {
      return { err: failure(e) || "refused", sig: "" };
    }
  };
  const logsOf = async (sig: string) =>
    (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages ?? [];

  /** The sweep of pool `p` to the owners `protocolOwner` and `fundOwner`, with any account replaced by `over`. */
  const sweepIx = (p: Pool, protocolOwner: PublicKey, fundOwner: PublicKey, over: Record<string, PublicKey> = {}) =>
    cpSwap.methods
      .sweepFees()
      .accountsPartial({
        authority,
        poolState: p.pool,
        ammConfig: p.tier,
        token0Vault: p.vaults[0],
        token1Vault: p.vaults[1],
        vault0Mint: p.mints[0],
        vault1Mint: p.mints[1],
        protocolToken0Account: ata(p.mints[0], protocolOwner, p.programs[0]),
        protocolToken1Account: ata(p.mints[1], protocolOwner, p.programs[1]),
        fundToken0Account: ata(p.mints[0], fundOwner, p.programs[0]),
        fundToken1Account: ata(p.mints[1], fundOwner, p.programs[1]),
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        ...over,
      })
      .instruction();

  /** One swap of exactly ONE_IN that `who` signs, token 0 in when dir is 0, token 1 in when 1. */
  const swap = async (who: Keypair, p: Pool, dir: 0 | 1) => {
    const [i, o] = dir === 0 ? [0, 1] : [1, 0];
    const ix = await cpSwap.methods
      .swapBaseInput(new BN(ONE_IN.toString()), new BN(0))
      .accountsPartial({
        payer: who.publicKey,
        authority,
        ammConfig: p.tier,
        poolState: p.pool,
        inputTokenAccount: ata(p.mints[i], who.publicKey, p.programs[i]),
        outputTokenAccount: ata(p.mints[o], who.publicKey, p.programs[o]),
        inputVault: p.vaults[i],
        outputVault: p.vaults[o],
        inputTokenProgram: p.programs[i],
        outputTokenProgram: p.programs[o],
        inputTokenMint: p.mints[i],
        outputTokenMint: p.mints[o],
        observationState: p.observationState,
      })
      .instruction();
    const r = await send([ix], who);
    assert.equal(r.err, "", `swap ${dir === 0 ? "0 to 1" : "1 to 0"}`);
  };
  /** Swaps both ways, so that both tokens of the pool have shares set aside. */
  const trade = async (p: Pool) => {
    for (const dir of [0, 1, 0, 1] as const) await swap(stranger, p, dir);
    const s = await state(p);
    for (const i of [0, 1]) {
      assert.isAbove(Number(s.protocol[i]), 0, `the venue's share of token ${i} is set aside`);
      assert.isAbove(Number(s.fund[i]), 0, `the island's share of token ${i} is set aside`);
    }
  };

  const setOwner = (p: Pool, param: 3 | 4, who: PublicKey) =>
    cpSwap.methods
      .updateAmmConfig(param, new BN(0))
      .accountsPartial({ owner: wallet.publicKey, ammConfig: p.tier })
      .remainingAccounts([{ pubkey: who, isSigner: false, isWritable: false }])
      .rpc();

  /** A 1% tier at `index` and a public pool of `mints` on it, open for swaps. */
  const openPool = async (index: number, mints: [PublicKey, PublicKey], programs: [PublicKey, PublicKey]): Promise<Pool> => {
    const tier = tierAt(index);
    await cpSwap.methods
      .createAmmConfig(index, new BN(TRADE_FEE.toString()), new BN(PROTOCOL_SHARE.toString()), new BN(FUND_SHARE.toString()), new BN(0), new BN(0))
      .accountsPartial({ owner: wallet.publicKey, ammConfig: tier, systemProgram: SystemProgram.programId })
      .rpc();
    const pool = pda([POOL_SEED, tier.toBuffer(), mints[0].toBuffer(), mints[1].toBuffer()]);
    const lp = pda([POOL_LP_MINT_SEED, pool.toBuffer()]);
    const p: Pool = {
      tier,
      pool,
      mints,
      programs,
      vaults: [pda([POOL_VAULT_SEED, pool.toBuffer(), mints[0].toBuffer()]), pda([POOL_VAULT_SEED, pool.toBuffer(), mints[1].toBuffer()])],
      observationState: pda([OBSERVATION_SEED, pool.toBuffer()]),
    };
    await cpSwap.methods
      .initialize(new BN(1_000_000_000), new BN(2_000_000_000), new BN(0))
      .accountsPartial({
        creator: wallet.publicKey,
        ammConfig: tier,
        authority,
        poolState: pool,
        token0Mint: mints[0],
        token1Mint: mints[1],
        lpMint: lp,
        creatorToken0: ata(mints[0], wallet.publicKey, programs[0]),
        creatorToken1: ata(mints[1], wallet.publicKey, programs[1]),
        creatorLpToken: ata(lp, wallet.publicKey, TOKEN_PROGRAM_ID),
        token0Vault: p.vaults[0],
        token1Vault: p.vaults[1],
        createPoolFee: feeReceiver,
        observationState: p.observationState,
        tokenProgram: TOKEN_PROGRAM_ID,
        token0Program: programs[0],
        token1Program: programs[1],
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    const opens = Number((await (cpSwap.account as any).poolState.fetch(pool)).openTime);
    for (let i = 0; i < 40 && ((await conn.getBlockTime(await conn.getSlot())) ?? 0) < opens; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    // The venue and the island own the tier's two shares, as the vault and the Workshop do on mainnet.
    await setOwner(p, 3, venue.publicKey);
    await setOwner(p, 4, island.publicKey);
    return p;
  };

  /** A sorted pair of the two mints, each with its own program. */
  const sorted = (a: [PublicKey, PublicKey], b: [PublicKey, PublicKey]): [[PublicKey, PublicKey], [PublicKey, PublicKey]] =>
    Buffer.compare(a[0].toBuffer(), b[0].toBuffer()) < 0 ? [[a[0], b[0]], [a[1], b[1]]] : [[b[0], a[0]], [b[1], a[1]]];

  before(async () => {
    try {
      await createAssociatedTokenAccount(conn, wallet, NATIVE_MINT, wallet.publicKey);
    } catch {
      /* another file in this run made it already */
    }
    await send([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger.publicKey, lamports: LAMPORTS_PER_SOL })], wallet);
    await send([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: venue.publicKey, lamports: LAMPORTS_PER_SOL / 10 })], wallet);
    const a = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const b = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const c = await createMint(conn, wallet, wallet.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    const coins: [PublicKey, PublicKey][] = [
      [a, TOKEN_PROGRAM_ID],
      [b, TOKEN_PROGRAM_ID],
      [c, TOKEN_2022_PROGRAM_ID],
    ];
    for (const [m, prog] of coins) {
      for (const who of [wallet.publicKey, stranger.publicKey, venue.publicKey, island.publicKey, venue2.publicKey]) {
        await createAssociatedTokenAccount(conn, wallet, m, who, undefined, prog);
      }
      for (const who of [wallet.publicKey, stranger.publicKey]) {
        await mintTo(conn, wallet, m, ata(m, who, prog), wallet, 10_000_000_000, [], undefined, prog);
      }
    }
    const [cm, cp] = sorted([a, TOKEN_PROGRAM_ID], [b, TOKEN_PROGRAM_ID]);
    classic = await openPool(71, cm, cp);
    const [tm, tp] = sorted([a, TOKEN_PROGRAM_ID], [c, TOKEN_2022_PROGRAM_ID]);
    t22 = await openPool(72, tm, tp);
  });

  it("anyone may sweep: the venue's share lands in the venue's own accounts, the island's in the island's, all of it, and the price does not move", async () => {
    await trade(classic);
    const before = await state(classic);
    const venueBefore = await held(venue.publicKey, classic);
    const islandBefore = await held(island.publicKey, classic);
    const r = await send([await sweepIx(classic, venue.publicKey, island.publicKey)], stranger);
    assert.equal(r.err, "", "a stranger's sweep goes through");
    const after = await state(classic);
    const venueAfter = await held(venue.publicKey, classic);
    const islandAfter = await held(island.publicKey, classic);
    for (const i of [0, 1]) {
      assert.equal(venueAfter[i] - venueBefore[i], before.protocol[i], `all of the venue's token ${i}`);
      assert.equal(islandAfter[i] - islandBefore[i], before.fund[i], `all of the island's token ${i}`);
      assert.equal(after.protocol[i], 0n, `the venue's token ${i} count is zero`);
      assert.equal(after.fund[i], 0n, `the island's token ${i} count is zero`);
      assert.equal(before.vault[i] - after.vault[i], before.protocol[i] + before.fund[i], `the vault of token ${i} paid exactly the two shares`);
      assert.equal(curve(after, i), curve(before, i), `the curve's token ${i} did not move`);
    }
    assert.deepEqual(after.creator, before.creator, "the creator fee is untouched");

    const ev = swept(await logsOf(r.sig));
    assert.equal(ev.length, 1, "one FeesSwept");
    assert.equal(ev[0].pool, classic.pool.toBase58());
    assert.equal(ev[0].protocolOwner, venue.publicKey.toBase58());
    assert.equal(ev[0].fundOwner, island.publicKey.toBase58());
    assert.deepEqual(ev[0].protocol, [before.protocol[0], before.protocol[1]]);
    assert.deepEqual(ev[0].fund, [before.fund[0], before.fund[1]]);
  });

  it("with nothing set aside, a sweep moves nothing and still goes through", async () => {
    const before = await state(classic);
    const venueBefore = await held(venue.publicKey, classic);
    const islandBefore = await held(island.publicKey, classic);
    const r = await send([await sweepIx(classic, venue.publicKey, island.publicKey)], stranger);
    assert.equal(r.err, "");
    assert.deepEqual(await state(classic), before);
    assert.deepEqual(await held(venue.publicKey, classic), venueBefore);
    assert.deepEqual(await held(island.publicKey, classic), islandBefore);
  });

  it("a destination that is not the owner's own associated account is refused, and nothing moves", async () => {
    await trade(classic);
    const before = await state(classic);
    const second = await createAccount(conn, wallet, classic.mints[0], venue.publicKey, Keypair.generate());
    const islandSecond = await createAccount(conn, wallet, classic.mints[1], island.publicKey, Keypair.generate());
    const cases: [string, Record<string, PublicKey>][] = [
      ["a second account the island holds", { fundToken1Account: islandSecond }],
      ["the stranger's own account as the venue's", { protocolToken0Account: ata(classic.mints[0], stranger.publicKey, TOKEN_PROGRAM_ID) }],
      ["the stranger's own account as the island's", { fundToken1Account: ata(classic.mints[1], stranger.publicKey, TOKEN_PROGRAM_ID) }],
      ["the island's account as the venue's", { protocolToken0Account: ata(classic.mints[0], island.publicKey, TOKEN_PROGRAM_ID) }],
      ["the venue's account as the island's", { fundToken0Account: ata(classic.mints[0], venue.publicKey, TOKEN_PROGRAM_ID) }],
      ["a second account the venue holds", { protocolToken0Account: second }],
      ["the venue's token 1 account in the token 0 slot", { protocolToken0Account: ata(classic.mints[1], venue.publicKey, TOKEN_PROGRAM_ID) }],
    ];
    for (const [what, over] of cases) {
      const r = await send([await sweepIx(classic, venue.publicKey, island.publicKey, over)], stranger);
      refusedNotOwners(r.err, what);
    }
    assert.deepEqual(await state(classic), before, "the refused sweeps moved nothing");
  });

  it("an associated account its owner handed over is refused, and taken back, it is paid again", async () => {
    const venues0 = ata(classic.mints[0], venue.publicKey, TOKEN_PROGRAM_ID);
    await setAuthority(conn, wallet, venues0, venue, AuthorityType.AccountOwner, stranger.publicKey);
    try {
      const before = await state(classic);
      const refused = await send([await sweepIx(classic, venue.publicKey, island.publicKey)], stranger);
      refusedNotOwners(refused.err);
      assert.deepEqual(await state(classic), before);
    } finally {
      // Always taken back: a failure above must not leave the venue's account with the stranger for the tests after.
      await setAuthority(conn, wallet, venues0, stranger, AuthorityType.AccountOwner, venue.publicKey);
    }
    const r = await send([await sweepIx(classic, venue.publicKey, island.publicKey)], stranger);
    assert.equal(r.err, "");
    const after = await state(classic);
    assert.deepEqual([after.protocol, after.fund], [[0n, 0n], [0n, 0n]]);
  });

  it("the destinations follow the tier: a new protocol owner is paid, the old one refused", async () => {
    await setOwner(classic, 3, venue2.publicKey);
    try {
      await trade(classic);
      const before = await state(classic);
      const old = await send([await sweepIx(classic, venue.publicKey, island.publicKey)], stranger);
      refusedNotOwners(old.err);
      const v2Before = await held(venue2.publicKey, classic);
      const r = await send([await sweepIx(classic, venue2.publicKey, island.publicKey)], stranger);
      assert.equal(r.err, "");
      const v2After = await held(venue2.publicKey, classic);
      for (const i of [0, 1]) assert.equal(v2After[i] - v2Before[i], before.protocol[i]);
    } finally {
      // Always set back: a failure above must not leave the tier paying venue2 for the tests after.
      await setOwner(classic, 3, venue.publicKey);
    }
  });

  it("a Token-2022 coin is swept to its owner's Token-2022 account, never a classic-program address", async () => {
    await trade(t22);
    const before = await state(t22);
    const i22 = t22.programs[0].equals(TOKEN_2022_PROGRAM_ID) ? 0 : 1;
    const slot = i22 === 0 ? "protocolToken0Account" : "protocolToken1Account";
    const wrong = await send(
      [await sweepIx(t22, venue.publicKey, island.publicKey, { [slot]: ata(t22.mints[i22], venue.publicKey, TOKEN_PROGRAM_ID) })],
      stranger
    );
    assert.notEqual(wrong.err, "", "the classic-program address of a Token-2022 coin is refused");
    assert.deepEqual(await state(t22), before);
    const venueBefore = await held(venue.publicKey, t22);
    const islandBefore = await held(island.publicKey, t22);
    const r = await send([await sweepIx(t22, venue.publicKey, island.publicKey)], stranger);
    assert.equal(r.err, "");
    const venueAfter = await held(venue.publicKey, t22);
    const islandAfter = await held(island.publicKey, t22);
    for (const i of [0, 1]) {
      assert.equal(venueAfter[i] - venueBefore[i], before.protocol[i]);
      assert.equal(islandAfter[i] - islandBefore[i], before.fund[i]);
    }
  });

  it("the hand collect is unchanged: a stranger still cannot collect the venue's share", async () => {
    await trade(classic);
    const before = await state(classic);
    const ix = await cpSwap.methods
      .collectProtocolFee(new BN("18446744073709551615"), new BN("18446744073709551615"))
      .accountsPartial({
        owner: stranger.publicKey,
        authority,
        poolState: classic.pool,
        ammConfig: classic.tier,
        token0Vault: classic.vaults[0],
        token1Vault: classic.vaults[1],
        vault0Mint: classic.mints[0],
        vault1Mint: classic.mints[1],
        recipientToken0Account: ata(classic.mints[0], stranger.publicKey, TOKEN_PROGRAM_ID),
        recipientToken1Account: ata(classic.mints[1], stranger.publicKey, TOKEN_PROGRAM_ID),
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
    const r = await send([ix], stranger);
    assert.include(r.err, "InvalidOwner");
    assert.deepEqual(await state(classic), before);
  });
});
