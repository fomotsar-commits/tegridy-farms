import { SUBLIMINAL } from '../constants';

export function drawGlitchCut(
  ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  W: number, H: number, progress: number, dpr: number, elapsed: number,
) {
  // Oscillating chromatic aberration
  const offset = 6 + Math.sin(elapsed * 0.02) * 8;
  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const shifted = ctx.createImageData(canvas.width, canvas.height);
    const sd = shifted.data;
    const cw = canvas.width;
    const ch = canvas.height;

    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const rxSrc = Math.min(x + Math.floor(offset * dpr), cw - 1);
        const ri = (y * cw + rxSrc) * 4;
        sd[i] = data[ri];
        sd[i + 1] = data[i + 1];
        const bxSrc = Math.max(x - Math.floor(offset * dpr), 0);
        const bi = (y * cw + bxSrc) * 4;
        sd[i + 2] = data[bi + 2];
        sd[i + 3] = data[i + 3];
      }
    }
    ctx.putImageData(shifted, 0, 0);
  } catch { /* tainted canvas */ }

  // VHS tracking band — horizontal distortion band scrolling vertically
  const bandY = ((elapsed * 0.3) % (H + 40)) - 20;
  const bandH = 15 + Math.sin(elapsed * 0.01) * 8;
  try {
    const bandData = ctx.getImageData(0, Math.max(0, bandY * dpr), canvas.width, Math.max(1, Math.floor(bandH * dpr)));
    ctx.putImageData(bandData, (Math.sin(elapsed * 0.05) * 12) * dpr, Math.max(0, bandY * dpr));
  } catch { /* skip */ }
  // Bright band overlay
  ctx.save();
  ctx.fillStyle = `rgba(255,255,255,${0.04 + Math.sin(elapsed * 0.03) * 0.02})`;
  ctx.fillRect(0, bandY, W, bandH);
  ctx.restore();

  // Horizontal color bleed bands
  for (let i = 0; i < 3; i++) {
    const by = Math.random() * H;
    const bh = 2 + Math.random() * 6;
    const colors = ['rgba(255,0,100,0.04)', 'rgba(0,255,255,0.04)', 'rgba(255,0,255,0.03)'];
    ctx.save();
    ctx.fillStyle = colors[i];
    ctx.fillRect(0, by, W, bh);
    ctx.restore();
  }

  // Horizontal tear lines
  const tearCount = 3 + Math.floor(Math.random() * 3);
  try {
    for (let i = 0; i < tearCount; i++) {
      const ty = Math.floor(Math.random() * H);
      const tOffset = (Math.random() - 0.5) * 20;
      const stripH = Math.max(2, Math.floor(2 + Math.random() * 8));
      const tearData = ctx.getImageData(0, ty * dpr, canvas.width, stripH * dpr);
      ctx.putImageData(tearData, tOffset * dpr, ty * dpr);
    }
  } catch { /* skip */ }

  // Noise grain — denser now (ramp from 200 to 600)
  const noiseCount = Math.floor(200 + progress * 400);
  if (progress < 0.5) {
    ctx.save();
    for (let i = 0; i < noiseCount; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 3, 3);
    }
    ctx.restore();
  }

  // Scanlines
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let y = 0; y < H; y += 4) {
    ctx.fillRect(0, y, W, 2);
  }
  ctx.restore();

  // White flash
  if (progress < 0.3) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Slight skew
  if (progress < 0.6) {
    try {
      const sk = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(3, 0);
      ctx.transform(1, 0, 0.01, 1, 0, 0);
      ctx.putImageData(sk, 0, 0);
      ctx.restore();
    } catch { /* skip */ }
  }
}

export function drawSubliminalText(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const word = SUBLIMINAL[Math.floor(Math.random() * SUBLIMINAL.length)];
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((Math.random() - 0.5) * 0.1);
  ctx.font = '600 60px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,80,80,0.25)';
  ctx.fillText(word, 3, 0);
  ctx.fillStyle = 'rgba(80,80,255,0.25)';
  ctx.fillText(word, -3, 0);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(word, 0, 0);
  ctx.restore();
}
