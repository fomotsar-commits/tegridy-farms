// The venue's total value locked, `?resource=venue-tvl` on the catchall, for the home page.
// Read from the chains when asked, at most once a minute per instance (the edge keeps the
// answer for a minute too), and stored nowhere. A chain that cannot be read is named in the
// answer and left out of the total, which then says it is partial: never a zero.
//
// WHAT IS COUNTED, AND AT WHAT VALUE
//   - Solana, our pool program: every pool holding SOL, USDC or BAYLA, at twice that coin
//     (the highest-ranked one it holds, pool-index.js's rule). The two sides of a
//     constant-product pool are worth the same at its price.
//   - Solana, our range-pool program: the SOL, USDC and BAYLA it holds, and nothing for any
//     other coin. A range pool's price is whatever its depositors set, so valuing its other
//     side at that price would let anyone make the total say anything.
//   - Ethereum, Base and Robinhood: every pair our factory made that holds WETH, at twice it.
// Only those coins add dollars, so pools of worthless tokens add nothing: the figure moves
// only when SOL, USDC, BAYLA or ETH really sit in our pools.
//
// PRICES: SOL and ETH from Coinbase, then CoinGecko (the volume counter's spotPrice). USDC is
// a dollar. BAYLA is valued at its price in our deepest BAYLA/SOL pool, else BAYLA/USDC; with
// neither, the pools it would value are left out and the answer says so.
//
// WHAT IS STAKED, AND AT WHAT VALUE (owner 2026-10-30: the total left out the staking pools)
//   - Every staking pool we run, live or retired (a retired pool keeps what people staked until
//     they take it out), at the pool's own count of what was staked. Never its token balance:
//     a ladder or lighthouse pays its rewards out of the coin it holds.
//   - Each staked coin at its market price: Jupiter's on Solana, DefiLlama's on Ethereum and
//     Base. Not at a price in our own pools, staked BAYLA included: far more BAYLA is staked than
//     any of our pools holds, so a pool price one depositor can lean on would move the total by
//     far more than that deposit. A coin with no market price is left out and the answer says so.
//   - Not counted: the LP farm (its LP tokens are shares of one of our pairs, counted above) and
//     the JBAC vault (NFTs, which have no price here).
import { base58 } from "@scure/base";
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { CP_SWAP_PROGRAM, OFFSETS, POOL_DISCRIMINATOR_B58, POOL_STATE_LEN, QUOTE_COINS } from "./pool-index.js";
import { EVM_CHAINS } from "../../scripts/lib/venue-volume-chain.mjs";
import { spotPrice } from "../../scripts/venue-volume.mjs";

/** The range-pool program and its PoolState, copied from src/lib/solana/clmm (a test pins them). */
export const RANGE_PROGRAM = "7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso";
export const RANGE_POOL_LEN = 1544;
export const RANGE_OFFSETS = Object.freeze({ tokenMint0: 73, tokenMint1: 105, tokenVault0: 137, tokenVault1: 169 });

/** The two Solana programs, each with where its pool keeps its mints and vaults. */
export const SOLANA_PROGRAMS = Object.freeze([
  Object.freeze({
    program: CP_SWAP_PROGRAM,
    size: POOL_STATE_LEN,
    mint0: OFFSETS.token0Mint,
    mint1: OFFSETS.token1Mint,
    vault0: OFFSETS.token0Vault,
    vault1: OFFSETS.token0Vault + 32,
    doubled: true,
  }),
  Object.freeze({
    program: RANGE_PROGRAM,
    size: RANGE_POOL_LEN,
    mint0: RANGE_OFFSETS.tokenMint0,
    mint1: RANGE_OFFSETS.tokenMint1,
    vault0: RANGE_OFFSETS.tokenVault0,
    vault1: RANGE_OFFSETS.tokenVault1,
    doubled: false,
  }),
]);
export const EVM_TVL_CHAINS = Object.freeze(["ethereum", "base", "robinhood"]);

/** The two Solana staking programs: where each pool account keeps its count of what is staked
 *  (a u64, after the 8-byte discriminator). Both keep the staked coin's mint at byte 10. */
