import { GOLD } from '../constants';
import { coverFit } from '../geometry';
import type { LoaderState } from '../types';

export function drawHoldPhase(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  now: number, s: LoaderState,
) {
  const breathT = now * 0.001;

  // Background art — dark, cinematic, with slow Ken Burns
  if (s.images.length > 0) {
    const img = s.images[s.images.length - 1];
    const fit = coverFit(img, W, H);
    const slowZoom = 1.02 + Math.sin(breathT * 0.15) * 0.01;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.translate(W / 2, H / 2);
    ctx.scale(slowZoom, slowZoom);
    ctx.translate(-W / 2, -H / 2);
    ctx.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, 0, 0, W, H);
    ctx.restore();

    // Heavy dark vignette over the image
    ctx.save();
    const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.15, W / 2, H / 2, W * 0.65);
    vig.addColorStop(0, 'rgba(0,0,0,0.15)');
    vig.addColorStop(0.5, 'rgba(0,0,0,0.5)');
    vig.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Particles breathe
  const isMob = W < 768;
  for (const p of s.particles) {
    if (p.hasTarget) {
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
      // Keep text particles bright and fully opaque
      if (p.alpha < 1) p.alpha = Math.min(1, p.alpha + 0.05);
    } else {
      // On mobile, fade untargeted particles to dim ambient level
      if (isMob && p.alpha > 0.08) {
        p.alpha -= 0.008;
      }
      p.vx += (Math.random() - 0.5) * 0.05;
      p.vy += (Math.random() - 0.5) * 0.05;
      p.vx *= 0.99;
      p.vy *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
    }
    if (p.alpha > 0.02) {
      ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  // Mouse trail
  const maxTrail = s.isMobile ? 25 : 50;
  // Emit new trail particle if mouse moved
  if (s.trailParticles.length === 0 ||
      Math.abs(s.mouseX - (s.trailParticles[s.trailParticles.length - 1]?.x ?? 0)) > 3 ||
      Math.abs(s.mouseY - (s.trailParticles[s.trailParticles.length - 1]?.y ?? 0)) > 3) {
    if (s.mouseX > 0 && s.mouseY > 0) {
      s.trailParticles.push({
        x: s.mouseX, y: s.mouseY,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        alpha: 0.8,
        size: 2 + Math.random() * 3,
      });
      if (s.trailParticles.length > maxTrail) s.trailParticles.shift();
    }
  }
  // Update and draw trail
  for (let i = s.trailParticles.length - 1; i >= 0; i--) {
    const tp = s.trailParticles[i];
    tp.x += tp.vx;
    tp.y += tp.vy;
    tp.alpha -= 0.02;
    tp.size *= 0.98;
    if (tp.alpha <= 0.01) {
      s.trailParticles.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = tp.alpha;
    ctx.fillStyle = GOLD;
    ctx.shadowColor = GOLD;
    ctx.shadowBlur = isMob ? tp.size : tp.size * 3;
    ctx.beginPath();
    ctx.arc(tp.x, tp.y, tp.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Text sizing (needed for underline/CTA positioning too)
  const mainSize = isMob ? Math.min(130, W * 0.19) : Math.min(130, W * 0.15);
  const subSize = isMob ? Math.min(60, W * 0.09) : Math.min(60, W * 0.07);

  // Ghost text — lighter shadowBlur on mobile to avoid Safari brightness issue
  ctx.save();
  ctx.globalAlpha = isMob ? 0.06 : 0.1;
  ctx.font = `bold ${mainSize}px "Inter", "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = isMob ? 6 : 20;
  ctx.fillText('TEGRIDY', W / 2, H / 2 - subSize * 0.5);
  ctx.font = `bold ${subSize}px "Inter", "Helvetica Neue", sans-serif`;
  ctx.fillText('FARMS', W / 2, H / 2 + mainSize * 0.45);
  ctx.restore();

  // Golden underline (pulsing)
  const lineY = H / 2 + mainSize * 0.45 + 25;
  const lineW = Math.min(180, W * 0.3);
  ctx.save();
  ctx.strokeStyle = GOLD;
  ctx.globalAlpha = 0.35 + Math.sin(breathT) * 0.15;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - lineW, lineY);
  ctx.lineTo(W / 2 + lineW, lineY);
  ctx.stroke();
  ctx.restore();

  // "Click to Enter"
  const ctaAlpha = 0.25 + (Math.sin(breathT * 2.5) * 0.5 + 0.5) * 0.35;
  ctx.save();
  ctx.globalAlpha = ctaAlpha;
  ctx.fillStyle = '#fff';
  ctx.font = `200 ${isMob ? 11 : 13}px "Inter", "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.letterSpacing = '8px';
  ctx.fillText('CLICK TO ENTER', W / 2, lineY + 40);
  ctx.restore();

}
