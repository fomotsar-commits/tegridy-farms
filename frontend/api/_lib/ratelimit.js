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
//     AUDIT API-SEC (2026-04): fail-closed in production, fail-open in dev.
//     Earlier revisions always failed open on missing env or Upstash errors
//     — a configuration mistake silently left the API unthrottled. Now:
//       NODE_ENV === 'production' AND no env vars  → 503 Service Unavailable
//       NODE_ENV === 'production' AND Upstash error → 503 Service Unavailable
//       else (dev / preview without Upstash)        → allow with console.warn
//     This shifts the failure mode toward visibility: a 503 gets noticed,
//     a silent unthrottled API does not.
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
        'rate limiting DISABLED. Requests will be allowed without throttling.'
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

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Consume one rate-limit token.
 *
 * Returns true (allowed), false (blocked — 429 or 503 already sent).
 *
 * Failure modes:
 *   - Upstash env vars missing:
 *     - production → 503 + false    (fail closed)
 *     - non-prod   → true           (fail open, warn once)
 *   - Upstash request error:
 *     - production → 503 + false    (fail closed)
 *     - non-prod   → true           (fail open, warn)
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ limit: number, windowSec: number, identifier: string, walletAddress?: string }} opts
 * @returns {Promise<boolean>} true = allowed, false = blocked (response already sent)
 */
export async function checkRateLimit(req, res, opts) {
  const limiter = getLimiter(opts);
  if (!limiter) {
    // No Upstash configured.
    if (IS_PRODUCTION) {
      res.status(503).json({ error: 'Rate limiter unavailable' });
      return false;
    }
    return true; // dev / preview without Upstash — allowed
  }

  const key = buildRateLimitKey(req, opts.walletAddress);

  try {
    const { success, limit, remaining, reset } = await limiter.limit(key);
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
  } catch (err) {
    console.error('[ratelimit] upstash error:', err?.message ?? err);
    if (IS_PRODUCTION) {
      res.status(503).json({ error: 'Rate limiter unavailable' });
      return false;
    }
    // Dev / preview — fail open, but loud in logs.
    return true;
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
