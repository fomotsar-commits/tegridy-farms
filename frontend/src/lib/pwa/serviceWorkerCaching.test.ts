// public/sw.js, executed.
//
// The worker ships as a static file, so no import can reach it and no type
// checker looks at it — it is the one piece of this slice that could rot in
// silence while every other test stayed green. It is therefore loaded from disk
// and run against a stubbed service-worker global here, and the assertions are
// about the property that makes it safe to ship at all: it must never be able to
// hand back a cached answer to a question about the chain.
//
// A source-text grep would have been cheaper and would prove nothing. What
// matters is behaviour: which requests it takes over, what it stores, and what
// it returns when the network is gone.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf-8');

const ORIGIN = 'https://app.test';

class StubResponse {
  body: string;
  status: number;
  type: string;
  constructor(body = '', init: { status?: number; type?: string; headers?: Record<string, string> } = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.type = init.type ?? 'basic';
  }
  clone() {
    return new StubResponse(this.body, { status: this.status, type: this.type });
  }
}

class StubHeaders {
  private readonly map: Map<string, string>;
  constructor(init: Record<string, string> = {}) {
    this.map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), v]));
  }
  has(key: string) {
    return this.map.has(key.toLowerCase());
  }
}

class StubRequest {
  url: string;
  method: string;
  mode: string;
  headers: StubHeaders;
  constructor(url: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}) {
    this.url = url.startsWith('http') ? url : `${ORIGIN}${url}`;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'no-cors';
    this.headers = new StubHeaders(init.headers);
  }
}

class StubCache {
  readonly entries = new Map<string, StubResponse>();
  constructor(private readonly doFetch: (req: StubRequest) => Promise<StubResponse>) {}
  async add(request: StubRequest) {
    this.entries.set(request.url, await this.doFetch(request));
  }
  async match(request: StubRequest | string) {
    const url = typeof request === 'string' ? new StubRequest(request).url : request.url;
    return this.entries.get(url);
  }
  async put(request: StubRequest, response: StubResponse) {
    this.entries.set(request.url, response);
  }
}

function makeWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetchMock = vi.fn<(req: StubRequest) => Promise<StubResponse>>();
  const stores = new Map<string, StubCache>();

  const caches = {
    async open(name: string) {
      let cache = stores.get(name);
      if (!cache) {
        cache = new StubCache((req) => fetchMock(req));
        stores.set(name, cache);
      }
      return cache;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async match(request: StubRequest | string, options?: { cacheName?: string }) {
      const names = options?.cacheName ? [options.cacheName] : [...stores.keys()];
      for (const name of names) {
        const hit = await stores.get(name)?.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const claim = vi.fn(async () => {});
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    location: { origin: ORIGIN },
    clients: { claim },
  };

  const run = new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', SW_SOURCE);
  run(self, caches, fetchMock, StubRequest, StubResponse, URL);

  return { listeners, fetchMock, stores, caches, claim };
}

interface FetchEventStub {
  request: StubRequest;
  responded: Promise<StubResponse> | null;
  respondWith(p: Promise<StubResponse>): void;
}

function fetchEvent(request: StubRequest): FetchEventStub {
  return {
    request,
    responded: null,
    respondWith(p) {
      this.responded = p;
    },
  };
}

async function fire(worker: ReturnType<typeof makeWorker>, type: string, event: unknown) {
  const handler = worker.listeners.get(type);
  if (!handler) throw new Error(`the worker registered no ${type} listener`);
  handler(event);
}

async function install(worker: ReturnType<typeof makeWorker>) {
  const waits: Promise<unknown>[] = [];
  await fire(worker, 'install', { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}

let worker: ReturnType<typeof makeWorker>;

beforeEach(() => {
  worker = makeWorker();
  worker.fetchMock.mockImplementation(async (req) => new StubResponse(`network:${req.url}`));
});

describe('what the worker precaches', () => {
  it('caches the offline notice and nothing else', async () => {
    await install(worker);
    const cached = [...worker.stores.values()].flatMap((c) => [...c.entries.keys()]);
    expect(cached).toEqual([`${ORIGIN}/offline.html`]);
  });

  it('does not precache index.html — booting a cached app would frame unread data', async () => {
    await install(worker);
    const cached = [...worker.stores.values()].flatMap((c) => [...c.entries.keys()]);
    expect(cached.some((url) => url.endsWith('/index.html') || url === `${ORIGIN}/`)).toBe(false);
  });
});

describe('what the worker refuses to intercept', () => {
  const untouched = [
    ['a same-origin API read', new StubRequest('/api/heat?token=0x1')],
    ['the aggregator catchall itself', new StubRequest('/api')],
    ['a POST', new StubRequest('/assets/app.js', { method: 'POST' })],
    ['a cross-origin RPC call', new StubRequest('https://eth.example/rpc')],
    ['a range request', new StubRequest('/assets/video.mp4', { headers: { Range: 'bytes=0-' } })],
    ['a same-origin image outside the immutable prefixes', new StubRequest('/art/bobowelie.jpg')],
    ['the manifest', new StubRequest('/manifest.webmanifest')],
  ] as const;

  for (const [label, request] of untouched) {
    it(`leaves ${label} entirely to the browser`, async () => {
      await install(worker);
      const event = fetchEvent(request);
      await fire(worker, 'fetch', event);
      // Not "returns the network response" — respondWith is never called at all,
      // so the request never enters the worker's fetch and never meets a cache.
      expect(event.responded).toBeNull();
    });
  }

  it('stores nothing at all after a page full of uncacheable traffic', async () => {
    await install(worker);
    for (const [, request] of untouched) {
      await fire(worker, 'fetch', fetchEvent(request));
    }
    const cached = [...worker.stores.values()].flatMap((c) => [...c.entries.keys()]);
    expect(cached).toEqual([`${ORIGIN}/offline.html`]);
  });
});

describe('immutable build assets', () => {
  it('serves them from cache on the second ask, without a second network call', async () => {
    await install(worker);
    const request = new StubRequest('/assets/index-a1b2c3.js');

    const first = fetchEvent(request);
    await fire(worker, 'fetch', first);
    expect(await first.responded).toBeTruthy();

    worker.fetchMock.mockClear();
    const second = fetchEvent(request);
    await fire(worker, 'fetch', second);
    const body = await second.responded;
    expect(body!.body).toBe(`network:${ORIGIN}/assets/index-a1b2c3.js`);
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to store a non-200 or non-basic response', async () => {
    await install(worker);
    worker.fetchMock.mockResolvedValueOnce(new StubResponse('', { status: 206 }));
    await fire(worker, 'fetch', fetchEvent(new StubRequest('/assets/partial.js')));
    worker.fetchMock.mockResolvedValueOnce(new StubResponse('opaque', { type: 'opaque' }));
    await fire(worker, 'fetch', fetchEvent(new StubRequest('/assets/opaque.js')));
    await Promise.resolve();

    const cached = [...worker.stores.values()].flatMap((c) => [...c.entries.keys()]);
    expect(cached.some((url) => url.includes('partial.js') || url.includes('opaque.js'))).toBe(false);
  });
});

describe('navigating with no network', () => {
  it('answers with the offline notice, never with a cached app document', async () => {
    await install(worker);
    worker.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const event = fetchEvent(new StubRequest('/farm', { mode: 'navigate' }));
    await fire(worker, 'fetch', event);
    const response = await event.responded;
    expect(response!.body).toBe(`network:${ORIGIN}/offline.html`);
  });

  it('prefers the live document whenever the network answers', async () => {
    await install(worker);
    const event = fetchEvent(new StubRequest('/farm', { mode: 'navigate' }));
    await fire(worker, 'fetch', event);
    const response = await event.responded;
    // Network-first, so a working connection always gets the current build —
    // there is no path where a navigation is served from disk while online.
    expect(response!.body).toBe(`network:${ORIGIN}/farm`);
  });

  it('does not cache the document it just fetched', async () => {
    await install(worker);
    const event = fetchEvent(new StubRequest('/farm', { mode: 'navigate' }));
    await fire(worker, 'fetch', event);
    await event.responded;
    const cached = [...worker.stores.values()].flatMap((c) => [...c.entries.keys()]);
    expect(cached).toEqual([`${ORIGIN}/offline.html`]);
  });

  it('still says something honest when even the notice is missing', async () => {
    // No install ran, so nothing is precached — the degenerate case.
    worker.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const event = fetchEvent(new StubRequest('/', { mode: 'navigate' }));
    await fire(worker, 'fetch', event);
    const response = await event.responded;
    expect(response!.status).toBe(503);
    expect(response!.body).toContain('offline');
  });
});

describe('activation', () => {
  it('drops caches from older versions and keeps the current pair', async () => {
    await install(worker);
    await worker.caches.open('tegridy-shell-v0');
    await worker.caches.open('some-other-app-cache');

    const waits: Promise<unknown>[] = [];
    await fire(worker, 'activate', { waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);

    const remaining = await worker.caches.keys();
    expect(remaining).not.toContain('tegridy-shell-v0');
    expect(remaining).not.toContain('some-other-app-cache');
    expect(remaining.some((k) => k.startsWith('tegridy-shell-'))).toBe(true);
    expect(worker.claim).toHaveBeenCalled();
  });
});

describe('what the worker deliberately does not do', () => {
  it('registers no push, notificationclick, sync or periodicsync handler', () => {
    // Push belongs to /push-sw.js and to nothing else, and this venue runs no
    // keeper — a background handler here would imply work that nothing performs.
    for (const type of ['push', 'notificationclick', 'sync', 'periodicsync', 'backgroundfetchsuccess']) {
      expect(worker.listeners.has(type), `the shell worker registered a ${type} handler`).toBe(false);
    }
  });

  it('does not call skipWaiting, which would swap workers mid-session', async () => {
    const skipWaiting = vi.fn();
    const probe = makeWorker();
    (probe as unknown as { listeners: Map<string, unknown> }).listeners.clear();
    // Re-run with a self that records skipWaiting.
    const listeners = new Map<string, (event: unknown) => void>();
    const run = new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', SW_SOURCE);
    run(
      {
        addEventListener: (t: string, h: (e: unknown) => void) => listeners.set(t, h),
        location: { origin: ORIGIN },
        clients: { claim: async () => {} },
        skipWaiting,
      },
      probe.caches,
      probe.fetchMock,
      StubRequest,
      StubResponse,
      URL,
    );
    const waits: Promise<unknown>[] = [];
    listeners.get('install')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(skipWaiting).not.toHaveBeenCalled();
  });
});
