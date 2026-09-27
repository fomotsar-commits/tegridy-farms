// Style tokens and pure helpers for the /curve-launch UI. No React, so the
// component files export only components.

import type { TreasuryDescription } from '../../../lib/launcher/solana/curve';

export const CARD = 'rounded-2xl p-5 relative overflow-hidden';
export const CARD_STYLE = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;
export const SHADOW = { textShadow: '0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)' } as const;
// 16px on every screen: iOS Safari zooms the page when a field under 16px gets
// focus, on iPhone AND iPad, and index.css's site-wide `max(16px, inherit)` rule is
// invalid CSS that browsers drop.
export const inputCls = 'w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[16px] outline-none';
export const inputStyle = { border: '1px solid rgba(255,255,255,0.18)' } as const;
// Buy/Sell, slippage presets, Recent/Yours: 44px tall, the same touch target the
// site's .btn-* classes get (index.css). py-1.5 with 12px text is only about 30px.
export const TOGGLE_CLS = 'flex-1 min-h-[44px] py-1.5 rounded-lg text-[12px] text-white transition-colors';
export const DIVIDER = { borderTop: '1px solid rgba(255,255,255,0.08)' } as const;

/** Basis points as a percentage with two decimals: 369n → "3.69%". */
export const bpsPercent = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;

/**
 * The platform reserve, said plainly. `share` is words read from chain ("3.69% of
 * the supply"); `treasury` names `global.fee_recipient` and is called a multisig only
 * when it is the known Squads vault (describeTreasury). `when` is 'will' before a
 * token exists and 'was' for one already created: `create_launch` pays the reserve
 * in the same instruction that creates the curve, so there is no third case.
 */
export function reserveDisclosure(share: string, treasury: TreasuryDescription, when: 'will' | 'was'): string {
  const paid =
    when === 'will'
      ? `When the token is created, the platform receives ${share}, sent to ${treasury.name}.`
      : `When this token was created, the platform received ${share}, sent to ${treasury.name}.`;
  const unconfirmed = treasury.multisig ? '' : ' This page cannot confirm that the treasury is a multisig.';
  return `${paid}${unconfirmed} The program does not stop the treasury selling those tokens, including while the curve is live.`;
}

/**
 * What happens to the supply, from the program's own reserve setting. The curve can
 * sell only what is left after the platform reserve, so "the whole supply" is said
 * only when there is no reserve.
 */
export function supplySentence(platformReserveBps: bigint, treasury: TreasuryDescription): string {
  const never = 'Nobody, including you, can ever make more.';
  if (platformReserveBps <= 0n || platformReserveBps >= 10_000n) {
    return platformReserveBps <= 0n ? `The whole supply goes onto the curve. ${never}` : never;
  }
  return (
    `${bpsPercent(10_000n - platformReserveBps)} of the supply goes onto the curve. ` +
    `The other ${bpsPercent(platformReserveBps)} is the platform reserve: it is sent to ${treasury.name} in the ` +
    `same transaction that creates the token. ${never}`
  );
}

/**
 * How the trade fee is split. `creatorFeeShareBps` is a share OF THE FEE, not of
 * the trade; the protocol keeps the rest. `null` for a share over 100%, which the
 * program never writes, so no split is invented for it.
 */
export function feeSplitLabel(creatorFeeShareBps: bigint): string | null {
  if (creatorFeeShareBps < 0n || creatorFeeShareBps > 10_000n) return null;
  return `creator ${bpsPercent(creatorFeeShareBps)} · protocol ${bpsPercent(10_000n - creatorFeeShareBps)} of the fee`;
}

/**
 * `part / whole` as a percentage with two decimals, from integers only. `null`
 * when there is no honest ratio (a zero or negative whole), never "0.00%".
 */
export function sharePercent(part: bigint, whole: bigint): string | null {
  if (whole <= 0n || part < 0n) return null;
  const bps = (part * 10_000n) / whole;
  const s = `${bps / 100n}.${(bps % 100n).toString().padStart(2, '0')}%`;
  // A real holding that rounds to 0.00% says so rather than reading as nothing.
  return bps === 0n && part > 0n ? '<0.01%' : s;
}

/** Price impact for a row. `null` (no price to measure against) is said, never "0.00%". */
export const impactText = (bps: bigint | null) => (bps === null ? 'could not compute' : bpsPercent(bps));

/** A price impact at or above these gets a warning, then a stronger one. */
export const IMPACT_WARN_BPS = 500n;
export const IMPACT_HIGH_BPS = 1500n;

/** The warning a price impact earns, or null. The same words on the form and the review. */
export function impactWarning(bps: bigint | null): { tone: 'warn' | 'bad'; text: string } | null {
  if (bps === null) {
    return { tone: 'warn', text: 'The price impact could not be computed. Check what you receive below before you continue.' };
  }
  if (bps >= IMPACT_HIGH_BPS) {
    return {
      tone: 'bad',
      text: `This trade moves the price by ${bpsPercent(bps)}. You get far less than the current price suggests. A smaller amount moves it less.`,
    };
  }
  if (bps >= IMPACT_WARN_BPS) {
    return {
      tone: 'warn',
      text: `This trade moves the price by ${bpsPercent(bps)}. You get noticeably less than the current price suggests.`,
    };
  }
  return null;
}

/** A pool quote's price impact (a fraction, 0.05 = 5%) in bps, for the same warnings. */
export const fractionToBps = (f: number): bigint | null => (Number.isFinite(f) && f >= 0 ? BigInt(Math.round(f * 10_000)) : null);

/**
 * Base units as text the amount field accepts: 98612106050692 at 6 decimals is
 * "98612106.050692". No thousands separators and no rounding, so the amount parses
 * back to exactly these base units. `null` decimals: the field takes base units.
 */
export function baseUnitsToInput(v: bigint, decimals: number | null): string {
  if (decimals === null || decimals <= 0) return v.toString();
  const scale = 10n ** BigInt(decimals);
  const frac = (v % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${v / scale}${frac ? `.${frac}` : ''}`;
}

/**
 * Slippage: 0.5 / 1 / 3 % presets, a typed value up to 5 %, a warning above 3 %.
 * The value is in bps. Anything the picker cannot honour is reported as `null`
 * to the parent, which must then refuse to build a trade.
 */
export const SLIPPAGE_PRESETS_BPS = [50n, 100n, 300n] as const;
export const DEFAULT_SLIPPAGE_BPS = 100n;
export const MAX_SLIPPAGE_BPS = 500n;
export const WARN_SLIPPAGE_BPS = 300n;

export function parseSlippagePercent(text: string): bigint | null {
  const t = text.trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  const bps = BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2));
  if (bps <= 0n || bps > MAX_SLIPPAGE_BPS) return null;
  return bps;
}

