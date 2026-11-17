// Harvest's figure in numbers (components/farm/HarvestGranary.tsx draws it): one street, each room
// with a claim one building on its own footing, its claims stacks of storeys on the island bungalow's
// footprint (lib/isoBungalow.ts), and one lane a claim to YOUR WALLET at the street's head. Pure.
//
// EVERY STOREY, LANE AND PLATE IS THE SAME SIZE whatever the claim pays: none carries an amount.
// Height and place are run order and state, never value.
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK, mixHex } from '../editorial';
import { bounds, iso, type P3, type Pt } from '../iso';
import { HOUSE_D, HOUSE_W, OVER_GABLE, RISE, U, convexHull, positionOf } from '../isoBungalow';
import type { ClaimState, HarvestChain } from './types';

export { RISE, U };

/* ─────────────── colours ─────────────── */

export const BG = EDITORIAL_BG;
export const INK = EDITORIAL_INK;
export const GREEN = EDITORIAL_GREEN;
export const AMBER = '#e3b341';
export const REFUSED = '#f08a6b';
export const UNSURE = '#f0b26b';
/** IsoBungalow's lamplight. */
export const GLOW = '#ffd98a';
/** A window with no light behind it: dark glass, the sky caught in its corner; a lit pane, hot at its middle. */
export const GLASS = '#0e1826';
export const SKY = '#9db6d8';
export const HOT = '#fff4cf';
export const STONE = mixHex(BG, INK, 0.24);
export const SLATE = mixHex(BG, INK, 0.2);
export const SLATE_EDGE = mixHex(BG, INK, 0.12);
export const FASCIA_STONE = mixHex(BG, INK, 0.3);
/** Cancelled and not sent: the dashed storey's cream. */
const CREAM = mixHex(BG, INK, 0.62);
/** The wallet's glass. */
export const GLASS_TINT = '#9cc9dc';
/** A lane at rest wears its network's colour: three hues of one weight, none of them a state's colour. */
export const NET_COLOUR: Readonly<Record<HarvestChain, string>> = { solana: '#6fcfc2', ethereum: '#c0aefc', base: '#9bb9ff' };

/* ─────────────── the granary's numbers, in world units (U px each) ─────────────── */

/** A storey's footprint is the bungalow's; its height. */
export const W = HOUSE_W;
export const D = HOUSE_D;
export const H = 1.7;
/** The stone fascia across a storey's top (its number and ticker), and the floor band at its foot. */
const FASCIA = 0.42;
const FLOOR = 0.1;
/** The footing's height, its margin past the storeys, and the lot's margin past the footing. */
export const FOOT = 0.55;
export const M = 0.3;
const LOT = 0.42;
/** A stack holds at most CAP storeys; a room with more stands as stacks side by side on one footing. */
export const CAP = 4;
/** The alley between two stacks of a network, along the windowed wall's axis: a whole window of each storey shows. */
export const ALLEY = 1.0;
/** The thickness of the board the model stands on. */
export const BOARD = 0.16;
/** The gap under the lowest storey hung, the air between storeys hung, the lift at the wallet. */
export const FLOAT = 1.0;
export const AIR = 1.05;
export const LIFT = 0.5;
/** The gap between the top storey hung and the roof hung over it; the stone course the roof sits on. */
export const ROOF_AIR = 0.85;
export const CORNICE = 0.34;
/** Over a topped-out tower a dashed storey hangs this far above the built top: clear of roof and flag. */
export const FLOAT_DONE = 3.0;
export const FLAG_H = 1.0;
/** The revision cloud's reach past the storey, one scallop's chord, in sheet px, and each arc's radius to its chord. */
export const CLOUD_PAD = 7;
export const CLOUD_STEP = 9.5;
const CLOUD_BULGE = 0.56;
/** The box's side padding past a claim set: room for the cloud round any storey. */
const BOX_PAD = 14;

const px = (n: number) => Math.round(n * 100) / 100;
/** A storey's walls in their own planes, px at U: across, deep, high; fascia and floor bands; the band between. */
export const WALL_PX = px(W * U);
export const SIDE_PX = px(D * U);
export const STOREY_PX = px(H * U);
export const FASCIA_PX = px(FASCIA * U);
export const FLOOR_PX = px(FLOOR * U);
export const BAND_PX = px((H - FASCIA - FLOOR) * U);

