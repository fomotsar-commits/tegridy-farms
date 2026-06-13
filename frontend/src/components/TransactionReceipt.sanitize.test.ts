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
});
