import { GOLD, STIFFNESS, DAMPING } from '../constants';
import { easeInOutCubic, coverFit } from '../geometry';
import type { LoaderState } from '../types';

export function drawTextFormPhase(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  elapsed: number, s: LoaderState,
) {
  const textDuration = 2000;
  const tp = Math.min(elapsed / textDuration, 1);

  // Fade in background art as text forms
  if (s.images.length > 0 && tp > 0.3) {
    const img = s.images[s.images.length - 1];
    const fit = coverFit(img, W, H);
    const fadeIn = Math.min(1, (tp - 0.3) / 0.7);
    ctx.save();
    ctx.globalAlpha = fadeIn * 0.35;
    ctx.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, 0, 0, W, H);
    ctx.restore();
    // Vignette
    ctx.save();
    const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.15, W / 2, H / 2, W * 0.65);
    vig.addColorStop(0, `rgba(0,0,0,${0.15 * fadeIn})`);
    vig.addColorStop(0.5, `rgba(0,0,0,${0.5 * fadeIn})`);
    vig.addColorStop(1, `rgba(0,0,0,${0.85 * fadeIn})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  const isMob = W < 768;
  for (const p of s.particles) {
    if (p.hasTarget) {
      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      p.vx += dx * STIFFNESS;
      p.vy += dy * STIFFNESS;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += p.vx;
      p.y += p.vy;
      p.alpha = Math.min(1, p.alpha + 0.05);
    } else {
      const cx = W / 2, cy = H / 2;
      const dx = p.x - cx;
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
      // On mobile, fade untargeted particles to dim ambient level
      p.alpha = isMob
        ? Math.max(0.05, p.alpha - 0.015)
        : Math.max(0.03, p.alpha - 0.01);
    }
    if (p.alpha > 0.02) {
      ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  // Ghost text glow — desktop only; Safari canvas shadowBlur is too bright on mobile
  if (tp > 0.3 && !isMob) {
    const glowAlpha = Math.min(0.1, (tp - 0.3) * 0.15);
    const mainSize = Math.min(130, W * 0.15);
    const subSize = Math.min(60, W * 0.07);
    ctx.save();
    ctx.globalAlpha = glowAlpha;
    ctx.font = `bold ${mainSize}px "Inter", "Helvetica Neue", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 20;
    ctx.fillText('TEGRIDY', W / 2, H / 2 - subSize * 0.5);
    ctx.font = `bold ${subSize}px "Inter", "Helvetica Neue", sans-serif`;
    ctx.fillText('FARMS', W / 2, H / 2 + mainSize * 0.45);
    ctx.restore();
  }

  // Golden underline draws left to right
  if (tp > 0.5) {
    const ulp = (tp - 0.5) / 0.5;
    const isMobileUl = W < 768;
    const mainSize = isMobileUl ? Math.min(130, W * 0.19) : Math.min(130, W * 0.15);
    const lineY = H / 2 + mainSize * 0.45 + 25;
    const lineW = Math.min(180, W * 0.3) * easeInOutCubic(ulp);
    ctx.save();
    ctx.strokeStyle = GOLD;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - lineW, lineY);
    ctx.lineTo(W / 2 + lineW, lineY);
    ctx.stroke();
    const tlGlow = ctx.createRadialGradient(W / 2 + lineW, lineY, 0, W / 2 + lineW, lineY, 20);
    tlGlow.addColorStop(0, `rgba(212,160,23,${0.3 * ulp})`);
    tlGlow.addColorStop(1, 'rgba(212,160,23,0)');
    ctx.fillStyle = tlGlow;
    ctx.fillRect(W / 2 + lineW - 20, lineY - 20, 40, 40);
    ctx.restore();
  }

  return elapsed >= textDuration;
}
