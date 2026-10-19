// The home page's all-time volume, as /api/aggregator?resource=venue-volume serves it
// (api/_lib/venueVolume.js). Anything the page cannot trust reads as unread, never as
// zero; an answer the edge cached past its staleAt turns itself behind.

export const VENUE_VOLUME_URL = '/api/aggregator?resource=venue-volume';

export type VenueVolume =
  | { state: 'unread' }
  | { state: 'current' | 'behind'; usd: number; swaps: number; asOf: Date };

export function parseVenueVolume(body: unknown, nowMs: number): VenueVolume {
  const b = body as Record<string, unknown> | null;
  if (!b || (b.state !== 'current' && b.state !== 'behind')) return { state: 'unread' };
  const usd = b.usd;
  const swaps = b.swaps;
  const asOf = Date.parse(String(b.asOf));
  const staleAt = Date.parse(String(b.staleAt));
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return { state: 'unread' };
  if (typeof swaps !== 'number' || !Number.isFinite(swaps) || swaps < 0) return { state: 'unread' };
  if (!Number.isFinite(asOf) || !Number.isFinite(staleAt)) return { state: 'unread' };
  const behind = b.state === 'behind' || nowMs > staleAt;
  return { state: behind ? 'behind' : 'current', usd, swaps, asOf: new Date(asOf) };
}

export async function fetchVenueVolume(fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<VenueVolume> {
  try {
    const r = await fetchImpl(VENUE_VOLUME_URL, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { state: 'unread' };
    return parseVenueVolume(await r.json(), nowMs);
  } catch {
    return { state: 'unread' };
  }
}
