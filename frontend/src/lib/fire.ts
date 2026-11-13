/**
 * The island's fire this week, for Bayla's intel line (api/_lib/fire.js behind
 * `?resource=fire`): read once per five minutes per tab, every caller sharing the read in
 * flight. Null until read, and when it cannot be read: the line is then left out, never 0.
 */
const FIRE_PATH = '/api/aggregator?resource=fire';
const FIRE_FOR_MS = 5 * 60_000;

export interface FireWeek {
  burned: number;
}

let fire: { at: number; answer: Promise<FireWeek | null> } | null = null;

export function readFire(fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<FireWeek | null> {
  if (fire && nowMs - fire.at < FIRE_FOR_MS) return fire.answer;
  const answer = (async (): Promise<FireWeek | null> => {
    try {
      const res = await fetchImpl(FIRE_PATH, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const body = (await res.json()) as { week?: { burned?: unknown } } | null;
      const burned = body?.week?.burned;
      return typeof burned === 'number' && Number.isFinite(burned) ? { burned } : null;
    } catch {
      return null;
    }
  })();
  const mine = { at: nowMs, answer };
  fire = mine;
  void answer.then((a) => {
    if (a === null && fire === mine) fire = null;
  });
  return answer;
}

/** Tests only. */
export function __resetFire(): void {
  fire = null;
}
