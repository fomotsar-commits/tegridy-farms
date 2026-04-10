import { SUBLIMINAL } from '../constants';

export function drawGlitchCut(
  ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  W: number, H: number, progress: number, dpr: number, elapsed: number, isMobile = false,
) {
  // Heavy oscillating chromatic aberration (stronger shift range)
  const offset = 10 + Math.sin(elapsed * 0.025) * 12;
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

  // Block displacement — random rectangular chunks displaced horizontally
  const blockCount = 4 + Math.floor(progress * 6);
  try {
    for (let i = 0; i < blockCount; i++) {
      const by = Math.floor(Math.random() * H);
      const bh = Math.max(4, Math.floor(10 + Math.random() * 40));
      const bOffset = (Math.random() - 0.5) * 60;
      const blockData = ctx.getImageData(0, by * dpr, canvas.width, Math.max(1, bh * dpr));
      ctx.putImageData(blockData, bOffset * dpr, by * dpr);
    }
  } catch { /* skip */ }

  // VHS tracking band — heavier horizontal distortion
  const bandY = ((elapsed * 0.35) % (H + 60)) - 30;
  const bandH = 20 + Math.sin(elapsed * 0.01) * 12;
  try {
    const bandData = ctx.getImageData(0, Math.max(0, bandY * dpr), canvas.width, Math.max(1, Math.floor(bandH * dpr)));
    ctx.putImageData(bandData, (Math.sin(elapsed * 0.06) * 18) * dpr, Math.max(0, bandY * dpr));
  } catch { /* skip */ }
  // Bright band overlay
  ctx.save();
  ctx.fillStyle = `rgba(255,255,255,${0.06 + Math.sin(elapsed * 0.03) * 0.03})`;
  ctx.fillRect(0, bandY, W, bandH);
  ctx.restore();

  // Second VHS band moving opposite direction
  const band2Y = H - ((elapsed * 0.25) % (H + 40)) + 20;
  const band2H = 12 + Math.sin(elapsed * 0.015) * 6;
  try {
    const band2Data = ctx.getImageData(0, Math.max(0, band2Y * dpr), canvas.width, Math.max(1, Math.floor(band2H * dpr)));
    ctx.putImageData(band2Data, (Math.cos(elapsed * 0.04) * 14) * dpr, Math.max(0, band2Y * dpr));
  } catch { /* skip */ }

  // Horizontal color bleed bands — more and bolder
  for (let i = 0; i < 6; i++) {
    const by = Math.random() * H;
    const bh = 3 + Math.random() * 10;
    const colors = [
      'rgba(255,0,100,0.08)', 'rgba(0,255,255,0.08)', 'rgba(255,0,255,0.06)',
      'rgba(139,92,246,0.07)', 'rgba(212,160,23,0.06)', 'rgba(0,255,100,0.05)',
    ];
    ctx.save();
    ctx.fillStyle = colors[i];
    ctx.fillRect(0, by, W, bh);
    ctx.restore();
  }

  // Horizontal tear lines — more of them, wider displacement
  const tearCount = 5 + Math.floor(Math.random() * 5);
  try {
    for (let i = 0; i < tearCount; i++) {
      const ty = Math.floor(Math.random() * H);
      const tOffset = (Math.random() - 0.5) * 40;
      const stripH = Math.max(2, Math.floor(3 + Math.random() * 12));
      const tearData = ctx.getImageData(0, ty * dpr, canvas.width, stripH * dpr);
      ctx.putImageData(tearData, tOffset * dpr, ty * dpr);
    }
  } catch { /* skip */ }

  // Noise grain — much denser, block noise like GlitchTransition
  const noiseCount = isMobile ? Math.floor(150 + progress * 250) : Math.floor(400 + progress * 800);
  ctx.save();
  for (let i = 0; i < noiseCount; i++) {
    const nSize = 2 + Math.floor(Math.random() * 4);
    ctx.fillStyle = `rgba(255,255,255,${0.08 + Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, nSize, nSize);
  }
  ctx.restore();

  // Color inversion zones — random horizontal strips get inverted look
  if (progress < 0.7) {
    const invertCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < invertCount; i++) {
      const iy = Math.random() * H;
      const ih = 5 + Math.random() * 20;
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(0, iy, W, ih);
      ctx.restore();
    }
  }

  // Scanlines — heavier
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < H; y += 3) {
    ctx.fillRect(0, y, W, 1.5);
  }
  ctx.restore();

  // White screen flash — brighter and longer
  if (progress < 0.35) {
    ctx.save();
    ctx.fillStyle = `rgba(255,255,255,${0.15 - progress * 0.3})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Brief mid-glitch flash burst
  if (progress > 0.45 && progress < 0.55) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Skew distortion — stronger
  if (progress < 0.7) {
    try {
      const sk = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(5, 0);
      ctx.transform(1, 0, 0.02, 1, 0, 0);
      ctx.putImageData(sk, 0, 0);
      ctx.restore();
    } catch { /* skip */ }
  }

  // Horizontal glitch lines (like GlitchTransition hLines)
  const hLineCount = 4 + Math.floor(Math.random() * 4);
  ctx.save();
  for (let i = 0; i < hLineCount; i++) {
    const ly = Math.random() * H;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(139,92,246,0.4)' : 'rgba(212,160,23,0.4)';
    ctx.fillRect(0, ly, W, 1.5);
  }
  ctx.restore();
}

export function drawSubliminalText(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const word = SUBLIMINAL[Math.floor(Math.random() * SUBLIMINAL.length)];
  const fontSize = Math.min(72, W * 0.15);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((Math.random() - 0.5) * 0.12);
  ctx.font = `900 ${fontSize}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // RGB split ghost layers — more pronounced
  ctx.fillStyle = 'rgba(255,0,0,0.4)';
  ctx.fillText(word, 5, 0);
  ctx.fillStyle = 'rgba(0,0,255,0.4)';
  ctx.fillText(word, -5, 0);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(word, 0, 0);
  // Screen-blend overlay for extra punch
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = 'rgba(139,92,246,0.2)';
  ctx.fillText(word, 2, -2);
  ctx.restore();
}
