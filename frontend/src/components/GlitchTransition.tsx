import { useEffect, useState, useRef, useCallback } from 'react';

/* ─────────────────────────────────────────────────────────────────────────────
   GLITCH TRANSITION v4
   Desktop: full DOM-based effect with noise canvas, art slices, RGB splits
   Mobile:  single-canvas approach (like the splash screen) for 60fps Safari
   ────────────────────────────────────────────────────────────────────────── */

const ART_IMAGES = [
  '/art/mfers-heaven.jpg', '/art/mumu-bull.jpg', '/art/bobowelie.jpg',
  '/art/jungle-bus.jpg', '/art/pool-party.jpg', '/art/boxing-ring.jpg',
  '/art/bus-crew.jpg', '/art/forest-scene.jpg', '/art/sword-of-love.jpg',
  '/art/towelie-window.jpg', '/art/chaos-scene.jpg', '/art/ape-hug.jpg',
  '/art/beach-vibes.jpg', '/art/dance-night.jpg', '/art/wrestler.jpg',
  '/art/jungle-dark.jpg', '/art/smoking-duo.jpg', '/art/jb-christmas.jpg',
  '/art/beach-sunset.jpg', '/art/porch-chill.jpg', '/art/rose-ape.jpg',
];

const SUBLIMINAL_PHRASES = [
  'TEGRIDY', 'FAFO', 'DM+T', 'WAGMI',
  "DON'T FORGET YOUR TOWEL", 'SEIZE THE MEMES',
];

export interface GlitchConfig {
  intensity: 'light' | 'medium' | 'heavy';
  direction: 'forward' | 'backward';
  sliceCount: number;
  duration: number;
}

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 768;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   MOBILE: Single-canvas glitch (like splash screen — fast on Safari)
   ══════════════════════════════════════════════════════════════════════════ */

