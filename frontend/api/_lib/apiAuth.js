// Keyed-API auth, tiering and metering for /api/v1.
//
// WHY THIS EXISTS
//   api/v1/index.js has advertised `Access-Control-Allow-Headers: …, X-API-Key`
//   since it was written and has never read that header. The only control was the
//   per-IP limiter, which by design (see ratelimit.js, PROD OUTAGE FIX 2026-06-09)
//   fails OPEN into a per-instance in-memory bucket when Upstash is missing. That
//   posture is right for a free consumer read surface and wrong for a sold one:
//   an unmetered paid call is revenue the venue cannot bill and a quota the caller
//   cannot be held to.
//
// THE THREE FAILURE MODES THIS FILE KEEPS APART
//   401  the CALLER's key is wrong (absent on a keyed route, unknown, revoked)
//   429  the caller is over a limit, with the reset that makes retry mechanical
//   503  WE cannot answer — the key store or the meter is unconfigured or down
//   A deployment gap reported as 401 sends an integrator to re-read their key
//   forever; a caller's bad key reported as 503 sends the operator to a
//   non-existent outage. They are never merged.
//
// FAIL CLOSED, DELIBERATELY DIFFERENT FROM ratelimit.js
//   ratelimit.js degrades to in-memory counting so a Redis blip cannot take the
//   consumer read surface down. Keyed calls take the opposite trade: no meter,
//   no service. An in-memory monthly counter reset by every cold start is not a
//   quota, and serving against one is serving for free while telling the customer
//   they were metered. So `meterKeyedCall` 503s rather than guessing.
//
// WHERE THE KEY LIVES
//   Only a SHA-256 of the key is stored. The plaintext is returned exactly once,
//   at issuance, and never again — there is no "show key" path because there is
//   nothing left to show. SHA-256 (not bcrypt/argon) is correct HERE and only
//   here: the secret is 32 bytes from a CSPRNG, so there is no dictionary to run
//   and no work factor worth paying on every request. This is the same reasoning
//   behind Stripe's and GitHub's token stores. It does NOT transfer to passwords.

import { createHash, randomBytes } from 'node:crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import { jwtVerify } from 'jose';
import { getTier, isSelfServeTier, DEFAULT_TIER_ID, API_BILLING_ENABLED } from './apiTiers.js';
import { logSafe } from './logSafe.js';

// ── Key format ───────────────────────────────────────────────────────────
// `mtk_` + 43 base64url chars (32 bytes). The prefix is stored in clear so a
// dashboard can name a key without holding it, and so an integrator who pastes a
// key into a bug report leaks a label rather than a credential.
const KEY_PREFIX = 'mtk_';
const KEY_BYTES = 32;
const KEY_RE = /^mtk_[A-Za-z0-9_-]{43}$/;
/** Chars of the key kept in the clear for display: `mtk_` + 8. */
const DISPLAY_PREFIX_LEN = KEY_PREFIX.length + 8;

const KEYS_TABLE = 'api_keys';

/** Longest key material we will even hash. Bounds a spray of megabyte headers. */
const MAX_KEY_LEN = 200;

// ── Redis (metering) ─────────────────────────────────────────────────────
// A second client rather than reaching into ratelimit.js: that module's whole
// contract is "never 503 the read surface", and this one's is the reverse. Wiring
// them together would mean one call site could silently inherit the other's
// failure posture. Same env vars, opposite promise.
let _redis = null;
let _redisResolved = false;

function getRedis() {
  if (_redisResolved) return _redis;
  _redisResolved = true;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

const _limiters = new Map();

function getTierLimiter(tier) {
  const cached = _limiters.get(tier.id);
  if (cached) return cached;
  const redis = getRedis();
  if (!redis) return null;
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(tier.rateLimitPerMinute, '60 s'),
    prefix: `tegridy:apikey:${tier.id}`,
    analytics: false,
  });
  _limiters.set(tier.id, limiter);
  return limiter;
}

// ── Supabase (key store) ─────────────────────────────────────────────────
// Service role: api_keys has RLS on with no policies, so the anon key reads
// nothing and this is the only path in. Kept to key lookup, issuance and
// revocation — nothing else may borrow this client.
let _store = null;
let _storeResolved = false;

