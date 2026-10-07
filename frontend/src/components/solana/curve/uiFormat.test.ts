// UX3: iOS Safari zooms the page when a text field under 16px gets focus, on iPhone
// and on iPad alike. index.css's site-wide `font-size: max(16px, inherit)` is invalid
// CSS (inherit is not allowed inside max()), so browsers drop it and it protects
// nothing: the field's own class must be 16px at EVERY breakpoint.
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT, describeTreasury } from '../../../lib/launcher/solana/curve';
import { BODY, ERROR, HEAD, HINT, LABEL, LP_SCRIM, inputCls, reserveDisclosure, supplySentence } from './uiFormat';

describe('curve form fields', () => {
  it('are at least 16px on every screen size', () => {
    const sizes = [...inputCls.matchAll(/(?:^|\s)(?:[a-z0-9-]+:)*text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const px of sizes) expect(px).toBeGreaterThanOrEqual(16);
    // No named Tailwind size either (text-sm is 14px, text-xs 12px).
    expect(inputCls).not.toMatch(/(?:^|\s)(?:[a-z0-9-]+:)*text-(?:xs|sm)(?:\s|$)/);
  });
});

describe('supply sentence', () => {
  const other = describeTreasury(new PublicKey(new Uint8Array(32).fill(4)));
  it('says "the whole supply" only when there is no platform reserve', () => {
    expect(supplySentence(0n, other)).toMatch(/^The whole supply goes onto the curve\./);
    expect(supplySentence(369n, other)).not.toMatch(/whole supply/i);
    expect(supplySentence(369n, other)).toMatch(/^96\.31% of the supply goes onto the curve\. The other 3\.69%/);
  });

  it('says the reserve is sent at creation, never that it waits for graduation', () => {
    const s = supplySentence(369n, other);
    expect(s).toContain(`sent to ${other.name} in the same transaction that creates the token`);
    expect(s).not.toMatch(/graduat|release|held by the program/i);
  });
});

describe('reserve disclosure', () => {
  const other = describeTreasury(new PublicKey(new Uint8Array(32).fill(4)));
  const vault = describeTreasury(PLATFORM_TREASURY_VAULT);

  it('says when, to whom, and that the program does not stop the treasury selling', () => {
    expect(reserveDisclosure('3.69% of the supply', vault, 'will')).toBe(
      'When the token is created, the platform receives 3.69% of the supply, sent to the platform treasury (a multisig). ' +
        'The program does not stop the treasury selling those tokens, including while the curve is live.',
    );
    expect(reserveDisclosure('3.69% of the supply', vault, 'was')).toMatch(
      /^When this token was created, the platform received 3\.69% of the supply, sent to the platform treasury \(a multisig\)\./,
    );
  });

  it('calls the treasury a multisig only when it is the known vault', () => {
    const s = reserveDisclosure('3.69% of the supply', other, 'was');
    expect(s).not.toMatch(/\(a multisig\)/);
    expect(s).toContain('This page cannot confirm that the treasury is a multisig.');
    // An unread config names no one and claims nothing.
    expect(reserveDisclosure('3.69% of the supply', describeTreasury(null), 'will')).toContain(
      'sent to the platform treasury. This page cannot confirm',
    );
  });
});

// The LP text kit over art (DESIGN 2.A3). Each token's colour is composited over the LP scrim
// (black at LP_SCRIM) laid over WHITE art, the lightest ground a card can have, and measured
// as WCAG contrast: body, headings and labels at 7:1 or better, hints and errors at 4.5:1 or
// better. Sizes are read from the token's own class. Red on today's classes (2026-10-06):
// body text-[11px] text-white/60 and hint text-[10px] text-white/40 fail the size pins, and
// both name an opacity under 70, which index.css's floor rewrites (to 0.88 and 0.82).
describe('the LP text kit over art', () => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  const over = (ground: number[], colour: number[], alpha: number) => colour.map((c, i) => alpha * c + (1 - alpha) * ground[i]!);
  const contrast = (fg: number[], bg: number[]) => {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  /** oklch to sRGB: Tailwind v4's theme.css gives its palette in oklch. */
  const oklch = (L: number, C: number, h: number): number[] => {
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const gamma = (x: number) => {
      const v = Math.min(1, Math.max(0, x));
      return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    };
    return [
      gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  };
  // node_modules/tailwindcss/theme.css: --color-white: #fff; --color-rose-300: oklch(81% 0.117 11.638).
  const PALETTE: Record<string, number[]> = { white: [255, 255, 255], 'rose-300': oklch(0.81, 0.117, 11.638) };
  const WHITE_ART = [255, 255, 255];

  /** The token's size and its colour, from its classes: `text-[13px] text-white/75` is 13px, white at 0.75. */
  const read = (token: string) => {
    const px = Number(token.match(/(?:^|\s)text-\[(\d+(?:\.\d+)?)px\](?:\s|$)/)?.[1]);
    const m = token.match(/(?:^|\s)text-([a-z]+(?:-\d+)?)(?:\/(\d+))?(?:\s|$)/);
    const colour = PALETTE[m?.[1] ?? ''];
    expect(colour, `${token}: a colour this test knows`).toBeDefined();
    expect(px, `${token}: an explicit px size`).toBeGreaterThan(0);
    return { px, colour: colour!, alpha: m?.[2] ? Number(m[2]) / 100 : 1 };
  };
  const measure = (token: string) => {
    const t = read(token);
    const ground = over(WHITE_ART, [0, 0, 0], LP_SCRIM);
    return { px: t.px, ratio: contrast(over(ground, t.colour, t.alpha), ground) };
  };

  it("the LP scrim is the owner's 0.78: every card a surface, the art visible, never two scrims", () => {
    expect(LP_SCRIM).toBe(0.78);
  });

  it('a white token names the opacity it renders: index.css floors text-white/10 to /65 at 0.55 to 0.88', () => {
    for (const token of [BODY, HINT, HEAD, LABEL]) {
      expect(read(token).alpha, `${token}: a class under /70 renders at the floor, not at what it names`).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('body is at least 13px and reads at 7:1 or better over white art under the scrim', () => {
    const { px, ratio } = measure(BODY);
    expect(px, BODY).toBeGreaterThanOrEqual(13);
    expect(ratio, `${BODY} measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
  });

  it('headings and labels are at least 13px and read at 7:1 or better', () => {
    for (const token of [HEAD, LABEL]) {
      const { px, ratio } = measure(token);
      expect(px, token).toBeGreaterThanOrEqual(13);
      expect(ratio, `${token} measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
    }
    expect(read(HEAD).px, 'a heading is larger than the body').toBeGreaterThan(read(BODY).px);
  });

  it('hints and errors are at least 12px and read at 4.5:1 or better', () => {
    for (const token of [HINT, ERROR]) {
      const { px, ratio } = measure(token);
      expect(px, token).toBeGreaterThanOrEqual(12);
      expect(ratio, `${token} measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
