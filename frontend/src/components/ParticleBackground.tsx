import { useRef, useEffect } from 'react';

interface Particle {
  x: number;
  y: number;
  baseSize: number;
  size: number;
  speedY: number;
  speedX: number;
  color: string;
  baseOpacity: number;
  opacity: number;
  phase: number;       // twinkle phase offset
  sizePhase: number;   // breathing phase offset
  isStar: boolean;
}

// #87 audit: hardware-adaptive particle counts with reduced-motion support
function getParticleCounts(reducedMotion: boolean): { particles: number; stars: number } {
  // Respect prefers-reduced-motion — minimal particles
  if (reducedMotion) {
    return { particles: 0, stars: 0 };
  }
  const cores = navigator?.hardwareConcurrency ?? 2;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  // Low-end: <=2 cores or mobile
  if (cores <= 2 || isMobile) return { particles: 40, stars: 5 };
  // Mid-range: 4 cores
  if (cores <= 4) return { particles: 80, stars: 10 };
  // High-end: cap at 500 particles max (1000 absolute cap never reached for background)
  return { particles: Math.min(cores * 30, 500), stars: Math.min(cores * 3, 30) };
}
const COLORS: readonly { color: string; opacity: number }[] = [
  { color: '139, 92, 246', opacity: 0.40 },  // purple
  { color: '212, 160, 23', opacity: 0.30 },   // gold
] as const;

function createParticle(canvasW: number, canvasH: number, startAtBottom?: boolean, isStar = false): Particle {
  const colorDef = COLORS[Math.random() < 0.6 ? 0 : 1]!;
  const baseSize = isStar ? (6 + Math.random() * 2) : (2 + Math.random() * 3);
  const baseOpacity = isStar ? (0.35 + Math.random() * 0.15) : colorDef.opacity;
  return {
    x: Math.random() * canvasW,
    y: startAtBottom ? canvasH + Math.random() * 20 : Math.random() * canvasH,
    baseSize,
    size: baseSize,
    speedY: -(0.3 + Math.random() * 0.5),
    speedX: (Math.random() - 0.5) * 0.4,
    color: colorDef.color,
    baseOpacity,
    opacity: baseOpacity,
    phase: Math.random() * Math.PI * 2,
    sizePhase: Math.random() * Math.PI * 2,
    isStar,
  };
}

export function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  // Cached viewport dimensions — updated only in resize handler
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const animateFnRef = useRef<((ts: number) => void) | null>(null);

  useEffect(() => {
    // Evaluate reduced-motion inside the component so it can react to changes
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let { particles: particleCount, stars: starCount } = getParticleCounts(motionQuery.matches);

    // Re-evaluate particle counts when the user toggles reduced-motion
    const handleMotionChange = (e: MediaQueryListEvent) => {
      const counts = getParticleCounts(e.matches);
      particleCount = counts.particles;
      starCount = counts.stars;
      if (particleCount === 0 && starCount === 0) {
        cancelAnimationFrame(rafRef.current);
        particlesRef.current = [];
        const cvs = canvasRef.current;
        if (cvs) {
          const c = cvs.getContext('2d');
          c?.clearRect(0, 0, sizeRef.current.w, sizeRef.current.h);
        }
      } else if (particlesRef.current.length === 0) {
        // Re-init particles and restart animation
        const { w, h } = sizeRef.current;
        const normal = Array.from({ length: particleCount }, () => createParticle(w, h, false, false));
        const stars = Array.from({ length: starCount }, () => createParticle(w, h, false, true));
        particlesRef.current = [...normal, ...stars];
        lastTimeRef.current = 0;
        if (animateFnRef.current) {
          rafRef.current = requestAnimationFrame(animateFnRef.current);
        }
      }
    };
    motionQuery.addEventListener('change', handleMotionChange);

    // #87 audit: skip animation entirely when reduced-motion is preferred or zero particles
    if (particleCount === 0 && starCount === 0) {
      return () => { motionQuery.removeEventListener('change', handleMotionChange); };
    }

    const canvas = canvasRef.current;
    if (!canvas) return () => { motionQuery.removeEventListener('change', handleMotionChange); };

    const ctx = canvas.getContext('2d');
    if (!ctx) return () => { motionQuery.removeEventListener('change', handleMotionChange); };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      sizeRef.current = { w, h };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const debouncedResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    };

    resize();

    // Initialize particles
    const { w: initW, h: initH } = sizeRef.current;
    const normalParticles = Array.from({ length: particleCount }, () =>
      createParticle(initW, initH, false, false)
    );
    const starParticles = Array.from({ length: starCount }, () =>
      createParticle(initW, initH, false, true)
    );
    particlesRef.current = [...normalParticles, ...starParticles];

    const animate = (timestamp: number) => {
      // Compute actual frame delta instead of assuming 60fps
      if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
      const delta = (timestamp - lastTimeRef.current) / 1000;
      lastTimeRef.current = timestamp;
      timeRef.current += delta;

      const { w, h } = sizeRef.current;
      const t = timeRef.current;

      ctx.clearRect(0, 0, w, h);

      for (const p of particlesRef.current) {
        p.x += p.speedX;
        p.y += p.speedY;

        // Twinkle: sinusoidal opacity pulse
        const twinkle = Math.sin(t * 2.5 + p.phase) * 0.5 + 0.5; // 0-1
        p.opacity = p.baseOpacity * (0.5 + twinkle * 0.5);

        // Breathing: gentle size variation
        const breath = Math.sin(t * 1.8 + p.sizePhase) * 0.5 + 0.5;
        p.size = p.baseSize * (0.85 + breath * 0.3);

        // Respawn at bottom when leaving top
        if (p.y < -10) {
          Object.assign(p, createParticle(w, h, true, p.isStar));
        }

        // Wrap horizontal
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${p.opacity})`;
        ctx.fill();

        // Stars get a soft glow
        if (p.isStar) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${p.color}, ${p.opacity * 0.15})`;
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    animateFnRef.current = animate;
    rafRef.current = requestAnimationFrame(animate);

    // Pause animation when tab is hidden to save resources
    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current);
      } else {
        // Reset lastTimeRef so we don't get a huge delta spike on resume
        lastTimeRef.current = 0;
        rafRef.current = requestAnimationFrame(animate);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    window.addEventListener('resize', debouncedResize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', debouncedResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      motionQuery.removeEventListener('change', handleMotionChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  );
}