/* ─────────────── the street and YOUR WALLET, in world units ─────────────── */

/** The wallet, a glass pavilion: its side, its podium's height and reach, the glass's top, the roof's thickness and reach, the transom. */
export const WT = 2.6;
export const W_POD = 0.2;
export const W_POD_OVER = 0.22;
export const W_GLASS = 2.35;
export const W_ROOF_T = 0.16;
export const W_ROOF_OVER = 0.24;
export const W_HEAD = 1.6;
/** Clear ground, wall to wall: the wallet to the first footing; two rooms on one network; two networks. */
export const W_GAP = 0.9;
export const ROOM_GAP = 1.0;
export const DISTRICT_GAP = 1.5;
/** From a footing's front edge to the wallet's door zone; the door zone's inset from the wallet's corners. */
export const STREET0 = 0.35;
export const DOOR_IN = 0.3;
/** Past the last lane: the strip each network's name is lettered on, then the kerb; then the board's edge. */
export const NAME_STRIP = 0.8;
export const KERB_OUT = 0.25;
/** A lane's width, the most room between two lanes, the gap between two networks' doors. */
export const LANE_W = 0.17;
export const LANE_P = 0.3;
export const DOOR_GAP = 0.25;
/** Where a stack's lanes leave its front: centred ROOT_AT along it, ROOT_Q apart. */
export const ROOT_AT = 1.85;
export const ROOT_Q = 0.6;
/** One plate per claim paid: its side, its most thickness, the air between two. */
export const PLATE = 0.56;
const PLATE_T = 0.12;
const PLATE_AIR = 0.03;

/**
 * How a storey's fascia is lettered, by how large the figure is drawn (sheet px a unit, the svg's
 * own scale): its plaque (number and ticker) from 1 up; under that, a number tile large enough to read.
 */
export function letteringFor(scale: number): 'l' | 'm' {
  return scale >= 1 ? 'l' : 'm';
}

/* ─────────────── the storeys ─────────────── */

export type GhostKind = 'reverted' | 'unconfirmed' | 'declined' | 'not-sent';
/** A claim that did not land: drawn as a dashed storey, never part of the building. */
export const GHOST_STATES: ReadonlySet<ClaimState['kind']> = new Set<GhostKind>(['reverted', 'unconfirmed', 'declined', 'not-sent']);

export function isGhost(state: ClaimState['kind'] | null): state is GhostKind {
  return state !== null && GHOST_STATES.has(state);
}

const resolved = (state: ClaimState['kind'] | null) => state === 'claimed' || isGhost(state);
/** Paid, refused or cancelled: a claim not confirmed may still land, and one not sent was never asked. */
const answered = (state: ClaimState['kind'] | null) => state === 'claimed' || state === 'reverted' || state === 'declined';

/** One claim, as the drawing sees it: never its amount. */
export interface GranaryStorey {
  /** The claim's key. */
  key: string;
  /** Its row number: its index in the run list, plus one. */
  n: number;
  chain: HarvestChain;
  roomId: string;
  symbol: string;
  /** The room's colour, `#rrggbb`. */
  accent: string;
  /** The claim carries a caution (it may not pay). */
  caution: boolean;
  /** Null before a run: ready. */
  state: ClaimState['kind'] | null;
}

export interface GranaryNetwork {
  chain: HarvestChain;
  storeys: GranaryStorey[];
}

export interface PlacedStorey {
  storey: GranaryStorey;
  /** Its floor's height. */
  z: number;
  where: 'built' | 'aloft' | 'ghost';
  /** Raised LIFT: it is at the wallet, or hung above one that is. */
  lifted: boolean;
}

export type RoofMode = 'kit' | 'topped' | 'ghost';

/** A room's footing on the street: its near-left corner in plan, its length along x, and whose it is. */
export interface Lot {
  x: number;
  y: number;
  length: number;
  /** Its network's place in the run, and that network. */
  net: number;
  chain: HarvestChain;
  roomId: string;
  symbol: string;
  /** The first lot of its network: where the network's name is lettered on the ground. */
  first: boolean;
}

