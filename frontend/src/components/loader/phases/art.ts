import { GOLD } from '../constants';
import { coverFit } from '../geometry';

export function drawArtPiece(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  img: HTMLImageElement, alpha: number, zoom: number,
  borderAlpha: number, title: string, titleAlpha: number,
  mouseX: number, mouseY: number, isMobile = false,
) {
  ctx.save();
  const artScale = isMobile ? 0.88 : 0.72;
  const artW = W * artScale;
  const artH = H * artScale;
  const artX = (W - artW) / 2;
  const artY = (H - artH) / 2;

  ctx.beginPath();
  ctx.rect(artX, artY, artW, artH);
  ctx.clip();

  // 3D parallax: draw image 3x at different offsets based on mouse
  const mcx = mouseX - W / 2;
  const mcy = mouseY - H / 2;
  const layers = [
    { scale: 1.04, ox: mcx * 0.01, oy: mcy * 0.01, a: 1 },     // background
    { scale: 1.02, ox: mcx * 0.025, oy: mcy * 0.025, a: 0.15 }, // midground highlight
    { scale: 1.0, ox: mcx * 0.05, oy: mcy * 0.05, a: 0.08 },    // foreground glow
  ];

  const fit = coverFit(img, artW, artH);

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    ctx.save();
    ctx.translate(W / 2 + layer.ox, H / 2 + layer.oy);
    ctx.scale(zoom * layer.scale, zoom * layer.scale);
    ctx.translate(-W / 2, -H / 2);
    ctx.globalAlpha = i === 0 ? alpha : alpha * layer.a;
    if (i === 0) {
      ctx.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, artX, artY, artW, artH);
    } else {
      // Additive blend for highlight layers
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, artX, artY, artW, artH);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  // Color grading — purple tint
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = 'rgba(139,92,246,0.06)';
  ctx.fillRect(artX, artY, artW, artH);
  ctx.globalCompositeOperation = 'source-over';

  // Vignette
  ctx.globalAlpha = alpha;
  const vig = ctx.createRadialGradient(W / 2, H / 2, artW * 0.2, W / 2, H / 2, artW * 0.55);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.4)');
  ctx.fillStyle = vig;
  ctx.fillRect(artX, artY, artW, artH);

  ctx.restore();

  // Golden border
  if (borderAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = borderAlpha * 0.5;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1;
    ctx.strokeRect(artX + 0.5, artY + 0.5, artW - 1, artH - 1);
    ctx.restore();
  }

  // Title (museum placard)
  if (titleAlpha > 0 && title) {
    ctx.save();
    ctx.globalAlpha = titleAlpha * 0.3;
    ctx.fillStyle = '#ffffff';
    const titleSize = isMobile ? Math.max(10, Math.floor(W * 0.028)) : 12;
    ctx.font = `200 ${titleSize}px "Inter", "Helvetica Neue", sans-serif`;
    ctx.textAlign = 'center';
    ctx.letterSpacing = isMobile ? '4px' : '8px';
    ctx.fillText(title.toUpperCase(), W / 2, artY + artH + (isMobile ? 20 : 30));
    ctx.restore();
  }
}
