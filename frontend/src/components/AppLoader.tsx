import React, { useState, useEffect, useRef, useCallback } from 'react';

/* ─────────────────────────────────────────────────────────────────────────────
   TEGRIDY FARMS — "Glitch Gallery" Splash Screen
   Cinematic luxury: void → golden line → 4 art pieces with glitch cuts →
   particle shatter → vortex → spring-physics text formation → click to enter.
   ────────────────────────────────────────────────────────────────────────── */

const ART_COLLECTION: Array<{ src: string; title: string }> = [
  { src: '/art/mfers-heaven.jpg', title: 'All MFers Go to Heaven' },
  { src: '/art/mumu-bull.jpg', title: 'Mumu the Bull' },
  { src: '/art/bobowelie.jpg', title: 'Bobowelie' },
  { src: '/art/jungle-bus.jpg', title: 'Jungle Bay Island' },
  { src: '/art/pool-party.jpg', title: 'Pool Party' },
  { src: '/art/boxing-ring.jpg', title: 'Fight Night' },
  { src: '/art/forest-scene.jpg', title: 'Enchanted Forest' },
  { src: '/art/chaos-scene.jpg', title: 'Chaos' },
  { src: '/art/ape-hug.jpg', title: 'The Brotherhood' },
  { src: '/art/beach-vibes.jpg', title: 'Beach Vibes' },
  { src: '/art/dance-night.jpg', title: 'Dance Night' },
  { src: '/art/wrestler.jpg', title: 'The Wrestler' },
  { src: '/art/smoking-duo.jpg', title: 'Smoking Session' },
  { src: '/art/beach-sunset.jpg', title: 'Sunset Beach' },
  { src: '/art/porch-chill.jpg', title: 'Porch Chill' },
  { src: '/art/rose-ape.jpg', title: 'Rose Ape' },
  { src: '/art/sword-of-love.jpg', title: 'The Sword of Love' },
  { src: '/art/towelie-window.jpg', title: 'Window Watch' },
  { src: '/art/bus-crew.jpg', title: 'The Crew' },
  { src: '/art/gallery-collage.jpg', title: 'The Collection' },
  { src: '/art/jungle-dark.jpg', title: 'Into the Jungle' },
  { src: '/art/jb-christmas.jpg', title: 'JB Christmas' },
];

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  targetX: number; targetY: number;
  hasTarget: boolean;
  r: number; g: number; b: number;
  size: number; alpha: number;
  angle: number; angularVel: number;
  radius: number;
  trail: Array<{ x: number; y: number; alpha: number }>;
}

interface ExitShard {
  poly: Array<{x: number; y: number}>;
  origCx: number; origCy: number;
  cx: number; cy: number;
  dist: number; delay: number;
  vx: number; vy: number;
  rot: number; rotSpeed: number;
  alpha: number; scale: number;
  tex: HTMLCanvasElement | null;
  texOffX: number; texOffY: number;
}

const GOLD = '#d4a017';
const SUBLIMINAL = ['TEGRIDY', 'FAFO', 'DM+T', 'WAGMI'];
const STIFFNESS = 0.07;
const DAMPING = 0.87;

/* ── Timings (ms) ── */
const T_VOID_END       = 1500;
const T_ART_START      = T_VOID_END;          // 1500
const T_ART_DURATION   = 2000;
const T_ART_COUNT      = 4;
const T_ART_END        = T_ART_START + T_ART_DURATION * T_ART_COUNT; // 9500
const T_SHATTER_END    = 11000;
const T_VORTEX_END     = 12500;
const T_TEXT_END       = 14500;

/* ── Preload (allSettled — skip failures) ── */
function preloadImages(srcs: string[]): Promise<(HTMLImageElement | null)[]> {
  return Promise.allSettled(
    srcs.map(
      (src) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        }),
    ),
  ).then((results) =>
    results.map((r) => (r.status === 'fulfilled' ? r.value : null)),
  );
}

/* ── Easing ── */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/* ── Shuffle (Fisher-Yates) ── */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── Build radial glass-shatter shards from click point ── */
function buildExitShards(clickX: number, clickY: number, W: number, H: number): ExitShard[] {
  const numRadials = 8;
  const numRings = 3;
  const maxDist = Math.sqrt(W * W + H * H) * 0.8;

  // Radial angles with organic jitter
  const angles: number[] = [];
  const aStep = (Math.PI * 2) / numRadials;
  for (let i = 0; i < numRadials; i++) {
    angles.push(aStep * i + (Math.random() - 0.5) * aStep * 0.45);
  }
  angles.sort((a, b) => a - b);

  // Ring distances
  const rings = [0];
  for (let i = 1; i <= numRings; i++) {
    rings.push((maxDist * i) / numRings);
  }

  // Precompute shared vertices so adjacent shards have no gaps
  const verts: Array<Array<{x: number; y: number}>> = [];
  for (let r = 0; r <= numRings; r++) {
    verts[r] = [];
    for (let a = 0; a < numRadials; a++) {
      if (r === 0) {
        verts[r][a] = { x: clickX, y: clickY };
      } else {
        const jitter = rings[r] * 0.08;
        verts[r][a] = {
          x: clickX + Math.cos(angles[a]) * rings[r] + (Math.random() - 0.5) * jitter,
          y: clickY + Math.sin(angles[a]) * rings[r] + (Math.random() - 0.5) * jitter,
        };
      }
    }
  }

  const shards: ExitShard[] = [];
  for (let r = 0; r < numRings; r++) {
    for (let a = 0; a < numRadials; a++) {
      const na = (a + 1) % numRadials;
      const poly = r === 0
        ? [verts[0][a], verts[1][a], verts[1][na]]
        : [verts[r][a], verts[r + 1][a], verts[r + 1][na], verts[r][na]];

      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      const dist = Math.sqrt((cx - clickX) ** 2 + (cy - clickY) ** 2);
      const outAngle = Math.atan2(cy - clickY, cx - clickX);
      const speed = 4 + Math.random() * 6;

      shards.push({
        poly,
        origCx: cx, origCy: cy,
        cx, cy,
        dist,
        delay: 100 + (dist / maxDist) * 250,
        vx: Math.cos(outAngle) * speed,
        vy: Math.sin(outAngle) * speed - 3,
        rot: 0,
        rotSpeed: (Math.random() - 0.5) * 0.15,
        alpha: 1,
        scale: 1,
        tex: null,
        texOffX: 0, texOffY: 0,
      });
    }
  }
  return shards;
}