function getKeyStore() {
  if (_storeResolved) return _store;
  _storeResolved = true;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  _store =
    url && serviceKey
      ? createClient(url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;
  return _store;
}

/** Test seam — drops the memoised clients so env changes take effect. */
export function __resetApiAuthCaches() {
  _redis = null;
  _redisResolved = false;
  _store = null;
  _storeResolved = false;
  _limiters.clear();
}

/** @param {string} secret */
export function hashApiKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * The key the caller presented, or null.
 *
 * `X-API-Key` is the documented header. `Authorization: Bearer mtk_…` is also
 * read because every HTTP client has a first-class way to send it and an
 * integrator who reaches for it should not get a 401 that means "wrong header".
 * The SIWE cookie is a different credential entirely and is never consulted here.
 */
export function extractPresentedKey(req) {
  const headers = req?.headers || {};
  const direct = headers['x-api-key'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, MAX_KEY_LEN);
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m && m[1].startsWith(KEY_PREFIX)) return m[1].slice(0, MAX_KEY_LEN);
  }
  return null;
}

/**
 * Resolve the presented key to an entitlement.
 *
 * Never throws: a store failure is a RESULT ('store-unavailable'), because the
 * caller must be able to tell it apart from a bad key, and an exception at this
 * boundary would land in v1's generic 500 where that distinction dies.
 *
 * @returns {Promise<
 *   | { state: 'anonymous' }
 *   | { state: 'malformed' | 'unknown' | 'revoked' }
 *   | { state: 'store-unconfigured' | 'store-unavailable' | 'tier-unknown' }
 *   | { state: 'ok', keyId: string, ownerWallet: string|null, tier: import('./apiTiers.js').ApiTier }
 * >}
 */
export async function verifyApiKey(req) {
  const presented = extractPresentedKey(req);
  if (!presented) return { state: 'anonymous' };
  if (!KEY_RE.test(presented)) return { state: 'malformed' };

  const store = getKeyStore();
  if (!store) return { state: 'store-unconfigured' };

  let row;
  try {
    const { data, error } = await store
      .from(KEYS_TABLE)
      .select('id, tier, owner_wallet, revoked_at')
      .eq('key_hash', hashApiKey(presented))
      .maybeSingle();
    // A PostgREST error is NOT "no such key". Reporting it as 401 tells a paying
    // integrator their credential was rejected during our database incident.
    if (error) {
      console.error('[apiAuth] key lookup failed:', logSafe(error.message ?? error));
      return { state: 'store-unavailable' };
    }
    row = data;
  } catch (err) {
    console.error('[apiAuth] key lookup threw:', logSafe(err));
    return { state: 'store-unavailable' };
  }

  if (!row) return { state: 'unknown' };
  if (row.revoked_at) return { state: 'revoked' };

  // A tier column that no longer names a catalog entry (renamed tier, hand-edited
  // row) is an entitlement we cannot determine. Falling back to `free` would
  // silently downgrade a paying customer; falling back to the top tier would give
  // away the product. Neither is an answer, so this is our failure, not theirs.
  const tier = getTier(row.tier);
  if (!tier) {
    console.error(`[apiAuth] key ${row.id} carries unknown tier "${row.tier}"`);
    return { state: 'tier-unknown' };
  }

  return {
    state: 'ok',
    keyId: String(row.id),
    ownerWallet: row.owner_wallet ? String(row.owner_wallet) : null,
    tier,
  };
}

/** The UTC instant the current monthly quota window rolls over. */
export function monthlyQuotaReset(now = new Date()) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/** Quota bucket id — `YYYY-MM` in UTC, so the window is the same everywhere. */
export function quotaPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Two months of retention so a period that has just rolled over is still
// readable for a usage display; the counter is a meter, not a ledger.
const QUOTA_TTL_SEC = 70 * 24 * 60 * 60;

/**
 * Spend one call against a key's per-minute limit and monthly quota.
 *
 * Returns either a refusal to be written verbatim, or `{ ok: true, settle }`.
 * `settle(status)` MUST be called with the status actually sent: a 5xx is our
 * failure and is refunded, because billing a customer for our outage is the
 * money-side version of rendering an outage as a clean scan.
 *
 * @param {{ keyId: string, tier: import('./apiTiers.js').ApiTier }} ctx
 */