/** One stack of storeys, on its room's footing. */
export interface Tower {
  chain: HarvestChain;
  /** Its network's place in the run; its place among its room's stacks; whether it is the room's last. */
  net: number;
  stack: number;
  last: boolean;
  /** The same object for every stack of one room. */
  lot: Lot;
  storeys: GranaryStorey[];
  x: number;
  y: number;
  built: number;
  builtTop: number;
  /** Built storeys first, then the hung ones, each in run order. */
  placed: PlacedStorey[];
  /** `e` is where the walls under the roof stop (base + CORNICE). */
  roof: { base: number; e: number; mode: RoofMode };
  topped: boolean;
  /** A hung storey that is not dashed exists. */
  anyAloft: boolean;
}

/** The storeys grouped by network: networks in the order of their first storey, storeys in the order given (run order). */
export function networksOf(storeys: readonly GranaryStorey[]): GranaryNetwork[] {
  const out: GranaryNetwork[] = [];
  for (const s of storeys) {
    let net = out.find((n) => n.chain === s.chain);
    if (!net) out.push((net = { chain: s.chain, storeys: [] }));
    net.storeys.push(s);
  }
  return out;
}

/**
 * A network's storeys in run order as stacks of at most `cap`: as few stacks as hold them, each as
 * full as the next (5 is 3 + 2, 7 is 4 + 3), the first filled first. Reads only the count and the
 * order, so a claim never changes stack during a run.
 */
export function stacksOf<T>(storeys: readonly T[], cap = CAP): T[][] {
  const k = Math.max(1, Math.ceil(storeys.length / cap));
  const out: T[][] = [];
  let at = 0;
  for (let j = 0; j < k; j++) {
    const size = Math.ceil((storeys.length - at) / (k - j));
    out.push(storeys.slice(at, at + size));
    at += size;
  }
  return out;
}

export interface GranaryRoom {
  roomId: string;
  symbol: string;
  storeys: GranaryStorey[];
}

/** One network's storeys by room: rooms in the order of their first storey, each room's storeys in run order. */
export function roomsOf(storeys: readonly GranaryStorey[]): GranaryRoom[] {
  const out: GranaryRoom[] = [];
  for (const s of storeys) {
    let room = out.find((r) => r.roomId === s.roomId);
    if (!room) out.push((room = { roomId: s.roomId, symbol: s.symbol, storeys: [] }));
    room.storeys.push(s);
  }
  return out;
}

/**
 * Where everything stands, from the claims' states alone: one Tower per stack, along one street.
 * Each room with a claim is one lot, networks in run order and each network's rooms in the order of
 * their first claim, wall to wall ROOM_GAP apart on one network and DISTRICT_GAP between two. A
 * storey is built when it is claimed and every storey before it in its stack has come to something;
 * the rest hang in run order. Once every claim on a network was paid, refused or cancelled, each of
 * its stacks holding a paid storey tops out; any other's roof hangs dashed.
 */
export function granaryLayout(networks: readonly GranaryNetwork[]): Tower[] {
  const out: Tower[] = [];
  let x = 0;
  networks.forEach((network, net) => {
    const allAnswered = network.storeys.length > 0 && network.storeys.every((s) => answered(s.state));
    roomsOf(network.storeys).forEach((room, r) => {
      if (out.length) x += r === 0 ? DISTRICT_GAP : ROOM_GAP;
      const stacks = stacksOf(room.storeys);
      const length = stacks.length * W + (stacks.length - 1) * ALLEY;
      const lot: Lot = { x, y: 0, length, net, chain: network.chain, roomId: room.roomId, symbol: room.symbol, first: r === 0 };
      stacks.forEach((storeys, stack) => {
        out.push(stackOf(network.chain, storeys, x + stack * (W + ALLEY), 0, allAnswered, { net, stack, last: stack === stacks.length - 1, lot }));
      });
      x += length;
    });
  });
  return out;
}

