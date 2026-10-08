import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { browserCurveRpc, browserRpc } from '../../lib/launcher/solana/curve/rpc';
import { PROGRAM_ID as LAUNCH_PROGRAM_ID } from '../../lib/launcher/solana/curve/program';
import { readVenue, type VenueStatus } from '../../lib/solana/cpswap/read';
import { aggregatorCandidate, chooseRoute, type RouteCandidate, type RouteDecision } from '../../lib/solana/route';
import { quoteVenuePools, readVenuePools, rememberingFetch, type OwnPoolsState, type VenuePoolCandidate, type VenuePoolsRead } from '../../lib/solana/swap/venuePools';
import { withReadCommitment } from '../solana/curve/confirmedRpc';

/**
 * Where a Solana swap goes. One hook, so the line that says it (`SolanaRouteLine`) and
 * the page that sends the trade read ONE decision. The venue read is cached in module
 * scope. Our pools are read once per pair, at 'confirmed', and quoted locally for each
 * amount; a read older than `POOLS_FRESH_MS`, or one that failed, is made again on the
 * next amount, and `refresh` reads at once (the page calls it when Buy is pressed).
 */

let venueCache: Promise<VenueStatus> | null = null;
function venueStatusOnce(): Promise<VenueStatus> {
  venueCache ??= readVenue(browserCurveRpc())
    .catch((): VenueStatus => ({ kind: 'unreadable', detail: 'the RPC proxy did not answer' }))
    .then((v) => {
      // A read that failed once is not the session's truth: the next mount asks again.
      if (v.kind === 'unreadable') venueCache = null;
      return v;
    });
  return venueCache;
}

/** How long a read of our pools is quoted from before the next amount reads again. */
export const POOLS_FRESH_MS = 15_000;
/**
 * How long this tab keeps the pool index's LIST of a token's pools. The pools on it are
 * read from the chain on every read above; only which pools exist is remembered.
 */
export const POOL_LIST_FRESH_MS = 5 * 60_000;
const poolListFetch = rememberingFetch(POOL_LIST_FRESH_MS);

function readPools(programId: string, inputMint: string, outputMint: string): Promise<VenuePoolsRead> {
  return readVenuePools(withReadCommitment(browserRpc(), 'confirmed'), inputMint, outputMint, {
    programId: new PublicKey(programId),
    launchProgramId: LAUNCH_PROGRAM_ID,
    fetchImpl: poolListFetch,
  }).catch((e: unknown): VenuePoolsRead => ({ kind: 'unread', detail: e instanceof Error ? e.message : String(e) }));
}

export interface SolanaRouteInput {
  inputMint: string;
  outputMint: string;
  /** Raw input base units. Zero or null means "no quote yet". */
  amountInRaw: bigint | null;
  /** The aggregator's quote, as returned. Null while loading or on failure. */
  aggregatorQuote: { outAmount: string; priceImpactPct?: string } | null;
  /**
   * The aggregator's answer for THIS amount is still on its way. There is no decision
   * until it lands: the quote in hand is for another amount. Our pools are read meanwhile.
   */
  aggregatorPending?: boolean;
  /** Bumped by the page's "Try again": a pools read that failed is made again with it. */
  retry?: number;
  aggregatorLabel?: string;
}

export interface SolanaRoute {
  /** Null until the venue has been read once. */
  venue: VenueStatus | null;
  /** What became of our own pools for this pair and amount. `pending`: the read is in flight. */
  own: 'pending' | OwnPoolsState;
  /** Our pools that quoted this amount. */
  candidates: VenuePoolCandidate[];
  /** The decision for this pair, amount and aggregator quote; null before there is one. */
  decision: RouteDecision | null;
  aggregatorLabel: string;
  /** Read our pools again now and quote `amountIn` of the pay token. Never throws. */
  /** An amount is typed and the aggregator has not answered for it yet: no decision, and one on its way. */
  asking: boolean;
  refresh(amountIn: bigint): Promise<VenuePoolCandidate[]>;
  /** Drop the read in hand (a trade just changed the pool): the next amount reads again. */
  forget(): void;
}

