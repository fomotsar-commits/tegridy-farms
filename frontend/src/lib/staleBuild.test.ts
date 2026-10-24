import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaleBuildEnv } from './staleBuild';

// A tab on build A whose host now serves build B, and what the tab does when a lazy load
// fails. The module keeps its state for the life of a page, so each test loads it fresh.

const A = '/assets/index-AAAAAAAA.js';
const B = '/assets/index-BBBBBBBB.js';
const C = '/assets/index-CCCCCCCC.js';

type Mod = typeof import('./staleBuild');
let mod: Mod;

/** One tab's session storage: it outlives a reload, so a test hands it to the next page. */
function tabStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

interface PageOptions extends Partial<StaleBuildEnv> {
  running?: string | null;
  served?: string | null;
  store?: ReturnType<typeof tabStorage>;
}

/** One loaded page: build A on a host serving B unless said otherwise. Every part is a spy. */
function page(over: PageOptions = {}) {
  const { running = A, served = B, store = tabStorage(), ...rest } = over;
  return {
    runningEntry: vi.fn(rest.runningEntry ?? (() => running)),
    servedEntry: vi.fn(rest.servedEntry ?? (async () => served)),
    held: vi.fn(rest.held ?? (() => false)),
    storage: vi.fn(rest.storage ?? (() => store)),
    now: vi.fn(rest.now ?? (() => 1_000_000)),
    reload: vi.fn(rest.reload ?? (() => undefined)),
    store,
  };
}

