import { describe, it, expect } from 'vitest';
import { cityRooms } from '../../hooks/useCityReads';
import { createKit } from './kit';
import { buildPlan, type PieceId, type Plot } from './plan';
import { makePieces } from './pieces';

/** One piece of a picture laid on a wall: whose picture, and which part of it. */
interface Laid {
  id: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}
const PICTURE_W = 480;
const PICTURE_H = 360;

/** Draw one plot's building on a canvas that keeps nothing but the pictures laid on it. */
function wear(plot: Plot, loaded = true): Laid[] {
  const laid: Laid[] = [];
  const gradient = { addColorStop() {} };
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(t, name: string) {
      if (name in t) return t[name];
      return (...args: unknown[]) => {
        if (name === 'drawImage') {
          const [img, sx, sy, sw, sh] = args as [{ id: string }, number, number, number, number];
          laid.push({ id: img.id, sx, sy, sw, sh });
        }
        if (name === 'createLinearGradient' || name === 'createRadialGradient') return gradient;
        if (name === 'measureText') return { width: 6 };
        return undefined;
      };
    },
    set(t, name: string, value) {
      t[name] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const pictures = new Map<string, HTMLImageElement>();
  const mural = (id: string): HTMLImageElement | null => {
    if (!loaded) return null;
    if (!pictures.has(id)) pictures.set(id, { id, naturalWidth: PICTURE_W, naturalHeight: PICTURE_H } as unknown as HTMLImageElement);
    return pictures.get(id)!;
  };
  const kit = createKit({ ctx, cam: { x: 600, y: 200, z: 1 }, time: () => 0, mural });
  makePieces(kit, { walletLit: () => true, doorPulse: () => 0, stacks: () => [] })[plot.piece](plot);
  return laid;
}

const plan = buildPlan(cityRooms());
const rooms = plan.plots.filter((p) => p.kind === 'room');
/**
 * The buildings of more than one block, and the round ones: the picture must go round all of
 * them. A storey's two near walls, and a round wall's sixteen strips on its near half.
 */
const WRAPPED: Partial<Record<PieceId, { walls: number; storeys: number }>> = {
  slouch: { walls: 6, storeys: 3 },
  monolith: { walls: 4, storeys: 2 },
  stack: { walls: 6, storeys: 3 },
  lighthouse: { walls: 6 * 16, storeys: 6 },
  gridshell: { walls: 16, storeys: 1 },
};

describe("each room's building wears its own art", () => {
  it('has rooms to dress', () => expect(rooms.length).toBeGreaterThan(5));

  it('wraps every room in its own picture, on every wall it shows, and never in another room’s', () => {
    for (const p of rooms) {
      const laid = wear(p);
      expect(laid.length, `${p.id} (${p.piece})`).toBeGreaterThanOrEqual(WRAPPED[p.piece]?.walls ?? 2);
      expect(new Set(laid.map((l) => l.id)), p.id).toEqual(new Set([p.id]));
    }
  });

  it('shows each storey its own part of the one picture, the top of it on top, never the same part again', () => {
    for (const p of rooms) {
      const want = WRAPPED[p.piece];
      if (!want || want.storeys < 2) continue;
      const laid = wear(p);
      const heights = [...new Set(laid.map((l) => Math.round(l.sy * 1000) / 1000))];
      expect(heights.length, `${p.id}: parts of the picture by height`).toBeGreaterThanOrEqual(want.storeys);
      // drawn bottom storey first: the last storey drawn shows a higher part of the picture
      expect(laid.at(-1)!.sy, p.id).toBeLessThan(laid[0]!.sy);
    }
  });

  it('takes every part from inside the picture: nothing is stretched past its edges', () => {
    for (const p of rooms) {
      for (const l of wear(p)) {
        expect(l.sx, `${p.id} left`).toBeGreaterThanOrEqual(-1e-6);
        expect(l.sy, `${p.id} top`).toBeGreaterThanOrEqual(-1e-6);
        expect(l.sx + l.sw, `${p.id} right`).toBeLessThanOrEqual(PICTURE_W + 1e-6);
        expect(l.sy + l.sh, `${p.id} bottom`).toBeLessThanOrEqual(PICTURE_H + 1e-6);
        expect(l.sw, p.id).toBeGreaterThan(0);
        expect(l.sh, p.id).toBeGreaterThan(0);
      }
    }
  });

  it('draws a building plain, and whole, while its picture has not loaded', () => {
    for (const p of rooms) expect(wear(p, false), p.id).toEqual([]);
  });

  it("dresses no civic building in any room's picture", () => {
    for (const p of plan.plots.filter((x) => x.kind === 'civic')) expect(wear(p), p.id).toEqual([]);
  });
});