function MobileGlitchTransition({ config }: { config: GlitchConfig }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const [done, setDone] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    return false;
  });
  const skippedRef = useRef(false);
  const seedRef = useRef(Math.floor(Math.random() * 99999));
  const subliminalWord = useRef(
    SUBLIMINAL_PHRASES[Math.floor(Math.random() * SUBLIMINAL_PHRASES.length)] ?? 'TEGRIDY'
  );

  // Preload 3 random art images
  useEffect(() => {
    let cancelled = false;
    const shuffled = [...ART_IMAGES].sort(() => Math.random() - 0.5);
    const toLoad = shuffled.slice(0, 3);
    const images: HTMLImageElement[] = [];
    toLoad.forEach((src) => {
      const img = new Image();
      images.push(img);
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (!cancelled) imagesRef.current.push(img);
      };
      img.onerror = () => { /* no-op */ };
      img.src = src;
    });
    return () => {
      cancelled = true;
      // Abort any in-flight loads and release references
      images.forEach((img) => { img.onload = null; img.onerror = null; img.src = ''; });
      imagesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    // Use 1x resolution for performance — no retina needed for glitch
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    startRef.current = performance.now();
    const dur = config.duration;
    const dirSign = config.direction === 'forward' ? 1 : -1;
    let seed = seedRef.current;

    // Simple deterministic random per frame
    const srand = () => {
      seed = (seed * 16807 + 0) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const loop = () => {
      const now = performance.now();
      const elapsed = now - startRef.current;
      const progress = Math.min(elapsed / dur, 1);

      if (progress >= 1) {
        setDone(true);
        return;
      }

      ctx.clearRect(0, 0, W, H);

      // ── Black base with varying opacity (flash in/out) ──
      const baseAlpha = progress < 0.1
        ? progress / 0.1
        : progress > 0.85
          ? 1 - (progress - 0.85) / 0.15
          : 1;
      ctx.fillStyle = `rgba(0,0,0,${0.7 * baseAlpha})`;
      ctx.fillRect(0, 0, W, H);

      // ── Art slices (draw directly on canvas — no DOM layers) ──
      const images = imagesRef.current;
      if (images.length > 0 && progress > 0.05 && progress < 0.85) {
        const sliceCount = 3 + Math.floor(progress * 2);
        const sliceAlpha = progress < 0.15
          ? (progress - 0.05) / 0.1
          : progress > 0.7
            ? (0.85 - progress) / 0.15
            : 1;

        seed = seedRef.current + Math.floor(elapsed / 80) * 7; // Change slices every ~80ms

        for (let i = 0; i < sliceCount; i++) {
          const img = images[Math.floor(srand() * images.length)]!;
          if (!img) continue;
          const sliceY = Math.floor(srand() * H);
          const sliceH = Math.max(20, Math.floor(30 + srand() * (H * 0.15)));
          const offsetX = dirSign * (srand() - 0.3) * 40;

          ctx.save();
          ctx.globalAlpha = sliceAlpha * (0.6 + srand() * 0.4);
          ctx.drawImage(
            img,
            0, (sliceY / H) * img.naturalHeight, img.naturalWidth, (sliceH / H) * img.naturalHeight,
            offsetX, sliceY, W, sliceH,
          );

          // Chromatic aberration: offset red/blue draws
          const shift = 3 + srand() * 5;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.15 * sliceAlpha;
          // Red
          ctx.drawImage(
            img,
            0, (sliceY / H) * img.naturalHeight, img.naturalWidth, (sliceH / H) * img.naturalHeight,
            offsetX + shift, sliceY, W, sliceH,
          );
          // Blue
          ctx.drawImage(
            img,
            0, (sliceY / H) * img.naturalHeight, img.naturalWidth, (sliceH / H) * img.naturalHeight,
            offsetX - shift, sliceY, W, sliceH,
          );
          ctx.globalCompositeOperation = 'source-over';
          ctx.restore();
        }
      }

      // ── Horizontal color lines ──
      if (progress > 0.05 && progress < 0.9) {
        const lineCount = 3 + Math.floor(srand() * 4);
        for (let i = 0; i < lineCount; i++) {
          const ly = Math.floor(srand() * H);
          ctx.fillStyle = srand() > 0.5
            ? `rgba(139,92,246,${0.5 * baseAlpha})`
            : `rgba(212,160,23,${0.5 * baseAlpha})`;
          ctx.fillRect(0, ly, W, 2);
        }
      }

      // ── Block displacement ──
      if (progress > 0.1 && progress < 0.8) {
        try {
          const blockCount = 2 + Math.floor(srand() * 3);
          for (let i = 0; i < blockCount; i++) {
            const by = Math.floor(srand() * H);
            const bh = Math.max(4, Math.floor(8 + srand() * 25));
            const bOffset = (srand() - 0.5) * 30;
            const blockData = ctx.getImageData(0, by, W, Math.min(bh, H - by));
            ctx.putImageData(blockData, bOffset, by);
          }
        } catch { /* skip on tainted canvas */ }
      }

      // ── Noise grain (sparse, fast) ──
      const noiseCount = 80 + Math.floor(progress * 120);
      ctx.save();
      for (let i = 0; i < noiseCount; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.1 + srand() * 0.15})`;
        ctx.fillRect(srand() * W, srand() * H, 2 + srand() * 3, 2 + srand() * 3);
      }
      ctx.restore();

      // ── Scanlines ──
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      for (let y = 0; y < H; y += 4) {
        ctx.fillRect(0, y, W, 1.5);
      }
      ctx.restore();

      // ── Subliminal text flash (brief window) ──
      if (progress > 0.3 && progress < 0.45) {
        const subAlpha = progress < 0.35
          ? (progress - 0.3) / 0.05
          : (0.45 - progress) / 0.1;
        const word: string = subliminalWord.current;
        const fontSize = Math.min(32, W * 0.09);
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate((srand() - 0.5) * 0.08);
        ctx.font = `900 ${fontSize}px "JetBrains Mono", "Courier New", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // RGB split via offset text
        ctx.fillStyle = `rgba(255,0,0,${0.5 * subAlpha})`;
        ctx.fillText(word, 3, 0);
        ctx.fillStyle = `rgba(0,100,255,${0.5 * subAlpha})`;
        ctx.fillText(word, -3, 0);
        ctx.fillStyle = `rgba(255,255,255,${0.8 * subAlpha})`;
        ctx.fillText(word, 0, 0);
        ctx.restore();
      }

      // ── White flash at peak ──
      if (progress > 0.55 && progress < 0.62) {
        const flashAlpha = progress < 0.58
          ? (progress - 0.55) / 0.03
          : (0.62 - progress) / 0.04;
        ctx.fillStyle = `rgba(255,255,255,${0.25 * flashAlpha})`;
        ctx.fillRect(0, 0, W, H);
      }

      // ── VHS tracking band ──
      const bandY = ((elapsed * 0.4) % (H + 40)) - 20;
      ctx.fillStyle = `rgba(255,255,255,${0.04 * baseAlpha})`;
      ctx.fillRect(0, bandY, W, 15 + Math.sin(elapsed * 0.01) * 8);

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [config]);

  // #88 audit: skip transition on click
  const handleSkip = useCallback(() => {
    if (!skippedRef.current) {
      skippedRef.current = true;
      cancelAnimationFrame(rafRef.current);
      setDone(true);
    }
  }, []);

  if (done) return null;

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 cursor-pointer"
      onClick={handleSkip}
      style={{
        zIndex: 10000,
        width: '100vw',
        height: '100vh',
      }}
    />
  );
}


