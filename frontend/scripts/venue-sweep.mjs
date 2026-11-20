#!/usr/bin/env node
// Daily, by .github/workflows/venue-sweep.yml: sweep every own pool's set-aside fee shares to
// their owners with the pool program's `sweep_fees` (solana/tegridy-amm lib.rs, 2026-11-15).
// The venue's share (10.4% of each trade fee) goes to the Squads vault's own token accounts and
// the island's (5.6%) to the Workshop's. The PROGRAM derives and enforces every destination: this
// job cannot send a coin anywhere else. It pays the network fee and, once per new coin, the rent
// of an owner's token account (the associated token account program's CreateIdempotent).
// HELD BACK: a pool holding a Token-2022 coin with a transfer fee (GROYPER takes 3% of every
// move) is not swept, since the coin would keep that much of both shares; the summary names it
// and the owner decides. A coin whose fee setting cannot be read is held back too, and fails the run.
//
//   node frontend/scripts/venue-sweep.mjs --payer <address>   dry run: reads and simulates as that
//                                                             payer, sends nothing, needs no key
//   node frontend/scripts/venue-sweep.mjs                     dry run with the key's address
//   node frontend/scripts/venue-sweep.mjs --live              sends; needs VENUE_SWEEPER_KEYPAIR
// Options: --rpc <url> (default the public mainnet RPC), --program <id> (default the venue's
// pool program; any other is a test chain, where the mainnet owner check does not apply),
// --min-usd <n> (default 0.5: a pool whose priced shares are worth less waits for a later day).
// Exit 0 when every pool above the floor was swept or simulated clean (or the program has no
// sweep yet), 1 when anything failed. Plain Node, no package: the key never shares a process with
// third-party code (venue-volume.yml's rule).
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { base58, solanaRpc, SOLANA_RPC, SOL_MINT, USDC_MINT, USDT_MINT, VENUE_PROGRAM } from "./lib/venue-volume-chain.mjs";
import {
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  associatedTokenAddress,
  compileLegacy,
  createIdempotentIx,
  findProgramAddress,
  keypairSigner,
  signTransaction,
} from "./lib/solana-signer.mjs";

/** The fee owners on mainnet (frontend/scripts/addresses.json: squads-vault, island-workshop-wallet). */
export const VAULT = "GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd";
export const WORKSHOP = "G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu";
export const POOL_SIZE = 637;
export const TIER_SIZE = 236;
const AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");
/** Anchor's instruction tag: sha256("global:sweep_fees")[..8]. */
export const SWEEP_FEES_TAG = createHash("sha256").update("global:sweep_fees").digest().subarray(0, 8);
/** Anchor's "instruction not found" (InstructionFallbackNotFound): the program has no sweep yet. */
const NO_SUCH_INSTRUCTION = 101;

const pk = (d, o) => base58(d.subarray(o, o + 32));
const u64 = (d, o) => d.readBigUInt64LE(o);

/** A cp-swap pool account (states/pool.rs, 637 bytes): what the sweep needs. */
export function decodePool(address, base64) {
  const d = Buffer.from(base64, "base64");
  if (d.length !== POOL_SIZE) throw new Error(`pool ${address} is ${d.length} bytes, not ${POOL_SIZE}`);
  return {
    address,
    ammConfig: pk(d, 8),
    vault0: pk(d, 72),
    vault1: pk(d, 104),
    mint0: pk(d, 168),
    mint1: pk(d, 200),
    program0: pk(d, 232),
    program1: pk(d, 264),
    decimals0: d[331],
    decimals1: d[332],
    protocol: [u64(d, 341), u64(d, 349)],
    fund: [u64(d, 357), u64(d, 365)],
  };
}

/** A cp-swap fee tier (states/config.rs, 236 bytes): its two fee owners. */
export function decodeTier(address, base64) {
  const d = Buffer.from(base64, "base64");
  if (d.length !== TIER_SIZE) throw new Error(`fee tier ${address} is ${d.length} bytes, not ${TIER_SIZE}`);
  return { address, protocolOwner: pk(d, 44), fundOwner: pk(d, 76) };
}

