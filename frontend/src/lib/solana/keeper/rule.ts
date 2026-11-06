import { EXTENSION, FREEZE_AUTHORITY_ACCEPTED, type TokenSafety } from '../lp/tokenSafety';

/**
 * The ONE "would the robot take this trip" rule. The price robot (scripts/price-keeper.mjs, through
 * keeper/plan.ts and keeper/cycle.ts) and the arbitrage scanner (scripts/arb-scanner.mjs) both
 * import it, so what the scanner lists as "the robot would take this" is decided by the very lines
 * the robot runs (owner, 2026-11-05: "our bot should take them as long as it can exit safely with
 * profit after fees and slippage").
 *
 * A trip starts and ends in one coin (SOL or USDC), in ONE transaction:
 *   - SIZE: where it makes the most money, which is where the gap between the pools closes; less
 *     when the robot's float or its cap is smaller. The scanner shows both, so a gap bigger than
 *     the robot can take is plain to see.
 *   - FLOOR: it must end with at least what it spent plus the network fee plus $0.01. The last
 *     leg's minimum out is set to that, and a Lighthouse check at the end of the transaction
 *     (keeper/lighthouse.ts) holds the robot's coin account to it, so a trip that would lose
 *     undoes itself and costs only its network fee.
 *   - CAP: the owner's setting (KEEPER_MAX_TRADE_USD), but never past $25 until the Lighthouse
 *     check has been proven on mainnet to undo a trip that misses its floor.
 *   - COINS: never a token that can take coins back or stop them (`tokenGate`).
 *   - BANS: a pool whose sent trips the chain refused twice in a day is left alone for a day.
 */

/** The cap until the Lighthouse check is proven (owner, 2026-11-05). */
export const SAFE_CAP_USD = 25;

/** Solana's fee for one signature, in lamports. */
export const BASE_FEE_LAMPORTS = 5_000;

/**
 * The most compute a trip's test run may use. The floor counts the network fee at this, the most
 * a trip can cost, so a cheaper trip only clears it by more.
 */
export const MAX_TRIP_UNITS = 1_400_000;

export interface RuleSettings {
  /** The owner's cap a trip, in USD (KEEPER_MAX_TRADE_USD). */
  maxTradeUsd: number;
  /** The least a trip must make after its network fee, in USD (KEEPER_MIN_PROFIT_USD). */
  minProfitUsd: number;
  /** Priority fee, micro-lamports per compute unit (KEEPER_PRIORITY_MICROLAMPORTS). */
  microLamports: number;
  /** True only once the Lighthouse check was proven this run to undo a trip under its floor. */
  lighthouseProven: boolean;
}