export async function meterKeyedCall(ctx) {
  const { keyId, tier } = ctx;
  const redis = getRedis();
  if (!redis) {
    // No meter, no service. See the header: an in-memory monthly counter reset
    // by every cold start is not a quota, and serving against one is serving for
    // free while telling the customer they were metered.
    return {
      ok: false,
      status: 503,
      code: 'metering_not_configured',
      message:
        'Usage metering is not configured on this deployment, so keyed requests are not served. ' +
        'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
    };
  }

  const limiter = getTierLimiter(tier);
  let window;
  try {
    window = await limiter.limit(keyId);
  } catch (err) {
    console.error('[apiAuth] rate window failed:', logSafe(err));
    return {
      ok: false,
      status: 503,
      code: 'metering_unavailable',
      message: 'Usage metering is temporarily unavailable — keyed requests are not served while it is down.',
    };
  }

  const headers = {
    'X-RateLimit-Limit': String(tier.rateLimitPerMinute),
    'X-RateLimit-Remaining': String(Math.max(0, window.remaining)),
    'X-RateLimit-Reset': String(Math.floor(window.reset / 1000)),
  };

  if (!window.success) {
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      message: `Over the ${tier.label} tier limit of ${tier.rateLimitPerMinute} requests/minute.`,
      headers,
      retryAfterSec: Math.max(1, Math.ceil((window.reset - Date.now()) / 1000)),
      resetAtMs: window.reset,
    };
  }

  const period = quotaPeriod();
  const quotaKey = `tegridy:apiquota:${keyId}:${period}`;
  let used;
  try {
    used = await redis.incr(quotaKey);
    // TTL only on the first increment of a period. Re-arming it every call would
    // make a busy key's bucket immortal and a quiet one's expire mid-month.
    if (used === 1) await redis.expire(quotaKey, QUOTA_TTL_SEC);
  } catch (err) {
    console.error('[apiAuth] quota counter failed:', logSafe(err));
    return {
      ok: false,
      status: 503,
      code: 'metering_unavailable',
      message: 'Usage metering is temporarily unavailable — keyed requests are not served while it is down.',
    };
  }

  const resetAtMs = monthlyQuotaReset();
  const quotaHeaders = {
    ...headers,
    'X-API-Tier': tier.id,
    'X-API-Quota-Limit': String(tier.includedCallsPerMonth),
    'X-API-Quota-Used': String(used),
    'X-API-Quota-Reset': String(Math.floor(resetAtMs / 1000)),
  };

  if (used > tier.includedCallsPerMonth) {
    // Hard stop, not overage. `overageUsdPerCall` is a published intent; with no
    // payment processor wired there is nothing that could bill the extra call, so
    // serving it would be giving the product away under a price list that says
    // otherwise. The message says which of the two it is.
    return {
      ok: false,
      status: 429,
      code: 'quota_exhausted',
      message: API_BILLING_ENABLED
        ? `Monthly quota of ${tier.includedCallsPerMonth} calls exhausted for the ${tier.label} tier.`
        : `Monthly quota of ${tier.includedCallsPerMonth} calls exhausted for the ${tier.label} tier. ` +
          'Overage is not billable on this deployment, so the quota is a hard stop.',
      headers: quotaHeaders,
      retryAfterSec: Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000)),
      resetAtMs,
    };
  }

  return {
    ok: true,
    headers: quotaHeaders,
    /**
     * @param {number} status the status actually sent to the caller
     */
    settle: async (status) => {
      if (status < 500) return;
      try {
        await redis.decr(quotaKey);
      } catch (err) {
        // A refund we could not apply is worth one log line and nothing more —
        // failing the request now would replace an overcharge of one call with
        // an outage the caller can see.
        console.error('[apiAuth] quota refund failed:', logSafe(err));
      }
    },
  };
}

/**
 * The full admission gate for a keyed route: verify, then meter.
 *
 * Writes the refusal itself and returns null when the call is not admitted, so a
 * caller cannot forget to respond. On success returns the context plus `settle`.
 *
 * @param {{ requireKey: boolean }} opts `requireKey` false lets anonymous callers
 *   through untouched (the free consumer routes); true 401s them.
 */
