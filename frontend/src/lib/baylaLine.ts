import { BAYLA_LINES } from './arrival';
import { printedTier, type HeatReading } from './heat/heatOracle';
import type { ScreenMove } from './screenMove';

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
  /** Where the buttons go, read at render by the component: the Add sheet, the Buy sheet, the launch door, the home's field, the hall. */
  to: { pools: string; buy: string; launch: string; read: string; pick: string; receipt: string };
  /** The move the screen's own green button makes, when it draws one (lib/screenMove.ts). */
  screenMove?: ScreenMove | null;
}

/** What the line's button does: the screen's own green button can do the same (answer twenty-five, §2). */
export type BaylaMove = 'read' | 'start' | 'add' | 'pick' | 'launch' | 'receipt';

export interface BaylaLine {
  text: string;
  button: { label: string; to: string; move: BaylaMove };
  /** The screen's own green button makes this move, so the line's button is drawn quiet: one green button per screen. */
  sameMove: boolean;
}

/** Degrees as the line says them: two decimals, as the card prints them. */
export function degreesText(degrees: number): string {
  return degrees.toFixed(2);
}

function lineFor(i: BaylaInputs): Omit<BaylaLine, 'sameMove'> {
  const L = BAYLA_LINES;
  if (i.landed) return { text: L.done, button: { label: L.buttons.receipt, to: i.to.receipt, move: 'receipt' } };
  const r = i.reading;
  if (!r) return { text: L.noWallet, button: { label: L.buttons.read, to: i.to.read, move: 'read' } };
  if (r.isCold || !(r.degrees > 0)) return { text: L.cold, button: { label: L.buttons.start, to: i.to.buy, move: 'start' } };
  const add = (coin: string) => ({ label: L.buttons.add(coin), to: i.to.pools, move: 'add' as const });
  const pick = { label: L.buttons.pick, to: i.to.pick, move: 'pick' as const };
  const inRoom = i.room !== null && i.room.solanaPool;
  // The launch door's own screen says the door's words (answer twenty-six, §2.7).
  const door = i.screenMove === 'door';
  if (!door && inRoom && i.slow) return { text: L.slow(i.slow.price, i.slow.age), button: add(i.room!.coin) };
  const d = degreesText(r.degrees);
  // Never the word Drifter: under Observer the degrees stand alone (answer twenty-six, §2.8).
  const tier = printedTier(r.tier);
  const atFloor = r.degrees >= i.floor;
  const days = r.daysToPlant;
  const served = days !== null && days >= 1;
  if (door) {
    // Her quiet button makes the screen's own move (answer twenty-six, §2.7): the clock under the
    // floor; at it, the room's Add or a pick on the Add sheet. Never Launch, the page she is on.
    const button = !atFloor
      ? { label: L.buttons.start, to: i.to.buy, move: 'start' as const }
      : inRoom
        ? add(i.room!.coin)
        : { label: L.buttons.pick, to: i.to.pools, move: 'pick' as const };
    return { text: atFloor ? L.open(d, tier) : served ? L.doorDays(d, days) : L.doorWarming(d), button };
  }
  if (atFloor) {
    return { text: L.open(d, tier), button: inRoom ? add(i.room!.coin) : { label: L.buttons.launch, to: i.to.launch, move: 'launch' } };
  }
  if (inRoom) return { text: L.warmInRoom(d, tier), button: add(i.room!.coin) };
  return { text: served ? L.warmDays(d, tier, days) : L.warmPick(d, tier), button: pick };
}

export function baylaLine(i: BaylaInputs): BaylaLine {
  const line = lineFor(i);
  // One green button per screen (answer twenty-five, §2), and the rule is the screen's (answer
  // twenty-eight, §2.2): wherever the screen draws its own green button (the countdown's Start the
  // clock, the sheet, the receipt, the launch door) her button is quiet, whatever move it makes.
  return { ...line, sameMove: (i.screenMove ?? null) !== null };
}

/** The intel line under Bayla's: one fact read, in the past tense; null when it could not be read (never 0). */
export function intelLine(fire: { burned: number } | null): string | null {
  if (!fire || !Number.isFinite(fire.burned) || fire.burned <= 0) return null;
  return BAYLA_LINES.intelFire(Math.round(fire.burned).toLocaleString('en-US'));
}
