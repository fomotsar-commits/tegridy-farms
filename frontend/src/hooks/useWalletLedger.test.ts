// The read is either a window this venue can describe, or it is nothing.
//
// Four properties, each of which fails in a way that LOOKS like a finished
// report rather than like an error:
//
//   pinned    every page is asked against one block, or a block mined mid-read
//             shifts every row and a transaction slides through the seam.
//   ordered   no head, no read. A ledger with no consistent frame is worse than
//             no ledger, because it renders as one.
//   closed    a 429 on page 5 fails the WHOLE read. Keeping the four pages that
//             worked is a report short by an unknown amount with nothing saying
//             so — the "quietly drops six weeks" failure with a new cause.
//   bounded   the explorer budget is shared with /history and /deployer, and a
//             re-read button with no cooldown is a way for one visitor to lock
//             every explorer-backed surface on the site out for a minute.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const client = { getBlock: vi.fn() };
const clientBox = { current: client as { getBlock: ReturnType<typeof vi.fn> } | undefined };
vi.mock('wagmi', () => ({
  usePublicClient: () => clientBox.current,
}));

import { useWalletLedger, MAX_LEDGER_PAGES, RELOAD_COOLDOWN_SECONDS } from './useWalletLedger';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const HEAD = { number: 21_000_000n, timestamp: 1_760_000_000n };

function row(i: number, timeStamp: number) {
  return {
    hash: `0x${String(i).padStart(64, '0')}`,
    to: `0x${'c'.repeat(40)}`,
    from: WALLET,
    timeStamp: String(timeStamp),
    value: '0',
    functionName: '',
    isError: '0',
  };
}

/** A page of `n` rows, oldest at `oldest` seconds. */
function page(n: number, oldest: number) {
  return Array.from({ length: n }, (_, i) => row(i, oldest + i));
}

function envelope(result: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ status: '1', result })),
  };
}

const EMPTY = {
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify({ status: '0', message: 'No transactions found', result: [] })),
};

beforeEach(() => {
  vi.clearAllMocks();
  clientBox.current = client;
  client.getBlock.mockResolvedValue(HEAD);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('no head, no read', () => {
  it('fails closed and asks the explorer for NOTHING when the chain head is unreadable', async () => {
    client.getBlock.mockRejectedValue(new Error('rpc down'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('failed'));
    expect(result.current.read).toMatchObject({ reason: 'head-unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is idle, not failed, when there is no wallet to read for', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useWalletLedger({ address: null }));
    expect(result.current.read.status).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('every page is read against one pinned block', () => {
  it('sends the head block as endblock on every call, and reads all three lists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(EMPTY);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('ready'));

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(3);
    for (const url of urls) expect(url).toContain(`endblock=${HEAD.number.toString()}`);
    expect(urls.some((u) => u.includes('action=txlist&'))).toBe(true);
    expect(urls.some((u) => u.includes('action=txlistinternal'))).toBe(true);
    expect(urls.some((u) => u.includes('action=tokentx'))).toBe(true);
  });

  it('takes its as-of from the BLOCK, not from the clock in the browser', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(EMPTY));
    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('ready'));
    expect(result.current.read).toMatchObject({
      head: { block: HEAD.number, timestamp: Number(HEAD.timestamp) },
    });
  });
});

describe('a bounded read declares its own boundary', () => {
  it('stops at four full pages and reports the cut it stopped at', async () => {
    const oldest = 1_700_000_000;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (!String(url).includes('action=tokentx')) return Promise.resolve(EMPTY);
      // Four full pages, each older than the last.
      const p = Number(/page=(\d+)/.exec(String(url))?.[1] ?? '1');
      return Promise.resolve(envelope(page(500, oldest + (4 - p) * 100_000)));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('ready'));
    const read = result.current.read;
    if (read.status !== 'ready') throw new Error('unreachable');
    expect(read.pagesRead.tokentx).toBe(MAX_LEDGER_PAGES);
    expect(read.ledger.truncated).toEqual([{ action: 'tokentx', oldestRowAt: oldest }]);
    expect(read.ledger.cut).toBe(oldest);
    // MUTATION GUARD: these rows are deliberately NOT token-transfer shaped, so
    // every one of them fails the tokentx schema. The boundary must still be
    // named — deriving it from the rows that validated (as an earlier draft
    // did) ended the read reporting no cut at all, which is history dropped
    // with nothing on the file saying so.
    expect(read.ledger.unreadRows).toBe(4 * 500);
  });

  it('claims no truncation when a list ends short of the bound', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('action=tokentx') ? envelope(page(3, 1_700_000_000)) : EMPTY),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('ready'));
    const read = result.current.read;
    if (read.status !== 'ready') throw new Error('unreachable');
    expect(read.ledger.truncated).toEqual([]);
    expect(read.ledger.cut).toBeNull();
  });
});

describe('a partial read is never presented as a whole one', () => {
  it('fails the WHOLE read when one page is throttled, keeping nothing', async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(envelope(page(2, 1_700_000_000)));
      return Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('') });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('failed'));
    expect(result.current.read).toMatchObject({ reason: 'proxy-rate-limited' });
    // The invariant that matters: no ledger at all, so nothing downstream can
    // render the rows that did come back as if they were the year.
    expect(result.current.read).not.toHaveProperty('ledger');
  });

  it('fails closed on a keyless proxy rather than reporting an empty wallet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' })),
      }),
    );
    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('failed'));
    expect(result.current.read).toMatchObject({ reason: 'explorer-keyless' });
  });
});

describe('the shared explorer budget is protected', () => {
  it('refuses a second read inside the cooldown, and says how long is left', async () => {
    const fetchMock = vi.fn().mockResolvedValue(EMPTY);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useWalletLedger({ address: WALLET }));
    await waitFor(() => expect(result.current.read.status).toBe('ready'));
    const after = fetchMock.mock.calls.length;

    act(() => result.current.reload());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.length).toBe(after);
    expect(result.current.nextReloadAt).not.toBeNull();
    expect(result.current.cooldownSeconds).toBeGreaterThan(0);
    expect(result.current.cooldownSeconds).toBeLessThanOrEqual(RELOAD_COOLDOWN_SECONDS);
  });
});
