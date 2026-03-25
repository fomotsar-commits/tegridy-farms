import type { MorphParticle, LoaderState } from '../types';
import { coverFit } from '../geometry';
import { STIFFNESS, DAMPING } from '../constants';

export function createMorphParticles(
  currentImg: HTMLImageElement, _nextImg: HTMLImageElement | null,
  W: number, H: number,
): MorphParticle[] {
  const artW = W * 0.72, artH = H * 0.72;
  const artX = (W - artW) / 2, artY = (H - artH) / 2;
  const count = 400;
  const particles: MorphParticle[] = [];

  // Sample from current image
  const oc = document.createElement('canvas');
  oc.width = Math.floor(artW);
  oc.height = Math.floor(artH);
  const ocx = oc.getContext('2d')!;
  const fit = coverFit(currentImg, artW, artH);
  ocx.drawImage(currentImg, fit.sx, fit.sy, fit.sw, fit.sh, 0, 0, oc.width, oc.height);

  let pixelData: ImageData | null = null;
  try { pixelData = ocx.getImageData(0, 0, oc.width, oc.height); } catch { /* tainted */ }



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
    const speed = 3 + Math.random() * 4;
    const tx = Math.random() * oc.width;
    const ty = Math.random() * oc.height;

    particles.push({
      x: artX + px, y: artY + py,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      targetX: artX + tx, targetY: artY + ty,
      r, g, b,
      size: 1.5 + Math.random() * 2,
      alpha: 1,
      progress: 0,
    });
  }
  return particles;
}

export function updateMorphParticles(
  ctx: CanvasRenderingContext2D, s: LoaderState, progress: number,
) {
  for (let i = s.morphParticles.length - 1; i >= 0; i--) {
    const p = s.morphParticles[i];
    p.progress = progress;

    if (progress < 0.4) {
      // Explode outward
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.96;
      p.vy *= 0.96;
    } else {
      // Reassemble at target
      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      p.vx += dx * STIFFNESS * 1.5;
      p.vy += dy * STIFFNESS * 1.5;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += p.vx;
      p.y += p.vy;
    }

    // Fade based on progress
    p.alpha = progress < 0.5
      ? 1 - progress * 0.5
      : 0.5 + (1 - progress) * 0.5;

    if (p.alpha > 0.02) {
      ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha * 0.6})`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  // Clear when done
  if (progress >= 1) {
    s.morphParticles = [];
  }
}
