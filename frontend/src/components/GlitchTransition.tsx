import { useEffect, useState, useRef, useCallback } from 'react';

/* ─────────────────────────────────────────────────────────────────────────────
   GLITCH TRANSITION v2
   Elite CRT channel-switch effect with digital noise, art slices with RGB
   channel separation, subliminal text flashes, and directional awareness.
   ────────────────────────────────────────────────────────────────────────── */

const ART_IMAGES = [
  '/art/mfers-heaven.jpg',
  '/art/mumu-bull.jpg',
  '/art/bobowelie.jpg',
  '/art/jungle-bus.jpg',
  '/art/pool-party.jpg',
  '/art/boxing-ring.jpg',
  '/art/bus-crew.jpg',
  '/art/forest-scene.jpg',
  '/art/sword-of-love.jpg',
  '/art/towelie-window.jpg',
  '/art/chaos-scene.jpg',
  '/art/ape-hug.jpg',
  '/art/beach-vibes.jpg',
  '/art/dance-night.jpg',
  '/art/wrestler.jpg',
  '/art/jungle-dark.jpg',
  '/art/smoking-duo.jpg',
  '/art/jb-christmas.jpg',
  '/art/beach-sunset.jpg',
  '/art/porch-chill.jpg',
  '/art/rose-ape.jpg',
];

const SUBLIMINAL_PHRASES = [
  'TEGRIDY',
  'FAFO',
  'DM+T',
  'WAGMI',
  "DON'T FORGET YOUR TOWEL",
  'SEIZE THE MEMES',
];

export interface GlitchConfig {
  intensity: 'light' | 'medium' | 'heavy';
  direction: 'forward' | 'backward';
  sliceCount: number;
  duration: number;
}

/* ── Seeded random for consistent per-transition values ── */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface SliceData {
  src: string;
  top: number;       // % from top
  height: number;    // % of viewport
  offsetX: number;   // px horizontal offset
  skewX: number;     // degrees
  delay: number;     // ms
  rgbShift: number;  // px
}

function generateSlices(
  config: GlitchConfig,
  rand: () => number,
): SliceData[] {
  const dirSign = config.direction === 'forward' ? 1 : -1;
  const slices: SliceData[] = [];
  const shuffled = [...ART_IMAGES].sort(() => rand() - 0.5);

  for (let i = 0; i < config.sliceCount; i++) {
    const src = shuffled[i % shuffled.length];
    const height = 8 + rand() * 27; // 8-35%
    const top = rand() * (100 - height);
    const baseOffset = 20 + rand() * 40; // 20-60px
    slices.push({
      src,
      top,
      height,
      offsetX: dirSign * baseOffset,
      skewX: (rand() - 0.5) * 10, // -5 to 5 deg
      delay: (i / config.sliceCount) * 200, // stagger over 200ms
      rgbShift: 3 + rand() * 5,
    });
  }
  return slices;
}

interface HLineData {
  top: number;
  color: string;
  delay: number;
}

function generateHLines(rand: () => number): HLineData[] {
  const count = 4 + Math.floor(rand() * 5); // 4-8
  const lines: HLineData[] = [];
  for (let i = 0; i < count; i++) {
    lines.push({
      top: rand() * 100,
      color: rand() > 0.5 ? '#8b5cf6' : '#d4a017',
      delay: rand() * 300,
    });
  }
  return lines;
}

interface SubliminalData {
  text: string;
  offsetX: number;
  offsetY: number;
  rotation: number;
  fontSize: number;
  showAt: number;    // ms from start
  showDur: number;   // ms visible
}

function generateSubliminal(
  config: GlitchConfig,
  rand: () => number,
): SubliminalData {
  const phrases = [...SUBLIMINAL_PHRASES];
  const text = phrases[Math.floor(rand() * phrases.length)];
  return {
    text,
    offsetX: (rand() - 0.5) * 60,
    offsetY: (rand() - 0.5) * 40,
    rotation: (rand() - 0.5) * 6, // 1-3 deg range
    fontSize: 48 + rand() * 24,
    showAt: config.duration * 0.35,
    showDur: 80 + rand() * 40,
  };
}

