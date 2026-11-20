import { formatUnits } from 'viem';

export function formatCurrency(value: number, decimals = 2): string {
  if (!isFinite(value) || isNaN(value)) return '–';
  // Handle the sign once so negatives render as the conventional `-$12.34`
  // (sign OUTSIDE the `$`), not `$-12.34`. Format the magnitude, then prefix.
  const sign = value < 0 ? '-' : '';
  const v = Math.abs(value);
  if (v >= 1_000_000_000_000) return `${sign}$${(v / 1_000_000_000_000).toFixed(decimals)}T`;
  if (v >= 1_000_000_000) return `${sign}$${(v / 1_000_000_000).toFixed(decimals)}B`;
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(decimals)}M`;
  if (v >= 1_000) return `${sign}$${(v / 1_000).toFixed(decimals)}K`;
  if (v > 0 && v < 0.000001) return `${sign}$${v.toExponential(2)}`;
  if (v > 0 && v < 0.01) return `${sign}$${v.toFixed(Math.max(decimals, 8))}`;
  return `${sign}$${v.toFixed(decimals)}`;
}

export function formatNumber(value: number, decimals = 2): string {
  if (!isFinite(value) || isNaN(value)) return '–';
  // Handle the sign once so large negatives still get thousands separators
  // (the old code fell through every `>=` threshold for negatives, yielding
  // an un-grouped `-5000.00`).
  const sign = value < 0 ? '-' : '';
  const v = Math.abs(value);
  if (v >= 1_000_000_000_000) return `${sign}${(v / 1_000_000_000_000).toFixed(decimals)}T`;
  if (v >= 1_000_000_000) return `${sign}${(v / 1_000_000_000).toFixed(decimals)}B`;
  if (v >= 1_000_000) return `${sign}${(v / 1_000_000).toFixed(decimals)}M`;
  if (v >= 1_000) return `${sign}${v.toLocaleString('en-US', { maximumFractionDigits: decimals })}`;
  return `${sign}${v.toFixed(decimals)}`;
}

/** An amount written out exactly: its sign, whole digits and fraction digits. */
interface Decimal {
  neg: boolean;
  whole: string;
  frac: string;
}

// A plain decimal, written so the match has one way to split it (CodeQL js/polynomial-redos).
const DECIMAL = /^\s*([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,4}))?\s*$/;

/**
 * `value` as an exact decimal, times 10^shift. A decimal string is read digit for digit. A number
 * is read through 15 significant digits, every digit a double holds, so 0.29 stays 0.29 and
 * 0.1 + 0.2 reads 0.3 (from 1e15 up, every whole digit it has). Null when not a finite number.
 */
function decimalOf(value: string | number, shift = 0): Decimal | null {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return null;
  const plain = typeof value === 'string' && value.length <= 400 && DECIMAL.test(value);
  const m = DECIMAL.exec(plain ? (value as string) : Math.abs(num) >= 1e15 ? String(num) : num.toPrecision(15));
  if (!m) return null;
  const digits = (m[2] ?? '') + (m[3] ?? m[4] ?? '');
  const point = (m[2] ?? '').length + Number(m[5] ?? 0) + shift;
  let whole = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0');
  const frac = point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  whole = whole.replace(/^0+(?=\d)/, '');
  return { neg: m[1] === '-' && /[1-9]/.test(digits), whole, frac };
}

/** True when |d| is under 10^-places. */
function under(d: Decimal, places: number): boolean {
  return d.whole === '0' && /^0*$/.test(d.frac.slice(0, places));
}

/** `d` at `places` decimals: cut toward zero, or with `up` rounded away from zero. */
function roundAt(d: Decimal, places: number, up: boolean): Decimal {
  const kept = d.frac.slice(0, places).padEnd(places, '0');
  if (!up || !/[1-9]/.test(d.frac.slice(places))) return { neg: d.neg, whole: d.whole, frac: kept };
  const next = (BigInt(d.whole + kept) + 1n).toString().padStart(places + 1, '0');
  return { neg: d.neg, whole: next.slice(0, next.length - places), frac: next.slice(next.length - places) };
}

function textOf(d: Decimal, group: boolean, trim: boolean): string {
  const frac = trim ? d.frac.replace(/0+$/, '') : d.frac;
  const whole = group ? d.whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : d.whole;
  return `${d.neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** An amount under 0.000001 as toExponential(2) writes it ("1.23e-7"), cut or rounded up. */
function expText(d: Decimal, up: boolean): string {
  const first = d.frac.search(/[1-9]/);
  let mantissa = BigInt(d.frac.slice(first, first + 3).padEnd(3, '0'));
  let exp = -(first + 1);
  if (up && /[1-9]/.test(d.frac.slice(first + 3))) mantissa += 1n;
  if (mantissa === 1000n) {
    mantissa = 100n;
    exp += 1;
  }
  const m = mantissa.toString();
  return `${d.neg ? '-' : ''}${m[0]}.${m.slice(1)}e${exp}`;
}

/**
 * How an amount is written. What a visitor receives, is owed or holds is CUT at the last digit
 * shown, so it is never printed above itself; what a visitor pays is rounded `up`, so it is never
 * printed below. `sig` counts significant digits for an amount under 1; `shift` is a power of ten
 * applied first (-6 writes millions); `trim` drops trailing zeros.
 */
export interface DecimalShape {
  places?: number;
  sig?: number;
  up?: boolean;
  group?: boolean;
  trim?: boolean;
  shift?: number;
}

/** `value` written to `shape`, exactly; null when it is not a finite number. */
export function decimalText(value: string | number, shape: DecimalShape): string | null {
  const d = decimalOf(value, shape.shift ?? 0);
  if (!d) return null;
  let places = shape.places ?? 0;
  if (shape.sig !== undefined) {
    const first = d.frac.search(/[1-9]/);
    places = d.whole !== '0' || first < 0 ? 0 : first + shape.sig;
  }
  return textOf(roundAt(d, places, shape.up === true), shape.group === true, shape.trim === true);
}

function tokenAmountText(value: string | number, decimals: number, up: boolean, group: boolean): string {
  const d = decimalOf(value);
  if (!d) return '\u2013';
  if (!/[1-9]/.test(d.whole + d.frac)) return (0).toFixed(decimals);
  if (!d.neg && under(d, 6)) return expText(d, up);
  if (!d.neg && under(d, 4)) return textOf(roundAt(d, 8, up), false, false);
  return textOf(roundAt(d, decimals, up), group, false);
}

/** An amount received, owed or held, cut at `decimals`; dust under 0.0001 keeps more digits. */
export function formatTokenAmount(value: string | number, decimals = 4): string {
  return tokenAmountText(value, decimals, false, false);
}

/** An amount the visitor pays, as `formatTokenAmount` writes it but rounded up. */
export function formatTokenAmountUp(value: string | number, decimals = 4): string {
  return tokenAmountText(value, decimals, true, false);
}

/** A price, rate or multiplier, in `formatTokenAmount`'s shape but rounded to the nearest digit shown. */
export function formatTokenAmountNearest(value: string | number, decimals = 4): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(num) || isNaN(num)) return '\u2013';
  if (num === 0) return (0).toFixed(decimals);
  if (num > 0 && num < 0.000001) return num.toExponential(2);
  if (num > 0 && num < 0.0001) return num.toFixed(8);
  return num.toFixed(decimals);
}

