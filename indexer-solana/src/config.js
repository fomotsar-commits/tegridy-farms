// Environment → configuration, with "not configured" as a first-class answer.
//
// Nothing here throws on a missing variable. An unconfigured deploy must come
// up, say precisely what it is missing, answer /ready with 503 and index
// nothing — the same resting state frontend/src/lib/indexer/client.ts holds
// while VITE_INDEXER_URL is unset. A service that crash-loops on a missing env
// var teaches the operator nothing and, worse, a service that starts with an
// empty watch set and reports healthy publishes "no Solana trades" as a fact.

import { isSolanaAddress, isSolanaSignature } from "./base58.js";

/** Poll interval floor. Below this a public RPC starts 429-ing on its own. */
export const MIN_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const MAX_POLL_INTERVAL_MS = 600_000;

/** `getSignaturesForAddress` caps `limit` at 1000 cluster-side. */
export const MAX_SIGNATURE_PAGE = 1_000;
export const DEFAULT_SIGNATURE_PAGE = 200;

/**
 * How far back a single tick will page toward the resume signature before it
 * gives up and calls the remainder a pruned-history gap.
 *
 * A bound is required, not optional: `getSignaturesForAddress` walks BACKWARD
 * from head, so a cursor that has fallen far behind (a week of downtime, an RPC
 * that pruned the range) would otherwise page forever inside one tick and the
 * service would never write a row again — an infinite catch-up that looks
 * identical to a hang.
 */
export const DEFAULT_MAX_PAGES_PER_TICK = 20;

export const DEFAULT_STALE_AFTER_MS = 120_000;

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Parse SOLANA_WATCH.
 *
 * JSON array of `{ pool, baseMint, quoteMint, label?, feeReceiver?,
 * baseDecimals?, quoteDecimals?, startSignature? }`.
 *
 * A malformed entry is REJECTED, never repaired. Defaulting a missing quoteMint
 * to SOL would be a guess that produces confident wrong trades for a USDC pool,
 * and the resulting rows are indistinguishable from correct ones.
 *
 * @returns {{ watches: object[], errors: string[] }}
 */
export function parseWatchSet(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { watches: [], errors: [] };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { watches: [], errors: ["SOLANA_WATCH is not valid JSON"] };
  }
  if (!Array.isArray(parsed)) {
    return { watches: [], errors: ["SOLANA_WATCH must be a JSON array"] };
  }

  const watches = [];
  const errors = [];
  const seen = new Set();

  parsed.forEach((entry, i) => {
    const where = `SOLANA_WATCH[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where} is not an object`);
      return;
    }
    const pool = String(entry.pool ?? "").trim();
    const baseMint = String(entry.baseMint ?? "").trim();
    const quoteMint = String(entry.quoteMint ?? "").trim();

    for (const [name, value] of [
      ["pool", pool],
      ["baseMint", baseMint],
      ["quoteMint", quoteMint],
    ]) {
      if (!value) errors.push(`${where}.${name} is missing`);
      else if (!isSolanaAddress(value)) errors.push(`${where}.${name} is not a 32-byte base58 address`);
    }
    if (baseMint && baseMint === quoteMint) {
      errors.push(`${where}.baseMint and .quoteMint are the same mint`);
    }

    const feeReceiver = entry.feeReceiver ? String(entry.feeReceiver).trim() : null;
    if (feeReceiver && !isSolanaAddress(feeReceiver)) {
      errors.push(`${where}.feeReceiver is not a 32-byte base58 address`);
    }
    const startSignature = entry.startSignature ? String(entry.startSignature).trim() : null;
    if (startSignature && !isSolanaSignature(startSignature)) {
      errors.push(`${where}.startSignature is not a 64-byte base58 signature`);
    }

    if (pool && seen.has(pool)) errors.push(`${where}.pool is a duplicate of an earlier entry`);
    seen.add(pool);

    if (errors.length > 0) return;

    watches.push({
      pool,
      label: entry.label ? String(entry.label).trim() : null,
      baseMint,
      quoteMint,
      feeReceiver,
      baseDecimals: Number.isInteger(entry.baseDecimals) ? entry.baseDecimals : null,
      quoteDecimals: Number.isInteger(entry.quoteDecimals) ? entry.quoteDecimals : null,
      startSignature,
    });
  });

  // All-or-nothing: a partially accepted watch set indexes some pools and
  // silently omits others, and the omitted ones read as pools with no activity.
  if (errors.length > 0) return { watches: [], errors };
  return { watches, errors };
}

/**
 * @returns {{
 *   rpcUrls: string[],
 *   databaseUrl: string | null,
 *   watches: object[],
 *   pollIntervalMs: number,
 *   signaturePageLimit: number,
 *   maxPagesPerTick: number,
 *   staleAfterMs: number,
 *   statusPort: number | null,
 *   problems: string[],
 *   ready: boolean,
 * }}
 */
export function loadConfig(env = process.env) {
  const rpcUrls = [
    env.SOLANA_RPC_URL,
    env.SOLANA_RPC_URL_2,
    env.SOLANA_RPC_URL_3,
    env.SOLANA_RPC_URL_4,
  ]
    .map((u) => String(u ?? "").trim())
    .filter(Boolean);

  // Mirrors the Ponder app's precedence exactly (indexer/.env.local.example):
  // Railway injects both and the private one skips egress billing.
  const databaseUrl =
    String(env.DATABASE_PRIVATE_URL ?? "").trim() || String(env.DATABASE_URL ?? "").trim() || null;

  const { watches, errors: watchErrors } = parseWatchSet(env.SOLANA_WATCH);

  const problems = [...watchErrors];
  if (rpcUrls.length === 0) {
    problems.push("SOLANA_RPC_URL is unset — there is no cluster to read from");
  } else {
    for (const url of rpcUrls) {
      if (!/^https?:\/\//i.test(url)) {
        problems.push(`an RPC URL is not http(s): ${url.slice(0, 12)}…`);
      }
    }
  }
  if (!databaseUrl) {
    problems.push("neither DATABASE_PRIVATE_URL nor DATABASE_URL is set — there is nowhere to write");
  }
  if (watches.length === 0 && watchErrors.length === 0) {
    problems.push("SOLANA_WATCH is empty — no pool is being followed, so no absence of trades means anything");
  }

  const statusPortRaw = String(env.SOLANA_STATUS_PORT ?? "").trim();

  return {
    rpcUrls,
    databaseUrl,
    watches,
    pollIntervalMs: clampInt(
      env.SOLANA_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    ),
    signaturePageLimit: clampInt(
      env.SOLANA_SIGNATURE_PAGE_LIMIT,
      DEFAULT_SIGNATURE_PAGE,
      1,
      MAX_SIGNATURE_PAGE,
    ),
    maxPagesPerTick: clampInt(env.SOLANA_MAX_PAGES_PER_TICK, DEFAULT_MAX_PAGES_PER_TICK, 1, 1_000),
    staleAfterMs: clampInt(env.SOLANA_STALE_AFTER_MS, DEFAULT_STALE_AFTER_MS, 10_000, 86_400_000),
    // Unset means no listener at all. An operator who has not asked for a
    // status port should not get an open socket.
    statusPort: statusPortRaw ? clampInt(statusPortRaw, 0, 1, 65_535) || null : null,
    problems,
    ready: problems.length === 0,
  };
}
