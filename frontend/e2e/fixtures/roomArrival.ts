/**
 * One cold arrival at a room, measured from inside the tab. Shared by the CI
 * spec (e2e/room-arrival.spec.ts, vite preview) and the production walk
 * (e2e-prod/room-arrival.spec.ts). The counter lives in sessionStorage because
 * it survives a reload within the tab, so a reload reads as loads 2; the app
 * itself ships no instrumentation.
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';

export const ROOM_ROUTES = ['/bayla', '/pepe', '/mfer', '/toweli'] as const;
export const SAMPLE_MS = [1000, 3000, 7000] as const;

export interface Sample {
  y: number;
  h1InView: boolean;
  lateMs: number;
}

export interface Arrival {
  url: string;
  /** Documents the page loaded, counted by the init script. */
  loads: number;
  /** Main-frame document requests Playwright saw. */
  documents: number;
  /** One per document, pushed at its DOMContentLoaded. Empty if none landed in time. */
  navTypes: string[];
  at: Record<string, Sample>;
  scrollHeight: number;
  /** First moment (ms from navigation start) the H1 was in the viewport, polled every 50 ms; null if never by 8 s. */
  h1FirstMs: number | null;
}

/** Runs before any page script, on every document of the tab. */
function instrument(samples: readonly number[]) {
  const KEY = '__roomArrival';
  type State = {
    t0: number; loads: number; navTypes: string[]; at: Record<string, unknown>; scrollHeight: number; h1FirstMs: number | null;
  };
  const read = (): State | null => {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as State) : null;
    } catch {
      return null;
    }
  };
  const write = (s: State) => {
    try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked: the spec sees no state */ }
  };
  const first = read() ?? { t0: performance.timeOrigin, loads: 0, navTypes: [], at: {}, scrollHeight: 0, h1FirstMs: null };
  first.loads += 1;
  write(first);
  document.addEventListener('DOMContentLoaded', () => {
    const s = read();
    if (!s) return;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    s.navTypes.push(nav?.type ?? 'unknown');
    write(s);
  });
  // The document may not have a root element yet when a late timer fires, so every read here tolerates that.
  // A door's static frame sits outside main until React replaces it.
  const h1InView = () => {
    const r = document.querySelector('#first-frame h1, main#main-content h1')?.getBoundingClientRect();
    return !!r && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  };
  for (const ms of samples) {
    const due = first.t0 + ms;
    setTimeout(() => {
      const s = read();
      if (!s || s.at[ms]) return;
      s.at[ms] = { y: Math.round(window.scrollY), h1InView: h1InView(), lateMs: Math.round(Date.now() - due) };
      s.scrollHeight = document.documentElement?.scrollHeight ?? 0;
      write(s);
    }, Math.max(0, due - Date.now()));
  }
  const poll = setInterval(() => {
    if (!h1InView()) return;
    clearInterval(poll);
    const s = read();
    if (s && s.h1FirstMs === null) {
      s.h1FirstMs = Math.round(Date.now() - s.t0);
      write(s);
    }
  }, 50);
  setTimeout(() => clearInterval(poll), Math.max(0, first.t0 + 8000 - Date.now()));
}

/** A new context (nothing stored), one navigation, samples at 1, 3 and 7 s. */
export async function coldArrival(browser: Browser, contextOptions: BrowserContextOptions, url: string): Promise<Arrival> {
  const context = await browser.newContext(contextOptions);
  try {
    await context.addInitScript(instrument, SAMPLE_MS);
    const page = await context.newPage();
    let documents = 0;
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents += 1;
    });
    await page.goto(url, { waitUntil: 'commit' });
    const last = String(SAMPLE_MS[SAMPLE_MS.length - 1]);
    const deadline = Date.now() + 20_000;
    let state: Omit<Arrival, 'url' | 'documents'> | null = null;
    while (Date.now() < deadline) {
      state = await page
        .evaluate(() => {
          try {
            return JSON.parse(sessionStorage.getItem('__roomArrival') ?? 'null');
          } catch {
            return null;
          }
        })
        .catch(() => null);
      // The last sample is fixed at 7 s but DOMContentLoaded is not, so waiting
      // only for the sample can read navTypes before the document pushed one.
      if (state?.at?.[last] && state.navTypes.length > 0) break;
      await page.waitForTimeout(250);
    }
    if (!state?.at?.[last]) throw new Error(`${url}: no ${last} ms sample within 20 s`);
    return {
      url, documents, loads: state.loads, navTypes: state.navTypes, at: state.at,
      scrollHeight: state.scrollHeight, h1FirstMs: state.h1FirstMs,
    };
  } finally {
    await context.close();
  }
}

/** One line per route and class, for the run log and the measurement record. */
export function summarize(label: string, arrivals: Arrival[]): string {
  const n = arrivals.length;
  const count = (f: (a: Arrival) => boolean) => arrivals.filter(f).length;
  const offHero = (a: Arrival) => SAMPLE_MS.some((ms) => (a.at[ms]?.y ?? -1) !== 0) || !a.at[7000]?.h1InView;
  const h1 = (ms: number) => count((a) => !!a.at[ms]?.h1InView);
  const firsts = arrivals.map((a) => a.h1FirstMs).filter((v): v is number => v !== null).sort((x, y) => x - y);
  const h1First = firsts.length
    ? `${firsts[0]}-${firsts[firsts.length - 1]} ms, median ${firsts[Math.floor((firsts.length - 1) / 2)]}`
    : 'never';
  return (
    `[room-arrival] ${label}: documents ${arrivals.map((a) => a.documents).join(',')}` +
    ` · loads ${arrivals.map((a) => a.loads).join(',')}` +
    ` · nav ${arrivals.map((a) => a.navTypes.join('+') || 'none').join(',')}` +
    ` · off-hero ${count(offHero)}/${n}` +
    ` · H1@1s ${h1(1000)}/${n} · H1@3s ${h1(3000)}/${n} · H1@7s ${h1(7000)}/${n}` +
    ` · H1 first in view ${h1First} (${firsts.length}/${n})` +
    ` · y@7s ${arrivals.map((a) => `${a.at[7000]?.y}/${a.scrollHeight}`).join(',')}`
  );
}