export const STAKE_PROGRAMS = Object.freeze({
  // bayla-ladder's Pool.total_principal (src/lib/ladder/program.ts; a test pins it).
  ladder: Object.freeze({ program: "EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ", discriminator: Object.freeze([241, 154, 109, 4, 17, 177, 109, 188]), staked: 243 }),
  // Streamflow's StakePool.total_stake (the SDK's own IDL; a test pins it).
  streamflow: Object.freeze({ program: "STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH", discriminator: Object.freeze([121, 34, 206, 21, 79, 127, 255, 28]), staked: 203 }),
});
export const STAKE_MINT_OFFSET = 10;

const BAYLA_MINT = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
/** Every Solana staking pool, with the coin it takes (src/lib/bungalows.ts; a test pins the list). */
export const SOLANA_STAKE_POOLS = Object.freeze(
  [
    ["Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV", "ladder", BAYLA_MINT], // BAYLA lock ladder
    ["EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f", "streamflow", BAYLA_MINT], // BAYLA lighthouse
    ["4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp", "streamflow", BAYLA_MINT], // BAYLA, retired
    ["PkwDYVNxyesAukE9STqRQL9H1pBpXbt1tVbiYVMX96w", "streamflow", "4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump"], // BOBO
    ["5hgUVCWW4fwM7oq3SQyaj5ucVQFa2dQ4YqQc4JqrGXHj", "streamflow", "8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump"], // SOY
    ["2qSZBzjpxKzhJWmyaoN5kP3XQxUikH3SQR5suXuQjkZR", "streamflow", "4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump"], // BRAINLET
    ["BZ1rGCD8G5kXyKkXxmNh2Xf92QLz4PUZitzauMEdxd5c", "streamflow", "5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k"], // RIZZ
  ].map(([pool, kind, mint]) => Object.freeze({ pool, kind, mint })),
);

const TOTAL_STAKED = "0x817b1cd2"; // TegridyStaking's totalStaked()
const TOTAL_SUPPLY = "0x18160ddd"; // a ladder's or lighthouse's totalSupply(): staked, never boosted
const TOWELI = "0x420698cfdeddea6bc78d59bc17798113ad278f9d";
/** Every EVM staking contract, with the coin it takes and how it counts what is staked
 *  (scripts/addresses.json; a test pins the list). */
