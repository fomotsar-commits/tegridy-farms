// The named tape's client half — wave seven, element N.
//
// One request per tape, not one per row. The island's heat oracle is CORS-locked
// so the browser cannot read it directly at all, and even if it could, twelve
// reads from a page would spend the instrument's own rate-limit bucket twelve at
// a time and 429 the next visitor's reading. `?resource=tape` is the door the
// island gave this, and api/_lib/tape.js is the bounded fan-out behind it.
//
// FAILURE LEAVES THE ROW, and that rule lives on BOTH sides of the wire. The
// proxy omits a wallet it could not read; this returns an empty map when the
// whole call fails. Either way a row renders exactly as it did before names
// existed — never a blank where an address was, and never "unnamed", which would
// state a fact about a person out of an outage.

/** What a tape row may know about a buyer. Nothing else crosses the wire. */
export interface TapeName {
  /** Stored BARE, without the leading @, exactly as the instrument stores it. */
  xHandle: string;
  tier: string;
  /** Days held, on the ISLAND's clock (held_since → as_of), never ours. */
  days: number | null;
}

/** Address (as sent) → its name. Absent means "no name to show". */
export type TapeNames = Record<string, TapeName>;

const ENDPOINT = '/api/aggregator?resource=tape';

// The proxy caps at twelve and the tape asks for twelve. Sending more would be
// silently truncated there, so it is truncated here where it can be seen.
const MAX = 12;

// Under the proxy's own 4.5s-per-read budget times a serial worst case. A tape
// that has not answered by now is not going to change the page usefully.
const TIMEOUT_MS = 9000;

/**
 * Days between two island timestamps.
 *
 * Deliberately NOT `Date.now()`. The island reckons held time from `held_since`
 * to the `as_of` of its own reading; dating it against the viewer's clock would
 * give two people looking at the same row different numbers, and would keep
 * ticking while the island's reading stood still.
 */
export function daysBetween(heldSinceUnix: number | null, asOfUnix: number | null): number | null {
  if (typeof heldSinceUnix !== 'number' || typeof asOfUnix !== 'number') return null;
  if (asOfUnix < heldSinceUnix) return null;
  return Math.floor((asOfUnix - heldSinceUnix) / 86_400);
}

/**
 * Name as many of these wallets as the island knows.
 *
 * NEVER throws and never rejects: every failure path resolves to `{}`, because
 * the caller's rows are already on screen and a naming outage is not their
 * problem to render.
 */
export async function fetchTapeNames(
  wallets: readonly (string | null)[],
  opts: { signal?: AbortSignal } = {},
): Promise<TapeNames> {
  const wanted = [...new Set(wallets.filter((w): w is string => !!w && w.length > 0))].slice(0, MAX);
  if (wanted.length === 0) return {};

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${ENDPOINT}&addresses=${encodeURIComponent(wanted.join(','))}`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!resp.ok) return {};
    const body: unknown = await resp.json();
    const raw = (body as { names?: Record<string, unknown> } | null)?.names;
    if (!raw || typeof raw !== 'object') return {};

    const out: TapeNames = {};
    for (const [address, value] of Object.entries(raw)) {
      const v = value as Record<string, unknown> | null;
      const handle = typeof v?.x_handle === 'string' ? v.x_handle.replace(/^@+/, '') : '';
      // A row with no usable handle is not a name. The proxy already refuses
      // these; this refuses them again rather than trusting the wire, because a
      // tier printed beside a stranger's trade without their handle would be
      // standing they never asked to publish.
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue;
      out[address] = {
        xHandle: handle,
        tier: typeof v?.tier === 'string' ? v.tier : '',
        days: daysBetween(
          typeof v?.held_since_unix === 'number' ? v.held_since_unix : null,
          typeof v?.as_of_unix === 'number' ? v.as_of_unix : null,
        ),
      };
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
