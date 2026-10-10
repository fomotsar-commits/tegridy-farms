import { reloadHeld } from './reloadHold';

// A tab left open across a deploy runs a build the host no longer serves. The files it
// loads on demand are gone, and the host answers their names with the app's HTML page
// (status 200), which the browser refuses as a script. Vite reports each such failure as
// `vite:preloadError`. When the host's own page names another build, the tab reloads
// once to the same address; when it may not, StaleBuildFallback says the site was updated.

export type StaleBuildState =
  | { kind: 'idle' }
  /** A lazy load failed and the host's page is being read. */
  | { kind: 'checking' }
  | { kind: 'reloading' }
  /** The host serves another build and this tab has not reloaded itself. */
  | { kind: 'updated' }
  /** Not shown to be a new build: the host's page was unread, or names this build. */
  | { kind: 'unknown' };

/** Everything outside this module that a decision reads or does. Tests pass their own. */
export interface StaleBuildEnv {
  /** The entry script this tab runs, as index.html names it. Null on a dev server. */
  runningEntry(): string | null;
  /** The entry script the host's page names now. Null when it could not be read. */
  servedEntry(): Promise<string | null>;
  held(): boolean;
  /** Where the reload mark lives: this tab only, and it survives the reload. */
  storage(): Pick<Storage, 'getItem' | 'setItem'> | null;
  now(): number;
  reload(): void;
}

const RELOAD_MARK_KEY = 'tegridy-stale-build-reload';
/** No second reload by itself inside this long, whatever the builds say. */
export const RELOAD_MIN_GAP_MS = 60_000;
const INDEX_READ_TIMEOUT_MS = 5_000;
/** A reload that has not replaced the page by now was stopped: the notice takes over. */
export const RELOAD_GIVE_UP_MS = 10_000;

/** The entry script an index.html names, or null when it is not this app's page. */
export function entryOf(html: string): string | null {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    if (!/\btype="module"/.test(tag)) continue;
    const src = /\bsrc="(\/assets\/[^"]+\.js)"/.exec(tag)?.[1];
    if (src) return src;
  }
  return null;
}

async function readServedEntry(): Promise<string | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), INDEX_READ_TIMEOUT_MS);
  try {
    const res = await fetch('/index.html', { cache: 'no-store', signal: stop.signal });
    return res.ok ? entryOf(await res.text()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const browserEnv: StaleBuildEnv = {
  runningEntry: () => document.querySelector('script[type="module"][src^="/assets/"]')?.getAttribute('src') ?? null,
  servedEntry: readServedEntry,
  held: reloadHeld,
  storage: () => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  reload: () => window.location.reload(),
};

/**
 * The loop guard. One reload by itself away from a given build, and none within
 * RELOAD_MIN_GAP_MS of the last: a reload that lands on the same build again, or a host
 * handing out two builds in turn, ends at the notice. A mark that cannot be read back
 * after writing is no guard, so it is no reload.
 */
function claimReload(env: StaleBuildEnv, running: string): boolean {
  try {
    const store = env.storage();
    if (!store) return false;
    const last = JSON.parse(store.getItem(RELOAD_MARK_KEY) ?? 'null') as { from?: unknown; at?: unknown } | null;
    if (last && (last.from === running || typeof last.at !== 'number' || env.now() - last.at < RELOAD_MIN_GAP_MS)) return false;
    const mark = JSON.stringify({ from: running, at: env.now() });
    store.setItem(RELOAD_MARK_KEY, mark);
    return store.getItem(RELOAD_MARK_KEY) === mark;
  } catch {
    return false;
  }
}

let state: StaleBuildState = { kind: 'idle' };
const listeners = new Set<() => void>();
const failed = new WeakSet<object>();

function set(next: StaleBuildState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function staleBuildState(): StaleBuildState {
  return state;
}

export function subscribeStaleBuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Is this the error of a lazy load that failed? By identity: the object Vite reported. */
export function lazyLoadFailed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && failed.has(error);
}

/** One lazy load failed. Reads the host's page, then reloads, or says why it did not. */
export async function noteLazyLoadFailure(error: unknown, env: StaleBuildEnv = browserEnv): Promise<void> {
  if (typeof error === 'object' && error !== null) failed.add(error);
  // One read at a time. A later failure asks again: what held the page may be over.
  if (state.kind === 'checking' || state.kind === 'reloading') return;
  set({ kind: 'checking' });
  const running = env.runningEntry();
  const served = running ? await env.servedEntry() : null;
  if (!running || !served || served === running) return set({ kind: 'unknown' });
  // Asked last, right before the reload: a prompt may have opened during the read.
  if (env.held() || !claimReload(env, running)) return set({ kind: 'updated' });
  set({ kind: 'reloading' });
  setTimeout(() => set({ kind: 'updated' }), RELOAD_GIVE_UP_MS);
  env.reload();
}

/** Listens for Vite's report of a failed lazy load. Mounted once, before the app renders. */
export function installStaleBuildReload(env: StaleBuildEnv = browserEnv): () => void {
  const onPreloadError = (event: VitePreloadErrorEvent) => {
    void noteLazyLoadFailure(event.payload, env);
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}
