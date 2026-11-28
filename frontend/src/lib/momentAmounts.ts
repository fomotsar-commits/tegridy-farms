/**
 * What went in, on the add's GIF (the owner's word, 11-28): "0.5 SOL + 1.23M $BAYLA" in a band across its top, over
 * the island's card that says "Added SOL + $BAYLA". The figures are the ones the receipt read from the add's own
 * transaction (its deposit event: lib/solana/receiptRead.ts), never what was typed; an add whose transaction was not
 * read shares the island's GIF as it came. No wallet is named.
 *
 * The band is drawn here, on a canvas, in the site's heading face and the card's colours: the pairing coin in white,
 * the "+" in the card's secondary lavender, the coin in its own hue (the floor line's mark). lib/gifBand.ts puts it
 * on the GIF, in a chunk of its own.
 */
import { hueOf } from './floorMoment';
import type { Receipt } from './receipt';
import { sheetRoom } from './sheet';

/** The band's two figures, each with its coin, and the coin's hue. */
export interface AmountsLine {
  quote: string;
  coin: string;
  hue: readonly [number, number, number];
}

const COMPACT: readonly { floor: bigint; suffix: string }[] = [
  { floor: 1_000_000_000_000n, suffix: 'T' },
  { floor: 1_000_000_000n, suffix: 'B' },
  { floor: 1_000_000n, suffix: 'M' },
];

/**
 * A figure short enough for the band, always rounded DOWN so it never says more went in than did: 1.23M, 12,345,
 * 12.34, 0.5, 0.0001234 (four figures at most under a thousand, so a little is never "0").
 */
export function bandAmount(base: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = base / scale;
  for (const { floor, suffix } of COMPACT) {
    if (whole < floor) continue;
    const hundredths = (whole * 100n) / floor;
    const frac = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return `${(hundredths / 100n).toLocaleString('en-US')}${frac ? `.${frac}` : ''}${suffix}`;
  }
  if (whole >= 1_000n || decimals === 0) return whole.toLocaleString('en-US');
  const digits = (base % scale).toString().padStart(decimals, '0');
  // Four figures in all: what the whole part leaves, or, under one, from the first figure that is not 0.
  const keep = whole > 0n ? Math.max(0, 4 - whole.toString().length) : (digits.search(/[1-9]/) + 1 || digits.length) + 3;
  const frac = digits.slice(0, keep).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * The band's words for an add's receipt, or null: not an add, its transaction not read, a figure of 0, or a coin
 * with no ticker of its own (its post and its GIF name no coin: island answer thirty-four).
 */
export function amountsLine(receipt: Pick<Receipt, 'action' | 'coin' | 'pairing' | 'unnamed' | 'deposit'>): AmountsLine | null {
  const d = receipt.deposit;
  if (receipt.action !== 'added' || !d || d.quote <= 0n || d.token <= 0n || receipt.unnamed) return null;
  // The coin as the island's card names it: a room by its own symbol, any other coin by its ticker.
  const ticker = (sheetRoom(receipt.coin.mint)?.symbol ?? receipt.coin.symbol).replace(/^\$/, '');
  if (!ticker) return null;
  return {
    quote: `${bandAmount(d.quote, d.quoteDecimals)} ${receipt.pairing ?? 'SOL'}`,
    coin: `${bandAmount(d.token, d.tokenDecimals)} $${ticker}`,
    hue: hueOf(ticker).mid,
  };
}

/** The card's secondary words, as the island draws them (index.css `--color-text-secondary`). */
const LAVENDER: readonly [number, number, number] = [165, 153, 201];
const WHITE: readonly [number, number, number] = [255, 255, 255];
const FACE = "Archivo, 'Helvetica Neue', Arial, sans-serif";

/**
 * The band over a GIF `width` wide: its height, and its words as RGBA, centred, in the heading face at 800. Null
 * where there is no canvas, or when the words cannot fit at a size still easy to read.
 */
export async function drawBand(width: number, line: AmountsLine): Promise<{ height: number; words: Uint8ClampedArray } | null> {
  if (typeof document === 'undefined') return null;
  // Sized to the island's clip, 720 wide: a 72-pixel band, words at 40 pixels, no wider than the card's inside.
  const height = Math.round(width / 10);
  const most = Math.round((width * 632) / 720);
  const least = Math.round(width / 30);
  let size = Math.round(width / 18);
  if (height <= 0 || most <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    await document.fonts?.load(`800 ${size}px Archivo`);
  } catch {
    // The face's own fallbacks draw it.
  }
  const parts: [string, readonly [number, number, number]][] = [
    [line.quote, WHITE],
    ['  +  ', LAVENDER],
    [line.coin, line.hue],
  ];
  const text = parts.map(([t]) => t).join('');
  ctx.font = `800 ${size}px ${FACE}`;
  const wide = ctx.measureText(text).width;
  if (wide > most) size = Math.floor((size * most) / wide);
  if (size < least) return null;
  ctx.font = `800 ${size}px ${FACE}`;
  const m = ctx.measureText(text);
  if (m.width > most) return null;
  // Centred on the words' own ink, so figures and a "$" sit in the middle of the band.
  const y = height / 2 + ((m.actualBoundingBoxAscent ?? size * 0.7) - (m.actualBoundingBoxDescent ?? 0)) / 2;
  let x = (width - m.width) / 2;
  ctx.textBaseline = 'alphabetic';
  for (const [t, [r, g, b]] of parts) {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillText(t, x, y);
    x += ctx.measureText(t).width;
  }
  return { height, words: ctx.getImageData(0, 0, width, height).data };
}

/** X's cap on a GIF posted from a phone. */
export const X_GIF_CAP = 5_000_000;

/**
 * The moment's GIF with what went in across its top, or null when it cannot be had (the caller shares the island's
 * GIF as it came): not a GIF this reads, no canvas, the words too long, or the result over X's cap.
 */
export async function withAmounts(file: File, line: AmountsLine): Promise<File | null> {
  try {
    const { readGif, addBand } = await import('./gifBand');
    const gif = readGif(new Uint8Array(await file.arrayBuffer()));
    if (!gif) return null;
    const band = await drawBand(gif.width, line);
    if (!band) return null;
    const out = addBand(gif, band, { maxBytes: X_GIF_CAP });
    return out ? new File([out], file.name, { type: 'image/gif' }) : null;
  } catch {
    return null;
  }
}
