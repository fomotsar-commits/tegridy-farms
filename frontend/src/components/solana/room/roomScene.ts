// The Liquidity Room's picture: three.js on WebGPU, on WebGL 2 where the browser has no WebGPU.
//
// Nothing here reads the chain or decides a number. It draws what roomLayout.ts worked out:
// a landscape whose height is the liquidity in use at each price, a green sheet at the pool's
// price, a slab for each of the wallet's positions, and one spark per real swap. A spark flies
// in from the side its swap pushed the price from, and at the price it splits the way the fee
// does: the positions' part sinks into the landscape, the venue's part rises to the venue mark.
//
// This file is only ever loaded by LiquidityRoom.tsx, which is itself lazy: a visitor who never
// opens the room never downloads three.js.
import * as THREE from 'three/webgpu';
import { EDITORIAL_GREEN, EDITORIAL_INK } from '../../../lib/editorial';
import { ROOM_COLUMNS, type RoomLayout, type RoomSpark } from '../../../lib/solana/clmm/roomLayout';

/** The floor, in scene units: wide by price, deep for the eye only, and the tallest hill. */
const W = 10;
const D = 4.4;
const H = 2.4;
const ROWS = 30;
/** Sparks drawn at once; each swap uses two (the positions' part and the venue's). */
const SPARKS = 14;
const FLIGHT_S = 2.8;
const SPLIT_AT = 0.58;
const LAUNCH_EVERY_S = 0.85;
const REPLAY_REST_S = 5;
const TURN_LIMIT = 1.05;

export interface RoomSceneInput {
  layout: RoomLayout;
  sparks: RoomSpark[];
  /** The venue's share of each fee, 0 to 1, as the tier account reads today. */
  venueShare: number;
}

/** Where two marks stand on the canvas, in CSS pixels from its top left, for the labels over it. */
export interface RoomMarks {
  now: { x: number; y: number };
  venue: { x: number; y: number };
}

export interface RoomScene {
  engine: 'webgpu' | 'webgl2';
  set(input: RoomSceneInput): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Off while the room is off screen or the tab is hidden: nothing is drawn. */
  setRunning(on: boolean): void;
  /** Turn the view by a drag of `dx` pixels. */
  turn(dx: number): void;
  dispose(): void;
}

const xAt = (fraction: number) => (fraction - 0.5) * W;
/** The hill's cross-section front to back: full at the middle, down to the floor at both edges. */
const ridge = (row: number) => Math.pow(Math.cos(((row / (ROWS - 1)) * 2 - 1) * (Math.PI / 2)), 1.6);
const ease = (t: number) => t * t * (3 - 2 * t);

interface Flight {
  spark: RoomSpark;
  startedAt: number;
}

