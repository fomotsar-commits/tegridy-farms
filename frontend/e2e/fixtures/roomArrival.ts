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
  navTypes: string[];
  at: Record<string, Sample>;
  scrollHeight: number;
}

/** Runs before any page script, on every document of the tab. */
function instrument(samples: readonly number[]) {
  const KEY = '__roomArrival';
  type State = { t0: number; loads: number; navTypes: string[]; at: Record<string, unknown>; scrollHeight: number };
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
  const first = read() ?? { t0: performance.timeOrigin, loads: 0, navTypes: [], at: {}, scrollHeight: 0 };
  first.loads += 1;
  write(first);
  document.addEventListener('DOMContentLoaded', () => {
    const s = read();
    if (!s) return;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    s.navTypes.push(nav?.type ?? 'unknown');
    write(s);
  });
  for (const ms of samples) {
    const due = first.t0 + ms;
    setTimeout(() => {
      const s = read();
      if (!s || s.at[ms]) return;
      const h1 = document.querySelector('main#main-content h1');
      const r = h1?.getBoundingClientRect();
      s.at[ms] = {
        y: Math.round(window.scrollY),
        h1InView: !!r && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight,
        lateMs: Math.round(Date.now() - due),
      };
      s.scrollHeight = document.documentElement.scrollHeight;
      write(s);
    }, Math.max(0, due - Date.now()));
  }
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
      if (state?.at?.[last]) break;
      await page.waitForTimeout(250);
    }
    if (!state?.at?.[last]) throw new Error(`${url}: no ${last} ms sample within 20 s`);
    return { url, documents, loads: state.loads, navTypes: state.navTypes, at: state.at, scrollHeight: state.scrollHeight };
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
  return (
    `[room-arrival] ${label}: documents ${arrivals.map((a) => a.documents).join(',')}` +
    ` · loads ${arrivals.map((a) => a.loads).join(',')}` +
    ` · off-hero ${count(offHero)}/${n}` +
    ` · H1@1s ${h1(1000)}/${n} · H1@3s ${h1(3000)}/${n} · H1@7s ${h1(7000)}/${n}` +
    ` · y@7s ${arrivals.map((a) => `${a.at[7000]?.y}/${a.scrollHeight}`).join(',')}`
  );
}
