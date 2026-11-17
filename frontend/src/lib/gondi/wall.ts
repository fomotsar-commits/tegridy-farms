// L-01's instrument, THE WALL (owner, 2026-11-15): an elevation of one gallery wall with the
// picked collection hung on it, drawn by components/dwg/LoanWall.tsx. Pure: the market card's
// own read in, the drawing's numbers out, one unit to one pixel. The picture stands from datum
// ±0 to the floor, so its height IS the floor. What was not read is listed, never drawn at a height.
import { barMax, barZone, type BarZone } from './floorBar';
import { underFloorPct, type LendingMarket } from './lenderPitch';

const usable = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
const r1 = (n: number) => Math.round(n * 10) / 10;
/** The market card's own figure format (LenderMarketPanel.tsx). */
const eth = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

/** reading: the read is still out. scaled: the floor was read. nts: not to scale, the floor was not read. */
export type WallMode = 'reading' | 'scaled' | 'nts';
/** none: bids were read and none is open. unread: they were not read. Never one for the other. */
export type BidState = 'reading' | 'read' | 'none' | 'unread';

/** A floor-share chip the Lend form offers (lendDesk.ts floorShareAmount). */
export interface WallShare {
  readonly pct: number;
  readonly amount: string;
}

export interface WallFacts {
  readonly mode: WallMode;
  /** The WETH at the head of the scale (floorBar.ts barMax); null unless to scale. */
  readonly top: number | null;
  readonly floor: number | null;
  readonly bid: number | null;
  readonly bidState: BidState;
  /** The amount typed, in WETH; null while nothing valid is typed. */
  readonly amount: number | null;
  /** Where the amount stands, as FloorBar names it; null unless to scale and typed. */
  readonly zone: BarZone | null;
  readonly shares: readonly WallShare[];
}

/** What the wall may draw, from what the market card already read. */
export function wallFacts({
  market,
  loading,
  principal,
  shares = [],
}: {
  market: LendingMarket | undefined;
  loading: boolean;
  principal: number | null;
  shares?: readonly WallShare[];
}): WallFacts {
  const amount = usable(principal) ? principal : null;
  if (loading) return { mode: 'reading', top: null, floor: null, bid: null, bidState: 'reading', amount, zone: null, shares: [] };
  const floor = market && usable(market.floor) ? market.floor : null;
  const bids = market ? market.bids : null;
  const bid = bids && usable(bids.bestBid) ? bids.bestBid : null;
  const bidState: BidState = !bids ? 'unread' : bid === null ? 'none' : 'read';
  if (floor === null) return { mode: 'nts', top: null, floor: null, bid, bidState, amount, zone: null, shares: [] };
  return {
    mode: 'scaled',
    top: barMax(floor, bid, amount),
    floor,
    bid,
    bidState,
    amount,
    zone: amount === null ? null : barZone(amount, floor, bid),
    shares,
  };
}

/** Margins round the wall: the staff and its marks on the left, the level tags on the right. */
export const WALL_MARGIN = { left: 50, right: 176, rightCompact: 96, top: 10 } as const;
/** A box narrower than this draws the compact wall: short tags, no units. */
export const WALL_COMPACT_BELOW = 500;
/** The scale's height at most: as tall as the wall is wide, up to this. */
export const WALL_MAX_SCALE = 460;

export type WallTone = '' | 'ok' | 'warn' | 'bad';

export interface WallLabel {
  /** The same across redraws, so a tag that moves eases to its new place. */
  readonly id: string;
  readonly k: 'tag' | 'loan' | 'share' | 'datum' | 'dim' | 'stamp' | 'plate';
  readonly x: number;
  readonly y: number;
  readonly t: string;
  readonly v?: string;
  readonly tone?: WallTone;
  readonly on?: boolean;
  readonly align?: 'right';
  readonly stack?: boolean;
}

export interface WallRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface WallDrawing {
  readonly W: number;
  readonly H: number;
  readonly compact: boolean;
  readonly x0: number;
  readonly x1: number;
  readonly wallW: number;
  readonly scaleH: number;
  readonly yHead: number;
  readonly yRail: number;
  /** The head of the scale. */
  readonly yS: number;
  /** Datum ±0: nothing lent. */
  readonly y0: number;
  /** The ground line. */
  readonly yG: number;
  /** The staff's left edge and width. */
  readonly sx: number;
  readonly sw: number;
  /** A square from its top-left corner; `wire` is the polyline it hangs from. */
  readonly picture: { readonly x: number; readonly y: number; readonly side: number; readonly wire: string; readonly nail: readonly [number, number] };
  /** The staff's three zones, to scale only; `covered` only with a read bid. */
  readonly zones: { readonly covered: WallRect | null; readonly under: WallRect; readonly over: WallRect } | null;
  /** A graduation at each tenth of the floor: its height and its length. */
  readonly grads: readonly (readonly [number, number])[];
  /** One mark per floor-share chip the page offers, lit when it is the amount typed. */
  readonly shareMarks: readonly { readonly y: number; readonly on: boolean }[];
  readonly floorY: number | null;
  readonly bidY: number | null;
  readonly loanY: number | null;
  /** The dimension between the loan and the floor: its x and its two ends. */
  readonly dim: { readonly x: number; readonly a: number; readonly b: number } | null;
  /** From a level to its tag where the tag stepped aside, as polyline points. */
  readonly leaders: readonly string[];
  /** Not to scale: the height of the dashed rule to each listed value. */
  readonly listed: readonly number[];
  readonly labels: readonly WallLabel[];
}

