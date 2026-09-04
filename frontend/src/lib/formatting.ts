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

export function formatTokenAmount(value: string | number, decimals = 4): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(num) || isNaN(num)) return '–';
  if (num === 0) return (0).toFixed(decimals);
  if (num > 0 && num < 0.000001) return num.toExponential(2);
  if (num > 0 && num < 0.0001) return num.toFixed(8);
  return num.toFixed(decimals);
}

/**
 * F207: like `formatTokenAmount` but groups the integer part with thousands
 * separators so a 75M-TOWELI receive reads `75,000,000.0000` instead of the
 * unreadable `75000000.0000`. Keeps the tiny/scientific branches identical so
 * dust still renders distinctly. Additive — `formatTokenAmount` is unchanged
 * for the many callers that don't want grouping.
 */
export function formatTokenAmountGrouped(value: string | number, decimals = 4): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(num) || isNaN(num)) return '–';
  if (num === 0) return (0).toFixed(decimals);
  if (num > 0 && num < 0.000001) return num.toExponential(2);
  if (num > 0 && num < 0.0001) return num.toFixed(8);
  // Group only the integer part; preserve the fixed fractional display.
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * F207: floor-aware balance formatting. A 0.00004-ETH balance rendered through
 * `Number(x).toFixed(4)` collapses to a misleading `0.0000`; this shows
 * `<0.0001` for any non-zero value below the display floor so dust reads as
 * present-but-tiny rather than empty. Groups large balances for readability.
 */
export function formatBalance(value: string | number, decimals = 4): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(num) || isNaN(num)) return '0';
  if (num === 0) return (0).toFixed(decimals);
  const floor = Math.pow(10, -decimals);
  if (num > 0 && num < floor) return `<${floor.toFixed(decimals)}`;
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
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
