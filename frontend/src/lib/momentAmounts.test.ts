import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeCanvas } from '../test/fakeCanvas';
import { decodeFrame, readGif } from './gifBand';
import { hueOf } from './floorMoment';
import { amountsLine, bandAmount, withAmounts } from './momentAmounts';
import type { Receipt } from './receipt';

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

describe('a figure short enough for the band, never more than went in', () => {
  it.each([
    [500_000_000n, 9, '0.5'],
    [1_000_000_000n, 9, '1'],
    [1_234_567_890n, 9, '1.234'],
    [12_345_678_900n, 9, '12.34'],
    [999_999_000_000n, 9, '999.9'],
    [123_456n, 9, '0.0001234'],
    [1n, 9, '0.000000001'],
    [12_345_678_900n, 6, '12,345'],
    [999_999_999_999n, 6, '999,999'],
    [1_000_000_000_000n, 6, '1M'],
    [1_234_567_890_000n, 6, '1.23M'],
    [1_209_999_000_000n, 6, '1.2M'],
    [1_999_999_999_999n, 6, '1.99M'],
    [257_620_000_000_000n, 6, '257.62M'],
    [6_910_000_000_000_000_000n, 6, '6.91T'],
    [42n, 0, '42'],
    [0n, 6, '0'],
  ])('%s at %s decimals reads %s', (base, decimals, text) => {
    expect(bandAmount(base, decimals)).toBe(text);
  });
});

const add = (over: Partial<Receipt> = {}): Pick<Receipt, 'action' | 'coin' | 'pairing' | 'unnamed' | 'deposit'> => ({
  action: 'added',
  coin: { symbol: 'BAYLA', mint: BAYLA },
  pairing: 'SOL',
  unnamed: false,
  deposit: { quote: 500_000_000n, quoteDecimals: 9, token: 1_234_567_890_000n, tokenDecimals: 6 },
  ...over,
});

describe('the band’s words for an add', () => {
  it('both figures, each with its coin, the coin in its own hue', () => {
    expect(amountsLine(add())).toEqual({ quote: '0.5 SOL', coin: '1.23M $BAYLA', hue: hueOf('BAYLA').mid });
  });

  it('any coin, any pairing: the coin by its own ticker, one "$" only', () => {
    expect(amountsLine(add({ coin: { symbol: '$WIF', mint: WIF }, pairing: 'USDC', deposit: { quote: 25_500_000n, quoteDecimals: 6, token: 9_876_543_210n, tokenDecimals: 6 } }))).toEqual({
      quote: '25.5 USDC',
      coin: '9,876 $WIF',
      hue: hueOf('WIF').mid,
    });
  });

  it('none until the transaction is read, for a figure of 0, a coin left unnamed, or anything but an add', () => {
    expect(amountsLine(add({ deposit: undefined }))).toBeNull();
    expect(amountsLine(add({ deposit: { quote: 0n, quoteDecimals: 9, token: 5n, tokenDecimals: 6 } }))).toBeNull();
    expect(amountsLine(add({ deposit: { quote: 5n, quoteDecimals: 9, token: 0n, tokenDecimals: 6 } }))).toBeNull();
    expect(amountsLine(add({ unnamed: true }))).toBeNull();
    expect(amountsLine(add({ action: 'bought' }))).toBeNull();
  });
});

describe('the GIF with what went in across its top', () => {
  const GIF = new Uint8Array(readFileSync(join(process.cwd(), 'src/lib/__fixtures__/gifBand/pillow-noise.gif')));
  const file = (bytes: Uint8Array = GIF) => new File([bytes.slice()], 'memetics-finance-flash-bayla.gif', { type: 'image/gif' });
  let canvas: ReturnType<typeof fakeCanvas> | null = null;
  afterEach(() => {
    canvas?.restore();
    canvas = null;
  });

  it('the pairing coin in white, the "+" in the card’s lavender, the coin in its hue, in the heading face at 800', async () => {
    canvas = fakeCanvas();
    const line = amountsLine(add())!;
    const out = await withAmounts(file(), line);
    expect(out?.name).toBe('memetics-finance-flash-bayla.gif');
    expect(out?.type).toBe('image/gif');
    const gif = readGif(new Uint8Array(await out!.arrayBuffer()))!;
    // A 72-wide GIF: a band of 7 rows, words at 4 pixels.
    expect([gif.width, gif.height]).toEqual([72, 107]);
    expect(canvas.drawn.map((d) => [d.text, d.fill])).toEqual([
      ['0.5 SOL', 'rgb(255,255,255)'],
      ['  +  ', 'rgb(165,153,201)'],
      ['1.23M $BAYLA', `rgb(${hueOf('BAYLA').mid.join(',')})`],
    ]);
    expect(canvas.fonts.at(-1)).toBe("800 4px Archivo, 'Helvetica Neue', Arial, sans-serif");
    // The words are on the band, in the first frame's colours: white where the pairing coin is.
    const f0 = gif.frames[0]!;
    const idx = decodeFrame(gif, f0)!;
    const first = canvas.drawn[0]!;
    const x = Math.round(first.x) + 1;
    const y = Math.round(first.y) - 1;
    const i = idx[y * 72 + x]!;
    expect([...f0.palette.subarray(i * 3, i * 3 + 3)]).toEqual([255, 255, 255]);
  });

  it('words too long for the card shrink to fit it; too long even then, no band', async () => {
    canvas = fakeCanvas({ charWidth: 0.9 });
    const line = amountsLine(add())!;
    expect(await withAmounts(file(), line)).not.toBeNull();
    // 24 characters at 4 pixels, 0.9 each, is 86 wide: 63 is the most, so 2 pixels (the least) is what fits.
    expect(canvas.fonts.at(-1)).toBe("800 2px Archivo, 'Helvetica Neue', Arial, sans-serif");
    canvas.restore();
    canvas = fakeCanvas({ charWidth: 0.9 });
    expect(await withAmounts(file(), { ...line, coin: `${'9'.repeat(30)} $BAYLA` })).toBeNull();
  });

  it('no canvas, or not a GIF: none, and the island’s GIF goes as it came', async () => {
    const line = amountsLine(add())!;
    canvas = fakeCanvas();
    expect(await withAmounts(file(new TextEncoder().encode('<!doctype html>')), line)).toBeNull();
    expect(canvas.drawn).toEqual([]);
    canvas.restore();
    canvas = null;
    const none = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof none;
    try {
      expect(await withAmounts(file(), line)).toBeNull();
    } finally {
      HTMLCanvasElement.prototype.getContext = none;
    }
  });
});
