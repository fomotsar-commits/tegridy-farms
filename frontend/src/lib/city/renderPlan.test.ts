import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNGALOWS } from '../bungalows';
import { doorArt } from '../doorArt';
import { cityRooms } from '../../hooks/useCityReads';
import { ZP } from './kit';
import {
  FD, FW, FX, FY, HILLS, ISLAND_CX, ISLAND_CY, ISLAND_REACH, JUNCTION_R, KERB, NC, NR, PAVE_W, PD, PIER_X, PIER_Y0, PIER_Y1, PW, ROAD_HALF, RW, SX, SY, VILLA_DECK,
  buildPlan, coast, plotCorners,
} from './plan';
import { RENDER, RENDER_CENTER, RENDER_K, RENDER_SPAN } from './render';

// The island Blender renders is set out from THIS plan (scripts/city-render/island.py reads the
// file below). If the two ever disagree, the render's buildings stand somewhere the page's
// plaques, people and presses are not. To write the file again after changing the plan:
//   CITY_PLAN_WRITE=1 npx vitest run src/lib/city/renderPlan.test.ts
// then render again (scripts/city-render/README.md).
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'scripts', 'city-render', 'plan.json');

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
/** A point as written to the file: a walk point's height is there only when the walk climbs. */
const pt = (p: readonly (number | undefined)[]): number[] => p.flatMap((n) => (n === undefined ? [] : [r4(n)]));

function renderPlan() {
  const plan = buildPlan(cityRooms());
  const art: Record<string, string> = {};
  for (const b of BUNGALOWS) {
    const src = doorArt(b)?.src;
    if (src && plan.byId.get(b.id)?.kind === 'room') art[b.id] = src;
  }
  return {
    note: 'Written by frontend/src/lib/city/renderPlan.test.ts from lib/city/plan.ts. Do not edit by hand.',
    grid: {
      PW, PD, RW, SX, SY, NC, NR, FX, FY, FW, FD, ZP, VILLA_DECK, ROAD_HALF, PAVE_W, KERB, JUNCTION_R, PIER_X, PIER_Y0, PIER_Y1,
      ISLAND_CX: r4(ISLAND_CX), ISLAND_CY: r4(ISLAND_CY), ISLAND_REACH,
    },
    render: { center: pt(RENDER_CENTER), span: [...RENDER_SPAN], k: RENDER_K, width: RENDER.full.width, height: RENDER.full.height },
    // a plot's own parts are in its frame (where its builder makes it); `site` sets it down on the island
    plots: plan.plots.map((p) => ({
      id: p.id, kind: p.kind, civic: p.civic ?? null, piece: p.piece, name: p.name, tick: p.tick, acc: p.acc, c: p.c, r: p.r,
      x0: r4(p.x0), y0: r4(p.y0), X: r4(p.X), Y: r4(p.Y), cx: r4(p.fx), cy: r4(p.fy), mural: p.mural ?? null,
      site: { x: r4(p.site.x), y: r4(p.site.y), rot: r4(p.site.rot) },
      pool: p.pool ? { pts: p.pool.pts.map(pt), cx: r4(p.pool.cx), cy: r4(p.pool.cy), rw: r4(p.pool.rw), rd: r4(p.pool.rd), water: p.pool.water, lanes: p.pool.lanes, jet: p.pool.jet, lilies: p.pool.lilies } : null,
      garden: p.garden ? p.garden.map(pt) : null,
    })),
    // a plot's palms in its frame; the street's and the shore's on the island
    palms: plan.palms.map((t) => ({ x: r4(t.x), y: r4(t.y), h: r4(t.h), lean: r4(t.lean), r: r4(t.r), ph: r4(t.ph), plot: t.plot?.id ?? null })),
    // each plot's own lamps, in its frame
    lamps: plan.lamps.map((l) => pt([l.x, l.y])),
    streetLamps: plan.streetLamps.map(pt),
    roads: plan.roads.map((r) => ({ id: r.id, pts: r.pts.map(pt), dead: r.dead })),
    junctions: plan.junctions.map(pt),
    zebras: plan.zebras.map((z) => ({ road: z.road, x: r4(z.x), y: r4(z.y), a: r4(z.a) })),
    coast: Object.fromEntries([1, 0.95, 1.03, 1.12, 1.26].map((s) => [String(s), coast(s).map(pt)])),
    hills: HILLS.map((h) => ({ ...h })),
    art,
  };
}

describe('the island Blender renders', () => {
  it('is set out from the site’s own plan: buildings, pools, palms and roads stand where the page puts them', () => {
    const want = renderPlan();
    if (process.env.CITY_PLAN_WRITE === '1') writeFileSync(FILE, `${JSON.stringify(want, null, 1)}\n`);
    expect(existsSync(FILE), FILE).toBe(true);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(want);
  });

  it('frames the whole island, with every room’s picture known', () => {
    const want = renderPlan();
    expect(Object.keys(want.art).sort()).toEqual(want.plots.filter((p) => p.kind === 'room').map((p) => p.id).sort());
    for (const src of Object.values(want.art)) expect(src).toMatch(/^\/art\/.+\.(jpe?g|png|webp)$/i);
    // every plot inside the frame where it stands, with room above it for its roof
    const plan = buildPlan(cityRooms());
    const [cx, cy, cz] = RENDER_CENTER;
    for (const p of plan.plots) {
      for (const [x, y] of plotCorners(p)) {
        const sx = (x - y - (cx - cy)) * Math.sqrt(3) / 2;
        const sy = (x + y - (cx + cy)) / 2 + cz;
        expect(Math.abs(sx), `${p.id} across`).toBeLessThan(RENDER_SPAN[0] / 2);
        expect(Math.abs(sy - 4), `${p.id} up and down`).toBeLessThan(RENDER_SPAN[1] / 2);
      }
    }
  });
});