export function useSolanaRoute({ inputMint, outputMint, amountInRaw, aggregatorQuote, aggregatorPending = false, retry = 0, aggregatorLabel = 'Jupiter' }: SolanaRouteInput): SolanaRoute {
  const [venue, setVenue] = useState<VenueStatus | null>(null);
  // The pools read is the only asynchronous input, and it is KEYED by the pair, so an
  // answer for a previous pair is discarded by derivation. A pair's pools are the same
  // whichever of the two is paid in.
  const [pools, setPools] = useState<{ key: string; read: VenuePoolsRead; at: number } | null>(null);
  const pairKey = [inputMint, outputMint].sort().join('|');
  const hasAmount = amountInRaw !== null && amountInRaw > 0n;
  const programId = venue?.kind === 'live' ? venue.programId : null;

  useEffect(() => {
    let cancelled = false;
    venueStatusOnce().then((v) => {
      if (!cancelled) setVenue(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The newest read and the pair on screen, for the read below and for an answer that
  // lands late: neither makes it run again.
  const held = useRef(pools);
  const onScreen = useRef(pairKey);
  const inFlight = useRef<string | null>(null);
  useEffect(() => {
    held.current = pools;
    onScreen.current = pairKey;
  }, [pools, pairKey]);

  // One read per pair, once there is an amount. An amount typed over a fresh read
  // quotes from it; over a stale one, or one that failed, it reads again. A keystroke
  // never restarts a read that is in flight, and an answer for a pair no longer on
  // screen is dropped.
  useEffect(() => {
    if (!programId || !hasAmount) return;
    const h = held.current;
    if (h && h.key === pairKey && h.read.kind !== 'unread' && Date.now() - h.at < POOLS_FRESH_MS) return;
    if (inFlight.current === pairKey) return;
    inFlight.current = pairKey;
    void readPools(programId, inputMint, outputMint).then((read) => {
      if (inFlight.current === pairKey) inFlight.current = null;
      if (onScreen.current === pairKey) setPools({ key: pairKey, read, at: Date.now() });
    });
    // inputMint and outputMint are read through pairKey: a flip is the same pools.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId, pairKey, hasAmount, amountInRaw, retry]);

  const read = pools && pools.key === pairKey ? pools.read : null;
  const quoted = useMemo(
    () => (read && hasAmount ? quoteVenuePools(read, inputMint, amountInRaw) : null),
    [read, hasAmount, inputMint, amountInRaw],
  );

  // A venue that is provably not deployed has no pools ('absent'); an UNREADABLE venue
  // proves nothing and is 'error', never 'absent'.
  const own: SolanaRoute['own'] =
    venue?.kind === 'live' ? (quoted?.state ?? 'pending') : venue?.kind === 'unreadable' ? 'error' : 'absent';
  const candidates = useMemo(() => (venue?.kind === 'live' ? (quoted?.candidates ?? []) : []), [venue, quoted]);

  const decision: RouteDecision | null = useMemo(() => {
    if (!venue || !hasAmount || aggregatorPending) return null;
    const agg = aggregatorCandidate(aggregatorQuote, aggregatorLabel);
    const all = [...candidates, agg].filter((c): c is RouteCandidate => c !== null);
    return all.length ? chooseRoute(all) : null;
  }, [venue, hasAmount, aggregatorPending, aggregatorQuote, aggregatorLabel, candidates]);

  const refresh = useCallback(
    async (amountIn: bigint): Promise<VenuePoolCandidate[]> => {
      const v = await venueStatusOnce();
      if (v.kind !== 'live') return [];
      const fresh = await readPools(v.programId, inputMint, outputMint);
      if (onScreen.current === pairKey) setPools({ key: pairKey, read: fresh, at: Date.now() });
      return quoteVenuePools(fresh, inputMint, amountIn).candidates;
    },
    [inputMint, outputMint, pairKey],
  );
  const forget = useCallback(() => setPools(null), []);

  return { venue, own, candidates, decision, aggregatorLabel, asking: hasAmount && aggregatorPending, refresh, forget };
}