/* ── Build golden snake path that coils around text ── */
function buildSnakePath(W: number, H: number): Array<{x: number; y: number}> {
  const mainSize = Math.min(130, W * 0.15);
  const subSize = Math.min(60, W * 0.07);
  const cx = W / 2;
  const cy = H / 2;
  // Text vertical center (between TEGRIDY and FARMS)
  const textCenterY = cy + (mainSize * 0.45 - subSize * 0.5) / 2;
  const points: Array<{x: number; y: number}> = [];
  const numPoints = 180;
  const revolutions = 2.5;
  // Elliptical radii sized to wrap tightly around both words
  const maxRx = Math.min(W * 0.32, mainSize * 2.8);
  const maxRy = mainSize * 0.9;

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const angle = t * revolutions * Math.PI * 2;
    // Spiral outward from tight to wide
    const r = 0.2 + t * 0.8;
    // Organic waviness
    const wobble = Math.sin(angle * 4) * 0.06 + Math.sin(angle * 7) * 0.03;
    points.push({
      x: cx + Math.cos(angle) * maxRx * (r + wobble),
      y: textCenterY + Math.sin(angle) * maxRy * (r + wobble),
    });
  }
  return points;
}

/* ── Text pixel map ── */
function getTextPixels(
  text: string, fontSize: number, W: number, H: number, offsetY: number,
): Array<{ x: number; y: number }> {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d')!;
  cx.font = `bold ${fontSize}px "Inter", "Helvetica Neue", sans-serif`;
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillStyle = '#fff';
  cx.fillText(text, W / 2, H / 2 + offsetY);
  const d = cx.getImageData(0, 0, W, H).data;
  const pts: Array<{ x: number; y: number }> = [];
  const step = Math.max(3, Math.floor(Math.min(W, H) / 250));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (d[(y * W + x) * 4 + 3] > 128) pts.push({ x, y });
    }
  }
  return pts;
}

/* ── Cover-fit helper ── */
function coverFit(
  img: HTMLImageElement, areaW: number, areaH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const imgAspect = img.width / img.height;
  const areaAspect = areaW / areaH;
  let sw: number, sh: number, sx: number, sy: number;
  if (imgAspect > areaAspect) {
    // Image wider than area — crop sides, keep full height
    sh = img.height; sw = sh * areaAspect;
    sx = (img.width - sw) / 2; sy = 0;
  } else {
    // Image taller than area — crop top/bottom
    // Bias toward upper 35% to capture character faces
    sw = img.width; sh = sw / areaAspect;
    sx = 0;
    const maxSy = img.height - sh;
    sy = Math.min(maxSy * 0.35, maxSy); // 35% from top instead of 50%
  }
  return { sx, sy, sw, sh };
}

/* ═══════════════════════════════════════════════════════════════════════════ */

