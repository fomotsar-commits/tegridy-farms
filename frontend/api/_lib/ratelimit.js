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
// IP EXTRACTION
//   Vercel forwards the real IP via `x-forwarded-for` (first hop) with
//   `x-real-ip` as fallback. Both are trusted because Vercel's edge strips
//   them on ingress.

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

function extractIp(req) {
  // Vercel trusts x-forwarded-for (first hop after edge).
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  return 'unknown';
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
 * @param {{ limit: number, windowSec: number, identifier: string }} opts
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

  const ip = extractIp(req);
  const key = `${ip}`;

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