export const EVM_STAKE_POOLS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      ethereum: [
        ["0xcadc93e96de58ea554c71ca609974625615e046d", TOWELI, TOTAL_STAKED], // tegridy-staking
        ["0x044a925839ac3cec0bccc93d00230f39ffbeee44", TOWELI, TOTAL_STAKED], // legacy-staking-v1, withdraw-only
        ["0x626644523d34b84818df602c991b4a06789c4819", TOWELI, TOTAL_STAKED], // legacy-staking-v2, withdraw-only
        ["0xbe1905de5fcde60e13a9f1afa44befde1c5aaa1d", "0x6982508145454ce325ddbe47a25d4ec3d2311933", TOTAL_SUPPLY], // ladder-pepe
        ["0xdc0b34ce782029f30382f42097f6b33f0544329c", "0x6982508145454ce325ddbe47a25d4ec3d2311933", TOTAL_SUPPLY], // ladder-pepe-retired
        ["0xa43f3f1c4171a8c9a1be4dc6eaa9a16ab94f6c32", "0x6982508145454ce325ddbe47a25d4ec3d2311933", TOTAL_SUPPLY], // lighthouse-pepe, retired
      ],
      base: [
        ["0x55b72f09d31f43834bf7eba42f53a419a716f554", "0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf", TOTAL_SUPPLY], // ladder-qr
        ["0xdcc3a95a0921b83326157132b17770f02094c8e3", "0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf", TOTAL_SUPPLY], // ladder-qr-retired
        ["0x820246a4eb6e1ad7e571e8581bdb127020adb469", "0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf", TOTAL_SUPPLY], // lighthouse-qr, retired
        ["0xecb3c54488a2a0df764444f67b2df6b8ad4eadd6", "0xe3086852a4b125803c815a158249ae468a3254ca", TOTAL_SUPPLY], // ladder-mfer
        ["0x7288dbf43d3bdbfc439b6e8a47aef225d4816273", "0xe3086852a4b125803c815a158249ae468a3254ca", TOTAL_SUPPLY], // ladder-mfer-retired
        ["0x79ff1bdf7ed6b09c24d4766fb4a82aa28398b548", "0xe3086852a4b125803c815a158249ae468a3254ca", TOTAL_SUPPLY], // lighthouse-mfer, retired
        ["0xe6abc8aca0415afac426ec1242bb17afabe8dbcf", "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b", TOTAL_SUPPLY], // ladder-bnkr
        ["0xe0a152ebc21891fd47a7dcd6018cfe3a64363178", "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b", TOTAL_SUPPLY], // ladder-bnkr-retired
        ["0x2a5f65f4c74b1e49e77ae9a57e20fbdb0ced11d2", "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b", TOTAL_SUPPLY], // lighthouse-bnkr, retired
        ["0x0acb93fcfd5b1950d94064998017a2601b36d7bb", "0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2", TOTAL_SUPPLY], // ladder-drb
        ["0xb62bad165997e95c503044787b2dcc85dc6d83f1", "0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2", TOTAL_SUPPLY], // ladder-drb-retired
        ["0xa2e7e7fae91846e4c92af7f4b43b24cdd9abf4f5", "0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2", TOTAL_SUPPLY], // lighthouse-drb, retired
        ["0x3c339692ec7b3b96ad6f8fbeb5f5202164b44465", "0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d", TOTAL_SUPPLY], // ladder-jbm
        ["0xa0d43ef39c4940e68b2f81d51e6316a45c136d93", "0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d", TOTAL_SUPPLY], // ladder-jbm-retired
        ["0xf261940cdc04d8f2422345ff6091d6fa601541fa", "0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d", TOTAL_SUPPLY], // lighthouse-jbm, retired
      ],
    }).map(([chain, rows]) => [chain, Object.freeze(rows.map(([address, token, staked]) => Object.freeze({ address, token, staked })))]),
  ),
);
/** The chains with staking, in the order the answer lists them. */
export const STAKE_CHAINS = Object.freeze(["solana", ...Object.keys(EVM_STAKE_POOLS)]);

/** More pools than this on one program, or pairs on one factory, reads as "could not read". */
export const MAX_POOLS = 5000;
export const MAX_PAIRS = 1000;
const SCAN_CAP_BYTES = 8 * 1024 * 1024;
const RPC_TIMEOUT_MS = 8000;
const VAULT_CHUNK = 100;
const CACHE_MS = 60_000;
const PARTIAL_CACHE_MS = 15_000;
const RATE = { limit: 30, windowSec: 60, identifier: "venue-tvl" };
const GLOBAL = { limit: 60, windowSec: 60, identifier: "venue-tvl" };

const COIN_BY_MINT = new Map(QUOTE_COINS.map((c, rank) => [c.mint, { ...c, rank }]));
const [SOL, USDC, BAYLA] = QUOTE_COINS;

let cached = null; // { at, body }
let inflight = null;
const pairCache = new Map(); // chain -> [{ address, wethSide }], pairs never change once made
const priceCache = new Map(); // symbol, or chain:coin for a market price -> { at, usd }
const decimalsCache = new Map(); // chain:coin -> decimals, which never change

/** Tests only: forget every cached answer, pair, price and decimals. */
export function __resetVenueTvl() {
  cached = null;
  inflight = null;
  pairCache.clear();
  priceCache.clear();
  decimalsCache.clear();
}

function solanaUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

async function solanaRpc(method, params, fetchImpl, capBytes = 1024 * 1024) {
  const res = await fetchImpl(solanaUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`solana HTTP ${res.status}`);
  const { text, truncated } = await readBoundedText(res, capBytes);
  if (truncated) throw new Error("solana answer over cap");
  const parsed = JSON.parse(text);
  if (parsed?.error) throw new Error(`solana error ${String(parsed.error.code ?? "")}`);
  if (!parsed || !("result" in parsed)) throw new Error("solana answer carried no result");
  return parsed.result;
}