/** The four destinations of a pool's sweep, as the program derives them. */
export function destinations(pool, tier) {
  return {
    protocol0: associatedTokenAddress(tier.protocolOwner, pool.mint0, pool.program0),
    protocol1: associatedTokenAddress(tier.protocolOwner, pool.mint1, pool.program1),
    fund0: associatedTokenAddress(tier.fundOwner, pool.mint0, pool.program0),
    fund1: associatedTokenAddress(tier.fundOwner, pool.mint1, pool.program1),
  };
}

/** The sweep_fees instruction, its accounts in the order of `SweepFees` in lib.rs. */
export function sweepFeesIx({ programId, pool, tier }) {
  const authority = findProgramAddress([AUTH_SEED], programId).address;
  const to = destinations(pool, tier);
  const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
  return {
    programId,
    keys: [
      r(authority),
      w(pool.address),
      r(pool.ammConfig),
      w(pool.vault0),
      w(pool.vault1),
      r(pool.mint0),
      r(pool.mint1),
      w(to.protocol0),
      w(to.protocol1),
      w(to.fund0),
      w(to.fund1),
      r(TOKEN_PROGRAM),
      r(TOKEN_2022_PROGRAM),
    ],
    data: Buffer.from(SWEEP_FEES_TAG),
  };
}

/** What the pool's shares are worth, counting only the legs with a known price (SOL, USDC, USDT). */
export function pricedShares(pool, solUsd) {
  const usdOf = (mint, raw, decimals) => {
    const units = Number(raw) / 10 ** decimals;
    if (mint === USDC_MINT || mint === USDT_MINT) return units;
    if (mint === SOL_MINT) return solUsd == null ? null : units * solUsd;
    return 0;
  };
  let usd = 0;
  for (const [i, mint, decimals] of [
    [0, pool.mint0, pool.decimals0],
    [1, pool.mint1, pool.decimals1],
  ]) {
    const v = usdOf(mint, pool.protocol[i] + pool.fund[i], decimals);
    if (v === null) return null;
    usd += v;
  }
  return usd;
}

/**
 * A Token-2022 mint's transfer fee in basis points: the higher of its two settings (the one in
 * force now and the one scheduled), 0 with no TransferFeeConfig extension. Layout (spl-token-2022):
 * the 82-byte mint, padding to 165, the account type (1 = mint) at 165, then type/length/value
 * entries from 166; TransferFeeConfig is type 1, 108 bytes: two authorities (64), the withheld
 * amount (8), then two TransferFee of epoch (8), maximum (8) and basis points (2).
 */
export function transferFeeBps(d) {
  if (d.length <= 166 || d[165] !== 1) return 0;
  for (let off = 166; off + 4 <= d.length; ) {
    const type = d.readUInt16LE(off);
    const len = d.readUInt16LE(off + 2);
    if (type === 0) break;
    if (type === 1) {
      if (len < 108 || off + 4 + len > d.length) return null;
      const v = d.subarray(off + 4, off + 4 + len);
      return Math.max(v.readUInt16LE(88), v.readUInt16LE(106));
    }
    off += 4 + len;
  }
  return 0;
}

