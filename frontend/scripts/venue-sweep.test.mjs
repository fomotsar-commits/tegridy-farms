// @vitest-environment node
// The daily venue sweep (scripts/venue-sweep.mjs) and its plain-Node signer
// (scripts/lib/solana-signer.mjs), each piece checked against @solana/web3.js and
// @solana/spl-token, which the job itself never loads. Node's environment, not jsdom: there
// web3.js's own curve check and its serializer break (see scripts/bayla-ladder-ops.test.mjs).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, Message, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getTransferFeeConfig, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import {
  ATA_PROGRAM,
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
  SWEEP_FEES_TAG,
  TIER_SIZE,
  VAULT,
  WORKSHOP,
  customError,
  decodePool,
  decodeTier,
  destinations,
  parseArgs,
  run,
  summary,
  sweepFeesIx,
  transferFeeBps,
  worthSweeping,
} from "./venue-sweep.mjs";
import { SOL_MINT, USDC_MINT, VENUE_PROGRAM } from "./lib/venue-volume-chain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
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

/** A pool account's bytes with the fields the sweep reads; everything else zero. */
function poolBytes({ ammConfig, vault0, vault1, mint0, mint1, program0, program1, decimals0 = 9, decimals1 = 6, protocol = [0n, 0n], fund = [0n, 0n] }) {
  const d = Buffer.alloc(POOL_SIZE);
  const put = (k, o) => new PublicKey(k).toBuffer().copy(d, o);
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

describe("venue-sweep: the instruction", () => {
  it("decodes a pool and a tier where states/pool.rs and states/config.rs put each field", () => {
    const f = { ammConfig: key(), vault0: key(), vault1: key(), mint0: SOL_MINT, mint1: BAYLA, program0: TOKEN_PROGRAM, program1: TOKEN_2022_PROGRAM, protocol: [5n, 6n], fund: [7n, 8n] };
    const p = decodePool("P", poolBytes(f));
    expect(p).toMatchObject({ ...f, decimals0: 9, decimals1: 6 });
    expect(decodeTier("T", tierBytes(VAULT, WORKSHOP))).toMatchObject({ protocolOwner: VAULT, fundOwner: WORKSHOP });
    expect(() => decodePool("P", Buffer.alloc(10).toString("base64"))).toThrow(/637/);
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

  it("worthSweeping prices SOL and dollar coins only, and falls back to 0.007 SOL when SOL has no price", () => {
    const base = { mint0: SOL_MINT, mint1: BAYLA, decimals0: 9, decimals1: 6 };
    expect(worthSweeping({ ...base, protocol: [6_000_000n, 0n], fund: [1_000_000n, 0n] }, 72, 0.5)).toBe(true); // 0.007 SOL = $0.50
    expect(worthSweeping({ ...base, protocol: [1_000_000n, 99_999_999n], fund: [0n, 0n] }, 72, 0.5)).toBe(false); // BAYLA is not priced
    expect(worthSweeping({ ...base, protocol: [7_000_000n, 0n], fund: [0n, 0n] }, null, 0.5)).toBe(true);
    expect(worthSweeping({ mint0: USDC_MINT, mint1: BAYLA, decimals0: 6, decimals1: 6, protocol: [400_000n, 0n], fund: [100_000n, 0n] }, null, 0.5)).toBe(true);
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

/**
 * A fake chain: the pools and tiers given, the accounts that exist, and what each call returns.
 * `simErr(tx)` answers each simulation from the transaction itself (web3.js's reading of it).
 */
function fakeChain({ pools, tiers, existing = new Set(), mints = { [BAYLA]: BAYLA_MINT, [GROYPER]: GROYPER_MINT }, simErr = () => null, statuses = [{ confirmationStatus: "confirmed", err: null }] }) {
  const calls = [];
  let s = 0;
  let sent = 0;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "getProgramAccounts") return pools.map(([pubkey, data]) => ({ pubkey, account: { data: [data, "base64"] } }));
    if (method === "getMultipleAccounts")
      return { value: params[0].map((k) => (mints[k] ? { data: [mints[k], "base64"] } : tiers[k] ? { data: [tiers[k], "base64"] } : existing.has(k) ? { data: ["", "base64"] } : null)) };
    if (method === "getLatestBlockhash") return { value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } };
    if (method === "simulateTransaction") return { value: { err: simErr(Transaction.from(Buffer.from(params[0], "base64"))), logs: [], unitsConsumed: 61234 } };
    if (method === "sendTransaction") return `SiG${++sent}`;
    if (method === "getSignatureStatuses") return { value: [statuses[Math.min(s++, statuses.length - 1)]] };
    if (method === "getBlockHeight") return 10;
    throw new Error(`unexpected ${method}`);
  };
  /** Each transaction simulated, as web3.js reads it. */
  const simulated = () => calls.filter((c) => c.method === "simulateTransaction").map((c) => Transaction.from(Buffer.from(c.params[0], "base64")));
  return { call, calls, simulated };
}
/** The side a sweep_fees instruction names (its data's last byte): "venue" or "island". */
const sideOf = (ix) => (ix.data[8] === 1 ? "island" : "venue");
const sweepsIn = (tx) => tx.instructions.filter((i) => i.programId.toBase58() === VENUE_PROGRAM);
const noPrice = async () => ({ json: async () => ({}) });
const quiet = () => {};

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
    const chain = fakeChain({ pools: [big, dust, empty], tiers, existing: new Set(workshopAccounts) });
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
    const chain = fakeChain({ pools: [big], tiers, existing: new Set([...vaultAccounts, workshopAccounts[0]]) });
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

  for (const [refused, still] of [
    ["venue", "island"],
    ["island", "venue"],
  ]) {
    it(`a refusal of the ${refused}'s sweep does not stop the ${still}'s: each is its own transaction, and the run fails`, async () => {
      const chain = fakeChain({
        pools: [big],
        tiers,
        existing: new Set([...vaultAccounts, ...workshopAccounts]),
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

  it("before the program is upgraded, the simulation's 'no such instruction' is said and is not a failure", async () => {
    // The vault's accounts do not exist yet, so two CreateIdempotent come first and its sweep is the third.
    const chain = fakeChain({
      pools: [big],
      tiers,
      existing: new Set(workshopAccounts),
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
    const chain = fakeChain({ pools: [big], tiers, existing: new Set([...vaultAccounts, ...workshopAccounts]) });
    const env = { VENUE_SWEEPER_KEYPAIR: JSON.stringify([...kp.secretKey]) };
    const res = await run(parseArgs(["--live"]), { call: chain.call, fetchImpl: noPrice, env, log: quiet, wait: async () => {} });
    const sent = chain.calls.filter((c) => c.method === "sendTransaction").map((c) => Transaction.from(Buffer.from(c.params[0], "base64")));
    expect(sent.map((tx) => sweepsIn(tx).map(sideOf))).toEqual([["venue"], ["island"]]);
    expect(res.ok).toBe(true);
    expect(res.pools[0]).toMatchObject({ created: 0, venue: { swept: true, signature: "SiG1" }, island: { swept: true, signature: "SiG2" } });
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
});