export async function createRoomScene(canvas: HTMLCanvasElement, opts: { still: boolean; onFrame: (marks: RoomMarks) => void }): Promise<RoomScene> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  await renderer.init();
  renderer.setClearColor(0x000000, 0);
  const engine: RoomScene['engine'] = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const ink = new THREE.Color(EDITORIAL_INK);
  const green = new THREE.Color(EDITORIAL_GREEN);
  const dark = new THREE.Color('#0b1220');

  scene.add(new THREE.HemisphereLight(0xfff4d6, 0x05080f, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-4, 7, 5);
  scene.add(sun);

  // ── the landscape ──────────────────────────────────────────────────────────────────
  const cols = ROOM_COLUMNS;
  const positions = new Float32Array(cols * ROWS * 3);
  const colors = new Float32Array(cols * ROWS * 3);
  const index: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      positions[i] = xAt((c + 0.5) / cols);
      positions[i + 1] = 0;
      positions[i + 2] = (r / (ROWS - 1) - 0.5) * D;
    }
  }
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  const land = new THREE.BufferGeometry();
  land.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  land.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  land.setIndex(index);
  const landMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0.08, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(land, landMaterial));
  const wireMaterial = new THREE.MeshBasicMaterial({ color: ink, wireframe: true, transparent: true, opacity: 0.13 });
  const wire = new THREE.Mesh(land, wireMaterial);
  wire.position.y = 0.004;
  scene.add(wire);

  const grid = new THREE.GridHelper(W * 1.5, 30, ink, ink);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.07;
  grid.position.y = -0.01;
  scene.add(grid);

  // ── the pool's price ───────────────────────────────────────────────────────────────
  const sheetGeometry = new THREE.PlaneGeometry(D, H * 1.18);
  const sheetMaterial = new THREE.MeshBasicMaterial({ color: green, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const sheet = new THREE.Mesh(sheetGeometry, sheetMaterial);
  sheet.rotation.y = Math.PI / 2;
  sheet.position.y = (H * 1.18) / 2;
  scene.add(sheet);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: green });
  const sheetEdge = new THREE.LineSegments(new THREE.EdgesGeometry(sheetGeometry), edgeMaterial);
  sheet.add(sheetEdge);

  // ── the venue's mark ───────────────────────────────────────────────────────────────
  const venueAt = new THREE.Vector3(W / 2 - 0.9, H + 0.75, -D / 2 + 0.4);
  const venueGeometry = new THREE.OctahedronGeometry(0.26);
  const venueMaterial = new THREE.MeshBasicMaterial({ color: ink, wireframe: true });
  const venue = new THREE.Mesh(venueGeometry, venueMaterial);
  venue.position.copy(venueAt);
  scene.add(venue);

  // ── the wallet's positions ─────────────────────────────────────────────────────────
  const slabs = new THREE.Group();
  scene.add(slabs);
  const slabGeometry = new THREE.BoxGeometry(1, 1, 1);
  const slabEdges = new THREE.EdgesGeometry(slabGeometry);
  const slabFill = { in: new THREE.MeshBasicMaterial({ color: green, transparent: true, opacity: 0.1, depthWrite: false }), out: new THREE.MeshBasicMaterial({ color: ink, transparent: true, opacity: 0.06, depthWrite: false }) };
  const slabLine = { in: new THREE.LineBasicMaterial({ color: green }), out: new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.6 }) };

  // ── the sparks ─────────────────────────────────────────────────────────────────────
  const sparkGeometry = new THREE.IcosahedronGeometry(0.13, 1);
  const sparkMaterial = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sparks = new THREE.InstancedMesh(sparkGeometry, sparkMaterial, SPARKS * 2);
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparks.frustumCulled = false;
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SPARKS * 2; i++) {
    sparks.setMatrixAt(i, hidden);
    sparks.setColorAt(i, i % 2 === 0 ? green : ink);
  }
  scene.add(sparks);

  // ── state ──────────────────────────────────────────────────────────────────────────
  let target: RoomLayout | null = null;
  const shown = new Float32Array(cols);
  let nowX = 0;
  let nowY = 0;
  let venueShare = 0;
  let all: RoomSpark[] = [];
  const seen = new Set<string>();
  /** Swaps waiting to fly: the first replay, then any that land while the room is open. */
  let queue: RoomSpark[] = [];
  const flights: (Flight | null)[] = Array.from({ length: SPARKS }, () => null);
  let lastLaunch = -Infinity;
  let idleSince: number | null = null;
  let venuePulse = 0;

  let azimuth = 0.52;
  let size = { width: 1, height: 1 };
  let running = false;
  let disposed = false;
  let settled = false;
  const timer = new THREE.Timer();

  const placeCamera = (t: number) => {
    const aspect = size.width / size.height;
    // A narrow canvas (a phone) steps back so the whole floor stays in view.
    const radius = 12.6 / Math.min(1, aspect / 1.75);
    const a = azimuth + (opts.still ? 0 : Math.sin(t * 0.17) * 0.07);
    camera.position.set(Math.sin(a) * radius, 4.9, Math.cos(a) * radius);
    camera.lookAt(0, 0.75, 0);
  };

  const paintLand = (dt: number) => {
    if (!target) return;
    // The hills ease to a new reading instead of jumping; a still room takes it at once.
    const k = opts.still || !settled ? 1 : 1 - Math.exp(-dt * 5);
    for (let c = 0; c < cols; c++) shown[c] = shown[c]! + (target.heights[c]! - shown[c]!) * k;
    settled = true;
    const nowCol = target.now * cols - 0.5;
    const tint = new THREE.Color();
    for (let r = 0; r < ROWS; r++) {
      const lift = ridge(r);
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        const h = shown[c]!;
        positions[i + 1] = h * H * lift;
        // Cream where it is deep, green close to the pool's price: that is where swaps are paying.
        const near = Math.exp(-Math.pow((c - nowCol) / (cols * 0.07), 2));
        tint.copy(dark).lerp(ink, 0.12 + 0.5 * h * lift).lerp(green, near * 0.75 * Math.min(1, h * 4));
        colors[i] = tint.r;
        colors[i + 1] = tint.g;
        colors[i + 2] = tint.b;
      }
    }
    land.attributes.position!.needsUpdate = true;
    land.attributes.color!.needsUpdate = true;
    land.computeVertexNormals();
    land.computeBoundingSphere();
    nowX = xAt(target.now);
    const at = Math.max(0, Math.min(cols - 1, Math.round(nowCol)));
    nowY = shown[at]! * H;
    sheet.position.x = nowX;
    // The venue's mark keeps to the half of the room the price is not in, so the two labels never meet.
    venueAt.x = (target.now > 0.5 ? -1 : 1) * (W / 2 - 0.9);
    venue.position.copy(venueAt);
  };

  const buildSlabs = () => {
    slabs.clear();
    if (!target) return;
    for (const b of target.blocks) {
      const width = Math.max(0.04, (b.to - b.from) * W);
      const tall = H * 0.62;
      const kind = b.inRange ? 'in' : 'out';
      const fill = new THREE.Mesh(slabGeometry, slabFill[kind]);
      fill.scale.set(width, tall, D * 0.5);
      fill.position.set(xAt((b.from + b.to) / 2), tall / 2, 0);
      const line = new THREE.LineSegments(slabEdges, slabLine[kind]);
      fill.add(line);
      slabs.add(fill);
    }
  };

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const put = (slot: number, at: THREE.Vector3, scale: number) => {
    s.setScalar(scale);
    m.compose(at, q, s);
    sparks.setMatrixAt(slot, m);
  };

  const flySparks = (t: number) => {
    // Launch the next waiting swap into a free slot.
    if (queue.length > 0 && t - lastLaunch >= LAUNCH_EVERY_S) {
      const free = flights.indexOf(null);
      if (free >= 0) {
        flights[free] = { spark: queue.shift()!, startedAt: t };
        lastLaunch = t;
        idleSince = null;
      }
    }
    let busy = false;
    for (let i = 0; i < SPARKS; i++) {
      const f = flights[i];
      const lp = i * 2;
      const cut = i * 2 + 1;
      if (!f) {
        sparks.setMatrixAt(lp, hidden);
        sparks.setMatrixAt(cut, hidden);
        continue;
      }
      const u = (t - f.startedAt) / FLIGHT_S;
      if (u >= 1) {
        flights[i] = null;
        venuePulse = 1;
        sparks.setMatrixAt(lp, hidden);
        sparks.setMatrixAt(cut, hidden);
        continue;
      }
      busy = true;
      const meetY = nowY + 0.22;
      const big = f.spark.size;
      if (u < SPLIT_AT) {
        // In from the side the swap pushed from, in an arc, down to the price.
        const a = ease(u / SPLIT_AT);
        const from = f.spark.side === 'buy' ? -W / 2 - 1.4 : W / 2 + 1.4;
        // Low and in front, so a swap on its way in is never mistaken for the venue's part on its way up.
        p.set(from + (nowX - from) * a, 0.45 + (meetY - 0.45) * a + Math.sin(a * Math.PI) * 0.7, (1 - a) * D * 0.62);
        put(lp, p, big * 1.25);
        sparks.setMatrixAt(cut, hidden);
      } else {
        const b = ease((u - SPLIT_AT) / (1 - SPLIT_AT));
        // The positions' part sinks into the hill at the price, and is gone.
        p.set(nowX, meetY - (meetY - nowY * 0.5) * b, 0);
        put(lp, p, big * 1.25 * Math.cbrt(1 - venueShare) * (1 - b));
        // The venue's part rises to the venue's mark.
        p.set(nowX + (venueAt.x - nowX) * b, meetY + (venueAt.y - meetY) * b + Math.sin(b * Math.PI) * 0.5, venueAt.z * b);
        put(cut, p, venueShare > 0 ? big * 1.25 * Math.cbrt(venueShare) * (1 - b * 0.4) : 0);
      }
    }
    sparks.instanceMatrix.needsUpdate = true;
    // The page's swaps have all flown: rest, then run them again.
    if (!busy && queue.length === 0 && all.length > 0) {
      idleSince ??= t;
      if (t - idleSince >= REPLAY_REST_S) {
        queue = [...all];
        idleSince = null;
      }
    }
  };

  const v = new THREE.Vector3();
  const markOf = (at: THREE.Vector3) => {
    v.copy(at).project(camera);
    return { x: (v.x * 0.5 + 0.5) * size.width, y: (-v.y * 0.5 + 0.5) * size.height };
  };

  const frame = () => {
    if (disposed) return;
    timer.update();
    const dt = Math.min(0.1, timer.getDelta());
    const t = timer.getElapsed();
    placeCamera(t);
    paintLand(dt);
    if (!opts.still) {
      flySparks(t);
      venue.rotation.y = t * 0.6;
      venuePulse = Math.max(0, venuePulse - dt * 1.6);
      venue.scale.setScalar(1 + venuePulse * 0.5);
      sheetMaterial.opacity = 0.14 + Math.sin(t * 1.8) * 0.03;
    }
    renderer.render(scene, camera);
    opts.onFrame({ now: markOf(p.set(nowX, H * 1.18, 0)), venue: markOf(venueAt) });
  };

  const start = () => {
    if (opts.still) frame();
    else void renderer.setAnimationLoop(frame);
  };
  const stop = () => void renderer.setAnimationLoop(null);

  return {
    engine,
    set(input) {
      target = input.layout;
      venueShare = Math.max(0, Math.min(1, input.venueShare));
      all = input.sparks;
      // A swap not seen before flies next; the ones already shown wait for the replay.
      const fresh = all.filter((x) => !seen.has(x.signature));
      for (const x of fresh) seen.add(x.signature);
      queue.push(...fresh);
      buildSlabs();
      if (opts.still && running) frame();
    },
    resize(width, height, pixelRatio) {
      size = { width: Math.max(1, width), height: Math.max(1, height) };
      renderer.setPixelRatio(Math.min(2, pixelRatio));
      renderer.setSize(size.width, size.height, false);
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
      if (opts.still && running) frame();
    },
    setRunning(on) {
      if (on === running || disposed) return;
      running = on;
      if (on) start();
      else stop();
    },
    turn(dx) {
      azimuth = Math.max(-TURN_LIMIT, Math.min(TURN_LIMIT, azimuth - dx * 0.006));
      if (opts.still && running) frame();
    },
    dispose() {
      disposed = true;
      stop();
      for (const g of [land, sheetGeometry, sheetEdge.geometry, venueGeometry, slabGeometry, slabEdges, sparkGeometry, grid.geometry]) g.dispose();
      for (const mat of [landMaterial, wireMaterial, sheetMaterial, edgeMaterial, venueMaterial, slabFill.in, slabFill.out, slabLine.in, slabLine.out, sparkMaterial, grid.material as THREE.Material]) mat.dispose();
      sparks.dispose();
      renderer.dispose();
    },
  };
}