export async function admitKeyedCall(req, res, opts = {}) {
  const requireKey = opts.requireKey !== false;
  const auth = await verifyApiKey(req);

  if (auth.state === 'anonymous') {
    if (!requireKey) return { admitted: true, keyed: false, settle: async () => {} };
    return refuse(res, 401, 'api_key_required', 'This endpoint requires an API key. Send it as the X-API-Key header.');
  }
  if (auth.state === 'malformed' || auth.state === 'unknown') {
    // One message for both: telling an anonymous prober that a well-formed key
    // merely does not exist is a free existence oracle over the key space.
    return refuse(res, 401, 'api_key_invalid', 'API key not recognised.');
  }
  if (auth.state === 'revoked') {
    // Distinct on purpose. The holder of a revoked key had a valid one; sending
    // them to "not recognised" hides the one fact that explains the failure.
    return refuse(res, 401, 'api_key_revoked', 'This API key has been revoked.');
  }
  if (auth.state === 'store-unconfigured') {
    return refuse(
      res,
      503,
      'api_keys_not_configured',
      'API key verification is not configured on this deployment, so keys cannot be checked and keyed requests are not served.',
    );
  }
  if (auth.state === 'store-unavailable') {
    return refuse(res, 503, 'api_key_store_unavailable', 'API key verification is temporarily unavailable.');
  }
  if (auth.state === 'tier-unknown') {
    return refuse(res, 503, 'api_key_tier_unknown', 'This key is on a tier this deployment cannot resolve.');
  }

  const meter = await meterKeyedCall({ keyId: auth.keyId, tier: auth.tier });
  if (!meter.ok) {
    for (const [k, v] of Object.entries(meter.headers || {})) res.setHeader(k, v);
    if (meter.retryAfterSec) res.setHeader('Retry-After', String(meter.retryAfterSec));
    res.setHeader('Cache-Control', 'no-store');
    res.status(meter.status).json({
      error: meter.message,
      code: meter.code,
      ...(meter.resetAtMs ? { resetAt: new Date(meter.resetAtMs).toISOString() } : {}),
    });
    return null;
  }

  for (const [k, v] of Object.entries(meter.headers)) res.setHeader(k, v);
  return { admitted: true, keyed: true, keyId: auth.keyId, tier: auth.tier, settle: meter.settle };
}

function refuse(res, status, code, message) {
  // Never cached: a 401 or a 503 held at the edge outlives the condition that
  // produced it, and a cached 503 would keep refusing after the fix landed.
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: message, code });
  return null;
}

// ── Issuance ─────────────────────────────────────────────────────────────

/**
 * Read the SIWE session from the httpOnly cookie. Issuance is wallet-authed, not
 * key-authed — a key cannot mint another key, so a leaked key cannot grow itself
 * a family of successors that survive its revocation.
 *
 * @returns {Promise<{ wallet: string } | null>}
 */
export async function readSiweSession(req) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  const cookieHeader = req?.headers?.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)siwe_jwt=([^;]*)/);
  if (!match) return null;
  try {
    const { payload } = await jwtVerify(match[1], new TextEncoder().encode(secret), {
      issuer: 'supabase',
      audience: 'authenticated',
      algorithms: ['HS256'],
    });
    const wallet = payload.wallet || payload.sub;
    return wallet ? { wallet: String(wallet).toLowerCase() } : null;
  } catch {
    return null;
  }
}

/** Keys one wallet may hold at once. Bounds a script that mints forever. */
export const MAX_KEYS_PER_WALLET = 5;

function newSecret() {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url');
}

/**
 * Mint a key for a wallet.
 *
 * BILLING IS NOT WIRED, so this refuses any tier with a price: issuance must
 * never be the path by which a paid entitlement is obtained for nothing. The
 * operator grants paid tiers by hand until a processor exists.
 *
 * @param {{ ownerWallet: string, label?: string, tierId?: string }} input
 */
