import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { isKeeperCoin } from './plan';
import { plainText } from './scannerView';
import { isAddress, isObject, localPageUrl } from './takes';

/**
 * Trips the engine hands the robot (scripts/arb-listen.mjs, its /events stream; owner 2026-11-07:
 * "build it"). The engine watches every pool live and judges each coin's trips the instant an
 * account changes; a trip that pays after every cost comes here as a record: the route in order,
 * each leg's pool, venue, direction and the accounts its exact quote walked, the size and what
 * each leg pays at it, and when the record stops standing. Nothing in a record is trusted past
 * choosing what to do: the robot reads every pool itself, builds every swap with the program's
 * own maths (scripts/lib/arb-legs.mjs, handed in as `KeeperIo.routeLegs`), chains each leg's
 * minimum from its own quotes, gates the token, test-runs the whole trip and ends it with the
 * Lighthouse check, as every trip (keeper/cycle.ts engineTrip, sendChecked).
 *
 * A record stands ENGINE_FRESH_MS from its judgement: the practice the research found in every
 * engine that lands (a stale route is a lost race, not a trade); one past that is answered
 * 'stale' and never built.
 */

/** How long a handover stands, from the engine's judgement (lib/arb-listen.mjs HANDOVER_TTL_MS says the same). */
export const ENGINE_FRESH_MS = 800;

/** The exchanges a leg may be on, by the engine's key for each (scripts/lib/arb-chain.mjs DEXES). */
export const ENGINE_DEXES = ['ours', 'pumpswap', 'ammV4', 'cpmm', 'clmm', 'whirlpool', 'dlmm', 'damm'] as const;
export type EngineDex = (typeof ENGINE_DEXES)[number];

/** The most accounts a leg's quote may have walked (tick or bin arrays, an oracle, a fee config): more is not a swap. */
export const MAX_LEG_ACCOUNTS = 16;

export interface EngineLeg {
  pool: string;
  dex: EngineDex;
  from: string;
  to: string;
  /** The pool's fee as the engine read it, a share; shown, never trusted. */
  fee: number;
  /** A Token-2022 transfer fee's rate on the coin going in and coming out (0: none). */
  inCut: number;
  outCut: number;
  /** The accounts the engine's exact quote read for the pool: the robot reads them too, and more if its walk needs them. */
  accounts: string[];
}

