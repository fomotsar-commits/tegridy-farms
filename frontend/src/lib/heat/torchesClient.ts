// Network boundary for Jungle Bay Island's torches, browser side.
//
// Goes through OUR proxy (`/api/aggregator?resource=torches`), never the island
// directly: its routes carry no CORS header for this origin. One call answers both
// surfaces that paint torches: a room's door (its own lit count, next price and last
// torch) and the home's strip (the fire, the flames, the season, the last torch).
// See api/_lib/torches.js.
//
// TWO OUTCOMES. A read, whose parts may each be null (that part was not read), or
// TorchesUnavailableError (nothing was read). There is no path that turns either into
// a zero: a surface shows only the parts that came back.

/**
 * The venue's twelve rooms, each with the island's place for it as /api/torches/places
 * serves it (read 2026-10-23): six by slug and six by chain and address. `key` is the
 * name the island gave each room in answer eighteen §3, which its bungalow pages already
 * answer at memetics.wtf/b/<key>. When the island serves `key` on its places, match on
 * it and drop `place`. A room not listed here, or a place the island did not serve,
 * shows nothing.
 */
export const ISLAND_ROOMS: Readonly<Record<string, { key: string; place: string }>> = {
  toweli: { key: 'toweli', place: 'toweli' },
  bayla: { key: 'bayla', place: 'solana-7hmvkpxmvagxoptaepx4jbzzvhwgldfj6c1y42qxpump' },
  pepe: { key: 'pepe', place: 'ethereum-0x6982508145454ce325ddbe47a25d4ec3d2311933' },
  qr: { key: 'qr', place: 'base-0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf' },
  mfer: { key: 'mfer', place: 'base-0xe3086852a4b125803c815a158249ae468a3254ca' },
  bnkr: { key: 'bnkr', place: 'base-0x22af33fe49fd1fa80c7149773dde5890d3c76f3b' },
  drb: { key: 'drb', place: 'base-0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2' },
  bobo: { key: 'bobo', place: 'bobo' },
  jbm: { key: 'jungle-bay', place: 'jungle-bay' },
  soy: { key: 'soy', place: 'soy' },
  brainlet: { key: 'brainlet', place: 'brainlet' },
  rizz: { key: 'rizz', place: 'rizz' },
};

/** The venue room a served place belongs to, or null for a place not pinned above. */
export function roomOfPlace(place: string): string | null {
  for (const [roomId, pin] of Object.entries(ISLAND_ROOMS)) if (pin.place === place) return roomId;
  return null;
}

export interface Torch {
  /** As the island served it, or null for a torch lit by someone with no name there. */
  name: string | null;
  amount: number;
  litAtMs: number;
}

export interface PlaceTorches {
  place: string;
  label: string | null;
  torches: number;
  openRow: number;
  nextPrice: number;
  slotsPerRow: number;
  last: Torch | null;
}

export interface IslandTorches {
  places: PlaceTorches[] | null;
  /** The island's newest torch: lit in a room, or fed to the fire, as its own page counts it. */
  lastTorch: (Torch & { kind: 'bungalow' | 'fire'; place: string; label: string | null }) | null;
  /** $BAYLA fed to the fire, all time: the island's own served total. */
  fireBurned: number | null;
  season: { number: number; endsAtMs: number } | null;
  flames: number | null;
  /** When this tab read it: the "now" an age or a day count is measured against. */
  readAtMs: number;
}

export class TorchesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TorchesUnavailableError';
  }
}

const CLIENT_TIMEOUT_MS = 6000;
/** The edge keeps the answer a minute; so does this tab. */
const CACHE_TTL_MS = 60_000;
let cache: { data: IslandTorches; storedAt: number } | null = null;

/** Drop the cached read. For tests. */
export function clearTorchesCache(): void {
  cache = null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const timeOf = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function parseTorch(raw: unknown): Torch | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const litAtMs = timeOf(r.lit_at);
  if (litAtMs === null || !isAmount(r.amount)) return null;
  return { name: textOf(r.name), amount: r.amount, litAtMs };
}

function parsePlace(raw: unknown): PlaceTorches | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!textOf(r.place) || !isCount(r.torches) || !isCount(r.open_row) || r.open_row < 1) return null;
  if (!isAmount(r.next_price) || !isCount(r.slots_per_row) || r.slots_per_row < 1) return null;
  return {
    place: r.place as string,
    label: textOf(r.label),
    torches: r.torches,
    openRow: r.open_row,
    nextPrice: r.next_price,
    slotsPerRow: r.slots_per_row,
    last: parseTorch(r.last),
  };
}

