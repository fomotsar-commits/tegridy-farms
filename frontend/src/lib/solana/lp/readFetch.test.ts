// @vitest-environment node
//
// Every LP read ends. A proxy that never answers used to leave "Reading..." on the card
// for good; `lpFetch` gives a request READ_TIMEOUT_MS and then throws a sentence the card
// can print. Fake timers throughout: the 20 seconds are advanced, never waited for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lpFetch, OPTIONAL_READ_FLOOR, READ_TIMEOUT_MS, timeoutDetail } from './readFetch';

/** A fetch that only ever settles when its signal aborts, as a real fetch does on abort. */
function neverAnswers(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return;
      if (s.aborted) reject(s.reason);
      else s.addEventListener('abort', () => reject(s.reason), { once: true });
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('lpFetch: every read ends', () => {
  it('a fetch that never settles throws "the chain did not answer in 20 seconds" at 20 s, and not a moment before', async () => {
    const under = neverAnswers();
    vi.stubGlobal('fetch', under);
    const onResponse = vi.fn();
    let settled: string | null = null;
    const p = lpFetch({ what: 'the chain', onResponse })('/api/solrpc', { method: 'POST', body: '{}' }).then(
      () => {
        settled = 'answered';
      },
      (e: unknown) => {
        settled = e instanceof Error ? e.message : String(e);
      },
    );
    // The underlying fetch was handed a signal: without one nothing could ever end it.
    const init = (under as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method).toBe('POST');
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('the chain did not answer in 20 seconds');
    await p;
    // A read that never arrived is not a response: the budget hears nothing.
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('a fetch that answers at 19.9 s passes, with its own Response, and leaves no timer behind', async () => {
    const res = new Response('{"jsonrpc":"2.0","id":1,"result":null}', { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            setTimeout(() => resolve(res), READ_TIMEOUT_MS - 100);
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          }),
      ),
    );
    const p = lpFetch({ what: 'the pool index' })('/api/pools?mint=x');
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 100);
    expect(await p).toBe(res);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('headers, then a body that never ends: the same 20 seconds and the same sentence', async () => {
    // A phone losing signal mid-answer: fetch() has resolved, and the body never closes.
    const res = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    const onResponse = vi.fn();
    let settled: string | null = null;
    const p = lpFetch({ what: 'the chain', onResponse })('/api/solrpc').then(
      () => {
        settled = 'answered';
      },
      (e: unknown) => {
        settled = e instanceof Error ? e.message : String(e);
      },
    );
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    // The headers did arrive, so the budget heard them.
    expect(onResponse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('the chain did not answer in 20 seconds');
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a body that finishes at 19.9 s passes, and the caller reads it whole', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"ok":'));
        setTimeout(() => {
          c.enqueue(new TextEncoder().encode('true}'));
          c.close();
        }, READ_TIMEOUT_MS - 100);
      },
    });
    const res = new Response(body, { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    let got: Response | null = null;
    const p = lpFetch({ what: 'the chain' })('/api/solrpc').then((r) => {
      got = r;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 101);
    // Not handed back on its headers alone.
    expect(got).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(got).toBe(res);
    expect(await res.json()).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onResponse is called once, with the Response the caller gets, before its body is read', async () => {
    const res = new Response('{"ok":true}', { status: 200, headers: { 'X-RateLimit-Remaining': '123' } });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    const onResponse = vi.fn((r: Response) => ({ bodyUsed: r.bodyUsed, remaining: r.headers.get('X-RateLimit-Remaining') }));
    const got = await lpFetch({ what: 'Jupiter', onResponse })('/api/jupiter/swap/v1/quote');
    expect(got).toBe(res);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(res);
    expect(onResponse.mock.results[0]?.value).toEqual({ bodyUsed: false, remaining: '123' });
    // The caller can still read the body: the wrapper did not consume it.
    expect(await got.json()).toEqual({ ok: true });
  });

  it('the caller’s own signal still cancels, with the caller’s reason, not the timeout sentence', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const ctrl = new AbortController();
    const p = lpFetch({ what: 'the chain' })('/api/solrpc', { signal: ctrl.signal }).catch((e: unknown) => e);
    ctrl.abort(new Error('left the page'));
    const e = await p;
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('left the page');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('every other error passes through untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(lpFetch({ what: 'the chain' })('/api/solrpc')).rejects.toThrow('Failed to fetch');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the figures and the three sentences, verbatim, with no em dash', () => {
    expect(READ_TIMEOUT_MS).toBe(20_000);
    expect(OPTIONAL_READ_FLOOR).toBe(60);
    expect(timeoutDetail('the chain')).toBe('the chain did not answer in 20 seconds');
    expect(timeoutDetail('the pool index')).toBe('the pool index did not answer in 20 seconds');
    expect(timeoutDetail('Jupiter')).toBe('Jupiter did not answer in 20 seconds');
    for (const what of ['the chain', 'the pool index', 'Jupiter'] as const) expect(timeoutDetail(what)).not.toMatch(/—/);
  });
});
