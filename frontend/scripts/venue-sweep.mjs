#!/usr/bin/env node
// Daily, by .github/workflows/venue-sweep.yml: the pool program's `sweep_fees` (lib.rs), which picks
// every destination itself, moves the venue's share (10.4% of each trade fee) to the vault's own
// token accounts and the island's (5.6%) to the Workshop's, each in a transaction of its own.
//
// Each owner's side is sent only when that owner's own share passes the floor on the coins priced
// here: SOL, USDC, USDT and the island's five (Jupiter's keyless price, as the volume figure reads
// it; a price that is not a finite number above 0 is no price). No other coin takes a price: a pool
// with none of these is named and left to hand collects, as is one with a coin that takes a
// transfer fee. Before a pool's sides go, the pool and every account their transfers touch are
// read again in one request, and each side goes by the counts as they stand then; after the
// venue's sweep is sent, the island's accounts and the pool are read once more. A destination
// counts as open only when its coin's own token program owns it. The vault's missing ones are
// opened here (their rent stays the venue's); the Workshop's never are (its share waits, and the
// summary names them). It follows the pool program's two rules (the owner's ruling, 2026-11-21:
// "Fix in the program"). An open destination with a delegate or a close authority holds its side
// back, named, owed or not, since the program refuses it. A coin the side is owed whose
// destination or pool account is frozen is left in the pool and named with that account, also on
// a side that waits: it counts nothing toward the floor, and the other coin is sent when it passes
// on its own. On the vault's side a delegate, a close authority or a frozen USDC or USDT also fails
// the run, whether the other coin is sent or the side waits, and its destinations are checked
// whenever they are read. The key pays 5,000 lamports a sweep, the island's included, and the
// vault's rent: at most two sweeps a pool a run, and each missing vault account's rent once. Every
// simulation is of the unsigned transaction; a live run signs only what it then sends, on a
// finalized blockhash, which every node knows. An error stays on its pool's row; a transport that
// stops answering, or the run's own time limit, ends the run early. Each signature is logged
// before it is sent, and a send that answers an error is looked up on chain. On mainnet a listing
// with no pool fails the run. The summary is always written, with what the key paid and holds.
//
//   node frontend/scripts/venue-sweep.mjs --payer <address>   dry run: reads and simulates as that
//                                                             payer, sends nothing, needs no key
//   node frontend/scripts/venue-sweep.mjs                     dry run as the key's address, unsigned
//   node frontend/scripts/venue-sweep.mjs --live              signs and sends; needs VENUE_SWEEPER_KEYPAIR
// Options: --rpc <url> (default the public mainnet RPC), --program <id> (default the venue's
// pool program; any other is a test chain, where the mainnet owner check does not apply),
// --min-usd <n> (default 0.5: an owner's share worth less waits for a later day).
// Exit 0 when nothing failed (a dry run before the upgrade, which says so, included), 1 when
// anything did, a live run that meets a program with no sweep among them. Plain Node, no package:
// the key never shares a process with third-party code (venue-volume.yml's rule).
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ISLAND_COINS, base58, solanaRpc, SOLANA_RPC, SOL_MINT, USDC_MINT, USDT_MINT, VENUE_PROGRAM } from "./lib/venue-volume-chain.mjs";
import { islandPrices } from "./venue-volume.mjs";
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
/** Anchor's account tag: sha256("account:PoolState")[..8], the first 8 bytes of every real pool. */
export const POOL_TAG = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);
/** Anchor's instruction tag: sha256("global:sweep_fees")[..8]. */
export const SWEEP_FEES_TAG = createHash("sha256").update("global:sweep_fees").digest().subarray(0, 8);
/** Anchor's "instruction not found" (InstructionFallbackNotFound): the program has no sweep. */
const NO_SUCH_INSTRUCTION = 101;
/** What a sweep costs in network fees: one signature, no priority fee. */
const FEE_LAMPORTS = 5000;
/**
 * The largest token account a coin swept here takes: 165 bytes, and 170 for a Token-2022 one with
 * the ImmutableOwner entry the associated token program gives it. (A taxed coin's are larger, and
 * its pools are never swept.)
 */
const ACCOUNT_BYTES = 170;
/**
 * The run stops itself after 9 minutes and still writes its summary. Only a call already under way
 * can run past it, using all its tries (5.5 minutes at most): the reads at the end are made only
 * inside the limit. The workflow's 20 minutes hold both, with room for checkout and Node.
 */
