import { PublicKey } from '@solana/web3.js';
import { isKeeperCoin } from './plan';

/**
 * Trips through two pools that are NOT ours, as the arbitrage scanner (scripts/arb-scanner.mjs)
 * found and test-ran them: buy the token in one outside pool, sell it in another, start and end
 * in SOL or USDC. The scanner does the looking (every pool of every coin it follows, read in one
 * slot); the robot only takes what it proved. Nothing on the scanner's page is trusted past
 * choosing what to ask about: the robot quotes each trip again, holds each leg to its exchange,
 * gates the token, test-runs the whole trip and ends it with the Lighthouse check (keeper/cycle.ts
 * `outsideTrip`).
 */

/** One leg: the pool the scanner priced, and its exchange's program. */
export interface OutsideLeg {
  pool: string;
  program: string;
}

export interface OutsideTake {
  coinMint: string;
  tokenMint: string;
  /** Buy the token in the first pool, sell it in the second. */
  legs: [OutsideLeg, OutsideLeg];
  /** The scanner's size, in the coin's base units: the robot holds it to its own cap and float. */
  inRaw: bigint;
  /** The scanner's estimate after the network fee, USD: the order trips are tried in, nothing more. */
  netUsd: number;
}

/** A trip is taken only this soon after the scanner's test run of it passed (the scanner keeps a pass 3 minutes). */
export const TAKE_FRESH_MS = 3 * 60_000;

export const isAddress = (s: unknown): s is string => {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
};
export const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * KEEPER_SCANNER_URL as a URL, held to the scanner's page on THIS computer: the robot (which trips
 * to try) and the dashboard (what the scanner shows) read nothing from anywhere else.
 */
export function scannerPageUrl(raw: string): URL {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // said below, as any other address
  }
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`KEEPER_SCANNER_URL must be the scanner's page on this computer (http://127.0.0.1:<port>/state.json), not "${raw}"`);
  }
  return url;
}

/** One scanner row as a trip the robot may try, or null. */
function takeOf(row: unknown, programs: Readonly<Record<string, string>>, now: number): OutsideTake | null {
  if (!isObject(row) || !Array.isArray(row.legs) || row.legs.length !== 2) return null;
  const { coin, mint, inRaw, netUsd, proof } = row;
  if (!isAddress(coin) || !isAddress(mint) || !isKeeperCoin(coin) || isKeeperCoin(mint)) return null;
  if (!isObject(proof) || proof.ok !== true || typeof proof.at !== 'number') return null;
  const age = now - proof.at;
  if (!(age >= 0 && age < TAKE_FRESH_MS)) return null;
  if (typeof inRaw !== 'number' || !Number.isFinite(inRaw) || inRaw < 1 || typeof netUsd !== 'number' || !Number.isFinite(netUsd)) return null;
  const legs: OutsideLeg[] = [];
  for (const [i, l] of (row.legs as unknown[]).entries()) {
    if (!isObject(l) || !isAddress(l.pool) || typeof l.dex !== 'string' || !Object.hasOwn(programs, l.dex)) return null;
    // Coin → token, then token → coin: anything else is not a two-pool round trip.
    const [from, to] = i === 0 ? [coin, mint] : [mint, coin];
    if (l.from !== from || l.to !== to) return null;
    legs.push({ pool: l.pool, program: programs[l.dex]! });
  }
  if (legs[0]!.pool === legs[1]!.pool) return null;
  return { coinMint: coin, tokenMint: mint, legs: [legs[0]!, legs[1]!], inRaw: BigInt(Math.floor(inRaw)), netUsd };
}

/**
 * The scanner's page (`/state.json`) read as trips between two outside pools whose test run
 * passed within TAKE_FRESH_MS, best estimate first, each route once. `programs` names each
 * outside exchange the scanner knows by its key (scripts/lib/outside-dexes.mjs); a leg on any
 * other exchange, or in OUR pool (those are the robot's own trips), drops its row.
 */
export function outsideTakes(state: unknown, programs: Readonly<Record<string, string>>, now: number): OutsideTake[] {
  if (!isObject(state)) return [];
  const rows = [state.take, state.watch].flatMap((x) => (Array.isArray(x) ? x : []));
  const seen = new Set<string>();
  const out: OutsideTake[] = [];
  for (const row of rows) {
    const t = takeOf(row, programs, now);
    if (!t) continue;
    const route = `${t.coinMint} ${t.legs[0].pool} ${t.legs[1].pool}`;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push(t);
  }
  return out.sort((a, b) => b.netUsd - a.netUsd);
}
