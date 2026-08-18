// Venue swap-fee policy — the single place the meta-router's fee rate, its
// recipient, and the per-provider legs that carry it are decided.
//
// SHIPS OFF. Default is 0 bps with no recipient, and it stays that way until an
// operator sets BOTH dials. A rate without a recipient is not a smaller fee, it is a
// fee paid to whoever the provider decides — so there is deliberately no constant
// here to fall back to, and none may be added.
//
// Structured like heat/heatGateConfig.ts: every value is read through a function
// rather than exported as a constant, so a caller cannot capture one at module-init
// and drift from a redeployed dial, and a nonsense override is IGNORED rather than
// obeyed. The failure mode this guards is not a stuck gate but a surprise charge on
// somebody else's money, so the parse is stricter than the heat gate's: anything that
// is not a whole, positive, in-range bps count disables the fee outright.
//
// The number a caller SENDS and the number a surface DISPLAYS both come from
// `providerFeeAttachment` — one call, one object, per provider per quote. Nothing
// else may compute a fee figure.

import type { AggregatorSource } from '../aggregator';

/**
 * Hard ceiling on the venue fee, in basis points.
 *
 * docs/BATTLE_PLAN.md #3 sets the intended rate at 25 bps (50 bps on the gasless CoW
 * path). The ceiling sits at 1% so a fat-fingered `2500` lands at 100 rather than
 * charging a quarter of the trade — over-max is clamped, not ignored, because an
 * operator who typed a too-large number still meant "charge the maximum".
 */
export const MAX_SWAP_FEE_BPS = 100;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SwapFeePolicy {
  /** True only when a usable rate AND a usable recipient are both configured. */
  enabled: boolean;
  /** Effective rate in bps. Always 0 when `enabled` is false — never the raw override. */
  bps: number;
  /** Checksum-agnostic 20-byte address, or null when the fee is off. */
  recipient: `0x${string}` | null;
}

/**
 * `VITE_SWAP_FEE_BPS` → an effective bps count.
 *
 * A fractional value (12.5) is rejected rather than rounded: no provider parameter in
 * the table below can express it, so rounding would make the sent fee differ from the
 * configured one. Everything non-numeric, negative or zero disables. Over-max clamps.
 */
function feeBpsEnv(raw: string | undefined): number {
  const t = raw?.trim();
  if (!t) return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return 0;
  return Math.min(n, MAX_SWAP_FEE_BPS);
}

/**
 * `VITE_SWAP_FEE_RECIPIENT` → an address, or null.
 *
 * The zero address is rejected explicitly: several providers treat it as "no partner"
 * and silently keep the fee, which would read on our side as revenue we never earned.
 */
