import { BAYLA_LINES } from './arrival';
import type { HeatReading } from './heat/heatOracle';

/**
 * Bayla's line at the door (island answer twenty-four, build 4): one sentence in her
 * voice at the top of every venue screen, reading the state and saying the one next move
 * with its one number, and the button beside it that does the move. A pure function of
 * the state, so the table test covers every line. The words are the island's (arrival.ts
 * BAYLA_LINES) and are not reworded here.
 */
export interface BaylaInputs {
  /** The wallet read last: connected, pasted or shared. Null when nothing has been read. */
  reading: HeatReading | null;
  /** The room entered last, with its coin's ticker and whether it has a Solana pool here. */
  room: { coin: string; solanaPool: boolean } | null;
  /** The launch floor in degrees (heatLaunchFloor). */
  floor: number;
  /** A swap or an add that landed in the last minute (lib/landed.ts). */
  landed: 'trade' | 'add' | null;
  /** The room pool's own price and the age of its outside price, when the shared list is behind (readers in BaylaLine.tsx). */
  slow: { price: string; age: string } | null;
  /** Where the buttons go, read at render by the component: the room's pool, the Buy form, the launch door, the home's field, the hall. */
  to: { pools: string; buy: string; launch: string; read: string; pick: string; receipt: string };
}

export interface BaylaLine {
  text: string;
  button: { label: string; to: string };
}

/** Degrees as the line says them: two decimals, as the card prints them. */
export function degreesText(degrees: number): string {
  return degrees.toFixed(2);
}

export function baylaLine(i: BaylaInputs): BaylaLine {
  const L = BAYLA_LINES;
  if (i.landed) return { text: L.done, button: { label: L.buttons.receipt, to: i.to.receipt } };
  const r = i.reading;
  if (!r) return { text: L.noWallet, button: { label: L.buttons.read, to: i.to.read } };
  if (r.isCold || !(r.degrees > 0)) return { text: L.cold, button: { label: L.buttons.start, to: i.to.buy } };
  const add = (coin: string) => ({ label: L.buttons.add(coin), to: i.to.pools });
  const inRoom = i.room !== null && i.room.solanaPool;
  if (inRoom && i.slow) return { text: L.slow(i.slow.price, i.slow.age), button: add(i.room!.coin) };
  const d = degreesText(r.degrees);
  if (r.degrees >= i.floor) {
    return { text: L.open(d, r.tier), button: inRoom ? add(i.room!.coin) : { label: L.buttons.launch, to: i.to.launch } };
  }
  if (inRoom) return { text: L.warmInRoom(d, r.tier), button: add(i.room!.coin) };
  const days = r.daysToPlant;
  const text = days !== null && days >= 1 ? L.warmDays(d, r.tier, days) : L.warmPick(d, r.tier);
  return { text, button: { label: L.buttons.pick, to: i.to.pick } };
}

/** The intel line under Bayla's: one fact read, in the past tense; null when it could not be read (never 0). */
export function intelLine(fire: { burned: number } | null): string | null {
  if (!fire || !Number.isFinite(fire.burned) || fire.burned <= 0) return null;
  return BAYLA_LINES.intelFire(Math.round(fire.burned).toLocaleString('en-US'));
}