export function AppLoader({ onComplete, children }: { onComplete?: () => void; children?: React.ReactNode }) {
  const [visible, setVisible] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    phase: 'loading' as string,
    t0: 0,
    images: [] as HTMLImageElement[],
    titles: [] as string[],
    particles: [] as Particle[],
    exitStart: 0,
    exitClickX: 0,
    exitClickY: 0,
    exitSnapshot: null as HTMLCanvasElement | null,
    exitShards: [] as ExitShard[],
    exitShardsBuilt: false,
    exitSnakePath: [] as Array<{x: number; y: number}>,
    textTargetsReady: false,
    clicked: false,
    dpr: 1,
    isMobile: false,
    prevFrameData: null as ImageData | null,
  });

  const finalize = useCallback(() => {
    setVisible(false);
    onComplete?.();
  }, [onComplete]);

  /* ── Skip for repeat visits ── */
  useEffect(() => {
    if (sessionStorage.getItem('tf_loaded')) {
      finalize();
    }
  }, [finalize]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const s = stateRef.current;
    // Allow click during hold, textForm, or vortex phases
    if (!s.clicked && (s.phase === 'hold' || s.phase === 'textForm' || s.phase === 'vortex')) {
      s.clicked = true;
      s.phase = 'exit';
      s.exitStart = performance.now();
      s.exitClickX = e.clientX;
      s.exitClickY = e.clientY;
      // Snapshot current canvas for shard textures
      const canvas = canvasRef.current;
      if (canvas) {
        const snap = document.createElement('canvas');
        snap.width = canvas.width;
        snap.height = canvas.height;
        const sctx = snap.getContext('2d');
        if (sctx) sctx.drawImage(canvas, 0, 0);
        s.exitSnapshot = snap;
      }
    }
  }, []);

  useEffect(() => {
    if (!visible) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const s = stateRef.current;
    s.dpr = Math.min(window.devicePixelRatio || 1, 2);
    s.isMobile = window.innerWidth < 768;

    let W = window.innerWidth;
    let H = window.innerHeight;

    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas!.width = W * s.dpr;
      canvas!.height = H * s.dpr;
      canvas!.style.width = W + 'px';
      canvas!.style.height = H + 'px';
      ctx!.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    let rafId = 0;
    let disposed = false;

    /* ── Start loading images ── */
    const chosen = shuffle(ART_COLLECTION).slice(0, T_ART_COUNT);
    const srcs = chosen.map((a) => a.src);
    const titles = chosen.map((a) => a.title);

    preloadImages(srcs).then((results) => {
      if (disposed) return;
      const loaded = results.filter((r): r is HTMLImageElement => r !== null);
      if (loaded.length === 0) {
        // Fallback: skip to text
        s.images = [];
        s.titles = [];
      } else {
        s.images = loaded;
        s.titles = titles.slice(0, loaded.length);
      }
      s.phase = 'void';
      s.t0 = performance.now();
      rafId = requestAnimationFrame(tick);
    });

    /* ─────────── Draw helpers ─────────── */

    function drawGoldenLine(progress: number, alpha: number) {
      if (progress <= 0 || alpha <= 0) return;
      const cx2 = W / 2;
      const cy = H * 0.38;
      const halfLen = (W * 0.35) * Math.min(progress, 1);

      // Warm glow
      const glow = ctx!.createRadialGradient(cx2, cy, 0, cx2, cy, halfLen * 1.5);
      glow.addColorStop(0, `rgba(212,160,23,${0.08 * alpha})`);
      glow.addColorStop(1, 'rgba(212,160,23,0)');
      ctx!.fillStyle = glow;
      ctx!.fillRect(cx2 - halfLen * 1.5, cy - 40, halfLen * 3, 80);

      // Line
      ctx!.strokeStyle = GOLD;
      ctx!.globalAlpha = alpha * 0.5;
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.moveTo(cx2 - halfLen, cy);
      ctx!.lineTo(cx2 + halfLen, cy);
      ctx!.stroke();
      ctx!.globalAlpha = 1;
    }

    function drawPurpleMist(alpha: number) {
      if (alpha <= 0) return;
      const g = ctx!.createRadialGradient(W / 2, H / 2, W * 0.1, W / 2, H / 2, W * 0.7);
      g.addColorStop(0, 'rgba(139,92,246,0)');
      g.addColorStop(0.7, `rgba(139,92,246,${0.03 * alpha})`);
      g.addColorStop(1, `rgba(139,92,246,${0.06 * alpha})`);
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, W, H);
    }

    function drawArtPiece(
      img: HTMLImageElement, alpha: number, zoom: number,
      borderAlpha: number, title: string, titleAlpha: number,
    ) {
      ctx!.save();
      const artScale = 0.72;
      const artW = W * artScale;
      const artH = H * artScale;
      const artX = (W - artW) / 2;
      const artY = (H - artH) / 2;

      // Clip to art area
      ctx!.beginPath();
      ctx!.rect(artX, artY, artW, artH);
      ctx!.clip();

      // Ken Burns zoom
      ctx!.translate(W / 2, H / 2);
      ctx!.scale(zoom, zoom);
      ctx!.translate(-W / 2, -H / 2);

      ctx!.globalAlpha = alpha;
      const fit = coverFit(img, artW, artH);
      ctx!.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, artX, artY, artW, artH);

      // Color grading — purple tint
      ctx!.globalCompositeOperation = 'overlay';
      ctx!.fillStyle = 'rgba(139,92,246,0.06)';
      ctx!.fillRect(artX, artY, artW, artH);
      ctx!.globalCompositeOperation = 'source-over';

      // Vignette
      ctx!.globalAlpha = alpha;
      const vig = ctx!.createRadialGradient(W / 2, H / 2, artW * 0.2, W / 2, H / 2, artW * 0.55);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.4)');
      ctx!.fillStyle = vig;
      ctx!.fillRect(artX, artY, artW, artH);

      ctx!.restore();

      // Golden border (outside clip)
      if (borderAlpha > 0) {
        ctx!.save();
        ctx!.globalAlpha = borderAlpha * 0.5;
        ctx!.strokeStyle = GOLD;
        ctx!.lineWidth = 1;
        ctx!.strokeRect(artX + 0.5, artY + 0.5, artW - 1, artH - 1);
        ctx!.restore();
      }

      // Title (museum placard)
      if (titleAlpha > 0 && title) {
        ctx!.save();
        ctx!.globalAlpha = titleAlpha * 0.3;
        ctx!.fillStyle = '#ffffff';
        ctx!.font = '200 12px "Inter", "Helvetica Neue", sans-serif';
        ctx!.textAlign = 'center';
        ctx!.letterSpacing = '8px';
        ctx!.fillText(title.toUpperCase(), W / 2, artY + artH + 30);
        ctx!.restore();
      }
    }

    function drawGlitchCut(progress: number) {
      // Chromatic aberration
      const offset = 6;
      try {
        const imgData = ctx!.getImageData(0, 0, canvas!.width, canvas!.height);
        const data = imgData.data;
        const shifted = ctx!.createImageData(canvas!.width, canvas!.height);
        const sd = shifted.data;
        const cw = canvas!.width;
        const ch = canvas!.height;

        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const i = (y * cw + x) * 4;
            // Red channel shifted right
            const rxSrc = Math.min(x + offset * s.dpr, cw - 1);
            const ri = (y * cw + rxSrc) * 4;
            sd[i] = data[ri];
            // Green channel stays
            sd[i + 1] = data[i + 1];
            // Blue channel shifted left
            const bxSrc = Math.max(x - offset * s.dpr, 0);
            const bi = (y * cw + bxSrc) * 4;
            sd[i + 2] = data[bi + 2];
            sd[i + 3] = data[i + 3];
          }
        }
        ctx!.putImageData(shifted, 0, 0);
      } catch { /* security error on tainted canvas — skip */ }

      // Horizontal tear lines
      const tearCount = 3 + Math.floor(Math.random() * 3);
      try {
        for (let i = 0; i < tearCount; i++) {
          const ty = Math.floor(Math.random() * H);
          const tOffset = (Math.random() - 0.5) * 20;
          const stripH = Math.max(2, Math.floor(2 + Math.random() * 8));
          const tearData = ctx!.getImageData(0, ty * s.dpr, canvas!.width, stripH * s.dpr);
          ctx!.putImageData(tearData, tOffset * s.dpr, ty * s.dpr);
        }
      } catch { /* skip */ }

      // Noise grain
      if (progress < 0.5) {
        ctx!.save();
        for (let i = 0; i < 200; i++) {
          ctx!.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.05})`;
          ctx!.fillRect(Math.random() * W, Math.random() * H, 3, 3);
        }
        ctx!.restore();
      }

      // Scanlines
      ctx!.save();
      ctx!.fillStyle = 'rgba(0,0,0,0.08)';
      for (let y = 0; y < H; y += 4) {
        ctx!.fillRect(0, y, W, 2);
      }
      ctx!.restore();

      // White flash
      if (progress < 0.3) {
        ctx!.save();
        ctx!.fillStyle = 'rgba(255,255,255,0.08)';
        ctx!.fillRect(0, 0, W, H);
        ctx!.restore();
      }

      // Slight skew
      if (progress < 0.6) {
        try {
          const sk = ctx!.getImageData(0, 0, canvas!.width, canvas!.height);
          ctx!.clearRect(0, 0, W, H);
          ctx!.save();
          ctx!.translate(3, 0);
          ctx!.transform(1, 0, 0.01, 1, 0, 0);
          ctx!.putImageData(sk, 0, 0);
          ctx!.restore();
        } catch { /* skip */ }
      }
    }

    function drawSubliminalText() {
      const word = SUBLIMINAL[Math.floor(Math.random() * SUBLIMINAL.length)];
      ctx!.save();
      ctx!.translate(W / 2, H / 2);
      ctx!.rotate((Math.random() - 0.5) * 0.1);
      ctx!.font = '600 60px "Courier New", monospace';
      ctx!.textAlign = 'center';
      ctx!.textBaseline = 'middle';
      // RGB ghost
      ctx!.fillStyle = 'rgba(255,80,80,0.25)';
      ctx!.fillText(word, 3, 0);
      ctx!.fillStyle = 'rgba(80,80,255,0.25)';
      ctx!.fillText(word, -3, 0);
      ctx!.fillStyle = 'rgba(255,255,255,0.4)';
      ctx!.fillText(word, 0, 0);
      ctx!.restore();
    }

    /* ── Create particles from last art image ── */
    function createParticles(img: HTMLImageElement) {
      // Draw art to offscreen canvas to sample colors
      const oc = document.createElement('canvas');
      const artW = W * 0.72;
      const artH = H * 0.72;
      oc.width = Math.floor(artW);
      oc.height = Math.floor(artH);
      const ocx = oc.getContext('2d')!;
      const fit = coverFit(img, artW, artH);
      ocx.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, 0, 0, oc.width, oc.height);

      let pixelData: ImageData | null = null;
      try {
        pixelData = ocx.getImageData(0, 0, oc.width, oc.height);
      } catch { /* tainted */ }

      const count = s.isMobile ? 1200 : 2000;
      const particles: Particle[] = [];
      const artX = (W - artW) / 2;
      const artY = (H - artH) / 2;

      for (let i = 0; i < count; i++) {
        const px = Math.random() * oc.width;
        const py = Math.random() * oc.height;
        let r = 200, g = 180, b = 140;
        if (pixelData) {
          const idx = (Math.floor(py) * oc.width + Math.floor(px)) * 4;
          r = pixelData.data[idx];
          g = pixelData.data[idx + 1];
          b = pixelData.data[idx + 2];
        }
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 6;
        particles.push({
          x: artX + px,
          y: artY + py,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          targetX: W / 2,
          targetY: H / 2,
          hasTarget: false,
          r, g, b,
          size: 1.5 + Math.random() * 2,
          alpha: 1,
          angle: Math.random() * Math.PI * 2,
          angularVel: (Math.random() - 0.5) * 0.04,
          radius: 0,
          trail: [],
        });
      }
      s.particles = particles;
    }

    /* ── Assign text targets ── */
    function assignTextTargets() {
      const mainSize = Math.min(130, W * 0.15);
      const subSize = Math.min(60, W * 0.07);
      const mainPts = getTextPixels('TEGRIDY', mainSize, W, H, -subSize * 0.5);
      const subPts = getTextPixels('FARMS', subSize, W, H, mainSize * 0.45);
      const allPts = [...mainPts, ...subPts];

      const shuffled = shuffle([...Array(s.particles.length).keys()]);
      for (let i = 0; i < Math.min(allPts.length, s.particles.length); i++) {
        const p = s.particles[shuffled[i]];
        p.targetX = allPts[i].x;
        p.targetY = allPts[i].y;
        p.hasTarget = true;
      }
      s.textTargetsReady = true;
    }

    /* ─────────── Main render loop ─────────── */
    function tick(now: number) {
      if (disposed) return;
      const elapsed = now - s.t0;
      ctx!.clearRect(0, 0, W, H);

      // Black BG for all phases except exit (exit is transparent to show app)
      if (s.phase !== 'exit') {
        ctx!.fillStyle = '#000';
        ctx!.fillRect(0, 0, W, H);
      }

      const phase = s.phase;

      /* ── VOID ── */
      if (phase === 'void') {
        if (elapsed < 500) {
          // Pure black
        } else if (elapsed < 1300) {
          // Golden line draws
          const lp = (elapsed - 500) / 800;
          drawGoldenLine(easeInOutCubic(lp), 1);
        } else if (elapsed < T_VOID_END) {
          drawGoldenLine(1, 1);
          // Purple mist fades in
          const mp = (elapsed - 1200) / 300;
          drawPurpleMist(easeInOutCubic(Math.min(mp, 1)));
        }

        if (elapsed >= T_VOID_END) {
          if (s.images.length === 0) {
            // No images loaded — skip to text formation
            s.phase = 'textForm';
            s.t0 = now;
            // Create simple colored particles
            const count = s.isMobile ? 1200 : 2000;
            const particles: Particle[] = [];
            for (let i = 0; i < count; i++) {
              particles.push({
                x: Math.random() * W, y: Math.random() * H,
                vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
                targetX: W / 2, targetY: H / 2, hasTarget: false,
                r: 180 + Math.random() * 75, g: 140 + Math.random() * 60,
                b: 80 + Math.random() * 60,
                size: 1.5 + Math.random() * 2, alpha: 0.8,
                angle: 0, angularVel: 0, radius: 0, trail: [],
              });
            }
            s.particles = particles;
            assignTextTargets();
          } else {
            s.phase = 'art';
            s.t0 = now;
          }
        }
      }

      /* ── ART GALLERY ── */
      if (phase === 'art') {
        const artElapsed = elapsed;
        const pieceIdx = Math.floor(artElapsed / T_ART_DURATION);
        const pieceTime = artElapsed % T_ART_DURATION;

        // Background elements
        drawGoldenLine(1, 0.2);
        drawPurpleMist(0.5);

        if (pieceIdx >= s.images.length) {
          // Start shatter
          s.phase = 'shatter';
          s.t0 = now;
          createParticles(s.images[s.images.length - 1]);
          rafId = requestAnimationFrame(tick);
          return;
        }

        const img = s.images[pieceIdx];
        const title = s.titles[pieceIdx] || '';

        if (pieceTime < 600) {
          // Fade in
          const fp = pieceTime / 600;
          const alpha = easeInOutCubic(fp);
          const zoom = 1 + fp * 0.01; // start of Ken Burns
          drawArtPiece(img, alpha, zoom, alpha * 0.4, title, alpha);
        } else if (pieceTime < 1400) {
          // Hold & breathe — Ken Burns continues
          const hp = (pieceTime - 600) / 800;
          const zoom = 1.01 + hp * 0.015;
          drawArtPiece(img, 1, zoom, 0.4, title, 1);
        } else if (pieceTime < 1920) {
          // GLITCH CUT (520ms total: 200ms glitch, 240ms transition, 80ms black)
          const glitchTime = pieceTime - 1400;

          if (glitchTime < 200) {
            // Draw current art then apply glitch
            const zoom = 1.025 + (glitchTime / 200) * 0.015;
            drawArtPiece(img, 1, zoom, 0.4, title, 1);
            drawGlitchCut(glitchTime / 200);
          } else if (glitchTime < 440) {
            // Transition: more noise, less art
            const tp = (glitchTime - 200) / 240;
            const fadeAlpha = 1 - easeInOutCubic(tp);
            if (fadeAlpha > 0.05) {
              drawArtPiece(img, fadeAlpha, 1.04, 0, '', 0);
              if (tp < 0.5) drawGlitchCut(0.5 + tp);
            }
          }
          // else: 440-520 = 80ms black gap with subliminal
          if (glitchTime >= 440 && glitchTime < 520) {
            drawSubliminalText();
          }
        } else {
          // 1920-2000: tail end, black (handled by gap, next piece starts at 0)
        }
      }

      /* ── SHATTER ── */
      if (phase === 'shatter') {
        drawGoldenLine(1, 0.15);
        drawPurpleMist(0.3);

        const shatterElapsed = elapsed;
        const shatterDuration = T_SHATTER_END - T_ART_END; // 1500ms

        // Extra dramatic glitch on first 300ms
        if (shatterElapsed < 300) {
          const lastImg = s.images[s.images.length - 1];
          const gp = shatterElapsed / 300;
          const alpha = 1 - easeInOutCubic(gp);
          if (alpha > 0.05) {
            drawArtPiece(lastImg, alpha, 1.04, 0, '', 0);
            // Intensified glitch: 12px aberration (handled by scale)
            drawGlitchCut(gp * 0.8);
            // Extra noise
            for (let i = 0; i < 100; i++) {
              ctx!.fillStyle = `rgba(255,255,255,${0.1 + Math.random() * 0.1})`;
              ctx!.fillRect(Math.random() * W, Math.random() * H, 4, 4);
            }
          }
        }

        // Particles: explosive burst with deceleration
        for (const p of s.particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.97;
          p.vy *= 0.97;

          // Trail
          p.trail.push({ x: p.x, y: p.y, alpha: p.alpha });
          if (p.trail.length > 8) p.trail.shift();

          // Draw trail
          for (const t of p.trail) {
            ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${t.alpha * 0.2})`;
            ctx!.fillRect(t.x, t.y, p.size * 0.6, p.size * 0.6);
          }
          // Draw particle
          ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
          ctx!.fillRect(p.x, p.y, p.size, p.size);
        }

        if (shatterElapsed >= shatterDuration) {
          s.phase = 'vortex';
          s.t0 = now;
        }
      }

      /* ── VORTEX ── */
      if (phase === 'vortex') {
        drawGoldenLine(1, 0.12);

        const vortexDuration = T_VORTEX_END - T_SHATTER_END; // 1500ms
        const vp = Math.min(elapsed / vortexDuration, 1);
        const cx2 = W / 2;
        const cy = H / 2;

        for (const p of s.particles) {
          // Spiral toward center
          const dx = cx2 - p.x;
          const dy = cy - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const targetR = Math.max(20, (1 - vp) * W * 0.4);
          const angle = Math.atan2(dy, dx);

          p.angle += 0.03 + vp * 0.06;
          const spiralAngle = angle + p.angle;

          if (dist > targetR) {
            p.vx += dx * 0.01;
            p.vy += dy * 0.01;
          } else {
            p.x = cx2 + Math.cos(spiralAngle) * targetR;
            p.y = cy + Math.sin(spiralAngle) * targetR;
          }

          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.92;
          p.vy *= 0.92;

          // Trail
          p.trail.push({ x: p.x, y: p.y, alpha: p.alpha });
          if (p.trail.length > 6) p.trail.shift();
          for (const t of p.trail) {
            ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${t.alpha * 0.15})`;
            ctx!.fillRect(t.x, t.y, p.size * 0.5, p.size * 0.5);
          }
          ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
          ctx!.fillRect(p.x, p.y, p.size, p.size);
        }

        if (elapsed >= vortexDuration) {
          s.phase = 'textForm';
          s.t0 = now;
          assignTextTargets();
        }
      }

      /* ── TEXT FORMATION ── */
      if (phase === 'textForm') {
        const textDuration = T_TEXT_END - T_VORTEX_END; // 2000ms
        const tp = Math.min(elapsed / textDuration, 1);

        drawGoldenLine(1, 0.1 + tp * 0.15);
        drawPurpleMist(tp * 0.4);

        for (const p of s.particles) {
          if (p.hasTarget) {
            // Spring physics
            const dx = p.targetX - p.x;
            const dy = p.targetY - p.y;
            p.vx += dx * STIFFNESS;
            p.vy += dy * STIFFNESS;
            p.vx *= DAMPING;
            p.vy *= DAMPING;
            p.x += p.vx;
            p.y += p.vy;
            p.alpha = Math.min(1, p.alpha + 0.02);
          } else {
            // Non-target: drift to edges
            const cx2 = W / 2;
            const cy = H / 2;
            const dx = p.x - cx2;
            const dy = p.y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < W * 0.6) {
              p.vx += (dx / dist) * 0.15;
              p.vy += (dy / dist) * 0.15;
            }
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.98;
            p.vy *= 0.98;
            p.alpha = Math.max(0.05, p.alpha - 0.005);
          }

          if (p.alpha > 0.02) {
            ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
            ctx!.fillRect(p.x, p.y, p.size, p.size);
          }
        }

        // Ghost text glow for readability
        if (tp > 0.3) {
          const glowAlpha = Math.min(0.1, (tp - 0.3) * 0.15);
          const mainSize = Math.min(130, W * 0.15);
          const subSize = Math.min(60, W * 0.07);
          ctx!.save();
          ctx!.globalAlpha = glowAlpha;
          ctx!.font = `bold ${mainSize}px "Inter", "Helvetica Neue", sans-serif`;
          ctx!.textAlign = 'center';
          ctx!.textBaseline = 'middle';
          ctx!.fillStyle = '#fff';
          ctx!.shadowColor = '#fff';
          ctx!.shadowBlur = 20;
          ctx!.fillText('TEGRIDY', W / 2, H / 2 - subSize * 0.5);
          ctx!.font = `bold ${subSize}px "Inter", "Helvetica Neue", sans-serif`;
          ctx!.fillText('FARMS', W / 2, H / 2 + mainSize * 0.45);
          ctx!.restore();
        }

        // Golden underline draws left to right
        if (tp > 0.5) {
          const ulp = (tp - 0.5) / 0.5;
          const mainSize = Math.min(130, W * 0.15);
          const lineY = H / 2 + mainSize * 0.45 + 25;
          const lineW = Math.min(180, W * 0.2) * easeInOutCubic(ulp);
          ctx!.save();
          ctx!.strokeStyle = GOLD;
          ctx!.globalAlpha = 0.5;
          ctx!.lineWidth = 1;
          ctx!.beginPath();
          ctx!.moveTo(W / 2 - lineW, lineY);
          ctx!.lineTo(W / 2 + lineW, lineY);
          ctx!.stroke();
          // Trailing glow
          const tlGlow = ctx!.createRadialGradient(
            W / 2 + lineW, lineY, 0, W / 2 + lineW, lineY, 20,
          );
          tlGlow.addColorStop(0, `rgba(212,160,23,${0.3 * ulp})`);
          tlGlow.addColorStop(1, 'rgba(212,160,23,0)');
          ctx!.fillStyle = tlGlow;
          ctx!.fillRect(W / 2 + lineW - 20, lineY - 20, 40, 40);
          ctx!.restore();
        }

        if (elapsed >= textDuration) {
          s.phase = 'hold';
          s.t0 = now;
        }
      }

      /* ── HOLD ── */
      if (phase === 'hold') {
        const breathT = now * 0.001;
        drawGoldenLine(1, 0.15 + Math.sin(breathT * 0.5) * 0.05);

        // Pulsing purple glow
        const purpleAlpha = 0.3 + Math.sin(breathT * 0.7) * 0.1;
        drawPurpleMist(purpleAlpha);

        // Particles breathe
        for (const p of s.particles) {
          if (p.hasTarget) {
            // Gentle oscillation
            const bx = Math.sin(breathT + p.targetX * 0.01) * 0.5;
            const by = Math.cos(breathT + p.targetY * 0.01) * 0.5;
            const dx = p.targetX + bx - p.x;
            const dy = p.targetY + by - p.y;
            p.vx += dx * 0.03;
            p.vy += dy * 0.03;
            p.vx *= 0.9;
            p.vy *= 0.9;
            p.x += p.vx;
            p.y += p.vy;
          } else {
            // Ambient drift
            p.vx += (Math.random() - 0.5) * 0.05;
            p.vy += (Math.random() - 0.5) * 0.05;
            p.vx *= 0.99;
            p.vy *= 0.99;
            p.x += p.vx;
            p.y += p.vy;
            // Wrap
            if (p.x < 0) p.x = W;
            if (p.x > W) p.x = 0;
            if (p.y < 0) p.y = H;
            if (p.y > H) p.y = 0;
          }

          if (p.alpha > 0.02) {
            ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
            ctx!.fillRect(p.x, p.y, p.size, p.size);
          }
        }

        // Ghost text
        const mainSize = Math.min(130, W * 0.15);
        const subSize = Math.min(60, W * 0.07);
        ctx!.save();
        ctx!.globalAlpha = 0.1;
        ctx!.font = `bold ${mainSize}px "Inter", "Helvetica Neue", sans-serif`;
        ctx!.textAlign = 'center';
        ctx!.textBaseline = 'middle';
        ctx!.fillStyle = '#fff';
        ctx!.shadowColor = '#fff';
        ctx!.shadowBlur = 20;
        ctx!.fillText('TEGRIDY', W / 2, H / 2 - subSize * 0.5);
        ctx!.font = `bold ${subSize}px "Inter", "Helvetica Neue", sans-serif`;
        ctx!.fillText('FARMS', W / 2, H / 2 + mainSize * 0.45);
        ctx!.restore();

        // Golden underline (pulsing)
        const lineY = H / 2 + mainSize * 0.45 + 25;
        const lineW = Math.min(180, W * 0.2);
        ctx!.save();
        ctx!.strokeStyle = GOLD;
        ctx!.globalAlpha = 0.35 + Math.sin(breathT) * 0.15;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.moveTo(W / 2 - lineW, lineY);
        ctx!.lineTo(W / 2 + lineW, lineY);
        ctx!.stroke();
        ctx!.restore();

        // "Click to Enter"
        const ctaAlpha = 0.25 + (Math.sin(breathT * 2.5) * 0.5 + 0.5) * 0.35;
        ctx!.save();
        ctx!.globalAlpha = ctaAlpha;
        ctx!.fillStyle = '#fff';
        ctx!.font = '200 13px "Inter", "Helvetica Neue", sans-serif';
        ctx!.textAlign = 'center';
        ctx!.letterSpacing = '8px';
        ctx!.fillText('CLICK TO ENTER', W / 2, lineY + 40);
        ctx!.restore();
      }

      /* ── EXIT: Glass Shatter ── */
      if (phase === 'exit') {
        const exitElapsed = now - s.exitStart;

        // Build shards as CSS-animated DOM elements (GPU-composited)
        if (!s.exitShardsBuilt) {
          s.exitShardsBuilt = true;
          s.exitShards = buildExitShards(s.exitClickX, s.exitClickY, W, H);
          if (overlayRef.current) overlayRef.current.style.background = 'transparent';
          if (canvasRef.current) canvasRef.current.style.display = 'none';

          const snap = s.exitSnapshot;
          const dpr = s.dpr;
          const overlay = overlayRef.current;
          const cx = s.exitClickX;
          const cy = s.exitClickY;

          if (snap && overlay) {
            // Inject all keyframes at once
            const style = document.createElement('style');
            style.textContent = `
              @keyframes exitShake {
                0%, 100% { transform: translate(0,0); }
                10% { transform: translate(-6px, 3px); }
                20% { transform: translate(5px, -4px); }
                30% { transform: translate(-3px, 5px); }
                40% { transform: translate(4px, -2px); }
                50% { transform: translate(-2px, 3px); }
                60% { transform: translate(3px, -1px); }
                70% { transform: translate(-1px, 2px); }
                80% { transform: translate(1px, -1px); }
              }
              @keyframes exitFlash { to { opacity: 0; } }
              @keyframes exitRing {
                0% { transform: translate(-50%,-50%) scale(0); opacity: 1; }
                100% { transform: translate(-50%,-50%) scale(1); opacity: 0; }
              }
              @keyframes sparkFly {
                0% { transform: translate(0, 0) scale(1); opacity: 1; }
                100% { transform: translate(var(--sx), var(--sy)) scale(0); opacity: 0; }
              }
            `;
            document.head.appendChild(style);

            // Screen shake container
            const shakeWrap = document.createElement('div');
            shakeWrap.style.cssText = `position:absolute;inset:0;animation:exitShake 0.2s ease-out;`;
            overlay.appendChild(shakeWrap);

            // Enable 3D perspective on the shake container
            shakeWrap.style.perspective = '1200px';
            shakeWrap.style.perspectiveOrigin = `${cx}px ${cy}px`;

            // Create shards
            for (const sh of s.exitShards) {
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const p of sh.poly) {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
              }
              minX = Math.floor(minX) - 2;
              minY = Math.floor(minY) - 2;
              maxX = Math.ceil(maxX) + 2;
              maxY = Math.ceil(maxY) + 2;
              const tw = maxX - minX;
              const th = maxY - minY;
              if (tw <= 0 || th <= 0) continue;

              // Pre-render shard texture
              const offCvs = document.createElement('canvas');
              offCvs.width = tw;
              offCvs.height = th;
              const offCtx = offCvs.getContext('2d')!;
              offCtx.beginPath();
              offCtx.moveTo(sh.poly[0].x - minX, sh.poly[0].y - minY);
              for (let i = 1; i < sh.poly.length; i++) {
                offCtx.lineTo(sh.poly[i].x - minX, sh.poly[i].y - minY);
              }
              offCtx.closePath();
              offCtx.clip();
              const srcX = Math.max(0, Math.floor(minX * dpr));
              const srcY = Math.max(0, Math.floor(minY * dpr));
              const srcW = Math.min(Math.ceil(tw * dpr), snap.width - srcX);
              const srcH = Math.min(Math.ceil(th * dpr), snap.height - srcY);
              if (srcW > 0 && srcH > 0) {
                offCtx.drawImage(snap, srcX, srcY, srcW, srcH, 0, 0, tw, th);
              }
              // Glowing gold edge
              offCtx.shadowColor = 'rgba(212,160,23,0.6)';
              offCtx.shadowBlur = 4;
              offCtx.strokeStyle = GOLD;
              offCtx.lineWidth = 1.2;
              offCtx.stroke();
              offCtx.shadowBlur = 0;
              // Inner white refraction edge
              offCtx.strokeStyle = 'rgba(255,255,255,0.15)';
              offCtx.lineWidth = 0.5;
              offCtx.stroke();

              // Position in shake container
              offCvs.style.cssText = `
                position:absolute;
                left:${minX}px; top:${minY}px;
                width:${tw}px; height:${th}px;
                transform-origin:${sh.origCx - minX}px ${sh.origCy - minY}px;
                will-change:transform,opacity;
                pointer-events:none;
                filter:brightness(1);
              `;
              shakeWrap.appendChild(offCvs);

              // Compute dramatic flight path
              const outAngle = Math.atan2(sh.origCy - cy, sh.origCx - cx);
              const flyDist = 400 + sh.dist * 2;
              const finalX = Math.cos(outAngle) * flyDist;
              const finalY = Math.sin(outAngle) * flyDist + 500;
              const rotZ = (Math.random() - 0.5) * 120;
              const rotX = (Math.random() - 0.5) * 60;
              const rotY = (Math.random() - 0.5) * 60;

              // Stagger by distance from click — ripple wave
              const stagger = 30 + (sh.dist / (Math.sqrt(W * W + H * H) * 0.8)) * 180;
              setTimeout(() => {
                offCvs.style.transition = `transform 1s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.6s ease-out, filter 0.3s`;
                offCvs.style.transform = `translate3d(${finalX}px, ${finalY}px, ${-200 - Math.random() * 300}px) rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg) scale(0.3)`;
                offCvs.style.opacity = '0';
                offCvs.style.filter = 'brightness(1.8)';
              }, stagger);
            }

            // Bright gold flash + white core
            const flash = document.createElement('div');
            flash.style.cssText = `
              position:absolute;inset:0;pointer-events:none;
              background:radial-gradient(circle at ${cx}px ${cy}px,
                rgba(255,255,255,0.9) 0%,
                rgba(255,220,100,0.7) 8%,
                rgba(212,160,23,0.5) 25%,
                transparent 55%);
              animation:exitFlash 0.4s ease-out forwards;
            `;
            overlay.appendChild(flash);

            // Expanding gold shockwave ring
            const ring = document.createElement('div');
            const ringSize = Math.max(W, H) * 1.5;
            ring.style.cssText = `
              position:absolute;left:${cx}px;top:${cy}px;
              width:${ringSize}px;height:${ringSize}px;
              border-radius:50%;pointer-events:none;
              border:2px solid ${GOLD};
              box-shadow:0 0 20px rgba(212,160,23,0.6), inset 0 0 20px rgba(212,160,23,0.3);
              animation:exitRing 0.6s ease-out forwards;
            `;
            overlay.appendChild(ring);

            // Spark particles from the click point
            for (let i = 0; i < 20; i++) {
              const spark = document.createElement('div');
              const angle = Math.random() * Math.PI * 2;
              const dist = 80 + Math.random() * 250;
              const sparkX = Math.cos(angle) * dist;
              const sparkY = Math.sin(angle) * dist - 40;
              const size = 2 + Math.random() * 3;
              spark.style.cssText = `
                position:absolute;left:${cx}px;top:${cy}px;
                width:${size}px;height:${size}px;
                background:${GOLD};border-radius:50%;
                box-shadow:0 0 ${size * 2}px ${GOLD};
                pointer-events:none;
                --sx:${sparkX}px;--sy:${sparkY}px;
                animation:sparkFly ${0.3 + Math.random() * 0.5}s ease-out ${Math.random() * 0.15}s forwards;
              `;
              overlay.appendChild(spark);
            }
          }
        }

        // Finalize after animation completes
        if (exitElapsed >= 1400) {
          sessionStorage.setItem('tf_loaded', '1');
          finalize();
          return;
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, [visible, finalize]);

  return (
    <>
      {children}
      {visible && (
        <div
          ref={overlayRef}
          onClick={handleClick}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: '#000',
            cursor: 'pointer',
            touchAction: 'none',
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
            }}
          />
        </div>
      )}
    </>
  );
}
