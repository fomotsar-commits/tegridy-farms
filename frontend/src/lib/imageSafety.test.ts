import { describe, it, expect } from 'vitest';
import { IPFS_GATEWAYS, resolveSafeUrl, ipfsCandidates, isAllowedUri } from './imageSafety';

describe('imageSafety IPFS gateways (F470)', () => {
  it('leads with a live public gateway, not the sunset cloudflare-ipfs.com', () => {
    // Single-host resolvers hand IPFS_GATEWAYS[0] to <img src> with no fallback,
    // so the first entry must be a live gateway. Cloudflare deprecated its public
    // IPFS gateway in 2024.
    expect(IPFS_GATEWAYS[0]).not.toContain('cloudflare-ipfs.com');
    expect(IPFS_GATEWAYS[0]).toBe('https://ipfs.io/ipfs/');
  });

  it('resolveSafeUrl maps an ipfs:// URI onto the leading live gateway', () => {
    const cid = 'QmTest123';
    const url = resolveSafeUrl(`ipfs://${cid}`);
    expect(url).toBe(`https://ipfs.io/ipfs/${cid}`);
    expect(url).not.toContain('cloudflare-ipfs.com');
  });

  it('ipfsCandidates still returns every gateway for the race path', () => {
    const cid = 'QmTest123';
    const candidates = ipfsCandidates(`ipfs://${cid}`);
    expect(candidates).toHaveLength(IPFS_GATEWAYS.length);
    expect(candidates[0]).toBe(`https://ipfs.io/ipfs/${cid}`);
    // Cloudflare is retained as a harmless tail (additive — removes nothing).
    expect(candidates).toContain(`https://cloudflare-ipfs.com/ipfs/${cid}`);
  });

  it('still rejects disallowed schemes', () => {
    expect(isAllowedUri('javascript:alert(1)')).toBe(false);
    expect(resolveSafeUrl('file:///etc/passwd')).toBeNull();
  });
});