function stackOf(chain: HarvestChain, storeys: GranaryStorey[], x: number, y: number, allAnswered: boolean,
  at: Pick<Tower, 'net' | 'stack' | 'last' | 'lot'>): Tower {
  let built = 0;
  let earlierOpen = false;
  const placed: PlacedStorey[] = [];
  const hung: GranaryStorey[] = [];
  for (const s of storeys) {
    if (s.state === 'claimed' && !earlierOpen) {
      placed.push({ storey: s, z: FOOT + built * H, where: 'built', lifted: false });
      built += 1;
    } else {
      hung.push(s);
    }
    if (!resolved(s.state)) earlierOpen = true;
  }
  const topped = allAnswered && built > 0;
  const builtTop = FOOT + built * H;
  const first = topped ? FLOAT_DONE : FLOAT;
  let lift = false;
  hung.forEach((s, j) => {
    if (s.state === 'sending') lift = true;
    placed.push({ storey: s, z: builtTop + first + j * (H + AIR) + (lift ? LIFT : 0), where: isGhost(s.state) ? 'ghost' : 'aloft', lifted: lift });
  });
  const aloftTop = hung.length ? builtTop + first + hung.length * H + (hung.length - 1) * AIR + (lift ? LIFT : 0) : builtTop;
  const base = topped ? builtTop : aloftTop + ROOF_AIR;
  return {
    chain, ...at, storeys, x, y, built, builtTop, placed,
    roof: { base, e: base + CORNICE, mode: topped ? 'topped' : allAnswered ? 'ghost' : 'kit' },
    topped, anyAloft: hung.some((s) => !isGhost(s.state)),
  };
}

/* ─────────────── the lanes, the doors and the plates ─────────────── */

const P = (x: number, y: number, z: number): Pt => iso([x, y, z], U);

/** One claim's lane: out of its building's front at plan x `x`, along the street at plan y `y`, to its network's door. */
export interface Lane {
  storey: GranaryStorey;
  x: number;
  y: number;
}

/** A network's door on the wallet's glass face (plan y `lo` to `hi`), and the spot its plates stack on inside. */
export interface Door {
  chain: HarvestChain;
  lo: number;
  hi: number;
  /** Its network's claims. */
  count: number;
  /** The near-left corner of its plates' spot, in plan. */
  spot: readonly [number, number];
}

export interface CityPlan {
  /** The wallet's far corner in plan, and its glass face toward the street (plan x). */
  wx: number;
  wy: number;
  face: number;
  /** In the street's order: building by building, each stack's storeys in run order. */
  lanes: Lane[];
  doors: Door[];
  /** Between two lanes; one width for every lane; one thickness, and one air, for every plate. */
  pitch: number;
  laneW: number;
  plateT: number;
  plateAir: number;
  /** The street's near edge (plan y). */
  kerb: number;
}

/**
 * Where the wallet stands and every lane, door and plate spot, from the count and the order of the
 * claims alone (it reads no state and no amount, so nothing in it moves during a run). The lanes'
 * runs are centred on the wallet's glass face; both where a lane leaves its building and where it
 * runs rise along the street, so no lane crosses another.
 */
export function cityPlan(towers: readonly Tower[]): CityPlan {
  const wx = -M - W_GAP - WT;
  const wy = D + M + STREET0 - DOOR_IN;
  const face = wx + WT;
  const at: { storey: GranaryStorey; x: number; net: number }[] = [];
  for (const t of towers) t.storeys.forEach((storey, i) => at.push({ storey, x: t.x + ROOT_AT + (i - (t.storeys.length - 1) / 2) * ROOT_Q, net: t.net }));
  const nets = [...new Set(at.map((l) => l.net))];
  const n = at.length;
  const gaps = (nets.length - 1) * DOOR_GAP;
  const pitch = n > 1 ? Math.min(LANE_P, (WT - 2 * DOOR_IN - gaps) / (n - 1)) : LANE_P;
  const y0 = wy + WT / 2 - ((n - 1) * pitch + gaps) / 2;
  const lanes: Lane[] = at.map((l, j) => ({ storey: l.storey, x: l.x, y: y0 + j * pitch + nets.indexOf(l.net) * DOOR_GAP }));
  // A spot that would touch the one before it moves 0.07 past it; if the last then leaves the glass, all move back.
  let end = -Infinity;
  const spots = nets.map((net) => {
    const ys = lanes.filter((_, j) => at[j]!.net === net).map((l) => l.y);
    const lo = Math.min(...ys) - 0.17;
    const hi = Math.max(...ys) + 0.17;
    let y = Math.max(wy + 0.14, Math.min(wy + WT - 0.14 - PLATE, (lo + hi) / 2 - PLATE / 2));
    if (y < end + 0.07) y = end + 0.07;
    end = y + PLATE;
    return { chain: at.find((l) => l.net === net)!.storey.chain, lo, hi, count: ys.length, y };
  });
  const back = Math.max(0, end - (wy + WT - 0.1));
  const doors: Door[] = spots.map(({ y, ...d }) => ({ ...d, spot: [face - 0.2 - PLATE, y - back] as const }));
  // One thickness for every plate: the most claims on one network still stack inside the glass.
  const room = (W_GLASS - W_POD - 0.3) / Math.max(1, ...doors.map((d) => d.count));
  const plateT = Math.max(0.01, Math.min(PLATE_T, room - PLATE_AIR));
  const plateAir = Math.min(PLATE_AIR, Math.max(0, room - plateT));
  const laneW = n > 1 ? Math.min(LANE_W, 0.8 * pitch) : LANE_W;
  return { wx, wy, face, lanes, doors, pitch, laneW, plateT, plateAir, kerb: wy + WT - DOOR_IN + NAME_STRIP };
}

