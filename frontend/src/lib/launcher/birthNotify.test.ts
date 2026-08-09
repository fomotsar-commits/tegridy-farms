// "The notify NEVER blocks a launch and NEVER fails silently."
//
// Both halves are tested here, because each is easy to satisfy alone and the pair is
// what the directive actually asks for.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueueBirth,
  flushBirthQueue,
  readBirthQueue,
  clearBirthQueue,
  removeBirth,
  birthQueueSummary,
  type BirthNotifyBody,
} from './birthNotify';

const BODY: BirthNotifyBody = {
  ca: '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca',
  chain: 'base',
  creator: '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a',
  birth_block: 21_500_000,
  gate_decision_id: 'gd_row_1',
  record_url: 'https://memetic.fun/record/base/0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca.json',
};

const other = (ca: string): BirthNotifyBody => ({ ...BODY, ca, record_url: `https://memetic.fun/record/base/${ca}.json` });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status: number, body: unknown = {}) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  clearBirthQueue();
});

describe('never blocks a launch', () => {
  it('enqueue is synchronous and returns an item, not a promise', () => {
    const item = enqueueBirth(BODY);
    expect(item).not.toBeInstanceOf(Promise);
    expect(item.status).toBe('pending');
    expect(readBirthQueue()).toHaveLength(1);
  });

  it('enqueue does not throw when storage is dead — the launch already happened', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => enqueueBirth(BODY)).not.toThrow();
    spy.mockRestore();
  });

  it('is idempotent per (chain, ca) — a reload must not double-queue one birth', () => {
    const a = enqueueBirth(BODY);
    const b = enqueueBirth(BODY);
    expect(b.id).toBe(a.id);
    expect(readBirthQueue()).toHaveLength(1);
  });

  it('a DIFFERENT token is a different birth', () => {
    enqueueBirth(BODY);
    enqueueBirth(other('0x1111111111111111111111111111111111111111'));
    expect(readBirthQueue()).toHaveLength(2);
  });

  it('flush never rejects, even when every delivery explodes', async () => {
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(flushBirthQueue({ fetchImpl, gapMs: 0 })).resolves.toBe(1);
  });
});

describe('never fails silently', () => {
  it('a failed delivery STAYS queued, with its error and attempt count', async () => {
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await flushBirthQueue({ fetchImpl, gapMs: 0 });

    const [item] = readBirthQueue();
    expect(item.status).toBe('pending');
    expect(item.attempts).toBe(1);
    expect(item.lastError).toMatch(/unreachable/i);
    expect(item.lastAttemptAt).toBeTypeOf('number');
  });

  it('attempts accumulate across flushes, so a stuck birth is visibly stuck', async () => {
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => fail(502, { error: 'socket down', retryable: true })) as unknown as typeof fetch;
    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    expect(readBirthQueue()[0].attempts).toBe(2);
    expect(readBirthQueue()[0].status).toBe('pending');
  });

  it('a 422 parks the birth as REJECTED rather than grinding a permanent failure', async () => {
    // Retrying a body the island named a problem with would burn a rate limit shared
    // with every other call we make to them, forever, and never succeed.
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => fail(422, { error: 'ca is not a valid address', retryable: false })) as unknown as typeof fetch;
    await flushBirthQueue({ fetchImpl, gapMs: 0 });

    const [item] = readBirthQueue();
    expect(item.status).toBe('rejected');
    expect(item.lastError).toMatch(/not a valid address/);

    // …and a later flush leaves it alone.
    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    expect(readBirthQueue()[0].attempts).toBe(1);
  });

  it('the summary is what the ops surface renders', async () => {
    enqueueBirth(BODY);
    enqueueBirth(other('0x2222222222222222222222222222222222222222'));
    expect(birthQueueSummary()).toEqual({ pending: 2, delivered: 0, rejected: 0 });

    const fetchImpl = vi.fn(async () => ok({ status: 'enrolled', enrollment_id: 5 })) as unknown as typeof fetch;
    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    expect(birthQueueSummary()).toEqual({ pending: 0, delivered: 2, rejected: 0 });
  });
});

describe('delivery', () => {
  it('a 200 marks it delivered and keeps the island’s enrollment_id', async () => {
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => ok({ status: 'enrolled', enrollment_id: 42 })) as unknown as typeof fetch;
    await flushBirthQueue({ fetchImpl, gapMs: 0 });

    const [item] = readBirthQueue();
    expect(item.status).toBe('delivered');
    expect(item.enrollmentId).toBe(42);
    expect(item.lastError).toBeNull();
  });

  it('a REPLAY (already_enrolled) is a success, not a retry — retries are free forever', async () => {
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => ok({ status: 'already_enrolled', enrollment_id: 42, replay: true })) as unknown as typeof fetch;
    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    expect(readBirthQueue()[0].status).toBe('delivered');
    expect(readBirthQueue()[0].enrollmentId).toBe(42);
  });

  it('posts the six fields verbatim to the signing relay, and nothing else', async () => {
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => ok({ status: 'enrolled', enrollment_id: 1 })) as unknown as typeof fetch;
    await flushBirthQueue({ fetchImpl, gapMs: 0 });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/aggregator?resource=births');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(BODY);
  });

  it('does NOT re-send an already delivered birth', async () => {
    enqueueBirth(BODY);
    const fetchImpl = vi.fn(async () => ok({ status: 'enrolled', enrollment_id: 1 })) as unknown as typeof fetch;
    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('drains oldest-first, so a backlog clears in the order it was created', async () => {
    enqueueBirth(other('0x1111111111111111111111111111111111111111'));
    enqueueBirth(other('0x2222222222222222222222222222222222222222'));
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string).ca);
      return ok({ status: 'enrolled', enrollment_id: 1 });
    }) as unknown as typeof fetch;

    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    expect(seen).toEqual([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ]);
  });

  it('sends SERIALLY, never as a burst — the island’s /api/* is 100/min shared', async () => {
    for (let i = 1; i <= 3; i++) enqueueBirth(other(`0x${String(i).repeat(40)}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return ok({ status: 'enrolled', enrollment_id: 1 });
    }) as unknown as typeof fetch;

    await flushBirthQueue({ fetchImpl, gapMs: 0 });
    expect(maxInFlight).toBe(1);
  });

  it('honours the batch cap, so one flush cannot empty a huge backlog at once', async () => {
    for (let i = 1; i <= 5; i++) enqueueBirth(other(`0x${String(i).repeat(40)}`));
    const fetchImpl = vi.fn(async () => ok({ status: 'enrolled', enrollment_id: 1 })) as unknown as typeof fetch;
    const stillPending = await flushBirthQueue({ fetchImpl, gapMs: 0, max: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stillPending).toBe(3);
  });
});

describe('ops actions', () => {
  it('an operator can drop a birth from the queue', () => {
    const item = enqueueBirth(BODY);
    removeBirth(item.id);
    expect(readBirthQueue()).toHaveLength(0);
  });

  it('a corrupted queue reads as empty rather than crashing the ops surface', () => {
    localStorage.setItem('tegridy.births.queue.v1', 'not json');
    expect(readBirthQueue()).toEqual([]);
    expect(() => enqueueBirth(BODY)).not.toThrow();
  });
});