export const RUN_LIMIT_MS = 9 * 60_000;
/** solanaRpc's error once a call has used all its tries (lib/venue-volume-chain.mjs): the RPC is not answering. */
const NO_ANSWER = /: no answer after \d+ tries/;
/** How many times a sent sweep's status is looked at, 1.5 seconds apart, before the job gives up on it. */
const LOOKS = 40;
const NOTHING = "nothing set aside";
const UNPRICED = "no priced coin: not swept by this job";
const DOLLARS = new Set([USDC_MINT, USDT_MINT]);
const ISLAND = new Set(ISLAND_COINS.map((c) => c.mint));

const pk = (d, o) => base58(d.subarray(o, o + 32));
const u64 = (d, o) => d.readBigUInt64LE(o);

/** A cp-swap pool account (states/pool.rs, 637 bytes, PoolState's tag first): what the sweep needs. */
export function decodePool(address, base64) {
  const d = Buffer.from(base64, "base64");
  if (d.length !== POOL_SIZE) throw new Error(`pool ${address} is ${d.length} bytes, not ${POOL_SIZE}`);
  if (!d.subarray(0, 8).equals(POOL_TAG)) throw new Error(`${address} does not start with PoolState's tag: not a pool`);
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

/** `owner`'s two destinations in a pool's sweep, as the program derives them. */
export function destinations(pool, owner) {
  return [associatedTokenAddress(owner, pool.mint0, pool.program0), associatedTokenAddress(owner, pool.mint1, pool.program1)];
}

/** sweep_fees of `owner`'s share (the fund owner's when `fund`), its accounts in the order of `SweepFees` in lib.rs. */
export function sweepFeesIx({ programId, pool, owner, fund }) {
  const authority = findProgramAddress([AUTH_SEED], programId).address;
  const [to0, to1] = destinations(pool, owner);
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
      w(to0),
      w(to1),
      r(TOKEN_PROGRAM),
      r(TOKEN_2022_PROGRAM),
    ],
    data: Buffer.concat([SWEEP_FEES_TAG, Buffer.from([fund ? 1 : 0])]),
  };
}

/** Does this job price the coin: a dollar coin, SOL or one of the island's five? No other coin ever takes a price. */
const priced = (mint) => DOLLARS.has(mint) || mint === SOL_MINT || ISLAND.has(mint);

/**
 * Is one owner's share of a pool (its two counts) worth a transaction today? Counted on the coins
 * priced here: USDC and USDT at $1, SOL and the island's five at `prices` ({ sol, island: { mint:
 * usd } }, null where unread); any other coin counts nothing. With no SOL price, 0.007 SOL of the
 * share stands in for $0.50.
 */
export function worthSweeping(pool, share, prices, minUsd) {
  let usd = 0;
  let solRaw = 0n;
  for (const [i, mint, decimals] of [
    [0, pool.mint0, pool.decimals0],
    [1, pool.mint1, pool.decimals1],
  ]) {
    const price = DOLLARS.has(mint) ? 1 : mint === SOL_MINT ? (prices.sol ?? null) : ISLAND.has(mint) ? (prices.island?.[mint] ?? null) : 0;
    if (price !== null) usd += (Number(share[i]) / 10 ** decimals) * price;
    else if (mint === SOL_MINT) solRaw += share[i];
  }
  return usd >= minUsd || Number(solRaw) / 1e9 >= (0.007 * minUsd) / 0.5;
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

/**
 * A destination as the job reads it: open only when the coin's own token program owns it, and then
 * its delegate (a COption tag, u32 at byte 72), its state (byte 108, 2 = frozen) and its close
 * authority (a COption tag at byte 129), where both token programs keep them in a token account's
 * first 165 bytes. Not open, it carries the lamports already at the address.
 */
export function destinationState(info, tokenProgram) {
  if (!info || info.owner !== tokenProgram) return { open: false, lamports: info?.lamports ?? 0 };
  const d = Buffer.from(info.data[0], "base64");
  return { open: true, delegate: d.readUInt32LE(72) !== 0, frozen: d[108] === 2, closeAuthority: d.readUInt32LE(129) !== 0 };
}

/**
 * What is wrong with one owner's side, named, by the pool program's two rules (the owner's ruling,
 * 2026-11-21). An open destination with a delegate or a close authority `blocks` the side, owed or
 * not: the program refuses it (6020). A freeze leaves only its leg: given `pool` (the pool's own two
 * accounts) and the side's `share`, each coin the side is owed whose destination or pool account is
 * frozen is `left` (the program keeps its count and still moves the other coin), and a frozen
 * destination of a coin the side is not owed is only named. On the vault's side a delegate, a close
 * authority or a frozen USDC or USDT also fails the run, whether or not the other coin is sent; any
 * other freeze is only named. On the Workshop's side a delegate, a close authority or a freeze never
 * fails the run.
 */
function problems({ states, addresses, mints, vault, pool = null, share = null }) {
  const named = [];
  let blocks = false;
  let fails = false;
  states.forEach((s, i) => {
    if (!s.open) return;
    const why = [s.delegate && "has a delegate", s.closeAuthority && "has a close authority", s.frozen && "is frozen"].filter(Boolean);
    if (!why.length) return;
    named.push(`its account \`${addresses[i]}\` for ${mints[i]} ${why.join(" and ")}`);
    if (s.delegate || s.closeAuthority) blocks = true;
    if (vault && (s.delegate || s.closeAuthority || (s.frozen && DOLLARS.has(mints[i])))) fails = true;
  });
  pool?.states.forEach((s, i) => {
    if (!s.open || !s.frozen || share[i] === 0n) return;
    named.push(`the pool's own account \`${pool.addresses[i]}\` for ${mints[i]} is frozen`);
    if (vault && DOLLARS.has(mints[i])) fails = true;
  });
  // Each coin the side is owed whose destination or pool account is frozen (destinationState reads a freeze on an open account only).
  const left = pool ? [0, 1].filter((i) => share[i] > 0n && (states[i].frozen || pool.states[i].frozen)) : [];
  return { named, blocks, left, fails };
}
const said = (p) => `${p.named.join("; ")}${p.fails ? ": read it" : ""}`;
/** A side held back for a delegate or a close authority: nothing is sent. */
const held = (p) => ({ ok: !p.fails, heldBack: true, result: `held back, nothing sent: ${said(p)}` });
/** A side's result with its accounts' problems named after it, failing the run where they do. */
const naming = (r, p) => (p.named.length ? { ...r, ok: r.ok && !p.fails, result: `${r.result}; ${said(p)}` } : r);

/** The custom error number a simulation's `err` carries for instruction `ix`, or null. */
export function customError(err, ix) {
  const e = err?.InstructionError;
  return Array.isArray(e) && e[0] === ix && typeof e[1]?.Custom === "number" ? e[1].Custom : null;
}

/** A raw amount in whole coins, at most 20 decimal places: a mint may claim up to 255 decimals, and Node refuses more than 100. */
export const fmt = (raw, decimals) => (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: Math.min(decimals, 20) });

