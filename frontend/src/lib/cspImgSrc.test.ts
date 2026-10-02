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

// The Jungle Bay family collections render images from OpenSea's own CDN, whose
// host varies by route (i2c, i2, raw2 and ipfs2 were all seen on the saved
// collection pages; the header lists only i.seadn.io), from Gold Cards' S3
// bucket, and from the wsrv.nl image proxy for Junglets. Every one was read
// from the collections' own pages or metadata.
describe('vercel.json CSP img-src: the Jungle Bay family', () => {
  it.each([
    // Seeds' collection image, the registry's own value.
    'https://i2c.seadn.io/base/5e9fe098b5ce43d4bc0693febb0106f6/d270b900f8b40fc5bbc31834b38934/9dd270b900f8b40fc5bbc31834b38934.png',
    // A Bojungles item image from its saved collection page.
    'https://i2c.seadn.io/base/0x36afee4fadc3b77ff5f1f9a040e264150afb979a/21379ac2788a8cbaeea23502e82318/0d21379ac2788a8cbaeea23502e82318.png',
    // Hosts the saved pages also name. i2 appears there as a bare host, so it
    // is checked as one rather than with a path nobody saw it serve.
    'https://i2.seadn.io/',
    'https://raw2.seadn.io/currency_logos/TUSD.webp',
    'https://ipfs2.seadn.io/ipfs/QmPjBx6Rt9eTC7M9D4M5BAUjPiftq3FBSdUGLsJQBFrm8N/101.json',
    // Junglets, through the image proxy the venue already uses for token icons.
    'https://wsrv.nl/?url=https%3A%2F%2Fna-assets.pinit.io%2F3zoVsecguqdcLcTBaSjNQyAyYLLLt1tn93agbKBJ9vSw%2Fb69c398c-8a8f-4b56-8f82-fdb0b1d3a16e%2F0&w=400&output=webp',
    // Every Gold Card's own image, named by its on-chain metadata.
    'https://junglebay.s3.us-east-2.amazonaws.com/Thumbnail.JPG',
  ])('permits %s', (url) => {
    expect(allowsImage(url), `img-src blocks ${url}`).toBe(true);
  });

  it('permits every collection image the marketplace registry names', async () => {
    const { COLLECTIONS } = await import('../nakamigos/constants.js');
    const images = Object.entries(COLLECTIONS as Record<string, { image?: string }>)
      .map(([slug, c]) => [slug, c.image] as const)
      .filter(([, img]) => !!img);
    expect(images.length).toBeGreaterThanOrEqual(9);
    for (const [slug, img] of images) {
      if (/^https?:\/\//.test(img!)) {
        expect(allowsImage(img!), `${slug}'s image ${img} is blocked by img-src`).toBe(true);
      } else {
        // A same-origin path is covered by 'self', which the matcher above
        // deliberately does not model; assert the keyword is present instead.
        expect(new URL(img!, 'https://memetics.finance').origin).toBe('https://memetics.finance');
        expect(directive('img-src'), `${slug}'s image ${img} needs 'self'`).toContain("'self'");
      }
    }
  });

  it('opens OpenSea\'s CDN with one subdomain wildcard, not a catch-all', () => {
    expect(directive('img-src')).toContain('https://*.seadn.io');
    expect(allowsImage('https://seadn.io.evil.example/x.png')).toBe(false);
  });
});
