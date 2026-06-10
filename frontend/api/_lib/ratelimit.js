// AUDIT API-M1: Real per-IP rate limiting backed by Upstash Redis.
//
// The entire `api/` surface previously set cosmetic X-RateLimit-* headers
// with static numbers — never enforced. This module implements a sliding-
// window rate limiter shared across every endpoint. Each endpoint declares
// its own { limit, windowSec } tuple; this file handles the rest.
//
// HOW IT WORKS
//   - `@upstash/ratelimit` over `@upstash/redis` performs atomic increment-
//     with-expiry against a Redis ZSET keyed by ip + endpoint + window.
//   - Sliding window (not fixed), so clients can't burst at window boundaries.
//   - Configured via two env vars set in Vercel:
//       UPSTASH_REDIS_REST_URL
//       UPSTASH_REDIS_REST_TOKEN
//     AUDIT API-SEC (2026-04) + F1 (2026-05): earlier revisions always failed
//     open on missing env or Upstash errors — a configuration mistake silently
//     left the API unthrottled — so F1 made prod-like deployments fail CLOSED
//     (503 on missing env / Upstash error).
//
//     PROD OUTAGE FIX (2026-06-09): fail-closed took the ENTIRE api/ read
//     surface down — the Vercel project had no Upstash configured, so every
//     alchemy/opensea/etherscan/aggregator proxy 503'd and the NFT marketplace
//     rendered skeletons forever. Fail-closed conflated "no abuse protection"
//     with "no service at all". Current behavior, every environment:
//       Upstash configured + healthy → distributed sliding-window (unchanged)
//       Upstash missing OR erroring  → DEGRADED MODE: per-instance in-memory
//                                      fixed-window enforcing the SAME
//                                      { limit, windowSec } per key
//     Degraded mode is weaker than Redis (per-instance buckets, reset on cold
//     start) but preserves F1's real goal — the API is never silently
//     unthrottled — without turning a Redis outage into a product outage.
//     A console.error fires once per instance so the missing config stays
//     loud in Vercel logs.
//
// USAGE
//   import { withRateLimit } from './_lib/ratelimit.js';
//
//   export default withRateLimit(
//     { limit: 30, windowSec: 60, identifier: 'alchemy' },
//     async (req, res) => { ...existing handler... }
//   );
//
//   or, inline:
//   const ok = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: 'alchemy' });
//   if (!ok) return;   // already responded with 429
//
// IP EXTRACTION (AUDIT R051 H-1)
//   `x-forwarded-for` is appended-to (not overwritten) by Vercel's edge:
//   any value the inbound client sends is preserved, and Vercel adds the
//   real client IP at the END of the list. Reading XFF[0] therefore trusts
//   attacker-controlled data and lets any caller spoof their rate-limit
//   key by injecting a fake first entry. The correct ordering is:
//     1. `request.ip`  — Vercel-runtime parsed real client IP (preferred).
//     2. `x-real-ip`   — Vercel sets this from the trusted edge.
//     3. XFF[LAST]     — Vercel APPENDS the real IP at the end.
//   Never read XFF[0]: always attacker-spoofable on Vercel.
//
// PER-IDENTITY KEYING (AUDIT R051 M)
//   Per-IP keying alone collapses NAT egress: every wallet behind a mobile
//   carrier shares one bucket and one user can soft-DoS others. For
//   authenticated endpoints we key by verified wallet address instead;
//   `buildRateLimitKey` namespaces `wallet:` vs `ip:` so the two buckets
//   never collide.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

let limiterCache = new Map();
let redisClient = null;
let configWarned = false;

function getRedis() {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!configWarned) {
      console.warn(
        '[ratelimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ' +
        'falling back to per-instance in-memory rate limiting (degraded mode).'
      );
      configWarned = true;
    }
    return null;
  }
  redisClient = new Redis({ url, token });
  return redisClient;
}

function getLimiter({ limit, windowSec, identifier }) {
  const key = `${identifier}:${limit}:${windowSec}`;
  if (limiterCache.has(key)) return limiterCache.get(key);
  const redis = getRedis();
  if (!redis) return null;
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
    prefix: `tegridy:${identifier}`,
    analytics: false,
  });
  limiterCache.set(key, limiter);
  return limiter;
}

/**
 * AUDIT R051 H-1: extract the real client IP using a strictly-trusted
 * precedence chain. Never trust XFF[0] — Vercel APPENDS the real IP, so
 * the first entry is whatever the inbound client sent.
 *
 * Order: request.ip → x-real-ip → XFF[last] → 'unknown'.
 *
 * Exported for unit testing.
 */
export function extractIp(req) {
  // Vercel runtime — most trusted source when available.
  if (req?.ip) return String(req.ip);

  // x-real-ip — Vercel sets this from the trusted edge.
  const real = req?.headers?.['x-real-ip'];
  if (real) {
    const trimmed = String(real).trim();
    if (trimmed) return trimmed;
  }

  // x-forwarded-for: take the LAST entry (Vercel-appended real IP).
  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) {
    const parts = String(xff)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return 'unknown';
}

