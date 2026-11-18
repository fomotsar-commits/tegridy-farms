import { describe, it, expect } from 'vitest';
import { BUNGALOWS } from '../bungalows';
import { cityRooms } from '../../hooks/useCityReads';
import { Hr, NC, NR, PD, PW, SLOTS, SX, SY, VILLA_DECK, Vr, buildPlan, levelOf, walkAt, walkLength, type Room } from './plan';

const rooms = cityRooms();
const plan = buildPlan(rooms);
const fake = (id: string): Room => ({ id, name: id.toUpperCase(), symbol: id.toUpperCase(), chain: 'base', address: `0x${id}`, accent: '#8f8f8f' });

describe('the city plan', () => {
  it('gives every live room in the registry a plot: a new room fails here until it has one', () => {
    expect(rooms.length).toBeGreaterThan(0);
    expect(plan.unplaced).toEqual([]);
    for (const b of BUNGALOWS.filter((x) => x.live && x.chain !== 'tbd')) {
      const plot = plan.byId.get(b.id);
      expect(plot, b.id).toBeDefined();
      expect(plot!.kind).toBe('room');
      // the registry's own facts, never retyped: its ticker, its whole address, its door
      expect(plot!.tick).toBe(b.symbol);
      expect(plot!.addr).toBe(b.address);
      expect(plot!.href).toBe(`/${b.id}`);
      expect(plot!.mural).toBe(b.id);
    }
  });

  it('reports a room that has no plot rather than dropping it', () => {
    expect(buildPlan([...rooms, fake('newcoin')]).unplaced).toEqual(['newcoin']);
  });

  it('keeps a plot whose room is not in the registry yet as an open lot, and builds on it when the room arrives', () => {
    const slot = SLOTS.find((s) => 'room' in s && !rooms.some((r) => r.id === s.room));
    if (!slot || !('room' in slot)) return; // every placed room is live: nothing waits
    const waiting = plan.plots.find((p) => p.c === slot.c && p.r === slot.r)!;
    expect(waiting.piece).toBe('ghost');
    expect(waiting.kind).toBe('civic');
    expect(waiting.addr).toBeUndefined();
    expect(waiting.walk).toBeUndefined();
    const built = buildPlan([...rooms, fake(slot.room)]).byId.get(slot.room)!;
    expect(built.piece).toBe(slot.piece);
    expect(built.c).toBe(slot.c);
    expect(built.walk).toBeDefined();
  });

  it('sets out twenty plots, one to a place on the grid, every one the same size', () => {
    expect(plan.plots).toHaveLength(NC * NR);
    expect(new Set(plan.plots.map((p) => `${p.c},${p.r}`)).size).toBe(NC * NR);
    for (const p of plan.plots) {
      expect(p.x0).toBeCloseTo(p.c * SX + (SX - PW));
      expect(p.y0).toBeCloseTo(p.r * SY + (SY - PD));
    }
  });

  it('gives each plot its own piece, and each room its own pool shape and water', () => {
    expect(new Set(SLOTS.map((s) => s.piece)).size).toBe(SLOTS.length);
    const roomSlots = SLOTS.flatMap((s) => ('room' in s ? [s] : []));
    expect(new Set(roomSlots.map((s) => s.shape)).size).toBe(roomSlots.length);
    expect(new Set(roomSlots.map((s) => s.water)).size).toBe(roomSlots.length);
  });

  it('walks every room to the wallet door: along the pavements, square corners only, up the steps at the end', () => {
    const door = plan.wallet.walk!.at(-1)!;
    expect(door[2]).toBe(VILLA_DECK);
    for (const p of plan.plots.filter((x) => x.kind === 'room')) {
      const walk = p.walk!;
      expect(walk.length, p.id).toBeGreaterThan(3);
      // it starts on its own plot
      expect(walk[0]![0]).toBeGreaterThan(p.x0);
      expect(walk[0]![0]).toBeLessThan(p.x0 + PW);
      expect(walk[0]![1]).toBeGreaterThan(p.y0);
      expect(walk[0]![1]).toBeLessThan(p.y0 + PD);
      // and ends at the wallet's door
      expect(walk.at(-1)).toEqual(door);
      for (let i = 0; i < walk.length - 1; i++) {
        const dx = Math.abs(walk[i + 1]![0] - walk[i]![0]);
        const dy = Math.abs(walk[i + 1]![1] - walk[i]![1]);
        expect(Math.min(dx, dy), `${p.id} leg ${i} cuts a corner`).toBeLessThan(1e-9);
      }
    }
  });

  it('paints a crossing wherever a walk goes over a road, and nowhere else', () => {
    const wanted = new Set<string>();
    for (const p of plan.plots) {
      const walk = p.walk;
      if (!walk || p.kind !== 'room') continue;
      for (let i = 0; i < walk.length - 1; i++) {
        const a = walk[i]!;
        const b = walk[i + 1]!;
        if (Math.abs(a[1] - b[1]) < 1e-9) {
          for (let c = 0; c <= NC; c++) if (Vr(c) > Math.min(a[0], b[0]) && Vr(c) < Math.max(a[0], b[0])) wanted.add(`v${c}@${a[1].toFixed(2)}`);
        } else {
          for (let h = 0; h <= NR; h++) if (Hr(h) > Math.min(a[1], b[1]) && Hr(h) < Math.max(a[1], b[1])) wanted.add(`h${h}@${a[0].toFixed(2)}`);
        }
      }
    }
    expect(wanted.size).toBeGreaterThan(0);
    expect(new Set(plan.zebras.map((z) => `${z.kind}${z.i}@${z.at.toFixed(2)}`))).toEqual(wanted);
  });
});

describe('a pool level', () => {
  it('rises with the dollars, never past the brim, and never below the bottom mark', () => {
    let last = 0;
    for (const usd of [1, 1_000, 30_000, 100_000, 380_000, 1_400_000, 5_000_000, 1e9]) {
      const level = levelOf(usd);
      expect(level).toBeGreaterThanOrEqual(last);
      expect(level).toBeGreaterThanOrEqual(0.3);
      expect(level).toBeLessThanOrEqual(0.95);
      last = level;
    }
    expect(levelOf(1_400_000)).toBeGreaterThan(levelOf(100_000));
  });
  it('reads nonsense as the bottom mark, never as a number of its own', () => {
    for (const usd of [0, -5, NaN, Infinity * 0]) expect(levelOf(usd)).toBe(0.3);
  });
});

describe('a walk', () => {
  const walk = [[0, 0], [3, 0], [3, 4, 1]] as const;
  it('is as long as its legs', () => expect(walkLength(walk)).toBe(7));
  it('puts a walker where their distance says, lifting them on a rising leg', () => {
    expect(walkAt(walk, 0)).toEqual([0, 0, 0]);
    expect(walkAt(walk, 1.5)).toEqual([1.5, 0, 0]);
    expect(walkAt(walk, 5)).toEqual([3, 2, 0.5]);
    expect(walkAt(walk, 7)).toEqual([3, 4, 1]);
  });
  it('says a walker who has gone the whole way has arrived', () => expect(walkAt(walk, 7.01)).toBeNull());
});