/**
 * The board, ruled on the ground grid: the strip the buildings and the street stand on, with the
 * wallet's block at its head. Six corners in plan, clockwise from the far left.
 */
export function cityBoard(towers: readonly Tower[], plan: CityPlan): [number, number][] {
  const x0 = -M - LOT;
  const x1 = Math.max(...towers.map((t) => t.lot.x + t.lot.length)) + M + LOT;
  const a = plan.wx - W_POD_OVER - KERB_OUT;
  const b = plan.wy - W_POD_OVER - KERB_OUT;
  const c = plan.kerb + KERB_OUT;
  return [[x0, -M - LOT], [x1, -M - LOT], [x1, c], [a, c], [a, b], [x0, b]];
}

/** YOUR WALLET's type on screen at the least, in px; on the sheet at the most: NAME_PX down to a drawing at half a sheet px a unit. */
export const NAME_PX = 10;
export const NAME_MAX = 20;
/** Where YOUR WALLET's lettering may end: short of the first building's near edge (every street starts at x 0) and the cloud round it. */
const NAME_END = iso([0, D, 0], U)[0] - CLOUD_PAD - 2;

/** YOUR WALLET's type on the sheet: its cut's size, raised so it draws NAME_PX on screen at `scale` (sheet px to screen px; 0 unmeasured). */
export function walletNameSize(cut: 'l' | 'm', scale: number): number {
  const base = cut === 'm' ? 10.4 : 7.4;
  return scale > 0 ? Math.min(NAME_MAX, Math.max(base, Math.ceil((NAME_PX / scale) * 100) / 100)) : base;
}

/**
 * Where YOUR WALLET is lettered at `size`: the lantern's middle (its callout's foot); the name's anchor, its
 * middle on its baseline above the roof, on the lantern unless that brings it to the first building; its
 * reach: half its width and its height over the baseline (JetBrains Mono's 0.6 em, 1.1 tracking, its halo).
 */
export function walletLabel(plan: CityPlan, size = 7.4): { foot: Pt; at: Pt; half: number; rise: number } {
  const foot = P(plan.wx + WT / 2, plan.wy + WT / 2, W_GLASS + W_ROOF_T);
  const far = P(plan.wx - W_ROOF_OVER, plan.wy - W_ROOF_OVER, W_GLASS + W_ROOF_T);
  const half = ('YOUR WALLET'.length * (0.6 * size + 1.1) + 0.3 * size) / 2;
  return { foot, at: [Math.min(foot[0], NAME_END - half), far[1] - 9], half, rise: 0.88 * size };
}

/** A lane in the world: out of its building's front, along the street, up the wallet's step, over the threshold to its door. */
export function laneRoute(plan: CityPlan, lane: Lane): P3[] {
  const step = plan.face + W_POD_OVER;
  return [[lane.x, D + M, 0], [lane.x, lane.y, 0], [step, lane.y, 0], [step, lane.y, W_POD], [plan.face, lane.y, W_POD]];
}

