import type { LoaderState } from '../types';
import { drawGlitchCut } from './glitch';

export function drawShatterPhase(
  ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  W: number, H: number, elapsed: number, s: LoaderState,
) {
  const shatterDuration = 1500; // T_SHATTER_END - T_ART_END

  // Extra dramatic glitch on first 300ms
  if (elapsed < 300 && s.images.length > 0) {
    const lastImg = s.images[s.images.length - 1]!;
    const gp = elapsed / 300;
    const alpha = 1 - easeInOutCubicLocal(gp);
    if (alpha > 0.05) {
      // Import drawArtPiece would create circular dep, so inline minimal version
      ctx.save();
      ctx.globalAlpha = alpha;
      const artScale = s.isMobile ? 0.88 : 0.72;
      const artW = W * artScale, artH = H * artScale;
      const artX = (W - artW) / 2, artY = (H - artH) / 2;
      ctx.beginPath(); ctx.rect(artX, artY, artW, artH); ctx.clip();
      ctx.translate(W / 2, H / 2);
      ctx.scale(1.04, 1.04);
      ctx.translate(-W / 2, -H / 2);
      const iA = lastImg.width / lastImg.height;
      const aA = artW / artH;
      let sw: number, sh: number, sx: number, sy: number;
      if (iA > aA) { sh = lastImg.height; sw = sh * aA; sx = (lastImg.width - sw) / 2; sy = 0; }
      else { sw = lastImg.width; sh = sw / aA; sx = 0; sy = Math.min((lastImg.height - sh) * 0.35, lastImg.height - sh); }
      ctx.drawImage(lastImg, sx, sy, sw, sh, artX, artY, artW, artH);
      ctx.restore();
      drawGlitchCut(ctx, canvas, W, H, gp * 0.8, s.dpr, elapsed, s.isMobile);
      for (let i = 0; i < 100; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.1 + Math.random() * 0.1})`;
        ctx.fillRect(Math.random() * W, Math.random() * H, 4, 4);
      }
    }
  }

  // Particles: explosive burst with deceleration
  for (const p of s.particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.97;
    p.vy *= 0.97;
    p.trail.push({ x: p.x, y: p.y, alpha: p.alpha });
    if (p.trail.length > 8) p.trail.shift();
    for (const t of p.trail) {
      ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${t.alpha * 0.2})`;
      ctx.fillRect(t.x, t.y, p.size * 0.6, p.size * 0.6);
    }
    ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }

  return elapsed >= shatterDuration;
}

function easeInOutCubicLocal(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
