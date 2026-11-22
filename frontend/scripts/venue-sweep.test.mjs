// @vitest-environment node
// The daily venue sweep (scripts/venue-sweep.mjs) and its plain-Node signer
// (scripts/lib/solana-signer.mjs), each piece checked against @solana/web3.js and
// @solana/spl-token, which the job itself never loads. Node's environment, not jsdom: there
// web3.js's own curve check and its serializer break (see scripts/bayla-ladder-ops.test.mjs).
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { Keypair, Message, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMemoTransfer, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import {
  ATA_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  associatedTokenAddress,
  compactU16,
  compileLegacy,
  createIdempotentIx,
  findProgramAddress,
  isOnCurve,
  keypairSigner,
  signTransaction,
} from "./lib/solana-signer.mjs";
import {
  FEES_SWEPT_TAG,
  POOL_SIZE,
  POOL_TAG,
  RUN_LIMIT_MS,
  SWEEP_FEES_TAG,
  TIER_SIZE,
  VAULT,
  WORKSHOP,
  customError,
  decodePool,
  decodeTier,
  destinationState,
  destinations,
  exitCode,
  feesSwept,
  fmt,
  memoRequired,
  parseArgs,
  run,
  summary,
  sweepFeesIx,
  transferFeeBps,
  worthSweeping,
} from "./venue-sweep.mjs";
import { ISLAND_COINS, SOL_MINT, USDC_MINT, USDT_MINT, VENUE_PROGRAM, base58, solanaRpc, unbase58 } from "./lib/venue-volume-chain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
const island = (symbol) => ISLAND_COINS.find((c) => c.symbol === symbol).mint;
const BRAINLET = island("BRAINLET");
const SOY = island("SOY");
const GROYPER = "7QAn5wqkBcGuvfLLC16iLvX8fPyqXrzkMqnzHLS9NNna";
/** The two mint accounts as mainnet holds them, read 2026-11-20 (getMultipleAccounts, base64). */
const GROYPER_MINT =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbkKHQXyNAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF8ViRILr6mI0IFU5wFrI4seef1/od1F51MLaPRWO4JvAQBsAEAtXK96l8U0l2WOVhsmI9Djj1NA8git1QpO9FQLCssuQC1cr3qXxTSXZY5WGyYj0OOPU0DyCK3VCk70VAsKyy782J1UBAAAAAgEAAAAAAAAAIDGpH6NAwAsAQgEAAAAAAAAAIDGpH6NAwAsARMAowAHg6gVJiEPlKDo6E0ghwA7OkJg0pznnaz+IaTqdx+mKF8ViRILr6mI0IFU5wFrI4seef1/od1F51MLaPRWO4JvBwAAAEdyb3lwZXIHAAAAR1JPWVBFUkUAAABodHRwczovL2dhdGV3YXkuaXJ5cy54eXovQ29jV1lhWFk2RXpHTmo2dVRzTmpFdWdiM1RleUdUcDVGeE1ac3dZaVM4cmQAAAAA";
const BAYLA_MINT =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAc9L1Xc1+AwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGOXqlJul9FDfGHf+VZIG9qUaE+1xnVBhGM+WDQx51D/EwCqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5eqUm6X0UN8Yd/5Vkgb2pRoT7XGdUGEYz5YNDHnUP8FAAAAQkFZTEEFAAAAQkFZTEFQAAAAaHR0cHM6Ly9pcGZzLmlvL2lwZnMvYmFma3JlaWZ6Y2xjZDJjdHJ4bnBzYnJvdGd5YXp2NW03YmRqcGtham1heDQ3c2p3N2lwN3RneGV2dTQAAAAA";
/** What spl-token itself reads as the higher of a mint's two transfer-fee settings. */
const splTokenBps = (mint, b64) => {
  const m = unpackMint(new PublicKey(mint), { data: Buffer.from(b64, "base64"), owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false }, TOKEN_2022_PROGRAM_ID);
  const c = getTransferFeeConfig(m);
  return c ? Math.max(c.olderTransferFee.transferFeeBasisPoints, c.newerTransferFee.transferFeeBasisPoints) : 0;
};

describe("solana-signer, against @solana/web3.js", () => {
  it("isOnCurve agrees on 300 random strings and 200 wallets' keys", () => {
    for (let i = 0; i < 300; i++) {
      const b = randomBytes(32);
      expect(isOnCurve(b)).toBe(PublicKey.isOnCurve(b));
    }
    for (let i = 0; i < 200; i++) expect(isOnCurve(Keypair.generate().publicKey.toBytes())).toBe(true);
  });

  it("findProgramAddress agrees on address and bump, for random seeds and programs", () => {
    for (let i = 0; i < 60; i++) {
      const program = Keypair.generate().publicKey;
      const seeds = [randomBytes(1 + (i % 32)), randomBytes(i % 7)];
      const [want, bump] = PublicKey.findProgramAddressSync(seeds, program);
      const got = findProgramAddress(seeds, program.toBase58());
      expect(got.address).toBe(want.toBase58());
      expect(got.bump).toBe(bump);
    }
  });

  it("associatedTokenAddress agrees under both token programs, for a wallet and for a program-derived owner like the vault", () => {
    for (const owner of [Keypair.generate().publicKey, new PublicKey(VAULT), new PublicKey(WORKSHOP)]) {
      for (const [mint, program, prog] of [
        [new PublicKey(SOL_MINT), TOKEN_PROGRAM_ID, TOKEN_PROGRAM],
        [new PublicKey(BAYLA), TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM],
      ]) {
        expect(associatedTokenAddress(owner.toBase58(), mint.toBase58(), prog)).toBe(getAssociatedTokenAddressSync(mint, owner, true, program).toBase58());
      }
    }
    // The vault's own fee accounts on mainnet (frontend/scripts/addresses.json).
    expect(associatedTokenAddress(VAULT, SOL_MINT, TOKEN_PROGRAM)).toBe("2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa");
    expect(associatedTokenAddress(VAULT, BAYLA, TOKEN_2022_PROGRAM)).toBe("4HUXwHSie4q52eZiazheRqTHCABQZXJ4Yx3GkdBAwavy");
  });

  it("compactU16 is Solana's short-vector length", () => {
    const cases = [
      [0, [0]],
      [127, [0x7f]],
      [128, [0x80, 0x01]],
      [16383, [0xff, 0x7f]],
      [16384, [0x80, 0x80, 0x01]],
    ];
    for (const [n, want] of cases) expect([...compactU16(n)]).toEqual(want);
  });

  it("a transaction it signs is one web3.js reads back, signature valid, every instruction as built", () => {
    const kp = Keypair.generate();
    const signer = keypairSigner(JSON.stringify([...kp.secretKey]));
    expect(signer.address).toBe(kp.publicKey.toBase58());
    const owner = Keypair.generate().publicKey.toBase58();
    const ixs = [
      createIdempotentIx({ payer: signer.address, owner, mint: SOL_MINT, tokenProgram: TOKEN_PROGRAM }),
      {
        programId: Keypair.generate().publicKey.toBase58(),
        keys: [
          { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
          { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: false },
          { pubkey: signer.address, isSigner: true, isWritable: true },
        ],
        data: Buffer.from([9, 8, 7]),
      },
    ];
    const blockhash = Keypair.generate().publicKey.toBase58();
    const wire = signTransaction(compileLegacy({ payer: signer.address, instructions: ixs, recentBlockhash: blockhash }), signer);
    const tx = Transaction.from(wire);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer.toBase58()).toBe(signer.address);
    expect(tx.recentBlockhash).toBe(blockhash);
    expect(tx.instructions.length).toBe(2);
    tx.instructions.forEach((got, i) => {
      expect(got.programId.toBase58()).toBe(ixs[i].programId);
      expect(Buffer.from(got.data)).toEqual(Buffer.from(ixs[i].data));
      expect(got.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(ixs[i].keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]));
    });
  });

  it("orders a writable second signer before a read-only one, as the message header tells web3.js", () => {
    const payer = key();
    const w = key();
    const r = key();
    const c = compileLegacy({
      payer,
      instructions: [
        { programId: ATA_PROGRAM, keys: [{ pubkey: r, isSigner: true, isWritable: false }, { pubkey: w, isSigner: true, isWritable: true }], data: Buffer.alloc(0) },
      ],
      recentBlockhash: key(),
    });
    const m = Message.from(c.message);
    const at = (k) => m.accountKeys.findIndex((x) => x.toBase58() === k);
    expect(m.header).toMatchObject({ numRequiredSignatures: 3, numReadonlySignedAccounts: 1 });
    expect([at(payer), m.isAccountWritable(at(payer)), m.isAccountSigner(at(payer))]).toEqual([0, true, true]);
    expect([m.isAccountWritable(at(w)), m.isAccountSigner(at(w))]).toEqual([true, true]);
    expect([m.isAccountWritable(at(r)), m.isAccountSigner(at(r))]).toEqual([false, true]);
    expect(m.isAccountWritable(at(ATA_PROGRAM))).toBe(false);
  });

  it("refuses a keypair whose halves do not belong together, and one that is not 64 numbers", () => {
    const a = Keypair.generate().secretKey;
    const b = Keypair.generate().secretKey;
    expect(() => keypairSigner(JSON.stringify([...a.slice(0, 32), ...b.slice(32)]))).toThrow(/does not match/);
    expect(() => keypairSigner("[1,2,3]")).toThrow(/64 numbers/);
  });

  it("will not sign a transaction that needs another signer", () => {
    const kp = Keypair.generate();
    const signer = keypairSigner(JSON.stringify([...kp.secretKey]));
    const other = Keypair.generate().publicKey.toBase58();
    const c = compileLegacy({
      payer: signer.address,
      instructions: [{ programId: ATA_PROGRAM, keys: [{ pubkey: other, isSigner: true, isWritable: false }], data: Buffer.alloc(0) }],
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    });
    expect(() => signTransaction(c, signer)).toThrow(/needs the signatures/);
  });
});

/** PoolState's account tag as a real mainnet pool starts with it (sha256 of "account:PoolState"). */
const POOL_TAG_HEX = "f7ede3f5d7c3de46";

/** A pool account's bytes with its tag and the fields the sweep reads; everything else zero. */
function poolBytes({ ammConfig, vault0, vault1, mint0, mint1, program0, program1, decimals0 = 9, decimals1 = 6, protocol = [0n, 0n], fund = [0n, 0n] }) {
  const d = Buffer.alloc(POOL_SIZE);
  const put = (k, o) => new PublicKey(k).toBuffer().copy(d, o);
  Buffer.from(POOL_TAG_HEX, "hex").copy(d, 0);
  put(ammConfig, 8);
  put(vault0, 72);
  put(vault1, 104);
  put(mint0, 168);
  put(mint1, 200);
  put(program0, 232);
  put(program1, 264);
  d[331] = decimals0;
  d[332] = decimals1;
  d.writeBigUInt64LE(protocol[0], 341);
  d.writeBigUInt64LE(protocol[1], 349);
  d.writeBigUInt64LE(fund[0], 357);
  d.writeBigUInt64LE(fund[1], 365);
  return d.toString("base64");
}
function tierBytes(protocolOwner, fundOwner) {
  const d = Buffer.alloc(TIER_SIZE);
  new PublicKey(protocolOwner).toBuffer().copy(d, 44);
  new PublicKey(fundOwner).toBuffer().copy(d, 76);
  return d.toString("base64");
}
const key = () => Keypair.generate().publicKey.toBase58();

/**
 * A token account's bytes, laid out as both token programs keep its first 165: the mint, the owner,
 * the amount, the delegate (COption at 72), the state (108: 1 open, 2 frozen), is_native, the
 * delegated amount and the close authority (COption at 129). A Token-2022 account adds its account
 * type (2) and the ImmutableOwner entry the associated token program gives it, and with `memo`
 * (true or false) a MemoTransfer entry after it (type 8, one byte: 1 when every transfer in needs
 * a memo).
 */
function tokenAccountBytes({ mint, owner, program, delegate = false, frozen = false, closeAuthority = false, memo = null }) {
  const t22 = program === TOKEN_2022_PROGRAM;
  const d = Buffer.alloc(t22 ? (memo === null ? 170 : 175) : 165);
  new PublicKey(mint).toBuffer().copy(d, 0);
  new PublicKey(owner).toBuffer().copy(d, 32);
  if (delegate) {
    d.writeUInt32LE(1, 72);
    new PublicKey(key()).toBuffer().copy(d, 76);
  }
  d[108] = frozen ? 2 : 1;
  if (closeAuthority) {
    d.writeUInt32LE(1, 129);
    new PublicKey(key()).toBuffer().copy(d, 133);
  }
  if (t22) {
    d[165] = 2;
    d.writeUInt16LE(7, 166);
    if (memo !== null) {
      d.writeUInt16LE(8, 170);
      d.writeUInt16LE(1, 172);
      d[174] = memo ? 1 : 0;
    }
  }
  return d.toString("base64");
}
/** Accounts as getMultipleAccounts returns them. */
const tokenAccount = (o) => ({ owner: o.program, lamports: 2_039_280, executable: false, data: [tokenAccountBytes(o), "base64"] });
const systemAccount = (lamports) => ({ owner: SYSTEM_PROGRAM, lamports, executable: false, data: ["", "base64"] });
/**
 * `owner`'s associated token account for each [mint, program], open; `flags[mint]` sets that one's
 * delegate, state, close authority or memo rule, and `owner` there the owner its bytes name (an
 * account handed to another owner keeps its address).
 */
const accountsOf = (owner, coins, flags = {}) =>
  Object.fromEntries(coins.map(([mint, program]) => [associatedTokenAddress(owner, mint, program), tokenAccount({ mint, owner, program, ...(flags[mint] ?? {}) })]));
const SOL_BAYLA = [
  [SOL_MINT, TOKEN_PROGRAM],
  [BAYLA, TOKEN_2022_PROGRAM],
];
/** Each owner's SOL and BAYLA accounts, open and plain. */
const opened = (...owners) => Object.assign({}, ...owners.map((o) => accountsOf(o, SOL_BAYLA)));

describe("venue-sweep: the instruction", () => {
  it("decodes a pool and a tier where states/pool.rs and states/config.rs put each field", () => {
    const f = { ammConfig: key(), vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [5n, 6n], fund: [7n, 8n] };
    const p = decodePool("P", poolBytes(f));
    expect(p).toMatchObject({ ...f, decimals0: 9, decimals1: 6 });
    expect(decodeTier("T", tierBytes(VAULT, WORKSHOP))).toMatchObject({ protocolOwner: VAULT, fundOwner: WORKSHOP });
    expect(() => decodePool("P", Buffer.alloc(10).toString("base64"))).toThrow(/637/);
  });

  it("knows a pool by PoolState's tag, sha256('account:PoolState')'s first 8 bytes, and decodes nothing without it", () => {
    expect(Buffer.from(POOL_TAG).toString("hex")).toBe(POOL_TAG_HEX);
    expect(Buffer.from(POOL_TAG)).toEqual(createHash("sha256").update("account:PoolState").digest().subarray(0, 8));
    const d = Buffer.from(poolBytes({ ammConfig: key(), vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM }), "base64");
    d[3] ^= 1;
    expect(() => decodePool("P", d.toString("base64"))).toThrow(/PoolState/);
    expect(() => decodePool("P", Buffer.alloc(POOL_SIZE).toString("base64"))).toThrow(/PoolState/);
  });

  it("sweep_fees carries Anchor's tag, the side, and the 11 accounts of SweepFees in order: each owner's sweep names only that owner's own accounts", () => {
    const pool = decodePool("PooL1111111111111111111111111111111111111111".slice(0, 44), poolBytes({ ammConfig: key(), vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM }));
    pool.address = key();
    const tag = createHash("sha256").update("global:sweep_fees").digest().subarray(0, 8);
    expect(Buffer.from(SWEEP_FEES_TAG)).toEqual(tag);
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], new PublicKey(VENUE_PROGRAM));
    const ata = (owner, mint, program) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, program).toBase58();
    for (const [owner, fund] of [
      [VAULT, false],
      [WORKSHOP, true],
    ]) {
      const ix = sweepFeesIx({ programId: VENUE_PROGRAM, pool, owner, fund });
      // Anchor's borsh: the tag, then the side as one byte (0 the protocol owner's share, 1 the fund owner's).
      expect(Buffer.from(ix.data)).toEqual(Buffer.concat([tag, Buffer.from([fund ? 1 : 0])]));
      expect(ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable])).toEqual([
        [authority.toBase58(), false, false],
        [pool.address, false, true],
        [pool.ammConfig, false, false],
        [pool.vault0, false, true],
        [pool.vault1, false, true],
        [SOL_MINT, false, false],
        [BAYLA, false, false],
        [ata(owner, SOL_MINT, TOKEN_PROGRAM_ID), false, true],
        [ata(owner, BAYLA, TOKEN_2022_PROGRAM_ID), false, true],
        [TOKEN_PROGRAM, false, false],
        [TOKEN_2022_PROGRAM, false, false],
      ]);
    }
    const venue = sweepFeesIx({ programId: VENUE_PROGRAM, pool, owner: VAULT, fund: false });
    expect(venue.keys[7].pubkey).toBe("2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa");
    expect(venue.keys[8].pubkey).toBe("4HUXwHSie4q52eZiazheRqTHCABQZXJ4Yx3GkdBAwavy");
  });

  it("names the accounts in the order the program's SweepFees declares them, and passes the side the program reads", () => {
    const lib = join(here, "../../solana/tegridy-amm/programs/cp-swap/src/lib.rs");
    const order = ["authority", "pool_state", "amm_config", "token_0_vault", "token_1_vault", "vault_0_mint", "vault_1_mint", "owner_token_0_account", "owner_token_1_account", "token_program", "token_program_2022"];
    const src = readFileSync(lib, "utf8");
    const at = src.indexOf("pub struct SweepFees<'info>");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    const fields = [...body.matchAll(/^\s*pub (\w+): /gm)].map((m) => m[1]);
    expect(fields).toEqual(order);
    expect(src.slice(at - 40, at)).toContain("#[instruction(fund: bool)]");
    expect(src).toContain("pub fn sweep_fees(ctx: Context<SweepFees>, fund: bool) -> Result<()>");
  });

  it("worthSweeping weighs one side's own share: SOL, the dollar coins and the island's coins at their prices, any other coin at nothing, and 0.007 SOL stands in when SOL has no price", () => {
    const base = { mint0: SOL_MINT, mint1: BAYLA, decimals0: 9, decimals1: 6 };
    const at = (sol, coins = {}) => ({ sol, island: coins });
    expect(worthSweeping(base, [7_000_000n, 0n], at(72), 0.5)).toBe(true); // 0.007 SOL = $0.504
    expect(worthSweeping(base, [6_000_000n, 0n], at(72), 0.5)).toBe(false); // $0.432
    expect(worthSweeping(base, [1_000_000n, 99_999_999n], at(72), 0.5)).toBe(false); // BAYLA's price unread: it counts nothing
    expect(worthSweeping(base, [1_000_000n, 500_000_000n], at(72, { [BAYLA]: 0.001 }), 0.5)).toBe(true); // $0.072 + 500 BAYLA at $0.001
    expect(worthSweeping(base, [7_000_000n, 0n], at(null), 0.5)).toBe(true);
    expect(worthSweeping(base, [6_999_999n, 0n], at(null), 0.5)).toBe(false);
    expect(worthSweeping({ mint0: USDC_MINT, mint1: BAYLA, decimals0: 6, decimals1: 6 }, [500_000n, 0n], at(null), 0.5)).toBe(true);
    expect(worthSweeping({ mint0: USDT_MINT, mint1: BAYLA, decimals0: 6, decimals1: 6 }, [499_999n, 0n], at(null), 0.5)).toBe(false);
    expect(worthSweeping({ mint0: BRAINLET, mint1: SOY, decimals0: 6, decimals1: 6 }, [0n, 250_000_000n], at(null, { [SOY]: 0.002 }), 0.5)).toBe(true); // 250 SOY at $0.002
    // A coin off the list takes no price, whatever is offered for it.
    const offList = key();
    expect(worthSweeping({ mint0: SOL_MINT, mint1: offList, decimals0: 9, decimals1: 6 }, [0n, 10n ** 18n], at(72, { [offList]: 1 }), 0.5)).toBe(false);
  });

  it("fmt shows any number of decimals a mint may claim (up to 255) without Node's limit of 100", () => {
    expect(fmt(51_216_483n, 9)).toBe("0.051216483");
    expect(fmt(7_000_000_000n, 6)).toBe("7,000");
    expect(fmt(5n, 255)).toBe("0");
    expect(fmt(123_456n, 101)).toBe("0");
  });

  it("the exit code follows the result: 0 only when the run is ok", () => {
    expect(exitCode({ ok: true, pools: [] })).toBe(0);
    expect(exitCode({ ok: false, pools: [] })).toBe(1);
    expect(exitCode(undefined)).toBe(1);
    expect(exitCode({})).toBe(1);
  });

  it("reads a destination's owner, delegate, state, close authority and memo rule where spl-token does, under both token programs", () => {
    for (const [program, programId] of [
      [TOKEN_PROGRAM, TOKEN_PROGRAM_ID],
      [TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM_ID],
    ]) {
      for (let bits = 0; bits < 32; bits++) {
        // A memo entry only a Token-2022 account can hold: on (bit 8) or off (bit 16).
        const memo = program === TOKEN_2022_PROGRAM && bits & 24 ? !!(bits & 8) : null;
        const o = { mint: key(), owner: key(), program, delegate: !!(bits & 1), frozen: !!(bits & 2), closeAuthority: !!(bits & 4), memo };
        const info = tokenAccount(o);
        const want = unpackAccount(new PublicKey(key()), { data: Buffer.from(info.data[0], "base64"), owner: programId, lamports: info.lamports, executable: false }, programId);
        expect([want.mint.toBase58(), want.owner.toBase58()]).toEqual([o.mint, o.owner]);
        expect(destinationState(info, program)).toEqual({
          open: true,
          owner: want.owner.toBase58(),
          delegate: want.delegate !== null,
          frozen: want.isFrozen,
          closeAuthority: want.closeAuthority !== null,
          memo: getMemoTransfer(want)?.requireIncomingTransferMemos ?? false,
        });
      }
      // Owned by anyone but the coin's own token program, it is not open, whatever its bytes say.
      const other = program === TOKEN_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
      expect(destinationState(tokenAccount({ mint: key(), owner: key(), program }), other)).toMatchObject({ open: false });
    }
    expect(destinationState(null, TOKEN_PROGRAM)).toEqual({ open: false, lamports: 0 });
    expect(destinationState(systemAccount(650_240), TOKEN_PROGRAM)).toEqual({ open: false, lamports: 650_240 });
  });

  it("reads a coin's transfer fee as spl-token does: GROYPER's 3% on mainnet, BAYLA none, a classic mint none", () => {
    expect(transferFeeBps(Buffer.from(GROYPER_MINT, "base64"))).toBe(300);
    expect(splTokenBps(GROYPER, GROYPER_MINT)).toBe(300);
    expect(transferFeeBps(Buffer.from(BAYLA_MINT, "base64"))).toBe(0);
    expect(splTokenBps(BAYLA, BAYLA_MINT)).toBe(0);
    expect(transferFeeBps(Buffer.alloc(82))).toBe(0);
    // Only the scheduled setting charges: the higher of the two still counts.
    const d = Buffer.from(GROYPER_MINT, "base64");
    const at = d.indexOf(Buffer.from([1, 0, 108, 0]), 166) + 4;
    d.writeUInt16LE(0, at + 88);
    d.writeUInt16LE(50, at + 106);
    expect(transferFeeBps(d)).toBe(50);
    expect(splTokenBps(GROYPER, d.toString("base64"))).toBe(50);
    // A fee entry cut short is unreadable, not "no fee".
    expect(transferFeeBps(Buffer.from(GROYPER_MINT, "base64").subarray(0, at + 50))).toBe(null);
  });

  it("reads a Token-2022 account's memo rule as spl-token does, wherever its entry sits among the others, and none on a classic account", () => {
    /** A Token-2022 account's bytes: the 165-byte account, its account type (2), then these type/length/value entries. */
    const withEntries = (entries) => {
      const base = Buffer.from(tokenAccountBytes({ mint: key(), owner: key(), program: TOKEN_PROGRAM }), "base64");
      const tlv = entries.map(([type, value]) => {
        const h = Buffer.alloc(4);
        h.writeUInt16LE(type, 0);
        h.writeUInt16LE(value.length, 2);
        return Buffer.concat([h, Buffer.from(value)]);
      });
      return Buffer.concat([base, Buffer.from([2]), ...tlv]);
    };
    const spl = (d) => getMemoTransfer(unpackAccount(new PublicKey(key()), { data: d, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false }, TOKEN_2022_PROGRAM_ID))?.requireIncomingTransferMemos ?? false;
    // ImmutableOwner (7, no value), MemoTransfer (8, one byte), TransferFeeAmount (2, eight bytes), CpiGuard (11, one byte).
    for (const [entries, want] of [
      [[[7, []]], false],
      [[[7, []], [8, [1]]], true],
      [[[7, []], [8, [0]]], false],
      [[[8, [1]], [7, []]], true],
      [[[2, Array(8).fill(0)], [7, []], [8, [1]]], true],
      [[[11, [1]]], false],
      [[[11, [1]], [8, [1]]], true],
      [[[7, []], [8, [255]]], true],
    ]) {
      const d = withEntries(entries);
      expect([memoRequired(d), spl(d)], JSON.stringify(entries)).toEqual([want, want]);
    }
    // A memo entry cut short reads as a rule in force; a classic account, or a mint's bytes, has none.
    expect(memoRequired(withEntries([[7, []], [8, [1]]]).subarray(0, 174))).toBe(true);
    expect(memoRequired(Buffer.from(tokenAccountBytes({ mint: key(), owner: key(), program: TOKEN_PROGRAM }), "base64"))).toBe(false);
    expect(memoRequired(Buffer.from(BAYLA_MINT, "base64"))).toBe(false);
  });

  it("counts a FeesSwept only when the pool program printed it itself, in its own call as the instruction asked about, and decodes it as states/config.rs lays it out", () => {
    const program = key();
    const other = key();
    const e = { pool: key(), fund: true, owner: key(), moved: [5_600_000n, 0n], left: [0n, 84_000_000n] };
    const line = sweptLine(e);
    const decoded = { pool: e.pool, fund: true, owner: e.owner, moved: e.moved, left: e.left };
    // A sweep that opens an account first: its record is printed in the pool program's call, the second instruction.
    const real = [...invoked(ATA_PROGRAM, ["Program log: CreateIdempotent"]), ...invoked(program, ["Program log: Instruction: SweepFees", ...invoked(TOKEN_PROGRAM, ["Program log: Instruction: TransferChecked"], 2), line])];
    expect(feesSwept(real, program, 1)).toEqual([decoded]);
    expect(Buffer.from(FEES_SWEPT_TAG)).toEqual(SWEPT_TAG);
    expect(feesSwept(real, program, 0)).toEqual([]);
    expect(feesSwept(real, other, 1)).toEqual([]);
    // Printed by another program the sweep calls, by the pool program in a deeper call, or by another instruction: not counted.
    expect(feesSwept(invoked(program, ["Program log: Instruction: SweepFees", ...invoked(other, [line], 2)]), program, 0)).toEqual([]);
    expect(feesSwept(invoked(program, ["Program log: Instruction: SweepFees", ...invoked(program, [line], 2)]), program, 0)).toEqual([]);
    expect(feesSwept([...invoked(other, [line]), ...invoked(program, ["Program log: Instruction: SweepFees"])], program, 1)).toEqual([]);
    // After a call it made has returned, a line is the pool program's own again; one after its own call has ended is nobody's.
    expect(feesSwept(invoked(program, [...invoked(other, ["Program log: one"], 2), line]), program, 0)).toEqual([decoded]);
    expect(feesSwept([...invoked(program, []), line], program, 0)).toEqual([]);
    // A call whose result line is missing does not move the record: the runtime's own depth places each call.
    const lost = [`Program ${other} invoke [1]`, `Program ${key()} invoke [2]`, `Program ${other} success`, ...invoked(program, [line])];
    expect(feesSwept(lost, program, 1)).toEqual([decoded]);
    // Two records in its own call are both counted, for the reader to refuse; a line of two parts, another tag or another size is none.
    expect(feesSwept(invoked(program, [line, line]), program, 0)).toEqual([decoded, decoded]);
    const b = sweptBytes(e);
    const tagged = Buffer.from(b);
    tagged[0] ^= 1;
    for (const bad of [`${line} ${line.slice(14)}`, `Program data: ${tagged.toString("base64")}`, `Program data: ${b.subarray(0, 104).toString("base64")}`, `Program data: ${Buffer.concat([b, Buffer.alloc(1)]).toString("base64")}`, `Program log: ${line}`]) {
      expect(feesSwept(invoked(program, [bad]), program, 0), bad).toEqual([]);
    }
    // A side byte that is not 0 or 1 is no bool.
    const side = Buffer.from(b);
    side[40] = 2;
    expect(feesSwept(invoked(program, [`Program data: ${side.toString("base64")}`]), program, 0)).toEqual([]);
  });

  it("a line a program prints that only quotes a call's opening or its result does not place a call: only the runtime's own lines do", () => {
    const program = key();
    const other = key();
    const e = { pool: key(), fund: false, owner: key(), moved: [1n, 2n], left: [0n, 0n] };
    const line = sweptLine(e);
    const decoded = { pool: e.pool, fund: false, owner: e.owner, moved: e.moved, left: e.left };
    // Inside another program's call, a quoted result does not end that call: its record stays its own.
    expect(feesSwept(invoked(program, ["Program log: Instruction: SweepFees", ...invoked(other, [`Program log: Program ${other} success`, line], 2)]), program, 0)).toEqual([]);
    expect(feesSwept(invoked(program, ["Program log: Instruction: SweepFees", ...invoked(other, [`Program log: Program ${other} failed: custom program error: 0x1`, line], 2)]), program, 0)).toEqual([]);
    // A quoted opening does not start a call or count an instruction.
    const quoted = invoked(program, [`Program log: Program ${other} invoke [1]`, line]);
    expect(feesSwept(quoted, program, 0)).toEqual([decoded]);
    expect(feesSwept(quoted, program, 1)).toEqual([]);
    // Nor does it make another program's record the pool program's.
    expect(feesSwept(invoked(other, [`Program log: Program ${program} invoke [1]`, line]), program, 1)).toEqual([]);
  });

  it("reads Anchor's 'no such instruction' from a simulation's error", () => {
    expect(customError({ InstructionError: [2, { Custom: 101 }] }, 2)).toBe(101);
    expect(customError({ InstructionError: [1, { Custom: 101 }] }, 2)).toBe(null);
    expect(customError({ InstructionError: [2, "InvalidAccountData"] }, 2)).toBe(null);
  });

  it("parses its options and refuses a bad one", () => {
    expect(parseArgs([])).toMatchObject({ live: false, program: VENUE_PROGRAM, minUsd: 0.5 });
    expect(parseArgs(["--live", "--min-usd", "2", "--payer", VAULT])).toMatchObject({ live: true, minUsd: 2, payer: VAULT });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--min-usd", "x"])).toThrow(/dollars/);
  });
});