/** A lane whose claim did not land: its route from its building to half the whole route's length, where its stop bar stands. */
export function laneHalf(plan: CityPlan, lane: Lane): P3[] {
  const route = laneRoute(plan, lane);
  const legs = route.slice(1).map((b, i) => Math.hypot(b[0] - route[i]![0], b[1] - route[i]![1], b[2] - route[i]![2]));
  let left = legs.reduce((sum, l) => sum + l, 0) / 2;
  const out: P3[] = [route[0]!];
  for (let i = 0; i < legs.length; i++) {
    const [a, b] = [route[i]!, route[i + 1]!];
    if (legs[i]! >= left) {
      const t = left / legs[i]!;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      break;
    }
    left -= legs[i]!;
    out.push(b);
  }
  return out;
}

/* ─────────────── the box ─────────────── */

/** With no claims: the pools being read, nothing to claim, or some pools not read (no footing drawn). */
export type GranaryMode = 'claims' | 'reading' | 'nothing' | 'unread';

export interface GranaryBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A room's lot on the ground: its footing, `length` along x, and the margin round it. */
export function lotCorners(x: number, y: number, length = W): Pt[] {
  return [
    P(x - M - LOT, y - M - LOT, 0), P(x + length + M + LOT, y - M - LOT, 0),
    P(x + length + M + LOT, y + D + M + LOT, 0), P(x - M - LOT, y + D + M + LOT, 0),
  ];
}

function towerPoints(t: Tower): Pt[] {
  const { x, y, roof } = t;
  const out = lotCorners(t.lot.x, t.lot.y, t.lot.length);
  for (const q of t.placed) out.push(P(x, y, q.z + H), P(x + W, y, q.z + H), P(x, y + D, q.z + H));
  out.push(P(x + W * 0.66, y + D / 2, roof.e + RISE + 0.62), P(x - OVER_GABLE, y + D / 2, roof.e + RISE));
  if (t.topped) {
    out.push(P(x + W + OVER_GABLE + 0.85, y + D / 2, roof.e + RISE + FLAG_H + 0.1), P(x + W * 0.66 + 0.6, y + D / 2, roof.e + RISE + 2.1));
  }
  return out;
}

/**
 * The drawing's viewBox, FIXED for a claim set: the current layout united with the kit (every
 * storey at the wallet: all hung, all lifted), the board, the wallet's roof and its name at its
 * largest, so it never changes size during a run. Padded past the revision cloud's reach. With no
 * claims: the lot alone.
 */
export function granaryBox(networks: readonly GranaryNetwork[], mode: GranaryMode): GranaryBox {
  const claims = mode === 'claims' && networks.some((n) => n.storeys.length > 0);
  const points: Pt[] = [];
  let name: ReturnType<typeof walletLabel> | null = null;
  if (claims) {
    const towers = granaryLayout(networks);
    const kit = networks.map((n) => ({ ...n, storeys: n.storeys.map((s) => ({ ...s, state: 'sending' as const })) }));
    for (const t of [...towers, ...granaryLayout(kit)]) points.push(...towerPoints(t));
    const plan = cityPlan(towers);
    name = walletLabel(plan, NAME_MAX);
    points.push(...cityBoard(towers, plan).map(([x, y]) => P(x, y, 0)), P(plan.wx - W_ROOF_OVER, plan.wy - W_ROOF_OVER, W_GLASS + W_ROOF_T));
  } else {
    points.push(...lotCorners(0, 0));
  }
  const [bx, by, bw, bh] = bounds(points);
  const padX = claims ? BOX_PAD : 6;
  const box = { x: Math.floor(bx - padX), y: Math.floor(by - 8), w: Math.ceil(bw + 2 * padX), h: Math.ceil(bh + 14) };
  if (!name) return box;
  // YOUR WALLET at its largest sets its own edge: the pad is room for a storey's cloud, which never comes near it.
  const x = Math.min(box.x, Math.floor(name.at[0] - name.half));
  const y = Math.min(box.y, Math.floor(name.at[1] - name.rise));
  return { x, y, w: box.w + box.x - x, h: box.h + box.y - y };
}

/* ─────────────── a storey's picture and its revision cloud ─────────────── */

/**
 * Where a room's door picture lies on a storey's front wall, in the wall's plane: object-fit cover
 * of the band under the fascia, at the room's own object-position (the crop its door card shows).
 */
export function storeyMuralFrame(natural: { w: number; h: number }, objectPosition?: string) {
  const [fx, fy] = positionOf(objectPosition);
  const s = Math.max(WALL_PX / natural.w, BAND_PX / natural.h);
  const width = natural.w * s;
  const height = natural.h * s;
  return { x: (WALL_PX - width) * fx, y: FASCIA_PX + (BAND_PX - height) * fy, width, height };
}

