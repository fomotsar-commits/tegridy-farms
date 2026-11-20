/**
 * cp-swap's sweep (programs/cp-swap/src/lib.rs `sweep_fees`) on a local validator. solana-ci.yml's
 * migration-rehearsal job runs it after the keeper's files, on the same deployed cp-swap (this
 * wallet its admin, and the venue here: the protocol owner on mainnet is the admin). It opens its
 * own tiers (71 to 74), so it needs no other file. The rules: TEGRIDY_FORK.md, "The fee sweep";
 * each test's title says the one it holds.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  createAccount,
  createAssociatedTokenAccount,
  createAssociatedTokenAccountIdempotent,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  ExtensionType,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
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
/** GROYPER's transfer fee on mainnet, for the taxed coin here. */
const TAX_BPS = 300;

const failure = (e: unknown) => `${String(e)}\n${((e as { logs?: string[] }).logs ?? []).join("\n")}`;
/** A refusal by name when the simulation refuses it, or by number when the network does. */
const refusedWith = (name: string, code: number) => (err: string, what?: string) =>
  assert.match(err, new RegExp(`${name}|"Custom":${code}\\b|custom program error: 0x${code.toString(16)}\\b`), what);
const refusedNotOwners = refusedWith("NotFeeOwnersAccount", 6018);
const refusedNotAdmin = refusedWith("ProtocolOwnerNotAdmin", 6019);
const refusedInvalidVault = refusedWith("InvalidVault", 6008);
const refusedTier = refusedWith("ConstraintAddress", 2012);
const refusedVault = refusedWith("ConstraintRaw", 2003);

/** Anchor's event discriminator: sha256("event:<Name>")[..8]. */
const eventTag = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
type Swept = { pool: string; fund: boolean; owner: string; moved: [bigint, bigint]; left: [bigint, bigint] };
/** The FeesSwept events a transaction logged, decoded by hand from its "Program data:" lines. */
function swept(logs: string[]): Swept[] {
  const out: Swept[] = [];
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    const b = Buffer.from(m[1], "base64");
    if (!b.subarray(0, 8).equals(eventTag("FeesSwept"))) continue;
    assert.equal(b.length, 8 + 32 + 1 + 32 + 8 * 4, "FeesSwept is a pool, a side, an owner and four amounts");
    out.push({
      pool: new PublicKey(b.subarray(8, 40)).toBase58(),
      fund: b[40] === 1,
      owner: new PublicKey(b.subarray(41, 73)).toBase58(),
      moved: [b.readBigUInt64LE(73), b.readBigUInt64LE(81)],
      left: [b.readBigUInt64LE(89), b.readBigUInt64LE(97)],
    });
  }
  return out;
}