export function GlitchTransition({ config }: { config: GlitchConfig }) {
  const seed = useState(() => Math.floor(Math.random() * 2147483646))[0];
  const rand = seededRandom(seed);

  const [slices] = useState(() => generateSlices(config, rand));
  const [hLines] = useState(() => generateHLines(rand));
  const [subliminal] = useState(() => generateSubliminal(config, rand));

  const [phase, setPhase] = useState<'active' | 'afterimage' | 'done'>('active');
  const [showSubliminal, setShowSubliminal] = useState(false);
  const [showFlash, setShowFlash] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  /* ── Digital Noise Canvas ── */
  const drawNoise = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const blockSize = 4;
    const cols = Math.ceil(w / blockSize);
    const rows = Math.ceil(h / blockSize);
    // Sparse random blocks — ~5% coverage for performance
    const blockCount = Math.floor(cols * rows * 0.05);

    for (let i = 0; i < blockCount; i++) {
      const bx = Math.floor(Math.random() * cols) * blockSize;
      const by = Math.floor(Math.random() * rows) * blockSize;
      const opacity = 0.10 + Math.random() * 0.08; // 10-18%
      ctx.fillStyle = `rgba(255,255,255,${opacity})`;
      ctx.fillRect(bx, by, blockSize, blockSize);
    }
  }, []);

  /* ── Noise animation loop ── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    let lastDraw = 0;
    const loop = (time: number) => {
      if (time - lastDraw >= 30) {
        drawNoise();
        lastDraw = time;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(rafRef.current);
  }, [drawNoise]);

  /* ── Phase timers ── */
  useEffect(() => {
    const flashAt = config.duration * 0.6;
    const activeEnd = config.duration - 200;

    const tSub = setTimeout(() => setShowSubliminal(true), subliminal.showAt);
    const tSubOff = setTimeout(
      () => setShowSubliminal(false),
      subliminal.showAt + subliminal.showDur,
    );
    const tFlash = setTimeout(() => setShowFlash(true), flashAt);
    const tFlashOff = setTimeout(() => setShowFlash(false), flashAt + 60);
    const tAfter = setTimeout(() => setPhase('afterimage'), activeEnd);
    const tDone = setTimeout(() => setPhase('done'), config.duration);

    return () => {
      clearTimeout(tSub);
      clearTimeout(tSubOff);
      clearTimeout(tFlash);
      clearTimeout(tFlashOff);
      clearTimeout(tAfter);
      clearTimeout(tDone);
    };
  }, [config.duration, subliminal.showAt, subliminal.showDur]);

  if (phase === 'done') return null;

  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 60 }}
    >
      {/* ── Digital Noise Canvas ── */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{
          zIndex: 60,
          pointerEvents: 'none',
          mixBlendMode: 'overlay',
          opacity: phase === 'afterimage' ? 0 : 1,
          transition: 'opacity 200ms',
          animation: `noise-flicker ${config.duration}ms linear`,
        }}
      />

      {/* ── Art Image Glitch Slices ── */}
      {phase === 'active' &&
        slices.map((slice, i) => (
          <div
            key={`slice-${i}`}
            className="absolute left-0 w-full"
            style={
              {
                top: `${slice.top}%`,
                height: `${slice.height}%`,
                zIndex: 61,
                '--glitch-dir': `${slice.offsetX}px`,
                '--glitch-skew': `${slice.skewX}deg`,
                animation: `glitch-slice-in ${config.duration * 0.7}ms ${slice.delay}ms steps(1) forwards`,
                opacity: 0,
              } as React.CSSProperties
            }
          >
            {/* Normal layer */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url(${slice.src})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                filter: 'contrast(1.3) brightness(1.1)',
              }}
            />
            {/* Red channel */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url(${slice.src})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                transform: `translateX(${slice.rgbShift}px)`,
                opacity: 0.5,
                mixBlendMode: 'screen',
                filter: 'hue-rotate(-30deg) saturate(2)',
              }}
            />
            {/* Blue channel */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url(${slice.src})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                transform: `translateX(${-slice.rgbShift}px)`,
                opacity: 0.4,
                mixBlendMode: 'screen',
                filter: 'hue-rotate(30deg) saturate(2)',
              }}
            />
          </div>
        ))}

      {/* ── Horizontal Glitch Lines ── */}
      {phase === 'active' &&
        hLines.map((line, i) => (
          <div
            key={`hline-${i}`}
            className="absolute left-0 w-full"
            style={{
              top: `${line.top}%`,
              height: '1.5px',
              background: line.color,
              zIndex: 61,
              transformOrigin: config.direction === 'forward' ? 'left' : 'right',
              animation: `glitch-hline-sweep ${120 + i * 20}ms ${line.delay}ms steps(1) forwards`,
              opacity: 0,
            }}
          />
        ))}

      {/* ── Subliminal Text Flash ── */}
      {showSubliminal && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ zIndex: 62 }}
        >
          {/* Main text */}
          <span
            style={
              {
                fontFamily: "'JetBrains Mono', 'Courier Prime', monospace",
                fontSize: `${subliminal.fontSize}px`,
                fontWeight: 900,
                color: 'white',
                mixBlendMode: 'difference',
                '--sub-x': `${subliminal.offsetX}px`,
                '--sub-y': `${subliminal.offsetY}px`,
                '--sub-rot': `${subliminal.rotation}deg`,
                animation: `subliminal-flash ${subliminal.showDur}ms steps(1) forwards`,
                position: 'relative',
                whiteSpace: 'nowrap',
              } as React.CSSProperties
            }
          >
            {subliminal.text}
            {/* Red ghost */}
            <span
              className="absolute inset-0"
              style={{
                color: 'rgba(255,0,0,0.6)',
                transform: 'translateX(4px)',
                mixBlendMode: 'screen',
              }}
              aria-hidden
            >
              {subliminal.text}
            </span>
            {/* Blue ghost */}
            <span
              className="absolute inset-0"
              style={{
                color: 'rgba(0,0,255,0.6)',
                transform: 'translateX(-4px)',
                mixBlendMode: 'screen',
              }}
              aria-hidden
            >
              {subliminal.text}
            </span>
          </span>
        </div>
      )}

      {/* ── Screen Flash ── */}
      {showFlash && (
        <div
          className="absolute inset-0"
          style={{
            zIndex: 63,
            background: 'white',
            animation: 'glitch-screen-flash 60ms steps(1) forwards',
            opacity: 0,
          }}
        />
      )}

      {/* ── Scanline overlay ── */}
      {phase === 'active' && (
        <div
          className="absolute inset-0"
          style={{
            zIndex: 61,
            background:
              'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.12) 2px, rgba(0,0,0,0.12) 4px)',
            animation: 'scanline-scroll 0.1s linear infinite',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* ── Afterimage Ghost (phosphor burn) ── */}
      {phase === 'afterimage' && (
        <div
          className="absolute inset-0"
          style={{
            zIndex: 60,
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
            animation: 'afterimage-fade 200ms ease-out forwards',
          }}
        />
      )}
    </div>
  );
}