/** The process's exit code for a run's result: 0 only when it says ok. */
export const exitCode = (res) => (res?.ok === true ? 0 : 1);

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

/** A price only when it is a finite number above 0: JSON's 1e999 reads as Infinity, which is no price. */
const usable = (v) => (Number.isFinite(v) && v > 0 ? v : null);

async function solPrice(fetchImpl) {
  try {
    const r = await fetchImpl("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(10_000) });
    return usable(Number((await r.json())?.data?.amount));
  } catch {
    return null;
  }
}

/**
 * The island coins' prices, read as the volume figure reads them (venue-volume.mjs islandPrices),
 * from Jupiter's keyless host only: never the site's key, which allows one request a second for
 * the whole site. No prices, and the reason, when Jupiter cannot be read.
 */
async function islandCoinPrices(fetchImpl) {
  try {
    const read = await islandPrices(fetchImpl, "");
    return { prices: Object.fromEntries(Object.entries(read).map(([mint, usd]) => [mint, usable(usd)])), error: null };
  } catch (e) {
    return { prices: {}, error: e.message };
  }
}

/**
 * One run. `deps` are injectable for tests: { call (JSON-RPC), fetchImpl, env, log, wait, now }.
 * Returns { ok, notUpgraded, pools: [...], listed, stopped, unvisited, payer, paid, balance,
 * balanceError, keep, prices }. A side's `left` lists the coins a frozen account leaves in the
 * pool: its result never calls them swept. It throws only when it cannot start (no key for a live
 * run, no payer for a dry run).
 */
export async function run(opts, deps) {
  const { call, fetchImpl = globalThis.fetch, env = process.env, log = console.log, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = deps;
  const mainnet = opts.program === VENUE_PROGRAM;
  const signer = env.VENUE_SWEEPER_KEYPAIR ? keypairSigner(env.VENUE_SWEEPER_KEYPAIR) : null;
  if (opts.live && !signer) throw new Error("--live needs VENUE_SWEEPER_KEYPAIR");
  const payer = signer?.address ?? opts.payer;
  if (!payer) throw new Error("a dry run needs --payer <address> or VENUE_SWEEPER_KEYPAIR");

  const res = { ok: true, notUpgraded: false, pools: [], listed: false, stopped: null, unvisited: 0, payer, paid: { opened: 0, rent: 0, sweeps: 0 }, balance: null, balanceError: null, keep: null, prices: null };
  const limit = now() + RUN_LIMIT_MS;
  /** Past the run's time limit? Then the run stops, and says so. */
  const late = () => {
    if (now() <= limit) return false;
    res.stopped ??= `it reached its ${RUN_LIMIT_MS / 60_000}-minute limit`;
    return true;
  };
  // Every call but the reads at the end goes through here: none is made past the time limit, and
  // one that has used all its tries ends the run.
  const rpc = async (method, params) => {
    if (late()) throw Object.assign(new Error(`not asked: the run stopped early (${res.stopped})`), { late: true });
    try {
      return await call(method, params);
    } catch (e) {
      if (NO_ANSWER.test(e?.message ?? "")) res.stopped ??= e.message;
      throw e;
    }
  };

  let listed;
  let tiers;
  let feeCoins;
  try {
    const filters = [{ dataSize: POOL_SIZE }, { memcmp: { offset: 0, bytes: base58(POOL_TAG) } }];
    const raw = await rpc("getProgramAccounts", [opts.program, { encoding: "base64", commitment: "confirmed", filters }]);
    // Mainnet's program has pools: a listing of none there is a wrong answer, not a quiet day.
    if (mainnet && !raw.length) throw new Error("the RPC listed no pool, and mainnet's program has pools");
    res.listed = true;
    // An account that will not decode is a failed row of its own; the rest are still swept.
    listed = raw.map((a) => {
      try {
        return { address: a.pubkey, pool: decodePool(a.pubkey, a.account.data[0]) };
      } catch (e) {
        return { address: a.pubkey, error: e.message };
      }
    });
    const pools = listed.filter((l) => l.pool).map((l) => l.pool);
    const tierKeys = [...new Set(pools.map((p) => p.ammConfig))];
    const tierInfos = tierKeys.length ? (await rpc("getMultipleAccounts", [tierKeys, { encoding: "base64", commitment: "confirmed" }])).value : [];
    // A tier that will not decode fails only its own pools.
    tiers = new Map(
      tierKeys.map((k, i) => {
        try {
          return [k, tierInfos[i] ? decodeTier(k, tierInfos[i].data[0]) : null];
        } catch (e) {
          return [k, { error: e.message }];
        }
      })
    );
    feeCoins = await transferFeeCoins(rpc, pools);
  } catch (e) {
    res.ok = false;
    res.stopped ??= `the pools could not be read: ${e.message}`;
    res.unvisited = listed?.length ?? 0;
    return res;
  }
  const solUsd = await solPrice(fetchImpl);
  const inPools = ISLAND_COINS.filter((c) => listed.some((l) => l.pool && (l.pool.mint0 === c.mint || l.pool.mint1 === c.mint)));
  const island = inPools.length ? await islandCoinPrices(fetchImpl) : { prices: {}, error: null };
  const prices = { sol: solUsd, island: island.prices };
  res.prices = { ...prices, islandError: island.error, unpriced: inPools.filter((c) => island.prices[c.mint] == null).map((c) => c.symbol), floor: opts.minUsd };
  const islandText = !inPools.length
    ? "none in a pool"
    : island.error
      ? `unread (${island.error})`
      : inPools.map((c) => `${c.symbol} ${island.prices[c.mint] == null ? "unpriced" : `$${island.prices[c.mint]}`}`).join(", ");
  log(`${listed.length} pools on ${opts.program}; SOL ${solUsd == null ? "price unread" : `$${solUsd}`}; island coins ${islandText}; payer ${payer}; ${opts.live ? "LIVE" : "dry run"}`);

  /**
   * Simulates one transaction and, in a live run, sends it and waits for the chain: what came of
   * it. `created` are the vault's accounts it opens ({ address, before: the lamports already there });
   * `only`, when a frozen leg stays in the pool, says what the sweep moves and what it leaves.
   */
  const sendOne = async (label, ixs, created = [], only = "") => {
    // A finalized blockhash, which every node knows: a node a few slots behind still takes the send.
    const { blockhash, lastValidBlockHeight } = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value;
    const compiled = compileLegacy({ payer, instructions: ixs, recentBlockhash: blockhash });
    // Every simulation, dry run or live, is of the bare message as the payer, unsigned: a live run
    // signs only once it has decided to send.
    const bare = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), compiled.message]);
    const config = { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" };
    // The accounts it opens, as the simulation leaves them: their rent is what the key pays for them.
    if (created.length) config.accounts = { encoding: "base64", addresses: created.map((c) => c.address) };
    const sim = (await rpc("simulateTransaction", [bare.toString("base64"), config])).value;
    if (sim.err) {
      const code = customError(sim.err, ixs.length - 1);
      if (code === NO_SUCH_INSTRUCTION) {
        // Before the upgrade a dry run says so and passes. Live, it can only mean the program was
        // rolled back or is not the venue's, and the run fails.
        return opts.live
          ? { ok: false, notUpgraded: true, result: "the pool program has no sweep (not upgraded, or rolled back): nothing sent, and a live run fails on it" }
          : { ok: true, notUpgraded: true, result: "the pool program has no sweep yet (not upgraded): nothing sent" };
      }
      return { ok: false, result: `the simulation refused it: ${JSON.stringify(sim.err)}; ${(sim.logs ?? []).slice(-3).join("; ")}` };
    }
    // Each account it opens with its rent, as the simulation leaves it: null where that was not read.
    const opens = created.map((c, i) => ({ address: c.address, rent: sim.accounts?.[i] ? sim.accounts[i].lamports - c.before : null }));
    // `fee`: the network fee is paid (or, in a dry run, would be); `opens` count only when its accounts are really opened.
    if (!opts.live) return { ok: true, clean: true, fee: true, opens, result: `simulated clean (${sim.unitsConsumed ?? "?"} compute units); a live run would send it${only && `, sweeping ${only}`}` };
    if (late()) return { ok: false, result: "not sent: the run stopped early" };
    const wire = signTransaction(compiled, signer);
    // The signature is in the signed bytes (the 64 after their count): it is logged before the send.
    const signature = base58(wire.subarray(1, 65));
    log(`sending ${label}: ${signature}`);
    let answered = null;
    try {
      await rpc("sendTransaction", [wire.toString("base64"), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }]);
    } catch (e) {
      // An answer lost after the transaction reached the chain makes the transport's repeat answer
      // "already processed": the chain is asked what came of it, unless the RPC has stopped answering.
      answered = e.message;
      if (res.stopped) return { ok: false, signature, result: `sending got no answer (${answered}): look its signature up on chain` };
    }
    let landed = null;
    let expired = false;
    try {
      for (let i = 0; i < LOOKS && landed === null; i++) {
        await wait(1500);
        const st = (await rpc("getSignatureStatuses", [[signature]])).value[0];
        if (st?.err) landed = false;
        else if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") landed = true;
        else if ((await rpc("getBlockHeight", [{ commitment: "confirmed" }])) > lastValidBlockHeight) {
          expired = true;
          break;
        }
      }
    } catch (e) {
      const why = e.late ? "the run stopped before the chain confirmed it: look its signature up" : `its status could not be read: ${e.message}`;
      return { ok: false, signature, result: answered ? `its send answered an error (${answered}), and ${why}` : `sent, but ${why}` };
    }
    const after = answered ? ` (its send answered: ${answered})` : "";
    if (landed) return { ok: true, sent: true, swept: true, fee: true, signature, opens, result: `swept${only && ` ${only}`}${after}` };
    if (landed === false) return { ok: false, sent: true, fee: true, signature, result: `sent, and it failed on chain${after}` };
    if (expired) {
      return {
        ok: false,
        signature,
        result: answered ? `sending failed (${answered}), and it was not seen on chain before its blockhash expired` : "sent, but not seen on chain before its blockhash expired: tomorrow's run tries again",
      };
    }
    // The looks ran out first: its blockhash had not expired at the last one, so it may still land.
    const unseen = `not confirmed after ${LOOKS} looks, though its blockhash had not expired at the last one: look its signature up`;
    return { ok: false, signature, result: answered ? `its send answered an error (${answered}), and it was ${unseen}` : `sent, but ${unseen}` };
  };

  /** One side, its error kept on its own row; once the run has stopped, not tried at all. */
  const attempt = async (fn) => {
    if (res.stopped) return { ok: false, result: "not tried: the run stopped early" };
    try {
      return await fn();
    } catch (e) {
      return { ok: false, result: e.late ? "not tried: the run stopped early" : `error: ${e.message}` };
    }
  };

  const owed = (share) => share.some((x) => x > 0n);
  const shareOf = (pool, share) => `${fmt(share[0], pool.decimals0)} of ${pool.mint0} + ${fmt(share[1], pool.decimals1)} of ${pool.mint1}`;
  const nothing = { ok: true, result: NOTHING };
  const under = { ok: true, result: `under the $${opts.minUsd} floor: waits` };

  /** One pool: its row says what came of each owner's side. */
  const sweepPool = async (pool, row) => {
    const tier = tiers.get(pool.ammConfig);
    if (!tier || tier.error) {
      row.note = `its fee tier ${pool.ammConfig} could not be read${tier?.error ? `: ${tier.error}` : ""}`;
      res.ok = false;
      return;
    }
    if (mainnet && (tier.protocolOwner !== VAULT || tier.fundOwner !== WORKSHOP)) {
      row.note = `its fee tier names ${tier.protocolOwner} and ${tier.fundOwner}, not the vault and the Workshop: not swept, read it`;
      res.ok = false;
      return;
    }
    if (!owed(pool.protocol) && !owed(pool.fund)) {
      row.note = NOTHING;
      return;
    }
    const taxed = [pool.mint0, pool.mint1].find((m) => feeCoins.has(m));
    if (taxed) {
      const bps = feeCoins.get(taxed);
      if (bps === null) {
        row.note = `held back: the transfer fee of ${taxed} could not be read`;
        res.ok = false;
      } else {
        row.note = `held back: ${taxed} takes ${bps / 100}% of every transfer, so the pool program leaves its shares in the pool for the owners to collect by hand; this job leaves the whole pool to them`;
      }
      return;
    }
    if (!priced(pool.mint0) && !priced(pool.mint1)) {
      Object.assign(row, { note: UNPRICED, venue: { share: shareOf(pool, pool.protocol) }, island: { share: shareOf(pool, pool.fund) } });
      return;
    }
    // Each owner's own share against the floor: one side waiting never sends the other's dust.
    const venueDue = owed(pool.protocol) && worthSweeping(pool, pool.protocol, prices, opts.minUsd);
    const islandDue = owed(pool.fund) && worthSweeping(pool, pool.fund, prices, opts.minUsd);
    if (!venueDue && !islandDue) {
      row.note = `under the $${opts.minUsd} floor: waits`;
      return;
    }
    row.venue = { share: shareOf(pool, pool.protocol) };
    row.island = { share: shareOf(pool, pool.fund) };
    row.created = 0;
    const coins = [
      [pool.mint0, pool.program0],
      [pool.mint1, pool.program1],
    ];
    const mints = [pool.mint0, pool.mint1];
    const decimals = [pool.decimals0, pool.decimals1];
    const vaultTo = destinations(pool, tier.protocolOwner);
    const workshopTo = destinations(pool, tier.fundOwner);
    const poolOwn = [pool.vault0, pool.vault1];
    /**
     * One read of the `owners`' destinations, the pool's own two accounts and the pool itself: each
     * owner's two as destinationState reads them, the pool's two, and the pool's two shares as they
     * stand now, so a share swept or collected since the listing is not sent for again.
     */
    const read = async (owners) => {
      const to = owners.flat();
      const infos = (await rpc("getMultipleAccounts", [[...to, ...poolOwn, pool.address], { encoding: "base64", commitment: "confirmed" }])).value;
      const states = (from) => coins.map(([, tokenProgram], i) => destinationState(infos[from + i], tokenProgram));
      const again = infos[to.length + 2];
      if (!again) throw new Error(`the pool ${pool.address} could not be read again`);
      const { protocol, fund } = decodePool(pool.address, again.data[0]);
      return { dest: owners.map((_, k) => states(2 * k)), pooled: { states: states(to.length), addresses: poolOwn }, protocol, fund };
    };
    // Every account a side's transfer touches, in one read: both owners' destinations (each owner's
    // are checked whenever they are read, whichever side is due), the pool's own two, and the pool.
    const first = await read([vaultTo, workshopTo]);
    const [vaultDest, workshopDest] = first.dest;
    row.venue.share = shareOf(pool, first.protocol);
    row.island.share = shareOf(pool, first.fund);
    /** Each coin's amount in `raw` above 0, as "<amount> of <mint>", joined with "and". */
    const amounts = (raw) =>
      raw
        .map((x, i) => (x > 0n ? `${fmt(x, decimals[i])} of ${mints[i]}` : null))
        .filter(Boolean)
        .join(" and ");
    /**
     * One side by the program's two rules (`p` from problems()): held back for a delegate or a
     * close authority. Otherwise each frozen leg is left in the pool and counts nothing toward the
     * floor, and `send(only)` sends the rest once it passes on its own, `only` saying what moves.
     * What is wrong is named after the result either way.
     */
    const side = async (p, share, send) => {
      if (p.blocks) return held(p);
      if (!p.left.length) return naming(await send(""), p);
      const moving = share.map((x, i) => (p.left.includes(i) ? 0n : x));
      const stays = `${amounts(share.map((x, i) => (p.left.includes(i) ? x : 0n)))} ${p.left.length > 1 ? "are" : "is"} left in the pool`;
      const leaving = (r) => ({ ...naming(r, p), left: p.left.map((i) => mints[i]) });
      if (!owed(moving)) return leaving({ ok: true, result: `waits, nothing sent: ${stays}` });
      if (!worthSweeping(pool, moving, prices, opts.minUsd)) return leaving({ ok: true, result: `waits: what can move is under the $${opts.minUsd} floor, and ${stays}` });
      return leaving(await send(`${amounts(moving)} only, and ${stays}`));
    };
    /** The venue's sweep, after the vault's missing accounts are opened: they and their rent stay the venue's. */
    const sendVenue = (only) => {
      const opens = coins.map(([mint, tokenProgram], i) => ({ mint, tokenProgram, address: vaultTo[i], before: vaultDest[i].lamports })).filter((_, i) => !vaultDest[i].open);
      row.created = opens.length;
      const ixs = [...opens.map(({ mint, tokenProgram }) => createIdempotentIx({ payer, owner: tier.protocolOwner, mint, tokenProgram })), sweepFeesIx({ programId: opts.program, pool, owner: tier.protocolOwner, fund: false })];
      return sendOne(`the venue's sweep of ${pool.address}`, ixs, opens, only);
    };
    const sendIsland = (only) => sendOne(`the island's sweep of ${pool.address}`, [sweepFeesIx({ programId: opts.program, pool, owner: tier.fundOwner, fund: true })], [], only);
    /**
     * One side on its share as the read found it: nothing set aside, under the floor, or `go`. What
     * is wrong with its accounts (`p` from problems(), the pool's own two included) is named either
     * way, and on the vault's side fails the run where it does.
     */
    const weigh = async (p, share, go) => (!owed(share) ? naming(nothing, p) : !worthSweeping(pool, share, prices, opts.minUsd) ? naming(under, p) : attempt(go));
    const venueP = problems({ states: vaultDest, addresses: vaultTo, mints, vault: true, pool: first.pooled, share: first.protocol });
    Object.assign(row.venue, await weigh(venueP, first.protocol, () => side(venueP, first.protocol, sendVenue)));
    const islandSide = (dest, pooled, share) => {
      const p = problems({ states: dest, addresses: workshopTo, mints, vault: false, pool: pooled, share });
      return weigh(p, share, async () => {
        // The Workshop's are never opened here: its share waits until the island holds both, and
        // what is wrong with the one it holds is named meanwhile.
        const lacking = coins.map(([mint], i) => ({ mint, address: workshopTo[i] })).filter((_, i) => !dest[i].open);
        if (lacking.length) {
          row.missing = lacking;
          return naming({ ok: true, result: `waits: the Workshop has no account yet for ${lacking.map((m) => m.mint).join(" or ")}` }, p);
        }
        return side(p, share, sendIsland);
      });
    };
    // The venue's sweep, once sent, took seconds or more: the Workshop's accounts, the pool's own
    // two and the pool are read again before the island's side goes.
    if (!row.venue.signature || !owed(first.fund)) Object.assign(row.island, await islandSide(workshopDest, first.pooled, first.fund));
    else {
      Object.assign(
        row.island,
        await attempt(async () => {
          const again = await read([workshopTo]);
          row.island.share = shareOf(pool, again.fund);
          return islandSide(again.dest[0], again.pooled, again.fund);
        })
      );
    }
  };

  const opened = new Map();
  for (const [i, item] of listed.entries()) {
    if (res.stopped || late()) {
      res.unvisited = listed.length - i;
      break;
    }
    const row = { pool: item.address };
    res.pools.push(row);
    if (item.error) {
      row.error = item.error;
      res.ok = false;
      continue;
    }
    try {
      await sweepPool(item.pool, row);
    } catch (e) {
      // An error stays on its pool's row, and the run goes on to the next pool.
      row.error = e.message;
      res.ok = false;
    }
    for (const s of [row.venue, row.island]) {
      if (!s?.result) continue;
      if (!s.ok) res.ok = false;
      if (s.notUpgraded) res.notUpgraded = true;
      // A fee for each sweep the chain has seen, a failed one too, or a dry run would send; none for one never seen.
      if (s.fee) res.paid.sweeps++;
      // Each account once: in a dry run every pool's simulation opens it afresh.
      for (const o of s.opens ?? []) if (!opened.has(o.address)) opened.set(o.address, o.rent);
    }
  }
  res.paid.opened = opened.size;
  res.paid.rent = [...opened.values()].reduce((sum, r) => (sum === null || r === null ? null : sum + r), 0);
  if (res.stopped) {
    res.ok = false;
    return res;
  }
  // At the end: what one more sweep that opens a vault account needs the payer to hold (the least
  // it must keep, and the rent of one account of the largest size), then one read of what it holds.
  // They only feed the summary, so each is made only inside the time limit, and none after one the
  // RPC left unanswered: only a call already under way can run past the limit.
  let answering = true;
  const endRead = async (method, params) => {
    if (!answering || now() > limit) throw Object.assign(new Error("not asked"), { skipped: true });
    try {
      return await call(method, params);
    } catch (e) {
      if (NO_ANSWER.test(e?.message ?? "")) answering = false;
      throw e;
    }
  };
  try {
    res.keep = { floor: await endRead("getMinimumBalanceForRentExemption", [0]), rent: await endRead("getMinimumBalanceForRentExemption", [ACCOUNT_BYTES]) };
  } catch {
    res.keep = null;
  }
  try {
    res.balance = (await endRead("getBalance", [payer, { commitment: "confirmed" }])).value;
  } catch (e) {
    if (!e.skipped) res.balanceError = e.message;
  }
  return res;
}

