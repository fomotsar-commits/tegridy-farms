/**
 * The value rewrite behind the receipt card's image. html2canvas 1.4 throws on
 * oklab()/oklch()/lab()/lch()/color(), which Tailwind v4 computes for palette
 * classes, so every such call must come out as the converter's rgba() and
 * everything else must come out untouched. The DOM walk and the pixel read-back
 * need a real browser and are proven by e2e/stake.spec.ts (the share leg).
 */
import { describe, it, expect } from 'vitest';
import { rewriteModernColors } from './flattenModernColors';

const tag = (c: string) => `RGB<${c}>`;

describe('rewriteModernColors', () => {
  it('rewrites each CSS Color 4 function the receipt badge computes to', () => {
    expect(rewriteModernColors('oklab(0.695996 -0.162107 0.0511875 / 0.15)', tag))
      .toBe('RGB<oklab(0.695996 -0.162107 0.0511875 / 0.15)>');
    expect(rewriteModernColors('lab(83.9203 -48.7124 13.8849)', tag)).toBe('RGB<lab(83.9203 -48.7124 13.8849)>');
    expect(rewriteModernColors('oklch(0.7 0.1 150)', tag)).toBe('RGB<oklch(0.7 0.1 150)>');
    expect(rewriteModernColors('lch(50 30 120)', tag)).toBe('RGB<lch(50 30 120)>');
    expect(rewriteModernColors('color(srgb 1 0 0 / 0.5)', tag)).toBe('RGB<color(srgb 1 0 0 / 0.5)>');
  });

  it('rewrites every color inside a compound value and keeps the rest of it', () => {
    expect(rewriteModernColors('oklab(0.5 0 0) 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 24px 64px 0px', tag))
      .toBe('RGB<oklab(0.5 0 0)> 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 24px 64px 0px');
    expect(rewriteModernColors('linear-gradient(90deg, oklch(0.7 0.1 150) 0%, lab(50 0 0) 100%)', tag))
      .toBe('linear-gradient(90deg, RGB<oklch(0.7 0.1 150)> 0%, RGB<lab(50 0 0)> 100%)');
  });

  it('leaves the colors html2canvas already reads alone', () => {
    for (const v of ['rgb(255, 255, 255)', 'rgba(8, 14, 32, 0.55)', 'none', 'transparent', '#060c1a', 'url("x.png")']) {
      expect(rewriteModernColors(v, tag)).toBe(v);
    }
  });
});
