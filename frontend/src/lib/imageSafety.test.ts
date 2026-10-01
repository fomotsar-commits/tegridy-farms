import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  IPFS_GATEWAYS,
  resolveSafeUrl,
  ipfsCandidates,
  isAllowedUri,
  fetchWithIpfsFallback,
} from './imageSafety';
import { IPFS_GATEWAYS as SHARED_GATEWAYS } from './ipfsGateways';

describe('imageSafety IPFS gateways (F470, 2026-09-26 retirement)', () => {
  it('uses the one site-wide list, not a copy of its own', () => {
    expect(IPFS_GATEWAYS).toBe(SHARED_GATEWAYS);
  });

  it('never leads with a retired gateway', () => {
    // Single-host resolvers hand IPFS_GATEWAYS[0] to <img src>. ipfs.io and
    // dweb.link were retired 2026-09-21; cloudflare-ipfs.com in 2024.
    for (const dead of ['ipfs.io', 'dweb.link', 'cloudflare-ipfs.com']) {
      expect(IPFS_GATEWAYS.join(' ')).not.toContain(`//${dead}/`);
    }
    expect(IPFS_GATEWAYS[0]).toBe('https://ipfs.filebase.io/ipfs/');
  });

  it('resolveSafeUrl maps an ipfs:// URI onto the leading live gateway', () => {
    const cid = 'QmTest123';
    expect(resolveSafeUrl(`ipfs://${cid}`)).toBe(`https://ipfs.filebase.io/ipfs/${cid}`);
  });

  it('resolveSafeUrl also moves an https URL off a retired gateway', () => {
    expect(resolveSafeUrl('https://ipfs.io/ipfs/QmTest123/a.png')).toBe('https://ipfs.filebase.io/ipfs/QmTest123/a.png');
    expect(resolveSafeUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('ipfsCandidates returns every gateway, in order', () => {
    const cid = 'QmTest123';
    expect(ipfsCandidates(`ipfs://${cid}`)).toEqual(IPFS_GATEWAYS.map((g) => `${g}${cid}`));
    expect(ipfsCandidates('https://example.com/a.png')).toEqual(['https://example.com/a.png']);
  });

  it('still rejects disallowed schemes', () => {
    expect(isAllowedUri('javascript:alert(1)')).toBe(false);
    expect(resolveSafeUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('fetchWithIpfsFallback walks past every kind of gateway failure', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('moves on after a refusal (403/429) and a network error, and returns the first 2xx', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      if (seen.length === 1) return { ok: false, status: 429 } as Response;
      if (seen.length === 2) throw new TypeError('Failed to fetch');
      if (seen.length === 3) return { ok: false, status: 403 } as Response;
      return { ok: true, status: 200 } as Response;
    }));
    const r = await fetchWithIpfsFallback('ipfs://QmX');
    expect(r.ok).toBe(true);
    expect(seen).toEqual(IPFS_GATEWAYS.map((g) => `${g}QmX`));
  });

  it("stops at once when the CALLER aborts", async () => {
    const ac = new AbortController();
    const f = vi.fn(async () => {
      ac.abort();
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    });
    vi.stubGlobal('fetch', f);
    await expect(fetchWithIpfsFallback('ipfs://QmX', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