describe("cp-swap sweep_fees", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as AnchorProvider;
  const conn = provider.connection;
  /** cp-swap's admin in this build, so the venue (the protocol owner); it also mints the test coins. */
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
    getAssociatedTokenAddressSync(mint, owner, true, program, ASSOCIATED_TOKEN_PROGRAM_ID);

  /** The island (fund owner), a protocol owner that is not the admin, and a visitor who sweeps. */
  const venue = wallet;
  const island = Keypair.generate();
  const venue2 = Keypair.generate();
  const stranger = Keypair.generate();
  const VENUE = false;
  const ISLAND = true;
  const owners: [string, boolean, Keypair, Keypair][] = [
    ["the venue", VENUE, venue, island],
    ["the island", ISLAND, island, venue],
  ];

  type Pool = {
    tier: PublicKey;
    pool: PublicKey;
    mints: [PublicKey, PublicKey];
    programs: [PublicKey, PublicKey];
    vaults: [PublicKey, PublicKey];
    observationState: PublicKey;
  };
  /** Tier 71: two classic coins. 72: a classic and a Token-2022 coin. 73: tier 71's coins, the
   * vault authority its fund owner. 74: a classic coin and a Token-2022 coin with a 3% transfer fee. */
  let classic: Pool;
  let t22: Pool;
  let authFund: Pool;
  let taxed: Pool;
  let taxedMint: PublicKey;

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
  /** One side's two counts. */
  const share = (s: State, fund: boolean) => (fund ? s.fund : s.protocol);
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

  /** The sweep of `owner`'s share of pool `p` (the island's when `fund`), any account replaced by `over`. */
  const sweepIx = (p: Pool, fund: boolean, owner: PublicKey, over: Record<string, PublicKey> = {}) =>
    cpSwap.methods
      .sweepFees(fund)
      .accountsPartial({
        authority,
        poolState: p.pool,
        ammConfig: p.tier,
        token0Vault: p.vaults[0],
        token1Vault: p.vaults[1],
        vault0Mint: p.mints[0],
        vault1Mint: p.mints[1],
        ownerToken0Account: ata(p.mints[0], owner, p.programs[0]),
        ownerToken1Account: ata(p.mints[1], owner, p.programs[1]),
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        ...over,
      })
      .instruction();
  const slotName = (i: number) => (i === 0 ? "ownerToken0Account" : "ownerToken1Account");

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
  /** Swaps both ways, so that both tokens of the pool have both shares set aside. */
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
  /** `owner` hands its own account for token `i` of `p` to the stranger, or the stranger hands it back. */
  const handOver = (p: Pool, i: number, owner: Keypair, back = false) =>
    setAuthority(
      conn,
      wallet,
      ata(p.mints[i], owner.publicKey, p.programs[i]),
      back ? stranger : owner,
      AuthorityType.AccountOwner,
      back ? owner.publicKey : stranger.publicKey
    );

  /** A 1% tier at `index` and a public pool of `mints` on it, open for swaps. Its protocol owner is the admin. */
  const openPool = async (
    index: number,
    mints: [PublicKey, PublicKey],
    programs: [PublicKey, PublicKey],
    fundOwner: PublicKey = island.publicKey
  ): Promise<Pool> => {
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
    // The island owns the tier's fund share, as the Workshop does on mainnet; the admin keeps the protocol share.
    await setOwner(p, 4, fundOwner);
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
    for (const who of [island, venue2]) {
      await send([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: who.publicKey, lamports: LAMPORTS_PER_SOL / 10 })], wallet);
    }
    const a = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const b = await createMint(conn, wallet, wallet.publicKey, null, 6);
    const c = await createMint(conn, wallet, wallet.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    // A Token-2022 coin that keeps 3% of every transfer, as GROYPER does on mainnet.
    const d = Keypair.generate();
    const len = getMintLen([ExtensionType.TransferFeeConfig]);
    const made = await send(
      [
        SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: d.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
        createInitializeTransferFeeConfigInstruction(d.publicKey, wallet.publicKey, wallet.publicKey, TAX_BPS, 10n ** 15n, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(d.publicKey, 6, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
      ],
      wallet,
      [d]
    );
    assert.equal(made.err, "", "the taxed coin is made");
    taxedMint = d.publicKey;
    const coins: [PublicKey, PublicKey][] = [
      [a, TOKEN_PROGRAM_ID],
      [b, TOKEN_PROGRAM_ID],
      [c, TOKEN_2022_PROGRAM_ID],
      [taxedMint, TOKEN_2022_PROGRAM_ID],
    ];
    for (const [m, prog] of coins) {
      for (const who of [wallet.publicKey, stranger.publicKey, island.publicKey, venue2.publicKey]) {
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
    // The fund owner is named once only (update_config param 4), so this tier names the authority from the start.
    authFund = await openPool(73, cm, cp, authority);
    const [xm, xp] = sorted([a, TOKEN_PROGRAM_ID], [taxedMint, TOKEN_2022_PROGRAM_ID]);
    taxed = await openPool(74, xm, xp);
  });

  for (const [who, fund, owner, other] of owners) {
    it(`anyone may sweep ${who}'s share on its own: all of it lands in ${who}'s own accounts, the other share stays set aside, and the price does not move`, async () => {
      await trade(classic);
      const before = await state(classic);
      const ownerBefore = await held(owner.publicKey, classic);
      const otherBefore = await held(other.publicKey, classic);
      const r = await send([await sweepIx(classic, fund, owner.publicKey)], stranger);
      assert.equal(r.err, "", "a stranger's sweep goes through");
      const after = await state(classic);
      const ownerAfter = await held(owner.publicKey, classic);
      const otherAfter = await held(other.publicKey, classic);
      for (const i of [0, 1]) {
        assert.equal(ownerAfter[i] - ownerBefore[i], share(before, fund)[i], `all of ${who}'s token ${i}`);
        assert.equal(share(after, fund)[i], 0n, `${who}'s token ${i} count is zero`);
        assert.equal(share(after, !fund)[i], share(before, !fund)[i], `the other share of token ${i} stays set aside`);
        assert.equal(otherAfter[i], otherBefore[i], `the other owner is paid nothing of token ${i}`);
        assert.equal(before.vault[i] - after.vault[i], share(before, fund)[i], `the vault of token ${i} paid exactly ${who}'s share`);
        assert.equal(curve(after, i), curve(before, i), `the curve's token ${i} did not move`);
      }
      assert.deepEqual(after.creator, before.creator, "the creator fee is untouched");

      const ev = swept(await logsOf(r.sig));
      assert.equal(ev.length, 1, "one FeesSwept");
      assert.deepEqual(ev[0], {
        pool: classic.pool.toBase58(),
        fund,
        owner: owner.publicKey.toBase58(),
        moved: [share(before, fund)[0], share(before, fund)[1]],
        left: [0n, 0n],
      });
    });
  }

  it("with nothing set aside, a sweep of either share moves nothing and still goes through", async () => {
    for (const [who, fund, owner] of owners) {
      const empty = await send([await sweepIx(classic, fund, owner.publicKey)], stranger);
      assert.equal(empty.err, "", `${who}'s first sweep`);
      const before = await state(classic);
      const heldBefore = await held(owner.publicKey, classic);
      const r = await send([await sweepIx(classic, fund, owner.publicKey)], stranger);
      assert.equal(r.err, "", `${who}'s sweep with nothing set aside`);
      assert.deepEqual(share(await state(classic), fund), [0n, 0n]);
      assert.deepEqual(await state(classic), before);
      assert.deepEqual(await held(owner.publicKey, classic), heldBefore);
    }
  });

  it("for each owner and each coin, a destination that is not the owner's own associated account is refused, and nothing moves", async () => {
    await trade(classic);
    const before = await state(classic);
    for (const [who, fund, owner, other] of owners) {
      for (const i of [0, 1]) {
        const second = await createAccount(conn, wallet, classic.mints[i], owner.publicKey, Keypair.generate(), undefined, classic.programs[i]);
        const cases: [string, PublicKey][] = [
          ["a second account the owner holds", second],
          ["the stranger's own account", ata(classic.mints[i], stranger.publicKey, classic.programs[i])],
          ["the other owner's account", ata(classic.mints[i], other.publicKey, classic.programs[i])],
          ["the owner's account for the other coin", ata(classic.mints[1 - i], owner.publicKey, classic.programs[1 - i])],
        ];
        for (const [what, account] of cases) {
          const r = await send([await sweepIx(classic, fund, owner.publicKey, { [slotName(i)]: account })], stranger);
          refusedNotOwners(r.err, `${who}, token ${i}: ${what}`);
        }
      }
    }
    assert.deepEqual(await state(classic), before, "the refused sweeps moved nothing");
  });

  it("for each owner and each coin, an associated account its owner handed over is refused, and taken back, it is paid again", async () => {
    for (const [who, fund, owner] of owners) {
      for (const i of [0, 1]) {
        await handOver(classic, i, owner);
        try {
          const before = await state(classic);
          const refused = await send([await sweepIx(classic, fund, owner.publicKey)], stranger);
          refusedNotOwners(refused.err, `${who}'s token ${i} account, handed over`);
          assert.deepEqual(await state(classic), before);
        } finally {
          // Always taken back: a failure above must not leave the account with the stranger for the tests after.
          await handOver(classic, i, owner, true);
        }
      }
      const r = await send([await sweepIx(classic, fund, owner.publicKey)], stranger);
      assert.equal(r.err, "", `${who}'s account taken back is paid`);
      assert.deepEqual(share(await state(classic), fund), [0n, 0n]);
    }
  });

  for (const [who, fund, owner, other] of owners) {
    it(`an account ${who} hands over stops only ${who}'s sweep: the other owner's still goes through`, async () => {
      await trade(classic);
      await handOver(classic, fund ? 0 : 1, owner);
      try {
        const before = await state(classic);
        const blocked = await send([await sweepIx(classic, fund, owner.publicKey)], stranger);
        refusedNotOwners(blocked.err, `${who}'s own sweep`);
        const otherBefore = await held(other.publicKey, classic);
        const r = await send([await sweepIx(classic, !fund, other.publicKey)], stranger);
        assert.equal(r.err, "", "the other owner's sweep goes through");
        const after = await state(classic);
        const otherAfter = await held(other.publicKey, classic);
        for (const i of [0, 1]) {
          assert.equal(otherAfter[i] - otherBefore[i], share(before, !fund)[i], `all of the other owner's token ${i}`);
          assert.equal(share(after, !fund)[i], 0n);
          assert.equal(share(after, fund)[i], share(before, fund)[i], `${who}'s token ${i} stays set aside`);
        }
      } finally {
        await handOver(classic, fund ? 0 : 1, owner, true);
      }
      assert.equal((await send([await sweepIx(classic, fund, owner.publicKey)], stranger)).err, "", `${who}'s sweep, account taken back`);
    });
  }

  it("the venue's share is swept only while the tier's protocol owner is the admin; the island's still is, and the admin still collects by hand", async () => {
    // The vault authority's own accounts: off the curve, so made with allowOwnerOffCurve.
    for (const i of [0, 1] as const) {
      await createAssociatedTokenAccountIdempotent(conn, wallet, classic.mints[i], authority, { commitment: "confirmed" }, classic.programs[i], ASSOCIATED_TOKEN_PROGRAM_ID, true);
    }
    for (const notAdmin of [venue2.publicKey, authority]) {
      await setOwner(classic, 3, notAdmin);
      try {
        await trade(classic);
        const before = await state(classic);
        const heldBefore = await held(notAdmin, classic);
        for (const named of [notAdmin, venue.publicKey]) {
          const r = await send([await sweepIx(classic, VENUE, named)], stranger);
          refusedNotAdmin(r.err, `protocol owner ${notAdmin.toBase58()}, accounts of ${named.toBase58()}`);
        }
        assert.deepEqual(await state(classic), before, "the refused sweeps moved nothing");
        assert.deepEqual(await held(notAdmin, classic), heldBefore, "the protocol owner that is not the admin got nothing");

        const islandBefore = await held(island.publicKey, classic);
        const r = await send([await sweepIx(classic, ISLAND, island.publicKey)], stranger);
        assert.equal(r.err, "", "the island's sweep goes through");
        const after = await state(classic);
        const islandAfter = await held(island.publicKey, classic);
        for (const i of [0, 1]) assert.equal(islandAfter[i] - islandBefore[i], before.fund[i]);
        assert.deepEqual(after.protocol, before.protocol, "the venue's share stays set aside");

        const venueBefore = await held(venue.publicKey, classic);
        const collect = await cpSwap.methods
          .collectProtocolFee(new BN("18446744073709551615"), new BN("18446744073709551615"))
          .accountsPartial({
            owner: wallet.publicKey,
            authority,
            poolState: classic.pool,
            ammConfig: classic.tier,
            token0Vault: classic.vaults[0],
            token1Vault: classic.vaults[1],
            vault0Mint: classic.mints[0],
            vault1Mint: classic.mints[1],
            recipientToken0Account: ata(classic.mints[0], venue.publicKey, classic.programs[0]),
            recipientToken1Account: ata(classic.mints[1], venue.publicKey, classic.programs[1]),
            tokenProgram: TOKEN_PROGRAM_ID,
            tokenProgram2022: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();
        assert.equal((await send([collect], venue)).err, "", "the admin's hand collect");
        const venueAfter = await held(venue.publicKey, classic);
        for (const i of [0, 1]) assert.equal(venueAfter[i] - venueBefore[i], before.protocol[i], `the admin collects token ${i} by hand`);
      } finally {
        // Always set back: a failure above must not leave the tier naming another owner for the tests after.
        await setOwner(classic, 3, venue.publicKey);
      }
    }
  });

  it("a tier whose fund owner is the vault authority is refused: nothing is swept into an account the pools' vault holder holds", async () => {
    const authAta = (i: 0 | 1) => getAssociatedTokenAddressSync(authFund.mints[i], authority, true, authFund.programs[i], ASSOCIATED_TOKEN_PROGRAM_ID);
    for (const i of [0, 1] as const) {
      await createAssociatedTokenAccountIdempotent(conn, wallet, authFund.mints[i], authority, { commitment: "confirmed" }, authFund.programs[i], ASSOCIATED_TOKEN_PROGRAM_ID, true);
    }
    await trade(authFund);
    const before = await state(authFund);
    const heldBefore = await held(authority, authFund);
    const r = await send([await sweepIx(authFund, ISLAND, authority)], stranger);
    refusedInvalidVault(r.err, "the authority's own accounts as the island's");
    assert.deepEqual(await state(authFund), before, "the refused sweep moved nothing");
    assert.deepEqual(await held(authority, authFund), heldBefore, "the authority's accounts got nothing");
    assert.equal((await send([await sweepIx(authFund, VENUE, venue.publicKey)], stranger)).err, "", "the venue's sweep of that pool still goes through");
    assert.deepEqual((await state(authFund)).fund, before.fund);
  });

  it("a Token-2022 coin is swept to its owner's Token-2022 account and a classic coin to its classic one, on both sides", async () => {
    await trade(t22);
    for (const [who, fund, owner] of owners) {
      const before = await state(t22);
      const heldBefore = await held(owner.publicKey, t22);
      const r = await send([await sweepIx(t22, fund, owner.publicKey)], stranger);
      assert.equal(r.err, "", `${who}'s sweep`);
      const heldAfter = await held(owner.publicKey, t22);
      for (const i of [0, 1]) assert.equal(heldAfter[i] - heldBefore[i], share(before, fund)[i], `${who}'s token ${i}`);
      assert.deepEqual(share(await state(t22), fund), [0n, 0n]);
    }
  });

  it("a coin that takes a transfer fee keeps its share counted in the pool, and the other coin still moves, on both sides", async () => {
    await trade(taxed);
    const t = taxed.mints[0].equals(taxedMint) ? 0 : 1;
    const u = 1 - t;
    for (const [who, fund, owner] of owners) {
      const before = await state(taxed);
      const heldBefore = await held(owner.publicKey, taxed);
      const r = await send([await sweepIx(taxed, fund, owner.publicKey)], stranger);
      assert.equal(r.err, "", `${who}'s sweep`);
      const after = await state(taxed);
      const heldAfter = await held(owner.publicKey, taxed);
      assert.equal(share(after, fund)[t], share(before, fund)[t], `${who}'s share of the taxed coin stays counted`);
      assert.equal(heldAfter[t], heldBefore[t], `${who} is paid none of the taxed coin`);
      assert.equal(after.vault[t], before.vault[t], "the taxed coin's vault paid nothing");
      assert.equal(heldAfter[u] - heldBefore[u], share(before, fund)[u], `all of ${who}'s other coin`);
      assert.equal(share(after, fund)[u], 0n);
      const ev = swept(await logsOf(r.sig));
      assert.equal(ev.length, 1, "one FeesSwept");
      const moved: [bigint, bigint] = [0n, 0n];
      const left: [bigint, bigint] = [0n, 0n];
      moved[u] = share(before, fund)[u];
      left[t] = share(before, fund)[t];
      assert.deepEqual(ev[0], { pool: taxed.pool.toBase58(), fund, owner: owner.publicKey.toBase58(), moved, left }, "it logs what stays");
    }
  });

  it("the tier and both vaults must be the pool's own", async () => {
    await trade(classic);
    const before = [await state(classic), await state(authFund)];
    for (const [who, fund, owner] of owners) {
      refusedTier((await send([await sweepIx(classic, fund, owner.publicKey, { ammConfig: t22.tier })], stranger)).err, `${who}: another pool's tier`);
      for (const i of [0, 1]) {
        const vault = i === 0 ? { token0Vault: authFund.vaults[0] } : { token1Vault: authFund.vaults[1] };
        refusedVault((await send([await sweepIx(classic, fund, owner.publicKey, vault)], stranger)).err, `${who}: another pool's vault of token ${i}`);
      }
    }
    assert.deepEqual([await state(classic), await state(authFund)], before, "the refused sweeps moved nothing");
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