/* ══════════════════════════════════════════════════════════════════════════════
   DESKTOP: Full canvas-based effect — premium quality matching mobile
   Restored from DOM-only approach back to per-frame canvas rendering for
   dynamic noise, VHS tracking, block displacement, and richer visuals.
   ══════════════════════════════════════════════════════════════════════════ */

interface SliceStep {
  at: number;
  opacity: number;
  xMul: number;
  skewMul: number;
}

const SLICE_STEPS: SliceStep[] = [
  { at: 0,    opacity: 0,    xMul: 1,     skewMul: 1 },
  { at: 0.10, opacity: 1,    xMul: 1,     skewMul: 1 },
  { at: 0.22, opacity: 0.95, xMul: -0.8,  skewMul: -0.9 },
  { at: 0.35, opacity: 1,    xMul: 0.6,   skewMul: 0.6 },
  { at: 0.48, opacity: 0.9,  xMul: -0.4,  skewMul: -0.4 },
  { at: 0.60, opacity: 0.85, xMul: 0.25,  skewMul: 0.2 },
  { at: 0.75, opacity: 0.5,  xMul: -0.1,  skewMul: 0 },
  { at: 0.88, opacity: 0.2,  xMul: 0,     skewMul: 0 },
  { at: 1.0,  opacity: 0,    xMul: 0,     skewMul: 0 },
];

function interpolateSlice(progress: number, offsetX: number, skewX: number) {
  let a = SLICE_STEPS[0]!;
  let b = SLICE_STEPS[SLICE_STEPS.length - 1]!;
  for (let i = 0; i < SLICE_STEPS.length - 1; i++) {
    if (progress >= SLICE_STEPS[i]!.at && progress <= SLICE_STEPS[i + 1]!.at) {
      a = SLICE_STEPS[i]!;
      b = SLICE_STEPS[i + 1]!;
      break;
    }
  }
  const t = a.at === b.at ? 1 : (progress - a.at) / (b.at - a.at);
  return {
    opacity: a.opacity + (b.opacity - a.opacity) * t,
    transform: `translateX(${offsetX * (a.xMul + (b.xMul - a.xMul) * t)}px) skewX(${skewX * (a.skewMul + (b.skewMul - a.skewMul) * t)}deg) translateZ(0)`,
  };
}

interface SliceData {
  src: string; top: number; height: number;
  offsetX: number; skewX: number; delay: number; rgbShift: number;
}

function generateSlices(config: GlitchConfig, rand: () => number): SliceData[] {
  const dirSign = config.direction === 'forward' ? 1 : -1;
  const slices: SliceData[] = [];
  const shuffled = [...ART_IMAGES].sort(() => rand() - 0.5);
  // More slices for desktop, spread across the full duration
  const delaySpread = config.duration * 0.45; // 45% of duration for stagger
  for (let i = 0; i < config.sliceCount; i++) {
    const src = shuffled[i % shuffled.length]!;
    const height = 8 + rand() * 40; // taller slices possible
    const top = rand() * (100 - height);
    const baseOffset = 50 + rand() * 120; // much wider offsets
    slices.push({
      src, top, height,
      offsetX: dirSign * baseOffset,
      skewX: (rand() - 0.5) * 24, // more dramatic skew
      delay: (i / config.sliceCount) * delaySpread + rand() * 60, // staggered with jitter
      rgbShift: 10 + rand() * 18, // much stronger RGB split
    });
  }
  return slices;
}