beforeEach(async () => {
  vi.resetModules();
  mod = await import('./staleBuild');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a lazy load fails on a tab left open across a deploy', () => {
  it('the host serves another build: the tab reloads, once', async () => {
    const env = page();
    await mod.noteLazyLoadFailure(new Error('Failed to fetch dynamically imported module'), env);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(mod.staleBuildState()).toEqual({ kind: 'reloading' });
  });

  it('several lazy loads failing together make one read of the host and one reload', async () => {
    const env = page();
    await Promise.all([
      mod.noteLazyLoadFailure(new Error('page chunk'), env),
      mod.noteLazyLoadFailure(new Error('its stylesheet'), env),
      mod.noteLazyLoadFailure(new Error('a second chunk'), env),
    ]);
    expect(env.servedEntry).toHaveBeenCalledTimes(1);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('says it is reading the host while it reads, so a boundary can hold its spinner', async () => {
    let answer: (entry: string | null) => void = () => undefined;
    const env = page({ servedEntry: () => new Promise<string | null>((r) => (answer = r)) });
    const seen: string[] = [];
    mod.subscribeStaleBuild(() => seen.push(mod.staleBuildState().kind));
    const done = mod.noteLazyLoadFailure(new Error('x'), env);
    expect(mod.staleBuildState()).toEqual({ kind: 'checking' });
    answer(B);
    await done;
    expect(seen).toEqual(['checking', 'reloading']);
  });
});

describe('the loop guard', () => {
  it('a reload that lands on the SAME build does not reload again: the notice stands', async () => {
    const first = page();
    await mod.noteLazyLoadFailure(new Error('x'), first);
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The page after that reload: a fresh module, the same tab's storage, still build A.
    vi.resetModules();
    const after: Mod = await import('./staleBuild');
    const second = page({ store: first.store, now: () => 1_000_000 + 10 * mod.RELOAD_MIN_GAP_MS });
    await after.noteLazyLoadFailure(new Error('x'), second);
    expect(second.reload).not.toHaveBeenCalled();
    expect(after.staleBuildState()).toEqual({ kind: 'updated' });
  });

  it('a host handing out two builds in turn does not make the tab reload back and forth', async () => {
    const first = page({ running: A, served: B });
    await mod.noteLazyLoadFailure(new Error('x'), first);
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The reload landed on B, and seconds later the host names A again.
    vi.resetModules();
    const after: Mod = await import('./staleBuild');
    const second = page({ running: B, served: A, store: first.store, now: () => 1_000_000 + mod.RELOAD_MIN_GAP_MS - 1 });
    await after.noteLazyLoadFailure(new Error('x'), second);
    expect(second.reload).not.toHaveBeenCalled();
    expect(after.staleBuildState()).toEqual({ kind: 'updated' });
  });

  it('a LATER deploy gets its own single reload: the mark is for one build, not for the tab', async () => {
    const first = page({ running: A, served: B });
    await mod.noteLazyLoadFailure(new Error('x'), first);

    vi.resetModules();
    const after: Mod = await import('./staleBuild');
    const second = page({ running: B, served: C, store: first.store, now: () => 1_000_000 + mod.RELOAD_MIN_GAP_MS });
    await after.noteLazyLoadFailure(new Error('x'), second);
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it('no storage to keep the mark in: no reload, the notice instead', async () => {
    const env = page({ storage: () => null });
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(mod.staleBuildState()).toEqual({ kind: 'updated' });
  });

  it('a mark that does not read back after writing is no guard: no reload', async () => {
    const env = page({ storage: () => ({ getItem: () => null, setItem: () => undefined }) });
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(mod.staleBuildState()).toEqual({ kind: 'updated' });
  });

  it('storage that throws, or holds something unreadable: no reload', async () => {
    const throwing = page({
      storage: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    await mod.noteLazyLoadFailure(new Error('x'), throwing);
    expect(throwing.reload).not.toHaveBeenCalled();

    vi.resetModules();
    const again: Mod = await import('./staleBuild');
    const garbled = page({ storage: () => ({ getItem: () => '{not json', setItem: () => undefined }) });
    await again.noteLazyLoadFailure(new Error('x'), garbled);
    expect(garbled.reload).not.toHaveBeenCalled();
    expect(again.staleBuildState()).toEqual({ kind: 'updated' });
  });

  it('a reload the browser did not carry out ends at the notice, not at a spinner', async () => {
    vi.useFakeTimers();
    const env = page();
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(mod.staleBuildState()).toEqual({ kind: 'reloading' });
    vi.advanceTimersByTime(mod.RELOAD_GIVE_UP_MS);
    expect(mod.staleBuildState()).toEqual({ kind: 'updated' });
  });
});

describe('a transaction is in flight', () => {
  it('never reloads: the notice instead, and nothing is marked', async () => {
    const env = page({ held: () => true });
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(mod.staleBuildState()).toEqual({ kind: 'updated' });
    expect(env.store.data.size).toBe(0);
  });

  it('is asked AFTER the host is read: a prompt opened during the read still holds', async () => {
    let open = false;
    const env = page({
      held: () => open,
      servedEntry: async () => {
        open = true;
        return B;
      },
    });
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(mod.staleBuildState()).toEqual({ kind: 'updated' });
  });

  it('once it is over, the next failed lazy load reloads', async () => {
    let open = true;
    const env = page({ held: () => open });
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(env.reload).not.toHaveBeenCalled();
    open = false;
    await mod.noteLazyLoadFailure(new Error('y'), env);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });
});

describe('not shown to be a new build', () => {
  it.each([
    ['the host names the build this tab runs', { served: A }],
    ['the host could not be read', { served: null }],
    ['a dev server, which has no built entry', { running: null }],
  ])('%s: no reload and no claim of an update', async (_name, over) => {
    const env = page(over);
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(mod.staleBuildState()).toEqual({ kind: 'unknown' });
    expect(env.store.data.size).toBe(0);
  });

  it('asks again at the next failure: the deploy may have landed since', async () => {
    let served: string | null = null;
    const env = page({ servedEntry: async () => served });
    await mod.noteLazyLoadFailure(new Error('x'), env);
    expect(mod.staleBuildState()).toEqual({ kind: 'unknown' });
    served = B;
    await mod.noteLazyLoadFailure(new Error('y'), env);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });
});

describe("Vite's report is the only thing listened to", () => {
  it('vite:preloadError starts the read, and its error is known again by identity', async () => {
    const env = page();
    const stop = mod.installStaleBuildReload(env);
    const failure = new Error('Failed to fetch dynamically imported module: /assets/SolanaLpPage-old.js');
    const event = new Event('vite:preloadError', { cancelable: true }) as VitePreloadErrorEvent;
    event.payload = failure;
    window.dispatchEvent(event);
    await vi.waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1));
    expect(mod.lazyLoadFailed(failure)).toBe(true);
    // The same words on another error are not a failed lazy load: nothing is matched by text.
    expect(mod.lazyLoadFailed(new Error(failure.message))).toBe(false);
    // The import still rejects for whoever awaited it: the event is not swallowed.
    expect(event.defaultPrevented).toBe(false);
    stop();
  });

  it('after it is removed, nothing is listened to', async () => {
    const env = page();
    mod.installStaleBuildReload(env)();
    const event = new Event('vite:preloadError') as VitePreloadErrorEvent;
    event.payload = new Error('x');
    window.dispatchEvent(event);
    await Promise.resolve();
    expect(env.servedEntry).not.toHaveBeenCalled();
  });
});

describe('entryOf', () => {
  it("reads the entry script from this app's index.html", () => {
    const html = `<!doctype html><html><head><script src="/theme-init.js"></script>
      <script type="module" crossorigin src="${A}"></script></head><body></body></html>`;
    expect(mod.entryOf(html)).toBe(A);
    expect(mod.entryOf(`<script src="${A}" crossorigin type="module"></script>`)).toBe(A);
    // Read as a browser reads it, whatever the case or the quotes.
    expect(mod.entryOf(`<SCRIPT TYPE="module" SRC='${A}'></SCRIPT>`)).toBe(A);
  });

  it('reads the same script the running page is asked for: one rule for both documents', () => {
    document.head.innerHTML = `<script type="module" crossorigin src="${A}"></script>`;
    const running = document.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute('src');
    expect(mod.entryOf(document.documentElement.outerHTML)).toBe(running);
    document.head.innerHTML = '';
  });

  it('a script only written about, inside a comment or as text, is not the entry', () => {
    expect(mod.entryOf(`<!-- <script type="module" src="${A}"></script> -->`)).toBeNull();
    expect(mod.entryOf(`<pre>&lt;script type="module" src="${A}"&gt;&lt;/script&gt;</pre>`)).toBeNull();
  });

  it("is null for a page that is not this app's: no reload is ever based on it", () => {
    expect(mod.entryOf('<html><body>Sign in to the network</body></html>')).toBeNull();
    expect(mod.entryOf('<script type="module" src="https://elsewhere.example/assets/index-x.js"></script>')).toBeNull();
    expect(mod.entryOf('<script src="/assets/index-classic.js"></script>')).toBeNull();
  });
});

describe('in a browser', () => {
  const realFetch = globalThis.fetch;
  const realLocation = window.location;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { ...realLocation, reload } });
    window.sessionStorage.clear();
    document.head.innerHTML = `<script type="module" crossorigin src="${A}"></script>`;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
    globalThis.fetch = realFetch;
    document.head.innerHTML = '';
  });

  it('reads /index.html past every cache, and reloads when it names another entry', async () => {
    const fetched = vi.fn(async () => new Response(`<script type="module" crossorigin src="${B}"></script>`, { status: 200 }));
    globalThis.fetch = fetched as unknown as typeof fetch;
    await mod.noteLazyLoadFailure(new Error('x'));
    expect(fetched).toHaveBeenCalledWith('/index.html', expect.objectContaining({ cache: 'no-store' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.sessionStorage.getItem('tegridy-stale-build-reload') ?? '{}')).toMatchObject({ from: A });
  });

  it.each([
    ['the read fails', async () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the host answers an error', async () => new Response('down', { status: 503 })],
    ['the host names the same entry', async () => new Response(`<script type="module" src="${A}"></script>`, { status: 200 })],
  ])('%s: no reload', async (_name, answer) => {
    globalThis.fetch = vi.fn(answer) as unknown as typeof fetch;
    await mod.noteLazyLoadFailure(new Error('x'));
    expect(reload).not.toHaveBeenCalled();
    expect(mod.staleBuildState()).toEqual({ kind: 'unknown' });
  });
});
