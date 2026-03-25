import { GOLD } from '../constants';
import { buildExitShards } from '../geometry';
import type { LoaderState, CrackSegment } from '../types';
import { AudioEngine } from '../fx/audio';

/* Draw animated crack lines on canvas */
function drawCracks(
  ctx: CanvasRenderingContext2D, cracks: CrackSegment[],
  elapsed: number, totalDuration: number,
) {
  for (const crack of cracks) {
    const crackProgress = Math.max(0, Math.min(1, (elapsed / totalDuration - crack.delay) / (1 - crack.delay)));
    crack.progress = crackProgress;
    if (crackProgress <= 0) continue;

    const pts = crack.points;
    const drawCount = Math.floor(crackProgress * (pts.length - 1));
    if (drawCount < 1) continue;

    // Main crack line
    ctx.save();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = crack.width;
    ctx.shadowColor = 'rgba(212,160,23,0.8)';
    ctx.shadowBlur = 6;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= drawCount; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    // Partial segment for smooth animation
    if (drawCount < pts.length - 1) {
      const frac = (crackProgress * (pts.length - 1)) - drawCount;
      const a = pts[drawCount], b = pts[drawCount + 1];
      ctx.lineTo(a.x + (b.x - a.x) * frac, a.y + (b.y - a.y) * frac);
    }
    ctx.stroke();

    // White highlight
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = crack.width * 0.4;
    ctx.stroke();
    ctx.restore();

    // Draw children recursively
    if (crack.children.length > 0) {
      drawCracks(ctx, crack.children, elapsed, totalDuration);
    }
  }
}

