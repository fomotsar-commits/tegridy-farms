// The API tier catalog — ONE source of truth for limits, quotas and prices.
//
// This module is imported by BOTH sides:
//   * the lambda (api/_lib/apiAuth.js) enforces `rateLimitPerMinute` and
//     `includedCallsPerMonth` from here;
//   * the browser (src/components/developer/*) renders the pricing table from
//     here, so published copy cannot drift from what the limiter actually does.
//
// It is therefore a .js file with a co-located .d.ts, the same arrangement
// record-core.js uses: a Vercel lambda cannot import a .ts module, and the
// alternative is a hand-maintained fork of the numbers on each side — which is
// exactly the drift that lets a page advertise 60 rpm while the limiter grants 10.
//
// HARD CONSTRAINT: keep this file free of imports and of `process.env`. It is
// bundled into the browser; a single `import { Redis }` here would ship the
// server's Upstash client to every visitor.

/**
 * Billing switch. FALSE means: no payment processor is wired, no card is taken,
 * and no overage can be charged — so the runtime treats every tier's monthly
 * quota as a HARD STOP (429) rather than the start of metered overage, and
 * self-serve issuance may only mint the tier whose price is zero.
 *
 * Flipping this to true without wiring a processor would publish a price the
 * venue cannot collect and meter overage it cannot bill. It is a code constant
 * rather than an env var precisely so that flip goes through review.
 */
export const API_BILLING_ENABLED = false;

/**
 * Pricing lifecycle. While 'proposed', the numbers below are a stated intent and
 * the developer page must say so: this is an unproven revenue category and the
 * house rule is design partners before public pricing.
 */
export const API_PRICING_STATE = 'proposed';

/**
 * Routes this deployment can actually serve, with the honest note about each.
 * `keyed: true` means anonymous callers get 401 — never a degraded free answer.
 */
export const API_ROUTES = [
  {
    id: 'scan',
    method: 'GET',
    path: '/api/v1?route=scan&chain=ethereum&address=0x…',
    summary: 'ERC-20 holder-distribution read with provenance and coverage.',
    keyed: true,
    // The scan envelope reports what was READ. Concentration scoring, risk
    // banding and the launch simulator still run in the browser bundle
    // (src/lib/detection, src/lib/launchSim) and are not served here.
    note: 'Returns the measured distribution, not a risk score.',
  },
  {
    id: 'collections',
    method: 'GET',
    path: '/api/v1?route=collections&slug=…',
    summary: 'Collection floor, owner count and supply.',
    keyed: false,
    note: 'Allowlisted collections only.',
  },
  {
    id: 'floor',
    method: 'GET',
    path: '/api/v1?route=floor&contract=0x…',
    summary: 'Floor price for an allowlisted collection.',
    keyed: false,
    note: 'Allowlisted collections only.',
  },
  {
    id: 'holders',
    method: 'GET',
    path: '/api/v1?route=holders&contract=0x…',
    summary: 'Top NFT holders by token count.',
    keyed: false,
    note: 'Allowlisted collections only.',
  },
  {
    id: 'activity',
    method: 'GET',
    path: '/api/v1?route=activity&contract=0x…',
    summary: 'Recent sales for an allowlisted collection.',
    keyed: false,
    note: 'Allowlisted collections only.',
  },
  {
    id: 'token',
    method: 'GET',
    path: '/api/v1?route=token&contract=0x…&tokenId=1',
    summary: 'Token metadata and current owner.',
    keyed: false,
    note: 'Allowlisted collections only.',
  },
  {
    id: 'listings',
    method: 'GET',
    path: '/api/v1?route=listings&slug=…',
    summary: 'Best active listings for an allowlisted collection.',
    keyed: false,
    note: 'Allowlisted collections only.',
  },
];

/**
 * Surfaces the venue computes but does NOT sell over this API yet. Listed so the
 * developer page can say what is missing instead of leaving a reader to infer it
 * from an endpoint table that quietly omits them. A roadmap row is honest; a
 * 501 stub that answers a documented URL is a promise the deployment cannot keep.
 */
export const API_ROADMAP = [
  {
    id: 'deployer',
    summary: 'Deployer reputation graph',
    blockedBy:
      'The scoring core is TypeScript in the browser bundle (src/lib/detection). ' +
      'Serving it needs the trust-core package extraction and a host that can run it.',
  },
  {
    id: 'wallet-exposure',
    summary: 'Wallet exposure engine',
    blockedBy: 'Same extraction as deployer reputation.',
  },
  {
    id: 'launch-sim',
    summary: 'Launch simulator',
    blockedBy: 'Needs POST bodies and a compute budget the 12-function Hobby deploy has no room for.',
  },
  {
    id: 'reputation-attestation',
    summary: 'EIP-712 signed reputation attestation',
    blockedBy:
      'Needs the attester keypair held on a dedicated host. Signing from a shared ' +
      'serverless deployment would put the venue signing key in the same blast radius as the proxies.',
  },
];

/**
 * The refusal contract, published verbatim.
 *
 * The three classes must never be confused with one another: 401 means the
 * CALLER's key is wrong, 429 means they are over a limit and the reset says for
 * how long, 5xx means WE could not answer. An integrator who cannot tell a
 * deployment gap from a bad key retries a key that was always correct.
 *
 * `api/__tests__/apiErrorSemantics.test.js` pins this list against the codes the
 * server can actually emit in both directions, so a new refusal cannot ship
 * undocumented and a documented one cannot outlive the code that sent it.
 */
