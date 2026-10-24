import { describe, it, expect } from 'vitest';
import { sanitize } from './TransactionReceipt';

// F10: sanitize() used to HTML-entity-encode (& < > " '), but every value is
// rendered as a JSX text node (React already escapes), so the encoding only
// corrupted display ("Randy's Pool" → "Randy&#x27;s Pool"). sanitize() is now
// an identity pass with a defensive length cap.
describe('TransactionReceipt sanitize', () => {
  it('returns the literal string without HTML entities', () => {
    expect(sanitize("Randy's & Co")).toBe("Randy's & Co");
    expect(sanitize('a < b > c "q"')).toBe('a < b > c "q"');
  });

  it('returns empty string for undefined/empty input', () => {
    expect(sanitize(undefined)).toBe('');
    expect(sanitize('')).toBe('');
  });

  it('passes through normal token/pool names unchanged', () => {
    expect(sanitize('TOWELI')).toBe('TOWELI');
    expect(sanitize('TOWELI/WETH')).toBe('TOWELI/WETH');
  });

  it('caps pathologically long values', () => {
    const long = 'x'.repeat(500);
    const out = sanitize(long);
    expect(out.length).toBe(120);
    expect(out).toBe('x'.repeat(120));
  });

  // The cap counted UTF-16 units, so it could keep half of an emoji, and the
  // receipt's share link then threw a URIError in encodeURIComponent.
  it('caps by character, never keeping half of an emoji', () => {
    const emoji = '\u{1F600}';
    expect(sanitize(`${'A'.repeat(119)}${emoji}`)).toBe(`${'A'.repeat(119)}${emoji}`);
    expect(sanitize(`${'A'.repeat(120)}${emoji}`)).toBe('A'.repeat(120));
    expect(sanitize(emoji.repeat(200))).toBe(emoji.repeat(120));
  });

  it('drops a half character already in the value', () => {
    expect(sanitize('AB\u{D83D}CD')).toBe('ABCD');
    expect(sanitize('AB\u{DE00}CD')).toBe('ABCD');
    expect(sanitize('\u{D83D}')).toBe('');
  });

  it('always returns text a URL can carry', () => {
    for (const s of [`${'A'.repeat(119)}\u{1F600}`, 'x\u{D83D}', '\u{DE00}y', `${'\u{1F33F}'.repeat(130)}`]) {
      expect(() => encodeURIComponent(sanitize(s))).not.toThrow();
    }
  });
});