interface HLineData { top: number; color: string; delay: number; thickness: number; glow: number; }

function generateHLines(config: GlitchConfig, rand: () => number): HLineData[] {
  const count = 8 + Math.floor(rand() * 8); // more lines
  return Array.from({ length: count }, () => ({
    top: rand() * 100,
    color: rand() > 0.6 ? '#8b5cf6' : rand() > 0.3 ? '#d4a017' : '#2D8B4E', // added tegridy green
    delay: rand() * (config.duration * 0.5),
    thickness: 2 + rand() * 4, // variable thickness
    glow: 8 + rand() * 16, // variable glow spread
  }));
}

interface SubliminalData {
  text: string; offsetX: number; offsetY: number;
  rotation: number; fontSize: number; showAt: number; showDur: number;
}

function generateSubliminal(config: GlitchConfig, rand: () => number): SubliminalData {
  return {
    text: SUBLIMINAL_PHRASES[Math.floor(rand() * SUBLIMINAL_PHRASES.length)] ?? 'TEGRIDY',
    offsetX: (rand() - 0.5) * 80,
    offsetY: (rand() - 0.5) * 50,
    rotation: (rand() - 0.5) * 8,
    fontSize: 56 + rand() * 36, // bigger text
    showAt: config.duration * 0.28,
    showDur: config.duration * 0.22, // much longer — 22% of total duration
  };
}

function AnimatedSlice({ slice, duration, active }: { slice: SliceData; duration: number; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const animDuration = duration * 0.75;

  useEffect(() => {
    if (!active || !ref.current) return;
    let startTime = 0;

    const timeout = setTimeout(() => {
      startTime = performance.now();
      const tick = () => {
        const el = ref.current;
        if (!el) return;
        const progress = Math.min((performance.now() - startTime) / animDuration, 1);
        const { opacity, transform } = interpolateSlice(progress, slice.offsetX, slice.skewX);
        el.style.opacity = String(opacity);
        el.style.transform = transform;
        if (progress < 1) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }, slice.delay);

    return () => { clearTimeout(timeout); cancelAnimationFrame(rafRef.current); };
  }, [active, slice.delay, slice.offsetX, slice.skewX, animDuration]);

  return (
    <div
      ref={ref}
      className="absolute left-0 w-full overflow-hidden"
      style={{ top: `${slice.top}%`, height: `${slice.height}%`, zIndex: 2, opacity: 0, willChange: 'transform, opacity' }}
    >
      {/* Base image — high contrast */}
      <div className="absolute inset-0" style={{
        backgroundImage: `url(${slice.src})`, backgroundSize: 'cover', backgroundPosition: 'center',
        filter: 'contrast(1.6) brightness(1.3) saturate(1.5)',
      }} />
      {/* Red channel shift */}
      <div className="absolute inset-0" style={{
        backgroundImage: `url(${slice.src})`, backgroundSize: 'cover', backgroundPosition: 'center',
        transform: `translateX(${slice.rgbShift}px) translateZ(0)`,
        opacity: 0.5, mixBlendMode: 'screen',
        filter: 'hue-rotate(-30deg) saturate(4) brightness(1.6)',
      }} />
      {/* Blue channel shift */}
      <div className="absolute inset-0" style={{
        backgroundImage: `url(${slice.src})`, backgroundSize: 'cover', backgroundPosition: 'center',
        transform: `translateX(${-slice.rgbShift}px) translateZ(0)`,
        opacity: 0.45, mixBlendMode: 'screen',
        filter: 'hue-rotate(30deg) saturate(4) brightness(1.6)',
      }} />
      {/* Green channel for extra color separation */}
      <div className="absolute inset-0" style={{
        backgroundImage: `url(${slice.src})`, backgroundSize: 'cover', backgroundPosition: 'center',
        transform: `translateY(${slice.rgbShift * 0.4}px) translateZ(0)`,
        opacity: 0.2, mixBlendMode: 'screen',
        filter: 'hue-rotate(120deg) saturate(3) brightness(1.4)',
      }} />
    </div>
  );
}

function AnimatedSubliminal({ data }: { data: SubliminalData }) {
  const ref = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const start = performance.now();
    const tick = () => {
      const el = ref.current;
      if (!el) return;
      const p = Math.min((performance.now() - start) / data.showDur, 1);
      let opacity: number, scale: number, xM: number, yM: number, rM: number;
      if (p < 0.1) { opacity = p / 0.1; scale = 1 + p / 0.1 * 0.08; xM = 1; yM = 1; rM = 1; }
      else if (p < 0.3) { const t = (p - 0.1) / 0.2; opacity = 1; scale = 1.08 + t * 0.07; xM = 1 + t * 0.5; yM = 1 - t * 0.2; rM = 1 - t * 2; }
      else if (p < 0.6) { const t = (p - 0.3) / 0.3; opacity = 1 - t * 0.3; scale = 1.15 + t * 0.05; xM = 1.5 - t * 0.3; yM = 0.8 + t * 0.1; rM = -1 + t * 0.5; }
      else if (p < 0.85) { const t = (p - 0.6) / 0.25; opacity = 0.7 - t * 0.5; scale = 1.2 - t * 0.1; xM = 1.2; yM = 0.9; rM = -0.5; }
      else { const t = (p - 0.85) / 0.15; opacity = 0.2 - t * 0.2; scale = 1.1; xM = 1.2; yM = 0.9; rM = -0.5; }
      el.style.opacity = String(Math.max(0, opacity));
      el.style.transform = `translate(${data.offsetX * xM}px, ${data.offsetY * yM}px) rotate(${data.rotation * rM}deg) scale(${scale}) translateZ(0)`;
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [data]);

  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 3 }}>
      <span ref={ref} style={{
        fontFamily: "'JetBrains Mono', 'Courier Prime', monospace",
        fontSize: `${data.fontSize}px`, fontWeight: 900, color: 'white',
        textShadow: '6px 0 rgba(255,0,0,0.9), -6px 0 rgba(0,100,255,0.9), 0 3px rgba(0,255,100,0.4), 0 0 30px rgba(139,92,246,0.7), 0 0 60px rgba(45,139,78,0.4)',
        opacity: 0, whiteSpace: 'nowrap', letterSpacing: '0.08em', willChange: 'transform, opacity',
      }}>
        {data.text}
      </span>
    </div>
  );
}

