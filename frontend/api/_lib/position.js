// THE POSITION LINK: `GET /position/:id.json`.
//
// Every range position's NFT is born with this link and keeps it forever: the range program
// writes `https://memetics.finance/position/<id>.json` into the NFT, where <id> is the
// position's record (its PersonalPositionState address), not the NFT's mint
// (solana/tegridy-clmm/programs/amm/src/instructions/open_position.rs, get_metadata_data).
// Wallets read it for the NFT's name, picture and details. So it must answer JSON, never the
// site's HTML, from before the program is deployed: a vercel.json rewrite sends it here.
//
// DERIVED FROM CHAIN ON READ, like the birth record: nothing is stored, so nothing can drift
// from the chain or be forged. The answer is the position's own record, its pool and the
// pool's fee tier, each read from accounts the range program owns. Anything not owned by
// that program is not a position here. A failed read is a 503, never a 404 a wallet would
// keep, and never a partial document.

import { checkGlobalLimit, checkRateLimit } from "./ratelimit.js";
import { logSafe } from "./logSafe.js";

/** The id the program source declared before the deploy: nobody holds its key, so no link is served for it. */
export const PLACEHOLDER_PROGRAM_ID = "RangePoo1PLACEHo1DERnotDep1oyed111111111111";

/**
 * The range program, deployed 2026-10-21 and held by the vault. position.test.js holds it
 * equal to the program's declare_id!, as src/lib/solana/clmm/program.ts does for the site.
 */
export const RANGE_PROGRAM_ID = "7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso";

/** The NFT's own name and symbol, as the program writes them (position.test.js pins both). */
export const POSITION_NAME = "Memetics Range Position";
export const POSITION_SYMBOL = "MEM-RANGE";
export const POSITION_IMAGE = "https://memetics.finance/art/pool-party.jpg";
export const POOLS_PAGE = "https://memetics.finance/pools";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RPC_TIMEOUT_MS = 6000;

/** Account layouts, recomputed from the program's structs by position.test.js. */
export const PERSONAL_POSITION = { len: 281, disc: [70, 111, 150, 126, 230, 15, 25, 117], nftMint: 9, poolId: 41, tickLower: 73, tickUpper: 77, liquidity: 81 };
export const POOL_STATE = { len: 1544, disc: [247, 237, 227, 245, 215, 195, 222, 70], ammConfig: 9, mint0: 73, mint1: 105, decimals0: 233, decimals1: 234, tickSpacing: 235 };
export const AMM_CONFIG = { len: 117, disc: [218, 244, 33, 104, 203, 203, 43, 111], owner: 11, protocolFeeRate: 43, tradeFeeRate: 47, fundFeeRate: 53, fundOwner: 61 };

/**
 * The island's agreed split of the venue's cut (owner, 2026-10-20): of each fee, 10.4% (the
 * protocol part) to the team's shared wallet and 5.6% (the fund part) to the island's
 * Workshop. position.test.js holds the wallets equal to the site's own constants. A tier
 * that differs in any way is said first, as a warning.
 */
export const TEAM_VAULT = "GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd";
export const ISLAND_WORKSHOP = "G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu";
export const AGREED_PROTOCOL_RATE = 104_000;
export const AGREED_FUND_RATE = 56_000;

/** Coins the venue names; any other shows as its address, never a name it claims. */
const KNOWN = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump": "BAYLA",
};