/** An RPC's refusal as the job's transport throws it, carrying the JSON-RPC error a stub server answers with. */
const rpcError = (method, code, message) => Object.assign(new Error(`${method}: ${JSON.stringify({ code, message })}`), { rpcError: { code, message } });
/** A transaction's signature as the RPC names it: the 64 bytes after the wire's signature count. */
const sigOfWire = (b64) => base58(Buffer.from(b64, "base64").subarray(1, 65));
const sigOfTx = (tx) => base58(tx.signatures[0].signature);

/** Anchor's tags, worked out here as the program's own tests do: the sweep's instruction, and its event. */
const SWEEP_TAG = createHash("sha256").update("global:sweep_fees").digest().subarray(0, 8);
const SWEPT_TAG = createHash("sha256").update("event:FeesSwept").digest().subarray(0, 8);
/** A FeesSwept record's bytes, as states/config.rs lays it out: the tag, the pool, the side, the owner, then what moved of each coin and what was left. */
function sweptBytes({ pool, fund, owner, moved, left }) {
  const d = Buffer.alloc(8 + 32 + 1 + 32 + 4 * 8);
  SWEPT_TAG.copy(d, 0);
  new PublicKey(pool).toBuffer().copy(d, 8);
  d[40] = fund ? 1 : 0;
  new PublicKey(owner).toBuffer().copy(d, 41);
  [...moved, ...left].forEach((x, i) => d.writeBigUInt64LE(x, 73 + 8 * i));
  return d;
}
const sweptLine = (e) => `Program data: ${sweptBytes(e).toString("base64")}`;
/** One call's log lines as the runtime writes them, at `depth`, with `inner` printed inside it. */
const invoked = (program, inner = [], depth = 1) => [`Program ${program} invoke [${depth}]`, ...inner, `Program ${program} consumed 25553 of 200000 compute units`, `Program ${program} success`];

/**
 * A fake chain: the pools, tiers and accounts given, and what each call returns. getProgramAccounts
 * honours the filters it is sent, as the RPC does (`honourFilters: false` plays one that ignores
 * them), and getMultipleAccounts serves a pool by its address as `pools` holds it at that moment
 * (a test changes an entry to play a pool swept or collected since the listing). `simErr(tx)`
 * answers each simulation from the transaction itself (web3.js's reading of it), and a simulation
 * asked for accounts gets each back holding `rent` lamports, as an opened account would
 * (`rentOf(address)` gives each its own; none with `simAccounts: false`). A send lands and is
 * answered with its own signature; one already landed is refused as a node's preflight refuses it;
 * only a landed one has a status, from `statuses`. A landed one's transaction is kept with the log
 * lines the program prints, its FeesSwept inside its own call, worked out as sweep_pool_fees works
 * when it lands: a coin whose pool account or destination is frozen then is left, the other moves.
 * `txAnswer(signature, tx)` may answer getTransaction otherwise. `fail(method, params)` may return
 * an error for that call to throw instead (a send it fails never lands).
 */
function fakeChain({
  pools,
  tiers,
  accounts = {},
  mints = { [BAYLA]: BAYLA_MINT, [GROYPER]: GROYPER_MINT },
  simErr = () => null,
  simLogs = [],
  simAccounts = true,
  statuses = [{ confirmationStatus: "confirmed", err: null }],
  fail = () => null,
  honourFilters = true,
  rent = 1_488_440,
  rentOf = null,
  balance = 987_654_321,
  blockHeight = 10,
  txAnswer = null,
}) {
  const calls = [];
  let s = 0;
  const landed = new Set();
  const made = new Map();
  /** What a sweep instruction moves and leaves with the chain as it stands, read from the bytes as poolBytes and tierBytes lay them out. */
  const sweepOf = (ix) => {
    const k = ix.keys.map((x) => x.pubkey.toBase58());
    const p = Buffer.from(pools.find(([a]) => a === k[1])[1], "base64");
    const t = Buffer.from(tiers[k[2]], "base64");
    const fund = ix.data[8] === 1;
    const owed = fund ? [p.readBigUInt64LE(357), p.readBigUInt64LE(365)] : [p.readBigUInt64LE(341), p.readBigUInt64LE(349)];
    const frozen = (a) => !!accounts[a] && Buffer.from(accounts[a].data[0], "base64")[108] === 2;
    const left = owed.map((x, i) => (frozen(k[3 + i]) || frozen(k[7 + i]) ? x : 0n));
    const programs = [232, 264].map((o) => new PublicKey(p.subarray(o, o + 32)).toBase58());
    return { pool: k[1], fund, owner: new PublicKey(t.subarray(fund ? 76 : 44, fund ? 108 : 76)).toBase58(), moved: owed.map((x, i) => x - left[i]), left, programs };
  };
  /** A landed transaction's log lines: each instruction in its own call, a sweep's transfers inside it and then its FeesSwept. */
  const logsOf = (tx) =>
    tx.instructions.flatMap((ix) => {
      const program = ix.programId.toBase58();
      if (!(ix.data.length === 9 && Buffer.from(ix.data.subarray(0, 8)).equals(SWEEP_TAG))) return invoked(program, ["Program log: CreateIdempotent"]);
      const e = sweepOf(ix);
      const transfers = e.moved.flatMap((x, i) => (x > 0n ? invoked(e.programs[i], ["Program log: Instruction: TransferChecked"], 2) : []));
      return invoked(program, ["Program log: Instruction: SweepFees", ...transfers, sweptLine(e)]);
    });
  const passes = (data, filters) => {
    const d = Buffer.from(data, "base64");
    return filters.every((f) => {
      if (f.dataSize !== undefined) return d.length === f.dataSize;
      const want = unbase58(f.memcmp.bytes);
      return d.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
    });
  };
  const call = async (method, params) => {
    calls.push({ method, params });
    const e = fail(method, params);
    if (e) throw e;
    if (method === "getProgramAccounts") {
      const filters = params[1]?.filters ?? [];
      return pools.filter(([, data]) => !honourFilters || passes(data, filters)).map(([pubkey, data]) => ({ pubkey, account: { data: [data, "base64"] } }));
    }
    if (method === "getMultipleAccounts") {
      const pool = (k) => pools.find(([p]) => p === k);
      return {
        value: params[0].map((k) =>
          mints[k]
            ? { owner: TOKEN_2022_PROGRAM, lamports: 1, data: [mints[k], "base64"] }
            : tiers[k]
              ? { owner: VENUE_PROGRAM, lamports: 1, data: [tiers[k], "base64"] }
              : pool(k)
                ? { owner: VENUE_PROGRAM, lamports: 1, data: [pool(k)[1], "base64"] }
                : (accounts[k] ?? null)
        ),
      };
    }
    if (method === "getLatestBlockhash") return { value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } };
    if (method === "simulateTransaction") {
      const tx = Transaction.from(Buffer.from(params[0], "base64"));
      const asked = params[1]?.accounts?.addresses;
      return { value: { err: simErr(tx), logs: simLogs, unitsConsumed: 61234, accounts: asked && simAccounts ? asked.map((a) => ({ owner: TOKEN_PROGRAM, lamports: rentOf ? rentOf(a) : rent, data: ["", "base64"] })) : null } };
    }
    if (method === "sendTransaction") {
      const sig = sigOfWire(params[0]);
      if (landed.has(sig)) throw rpcError(method, -32002, "Transaction simulation failed: This transaction has already been processed");
      landed.add(sig);
      const tx = Transaction.from(Buffer.from(params[0], "base64"));
      made.set(sig, { slot: 7, blockTime: 1_763_700_000, version: "legacy", transaction: { signatures: [sig] }, meta: { err: null, fee: 5000, logMessages: logsOf(tx) } });
      return sig;
    }
    if (method === "getTransaction") {
      const tx = made.get(params[0]) ?? null;
      return txAnswer ? txAnswer(params[0], tx) : tx;
    }
    if (method === "getSignatureStatuses") return { value: params[0].map((sig) => (landed.has(sig) ? statuses[Math.min(s++, statuses.length - 1)] : null)) };
    if (method === "getBlockHeight") return blockHeight;
    // Mainnet's rent today: 5,080 lamports a byte, the 128-byte account header included.
    if (method === "getMinimumBalanceForRentExemption") return (128 + params[0]) * 5080;
    if (method === "getBalance") return { context: { slot: 1 }, value: balance };
    throw new Error(`unexpected ${method}`);
  };
  /** Each transaction simulated, as web3.js reads it. */
  const simulated = () => calls.filter((c) => c.method === "simulateTransaction").map((c) => Transaction.from(Buffer.from(c.params[0], "base64")));
  /** Each transaction sent, as web3.js reads it. */
  const sentTxs = () => calls.filter((c) => c.method === "sendTransaction").map((c) => Transaction.from(Buffer.from(c.params[0], "base64")));
  return { call, calls, simulated, sentTxs };
}
/** The side a sweep_fees instruction names (its data's last byte): "venue" or "island". */
const sideOf = (ix) => (ix.data[8] === 1 ? "island" : "venue");
const sweepsIn = (tx) => tx.instructions.filter((i) => i.programId.toBase58() === VENUE_PROGRAM);
const noPrice = async () => ({ json: async () => ({}) });
/** Prices as the job reads them: SOL from Coinbase, the island coins from Jupiter's price API (`island`: mint -> usd). */
const priced = (sol, coins = {}, seen = []) =>
  async (url, init) => {
    seen.push({ url, init });
    if (url.startsWith("https://api.coinbase.com/")) return { ok: true, json: async () => (sol == null ? {} : { data: { amount: String(sol) } }) };
    if (/jup\.ag\/price\/v3/.test(url)) return { ok: true, status: 200, json: async () => Object.fromEntries(Object.entries(coins).map(([m, usd]) => [m, { usdPrice: usd }])) };
    throw new Error(`unexpected fetch ${url}`);
  };
const quiet = () => {};
const live = (kp) => ({ VENUE_SWEEPER_KEYPAIR: JSON.stringify([...kp.secretKey]) });

