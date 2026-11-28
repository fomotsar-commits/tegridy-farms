import { vi } from 'vitest';

/**
 * A 2D canvas for jsdom, which has none: every word is a solid block `size * 0.5` wide a character and `size` tall,
 * in its fill colour, so a test can read back where each word went and in what colour. Its calls are kept.
 */
export function fakeCanvas(opts: { charWidth?: number; only?: (canvas: HTMLCanvasElement) => boolean } = {}) {
  const drawn: { text: string; x: number; y: number; size: number; fill: string }[] = [];
  const fonts: string[] = [];
  const per = opts.charWidth ?? 0.5;
  const jsdoms = HTMLCanvasElement.prototype.getContext;
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: unknown[]) {
    return contextFor(this, args);
  } as unknown as HTMLCanvasElement['getContext']);
  function contextFor(canvas: HTMLCanvasElement, args: unknown[]): CanvasRenderingContext2D | null {
    // Any other canvas (a moment's engine) gets jsdom's own answer: none.
    if (opts.only && !opts.only(canvas)) return (jsdoms as (...a: unknown[]) => CanvasRenderingContext2D | null).apply(canvas, args);
    let font = '10px sans-serif';
    let fill = 'rgb(0,0,0)';
    const sizeOf = () => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
    const rgba = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    const ctx = {
      get font() {
        return font;
      },
      set font(f: string) {
        font = f;
        fonts.push(f);
      },
      get fillStyle() {
        return fill;
      },
      set fillStyle(f: string) {
        fill = f;
      },
      textBaseline: 'alphabetic',
      measureText: (t: string) => ({ width: t.length * sizeOf() * per, actualBoundingBoxAscent: sizeOf() * 0.7, actualBoundingBoxDescent: 0 }),
      fillText: (t: string, x: number, y: number) => {
        const size = sizeOf();
        drawn.push({ text: t, x, y, size, fill });
        const [r, g, b] = (/rgb\((\d+),(\d+),(\d+)\)/.exec(fill) ?? []).slice(1).map(Number);
        // The ink: the words without the spaces around them.
        const x0 = Math.max(0, Math.round(x + (t.length - t.trimStart().length) * size * per));
        const x1 = Math.min(canvas.width, Math.round(x + t.trimEnd().length * size * per));
        const top = Math.max(0, Math.round(y - size * 0.7));
        for (let py = top; py < Math.min(canvas.height, Math.round(y)); py++) {
          for (let px = x0; px < x1; px++) {
            const o = (py * canvas.width + px) * 4;
            rgba[o] = r!;
            rgba[o + 1] = g!;
            rgba[o + 2] = b!;
            rgba[o + 3] = 255;
          }
        }
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: rgba.slice(0, w * h * 4), width: w, height: h }),
    };
    return ctx as unknown as CanvasRenderingContext2D;
  }
  return { drawn, fonts, restore: () => spy.mockRestore() };
}
