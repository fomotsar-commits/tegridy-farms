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
import { getAssociatedTokenAddressSync, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
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
  fmt,
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
 * type (2) and the ImmutableOwner entry the associated token program gives it.
 */
function tokenAccountBytes({ mint, owner, program, delegate = false, frozen = false, closeAuthority = false }) {
  const d = Buffer.alloc(program === TOKEN_2022_PROGRAM ? 170 : 165);
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
  if (program === TOKEN_2022_PROGRAM) {
    d[165] = 2;
    d.writeUInt16LE(7, 166);
  }
  return d.toString("base64");
}
/** Accounts as getMultipleAccounts returns them. */
const tokenAccount = (o) => ({ owner: o.program, lamports: 2_039_280, executable: false, data: [tokenAccountBytes(o), "base64"] });
const systemAccount = (lamports) => ({ owner: SYSTEM_PROGRAM, lamports, executable: false, data: ["", "base64"] });
/** `owner`'s associated token account for each [mint, program], open; `flags[mint]` sets that one's delegate, state or close authority. */
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

  it("reads a destination's delegate, state and close authority where spl-token does, under both token programs", () => {
    for (const [program, programId] of [
      [TOKEN_PROGRAM, TOKEN_PROGRAM_ID],
      [TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM_ID],
    ]) {
      for (let bits = 0; bits < 8; bits++) {
        const o = { mint: key(), owner: key(), program, delegate: !!(bits & 1), frozen: !!(bits & 2), closeAuthority: !!(bits & 4) };
        const info = tokenAccount(o);
        const want = unpackAccount(new PublicKey(key()), { data: Buffer.from(info.data[0], "base64"), owner: programId, lamports: info.lamports, executable: false }, programId);
        expect([want.mint.toBase58(), want.owner.toBase58()]).toEqual([o.mint, o.owner]);
        expect(destinationState(info, program)).toEqual({ open: true, delegate: want.delegate !== null, frozen: want.isFrozen, closeAuthority: want.closeAuthority !== null });
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

/**
 * A fake chain: the pools, tiers and accounts given, and what each call returns. getProgramAccounts
 * honours the filters it is sent, as the RPC does (`honourFilters: false` plays one that ignores
 * them). `simErr(tx)` answers each simulation from the transaction itself (web3.js's reading of it),
 * and a simulation asked for accounts gets each back holding `rent` lamports, as an opened account
 * would (none with `simAccounts: false`). A send lands and is answered with its own signature; one
 * already landed is refused as a node's preflight refuses it; only a landed one has a status, from
 * `statuses`. `fail(method, params)` may return an error for that call to throw instead (a send it
 * fails never lands).
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
  balance = 987_654_321,
  blockHeight = 10,
}) {
  const calls = [];
  let s = 0;
  const landed = new Set();
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
    if (method === "getMultipleAccounts")
      return {
        value: params[0].map((k) =>
          mints[k] ? { owner: TOKEN_2022_PROGRAM, lamports: 1, data: [mints[k], "base64"] } : tiers[k] ? { owner: VENUE_PROGRAM, lamports: 1, data: [tiers[k], "base64"] } : (accounts[k] ?? null)
        ),
      };
    if (method === "getLatestBlockhash") return { value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } };
    if (method === "simulateTransaction") {
      const tx = Transaction.from(Buffer.from(params[0], "base64"));
      const asked = params[1]?.accounts?.addresses;
      return { value: { err: simErr(tx), logs: simLogs, unitsConsumed: 61234, accounts: asked && simAccounts ? asked.map(() => ({ owner: TOKEN_PROGRAM, lamports: rent, data: ["", "base64"] })) : null } };
    }
    if (method === "sendTransaction") {
      const sig = sigOfWire(params[0]);
      if (landed.has(sig)) throw rpcError(method, -32002, "Transaction simulation failed: This transaction has already been processed");
      landed.add(sig);
      return sig;
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
      const chain = fakeChain({
        pools: [big],
        tiers,
        accounts: opened(VAULT, WORKSHOP),
        simErr: (tx) => (sweepsIn(tx).some((ix) => sideOf(ix) === refused) ? { InstructionError: [0, { Custom: 6018 }] } : null),
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
      simErr: (tx) => ({ InstructionError: [tx.instructions.length - 1, { Custom: 6018 }] }),
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

  it("a live run needs the key, and a dry run needs a payer", async () => {
    const chain = fakeChain({ pools: [], tiers });
    await expect(run(parseArgs(["--live"]), { call: chain.call, env: {}, log: quiet })).rejects.toThrow(/VENUE_SWEEPER_KEYPAIR/);
    await expect(run(parseArgs([]), { call: chain.call, env: {}, log: quiet })).rejects.toThrow(/--payer/);
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

  it("a pool or a fee tier that will not decode fails only its own row; the other pools are still swept", async () => {
    const badTier = key();
    const onBadTier = [key(), poolBytes({ ammConfig: badTier, vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [51_216_483n, 0n] })];
    const other = tagless();
    // An RPC that ignores the filters hands back the account without the tag as well.
    const chain = fakeChain({ pools: [other, onBadTier, big], tiers: { ...tiers, [badTier]: Buffer.alloc(21).toString("base64") }, accounts: opened(VAULT, WORKSHOP), honourFilters: false });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const row = (p) => res.pools.find((r) => r.pool === p[0]);
    expect(res.ok).toBe(false);
    expect(row(other).error).toMatch(/PoolState/);
    expect(row(onBadTier).note).toMatch(new RegExp(`its fee tier ${badTier} could not be read: .*21 bytes`));
    expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(row(big).venue.result).toMatch(/simulated clean/);
    expect(row(big).island.result).toMatch(/simulated clean/);
    const text = summary(res, { live: false });
    expect(text).toContain(other[0]);
    expect(text).toContain(onBadTier[0]);
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
    expect(res.pools[0].venue).toMatchObject({ ok: false, signature: sigOfTx(venueTx), result: expect.stringMatching(/^sending failed \(.*Blockhash not found.*\), and it was not seen on chain/) });
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
    expect(res.pools[0].venue).toMatchObject({ ok: true, swept: true, signature: sig, result: expect.stringMatching(/^swept \(its send answered: sendTransaction: .*already been processed/) });
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
      expect(res.pools[0][side]).toMatchObject({ ok: false, signature: sigOfTx(sent[i]), result: expect.stringMatching(/^sending failed \(.*already been processed.*\), and it was not seen on chain/) });
    }
    expect(res.ok).toBe(false);
    expect(res.paid.sweeps).toBe(0);
    expect(summary(res, { live: true })).toContain("0 sweeps seen on chain (0 lamports of network fees)");
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

  // ── Each destination is checked before its side is sent (the owner's ruling, 2026-11-21) ──
  const usdcPool = dollarPool(USDC_MINT);
  const usdtPool = dollarPool(USDT_MINT);
  for (const c of [
    { side: "venue", owner: VAULT, coin: SOL_MINT, flag: "delegate", says: "has a delegate", red: true },
    { side: "venue", owner: VAULT, coin: BAYLA, flag: "closeAuthority", says: "has a close authority", red: true },
    { side: "venue", owner: VAULT, coin: USDC_MINT, flag: "frozen", says: "is frozen", red: true },
    { side: "venue", owner: VAULT, coin: USDT_MINT, flag: "frozen", says: "is frozen", red: true },
    { side: "venue", owner: VAULT, coin: BAYLA, flag: "frozen", says: "is frozen", red: false },
    { side: "island", owner: WORKSHOP, coin: SOL_MINT, flag: "delegate", says: "has a delegate", red: false },
    { side: "island", owner: WORKSHOP, coin: BAYLA, flag: "closeAuthority", says: "has a close authority", red: false },
    { side: "island", owner: WORKSHOP, coin: BAYLA, flag: "frozen", says: "is frozen", red: false },
    { side: "island", owner: WORKSHOP, coin: USDC_MINT, flag: "frozen", says: "is frozen", red: false },
    { side: "island", owner: WORKSHOP, coin: USDT_MINT, flag: "frozen", says: "is frozen", red: false },
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

  // ── A side is sent only when every account its transfer touches is open ────
  const authority = findProgramAddress([Buffer.from("vault_and_lp_mint_auth_seed")], VENUE_PROGRAM).address;
  for (const c of [
    { coin: USDC_MINT, venueOwes: [2_000_000n, 30_000_000n], islandOwes: [0n, 15_000_000n], held: ["venue"], red: true },
    { coin: USDC_MINT, venueOwes: [0n, 30_000_000n], islandOwes: [1_000_000n, 15_000_000n], held: ["island"], red: false },
    { coin: USDT_MINT, venueOwes: [2_000_000n, 30_000_000n], islandOwes: [0n, 0n], held: ["venue"], red: true },
    { coin: BAYLA, venueOwes: [51_216_483n, 7_000_000_000n], islandOwes: [23_051_592n, 3_683_000_000n], held: ["venue", "island"], red: false },
    { coin: BAYLA, venueOwes: [51_216_483n, 0n], islandOwes: [23_051_592n, 3_683_000_000n], held: ["island"], red: false },
  ]) {
    const name = { [BAYLA]: "BAYLA", [USDC_MINT]: "USDC", [USDT_MINT]: "USDT" }[c.coin];
    it(`the pool's own ${name} account frozen holds back the ${c.held.join(" and the ")}'s side, each owed ${name}: ${c.red ? "the venue's fails the run" : "named, and the run passes"}; a side not owed ${name} still goes`, async () => {
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
        if (c.held.includes(side)) {
          expect(res.pools[0][side]).toMatchObject({ heldBack: true, ok: !(c.red && side === "venue") });
          expect(res.pools[0][side].result).toContain(`the pool's own account \`${own[at]}\` for ${c.coin} is frozen`);
        } else expect(res.pools[0][side].result).toMatch(owes[side].some((x) => x > 0n) ? /simulated clean/ : /^nothing set aside$/);
      }
      const sent = ["venue", "island"].filter((s) => !c.held.includes(s) && owes[s].some((x) => x > 0n));
      expect(chain.simulated().map((tx) => sweepsIn(tx).map(sideOf))).toEqual(sent.map((s) => [s]));
      expect(res.ok).toBe(!c.red);
      expect(summary(res, { live: false })).toContain(own[at]);
    });
  }

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

  it("a sweep never seen on chain is said so and fails the run", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [null] });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    for (const side of ["venue", "island"]) expect(res.pools[0][side]).toMatchObject({ ok: false, signature: expect.any(String), result: expect.stringMatching(/not seen on chain/) });
    expect(chain.calls.filter((c) => c.method === "getSignatureStatuses").length).toBe(80);
    expect(res.ok).toBe(false);
    expect(exitCode(res)).toBe(1);
  });

  it("a sweep still unseen once its blockhash has expired is given up after that look, and fails the run", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), statuses: [null], blockHeight: 1001 });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    for (const side of ["venue", "island"]) expect(res.pools[0][side].result).toMatch(/not seen on chain before its blockhash expired/);
    expect(chain.calls.filter((c) => c.method === "getSignatureStatuses").length).toBe(2);
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

  it("a live run's simulation checks the signature on the real blockhash, and its send keeps the RPC's own preflight", async () => {
    const kp = Keypair.generate();
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP) });
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env: live(kp), log: quiet, wait: async () => {} });
    expect(res.ok).toBe(true);
    const sims = chain.calls.filter((c) => c.method === "simulateTransaction");
    const sends = chain.calls.filter((c) => c.method === "sendTransaction");
    expect([sims.length, sends.length]).toEqual([2, 2]);
    for (const c of sims) expect(c.params[1]).toMatchObject({ sigVerify: true, replaceRecentBlockhash: false });
    for (const c of sends) expect(c.params[1]).toEqual({ encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 });
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

  it("the summary says when the payer holds less than one more sweep that opens a vault account needs: what it must keep, the rent and the fee", async () => {
    const chain = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), balance: 1_503_440 });
    const res = await run(parseArgs(["--payer", payer]), { call: chain.call, fetchImpl: noPrice, env: {}, log: quiet });
    const text = summary(res, { live: false });
    expect(text).toContain(`\`${payer}\` holds 1,503,440 lamports.`);
    expect(text).toContain("That is under the 2,143,680 lamports one more sweep that opens a vault account needs (650,240 the payer must keep, 1,488,440 of rent and 5,000 of fee): fund it.");
    const rich = fakeChain({ pools: [big], tiers, accounts: opened(VAULT, WORKSHOP), balance: 2_143_680 });
    const res2 = await run(parseArgs(["--payer", payer]), { call: rich.call, fetchImpl: noPrice, env: {}, log: quiet });
    expect(summary(res2, { live: false })).not.toContain("fund it");
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
    const chain = fakeChain({ pools: [], tiers: {} });
    const r = await runJob(["--payer", payer], { chain });
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/^### Venue sweep \(dry run\)\n/);
    expect(r.summary).toContain(`\`${payer}\` holds 987,654,321 lamports`);
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
  it("the job loads only Node's own modules and this repo's files, all the way down", () => {
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
    expect(files).toEqual(expect.arrayContaining(["frontend/scripts/venue-sweep.mjs", "frontend/scripts/lib/solana-signer.mjs", "frontend/scripts/lib/venue-volume-chain.mjs", "frontend/scripts/venue-volume.mjs"]));
  });
});