/** Every pool on one program: its two mints and two vaults. */
async function scanPrograms(layout, fetchImpl) {
  const start = Math.min(layout.mint0, layout.mint1, layout.vault0, layout.vault1);
  const length = Math.max(layout.mint0, layout.mint1, layout.vault0, layout.vault1) + 32 - start;
  const result = await solanaRpc(
    "getProgramAccounts",
    [
      layout.program,
      {
        encoding: "base64",
        commitment: "confirmed",
        dataSlice: { offset: start, length },
        filters: [{ dataSize: layout.size }, { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } }],
      },
    ],
    fetchImpl,
    SCAN_CAP_BYTES,
  );
  if (!Array.isArray(result)) throw new Error("solana scan carried no list");
  if (result.length > MAX_POOLS) throw new Error(`more than ${MAX_POOLS} pools on ${layout.program}`);
  const key = (d, at) => base58.encode(Uint8Array.from(d.subarray(at - start, at - start + 32)));
  return result.map((item) => {
    const b64 = item?.account?.data?.[0];
    const d = typeof b64 === "string" ? Buffer.from(b64, "base64") : null;
    if (!d || d.length !== length) throw new Error("solana scan carried a wrong-sized slice");
    return {
      sides: [
        { mint: key(d, layout.mint0), vault: key(d, layout.vault0) },
        { mint: key(d, layout.mint1), vault: key(d, layout.vault1) },
      ],
    };
  });
}

/** Each vault's balance in whole coins, checked to hold the coin under the coin's own token program. */
async function readVaults(wanted, fetchImpl) {
  const keys = [...wanted.keys()];
  const out = new Map();
  for (let i = 0; i < keys.length; i += VAULT_CHUNK) {
    const chunk = keys.slice(i, i + VAULT_CHUNK);
    const r = await solanaRpc("getMultipleAccounts", [chunk, { encoding: "jsonParsed", commitment: "confirmed" }], fetchImpl);
    if (!Array.isArray(r?.value) || r.value.length !== chunk.length) throw new Error("solana vault answer has the wrong shape");
    r.value.forEach((acc, j) => {
      const coin = wanted.get(chunk[j]);
      const info = acc?.data?.parsed?.info;
      const amount = info?.tokenAmount?.amount;
      const decimals = info?.tokenAmount?.decimals;
      if (!acc || acc.owner !== coin.program || info?.mint !== coin.mint || typeof amount !== "string" || !/^\d+$/.test(amount) || !Number.isInteger(decimals)) {
        throw new Error(`vault ${chunk[j]} does not read as a ${coin.symbol} account`);
      }
      out.set(chunk[j], Number(amount) / 10 ** decimals);
    });
  }
  return out;
}

/**
 * The Solana side: both programs, valued. `{ usd, pools, unvalued }`, where `unvalued`
 * counts pools left out because BAYLA had no price. Throws when any read failed.
 */
export async function readSolana({ fetchImpl, priceOf }) {
  const programs = await Promise.all(SOLANA_PROGRAMS.map((layout) => scanPrograms(layout, fetchImpl)));
  // What each pool counts: the cp-swap pool its top coin, doubled; a range pool every coin.
  const counted = [];
  const wanted = new Map();
  programs.forEach((pools, p) => {
    const { doubled } = SOLANA_PROGRAMS[p];
    for (const pool of pools) {
      const coinSides = pool.sides.filter((s) => COIN_BY_MINT.has(s.mint));
      if (!coinSides.length) continue;
      const sides = doubled ? [coinSides.reduce((a, b) => (COIN_BY_MINT.get(a.mint).rank <= COIN_BY_MINT.get(b.mint).rank ? a : b))] : coinSides;
      counted.push({ sides, factor: doubled ? 2 : 1, both: doubled && coinSides.length === 2 ? coinSides : null });
      // Both coin vaults of a coin/coin pool: BAYLA's price is read from them.
      for (const s of doubled ? coinSides : sides) wanted.set(s.vault, COIN_BY_MINT.get(s.mint));
    }
  });
  const held = wanted.size ? await readVaults(wanted, fetchImpl) : new Map();

  if (!counted.length) return { usd: 0, pools: 0, unvalued: 0 };
  const usd = { [SOL.mint]: await priceOf("SOL"), [USDC.mint]: 1, [BAYLA.mint]: null };
  usd[BAYLA.mint] = baylaUsd(counted, held, usd);

  let total = 0;
  let unvalued = 0;
  for (const c of counted) {
    const prices = c.sides.map((s) => usd[s.mint]);
    if (prices.some((v) => v === null)) {
      unvalued++;
      continue;
    }
    total += c.factor * c.sides.reduce((sum, s, i) => sum + held.get(s.vault) * prices[i], 0);
  }
  return { usd: total, pools: counted.length - unvalued, unvalued };
}