interface Tag {
  readonly id: string;
  readonly k: 'tag' | 'loan';
  readonly y: number;
  readonly t: string;
  readonly v: string;
  readonly tone: WallTone;
}

/** Tags that would sit on one another step apart, in order, and stay between min and max. Input order kept. */
export function spreadTags<T extends { readonly y: number }>(tags: readonly T[], min: number, max: number, gap: number): (T & { ty: number })[] {
  const out = tags.map((t) => ({ ...t, ty: t.y }));
  const row = [...out].sort((a, b) => a.y - b.y);
  let after = -Infinity;
  for (const t of row) {
    t.ty = Math.max(Math.min(Math.max(t.y, min), max), after);
    after = t.ty + gap;
  }
  let room = max;
  for (const t of [...row].reverse()) {
    t.ty = Math.min(t.ty, room);
    room = t.ty - gap;
  }
  return out;
}

/** The elevation at a box W px wide, for the collection the lender picked. */
export function wallElevation(W: number, f: WallFacts, col: { readonly name: string; readonly symbol: string; readonly address: string }): WallDrawing {
  const compact = W < WALL_COMPACT_BELOW;
  const x0 = WALL_MARGIN.left;
  const x1 = W - (compact ? WALL_MARGIN.rightCompact : WALL_MARGIN.right);
  const wallW = Math.max(1, x1 - x0);
  const scaleH = Math.round(Math.min(WALL_MAX_SCALE, wallW));
  const yHead = WALL_MARGIN.top;
  const yRail = yHead + 9;
  const yS = yHead + 24;
  const y0 = yS + scaleH;
  const yG = y0 + 14;
  const H = yG + 52; // the earth, then the wall label's two lines
  const scale = f.mode === 'scaled' && f.top !== null && f.floor !== null ? { top: f.top, floor: f.floor } : null;
  const y = (v: number) => y0 - (v / (scale ? scale.top : 1)) * scaleH;
  const S = scale ? Math.round(y0 - y(scale.floor)) : Math.round(scaleH * 0.8);
  const px = Math.round(x0 + (wallW - S) / 2);
  const py = scale ? y0 - S : Math.round(yS + scaleH * 0.07);
  const nx = px + S / 2;
  const labels: WallLabel[] = [];
  const sx = x0 - 19;
  const sw = 10;

  // The staff: datum ±0 to the head of the scale, in the three zones FloorBar names. Only to scale.
  let zones: WallDrawing['zones'] = null;
  const grads: [number, number][] = [];
  const shareMarks: { y: number; on: boolean }[] = [];
  if (scale) {
    const yF = y(scale.floor);
    const yB = f.bid !== null ? y(Math.min(f.bid, scale.floor)) : y0;
    zones = {
      covered: f.bid !== null ? { x: sx, y: r1(yB), w: sw, h: r1(y0 - yB) } : null,
      under: { x: sx, y: r1(yF), w: sw, h: r1(yB - yF) },
      over: { x: sx, y: yS, w: sw, h: r1(yF - yS) },
    };
    // A loan typed far over the floor packs the tenths together: under 2 px apart, none is drawn.
    if ((scale.floor / 10 / scale.top) * scaleH >= 2) {
      for (let k = 1; (scale.floor * k) / 10 < scale.top; k++) grads.push([r1(y((scale.floor * k) / 10)), k % 5 ? 3 : 6]);
    }
    for (const sh of f.shares) {
      const ys = r1(y((scale.floor * sh.pct) / 100));
      const on = f.amount !== null && Math.abs(f.amount - Number(sh.amount)) < 1e-9;
      shareMarks.push({ y: ys, on });
      labels.push({ id: `share-${sh.pct}`, k: 'share', x: sx - 9, y: ys, t: `${sh.pct}%`, on, align: 'right' });
    }
  }
  labels.push({ id: 'datum', k: 'datum', x: sx - 9, y: y0, t: '±0', align: 'right' });

  const tx = x1 + (compact ? 26 : 30); // where the level tags start
  const bidName = compact ? 'BID' : 'BEST BID';
  let floorY: number | null = null;
  let bidY: number | null = null;
  let loanY: number | null = null;
  let dim: WallDrawing['dim'] = null;
  const leaders: string[] = [];
  const listed: number[] = [];
  if (scale) {
    floorY = r1(y(scale.floor));
    const tags: Tag[] = [{ id: 'floor', k: 'tag', y: floorY, t: 'FLOOR', v: `${eth(scale.floor)}${compact ? '' : ' ETH'}`, tone: '' }];
    if (f.bid !== null) {
      bidY = r1(y(f.bid));
      tags.push({ id: 'bid', k: 'tag', y: bidY, t: bidName, v: `${eth(f.bid)}${compact ? '' : ' WETH'}`, tone: 'ok' });
    }
    let dimLabel: WallLabel | null = null;
    if (f.amount !== null) {
      loanY = r1(y(f.amount));
      tags.push({ id: 'loan', k: 'loan', y: loanY, t: 'LOAN', v: `${f.amount.toFixed(4)}${compact ? '' : ' WETH'}`, tone: '' });
      // Between the loan and the floor: the figure the sentence under the floor bar gives.
      const under = underFloorPct(f.amount, scale.floor);
      const span = Math.abs(loanY - floorY);
      if (under !== null && under !== 0 && span >= 16) {
        dim = { x: x1 + 7, a: Math.min(loanY, floorY), b: Math.max(loanY, floorY) };
        if (!compact && span >= 40 && Math.abs(under) < 1000) {
          dimLabel = { id: 'dim', k: 'dim', x: tx, y: (dim.a + dim.b) / 2, t: `${Math.abs(under)}% ${under > 0 ? 'UNDER' : 'OVER'} THE FLOOR`, tone: under > 0 ? '' : 'bad' };
        }
      }
    }
    const at = y0 - (compact ? 14 : 9);
    if (f.bidState === 'none') labels.push({ id: 'bid', k: 'tag', x: tx, y: at, t: bidName, v: 'NONE', stack: compact });
    if (f.bidState === 'unread') labels.push({ id: 'bid', k: 'tag', x: tx, y: at, t: bidName, v: 'NOT READ', tone: 'warn', stack: compact });
    const spread = spreadTags(tags, yS + (compact ? 8 : 2), y0 - (f.bidState === 'read' ? (compact ? 8 : 2) : compact ? 40 : 26), compact ? 35 : 17);
    if (dimLabel && spread.every((t) => Math.abs(t.ty - dimLabel.y) >= 15)) labels.push(dimLabel);
    for (const t of spread) {
      if (Math.abs(t.ty - t.y) > 2) leaders.push(`${x1 + 20},${t.y} ${x1 + 25},${t.ty} ${tx - 2},${t.ty}`);
      labels.push({ id: t.id, k: t.k, x: tx, y: t.ty, t: t.t, v: t.v, tone: t.tone, stack: compact });
    }
  } else {
    // Not to scale: what was read is listed from the head of the wall down, largest first, at no height.
    const list: { id: string; k: 'tag' | 'loan'; t: string; v: string; tone: WallTone; n: number }[] = [];
    if (f.mode === 'nts') {
      list.push({ id: 'floor', k: 'tag', t: 'FLOOR', v: 'NOT READ', tone: 'warn', n: Infinity });
      if (f.bidState === 'read' && f.bid !== null) list.push({ id: 'bid', k: 'tag', t: bidName, v: `${eth(f.bid)}${compact ? '' : ' WETH'}`, tone: 'ok', n: f.bid });
      else list.push({ id: 'bid', k: 'tag', t: bidName, v: f.bidState === 'none' ? 'NONE' : 'NOT READ', tone: f.bidState === 'none' ? '' : 'warn', n: -1 });
      if (f.amount !== null) list.push({ id: 'loan', k: 'loan', t: 'LOAN', v: `${f.amount.toFixed(4)}${compact ? '' : ' WETH'}`, tone: '', n: f.amount });
      list.sort((a, b) => b.n - a.n);
    }
    list.forEach((t, i) => {
      const ty = yS + 14 + i * (compact ? 32 : 22);
      listed.push(ty);
      labels.push({ id: t.id, k: t.k, x: tx, y: ty, t: t.t, v: t.v, tone: t.tone, stack: compact });
    });
    labels.push({ id: 'stamp', k: 'stamp', x: px + S - 8, y: py + 22, t: f.mode === 'reading' ? 'READING' : 'NOT TO SCALE', tone: f.mode === 'reading' ? '' : 'warn', align: 'right' });
  }
  // The wall label: the collection's name, its ticker and its whole address.
  labels.push({ id: 'plate', k: 'plate', x: x0 - 30, y: yG + 22, t: `${col.name.toUpperCase()} · ${col.symbol}`, v: col.address });

  return {
    W,
    H,
    compact,
    x0,
    x1,
    wallW,
    scaleH,
    yHead,
    yRail,
    yS,
    y0,
    yG,
    sx,
    sw,
    picture: { x: px, y: py, side: S, wire: `${r1(px + S * 0.2)},${py} ${r1(nx)},${yRail} ${r1(px + S * 0.8)},${py}`, nail: [r1(nx), yRail] },
    zones,
    grads,
    shareMarks,
    floorY,
    bidY,
    loanY,
    dim,
    leaders,
    listed,
    labels,
  };
}
