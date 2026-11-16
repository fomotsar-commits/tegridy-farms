/**
 * Small helpers shared by the data layer. Two conventions the whole layer keeps, so a caller never
 * has to guess a unit:
 *
 *  - Every market or chain time FIELD (`time`, `startTime`, `endTime`, `createdAt`, an `afterSec`
 *    argument) is unix SECONDS, as Seaport, OpenSea's REST events and block headers give it.
 *  - Every CLOCK reading (`now()` in a factory, `lastMessageAt()`, `retryAfterMs`,
 *    `lastSignatureValidUntil`) is MILLISECONDS, as Date.now() gives it.
 *
 * Where a function takes `now` as a value (buildTape, fairValue) it accepts either: a value above
 * 1e11 is read as milliseconds. 1e11 seconds is the year 5138 and 1e11 ms is March 1973, so the two
 * cannot be confused for any date the bot will run on.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

export const isAddress = (s) => typeof s === 'string' && ADDRESS_RE.test(s);
export const isHash32 = (s) => typeof s === 'string' && HASH32_RE.test(s);
export const isDecimalString = (s) => typeof s === 'string' && DECIMAL_RE.test(s);

/** A lowercased address, or a TypeError naming what was wrong. */
export function lowerAddress(s, what = 'address') {
  if (!isAddress(s)) throw new TypeError(`${what} is not a 0x + 40 hex address`);
  return s.toLowerCase();
}

/** Unix seconds from a clock value in milliseconds or seconds (see the header). */
export function toUnixSec(v) {
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError('a time must be a finite number');
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/** A bigint from a bigint, a decimal string or a safe whole number; anything else is refused. */
export function toBigInt(v, what = 'amount') {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && DECIMAL_RE.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new TypeError(`${what} must be a whole number of wei (bigint or decimal string)`);
}

/**
 * A set of lowercased addresses from whatever shape a wallet list arrives in: an array of strings,
 * an array of `{ address }`, a Set, or insiders.json itself (`{ wallets: [{ address }], contracts: [...] }`).
 * A malformed entry throws: silently skipping one would let that wallet trade with the house.
 */
export function addressSet(list, what = 'wallet list') {
  const out = new Set();
  if (list == null) return out;
  const add = (entry) => {
    const a = typeof entry === 'string' ? entry : entry?.address;
    out.add(lowerAddress(a, `an entry of the ${what}`));
  };
  if (list instanceof Set || Array.isArray(list)) {
    for (const e of list) add(e);
    return out;
  }
  if (typeof list === 'object') {
    for (const e of list.wallets ?? []) add(e);
    for (const e of list.contracts ?? []) add(e);
    return out;
  }
  throw new TypeError(`the ${what} must be an array, a Set or { wallets, contracts }`);
}

/** The middle value of a list of bigints; for an even count, the floor of the mean of the two middles. */
export function medianBig(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2n;
}

export const minBig = (a, b) => (a < b ? a : b);

/**
 * A logger that never throws. `log` may be a function `(level, message, details)`, a console-like
 * object with debug/info/warn/error methods, or nothing. A broken logger must never stop a read.
 */
export function makeLog(log) {
  const emit = (level, message, details) => {
    if (!log) return;
    try {
      if (typeof log === 'function') log(level, message, details);
      else if (typeof log[level] === 'function') log[level](message, details ?? '');
    } catch {
      // swallowed on purpose: logging is best effort
    }
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

/** A promise that settles after `ms`, used where a caller did not inject its own clock. */
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
