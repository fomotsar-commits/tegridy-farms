import type { ExitShard, CrackSegment } from './types';

export const MAX_PARTICLES = 20000;

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function coverFit(
  img: HTMLImageElement, areaW: number, areaH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const imgAspect = img.width / img.height;
  const areaAspect = areaW / areaH;
  let sw: number, sh: number, sx: number, sy: number;
  if (imgAspect > areaAspect) {
    sh = img.height; sw = sh * areaAspect;
    sx = (img.width - sw) / 2; sy = 0;
  } else {
    sw = img.width; sh = sw / areaAspect;
    sx = 0;
    const maxSy = img.height - sh;
    sy = Math.min(maxSy * 0.35, maxSy);
  }
  return { sx, sy, sw, sh };
}

const _textPixelCache = new Map<string, Array<{ x: number; y: number }>>();

export function getTextPixels(
  text: string, fontSize: number, W: number, H: number, offsetY: number,
): Array<{ x: number; y: number }> {
  const key = `${text}_${fontSize}_${W}_${H}_${offsetY}`;
  const cached = _textPixelCache.get(key);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d')!;
  cx.font = `bold ${fontSize}px "Inter", "Helvetica Neue", sans-serif`;
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillStyle = '#fff';
  cx.fillText(text, W / 2, H / 2 + offsetY);
  const d = cx.getImageData(0, 0, W, H).data;
  const pts: Array<{ x: number; y: number }> = [];
  // Step size balances coverage density vs total target count
  // Mobile: step=3 keeps targets ~1200-1500 (close to 1000 particle count)
  // Desktop: step=3-4 keeps targets ~2000-3000 (close to 2000 particles)
  const step = W < 768 ? 3 : Math.max(3, Math.floor(Math.min(W, H) / 250));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (d[(y * W + x) * 4 + 3] > 128) pts.push({ x, y });
    }
  }
  _textPixelCache.set(key, pts);
  return pts;
}

export function buildSnakePath(W: number, H: number): Array<{ x: number; y: number }> {
  const mainSize = Math.min(130, W * 0.15);
  const subSize = Math.min(60, W * 0.07);
  const cx = W / 2;
  const cy = H / 2;
  const textCenterY = cy + (mainSize * 0.45 - subSize * 0.5) / 2;
  const points: Array<{ x: number; y: number }> = [];
  const numPoints = 180;
  const revolutions = 2.5;
  const maxRx = Math.min(W * 0.32, mainSize * 2.8);
  const maxRy = mainSize * 0.9;

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const angle = t * revolutions * Math.PI * 2;
    const r = 0.2 + t * 0.8;
    const wobble = Math.sin(angle * 4) * 0.06 + Math.sin(angle * 7) * 0.03;
    points.push({
      x: cx + Math.cos(angle) * maxRx * (r + wobble),
      y: textCenterY + Math.sin(angle) * maxRy * (r + wobble),
    });
  }
  return points;
}

export function buildExitShards(clickX: number, clickY: number, W: number, H: number): ExitShard[] {
  const numRadials = 8;
  const numRings = 3;
  const maxDist = Math.sqrt(W * W + H * H) * 0.8;

  const angles: number[] = [];
  const aStep = (Math.PI * 2) / numRadials;
  for (let i = 0; i < numRadials; i++) {
    angles.push(aStep * i + (Math.random() - 0.5) * aStep * 0.45);
  }
  angles.sort((a, b) => a - b);

  const rings = [0];
  for (let i = 1; i <= numRings; i++) {
    rings.push((maxDist * i) / numRings);
  }

  const verts: Array<Array<{ x: number; y: number }>> = [];
  for (let r = 0; r <= numRings; r++) {
    verts[r] = [];
    for (let a = 0; a < numRadials; a++) {
      if (r === 0) {
        verts[r][a] = { x: clickX, y: clickY };
      } else {
        const jitter = rings[r] * 0.08;
        verts[r][a] = {
          x: clickX + Math.cos(angles[a]) * rings[r] + (Math.random() - 0.5) * jitter,
          y: clickY + Math.sin(angles[a]) * rings[r] + (Math.random() - 0.5) * jitter,
        };
      }
    }
  }

  const shards: ExitShard[] = [];
  for (let r = 0; r < numRings; r++) {
    for (let a = 0; a < numRadials; a++) {
      const na = (a + 1) % numRadials;
      const poly = r === 0
        ? [verts[0][a], verts[1][a], verts[1][na]]
        : [verts[r][a], verts[r + 1][a], verts[r + 1][na], verts[r][na]];

      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      const dist = Math.sqrt((cx - clickX) ** 2 + (cy - clickY) ** 2);
      const outAngle = Math.atan2(cy - clickY, cx - clickX);
      const speed = 4 + Math.random() * 6;

      shards.push({
        poly, origCx: cx, origCy: cy, cx, cy, dist,
        delay: 100 + (dist / maxDist) * 250,
        vx: Math.cos(outAngle) * speed,
        vy: Math.sin(outAngle) * speed - 3,
        rot: 0, rotSpeed: (Math.random() - 0.5) * 0.15,
        alpha: 1, scale: 1,
        tex: null, texOffX: 0, texOffY: 0,
      });
    }
  }
  return shards;
}

/* Build branching crack paths from a click point */
export function buildCrackPaths(
  clickX: number, clickY: number, W: number, H: number,
): CrackSegment[] {
  const numMain = 6 + Math.floor(Math.random() * 5); // 6-10 main cracks
  const maxLen = Math.sqrt(W * W + H * H) * 0.5;
  const cracks: CrackSegment[] = [];

  for (let i = 0; i < numMain; i++) {
    const angle = (Math.PI * 2 * i) / numMain + (Math.random() - 0.5) * 0.6;
    const crack = buildCrackBranch(clickX, clickY, angle, maxLen * (0.5 + Math.random() * 0.5), 2, i * 0.08);
    cracks.push(crack);
  }
  return cracks;
}

function buildCrackBranch(
  startX: number, startY: number, angle: number,
  length: number, width: number, delay: number,
): CrackSegment {
  const points: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];
  const segments = 8 + Math.floor(Math.random() * 6);
  const segLen = length / segments;
  let curX = startX, curY = startY, curAngle = angle;

  for (let i = 0; i < segments; i++) {
    curAngle += (Math.random() - 0.5) * 0.5; // wobble
    curX += Math.cos(curAngle) * segLen;
    curY += Math.sin(curAngle) * segLen;
    points.push({ x: curX, y: curY });
  }

  const children: CrackSegment[] = [];
  // Spawn sub-cracks with 40% probability per segment
  for (let i = 2; i < segments; i++) {
    if (Math.random() < 0.4 && width > 0.5) {
      const branchAngle = curAngle + (Math.random() > 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.7);
      const branchLen = length * (0.3 + Math.random() * 0.3);
      const pt = points[i];
      children.push(buildCrackBranch(pt.x, pt.y, branchAngle, branchLen, width * 0.6, delay + i * 0.05));
    }
  }

  return { points, progress: 0, delay, width, children };
}