/** 32 bytes as base58. */
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** True when `s` names exactly 32 bytes. */
export function isAddress(s) {
  if (typeof s !== "string" || !SOLANA_ADDRESS_RE.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  let len = 0;
  while (n > 0n) {
    len++;
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    len++;
  }
  return len === 32;
}

const isKind = (buf, layout) => buf.length === layout.len && layout.disc.every((b, i) => buf[i] === b);
const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const u128 = (d, o) => d.getBigUint64(o, true) | (d.getBigUint64(o + 8, true) << 64n);

/** The position fields the link shows, or null when the bytes are not a position. */
export function decodePosition(buf) {
  if (!isKind(buf, PERSONAL_POSITION)) return null;
  const d = view(buf);
  return {
    // The one NFT that controls the position: the document names it, so a copy pointing here cannot pass for it.
    nftMint: base58(buf.subarray(PERSONAL_POSITION.nftMint, PERSONAL_POSITION.nftMint + 32)),
    poolId: base58(buf.subarray(PERSONAL_POSITION.poolId, PERSONAL_POSITION.poolId + 32)),
    tickLower: d.getInt32(PERSONAL_POSITION.tickLower, true),
    tickUpper: d.getInt32(PERSONAL_POSITION.tickUpper, true),
    liquidity: u128(d, PERSONAL_POSITION.liquidity),
  };
}

/** The pool fields the link shows, or null when the bytes are not a pool. */
export function decodePool(buf) {
  if (!isKind(buf, POOL_STATE)) return null;
  const d = view(buf);
  const key = (o) => base58(buf.subarray(o, o + 32));
  return {
    ammConfig: key(POOL_STATE.ammConfig),
    mint0: key(POOL_STATE.mint0),
    mint1: key(POOL_STATE.mint1),
    decimals0: buf[POOL_STATE.decimals0],
    decimals1: buf[POOL_STATE.decimals1],
    tickSpacing: d.getUint16(POOL_STATE.tickSpacing, true),
  };
}

/**
 * The fee tier's rates (per million: the swap fee of each swap, the protocol and fund parts
 * of that fee) and the two wallets that collect those parts, or null when the bytes are not
 * a fee tier.
 */
export function decodeFeeTier(buf) {
  if (!isKind(buf, AMM_CONFIG)) return null;
  const d = view(buf);
  return {
    tradeFeeRate: d.getUint32(AMM_CONFIG.tradeFeeRate, true),
    protocolFeeRate: d.getUint32(AMM_CONFIG.protocolFeeRate, true),
    fundFeeRate: d.getUint32(AMM_CONFIG.fundFeeRate, true),
    owner: base58(buf.subarray(AMM_CONFIG.owner, AMM_CONFIG.owner + 32)),
    fundOwner: base58(buf.subarray(AMM_CONFIG.fundOwner, AMM_CONFIG.fundOwner + 32)),
  };
}

const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const coinName = (mint) => KNOWN[mint] ?? shortAddress(mint);

/**
 * One whole token 0 in whole token 1 at a tick, to six significant figures. Never "0": a
 * price too small for six decimals is written with an exponent.
 */
export function priceAtTick(tick, decimals0, decimals1) {
  const p = Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Number(p.toPrecision(6)).toString();
}

/** Per million as a percent, exactly: 10000 = "1%", 2500 = "0.25%". */
export function feePercent(rate) {
  const whole = Math.floor(rate / 10000);
  const rest = String(rate % 10000).padStart(4, "0").replace(/0+$/, "");
  return rest ? `${whole}.${rest}%` : `${whole}%`;
}

/** Per million as a percent, to four decimals of a percent: 8400 = "0.84%", 104000 = "10.4%". */
const perMillion = (rate) => `${Number((rate / 10000).toFixed(4))}%`;

const walletName = (a) => (a === TEAM_VAULT ? "the team’s shared wallet" : a === ISLAND_WORKSHOP ? "the island’s Workshop" : a);

/**
 * What each wallet collects of each fee, by the wallet that ACTUALLY collects it: the tier's
 * `owner` takes the protocol part, its `fund_owner` the fund part, and one wallet named by
 * both takes both. The team's wallet and the Workshop are always listed, at 0 when they get
 * nothing; any other wallet only when it gets something.
 */
export function collectors(tier) {
  const take = new Map([[TEAM_VAULT, 0], [ISLAND_WORKSHOP, 0]]);
  take.set(tier.owner, (take.get(tier.owner) ?? 0) + tier.protocolFeeRate);
  take.set(tier.fundOwner, (take.get(tier.fundOwner) ?? 0) + tier.fundFeeRate);
  return [...take].filter(([a, rate]) => rate > 0 || a === TEAM_VAULT || a === ISLAND_WORKSHOP).map(([address, rate]) => ({ address, rate }));
}

/** True only for exactly the agreed split: the protocol part, 10.4%, to the team; the fund part, 5.6%, to the Workshop. */
export function isAgreedSplit(tier) {
  return tier.owner === TEAM_VAULT && tier.fundOwner === ISLAND_WORKSHOP && tier.protocolFeeRate === AGREED_PROTOCOL_RATE && tier.fundFeeRate === AGREED_FUND_RATE;
}

/**
 * How the swap fee is shared, said the way the site's Range tab says it (clmm/venueEarns.ts):
 * what positions in range share, what the venue keeps, and what each wallet collects of the
 * fee and of the swap. Every figure and wallet is the tier's own; anything but the agreed
 * split is said first, as a warning.
 */
function feeShare(tier) {
  const venue = tier.protocolFeeRate + tier.fundFeeRate;
  const ofSwap = (rate) => perMillion((tier.tradeFeeRate * rate) / 1_000_000);
  const takes = collectors(tier).map((c) => ({ ...c, name: walletName(c.address), ofFee: perMillion(c.rate), ofSwap: ofSwap(c.rate) }));
  const list = takes.map((c) => `${c.ofFee} of the fee (${c.ofSwap} of the swap) to ${c.name}`).join(", ");
  const agreed = isAgreedSplit(tier);
  return {
    fee: feePercent(tier.tradeFeeRate),
    lpOfFee: perMillion(1_000_000 - venue),
    lpOfSwap: perMillion((tier.tradeFeeRate * (1_000_000 - venue)) / 1_000_000),
    venueOfFee: perMillion(venue),
    venueOfSwap: ofSwap(venue),
    takes,
    agreed,
    where: agreed ? `: ${list}` : "",
    warning: agreed
      ? ""
      : `WARNING: the venue’s cut of each swap does not follow the agreed split (10.4% of the fee to the team’s shared wallet and 5.6% to the island’s Workshop). As this fee tier stands: ${list}. `,
  };
}

/** The metadata document a wallet reads, from the three accounts. */
export function buildPositionMetadata({ id, position, pool, tier }) {
  const a = coinName(pool.mint0);
  const b = coinName(pool.mint1);
  const low = priceAtTick(position.tickLower, pool.decimals0, pool.decimals1);
  const high = priceAtTick(position.tickUpper, pool.decimals0, pool.decimals1);
  const range = low && high ? `from ${low} to ${high} ${b} per ${a}` : `between ticks ${position.tickLower} and ${position.tickUpper}`;
  const share = feeShare(tier);
  const description =
    share.warning +
    `A range position in a memetics.finance pool of ${a} and ${b}, ${range}. ` +
    `Each swap through its range pays a ${share.fee} fee: positions in range share ${share.lpOfFee} of it (${share.lpOfSwap} of the swap), split by their liquidity there, and the venue keeps ${share.venueOfFee} (${share.venueOfSwap} of the swap)${share.where}. ` +
    `It earns only while the price is inside its range; outside it, it earns nothing. ` +
    `Only the NFT with mint ${position.nftMint} controls this position; any other NFT showing this page is a copy.`;
  const attributes = [
    { trait_type: "NFT mint", value: position.nftMint },
    { trait_type: "Pool", value: position.poolId },
    { trait_type: "Token 0", value: pool.mint0 },
    { trait_type: "Token 1", value: pool.mint1 },
    { trait_type: "Swap fee", value: share.fee },
    { trait_type: "Positions’ share of the fee", value: share.lpOfFee },
    { trait_type: "Venue’s share of the fee", value: share.venueOfFee },
    { trait_type: "Venue’s cut follows the agreed split", value: share.agreed ? "Yes" : "NO: see the warning" },
    ...share.takes.map((c) => ({
      trait_type: c.address === TEAM_VAULT || c.address === ISLAND_WORKSHOP ? `To ${c.name}` : `To another wallet, ${c.address}`,
      value: `${c.ofFee} of the fee (${c.ofSwap} of the swap)`,
    })),
    { trait_type: "Fee tier owner", value: tier.owner },
    { trait_type: "Fund owner", value: tier.fundOwner },
    { trait_type: "Lowest price", value: low ? `${low} ${b} per ${a}` : "unread" },
    { trait_type: "Highest price", value: high ? `${high} ${b} per ${a}` : "unread" },
    { trait_type: "Lower tick", value: position.tickLower },
    { trait_type: "Upper tick", value: position.tickUpper },
    { trait_type: "Liquidity", value: position.liquidity.toString() },
  ];
  return {
    name: POSITION_NAME,
    symbol: POSITION_SYMBOL,
    description,
    image: POSITION_IMAGE,
    external_url: POOLS_PAGE,
    attributes,
    properties: { category: "image", files: [{ uri: POSITION_IMAGE, type: "image/jpeg" }] },
    position: id,
  };
}

/**
 * Which position is asked for, under either rewrite: `?id=` (the pretty route) or
 * `?path=` (the catch-all). Array-valued params are refused: Vercel merges the request's
 * own query with the rewrite's, so `/position/X.json?id=Y` arrives as an array.
 */
export function resolveId(query) {
  if (!query) return null;
  let id = query.id;
  if (typeof id !== "string") {
    if (typeof query.path !== "string") return null;
    const parts = query.path.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    id = parts[0];
  }
  id = id.trim();
  if (id.endsWith(".json")) id = id.slice(0, -5);
  return isAddress(id) ? id : null;
}

function rpcUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

async function getAccounts(addresses) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding: "base64", commitment: "confirmed" }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`solana rpc ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (json.error || !Array.isArray(json.result?.value) || json.result.value.length !== addresses.length) throw new Error("solana rpc did not answer");
  return json.result.value.map((v) => {
    if (v === null) return null;
    if (!Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.owner !== "string") throw new Error("solana rpc answered an account without data");
    return { owner: v.owner, data: Uint8Array.from(Buffer.from(v.data[0], "base64")) };
  });
}

function setPositionHeaders(res) {
  // Public by design: wallets read it from their own servers, with no Origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// Every 404 names the program it serves. The deploy pack's page asks a random address and
// approves a fee tier only when the answer is the no-position 404 for the deployed id.
const notHere = (res, error, seconds, program) => {
  res.setHeader("Cache-Control", `s-maxage=${seconds}`);
  return res.status(404).json({ error, program });
};

/** `programId` is for tests; the site serves RANGE_PROGRAM_ID only. */
export async function handlePosition(req, res, { programId = RANGE_PROGRAM_ID } = {}) {
  setPositionHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // A malformed link costs nothing: it is refused before any limiter is charged.
  const id = resolveId(req.query);
  if (!id) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Malformed position link" });
  }
  // Each caller has its own bucket ahead of the shared breaker, so one caller cannot spend the
  // breaker every wallet's read (and the deploy page's 404 check) needs. A refusal is never cached.
  res.setHeader("Cache-Control", "no-store");
  const perCaller = await checkRateLimit(req, res, { limit: Number(process.env.POSITION_IP_RPM) || 60, windowSec: 60, identifier: "position-ip" });
  if (!perCaller) return;
  // One caller's counts must not ride on a document the edge keeps for everyone.
  for (const h of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]) res.removeHeader?.(h);
  const underCap = await checkGlobalLimit(res, { limit: Number(process.env.POSITION_GLOBAL_RPM) || 600, windowSec: 60, identifier: "position" });
  if (!underCap) return;
  if (programId === PLACEHOLDER_PROGRAM_ID) {
    return notHere(res, "Range pools are not open yet, so there is no position at this address.", 60, programId);
  }

  try {
    const [account] = await getAccounts([id]);
    // A position opened a moment ago may not be visible yet: a short cache, never a long one.
    if (!account) return notHere(res, "No range position at this address.", 15, programId);
    const position = account.owner === programId ? decodePosition(account.data) : null;
    if (!position) return notHere(res, "This address is not a range position of memetics.finance.", 300, programId);

    const [poolAccount] = await getAccounts([position.poolId]);
    const pool = poolAccount?.owner === programId ? decodePool(poolAccount.data) : null;
    if (!pool) throw new Error("the position's pool did not read");
    const [configAccount] = await getAccounts([pool.ammConfig]);
    const tier = configAccount?.owner === programId ? decodeFeeTier(configAccount.data) : null;
    if (tier === null) throw new Error("the pool's fee tier did not read");

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=600");
    return res.status(200).json(buildPositionMetadata({ id, position, pool, tier }));
  } catch (err) {
    console.error("position:", logSafe(err));
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "The position could not be read from the chain just now. Try again shortly." });
  }
}