describe("venue-sweep: a run", () => {
  const tierKey = key();
  const vault0 = key();
  const vault1 = key();
  const big = [key(), poolBytes({ ammConfig: tierKey, vault0, vault1, mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 7_000_000_000n], fund: [23_051_592n, 3_683_000_000n] })];
  const dust = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [10_000n, 1n], fund: [5_000n, 1n] })];
  const empty = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM })];
  const tiers = { [tierKey]: tierBytes(VAULT, WORKSHOP) };
  const payer = key();
  const workshopAccounts = [associatedTokenAddress(WORKSHOP, SOL_MINT, TOKEN_PROGRAM), associatedTokenAddress(WORKSHOP, BAYLA, TOKEN_2022_PROGRAM)];
  const vaultAccounts = [associatedTokenAddress(VAULT, SOL_MINT, TOKEN_PROGRAM), associatedTokenAddress(VAULT, BAYLA, TOKEN_2022_PROGRAM)];
  /** What each side's whole sweep of `big` moves, as its own FeesSwept says. */
  const BIG_VENUE = `0.051216483 of ${SOL_MINT} and 7,000 of ${BAYLA}`;
  const BIG_ISLAND = `0.023051592 of ${SOL_MINT} and 3,683 of ${BAYLA}`;

  it("a dry run simulates the venue's share and the island's in two transactions, opens only the vault's missing accounts, and sends nothing", async () => {
    const chain = fakeChain({ pools: [big, dust, empty], tiers, accounts: opened(WORKSHOP) });
    const res = await run({ ...parseArgs(["--payer", payer]) }, { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(chain.calls.some((c) => c.method === "sendTransaction")).toBe(false);
    expect(res.ok).toBe(true);
    const row = res.pools.find((r) => r.pool === big[0]);
    expect(row.venue.result).toMatch(/simulated clean/);
    expect(row.island.result).toMatch(/simulated clean/);
    expect(row.created).toBe(2); // the vault's wSOL and BAYLA accounts; the Workshop's exist
    expect(res.pools.find((r) => r.pool === dust[0]).note).toMatch(/under the/);
    expect(res.pools.find((r) => r.pool === empty[0]).note).toBe("nothing set aside");
    const [venueTx, islandTx] = chain.simulated();
    expect(venueTx.instructions.map((i) => i.programId.toBase58())).toEqual([ATA_PROGRAM, ATA_PROGRAM, VENUE_PROGRAM]);
    expect(venueTx.instructions.slice(0, 2).map((i) => [i.keys[1].pubkey.toBase58(), i.keys[2].pubkey.toBase58()])).toEqual(vaultAccounts.map((a) => [a, VAULT]));
    expect(sweepsIn(venueTx).map(sideOf)).toEqual(["venue"]);
    expect(sweepsIn(venueTx)[0].keys.slice(7, 9).map((k) => k.pubkey.toBase58())).toEqual(vaultAccounts);
    expect(islandTx.instructions.map((i) => i.programId.toBase58())).toEqual([VENUE_PROGRAM]);
    expect(sweepsIn(islandTx).map(sideOf)).toEqual(["island"]);
    expect(sweepsIn(islandTx)[0].keys.slice(7, 9).map((k) => k.pubkey.toBase58())).toEqual(workshopAccounts);
    expect(chain.calls.find((c) => c.method === "simulateTransaction").params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
    expect(summary(res, { live: false })).toContain(big[0]);
  });

  it("the job never opens the Workshop's accounts: the island's share waits until it holds both, the summary names the missing one, and the venue's is still swept", async () => {
    const chain = fakeChain({ pools: [big], tiers, accounts: { ...opened(VAULT), ...accountsOf(WORKSHOP, [SOL_BAYLA[0]]) } });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const txs = chain.simulated();
    for (const tx of txs) {
      for (const ix of tx.instructions.filter((i) => i.programId.toBase58() === ATA_PROGRAM)) expect(ix.keys[2].pubkey.toBase58()).not.toBe(WORKSHOP);
    }
    expect(txs.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    expect(res.ok).toBe(true);
    const [row] = res.pools;
    expect(row.venue.result).toMatch(/simulated clean/);
    expect(row.created).toBe(0);
    expect(row.island.result).toMatch(new RegExp(`waits: the Workshop has no account yet for ${BAYLA}`));
    expect(row.missing).toEqual([{ mint: BAYLA, address: workshopAccounts[1] }]);
    expect(summary(res, { live: false })).toContain(`${BAYLA} (\`${workshopAccounts[1]}\`)`);
  });

  for (const [none, some] of [
    ["venue", "island"],
    ["island", "venue"],
  ]) {
    it(`a side with nothing set aside costs nothing: with the ${none}'s share at zero, only the ${some}'s sweep is sent and no account is opened for the ${none}`, async () => {
      const shares = { protocol: [51_216_483n, 7_000_000_000n], fund: [23_051_592n, 3_683_000_000n], [none === "venue" ? "protocol" : "fund"]: [0n, 0n] };
      const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, ...shares })];
      // The vault holds no account for these coins, and the Workshop holds both only where its share is owed.
      const chain = fakeChain({ pools: [pool], tiers, accounts: none === "venue" ? opened(WORKSHOP) : {} });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([[some]]);
      const opens = chain.simulated().flatMap((tx) => tx.instructions.filter((i) => i.programId.toBase58() === ATA_PROGRAM));
      expect(opens.map((i) => i.keys[2].pubkey.toBase58())).toEqual(none === "venue" ? [] : [VAULT, VAULT]);
      expect(res.ok).toBe(true);
      expect(res.pools[0]).toMatchObject({ created: none === "venue" ? 0 : 2, [none]: { result: "nothing set aside" }, [some]: { result: expect.stringMatching(/simulated clean/) } });
      expect(res.pools[0].missing).toBeUndefined();
    });
  }

  for (const [refused, still] of [
    ["venue", "island"],
    ["island", "venue"],
  ]) {
    it(`a refusal of the ${refused}'s sweep does not stop the ${still}'s: each is its own transaction, and the run fails`, async () => {
      // 6008 (InvalidVault): a refusal no account setting of either owner makes.
      const chain = fakeChain({
        pools: [big],
        tiers,
        accounts: opened(VAULT, WORKSHOP),
        simErr: (tx) => (sweepsIn(tx).some((ix) => sideOf(ix) === refused) ? { InstructionError: [0, { Custom: 6008 }] } : null),
      });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
      expect(res.ok).toBe(false);
      expect(res.pools[0][refused].result).toMatch(/the simulation refused it/);
      expect(res.pools[0][still].result).toMatch(/simulated clean/);
    });
  }

  it("a pool holding a coin with a transfer fee is held back and named, never simulated or sent; the run still passes", async () => {
    const groyper = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: GROYPER, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 7_000_000_000n], fund: [23_051_592n, 3_683_000_000n] })];
    const chain = fakeChain({ pools: [groyper], tiers });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(true);
    expect(res.pools[0].note).toMatch(new RegExp(`held back: ${GROYPER} takes 3% of every transfer`));
    expect(chain.calls.some((c) => c.method === "simulateTransaction" || c.method === "sendTransaction")).toBe(false);
    expect(summary(res, { live: false })).toContain(groyper[0]);
  });

  it("a coin whose transfer fee cannot be read is held back too, and fails the run", async () => {
    const chain = fakeChain({ pools: [big], tiers, mints: {} });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(false);
    expect(res.pools[0].note).toMatch(new RegExp(`held back: the transfer fee of ${BAYLA} could not be read`));
    expect(chain.calls.some((c) => c.method === "simulateTransaction")).toBe(false);
  });

  it("in a dry run before the program is upgraded, the simulation's 'no such instruction' is said and is not a failure", async () => {
    // The vault's accounts do not exist yet, so two CreateIdempotent come first and its sweep is the third.
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(WORKSHOP),
      simErr: (tx) => ({ InstructionError: [tx.instructions.length - 1, { Custom: 101 }] }),
    });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated().map((tx) => tx.instructions.length)).toEqual([3, 1]);
    expect(res).toMatchObject({ ok: true, notUpgraded: true });
    expect(res.pools[0].venue.result).toMatch(/not upgraded/);
    expect(res.pools[0].island.result).toMatch(/not upgraded/);
  });

  it("any other refusal is a failure, and nothing is sent", async () => {
    const chain = fakeChain({ pools: [big], tiers, simErr: () => ({ InstructionError: [2, { Custom: 6018 }] }) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(false);
    expect(chain.calls.some((c) => c.method === "sendTransaction")).toBe(false);
  });

  // A dry run returns before any send whatever it makes of a refusal, so these two hold the live path.
  it("in a live run too, a refused simulation is a failure and nothing is sent", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      simErr: (tx) => ({ InstructionError: [tx.instructions.length - 1, { Custom: 6008 }] }),
    });
    const env = { VENUE_SWEEPER_KEYPAIR: JSON.stringify([...kp.secretKey]) };
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env, log: quiet, wait: async () => {} });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(chain.calls.some((c) => c.method === "sendTransaction")).toBe(false);
    expect(res.ok).toBe(false);
    for (const side of ["venue", "island"]) expect(res.pools[0][side].result).toMatch(/the simulation refused it/);
  });

  it("in a live run, a program with no sweep yet is said for both sides, nothing is sent, and the run fails", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      simErr: (tx) => ({ InstructionError: [tx.instructions.length - 1, { Custom: 101 }] }),
    });
    const env = { VENUE_SWEEPER_KEYPAIR: JSON.stringify([...kp.secretKey]) };
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env, log: quiet, wait: async () => {} });
    expect(chain.calls.some((c) => c.method === "sendTransaction")).toBe(false);
    expect(res.notUpgraded).toBe(true);
    for (const side of ["venue", "island"]) expect(res.pools[0][side].result).toMatch(/not upgraded/);
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
  });

  it("on mainnet, a tier that names anyone but the vault and the Workshop is not swept and fails the run", async () => {
    const other = key();
    const chain = fakeChain({ pools: [big], tiers: { [tierKey]: tierBytes(other, WORKSHOP) } });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(false);
    expect(res.pools[0].note).toMatch(/not the vault and the Workshop/);
    expect(chain.calls.some((c) => c.method === "simulateTransaction")).toBe(false);
  });

  it("a live run signs with the sweeper's key, sends each owner's sweep on its own, and waits until the chain confirms each", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const env = { VENUE_SWEEPER_KEYPAIR: JSON.stringify([...kp.secretKey]) };
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env, log: quiet, wait: async () => {} });
    const sent = chain.calls.filter((c) => c.method === "sendTransaction").map((c) => Transaction.from(Buffer.from(c.params[0], "base64")));
    expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(res.ok).toBe(true);
    expect(res.pools[0]).toMatchObject({ created: 0, venue: { swept: true, signature: sigOfTx(sent[0]) }, island: { swept: true, signature: sigOfTx(sent[1]) } });
    for (const tx of sent) {
      expect(tx.verifySignatures()).toBe(true);
      expect(tx.feePayer.toBase58()).toBe(kp.publicKey.toBase58());
      expect(tx.instructions.map((i) => i.programId.toBase58())).toEqual([VENUE_PROGRAM]);
    }
    const p = decodePool(big[0], big[1]);
    expect([...destinations(p, VAULT), ...destinations(p, WORKSHOP)]).toEqual([...vaultAccounts, ...workshopAccounts]);
  });

  it("a live run needs the key, and a dry run needs a payer: each is refused before any call", async () => {
    const chain = fakeChain({ pools: [], tiers });
    await expect(run(parseArgs(["--live"]), { call: chain.call, env: {}, log: quiet })).rejects.toThrow(/^--live needs VENUE_SWEEPER_KEYPAIR$/);
    await expect(run(parseArgs(["--live", "--payer", payer]), { call: chain.call, env: {}, log: quiet })).rejects.toThrow(/^--live needs VENUE_SWEEPER_KEYPAIR$/);
    await expect(run(parseArgs([]), { call: chain.call, env: {}, log: quiet })).rejects.toThrow(/^a dry run needs --payer <address> or VENUE_SWEEPER_KEYPAIR$/);
    expect(chain.calls).toEqual([]);
  });

  it("on mainnet, a listing of no pool at all fails the run: it is a wrong answer, not a quiet day", async () => {
    const chain = fakeChain({ pools: [], tiers });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res).toMatchObject({ ok: false, listed: false, pools: [] });
    expect(res.stopped).toBe("the pools could not be read: the RPC listed no pool, and mainnet's program has pools");
    expect(summary(res, { live: false })).toContain("; the pools were not listed.");
    // On a test chain, none is a quiet day.
    const test = fakeChain({ pools: [], tiers });
    expect((await run(parseArgs(["--payer", payer, "--program", key()]), { call: test.call, fetchImpl: noPrice, env: {}, log: quiet })).ok).toBe(true);
  });

  // ── Only real pools are listed ─────────────────────────────────────────────
  const tagless = () => [key(), Buffer.alloc(POOL_SIZE).toString("base64")];

  it("lists only real pools: the RPC is asked for PoolState's tag as well as its size", async () => {
    const other = tagless();
    const chain = fakeChain({ pools: [other, big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const [listing] = chain.calls.filter((c) => c.method === "getProgramAccounts");
    expect(listing.params[1].filters).toEqual([{ dataSize: POOL_SIZE }, { memcmp: { offset: 0, bytes: base58(Buffer.from(POOL_TAG_HEX, "hex")) } }]);
    expect(res.pools.map((r) => r.pool)).toEqual([big[0]]);
    expect(res.ok).toBe(true);
  });

  it("an account that will not decode fails only its own row, and the run; the other pools are still swept", async () => {
    const other = tagless();
    // An RPC that ignores the filters hands back the account without the tag as well.
    const chain = fakeChain({ pools: [other, big], tiers, accounts: opened(VAULT, WORKSHOP), honourFilters: false });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const row = (p) => res.pools.find((r) => r.pool === p[0]);
    expect(row(other).error).toMatch(/PoolState/);
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(row(big).venue.result).toMatch(/simulated clean/);
    expect(row(big).island.result).toMatch(/simulated clean/);
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
    expect(summary(res, { live: false })).toContain(other[0]);
  });

  it("a fee tier that will not decode fails only its own pools, and the run; the other pools are still swept", async () => {
    const badTier = key();
    const onBadTier = [key(), poolBytes({ ammConfig: badTier, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n] })];
    const chain = fakeChain({ pools: [onBadTier, big], tiers: { ...tiers, [badTier]: Buffer.alloc(21).toString("base64") }, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const row = (p) => res.pools.find((r) => r.pool === p[0]);
    expect(row(onBadTier).note).toMatch(new RegExp(`its fee tier ${badTier} could not be read: .*21 bytes`));
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(row(big).venue.result).toMatch(/simulated clean/);
    expect(row(big).island.result).toMatch(/simulated clean/);
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
    expect(summary(res, { live: false })).toContain(onBadTier[0]);
  });

  it("on a test chain (another --program), the tier's own owners are swept by that program; the mainnet owner check is not made", async () => {
    const program = key();
    const [protocolOwner, fundOwner] = [key(), key()];
    const testTier = key();
    const pool = [key(), poolBytes({ ammConfig: testTier, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n], fund: [23_051_592n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers: { [testTier]: tierBytes(protocolOwner, fundOwner) }, accounts: opened(protocolOwner, fundOwner) });
    const res = await run(parseArgs(["--payer", payer, "--program", program]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const p = decodePool(pool[0], pool[1]);
    const sweeps = chain.simulated().map((tx) => tx.instructions.at(-1));
    expect(sweeps.map((ix) => ix.programId.toBase58())).toEqual([program, program]);
    expect(sweeps.map((ix) => ix.keys.slice(7, 9).map((k) => k.pubkey.toBase58()))).toEqual([destinations(p, protocolOwner), destinations(p, fundOwner)]);
    expect(res.pools[0].venue.result).toMatch(/simulated clean/);
    expect(res.pools[0].island.result).toMatch(/simulated clean/);
    expect(res.ok).toBe(true);
  });

  it("a listing the RPC refuses fails the run without throwing, and the summary says the pools were not listed and the balance was not read", async () => {
    const chain = fakeChain({ pools: [big], tiers, fail: (m) => (m === "getProgramAccounts" ? rpcError("getProgramAccounts", -32010, "excluded from account secondary indexes") : null) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res).toMatchObject({ ok: false, pools: [] });
    expect(res.stopped).toMatch(/^the pools could not be read: getProgramAccounts: .*secondary indexes/);
    expect(chain.calls.map((c) => c.method)).toEqual(["getProgramAccounts"]);
    const text = summary(res, { live: false });
    expect(text).toContain("); the pools were not listed.");
    expect(text).toContain(`The balance of \`${payer}\` was not read.`);
    expect(text).not.toContain("not looked at");
  });

  it("a failed read of the pools' coins fails the run before anything is simulated", async () => {
    const chain = fakeChain({ pools: [big], tiers, fail: (m, p) => (m === "getMultipleAccounts" && p[0].includes(BAYLA) ? rpcError("getMultipleAccounts", -32603, "Internal error") : null) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(false);
    expect(res.stopped).toMatch(/^the pools could not be read: getMultipleAccounts: .*Internal error/);
    expect(chain.calls.some((c) => c.method === "simulateTransaction")).toBe(false);
    expect(summary(res, { live: false })).toContain("1 pool not looked at");
  });

  // ── Errors stay on their row ───────────────────────────────────────────────
  const dollarPool = (mint) => [
    key(),
    poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: mint, mint1: SOL_MINT, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 9, protocol: [2_000_000n, 30_000_000n], fund: [1_000_000n, 15_000_000n] }),
  ];
  const DOLLAR_SOL = (mint) => [
    [mint, TOKEN_PROGRAM],
    [SOL_MINT, TOKEN_PROGRAM],
  ];

  it("an RPC error in one pool stays on that pool's row: the run goes on, fails, and the summary names it", async () => {
    const usdc = dollarPool(USDC_MINT);
    const chain = fakeChain({
      pools: [big, usdc],
      tiers,
      accounts: { ...opened(VAULT, WORKSHOP), ...accountsOf(VAULT, DOLLAR_SOL(USDC_MINT)), ...accountsOf(WORKSHOP, DOLLAR_SOL(USDC_MINT)) },
      fail: (m, p) => (m === "getMultipleAccounts" && p[0].includes(vaultAccounts[1]) ? new Error('getMultipleAccounts: {"code":-32005,"message":"Node is behind by 200 slots"}') : null),
    });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(false);
    expect(res.pools.find((r) => r.pool === big[0]).error).toMatch(/Node is behind/);
    const next = res.pools.find((r) => r.pool === usdc[0]);
    expect(next.venue.result).toMatch(/simulated clean/);
    expect(next.island.result).toMatch(/simulated clean/);
    expect(summary(res, { live: false })).toMatch(/Node is behind/);
  });

  it("a send the RPC refuses stays on that side's row with its signature, after the chain is asked about it; the other side is still sent", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      fail: (m, p) =>
        m === "sendTransaction" && sweepsIn(Transaction.from(Buffer.from(p[0], "base64"))).some((ix) => sideOf(ix) === "venue")
          ? rpcError("sendTransaction", -32002, "Transaction simulation failed: Blockhash not found")
          : null,
    });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    const [venueTx, islandTx] = chain.sentTxs();
    expect(res.ok).toBe(false);
    // Its blockhash has not expired (the chain's height is 10 of 1,000), so the 40 looks run out first.
    expect(res.pools[0].venue).toMatchObject({
      ok: false,
      signature: sigOfTx(venueTx),
      result: expect.stringMatching(/^its send answered an error \(.*Blockhash not found.*\), and it was not confirmed after 40 looks, though its blockhash had not expired at the last one: look its signature up$/),
    });
    expect(chain.calls.filter((c) => c.method === "getSignatureStatuses" && c.params[0][0] === sigOfTx(venueTx)).length).toBe(40);
    expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, signature: sigOfTx(islandTx) });
  });

  it("a send whose answer is lost is looked up on chain: the transport's repeat is told it was already processed, and the row says swept, with its signature", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    let sends = 0;
    // The job's real transport. The venue's send reaches the chain, and its answer is lost on the way back.
    const net = async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      let result;
      try {
        result = await chain.call(method, params);
      } catch (e) {
        if (e.rpcError) return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: e.rpcError }) };
        throw e;
      }
      if (method === "sendTransaction" && sends++ === 0) throw new Error("socket hang up");
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    };
    const call = solanaRpc({ fetchImpl: net, url: "http://rpc.invalid", pauseMs: 0, wait: async () => {} });
    const logged = [];
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: (l) => logged.push(l), wait: async () => {} });
    const sent = chain.sentTxs();
    expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["venue"], ["island"]]); // the venue's twice: the transport repeated it
    const sig = sigOfTx(sent[0]);
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, signature: sig, result: expect.stringMatching(/\(its send answered: sendTransaction: .*already been processed/) });
    expect(res.pools[0].venue.result.startsWith(`swept ${BIG_VENUE} (its send answered: `)).toBe(true);
    expect(logged.some((l) => l.includes(sig))).toBe(true);
    expect(res.ok).toBe(true);
    expect(summary(res, { live: true })).toContain("2 sweeps seen on chain (10,000 lamports of network fees)");
  });

  it("a send that answers an error and is never seen on chain fails its row, which keeps its signature, and costs no fee", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      fail: (m) => (m === "sendTransaction" ? rpcError("sendTransaction", -32002, "Transaction simulation failed: This transaction has already been processed") : null),
    });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    const sent = chain.sentTxs();
    for (const [i, side] of [
      [0, "venue"],
      [1, "island"],
    ]) {
      expect(res.pools[0][side]).toMatchObject({ ok: false, signature: sigOfTx(sent[i]), result: expect.stringMatching(/^its send answered an error \(.*already been processed.*\), and it was not confirmed after 40 looks/) });
    }
    expect(res.ok).toBe(false);
    expect(res.paid.sweeps).toBe(0);
    expect(summary(res, { live: true })).toContain("0 sweeps seen on chain (0 lamports of network fees)");
  });

  it("a send that answers an error, never seen on chain once its blockhash has expired, is said as failed and costs no fee", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      blockHeight: 1001,
      fail: (m) => (m === "sendTransaction" ? rpcError("sendTransaction", -32002, "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.") : null),
    });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    for (const side of ["venue", "island"]) {
      expect(res.pools[0][side].result).toMatch(/^sending failed \(sendTransaction: .*no record of a prior credit.*\), and it was not seen on chain before its blockhash expired$/);
    }
    expect(chain.calls.filter((c) => c.method === "getSignatureStatuses").length).toBe(2);
    expect(res.paid.sweeps).toBe(0);
    expect(res.ok).toBe(false);
  });

  it("an error reading a sent sweep's status is written with its signature, and the run goes on", async () => {
    const kp = Keypair.generate();
    let reads = 0;
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      fail: (m) => (m === "getSignatureStatuses" && reads++ === 0 ? new Error('getSignatureStatuses: {"code":-32603,"message":"Internal error"}') : null),
    });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    const [venueTx, islandTx] = chain.sentTxs();
    expect(res.ok).toBe(false);
    expect(res.pools[0].venue).toMatchObject({ ok: false, signature: sigOfTx(venueTx), result: expect.stringMatching(/sent, but its status could not be read: .*Internal error/) });
    expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, signature: sigOfTx(islandTx) });
    expect(summary(res, { live: true })).toContain(`\`${sigOfTx(venueTx)}\``);
  });

  it("a transport that has used all its retries ends the run early, and the summary is still written", async () => {
    const usdc = dollarPool(USDC_MINT);
    const chain = fakeChain({ pools: [big, usdc], tiers, accounts: opened(VAULT, WORKSHOP) });
    let tries = 0;
    // The job's real transport, on a network where one call never gets an answer.
    const net = async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method === "getLatestBlockhash") {
        tries++;
        throw new Error("socket hang up");
      }
      const result = await chain.call(method, params);
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    };
    const call = solanaRpc({ fetchImpl: net, url: "http://rpc.invalid", pauseMs: 0, wait: async () => {} });
    const res = await run(parseArgs(["--payer", payer]), { call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(false);
    expect(res.stopped).toMatch(/getLatestBlockhash: no answer after 8 tries \(socket hang up\)/);
    expect(tries).toBe(8);
    expect(res.pools.map((r) => r.pool)).toEqual([big[0]]);
    expect(res.pools[0].venue.result).toMatch(/no answer after 8 tries/);
    expect(res.pools[0].island.result).toMatch(/not tried: the run stopped early/);
    expect(res.unvisited).toBe(1);
    expect(chain.calls.some((c) => c.method === "getBalance")).toBe(false);
    const text = summary(res, { live: false });
    expect(text).toMatch(/The run stopped early \(getLatestBlockhash: no answer after 8 tries/);
    expect(text).toContain("1 pool not looked at");
  });

  for (const [n, where] of [
    [1, "between one pool's two sides"],
    [2, "between two pools"],
  ]) {
    it(`the run stops itself at its ${RUN_LIMIT_MS / 60_000}-minute limit, reached ${where}: the rest is counted as not looked at, and the summary is still written`, async () => {
      const more = () => [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n], fund: [23_051_592n, 0n] })];
      const chain = fakeChain({ pools: [big, more(), more()], tiers, accounts: opened(VAULT, WORKSHOP) });
      let t = 0;
      let sims = 0;
      // The n-th simulation answers past the limit.
      const call = async (method, params) => {
        const r = await chain.call(method, params);
        if (method === "simulateTransaction" && ++sims === n) t = RUN_LIMIT_MS + 1;
        return r;
      };
      const res = await run(parseArgs(["--payer", payer]), { call, fetchImpl: noPrice, env: {}, log: quiet, now: () => t });
      expect(res.ok).toBe(false);
      expect(res.stopped).toBe(`it reached its ${RUN_LIMIT_MS / 60_000}-minute limit`);
      expect(res.pools.map((r) => r.pool)).toEqual([big[0]]);
      expect(res.pools[0].venue.result).toMatch(/simulated clean/);
      expect(res.pools[0].island.result).toMatch(n === 1 ? /^not tried: the run stopped early$/ : /simulated clean/);
      expect(res.unvisited).toBe(2);
      expect(chain.calls.filter((c) => c.method === "simulateTransaction").length).toBe(n);
      expect(chain.calls.some((c) => c.method === "getBalance")).toBe(false);
      expect(summary(res, { live: false })).toContain(`The run stopped early (it reached its ${RUN_LIMIT_MS / 60_000}-minute limit); 2 pools not looked at.`);
    });
  }

  it("a live sweep whose simulation answers past the limit is not sent, and no sending is logged", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    let t = 0;
    const call = async (method, params) => {
      const r = await chain.call(method, params);
      if (method === "simulateTransaction") t = RUN_LIMIT_MS + 1;
      return r;
    };
    const logged = [];
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: (l) => logged.push(l), wait: async () => {}, now: () => t });
    expect(res.pools[0].venue).toEqual({ share: expect.any(String), ok: false, result: "not sent: the run stopped early" });
    expect(res.pools[0].island.result).toBe("not tried: the run stopped early");
    expect(chain.calls.some((c) => c.method === "sendTransaction")).toBe(false);
    expect(logged.some((l) => l.startsWith("sending"))).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("a send that gets no answer after all its tries is written with its signature, the chain is not asked about it, and the run stops", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    // The job's real transport, on a network where a send is never answered.
    const net = async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method === "sendTransaction") throw new Error("socket hang up");
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: await chain.call(method, params) }) };
    };
    const call = solanaRpc({ fetchImpl: net, url: "http://rpc.invalid", pauseMs: 0, wait: async () => {} });
    const logged = [];
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: (l) => logged.push(l), wait: async () => {} });
    const line = logged.find((l) => l.startsWith("sending the venue's sweep"));
    expect(line, "the venue's signature, logged before its send").toBeDefined();
    const sig = line.split(": ")[1];
    expect(res.pools[0].venue).toMatchObject({
      ok: false,
      signature: sig,
      result: "sending got no answer (sendTransaction: no answer after 8 tries (socket hang up)): look its signature up on chain",
    });
    expect(chain.calls.some((c) => c.method === "getSignatureStatuses")).toBe(false);
    expect(res.pools[0].island.result).toBe("not tried: the run stopped early");
    expect(res.stopped).toMatch(/^sendTransaction: no answer after 8 tries/);
    expect(res.ok).toBe(false);
  });

  it("a sweep still waiting for the chain when the run reaches its limit keeps its signature, and the other side is not tried", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [null] });
    let t = 0;
    const call = async (method, params) => {
      const r = await chain.call(method, params);
      if (method === "sendTransaction") t = RUN_LIMIT_MS + 1;
      return r;
    };
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {}, now: () => t });
    const sent = chain.sentTxs();
    expect(sent.length).toBe(1);
    expect(res.pools[0].venue).toMatchObject({ ok: false, signature: sigOfTx(sent[0]), result: "sent, but the run stopped before the chain confirmed it: look its signature up" });
    expect(res.pools[0].island.result).toBe("not tried: the run stopped early");
    expect(chain.calls.some((c) => c.method === "getSignatureStatuses")).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("each signature is taken from the signed bytes and logged before its send is made", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const logged = [];
    await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: (line) => logged.push([line, chain.calls.length]), wait: async () => {} });
    const sends = chain.calls.map((c, i) => [c, i]).filter(([c]) => c.method === "sendTransaction");
    expect(sends.length).toBe(2);
    for (const [n, side] of [
      [0, "venue"],
      [1, "island"],
    ]) {
      const sig = sigOfWire(sends[n][0].params[0]);
      const line = logged.find(([text]) => text.includes(sig));
      expect(line?.[0]).toMatch(new RegExp(`${side}'s sweep of ${big[0]}`));
      expect(line[1]).toBe(sends[n][1]); // logged with nothing between it and its send
    }
  });

  // ── A destination counts as open only when its coin's token program owns it ──
  it("a destination counts as open only when its coin's own token program owns it: the vault's is then opened, paying only the difference", async () => {
    const accounts = { ...opened(VAULT, WORKSHOP), [vaultAccounts[0]]: systemAccount(650_240) };
    const chain = fakeChain({ pools: [big], tiers, accounts, rent: 1_488_440 });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const [venueTx] = chain.simulated();
    expect(venueTx.instructions.map((i) => i.programId.toBase58())).toEqual([ATA_PROGRAM, VENUE_PROGRAM]);
    expect(venueTx.instructions[0].keys.slice(1, 4).map((k) => k.pubkey.toBase58())).toEqual([vaultAccounts[0], VAULT, SOL_MINT]);
    expect(res.pools[0]).toMatchObject({ created: 1, venue: { result: expect.stringMatching(/simulated clean/), opens: [{ address: vaultAccounts[0], rent: 838_200 }] } });
    expect(res.paid).toMatchObject({ opened: 1, rent: 838_200 });
    expect(res.ok).toBe(true);
  });

  it("a Workshop address that its coin's token program does not own reads as missing: the island's share waits and the account is listed", async () => {
    const accounts = { ...opened(VAULT, WORKSHOP), [workshopAccounts[0]]: systemAccount(650_240) };
    const chain = fakeChain({ pools: [big], tiers, accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    expect(res.pools[0].island.result).toMatch(new RegExp(`waits: the Workshop has no account yet for ${SOL_MINT}`));
    expect(res.pools[0].missing).toEqual([{ mint: SOL_MINT, address: workshopAccounts[0] }]);
    expect(res.ok).toBe(true);
  });

  // ── Each destination is checked before its side is sent, by the program's two rules (the owner's ruling, 2026-11-21) ──
  const usdcPool = dollarPool(USDC_MINT);
  const usdtPool = dollarPool(USDT_MINT);
  const CLEAN = "simulated clean (61234 compute units); a live run would send it";
  const NAME = { [SOL_MINT]: "SOL", [BAYLA]: "BAYLA", [USDC_MINT]: "USDC", [USDT_MINT]: "USDT" };
  // A delegate or a close authority: the program refuses that side (6020), so it is held back.
  for (const c of [
    { side: "venue", owner: VAULT, coin: SOL_MINT, flag: "delegate", says: "has a delegate", red: true },
    { side: "venue", owner: VAULT, coin: BAYLA, flag: "closeAuthority", says: "has a close authority", red: true },
    { side: "island", owner: WORKSHOP, coin: SOL_MINT, flag: "delegate", says: "has a delegate", red: false },
    { side: "island", owner: WORKSHOP, coin: BAYLA, flag: "closeAuthority", says: "has a close authority", red: false },
  ]) {
    const name = { [SOL_MINT]: "SOL", [BAYLA]: "BAYLA", [USDC_MINT]: "USDC", [USDT_MINT]: "USDT" }[c.coin];
    it(`the ${c.side}'s side is held back when its ${name} account ${c.says}: ${c.red ? "the run fails" : "it is named, and the run passes"}; the other side still goes`, async () => {
      const pool = c.coin === USDC_MINT ? usdcPool : c.coin === USDT_MINT ? usdtPool : big;
      const coins = pool === big ? SOL_BAYLA : DOLLAR_SOL(c.coin);
      const flags = { [c.coin]: { [c.flag]: true } };
      const accounts = { ...accountsOf(VAULT, coins, c.owner === VAULT ? flags : {}), ...accountsOf(WORKSHOP, coins, c.owner === WORKSHOP ? flags : {}) };
      const chain = fakeChain({ pools: [pool], tiers, accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      const other = c.side === "venue" ? "island" : "venue";
      const address = associatedTokenAddress(c.owner, c.coin, c.coin === BAYLA ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([[other]]);
      expect(res.pools[0][c.side]).toMatchObject({ ok: !c.red, heldBack: true });
      expect(res.pools[0][c.side].result).toContain(`\`${address}\` for ${c.coin} ${c.says}`);
      expect(res.pools[0][other].result).toMatch(/simulated clean/);
      expect(res.ok).toBe(!c.red);
      expect(summary(res, { live: false })).toContain(address);
    });
  }
  // A freeze: the program leaves that coin in the pool and still moves the other one.
  for (const c of [
    { side: "venue", owner: VAULT, coin: USDC_MINT, moves: `0.03 of ${SOL_MINT}`, left: `2 of ${USDC_MINT}`, red: true },
    { side: "venue", owner: VAULT, coin: USDT_MINT, moves: `0.03 of ${SOL_MINT}`, left: `2 of ${USDT_MINT}`, red: true },
    { side: "venue", owner: VAULT, coin: BAYLA, moves: `0.051216483 of ${SOL_MINT}`, left: `7,000 of ${BAYLA}`, red: false },
    { side: "island", owner: WORKSHOP, coin: BAYLA, moves: `0.023051592 of ${SOL_MINT}`, left: `3,683 of ${BAYLA}`, red: false },
    { side: "island", owner: WORKSHOP, coin: USDC_MINT, moves: `0.015 of ${SOL_MINT}`, left: `1 of ${USDC_MINT}`, red: false },
    { side: "island", owner: WORKSHOP, coin: USDT_MINT, moves: `0.015 of ${SOL_MINT}`, left: `1 of ${USDT_MINT}`, red: false },
  ]) {
    const name = NAME[c.coin];
    it(`the ${c.side}'s ${name} account frozen leaves its ${name} in the pool, named, and its side sweeps the other coin: ${c.red ? "the run fails" : "the run passes"}; the other side sweeps both`, async () => {
      const pool = c.coin === USDC_MINT ? usdcPool : c.coin === USDT_MINT ? usdtPool : big;
      const coins = pool === big ? SOL_BAYLA : DOLLAR_SOL(c.coin);
      const flags = { [c.coin]: { frozen: true } };
      const accounts = { ...accountsOf(VAULT, coins, c.owner === VAULT ? flags : {}), ...accountsOf(WORKSHOP, coins, c.owner === WORKSHOP ? flags : {}) };
      const chain = fakeChain({ pools: [pool], tiers, accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      const other = c.side === "venue" ? "island" : "venue";
      const address = associatedTokenAddress(c.owner, c.coin, c.coin === BAYLA ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
      expect(res.pools[0][c.side]).toMatchObject({
        ok: !c.red,
        left: [c.coin],
        result: `${CLEAN}, sweeping ${c.moves} only, and ${c.left} is left in the pool; its account \`${address}\` for ${c.coin} is frozen${c.red ? ": read it" : ""}`,
      });
      expect(res.pools[0][c.side].heldBack).toBeUndefined();
      expect(res.pools[0][other].result).toBe(CLEAN);
      expect(res.ok).toBe(!c.red);
      expect(summary(res, { live: false })).toContain(address);
    });
  }

  // ── The pool's own account of a coin, frozen, leaves that coin for each side owed it ──
  const authority = findProgramAddress([Buffer.from("vault_and_lp_mint_auth_seed")], VENUE_PROGRAM).address;
  for (const c of [
    { coin: USDC_MINT, venueOwes: [2_000_000n, 30_000_000n], islandOwes: [0n, 15_000_000n], left: { venue: [`0.03 of ${SOL_MINT}`, `2 of ${USDC_MINT}`] }, red: true },
    { coin: USDC_MINT, venueOwes: [0n, 30_000_000n], islandOwes: [1_000_000n, 15_000_000n], left: { island: [`0.015 of ${SOL_MINT}`, `1 of ${USDC_MINT}`] }, red: false },
    { coin: USDT_MINT, venueOwes: [2_000_000n, 30_000_000n], islandOwes: [0n, 0n], left: { venue: [`0.03 of ${SOL_MINT}`, `2 of ${USDT_MINT}`] }, red: true },
    {
      coin: BAYLA,
      venueOwes: [51_216_483n, 7_000_000_000n],
      islandOwes: [23_051_592n, 3_683_000_000n],
      left: { venue: [`0.051216483 of ${SOL_MINT}`, `7,000 of ${BAYLA}`], island: [`0.023051592 of ${SOL_MINT}`, `3,683 of ${BAYLA}`] },
      red: false,
    },
    { coin: BAYLA, venueOwes: [51_216_483n, 0n], islandOwes: [23_051_592n, 3_683_000_000n], left: { island: [`0.023051592 of ${SOL_MINT}`, `3,683 of ${BAYLA}`] }, red: false },
  ]) {
    const name = NAME[c.coin];
    it(`the pool's own ${name} account frozen leaves ${name} in the pool for the ${Object.keys(c.left).join(" and the ")}'s side, each owed ${name}, named, and each sweeps its other coin: ${c.red ? "the venue's fails the run" : "the run passes"}; a side not owed ${name} sweeps as usual, unnamed`, async () => {
      const dollar = c.coin !== BAYLA;
      const coins = dollar ? DOLLAR_SOL(c.coin) : SOL_BAYLA;
      const own = [key(), key()];
      const pool = [
        key(),
        poolBytes({ ammConfig: tierKey, vault0: own[0], vault1: own[1], mint0: coins[0][0], mint1: coins[1][0], program0: coins[0][1], program1: coins[1][1], decimals0: dollar ? 6 : 9, decimals1: dollar ? 9 : 6, protocol: c.venueOwes, fund: c.islandOwes }),
      ];
      const at = coins.findIndex(([m]) => m === c.coin);
      const pooled = Object.fromEntries(own.map((a, i) => [a, tokenAccount({ mint: coins[i][0], owner: authority, program: coins[i][1], frozen: i === at })]));
      const chain = fakeChain({ pools: [pool], tiers, accounts: { ...accountsOf(VAULT, coins), ...accountsOf(WORKSHOP, coins), ...pooled } });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      const owes = { venue: c.venueOwes, island: c.islandOwes };
      for (const side of ["venue", "island"]) {
        const l = c.left[side];
        const fails = c.red && side === "venue";
        if (l) {
          expect(res.pools[0][side]).toMatchObject({
            ok: !fails,
            left: [c.coin],
            result: `${CLEAN}, sweeping ${l[0]} only, and ${l[1]} is left in the pool; the pool's own account \`${own[at]}\` for ${c.coin} is frozen${fails ? ": read it" : ""}`,
          });
          expect(res.pools[0][side].heldBack).toBeUndefined();
        } else expect(res.pools[0][side].result).toBe(owes[side].some((x) => x > 0n) ? CLEAN : "nothing set aside");
      }
      // Every side owed anything is sent: each frozen leg's other coin passes the floor on its own.
      const sent = ["venue", "island"].filter((s) => owes[s].some((x) => x > 0n));
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual(sent.map((s) => [s]));
      expect(res.ok).toBe(!c.red);
      expect(summary(res, { live: false })).toContain(own[at]);
    });
  }

  // ── A frozen leg: what can move is sent, the frozen coin is named as left in the pool, never as swept ──
  const MINTS = [SOL_MINT, BAYLA];
  const BOTH = { protocol: [51_216_483n, 7_000_000_000n], fund: [23_051_592n, 3_683_000_000n] };
  /**
   * A pool of `coins` with its own two accounts, both owners holding both destinations: `frozen`
   * lists by coin what is frozen ({ pool, vault, workshop }), and `flags` adds a delegate or a close
   * authority to an owner's account ({ vault: { [mint]: { delegate: true } } }).
   */
  function legPool({ coins = SOL_BAYLA, decimals = [9, 6], protocol, fund = [0n, 0n], frozen = {}, flags = {} }) {
    const own = [key(), key()];
    const pool = [
      key(),
      poolBytes({ ammConfig: tierKey, vault0: own[0], vault1: own[1], mint0: coins[0][0], mint1: coins[1][0], program0: coins[0][1], program1: coins[1][1], decimals0: decimals[0], decimals1: decimals[1], protocol, fund }),
    ];
    const set = (who) => Object.fromEntries(coins.map(([m], i) => [m, { frozen: (frozen[who] ?? []).includes(i), ...flags[who]?.[m] }]));
    const accounts = {
      ...accountsOf(VAULT, coins, set("vault")),
      ...accountsOf(WORKSHOP, coins, set("workshop")),
      ...Object.fromEntries(own.map((a, i) => [a, tokenAccount({ mint: coins[i][0], owner: authority, program: coins[i][1], frozen: (frozen.pool ?? []).includes(i) })])),
    };
    return { pool, own, accounts };
  }

  // The pool's own account of coin 0, or of coin 1, frozen.
  for (const at of [0, 1]) {
    it(`a live run with the pool's own account of coin ${at} frozen: each side sweeps its other coin and names coin ${at} as left in the pool, with that account, never as swept`, async () => {
      const kp = Keypair.generate();
      const f = legPool({ ...BOTH, frozen: { pool: [at] } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: live(kp), log: quiet, wait: async () => {} });
      const sent = chain.sentTxs();
      expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
      const because = `the pool's own account \`${f.own[at]}\` for ${MINTS[at]} is frozen`;
      for (const [i, side, coin0, coin1, owed] of [
        [0, "venue", `0.051216483 of ${SOL_MINT}`, `7,000 of ${BAYLA}`, BOTH.protocol],
        [1, "island", `0.023051592 of ${SOL_MINT}`, `3,683 of ${BAYLA}`, BOTH.fund],
      ]) {
        const [moves, left] = at === 0 ? [coin1, coin0] : [coin0, coin1];
        expect(res.pools[0][side]).toEqual({
          share: `${coin0} + ${coin1}`,
          ok: true,
          sent: true,
          swept: true,
          fee: true,
          signature: sigOfTx(sent[i]),
          opens: [],
          // Its own FeesSwept: the frozen coin's count left, the other one moved.
          event: { moved: owed.map((x, j) => (j === at ? 0n : x)), left: owed.map((x, j) => (j === at ? x : 0n)) },
          left: [MINTS[at]],
          result: `swept ${moves} only, and ${left} is left in the pool; ${because}`,
        });
      }
      expect(res.ok).toBe(true);
      const text = summary(res, { live: true });
      const line = text.split("\n").find((l) => l.includes(f.pool[0]));
      for (const side of ["venue", "island"]) expect(line).toContain(` ${res.pools[0][side].result} \`${res.pools[0][side].signature}\` |`);
      expect(text).toContain("2 sweeps seen on chain (10,000 lamports of network fees)");
    });
  }

  // The vault's own account frozen, instead of the pool's.
  for (const at of [0, 1]) {
    it(`a live run with the vault's own account of coin ${at} frozen: the venue's side sweeps its other coin and names coin ${at} as left in the pool, with that account; the island's side sweeps both`, async () => {
      const kp = Keypair.generate();
      const f = legPool({ ...BOTH, frozen: { vault: [at] } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: live(kp), log: quiet, wait: async () => {} });
      const [moves, left] = at === 0 ? [`7,000 of ${BAYLA}`, `0.051216483 of ${SOL_MINT}`] : [`0.051216483 of ${SOL_MINT}`, `7,000 of ${BAYLA}`];
      expect(chain.sentTxs().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
      expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, left: [MINTS[at]], result: `swept ${moves} only, and ${left} is left in the pool; its account \`${vaultAccounts[at]}\` for ${MINTS[at]} is frozen` });
      expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_ISLAND}` });
      expect(res.pools[0].island.left).toBeUndefined();
      expect(res.ok).toBe(true);
    });
  }

  // Nothing the side is owed can move.
  it("a side owed only a frozen coin sends nothing and waits, naming the account; the other side, not owed that coin, sweeps as usual", async () => {
    const f = legPool({ protocol: [0n, 7_000_000_000n], fund: [23_051_592n, 0n], frozen: { pool: [1] } });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: {}, log: quiet });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["island"]]);
    expect(res.pools[0].venue).toEqual({
      share: `0 of ${SOL_MINT} + 7,000 of ${BAYLA}`,
      ok: true,
      left: [BAYLA],
      result: `waits, nothing sent: 7,000 of ${BAYLA} is left in the pool; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen`,
    });
    expect(res.pools[0].island.result).toBe(CLEAN);
    expect(res.ok).toBe(true);
  });

  it("a side with both of its coins frozen sends nothing and waits, naming both accounts", async () => {
    const f = legPool({ ...BOTH, frozen: { pool: [0, 1] } });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: {}, log: quiet });
    expect(chain.simulated()).toEqual([]);
    for (const [side, sol, bayla] of [
      ["venue", "0.051216483", "7,000"],
      ["island", "0.023051592", "3,683"],
    ]) {
      expect(res.pools[0][side]).toMatchObject({
        ok: true,
        left: MINTS,
        result: `waits, nothing sent: ${sol} of ${SOL_MINT} and ${bayla} of ${BAYLA} are left in the pool; the pool's own account \`${f.own[0]}\` for ${SOL_MINT} is frozen; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen`,
      });
      expect(res.pools[0][side].heldBack).toBeUndefined();
    }
    expect(res.ok).toBe(true);
  });

  it("the vault's USDC account frozen with only USDC owed: nothing is sent, the side waits, named, and the run fails", async () => {
    const f = legPool({ coins: DOLLAR_SOL(USDC_MINT), decimals: [6, 9], protocol: [2_000_000n, 0n], frozen: { vault: [0] } });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const address = associatedTokenAddress(VAULT, USDC_MINT, TOKEN_PROGRAM);
    expect(chain.simulated()).toEqual([]);
    expect(res.pools[0].venue).toMatchObject({ ok: false, left: [USDC_MINT], result: `waits, nothing sent: 2 of ${USDC_MINT} is left in the pool; its account \`${address}\` for ${USDC_MINT} is frozen: read it` });
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
  });

  // What can move is under the floor once the frozen coin is left out.
  for (const c of [
    { sol: 72, protocol: [1_000_000n, 7_000_000_000n], at: 1, left: `7,000 of ${BAYLA}`, why: "0.001 SOL at $72 is $0.072" },
    { sol: null, protocol: [1_000_000n, 7_000_000_000n], at: 1, left: `7,000 of ${BAYLA}`, why: "no SOL price, and 0.001 SOL is under the 0.007 SOL that stands in" },
    { sol: null, protocol: [51_216_483n, 100_000_000n], at: 0, left: `0.051216483 of ${SOL_MINT}`, why: "100 BAYLA is $0.10, and a frozen SOL leg never stands in" },
  ]) {
    it(`a side whose other coin is under the floor once the frozen one is left out sends nothing and waits, naming the account (${c.why})`, async () => {
      const f = legPool({ protocol: c.protocol, frozen: { pool: [c.at] } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(c.sol, { [BAYLA]: 0.001 }), env: {}, log: quiet });
      expect(chain.simulated()).toEqual([]);
      expect(res.pools[0].venue).toMatchObject({
        ok: true,
        left: [MINTS[c.at]],
        result: `waits: what can move is under the $0.5 floor, and ${c.left} is left in the pool; the pool's own account \`${f.own[c.at]}\` for ${MINTS[c.at]} is frozen`,
      });
      expect(res.pools[0].venue.heldBack).toBeUndefined();
      expect(res.pools[0].island.result).toBe("nothing set aside");
      expect(res.ok).toBe(true);
    });
  }

  it("the pool's own USDT account frozen and the SOL left under the floor: the venue's side waits, named, and the run fails", async () => {
    const f = legPool({ coins: DOLLAR_SOL(USDT_MINT), decimals: [6, 9], protocol: [2_000_000n, 1_000_000n], frozen: { pool: [0] } });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated()).toEqual([]);
    expect(res.pools[0].venue).toMatchObject({
      ok: false,
      left: [USDT_MINT],
      result: `waits: what can move is under the $0.5 floor, and 2 of ${USDT_MINT} is left in the pool; the pool's own account \`${f.own[0]}\` for ${USDT_MINT} is frozen: read it`,
    });
    expect(res.ok).toBe(false);
  });

  // The vault's USDC or USDT frozen fails the run, though the other coin is sent.
  for (const c of [
    { coin: USDC_MINT, where: "vault" },
    { coin: USDC_MINT, where: "pool" },
    { coin: USDT_MINT, where: "vault" },
    { coin: USDT_MINT, where: "pool" },
  ]) {
    const name = NAME[c.coin];
    it(`a live run with ${c.where === "vault" ? "the vault's" : "the pool's"} own ${name} account frozen: the venue's side sweeps its SOL, names the ${name} as left, and the run fails (exit code 1)`, async () => {
      const kp = Keypair.generate();
      const f = legPool({ coins: DOLLAR_SOL(c.coin), decimals: [6, 9], protocol: [2_000_000n, 30_000_000n], fund: [1_000_000n, 15_000_000n], frozen: { [c.where]: [0] } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      const sent = chain.sentTxs();
      expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
      const own = `the pool's own account \`${f.own[0]}\` for ${c.coin} is frozen`;
      const because = c.where === "vault" ? `its account \`${associatedTokenAddress(VAULT, c.coin, TOKEN_PROGRAM)}\` for ${c.coin} is frozen` : own;
      expect(res.pools[0].venue).toMatchObject({ ok: false, swept: true, signature: sigOfTx(sent[0]), left: [c.coin], result: `swept 0.03 of ${SOL_MINT} only, and 2 of ${c.coin} is left in the pool; ${because}: read it` });
      // The island's side never fails the run; the pool's own account leaves the island's share of that coin too.
      expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, result: c.where === "vault" ? `swept 1 of ${c.coin} and 0.015 of ${SOL_MINT}` : `swept 0.015 of ${SOL_MINT} only, and 1 of ${c.coin} is left in the pool; ${own}` });
      expect(res.ok).toBe(false);
      expect(exitCode(res)).toBe(1);
    });
  }

  // The Workshop's USDC or USDT frozen never fails the run.
  for (const c of [
    { coin: USDC_MINT, where: "workshop" },
    { coin: USDC_MINT, where: "pool" },
    { coin: USDT_MINT, where: "workshop" },
    { coin: USDT_MINT, where: "pool" },
  ]) {
    const name = NAME[c.coin];
    it(`a live run with ${c.where === "workshop" ? "the Workshop's" : "the pool's"} own ${name} account frozen and the venue ${c.where === "pool" ? "not owed it" : "owed it too"}: the island's side sweeps its SOL, names the ${name} as left, and the run passes`, async () => {
      const kp = Keypair.generate();
      const f = legPool({ coins: DOLLAR_SOL(c.coin), decimals: [6, 9], protocol: [c.where === "pool" ? 0n : 2_000_000n, 30_000_000n], fund: [1_000_000n, 15_000_000n], frozen: { [c.where]: [0] } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      const sent = chain.sentTxs();
      expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
      const because = c.where === "workshop" ? `its account \`${associatedTokenAddress(WORKSHOP, c.coin, TOKEN_PROGRAM)}\` for ${c.coin} is frozen` : `the pool's own account \`${f.own[0]}\` for ${c.coin} is frozen`;
      expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, signature: sigOfTx(sent[1]), left: [c.coin], result: `swept 0.015 of ${SOL_MINT} only, and 1 of ${c.coin} is left in the pool; ${because}` });
      expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, result: c.where === "pool" ? `swept 0.03 of ${SOL_MINT}` : `swept 2 of ${c.coin} and 0.03 of ${SOL_MINT}` });
      expect(res.ok).toBe(true);
      expect(exitCode(res)).toBe(0);
    });
  }

  // A frozen destination of a coin the side is not owed does not hold it back.
  for (const c of [
    { side: "venue", owner: VAULT, who: "vault", coins: SOL_BAYLA, at: 1, red: false },
    { side: "island", owner: WORKSHOP, who: "workshop", coins: SOL_BAYLA, at: 1, red: false },
    { side: "venue", owner: VAULT, who: "vault", coins: DOLLAR_SOL(USDC_MINT), at: 0, red: true },
  ]) {
    const [coin, program] = c.coins[c.at];
    it(`the ${c.side}'s ${NAME[coin]} account frozen, with no ${NAME[coin]} owed to that side: the side is sent and the account named; ${c.red ? "a frozen USDC account of the vault fails the run" : "the run passes"}`, async () => {
      const share = c.coins === SOL_BAYLA ? [51_216_483n, 0n] : [0n, 30_000_000n];
      const f = legPool({
        coins: c.coins,
        decimals: c.coins === SOL_BAYLA ? [9, 6] : [6, 9],
        protocol: c.side === "venue" ? share : [0n, 0n],
        fund: c.side === "island" ? share : [0n, 0n],
        frozen: { [c.who]: [c.at] },
      });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      const address = associatedTokenAddress(c.owner, coin, program);
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([[c.side]]);
      expect(res.pools[0][c.side]).toMatchObject({ ok: !c.red, result: `${CLEAN}; its account \`${address}\` for ${coin} is frozen${c.red ? ": read it" : ""}` });
      expect(res.pools[0][c.side].left).toBeUndefined();
      expect(res.pools[0][c.side].heldBack).toBeUndefined();
      expect(res.ok).toBe(!c.red);
    });
  }

  // A delegate or a close authority still holds the side back, owed or not.
  for (const c of [
    { side: "venue", owner: VAULT, who: "vault", flag: "delegate", says: "has a delegate", red: true },
    { side: "island", owner: WORKSHOP, who: "workshop", flag: "closeAuthority", says: "has a close authority", red: false },
  ]) {
    it(`the ${c.side}'s BAYLA account that ${c.says} holds its side back though no BAYLA is owed to it, as the program refuses it whatever the amount: ${c.red ? "the run fails" : "named, and the run passes"}`, async () => {
      const share = [51_216_483n, 0n];
      const f = legPool({ protocol: c.side === "venue" ? share : [0n, 0n], fund: c.side === "island" ? share : [0n, 0n], flags: { [c.who]: { [BAYLA]: { [c.flag]: true } } } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      const address = associatedTokenAddress(c.owner, BAYLA, TOKEN_2022_PROGRAM);
      expect(chain.simulated()).toEqual([]);
      expect(res.pools[0][c.side]).toMatchObject({ ok: !c.red, heldBack: true, result: `held back, nothing sent: its account \`${address}\` for ${BAYLA} ${c.says}${c.red ? ": read it" : ""}` });
      expect(res.ok).toBe(!c.red);
    });
  }

  it("a delegate holds the venue's side back even where a frozen coin would leave the other free to move, and fails the run; the island's side still sweeps its other coin", async () => {
    const f = legPool({ ...BOTH, frozen: { pool: [1] }, flags: { vault: { [SOL_MINT]: { delegate: true } } } });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["island"]]);
    expect(res.pools[0].venue).toMatchObject({
      ok: false,
      heldBack: true,
      result: `held back, nothing sent: its account \`${vaultAccounts[0]}\` for ${SOL_MINT} has a delegate; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen: read it`,
    });
    expect(res.pools[0].venue.left).toBeUndefined();
    expect(res.pools[0].island).toMatchObject({
      ok: true,
      left: [BAYLA],
      result: `${CLEAN}, sweeping 0.023051592 of ${SOL_MINT} only, and 3,683 of ${BAYLA} is left in the pool; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen`,
    });
    expect(res.ok).toBe(false);
  });

  // ── An account handed to another owner, or one that requires a memo on every transfer in (the owner's ruling, 2026-11-21) ──
  const HANDED = "has been handed to another owner";
  const MEMO = "requires a memo on every transfer in";
  for (const c of [
    { side: "island", owner: WORKSHOP, coin: SOL_MINT, says: HANDED, red: false },
    { side: "island", owner: WORKSHOP, coin: BAYLA, says: MEMO, red: false },
    { side: "venue", owner: VAULT, coin: SOL_MINT, says: HANDED, red: true },
    { side: "venue", owner: VAULT, coin: BAYLA, says: MEMO, red: true },
  ]) {
    it(`the ${c.side}'s side is held back when its ${NAME[c.coin]} account ${c.says}, and the account is named: ${c.red ? "the run fails" : "the run passes"}; the other side still goes`, async () => {
      const stranger = key();
      const flags = { [c.coin]: c.says === HANDED ? { owner: stranger } : { memo: true } };
      const accounts = { ...accountsOf(VAULT, SOL_BAYLA, c.owner === VAULT ? flags : {}), ...accountsOf(WORKSHOP, SOL_BAYLA, c.owner === WORKSHOP ? flags : {}) };
      const chain = fakeChain({ pools: [big], tiers, accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      const other = c.side === "venue" ? "island" : "venue";
      const address = associatedTokenAddress(c.owner, c.coin, c.coin === BAYLA ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
      const why = c.says === HANDED ? `has been handed to \`${stranger}\`` : MEMO;
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([[other]]);
      expect(res.pools[0][c.side]).toMatchObject({ ok: !c.red, heldBack: true, result: `held back, nothing sent: its account \`${address}\` for ${c.coin} ${why}${c.red ? ": read it" : ""}` });
      expect(res.pools[0][other].result).toBe(CLEAN);
      expect(res.ok).toBe(!c.red);
      expect(summary(res, { live: false })).toContain(address);
    });
  }

  // The memo rule refuses only a transfer into the account: a coin that does not move there does not hold the side back.
  for (const c of [
    { who: "workshop", owner: WORKSHOP, why: "the island is owed none of that coin", fund: [23_051_592n, 0n], frozen: {}, red: false },
    {
      who: "workshop",
      owner: WORKSHOP,
      why: "a freeze leaves that coin in the pool",
      fund: [23_051_592n, 3_683_000_000n],
      frozen: { pool: [1] },
      red: false,
      moves: `, sweeping 0.023051592 of ${SOL_MINT} only, and 3,683 of ${BAYLA} is left in the pool`,
      after: (f) => `; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen`,
    },
    { who: "vault", owner: VAULT, why: "the venue is owed none of that coin", protocol: [51_216_483n, 0n], frozen: {}, red: true },
  ]) {
    const side = c.who === "vault" ? "venue" : "island";
    it(`the ${c.who === "vault" ? "vault's" : "Workshop's"} BAYLA account that requires a memo does not hold the ${side}'s side back when ${c.why}: the sweep goes and the account is named; ${c.red ? "on the vault's side the run fails" : "the run passes"}`, async () => {
      const f = legPool({ protocol: c.protocol ?? [0n, 0n], fund: c.fund ?? [0n, 0n], frozen: c.frozen, flags: { [c.who]: { [BAYLA]: { memo: true } } } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      const address = associatedTokenAddress(c.owner, BAYLA, TOKEN_2022_PROGRAM);
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([[side]]);
      expect(res.pools[0][side]).toMatchObject({ ok: !c.red, result: `${CLEAN}${c.moves ?? ""}; its account \`${address}\` for ${BAYLA} ${MEMO}${c.after?.(f) ?? ""}${c.red ? ": read it" : ""}` });
      expect(res.pools[0][side].heldBack).toBeUndefined();
      expect(res.ok).toBe(!c.red);
    });
  }

  for (const c of [
    { side: "island", owner: WORKSHOP, other: "venue", red: false },
    { side: "venue", owner: VAULT, other: "island", red: true },
  ]) {
    it(`in a live run, the ${c.side}'s BAYLA account that requires a memo holds that side back before anything is simulated or sent for it: ${c.red ? "the run fails" : "the run passes"}, and the other side is swept`, async () => {
      const kp = Keypair.generate();
      const flags = { [BAYLA]: { memo: true } };
      const chain = fakeChain({ pools: [big], tiers, accounts: { ...accountsOf(VAULT, SOL_BAYLA, c.owner === VAULT ? flags : {}), ...accountsOf(WORKSHOP, SOL_BAYLA, c.owner === WORKSHOP ? flags : {}) } });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([[c.other]]);
      expect(chain.sentTxs().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([[c.other]]);
      const address = associatedTokenAddress(c.owner, BAYLA, TOKEN_2022_PROGRAM);
      expect(res.pools[0][c.side]).toMatchObject({ ok: !c.red, heldBack: true, result: `held back, nothing sent: its account \`${address}\` for ${BAYLA} requires a memo on every transfer in${c.red ? ": read it" : ""}` });
      expect(res.pools[0][c.other]).toMatchObject({ ok: true, swept: true });
      expect(res.ok).toBe(!c.red);
    });
  }

  // A refusal of the island's sweep for its accounts' own settings: 6018, 6020, Token-2022's 36 (a memo needed), or Anchor's 3012 (an account that does not exist).
  for (const code of [6018, 6020, 36, 3012]) {
    it(`a simulation of the island's sweep refused with ${code} holds back only the island's side, named, and the run passes; the venue's refused with ${code} fails it`, async () => {
      const refusedOn = (side) => (tx) => (sweepsIn(tx).some((ix) => sideOf(ix) === side) ? { InstructionError: [tx.instructions.length - 1, { Custom: code }] } : null);
      const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), simErr: refusedOn("island") });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      expect(res.pools[0].island).toMatchObject({ ok: true, heldBack: true, result: expect.stringMatching(new RegExp(`^held back, nothing sent: a Workshop account .*\\(${code}\\); the simulation refused it: \\{"InstructionError":\\[0,\\{"Custom":${code}\\}\\]\\}`)) });
      expect(res.pools[0].venue.result).toBe(CLEAN);
      expect(res.ok).toBe(true);
      expect(summary(res, { live: false })).toContain(`(${code}); the simulation refused it`);
      // On the vault's side the same refusal is a failure.
      const venue = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), simErr: refusedOn("venue") });
      const res2 = await run(parseArgs(["--payer", payer]), { call: venue.call, fetchImpl: noPrice, env: {}, log: quiet });
      expect(res2.pools[0].venue).toMatchObject({ ok: false, result: expect.stringMatching(/^the simulation refused it: /) });
      expect(res2.pools[0].venue.heldBack).toBeUndefined();
      expect(res2.pools[0].island.result).toBe(CLEAN);
      expect(res2.ok).toBe(false);
    });

    it(`in a live run, a simulation of the island's sweep refused with ${code} holds back only the island's side: named, nothing sent for it, no fee counted, and the run passes`, async () => {
      const kp = Keypair.generate();
      const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), simErr: (tx) => (sweepsIn(tx).some((ix) => sideOf(ix) === "island") ? { InstructionError: [0, { Custom: code }] } : null) });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      expect(chain.sentTxs().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
      expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_VENUE}` });
      expect(res.pools[0].island).toMatchObject({ ok: true, heldBack: true, result: expect.stringMatching(new RegExp(`^held back, nothing sent: a Workshop account .*\\(${code}\\); the simulation refused it: `)) });
      expect(res.pools[0].island.fee).toBeUndefined();
      expect(res.paid.sweeps).toBe(1);
      expect(res.ok).toBe(true);
      expect(summary(res, { live: true })).toContain("1 sweep seen on chain (5,000 lamports of network fees)");
    });
  }

  it("a live island sweep that fails on chain for its accounts' own settings is named, its fee counted, and the run passes; the venue's failing so fails it", async () => {
    const kp = Keypair.generate();
    const failed = (code) => ({ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: code }] } });
    // The venue's lands; the island's fails on chain with 6018 (an account handed over since its simulation).
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [{ confirmationStatus: "confirmed", err: null }, failed(6018)] });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    const sent = chain.sentTxs();
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_VENUE}` });
    expect(res.pools[0].island).toMatchObject({ ok: true, sent: true, fee: true, signature: sigOfTx(sent[1]), result: "sent, and it failed on chain: a Workshop account is not its own (6018)" });
    expect(res.pools[0].island.swept).toBeUndefined();
    expect(res.paid.sweeps).toBe(2);
    expect(res.ok).toBe(true);
    // The venue's failing on chain with the same number is a failure.
    const venue = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [failed(6018), { confirmationStatus: "confirmed", err: null }] });
    const res2 = await run(parseArgs(["--live"]), { call: venue.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res2.pools[0].venue).toMatchObject({ ok: false, sent: true, fee: true, result: "sent, and it failed on chain" });
    expect(res2.ok).toBe(false);
  });

  for (const code of [6018, 6020, 36, 3012]) {
    it(`a live island sweep that fails on chain with ${code} is named, its fee counted, and the run passes`, async () => {
      const kp = Keypair.generate();
      const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [{ confirmationStatus: "confirmed", err: null }, { confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: code }] } }] });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      expect(res.pools[0].island).toMatchObject({ ok: true, sent: true, fee: true, result: expect.stringMatching(new RegExp(`^sent, and it failed on chain: a Workshop account .* \\(${code}\\)$`)) });
      expect(res.paid.sweeps).toBe(2);
      expect(res.ok).toBe(true);
    });
  }

  it("a Workshop account handed to another owner is named on the island's side on a day it has nothing set aside, and while its other account is missing; the run passes", async () => {
    const stranger = key();
    const quietPool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n] })];
    const chain = fakeChain({ pools: [quietPool, big], tiers, accounts: { ...opened(VAULT), ...accountsOf(WORKSHOP, [SOL_BAYLA[0]], { [SOL_MINT]: { owner: stranger } }) } });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const row = (p) => res.pools.find((r) => r.pool === p[0]);
    const named = `its account \`${workshopAccounts[0]}\` for ${SOL_MINT} has been handed to \`${stranger}\``;
    expect(row(quietPool).island).toMatchObject({ ok: true, result: `nothing set aside; ${named}` });
    expect(row(big).island).toMatchObject({ ok: true, result: `waits: the Workshop has no account yet for ${BAYLA}; ${named}` });
    expect(res.ok).toBe(true);
  });

  // ── The program needs both of a pool's destinations to exist, even for a coin that does not move ──
  for (const c of [
    { why: "the venue is owed none of that coin", protocol: [51_216_483n, 0n], frozen: {}, left: undefined, moves: CLEAN, sweeps: 1 },
    {
      why: "the pool's own account of that coin is frozen",
      ...BOTH,
      frozen: { pool: [1] },
      left: [BAYLA],
      moves: (f) => `${CLEAN}, sweeping 0.051216483 of ${SOL_MINT} only, and 7,000 of ${BAYLA} is left in the pool; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen`,
      sweeps: 2,
    },
    {
      why: "the vault's other account is frozen, so that coin is the one that moves",
      ...BOTH,
      frozen: { vault: [0] },
      left: [SOL_MINT],
      moves: () => `${CLEAN}, sweeping 7,000 of ${BAYLA} only, and 0.051216483 of ${SOL_MINT} is left in the pool; its account \`${vaultAccounts[0]}\` for ${SOL_MINT} is frozen`,
      sweeps: 2,
    },
  ]) {
    it(`the venue's sweep opens the vault's missing BAYLA account inside its own transaction when ${c.why}, and its rent is counted once`, async () => {
      const f = legPool({ protocol: c.protocol, fund: c.fund, frozen: c.frozen });
      delete f.accounts[vaultAccounts[1]];
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts, rent: 1_488_440 });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: {}, log: quiet });
      const [venueTx] = chain.simulated();
      expect(venueTx.instructions.map((i) => i.programId.toBase58())).toEqual([ATA_PROGRAM, VENUE_PROGRAM]);
      expect(venueTx.instructions[0].keys.slice(1, 4).map((k) => k.pubkey.toBase58())).toEqual([vaultAccounts[1], VAULT, BAYLA]);
      expect(res.pools[0]).toMatchObject({ created: 1, venue: { ok: true, opens: [{ address: vaultAccounts[1], rent: 1_488_440 }], result: typeof c.moves === "function" ? c.moves(f) : c.moves } });
      expect(res.pools[0].venue.left).toEqual(c.left);
      expect(res.paid).toMatchObject({ opened: 1, rent: 1_488_440, sweeps: c.sweeps });
      expect(res.ok).toBe(true);
    });
  }

  it("a sweep that opens a classic and a Token-2022 account reads each one's own rent, less what its own address already held", async () => {
    // The classic address already holds 650,240 lamports; the Token-2022 one holds nothing.
    const accounts = { ...opened(WORKSHOP), [vaultAccounts[0]]: systemAccount(650_240) };
    const chain = fakeChain({ pools: [big], tiers, accounts, rentOf: (address) => (address === vaultAccounts[1] ? 1_513_840 : 1_488_440) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.pools[0].venue.opens).toEqual([
      { address: vaultAccounts[0], rent: 838_200 },
      { address: vaultAccounts[1], rent: 1_513_840 },
    ]);
    expect(res.paid).toMatchObject({ opened: 2, rent: 2_352_040 });
    expect(summary(res, { live: false })).toContain("2 accounts opened for the vault (2,352,040 lamports of rent, which stays the vault's)");
  });

  it("a vault account with a delegate or a close authority is named, and fails the run, on a day only the island's side of its pool is due", async () => {
    // One pool where the venue has nothing set aside, one where its share is under the floor.
    const usdc = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: USDC_MINT, mint1: SOL_MINT, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 9, protocol: [0n, 0n], fund: [1_000_000n, 15_000_000n] })];
    const sol = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [1_000n, 0n], fund: [23_051_592n, 0n] })];
    const accounts = {
      ...accountsOf(VAULT, DOLLAR_SOL(USDC_MINT), { [USDC_MINT]: { delegate: true } }),
      ...accountsOf(VAULT, [SOL_BAYLA[1]], { [BAYLA]: { closeAuthority: true } }),
      ...accountsOf(WORKSHOP, DOLLAR_SOL(USDC_MINT)),
      ...accountsOf(WORKSHOP, SOL_BAYLA),
    };
    const chain = fakeChain({ pools: [usdc, sol], tiers, accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const row = (p) => res.pools.find((r) => r.pool === p[0]);
    const usdcAccount = associatedTokenAddress(VAULT, USDC_MINT, TOKEN_PROGRAM);
    expect(row(usdc).venue).toMatchObject({ ok: false, result: `nothing set aside; its account \`${usdcAccount}\` for ${USDC_MINT} has a delegate: read it` });
    expect(row(sol).venue).toMatchObject({ ok: false, result: `under the $0.5 floor: waits; its account \`${vaultAccounts[1]}\` for ${BAYLA} has a close authority: read it` });
    for (const p of [usdc, sol]) expect(row(p).island.result).toMatch(/simulated clean/);
    expect(res.ok).toBe(false);
    const text = summary(res, { live: false });
    expect(text).toContain(usdcAccount);
    expect(text).toContain(vaultAccounts[1]);
  });

  // A side that waits under the floor names a frozen pool account of a coin it is owed, as one that is sent does.
  for (const coin of [USDC_MINT, USDT_MINT]) {
    it(`the pool's own ${NAME[coin]} account frozen is named on the venue's side while that side waits under the floor, and fails the run; the island's side still goes`, async () => {
      // The venue is owed 0.30 of the dollar coin, under the floor; the island 0.015 SOL, $1.08 at $72.
      const f = legPool({ coins: DOLLAR_SOL(coin), decimals: [6, 9], protocol: [300_000n, 0n], fund: [0n, 15_000_000n], frozen: { pool: [0] } });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72), env: {}, log: quiet });
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["island"]]);
      expect(res.pools[0].venue).toMatchObject({ ok: false, result: `under the $0.5 floor: waits; the pool's own account \`${f.own[0]}\` for ${coin} is frozen: read it` });
      expect(res.pools[0].island.result).toBe(CLEAN);
      expect(res.ok).toBe(false);
      expect(summary(res, { live: false })).toContain(f.own[0]);
    });
  }

  it("the pool's own frozen account of a coin the island is owed is named on the island's side while it waits under the floor; the run passes", async () => {
    const f = legPool({ coins: DOLLAR_SOL(USDC_MINT), decimals: [6, 9], protocol: [0n, 30_000_000n], fund: [300_000n, 0n], frozen: { pool: [0] } });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72), env: {}, log: quiet });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    expect(res.pools[0].island).toMatchObject({ ok: true, result: `under the $0.5 floor: waits; the pool's own account \`${f.own[0]}\` for ${USDC_MINT} is frozen` });
    // The venue is owed no USDC: the frozen account is not named on its side.
    expect(res.pools[0].venue.result).toBe(CLEAN);
    expect(res.ok).toBe(true);
  });

  for (const c of [
    { fund: [0n, 0n], says: "nothing set aside", when: "it has nothing set aside" },
    { fund: [1_000n, 0n], says: "under the $0.5 floor: waits", when: "its share is under the floor" },
  ]) {
    it(`a Workshop account with a delegate is named on the island's side on a day ${c.when}; the run passes`, async () => {
      const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n], fund: c.fund })];
      const accounts = { ...opened(VAULT), ...accountsOf(WORKSHOP, SOL_BAYLA, { [BAYLA]: { delegate: true } }) };
      const chain = fakeChain({ pools: [pool], tiers, accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      expect(res.pools[0].island).toMatchObject({ ok: true, result: `${c.says}; its account \`${workshopAccounts[1]}\` for ${BAYLA} has a delegate` });
      expect(res.pools[0].venue.result).toMatch(/simulated clean/);
      expect(res.ok).toBe(true);
    });
  }

  it("a Workshop account with a delegate is named while the island's share waits for another of its accounts; the run still passes", async () => {
    const accounts = { ...opened(VAULT), ...accountsOf(WORKSHOP, [SOL_BAYLA[0]], { [SOL_MINT]: { delegate: true } }) };
    const chain = fakeChain({ pools: [big], tiers, accounts });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const [row] = res.pools;
    expect(row.island).toMatchObject({ ok: true, result: `waits: the Workshop has no account yet for ${BAYLA}; its account \`${workshopAccounts[0]}\` for ${SOL_MINT} has a delegate` });
    expect(row.missing).toEqual([{ mint: BAYLA, address: workshopAccounts[1] }]);
    expect(row.venue.result).toMatch(/simulated clean/);
    expect(res.ok).toBe(true);
    const text = summary(res, { live: false });
    expect(text).toContain(workshopAccounts[0]);
    expect(text).toContain(workshopAccounts[1]);
  });

  it("on mainnet, a tier that names the vault but another fund owner is not swept either, and fails the run", async () => {
    const chain = fakeChain({ pools: [big], tiers: { [tierKey]: tierBytes(VAULT, key()) }, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.ok).toBe(false);
    expect(res.pools[0].note).toMatch(/not the vault and the Workshop/);
    expect(chain.calls.some((c) => c.method === "simulateTransaction")).toBe(false);
  });

  // ── Every run reads the vault's own accounts and every pool's own two (the owner's ruling, 2026-11-21) ──
  const VAULT_DAILY = [SOL_MINT, USDC_MINT, USDT_MINT].map((m) => associatedTokenAddress(VAULT, m, TOKEN_PROGRAM));
  const ownOf = (p) => {
    const d = decodePool(p[0], p[1]);
    return [d.vault0, d.vault1];
  };

  it("every run reads the vault's SOL, USDC and USDT accounts and every listed pool's own two in one request, with the pools' Token-2022 coins, on a day no side is due", async () => {
    const chain = fakeChain({ pools: [empty, dust], tiers, accounts: opened(VAULT) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const reads = chain.calls.filter((c) => c.method === "getMultipleAccounts").map((c) => c.params[0]);
    expect(reads).toEqual([[tierKey], [BAYLA, ...VAULT_DAILY, ...ownOf(empty), ...ownOf(dust)]]);
    expect(chain.simulated()).toEqual([]);
    expect(res.daily).toEqual({ vault: 3, pools: 4, named: [] });
    expect(res.ok).toBe(true);
    expect(summary(res, { live: false })).toContain("\nRead today, as every day: the vault's SOL, USDC and USDT accounts and the pools' own 4 accounts. Nothing to name.\n");
  });

  it("the daily read asks for at most 100 accounts a call, in order, and names what it finds in the last of them", async () => {
    const many = Array.from({ length: 60 }, () => [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM })]);
    const last = ownOf(many[59]);
    const chain = fakeChain({ pools: many, tiers, accounts: { [last[1]]: tokenAccount({ mint: BAYLA, owner: authority, program: TOKEN_2022_PROGRAM, frozen: true }) } });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const reads = chain.calls.filter((c) => c.method === "getMultipleAccounts").slice(1).map((c) => c.params[0]);
    expect(reads.map((r) => r.length)).toEqual([100, 24]);
    expect(reads.flat()).toEqual([BAYLA, ...VAULT_DAILY, ...many.flatMap(ownOf)]);
    expect(res.daily).toEqual({ vault: 3, pools: 120, named: [{ text: `the pool \`${many[59][0]}\`'s own account \`${last[1]}\` for ${BAYLA} is frozen`, red: false }] });
    expect(res.ok).toBe(true);
  });

  it("a daily read the RPC answers with fewer accounts than asked stops the run: nothing is taken from the wrong account", async () => {
    const usdc = dollarPool(USDC_MINT);
    const chain = fakeChain({ pools: [usdc], tiers, accounts: { ...accountsOf(VAULT, DOLLAR_SOL(USDC_MINT)), ...accountsOf(WORKSHOP, DOLLAR_SOL(USDC_MINT)) } });
    const call = async (method, params) => {
      const r = await chain.call(method, params);
      return method === "getMultipleAccounts" && params[0].includes(VAULT_DAILY[1]) && !params[0].includes(usdc[0]) ? { value: r.value.slice(1) } : r;
    };
    const res = await run(parseArgs(["--payer", payer]), { call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.stopped).toBe("the pools could not be read: getMultipleAccounts answered 4 accounts for 5");
    expect(chain.simulated()).toEqual([]);
    expect(res.ok).toBe(false);
  });

  it("a daily read the RPC refuses stops the run before any pool is looked at", async () => {
    const usdc = dollarPool(USDC_MINT);
    const chain = fakeChain({
      pools: [usdc],
      tiers,
      accounts: { ...accountsOf(VAULT, DOLLAR_SOL(USDC_MINT)), ...accountsOf(WORKSHOP, DOLLAR_SOL(USDC_MINT)) },
      fail: (m, p) => (m === "getMultipleAccounts" && p[0].includes(VAULT_DAILY[2]) ? rpcError(m, -32603, "Internal error") : null),
    });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res).toMatchObject({ ok: false, daily: null, pools: [] });
    expect(res.stopped).toMatch(/^the pools could not be read: getMultipleAccounts: .*Internal error/);
    expect(chain.simulated()).toEqual([]);
  });

  // On a day no side is due: the venue holds 0.001 of the dollar coin or of BAYLA, under the floor, and the island as given.
  const quietDollar = (mint, { protocol = [1_000n, 0n], fund = [0n, 0n] } = {}) => [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: mint, mint1: SOL_MINT, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 9, protocol, fund })];
  for (const c of [
    { what: "the vault's USDC account with a delegate", vault: USDC_MINT, flag: { delegate: true }, says: "has a delegate", red: true },
    { what: "the vault's SOL account with a close authority", vault: SOL_MINT, flag: { closeAuthority: true }, says: "has a close authority", red: true },
    { what: "the vault's USDT account frozen", vault: USDT_MINT, flag: { frozen: true }, says: "is frozen", red: true },
    { what: "the vault's USDC account frozen", vault: USDC_MINT, flag: { frozen: true }, says: "is frozen", red: true },
    { what: "the vault's SOL account frozen", vault: SOL_MINT, flag: { frozen: true }, says: "is frozen", red: false },
    { what: "the vault's USDC account handed to another owner", vault: USDC_MINT, flag: { owner: WORKSHOP }, says: `has been handed to \`${WORKSHOP}\``, red: true },
    { what: "a pool's own USDC account frozen where the venue holds USDC", pool: USDC_MINT, flag: { frozen: true }, says: "is frozen", red: true },
    { what: "a pool's own USDT account frozen where the venue holds USDT", pool: USDT_MINT, flag: { frozen: true }, says: "is frozen", red: true },
    { what: "a pool's own USDC account frozen where only the island holds USDC", pool: USDC_MINT, shares: { protocol: [0n, 1_000n], fund: [1_000n, 0n] }, flag: { frozen: true }, says: "is frozen", red: false },
    { what: "a pool's own BAYLA account frozen where the venue holds BAYLA", pool: BAYLA, flag: { frozen: true }, says: "is frozen", red: false },
    { what: "a pool's own USDC account with a delegate", pool: USDC_MINT, flag: { delegate: true }, says: "has a delegate", red: false },
  ]) {
    it(`the daily read names ${c.what} on a day no side is due: ${c.red ? "the run fails" : "only named, and the run passes"}`, async () => {
      let pool;
      let named;
      const accounts = {};
      if (c.vault) {
        pool = quietDollar(USDC_MINT);
        Object.assign(accounts, accountsOf(VAULT, [[c.vault, TOKEN_PROGRAM]], { [c.vault]: c.flag }));
        named = `the vault's account \`${associatedTokenAddress(VAULT, c.vault, TOKEN_PROGRAM)}\` for ${c.vault} ${c.says}`;
      } else {
        const t22 = c.pool === BAYLA;
        pool = t22
          ? [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: BAYLA, mint1: SOL_MINT, program0: TOKEN_2022_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 9, protocol: [1_000n, 0n] })]
          : quietDollar(c.pool, c.shares);
        const [own] = ownOf(pool);
        accounts[own] = tokenAccount({ mint: c.pool, owner: authority, program: t22 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM, ...c.flag });
        named = `the pool \`${pool[0]}\`'s own account \`${own}\` for ${c.pool} ${c.says}`;
      }
      const chain = fakeChain({ pools: [pool], tiers, accounts });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
      expect(res.pools[0].note).toBe("under the $0.5 floor: waits");
      expect(chain.simulated()).toEqual([]);
      expect(res.daily?.named).toEqual([{ text: named, red: c.red }]);
      expect(res.ok).toBe(!c.red);
      expect(summary(res, { live: false })).toContain(`\nRead today, as every day, whether or not a side was due: ${named}${c.red ? ": read it" : ""}.\n`);
    });
  }

  it("the daily read names the vault's account on a day nothing at all is set aside, and fails the run", async () => {
    const chain = fakeChain({ pools: [empty], tiers, accounts: accountsOf(VAULT, [[USDC_MINT, TOKEN_PROGRAM]], { [USDC_MINT]: { delegate: true } }) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.pools[0].note).toBe("nothing set aside");
    expect(res.daily?.named).toEqual([{ text: `the vault's account \`${VAULT_DAILY[1]}\` for ${USDC_MINT} has a delegate`, red: true }]);
    expect(res.ok).toBe(false);
  });

  it("on a test chain, the daily read reads each tier's own protocol owner's SOL, USDC and USDT accounts", async () => {
    const program = key();
    const [protocolOwner, fundOwner] = [key(), key()];
    const testTier = key();
    const pool = [key(), poolBytes({ ammConfig: testTier, vault0: key(), vault1: key(), mint0: USDC_MINT, mint1: SOL_MINT, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 9 })];
    const theirs = [SOL_MINT, USDC_MINT, USDT_MINT].map((m) => associatedTokenAddress(protocolOwner, m, TOKEN_PROGRAM));
    const chain = fakeChain({ pools: [pool], tiers: { [testTier]: tierBytes(protocolOwner, fundOwner) }, accounts: accountsOf(protocolOwner, [[USDC_MINT, TOKEN_PROGRAM]], { [USDC_MINT]: { delegate: true } }) });
    const res = await run(parseArgs(["--payer", payer, "--program", program]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.calls.filter((c) => c.method === "getMultipleAccounts").map((c) => c.params[0])[1]).toEqual([...theirs, ...ownOf(pool)]);
    expect(res.daily?.named).toEqual([{ text: `the vault's account \`${theirs[1]}\` for ${USDC_MINT} has a delegate`, red: true }]);
    expect(res.ok).toBe(false);
  });

  it("a live run makes the daily read too: the vault's account is named, the run fails, the summary says it, and both sides are still swept", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: { ...opened(VAULT, WORKSHOP), ...accountsOf(VAULT, [[USDC_MINT, TOKEN_PROGRAM]], { [USDC_MINT]: { delegate: true } }) } });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(chain.calls.filter((c) => c.method === "getMultipleAccounts").map((c) => c.params[0])[1]).toEqual([BAYLA, ...VAULT_DAILY, vault0, vault1]);
    const named = `the vault's account \`${VAULT_DAILY[1]}\` for ${USDC_MINT} has a delegate`;
    expect(res.daily).toEqual({ vault: 3, pools: 2, named: [{ text: named, red: true }] });
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_VENUE}` });
    expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_ISLAND}` });
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
    expect(summary(res, { live: true })).toContain(`\nRead today, as every day, whether or not a side was due: ${named}: read it.\n`);
  });

  // ── The floor is each side's own ───────────────────────────────────────────
  for (const sol of [72, null]) {
    it(`the floor is each side's own: a venue share of 693 lamports is not sent while the island's 0.01 SOL waits (${sol ? "SOL at $72" : "no SOL price: 0.007 SOL stands in"})`, async () => {
      const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [693n, 0n], fund: [10_000_000n, 0n] })];
      // The vault holds both accounts; the Workshop holds neither, so its share waits.
      const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT) });
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(sol), env: {}, log: quiet });
      expect(chain.simulated()).toEqual([]);
      expect(res.pools[0].venue.result).toMatch(/under the \$0\.5 floor/);
      expect(res.pools[0].island.result).toMatch(/waits: the Workshop has no account yet/);
      expect(res.ok).toBe(true);
    });
  }

  it("SOL's price is read and used: at $200 a venue share of 0.003 SOL ($0.60) is swept, which the 0.007 SOL stand-in would leave", async () => {
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [3_000_000n, 0n], fund: [0n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(200), env: {}, log: quiet });
    expect(res.prices.sol).toBe(200);
    expect(res.pools[0].venue.result).toMatch(/simulated clean/);
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    expect(summary(res, { live: false })).not.toContain("SOL's price was not read");
  });

  it("a SOL price that is not a finite number is no price: JSON's 1e999 leaves the 0.007 SOL stand-in, and the summary says SOL's price was not read", async () => {
    // 0.006 SOL: under the 0.007 SOL that stands in for $0.50.
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [6_000_000n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP) });
    const huge = async (url) => (url.startsWith("https://api.coinbase.com/") ? { ok: true, json: async () => JSON.parse('{"data":{"amount":"1e999"}}') } : priced(null)(url));
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: huge, env: {}, log: quiet });
    expect(res.prices.sol).toBeNull();
    expect(res.pools[0].note).toBe("under the $0.5 floor: waits");
    expect(chain.simulated()).toEqual([]);
    expect(summary(res, { live: false })).toContain("SOL's price was not read today, so 0.007 SOL stood in for the $0.5 floor.");
  });

  it("an island coin priced at JSON's 1e999 is no price: it counts nothing and is named, and the venue's real share of SOL still goes", async () => {
    // The venue is owed 0.03 SOL ($2.16 at $72) and none of BAYLA.
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [30_000_000n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: Infinity }), env: {}, log: quiet });
    expect(res.prices.island[BAYLA]).toBeNull();
    expect(res.pools[0].venue.result).toMatch(/simulated clean/);
    expect(summary(res, { live: false })).toContain("No price today for BAYLA: their shares counted as nothing against the floor.");
  });

  it("--min-usd sets each side's floor: at $2 a side worth $1.08 waits while one worth $2.16 goes, a pool with both under it waits whole, and so does what can move once a frozen coin is left out", async () => {
    // SOL at $72: the venue's 0.03 SOL is $2.16, the island's 0.015 SOL $1.08.
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [30_000_000n, 0n], fund: [15_000_000n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP) });
    const opts = parseArgs(["--payer", payer, "--min-usd", "2"]);
    const res = await run(opts, { call: chain.call, fetchImpl: priced(72), env: {}, log: quiet });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    expect(res.pools[0].island.result).toBe("under the $2 floor: waits");
    // Both sides under $2: the pool waits, and none of its accounts is read.
    const low = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [15_000_000n, 0n], fund: [15_000_000n, 0n] })];
    const quiet2 = fakeChain({ pools: [low], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res2 = await run(opts, { call: quiet2.call, fetchImpl: priced(72), env: {}, log: quiet });
    expect(res2.pools[0].note).toBe("under the $2 floor: waits");
    expect(quiet2.calls.some((c) => c.method === "getMultipleAccounts" && c.params[0].includes(low[0]))).toBe(false);
    // BAYLA's pool account frozen: of the venue's $8.44, only 0.02 SOL ($1.44) can move.
    const f = legPool({ protocol: [20_000_000n, 7_000_000_000n], frozen: { pool: [1] } });
    const leg = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    const res3 = await run(opts, { call: leg.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: {}, log: quiet });
    expect(leg.simulated()).toEqual([]);
    expect(res3.pools[0].venue.result).toBe(`waits: what can move is under the $2 floor, and 7,000 of ${BAYLA} is left in the pool; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen`);
  });

  it("with no SOL price, the summary says what stood in for the floor, at the floor the run was given", async () => {
    const chain = fakeChain({ pools: [dust], tiers });
    const res = await run(parseArgs(["--payer", payer, "--min-usd", "2"]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(summary(res, { live: false })).toContain("SOL's price was not read today, so 0.028 SOL stood in for the $2 floor.");
  });

  it("the run's first log line says how many pools, SOL's price or that it was not read, the island coins' prices, the payer, and dry run or live", async () => {
    const chain = fakeChain({ pools: [big, empty], tiers, accounts: opened(VAULT, WORKSHOP) });
    const logged = [];
    await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(null, { [BAYLA]: 0.001 }), env: {}, log: (l) => logged.push(l) });
    expect(logged[0]).toBe(`2 pools on ${VENUE_PROGRAM}; SOL price unread; island coins BAYLA $0.001; payer ${payer}; dry run`);
    const kp = Keypair.generate();
    const liveLog = [];
    await run(parseArgs(["--live"]), { call: fakeChain({ pools: [empty, dust], tiers }).call, fetchImpl: priced(72), env: live(kp), log: (l) => liveLog.push(l), wait: async () => {} });
    expect(liveLog[0]).toBe(`2 pools on ${VENUE_PROGRAM}; SOL $72; island coins BAYLA unpriced; payer ${kp.publicKey.toBase58()}; LIVE`);
  });

  // ── The island's coins take a price, and only they ─────────────────────────
  it("the island's coins take the price the site's volume figure uses: a pool of two island coins is swept once the venue's own share passes the floor", async () => {
    const twoIsland = [
      key(),
      poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: BRAINLET, mint1: SOY, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 6, protocol: [2_000_000_000n, 0n], fund: [0n, 1_000n] }),
    ];
    const offList = key();
    const baylaOffList = [
      key(),
      poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: BAYLA, mint1: offList, program0: TOKEN_2022_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 6, protocol: [1_000_000_000n, 10n ** 15n], fund: [0n, 0n] }),
    ];
    const chain = fakeChain({ pools: [twoIsland, baylaOffList], tiers });
    // Jupiter has no price for SOY today: its share counts nothing, and the summary says so.
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(null, { [BRAINLET]: 0.001, [BAYLA]: 0.001 }), env: {}, log: quiet });
    const row = (p) => res.pools.find((r) => r.pool === p[0]);
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["venue"]]);
    expect(row(twoIsland).venue.result).toMatch(/simulated clean/); // 2,000 BRAINLET at $0.001
    expect(row(twoIsland).island.result).toMatch(/under the \$0\.5 floor/); // 0.001 SOY
    expect(row(baylaOffList).venue.result).toMatch(/simulated clean/); // 1,000 BAYLA at $0.001; the other coin counts nothing
    expect(res.ok).toBe(true);
    expect(summary(res, { live: false })).toContain("No price today for SOY: their shares counted as nothing against the floor.");
  });

  it("a pool with no priced coin is named as not swept by this job, and not counted as waiting; no coin off the list takes a price", async () => {
    const [a, b] = [key(), key()];
    const unpriced = [
      key(),
      poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: a, mint1: b, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 6, protocol: [10n ** 15n, 10n ** 15n], fund: [10n ** 15n, 0n] }),
    ];
    // Jupiter would answer for those two coins as well: the job neither asks for them nor uses an answer.
    const seen = [];
    const chain = fakeChain({ pools: [unpriced, big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72, { [a]: 1, [b]: 1, [BAYLA]: 0.001 }, seen), env: {}, log: quiet });
    const row = res.pools.find((r) => r.pool === unpriced[0]);
    expect(row.note).toBe("no priced coin: not swept by this job");
    expect(chain.simulated().flatMap((tx) => sweepsIn(tx)).every((ix) => ix.keys[1].pubkey.toBase58() !== unpriced[0])).toBe(true);
    const text = summary(res, { live: false });
    expect(text).toContain(`| \`${unpriced[0]}\` | no priced coin: not swept by this job |`);
    expect(text).toContain("0 are under the floor and wait");
    expect(text).toContain("A pool with no SOL, USDC, USDT or island coin has no price here, so this job never sweeps it: its shares wait for a hand collect.");
    expect(seen.find((s) => s.url.includes("jup.ag")).url).not.toContain(a);
    expect(res.ok).toBe(true);
  });

  it("the island coins' prices come from Jupiter's keyless host only, never with the site's key", async () => {
    const seen = [];
    const before = process.env.JUPITER_API_KEY;
    process.env.JUPITER_API_KEY = "the-site-key";
    try {
      const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
      await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }, seen), env: { JUPITER_API_KEY: "the-site-key" }, log: quiet });
    } finally {
      if (before === undefined) delete process.env.JUPITER_API_KEY;
      else process.env.JUPITER_API_KEY = before;
    }
    const jup = seen.filter((s) => s.url.includes("jup.ag"));
    expect(jup.length).toBe(1);
    expect(new URL(jup[0].url).host).toBe("lite-api.jup.ag");
    expect(JSON.stringify(jup[0].init?.headers ?? {})).not.toMatch(/x-api-key|the-site-key/i);
    expect(new URL(jup[0].url).searchParams.get("ids").split(",").sort()).toEqual(ISLAND_COINS.map((c) => c.mint).sort());
  });

  // ── Decimals ───────────────────────────────────────────────────────────────
  it("a coin that claims more than 100 decimals is shown, not thrown on", async () => {
    const many = key();
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: many, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 9, decimals1: 255, protocol: [51_216_483n, 5n], fund: [0n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.pools[0].error).toBeUndefined();
    expect(res.pools[0].venue.share).toBe(`0.051216483 of ${SOL_MINT} + 0 of ${many}`);
    expect(res.pools[0].venue.result).toMatch(/simulated clean/);
    expect(res.ok).toBe(true);
  });

  // ── Each side goes by its share as it stands, read with its accounts ────────
  const solBayla = (protocol, fund = [0n, 0n]) => poolBytes({ ammConfig: tierKey, vault0, vault1, mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol, fund });
  /** `chain.call`, with `then(method)` run after each call it answers: the chain as it changes meanwhile. */
  const changing = (chain, then) => async (method, params) => {
    const r = await chain.call(method, params);
    then(method);
    return r;
  };

  it("a share swept or collected since the listing is not sent for again: nothing is simulated, sent or opened for that side, and its row shows the share as it stands", async () => {
    const kp = Keypair.generate();
    const address = key();
    const pools = [[address, solBayla([51_216_483n, 7_000_000_000n], [23_051_592n, 3_683_000_000n])]];
    // The vault still lacks its BAYLA account: nothing is opened for a sweep that would move nothing.
    const chain = fakeChain({ pools, tiers, accounts: { ...accountsOf(VAULT, [SOL_BAYLA[0]]), ...opened(WORKSHOP) } });
    // Once listed, the venue's share is swept by someone else.
    const call = changing(chain, (m) => m === "getProgramAccounts" && (pools[0] = [address, solBayla([0n, 0n], [23_051_592n, 3_683_000_000n])]));
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["island"]]);
    expect(chain.sentTxs().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["island"]]);
    expect(res.pools[0].venue).toEqual({ share: `0 of ${SOL_MINT} + 0 of ${BAYLA}`, ok: true, result: "nothing set aside" });
    expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_ISLAND}` });
    expect(res.paid).toMatchObject({ opened: 0, rent: 0, sweeps: 1 });
    expect(res.ok).toBe(true);
  });

  it("the island's side too goes by its share as it stands: a share the island collected since the listing is not simulated for, and its row says so", async () => {
    const address = key();
    const pools = [[address, solBayla([51_216_483n, 0n], [23_051_592n, 0n])]];
    const chain = fakeChain({ pools, tiers, accounts: opened(VAULT, WORKSHOP) });
    // Once listed, the island collects its share by hand.
    const call = changing(chain, (m) => m === "getProgramAccounts" && (pools[0] = [address, solBayla([51_216_483n, 0n])]));
    const res = await run(parseArgs(["--payer", payer]), { call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    expect(res.pools[0].island).toEqual({ share: `0 of ${SOL_MINT} + 0 of ${BAYLA}`, ok: true, result: "nothing set aside" });
    expect(res.ok).toBe(true);
  });

  it("a share that fell under the floor since the listing waits, and its row shows the share as it stands", async () => {
    const address = key();
    const pools = [[address, solBayla([51_216_483n, 0n])]];
    const chain = fakeChain({ pools, tiers, accounts: opened(VAULT, WORKSHOP) });
    const call = changing(chain, (m) => m === "getProgramAccounts" && (pools[0] = [address, solBayla([1_000n, 0n])]));
    const res = await run(parseArgs(["--payer", payer]), { call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated()).toEqual([]);
    expect(res.pools[0].venue).toEqual({ share: `0.000001 of ${SOL_MINT} + 0 of ${BAYLA}`, ok: true, result: "under the $0.5 floor: waits" });
    expect(res.ok).toBe(true);
  });

  it("a pool that cannot be read again is an error on its own row, and nothing is simulated for it", async () => {
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const call = async (method, params) => {
      const r = await chain.call(method, params);
      return method === "getMultipleAccounts" && params[0].includes(big[0]) ? { value: r.value.map((v, i) => (i === r.value.length - 1 ? null : v)) } : r;
    };
    const res = await run(parseArgs(["--payer", payer]), { call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.pools[0].error).toBe(`the pool ${big[0]} could not be read again`);
    expect(chain.simulated()).toEqual([]);
    expect(res.ok).toBe(false);
  });

  it("a dry run reads each pool and its accounts once: nothing is sent, so nothing can change in between", async () => {
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const reads = chain.calls.filter((c) => c.method === "getMultipleAccounts" && c.params[0].includes(big[0]));
    expect(reads.map((c) => c.params[0])).toEqual([[...vaultAccounts, ...workshopAccounts, vault0, vault1, big[0]]]);
  });

  // After the venue's sweep is sent, the island's accounts and the pool are read again.
  for (const c of [
    {
      what: "a delegate the Workshop's BAYLA account took meanwhile holds the island's side back, named, with nothing more simulated",
      change: (f) => (f.accounts[workshopAccounts[1]] = tokenAccount({ mint: BAYLA, owner: WORKSHOP, program: TOKEN_2022_PROGRAM, delegate: true })),
      island: () => ({ ok: true, heldBack: true, result: `held back, nothing sent: its account \`${workshopAccounts[1]}\` for ${BAYLA} has a delegate` }),
      sims: [["venue"]],
    },
    {
      what: "a Workshop account handed to another owner meanwhile holds the island's side back, named, with nothing more simulated",
      change: (f) => (f.accounts[workshopAccounts[0]] = tokenAccount({ mint: SOL_MINT, owner: VAULT, program: TOKEN_PROGRAM })),
      island: () => ({ ok: true, heldBack: true, result: `held back, nothing sent: its account \`${workshopAccounts[0]}\` for ${SOL_MINT} has been handed to \`${VAULT}\`` }),
      sims: [["venue"]],
    },
    {
      what: "a share the island collected meanwhile is not sent for, and its row shows the share as it stands",
      // The venue's sweep has landed, and the island collected its share by hand.
      change: (f, pools) => (pools[0] = [f.pool[0], poolBytes({ ammConfig: tierKey, vault0: f.own[0], vault1: f.own[1], mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM })]),
      island: () => ({ share: `0 of ${SOL_MINT} + 0 of ${BAYLA}`, ok: true, result: "nothing set aside" }),
      sims: [["venue"]],
    },
    {
      what: "a pool account frozen meanwhile leaves its coin in the pool for the island, named, and the island's side sweeps the other coin",
      change: (f) => (f.accounts[f.own[1]] = tokenAccount({ mint: BAYLA, owner: authority, program: TOKEN_2022_PROGRAM, frozen: true })),
      island: (f) => ({ ok: true, swept: true, left: [BAYLA], result: `swept 0.023051592 of ${SOL_MINT} only, and 3,683 of ${BAYLA} is left in the pool; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen` }),
      sims: [["venue"], ["island"]],
    },
  ]) {
    it(`after the venue's sweep is sent, the island's side is read again: ${c.what}`, async () => {
      const kp = Keypair.generate();
      const f = legPool({ ...BOTH });
      const pools = [f.pool];
      const chain = fakeChain({ pools, tiers, accounts: f.accounts });
      let sent = 0;
      const call = changing(chain, (m) => m === "sendTransaction" && sent++ === 0 && c.change(f, pools));
      const res = await run(parseArgs(["--live"]), { call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: live(kp), log: quiet, wait: async () => {} });
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual(c.sims);
      expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_VENUE}` });
      const want = c.island(f);
      if (want.share) expect(res.pools[0].island).toEqual(want);
      else expect(res.pools[0].island).toMatchObject(want);
      // The second read: the Workshop's two, the pool's own two, and the pool.
      const reads = chain.calls.filter((r) => r.method === "getMultipleAccounts" && r.params[0].includes(f.pool[0]));
      expect(reads.map((r) => r.params[0])).toEqual([[...vaultAccounts, ...workshopAccounts, ...f.own, f.pool[0]], [...workshopAccounts, ...f.own, f.pool[0]]]);
      expect(res.ok).toBe(true);
    });
  }

  it("an error in the island's second read stays on the island's row; the venue's sweep keeps its record", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), fail: (m, p) => (m === "getMultipleAccounts" && p[0].length === 5 ? rpcError(m, -32005, "Node is behind by 200 slots") : null) });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true });
    expect(res.pools[0].island).toMatchObject({ ok: false, result: expect.stringMatching(/^error: getMultipleAccounts: .*Node is behind/) });
    expect(chain.sentTxs().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    expect(res.ok).toBe(false);
  });

  // ── After a send ───────────────────────────────────────────────────────────
  it("a sweep that failed on chain is said so and fails the run", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 1 }] } }] });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    for (const side of ["venue", "island"]) expect(res.pools[0][side]).toMatchObject({ ok: false, result: "sent, and it failed on chain" });
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
    // A failed transaction still paid its fee.
    expect(summary(res, { live: true })).toContain("2 sweeps seen on chain (10,000 lamports of network fees)");
  });

  it("a sweep that failed on chain opened nothing: its accounts and their rent are not counted as paid", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(WORKSHOP), statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 1 }] } }] });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.pools[0].created).toBe(2);
    expect(res.paid).toMatchObject({ opened: 0, rent: 0, sweeps: 2 });
    expect(summary(res, { live: true })).toContain("Paid by the key: 0 accounts opened for the vault (0 lamports of rent, which stays the vault's); 2 sweeps seen on chain");
  });

  // ── Each landed sweep's row is written from its own FeesSwept on chain (the owner's ruling, 2026-11-21) ──
  it("a landed sweep is read back at confirmed, as JSON, up to version 1, and its row says what its own FeesSwept says moved and was left, though the read before the send said otherwise", async () => {
    const kp = Keypair.generate();
    const f = legPool({ ...BOTH });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts });
    // Once the venue's sweep is simulated, the pool's own BAYLA account is frozen: the program leaves BAYLA.
    const call = changing(chain, (m) => m === "simulateTransaction" && (f.accounts[f.own[1]] = tokenAccount({ mint: BAYLA, owner: authority, program: TOKEN_2022_PROGRAM, frozen: true })));
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: live(kp), log: quiet, wait: async () => {} });
    const sent = chain.sentTxs();
    expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(chain.calls.filter((c) => c.method === "getTransaction").map((c) => c.params)).toEqual(
      sent.map((tx) => [sigOfTx(tx), { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }])
    );
    expect(res.pools[0].venue).toMatchObject({
      ok: true,
      swept: true,
      signature: sigOfTx(sent[0]),
      event: { moved: [51_216_483n, 0n], left: [0n, 7_000_000_000n] },
      left: [BAYLA],
      result: `swept 0.051216483 of ${SOL_MINT} only, and 7,000 of ${BAYLA} is left in the pool`,
    });
    // The island's side, read again, sees the freeze itself and names it.
    expect(res.pools[0].island).toMatchObject({ ok: true, event: { moved: [23_051_592n, 0n], left: [0n, 3_683_000_000n] }, left: [BAYLA], result: `swept 0.023051592 of ${SOL_MINT} only, and 3,683 of ${BAYLA} is left in the pool; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen` });
    expect(res.ok).toBe(true);
    expect(summary(res, { live: true })).toContain(`| swept 0.051216483 of ${SOL_MINT} only, and 7,000 of ${BAYLA} is left in the pool \`${sigOfTx(sent[0])}\` |`);
  });

  it("a landed sweep whose record moved nothing says so: nothing set aside by then, or every coin left", async () => {
    const kp = Keypair.generate();
    for (const [left, says, mints] of [
      [[0n, 0n], "swept nothing", undefined],
      [[51_216_483n, 7_000_000_000n], `swept nothing: 0.051216483 of ${SOL_MINT} and 7,000 of ${BAYLA} are left in the pool`, [SOL_MINT, BAYLA]],
    ]) {
      let venueSig = null;
      const chain = fakeChain({
        pools: [big],
        tiers,
        accounts: opened(VAULT, WORKSHOP),
        txAnswer: (sig, tx) => ((venueSig ??= sig) === sig ? { ...tx, meta: { ...tx.meta, logMessages: invoked(VENUE_PROGRAM, [sweptLine({ pool: big[0], fund: false, owner: VAULT, moved: [0n, 0n], left })]) } } : tx),
      });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, event: { moved: [0n, 0n], left }, result: says });
      expect(res.pools[0].venue.left).toEqual(mints);
      expect(res.ok).toBe(true);
    }
  });

  // What cannot be read back keeps the counts read before the send, is named, and fails the run: its signature is to be looked up.
  for (const c of [
    { why: "the chain never returns it", answer: () => null, says: "the chain did not return it after 5 reads", reads: 5 },
    { why: "the RPC refuses the read", fail: (m) => (m === "getTransaction" ? rpcError(m, -32603, "Internal error") : null), says: /^it could not be read: getTransaction: .*Internal error/ },
    { why: "the chain says it failed", answer: (tx) => ({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, { Custom: 1 }] } } }), says: 'the chain says it failed: {"InstructionError":[0,{"Custom":1}]}' },
    { why: "it shows no FeesSwept", logs: () => invoked(VENUE_PROGRAM, ["Program log: Instruction: SweepFees"]), says: "it shows 0 FeesSwept printed by the pool program in its own call, not one" },
    { why: "its FeesSwept is printed by a program the sweep calls", logs: (line) => invoked(VENUE_PROGRAM, ["Program log: Instruction: SweepFees", ...invoked(key(), [line], 2)]), says: "it shows 0 FeesSwept printed by the pool program in its own call, not one" },
    { why: "its FeesSwept is printed by the pool program in a deeper call", logs: (line) => invoked(VENUE_PROGRAM, invoked(VENUE_PROGRAM, [line], 2)), says: "it shows 0 FeesSwept printed by the pool program in its own call, not one" },
    { why: "its FeesSwept is printed by another instruction", logs: (line) => [...invoked(key(), [line]), ...invoked(VENUE_PROGRAM, ["Program log: Instruction: SweepFees"])], says: "it shows 0 FeesSwept printed by the pool program in its own call, not one" },
    { why: "it shows two FeesSwept", logs: (line) => invoked(VENUE_PROGRAM, [line, line]), says: "it shows 2 FeesSwept printed by the pool program in its own call, not one" },
    { why: "its FeesSwept is of another pool", event: (e) => ({ ...e, pool: VAULT }), says: `its FeesSwept is of the pool ${VAULT}, the protocol owner's side and ${VAULT}` },
    { why: "its FeesSwept is of the other side", event: (e) => ({ ...e, fund: true }), says: `the fund owner's side and ${VAULT}` },
    { why: "its FeesSwept names another owner", event: (e) => ({ ...e, owner: WORKSHOP }), says: `the protocol owner's side and ${WORKSHOP}` },
  ]) {
    it(`a landed sweep that cannot be read back (${c.why}) keeps the counts read before the send, is named "not read back" with its signature, and fails the run; the other side is still sent and read`, async () => {
      const kp = Keypair.generate();
      let venueSig = null;
      const chain = fakeChain({
        pools: [big],
        tiers,
        accounts: opened(VAULT, WORKSHOP),
        // Only the venue's sweep, the first one read back, is answered otherwise.
        fail: (m, p) => {
          if (!c.fail || m !== "getTransaction") return null;
          venueSig ??= p[0];
          return p[0] === venueSig ? c.fail(m, p) : null;
        },
        txAnswer: (sig, tx) => {
          venueSig ??= sig;
          if (sig !== venueSig) return tx;
          if (c.answer) return c.answer(tx);
          const line = c.event ? sweptLine(c.event({ pool: big[0], fund: false, owner: VAULT, moved: [51_216_483n, 7_000_000_000n], left: [0n, 0n] })) : tx.meta.logMessages.find((l) => l.startsWith("Program data: "));
          return { ...tx, meta: { ...tx.meta, logMessages: c.logs ? c.logs(line) : invoked(VENUE_PROGRAM, ["Program log: Instruction: SweepFees", line]) } };
        },
      });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      const sent = chain.sentTxs();
      expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
      const venue = res.pools[0].venue;
      expect(venue).toMatchObject({ ok: false, sent: true, swept: true, fee: true, signature: sigOfTx(sent[0]) });
      expect(venue.event).toBeUndefined();
      if (typeof c.says === "string") expect(venue.notReadBack.endsWith(c.says)).toBe(true);
      else expect(venue.notReadBack).toMatch(c.says);
      expect(venue.result).toBe(`swept ${BIG_VENUE}, by the counts read before the send: not read back (${venue.notReadBack}), so look its signature up`);
      if (c.reads) expect(chain.calls.filter((x) => x.method === "getTransaction" && x.params[0] === sigOfTx(sent[0])).length).toBe(c.reads);
      expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, signature: sigOfTx(sent[1]), result: `swept ${BIG_ISLAND}` });
      expect(res.paid.sweeps).toBe(2);
      expect(res.ok).toBe(false);
      expect(exitCode(res)).toBe(1);
      expect(summary(res, { live: true })).toContain(`not read back (${venue.notReadBack}), so look its signature up \`${sigOfTx(sent[0])}\``);
    });
  }

  it("a sweep whose read back is cut by the run's time limit is said as not read back, and the other side is not tried", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    let t = 0;
    const call = async (method, params) => {
      const r = await chain.call(method, params);
      if (method === "getSignatureStatuses") t = RUN_LIMIT_MS + 1;
      return r;
    };
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {}, now: () => t });
    expect(res.pools[0].venue).toMatchObject({ ok: false, swept: true, notReadBack: "the run stopped before it was read" });
    expect(chain.calls.some((c) => c.method === "getTransaction")).toBe(false);
    expect(res.pools[0].island.result).toBe("not tried: the run stopped early");
    expect(res.ok).toBe(false);
  });

  it("a landed sweep the chain returns only on its third read is read back then, the reads 1.5 seconds apart, and its row is its own event's", async () => {
    const kp = Keypair.generate();
    let asked = 0;
    let venueSig = null;
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), txAnswer: (sig, tx) => ((venueSig ??= sig) === sig && ++asked < 3 ? null : tx) });
    const waits = [];
    let last = "";
    const call = async (method, params) => {
      last = method;
      return chain.call(method, params);
    };
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async (ms) => waits.push([last, ms]) });
    const sent = chain.sentTxs();
    expect(chain.calls.filter((c) => c.method === "getTransaction" && c.params[0] === sigOfTx(sent[0])).length).toBe(3);
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, event: { moved: [51_216_483n, 7_000_000_000n], left: [0n, 0n] }, result: `swept ${BIG_VENUE}` });
    expect(res.pools[0].venue.notReadBack).toBeUndefined();
    // Between the reads of one transaction: 1.5 seconds each, and none before the first.
    expect(waits.filter(([after]) => after === "getTransaction")).toEqual([
      ["getTransaction", 1500],
      ["getTransaction", 1500],
    ]);
    expect(res.ok).toBe(true);
  });

  it("an island sweep that cannot be read back fails the run as the venue's does, and its row keeps the counts read before the send", async () => {
    const kp = Keypair.generate();
    const seen = [];
    // Only the island's sweep, the second one read back, is never returned.
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), txAnswer: (sig, tx) => ((seen.includes(sig) || seen.push(sig)) && seen.indexOf(sig) === 1 ? null : tx) });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    const sent = chain.sentTxs();
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_VENUE}` });
    expect(res.pools[0].island).toMatchObject({
      ok: false,
      swept: true,
      fee: true,
      signature: sigOfTx(sent[1]),
      notReadBack: "the chain did not return it after 5 reads",
      result: `swept ${BIG_ISLAND}, by the counts read before the send: not read back (the chain did not return it after 5 reads), so look its signature up`,
    });
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
  });

  it("a sweep that leaves a frozen coin and cannot be read back says what the read before the send said: the coin left is never called swept, and stays listed", async () => {
    const kp = Keypair.generate();
    const f = legPool({ ...BOTH, frozen: { pool: [1] } });
    const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts, txAnswer: () => null });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: live(kp), log: quiet, wait: async () => {} });
    for (const [side, moves, left] of [
      ["venue", `0.051216483 of ${SOL_MINT}`, `7,000 of ${BAYLA}`],
      ["island", `0.023051592 of ${SOL_MINT}`, `3,683 of ${BAYLA}`],
    ]) {
      const s = res.pools[0][side];
      expect(s).toMatchObject({ ok: false, swept: true, left: [BAYLA], notReadBack: "the chain did not return it after 5 reads" });
      expect(s.event).toBeUndefined();
      expect(s.result).toBe(`swept ${moves} only, and ${left} is left in the pool, by the counts read before the send: not read back (the chain did not return it after 5 reads), so look its signature up; the pool's own account \`${f.own[1]}\` for ${BAYLA} is frozen`);
    }
    expect(res.ok).toBe(false);
  });

  it("on a test chain, a landed sweep is read back from the record that the program the run names printed", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--live", "--program", key()]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, event: { moved: [51_216_483n, 7_000_000_000n], left: [0n, 0n] }, result: `swept ${BIG_VENUE}` });
    expect(res.pools[0].island).toMatchObject({ ok: true, swept: true, result: `swept ${BIG_ISLAND}` });
    expect(res.ok).toBe(true);
  });

  it("a sweep not confirmed after 40 looks, its blockhash still good at the last one, is said so, never as expired, and fails the run", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [null] });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    for (const side of ["venue", "island"]) {
      expect(res.pools[0][side]).toMatchObject({ ok: false, signature: expect.any(String), result: "sent, but not confirmed after 40 looks, though its blockhash had not expired at the last one: look its signature up" });
    }
    expect(chain.calls.filter((c) => c.method === "getSignatureStatuses").length).toBe(80);
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
  });

  it("a sweep still unseen once its blockhash has expired is given up after that look, and fails the run", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [null], blockHeight: 1001 });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    for (const side of ["venue", "island"]) expect(res.pools[0][side].result).toBe("sent, but not seen on chain before its blockhash expired: tomorrow's run tries again");
    expect(chain.calls.filter((c) => c.method === "getSignatureStatuses").length).toBe(2);
    expect(res.ok).toBe(false);
  });

  // ── What counts as landed ──────────────────────────────────────────────────
  for (const c of [
    { statuses: [{ confirmationStatus: "processed", err: null }, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null }], looks: 3, why: "only processed twice, then confirmed" },
    { statuses: [{ confirmationStatus: "finalized", err: null }], looks: 1, why: "already finalized at the first look" },
  ]) {
    it(`a sweep is swept once the chain says confirmed or finalized (${c.why}): it is looked at ${c.looks} time${c.looks > 1 ? "s" : ""}, and its fee is counted`, async () => {
      const kp = Keypair.generate();
      const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n] })];
      const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP), statuses: c.statuses });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, result: `swept 0.051216483 of ${SOL_MINT}` });
      expect(chain.calls.filter((c2) => c2.method === "getSignatureStatuses").length).toBe(c.looks);
      expect(res.paid.sweeps).toBe(1);
      expect(res.ok).toBe(true);
    });
  }

  it("a sweep the chain has only processed is never written swept: after 40 looks it fails its row", async () => {
    const kp = Keypair.generate();
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [{ confirmationStatus: "processed", err: null }] });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.pools[0].venue).toMatchObject({ ok: false, result: "sent, but not confirmed after 40 looks, though its blockhash had not expired at the last one: look its signature up" });
    expect(res.pools[0].venue.swept).toBeUndefined();
    expect(res.paid.sweeps).toBe(0);
    expect(res.ok).toBe(false);
  });

  it("a send whose answer is lost and which then failed on chain is said so, keeps its fee, and fails the run", async () => {
    const kp = Keypair.generate();
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 1 }] } }] });
    let sends = 0;
    // The job's real transport: the send reaches the chain, and its answer is lost on the way back.
    const net = async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      let result;
      try {
        result = await chain.call(method, params);
      } catch (e) {
        if (e.rpcError) return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: e.rpcError }) };
        throw e;
      }
      if (method === "sendTransaction" && sends++ === 0) throw new Error("socket hang up");
      return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    };
    const call = solanaRpc({ fetchImpl: net, url: "http://rpc.invalid", pauseMs: 0, wait: async () => {} });
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.pools[0].venue).toMatchObject({ ok: false, sent: true, fee: true, result: expect.stringMatching(/^sent, and it failed on chain \(its send answered: sendTransaction: .*already been processed/) });
    expect(res.paid.sweeps).toBe(1);
    expect(res.ok).toBe(false);
  });

  // ── A dry run never signs ──────────────────────────────────────────────────
  it("a dry run never signs, even with the key present: it simulates the bare message as the key's address", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs([]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet });
    const sims = chain.calls.filter((c) => c.method === "simulateTransaction");
    expect(sims.length).toBe(2);
    for (const c of sims) {
      expect(c.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
      const tx = Transaction.from(Buffer.from(c.params[0], "base64"));
      expect(tx.feePayer.toBase58()).toBe(kp.publicKey.toBase58());
      expect(tx.signatures[0].signature).toBeNull(); // 64 zero bytes: no signature at all
    }
    expect(chain.calls.some((c) => c.method === "sendTransaction")).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("a live run simulates the same unsigned message a dry run does, signs only what it then sends, and its send keeps the RPC's own preflight", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.ok).toBe(true);
    const sims = chain.calls.filter((c) => c.method === "simulateTransaction");
    const sends = chain.calls.filter((c) => c.method === "sendTransaction");
    expect([sims.length, sends.length]).toEqual([2, 2]);
    sims.forEach((c, i) => {
      expect(c.params[1]).toEqual({ encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
      const simulated = Transaction.from(Buffer.from(c.params[0], "base64"));
      expect(simulated.signatures[0].signature).toBeNull(); // 64 zero bytes: no signature at all
      // The same message is what is signed and sent.
      expect(Buffer.from(simulated.serializeMessage())).toEqual(Buffer.from(Transaction.from(Buffer.from(sends[i].params[0], "base64")).serializeMessage()));
    });
    for (const c of sends) {
      expect(c.params[1]).toEqual({ encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 });
      expect(Transaction.from(Buffer.from(c.params[0], "base64")).verifySignatures()).toBe(true);
    }
    // The blockhash is a finalized one, which every node knows.
    const hashes = chain.calls.filter((c) => c.method === "getLatestBlockhash");
    expect(hashes.map((c) => c.params)).toEqual([[{ commitment: "finalized" }], [{ commitment: "finalized" }]]);
  });

  it("a live sweep not sent at the limit was never signed: no signed transaction reaches the RPC", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    let t = 0;
    const call = async (method, params) => {
      const r = await chain.call(method, params);
      if (method === "simulateTransaction") t = RUN_LIMIT_MS + 1;
      return r;
    };
    const res = await run(parseArgs(["--live"]), { call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {}, now: () => t });
    expect(res.pools[0].venue.result).toBe("not sent: the run stopped early");
    const handed = chain.calls.filter((c) => c.method === "simulateTransaction" || c.method === "sendTransaction");
    expect(handed.map((c) => c.method)).toEqual(["simulateTransaction"]);
    expect(Transaction.from(Buffer.from(handed[0].params[0], "base64")).signatures[0].signature).toBeNull();
  });

  // ── What the key paid ──────────────────────────────────────────────────────
  it("the summary says what the key paid and what it holds, from one balance read at the end", async () => {
    const kp = Keypair.generate();
    // The vault lacks its SOL account: the venue's sweep opens it.
    const accounts = { ...accountsOf(VAULT, [SOL_BAYLA[1]]), ...opened(WORKSHOP) };
    const chain = fakeChain({ pools: [big], tiers, accounts, rent: 1_488_440, balance: 42_000_000 });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.ok).toBe(true);
    expect(chain.calls.find((c) => c.method === "simulateTransaction").params[1].accounts).toEqual({ encoding: "base64", addresses: [vaultAccounts[0]] });
    const balances = chain.calls.map((c, i) => [c.method, i]).filter(([m]) => m === "getBalance");
    expect(balances.length).toBe(1);
    expect(balances[0][1]).toBe(chain.calls.length - 1);
    expect(chain.calls[balances[0][1]].params[0]).toBe(kp.publicKey.toBase58());
    const text = summary(res, { live: true });
    expect(text).toContain("Paid by the key: 1 account opened for the vault (1,488,440 lamports of rent");
    expect(text).toContain("2 sweeps seen on chain (10,000 lamports of network fees)");
    expect(text).toContain(`\`${kp.publicKey.toBase58()}\` holds 42,000,000 lamports`);
    expect(text).not.toContain("fund it");
    // A dry run says what a live run would pay.
    const dry = fakeChain({ pools: [big], tiers, accounts, rent: 1_488_440, balance: 7 });
    const res2 = await run(parseArgs(["--payer", payer]), { call: dry.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(summary(res2, { live: false })).toMatch(/A live run would pay: 1 account opened for the vault \(1,488,440 lamports of rent[^)]*\); 2 sweeps sent \(10,000 lamports of network fees\)/);
  });

  it("a dry run counts an account it would open once, though each pool's simulation opens it afresh", async () => {
    const big2 = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 7_000_000_000n], fund: [0n, 0n] })];
    const chain = fakeChain({ pools: [big, big2], tiers, accounts: opened(WORKSHOP), rent: 1_488_440 });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const opening = chain.simulated().filter((tx) => tx.instructions.some((i) => i.programId.toBase58() === ATA_PROGRAM));
    expect(opening.length).toBe(2); // each venue simulation opens the vault's two accounts
    expect(res.paid).toMatchObject({ opened: 2, rent: 2_976_880, sweeps: 3 });
    expect(summary(res, { live: false })).toContain("A live run would pay: 2 accounts opened for the vault (2,976,880 lamports of rent, which stays the vault's); 3 sweeps sent (15,000 lamports of network fees)");
  });

  it("an opened account's rent that the simulation did not return is said as not read, never as 0", async () => {
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(WORKSHOP), simAccounts: false });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.paid).toMatchObject({ opened: 2, rent: null });
    expect(summary(res, { live: false })).toContain("2 accounts opened for the vault (its rent not read)");
  });

  it("the summary says when the payer holds less than one more sweep that opens one vault account needs: what it must keep, the rent of the largest account a coin here takes, and the fee", async () => {
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), balance: 2_169_079 });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    // A Token-2022 account of 170 bytes: 1,513,840 lamports on mainnet today, against 1,488,440 for a classic one.
    expect(chain.calls.filter((c) => c.method === "getMinimumBalanceForRentExemption").map((c) => c.params)).toEqual([[0], [170]]);
    const text = summary(res, { live: false });
    expect(text).toContain(`\`${payer}\` holds 2,169,079 lamports.`);
    expect(text).toContain("That is under the 2,169,080 lamports one more sweep that opens one vault account needs (650,240 the payer must keep, 1,513,840 of rent and 5,000 of fee): fund it.");
    const rich = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), balance: 2_169_080 });
    const res2 = await run(parseArgs(["--payer", payer]), { call: rich.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(summary(res2, { live: false })).not.toContain("fund it");
  });

  // ── The reads at the end, inside the time limit only ───────────────────────
  it("once the run is past its time limit, no read is made at the end: the run passes and the summary says the balance was not read", async () => {
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n] })];
    const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP) });
    let t = 0;
    // The last pool's simulation answers past the limit: no pool is left, so the run itself is done.
    const call = async (method, params) => {
      const r = await chain.call(method, params);
      if (method === "simulateTransaction") t = RUN_LIMIT_MS + 1;
      return r;
    };
    const res = await run(parseArgs(["--payer", payer]), { call, fetchImpl: noPrice, env: {}, log: quiet, now: () => t });
    expect(res.pools[0].venue.result).toMatch(/simulated clean/);
    expect(chain.calls.some((c) => c.method === "getMinimumBalanceForRentExemption" || c.method === "getBalance")).toBe(false);
    expect(res).toMatchObject({ ok: true, stopped: null, keep: null, balance: null, balanceError: null });
    expect(summary(res, { live: false })).toContain(`The balance of \`${payer}\` was not read.`);
  });

  it("an end read the RPC leaves unanswered is the last one made: the run still returns, and the summary says the balance was not read", async () => {
    const chain = fakeChain({ pools: [], tiers, accounts: {} });
    const asked = [];
    const call = async (method, params) => {
      asked.push(method);
      if (method === "getMinimumBalanceForRentExemption") throw new Error(`${method}: no answer after 8 tries (socket hang up)`);
      return chain.call(method, params);
    };
    const res = await run(parseArgs(["--payer", payer, "--program", key()]), { call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(asked).toEqual(["getProgramAccounts", "getMinimumBalanceForRentExemption"]);
    expect(res).toMatchObject({ ok: true, keep: null, balance: null, balanceError: null });
    expect(summary(res, { live: false })).toContain(`The balance of \`${payer}\` was not read.`);
  });

  it("a balance read or a rent read the RPC refuses never stops the run: the sweeps already done keep their record, and the summary says what could not be read", async () => {
    const kp = Keypair.generate();
    for (const refuse of ["getBalance", "getMinimumBalanceForRentExemption"]) {
      const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), fail: (m) => (m === refuse ? rpcError(m, -32603, "Internal error") : null) });
      const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
      expect(res.pools[0]).toMatchObject({ venue: { swept: true }, island: { swept: true } });
      expect(res.ok).toBe(true);
      const text = summary(res, { live: true });
      expect(text).toContain("2 sweeps seen on chain (10,000 lamports of network fees)");
      if (refuse === "getBalance") {
        expect(res.balanceError).toMatch(/Internal error/);
        expect(text).toContain(`The balance of \`${kp.publicKey.toBase58()}\` could not be read.`);
      } else {
        expect(res.keep).toBeNull();
        expect(text).toContain(`\`${kp.publicKey.toBase58()}\` holds 987,654,321 lamports.`);
      }
    }
  });

  it("a refusal's log lines are joined with '; ', and a '|' in any cell cannot break the summary's table", async () => {
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      simErr: (tx) => (sweepsIn(tx).some((ix) => sideOf(ix) === "venue") ? { InstructionError: [0, { Custom: 6018 }] } : null),
      simLogs: ["Program log: one | two", "Program log: three\nfour", "Program log: failed"],
    });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.pools[0].venue.result).toContain("Program log: one | two; Program log: three\nfour; Program log: failed");
    const line = summary(res, { live: false })
      .split("\n")
      .find((l) => l.includes(big[0]));
    expect(line.split(/(?<!\\)\|/).length).toBe(8); // six cells between seven pipes
    expect(line).toContain("one \\| two; Program log: three four;");
    expect(line).toMatch(/simulated clean/);
  });

  it("a backslash in any cell is escaped too, so a '\\|' in a refusal's logs cannot break the summary's table", async () => {
    const chain = fakeChain({
      pools: [big],
      tiers,
      accounts: opened(VAULT, WORKSHOP),
      simErr: (tx) => (sweepsIn(tx).some((ix) => sideOf(ix) === "venue") ? { InstructionError: [0, { Custom: 6018 }] } : null),
      simLogs: ["Program log: one \\| two", "Program log: a \\ b"],
    });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res.pools[0].venue.result).toContain("Program log: one \\| two; Program log: a \\ b");
    const line = summary(res, { live: false })
      .split("\n")
      .find((l) => l.includes(big[0]));
    // In a table a "|" ends a cell unless an odd number of backslashes stands before it.
    expect(line.split(/(?<!\\)(?:\\\\)*\|/).length).toBe(8); // six cells between seven pipes
    expect(line).toContain("one \\\\\\| two; Program log: a \\\\ b");
  });

  it("the summary's table keeps a pool whose sides only wait or are held back, each with its account named, though the run passes", async () => {
    // The pool's own SOL account frozen and each side owed only SOL: both wait, and nothing is sent.
    const waiting = legPool({ protocol: [51_216_483n, 0n], fund: [23_051_592n, 0n], frozen: { pool: [0] } });
    // The Workshop's BAYLA account with a delegate: the island's side is held back, the venue's has nothing set aside.
    const held = legPool({ protocol: [0n, 0n], fund: [23_051_592n, 0n] });
    const heldAccounts = { ...held.accounts, [workshopAccounts[1]]: tokenAccount({ mint: BAYLA, owner: WORKSHOP, program: TOKEN_2022_PROGRAM, delegate: true }) };
    const chain = fakeChain({ pools: [waiting.pool, held.pool], tiers, accounts: { ...waiting.accounts, ...heldAccounts } });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(chain.simulated()).toEqual([]);
    expect(res.ok).toBe(true);
    const lines = summary(res, { live: false }).split("\n");
    const row = (p) => lines.find((l) => l.startsWith(`| \`${p[0]}\` |`));
    expect(row(waiting.pool)).toContain(`waits, nothing sent: 0.051216483 of ${SOL_MINT} is left in the pool; the pool's own account \`${waiting.own[0]}\` for ${SOL_MINT} is frozen`);
    expect(row(held.pool)).toContain(`held back, nothing sent: its account \`${workshopAccounts[1]}\` for ${BAYLA} has a delegate`);
  });

  it("the summary's totals count the pools with nothing set aside and those under the floor, and its heading says live or dry run", async () => {
    const nothingPool = () => [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM })];
    const dustPool = () => [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [10_000n, 1n], fund: [5_000n, 1n] })];
    const chain = fakeChain({ pools: [nothingPool(), dustPool(), nothingPool(), dustPool(), dustPool()], tiers });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const text = summary(res, { live: false });
    expect(text).toContain("\n2 pools have nothing set aside; 3 are under the floor and wait.\n");
    expect(text.split("\n")[0]).toBe("### Venue sweep (dry run)");
    expect(summary(res, { live: true }).split("\n")[0]).toBe("### Venue sweep (live)");
  });

  it("when Jupiter cannot be read, the summary names the island coins with no price and says why, and the run stays green (the owner's ruling, 2026-11-21)", async () => {
    const down = async (url) => (/jup\.ag\/price\/v3/.test(url) ? { ok: false, status: 503, json: async () => ({}) } : priced(72)(url));
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: down, env: {}, log: quiet });
    expect(res.prices.islandError).toBe("no island coin price could be read (lite-api.jup.ag HTTP 503)");
    expect(summary(res, { live: false })).toContain("No price today for BAYLA (no island coin price could be read (lite-api.jup.ag HTTP 503)): their shares counted as nothing against the floor.");
    expect(res.ok).toBe(true);
    expect(exitCode(res)).toBe(0);
  });

  // ── Three rules the suite held only in part ────────────────────────────────
  for (const c of [
    { why: "failed on chain", statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 1 }] } }, { confirmationStatus: "confirmed", err: null }], venue: /^sent, and it failed on chain$/ },
    { why: "was not confirmed after its 40 looks", statuses: [...Array(40).fill({ confirmationStatus: "processed", err: null }), { confirmationStatus: "confirmed", err: null }], venue: /^sent, but not confirmed after 40 looks/ },
  ]) {
    it(`the island's side is read again after a venue sweep that was sent and ${c.why}, not only after one that landed`, async () => {
      const kp = Keypair.generate();
      const f = legPool({ ...BOTH });
      const chain = fakeChain({ pools: [f.pool], tiers, accounts: f.accounts, statuses: c.statuses });
      let sent = 0;
      // While the venue's sweep is out, the Workshop's BAYLA account takes a delegate.
      const call = changing(chain, (m) => m === "sendTransaction" && sent++ === 0 && (f.accounts[workshopAccounts[1]] = tokenAccount({ mint: BAYLA, owner: WORKSHOP, program: TOKEN_2022_PROGRAM, delegate: true })));
      const res = await run(parseArgs(["--live"]), { call, fetchImpl: priced(72, { [BAYLA]: 0.001 }), env: live(kp), log: quiet, wait: async () => {} });
      expect(res.pools[0].venue).toMatchObject({ ok: false, signature: expect.any(String), result: expect.stringMatching(c.venue) });
      expect(res.pools[0].venue.swept).toBeUndefined();
      const reads = chain.calls.filter((r) => r.method === "getMultipleAccounts" && r.params[0].includes(f.pool[0]));
      expect(reads.map((r) => r.params[0])).toEqual([[...vaultAccounts, ...workshopAccounts, ...f.own, f.pool[0]], [...workshopAccounts, ...f.own, f.pool[0]]]);
      expect(res.pools[0].island).toMatchObject({ ok: true, heldBack: true, result: `held back, nothing sent: its account \`${workshopAccounts[1]}\` for ${BAYLA} has a delegate` });
      expect(chain.sentTxs().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"]]);
    });
  }

  for (const amount of [null, "0", "", "-5"]) {
    it(`a SOL price of ${JSON.stringify(amount)} is no price: the 0.007 SOL stand-in decides, and the summary says SOL's price was not read`, async () => {
      // 0.03 SOL: over the 0.007 SOL that stands in for $0.50. At a price of $0 it would count as nothing and wait.
      const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [30_000_000n, 0n] })];
      const chain = fakeChain({ pools: [pool], tiers, accounts: opened(VAULT, WORKSHOP) });
      const zero = async (url) => (url.startsWith("https://api.coinbase.com/") ? { ok: true, json: async () => ({ data: { amount } }) } : priced(null)(url));
      const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: zero, env: {}, log: quiet });
      expect(res.prices.sol).toBeNull();
      expect(res.pools[0].venue.result).toMatch(/simulated clean/);
      expect(summary(res, { live: false })).toContain("SOL's price was not read today, so 0.007 SOL stood in for the $0.5 floor.");
    });
  }

  it("an end read the RPC leaves unanswered does not mark the run as stopped early", async () => {
    const chain = fakeChain({ pools: [], tiers, accounts: {} });
    const call = async (method, params) => {
      if (method === "getMinimumBalanceForRentExemption") throw new Error(`${method}: no answer after 8 tries (socket hang up)`);
      return chain.call(method, params);
    };
    const res = await run(parseArgs(["--payer", payer, "--program", key()]), { call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(res).toMatchObject({ ok: true, stopped: null });
    expect(summary(res, { live: false })).not.toContain("The run stopped early");
  });
});