/**
 * A revision cloud round some points on the sheet, ruled close and small: their convex hull, walked
 * clockwise on screen, pushed out from its centroid by `pad`, walked in about `step`-px chords, each
 * chord an arc that bulges outward (sweep 1). At least 8 scallops. Closed.
 */
export function cloudPath(points: readonly Pt[], pad = CLOUD_PAD, step = CLOUD_STEP): string {
  let hull = convexHull(points);
  if (hull.length < 3) return '';
  const area = hull.reduce((sum, a, i) => {
    const b = hull[(i + 1) % hull.length]!;
    return sum + (a[0] * b[1] - b[0] * a[1]);
  }, 0);
  if (area < 0) hull = [...hull].reverse();
  const cx = hull.reduce((sum, q) => sum + q[0], 0) / hull.length;
  const cy = hull.reduce((sum, q) => sum + q[1], 0) / hull.length;
  const grown: Pt[] = hull.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const l = Math.hypot(dx, dy) || 1;
    return [x + (dx / l) * pad, y + (dy / l) * pad];
  });
  const per = grown.map((a, i) => {
    const b = grown[(i + 1) % grown.length]!;
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
  const total = per.reduce((sum, v) => sum + v, 0);
  const n = Math.max(8, Math.round(total / step));
  const at = (dist: number): Pt => {
    let d = dist;
    let i = 0;
    while (d > per[i]!) {
      d -= per[i]!;
      i = (i + 1) % per.length;
    }
    const a = grown[i]!;
    const b = grown[(i + 1) % grown.length]!;
    const t = per[i] ? d / per[i]! : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const marks = Array.from({ length: n }, (_, i) => at((total * i) / n));
  let d = `M${px(marks[0]![0])} ${px(marks[0]![1])}`;
  for (let i = 1; i <= n; i++) {
    const q = marks[i % n]!;
    const prev = marks[i - 1]!;
    const r = px(Math.hypot(q[0] - prev[0], q[1] - prev[1]) * CLOUD_BULGE);
    d += `A${r} ${r} 0 0 1 ${px(q[0])} ${px(q[1])}`;
  }
  return `${d}Z`;
}

/* ─────────────── state paint: one colour per state, as the rows wear it ─────────────── */

export interface StoreyPaint {
  /** The outline. */
  edge: string;
  edgeOpacity: number;
  edgeWidth: number;
  /** Laid over the band and the right wall. */
  veil: string;
  veilOpacity: number;
  /** Windows burning. */
  lit: boolean;
  /** The green seam at the storey's foot. */
  seam: boolean;
  /** The plaque: its box, its number, its edge, and the ticker. */
  plate: string;
  plateText: string;
  plateEdge: string;
  ticker: string;
}

const READY: StoreyPaint = {
  edge: INK, edgeOpacity: 0.6, edgeWidth: 1, veil: BG, veilOpacity: 0.1, lit: false, seam: false,
  plate: BG, plateText: INK, plateEdge: mixHex(BG, INK, 0.55), ticker: INK,
};
const WAITING = { plateEdge: mixHex(BG, INK, 0.35), plateText: mixHex(BG, INK, 0.6), ticker: mixHex(BG, INK, 0.6) };

/** A solid storey's paint by state; `Pointed` is its row pointed at. A dashed state's hidden solid wears `ready`. */
const STOREY_PAINT = {
  ready: READY,
  readyPointed: { ...READY, edge: '#ffffff', edgeOpacity: 1, edgeWidth: 1.5, veilOpacity: 0, plate: INK, plateText: BG, plateEdge: '#ffffff', ticker: '#ffffff' },
  waiting: { ...READY, ...WAITING, edgeOpacity: 0.4, veilOpacity: 0.48 },
  waitingPointed: { ...READY, ...WAITING, edgeOpacity: 1, veilOpacity: 0.1 },
  sending: { ...READY, edge: AMBER, edgeOpacity: 1, edgeWidth: 1.6, veil: AMBER, veilOpacity: 0.16, plate: AMBER, plateText: BG, plateEdge: AMBER, ticker: '#ffffff' },
  claimed: { ...READY, edge: BG, edgeOpacity: 0.85, veilOpacity: 0, lit: true, seam: true, plate: GREEN, plateText: BG, plateEdge: GREEN, ticker: '#ffffff' },
} as const satisfies Record<string, StoreyPaint>;

export function storeyPaint(state: ClaimState['kind'] | null, pointed: boolean): StoreyPaint {
  switch (state) {
    case 'claimed':
      return STOREY_PAINT.claimed;
    case 'sending':
      return STOREY_PAINT.sending;
    case 'waiting':
      return pointed ? STOREY_PAINT.waitingPointed : STOREY_PAINT.waiting;
    default:
      return pointed ? STOREY_PAINT.readyPointed : STOREY_PAINT.ready;
  }
}

/** The room's picture is dimmed at rest (the island's rule): not at the wallet, not built, not pointed at. */
export function muralDimmed(state: ClaimState['kind'] | null, pointed: boolean): boolean {
  return !pointed && state !== 'claimed' && state !== 'sending';
}

export interface GhostPaint {
  colour: string;
  dash: string;
  /** The faces' fill opacity (the right face x .7, the top x 1.3). */
  fill: number;
}

/** A dashed storey's paint by state: one colour each, as its row's words. */
export const GHOST_PAINT: Readonly<Record<GhostKind, GhostPaint>> = {
  reverted: { colour: REFUSED, dash: '4 2.5', fill: 0.1 },
  unconfirmed: { colour: UNSURE, dash: '2 2.5', fill: 0.08 },
  declined: { colour: CREAM, dash: '3 3', fill: 0.04 },
  'not-sent': { colour: CREAM, dash: '1.2 3', fill: 0.04 },
};

export interface LanePaint {
  /** The line: null wears its network's colour (a lane not yet sent), else its state's colour. */
  line: string | null;
  lineOpacity: number;
  /** A claim that did not land: its storey's dash, and its lane stops halfway to the wallet (laneHalf). */
  dash: string | undefined;
  short: boolean;
  /** Under the line, at the wallet and once paid. */
  glow: string | null;
  /** Inside the line: the sheet's dark while empty, light once paid; none where nothing came. */
  core: string | null;
  /** At the wallet, a light dashed line inside it, still; paid, the one green run from the building. */
  march: boolean;
  run: boolean;
  /** Its number plate: box, the box's opacity, number, edge, the edge's dash. */
  plate: string;
  plateOpacity: number;
  plateText: string;
  plateEdge: string;
  plateDash: string | undefined;
}

const LANE_AT_REST = { dash: undefined, short: false, glow: null, core: BG, march: false, run: false, plateOpacity: 1, plateDash: undefined };

/** A lane's paint by state, the same for every coin: its network's colour only while it waits to be sent. */
export function lanePaint(state: ClaimState['kind'] | null, pointed: boolean): LanePaint {
  switch (state) {
    case 'claimed':
      return { ...LANE_AT_REST, line: GREEN, lineOpacity: 1, glow: GREEN, core: mixHex(GREEN, '#ffffff', 0.45), run: true, plate: GREEN, plateText: BG, plateEdge: GREEN };
    case 'sending':
      return { ...LANE_AT_REST, line: AMBER, lineOpacity: 1, glow: AMBER, march: true, plate: AMBER, plateText: BG, plateEdge: AMBER };
    case null:
    case 'waiting': {
      const w = state === 'waiting';
      return pointed
        ? { ...LANE_AT_REST, line: '#ffffff', lineOpacity: 1, plate: INK, plateText: BG, plateEdge: '#ffffff' }
        : { ...LANE_AT_REST, line: null, lineOpacity: w ? 0.42 : 0.85, plate: BG, plateText: mixHex(BG, INK, w ? 0.6 : 1), plateEdge: mixHex(BG, INK, w ? 0.35 : 0.55) };
    }
    default: {
      const g = GHOST_PAINT[state];
      return {
        line: g.colour, lineOpacity: 1, dash: g.dash, short: true, glow: null, core: null, march: false, run: false,
        plate: pointed ? INK : BG, plateOpacity: 0.6, plateText: pointed ? BG : g.colour, plateEdge: g.colour, plateDash: '1.5 1',
      };
    }
  }
}
