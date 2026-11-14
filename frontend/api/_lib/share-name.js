// THE POOL SHARE NAME FILE: `GET /mint/:mint.json`, for a share with no file of its own.
//
// The pool program writes `https://memetics.finance/mint/<share mint>.json` into every share's
// name record (solana/tegridy-amm/programs/cp-swap/src/lib.rs, get_lp_metadata_data). Wallets
// read that link for the share's picture and words. The 23 shares that had holders by
// 2026-11-11 have a file committed in public/mint/, written by scripts/generate-mint-identity.mjs,
// and a committed file is always served first. Every other link is rewritten here (vercel.json),
// so a pool opened tomorrow gets its own pair's file with no pull request.
//
// DERIVED FROM CHAIN ON READ, like the range position link (position.js): nothing is stored.
// The share's pool is found by its share mint, and must be an account our pool program owns,
// of the pool's size and discriminator (the same scan as pool-index.js `?lpMint=`). Its two
// coins are read from that account. The words follow the committed files exactly (a test holds
// every committed pool share file to what this builds from its two coins):
//   - the pair reads the pool's own coin first and the coin it is paired with last (quotes.ts
//     `readPair`; SOL/USDC reads SOL first, as the site shows it);
//   - the site names its own coins (scripts/lib/mint-identity.mjs COINS and the pairing coins).
//     Any other coin shows the ticker it gives itself, cleaned for the screen, and one that
//     reads as a well-known coin at another address is "fake SOY" (owner ruling 2026-10-22,
//     the same rule as the site's identity.ts `claimedTicker`). The whole address of every
//     coin that is not a pairing coin is in the words;
//   - the picture is chosen only from the generator's own files, by the paired coin's ring.
//     A coin's own picture link is never used.
// Anything that is not one of our pool shares, or that names nothing, answers the default file,
// byte for byte public/mint/default.json, as every unknown link did before this function.
// A failed read is a 503, never the default file a wallet would keep.

import { base58 } from "@scure/base";
import { checkGlobalLimit, checkRateLimit } from "./ratelimit.js";
import { findProgramAddress } from "./launch-pins.js";
import { logSafe } from "./logSafe.js";
import { CP_SWAP_PROGRAM, OFFSETS, POOL_DISCRIMINATOR_B58, POOL_STATE_LEN, QUOTE_COINS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT, parseKey } from "./pool-index.js";
import { displaySafe, foldForCompare, foldedForms, impersonatesAll } from "../../src/lib/launchMetadata/validate.js";
import { COINS, DEFAULT_TOKEN, GENERIC_PICTURES, metadataFor, serialize, shareDescription } from "../../scripts/lib/mint-identity.mjs";

export const METAPLEX_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const RPC_TIMEOUT_MS = 6000;

/** The default file's bytes: public/mint/default.json, which a test holds this to. */
export const DEFAULT_BYTES = serialize(metadataFor(DEFAULT_TOKEN, GENERIC_PICTURES.moonlight));

/** The site's own name for a coin, by mint: the pairing coins and every coin of a committed share. */
const SITE_NAMES = new Map([...Object.entries(COINS).map(([ticker, mint]) => [mint, ticker]), ...QUOTE_COINS.map((q) => [q.mint, q.symbol])]);
const PAIRING = new Set(QUOTE_COINS.map((q) => q.mint));

/**
 * The server's copy of tokenSafety.ts `WELL_KNOWN_NAMES` (api/ does not import TypeScript):
 * a test holds the two equal. A coin claiming one of these names at another mint is a copy.
 */
