// The city's twenty buildings. A city's streets, an island's materials (thatch, bamboo, tin,
// timber, shell), and each plot ONE idea: a saddle of thatch, a bamboo gridshell, a lattice
// hourglass. Never a generic hut, never a city tower (owner, 2026-11-18).
//
// Every room's building is wrapped in that room's own picture, the one its house wears on Earn:
// every block, every storey and every round wall shows its own part of the one picture, so it
// reads as one building wearing its art (owner, 2026-11-18). It also carries the lock ladder.
// Each piece sets `plot.top`, its roof, so the scene knows
// where to hang its plaque. Nothing here reads anything: what moves is ornament (a lamp's sweep,
// a roof on its ropes), and anything that would state a figure waits for lib/city/scene.ts.

import type { P3, Pt } from '../iso';
import {
  AQUA, BAMBOO, BG, BRASS, GLASS, GLOW, HOT, INK, RED, SLATE, SLATE_E, SPOT, STONE, STONE_D, STONE_L, TAU, THATCH, THATCHED, TIN, VIOLET, WOOD, WOOD_D, WOOD_L, ZP,
  alpha, bil, hash, ink, mix, shellOf, type Kit, type MuralWrap,
} from './kit';
import { PD, PW, VILLA_DECK, type PieceId, type Plot } from './plan';

export interface PieceEnv {
  /** A wallet is connected: the villa's lamps are lit. */
  walletLit: () => boolean;
  /** 0 to 1: how lately something walked in at the wallet's door. */
  doorPulse: () => number;
  /** The crates in the wallet's yard: one stack per coin that is paying, as tall as what has walked in. */
  stacks: () => readonly { col: string; n: number }[];
}

