import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  IPFS_GATEWAYS,
  DEAD_IPFS_GATEWAY_HOSTS,
  ipfsGatewayUrls,
  liveIpfsUrl,
  nextIpfsGatewayUrl,
  watchIpfsImg,
  fetchIpfsStep,
  IPFS_STEP_TIMEOUT_MS,
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
  it('holds the four gateways measured to serve real content on 2026-09-26', () => {
    expect([...IPFS_GATEWAYS.map(host)].sort()).toEqual([
      'gateway.pinata.cloud',
      'ipfs.aleph.cloud',
      'ipfs.filebase.io',
      'ipfs.orbitor.dev',
    ]);
    // Fastest when it has the content (0.1-0.3s), so it leads.
    expect(host(IPFS_GATEWAYS[0])).toBe('ipfs.filebase.io');
  });

  // Uncached Jungle Bay tokens, 2026-09-26: Pinata served 8/8 (4.0-7.5s), while
  // orbitor and aleph answered 504 after 30s. Behind a hung filebase, Pinata is
  // where an uncached image comes from, so no gateway that 504s on uncached
  // content may sit in front of it and burn a step budget first.
  it('puts the gateway that serves uncached content right after the first', () => {
    const at = (h: string) => IPFS_GATEWAYS.map(host).indexOf(h);
    expect(at('gateway.pinata.cloud')).toBe(1);
    expect(at('gateway.pinata.cloud')).toBeLessThan(at('ipfs.orbitor.dev'));
    expect(at('gateway.pinata.cloud')).toBeLessThan(at('ipfs.aleph.cloud'));
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

  // Nakamigos' metadataBase is on alchemy.mypinata.cloud, a Pinata dedicated
  // gateway that is not in the CSP, so the browser blocked every image built on
  // it. The CID is public; it has to move onto the live list like a dead host.
  it('moves a Pinata dedicated-gateway URL onto a live one', () => {
    const naka = 'QmaN1jRPtmzeqhp6s3mR1SRK4q1xWPvFvwqW1jyN6trir9';
    expect(liveIpfsUrl(`https://alchemy.mypinata.cloud/ipfs/${naka}/1`)).toBe(`${IPFS_GATEWAYS[0]}${naka}/1`);
    expect(nextIpfsGatewayUrl(`https://alchemy.mypinata.cloud/ipfs/${naka}/1`)).toBe(`${IPFS_GATEWAYS[0]}${naka}/1`);
    // Only the dedicated-gateway family, not a look-alike.
    expect(liveIpfsUrl(`https://mypinata.cloud.evil.example/ipfs/${naka}`)).toBe(`https://mypinata.cloud.evil.example/ipfs/${naka}`);
  });

  // Review R2 (privacy): a query string rode along onto the public list, and a
  // Pinata dedicated gateway's URL can carry its access token. That token went
  // to all four gateways. A URL that moves host leaves its query behind.
  it('never carries a query string onto another host', () => {
    const naka = 'QmaN1jRPtmzeqhp6s3mR1SRK4q1xWPvFvwqW1jyN6trir9';
    const cid = 'bafkreiav3na7d325rg5ia4vbq5gs2wxbpvmgyzctwuvq2354yb73iv72uq';
    const cases: [string, string][] = [
      [`https://alchemy.mypinata.cloud/ipfs/${naka}/1?pinataGatewayToken=SECRET`, `${naka}/1`],
      [`https://ipfs.io/ipfs/${CID}/1.png?pinataGatewayToken=SECRET&x=1`, `${CID}/1.png`],
      [`https://${cid}.ipfs.dweb.link/meta.json?token=SECRET`, `${cid}/meta.json`],
      // Already on a live gateway: the walk still moves it to other hosts.
      [`${IPFS_GATEWAYS[0]}${CID}/1.png?token=SECRET`, `${CID}/1.png`],
    ];
    for (const [url, path] of cases) {
      const built = [...ipfsGatewayUrls(url)];
      for (let cur: string | null = url; (cur = nextIpfsGatewayUrl(cur)) !== null; ) built.push(cur);
      const live = liveIpfsUrl(url) as string;
      if (host(live) !== host(url)) built.push(live);
      expect(built.length, url).toBeGreaterThanOrEqual(IPFS_GATEWAYS.length);
      for (const u of built) {
        expect(u, `${url} -> ${u}`).not.toContain('SECRET');
        expect(new URL(u).search, `${url} -> ${u}`).toBe('');
        expect(u.endsWith(`/ipfs/${path}`), `${url} -> ${u}`).toBe(true);
      }
    }
    // A URL that stays where it is keeps its own query: nothing is sent anywhere new.
    const onLive = `${IPFS_GATEWAYS[1]}${CID}/1.png?filename=1.png`;
    expect(liveIpfsUrl(onLive)).toBe(onLive);
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
});

describe('watchIpfsImg: move on from a hung gateway, never from a slow download', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const img = (state: { naturalWidth?: number; complete?: boolean } = {}) => {
    const el = document.createElement('img');
    el.setAttribute('src', `${IPFS_GATEWAYS[0]}${CID}/1.png`);
    Object.defineProperty(el, 'naturalWidth', { configurable: true, get: () => state.naturalWidth ?? 0 });
    Object.defineProperty(el, 'complete', { configurable: true, get: () => state.complete ?? false });
    return el;
  };

  it('calls onHang when the gateway has sent nothing for a whole step', () => {
    vi.useFakeTimers();
    const onHang = vi.fn();
    watchIpfsImg(img(), { onHang });
    vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS - 1);
    expect(onHang).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHang).toHaveBeenCalledTimes(1);
  });

  // The review's R1: the old check was `complete && naturalWidth > 0`, so a
  // 2.5 MB PNG that had started arriving but not finished was treated as hung
  // and restarted on the next gateway. Browsers set naturalWidth from the image
  // header (measured in Chromium and WebKit), so it tells "no bytes yet" from
  // "still downloading".
  it('leaves an image alone once its bytes are arriving, however long the download', () => {
    vi.useFakeTimers();
    const onHang = vi.fn();
    watchIpfsImg(img({ naturalWidth: 2480, complete: false }), { onHang });
    vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 10);
    expect(onHang).not.toHaveBeenCalled();
  });

  it('does not call onHang for an image that already finished (loaded or failed)', () => {
    vi.useFakeTimers();
    const onHang = vi.fn();
    watchIpfsImg(img({ complete: true }), { onHang });
    vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 2);
    expect(onHang).not.toHaveBeenCalled();
  });

  // Pinata served every uncached token but took up to 7.5s to its first byte.
  // The old 6s step skipped it. An 8s gateway must still be waited for.
  it('waits out a slow gateway that answers after 8s', () => {
    vi.useFakeTimers();
    const state = { naturalWidth: 0 };
    const onHang = vi.fn();
    watchIpfsImg(img(state), { onHang });
    vi.advanceTimersByTime(8000);
    state.naturalWidth = 2480; // the first bytes arrive at 8s
    vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 3);
    expect(onHang).not.toHaveBeenCalled();
  });

  // Review R1 (WebKit): the clock started 1250px ahead of the viewport, where
  // Chromium has requested a lazy image but WebKit (about one viewport height)
  // has not, so on an iPhone an unseen image walked every gateway and was given
  // up on. The margin must be the viewport itself. The engines themselves are
  // exercised in e2e/ipfs-lazy-hang.spec.ts; this pins the wiring.
  it("starts a lazy image's clock only once it is in view, keeps it running after, and cleans up", () => {
    vi.useFakeTimers();
    type Cb = (e: { isIntersecting: boolean }[]) => void;
    const observers: { cb: Cb; opts?: IntersectionObserverInit; disconnected: boolean }[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      cb: Cb;
      opts?: IntersectionObserverInit;
      disconnected = false;
      constructor(cb: Cb, opts?: IntersectionObserverInit) { this.cb = cb; this.opts = opts; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    });
    const onHang = vi.fn();
    const stop = watchIpfsImg(img(), { lazy: true, onHang });
    // Observed against the viewport with no margin in any direction.
    expect(observers[0].opts?.root ?? null).toBeNull();
    const margins = (observers[0].opts?.rootMargin ?? '0px').trim().split(/\s+/);
    expect(margins.map((m) => parseFloat(m)), `rootMargin ${observers[0].opts?.rootMargin}`).toEqual(margins.map(() => 0));
    vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 3);
    expect(onHang).not.toHaveBeenCalled();
    observers[0].cb([{ isIntersecting: true }]);
    // Seen, then scrolled away: the browser's request goes on, so the clock does.
    observers[0].cb([{ isIntersecting: false }]);
    vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS);
    expect(onHang).toHaveBeenCalledTimes(1);

    const onHang2 = vi.fn();
    const stop2 = watchIpfsImg(img(), { onHang: onHang2 });
    stop2();
    vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 2);
    expect(onHang2).not.toHaveBeenCalled();
    stop();
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
