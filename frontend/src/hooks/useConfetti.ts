import { createContext, useContext } from 'react';

export interface ConfettiOptions {
  x?: number;
  y?: number;
}

export interface ConfettiContextValue {
  fire: (options?: ConfettiOptions) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

export const ConfettiContext = createContext<ConfettiContextValue | null>(null);

export function useConfetti() {
  const ctx = useContext(ConfettiContext);
  if (!ctx) {
    // Return a no-op if used outside provider (safe fallback)
    return { fire: () => {} };
  }
  return { fire: ctx.fire };
}

// --- Particle system logic ---

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  shape: 'square' | 'circle';
  rotation: number;
  rotationSpeed: number;
  life: number;
  maxLife: number;
}

const COLORS = ['#8b5cf6', '#d4a017', '#22c55e', '#ffffff'];
const PARTICLE_COUNT = 80;

function createParticle(x: number, y: number): Particle {
  const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
  const speed = 4 + Math.random() * 8;
  const maxLife = 2000 + Math.random() * 1000; // 2-3 seconds
  return {
    x,
    y,
    vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 3,
    vy: Math.sin(angle) * speed,
    size: 4 + Math.random() * 4,
    color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#8b5cf6',
    shape: Math.random() > 0.5 ? 'square' : 'circle',
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 0.15,
    life: 0,
    maxLife,
  };
}

export function fireConfetti(
  canvas: HTMLCanvasElement,
  originX: number,
  originY: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(createParticle(originX, originY));
  }

  let lastTime = performance.now();
  let animId = 0;

  function draw(now: number) {
    const dt = Math.min(now - lastTime, 50); // cap at 50ms
    lastTime = now;

    ctx!.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;

    for (const p of particles) {
      p.life += dt;
      if (p.life >= p.maxLife) continue;

      alive = true;

      // Physics
      p.vy += 0.15 * (dt / 16); // gravity
      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);
      p.rotation += p.rotationSpeed * (dt / 16);

      // Fade out
      const alpha = 1 - p.life / p.maxLife;

      ctx!.save();
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.rotation);
      ctx!.globalAlpha = alpha;

      if (p.shape === 'circle') {
        ctx!.beginPath();
        ctx!.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx!.fillStyle = p.color;
        ctx!.fill();
      } else {
        ctx!.fillStyle = p.color;
        ctx!.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }

      ctx!.restore();
    }

    if (alive) {
      animId = requestAnimationFrame(draw);
    } else {
      ctx!.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  animId = requestAnimationFrame(draw);

  // Safety cleanup after 4 seconds
  setTimeout(() => {
    cancelAnimationFrame(animId);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, 4000);
}
