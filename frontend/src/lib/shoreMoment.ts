/**
 * THE SHORE ANSWERS (island answer thirty, the owner's word 11-07): the second after a buy or an add.
 *
 * The strike in the receipt card's ring throws sparks; the fire roars up past the card and settles
 * back into the ring; one light breaks off the fire and flies onto the coin's shore, the card's head;
 * the shore's lights, blinking out of step like fireflies, take that light's beat nearest first,
 * until the whole shore pulses with it three times; then the shore breathes with it, slowly, the
 * breath running out from it along the water. A sale never strikes: the wallet's light stays on the
 * shore, cooling to amber.
 *
 * Framework free: two canvases and the ring element in, one stop function out. The island's own
 * page (v1.2, the owner's yes 11-07 6:41 PM) is this code with a stand-in card around it.
 *
 * The venue's edits to the island's file, and nothing else: typed for this repo's
 * noUncheckedIndexedAccess (SpriteName, four `!` on reads inside their own bounds, the palm's
 * fronds `as const`).
 */
export type ShoreState = 'catching' | 'lit' | 'ember';
export interface ShoreMomentOptions {
  /** The card's head: a canvas across the card's full width, 176 px tall, inside its top corners. */
  shore: HTMLCanvasElement;
  /** A fixed canvas over the whole screen (inset 0, pointer-events none) above the card: the fire leaves the card. */
  fx: HTMLCanvasElement;
  /** The 56 px ring the fire burns in; its centre is the strike. The engine sets ring.dataset.shore = 'lit' at the strike. */
  ring: HTMLElement;
  /** 'catching': play the moment once. 'lit': it played for this signature already: the rest, at once. 'ember': a sale. */
  state: ShoreState;
  /** The wallet: its light's own place on the shore, the same place every time it buys. */
  wallet: string;
  /** The coin's holders as the island counts them (this coin's room_holders on the wallet's reading), or null. */
  holders: number | null;
  /** prefers-reduced-motion: no screen-wide wash, fewer and shorter sparks, the fire held to the ring, no loop at rest. */
  reduced: boolean;
  /** The venue's tick(): at the strike, at the landing, on each of the three beats. */
  onTick?: () => void;
  /** Once, when the light lands (the line under the title shows). */
  onLanded?: () => void;
  /** Each of the three beats (warm the card's edge for 240 ms). */
  onBeat?: (n: number) => void;
}
type Sprite = HTMLCanvasElement;
interface Light { x: number; y: number; r: number; th: number; w: number; far: boolean; wob: number }
interface You { x: number; y: number; th: number; w: number; landed: boolean; cold: boolean; t0: number }
interface Body { x: number; y: number; vx: number; vy: number; life: number; max: number; sz: number; sd: number; c: number }
interface Spark { x: number; y: number; px?: number; py?: number; vx: number; vy: number; life: number; max: number; w: number }
interface Ember { x: number; y: number; vx: number; vy: number; life: number; max: number; sd: number }
interface Ripple { x: number; y: number; t0: number; v: number; a: number }
const MAX_LIGHTS = 54;
const FLY_AT = 0.78; // seconds after the strike
const LAND_AT = 1.5;
const BEATS = 3;
const REST_BREATH_S = 3.4; // the lantern's breath
const WAVE_PX_S = 380; // how fast the shore takes the beat, outward from the landed light
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function sprite(r: number, stops: [number, string][]): Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = r * 2;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, color] of stops) gr.addColorStop(at, color);
  g.fillStyle = gr;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}
