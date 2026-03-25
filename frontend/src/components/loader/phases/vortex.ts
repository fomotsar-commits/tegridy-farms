import type { LoaderState } from '../types';

export function drawVortexPhase(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  elapsed: number, s: LoaderState,
) {
  const vortexDuration = 1500;
  const vp = Math.min(elapsed / vortexDuration, 1);

  // Interactive: lerp vortex center toward mouse, blend back to screen center as phase progresses
  const screenCx = W / 2, screenCy = H / 2;
  const lerpSpeed = 0.05;
  s.vortexCenterX += (s.mouseX - s.vortexCenterX) * lerpSpeed;
  s.vortexCenterY += (s.mouseY - s.vortexCenterY) * lerpSpeed;
  // Blend back to center as vp increases
  const blendBack = vp * vp;
  const cx = s.vortexCenterX * (1 - blendBack) + screenCx * blendBack;
  const cy = s.vortexCenterY * (1 - blendBack) + screenCy * blendBack;

  for (const p of s.particles) {
    const dx = cx - p.x;
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
      p.x = cx + Math.cos(spiralAngle) * targetR;
      p.y = cy + Math.sin(spiralAngle) * targetR;
    }

    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.92;
    p.vy *= 0.92;

    p.trail.push({ x: p.x, y: p.y, alpha: p.alpha });
    if (p.trail.length > 6) p.trail.shift();
    for (const t of p.trail) {
      ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${t.alpha * 0.15})`;
      ctx.fillRect(t.x, t.y, p.size * 0.5, p.size * 0.5);
    }
    ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }

  return elapsed >= vortexDuration;
}