/**
 * F207: like `formatTokenAmount` but groups the integer part with thousands
 * separators so a 75M-TOWELI receive reads `75,000,000.0000` instead of the
 * unreadable `75000000.0000`. Keeps the tiny/scientific branches identical so
 * dust still renders distinctly. Cut, like `formatTokenAmount`.
 */
export function formatTokenAmountGrouped(value: string | number, decimals = 4): string {
  return tokenAmountText(value, decimals, false, true);
}

/** An amount the visitor pays, as `formatTokenAmountGrouped` writes it but rounded up. */
export function formatTokenAmountGroupedUp(value: string | number, decimals = 4): string {
  return tokenAmountText(value, decimals, true, true);
}

/**
 * F207: floor-aware balance formatting. A 0.00004-ETH balance rendered through
 * `Number(x).toFixed(4)` collapses to a misleading `0.0000`; this shows
 * `<0.0001` for any non-zero value below the display floor so dust reads as
 * present-but-tiny rather than empty. Groups large balances, and cuts at `decimals`: never above the balance.
 */
export function formatBalance(value: string | number, decimals = 4): string {
  const d = decimalOf(value);
  if (!d) return '0';
  if (!/[1-9]/.test(d.whole + d.frac)) return (0).toFixed(decimals);
  if (!d.neg && under(d, decimals)) return `<${Math.pow(10, -decimals).toFixed(decimals)}`;
  return textOf(roundAt(d, decimals, false), true, false);
}