/**
 * AUDIT R051 M: build a rate-limit key, preferring verified wallet over IP.
 *
 * - With wallet  → `wallet:0x<addr>` (lowercased).
 * - Without      → `ip:<extracted-ip>`.
 *
 * Distinct namespace prefixes prevent any cross-namespace collision (an IP
 * literally `0x...` won't match a wallet bucket).
 *
 * @param {object} req
 * @param {string|null|undefined} walletAddress
 */
export function buildRateLimitKey(req, walletAddress) {
  if (walletAddress && typeof walletAddress === 'string' && walletAddress.length > 0) {
    return `wallet:${walletAddress.toLowerCase()}`;
  }
  return `ip:${extractIp(req)}`;
}

// ── Degraded-mode fallback (2026-06-09) ─────────────────────────────────
// Per-instance fixed-window counter used ONLY when Upstash is unconfigured
// or erroring. Enforces the same { limit, windowSec } per key so the API is
// never silently unthrottled (F1's goal) while a Redis outage can no longer
// 503 the whole read surface. Bounded so a key-spray can't balloon instance
// memory: expired entries are swept on insert pressure, then oldest-inserted
// entries are evicted.
const MEM_MAX_KEYS = 5000;
const memBuckets = new Map(); // key -> { count, resetAt }
let degradedWarned = false;

function warnDegraded(reason) {
  if (degradedWarned) return;
  degradedWarned = true;
  console.error(
    `[ratelimit] DEGRADED MODE — Upstash ${reason}; enforcing per-instance ` +
    'in-memory limits. Set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN ' +
    'to restore distributed rate limiting.'
  );
}

/**
 * Fixed-window in-memory limiter. Exported for unit testing.
 *
 * @param {string} key
 * @param {number} limit
 * @param {number} windowSec
 * @param {number} [nowMs] injectable clock for tests
 * @returns {{ success: boolean, limit: number, remaining: number, reset: number }}
 */
export function memoryRateLimit(key, limit, windowSec, nowMs = Date.now()) {
  let slot = memBuckets.get(key);
  if (!slot || nowMs >= slot.resetAt) {
    if (!memBuckets.has(key) && memBuckets.size >= MEM_MAX_KEYS) {
      for (const [k, v] of memBuckets) {
        if (nowMs >= v.resetAt) memBuckets.delete(k);
      }
      if (memBuckets.size >= MEM_MAX_KEYS) {
        const oldest = memBuckets.keys().next().value;
        if (oldest !== undefined) memBuckets.delete(oldest);
      }
    }
    slot = { count: 0, resetAt: nowMs + windowSec * 1000 };
    memBuckets.set(key, slot);
  }
  slot.count += 1;
  return {
    success: slot.count <= limit,
    limit,
    remaining: Math.max(0, limit - slot.count),
    reset: slot.resetAt,
  };
}

/** Write X-RateLimit-* headers and the 429 when blocked. */
function applyLimitResult(res, { success, limit, remaining, reset }) {
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(reset / 1000)));
  if (!success) {
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests' });
    return false;
  }
  return true;
}

/**
 * Consume one rate-limit token.
 *
 * Returns true (allowed), false (blocked — 429 already sent).
 *
 * Failure modes (see header comment, PROD OUTAGE FIX 2026-06-09):
 *   - Upstash env vars missing → in-memory fixed-window, same limits
 *   - Upstash request error    → in-memory fixed-window, same limits
 * Both paths console.error once per instance; neither 503s.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ limit: number, windowSec: number, identifier: string, walletAddress?: string }} opts
 * @returns {Promise<boolean>} true = allowed, false = blocked (response already sent)
 */
export async function checkRateLimit(req, res, opts) {
  const limiter = getLimiter(opts);
  const key = buildRateLimitKey(req, opts.walletAddress);

  if (!limiter) {
    // No Upstash configured — degraded mode, never a hard outage.
    warnDegraded('not configured');
    return applyLimitResult(
      res,
      memoryRateLimit(`${opts.identifier}:${key}`, opts.limit, opts.windowSec),
    );
  }

  try {
    const { success, limit, remaining, reset } = await limiter.limit(key);
    return applyLimitResult(res, { success, limit, remaining, reset });
  } catch (err) {
    console.error('[ratelimit] upstash error:', err?.message ?? err);
    warnDegraded('erroring');
    return applyLimitResult(
      res,
      memoryRateLimit(`${opts.identifier}:${key}`, opts.limit, opts.windowSec),
    );
  }
}

/**
 * Wrap an existing handler with rate limiting as the first step.
 *
 * @param {{ limit: number, windowSec: number, identifier: string }} opts
 * @param {(req, res) => Promise<any>} handler
 */
export function withRateLimit(opts, handler) {
  return async function rateLimitedHandler(req, res) {
    const ok = await checkRateLimit(req, res, opts);
    if (!ok) return;
    return handler(req, res);
  };
}
