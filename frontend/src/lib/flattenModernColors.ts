/**
 * html2canvas 1.4 cannot parse the CSS Color 4 functions (oklab, oklch, lab, lch,
 * color()) and THROWS on the first one it meets. Tailwind v4 emits them: a class
 * such as `bg-emerald-500/15` computes to `oklab(... / 0.15)`. So any element using
 * a Tailwind palette class made the whole render fail. The receipt card's status
 * badge does, which is why "Copy Image" only ever copied text.
 *
 * The fix runs on html2canvas's CLONE of the page (its `onclone` hook), so the live
 * page is never touched: every computed color written in one of those functions is
 * converted to rgba() and set inline, where html2canvas reads it.
 */

/** Computed-style properties that carry a color html2canvas has to parse. */
const COLOR_PROPS = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'box-shadow',
  'text-shadow',
  'fill',
  'stroke',
] as const;

/** One CSS Color 4 function call. Computed values hold no var() or calc(), so no nesting. */
const MODERN_COLOR = /\b(?:oklab|oklch|lab|lch|color)\([^()]*\)/g;

/** Replace every CSS Color 4 function in a CSS value with what `toRgb` makes of it. */
export function rewriteModernColors(value: string, toRgb: (color: string) => string): string {
  return value.replace(MODERN_COLOR, (color) => toRgb(color));
}

/**
 * A converter that lets the browser do the color math: paint one pixel in the
 * color and read it back as sRGB bytes. A color the canvas cannot take comes out
 * transparent rather than as the previous color.
 */
function pixelToRgb(doc: Document): (color: string) => string {
  const ctx = doc.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const seen = new Map<string, string>();
  return (color) => {
    const hit = seen.get(color);
    if (hit) return hit;
    let rgba = 'rgba(0, 0, 0, 0)';
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
      rgba = `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
    }
    seen.set(color, rgba);
    return rgba;
  };
}

/** Rewrite, inline, every modern color computed on `root` and its descendants. */
export function flattenModernColors(root: HTMLElement): void {
  const view = root.ownerDocument.defaultView;
  if (!view) return;
  const toRgb = pixelToRgb(root.ownerDocument);
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const node of nodes) {
    const computed = view.getComputedStyle(node);
    for (const prop of COLOR_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (!value) continue;
      const flat = rewriteModernColors(value, toRgb);
      if (flat !== value) node.style.setProperty(prop, flat);
    }
  }
}