export interface EngineRecord {
  id: string;
  route: string;
  /** When the engine judged it (its clock, this computer's). */
  at: number;
  slot: number;
  expiresAt: number;
  coinMint: string;
  tokenMint: string;
  symbol: string;
  decimals: number;
  legs: EngineLeg[];
  /** The engine's size, in the coin's base units: the robot holds it to its own cap, float and loan. */
  inRaw: bigint;
  /** What each leg pays at that size by the engine's quotes, in order: shown and compared, never used as a minimum. */
  outs: bigint[];
  netUsd: number;
  netAllUsd: number;
  tipUsd: number | null;
  gapPct: number;
  /** Each mint's token program as the engine read it; the robot's own read decides. */
  mints: Record<string, string>;
  /** The prices the engine judged at (mint → USD), for the robot's floor and cap in the coin. */
  usd: Map<string, number>;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const rate = (x: unknown): number | null => {
  const n = x === undefined ? 0 : num(x);
  return n !== null && n >= 0 && n < 1 ? n : null;
};
/** A raw amount as the engine writes it (a decimal string, or a whole number), at least 1. */
const raw = (x: unknown): bigint | null => {
  if (typeof x === 'string' && /^[0-9]{1,30}$/.test(x)) {
    const n = BigInt(x);
    return n >= 1n ? n : null;
  }
  if (typeof x === 'number' && Number.isInteger(x) && x >= 1) return BigInt(x);
  return null;
};

function legOf(l: unknown): EngineLeg | null {
  if (!isObject(l) || !isAddress(l.pool) || !isAddress(l.from) || !isAddress(l.to) || l.from === l.to) return null;
  if (typeof l.dex !== 'string' || !(ENGINE_DEXES as readonly string[]).includes(l.dex)) return null;
  const [fee, inCut, outCut] = [rate(l.fee), rate(l.inCut), rate(l.outCut)];
  if (fee === null || inCut === null || outCut === null) return null;
  const accounts = l.accounts === undefined ? [] : l.accounts;
  if (!Array.isArray(accounts) || accounts.length > MAX_LEG_ACCOUNTS || !accounts.every(isAddress)) return null;
  return { pool: l.pool, dex: l.dex as EngineDex, from: l.from, to: l.to, fee, inCut, outCut, accounts: [...new Set(accounts as string[])] };
}

/**
 * One handover as the robot may act on it, or null when it is not one: a route of two or three
 * legs chaining from one of the robot's coins through the coin's pools back to it, on known
 * exchanges, with a size and each leg's pay at it, judged at a time and slot, standing until a time.
 */
export function engineRecord(row: unknown): EngineRecord | null {
  if (!isObject(row) || !isAddress(row.coin) || !isAddress(row.mint) || !isKeeperCoin(row.coin) || isKeeperCoin(row.mint)) return null;
  const id = plainText(row.id, 240);
  const [at, slot, expiresAt, decimals, netUsd, netAllUsd, gapPct] = [num(row.at), num(row.slot), num(row.expiresAt), num(row.decimals), num(row.netUsd), num(row.netAllUsd), num(row.gapPct)];
  if (!id || at === null || slot === null || expiresAt === null || decimals === null || netUsd === null || netAllUsd === null || gapPct === null) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !(expiresAt > at)) return null;
  if (!Array.isArray(row.legs) || row.legs.length < 2 || row.legs.length > 3) return null;
  const legs: EngineLeg[] = [];
  for (const l of row.legs) {
    const leg = legOf(l);
    if (!leg) return null;
    legs.push(leg);
  }
  // A round trip: from the coin, each leg from where the one before ended, back to the coin, through the token.
  if (legs[0]!.from !== row.coin || legs[legs.length - 1]!.to !== row.coin) return null;
  if (legs.some((l, i) => i > 0 && l.from !== legs[i - 1]!.to)) return null;
  if (!legs.some((l) => l.from === row.mint || l.to === row.mint)) return null;
  if (new Set(legs.map((l) => l.pool)).size !== legs.length) return null;
  const inRaw = raw(row.inRaw);
  if (inRaw === null || !Array.isArray(row.outs) || row.outs.length !== legs.length) return null;
  const outs: bigint[] = [];
  for (const o of row.outs) {
    const x = raw(o);
    if (x === null) return null;
    outs.push(x);
  }
  const mints: Record<string, string> = {};
  if (isObject(row.mints)) for (const [m, p] of Object.entries(row.mints)) if (isAddress(m) && isAddress(p)) mints[m] = p;
  const usd = new Map<string, number>();
  if (isObject(row.usd)) {
    for (const [m, v] of Object.entries(row.usd)) {
      const n = num(v);
      if (isAddress(m) && n !== null && n > 0) usd.set(m, n);
    }
  }
  return {
    id,
    route: legs.map((l) => l.pool).join('>'),
    at,
    slot: Math.floor(slot),
    expiresAt,
    coinMint: row.coin,
    tokenMint: row.mint,
    symbol: plainText(row.symbol, 24) ?? '?',
    decimals,
    legs,
    inRaw,
    outs,
    netUsd,
    netAllUsd,
    tipUsd: num(row.tipUsd),
    gapPct,
    mints,
    usd,
  };
}

/** Whether a handover still stands at `now`: younger than ENGINE_FRESH_MS and not past its own end. */
export function engineStands(rec: Pick<EngineRecord, 'at' | 'expiresAt'>, now: number): boolean {
  return now - rec.at < ENGINE_FRESH_MS && now < rec.expiresAt;
}

