// Small pure helpers the house bidder's brain and executor share. Amounts are bigint wei inside
// the bot and decimal strings in files; addresses are lowercased; clocks are milliseconds and
// order times are seconds, as Seaport's are.

import { PRICE_TICK_WEI, ONE_ETH } from './constants.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A 0x+40-hex address, lowercased; null for anything else (never a guess). */
export function addr(value) {
  return typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null;
}

/** Same as addr(), but a bad value is an error naming what was being read. */
export function mustAddr(value, what) {
  const a = addr(value);
  if (!a) throw new Error(`${what} is not an address (0x and 40 hex characters)`);
  return a;
}

/**
 * A whole non-negative amount: bigint, safe integer, decimal string or 0x-hex string.
 * Floats and anything with a decimal point are refused: wei never has a fraction.
 */
export function toWei(value, what = 'amount') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${what} is negative`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} is not a whole number of wei`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  throw new Error(`${what} is not a whole number of wei`);
}

/** Round a unit price DOWN to the 10^13 wei tick (BUILD-SPEC 1): never up. */
export function roundDownToTick(wei) {
  if (wei <= 0n) return 0n;
  return (wei / PRICE_TICK_WEI) * PRICE_TICK_WEI;
}

/** `wei` scaled by (bps / 10000), rounded down. */
export function bpsOf(wei, bps) {
  return (wei * BigInt(bps)) / 10_000n;
}

/** ETH as text with up to 6 decimals, for people (never for arithmetic). */
export function eth(wei, decimals = 6) {
  if (wei === null || wei === undefined) return 'n/a';
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / ONE_ETH;
  const frac = (v % ONE_ETH).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parse "0.035" (ETH) into wei exactly; refuses more than 18 decimals and anything not a number. */
export function parseEth(text) {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(text.trim())) {
    throw new Error(`"${text}" is not an amount of ETH such as 0.035`);
  }
  const [whole, frac = ''] = text.trim().split('.');
  return BigInt(whole) * ONE_ETH + BigInt(frac.padEnd(18, '0'));
}

/**
 * A timestamp in seconds, from seconds or milliseconds. The data layer's clocks are
 * milliseconds (`now = Date.now`) while sale and fill times are chain seconds; a value past
 * 10^12 can only be milliseconds (that many seconds is the year 33658).
 */
export function toSec(t) {
  if (typeof t === 'bigint') t = Number(t);
  if (typeof t === 'string') t = /^\d+$/.test(t) ? Number(t) : Date.parse(t) / 1000;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
}

/** JSON.stringify with bigints written as decimal strings (files never hold a bigint). */
export function jsonLine(value) {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** UTC day "YYYY-MM-DD" and month "YYYY-MM" of a millisecond time. */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const utcMonth = (ms) => new Date(ms).toISOString().slice(0, 7);

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  if (s.length % 2) return s[mid];
  return typeof s[0] === 'bigint' ? (s[mid - 1] + s[mid]) / 2n : (s[mid - 1] + s[mid]) / 2;
}