/** The rule's settings from the same environment the robot reads, so the scanner's caps are the robot's. */
export function ruleSettingsFromEnv(env: Record<string, string | undefined>, lighthouseProven: boolean): RuleSettings {
  const num = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, not "${raw}"`);
    return n;
  };
  return {
    maxTradeUsd: num('KEEPER_MAX_TRADE_USD', SAFE_CAP_USD),
    minProfitUsd: num('KEEPER_MIN_PROFIT_USD', 0.01),
    microLamports: num('KEEPER_PRIORITY_MICROLAMPORTS', 10_000),
    lighthouseProven,
  };
}

/** The cap a trip really gets: the owner's setting, held to $25 until Lighthouse is proven. */
export function capUsd(s: Pick<RuleSettings, 'maxTradeUsd' | 'lighthouseProven'>): number {
  return s.lighthouseProven ? s.maxTradeUsd : Math.min(s.maxTradeUsd, SAFE_CAP_USD);
}

/**
 * The rule as the running robot publishes it on its gap screen (`/state.json`, KEEPER_SCREEN_PORT):
 * its settings as read at its start, whether the Lighthouse check was proven, and whether it
 * borrows SOL past its float inside a trip (KEEPER_FLASH_LOANS, keeper/flashLoan.ts). The scanner
 * reads it back (`robotRule`), so it judges and sizes trips with the robot's own numbers, however
 * the scanner itself was started. The robot sizes a trip through two outside pools by the
 * scanner's size, so a scanner on other numbers holds those trips to ITS cap.
 */
export interface PublishedRule extends RuleSettings {
  flashLoans: boolean;
}

/** The rule's fields only, for the robot's page: none of its other settings. */
export function publishedRule(s: PublishedRule): PublishedRule {
  return { maxTradeUsd: s.maxTradeUsd, minProfitUsd: s.minProfitUsd, microLamports: s.microLamports, lighthouseProven: s.lighthouseProven, flashLoans: s.flashLoans };
}

/** The rule block of the robot's page, read back; why not, when it is missing or not what the robot writes. */
export function robotRule(page: unknown): PublishedRule | string {
  const block: unknown = page !== null && typeof page === 'object' ? (page as { rule?: unknown }).rule : undefined;
  if (block === null || typeof block !== 'object') return 'the robot’s page does not give its settings (a robot started on an older build does not)';
  const o = block as Record<string, unknown>;
  const positive = (k: string): number | null => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  };
  const maxTradeUsd = positive('maxTradeUsd');
  const minProfitUsd = positive('minProfitUsd');
  const microLamports = positive('microLamports');
  if (maxTradeUsd === null || minProfitUsd === null || microLamports === null) return 'the robot’s page gives a cap, floor or fee that is not a positive number';
  const { lighthouseProven, flashLoans } = o;
  if (typeof lighthouseProven !== 'boolean' || typeof flashLoans !== 'boolean') return 'the robot’s page does not say yes or no to the Lighthouse check and to loans';
  return { maxTradeUsd, minProfitUsd, microLamports, lighthouseProven, flashLoans };
}

/** A trip's network fee in lamports at `units` of compute: the signature fee plus the priority fee. */
export function tripFeeLamports(microLamports: number, units = MAX_TRIP_UNITS): number {
  return BASE_FEE_LAMPORTS + Math.ceil((units * microLamports) / 1e6);
}

export interface CoinBounds {
  /** USD a base unit of the coin. */
  unit: number;
  /** The most coin a trip may put in, in base units. */
  cap: bigint;
  capUsd: number;
  /** The least coin a trip must gain, in base units: the network fee plus the minimum profit. */
  floor: bigint;
  floorUsd: number;
  feeUsd: number;
}

/**
 * A coin's cap and floor for one trip, in its base units; a reason when there is no price.
 * `coinUsd` and `solUsd` are USD prices (SOL's pays the network fee).
 */
export function coinBounds(coin: { decimals: number }, coinUsd: number | undefined, solUsd: number | undefined, s: RuleSettings): CoinBounds | string {
  if (coinUsd === undefined || !(coinUsd > 0)) return 'no price for the coin';
  if (solUsd === undefined || !(solUsd > 0)) return 'no SOL price to count the network fee';
  const unit = coinUsd / 10 ** coin.decimals;
  const feeUsd = (tripFeeLamports(s.microLamports) / 1e9) * solUsd;
  // Each part rounded up to a whole base unit; a millionth of one is float noise, not money.
  const up = (usd: number) => BigInt(Math.ceil(usd / unit - 1e-6));
  const floor = up(s.minProfitUsd) + up(feeUsd);
  const cap = capUsd(s);
  return { unit, cap: BigInt(Math.floor(cap / unit)), capUsd: cap, floor, floorUsd: Number(floor) * unit, feeUsd };
}

/** One swap on x·y = k: what goes in (`rin` deep), what comes out (`rout` deep), and the fee kept from what goes in. */
export interface CpLeg {
  rin: number;
  rout: number;
  fee: number;
}

export const swapOut = (l: CpLeg, x: number): number => {
  const xin = x * (1 - l.fee);
  return (l.rout * xin) / (l.rin + xin);
};

/** What `x` of the start coin comes back as after every leg. */
export const runLegs = (legs: readonly CpLeg[], x: number): number => legs.reduce((amt, l) => swapOut(l, amt), x);

/**
 * The size (start coin, base units, at most `most`) where `gain` is largest. On x·y = k legs the
 * gain rises, peaks where the gap closes, and falls, so narrowing the range finds the peak.
 */
export function peakOf(gain: (x: number) => number, most: number): { x: number; gain: number } {
  let lo = 0;
  let hi = Math.max(0, most);
  for (let i = 0; i < 200 && hi - lo > 1e-9 * Math.max(1, hi); i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (gain(m1) < gain(m2)) lo = m1;
    else hi = m2;
  }
  const x = (lo + hi) / 2;
  return { x, gain: gain(x) };
}

export type SizedBy = 'gap' | 'float' | 'cap';

export interface Judged {
  /** The size where the gap closes, ignoring float and cap, and what it would make after the network fee. */
  gapInUsd: number;
  gapNetUsd: number;
  /** The robot's trip: in, gain before and after the network fee, and the floor it must clear. */
  inRaw: number;
  inUsd: number;
  gainUsd: number;
  feeUsd: number;
  floorUsd: number;
  netUsd: number;
  /** Profit after the network fee ÷ money put in, in percent. */
  roiPct: number;
  /** What held the size down: the gap itself, the robot's float, or the cap. */
  sizedBy: SizedBy;
  capUsd: number;
  /** What the robot holds of the start coin, in USD; null when not read. */
  floatUsd: number | null;
  /** The robot takes it: at its size it clears the floor. */
  takes: boolean;
  /** Why not, when it does not. */
  why: string | null;
}

/**
 * The robot's trip through `legs` (each x·y = k near its price, read in one slot), or why there
 * is none. `holdsRaw` is what the robot holds of the start coin (null: not read, sized by the cap).
 */
export function judgeTrip(
  legs: readonly CpLeg[],
  ctx: { decimals: number; coinUsd: number | undefined; solUsd: number | undefined; holdsRaw: number | null; settings: RuleSettings },
): Judged | string {
  if (legs.length < 2) return 'a trip needs two swaps';
  if (legs.some((l) => !(l.rin > 0 && l.rout > 0 && l.fee >= 0 && l.fee < 1))) return 'a pool has no depth or no fee read';
  const b = coinBounds({ decimals: ctx.decimals }, ctx.coinUsd, ctx.solUsd, ctx.settings);
  if (typeof b === 'string') return b;
  const gain = (x: number) => runLegs(legs, x) - x;
  // The gap closes long before the whole first pool goes in.
  const open = peakOf(gain, legs[0]!.rin * 4);
  const capRaw = Number(b.cap);
  const most = Math.min(capRaw, ctx.holdsRaw ?? Infinity);
  const sizedBy: SizedBy = open.x <= most ? 'gap' : ctx.holdsRaw !== null && ctx.holdsRaw < capRaw ? 'float' : 'cap';
  const trip = sizedBy === 'gap' ? open : peakOf(gain, most);
  const inRaw = Math.floor(trip.x);
  const gainUsd = gain(inRaw) * b.unit;
  const netUsd = gainUsd - b.feeUsd;
  const inUsd = inRaw * b.unit;
  const takes = inRaw > 0 && gainUsd >= b.floorUsd;
  return {
    gapInUsd: open.x * b.unit,
    gapNetUsd: open.gain * b.unit - b.feeUsd,
    inRaw,
    inUsd,
    gainUsd,
    feeUsd: b.feeUsd,
    floorUsd: b.floorUsd,
    netUsd,
    roiPct: inUsd > 0 ? (netUsd / inUsd) * 100 : 0,
    sizedBy,
    capUsd: b.capUsd,
    floatUsd: ctx.holdsRaw === null ? null : ctx.holdsRaw * b.unit,
    takes,
    why: takes ? null : inRaw <= 0 ? (ctx.holdsRaw === 0 ? 'the robot holds none of the coin' : 'no size pays') : `makes $${gainUsd.toFixed(4)} at its best size, under the floor $${b.floorUsd.toFixed(4)}`,
  };
}

/** Best first: by profit after the network fee (the robot's order: its float comes back after every trip), or by ROI. */
export function rankTrips<T extends { judged: Judged }>(trips: readonly T[], by: 'profit' | 'roi'): T[] {
  const key = (t: T) => (by === 'roi' ? t.judged.roiPct : t.judged.netUsd);
  return [...trips].sort((p, q) => Number(q.judged.takes) - Number(p.judged.takes) || key(q) - key(p));
}

/**
 * Token-2022 extensions the robot never trades through: each can take coins back, stop them, or
 * run code on a transfer. A transfer fee is not among them: it is a known cut, fixed for two
 * epochs once set, that the robot counts (keeper/plan.ts `poolProblem`), and the Lighthouse check
 * undoes any trip it leaves under the floor (owner, 2026-11-06: GROYPER's 3% fee, "take this").
 */
const REFUSED_EXTENSIONS: ReadonlyMap<number, string> = new Map([
  [EXTENSION.DefaultAccountState, 'new accounts of it can start frozen'],
  [EXTENSION.NonTransferable, 'it cannot be transferred'],
  [EXTENSION.PermanentDelegate, 'a permanent delegate can take it from any account'],
  [EXTENSION.TransferHook, 'a transfer hook runs on every transfer'],
  [EXTENSION.PausableConfig, 'a pause switch can stop every transfer'],
]);

/**
 * The token gate: why the robot must not trade a token, or null when it may. It refuses a token
 * it could not read, a live freeze authority (USDC and USDT keep one by design), and any
 * extension in REFUSED_EXTENSIONS.
 */
export function tokenGate(safety: TokenSafety | undefined): string | null {
  if (!safety || safety.kind === 'unread') return 'its mint was not read';
  if (safety.kind === 'absent') return 'no such token';
  const f = safety.facts;
  if (!f || !f.isInitialized) return 'not a token mint';
  if (f.freezeAuthority && !FREEZE_AUTHORITY_ACCEPTED.has(safety.mint)) return 'a live freeze authority can freeze any account of it';
  for (const t of f.extensions) {
    const why = REFUSED_EXTENSIONS.get(t);
    if (why) return why;
  }
  return null;
}

/** Two sent trips the chain refused, within this long, leave a pool alone for this long. */
export const BAN_AFTER_REVERTS = 2;
export const BAN_MS = 24 * 60 * 60_000;

/**
 * Pools banned after their sent trips were refused: two refusals within a day ban the pool (and
 * any trip naming it) for a day. Times are this computer's clock: only differences are used.
 */
export class TripBans {
  private readonly reverts = new Map<string, number[]>();
  private readonly until = new Map<string, number>();

  /** A sent trip through `pools` the chain refused, at `at` (ms). The second within a day bans the pool for a day from then. */
  reverted(pools: readonly string[], at: number): void {
    for (const p of pools) {
      const recent = [...(this.reverts.get(p) ?? []).filter((t) => at - t < BAN_MS), at];
      this.reverts.set(p, recent);
      if (recent.length >= BAN_AFTER_REVERTS) this.until.set(p, Math.max(this.until.get(p) ?? 0, at + BAN_MS));
    }
  }

  /** Why a trip through `pools` is banned at `now`, or null. */
  banned(pools: readonly string[], now: number): string | null {
    for (const p of pools) {
      const until = this.until.get(p);
      if (until !== undefined && now < until) {
        return `pool ${p} had ${BAN_AFTER_REVERTS} trips refused by the chain within a day: left alone for ${Math.ceil((until - now) / 3_600_000)} h more`;
      }
    }
    return null;
  }
}