describe("venue-sweep: the process, as the workflow runs it", () => {
  const script = join(here, "venue-sweep.mjs");
  // Price reads never leave this machine: only the local stub RPC below can be reached.
  const offline = `data:text/javascript,${encodeURIComponent('const f = globalThis.fetch; globalThis.fetch = (u, i) => (String(u).startsWith("http://127.0.0.1:") ? f(u, i) : Promise.reject(new Error("no network in this test")));')}`;

  /** The job as a process, against a local stub RPC answering from `chain`, with GITHUB_STEP_SUMMARY set: its exit code, output and summary file. */
  async function runJob(args, { chain, env = {} }) {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        const { id, method, params } = JSON.parse(body);
        let out;
        try {
          out = { jsonrpc: "2.0", id, result: await chain.call(method, params) };
        } catch (e) {
          out = { jsonrpc: "2.0", id, error: e.rpcError ?? { code: -32603, message: e.message } };
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const dir = mkdtempSync(join(tmpdir(), "venue-sweep-"));
    const file = join(dir, "summary.md");
    try {
      const childEnv = { ...process.env };
      delete childEnv.VENUE_SWEEPER_KEYPAIR;
      delete childEnv.JUPITER_API_KEY;
      Object.assign(childEnv, { GITHUB_STEP_SUMMARY: file }, env);
      const child = spawn(process.execPath, ["--import", offline, script, "--rpc", `http://127.0.0.1:${server.address().port}`, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const code = await new Promise((r) => child.on("close", r));
      return { code, output, summary: existsSync(file) ? readFileSync(file, "utf8") : null };
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const payer = key();

  it("a run that fails exits 1 and still writes its summary", { timeout: 30_000 }, async () => {
    const chain = fakeChain({ pools: [], tiers: {}, fail: (m) => (m === "getProgramAccounts" ? rpcError(m, -32010, "excluded from account secondary indexes") : null) });
    const r = await runJob(["--payer", payer], { chain });
    expect(r.code).toBe(1);
    expect(r.summary).toMatch(/^### Venue sweep \(dry run\)\n/);
    expect(r.summary).toContain("The run stopped early (the pools could not be read: getProgramAccounts:");
  });

  it("a clean run exits 0 and writes its summary", { timeout: 30_000 }, async () => {
    const tierKey = key();
    const quietPool = () => [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM })];
    const chain = fakeChain({ pools: [quietPool(), quietPool()], tiers: { [tierKey]: tierBytes(VAULT, WORKSHOP) } });
    const r = await runJob(["--payer", payer], { chain });
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/^### Venue sweep \(dry run\)\n/);
    expect(r.summary).toContain("2 pools have nothing set aside; 0 are under the floor and wait.");
    expect(r.summary).toContain(`\`${payer}\` holds 987,654,321 lamports`);
  });

  it("on mainnet, a listing of no pool at all exits 1: the summary says the pools were not listed", { timeout: 30_000 }, async () => {
    const chain = fakeChain({ pools: [], tiers: {} });
    const r = await runJob(["--payer", payer], { chain });
    expect(r.code).toBe(1);
    expect(r.summary).toContain("The run stopped early (the pools could not be read: the RPC listed no pool, and mainnet's program has pools); the pools were not listed.");
    expect(chain.calls.map((c) => c.method)).toEqual(["getProgramAccounts"]);
  });

  it("a run that cannot start exits 1 and its summary says why, never echoing the key", { timeout: 30_000 }, async () => {
    const chain = fakeChain({ pools: [], tiers: {} });
    const noPayer = await runJob([], { chain });
    expect(noPayer.code).toBe(1);
    expect(noPayer.summary).toBe("### Venue sweep\n\nIt did not run: a dry run needs --payer <address> or VENUE_SWEEPER_KEYPAIR\n");
    const badKey = await runJob(["--live"], { chain, env: { VENUE_SWEEPER_KEYPAIR: "not-a-key-31337" } });
    expect(badKey.code).toBe(1);
    expect(badKey.summary).toContain("It did not run: the keypair is not JSON");
    expect(`${badKey.summary}${badKey.output}`).not.toContain("31337");
    expect(chain.calls).toEqual([]);
  });

  it("with the vault's USDC account frozen the job still sends the SOL, names the USDC as left in the pool, and exits 1", { timeout: 30_000 }, async () => {
    const tierKey = key();
    const coins = [
      [USDC_MINT, TOKEN_PROGRAM],
      [SOL_MINT, TOKEN_PROGRAM],
    ];
    const pool = [key(), poolBytes({ ammConfig: tierKey, vault0: key(), vault1: key(), mint0: USDC_MINT, mint1: SOL_MINT, program0: TOKEN_PROGRAM, program1: TOKEN_PROGRAM, decimals0: 6, decimals1: 9, protocol: [2_000_000n, 30_000_000n] })];
    const accounts = { ...accountsOf(VAULT, coins, { [USDC_MINT]: { frozen: true } }), ...accountsOf(WORKSHOP, coins) };
    const chain = fakeChain({ pools: [pool], tiers: { [tierKey]: tierBytes(VAULT, WORKSHOP) }, accounts });
    const r = await runJob(["--payer", payer], { chain });
    expect(r.code).toBe(1);
    expect(chain.calls.filter((c) => c.method === "simulateTransaction").length).toBe(1);
    const usdc = associatedTokenAddress(VAULT, USDC_MINT, TOKEN_PROGRAM);
    expect(r.summary).toContain(`a live run would send it, sweeping 0.03 of ${SOL_MINT} only, and 2 of ${USDC_MINT} is left in the pool; its account \`${usdc}\` for ${USDC_MINT} is frozen: read it`);
  });
});

describe("venue-sweep: the workflow", () => {
  const yml = readFileSync(join(here, "../../.github/workflows/venue-sweep.yml"), "utf8");
  /** The sweep step's script, as bash is given it. */
  const step = (() => {
    const lines = yml.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes("name: Sweep the pools' fee shares to their owners"));
    const from = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
    const indent = lines[from].indexOf("run:");
    const body = [];
    for (let i = from + 1; i < lines.length && (lines[i].trim() === "" || lines[i].length - lines[i].trimStart().length > indent); i++) body.push(lines[i]);
    const cut = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return body.map((l) => l.slice(cut)).join("\n");
  })();
  // Git's own bash on Windows, where the PATH's bash may be WSL's launcher; plain bash elsewhere.
  const bash = (() => {
    if (process.platform !== "win32") return "bash";
    const r = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const root = resolve(r.stdout.trim(), "..", "..", "..");
    return [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")].find((p) => existsSync(p)) ?? null;
  })();

  it("runs in the venue-sweep environment, and only its one step is handed the key", () => {
    expect(yml).toMatch(/\n {4}environment: venue-sweep\r?\n/);
    expect(yml.match(/secrets\.VENUE_SWEEPER_KEYPAIR/g)).toHaveLength(1);
  });

  it("is live only on the repository variable's word for a scheduled run, or the tick for a manual one; a manual run is dry by default, and two runs never overlap", () => {
    const text = yml.replace(/\r\n/g, "\n");
    expect(text.match(/^\s*LIVE:.*$/gm)).toEqual(["          LIVE: ${{ (github.event_name == 'schedule' && vars.VENUE_SWEEP_LIVE == 'true') || (github.event_name == 'workflow_dispatch' && inputs.live) }}"]);
    expect(text).toContain('\n      live:\n        description: "Send the sweeps (otherwise simulate only)"\n        type: boolean\n        default: false\n');
    expect(text).toContain("\nconcurrency:\n  group: venue-sweep\n  cancel-in-progress: false\n");
  });

  it("the run, a call under way at its limit, and checkout and Node all end inside the workflow's timeout-minutes", async () => {
    const minutes = Number(yml.match(/\n {4}timeout-minutes: (\d+)\r?\n/)[1]);
    // A call that is never answered: the transport's 8 tries, each up to 30 seconds (its fetch's
    // timeout), and its pauses and waits between tries, measured with every try answered 503 at once.
    let tries = 0;
    let waited = 0;
    const call = solanaRpc({ fetchImpl: async () => (tries++, { status: 503 }), url: "http://rpc.invalid", wait: async (ms) => void (waited += ms) });
    await expect(call("getBalance", [])).rejects.toThrow(/no answer after 8 tries/);
    const oneCall = tries * 30_000 + waited;
    expect(oneCall).toBe(332_000);
    // Checkout and Node take about two minutes at most (the volume job's pin allows as much).
    expect(RUN_LIMIT_MS + oneCall + 2 * 60_000).toBeLessThanOrEqual(minutes * 60_000);
  });

  it.skipIf(!bash)("its step fails a live run without the key, warns and passes a dry one, and passes --live only to a live run", () => {
    for (const [secret, isLive, code, says] of [
      ["", "true", 1, /::error::the run is live but VENUE_SWEEPER_KEYPAIR is not set/],
      ["", "false", 0, /::warning::VENUE_SWEEPER_KEYPAIR is not set/],
      ["[1]", "true", 0, /^NODE frontend\/scripts\/venue-sweep\.mjs --live$/m],
      ["[1]", "false", 0, /^NODE frontend\/scripts\/venue-sweep\.mjs$/m],
    ]) {
      // `node` is a shell function here: the step's own lines run, and the job's command line is only printed.
      const r = spawnSync(bash, ["-c", `node() { echo "NODE $*"; }\n${step}`], { encoding: "utf8", env: { ...process.env, VENUE_SWEEPER_KEYPAIR: secret, LIVE: isLive } });
      expect([r.status, `${r.stdout}${r.stderr}`]).toEqual([code, expect.stringMatching(says)]);
      if (!secret) expect(r.stdout).not.toContain("NODE");
    }
  });
});

describe("venue-sweep: no package runs beside the key", () => {
  it("prices the island's five coins, by their mints, and no other", () => {
    expect(ISLAND_COINS.map((c) => [c.symbol, c.mint])).toEqual([
      ["BAYLA", "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump"],
      ["BOBO", "4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump"],
      ["SOY", "8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump"],
      ["BRAINLET", "4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump"],
      ["RIZZ", "5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k"],
    ]);
  });

  it("the job loads only Node's own modules and these five files of this repo, all the way down", () => {
    const repo = resolve(here, "..", "..");
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      const specs = [
        ...src.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["']([^"'\n]+)["']/gm),
        ...src.matchAll(/^[ \t]*import[ \t]*["']([^"'\n]+)["']/gm),
        ...src.matchAll(/\bimport\(\s*["']([^"'\n]+)["']/g),
      ].map((m) => m[1]);
      for (const s of specs) {
        if (s.startsWith("node:")) continue;
        expect(s, `${file} loads ${s}`).toMatch(/^\.\.?\//);
        const next = resolve(dirname(file), s);
        expect(next.startsWith(repo + sep), `${file} loads ${s}, outside the repo`).toBe(true);
        walk(next);
      }
    };
    walk(join(here, "venue-sweep.mjs"));
    const files = [...seen].map((f) => f.slice(repo.length + 1).split(sep).join("/"));
    // Exactly these: a file another pull request adds to the volume script's imports runs beside the key too, so it turns this red.
    expect(files.sort()).toEqual([
      "frontend/api/_lib/venueVolumePolicy.js",
      "frontend/scripts/lib/solana-signer.mjs",
      "frontend/scripts/lib/venue-volume-chain.mjs",
      "frontend/scripts/venue-sweep.mjs",
      "frontend/scripts/venue-volume.mjs",
    ]);
  });
});
