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
//     If either is missing, the limiter silently disables itself and every
//     request is allowed — this is deliberate so a config outage doesn't
//     brick the API. Ops gets a console.warn at first request.
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

/**
 * Consume one rate-limit token. If limit exceeded, responds with 429 and
 * returns false. If allowed, returns true. If Upstash isn't configured,
 * returns true (fail-open).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ limit: number, windowSec: number, identifier: string }} opts
 * @returns {Promise<boolean>} true = allowed, false = blocked (429 already sent)
 */
export async function checkRateLimit(req, res, opts) {
  const limiter = getLimiter(opts);
  if (!limiter) return true; // fail-open when disabled

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
    // Upstash hiccup — fail open rather than block legitimate traffic.
    console.error('[ratelimit] upstash error, failing open:', err?.message ?? err);
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
