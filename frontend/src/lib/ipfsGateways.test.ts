import { describe, it, expect, vi } from 'vitest';
import {
  IPFS_GATEWAYS,
  DEAD_IPFS_GATEWAY_HOSTS,
  ipfsGatewayUrls,
  liveIpfsUrl,
  nextIpfsGatewayUrl,
  advanceIpfsImg,
  fetchIpfsStep,
} from './ipfsGateways';
import { cspAllows, directive } from '../test/csp';

// ipfs.io and dweb.link were retired on 2026-09-21 and every IPFS image on the
// site went with them: every gateway list here led with one of them, and the
// renderers only ever tried the first entry. These tests pin the two halves of
// the fix: the list leads with gateways that serve an <img> today, and every
// renderer actually walks it.

const host = (u: string) => new URL(u).hostname;
const CID = 'QmaTrk9RrN3yhwyB1EbRFrxBEEtcbBaGs2NppJGn262Bid';

describe('the gateway list', () => {
  it('leads with the gateways measured to serve real content on 2026-09-26', () => {
    expect(IPFS_GATEWAYS.map(host)).toEqual([
      'ipfs.filebase.io',
      'ipfs.orbitor.dev',
      'gateway.pinata.cloud',
      'ipfs.aleph.cloud',
    ]);
  });

  it('contains no retired gateway, at any position', () => {
    for (const g of IPFS_GATEWAYS) {
      const h = host(g);
      for (const dead of DEAD_IPFS_GATEWAY_HOSTS) {
        expect(h === dead || h.endsWith(`.${dead}`), `${g} is on retired ${dead}`).toBe(false);
      }
    }
    expect(DEAD_IPFS_GATEWAY_HOSTS).toEqual(
      expect.arrayContaining(['ipfs.io', 'dweb.link', 'cloudflare-ipfs.com', 'nftstorage.link', 'w3s.link']),
    );
  });
});

describe('liveIpfsUrl', () => {
  const first = `${IPFS_GATEWAYS[0]}${CID}/1.png`;

  it('moves ipfs:// onto the first live gateway', () => {
    expect(liveIpfsUrl(`ipfs://${CID}/1.png`)).toBe(first);
    expect(liveIpfsUrl(`ipfs://ipfs/${CID}/1.png`)).toBe(first);
  });

  // BAYLA's on-chain metadata and Jupiter icon are https://ipfs.io/... URLs, so
  // rewriting only the ipfs:// scheme would leave them broken.
  it.each([
    `https://ipfs.io/ipfs/${CID}/1.png`,
    `https://dweb.link/ipfs/${CID}/1.png`,
    `https://cloudflare-ipfs.com/ipfs/${CID}/1.png`,
    `https://nftstorage.link/ipfs/${CID}/1.png`,
    `https://w3s.link/ipfs/${CID}/1.png`,
    `https://gateway.ipfs.io/ipfs/${CID}/1.png`,
  ])('moves a dead-gateway URL onto a live one: %s', (url) => {
    expect(liveIpfsUrl(url)).toBe(first);
  });

  it('handles the subdomain form of a dead gateway', () => {
    const cid = 'bafkreiav3na7d325rg5ia4vbq5gs2wxbpvmgyzctwuvq2354yb73iv72uq';
    expect(liveIpfsUrl(`https://${cid}.ipfs.dweb.link/`)).toBe(`${IPFS_GATEWAYS[0]}${cid}`);
    expect(liveIpfsUrl(`https://${cid}.ipfs.nftstorage.link/meta.json`)).toBe(`${IPFS_GATEWAYS[0]}${cid}/meta.json`);
  });

  it('leaves live-gateway, non-IPFS and empty values alone', () => {
    const onOrbitor = `${IPFS_GATEWAYS[1]}${CID}/1.png`;
    expect(liveIpfsUrl(onOrbitor)).toBe(onOrbitor);
    expect(liveIpfsUrl('https://nft-cdn.alchemy.com/eth-mainnet/abc')).toBe('https://nft-cdn.alchemy.com/eth-mainnet/abc');
    // A look-alike host is not a gateway.
    expect(liveIpfsUrl(`https://ipfs.io.evil.example/ipfs/${CID}`)).toBe(`https://ipfs.io.evil.example/ipfs/${CID}`);
    expect(liveIpfsUrl(null)).toBeNull();
    expect(liveIpfsUrl(undefined)).toBeUndefined();
    expect(liveIpfsUrl('')).toBe('');
  });
});

describe('nextIpfsGatewayUrl walks the whole list, then stops', () => {
  it('visits every gateway in order and ends with null', () => {
    const seen: string[] = [];
    let cur: string | null = `ipfs://${CID}/1.png`;
    while ((cur = nextIpfsGatewayUrl(cur)) !== null) {
      seen.push(cur);
      expect(seen.length).toBeLessThanOrEqual(IPFS_GATEWAYS.length);
    }
    expect(seen).toEqual(ipfsGatewayUrls(`ipfs://${CID}/1.png`));
    expect(seen).toEqual(IPFS_GATEWAYS.map((g) => `${g}${CID}/1.png`));
  });

  it('restarts a dead-gateway URL at the first live gateway', () => {
    expect(nextIpfsGatewayUrl(`https://ipfs.io/ipfs/${CID}`)).toBe(`${IPFS_GATEWAYS[0]}${CID}`);
  });

  it('returns null for non-IPFS URLs, so the caller keeps its own fallback', () => {
    expect(nextIpfsGatewayUrl('https://nft-cdn.alchemy.com/eth-mainnet/abc')).toBeNull();
    expect(nextIpfsGatewayUrl(null)).toBeNull();
  });

  it('advanceIpfsImg moves a plain <img> along and reports when it runs out', () => {
    const img = document.createElement('img');
    img.setAttribute('src', `${IPFS_GATEWAYS[0]}${CID}/1.png`);
    const visited = [img.getAttribute('src')];
    while (advanceIpfsImg(img)) visited.push(img.getAttribute('src'));
    expect(visited).toEqual(IPFS_GATEWAYS.map((g) => `${g}${CID}/1.png`));
  });
});

describe('fetchIpfsStep', () => {
  const hang = () =>
    vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_r, rej) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    }));

  it('gives up on a hanging gateway after its own step time, without touching the caller', async () => {
    const outer = new AbortController();
    await expect(fetchIpfsStep(hang() as unknown as typeof fetch, 'https://x/ipfs/a', outer.signal, 10))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(outer.signal.aborted).toBe(false);
  });

  it("follows the caller's abort", async () => {
    const outer = new AbortController();
    const p = fetchIpfsStep(hang() as unknown as typeof fetch, 'https://x/ipfs/a', outer.signal, 60_000);
    outer.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// The CSP header only exists on Vercel, so a gateway missing from it works
// locally and is blocked in production.
describe('vercel.json CSP and the gateway list', () => {
  it.each(IPFS_GATEWAYS.map((g) => [g]))('img-src and connect-src permit %s', (g) => {
    const url = `${g}${CID}/1.png`;
    expect(cspAllows('img-src', url), `img-src blocks ${g}`).toBe(true);
    // metadataUri's pre-launch check and fetchWithIpfsFallback fetch() gateways.
    expect(cspAllows('connect-src', url), `connect-src blocks ${g}`).toBe(true);
  });

  it('no longer lists the retired gateways', () => {
    for (const d of ['img-src', 'connect-src']) {
      const hosts = directive(d);
      for (const dead of DEAD_IPFS_GATEWAY_HOSTS) {
        expect(hosts, `${d} still lists retired ${dead}`).not.toContain(`https://${dead}`);
      }
    }
  });
});
