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

/**
 * What a tape row may know about a buyer. Nothing else crosses the wire.
 *
 * ANSWER NINE: a row now arrives for an UNNAMED flame too, carrying the cold
 * bit and nothing else. Element P needs to tell a cold planter from an unnamed
 * warm one, and both used to arrive as no row at all. Standing still never
 * travels without a handle: on an unnamed row, tier is empty and days is null
 * because the wire does not carry them.
 */
export interface TapeRow {
  /** Stored BARE, without the leading @. null when the flame is unnamed. */
  xHandle: string | null;
  /** The island has never seen this wallet hold anything. */
  isCold: boolean;
  /** Empty unless the row is named: standing is opt-in at the island's door. */
  tier: string;
  /** Days held, on the ISLAND's clock (held_since → as_of), never ours. */
  days: number | null;
}

/** A row the tape may PAINT. Element N renders these and nothing else. */
export type NamedTapeRow = TapeRow & { xHandle: string };

/**
 * The narrowing every consumer of a row has to pass through before printing a
 * name. Without it, an unnamed row renders as "@null" on the tape, which is
 * the exact class of bug the proxy returning null used to make impossible.
 */
export function isNamed(row: TapeRow | undefined | null): row is NamedTapeRow {
  return !!row && typeof row.xHandle === 'string' && row.xHandle.length > 0;
}

/** @deprecated the shape a named row has; kept so element N reads the same. */
export type TapeName = NamedTapeRow;

/** Address (as sent) → its row. Absent means the read failed or was refused. */
export type TapeNames = Record<string, TapeRow>;

import { daysHeld } from './daysHeld';

const ENDPOINT = '/api/aggregator?resource=tape';

// The proxy caps at twelve and the tape asks for twelve. Sending more would be
// silently truncated there, so it is truncated here where it can be seen.
const MAX = 12;

// Under the proxy's own 4.5s-per-read budget times a serial worst case. A tape
// that has not answered by now is not going to change the page usefully.
const TIMEOUT_MS = 9000;


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
      // A row with no usable handle is not a NAME, and this refuses to treat it
      // as one rather than trusting the wire: a tier printed beside a stranger's
      // trade without their handle would be standing they never asked to
      // publish. It is still a ROW, though (answer nine), carrying the cold bit
      // alone, so element P can tell a cold planter from an unnamed warm one.
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        out[address] = { xHandle: null, isCold: v?.is_cold === true, tier: '', days: null };
        continue;
      }
      out[address] = {
        xHandle: handle,
        isCold: v?.is_cold === true,
        tier: typeof v?.tier === 'string' ? v.tier : '',
        days: daysHeld(
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