export const WELL_KNOWN_NAMES = Object.freeze([
  { label: "SOL", mint: WSOL_MINT, names: ["SOL", "WSOL", "Wrapped SOL", "Solana", "Wrapped Solana"] },
  { label: "USDC", mint: USDC_MINT, names: ["USDC", "USD Coin", "USDCoin"] },
  { label: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", names: ["USDT", "Tether", "Tether USD", "USDTether"] },
  { label: "BAYLA", mint: "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump", names: ["BAYLA"] },
  { label: "TOWELI", mint: null, names: ["TOWELI"] },
  { label: "BOBO", mint: "4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump", names: ["BOBO"] },
  { label: "SOY", mint: "8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump", names: ["SOY"] },
  { label: "BRAINLET", mint: "4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump", names: ["BRAINLET"] },
  { label: "RIZZ", mint: "5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k", names: ["RIZZ"] },
]);
const WELL_KNOWN_FOLDED = WELL_KNOWN_NAMES.flatMap((k) => k.names.map((n) => ({ folded: foldForCompare(n), known: k })));

/** tokenSafety.ts `copiedWellKnownName`, line for line: the well-known coin a claim copies, else null. */
export function copiedWellKnownName(mint, claims) {
  for (const claim of claims) {
    const said = [...foldedForms(claim), ...impersonatesAll(claim).map(foldForCompare)];
    const hit = WELL_KNOWN_FOLDED.find((k) => said.includes(k.folded));
    if (hit && hit.known.mint !== mint) return hit.known;
  }
  return null;
}

/** identity.ts `claimedTicker` for a coin the site does not name: cleaned, "fake X" for a copy, null for none. */
export function claimedTicker(mint, symbol, claims) {
  if (!symbol) return null;
  const shown = displaySafe(symbol, 12);
  if (shown === "") return null;
  return copiedWellKnownName(mint, [...claims, shown]) ? `fake ${shown}` : shown;
}

/** The pool's own coin and the coin it is paired with (quotes.ts readPair; SOL/USDC reads SOL first). */
export function pairOf(token0, token1) {
  if (token0 === token1) return null;
  const pair = new Set([token0, token1]);
  if (pair.has(WSOL_MINT) && pair.has(USDC_MINT)) return { own: WSOL_MINT, paired: USDC_MINT };
  const rank = (m) => QUOTE_COINS.findIndex((q) => q.mint === m);
  const r0 = rank(token0);
  const r1 = rank(token1);
  if (r0 < 0 && r1 < 0) return null;
  const quoteIsToken0 = r1 < 0 || (r0 >= 0 && r0 < r1);
  return quoteIsToken0 ? { own: token1, paired: token0 } : { own: token0, paired: token1 };
}

/** The file for a pool share, from its two coins and the own coin's ticker (null when it has none). */
export function shareFile({ own, paired }, ownTicker) {
  const pairedName = SITE_NAMES.get(paired);
  if (!ownTicker || !pairedName) return DEFAULT_BYTES;
  const ownWords = PAIRING.has(own) ? ownTicker : `${ownTicker} (${own})`;
  const pair = `${ownTicker}/${pairedName}`;
  // The symbol a committed file would carry, when it fits Metaplex's 10 bytes as it is. A
  // longer one, and a copy's, stays the program's own MEM-LP: a short form is the owner's to pick.
  const letters = ownTicker.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const symbol = !ownTicker.startsWith("fake ") && letters !== "" && `${letters}-${pairedName}`.length <= 10 ? `${letters}-${pairedName}` : DEFAULT_TOKEN.symbol;
  const ring = paired === WSOL_MINT ? "sol" : paired === USDC_MINT ? "usdc" : "moonlight";
  return serialize(metadataFor({ name: `${pair} LP`, symbol, description: shareDescription(pair, ownWords, pairedName) }, GENERIC_PICTURES[ring]));
}

function rpcUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

async function rpc(method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`solana rpc ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (!json || json.error || !("result" in json)) throw new Error("solana rpc did not answer");
  return json.result;
}

const dataOf = (v) => {
  if (!Array.isArray(v?.data) || v.data[1] !== "base64" || typeof v.owner !== "string") throw new Error("solana rpc answered an account without data");
  return Uint8Array.from(Buffer.from(v.data[0], "base64"));
};

/** The pools of our program whose share mint is `mint`: each pool's two coins. */
async function poolsOfShare(mint) {
  const result = await rpc("getProgramAccounts", [
    CP_SWAP_PROGRAM,
    {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: OFFSETS.token0Mint, length: 64 },
      filters: [{ dataSize: POOL_STATE_LEN }, { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } }, { memcmp: { offset: OFFSETS.lpMint, bytes: mint } }],
    },
  ]);
  if (!Array.isArray(result)) throw new Error("solana rpc answered no list");
  return result.map((item) => {
    const d = dataOf(item?.account);
    if (d.length !== 64) throw new Error("solana rpc answered a pool slice of the wrong size");
    return { token0: base58.encode(d.subarray(0, 32)), token1: base58.encode(d.subarray(32, 64)) };
  });
}

/**
 * A length-prefixed string (u32 little-endian), or null when it runs past `end` or over `cap`.
 * Metaplex pads its strings with NULs, which its decoder strips; Token-2022's are exact.
 */
function str(d, o, end, cap, padded) {
  if (o + 4 > end) return null;
  const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
  if (len > cap || o + 4 + len > end) return null;
  const value = new TextDecoder("utf-8", { fatal: false }).decode(d.subarray(o + 4, o + 4 + len));
  return { value: padded ? value.replace(/\0+$/, "") : value, next: o + 4 + len };
}

/** Token-2022's own name and symbol on the mint (the TokenMetadata extension), else null. */
export function token2022Names(owner, data, mint) {
  if (owner !== TOKEN_2022_PROGRAM || data.length <= 166 || data[165] !== 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 166;
  while (o + 4 <= data.length) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    if (type === 0) break;
    const start = o + 4;
    const end = start + len;
    if (end > data.length) return null;
    if (type === 19) {
      if (len < 64 + 12 || base58.encode(data.subarray(start + 32, start + 64)) !== mint) return null;
      const name = str(data, start + 64, end, 0xffffffff, false);
      const symbol = name && str(data, name.next, end, 0xffffffff, false);
      return name && symbol ? { name: name.value, symbol: symbol.value } : null;
    }
    o = end;
  }
  return null;
}

/** A Metaplex name record's name and symbol (discover/metadata.ts decodeTokenMetadata's caps), else null. */
export function metaplexNames(owner, data, mint) {
  if (owner !== METAPLEX_PROGRAM || data.length < 65 || data[0] !== 4) return null;
  if (base58.encode(data.subarray(33, 65)) !== mint) return null;
  const name = str(data, 65, data.length, 64, true);
  const symbol = name && str(data, name.next, data.length, 32, true);
  return name && symbol ? { name: name.value, symbol: symbol.value } : null;
}

/** The own coin's ticker as the site would show it, read from chain when the site does not name it. */
export async function tickerOf(mint) {
  const named = SITE_NAMES.get(mint);
  if (named) return named;
  const record = findProgramAddress([new TextEncoder().encode("metadata"), base58.decode(METAPLEX_PROGRAM), base58.decode(mint)], METAPLEX_PROGRAM);
  const result = await rpc("getMultipleAccounts", [[mint, record], { encoding: "base64", commitment: "confirmed" }]);
  const [mintAccount, recordAccount] = Array.isArray(result?.value) && result.value.length === 2 ? result.value : (() => { throw new Error("solana rpc did not answer two accounts"); })();
  if (!mintAccount || (mintAccount.owner !== TOKEN_PROGRAM && mintAccount.owner !== TOKEN_2022_PROGRAM)) return null;
  const t22 = token2022Names(mintAccount.owner, dataOf(mintAccount), mint);
  const mp = recordAccount ? metaplexNames(recordAccount.owner, dataOf(recordAccount), mint) : null;
  // Token-2022's own words when the mint carries them, else Metaplex's; every one read is a claim.
  const claims = [t22?.name, t22?.symbol, mp?.name, mp?.symbol].filter((s) => typeof s === "string");
  return claimedTicker(mint, (t22 ?? mp)?.symbol ?? null, claims);
}

// Public by design: wallets read it from their own servers, with no Origin. The cross-origin
// headers come from vercel.json's `/mint/(.*)` block, the same ones every committed file gets:
// set here too, they could reach a browser twice, and "*, *" is refused.
function setHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/** A file, kept `seconds` by the edge and by whoever reads it. */
function sendFile(res, bytes, seconds) {
  res.setHeader("Cache-Control", `public, max-age=${seconds}`);
  res.setHeader("Vercel-CDN-Cache-Control", `max-age=${seconds}, stale-while-revalidate=${seconds * 4}`);
  return res.status(200).send(bytes);
}

export async function handleShareName(req, res) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // A link that is no address, or names a coin of ours, is never a pool share: the default
  // file, as before this function, with no limiter charged and nothing read.
  const mint = parseKey(req.query?.mint);
  if (!mint || SITE_NAMES.has(mint)) return sendFile(res, DEFAULT_BYTES, 86400);

  // Each caller has its own bucket ahead of the shared breaker, as for the position link.
  // Knobs: SHARE_NAME_IP_RPM (60) and SHARE_NAME_GLOBAL_RPM (600). Refusals are no-store.
  res.setHeader("Cache-Control", "no-store");
  if (!(await checkRateLimit(req, res, { limit: Number(process.env.SHARE_NAME_IP_RPM) || 60, windowSec: 60, identifier: "share-name-ip" }))) return;
  for (const h of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]) res.removeHeader?.(h);
  if (!(await checkGlobalLimit(res, { limit: Number(process.env.SHARE_NAME_GLOBAL_RPM) || 600, windowSec: 60, identifier: "share-name" }))) return;

  try {
    const pools = await poolsOfShare(mint);
    // No pool: not a share of ours, or a pool opened a moment ago the RPC has not seen. A short cache.
    if (pools.length !== 1) return sendFile(res, DEFAULT_BYTES, 60);
    const pair = pairOf(pools[0].token0, pools[0].token1);
    if (!pair) return sendFile(res, DEFAULT_BYTES, 3600);
    return sendFile(res, shareFile(pair, await tickerOf(pair.own)), 3600);
  } catch (err) {
    console.error("share-name:", logSafe(err));
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "The pool share could not be read from the chain just now. Try again shortly." });
  }
}