/* Spider web effect — connecting lines between crack endpoints */
function drawSpiderWeb(
  ctx: CanvasRenderingContext2D, cracks: CrackSegment[], alpha: number,
) {
  if (alpha <= 0) return;
  const endpoints: Array<{ x: number; y: number }> = [];
  function collect(segs: CrackSegment[]) {
    for (const s of segs) {
      if (s.progress > 0.5 && s.points.length > 1) {
        endpoints.push(s.points[s.points.length - 1]);
      }
      collect(s.children);
    }
  }
  collect(cracks);

  ctx.save();
  ctx.strokeStyle = `rgba(212,160,23,${0.15 * alpha})`;
  ctx.lineWidth = 0.5;
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const dx = endpoints[i].x - endpoints[j].x;
      const dy = endpoints[i].y - endpoints[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 150) {
        ctx.beginPath();
        ctx.moveTo(endpoints[i].x, endpoints[i].y);
        ctx.lineTo(endpoints[j].x, endpoints[j].y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

interface RagdollShard {
  el: HTMLCanvasElement;
  x: number; y: number;
  vx: number; vy: number;
  angle: number; angularVel: number;
  w: number; h: number;
  radius: number;
  bounceCount: number;
  startTime: number;
  isLarge: boolean;
}

/* Build DOM shards with ragdoll physics */
export function buildExitDOM(
  s: LoaderState, overlay: HTMLDivElement,
  W: number, H: number, audio: AudioEngine | null,
): { shards: RagdollShard[]; cleanup: () => void } {
  const snap = s.exitSnapshot;
  const dpr = s.dpr;
  const cx = s.exitClickX;
  const cy = s.exitClickY;
  const shardDefs = buildExitShards(cx, cy, W, H);
  const ragdollShards: RagdollShard[] = [];

  if (!snap) return { shards: [], cleanup: () => {} };

  // Inject keyframes
  const style = document.createElement('style');
  style.textContent = `
    @keyframes exitShake {
      0%, 100% { transform: translate(0,0); }
      10% { transform: translate(-8px, 4px); }
      20% { transform: translate(6px, -5px); }
      30% { transform: translate(-4px, 6px); }
      40% { transform: translate(5px, -3px); }
      50% { transform: translate(-3px, 4px); }
      60% { transform: translate(4px, -2px); }
      70% { transform: translate(-2px, 3px); }
      80% { transform: translate(2px, -1px); }
    }
    @keyframes exitFlash { to { opacity: 0; } }
    @keyframes exitRing {
      0% { transform: translate(-50%,-50%) scale(0); opacity: 1; }
      100% { transform: translate(-50%,-50%) scale(1); opacity: 0; }
    }
    @keyframes sparkFly {
      0% { transform: translate(0, 0) scale(1); opacity: 1; }
      100% { transform: translate(var(--sx), var(--sy)) scale(0); opacity: 0; }
    }
  `;
  document.head.appendChild(style);

  // Screen shake container
  const shakeWrap = document.createElement('div');
  shakeWrap.style.cssText = `position:absolute;inset:0;animation:exitShake 0.25s ease-out;perspective:1200px;perspective-origin:${cx}px ${cy}px;`;
  overlay.appendChild(shakeWrap);

  // Play shatter SFX
  audio?.playShatter();

  // Create shards
  const largeShardsCount = Math.min(10, shardDefs.length);
  for (let si = 0; si < shardDefs.length; si++) {
    const sh = shardDefs[si];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of sh.poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    minX = Math.floor(minX) - 2;
    minY = Math.floor(minY) - 2;
    maxX = Math.ceil(maxX) + 2;
    maxY = Math.ceil(maxY) + 2;
    const tw = maxX - minX;
    const th = maxY - minY;
    if (tw <= 0 || th <= 0) continue;

    // Pre-render shard texture
    const offCvs = document.createElement('canvas');
    offCvs.width = tw;
    offCvs.height = th;
    const offCtx = offCvs.getContext('2d')!;
    offCtx.beginPath();
    offCtx.moveTo(sh.poly[0].x - minX, sh.poly[0].y - minY);
    for (let i = 1; i < sh.poly.length; i++) {
      offCtx.lineTo(sh.poly[i].x - minX, sh.poly[i].y - minY);
    }
    offCtx.closePath();
    offCtx.clip();
    const srcX = Math.max(0, Math.floor(minX * dpr));
    const srcY = Math.max(0, Math.floor(minY * dpr));
    const srcW = Math.min(Math.ceil(tw * dpr), snap.width - srcX);
    const srcH = Math.min(Math.ceil(th * dpr), snap.height - srcY);
    if (srcW > 0 && srcH > 0) {
      offCtx.drawImage(snap, srcX, srcY, srcW, srcH, 0, 0, tw, th);
    }
    // Gold edge glow
    offCtx.shadowColor = 'rgba(212,160,23,0.6)';
    offCtx.shadowBlur = 4;
    offCtx.strokeStyle = GOLD;
    offCtx.lineWidth = 1.2;
    offCtx.stroke();
    offCtx.shadowBlur = 0;
    offCtx.strokeStyle = 'rgba(255,255,255,0.15)';
    offCtx.lineWidth = 0.5;
    offCtx.stroke();

    const isLarge = si < largeShardsCount;

    offCvs.style.cssText = `
      position:absolute;
      left:${minX}px; top:${minY}px;
      width:${tw}px; height:${th}px;
      transform-origin:center center;
      will-change:transform,opacity;
      pointer-events:none;
      ${isLarge ? 'backdrop-filter:blur(2px) brightness(1.1);' : ''}
    `;
    shakeWrap.appendChild(offCvs);

    // Initial velocity: explosive outward from click
    const outAngle = Math.atan2(sh.origCy - cy, sh.origCx - cx);
    const speed = 8 + Math.random() * 12;

    ragdollShards.push({
      el: offCvs,
      x: minX, y: minY,
      vx: Math.cos(outAngle) * speed + (Math.random() - 0.5) * 3,
      vy: Math.sin(outAngle) * speed - 4 + (Math.random() - 0.5) * 3,
      angle: 0,
      angularVel: (Math.random() - 0.5) * 12,
      w: tw, h: th,
      radius: Math.sqrt(tw * tw + th * th) / 2,
      bounceCount: 0,
      startTime: performance.now() + sh.dist * 0.3,
      isLarge,
    });
  }

  // Gold flash
  const flash = document.createElement('div');
  flash.style.cssText = `
    position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(circle at ${cx}px ${cy}px,
      rgba(255,255,255,0.9) 0%, rgba(255,220,100,0.7) 8%,
      rgba(212,160,23,0.5) 25%, transparent 55%);
    animation:exitFlash 0.4s ease-out forwards;
  `;
  overlay.appendChild(flash);

  // Shockwave ring
  const ring = document.createElement('div');
  const ringSize = Math.max(W, H) * 1.5;
  ring.style.cssText = `
    position:absolute;left:${cx}px;top:${cy}px;
    width:${ringSize}px;height:${ringSize}px;
    border-radius:50%;pointer-events:none;
    border:2px solid ${GOLD};
    box-shadow:0 0 20px rgba(212,160,23,0.6), inset 0 0 20px rgba(212,160,23,0.3);
    animation:exitRing 0.6s ease-out forwards;
  `;
  overlay.appendChild(ring);

  // Sparks
  for (let i = 0; i < 20; i++) {
    const spark = document.createElement('div');
    const angle = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 250;
    const sparkX = Math.cos(angle) * dist;
    const sparkY = Math.sin(angle) * dist - 40;
    const size = 2 + Math.random() * 3;
    spark.style.cssText = `
      position:absolute;left:${cx}px;top:${cy}px;
      width:${size}px;height:${size}px;
      background:${GOLD};border-radius:50%;
      box-shadow:0 0 ${size * 2}px ${GOLD};
      pointer-events:none;
      --sx:${sparkX}px;--sy:${sparkY}px;
      animation:sparkFly ${0.3 + Math.random() * 0.5}s ease-out ${Math.random() * 0.15}s forwards;
    `;
    overlay.appendChild(spark);
  }

  // Staggered whooshes
  if (audio) {
    setTimeout(() => audio.playWhoosh(), 100);
    setTimeout(() => audio.playWhoosh(), 300);
    setTimeout(() => audio.playWhoosh(), 500);
  }

  const cleanup = () => {
    style.remove();
  };

  return { shards: ragdollShards, cleanup };
}

/* Ragdoll physics tick — call per frame */
export function tickRagdollShards(
  shards: RagdollShard[], W: number, H: number, now: number,
): boolean {
  const gravity = 0.6;
  const restitution = 0.7;
  const maxBounces = 3;
  let allDone = true;

  for (const sh of shards) {
    if (now < sh.startTime) { allDone = false; continue; }
    const age = (now - sh.startTime) / 1000;

    // After max bounces or 2s, let it fall off screen
    const falling = sh.bounceCount >= maxBounces || age > 2;

    sh.vy += gravity;
    sh.x += sh.vx;
    sh.y += sh.vy;
    sh.angle += sh.angularVel;
    sh.angularVel *= 0.995;

    if (!falling) {
      // Wall bounce
      if (sh.x < 0) { sh.x = 0; sh.vx *= -restitution; sh.bounceCount++; }
      if (sh.x + sh.w > W) { sh.x = W - sh.w; sh.vx *= -restitution; sh.bounceCount++; }
      if (sh.y + sh.h > H) { sh.y = H - sh.h; sh.vy *= -restitution; sh.bounceCount++; sh.angularVel *= 0.8; }
      if (sh.y < 0) { sh.y = 0; sh.vy *= -restitution; sh.bounceCount++; }
    }

    // Fade out after 1.5s
    const fadeStart = 1.5;
    const opacity = age > fadeStart ? Math.max(0, 1 - (age - fadeStart) * 2) : 1;

    sh.el.style.transform = `translate(${sh.x}px, ${sh.y}px) rotate(${sh.angle}deg)`;
    sh.el.style.opacity = String(opacity);

    // Refraction effect: increase blur as shard speeds up
    if (sh.isLarge) {
      const speed = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy);
      const blur = Math.min(6, 2 + speed * 0.3);
      sh.el.style.backdropFilter = `blur(${blur}px) brightness(${1 + speed * 0.02})`;
    }

    if (opacity > 0 && sh.y < H + 200) allDone = false;
  }

  // Simple shard-shard collision (circle approximation)
  for (let i = 0; i < shards.length; i++) {
    if (now < shards[i].startTime) continue;
    for (let j = i + 1; j < shards.length; j++) {
      if (now < shards[j].startTime) continue;
      const a = shards[i], b = shards[j];
      const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
      const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = (a.radius + b.radius) * 0.6;
      if (dist < minDist && dist > 0) {
        const nx = dx / dist, ny = dy / dist;
        const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
        const dvn = dvx * nx + dvy * ny;
        if (dvn < 0) {
          a.vx -= dvn * nx * 0.5;
          a.vy -= dvn * ny * 0.5;
          b.vx += dvn * nx * 0.5;
          b.vy += dvn * ny * 0.5;
        }
      }
    }
  }

  return allDone;
}

export { drawCracks, drawSpiderWeb };
