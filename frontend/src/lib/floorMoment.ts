/**
 * THE FLASH (island answer thirty-two, the owner's word 11-07): the seconds after an add of liquidity, any token.
 *
 * Adding liquidity is pouring two liquids into one pool, so the card's head becomes the pool itself, seen from
 * just under its surface. The pool's pairing coin pours in from one side in its own color (SOL's green, USDC's blue,
 * an island coin's hue: `pourOf`), the token from the other, in its own hue. The two
 * colors wind into each other in the water. Where they meet a bubble forms, iridescent, and the pool's tone
 * holds it: it breathes faster and faster (ticks quickening), the pool darkens around it and swallows its
 * colors, it collapses to a point, and the point is a star inside the water: the flash, a streak across the
 * card, rays, the spectrum shock ring, every brick on the floor throwing a hard shadow. The light condenses
 * into a brick of light that sinks, wobbling, to the pool's floor, and the floor is the bricks of every LP
 * before you. Yours lands among them, bubbles rise, light runs across the floor from your brick out, the hues
 * drift. Rest: your brick glows on the floor. Sonoluminescence: sound making light inside a liquid. Here the
 * pool is the liquid, the signature is the sound, and the floor is what LPs are. No flame anywhere in it.
 *
 * Framework free: two canvases and the ring element in, one stop function out. The island's own page
 * (the-flash v2, the owner's "Great" 11-07 11:52 PM) is this code with a stand-in card around it.
 */
export type FloorState =
  /** Play the moment once, for this signature. */
  | 'playing'
  /** It played for this signature already (Bayla's Receipt raising the same card): the rest, at once, nothing moves. */
  | 'lit';
export interface FloorMomentOptions {
  /** The card's head: a canvas across the card's full width, 214 px tall, inside its top corners. */
  head: HTMLCanvasElement;
  /** A fixed canvas over the whole screen (inset 0, pointer-events none) above the card: the pour and the flash leave the card. */
  fx: HTMLCanvasElement;
  /** The 56 px ring on the head's bottom edge. The engine sets ring.dataset.floor = 'lit' at the flash: the ring then holds the pool's light (CSS), never a flame. */
  ring: HTMLElement;
  state: FloorState;
  /** The wallet: its brick's own socket on the floor, the same socket every time it adds to this pool. */
  wallet: string;
  /** The token's symbol as the venue prints it: its hue comes from it ($BAYLA keeps Bayla's green). */
  symbol: string;
  /** The pool's pairing coin by its ticker, as the receipt names it (SOL, USDC or an island coin): the pour's other stream takes its color (`pourOf`). Absent: SOL. */
  pairing?: string | null;
  /** How many wallets hold a share of this pool (holders.ts), when known: that many bricks are laid on the floor besides yours. Null: the floor is bedrock and yours. */
  lps: number | null;
  /** prefers-reduced-motion: no screen-wide wash, a shorter pour, fewer bubbles, and once the third beat settles the loop stops; the rest is a still. */
  reduced: boolean;
  /** The venue's tick(): at the pour's two hits, each breath of the bubble (quickening), the flash (the strongest), the landing, each of the three beats. The number is a weight, 5 to 22. */
  onTick?: (weight: number) => void;
  /** The flash: the card's edge goes white for 120 ms (a class on the card), then lit in the token's hue. */
  onFlash?: () => void;
  /** The landing: the line under the title shows ("You're part of $COIN's floor now. Every trade in the pool pays you."). */
  onLanded?: () => void;
  /** Each of the three beats, 1 to 3: the card's edge flares for 240 ms. */
  onBeat?: (n: number) => void;
}
export interface FloorMoment {
  /** Stop drawing and clear the fx canvas. Call on unmount or close. */
  stop: () => void;
  /** The pool's LP count arrived after the start (the read is two RPC calls): the floor takes it before the landing; after the landing it is kept for a card raised again. */
  setLps: (n: number | null) => void;
}
type RGB = [number, number, number];
interface Hue { h: number; rgb: RGB; mid: RGB; heart: RGB }
interface Brick { x: number; y: number; w: number; h: number; r: number; c: number; laid: boolean; grain: number; tone: number; you: boolean; k: number }
interface Blob { x: number; y: number; vx: number; vy: number; r0: number; r1: number; life: number; max: number; a: number; img: HTMLCanvasElement }
interface Bubble { x: number; y: number; r: number; v: number; p: number }
interface Ripple { x: number; t0: number; v: number; a: number; life: number }
interface Shock { x: number; y: number; t0: number; v: number; life: number }
interface Mote { x: number; y: number; r: number; v: number; p: number; a: number }
// ── The times, seconds after the pour begins ──
const T = { pour: 0, hit: 0.42, bubble: 0.95, collapse: 2.35, flash: 2.5, brick: 2.66, land: 3.72, wave: 150 } as const;
const SURF = 30, FLOOR_Y = 118, CX = 179, BUB = { x: 179, y: 90 };
// The floor seen from above: the back row small and far, the front row large and near (a pool's bottom, not a wall).
const ROWSPEC = [{ y: 118, h: 9, w: 27, m: 2 }, { y: 129, h: 12, w: 34, m: 2.5 }, { y: 143.5, h: 16, w: 43, m: 3 }, { y: 162.5, h: 21, w: 54, m: 3.5 }, { y: 187, h: 27, w: 67, m: 4 }];
/** The pairing coin's stream: its light, the lighter `mid` of its stream, the `deep` of its blobs in the water, and its point of light (`heart`, `pointMid`). */
interface Pour { rgb: RGB; mid: RGB; heart: RGB; deep: RGB; pointMid: RGB }
const SOL: Pour = { rgb: [20, 241, 149], mid: [90, 200, 230], heart: [220, 255, 245], deep: [58, 123, 213], pointMid: [90, 230, 200] };
const DOLLARS: Record<string, { rgb: RGB; mid: RGB; heart: RGB }> = {
  USDC: { rgb: [39, 117, 202], mid: [96, 165, 250], heart: [226, 240, 255] },
  USDT: { rgb: [38, 161, 123], mid: [80, 200, 160], heart: [225, 250, 240] },
};
function hash(s: string): number { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function clamp(x: number, a: number, b: number): number { return Math.max(a, Math.min(b, x)); }
function easeOut(x: number): number { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); }
function easeIn(x: number): number { x = clamp(x, 0, 1); return x * x; }
function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
/** Every token gets its own hue from its name, so no two pools look alike; $BAYLA keeps Bayla's green (the island's bayla-glow). */
export function hueOf(symbol: string): Hue {
  const sym = symbol.toUpperCase();
  if (sym === 'BAYLA') return { h: 113, rgb: [130, 255, 120], mid: [150, 255, 140], heart: [234, 255, 230] };
  let h = hash('hue-' + sym) % 360; if (h > 95 && h < 135) h += 60;
  return { h, rgb: hsl(h, 92, 64), mid: hsl(h, 95, 74), heart: hsl(h, 100, 93) };
}
/**
 * The pour is what went in (island answer thirty-four): beside the token's stream, the pool's pairing coin in its own
 * color. No pairing named, or SOL: Solana's green, drawn as it always was. USDC and USDT: their own. Any other pairing
 * coin (an island coin): its hue as `hueOf` gives it, so a $BAYLA pairing pours Bayla's green.
 */