export function summary(res, opts) {
  // A cell holds no table syntax: a "|" is escaped and a line break becomes a space.
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = [
    `### Venue sweep (${opts.live ? "live" : "dry run"})`,
    "",
    "| Pool | Result | Venue's share | Its sweep | Island's share | Its sweep |",
    "|---|---|---|---|---|---|",
  ];
  const side = (s) => (s ? `${s.result ?? ""}${s.signature ? ` \`${s.signature}\`` : ""}` : "");
  const waits = (r) => r.note?.startsWith("under the");
  for (const r of res.pools) {
    if (r.note === NOTHING || waits(r)) continue;
    lines.push(`| \`${r.pool}\` | ${[r.error ?? r.note, r.venue?.share, side(r.venue), r.island?.share, side(r.island)].map(cell).join(" | ")} |`);
  }
  const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const n = (x) => x.toLocaleString("en-US");
  lines.push("", `${res.pools.filter((r) => r.note === NOTHING).length} pools have nothing set aside; ${res.pools.filter(waits).length} are under the floor and wait.`);
  if (res.pools.some((r) => r.note === UNPRICED)) {
    lines.push("", "A pool with no SOL, USDC, USDT or island coin has no price here, so this job never sweeps it: its shares wait for a hand collect.");
  }
  const missing = [...new Map(res.pools.flatMap((r) => r.missing ?? []).map((m) => [m.address, m])).values()];
  if (missing.length) {
    lines.push("", `The Workshop has no token account yet for these coins, so the island's share of their pools waits until it opens them: ${missing.map((m) => `${m.mint} (\`${m.address}\`)`).join(", ")}.`);
  }
  if (res.prices?.unpriced.length) {
    const why = res.prices.islandError ? ` (${cell(res.prices.islandError)})` : "";
    lines.push("", `No price today for ${res.prices.unpriced.join(", ")}${why}: their shares counted as nothing against the floor.`);
  }
  if (res.prices && res.prices.sol == null) {
    const sol = ((0.007 * res.prices.floor) / 0.5).toLocaleString("en-US", { maximumFractionDigits: 9 });
    lines.push("", `SOL's price was not read today, so ${sol} SOL stood in for the $${res.prices.floor} floor.`);
  }
  if (res.stopped) lines.push("", `The run stopped early (${cell(res.stopped)}); ${res.listed ? `${count(res.unvisited, "pool")} not looked at` : "the pools were not listed"}.`);
  const p = res.paid;
  const rent = p.rent === null ? "its rent not read" : `${n(p.rent)} lamports of rent, which stays the vault's`;
  const balance = res.balance != null ? `\`${res.payer}\` holds ${n(res.balance)} lamports` : `The balance of \`${res.payer}\` ${res.balanceError ? "could not be read" : "was not read"}`;
  lines.push(
    "",
    `${opts.live ? "Paid by the key" : "A live run would pay"}: ${count(p.opened, "account")} opened for the vault (${rent}); ${count(p.sweeps, "sweep")} ${opts.live ? "seen on chain" : "sent"} (${n(p.sweeps * FEE_LAMPORTS)} lamports of network fees). ${balance}.`
  );
  const need = res.keep ? res.keep.floor + res.keep.rent + FEE_LAMPORTS : null;
  if (need !== null && res.balance != null && res.balance < need) {
    lines.push("", `That is under the ${n(need)} lamports one more sweep that opens one vault account needs (${n(res.keep.floor)} the payer must keep, ${n(res.keep.rent)} of rent and ${n(FEE_LAMPORTS)} of fee): fund it.`);
  }
  return lines.join("\n");
}

async function main() {
  const report = (text) => {
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = await run(opts, { call: solanaRpc({ url: opts.rpc }) });
    report(summary(res, opts));
    process.exitCode = exitCode(res);
  } catch (e) {
    // Only a run that could not start lands here, and the summary still says why.
    console.error(`venue sweep: ${e.message}`);
    report(`### Venue sweep\n\nIt did not run: ${e.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
