import { GOLD } from '../constants';
import { easeInOutCubic } from '../geometry';

export function drawGoldenLine(ctx: CanvasRenderingContext2D, W: number, H: number, progress: number, alpha: number) {
  if (progress <= 0 || alpha <= 0) return;
  const cx = W / 2;
  const cy = H * 0.38;
  const halfLen = (W * 0.35) * Math.min(progress, 1);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, halfLen * 1.5);
  glow.addColorStop(0, `rgba(212,160,23,${0.08 * alpha})`);
  glow.addColorStop(1, 'rgba(212,160,23,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - halfLen * 1.5, cy - 40, halfLen * 3, 80);
  ctx.strokeStyle = GOLD;
  ctx.globalAlpha = alpha * 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - halfLen, cy);
  ctx.lineTo(cx + halfLen, cy);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawPurpleMist(ctx: CanvasRenderingContext2D, W: number, H: number, alpha: number) {
  if (alpha <= 0) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.1, W / 2, H / 2, W * 0.7);
  g.addColorStop(0, 'rgba(139,92,246,0)');
  g.addColorStop(0.7, `rgba(139,92,246,${0.03 * alpha})`);
  g.addColorStop(1, `rgba(139,92,246,${0.06 * alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

export function drawVoidPhase(ctx: CanvasRenderingContext2D, W: number, H: number, elapsed: number) {
  if (elapsed < 500) {
    // Pure black
  } else if (elapsed < 1300) {
    const lp = (elapsed - 500) / 800;
    drawGoldenLine(ctx, W, H, easeInOutCubic(lp), 1);
  } else {
    drawGoldenLine(ctx, W, H, 1, 1);
    const mp = (elapsed - 1200) / 300;
    drawPurpleMist(ctx, W, H, easeInOutCubic(Math.min(mp, 1)));
  }
}