/** `Number(value).toFixed(places)` with the last digit cut instead of rounded. */
export function toFixedCut(value: string | number, places: number): string {
  return decimalText(value, { places }) ?? Number(value).toFixed(places);
}

/** `Number(value).toFixed(places)` with the last digit rounded up: for an amount paid. */
export function toFixedUp(value: string | number, places: number): string {
  return decimalText(value, { places, up: true }) ?? Number(value).toFixed(places);
}

/** `Number(value).toFixed(places)`, rounded to the nearest: for a price, rate or multiplier; `group` adds commas. */
export function toFixedNearest(value: string | number, places: number, group = false): string {
  const fixed = Number(value).toFixed(places);
  if (!group) return fixed;
  const [whole, frac] = fixed.split('.') as [string, string | undefined];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

/** `Number(value).toLocaleString(undefined, { maximumFractionDigits })`, its last digit cut. */
export function localeCut(value: string | number, maximumFractionDigits = 3): string {
  return Number(decimalText(value, { places: maximumFractionDigits }) ?? value).toLocaleString(undefined, { maximumFractionDigits });
}

/** As `localeCut`, the last digit rounded up: for an amount paid. */
export function localeUp(value: string | number, maximumFractionDigits = 3): string {
  return Number(decimalText(value, { places: maximumFractionDigits, up: true }) ?? value).toLocaleString(undefined, { maximumFractionDigits });
}

export function formatPercent(value: number): string {
  if (value >= 10000) return `${formatNumber(value, 0)}%`;
  return `${value.toFixed(2)}%`;
}

export function shortenAddress(address: string | undefined | null, chars = 4): string {
  if (!address || address.length < chars * 2 + 2) return address ?? '–';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Time remaining until a FUTURE unix timestamp, e.g. "5d left", "3h left",
 * "12m left", "<1m left". Returns "Ended" once the timestamp is in the past.
 * Use this for deadlines/countdowns — `formatTimeAgo` reports "just now" for any
 * future timestamp (negative elapsed), which is why deadlines read "Ends just now".
 */
export function formatTimeUntil(timestamp: number): string {
  const seconds = Math.floor(timestamp - Date.now() / 1000);
  if (seconds <= 0) return 'Ended';
  if (seconds < 60) return '<1m left';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m left`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h left`;
  return `${Math.floor(seconds / 86400)}d left`;
}

/**
 * Sanitize a user-typed token amount for a controlled decimal input.
 * Strips thousands separators and TERMINATES at scientific notation, so "1e5"
 * becomes "1" (visibly wrong, prompting the user) rather than the silently
 * plausible "15" the old strip-every-invalid-char approach produced. Collapses
 * to a single decimal point. Pair with `safeParseEther` for the parse step.
 */
export function sanitizeDecimalInput(raw: string): string {
  return raw
    .replace(/[eE][\s\S]*/, '')  // terminate at scientific notation ([\s\S] avoids the quadratic .*$ backtrack)
    .replace(/[^0-9.]/g, '')     // drop separators / letters / signs
    .replace(/(\..*)\./g, '$1'); // keep only the first decimal point
}

/** Format a large whole number with commas (e.g., 1234567 → "1,234,567") */
export function formatWholeNumber(value: number): string {
  if (!isFinite(value) || isNaN(value)) return '–';
  return Math.round(value).toLocaleString('en-US');
}

/** `formatWholeNumber` for an amount the visitor holds or receives: cut, never rounded up. */
export function formatWholeNumberCut(value: number): string {
  return decimalText(value, { places: 0, group: true }) ?? '\u2013';
}

/**
 * Format a BigInt wei value to a display string without unnecessary Number() conversion.
 * Avoids the Number(formatEther(x)).toFixed(d) anti-pattern that loses precision for large values.
 */
export function formatWei(value: bigint, decimals: number = 18, displayDecimals: number = 4): string {
  const formatted = formatUnits(value, decimals);
  const dot = formatted.indexOf('.');
  if (dot === -1) return formatted + '.' + '0'.repeat(displayDecimals);
  const whole = formatted.slice(0, dot);
  const frac = formatted.slice(dot + 1).slice(0, displayDecimals).padEnd(displayDecimals, '0');
  return whole + '.' + frac;
}
