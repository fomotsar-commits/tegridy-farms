// "Your recent activity" — a per-wallet, per-browser record of what this venue
// submitted, so a trade doesn't vanish the moment its toast is dismissed.
//
// localStorage only (kind + pair + human amounts + signature), keyed by wallet
// address so two wallets in one browser never see each other's rows. Amounts
// are stored HUMAN-formatted by the caller, which only formats with known
// decimals (the LimitTab no-guess rule). This is a venue-side convenience
// record, not an indexer: rows are labeled "this venue" and clearing site data
// clears them.

export interface SolActivityEntry {
  sig: string;
  /** Epoch ms at record time. */
  ts: number;
  kind: 'swap' | 'limit-place' | 'limit-cancel' | 'dca-place' | 'dca-cancel';
  summary: string;
}

const MAX_ENTRIES = 25;

function keyFor(wallet: string): string {
  return `sol.activity.${wallet}`;
}

export function recordActivity(wallet: string, entry: SolActivityEntry): void {
  try {
    const rest = getActivity(wallet).filter((e) => e.sig !== entry.sig);
    localStorage.setItem(keyFor(wallet), JSON.stringify([entry, ...rest].slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable — the toast already told the user */
  }
}

export function getActivity(wallet: string): SolActivityEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(wallet));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is SolActivityEntry =>
        !!e &&
        typeof (e as SolActivityEntry).sig === 'string' &&
        typeof (e as SolActivityEntry).ts === 'number' &&
        typeof (e as SolActivityEntry).summary === 'string',
    );
  } catch {
    return [];
  }
}

/** "3m ago" / "2h ago" / "5d ago" — coarse on purpose. */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