type SpriteName = 'white' | 'core' | 'edge' | 'deep' | 'halo' | 'flash' | 'green' | 'gHalo' | 'cold';
let SP: Record<SpriteName, Sprite> | null = null;
function sprites(): Record<SpriteName, Sprite> {
  // The island's fire (its design tokens: fire-white, fire-core, fire-edge, fire-fade) and Bayla's green for the shore.
  return (SP ??= {
    white: sprite(32, [[0, 'rgba(255,252,236,1)'], [0.3, 'rgba(255,243,196,.9)'], [1, 'rgba(255,243,196,0)']]),
    core: sprite(32, [[0, 'rgba(255,214,140,.95)'], [0.42, 'rgba(255,199,107,.55)'], [1, 'rgba(255,170,80,0)']]),
    edge: sprite(32, [[0, 'rgba(255,150,60,.8)'], [0.45, 'rgba(255,138,42,.38)'], [1, 'rgba(255,110,30,0)']]),
    deep: sprite(32, [[0, 'rgba(255,96,32,.6)'], [0.5, 'rgba(230,70,24,.22)'], [1, 'rgba(200,50,20,0)']]),
    halo: sprite(96, [[0, 'rgba(255,170,80,.42)'], [0.35, 'rgba(255,130,45,.14)'], [1, 'rgba(255,110,30,0)']]),
    flash: sprite(96, [[0, 'rgba(255,255,245,1)'], [0.2, 'rgba(255,243,196,.75)'], [0.55, 'rgba(255,199,107,.2)'], [1, 'rgba(255,170,80,0)']]),
    green: sprite(32, [[0, 'rgba(240,255,236,1)'], [0.22, 'rgba(150,255,140,.95)'], [0.55, 'rgba(130,255,120,.28)'], [1, 'rgba(130,255,120,0)']]),
    gHalo: sprite(64, [[0, 'rgba(130,255,120,.5)'], [0.4, 'rgba(130,255,120,.12)'], [1, 'rgba(130,255,120,0)']]),
    cold: sprite(32, [[0, 'rgba(255,214,170,.7)'], [0.3, 'rgba(255,150,80,.35)'], [1, 'rgba(255,120,50,0)']]),
  });
}
function blit(c: CanvasRenderingContext2D, img: Sprite, x: number, y: number, r: number, a: number): void {
  if (a <= 0.004 || r <= 0.2) return;
  c.globalAlpha = Math.min(1, a);
  c.drawImage(img, x - r, y - r, r * 2, r * 2);
}
function blit2(c: CanvasRenderingContext2D, img: Sprite, x: number, y: number, rx: number, ry: number, a: number): void {
  if (a <= 0.004 || rx <= 0.2) return;
  c.globalAlpha = Math.min(1, a);
  c.drawImage(img, x - rx, y - ry, rx * 2, ry * 2);
}
const ease = (x: number): number => { x = Math.max(0, Math.min(1, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export function startShoreMoment(o: ShoreMomentOptions): () => void {
  const sp = sprites();
  const sctx = o.shore.getContext('2d');
  const fctx = o.fx.getContext('2d');
  if (!sctx || !fctx) return () => {};
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rnd = seeded(hash(o.wallet + ':' + Date.now()));
  let W = 0, H = 0, SW = 0, SH = 0;
  const size = (): void => {
    W = window.innerWidth; H = window.innerHeight;
    o.fx.width = Math.round(W * dpr); o.fx.height = Math.round(H * dpr);
    const r = o.shore.getBoundingClientRect();
    SW = r.width; SH = r.height;
    o.shore.width = Math.round(SW * dpr); o.shore.height = Math.round(SH * dpr);
  };
  size();
  // ── The shore ──
  const shoreY = (x: number): number => SH * 0.52 + Math.sin((x / SW) * Math.PI * 1.25 + 0.5) * SH * 0.035 - Math.cos((x / SW) * Math.PI * 3.1) * SH * 0.012;
  const place = seeded(hash('shore-of-the-island')); // the shore's own layout: the same shore on every card
  const n = o.holders == null ? MAX_LIGHTS : Math.max(1, Math.min(MAX_LIGHTS, o.holders));
  const lights: Light[] = [];
  for (let i = 0; i < n; i++) {
    const x = 14 + ((SW - 28) * (i + 0.5 * place())) / n + (place() - 0.5) * 5;
    const far = place() < 0.62;
    lights.push({ x, y: shoreY(x) + (far ? -1.5 - place() * 2.5 : 1 + place() * 2.5), r: far ? 1.3 + place() * 0.8 : 2.0 + place() * 1.1,
      th: place() * Math.PI * 2, w: Math.PI * 2 * (0.42 + place() * 0.5), far, wob: place() * 6.28 });
  }
  const stars = Array.from({ length: 46 }, () => ({ x: place() * SW, y: place() * SH * 0.4, r: 0.4 + place() * 0.8, p: place() * 6.28, s: 0.5 + place() * 1.6 }));
  // The wallet's own place: the same every time it buys (never the middle, where the fire rises).
  let ux = 30 + ((hash(o.wallet) % 1000) / 1000) * (SW - 60);
  if (Math.abs(ux - SW / 2) < 34) ux += ux < SW / 2 ? -40 : 40;
  const you: You = { x: ux, y: shoreY(ux) - 1, th: 0, w: Math.PI * 2 * 1.05, landed: false, cold: o.state === 'ember', t0: 0 };
  const ripples: Ripple[] = [];
  const S = { t: 0, rest: 0, sync: 0 };
  const M = { pulses: 0, lastPeak: false, beat: 0, bloomAt: null as number | null, restAt: null as number | null, struck: false };
  const flame: Body[] = [], sparks: Spark[] = [], embers: Ember[] = [], trail: { x: number; y: number }[] = [];
  let gust = 0;
  // A card raised again for a signature that already caught, or a sale: the rest, at once.
  if (o.state !== 'catching') {
    you.landed = true; you.t0 = -5; M.struck = true;
    if (o.state === 'lit') { S.rest = 1; S.sync = 1; you.w = (Math.PI * 2) / REST_BREATH_S; o.ring.dataset.shore = 'lit'; }
  }
  const ringXY = () => { const r = o.ring.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.58 }; };
  const shoreToScreen = () => { const r = o.shore.getBoundingClientRect(); return { x: r.left + you.x, y: r.top + you.y }; };
  const intensity = (s: number): number => {
    if (o.state === 'ember') return 0;
    if (o.state === 'lit') return 0.28 + 0.03 * Math.sin(s * 3.1);
    if (s < 0) return 0;
    let I: number;
    if (s < 0.09) I = 1.7 * (s / 0.09);
    else if (s < 0.5) I = 1.7 - 0.6 * ((s - 0.09) / 0.41);
    else if (s < 1.5) I = 1.1 - 0.82 * ease((s - 0.5) / 1.0);
    else I = 0.28 + 0.03 * Math.sin(s * 3.1) + M.beat * 0.5; // the fire flares with each beat of the shore
    return o.reduced ? Math.min(I, 0.45) : I; // reduced motion: the fire stays in the ring
  };
  const strike = (at: { x: number; y: number }): void => {
    o.onTick?.();
    o.ring.dataset.shore = 'lit';
    const count = o.reduced ? 14 : 46;
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI / 2 + (rnd() - 0.5) * Math.PI * 1.25, sp0 = (o.reduced ? 120 : 260) + rnd() * (o.reduced ? 220 : 760);
      sparks.push({ x: at.x, y: at.y, vx: Math.cos(ang) * sp0, vy: Math.sin(ang) * sp0, life: 0, max: (o.reduced ? 0.3 : 0.55) + rnd() * (o.reduced ? 0.3 : 0.8), w: 1 + rnd() * 1.4 });
    }
  };
  const stepFire = (dt: number, s: number, at: { x: number; y: number }): number => {
    const I = intensity(s);
    M.beat = Math.max(0, M.beat - dt * 2.6);
    gust += dt * (7 + 5 * Math.min(1.5, I));
    // A flame is wide at its foot and licks to a point: bodies spawn across the base, near the axis most of all.
    let spawn = I * 6.2 * (dt * 60);
    const base = 7 + 19 * Math.min(1.6, I);
    while (spawn > 0) {
      if (spawn < 1 && rnd() > spawn) break;
      spawn -= 1;
      const off = ((rnd() + rnd() + rnd() - 1.5) / 1.5) * base;
      flame.push({ x: at.x + off, y: at.y + 4, vx: off * 0.6, vy: -(70 + 230 * I) * (0.7 + rnd() * 0.55),
        life: 0, max: 0.3 + rnd() * 0.38 + 0.12 * Math.min(1, I), sz: (8 + rnd() * 11) * (0.5 + 0.5 * Math.min(1.5, I)), sd: rnd() * 100, c: Math.abs(off) / base });
    }
    for (let i = flame.length - 1; i >= 0; i--) {
      const p = flame[i]!;
      p.life += dt;
      if (p.life > p.max) { flame.splice(i, 1); continue; }
      const hgt = Math.max(0, at.y - p.y);
      // The body sways as one (a slow wave up the flame), each tongue flickers on its own, everything leans in to a point.
      const sway = Math.sin(hgt * 0.045 - gust) * (20 + hgt * 0.75) + Math.sin(p.sd + p.life * 21) * 22;
      p.vx += (sway - p.vx * 3.2 + (at.x - p.x) * (5 + hgt * 0.07)) * dt;
      p.vy -= (120 + 120 * I) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let j = sparks.length - 1; j >= 0; j--) {
      const k = sparks[j]!;
      k.life += dt;
      if (k.life > k.max) { sparks.splice(j, 1); continue; }
      k.px = k.x; k.py = k.y;
      k.vy += 1250 * dt; k.vx *= 1 - 0.9 * dt; k.vy *= 1 - 0.5 * dt;
      k.x += k.vx * dt; k.y += k.vy * dt;
    }
    // Embers: a few thrown off the tongues, carried by the sea breeze.
    if (o.state !== 'ember' && s > 0.05 && rnd() < (0.06 + I * 0.32) * dt * 60) {
      embers.push({ x: at.x + (rnd() - 0.5) * 16, y: at.y - 20 - 70 * Math.min(1.4, I) * rnd(), vx: (rnd() - 0.35) * 60, vy: -(30 + rnd() * 80 + 90 * I), life: 0, max: 0.9 + rnd() * 1.2, sd: rnd() * 6 });
    }
    for (let e = embers.length - 1; e >= 0; e--) {
      const m = embers[e]!;
      m.life += dt;
      if (m.life > m.max) { embers.splice(e, 1); continue; }
      m.vx += (22 - m.vx * 0.4) * dt;
      m.x += (m.vx + Math.sin(m.sd + m.life * 4.1) * 30) * dt; m.y += m.vy * dt; m.vy *= 1 - 0.6 * dt;
    }
    return I;
  };
  const drawFire = (s: number, at: { x: number; y: number }, I: number): void => {
    const c = fctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H); c.globalCompositeOperation = 'lighter';
    // The strike: one white flash that throws its light for a breath (no wash under reduced motion).
    const fl = o.state === 'catching' && s >= 0 ? Math.exp(-s / 0.07) : 0;
    if (fl > 0.01) {
      blit(c, sp.flash, at.x, at.y, (o.reduced ? 30 : 50) + (o.reduced ? 60 : 170) * fl, fl);
      if (!o.reduced) { c.globalAlpha = 0.05 * fl; c.fillStyle = '#ffd9a0'; c.fillRect(0, 0, W, H); }
    }
    if (I > 0) blit(c, sp.halo, at.x, at.y - 34 * Math.min(1.4, I), 46 + 110 * Math.min(1.4, I), 0.42 + 0.25 * Math.min(1, I));
    // Each body: born white at the heart of the foot, the core's gold as it climbs, the edge's orange, then red as it goes out.
    for (const p of flame) {
      const a = p.life / p.max;
      const heart = a < 0.14 && p.c < 0.45;
      const img = heart ? sp.white : a < 0.42 ? sp.core : a < 0.75 ? sp.edge : sp.deep;
      const r = p.sz * (0.85 + 0.6 * a) * (1 - 0.7 * a * a);
      const al = Math.min(1, a / 0.06) * Math.pow(1 - a, 1.1) * (heart ? 0.9 : a < 0.42 ? 0.72 : 0.6) * (0.84 + 0.16 * Math.sin(p.sd * 7 + p.life * 46));
      blit2(c, img, p.x, p.y, r * 0.74, r * (1.12 + 0.5 * a), al);
    }
    c.lineCap = 'round';
    for (const k of sparks) {
      if (k.px == null || k.py == null) continue;
      const q = k.life / k.max;
      c.globalAlpha = Math.pow(1 - q, 1.4);
      c.strokeStyle = q < 0.25 ? '#fffbe8' : q < 0.6 ? '#ffc76b' : '#ff8a2a';
      c.lineWidth = k.w * (1 - q * 0.5);
      c.beginPath(); c.moveTo(k.px - (k.x - k.px) * 1.6, k.py - (k.y - k.py) * 1.6); c.lineTo(k.x, k.y); c.stroke();
    }
    for (const m of embers) { const u = m.life / m.max; blit(c, sp.core, m.x, m.y, 2.2 + 1.5 * (1 - u), (1 - u) * 0.9 * (0.6 + 0.4 * Math.sin(m.life * 14 + m.sd))); }
    // The light that flies home: from the fire's tip to its place on the shore.
    if (o.state === 'catching' && s >= FLY_AT && s < LAND_AT) {
      const ef = ease((s - FLY_AT) / (LAND_AT - FLY_AT));
      const from = { x: at.x, y: at.y - (o.reduced ? 60 : 120) }, to = shoreToScreen();
      const cx = (from.x + to.x) / 2 + (to.x - from.x) * 0.1, cy = Math.min(from.y, to.y) - (o.reduced ? 40 : 90);
      const x = (1 - ef) * (1 - ef) * from.x + 2 * (1 - ef) * ef * cx + ef * ef * to.x;
      const y = (1 - ef) * (1 - ef) * from.y + 2 * (1 - ef) * ef * cy + ef * ef * to.y;
      trail.push({ x, y }); if (trail.length > 16) trail.shift();
      trail.forEach((tp, i) => { const w = i / trail.length; blit(c, sp.green, tp.x, tp.y, 3 + 7 * w, 0.12 + 0.5 * w * w); });
      blit(c, sp.gHalo, x, y, 30, 0.7); blit(c, sp.green, x, y, 11, 1); blit(c, sp.white, x, y, 4, 1);
    } else trail.length = 0;
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  };
  // A light's brightness: a firefly's blink while it runs alone; once the shore has answered, a breath with a floor.
  const lum = (th: number): number => { const v = 0.5 + 0.5 * Math.cos(th), flash = Math.pow(v, 5), breath = 0.24 + 0.76 * v * v; return flash + (breath - flash) * S.rest; };
  const drawLight = (c: CanvasRenderingContext2D, L: Light, t: number): void => {
    const b = lum(L.th), wob = Math.sin(t * 1.3 + L.wob) * 0.4;
    const a = (L.far ? 0.12 : 0.16) + (L.far ? 0.6 : 0.84) * b;
    blit(c, sp.green, L.x, L.y, L.r * (1.5 + 1.8 * b), a);
    if (b > 0.4) { c.globalAlpha = Math.min(1, (b - 0.4) * 1.8); c.fillStyle = '#f4fff2'; const cr = L.far ? 0.6 : 0.85; c.fillRect(L.x - cr, L.y - cr, cr * 2, cr * 2); }
    c.save(); c.translate(L.x + wob, L.y + 4 + L.r * 1.5); c.scale(0.3, 1.5); blit(c, sp.green, 0, 0, L.r * (1.3 + 1.2 * b), 0.04 + 0.1 * b * (L.far ? 0.7 : 1)); c.restore();
  };
  const drawYou = (c: CanvasRenderingContext2D, t: number): void => {
    if (you.cold) { // Cooling, not gone: an ember's amber, its ring still on the water.
      const cb = 0.55 + 0.25 * Math.sin(t * 1.4);
      blit(c, sp.cold, you.x, you.y, 9, 0.6 * cb + 0.2); blit(c, sp.core, you.x, you.y, 2.4, 0.8);
      c.globalAlpha = 0.35; c.strokeStyle = 'rgba(255,170,90,1)'; c.lineWidth = 0.9;
      c.beginPath(); c.ellipse(you.x, you.y + 2.5, 9, 2.6, 0, 0, Math.PI * 2); c.stroke();
      c.save(); c.translate(you.x, you.y + 9); c.scale(0.5, 3); blit(c, sp.cold, 0, 0, 4, 0.18); c.restore();
      return;
    }
    const b = lum(you.th), land = Math.max(0, 1 - (t - you.t0) / 0.9), wob = Math.sin(t * 1.3) * 0.4;
    const R = 5 + 8 * b + 22 * land, A = 0.7 + 0.3 * b;
    blit(c, sp.gHalo, you.x, you.y, R * 2.1, 0.5 * A + 0.4 * land);
    blit(c, sp.green, you.x, you.y, R, A);
    blit(c, sp.white, you.x, you.y, 2.4 + 2 * b, 0.95);
    // Yours carries a thin ring on the water, so you can always find it.
    c.globalAlpha = 0.28 + 0.3 * b; c.strokeStyle = 'rgba(150,255,140,1)'; c.lineWidth = 0.9;
    c.beginPath(); c.ellipse(you.x, you.y + 2.5, 9 + 2 * b, 2.6 + 0.6 * b, 0, 0, Math.PI * 2); c.stroke();
    c.save(); c.translate(you.x + wob, you.y + 9); c.scale(0.5, 3.2); blit(c, sp.green, 0, 0, 4 + 3 * b, 0.24 + 0.22 * b); c.restore();
  };
  const drawPalm = (c: CanvasRenderingContext2D, x: number, y: number, s: number): void => {
    c.save(); c.translate(x, y); c.scale(s, s); c.strokeStyle = '#020605'; c.lineCap = 'round';
    c.lineWidth = 2.2; c.beginPath(); c.moveTo(0, 8); c.quadraticCurveTo(2, -6, -3, -20); c.stroke();
    c.lineWidth = 1.8;
    for (const f of [[-3, -20, -16, -17, -22, -10], [-3, -20, -12, -27, -21, -27], [-3, -20, 4, -29, 12, -26], [-3, -20, 9, -19, 15, -12], [-3, -20, -2, -30, -7, -33]] as const) {
      c.beginPath(); c.moveTo(f[0], f[1]); c.quadraticCurveTo(f[2], f[3], f[4], f[5]); c.stroke();
    }
    c.restore();
  };
  const drawShore = (t: number): void => {
    const c = sctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    // Night over the water: green black, a breath of Bayla's light on the horizon.
    const g = c.createLinearGradient(0, 0, 0, SH);
    g.addColorStop(0, '#04090c'); g.addColorStop(0.45, '#081612'); g.addColorStop(0.53, '#0c1f18'); g.addColorStop(0.56, '#050c0c'); g.addColorStop(1, '#03070a');
    c.fillStyle = g; c.fillRect(0, 0, SW, SH);
    const hz = c.createRadialGradient(SW * 0.5, SH * 0.53, 0, SW * 0.5, SH * 0.53, SW * 0.7);
    hz.addColorStop(0, `rgba(130,255,120,${0.07 + 0.05 * S.sync})`); hz.addColorStop(1, 'rgba(130,255,120,0)');
    c.fillStyle = hz; c.fillRect(0, 0, SW, SH);
    for (const s of stars) { c.globalAlpha = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * s.s + s.p)); c.fillStyle = '#e8f6ff'; c.fillRect(s.x, s.y, s.r, s.r); }
    // The far land, low and dark, the lights at its foot; a palm on the far point.
    c.globalAlpha = 1; c.fillStyle = '#020605'; c.beginPath(); c.moveTo(0, shoreY(0) - 5);
    for (let x = 0; x <= SW; x += 6) c.lineTo(x, shoreY(x) - 4 - 7 * Math.max(0, Math.sin((x / SW) * Math.PI * 2.2 + 1.1)) - 3 * Math.sin(x * 0.11));
    c.lineTo(SW, shoreY(SW) + 1); c.lineTo(0, shoreY(0) + 1); c.closePath(); c.fill();
    drawPalm(c, SW * 0.86, shoreY(SW * 0.86) - 9, 0.9);
    // The water: slow lines that catch the lights.
    for (let k = 0; k < 9; k++) {
      const yy = shoreY(SW / 2) + 8 + k * k * 1.15 + 2;
      if (yy > SH) break;
      c.strokeStyle = `rgba(150,255,195,${0.035 - k * 0.003})`; c.lineWidth = 1; c.beginPath();
      for (let xx = 0; xx <= SW; xx += 8) { const yw = yy + Math.sin(xx * 0.05 + t * (0.7 + k * 0.1) + k) * (0.8 + k * 0.25); if (xx === 0) c.moveTo(xx, yw); else c.lineTo(xx, yw); }
      c.stroke();
    }
    c.globalCompositeOperation = 'lighter';
    // Each beat blooms along the water from the landed light.
    if (M.bloomAt != null) {
      const ba = t - M.bloomAt;
      if (ba < 0.9) {
        const bk = Math.pow(1 - ba / 0.9, 2);
        c.save(); c.translate(you.x, you.y); c.scale(1, 0.16); blit(c, sp.gHalo, 0, 0, 40 + ba * 420, 0.55 * bk); c.restore();
        const hb = c.createLinearGradient(0, you.y - 26, 0, you.y + 26);
        hb.addColorStop(0, 'rgba(130,255,120,0)'); hb.addColorStop(0.5, `rgba(130,255,120,${(0.16 * bk).toFixed(3)})`); hb.addColorStop(1, 'rgba(130,255,120,0)');
        c.globalAlpha = 1; c.fillStyle = hb; c.fillRect(0, you.y - 26, SW, 52);
      }
    }
    for (const L of lights) drawLight(c, L, t);
    if (you.landed) drawYou(c, t);
    for (let r = ripples.length - 1; r >= 0; r--) {
      const rp = ripples[r]!, age = t - rp.t0;
      if (age > 1.6) { ripples.splice(r, 1); continue; }
      c.strokeStyle = `rgba(130,255,120,${((1 - age / 1.6) * rp.a).toFixed(3)})`; c.lineWidth = 1.2; c.globalAlpha = 1;
      c.beginPath(); c.ellipse(rp.x, rp.y + 3, 6 + age * rp.v, (6 + age * rp.v) * 0.22, 0, 0, Math.PI * 2); c.stroke();
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  };
  // The shore answers: once the light lands, the others take its beat, nearest first, until the whole shore pulses with it.
  const stepShore = (dt: number, s: number): void => {
    if (!you.landed || o.state === 'ember') { for (const L of lights) L.th += L.w * dt; if (you.landed) you.th += you.w * dt; return; }
    you.th += you.w * dt;
    const since = o.state === 'lit' ? 99 : s - LAND_AT;
    for (const L of lights) {
      const d = Math.abs(L.x - you.x) + Math.abs(L.y - you.y) * 2;
      const on = Math.max(0, Math.min(1, (since - d / WAVE_PX_S) / 0.28));
      const lag = S.rest * d * 0.016; // at rest the breath runs out from the landed light as a wave, never one band
      const target = you.th - lag;
      const diff = Math.atan2(Math.sin(target - L.th), Math.cos(target - L.th));
      L.th += (L.w + (you.w - L.w) * on + 10 * on * Math.sin(diff)) * dt;
    }
    if (o.state === 'lit') return;
    S.sync = Math.max(0, Math.min(1, (since - 0.55) / 0.6));
    const peak = Math.cos(you.th) > 0.985;
    if (peak && !M.lastPeak && since > 0.55 && M.pulses < BEATS) {
      M.pulses++; M.beat = 1; M.bloomAt = S.t;
      o.onTick?.(); o.onBeat?.(M.pulses);
      ripples.push({ x: you.x, y: you.y, t0: S.t, v: 110, a: 0.55 });
      if (M.pulses === BEATS) M.restAt = s + 0.35;
    }
    M.lastPeak = peak;
    // Rest: the shore keeps the beat, slowed to the lantern's breath.
    if (M.restAt != null && s > M.restAt) {
      const r = Math.min(1, (s - M.restAt) / 1.4);
      you.w = Math.PI * 2 * (1.05 + (1 / REST_BREATH_S - 1.05) * r); S.rest = r;
    }
  };
  let raf = 0, last: number | null = null, stopped = false;
  const tick = (dt: number): boolean => {
    S.t += dt;
    const s = S.t; // seconds since the strike: the caller starts the engine the moment the card is up
    const at = ringXY();
    if (o.state === 'catching' && !M.struck && s >= 0) { M.struck = true; strike(at); }
    if (o.state === 'catching' && !you.landed && s >= LAND_AT) {
      you.landed = true; you.t0 = S.t; you.th = 0;
      ripples.push({ x: you.x, y: you.y, t0: S.t, v: 70, a: 0.9 });
      o.onTick?.(); o.onLanded?.();
    }
    const I = stepFire(dt, s, at);
    stepShore(dt, s);
    drawShore(S.t);
    drawFire(s, at, I);
    // Reduced motion: once the third beat has settled (at once for a card raised again or a sale) the loop stops;
    // the canvas fire clears and the ring's CSS flame (data-shore="lit") holds the fire, still.
    if (o.reduced && (o.state !== 'catching' || S.rest >= 1)) {
      fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, o.fx.width, o.fx.height);
      return false;
    }
    return true;
  };
  const frame = (now: number): void => {
    if (stopped) return;
    if (last == null) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (tick(dt)) raf = requestAnimationFrame(frame);
  };
  const onResize = (): void => { size(); };
  window.addEventListener('resize', onResize);
  raf = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    fctx.clearRect(0, 0, o.fx.width, o.fx.height);
  };
}
