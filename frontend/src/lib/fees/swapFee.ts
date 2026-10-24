// Venue swap-fee policy: the one place the fee rate, its recipient and the per-provider
// legs that carry it are decided. SHIPS OFF, and stays off until an operator sets BOTH
// dials. There is no fallback recipient and none may be added.
// Values are read through functions, never exported constants, and anything that does
// not parse cleanly disables the fee rather than charging a surprise.
// Displayed and sent figures both come from `providerFeeAttachment`, and nothing else.

import type { AggregatorSource } from '../aggregator';
import { contractOn } from '../chains/registry';

/**
 * Hard ceiling on the venue fee, in basis points. docs/BATTLE_PLAN.md #3 intends 25 bps.
 * Over-max CLAMPS rather than disabling: an operator who typed 2500 meant "the maximum",
 * not a quarter of the trade.
 */
export const MAX_SWAP_FEE_BPS = 100;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SwapFeePolicy {
  /** True only when a usable rate AND a usable recipient ON THIS CHAIN are configured. */
  enabled: boolean;
  /** Effective rate in bps. Always 0 when `enabled` is false — never the raw override. */
  bps: number;
  /** The recipient on the chain asked about, or null when the fee is off there. */
  recipient: `0x${string}` | null;
}

/**
 * `VITE_SWAP_FEE_BPS` → an effective bps count. A fraction (12.5) is rejected, not
 * rounded, since no provider parameter can express it. Non-numeric, negative or zero
 * disables; over-max clamps.
 */
function feeBpsEnv(raw: string | undefined): number {
  const t = raw?.trim();
  if (!t) return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return 0;
  return Math.min(n, MAX_SWAP_FEE_BPS);
}

/**
 * `VITE_SWAP_FEE_RECIPIENT` → an address, or null. The zero address is rejected: several
 * providers read it as "no partner" and keep the fee.
 */
function feeRecipientEnv(raw: string | undefined): `0x${string}` | null {
  const t = raw?.trim();
  if (!t || !/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
  if (t.toLowerCase() === ZERO_ADDRESS) return null;
  return t as `0x${string}`;
}

/**
 * The configured recipient, accepted on `chainId` only if it IS the venue's treasury Safe
 * on that chain. A Safe exists per chain: Base's has no code on Ethereum, and ParaSwap
 * credits partner fees to a vault that only the partner address can withdraw from.
 * Any other address leaves the fee off there; it never picks a different destination.
 */
function feeRecipientOn(chainId: number, raw: string | undefined): `0x${string}` | null {
  const configured = feeRecipientEnv(raw);
  if (configured === null) return null;
  const treasury = contractOn(chainId, 'treasury');
  if (treasury.status !== 'deployed') return null;
  return configured.toLowerCase() === treasury.address.toLowerCase() ? treasury.address : null;
}

/** The venue's fee policy on `chainId`, the chain the fee would be collected on. Do not cache it. */
export function swapFeePolicy(chainId: number): SwapFeePolicy {
  const bps = feeBpsEnv(import.meta.env.VITE_SWAP_FEE_BPS as string | undefined);
  const recipient = feeRecipientOn(chainId, import.meta.env.VITE_SWAP_FEE_RECIPIENT as string | undefined);
  if (bps <= 0 || recipient === null) return { enabled: false, bps: 0, recipient: null };
  return { enabled: true, bps, recipient };
}

/** A policy that has already passed the enabled check, so a leg builder cannot see nulls. */
interface EnabledSwapFeePolicy {
  bps: number;
  recipient: `0x${string}`;
}

/**
 * Per-provider fee leg. `blocked` means the mechanism is not pinned down well enough to
 * send, not that the provider has none. A leg moves to `ready` by confirming `params`
 * against the provider's live API, never by assuming.
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
 * `ready` needs all three: the parameter names AND their unit are established, the
 * recipient is named in the request (else the provider picks who is paid), and the
 * provider quotes NET of the fee (else it wins rankings by exactly our own margin).
 */
export const PROVIDER_FEE_LEGS: Record<AggregatorSource, ProviderFeeLeg> = {
  // `partnerFeeBps` states its unit in its name, and `partnerAddress` names the recipient.
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

  // Odos prices the fee off a referral code registered on its side, not a request rate.
  odos: {
    status: 'blocked',
    params: ['referralCode'],
    mustConfirm:
      'a registered Odos referral code, and how its Odos-side rate is reconciled with VITE_SWAP_FEE_BPS — two independent rates would make the displayed figure a guess',
  },

  // CoW's fee rides the appData document, whose hash is pinned in src/lib/cowProtocol.ts.
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
 * The fee leg for one provider's request on `chainId`, or null when nothing is attached.
 * Display the rate from THIS object, never from `swapFeePolicy()`: a blocked provider
 * yields null while the policy is enabled.
 */
export function providerFeeAttachment(
  source: AggregatorSource,
  chainId: number,
): ProviderFeeAttachment | null {
  const policy = swapFeePolicy(chainId);
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
 * Query names each ready leg emits, keyed by `frontend/api/aggregator.js` provider id
 * (`kyber`, `cow`, not the AggregatorSource ids). That proxy DROPS unlisted parameters,
 * so a ready leg is inert, and display != sent, until its names are in `allowedQuery`.
 */
export const PROXY_ALLOWLIST_ADDITIONS: Partial<Record<string, readonly string[]>> = {
  paraswap: PROVIDER_FEE_LEGS.paraswap.params,
};