/** BAYLA in dollars from our deepest BAYLA/SOL pool, else BAYLA/USDC; null with neither. */
function baylaUsd(counted, held, usd) {
  for (const coin of [SOL, USDC]) {
    let best = null;
    for (const c of counted) {
      const other = c.both?.find((s) => s.mint === coin.mint);
      const bayla = c.both?.find((s) => s.mint === BAYLA.mint);
      if (!other || !bayla || !(held.get(bayla.vault) > 0)) continue;
      if (!best || held.get(other.vault) > held.get(best.other.vault)) best = { other, bayla };
    }
    if (best) return (held.get(best.other.vault) * usd[coin.mint]) / held.get(best.bayla.vault);
  }
  return null;
}

/** One eth_call over the chain's endpoints; the first that answers wins. */
function evmCall(rpcs, fetchImpl) {
  return async (to, data) => {
    let last = "";
    for (const url of rpcs) {
      try {
        const r = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        const j = r.ok ? await r.json() : null;
        if (typeof j?.result === "string" && /^0x[0-9a-fA-F]*$/.test(j.result) && j.result.length > 2) return j.result;
        last = j?.error ? JSON.stringify(j.error).slice(0, 120) : `HTTP ${r.status}`;
      } catch (e) {
        last = e?.message ?? String(e);
      }
    }
    throw new Error(`eth_call ${data.slice(0, 10)}: ${last}`);
  };
}

const word = (hex, k) => BigInt("0x" + hex.slice(2 + 64 * k, 2 + 64 * (k + 1)));
const addressOf = (hex) => "0x" + hex.slice(-40).toLowerCase();

/** One EVM chain: every pair the factory made that holds WETH, at twice its WETH. Throws when any read failed. */
export async function readEvm(name, { fetchImpl, priceOf, chains = EVM_CHAINS }) {
  const chain = chains[name];
  const call = evmCall(chain.rpcs, fetchImpl);
  const total = Number(word(await call(chain.factory, "0x574f2ba3"), 0));
  if (total > MAX_PAIRS) throw new Error(`more than ${MAX_PAIRS} pairs on ${name}`);
  const weth = chain.weth?.toLowerCase() ?? null;
  const pairs = pairCache.get(name)?.slice(0, total) ?? [];
  for (let i = pairs.length; i < total; i++) {
    const address = addressOf(await call(chain.factory, "0x1e3dd18b" + i.toString(16).padStart(64, "0")));
    const [t0, t1] = await Promise.all([call(address, "0x0dfe1681"), call(address, "0xd21220a7")]);
    pairs.push({ address, wethSide: weth === addressOf(t0) ? 0 : weth === addressOf(t1) ? 1 : null });
  }
  pairCache.set(name, pairs);
  const priced = pairs.filter((p) => p.wethSide !== null);
  if (!priced.length) return { usd: 0, pools: 0, unvalued: 0 };
  const [ethUsd, reserves] = await Promise.all([priceOf("ETH"), Promise.all(priced.map((p) => call(p.address, "0x0902f1ac")))]);
  const wethHeld = reserves.reduce((sum, r, i) => sum + Number(word(r, priced[i].wethSide)) / 1e18, 0);
  return { usd: 2 * wethHeld * ethUsd, pools: priced.length, unvalued: 0 };
}

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** Each staked amount in dollars: `{ usd, vaults, unvalued }`, where `unvalued` counts pools left out for want of a price. */
function valueStakes(stakes, prices) {
  let usd = 0;
  let unvalued = 0;
  for (const s of stakes) {
    const price = prices.get(s.coin);
    if (!(price > 0)) unvalued++;
    else usd += (Number(s.raw) / 10 ** s.decimals) * price;
  }
  return { usd, vaults: stakes.length - unvalued, unvalued };
}