function parse(body: Record<string, unknown>): IslandTorches {
  const places = Array.isArray(body.places)
    ? body.places.map(parsePlace).filter((p): p is PlaceTorches => p !== null)
    : null;
  const last = body.last_torch as Record<string, unknown> | null | undefined;
  const lastTorch = last ? parseTorch(last) : null;
  const fire = body.fire as Record<string, unknown> | null | undefined;
  const season = body.season as Record<string, unknown> | null | undefined;
  const endsAtMs = season ? timeOf(season.ends_at) : null;
  return {
    places,
    lastTorch: lastTorch && textOf(last?.place) && (last!.kind === 'bungalow' || last!.kind === 'fire')
      ? { ...lastTorch, kind: last!.kind, place: last!.place as string, label: textOf(last!.label) }
      : null,
    fireBurned: fire && isAmount(fire.burned) ? fire.burned : null,
    season: season && isCount(season.season) && season.season >= 1 && endsAtMs !== null
      ? { number: season.season, endsAtMs }
      : null,
    flames: isCount(body.flames) ? body.flames : null,
    readAtMs: Date.now(),
  };
}

/** Read the island's torches. Throws TorchesUnavailableError when nothing could be read. */
export async function fetchIslandTorches(opts: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<IslandTorches> {
  if (!opts.fresh && cache && Date.now() - cache.storedAt < CACHE_TTL_MS) return cache.data;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort);
  let body: unknown;
  try {
    const res = await fetch('/api/aggregator?resource=torches', {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new TorchesUnavailableError('The island could not be read.');
    body = await res.json();
  } catch (e) {
    throw e instanceof TorchesUnavailableError ? e : new TorchesUnavailableError('The island is unreachable.');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (!body || typeof body !== 'object') throw new TorchesUnavailableError('The island answered something unreadable.');
  const data = parse(body as Record<string, unknown>);
  cache = { data, storedAt: Date.now() };
  return data;
}

/** What a room's door paints: its open row's lit count, the next price, the last torch, the island's page. */
export interface RoomTorchView {
  lit: number;
  of: number;
  nextPrice: number;
  last: Torch | null;
  href: string;
  readAtMs: number;
}

/** A room's torches, or null on any miss: an unpinned room, an unserved place, or a count that does not add up. */
export function roomTorches(data: IslandTorches | null, roomId: string): RoomTorchView | null {
  const pin = ISLAND_ROOMS[roomId];
  const p = pin && data?.places?.find((x) => x.place === pin.place);
  if (!pin || !p) return null;
  // The island lights twelve to a row; the open row is the one still filling.
  const lit = p.torches - (p.openRow - 1) * p.slotsPerRow;
  if (lit < 0 || lit > p.slotsPerRow) return null;
  return { lit, of: p.slotsPerRow, nextPrice: p.nextPrice, last: p.last, href: islandRoomHref(roomId)!, readAtMs: data!.readAtMs };
}

/** The island's own page for a room, where a torch is lit. */
export function islandRoomHref(roomId: string): string | null {
  const pin = ISLAND_ROOMS[roomId];
  return pin ? `https://memetics.wtf/b/${pin.key}` : null;
}

/** 200000 -> "200,000". One locale, so every visitor reads the same figure. */
export function wholeNumber(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}

/** "8 days ago", "3 hours ago", "just now". */
export function ageWords(thenMs: number, nowMs: number): string {
  const mins = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (mins < 1) return 'just now';
  const [n, unit] = mins < 60 ? [mins, 'minute'] : mins < 1440 ? [Math.floor(mins / 60), 'hour'] : [Math.floor(mins / 1440), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

const SEASON_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** "86 days left in season one", whole days as the island counts them; null once the season has ended. */
export function seasonLine(season: { number: number; endsAtMs: number }, nowMs: number): string | null {
  const left = season.endsAtMs - nowMs;
  if (left <= 0) return null;
  const name = SEASON_WORDS[season.number - 1] ?? String(season.number);
  const days = Math.floor(left / 86_400_000);
  return days < 1 ? `The last day of season ${name}` : `${days} day${days === 1 ? '' : 's'} left in season ${name}`;
}