export function pourOf(pairing?: string | null): Pour {
  const sym = (pairing ?? 'SOL').toUpperCase();
  if (sym === 'SOL') return SOL;
  const c = DOLLARS[sym] ?? hueOf(sym);
  return { rgb: c.rgb, mid: c.mid, heart: c.heart, deep: [Math.round(c.rgb[0] * 0.6), Math.round(c.rgb[1] * 0.6), Math.round(c.rgb[2] * 0.6)], pointMid: c.mid };
}
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function infinity(ctx: CanvasRenderingContext2D, cx: number, cy: number, a: number, lw: number, color: string, alpha: number, blur: number): void {
  ctx.save(); ctx.translate(cx, cy); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  if (blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) { const t = i / 100 * Math.PI * 2, d = 1 + Math.sin(t) * Math.sin(t), x = a * Math.cos(t) / d, y = a * Math.sin(t) * Math.cos(t) / d; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke(); ctx.restore();
}
function sprite(r: number, stops: Array<[number, string]>): HTMLCanvasElement {
  const cv = document.createElement('canvas'); cv.width = cv.height = r * 2;
  const g = cv.getContext('2d'); if (!g) return cv;
  const gr = g.createRadialGradient(r, r, 0, r, r, r); for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr; g.fillRect(0, 0, r * 2, r * 2); return cv;
}
const soft = (rgb: RGB) => sprite(32, [[0, `rgba(${rgb},.85)`], [0.35, `rgba(${rgb},.35)`], [1, `rgba(${rgb},0)`]]);
const point = (heart: RGB, mid: RGB, rgb: RGB) => sprite(32, [[0, `rgba(${heart},1)`], [0.22, `rgba(${mid},.95)`], [0.55, `rgba(${rgb},.28)`], [1, `rgba(${rgb},0)`]]);
function blit(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number, r: number, a: number): void { if (a <= 0.004 || r <= 0.2) return; ctx.globalAlpha = Math.min(1, a); ctx.drawImage(img, x - r, y - r, r * 2, r * 2); }
export function startFloorMoment(o: FloorMomentOptions): FloorMoment {
  const hctx = o.head.getContext('2d'), fctx = o.fx.getContext('2d');
  if (!hctx || !fctx) return { stop: () => undefined, setLps: () => undefined }; // jsdom and the like: nothing to draw on
  const DPR = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const HUE = hueOf(o.symbol), POUR = pourOf(o.pairing);
  let seed = 1;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const SP = {
    flash: sprite(128, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(235,245,255,.95)'], [0.3, 'rgba(190,220,255,.55)'], [0.6, 'rgba(140,190,255,.16)'], [1, 'rgba(120,170,255,0)']]),
    white: sprite(32, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(240,248,255,.85)'], [1, 'rgba(230,240,255,0)']]),
    blue: soft([120, 170, 255]), solSoft: soft(POUR.rgb), solDeep: soft(POUR.deep), solPt: point(POUR.heart, POUR.pointMid, POUR.rgb),
    tok: soft(HUE.rgb), tokPt: point(HUE.heart, HUE.mid, HUE.rgb),
    tokHalo: sprite(64, [[0, `rgba(${HUE.rgb},.5)`], [0.4, `rgba(${HUE.rgb},.12)`], [1, `rgba(${HUE.rgb},0)`]]),
  };
  let W = 0, H = 0, HW = 358, HH = 214;
  let bricks: Brick[] = [], you: Brick | null = null, motes: Mote[] = [], bubbles: Bubble[] = [], blobs: Blob[] = [], ripples: Ripple[] = [], shock: Shock[] = [];
  const cache = document.createElement('canvas'), cctx = cache.getContext('2d');
  let lps = o.lps;
  function stone(ctx: CanvasRenderingContext2D, b: Brick, laid: boolean): void {
    const { x, y, w: BW, h: BH } = b, g = ctx.createLinearGradient(0, y, 0, y + BH);
    g.addColorStop(0, laid ? (b.tone < 0.5 ? '#1f2a33' : '#243038') : '#111920'); g.addColorStop(1, laid ? '#101820' : '#0a1016'); ctx.fillStyle = g; rrect(ctx, x, y, BW, BH, 2); ctx.fill();
    ctx.strokeStyle = laid ? 'rgba(200,230,255,.14)' : 'rgba(200,230,255,.05)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 1, y + BH - 1.5); ctx.lineTo(x + 1, y + 1.5); ctx.lineTo(x + BW - 1.5, y + 1.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.moveTo(x + 1.5, y + BH - 1); ctx.lineTo(x + BW - 1, y + BH - 1); ctx.lineTo(x + BW - 1, y + 1.5); ctx.stroke();
    const s0 = seed; seed = Math.floor(b.grain * 1e9) || 5;
    for (let i = 0; i < 28; i++) { const px = x + 2 + rnd() * (BW - 4), py = y + 2 + rnd() * (BH - 4); ctx.fillStyle = rnd() < 0.5 ? (laid ? 'rgba(220,240,255,.07)' : 'rgba(220,240,255,.03)') : 'rgba(0,0,0,.3)'; ctx.fillRect(px, py, 1 + rnd(), 1); }
    seed = s0;
  }
  function paintCache(): void {
    if (!cctx) return;
    cache.width = Math.round(HW * DPR); cache.height = Math.round(HH * DPR); cctx.setTransform(DPR, 0, 0, DPR, 0, 0); cctx.clearRect(0, 0, HW, HH);
    const fg = cctx.createLinearGradient(0, FLOOR_Y - 6, 0, HH); fg.addColorStop(0, '#060a10'); fg.addColorStop(1, '#080d13'); cctx.fillStyle = fg; cctx.fillRect(0, FLOOR_Y - 6, HW, HH - FLOOR_Y + 6);
    for (const b of bricks) { if (b.you) { cctx.fillStyle = '#04070a'; rrect(cctx, b.x, b.y, b.w, b.h, 2); cctx.fill(); continue; } stone(cctx, b, b.laid); }
  }
  // The floor: every laid brick a wallet holding a share of this pool (lps), the rest bedrock; yours from the wallet, the same socket every time.
  function buildPool(): void {
    seed = hash('pool-of-' + o.symbol.toUpperCase()) || 9; bricks = [];
    ROWSPEC.forEach((R, r) => { const pitch = R.w + R.m, off = (r % 2) ? pitch / 2 : 0, n = Math.ceil(HW / pitch) + 2;
      for (let c = -1; c < n; c++) { const x = CX - (n / 2) * pitch + c * pitch + off; if (x + R.w < 0 || x > HW) continue; bricks.push({ x, y: R.y, w: R.w, h: R.h, r, c, laid: false, grain: rnd(), tone: rnd(), you: false, k: 0 }); } });
    const open = bricks.filter((b) => b.r >= 2 && b.x > 6 && b.x + b.w < HW - 6);
    const mine = open[hash(o.wallet) % open.length]; if (!mine) return; mine.you = true; you = mine;
    layFloor();
    motes = []; for (let i = 0; i < 46; i++) motes.push({ x: rnd() * HW, y: SURF + rnd() * (FLOOR_Y - SURF), r: 0.5 + rnd() * 1.1, v: 3 + rnd() * 7, p: rnd() * 6.28, a: 0.2 + rnd() * 0.4 });
    bubbles = []; blobs = []; ripples = []; shock = [];
  }
  function layFloor(): void {
    seed = hash('lps-of-' + o.symbol.toUpperCase()) || 13;
    for (const b of bricks) b.laid = false;
    const want = Math.min(lps ?? 0, bricks.length - 1); let laid = 0, tries = 0;
    while (laid < want && tries < 2000) { tries++; const b = bricks[Math.floor(rnd() * bricks.length)]; if (!b || b.laid || b.you) continue; b.laid = true; laid++; }
    paintCache();
  }
  const surfY = (x: number, t: number): number => SURF + Math.sin(x * 0.045 + t * 1.1) * 1.6 + Math.sin(x * 0.11 - t * 1.7) * 0.8;
  const S = { t: 0 };
  interface Moment { t0: number; lead: number; hit: boolean; tickN: number; flashed: boolean; landed: boolean; landAt: number; pulses: number; said: boolean; ripOnce: boolean; stopped: boolean }
  let M: Moment | null = null;
  function drawHead(): void {
    const c = hctx!, T0 = HUE, s = M ? S.t - M.t0 - M.lead : -1;
    if (!you) return;
    c.setTransform(DPR, 0, 0, DPR, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    const flashed = s >= T.flash, since = s - T.flash, landed = s >= T.land, sinceLand = s - T.land;
    const fl = flashed ? Math.exp(-since / 0.26) : 0, fe = flashed ? Math.exp(-since / 0.55) : 0;
    const gather = s >= T.bubble && !flashed ? clamp((s - T.bubble) / 1.0, 0, 1) : 0;
    const pulse = landed && sinceLand > 0.2 && sinceLand < 2.4 ? Math.max(0, Math.cos((sinceLand - 0.2) / 0.733 * Math.PI * 2)) : 0;
    const rest = landed ? clamp((sinceLand - 2.4) / 1.2, 0, 1) : 0, breathe = rest * (0.5 + 0.5 * Math.cos((sinceLand - 2.4) / 3.4 * Math.PI * 2));
    const lit = landed ? clamp(sinceLand / 1.2, 0, 1) : 0, hueShift = landed ? (sinceLand - 0.2) * 28 : 0;
    // 1. The water, lit from the surface, dark at the floor; the token's light once the pool holds it, its hue drifting.
    const g = c.createLinearGradient(0, 0, 0, HH);
    g.addColorStop(0, `rgb(${hsl(200 + hueShift * 0.1, 50, 14 + 6 * lit)})`); g.addColorStop(0.18, `rgb(${hsl(205, 55, 10 + 4 * lit)})`); g.addColorStop(0.6, '#05101a'); g.addColorStop(1, '#02060b');
    c.fillStyle = g; c.fillRect(0, 0, HW, HH);
    if (lit > 0) {
      const hcl = hsl(T0.h + 34 * Math.sin(sinceLand * 0.7), 92, 62), tg = c.createRadialGradient(you.x + you.w / 2, you.y, 0, you.x + you.w / 2, you.y, 240);
      tg.addColorStop(0, `rgba(${hcl},${(0.3 * lit * (0.75 + 0.25 * pulse + 0.2 * breathe)).toFixed(3)})`); tg.addColorStop(1, `rgba(${hcl},0)`); c.fillStyle = tg; c.fillRect(0, 0, HW, HH);
      c.globalCompositeOperation = 'lighter';
      for (let ai = 0; ai < 3; ai++) { const ang = sinceLand * 0.45 + ai * 2.09, acol = hsl(T0.h + 50 * ai + hueShift, 95, 66), ax = you.x + you.w / 2 + Math.cos(ang) * 70, ay = you.y - 30 + Math.sin(ang) * 14;
        const ag = c.createRadialGradient(ax, ay, 0, ax, ay, 70); ag.addColorStop(0, `rgba(${acol},${(0.16 * lit).toFixed(3)})`); ag.addColorStop(1, `rgba(${acol},0)`); c.fillStyle = ag; c.fillRect(0, 0, HW, HH); }
      c.globalCompositeOperation = 'source-over';
    }
    // 2. Light from above: shafts that sway; motes.
    c.globalCompositeOperation = 'lighter'; c.save(); c.shadowColor = 'rgba(170,215,255,.9)'; c.shadowBlur = 18;
    for (let k = 0; k < 4; k++) { const sx = 40 + k * 90 + Math.sin(S.t * 0.25 + k) * 14, lg = c.createLinearGradient(0, SURF, 0, FLOOR_Y + 30); lg.addColorStop(0, `rgba(170,215,255,${(0.075 + 0.03 * lit).toFixed(3)})`); lg.addColorStop(1, 'rgba(170,215,255,0)');
      c.fillStyle = lg; c.globalAlpha = 1; c.beginPath(); c.moveTo(sx - 2, SURF); c.lineTo(sx + 14, SURF); c.lineTo(sx + 46 + 10 * Math.sin(S.t * 0.4 + k), FLOOR_Y + 30); c.lineTo(sx - 26, FLOOR_Y + 30); c.closePath(); c.fill(); }
    c.restore(); c.globalCompositeOperation = 'lighter';
    for (const m of motes) { let my = m.y - ((S.t * m.v) % (FLOOR_Y - SURF)); if (my < SURF) my += FLOOR_Y - SURF; c.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(S.t * 2 + m.p)); c.fillStyle = '#dceeff'; c.fillRect(m.x + Math.sin(S.t * 0.8 + m.p) * 3, my, m.r, m.r); }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    // 3. The floor: the still stone, the caustic net moving over it.
    c.drawImage(cache, 0, 0, cache.width, cache.height, 0, 0, HW, HH);
    c.globalCompositeOperation = 'lighter';
    for (let n = 0; n < 16; n++) { const ph = n * 0.9, depth = n / 16; c.strokeStyle = `rgba(200,230,255,${(0.07 + 0.05 * lit + 0.04 * pulse).toFixed(3)})`; c.lineWidth = 0.8 + depth * 1.2; c.beginPath();
      for (let xx = 0; xx <= HW; xx += 6) { const yy = FLOOR_Y - 2 + depth * depth * 100 + Math.sin(xx * (0.07 - 0.03 * depth) + S.t * 1.3 + ph) * (2 + 3 * depth) + Math.sin(xx * 0.023 - S.t * 0.9 + ph * 2) * (3 + 3 * depth); if (xx === 0) c.moveTo(xx, yy); else c.lineTo(xx, yy); } c.stroke(); }
    // 4. The pour: the two colors in the water, winding into each other.
    for (const bl of blobs) { const life = bl.life / bl.max; if (life >= 1) continue; blit(c, bl.img, bl.x, bl.y, bl.r0 + (bl.r1 - bl.r0) * easeOut(life), (1 - life) * bl.a); }
    // The surface from beneath, rippling where the streams hit and when the shock reaches it.
    c.globalAlpha = 1; c.strokeStyle = `rgba(210,235,255,${(0.5 + 0.3 * fl).toFixed(3)})`; c.lineWidth = 1.4; c.beginPath();
    for (let ux = 0; ux <= HW; ux += 4) { let uy = surfY(ux, S.t); for (const rp of ripples) { const age = S.t - rp.t0, d = Math.abs(ux - rp.x), R = age * rp.v; if (Math.abs(d - R) < 14) uy += Math.sin((d - R) * 0.45) * rp.a * Math.max(0, 1 - age / rp.life); } if (ux === 0) c.moveTo(ux, uy); else c.lineTo(ux, uy); } c.stroke();
    const sg = c.createLinearGradient(0, SURF - 2, 0, SURF + 26); sg.addColorStop(0, `rgba(200,230,255,${(0.16 + 0.1 * fl).toFixed(3)})`); sg.addColorStop(1, 'rgba(200,230,255,0)'); c.fillStyle = sg; c.fillRect(0, SURF - 2, HW, 28);
    // The gather: the pool goes dark around the bubble.
    if (gather > 0) { c.globalCompositeOperation = 'source-over'; const vg = c.createRadialGradient(BUB.x, BUB.y, 10, BUB.x, BUB.y, 300); vg.addColorStop(0, `rgba(2,5,12,${(0.2 * gather).toFixed(3)})`); vg.addColorStop(1, `rgba(2,5,12,${(0.72 * gather).toFixed(3)})`); c.fillStyle = vg; c.fillRect(0, 0, HW, HH); }
    // 5. The bubble: iridescent, held by the tone, breathing faster, its core brightening with what it swallows, then gone.
    if (s >= T.bubble && s < T.flash) {
      const bt = s - T.bubble, f = clamp(bt / (T.collapse - T.bubble), 0, 1), grow = easeOut(clamp(bt / 0.4, 0, 1)), base = 34 * grow, period = 0.9 - 0.78 * f;
      const osc = Math.sin(bt / period * Math.PI * 2 * (1 + f * 1.5)); let r = base * (1 + 0.2 * osc * (0.4 + f));
      if (s >= T.collapse) r = base * Math.max(0.03, 1 - (s - T.collapse) / (T.flash - T.collapse)) * 0.95;
      const bx = BUB.x, by = BUB.y;
      c.globalCompositeOperation = 'source-over'; const ig = c.createRadialGradient(bx - r * 0.2, by - r * 0.25, r * 0.1, bx, by, r); ig.addColorStop(0, 'rgba(255,255,255,.06)'); ig.addColorStop(0.8, 'rgba(200,230,255,.04)'); ig.addColorStop(1, 'rgba(255,255,255,.22)'); c.fillStyle = ig; c.beginPath(); c.arc(bx, by, r, 0, Math.PI * 2); c.fill();
      c.globalCompositeOperation = 'lighter';
      for (let hI = 0; hI < 9; hI++) { const hue = (hI * 40 + S.t * 160 + f * 300) % 360, col = hsl(hue, 95, 70); c.strokeStyle = `rgba(${col},${(0.6 + 0.3 * f).toFixed(3)})`; c.lineWidth = 1.8 + 0.8 * f; c.shadowColor = `rgb(${col})`; c.shadowBlur = 9; c.beginPath(); c.arc(bx, by, r, hI * Math.PI * 2 / 9 + S.t * 1.7, (hI + 1.15) * Math.PI * 2 / 9 + S.t * 1.7); c.stroke(); }
      c.shadowBlur = 0; c.globalAlpha = 0.35; c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = 0.8; c.beginPath(); c.arc(bx, by, r * 0.86, 0, Math.PI * 2); c.stroke();
      c.globalAlpha = 0.9; c.fillStyle = '#fff'; c.beginPath(); c.ellipse(bx - r * 0.42, by - r * 0.45, r * 0.16, r * 0.1, -0.6, 0, Math.PI * 2); c.fill();
      blit(c, SP.blue, bx, by, r * 2.2, 0.25 + 0.5 * f); blit(c, SP.tok, bx + r * 0.25, by + r * 0.2, r * 0.75, 0.5 * f); blit(c, SP.solSoft, bx - r * 0.25, by - r * 0.15, r * 0.7, 0.5 * f); blit(c, SP.white, bx, by, 3 + 9 * f * f, 0.25 + 0.6 * f); blit(c, SP.tokHalo, bx, by + r * 0.6, r * 1.6, 0.25 * f);
      if (s >= T.collapse) blit(c, SP.white, bx, by, 8 + 40 * (1 - r / 34), 0.95);
    }
    // 6. The flash: a star inside the water: rays, the streak across the card, the core, the spectrum shock ring, every brick's shadow, the floor lit from above.
    if (flashed) {
      c.globalCompositeOperation = 'lighter';
      c.save(); c.translate(BUB.x, BUB.y); c.rotate(since * 0.35);
      for (let ry2 = 0; ry2 < 14; ry2++) { c.rotate(Math.PI * 2 / 14); const rl = 200 + 90 * ((ry2 * 7) % 5) / 5, rg = c.createLinearGradient(0, 0, rl, 0); rg.addColorStop(0, `rgba(235,245,255,${(0.22 * fe).toFixed(3)})`); rg.addColorStop(1, 'rgba(235,245,255,0)'); c.fillStyle = rg; c.globalAlpha = 1; c.beginPath(); c.moveTo(0, 0); c.lineTo(rl, -rl * 0.045); c.lineTo(rl, rl * 0.045); c.closePath(); c.fill(); }
      c.restore();
      const stk = c.createLinearGradient(0, 0, HW, 0); stk.addColorStop(0, `rgba(${T0.rgb},0)`); stk.addColorStop(0.3, `rgba(${T0.mid},${(0.5 * fl).toFixed(3)})`); stk.addColorStop(0.5, `rgba(255,255,255,${(0.95 * fl).toFixed(3)})`); stk.addColorStop(0.7, `rgba(${T0.mid},${(0.5 * fl).toFixed(3)})`); stk.addColorStop(1, `rgba(${T0.rgb},0)`);
      c.globalAlpha = 1; c.fillStyle = stk; const sh2 = 1.5 + 7 * fl; c.fillRect(0, BUB.y - sh2 / 2, HW, sh2); c.fillRect(0, BUB.y - sh2 * 2.5, HW, sh2 * 5);
      const vst = c.createLinearGradient(0, BUB.y - 90, 0, BUB.y + 90); vst.addColorStop(0, 'rgba(255,255,255,0)'); vst.addColorStop(0.5, `rgba(255,255,255,${(0.7 * fl).toFixed(3)})`); vst.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = vst; c.fillRect(BUB.x - 1 - 2 * fl, BUB.y - 90, 2 + 4 * fl, 180);
      blit(c, SP.flash, BUB.x, BUB.y, 60 + 280 * (1 - Math.exp(-since / 0.12)), fl * 1.25); blit(c, SP.white, BUB.x, BUB.y, 16 + 14 * fl, fl); blit(c, SP.tokHalo, BUB.x, BUB.y, 110, fe * 0.9);
      c.globalAlpha = Math.min(1, fl * 1.5); c.fillStyle = '#eaf4ff'; c.fillRect(0, 0, HW, HH);
      for (const sh of shock) { const sa = S.t - sh.t0, R2 = sa * sh.v, al = Math.max(0, 1 - sa / sh.life); if (al <= 0) continue;
        c.globalAlpha = al * 0.9; c.strokeStyle = 'rgba(235,245,255,1)'; c.lineWidth = 2.2 * al + 0.5; c.beginPath(); c.arc(sh.x, sh.y, R2, 0, Math.PI * 2); c.stroke();
        for (let sp6 = 0; sp6 < 6; sp6++) { const scol = hsl(sp6 * 58, 100, 62); c.globalAlpha = al * 0.55; c.strokeStyle = `rgb(${scol})`; c.lineWidth = 2.4; c.beginPath(); c.arc(sh.x, sh.y, Math.max(0.5, R2 - 4 - sp6 * 3.2), 0, Math.PI * 2); c.stroke(); } }
      if (fe > 0.03) { c.globalCompositeOperation = 'source-over'; c.fillStyle = `rgba(0,4,10,${(0.6 * fe).toFixed(3)})`;
        for (const sb of bricks) { if (sb.you && !landed) continue; const sdx = sb.x + sb.w / 2 - BUB.x, sdy = sb.y + sb.h - BUB.y, sd = Math.hypot(sdx, sdy) || 1, ux = sdx / sd, uy = sdy / sd, L = (10 + 22 * (sb.r / 4)) * fe;
          c.beginPath(); c.moveTo(sb.x, sb.y + sb.h); c.lineTo(sb.x + sb.w, sb.y + sb.h); c.lineTo(sb.x + sb.w + ux * L, sb.y + sb.h + uy * L); c.lineTo(sb.x + ux * L, sb.y + sb.h + uy * L); c.closePath(); c.fill(); }
        c.globalCompositeOperation = 'lighter'; }
      if (fe > 0.02) for (const nb of bricks) { if (nb.you && !landed) continue; const d2 = Math.hypot(nb.x + nb.w / 2 - BUB.x, nb.y - BUB.y), lv = clamp(1 - d2 / 230, 0, 1) * fe * (nb.laid ? 0.6 : 0.3);
        const fg2 = c.createLinearGradient(0, nb.y, 0, nb.y + nb.h); fg2.addColorStop(0, `rgba(225,240,255,${lv.toFixed(3)})`); fg2.addColorStop(1, 'rgba(225,240,255,0)'); c.globalAlpha = 1; c.fillStyle = fg2; rrect(c, nb.x, nb.y, nb.w, nb.h, 2); c.fill(); }
    }
    // 7. The brick of light: born in the flash, it sinks to its socket; the floor answers from there.
    if (s >= T.brick) {
      const BW = you.w, BH = you.h, bf = clamp((s - T.brick) / (T.land - T.brick), 0, 1), ef = easeIn(bf) * 0.35 + bf * 0.65, ox = you.x + BW / 2, oy = you.y + BH / 2;
      let px2 = BUB.x + (ox - BUB.x) * ef + (1 - bf) * Math.sin(bf * 11) * 7, py2 = BUB.y + (oy - BUB.y) * ef, rot = (1 - bf) * Math.sin(bf * 9) * 0.12, sc = 0.3 + 0.7 * easeOut(clamp((s - T.brick) / 0.3, 0, 1));
      if (landed) { px2 = ox; py2 = oy + (sinceLand < 0.25 ? Math.sin(sinceLand / 0.25 * Math.PI) * 1.8 : 0); rot = 0; sc = 1; }
      const hot = landed ? 1 - clamp(sinceLand / 2.6, 0, 1) : 1;
      c.save(); c.translate(px2, py2); c.rotate(rot); c.scale(sc, sc); c.globalCompositeOperation = 'source-over';
      const bg = c.createLinearGradient(-BW / 2, 0, BW / 2, 0); bg.addColorStop(0, `rgba(${POUR.rgb},.95)`); bg.addColorStop(0.5, 'rgba(255,255,255,.95)'); bg.addColorStop(1, `rgba(${T0.rgb},.95)`); c.fillStyle = bg; rrect(c, -BW / 2, -BH / 2, BW, BH, 2.5); c.fill();
      const ig2 = c.createLinearGradient(0, -BH / 2, 0, BH / 2); ig2.addColorStop(0, `rgba(255,255,255,${(0.6 * hot + 0.25).toFixed(3)})`); ig2.addColorStop(0.5, 'rgba(255,255,255,0)'); ig2.addColorStop(1, 'rgba(0,0,0,.35)'); c.fillStyle = ig2; rrect(c, -BW / 2, -BH / 2, BW, BH, 2.5); c.fill();
      const sw = (S.t * 0.9) % 1, sg2 = c.createLinearGradient(-BW / 2, -BH / 2, BW / 2, BH / 2); sg2.addColorStop(Math.max(0, sw - 0.14), 'rgba(255,255,255,0)'); sg2.addColorStop(sw, `rgba(255,255,255,${(0.55 + 0.35 * hot).toFixed(3)})`); sg2.addColorStop(Math.min(1, sw + 0.14), 'rgba(255,255,255,0)');
      c.globalCompositeOperation = 'lighter'; c.fillStyle = sg2; rrect(c, -BW / 2, -BH / 2, BW, BH, 2.5); c.fill();
      c.strokeStyle = `rgba(255,255,255,${(0.55 + 0.4 * hot).toFixed(3)})`; c.lineWidth = 1.2; c.shadowColor = '#fff'; c.shadowBlur = 10 * hot; rrect(c, -BW / 2, -BH / 2, BW, BH, 2.5); c.stroke(); c.shadowBlur = 0;
      c.globalAlpha = 0.5; c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = 0.7; c.beginPath(); c.moveTo(-BW / 2 + 4, BH / 2 - 3); c.lineTo(-BW / 2 + 12, -BH / 2 + 3); c.moveTo(BW / 2 - 4, -BH / 2 + 3); c.lineTo(BW / 2 - 12, BH / 2 - 3); c.stroke();
      infinity(c, 0, 0, 9.5, 1.8, '#ffffff', 0.9, 6); blit(c, SP.white, 0, 0, 34, 0.45 * hot + 0.1); blit(c, SP.tokHalo, 0, 0, 52, 0.45 + 0.35 * pulse + 0.25 * breathe);
      c.restore(); c.globalCompositeOperation = 'lighter';
      if (landed) { const reach = sinceLand * T.wave;
        ([[0.8, 1.0, 240], [1.0, 2.2, T.wave]] as Array<[number, number, number]>).forEach((rr, ri) => { const ra = sinceLand / rr[1]; if (ra > 1) return; const R3 = ri === 0 ? 10 + sinceLand * rr[2] : reach, al = (1 - ra) * rr[0];
          c.globalAlpha = al * 0.7; c.strokeStyle = ri === 0 ? 'rgba(255,255,255,1)' : `rgba(${T0.mid},1)`; c.lineWidth = ri === 0 ? 1.6 : 2.4; c.shadowColor = c.strokeStyle; c.shadowBlur = 8; c.beginPath(); c.ellipse(ox, oy + 4, R3, R3 * 0.3, 0, 0, Math.PI * 2); c.stroke(); c.shadowBlur = 0; });
        for (const gb of bricks) { if (gb.you) continue; const gd = Math.abs(gb.x + gb.w / 2 - ox) + Math.abs(gb.y - oy) * 1.4, near = 1 - Math.abs(gd - reach) / 34; if (near <= 0) continue;
          c.globalAlpha = 0.75 * near; c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = 1; c.beginPath(); c.moveTo(gb.x + 2, gb.y + 1.5); c.lineTo(gb.x + gb.w - 2, gb.y + 1.5); c.stroke(); }
        for (const n2 of bricks) { if (!n2.laid || n2.you) continue; const nw = n2.w, nh = n2.h, dd = Math.abs(n2.x + nw / 2 - ox) + Math.abs(n2.y - oy) * 1.4, on = clamp((reach - dd) / 40, 0, 1); n2.k = on; if (on <= 0) continue;
          const lvl = on * (0.5 + 0.5 * pulse + 0.3 * breathe), hcol = hsl(T0.h + hueShift * 0.6 + n2.c * 9, 95, 70);
          const wg = c.createRadialGradient(n2.x + nw / 2, n2.y + nh, 0, n2.x + nw / 2, n2.y + nh, nw * 0.75); wg.addColorStop(0, `rgba(${hcol},${(0.42 * lvl).toFixed(3)})`); wg.addColorStop(1, `rgba(${hcol},0)`); c.globalAlpha = 1; c.fillStyle = wg; rrect(c, n2.x, n2.y, nw, nh, 2); c.fill();
          c.globalAlpha = 0.9 * lvl; c.strokeStyle = `rgba(${hcol},1)`; c.lineWidth = 1; c.beginPath(); c.moveTo(n2.x + 2, n2.y + 1.5); c.lineTo(n2.x + nw - 2, n2.y + 1.5); c.stroke();
          blit(c, SP.tokHalo, n2.x + nw / 2, n2.y - 6, 10 + nw * 0.4, 0.3 * lvl); } }
    }
    // 8. Bubbles rise, wobble, and break at the surface.
    for (const B of bubbles) { c.globalAlpha = 0.85; c.strokeStyle = 'rgba(220,240,255,.75)'; c.lineWidth = 0.8; c.beginPath(); c.arc(B.x, B.y, B.r, 0, Math.PI * 2); c.stroke(); c.fillStyle = '#fff'; c.globalAlpha = 0.9; c.fillRect(B.x - B.r * 0.4, B.y - B.r * 0.45, 1, 1); }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    const ft = c.createLinearGradient(0, HH - 18, 0, HH); ft.addColorStop(0, 'rgba(12,22,40,0)'); ft.addColorStop(1, 'rgba(12,22,40,.85)'); c.fillStyle = ft; c.fillRect(0, HH - 18, HW, 18);
  }
  // The fx canvas, over everything: the two streams pouring from above the card, and the flash spilling past it.
  function headXY(p: { x: number; y: number }): { x: number; y: number } { const r = o.head.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }
  function drawFx(s: number): void {
    const c = fctx!; c.setTransform(DPR, 0, 0, DPR, 0, 0); c.clearRect(0, 0, W, H); c.globalCompositeOperation = 'lighter';
    const cr = o.head.getBoundingClientRect();
    ([[0, 118, SP.solPt, SP.solSoft, POUR], [0.1, 240, SP.tokPt, SP.tok, HUE]] as Array<[number, number, HTMLCanvasElement, HTMLCanvasElement, { rgb: RGB; mid: RGB }]>).forEach((st) => {
      const t0 = st[0], x0 = st[1], f = s - T.pour - t0; if (f < 0 || f > T.hit + 0.55 - t0) return;
      const top = { x: cr.left + x0 + (x0 < 179 ? -70 : 70), y: cr.top - (o.reduced ? 40 : 60) }, hit = headXY({ x: x0, y: surfY(x0, S.t) });
      const prog = clamp(f / (T.hit - t0), 0, 1), tail = clamp((f - (T.hit - t0)) / 0.5, 0, 1); seed = 17 + Math.floor(x0);
      const col = st[4], head = { x: top.x + (hit.x - top.x) * prog, y: top.y + (hit.y - top.y) * (prog * prog * 0.6 + prog * 0.4) }, from = { x: top.x + (hit.x - top.x) * tail, y: top.y + (hit.y - top.y) * (tail * tail * 0.6 + tail * 0.4) };
      c.save(); c.shadowColor = `rgba(${col.rgb},1)`; c.shadowBlur = 12; c.lineCap = 'round';
      c.strokeStyle = `rgba(${col.mid},.9)`; c.lineWidth = 3.2; c.beginPath(); c.moveTo(from.x, from.y); c.quadraticCurveTo((from.x + head.x) / 2 + Math.sin(S.t * 4) * 4, (from.y + head.y) / 2, head.x, head.y); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 1.2; c.shadowBlur = 0; c.beginPath(); c.moveTo(from.x, from.y); c.quadraticCurveTo((from.x + head.x) / 2 + Math.sin(S.t * 4) * 4, (from.y + head.y) / 2, head.x, head.y); c.stroke(); c.restore();
      c.globalCompositeOperation = 'lighter';
      for (let u = 0; u < 10; u++) { const e = tail + (prog - tail) * u / 9; if (e < tail) continue; const x = top.x + (hit.x - top.x) * e, y = top.y + (hit.y - top.y) * (e * e * 0.6 + e * 0.4); blit(c, st[3], x + (rnd() - 0.5) * 4, y, 5 + 3 * e, 0.22); }
      if (prog > 0.98 && tail < 1) { const ct = tail * 0.5;
        for (let dI = 0; dI < 7; dI++) { const da = -Math.PI / 2 + (dI - 3) * 0.32, dv = 70 + (dI % 3) * 25, dxp = hit.x + Math.cos(da) * dv * ct, dyp = hit.y + Math.sin(da) * dv * ct + 330 * ct * ct; if (dyp > hit.y + 2) continue; blit(c, st[2], dxp, dyp, 2.4 - ct * 2, 0.9 * (1 - tail)); }
        const sp = c.createRadialGradient(hit.x, hit.y, 0, hit.x, hit.y, 26); sp.addColorStop(0, 'rgba(255,255,255,.4)'); sp.addColorStop(1, 'rgba(255,255,255,0)'); c.globalAlpha = 1 - tail; c.fillStyle = sp; c.fillRect(hit.x - 26, hit.y - 26, 52, 52); }
    });
    if (s >= T.flash && !o.reduced) { const since = s - T.flash, fl = Math.exp(-since / 0.3), at = headXY(BUB); blit(c, SP.flash, at.x, at.y, 120 + 520 * (1 - Math.exp(-since / 0.14)), fl * 0.9);
      const stk2 = c.createLinearGradient(0, 0, W, 0); stk2.addColorStop(0, `rgba(${HUE.rgb},0)`); stk2.addColorStop(0.5, `rgba(255,255,255,${(0.5 * fl).toFixed(3)})`); stk2.addColorStop(1, `rgba(${HUE.rgb},0)`); c.globalAlpha = 1; c.fillStyle = stk2; c.fillRect(0, at.y - 1 - 3 * fl, W, 2 + 6 * fl);
      c.globalAlpha = 0.42 * fl; c.fillStyle = '#eaf4ff'; c.fillRect(0, 0, W, H); }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }
  function step(dt: number, s: number): void {
    if (!M || !you) return;
    if (s >= T.hit && s < T.bubble + 0.3) for (let sp2 = 0; sp2 < (o.reduced ? 1 : 2); sp2++) {
      ([[118, SP.solSoft, SP.solDeep], [240, SP.tok, SP.tok]] as Array<[number, HTMLCanvasElement, HTMLCanvasElement]>).forEach((st) => { const x0 = st[0]; blobs.push({ x: x0 + (rnd() - 0.5) * 8, y: SURF + 4 + rnd() * 6, vx: (CX - x0) * 0.6 + (rnd() - 0.5) * 20, vy: 40 + rnd() * 50, r0: 5, r1: 28 + rnd() * 26, life: 0, max: 1.8 + rnd() * 0.9, a: 0.6, img: rnd() < 0.7 ? st[1] : st[2] }); });
      if (!M.ripOnce) { M.ripOnce = true; ripples.push({ x: 118, t0: S.t, v: 120, a: 3, life: 1.6 }); ripples.push({ x: 240, t0: S.t, v: 120, a: 3, life: 1.6 }); }
    }
    // The colors drift in a slow vortex around the bubble's place, winding into each other.
    const sw = s < T.bubble ? 1 : 2.4;
    blobs = blobs.filter((b) => { b.life += dt; if (b.life > b.max) return false;
      const dx = CX - b.x, dy = BUB.y - b.y, d = Math.hypot(dx, dy) + 1;
      b.vx += (dx / d * 26 - dy / d * 42 * sw - b.vx * 0.9) * dt; b.vy += (dy / d * 26 + dx / d * 42 * sw - b.vy * 0.9) * dt; b.x += b.vx * dt; b.y += b.vy * dt; return true; });
    // The bubble gathers the color: after it forms every blob is pulled in and swallowed at its skin.
    if (s >= T.bubble && s < T.flash) { const g2 = clamp((s - T.bubble) / 0.8, 0, 1);
      blobs = blobs.filter((bb) => { const ddx = BUB.x - bb.x, ddy = BUB.y - bb.y, dl = Math.hypot(ddx, ddy) + 1; bb.vx += ddx / dl * 160 * g2 * dt; bb.vy += ddy / dl * 160 * g2 * dt; if (dl < 30) return false; bb.max = Math.min(bb.max, bb.life + 1.2); return true; }); }
    ripples = ripples.filter((rp) => S.t - rp.t0 <= rp.life);
    shock = shock.filter((sh) => S.t - sh.t0 <= sh.life);
    bubbles = bubbles.filter((B) => { B.y -= B.v * dt; B.x += Math.sin(S.t * 5 + B.p) * 10 * dt; B.r += 0.6 * dt; if (B.y < surfY(B.x, S.t) + 2) { ripples.push({ x: B.x, t0: S.t, v: 60, a: 0.8, life: 0.7 }); return false; } return true; });
    if (M.landed && S.t - M.landAt > 1.8 && !o.reduced && rnd() < dt * 0.9) bubbles.push({ x: you.x + 6 + rnd() * (you.w - 12), y: you.y - 2, r: 1 + rnd() * 1.4, v: 18 + rnd() * 16, p: rnd() * 6.28 });
  }
  function tick(dt: number): void {
    S.t += dt; const s = M ? S.t - M.t0 - M.lead : -1;
    if (M && you) {
      if (!M.hit && s >= T.hit) { M.hit = true; o.onTick?.(6); }
      if (s >= T.bubble && s < T.collapse) { const bt = s - T.bubble, f = bt / (T.collapse - T.bubble), period = 0.9 - 0.78 * f, n = Math.floor(bt / period); if (n !== M.tickN) { M.tickN = n; o.onTick?.(5 + Math.round(6 * f)); } }
      if (!M.flashed && s >= T.flash) { M.flashed = true; o.onTick?.(22); shock.push({ x: BUB.x, y: BUB.y, t0: S.t, v: 520, life: 0.75 }); ripples.push({ x: BUB.x, t0: S.t, v: 420, a: 4, life: 0.9 }); o.ring.dataset.floor = 'lit'; o.onFlash?.(); }
      if (!M.landed && s >= T.land) { M.landed = true; M.landAt = S.t; o.onTick?.(12); seed = hash('land'); for (let q = 0; q < (o.reduced ? 5 : 12); q++) bubbles.push({ x: you.x + rnd() * you.w, y: you.y + 4, r: 0.8 + rnd() * 1.6, v: 26 + rnd() * 30, p: rnd() * 6.28 }); }
      if (M.landed) { const sl = s - T.land, bp = sl > 0.2 && sl < 2.4 ? (sl - 0.2) / 0.733 : -1;
        if (bp >= 0 && Math.floor(bp) !== M.pulses && Math.floor(bp) < 3) { M.pulses = Math.floor(bp); o.onTick?.(M.pulses === 2 ? 12 : 7); o.onBeat?.(M.pulses + 1); }
        if (sl > 0.6 && !M.said) { M.said = true; o.onLanded?.(); }
        // Reduced motion: once the third beat has settled the loop stops; the rest is a still (nothing loops).
        if (o.reduced && sl > 2.6 && !M.stopped) { M.stopped = true; drawHead(); fctx!.setTransform(1, 0, 0, 1, 0, 0); fctx!.clearRect(0, 0, o.fx.width, o.fx.height); halt(); return; } }
      step(dt, s);
    }
    drawHead(); drawFx(s);
  }
  function size(): void {
    W = window.innerWidth; H = window.innerHeight; o.fx.width = Math.round(W * DPR); o.fx.height = Math.round(H * DPR);
    const r = o.head.getBoundingClientRect(); HW = r.width || 358; HH = r.height || 214; o.head.width = Math.round(HW * DPR); o.head.height = Math.round(HH * DPR);
  }
  let raf = 0, last: number | null = null, halted = false;
  function frame(now: number): void { if (halted) return; if (last == null) last = now; const dt = Math.min(0.05, (now - last) / 1000); last = now; tick(dt); raf = requestAnimationFrame(frame); }
  function halt(): void { halted = true; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function restAtOnce(): void {
    // A card raised again: the pool lit, your brick on the floor, the line on; one frame, nothing loops.
    M = { t0: S.t - 30, lead: 0, hit: true, tickN: -1, flashed: true, landed: true, landAt: S.t - 30, pulses: 3, said: true, ripOnce: true, stopped: true };
    o.ring.dataset.floor = 'lit'; drawHead(); o.onLanded?.();
  }
  const onResize = (): void => { size(); paintCache(); };
  size(); buildPool();
  if (o.state === 'lit') { restAtOnce(); }
  else { M = { t0: S.t, lead: 0.1, hit: false, tickN: -1, flashed: false, landed: false, landAt: 0, pulses: -1, said: false, ripOnce: false, stopped: false }; raf = requestAnimationFrame(frame); }
  window.addEventListener('resize', onResize);
  return {
    stop: () => { halt(); window.removeEventListener('resize', onResize); fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, o.fx.width, o.fx.height); },
    setLps: (n) => { lps = n; layFloor(); if (M && M.stopped) drawHead(); },
  };
}

