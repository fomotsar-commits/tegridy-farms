// The on-ramp partner fee — DISCLOSURE ONLY. This module charges nothing.
//
// WHY IT DOES NOT GO THROUGH lib/fees/swapFee.ts, which is the venue's fee policy for
// everything else: that policy exists to put a rate and a RECIPIENT ADDRESS into an
// aggregator request, so the venue can be sure who receives a fee it caused to be charged.
// A ramp partner fee has neither half. It is configured inside the provider's own partner
// dashboard, charged by the provider, and paid out to the operating entity off-chain —
// there is no request parameter to attach and no on-chain recipient to name. Routing it
// through `swapFeePolicy()` would attach the SWAP rate to a rail that never charges it,
// and `providerFeeAttachment()` would hand a ramp a set of aggregator query parameters.
// So: no second mechanism is invented here, because there is no mechanism at all — only a
// number the operator has already agreed with the partner, mirrored so the UI can say it.
//
// The consequence for honesty is the important part. This value is a MIRROR of a setting
// this code cannot read, so it can be wrong in one direction: unset. An unset dial must
// therefore never render as "no partner fee" — the provider's own checkout breakdown is
// the authority, and the surface must say so. `declared: false` means "we are not telling
// you this figure", never "it is zero".

/**
 * Ceiling on the disclosed figure, in basis points.
 *
 * Ramp partner fees sit at 0.5-1% in the plan; 2% is a generous ceiling. Over-max CLAMPS
 * rather than disabling: an operator who typed a too-large number still intends to
 * disclose a fee, and silently disclosing nothing would be the worse failure. Under-
 * disclosure is the risk this whole module guards against.
 */
export const MAX_ONRAMP_PARTNER_FEE_BPS = 200;

export type OnrampPartnerFeeDisclosure =
  | { declared: true; bps: number }
  | { declared: false };

/**
 * `VITE_ONRAMP_PARTNER_FEE_BPS` -> the figure to disclose, or an explicit non-disclosure.
 *
 * Zero is accepted as a DECLARATION of no partner fee, and is the one case where an
 * operator can honestly say the venue takes nothing. It is spelled `0`, deliberately
 * distinct from leaving the variable unset — that distinction is the whole point.
 * Fractional and non-numeric values are refused rather than rounded: a disclosed rate that
 * differs from the agreed one is a false statement about somebody's money.
 */
export function onrampPartnerFeeDisclosure(): OnrampPartnerFeeDisclosure {
  const raw = (import.meta.env.VITE_ONRAMP_PARTNER_FEE_BPS as string | undefined)?.trim();
  if (!raw) return { declared: false };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { declared: false };
  return { declared: true, bps: Math.min(n, MAX_ONRAMP_PARTNER_FEE_BPS) };
}

/** Percent string for display, e.g. 75 bps -> "0.75%". Never call this on a non-declaration. */
export function formatPartnerFeeBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toString() : pct.toFixed(2).replace(/0$/, '')}%`;
}
