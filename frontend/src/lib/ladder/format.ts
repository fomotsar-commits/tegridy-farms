// Raw base units in, strings a person can read out — and, separately, strings a
// machine can parse back.
//
// ⚠️ DISPLAY AND DATA ARE DIFFERENT STRINGS, and conflating them is a live bug this
// repo has already shipped once. `LighthousePoolLive`'s MAX button used to round-trip
// its own DISPLAY string back through the parser after stripping commas. `fmt` groups
// with `toLocaleString()`, so in any dot-grouping locale (de-DE, pt-BR, it-IT, nl-NL)
// a balance of 1234 renders as "1.234", survives the comma-strip untouched, and parses
// as 1.234 tokens instead of 1234 — a silent factor-of-1000 under-stake with the
// wallet showing the right number the whole way. In space-grouping locales (fr-FR,
// es-ES) it fails to parse and the button dead-ends instead.
//
// So: `fmtRaw` is for eyes and is never parsed. `toPlain` is for parsing and is never
// grouped. The test file pins both halves against the locales that broke it.

/** Raw base units → a grouped, readable string. `null` reads as an em-dash, not 0. */
export function fmtRaw(raw: bigint | null | undefined, decimals: number, maxFrac = 2): string {
  if (raw === null || raw === undefined) return '–';
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = decimals > 0 ? s.slice(0, -decimals) || '0' : s;
  const frac = decimals > 0 ? s.slice(-decimals).replace(/0+$/, '') : '';
  const wholeNum = Number(whole);
  const wholeFmt = Number.isSafeInteger(wholeNum) ? wholeNum.toLocaleString() : whole;
  const out = frac ? `${wholeFmt}.${frac.slice(0, maxFrac)}` : wholeFmt;
  return neg ? `-${out}` : out;
}

/** Raw base units → a LOCALE-FREE decimal string, safe to feed back to `toRaw`. */
export function toPlain(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = decimals > 0 ? s.slice(0, -decimals) || '0' : s;
  const frac = decimals > 0 ? s.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * A typed amount → raw base units, or null when it is not a plain decimal.
 *
 * Returns null rather than 0 on anything it does not understand: a `0n` here would
 * be indistinguishable from a real zero and would sail through an `amount > 0` gate
 * as "the user typed nothing" rather than stopping the form.
 *
 * Extra fraction digits are TRUNCATED, never rounded up — rounding up would build a
 * transfer for more than the person typed.
 */
export function toRaw(human: string, decimals: number): bigint | null {
  const t = human.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(w + frac);
  } catch {
    return null;
  }
}

const DAY = 86_400;

/**
 * A duration a person can hold.
 *
 * Rolls up past a month and past a year on purpose: a well-funded vault against a
 * small stake produces enormous runways, and the first BAYLA top-up rendered as
 * "55555d" — a five-digit number nobody reads as 152 years.
 */
export function humanDuration(secs: number): string {
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / DAY);
  if (d >= 365) {
    const y = d / 365;
    return `${y >= 10 ? Math.round(y) : y.toFixed(1)}y`;
  }
  if (d >= 60) return `${Math.round(d / 30)}mo`;
  if (d >= 1) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

/** A lock length as the ladder's own rung label. */
export function lockLabel(secs: number): string {
  if (secs >= 365 * DAY) {
    const y = secs / (365 * DAY);
    return `${Number.isInteger(y) ? y : y.toFixed(1)}y`;
  }
  return `${Math.round(secs / DAY)}d`;
}

/** A boost in bps as a multiplier, e.g. 4_000 → "0.40×". */
export function boostLabel(bps: number): string {
  return `${(bps / 10_000).toFixed(2)}×`;
}