/** Canvas overlay for dynamic noise, VHS tracking, block displacement, color wash */
function NoiseCanvas({ config, phase }: { config: GlitchConfig; phase: 'active' | 'afterimage' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const startRef = useRef(performance.now());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    startRef.current = performance.now();
    let seed = Math.floor(Math.random() * 99999);
    const srand = () => {
      seed = (seed * 16807 + 0) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const loop = () => {
      const elapsed = performance.now() - startRef.current;
      const progress = Math.min(elapsed / config.duration, 1);
      if (progress >= 1) return;

      ctx.clearRect(0, 0, W, H);

      // Reseed every ~50ms for fast-changing noise
      seed = Math.floor(Math.random() * 99999) + Math.floor(elapsed / 50) * 7;

      // ── Dynamic noise grain (200+ particles per frame) ──
      const baseAlpha = progress < 0.08 ? progress / 0.08
        : progress > 0.88 ? 1 - (progress - 0.88) / 0.12
        : 1;
      const noiseCount = 200 + Math.floor(progress * 300);
      ctx.save();
      for (let i = 0; i < noiseCount; i++) {
        const bright = srand() > 0.7 ? 255 : Math.floor(srand() * 200);
        ctx.fillStyle = `rgba(${bright},${bright},${bright},${(0.08 + srand() * 0.18) * baseAlpha})`;
        ctx.fillRect(srand() * W, srand() * H, 1 + srand() * 4, 1 + srand() * 4);
      }
      ctx.restore();

      // ── Block displacement (glitch blocks) ──
      if (progress > 0.08 && progress < 0.85) {
        try {
          const blockCount = 3 + Math.floor(srand() * 5);
          for (let i = 0; i < blockCount; i++) {
            const by = Math.floor(srand() * H);
            const bh = Math.max(4, Math.floor(10 + srand() * 40));
            const bOffset = (srand() - 0.5) * 60;
            const imgData = ctx.getImageData(0, by, W * dpr, Math.min(bh, H - by) * dpr);
            ctx.putImageData(imgData, bOffset * dpr, by * dpr);
          }
        } catch { /* skip on tainted */ }
      }

      // ── VHS tracking band (continuous scroll) ──
      const bandSpeed = 0.3 + progress * 0.2;
      const bandY = ((elapsed * bandSpeed) % (H + 60)) - 30;
      const bandH = 20 + Math.sin(elapsed * 0.008) * 12;
      ctx.fillStyle = `rgba(255,255,255,${0.06 * baseAlpha})`;
      ctx.fillRect(0, bandY, W, bandH);
      // Second band going opposite direction
      const band2Y = H - ((elapsed * bandSpeed * 0.7) % (H + 40)) + 20;
      ctx.fillStyle = `rgba(255,255,255,${0.03 * baseAlpha})`;
      ctx.fillRect(0, band2Y, W, bandH * 0.6);

      // ── Color wash pulses ──
      if (progress > 0.1 && progress < 0.85) {
        const pulsePhase = (elapsed * 0.003) % (Math.PI * 2);
        const purpleAlpha = Math.sin(pulsePhase) * 0.06 * baseAlpha;
        const greenAlpha = Math.cos(pulsePhase * 1.3) * 0.04 * baseAlpha;
        if (purpleAlpha > 0) {
          ctx.fillStyle = `rgba(139,92,246,${purpleAlpha})`;
          ctx.fillRect(0, 0, W, H);
        }
        if (greenAlpha > 0) {
          ctx.fillStyle = `rgba(45,139,78,${greenAlpha})`;
          ctx.fillRect(0, 0, W, H);
        }
      }

      // ── Scanlines ──
      ctx.fillStyle = `rgba(0,0,0,${0.06 * baseAlpha})`;
      for (let y = 0; y < H; y += 3) {
        ctx.fillRect(0, y, W, 1.5);
      }

      // ── Horizontal glitch tears (random per frame) ──
      if (srand() > 0.6 && progress > 0.05 && progress < 0.9) {
        const tearCount = 1 + Math.floor(srand() * 3);
        for (let i = 0; i < tearCount; i++) {
          const ty = Math.floor(srand() * H);
          const tw = W * (0.3 + srand() * 0.7);
          const tx = srand() * (W - tw);
          ctx.fillStyle = `rgba(${srand() > 0.5 ? '139,92,246' : '212,160,23'},${0.3 + srand() * 0.4})`;
          ctx.fillRect(tx, ty, tw, 2 + srand() * 3);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [config, phase]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0"
      style={{
        width: '100%', height: '100%',
        zIndex: 5, pointerEvents: 'none',
        opacity: phase === 'afterimage' ? 0 : 1,
        transition: 'opacity 250ms',
      }}
    />
  );
}

function DesktopGlitchTransition({ config }: { config: GlitchConfig }) {
  const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seed = useState(() => Math.floor(Math.random() * 2147483646))[0];
  const rand = seededRandom(seed);

  const [slices] = useState(() => generateSlices(config, rand));
  const [hLines] = useState(() => generateHLines(config, rand));
  const [subliminal] = useState(() => generateSubliminal(config, rand));
  const [phase, setPhase] = useState<'active' | 'afterimage' | 'done'>(prefersReducedMotion ? 'done' : 'active');
  const [showSubliminal, setShowSubliminal] = useState(false);
  const [showFlash, setShowFlash] = useState(false);
  const [secondFlash, setSecondFlash] = useState(false);
  const rafRef = useRef<number>(0);

  // Skip transition on click
  const handleSkip = useCallback(() => {
    if (phase !== 'done') {
      cancelAnimationFrame(rafRef.current);
      setPhase('done');
    }
  }, [phase]);

  useEffect(() => {
    const dur = config.duration;
    // Primary flash at 55%
    const flash1At = dur * 0.55;
    // Secondary dimmer flash at 75%
    const flash2At = dur * 0.75;
    const activeEnd = dur - 300; // longer afterimage phase
    const tSub = setTimeout(() => setShowSubliminal(true), subliminal.showAt);
    const tSubOff = setTimeout(() => setShowSubliminal(false), subliminal.showAt + subliminal.showDur);
    const tFlash = setTimeout(() => setShowFlash(true), flash1At);
    const tFlashOff = setTimeout(() => setShowFlash(false), flash1At + 120); // longer flash
    const tFlash2 = setTimeout(() => setSecondFlash(true), flash2At);
    const tFlash2Off = setTimeout(() => setSecondFlash(false), flash2At + 80);
    const tAfter = setTimeout(() => setPhase('afterimage'), activeEnd);
    const tDone = setTimeout(() => setPhase('done'), dur);
    return () => { [tSub, tSubOff, tFlash, tFlashOff, tFlash2, tFlash2Off, tAfter, tDone].forEach(clearTimeout); };
  }, [config.duration, subliminal.showAt, subliminal.showDur]);

  if (phase === 'done') return null;

  return (
    <>
      <div className="fixed inset-0 cursor-pointer" onClick={handleSkip} style={{ zIndex: 10000, transform: 'translateZ(0)' }}>
        {/* Dark backdrop — fully opaque so page content doesn't bleed through */}
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(180deg, rgba(0,0,0,0.97) 0%, rgba(6,3,15,0.95) 50%, rgba(0,0,0,0.97) 100%)',
          opacity: phase === 'afterimage' ? 0 : 1,
          transition: 'opacity 300ms',
        }} />

        {/* DOM art slices with RGB split */}
        {phase === 'active' && slices.map((slice, i) => (
          <AnimatedSlice key={`slice-${i}`} slice={slice} duration={config.duration} active={phase === 'active'} />
        ))}

        {/* Horizontal color lines — thicker, glowier */}
        {phase === 'active' && hLines.map((line, i) => (
          <div key={`hline-${i}`} className="absolute left-0 w-full" style={{
            top: `${line.top}%`, height: `${line.thickness}px`, background: line.color,
            boxShadow: `0 0 ${line.glow}px ${line.color}, 0 0 ${line.glow * 2}px ${line.color}40`,
            zIndex: 2,
            transformOrigin: config.direction === 'forward' ? 'left' : 'right',
            animation: `glitch-hline-sweep ${200 + i * 30}ms ${line.delay}ms steps(1) forwards`, opacity: 0,
          }} />
        ))}

        {/* Subliminal text */}
        {showSubliminal && <AnimatedSubliminal data={subliminal} />}

        {/* Primary white flash — brighter, longer */}
        {showFlash && <div className="absolute inset-0" style={{
          zIndex: 4, background: 'radial-gradient(ellipse at center, rgba(255,255,255,1) 0%, rgba(255,255,255,0.2) 70%, transparent 100%)',
          animation: 'glitch-screen-flash 120ms steps(1) forwards', opacity: 0,
        }} />}

        {/* Secondary purple-tinted flash */}
        {secondFlash && <div className="absolute inset-0" style={{
          zIndex: 4, background: 'radial-gradient(ellipse at center, rgba(139,92,246,0.3) 0%, rgba(45,139,78,0.15) 60%, transparent 100%)',
          animation: 'glitch-screen-flash 80ms steps(1) forwards', opacity: 0,
        }} />}

        {/* Canvas overlay: dynamic noise, VHS tracking, block displacement, color wash */}
        <NoiseCanvas config={config} phase={phase} />

        {/* Scanlines */}
        {phase === 'active' && <div className="absolute inset-0" style={{
          zIndex: 6, pointerEvents: 'none',
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px)',
          animation: 'scanline-scroll 0.08s linear infinite',
        }} />}

        {/* Afterimage with stronger blur */}
        {phase === 'afterimage' && <div className="absolute inset-0" style={{
          zIndex: 6, backdropFilter: 'blur(4px) brightness(1.1)', WebkitBackdropFilter: 'blur(4px) brightness(1.1)',
          animation: 'afterimage-fade 300ms ease-out forwards',
        }} />}
      </div>
    </>
  );
}


/* ══════════════════════════════════════════════════════════════════════════════
   EXPORT: Routes to mobile or desktop version
   ══════════════════════════════════════════════════════════════════════════ */

export function GlitchTransition({ config }: { config: GlitchConfig }) {
  const [mobile] = useState(() => isMobile());
  return mobile
    ? <MobileGlitchTransition config={config} />
    : <DesktopGlitchTransition config={config} />;
}