/** KEEPER_ENGINE_URL as a URL, held to the engine's page on THIS computer. */
export const enginePageUrl = (raw: string): URL => localPageUrl(raw, 'KEEPER_ENGINE_URL');
/** The engine's event stream and outcome door, beside its page. */
export const engineEventsUrl = (page: URL): URL => new URL('/events', page);
export const engineOutcomeUrl = (page: URL): URL => new URL('/outcome', page);

/**
 * One swap of a route, built by the robot from its own read of the pool (scripts/lib/arb-legs.mjs):
 * what the program pays for an amount in, exactly, and the instruction for an amount in and a
 * minimum out. Null from either: the pool cannot take it (a stopped pool, a walk past the arrays read).
 */
export interface RouteLeg {
  pool: string;
  dex: EngineDex;
  /** The exchange's name, for the log. */
  venue: string;
  from: string;
  to: string;
  /** The coin going in's token program and the coin coming out's, as the robot read the mints. */
  fromProgram: PublicKey;
  toProgram: PublicKey;
  out(amountIn: bigint): bigint | null;
  ix(amountIn: bigint, minOut: bigint): TransactionInstruction | null;
}

/** The legs of a route, as `KeeperIo.routeLegs` answers: built, or why not. */
export type RouteLegs = { legs: RouteLeg[]; slot: number | null } | string;

/** One server-sent event: its name and its data lines joined. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Text from an event stream, cut into events as it arrives (a chunk may end mid-event). */
export class SseParser {
  private rest = '';

  feed(text: string): SseEvent[] {
    this.rest += text.replace(/\r\n/g, '\n');
    const out: SseEvent[] = [];
    for (;;) {
      const end = this.rest.indexOf('\n\n');
      if (end < 0) break;
      const block = this.rest.slice(0, end);
      this.rest = this.rest.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const at = line.indexOf(':');
        const field = at < 0 ? line : line.slice(0, at);
        const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}

/** The little of a fetch answer the stream reader needs. */
export interface StreamAnswer {
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel?(): Promise<void> } } | null;
}

/**
 * Follow the engine's event stream, handing each handover that parses to `onRecord`, until
 * `stopped` says so. A stream that closes or cannot be opened is opened again after `reopenMs`;
 * the first failure in a row is said once.
 */
export async function followEngine(opts: {
  url: URL;
  fetchImpl: (url: URL, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<StreamAnswer>;
  onRecord: (rec: EngineRecord) => void;
  log: (line: string) => void;
  stopped?: () => boolean;
  reopenMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const reopenMs = opts.reopenMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stopped = opts.stopped ?? (() => false);
  let saidDown = false;
  while (!stopped()) {
    try {
      const res = await opts.fetchImpl(opts.url, { headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`the engine's event stream answered ${res.status}`);
      if (saidDown) opts.log('Engine stream open again');
      saidDown = false;
      const reader = res.body.getReader();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          if (ev.event !== 'handover') continue;
          let row: unknown = null;
          try {
            row = JSON.parse(ev.data);
          } catch {
            continue;
          }
          const rec = engineRecord(row);
          if (rec) opts.onRecord(rec);
        }
        if (stopped()) {
          await reader.cancel?.();
          return;
        }
      }
      if (!stopped()) opts.log(`Engine stream closed: opening again in ${reopenMs / 1000} s`);
    } catch (e) {
      if (!saidDown) opts.log(`Engine stream not read (${e instanceof Error ? e.message : String(e)}): opening again every ${reopenMs / 1000} s`);
      saidDown = true;
    }
    if (!stopped()) await sleep(reopenMs);
  }
}

/** What the robot tells the engine it did with a handover (POST /outcome). */
export interface EngineOutcome {
  id: string;
  outcome: string;
  /** How long after the engine's judgement the robot acted, ms. */
  ms: number;
  note?: string;
}
