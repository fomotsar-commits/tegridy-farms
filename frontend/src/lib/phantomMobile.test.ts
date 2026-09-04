// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { phantomBrowseUrl, isMobileBrowser } from './phantomMobile';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

describe('phantomBrowseUrl', () => {
  it('encodes both params, as Phantom requires', () => {
    const url = phantomBrowseUrl('https://memetics.finance/farm?a=1&b=2', 'https://memetics.finance');
    expect(url).toBe(
      'https://phantom.app/ul/browse/https%3A%2F%2Fmemetics.finance%2Ffarm%3Fa%3D1%26b%3D2?ref=https%3A%2F%2Fmemetics.finance',
    );
    // The dapp URL must not leak its own query into the deeplink's query — that
    // is the whole reason it is percent-encoded.
    expect(url.indexOf('?')).toBe(url.lastIndexOf('?ref='));
  });

  it('keeps the ref param present (Phantom treats it as required)', () => {
    expect(phantomBrowseUrl('https://x.test/', 'https://x.test')).toContain('?ref=');
  });
});

describe('isMobileBrowser — matches the UA test RainbowKit renders its mobile modal on', () => {
  it('detects iPhone and Android', () => {
    expect(isMobileBrowser(IPHONE, 'iPhone', 5)).toBe(true);
    expect(isMobileBrowser(ANDROID, 'Linux armv8l', 5)).toBe(true);
  });

  it('detects modern iPadOS, which reports a MACINTOSH ua and is only betrayed by touch points', () => {
    // The case that makes iPad a distinct code path — a plain UA regex misses it.
    expect(isMobileBrowser(IPAD_MAC_UA, 'MacIntel', 5)).toBe(true);
  });

  it('does NOT fire on a real desktop Mac (same UA, no touch)', () => {
    // Mutation check for the line above: if the touch-points half were dropped,
    // every desktop Mac would be treated as mobile.
    expect(isMobileBrowser(DESKTOP, 'MacIntel', 0)).toBe(false);
  });
});