export const API_ERROR_SEMANTICS = [
  {
    status: 401,
    code: 'api_key_required',
    meaning: 'A keyed endpoint was called with no key. There is no anonymous fallback answer.',
  },
  { status: 401, code: 'api_key_invalid', meaning: 'The key is not recognised. Malformed and unknown keys are deliberately indistinguishable.' },
  { status: 401, code: 'api_key_revoked', meaning: 'The key existed and was withdrawn. Issue a new one.' },
  { status: 400, code: 'missing_chain', meaning: 'No chain given. There is no default — a silent one answers about the wrong chain.' },
  { status: 400, code: 'chain_not_supported', meaning: 'This deployment cannot scan that chain.' },
  { status: 400, code: 'invalid_address', meaning: 'The address is not a valid EVM address.' },
  {
    status: 422,
    code: 'not_a_token',
    meaning:
      'The upstream LOOKED and the address is not an ERC-20 (a wallet, an NFT). An answer about the address, not a failure — this is the one refusal carrying scanned: true.',
  },
  {
    status: 429,
    code: 'rate_limited',
    meaning: 'Over the tier\'s requests-per-minute ceiling. Retry-After and X-RateLimit-Reset say when.',
  },
  {
    status: 429,
    code: 'quota_exhausted',
    meaning: 'The monthly included calls are spent. With billing off this is a hard stop; resetAt is the next month boundary.',
  },
  {
    status: 502,
    code: 'upstream_unavailable',
    meaning:
      'NO SCAN WAS PERFORMED. This is not a clean result and carries no distribution field. Never cache it, never render it as a pass.',
  },
  {
    status: 503,
    code: 'source_not_configured',
    meaning: 'The holder-data source has no key on this deployment. Retrying will not help; the operator must configure it.',
  },
  { status: 503, code: 'api_keys_not_configured', meaning: 'This deployment has no key store, so no key can be checked. Not a statement about your key.' },
  { status: 503, code: 'api_key_store_unavailable', meaning: 'The key store could not be reached. Transient on our side.' },
  { status: 503, code: 'api_key_tier_unknown', meaning: 'The key names a tier this deployment cannot resolve, so entitlement is undetermined. We refuse rather than guess.' },
  {
    status: 503,
    code: 'metering_not_configured',
    meaning: 'Usage metering is not wired, and keyed calls are not served unmetered. Serving here would be free service billed as metered.',
  },
  { status: 503, code: 'metering_unavailable', meaning: 'The meter is down. Keyed calls fail closed while it is.' },
];

/**
 * @type {Record<string, import('./apiTiers.js').ApiTier>}
 *
 * `overageUsdPerCall` is a PUBLISHED INTENT, not live behaviour: with
 * API_BILLING_ENABLED false nothing can be charged, so the quota hard-stops.
 * Keep the two facts adjacent — a table that lists an overage rate next to a
 * limiter that silently 429s is the same lie in two places.
 */
export const API_TIERS = {
  free: {
    id: 'free',
    label: 'Free',
    priceUsdMonthly: 0,
    includedCallsPerMonth: 1000,
    rateLimitPerMinute: 10,
    overageUsdPerCall: null,
    selfServe: true,
    blurb: 'Evaluation and hobby use. Issued from a connected wallet, no payment.',
  },
  starter: {
    id: 'starter',
    label: 'Starter',
    priceUsdMonthly: 99,
    includedCallsPerMonth: 50000,
    rateLimitPerMinute: 60,
    overageUsdPerCall: 0.004,
    selfServe: false,
    blurb: 'One product surface — a wallet, a bot, a single dashboard.',
  },
  growth: {
    id: 'growth',
    label: 'Growth',
    priceUsdMonthly: 499,
    includedCallsPerMonth: 400000,
    rateLimitPerMinute: 300,
    overageUsdPerCall: 0.002,
    selfServe: false,
    blurb: 'Production traffic across several surfaces.',
  },
  scale: {
    id: 'scale',
    label: 'Scale',
    priceUsdMonthly: 2000,
    includedCallsPerMonth: 2500000,
    rateLimitPerMinute: 1200,
    overageUsdPerCall: 0.001,
    selfServe: false,
    blurb: 'Aggregators and exchanges scanning continuously.',
  },
};

/** Display order. Explicit so the table does not depend on object key order. */
export const API_TIER_ORDER = ['free', 'starter', 'growth', 'scale'];

/** The one tier self-serve issuance may mint while billing is off. */
export const DEFAULT_TIER_ID = 'free';

/**
 * @param {string|null|undefined} id
 * @returns {import('./apiTiers.js').ApiTier | null}
 */
export function getTier(id) {
  if (typeof id !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(API_TIERS, id) ? API_TIERS[id] : null;
}

/**
 * A tier a key may hold. A row whose `tier` column no longer names a catalog
 * entry (renamed tier, hand-edited row) must NOT fall back to a permissive
 * default — callers treat `null` as "cannot determine entitlement" and refuse.
 * @param {string|null|undefined} id
 */
export function isKnownTier(id) {
  return getTier(id) !== null;
}

/**
 * Whether a tier can be minted without a payment step. Any priced tier is
 * unavailable to self-serve while billing is off; there is no free upgrade path.
 * @param {string} id
 */
export function isSelfServeTier(id) {
  const tier = getTier(id);
  if (!tier) return false;
  if (!tier.selfServe) return false;
  return API_BILLING_ENABLED || tier.priceUsdMonthly === 0;
}