function feeRecipientEnv(raw: string | undefined): `0x${string}` | null {
  const t = raw?.trim();
  if (!t || !/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
  if (t.toLowerCase() === ZERO_ADDRESS) return null;
  return t as `0x${string}`;
}

/** The venue's current fee policy. Read it; do not cache it. */
export function swapFeePolicy(): SwapFeePolicy {
  const bps = feeBpsEnv(import.meta.env.VITE_SWAP_FEE_BPS as string | undefined);
  const recipient = feeRecipientEnv(import.meta.env.VITE_SWAP_FEE_RECIPIENT as string | undefined);
  if (bps <= 0 || recipient === null) return { enabled: false, bps: 0, recipient: null };
  return { enabled: true, bps, recipient };
}

/** A policy that has already passed the enabled check, so a leg builder cannot see nulls. */
interface EnabledSwapFeePolicy {
  bps: number;
  recipient: `0x${string}`;
}

/**
 * Per-provider fee leg.
 *
 * `blocked` is not "this provider has no fee mechanism" — it is "the mechanism is not
 * pinned down well enough to send". `params` records the parameter names the repo's own
 * plan (docs/BATTLE_PLAN.md F3 and #3) attributes to the provider; `mustConfirm` records
 * what is still missing. A leg moves to `ready` by confirming that against the
 * provider's live API, not by assuming.
 */
export type ProviderFeeLeg =
  | {
      status: 'ready';
      params: readonly string[];
      query: (policy: EnabledSwapFeePolicy) => Record<string, string>;
    }
  | {
      status: 'blocked';
      params: readonly string[];
      mustConfirm: string;
    };

/**
 * The table. A provider is `ready` only when BOTH the parameter names AND the unit the
 * provider reads them in are established — a correct name carrying the wrong unit is
 * the worse bug of the two, because the fee still goes out and no surface can tell.
 *
 * The recipient must also be nameable in the request. A rate parameter with no
 * accompanying recipient parameter does not mean the fee is unclaimed; it means the
 * provider decides who gets it, which is the one outcome this module exists to prevent.
 *
 * Third condition for `ready`, easy to miss: the provider must quote NET of the fee.
 * The meta-router ranks raw amountOut, so a provider that reports a gross figure while
 * charging us on top would win comparisons it should lose, by exactly our own margin.
 */
export const PROVIDER_FEE_LEGS: Record<AggregatorSource, ProviderFeeLeg> = {
  // The only leg whose unit is not a matter of interpretation: `partnerFeeBps` states
  // its unit in its own name, and `partnerAddress` names the recipient in the request.
  paraswap: {
    status: 'ready',
    params: ['partnerAddress', 'partnerFeeBps'],
    query: (p) => ({ partnerAddress: p.recipient, partnerFeeBps: String(p.bps) }),
  },

  lifi: {
    status: 'blocked',
    params: ['integrator', 'fee'],
    mustConfirm:
      "the unit of `fee` (fraction / percent / bps), and that the fee recipient is bound to a registered `integrator` identity rather than passed in the request — this module refuses to send a rate it cannot address",
  },

  openocean: {
    status: 'blocked',
    params: ['referrer', 'referrerFee'],
    mustConfirm:
      'the unit and ceiling of `referrerFee`. A bps count read as a percent is a 100× overcharge, and nothing downstream could detect it',
  },

  kyberswap: {
    status: 'blocked',
    params: ['feeAmount', 'chargeFeeBy', 'feeReceiver'],
    mustConfirm:
      '`feeAmount` is an absolute token amount unless a separate flag marks it as bps; that flag is named nowhere in this repo. Also unconfirmed: whether the price-only /routes endpoint honours the fee quad at all, or only the build call',
  },

  swapapi: {
    status: 'blocked',
    params: ['swapFeeBps'],
    mustConfirm:
      'the parameter that names the fee RECIPIENT (0x-style APIs pair swapFeeBps with a recipient and a fee token). Without it the rate is a donation to the provider',
  },

  // Odos prices the fee against a referral code registered on Odos's side; the rate is
  // not a request parameter at all, so this module cannot be its source of truth.
  odos: {
    status: 'blocked',
    params: ['referralCode'],
    mustConfirm:
      'a registered Odos referral code, and how its Odos-side rate is reconciled with VITE_SWAP_FEE_BPS — two independent rates would make the displayed figure a guess',
  },

  // CoW carries a partner fee in the appData document, whose JSON and pinned keccak256
  // hash live in src/lib/cowProtocol.ts. Changing the document changes the hash the
  // solver re-derives, so the leg cannot be added from here without that module.
  cowswap: {
    status: 'blocked',
    params: ['appData.metadata.partnerFee'],
    mustConfirm:
      'the appData partner-fee schema version, re-pinned against src/lib/cowProtocol.ts (COW_APP_DATA_DOC / COW_APP_DATA_HASH) — a document edit that misses the hash rejects every order',
  },
};

/** The fee actually attached to one provider's request. */
export interface ProviderFeeAttachment {
  /** Rate in bps. Display this; never recompute it from the policy. */
  bps: number;
  recipient: `0x${string}`;
  /** Merge into the provider's own query string / body. */
  params: Record<string, string>;
}

/**
 * The fee leg for one provider, or null when nothing is to be attached.
 *
 * Callers must take the displayed rate from the returned object rather than from
 * `swapFeePolicy()`: a blocked provider yields null while the policy is enabled, and a
 * surface reading the policy directly would advertise a fee that provider never saw.
 */
export function providerFeeAttachment(source: AggregatorSource): ProviderFeeAttachment | null {
  const policy = swapFeePolicy();
  if (!policy.enabled || policy.recipient === null) return null;
  const leg = PROVIDER_FEE_LEGS[source];
  if (!leg || leg.status !== 'ready') return null;
  const enabled: EnabledSwapFeePolicy = { bps: policy.bps, recipient: policy.recipient };
  return { bps: policy.bps, recipient: policy.recipient, params: leg.query(enabled) };
}

/** Providers whose leg is withheld, with the reason. Drives the operator checklist. */
export function blockedFeeLegs(): { source: AggregatorSource; params: readonly string[]; mustConfirm: string }[] {
  return (Object.keys(PROVIDER_FEE_LEGS) as AggregatorSource[])
    .map((source) => ({ source, leg: PROVIDER_FEE_LEGS[source] }))
    .filter((e): e is { source: AggregatorSource; leg: Extract<ProviderFeeLeg, { status: 'blocked' }> } =>
      e.leg.status === 'blocked')
    .map(({ source, leg }) => ({ source, params: leg.params, mustConfirm: leg.mustConfirm }));
}

/**
 * Query parameters each ready leg emits, keyed by the provider id used in
 * `frontend/api/aggregator.js`.
 *
 * That proxy allowlists query parameters per provider and DROPS anything else, so a leg
 * marked ready here is still inert until its names appear in `CONFIGS[<id>].allowedQuery`
 * — and inert in the worst way: the request loses the fee while this module still reports
 * one. Enabling the fee without widening the allowlist first breaks display==sent.
 *
 * Keys are the PROXY's provider ids, which are not the AggregatorSource ids everywhere:
 * `kyberswap` proxies as `kyber` and `cowswap` as `cow`.
 */
export const PROXY_ALLOWLIST_ADDITIONS: Partial<Record<string, readonly string[]>> = {
  paraswap: PROVIDER_FEE_LEGS.paraswap.params,
};
