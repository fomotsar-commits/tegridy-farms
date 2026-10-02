// Every host the app puts in an <img src> must be permitted by the served img-src. The
// header exists only on Vercel, so an omitted host is a broken placeholder in production
// and invisible locally: every large NFT image went that way when Alchemy moved its media
// to nft2-cdn.alchemy.com while img-src listed only nft-cdn.

import { describe, it, expect } from 'vitest';
import { cspAllows, directive } from '../test/csp';

const allowsImage = (url: string): boolean => cspAllows('img-src', url);

describe('vercel.json CSP img-src', () => {
  // Alchemy's NFT API hands back `image.thumbnailUrl` / `image.cachedUrl` on its CDN and
  // the app renders those verbatim (src/nakamigos/api.js). It now serves nft2-cdn; the
  // legacy host is still hardcoded in src/nakamigos/constants.js + middleware.js, so BOTH
  // must be renderable.
  it.each([
    'https://nft2-cdn.alchemy.com/eth-mainnet/5da8fc69b3357b9bfe42717280e7c102',
    'https://nft-cdn.alchemy.com/eth-mainnet/5da8fc69b3357b9bfe42717280e7c102',
  ])('permits Alchemy NFT media at %s', (url) => {
    expect(allowsImage(url), `img-src blocks ${url} — NFT images render as broken `
      + 'placeholders in production (the CSP header only exists on Vercel, so this is '
      + 'invisible locally)').toBe(true);
  });

  it('stays tight — no catch-all image sources', () => {
    const sources = directive('img-src');
    expect(sources).not.toContain('*');
    expect(sources).not.toContain('https:');
    expect(sources).not.toContain('http:');
    // An unrelated host must still be refused, i.e. the allowlist is a real allowlist.
    expect(allowsImage('https://evil.example.com/x.png')).toBe(false);
  });
});