export async function issueApiKey(input) {
  const tierId = input.tierId || DEFAULT_TIER_ID;
  if (!isSelfServeTier(tierId)) {
    return {
      ok: false,
      status: 403,
      code: 'tier_not_self_serve',
      message: `The ${tierId} tier is not self-serve on this deployment. Paid tiers require an operator until billing is wired.`,
    };
  }

  const store = getKeyStore();
  if (!store) {
    return {
      ok: false,
      status: 503,
      code: 'api_keys_not_configured',
      message: 'API key issuance is not configured on this deployment.',
    };
  }

  const ownerWallet = String(input.ownerWallet).toLowerCase();
  const label = String(input.label || '').trim().slice(0, 64) || 'default';

  try {
    const { count, error: countErr } = await store
      .from(KEYS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('owner_wallet', ownerWallet)
      .is('revoked_at', null);
    if (countErr) throw new Error(countErr.message);
    if ((count ?? 0) >= MAX_KEYS_PER_WALLET) {
      return {
        ok: false,
        status: 409,
        code: 'key_limit_reached',
        message: `A wallet may hold ${MAX_KEYS_PER_WALLET} active keys. Revoke one first.`,
      };
    }

    const secret = newSecret();
    const { data, error } = await store
      .from(KEYS_TABLE)
      .insert({
        key_hash: hashApiKey(secret),
        key_prefix: secret.slice(0, DISPLAY_PREFIX_LEN),
        owner_wallet: ownerWallet,
        tier: tierId,
        label,
      })
      .select('id, key_prefix, tier, label, created_at')
      .single();
    if (error) throw new Error(error.message);

    // The only time the plaintext exists outside the caller's terminal.
    return { ok: true, secret, key: data };
  } catch (err) {
    console.error('[apiAuth] issuance failed:', logSafe(err));
    return {
      ok: false,
      status: 503,
      code: 'api_key_store_unavailable',
      message: 'API key issuance is temporarily unavailable.',
    };
  }
}

/** Metadata for a wallet's keys. Never returns `key_hash`. */
export async function listApiKeys(ownerWallet) {
  const store = getKeyStore();
  if (!store) {
    return {
      ok: false,
      status: 503,
      code: 'api_keys_not_configured',
      message: 'API key issuance is not configured on this deployment.',
    };
  }
  try {
    const { data, error } = await store
      .from(KEYS_TABLE)
      .select('id, key_prefix, tier, label, created_at, revoked_at')
      .eq('owner_wallet', String(ownerWallet).toLowerCase())
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { ok: true, keys: data || [] };
  } catch (err) {
    console.error('[apiAuth] list failed:', logSafe(err));
    return {
      ok: false,
      status: 503,
      code: 'api_key_store_unavailable',
      message: 'API key listing is temporarily unavailable.',
    };
  }
}

/**
 * Revoke one key. Scoped by owner_wallet in the WHERE clause, so a caller cannot
 * revoke a key they do not own even if they learn its id.
 */
export async function revokeApiKey({ ownerWallet, id }) {
  const store = getKeyStore();
  if (!store) {
    return {
      ok: false,
      status: 503,
      code: 'api_keys_not_configured',
      message: 'API key issuance is not configured on this deployment.',
    };
  }
  try {
    const { data, error } = await store
      .from(KEYS_TABLE)
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('owner_wallet', String(ownerWallet).toLowerCase())
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return { ok: false, status: 404, code: 'key_not_found', message: 'No active key with that id for this wallet.' };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[apiAuth] revoke failed:', logSafe(err));
    return {
      ok: false,
      status: 503,
      code: 'api_key_store_unavailable',
      message: 'API key revocation is temporarily unavailable.',
    };
  }
}

/**
 * What this deployment can actually do, for the developer page.
 *
 * Reports CONFIGURATION, never a guess. The page renders 'not_configured' as an
 * explicit "issuance is off here", which is a fact; a page that omitted the field
 * would let a reader assume the opposite.
 */
export function apiPlatformStatus() {
  return {
    keyVerification: getKeyStore() ? 'configured' : 'not_configured',
    keyIssuance: getKeyStore() && process.env.SUPABASE_JWT_SECRET ? 'configured' : 'not_configured',
    metering: getRedis() ? 'configured' : 'not_configured',
    billing: API_BILLING_ENABLED ? 'configured' : 'not_configured',
  };
}