export function makePieces(kit: Kit, env: PieceEnv): Record<PieceId, (b: Plot) => void> {
  const {
    ctx, cam, time, K, LW, P, P3of, lerp, path, face, seg, dot, glow, beams,
    fp, fq, quad, outline, box, stoneBox, hutBox, rbox, wrapDrum, win, shut, panes, door, ladder, hip, butterfly,
    cyl, drum, ellipseG, tiltCone, post, deck, stilts, rail, steps, torch, flag, palm,
    hypar, umbrella, sweepX, gridDome, hyperboloid, helixOn, petal,
  } = kit;
  const lit = (seed: number, p = 0.7): boolean => hash(seed, 5, 2) < p;
  /** One picture round a room's whole building, from `z0` to `z1` and `run` round its widest storey. */
  const wrapOf = (b: Plot, z0: number, z1: number, run: number): MuralWrap | undefined => (b.mural ? { id: b.mural, z0, z1, run } : undefined);
  const water = (b: Plot): string => b.pool?.water ?? AQUA;

  /** The keeper's white van, parked. */
  function van(x: number, y: number): void {
    const w = 1.35;
    const d = 0.62;
    const c = '#eef2f5';
    path([P(x - w / 2 + 0.06, y - d / 2 + 0.06, 0.02), P(x + w / 2 + 0.06, y - d / 2 + 0.06, 0.02), P(x + w / 2 + 0.06, y + d / 2 + 0.06, 0.02), P(x - w / 2 + 0.06, y + d / 2 + 0.06, 0.02)]);
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fill();
    const f = box(x - w / 2, y - d / 2, w, d, 0.66, 0.06, { l: mix(BG, c, 0.62), r: mix(BG, c, 0.4), t: mix(BG, c, 0.78) }, 0.5);
    quad(f.L, 0.12, 0.38, 0.88, 0.56, AQUA, 0.3);
  }

  return {
    /* TOWELI. The Saddle: one thatched roof, twisted. Two corners ride high on masts, two come down to shoulder height. */
    wing(b) {
      const { X, Y, acc } = b;
      const l1: P3 = [X - 0.35, Y - 0.1, ZP + 1.3];
      const h1: P3 = [X + 3.45, Y - 0.1, ZP + 2.9];
      const l2: P3 = [X + 3.45, Y + 2.95, ZP + 1.66];
      const h2: P3 = [X - 0.35, Y + 2.95, ZP + 2.9];
      post(h1[0] - 0.1, h1[1] + 0.1, ZP, h1[2], 0.07);
      const f = hutBox(X + 0.4, Y + 0.55, 2.3, 1.75, 1.15, ZP, acc, b.mural);
      door(f.L, 0.42, 0.58, 0.72);
      win(f.R, 0.34, 0.3, 0.66, 0.74);
      ladder(X + 0.52, Y + 2.32, 1.02);
      hypar([l1, h1, l2, h2], 8, THATCHED);
      post(h2[0] + 0.1, h2[1] - 0.1, ZP, h2[2] - 0.05, 0.07);
      seg(P3of(l2), P(l2[0] + 0.3, l2[1] + 0.35, ZP), ink(0.55), 1);
      seg(P3of(h2), P(h2[0] - 0.55, h2[1] + 0.5, ZP), ink(0.4), 1);
      seg(P3of(h1), P(h1[0] + 0.5, h1[1] - 0.5, ZP), ink(0.4), 1);
      b.top = ZP + 3.1;
    },

    /* PEPE. The Lily Pads: giant leaves on single stems, each with its one slit, over a mural screen wall. */
    pads(b) {
      const { X, Y, acc } = b;
      const w = water(b);
      const k = K();
      const pad = (px: number, py: number, r: number, z: number, rot: number): void => {
        const c = P(px, py, z);
        const top = P(px, py, z + 0.07);
        const rx = r * 1.2247 * k;
        const ry = r * 0.7071 * k;
        glow(P(px, py, ZP), r * 1.5, w, 0.2);
        face([P(px - 0.06, py, ZP), P(px + 0.06, py, ZP), [c[0] + rx * 0.32, c[1]], [c[0] - rx * 0.32, c[1]]], mix(BG, acc, 0.42), 0.4);
        cyl(px, py, r, z, 0.07, mix(BG, w, 0.6), mix(BG, w, 0.25), { noTop: true, edge: 0.4 });
        const g = ctx.createLinearGradient(top[0] - rx, 0, top[0] + rx, 0);
        g.addColorStop(0, mix(BG, acc, 0.66));
        g.addColorStop(1, mix(BG, acc, 0.36));
        ctx.beginPath();
        ctx.ellipse(top[0], top[1], rx, ry, 0, rot + 0.2, rot + TAU - 0.2);
        ctx.lineTo(top[0], top[1]);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = alpha(w, 0.85);
        ctx.lineWidth = LW() * 1.3;
        ctx.stroke();
        if (cam.z > 0.5) {
          for (let i = 1; i < 9; i++) {
            const an = rot + 0.2 + ((TAU - 0.4) * i) / 9;
            seg(top, [top[0] + Math.cos(an) * rx, top[1] + Math.sin(an) * ry], ink(0.16), 1);
          }
        }
      };
      pad(X + 0.85, Y + 0.6, 0.8, ZP + 2.35, 0.9);
      pad(X + 1.4, Y + 1.6, 0.7, ZP + 1.75, 4.0);
      pad(X + 2.35, Y + 0.95, 1.08, ZP + 3.1, 2.4);
      pad(X + 2.95, Y + 1.95, 0.52, ZP + 1.3, 5.2);
      const f = hutBox(X + 0.05, Y + 2.4, 2.6, 0.24, 1.2, ZP, acc, b.mural, { split: 0.92, t: STONE_L });
      door(f.L, 0.4, 0.6, 0.74);
      ladder(X + 0.16, Y + 2.66, 1.05);
      b.top = ZP + 3.3;
    },

    /* NFT loans. The Blade: the gallery wall from the loans sheet, under one roof drawn out to a point and tied back to a mast. */
    blade(b) {
      const { X, Y } = b;
      const k = K();
      for (const [bx, tx] of [[0.5, 0.95], [2.8, 2.35]] as const) seg(P(X + bx, Y + 1.0, ZP), P(X + tx, Y + 2.2, ZP + 2.55), STONE_L, Math.max(1.2, 0.07 * k));
      const w = box(X - 0.1, Y + 2.35, 3.5, 0.3, 1.9, ZP, { l: mix(BG, INK, 0.1), r: mix(BG, INK, 0.2), t: STONE_L });
      const hung = [mix(BG, INK, 0.8), '#5b7fe0', VIOLET];
      hung.forEach((art, i) => {
        const u0 = 0.07 + i * 0.31;
        quad(w.L, u0, 0.34, u0 + 0.25, 0.9, BG, 0.7);
        quad(w.L, u0 + 0.03, 0.4, u0 + 0.22, 0.84, mix(BG, art, 0.8), 0.4);
        quad(w.L, u0 + 0.05, 0.16, u0 + 0.2, 0.27, INK, 0);
      });
      const C: [P3, P3, P3, P3] = [[X - 0.7, Y + 1.35, ZP + 2.3], [X + 3.3, Y + 0.9, ZP + 2.6], [X + 5.7, Y + 3.35, ZP + 3.7], [X - 0.7, Y + 3.35, ZP + 2.08]];
      const c = C.map(P3of);
      const mast = P(X + 4.2, Y + 0.7, ZP + 4.9);
      seg(P(X + 4.2, Y + 0.7, ZP), mast, STONE_L, Math.max(1.2, 0.07 * k));
      face([c[3]!, c[2]!, [c[2]![0], c[2]![1] + 0.02 * k], [c[3]![0], c[3]![1] + 0.08 * k]], mix(BG, INK, 0.5), 0.5);
      hypar(C, 6, TIN);
      seg(c[3]!, c[2]!, ink(0.9), LW() * 1.6);
      seg(mast, c[2]!, ink(0.5), 1);
      seg(mast, lerp(c[1]!, c[2]!, 0.45), ink(0.4), 1);
      seg(mast, c[1]!, ink(0.4), 1);
      ellipseG(X + 1.6, Y + 3.6, 0.45, 0.02, null, alpha(VIOLET, 0.8), 1.2);
      face([P(X + 1.6, Y + 3.1, 0.02), P(X + 1.45, Y + 3.3, 0.02), P(X + 1.75, Y + 3.3, 0.02)], INK, 0);
      glow(P(X + 1.6, Y + 3.6, 0.02), 1.6, VIOLET, 0.22);
      glow(fp(w.L, 0.5, 0.6), 2.6, HOT, 0.16);
      b.top = ZP + 3.1;
    },

    /* The price keeper. The Balance: one lit beam across a stone wedge, a pan of water for our price and a pan of brass for the price outside. */
    balance(b) {
      const { X, Y } = b;
      const xa = X - 0.55;
      const xb = X + 3.75;
      const ya = Y + 0.95;
      const yb = Y + 1.5;
      const ym = (ya + yb) / 2;
      const zc = ZP + 2.55;
      const hh = 0.34;
      const pan = (px: number, fill: string, light: string): void => {
        cyl(px, ym, 0.6, zc - 1.5, 0.09, STONE_L, STONE_D, { top: fill, edge: 0.6 });
        for (const [dx, dy] of [[-0.5, 0], [0.5, 0], [0, 0.5]] as const) seg(P(px, ym, zc), P(px + dx, ym + dy, zc - 1.41), ink(0.6), 1);
        glow(P(px, ym, zc - 1.35), 1.2, light, 0.45);
      };
      pan(xa + 0.3, mix(BG, AQUA, 0.82), AQUA);
      face([P(X + 1.0, yb + 0.3, ZP), P(X + 2.2, yb + 0.3, ZP), P(X + 1.6, ym, zc)], STONE, 0.5);
      face([P(X + 2.2, yb + 0.3, ZP), P(X + 2.2, ya - 0.3, ZP), P(X + 1.6, ym, zc)], STONE_D, 0.5);
      const beam = box(xa, ya, xb - xa, yb - ya, hh, zc, { l: mix(BG, INK, 0.16), r: mix(BG, INK, 0.1), t: STONE }, 0.55);
      quad(beam.L, 0.03, 0.26, 0.97, 0.74, GLOW, 0.5);
      if (cam.z > 0.5) for (let i = 1; i < 14; i++) seg(fp(beam.L, 0.03 + (0.94 * i) / 14, 0.26), fp(beam.L, 0.03 + (0.94 * i) / 14, 0.74), 'rgba(5,8,15,.8)', 1);
      glow(P(X + 1.6, yb, zc + 0.2), 2.4, GLOW, 0.2);
      const bubble = P(X + 1.6, yb, zc + hh + 0.02);
      dot(bubble, 0.08, AQUA);
      glow(bubble, 0.8, AQUA, 0.6);
      pan(xb - 0.3, mix(BG, BRASS, 0.88), BRASS);
      van(X + 1.6, Y + 2.9);
      b.top = zc + hh + 0.25;
    },

    /* An open lot. The Ghost: survey pegs, and the next building in dashed line because nobody has drawn it yet. */
    ghost(b) {
      const { X, Y, x0, y0 } = b;
      const k = K();
      const pegs: Pt[] = [[x0 + 0.5, y0 + 0.5], [x0 + PW - 0.5, y0 + 0.5], [x0 + PW - 0.5, y0 + PD - 0.5], [x0 + 0.5, y0 + PD - 0.5]];
      const wire = (pts: readonly P3[], col: string): void => {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const s = P3of(p);
          if (i) ctx.lineTo(s[0], s[1]);
          else ctx.moveTo(s[0], s[1]);
        });
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.stroke();
      };
      ctx.setLineDash([0.2 * k, 0.16 * k]);
      pegs.forEach((p, i) => {
        const q = pegs[(i + 1) % 4]!;
        wire([[p[0], p[1], ZP + 0.35], [q[0], q[1], ZP + 0.35]], ink(0.32));
      });
      const x1 = X + 0.5;
      const x2 = X + 2.7;
      const y1 = Y + 0.5;
      const y2 = Y + 2.3;
      const h = ZP + 1.3;
      const col = ink(0.55);
      wire([[x1, y2, ZP], [x2, y2, ZP], [x2, y1, ZP]], col);
      wire([[x1, y2, h], [x2, y2, h], [x2, y1, h], [x1, y1, h], [x1, y2, h]], col);
      for (const [x, y] of [[x1, y2], [x2, y2], [x2, y1]] as const) wire([[x, y, ZP], [x, y, h]], col);
      const C: [P3, P3, P3, P3] = [[x1 - 0.35, y1 - 0.35, h + 1.5], [x2 + 0.35, y1 - 0.35, h + 0.22], [x2 + 0.35, y2 + 0.35, h + 1.3], [x1 - 0.35, y2 + 0.35, h + 0.22]];
      for (let i = 0; i <= 4; i++) {
        wire([bil(C, i / 4, 0), bil(C, i / 4, 1)], col);
        wire([bil(C, 0, i / 4), bil(C, 1, i / 4)], col);
      }
      ctx.setLineDash([]);
      for (const p of pegs) post(p[0], p[1], ZP, ZP + 0.45, 0.05, ink(0.7));
      post(x0 + 1.3, y0 + 4.5, ZP, ZP + 0.7, 0.04, ink(0.6));
      post(x0 + 3.0, y0 + 4.5, ZP, ZP + 0.7, 0.04, ink(0.6));
      const sign = box(x0 + 1.05, y0 + 4.46, 2.2, 0.08, 0.75, ZP + 0.7, { l: mix(BG, INK, 0.12), r: STONE_D, t: STONE_L });
      if (cam.z > 0.8) {
        const q = fq(sign.L, 0.1, 0.3, 0.9, 0.7);
        seg(lerp(q[0]!, q[3]!, 0.2), lerp(q[1]!, q[2]!, 0.2), ink(0.6), 1);
        seg(lerp(q[0]!, q[3]!, 0.8), lerp(q[1]!, q[2]!, 0.8), ink(0.35), 1);
      }
      b.top = ZP + 2.9;
    },

    /* MFER. The Slouch: three timber slabs, each slid and turned a little further than the one below, the last hanging in the air on one prop. */
    slouch(b) {
      const { X, Y, acc } = b;
      const k = K();
      // one picture round all three slabs, each showing the part of it at its own height
      const art = wrapOf(b, ZP, ZP + 2.34, 4.2);
      const s1 = rbox(X + 1.3, Y + 1.5, 2.3, 1.9, 0, ZP, 1.0, acc, art);
      quad(s1[0]!, 0.42, 0, 0.56, 0.68, BG, 0.8);
      glow(fp(s1[0]!, 0.48, 0), 1.4, GLOW, 0.3);
      ladder(X + 0.3, Y + 2.47, 0.9);
      const s2 = rbox(X + 1.65, Y + 1.4, 2.6, 1.45, -0.24, ZP + 1.0, 0.72, acc, art);
      quad(s2[0]!, 0.07, 0.42, 0.93, 0.6, GLOW, 0.5);
      quad(s2[1]!, 0.12, 0.42, 0.88, 0.6, GLASS, 0.5);
      seg(P(X + 3.45, Y + 2.5, ZP), P(X + 3.0, Y + 1.9, ZP + 1.72), STONE_L, Math.max(1.2, 0.06 * k));
      const s3 = rbox(X + 1.95, Y + 1.3, 3.0, 1.1, -0.52, ZP + 1.72, 0.62, acc, art);
      quad(s3[0]!, 0.06, 0.4, 0.94, 0.6, GLOW, 0.5);
      quad(s3[1]!, 0.15, 0.4, 0.85, 0.6, GLOW, 0.5);
      if (cam.z > 0.5) for (const s of [s2, s3]) for (let i = 1; i < 8; i++) seg(fp(s[0]!, 0.07 + (0.86 * i) / 8, 0.42), fp(s[0]!, 0.07 + (0.86 * i) / 8, 0.6), 'rgba(5,8,15,.8)', 1);
      glow(fp(s3[0]!, 0.5, 0.5), 2.2, GLOW, 0.22);
      const aerial = P(X + 2.2, Y + 1.1, ZP + 2.34);
      seg(aerial, [aerial[0], aerial[1] - 0.9 * k], ink(0.7), 1);
      b.top = ZP + 2.5;
    },

    /* BNKR. The Monolith: a board-marked block held over an open lobby on four needles, split by a seam of light, a palm on its roof. */
    monolith(b) {
      const { X, Y, acc } = b;
      const z1 = ZP + 1.35;
      const k = K();
      ellipseG(X + 1.6, Y + 1.45, 1.25, ZP + 0.02, alpha(GLOW, 0.14), ink(0.3));
      for (const [dx, dy] of [[0.55, 0.5], [2.65, 0.5], [0.55, 2.4]] as const) post(X + dx, Y + dy, ZP, z1, 0.05, STONE_L);
      const core = box(X + 1.35, Y + 1.2, 0.5, 0.5, 1.35, ZP, { l: mix(BG, GLOW, 0.75), r: mix(BG, GLOW, 0.45), t: STONE }, 0.5);
      if (cam.z > 0.6) for (let i = 1; i < 5; i++) seg(fp(core.L, 0, i / 5), fp(core.L, 1, i / 5), 'rgba(5,8,15,.6)', 1);
      glow(P(X + 1.6, Y + 1.45, ZP + 0.6), 2.2, GLOW, 0.3);
      post(X + 2.65, Y + 2.4, ZP, z1, 0.05, STONE_L);
      seg(P(X + 0.2, Y + 3.0, ZP), P(X + 1.3, Y + 2.62, z1), ink(0.7), Math.max(1, 0.05 * k));
      // one picture round both storeys; the seam of light cuts across it
      const art = wrapOf(b, z1, z1 + 1.99, 5.0);
      hutBox(X + 0.3, Y + 0.25, 2.6, 2.4, 0.95, z1, acc, null, { t: STONE, wrap: art });
      box(X + 0.4, Y + 0.35, 2.4, 2.2, 0.09, z1 + 0.95, { l: HOT, r: GLOW, t: GLOW }, 0.2);
      glow(P(X + 1.6, Y + 2.55, z1 + 1.0), 2.4, GLOW, 0.3);
      const up = hutBox(X + 0.3, Y + 0.25, 2.6, 2.4, 0.95, z1 + 1.04, acc, null, { t: STONE, wrap: art });
      quad(up.L, 0.62, 0.28, 0.86, 0.72, GLOW, 0.6);
      quad(up.R, 0.4, 0.28, 0.6, 0.72, GLASS, 0.6);
      ladder(X + 0.42, Y + 2.67, 0.9, z1);
      palm({ x: X + 1.2, y: Y + 1.2, z: 3.34 - ZP, h: 1.25, lean: 0.3, r: 0.9, ph: 1.3 });
      b.top = ZP + 3.4;
    },

    /* DRB. The Gridshell: a dome woven from bamboo, no columns, its far side showing through. Inside it a round room wrapped in DRB's picture, with a fire on its roof. */
    gridshell(b) {
      const { X, Y, cx, cy, acc } = b;
      const k = K();
      const floor = ZP + 0.14;
      const room = 1.02;
      const roomTop = floor + 0.8;
      cyl(cx, cy, 1.6, ZP, 0.14, STONE, STONE_D, { top: mix(BG, acc, 0.22) });
      gridDome(cx, cy, 1.52, floor, 0.98, BAMBOO, 13, 'back');
      drum(cx, cy, room, floor, roomTop - floor, acc, { top: STONE_D });
      wrapDrum(cx, cy, room, floor, roomTop - floor, wrapOf(b, floor, roomTop, Math.PI * room));
      cyl(cx, cy, 0.22, roomTop, 0.2, HOT, GLOW, { top: HOT, edge: 0.3 });
      glow(P(cx, cy, roomTop + 0.3), 2.6, '#ffb347', 0.4);
      gridDome(cx, cy, 1.52, floor, 0.98, BAMBOO, 13, 'front');
      const eye = P(cx, cy, ZP + 0.14 + 1.52 * 0.98);
      ctx.beginPath();
      ctx.ellipse(eye[0], eye[1] + 0.05 * k, 0.3 * k, 0.16 * k, 0, 0, TAU);
      ctx.strokeStyle = alpha(GLOW, 0.9);
      ctx.lineWidth = LW() * 1.4;
      ctx.stroke();
      glow(eye, 1.0, GLOW, 0.4);
      const gate = hutBox(X - 0.35, Y + 2.62, 1.6, 0.22, 1.15, ZP, acc, b.mural, { split: 0.92, t: STONE_L });
      door(gate.L, 0.36, 0.64, 0.74);
      ladder(X - 0.28, Y + 2.86, 1.0);
      b.top = ZP + 1.85;
    },

    /* JBM. The Surf: one golden roof that comes in like a set of waves, each taller than the last, breaking toward the pool. */
    wave(b) {
      const { X, Y, acc } = b;
      const xa = X - 0.25;
      const xb = X + 3.4;
      const e = 1.05;
      const yf = Y + 2.55;
      const zAt = (x: number): number => {
        const t = Math.max(0, Math.min(1, (x - xa) / (xb - xa)));
        return ZP + e + 0.12 + (0.28 + 0.8 * t) * (0.5 - 0.5 * Math.cos(t * TAU * 2.5));
      };
      const f = hutBox(X, Y + 0.45, 3.1, 2.1, e, ZP, acc, b.mural);
      door(f.L, 0.44, 0.56, 0.72);
      const glass: Pt[] = [P(X, yf, ZP + e), P(X + 3.1, yf, ZP + e)];
      for (let i = 30; i >= 0; i--) {
        const x = X + (3.1 * i) / 30;
        glass.push(P(x, yf, zAt(x)));
      }
      face(glass, mix(BG, GLOW, 0.62), 0.5);
      if (cam.z > 0.5) {
        for (let i = 1; i < 12; i++) {
          const x = X + (3.1 * i) / 12;
          seg(P(x, yf, ZP + e), P(x, yf, zAt(x)), 'rgba(5,8,15,.75)', 1);
        }
      }
      face([P(X + 3.1, Y + 0.45, ZP + e), P(X + 3.1, yf, ZP + e), P(X + 3.1, yf, zAt(X + 3.1)), P(X + 3.1, Y + 0.45, zAt(X + 3.1))], mix(BG, GLOW, 0.36), 0.5);
      glow(P(X + 1.6, yf, ZP + e + 0.3), 2.6, GLOW, 0.24);
      const profile: Pt[] = [];
      for (let i = 0; i <= 44; i++) {
        const x = xa + ((xb - xa) * i) / 44;
        profile.push([x, zAt(x) + 0.03]);
      }
      sweepX(profile, Y + 0.25, Y + 2.78, shellOf(acc));
      ladder(X + 0.12, Y + 2.57, 0.92);
      b.top = ZP + 2.3;
    },

    /* QR. The Lantern: a cube of pattern-block screen lit from inside, floating over a smaller mural base, a palm growing out of the top. */
    lantern(b) {
      const { X, Y, acc } = b;
      const z1 = ZP + 0.78;
      const hh = 2.15;
      const on = mix(BG, GLOW, 0.66);
      const on2 = mix(BG, GLOW, 0.42);
      const base = hutBox(X + 0.5, Y + 0.45, 2.2, 1.9, 0.78, ZP, acc, b.mural);
      door(base.L, 0.42, 0.58, 0.8, true);
      ladder(X + 0.6, Y + 2.37, 0.7);
      const u = box(X + 0.2, Y + 0.15, 2.8, 2.5, hh, z1, { l: on, r: on2, t: mix(BG, INK, 0.12) });
      const code = (f: typeof u.L, n: number, m: number, seed: number): void => {
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < m; j++) {
            if (hash(seed + i * 7, j + 2, 5) < 0.47) quad(f, 0.05 + (i * 0.9) / n, 0.05 + (j * 0.9) / m, 0.05 + ((i + 1) * 0.9) / n + 0.002, 0.05 + ((j + 1) * 0.9) / m + 0.002, BG);
          }
        }
      };
      const eye = (f: typeof u.L, u0: number, v0: number, c: string): void => {
        const w = 0.27;
        const h = 0.3;
        quad(f, u0 - 0.02, v0 - 0.025, u0 + w + 0.02, v0 + h + 0.025, c);
        quad(f, u0, v0, u0 + w, v0 + h, BG);
        quad(f, u0 + w * 0.17, v0 + h * 0.17, u0 + w * 0.83, v0 + h * 0.83, c);
        quad(f, u0 + w * 0.32, v0 + h * 0.32, u0 + w * 0.68, v0 + h * 0.68, BG);
      };
      code(u.L, 13, 11, 3);
      code(u.R, 12, 11, 41);
      for (const [u0, v0] of [[0.05, 0.65], [0.68, 0.65], [0.05, 0.05]] as const) {
        eye(u.L, u0, v0, on);
        eye(u.R, u0, v0, on2);
      }
      outline(u.L, 0.7);
      outline(u.R, 0.7);
      face([P(X + 0.75, Y + 0.7, z1 + hh), P(X + 2.45, Y + 0.7, z1 + hh), P(X + 2.45, Y + 2.1, z1 + hh), P(X + 0.75, Y + 2.1, z1 + hh)], BG, 0.5);
      glow(fp(u.L, 0.5, 0.5), 3.4, GLOW, 0.2);
      glow(fp(u.R, 0.5, 0.5), 2.6, GLOW, 0.14);
      palm({ x: X + 1.6, y: Y + 1.4, z: z1 + hh - 0.25 - ZP, h: 1.45, lean: -0.25, r: 1.0, ph: 0.4 });
      b.top = z1 + hh + 0.1;
    },

    /* BAYLA. The Lighthouse: the lock ladder wound round it as a stair, a gallery, a lamp roof that floats, a mural cottage under a butterfly roof. */
    lighthouse(b) {
      const { X, Y, cx, cy, acc } = b;
      const k = K();
      const z0 = ZP + 0.32;
      const H = 3.9;
      const z1 = z0 + H;
      const rAt = (zz: number): number => 0.74 - (Math.max(0, Math.min(H, zz - z0)) / H) * 0.3;
      cyl(cx, cy, 1.3, ZP, 0.32, STONE, STONE_D, { top: STONE_L });
      // the whole tower wrapped in BAYLA's picture; the cream bands keep a cream wash, so it still reads banded
      const art = wrapOf(b, z0, z1, Math.PI * rAt(z0));
      for (let i = 0; i < 6; i++) {
        const za = z0 + (H * i) / 6;
        if (i % 2) cyl(cx, cy, rAt(za), za, H / 6, mix(BG, INK, 0.62), mix(BG, INK, 0.3), { noTop: true, rings: true });
        else drum(cx, cy, rAt(za), za, H / 6, acc, { noTop: true });
        wrapDrum(cx, cy, rAt(za), za, H / 6, art, 16, i % 2 ? 'rgba(245,228,184,.2)' : undefined);
      }
      const turns = 2.25;
      const a0 = 0.5;
      const rr = (zz: number): number => rAt(zz) + 0.08;
      const lw = Math.max(1, 0.05 * k);
      helixOn(cx, cy, rr, z0, z1, turns, a0, ink(0.9), lw);
      helixOn(cx, cy, rr, z0 + 0.2, z1 + 0.2, turns, a0, ink(0.9), lw);
      for (let i = 0; i <= 70; i++) {
        const t = i / 70;
        const an = a0 + t * turns * TAU;
        if (Math.cos(an) + Math.sin(an) < -0.15) continue;
        const z = z0 + H * t;
        const r = rr(z);
        seg(P(cx + r * Math.cos(an), cy + r * Math.sin(an), z), P(cx + r * Math.cos(an), cy + r * Math.sin(an), z + 0.2), ink(0.75), Math.max(0.8, 0.04 * k));
      }
      cyl(cx, cy, 0.92, z1 + 0.2, 0.06, STONE, STONE_D, { top: STONE_L });
      cyl(cx, cy, 0.4, z1 + 0.26, 0.6, HOT, GLOW, { noTop: true });
      cyl(cx, cy, 0.74, z1 + 0.98, 0.05, SLATE, SLATE_E, { top: mix(BG, INK, 0.3) });
      seg(P(cx, cy, z1 + 1.03), P(cx, cy, z1 + 1.7), ink(0.8), 1);
      dot(P(cx, cy, z1 + 1.7), 0.05, mix(acc, '#ffffff', 0.2));
      const cottage = hutBox(X - 0.25, Y + 2.0, 1.4, 0.85, 0.7, ZP, acc, b.mural, { split: 0.7 });
      door(cottage.R, 0.3, 0.62, 0.8);
      butterfly(X - 0.25, Y + 2.0, 1.4, 0.85, ZP + 0.7, 0.36, 0.12, TIN, acc);
      glow(P(cx, cy, z1 + 0.6), 1.7, GLOW, 0.75);
      beams.push({ cx, cy, z: z1 + 0.6 });
      b.top = z1 + 1.75;
    },

    /* Central Station. The Umbrellas: three thin shells, each on one column, low in the middle and lifting to their edges. A glass hall behind and a clock needle. */
    canopy(b) {
      const { X, Y, acc } = b;
      const k = K();
      const hall = box(X - 0.45, Y + 0.05, 4.7, 0.8, 1.05, ZP, { l: GLASS, r: mix(GLASS, BG, 0.4), t: STONE });
      panes(hall.L, 12, 1, 71, 0.9, { fh: 0.76, fw: 0.84, my: 0.1 });
      panes(hall.R, 2, 1, 72, 0.7, { fh: 0.76, fw: 0.84, my: 0.1 });
      glow(fp(hall.L, 0.5, 0.4), 2.6, GLOW, 0.2);
      const needle = stoneBox(X + 4.45, Y + 0.25, 0.42, 0.42, 4.0, ZP);
      hip(X + 4.45, Y + 0.25, 0.42, 0.42, ZP + 4.0, 1.0, 0);
      const clock = fp(needle.L, 0.5, 0.9);
      dot(clock, 0.17, HOT);
      seg(clock, [clock[0], clock[1] - 0.12 * k], BG, 1);
      seg(clock, [clock[0] + 0.09 * k, clock[1] + 0.03 * k], BG, 1);
      glow(clock, 0.8, GLOW, 0.45);
      const shell = shellOf(acc);
      for (let i = 0; i < 3; i++) umbrella(X + 0.33 + i * 1.57, Y + 1.95, 0.78, ZP + 1.5 + (i === 1 ? 0.35 : 0), ZP + 2.6 + (i === 1 ? 0.35 : 0), shell);
      b.top = ZP + 3.1;
    },

    /* The Treasury. The Hourglass: a brass lattice over a stone strongroom, every member straight. It stands for the 48-hour wait; 48 marks ring its foot. */
    hourglass(b) {
      const { X, Y } = b;
      const k = K();
      const cx = X + 1.6;
      const cy = Y + 1.3;
      const z0 = ZP + 0.14;
      const z1 = ZP + 4.2;
      const R = 1.25;
      const twist = 2.2;
      const zm = (z0 + z1) / 2;
      cyl(cx, cy, 1.5, ZP, 0.14, STONE, STONE_D, { top: STONE_L });
      if (cam.z > 0.5) {
        for (let i = 0; i < 48; i++) {
          const an = (i / 48) * TAU;
          seg(P(cx + 1.3 * Math.cos(an), cy + 1.3 * Math.sin(an), z0 + 0.01), P(cx + 1.45 * Math.cos(an), cy + 1.45 * Math.sin(an), z0 + 0.01), ink(0.34), 1);
        }
      }
      hyperboloid(cx, cy, R, z0, z1, 22, twist, BRASS, false);
      cyl(cx, cy, 0.6, z0, 0.95, STONE, STONE_D, { rings: true, top: STONE_L });
      const portal = stoneBox(cx - 0.32, cy + 0.42, 0.64, 0.42, 0.85, z0);
      quad(portal.L, 0.2, 0, 0.8, 0.78, mix(BG, BRASS, 0.9), 0.7);
      glow(fp(portal.L, 0.5, 0.2), 1.5, BRASS, 0.4);
      glow(P(cx, cy, zm), 1.5, BRASS, 0.5);
      hyperboloid(cx, cy, R, z0, z1, 22, twist, BRASS, true);
      for (const [zz, rr] of [[z1, R], [zm, R * Math.cos(twist / 2)]] as const) {
        const p = P(cx, cy, zz);
        ctx.beginPath();
        ctx.ellipse(p[0], p[1], rr * 1.2247 * k, rr * 0.7071 * k, 0, 0, TAU);
        ctx.strokeStyle = alpha(BRASS, 0.95);
        ctx.lineWidth = LW() * 1.4;
        ctx.stroke();
      }
      b.top = z1 + 0.1;
    },

    /* Range pools. The Diving Tower: one thin wall, three boards out over the lanes. */
    lifeguard(b) {
      const { x0, y0 } = b;
      const x = x0 + 6.45;
      const y = y0 + 2.3;
      for (const [z, len] of [[0.9, 1.0], [1.75, 1.35], [2.6, 0.8]] as const) box(x - len, y + 0.1, len + 0.16, 0.5, 0.07, ZP + z, { l: STONE, r: STONE_D, t: STONE_L }, 0.5);
      const wall = box(x, y, 0.16, 0.7, 3.0, ZP, { l: STONE, r: STONE_D, t: STONE_L });
      if (cam.z > 0.5) for (let i = 1; i < 12; i++) seg(fp(wall.R, 0.35, i / 12), fp(wall.R, 0.65, i / 12), ink(0.6), 1);
      flag(x + 0.08, y + 0.35, ZP + 3.0, ZP + 3.8, mix(BG, RED, 0.9));
      b.top = ZP + 3.1;
    },

    /* BOBO. The Raising: four bamboo masts, and the thatched roof part-way up them on its ropes, not yet set down. Hammers up. */
    lift(b) {
      const { X, Y, acc } = b;
      const k = K();
      const mh = ZP + 4.3;
      const e = ZP + 1.05 + 0.78 + Math.sin(time() * 0.7) * 0.07;
      const feet: Pt[] = [[X - 0.15, Y - 0.15], [X + 3.35, Y - 0.15], [X - 0.15, Y + 2.95], [X + 3.35, Y + 2.95]];
      const heads: Pt[] = [[X + 0.45, Y + 0.45], [X + 2.75, Y + 0.45], [X + 0.45, Y + 2.35], [X + 2.75, Y + 2.35]];
      const eaves: Pt[] = [[X + 0.4, Y + 0.4], [X + 2.8, Y + 0.4], [X + 0.4, Y + 2.4], [X + 2.8, Y + 2.4]];
      const bw = Math.max(1.2, 0.07 * k);
      const head = (i: number, dz = 0): Pt => P(heads[i]![0], heads[i]![1], mh + dz);
      const mast = (i: number): void => seg(P(feet[i]![0], feet[i]![1], ZP), head(i), BAMBOO, bw);
      const tie = (i: number, j: number): void => seg(head(i, -0.2), head(j, -0.2), BAMBOO, bw);
      const rope = (i: number, a: number): void => seg(head(i, -0.2), P(eaves[i]![0], eaves[i]![1], e), ink(a), 1);
      for (const i of [0, 1, 2]) mast(i);
      tie(0, 1);
      tie(0, 2);
      const f = hutBox(X + 0.45, Y + 0.45, 2.3, 1.9, 1.05, ZP, acc, b.mural, { t: mix(BG, GLOW, 0.3) });
      door(f.L, 0.42, 0.58, 0.72);
      win(f.R, 0.3, 0.3, 0.62, 0.72);
      glow(P(X + 1.6, Y + 1.4, ZP + 1.3), 2.0, GLOW, 0.34);
      ladder(X + 0.56, Y + 2.37, 0.92);
      for (const i of [0, 1, 2]) rope(i, 0.5);
      hip(X + 0.45, Y + 0.45, 2.3, 1.9, e, 1.5, 0.38, THATCHED);
      mast(3);
      tie(1, 3);
      tie(2, 3);
      rope(3, 0.6);
      b.top = ZP + 3.5;
    },

    /* SOY. The Halo: a lit dance floor on a mural-walled roof, and over it one ring of neon on three raking masts, tipping slowly round. */
    halo(b) {
      const { X, Y, acc } = b;
      const k = K();
      const z1 = ZP + 1.2;
      const cx = X + 1.55;
      const cy = Y + 1.45;
      const R = 1.85;
      const lean = time() * 0.22;
      const ringAt = (t: number): Pt => P(cx + R * Math.cos(t), cy + R * Math.sin(t), z1 + 1.75 + 0.5 * Math.cos(t - lean));
      const mast = (gx: number, gy: number, t: number): void => seg(P(gx, gy, ZP), ringAt(t), STONE_L, Math.max(1.2, 0.06 * k));
      mast(X - 0.45, Y - 0.2, 3.9);
      mast(X + 3.6, Y + 0.2, 5.6);
      const f = hutBox(X + 0.1, Y + 0.25, 2.9, 2.4, 1.2, ZP, acc, b.mural, { t: mix(BG, INK, 0.08) });
      const tw = 2.5 / 4;
      const td = 2.0 / 4;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const hue = (i * 47 + j * 83 + time() * 70) % 360;
          const x = X + 0.3 + i * tw;
          const y = Y + 0.45 + j * td;
          face([P(x + 0.03, y + 0.03, z1), P(x + tw - 0.03, y + 0.03, z1), P(x + tw - 0.03, y + td - 0.03, z1), P(x + 0.03, y + td - 0.03, z1)], `hsla(${hue | 0},85%,62%,.9)`, 0.3);
        }
      }
      face(fq(f.L, 0.42, 0, 0.58, 0.52), mix(SPOT, '#ffffff', 0.35), 0.8);
      glow(fp(f.L, 0.5, 0), 1.4, SPOT, 0.35);
      ladder(X + 0.22, Y + 2.67, 1.08);
      mast(X + 1.0, Y + 3.25, 1.75);
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const p = ringAt((i / 60) * TAU);
        if (i) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
      }
      ctx.strokeStyle = alpha(SPOT, 0.35);
      ctx.lineWidth = Math.max(4, 0.3 * k);
      ctx.stroke();
      ctx.strokeStyle = SPOT;
      ctx.lineWidth = Math.max(1.6, 0.1 * k);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.lineWidth = Math.max(0.8, 0.03 * k);
      ctx.stroke();
      for (let i = 0; i < 6; i++) glow(ringAt((i / 6) * TAU), 1.3, SPOT, 0.3);
      glow(P(cx, cy, z1), 2.4, SPOT, 0.2);
      torch(X - 0.25, Y + 3.0);
      torch(X + 3.3, Y + 3.0);
      b.top = z1 + 2.4;
    },

    /* BRAINLET. The Wrong Way Up: the smallest block at the bottom and the biggest on top, each turned off the last, with a telescope and a thatched hat worn askew. */
    stack(b) {
      const { X, Y, acc } = b;
      const k = K();
      const cx = X + 1.6;
      const cy = Y + 1.5;
      // one picture down all three blocks, the biggest on top showing the top of it
      const art = wrapOf(b, ZP, ZP + 2.95, 4.4);
      const s1 = rbox(cx - 0.05, cy + 0.15, 1.05, 0.95, 0.12, ZP, 0.9, acc, art);
      quad(s1[0]!, 0.38, 0, 0.62, 0.7, BG, 0.8);
      glow(fp(s1[0]!, 0.5, 0), 1.3, GLOW, 0.3);
      ladder(cx - 0.5, cy + 0.66, 0.8);
      const s2 = rbox(cx + 0.1, cy + 0.02, 1.6, 1.4, -0.2, ZP + 0.9, 0.85, acc, art);
      quad(s2[0]!, 0.4, 0.32, 0.6, 0.68, lit(33) ? GLOW : GLASS, 0.6);
      quad(s2[1]!, 0.4, 0.32, 0.6, 0.68, GLASS, 0.6);
      for (const [gx, gy, tx, ty] of [[X - 0.1, Y + 2.75, X + 0.75, Y + 2.2], [X + 3.25, Y + 2.3, X + 2.6, Y + 1.9]] as const) seg(P(gx, gy, ZP), P(tx, ty, ZP + 1.75), STONE_L, Math.max(1.1, 0.055 * k));
      rbox(cx - 0.05, cy - 0.05, 2.35, 2.05, 0.15, ZP + 1.75, 1.2, acc, art);
      const zt = ZP + 2.95;
      const foot = P(cx + 0.35, cy + 0.3, zt);
      seg(foot, P(cx + 0.35, cy + 0.3, zt + 0.35), ink(0.7), 1);
      ctx.lineCap = 'round';
      seg([foot[0], foot[1] - 0.35 * k], P(cx + 1.25, cy - 0.5, zt + 0.95), STONE_L, Math.max(2, 0.17 * k));
      ctx.lineCap = 'butt';
      tiltCone(cx - 0.45, cy - 0.2, 0.78, zt, [cx - 0.1, cy - 0.55, zt + 1.1]);
      b.top = zt + 1.15;
    },

    /* Your wallet. The Villa: a house on stilts under a thatched butterfly roof. Everything you earn comes in by the front door. */
    villa(b) {
      const { X, Y, acc } = b;
      const zf = ZP + VILLA_DECK;
      const home = env.walletLit();
      const pulse = env.doorPulse();
      stilts(X + 0.1, Y + 0.2, 3.0, 2.65, zf, 4, 3);
      deck(X, Y + 0.1, 3.2, 2.8, zf);
      const f = hutBox(X + 0.2, Y + 0.25, 2.8, 1.75, 0.95, zf, acc);
      face(fq(f.L, 0.37, 0, 0.63, 0.86), home ? HOT : BG, 0.85);
      if (cam.z > 0.6) seg(fp(f.L, 0.5, 0), fp(f.L, 0.5, 0.86), home ? 'rgba(5,8,15,.45)' : ink(0.3), 1);
      if (home) glow(fp(f.L, 0.5, 0.3), 2.0 + pulse * 1.5, GLOW, 0.36 + pulse * 0.3);
      shut(f.L, 0.11, 0.3, 0.22, 0.76, acc, home);
      shut(f.L, 0.78, 0.3, 0.89, 0.76, acc, home);
      win(f.R, 0.25, 0.3, 0.75, 0.76, home);
      butterfly(X + 0.2, Y + 0.25, 2.8, 1.75, zf + 0.95, 0.75, 0.3, THATCHED, acc, home);
      rail(X, Y + 2.9, X + 1.1, Y + 2.9, zf);
      rail(X + 2.1, Y + 2.9, X + 3.2, Y + 2.9, zf);
      rail(X + 3.2, Y + 2.9, X + 3.2, Y + 0.1, zf);
      steps(X + 1.15, Y + 2.9, 0.9, zf, 3);
      for (const lx of [X + 1.1, X + 2.1]) {
        post(lx, Y + 2.9, zf, zf + 0.62, 0.04, ink(0.75));
        const lamp = P(lx, Y + 2.9, zf + 0.68);
        dot(lamp, 0.07, home ? GLOW : mix(BG, INK, 0.3));
        if (home) glow(lamp, 0.9, GLOW, 0.4);
      }
      // The yard: one stack of crates per coin that is paying, as tall as what has walked in.
      const yx = b.x0 + 4.5;
      const yy = b.y0 + 2.2;
      box(yx - 0.2, yy - 0.25, 2.55, 0.95, 0.08, ZP, { l: WOOD, r: WOOD_D, t: WOOD_L }, 0.4);
      env.stacks().slice(0, 5).forEach((s, i) => {
        for (let j = 0; j < Math.min(6, s.n); j++) box(yx + i * 0.46, yy, 0.36, 0.42, 0.24, ZP + 0.08 + j * 0.24, { l: mix(BG, s.col, 0.7), r: mix(BG, s.col, 0.45), t: mix(BG, s.col, 0.86) }, 0.5);
      });
      b.top = zf + 1.95;
    },

    /* RIZZ. The Bloom: seven thatched petals open from a mural-walled roof round a lamp. You see the lit inside of the far ones. */
    bloom(b) {
      const { X, Y, acc } = b;
      const w = water(b);
      const cx = X + 1.6;
      const cy = Y + 1.4;
      const z1 = ZP + 1.0;
      const base = hutBox(X + 0.2, Y + 0.15, 2.8, 2.5, 1.0, ZP, acc, b.mural, { t: WOOD_L });
      door(base.L, 0.43, 0.57, 0.7, true);
      for (let i = 0; i < 7; i++) dot(P(X + 0.42 + i * 0.4, Y + 2.56, z1 + 0.04), 0.065, RED);
      ladder(X + 0.32, Y + 2.67, 0.9);
      const petals = Array.from({ length: 7 }, (_, i) => {
        const an = (i / 7) * TAU + 0.35;
        return { an, toward: Math.cos(an) + Math.sin(an) };
      }).sort((p, q) => p.toward - q.toward);
      for (const p of petals) if (p.toward < 0) petal(cx, cy, p.an, 0.5, 1.7, 0.36, z1, z1 + 2.15, mix(BG, w, 0.5));
      cyl(cx, cy, 0.2, z1, 0.5, HOT, GLOW, { top: HOT, edge: 0.3 });
      glow(P(cx, cy, z1 + 0.6), 2.4, w, 0.4);
      glow(P(cx, cy, z1 + 0.5), 1.2, GLOW, 0.5);
      for (const p of petals) if (p.toward >= 0) petal(cx, cy, p.an, 0.5, 1.7, 0.36, z1, z1 + 2.15, THATCH);
      b.top = z1 + 2.25;
    },

    /* The launch slip. The Slip: a hull in frame, its ribs showing, the stern under a tarp, one timber arch over the bow with the tackle hanging from it. */
    slip(b) {
      const { X, Y } = b;
      const k = K();
      const cx = X + 1.45;
      const ya = Y + 0.45;
      const yb = Y + 4.05;
      const tarp = '#b07a3a';
      const half = (t: number): number => 0.8 * Math.pow(Math.sin(Math.PI * (0.13 + t * 0.87)), 0.75);
      const sheer = (t: number): number => ZP + 1.3 + 0.55 * Math.pow(Math.abs(t - 0.42) / 0.58, 2.2);
      const keel = (t: number): number => ZP + 0.42 + (t > 0.78 ? Math.pow((t - 0.78) / 0.22, 1.6) * 1.2 : 0);
      const yy = (t: number): number => ya + (yb - ya) * t;
      const port = (t: number, dz = 0): Pt => P(cx - half(t), yy(t), sheer(t) + dz);
      const star = (t: number, dz = 0): Pt => P(cx + half(t), yy(t), sheer(t) + dz);
      const keelAt = (t: number): Pt => P(cx, yy(t), keel(t));
      const archZ = (t: number): number => ZP + 3.7 * 4 * t * (1 - t);
      face([P(X + 0.5, Y + 0.1, ZP), P(X + 2.4, Y + 0.1, ZP), P(X + 2.4, Y + 4.9, ZP), P(X + 0.5, Y + 4.9, ZP)], mix(BG, INK, 0.1), 0.3);
      if (cam.z > 0.45) for (let y = Y + 0.4; y < Y + 4.8; y += 0.45) seg(P(X + 0.7, y, ZP), P(X + 2.2, y, ZP), WOOD, Math.max(1.5, 0.09 * k));
      for (const rx of [X + 1.0, X + 1.9]) seg(P(rx, Y + 0.1, ZP + 0.02), P(rx, Y + 4.9, ZP + 0.02), ink(0.6), Math.max(1, 0.04 * k));
      const arch = (y: number): void => {
        ctx.beginPath();
        for (let i = 0; i <= 28; i++) {
          const t = i / 28;
          const p = P(X - 0.35 + 3.6 * t, y, archZ(t));
          if (i) ctx.lineTo(p[0], p[1]);
          else ctx.moveTo(p[0], p[1]);
        }
        ctx.strokeStyle = WOOD_L;
        ctx.lineWidth = Math.max(1.5, 0.1 * k);
        ctx.stroke();
      };
      const ay = Y + 3.3;
      arch(ay);
      if (cam.z > 0.45) {
        for (let i = 1; i < 18; i++) {
          const t = i / 18;
          const t2 = t + 1 / 36;
          seg(P(X - 0.35 + 3.6 * t, ay, archZ(t)), P(X - 0.35 + 3.6 * t2, ay + 0.4, archZ(t2)), ink(0.32), 1);
        }
      }
      for (const t of [0.22, 0.6]) {
        post(cx - 0.55, yy(t), ZP, keel(t) + 0.2, 0.06);
        post(cx + 0.55, yy(t), ZP, keel(t) + 0.2, 0.06);
        seg(P(cx - 0.55, yy(t), ZP + 0.3), P(cx + 0.55, yy(t), ZP + 0.3), WOOD_L, Math.max(1.2, 0.07 * k));
      }
      const stem = P(cx, yb, sheer(1) + 0.15);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const p = keelAt(i / 30);
        if (i) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
      }
      ctx.lineTo(stem[0], stem[1]);
      ctx.strokeStyle = WOOD_L;
      ctx.lineWidth = Math.max(1.6, 0.11 * k);
      ctx.stroke();
      for (let i = 0; i < 14; i++) {
        const t = i / 14;
        const l = port(t);
        const r = star(t);
        const kp = keelAt(t);
        const c1 = P(cx - half(t) * 0.98, yy(t), keel(t) + 0.02);
        const c2 = P(cx + half(t) * 0.98, yy(t), keel(t) + 0.02);
        ctx.beginPath();
        ctx.moveTo(l[0], l[1]);
        ctx.quadraticCurveTo(c1[0], c1[1], kp[0], kp[1]);
        ctx.quadraticCurveTo(c2[0], c2[1], r[0], r[1]);
        ctx.strokeStyle = i % 2 ? WOOD_L : mix(BG, '#b98a55', 0.85);
        ctx.lineWidth = Math.max(1.1, 0.065 * k);
        ctx.stroke();
      }
      for (const side of [port, star]) {
        ctx.beginPath();
        for (let i = 0; i <= 30; i++) {
          const p = i === 30 ? stem : side(i / 30);
          if (i) ctx.lineTo(p[0], p[1]);
          else ctx.moveTo(p[0], p[1]);
        }
        ctx.strokeStyle = ink(0.85);
        ctx.lineWidth = Math.max(1.1, 0.06 * k);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      const under = [0, 0.07, 0.14, 0.21, 0.28];
      face(under.map((t) => port(t, 0.1)).concat(under.slice().reverse().map((t) => star(t, 0.1))), mix(BG, tarp, 0.66), 0.5);
      face(under.map((t) => star(t, 0.1)).concat(under.slice().reverse().map((t) => star(t, -0.5))), mix(BG, tarp, 0.42), 0.5);
      face([port(0.28, 0.1), star(0.28, 0.1), star(0.28, -0.5), P(cx, yy(0.28), keel(0.28) + 0.25), port(0.28, -0.5)], mix(BG, tarp, 0.55), 0.5);
      arch(ay + 0.4);
      seg(P(cx, ay + 0.4, ZP + 3.7), stem, ink(0.6), 1);
      dot(P(cx, ay + 0.4, ZP + 3.1), 0.06, STONE_L);
      // The launcher is switched off: its lamp is dark until it is on.
      post(X + 2.85, Y + 4.4, ZP, ZP + 0.9, 0.04, ink(0.6));
      dot(P(X + 2.85, Y + 4.4, ZP + 0.95), 0.09, mix(BG, BRASS, 0.45));
      b.top = ZP + 2.3;
    },
  };
}