/** Solana's staking pools, each at its own count of what is staked. Throws when any read failed. */
export async function readSolanaStaking({ fetchImpl, marketPrices }) {
  const pools = SOLANA_STAKE_POOLS;
  const r = await solanaRpc("getMultipleAccounts", [pools.map((p) => p.pool), { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  if (!Array.isArray(r?.value) || r.value.length !== pools.length) throw new Error("solana stake pool answer has the wrong shape");
  const stakes = pools
    .map((p, i) => {
      const { program, discriminator, staked } = STAKE_PROGRAMS[p.kind];
      const acc = r.value[i];
      const d = typeof acc?.data?.[0] === "string" ? Buffer.from(acc.data[0], "base64") : null;
      const mint = d && d.length >= staked + 8 ? base58.encode(Uint8Array.from(d.subarray(STAKE_MINT_OFFSET, STAKE_MINT_OFFSET + 32))) : null;
      if (acc?.owner !== program || mint !== p.mint || !discriminator.every((b, j) => d[j] === b)) {
        throw new Error(`stake pool ${p.pool} does not read as a ${p.kind} pool of its coin`);
      }
      return { coin: p.mint, raw: d.readBigUInt64LE(staked) };
    })
    .filter((s) => s.raw > 0n);
  const coins = [...new Set(stakes.map((s) => s.coin))];
  const unknown = coins.filter((m) => !decimalsCache.has(`solana:${m}`));
  if (unknown.length) {
    const m = await solanaRpc("getMultipleAccounts", [unknown, { encoding: "jsonParsed", commitment: "confirmed" }], fetchImpl);
    unknown.forEach((mint, j) => {
      const acc = m?.value?.[j];
      const decimals = acc?.data?.parsed?.info?.decimals;
      if (!TOKEN_PROGRAMS.has(acc?.owner) || acc?.data?.parsed?.type !== "mint" || !Number.isInteger(decimals)) throw new Error(`mint ${mint} does not read as a mint`);
      decimalsCache.set(`solana:${mint}`, decimals);
    });
  }
  for (const s of stakes) s.decimals = decimalsCache.get(`solana:${s.coin}`);
  return valueStakes(stakes, coins.length ? await marketPrices("solana", coins) : new Map());
}

/** One EVM chain's staking contracts, each at its own count of what is staked. Throws when any read failed. */
export async function readEvmStaking(name, { fetchImpl, marketPrices, chains = EVM_CHAINS }) {
  const call = evmCall(chains[name].rpcs, fetchImpl);
  const pools = EVM_STAKE_POOLS[name];
  const raws = await Promise.all(pools.map((p) => call(p.address, p.staked)));
  const stakes = pools.map((p, i) => ({ coin: p.token, raw: word(raws[i], 0) })).filter((s) => s.raw > 0n);
  const coins = [...new Set(stakes.map((s) => s.coin))];
  await Promise.all(
    coins
      .filter((t) => !decimalsCache.has(`${name}:${t}`))
      .map(async (t) => decimalsCache.set(`${name}:${t}`, Number(word(await call(t, "0x313ce567"), 0)))),
  );
  for (const s of stakes) s.decimals = decimalsCache.get(`${name}:${s.coin}`);
  return valueStakes(stakes, coins.length ? await marketPrices(name, coins) : new Map());
}

async function fetchJson(url, fetchImpl, headers = {}) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const { text, truncated } = await readBoundedText(res, 256 * 1024);
  if (truncated) throw new Error(`answer from ${new URL(url).host} over cap`);
  return JSON.parse(text);
}

/**
 * Market prices in dollars for coins on one chain: Jupiter's on Solana (the keyed host when its
 * server-only key is set, as the swap proxy does), DefiLlama's elsewhere. A coin with no price is
 * missing from the map. Throws when the source cannot be read.
 */
export async function readMarketPrices(chain, coins, fetchImpl) {
  const out = new Map();
  if (chain === "solana") {
    const key = (process.env.JUPITER_API_KEY || "").trim();
    const hosts = key ? [["https://api.jup.ag", { "x-api-key": key }], ["https://lite-api.jup.ag", {}]] : [["https://lite-api.jup.ag", {}]];
    let j = null;
    let last = null;
    for (const [host, headers] of hosts) {
      try {
        j = await fetchJson(`${host}/price/v3?ids=${coins.join(",")}`, fetchImpl, headers);
        break;
      } catch (e) {
        last = e;
      }
    }
    if (!j) throw last;
    for (const c of coins) if (Number.isFinite(j?.[c]?.usdPrice)) out.set(c, j[c].usdPrice);
    return out;
  }
  const j = await fetchJson(`https://coins.llama.fi/prices/current/${coins.map((c) => `${chain}:${c}`).join(",")}`, fetchImpl);
  for (const c of coins) if (Number.isFinite(j?.coins?.[`${chain}:${c}`]?.price)) out.set(c, j.coins[`${chain}:${c}`].price);
  return out;
}

/** Every chain, read at once. Never throws: a chain that failed is `{ chain, read: false }`. */
export async function readVenueTvl({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const priceOf = async (symbol) => {
    const hit = priceCache.get(symbol);
    if (hit && now - hit.at < CACHE_MS) return hit.usd;
    const usd = await spotPrice(symbol, fetchImpl);
    priceCache.set(symbol, { at: now, usd });
    return usd;
  };
  // One read per chain for the coins not priced in the last minute.
  const marketPrices = async (chain, coins) => {
    const fresh = (c) => {
      const hit = priceCache.get(`${chain}:${c}`);
      return hit && now - hit.at < CACHE_MS;
    };
    const missing = coins.filter((c) => !fresh(c));
    if (missing.length) {
      const read = await readMarketPrices(chain, missing, fetchImpl);
      for (const c of missing) priceCache.set(`${chain}:${c}`, { at: now, usd: read.get(c) ?? null });
    }
    return new Map(coins.map((c) => [c, priceCache.get(`${chain}:${c}`).usd]));
  };
  const settle = (what, readers, count) =>
    Promise.all(
      readers.map(async ([chain, read]) => {
        try {
          const r = await read();
          return { chain, read: true, usd: Math.round(r.usd * 100) / 100, [count]: r[count], unvalued: r.unvalued };
        } catch (err) {
          console.error(`[venue-tvl] ${chain} ${what} not read:`, logSafe(err));
          return { chain, read: false };
        }
      }),
    );
  const [results, staking] = await Promise.all([
    settle("pools", [["solana", () => readSolana({ fetchImpl, priceOf })], ...EVM_TVL_CHAINS.map((name) => [name, () => readEvm(name, { fetchImpl, priceOf })])], "pools"),
    settle("staking", [["solana", () => readSolanaStaking({ fetchImpl, marketPrices })], ...STAKE_CHAINS.slice(1).map((name) => [name, () => readEvmStaking(name, { fetchImpl, marketPrices })])], "vaults"),
  ]);
  const parts = [...results, ...staking];
  if (!parts.some((r) => r.read)) return { state: "unread" };
  const whole = parts.every((r) => r.read && r.unvalued === 0);
  const usd = parts.reduce((sum, r) => sum + (r.read ? r.usd : 0), 0);
  return { state: whole ? "current" : "partial", usd: Math.round(usd * 100) / 100, chains: results, staking, readAt: new Date(now).toISOString() };
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, body) {
  if (body.state === "unread") {
    res.setHeader("Cache-Control", "s-maxage=15");
    return res.status(502).json(body);
  }
  res.setHeader("Cache-Control", body.state === "current" ? "public, max-age=0, s-maxage=60, stale-while-revalidate=60" : "public, max-age=0, s-maxage=15");
  return res.status(200).json(body);
}

export async function handleVenueTvl(req, res, { fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });

  const ttl = cached?.body.state === "current" ? CACHE_MS : PARTIAL_CACHE_MS;
  if (cached && nowMs - cached.at < ttl) return send(res, cached.body);
  // Charged only when the chains are read; one read at a time per instance, shared by everyone waiting.
  if (!(await checkRateLimit(req, res, RATE))) return;
  if (!inflight && !(await checkGlobalLimit(res, GLOBAL))) return;
  inflight ??= readVenueTvl({ fetchImpl, now: nowMs })
    .then((body) => {
      if (body.state !== "unread") cached = { at: nowMs, body };
      return body;
    })
    .finally(() => {
      inflight = null;
    });
  return send(res, await inflight);
}
