/**
 * The one place LP copy may say "a year" (FORECAST_WORDS, format.ts). A measured growth,
 * what it is measured against and the seconds it covers, as ONE string that carries its own
 * basis: how long, and that it is past. Simple proportion over a 365-day year, never
 * compounding. BigInt throughout. Every percent is two significant figures, CUT and never
 * rounded up, so the sentence never says more than was measured.
 */

const DAY = 86_400n;
const YEAR = 365n * DAY;
/** Decimal places the division keeps before the cut to two figures. */
const PLACES = 12n;
/** Under 0.0001% a measure is mostly rounding: it is said as "under", and never stretched to a year. */
const FLOOR_PER_PERCENT = 10_000n;
/** Past 1,000% a year, one large early trade is all the proportion shows: the yearly figure is left out. */
const CEILING_PERCENT = 1_000n;

const TAIL = 'Past trades, not a forecast.';
/** What the percent is a share of, for a caller that needs to say so. A closed list: the sentence is the helper's alone. */
const OF = { position: 'of this position' } as const;

/**
 * Every string `paceText` can return, whole. A test that bans FORECAST_WORDS on a surface
 * removes these first and nothing else, so "a year" passes only with its basis before it
 * and "Past trades, not a forecast." after it.
 */
export const PACE_SENTENCE =
  /(?:under 0\.0001|more than 1,000|\d[\d,]*(?:\.\d+)?)%(?: of this position)? in (?:under a minute|\d[\d,]*(?:\.\d)? (?:minute|hour|day)s?)\.(?: At that pace, about \d[\d,]*(?:\.\d+)?% a year\.)? Past trades, not a forecast\./g;

/** `num / den` cut to two significant figures and written out: "0.0084", "0.48", "12", "360", "1,000". Both positive. */
function twoFigures(num: bigint, den: bigint): string {
  const scale = 10n ** PLACES;
  const q = (num * scale) / den;
  const digits = q.toString().length;
  const kept = digits > 2 ? (q / 10n ** BigInt(digits - 2)) * 10n ** BigInt(digits - 2) : q;
  const frac = (kept % scale).toString().padStart(Number(PLACES), '0').replace(/0+$/, '');
  return `${(kept / scale).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/** Is `num / den` percent inside what the sentence prints as a number (0.0001% to 1,000%)? */
const printable = (num: bigint, den: bigint): boolean => num * FLOOR_PER_PERCENT >= den && num <= den * CEILING_PERCENT;

/**
 * A growth as a percent of what it is measured against: "0.0084%". Below 0.0001% it reads
 * "under 0.0001%", above 1,000% "more than 1,000%". Null unless both amounts are positive.
 */
export function percentText(growth: bigint, against: bigint): string | null {
  if (growth <= 0n || against <= 0n) return null;
  const num = growth * 100n;
  if (num * FLOOR_PER_PERCENT < against) return 'under 0.0001%';
  if (num > against * CEILING_PERCENT) return 'more than 1,000%';
  return `${twoFigures(num, against)}%`;
}

/** "6.3 days" (one decimal under ten days), "42 days", "5 hours", "40 minutes", "under a minute". Cut, never rounded up. */
function spanText(secs: bigint): string {
  const n = (count: bigint, unit: string) => `${count.toLocaleString('en-US')} ${unit}${count === 1n ? '' : 's'}`;
  if (secs < 60n) return 'under a minute';
  if (secs < 3_600n) return n(secs / 60n, 'minute');
  if (secs < DAY) return n(secs / 3_600n, 'hour');
  if (secs >= 10n * DAY) return n(secs / DAY, 'day');
  const tenths = (secs * 10n) / DAY;
  return tenths % 10n === 0n ? n(tenths / 10n, 'day') : `${tenths / 10n}.${tenths % 10n} days`;
}

/**
 * "0.0084% in 6.3 days. At that pace, about 0.48% a year. Past trades, not a forecast."
 * Null unless the growth is a positive amount over a positive value and at least one second.
 * The yearly figure is there only when the window is a day or longer and both the measure
 * and the yearly figure are between 0.0001% and 1,000%; otherwise the measure and its time
 * stand alone. The basis and the last sentence are in every string it returns.
 */
export function paceText(p: { growth: bigint; against: bigint; seconds: number; of?: keyof typeof OF }): string | null {
  const measured = percentText(p.growth, p.against);
  if (measured === null || !Number.isFinite(p.seconds) || p.seconds < 1) return null;
  const secs = BigInt(Math.floor(p.seconds));
  const head = `${measured}${p.of ? ` ${OF[p.of]}` : ''} in ${spanText(secs)}.`;
  const num = p.growth * 100n * YEAR;
  const den = p.against * secs;
  const yearly = secs >= DAY && printable(p.growth * 100n, p.against) && printable(num, den);
  return yearly ? `${head} At that pace, about ${twoFigures(num, den)}% a year. ${TAIL}` : `${head} ${TAIL}`;
}
