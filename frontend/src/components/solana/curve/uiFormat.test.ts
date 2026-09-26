// UX3: iOS Safari zooms the page when a text field under 16px gets focus, on iPhone
// and on iPad alike. index.css's site-wide `font-size: max(16px, inherit)` is invalid
// CSS (inherit is not allowed inside max()), so browsers drop it and it protects
// nothing: the field's own class must be 16px at EVERY breakpoint.
import { describe, expect, it } from 'vitest';
import { inputCls, supplySentence } from './uiFormat';

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
  it('says "the whole supply" only when there is no platform reserve', () => {
    expect(supplySentence(0n)).toMatch(/^The whole supply goes onto the curve\./);
    expect(supplySentence(369n)).not.toMatch(/whole supply/i);
    expect(supplySentence(369n)).toMatch(/^96\.31% of the supply goes onto the curve\. The other 3\.69%/);
  });
});
