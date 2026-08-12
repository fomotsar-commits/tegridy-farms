// THE BIRTH NOTIFY QUEUE.
//
// "Delivery semantics: the notify NEVER blocks a launch and NEVER fails silently. Queue
//  with visible retry and an ops surface; the chain and the JSON record are the backfill
//  truth."
//
// Those two nevers pull in opposite directions, and every design mistake here is picking
// one and forgetting the other:
//
//   NEVER BLOCKS  =>  `enqueueBirth` is synchronous and cannot throw. It writes to
//                     storage and returns. A launch that has landed on-chain is finished
//                     whether or not the island is reachable, and a launcher must never
//                     watch a spinner for a third party's uptime.
//
//   NEVER SILENT  =>  a failed delivery STAYS in the queue with its error and attempt
//                     count, and the ops surface renders it. The failure mode this rules
//                     out is a fire-and-forget `void fetch()` whose rejection is
//                     swallowed — after which nobody can tell an enrolled token from a
//                     lost one.
//
// The queue is per-browser (localStorage), which is a real limitation and is why the
// directive names the chain and the JSON record as the backfill truth: if a launcher
// closes the tab forever, the island can still reconstruct every birth from the chain.
// The queue's job is to make the COMMON case reliable and the uncommon case VISIBLE, not
// to be a durable message broker.

import type { BirthChain } from './birthRecord';

/** The six fields, exactly. A seventh is a 400 from the island, named. */
export interface BirthNotifyBody {
  ca: string;
  chain: BirthChain;
  creator: string;
  birth_block: number;
  gate_decision_id: string;
  record_url: string;
}

export type BirthQueueStatus = 'pending' | 'delivered' | 'rejected';

export interface BirthQueueItem {
  /** Local id. Distinct from the island's enrollment_id, which we learn on delivery. */
  id: string;
  body: BirthNotifyBody;
  status: BirthQueueStatus;
  attempts: number;
  /** Unix ms. */
  queuedAt: number;
  lastAttemptAt: number | null;
  /** The last failure, in the words the surface shows an operator. */
  lastError: string | null;
  /** The island's id, once it has one. */
  enrollmentId: number | null;
}

const STORAGE_KEY = 'tegridy.births.queue.v1';
/** Bounded: a queue that can grow without limit becomes a storage-quota outage. */
const MAX_ITEMS = 200;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `bn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Every queued birth, newest first. Never throws. */
export function readBirthQueue(): BirthQueueItem[] {
  const s = store();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is BirthQueueItem =>
        !!i && typeof i === 'object' && typeof (i as BirthQueueItem).id === 'string' && !!(i as BirthQueueItem).body,
    );
  } catch {
    return [];
  }
}

function writeQueue(items: BirthQueueItem[]): void {
  try {
    store()?.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    // Quota or private mode. The launch is unaffected — that is the invariant.
  }
}

/**
 * Queue a birth. SYNCHRONOUS AND INFALLIBLE BY CONTRACT.
 *
 * Does not await, does not throw, does not return a promise. Call it on the success path
 * of a launch and carry on; delivery is `flushBirthQueue`'s problem. If this ever grows
 * an `await`, the "never blocks a launch" guarantee is gone.
 *
 * Idempotent per (chain, ca): a page that re-renders, or a user who reloads after a
 * confirmed launch, must not enqueue the same birth twice. Retries are free island-side,
 * but a duplicate local row would show an operator two things to worry about where there
 * is one.
 */
export function enqueueBirth(body: BirthNotifyBody): BirthQueueItem {
  const existing = readBirthQueue();
  const already = existing.find((i) => i.body.chain === body.chain && i.body.ca === body.ca);
  if (already) return already;

  const item: BirthQueueItem = {
    id: newId(),
    body,
    status: 'pending',
    attempts: 0,
    queuedAt: Date.now(),
    lastAttemptAt: null,
    lastError: null,
    enrollmentId: null,
  };
  writeQueue([item, ...existing]);
  return item;
}

/** Update one item in place. */
function patch(id: string, fields: Partial<BirthQueueItem>): void {
  writeQueue(readBirthQueue().map((i) => (i.id === id ? { ...i, ...fields } : i)));
}

/** Drop an item. Ops-only — a delivered birth is kept as evidence, not swept. */
export function removeBirth(id: string): void {
  writeQueue(readBirthQueue().filter((i) => i.id !== id));
}

export function clearBirthQueue(): void {
  try {
    store()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Deliver one queued birth through our signing relay. */
async function deliver(item: BirthQueueItem, fetchImpl: typeof fetch): Promise<void> {
  patch(item.id, { attempts: item.attempts + 1, lastAttemptAt: Date.now() });

  let res: Response;
  try {
    res = await fetchImpl('/api/aggregator?resource=births', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(item.body),
    });
  } catch {
    patch(item.id, { lastError: 'The relay is unreachable. Still queued; it will retry.' });
    return;
  }

  let payload: { status?: string; enrollment_id?: number | null; error?: string; retryable?: boolean } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    /* an unparseable body is handled by the status checks below */
  }

  if (res.ok) {
    // 200 enrolled and 200 already_enrolled are both delivered. "Retries are free,
    // forever. The same birth always answers 200 already_enrolled with the original
    // enrollment_id." So a replay is a SUCCESS and must clear, not re-queue.
    patch(item.id, { status: 'delivered', lastError: null, enrollmentId: payload.enrollment_id ?? null });
    return;
  }

  // 422 = the island named something wrong with this body, or our signature failed.
  // Neither is fixed by trying again, so it is parked as `rejected` and left on the ops
  // surface for a human. Grinding a permanent failure would burn a rate limit shared with
  // every other call we make to them.
  if (res.status === 422) {
    patch(item.id, { status: 'rejected', lastError: payload.error ?? 'The island rejected this birth.' });
    return;
  }

  patch(item.id, { lastError: payload.error ?? `The relay answered ${res.status}. Still queued; it will retry.` });
}

/**
 * Attempt delivery of every pending birth, oldest first.
 *
 * Never throws and never rejects — callers fire it and forget it. Returns how many are
 * still pending afterwards, for the ops surface.
 *
 * The island's `/api/*` carries 100 requests per minute TOTAL, shared with every other
 * call we make there, so this walks the queue SERIALLY with a small gap rather than
 * firing a burst. A backlog draining slowly is fine; a backlog that trips a shared rate
 * limit takes the Heat oracle down with it.
 */
export async function flushBirthQueue(
  opts: { fetchImpl?: typeof fetch; gapMs?: number; max?: number } = {},
): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const gapMs = opts.gapMs ?? 1200;
  const pending = readBirthQueue().filter((i) => i.status === 'pending');
  const batch = [...pending].reverse().slice(0, opts.max ?? 10);

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    if (!item) continue;
    try {
      await deliver(item, fetchImpl);
    } catch {
      // deliver() already records its own failures; this is the belt for anything it
      // could not foresee. A throw here must never escape into a launch's success path.
    }
    if (i < batch.length - 1 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
  }

  return readBirthQueue().filter((x) => x.status === 'pending').length;
}

/** Counts for the ops surface. */
export function birthQueueSummary(): { pending: number; delivered: number; rejected: number } {
  const q = readBirthQueue();
  return {
    pending: q.filter((i) => i.status === 'pending').length,
    delivered: q.filter((i) => i.status === 'delivered').length,
    rejected: q.filter((i) => i.status === 'rejected').length,
  };
}