/** The pools' Token-2022 coins that take a fee on transfer: mint -> basis points, or null when unreadable. */
export async function transferFeeCoins(call, pools) {
  const mints = [
    ...new Set(
      pools.flatMap((p) => [
        [p.mint0, p.program0],
        [p.mint1, p.program1],
      ]).filter(([, prog]) => prog === TOKEN_2022_PROGRAM).map(([m]) => m)
    ),
  ];
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const infos = (await call("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }])).value;
    chunk.forEach((m, j) => {
      const bps = infos[j]?.data?.[0] ? transferFeeBps(Buffer.from(infos[j].data[0], "base64")) : null;
      if (bps !== 0) out.set(m, bps);
    });
  }
  return out;
}

/** Is the pool worth a transaction today? With no SOL price, 0.007 SOL of shares stands in for $0.50. */
export function worthSweeping(pool, solUsd, minUsd) {
  const usd = pricedShares(pool, solUsd);
  if (usd !== null) return usd >= minUsd;
  const solRaw = [pool.mint0, pool.mint1].reduce((a, m, i) => (m === SOL_MINT ? a + pool.protocol[i] + pool.fund[i] : a), 0n);
  return Number(solRaw) / 1e9 >= (0.007 * minUsd) / 0.5;
}

/** The custom error number a simulation's `err` carries for instruction `ix`, or null. */
export function customError(err, ix) {
  const e = err?.InstructionError;
  return Array.isArray(e) && e[0] === ix && typeof e[1]?.Custom === "number" ? e[1].Custom : null;
}

export function parseArgs(argv) {
  const out = { live: false, rpc: SOLANA_RPC, program: VENUE_PROGRAM, minUsd: 0.5, payer: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--live") out.live = true;
    else if (a === "--rpc") out.rpc = next();
    else if (a === "--program") out.program = next();
    else if (a === "--payer") out.payer = next();
    else if (a === "--min-usd") out.minUsd = Number(next());
    else throw new Error(`unknown option ${a}`);
  }
  if (!(out.minUsd >= 0)) throw new Error("--min-usd must be a number of dollars");
  return out;
}

async function solPrice(fetchImpl) {
  try {
    const r = await fetchImpl("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(10_000) });
    const v = Number((await r.json())?.data?.amount);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

const fmt = (raw, decimals) => (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals });

/**
 * One run. `deps` are injectable for tests: { call (JSON-RPC), fetchImpl, env, log, wait }.
 * Returns { ok, notUpgraded, pools: [...] }.
 */
export async function run(opts, deps) {
  const { call, fetchImpl = globalThis.fetch, env = process.env, log = console.log, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps;
  const mainnet = opts.program === VENUE_PROGRAM;
  const signer = env.VENUE_SWEEPER_KEYPAIR ? keypairSigner(env.VENUE_SWEEPER_KEYPAIR) : null;
  if (opts.live && !signer) throw new Error("--live needs VENUE_SWEEPER_KEYPAIR");
  const payer = signer?.address ?? opts.payer;
  if (!payer) throw new Error("a dry run needs --payer <address> or VENUE_SWEEPER_KEYPAIR");

  const raw = await call("getProgramAccounts", [opts.program, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: POOL_SIZE }] }]);
  const pools = raw.map((a) => decodePool(a.pubkey, a.account.data[0]));
  const tierKeys = [...new Set(pools.map((p) => p.ammConfig))];
  const tierInfos = tierKeys.length ? (await call("getMultipleAccounts", [tierKeys, { encoding: "base64", commitment: "confirmed" }])).value : [];
  const tiers = new Map(tierKeys.map((k, i) => [k, tierInfos[i] ? decodeTier(k, tierInfos[i].data[0]) : null]));
  const feeCoins = await transferFeeCoins(call, pools);
  const solUsd = await solPrice(fetchImpl);
  log(`${pools.length} pools on ${opts.program}; SOL ${solUsd == null ? "price unread" : `$${solUsd}`}; payer ${payer}; ${opts.live ? "LIVE" : "dry run"}`);

  const results = [];
  let ok = true;
  let notUpgraded = false;
  for (const pool of pools) {
    const tier = tiers.get(pool.ammConfig);
    const row = { pool: pool.address, swept: false };
    results.push(row);
    if (!tier) {
      row.note = `its fee tier ${pool.ammConfig} could not be read`;
      ok = false;
      continue;
    }
    if (mainnet && (tier.protocolOwner !== VAULT || tier.fundOwner !== WORKSHOP)) {
      row.note = `its fee tier names ${tier.protocolOwner} and ${tier.fundOwner}, not the vault and the Workshop: not swept, read it`;
      ok = false;
      continue;
    }
    if (pool.protocol.every((x) => x === 0n) && pool.fund.every((x) => x === 0n)) {
      row.note = "nothing set aside";
      continue;
    }
    const taxed = [pool.mint0, pool.mint1].find((m) => feeCoins.has(m));
    if (taxed) {
      const bps = feeCoins.get(taxed);
      if (bps === null) {
        row.note = `held back: the transfer fee of ${taxed} could not be read`;
        ok = false;
      } else {
        row.note = `held back: ${taxed} takes ${bps / 100}% of every transfer, so a sweep would hand that much of both shares of it to the coin; the owner decides`;
      }
      continue;
    }
    if (!worthSweeping(pool, solUsd, opts.minUsd)) {
      row.note = `under the $${opts.minUsd} floor: waits`;
      continue;
    }
    const to = destinations(pool, tier);
    const owners = [
      [tier.protocolOwner, pool.mint0, pool.program0, to.protocol0],
      [tier.protocolOwner, pool.mint1, pool.program1, to.protocol1],
      [tier.fundOwner, pool.mint0, pool.program0, to.fund0],
      [tier.fundOwner, pool.mint1, pool.program1, to.fund1],
    ];
    const exists = (await call("getMultipleAccounts", [owners.map((o) => o[3]), { encoding: "base64", commitment: "confirmed" }])).value;
    const seen = new Set();
    const ixs = [];
    owners.forEach(([owner, mint, tokenProgram, address], i) => {
      if (exists[i] || seen.has(address)) return;
      seen.add(address);
      ixs.push(createIdempotentIx({ payer, owner, mint, tokenProgram }));
    });
    ixs.push(sweepFeesIx({ programId: opts.program, pool, tier }));
    row.created = ixs.length - 1;
    row.venue = `${fmt(pool.protocol[0], pool.decimals0)} of ${pool.mint0} + ${fmt(pool.protocol[1], pool.decimals1)} of ${pool.mint1}`;
    row.island = `${fmt(pool.fund[0], pool.decimals0)} of ${pool.mint0} + ${fmt(pool.fund[1], pool.decimals1)} of ${pool.mint1}`;

    const { blockhash, lastValidBlockHeight } = (await call("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    const compiled = compileLegacy({ payer, instructions: ixs, recentBlockhash: blockhash });
    const wire = signer ? signTransaction(compiled, signer) : Buffer.concat([Buffer.from([1]), Buffer.alloc(64), compiled.message]);
    const sim = (
      await call("simulateTransaction", [wire.toString("base64"), { encoding: "base64", sigVerify: !!signer, replaceRecentBlockhash: !signer, commitment: "confirmed" }])
    ).value;
    if (sim.err) {
      if (customError(sim.err, ixs.length - 1) === NO_SUCH_INSTRUCTION) {
        row.note = "the pool program has no sweep yet (not upgraded): nothing sent";
        notUpgraded = true;
        continue;
      }
      row.note = `the simulation refused it: ${JSON.stringify(sim.err)}; ${(sim.logs ?? []).slice(-3).join(" | ")}`;
      ok = false;
      continue;
    }
    if (!opts.live) {
      row.note = `simulated clean (${sim.unitsConsumed ?? "?"} compute units); a live run would send it`;
      continue;
    }
    const sig = await call("sendTransaction", [wire.toString("base64"), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }]);
    row.signature = sig;
    let landed = null;
    for (let i = 0; i < 40 && landed === null; i++) {
      await wait(1500);
      const st = (await call("getSignatureStatuses", [[sig]])).value[0];
      if (st?.err) landed = false;
      else if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") landed = true;
      else if ((await call("getBlockHeight", [{ commitment: "confirmed" }])) > lastValidBlockHeight) break;
    }
    if (landed) {
      row.swept = true;
      row.note = "swept";
    } else {
      row.note = landed === false ? "sent, and it failed on chain" : "sent, but not seen on chain before its blockhash expired: tomorrow's run tries again";
      ok = false;
    }
  }
  return { ok, notUpgraded, pools: results };
}

export function summary(res, opts) {
  const lines = [`### Venue sweep (${opts.live ? "live" : "dry run"})`, "", "| Pool | Result | Venue's share | Island's share | Transaction |", "|---|---|---|---|---|"];
  for (const r of res.pools) {
    if (r.note === "nothing set aside" || r.note?.startsWith("under the")) continue;
    lines.push(`| \`${r.pool}\` | ${r.note ?? ""} | ${r.venue ?? ""} | ${r.island ?? ""} | ${r.signature ? `\`${r.signature}\`` : ""} |`);
  }
  const waiting = res.pools.filter((r) => r.note?.startsWith("under the")).length;
  const empty = res.pools.filter((r) => r.note === "nothing set aside").length;
  lines.push("", `${empty} pools have nothing set aside; ${waiting} are under the floor and wait.`);
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const call = solanaRpc({ url: opts.rpc });
  const res = await run(opts, { call });
  const text = summary(res, opts);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  process.exitCode = res.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`venue sweep: ${e.message}`);
    process.exitCode = 1;
  });
}
