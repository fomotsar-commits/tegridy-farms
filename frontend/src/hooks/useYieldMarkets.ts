import { useCallback, useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import {
  assembleReadings,
  readPlanA,
  readPlanB,
  type CallResult,
  type RocketGateReads,
} from '../lib/yield/reads';
import { rankByRate, type VenueMetrics, type YieldRanking } from '../lib/yield/metrics';
import { yieldVenues, type YieldVenueKind } from '../lib/yield/venues';

// The comparison table's state machine, reading Ethereum mainnet directly.
//
// FOUR STATES, and the last two are the ones this exists for. A two-state hook
// (loading / data) cannot express "we could not ask" or "we asked and some of it
// did not answer", and both of those render as a table of zeroes — the most
// persuasive wrong answer a yield surface can give, because a 0.00% rate beside
// a 1.0000× peg looks like a considered reading.
//
// `rows` is ALWAYS the full catalogue, in every state including `unavailable`.
// That is deliberate and is the opposite of the indexer hooks' empty-list
// discipline, for a reason specific to this data: the catalogue is static local
// knowledge — who the counterparty is, what the loss mode is — and none of it
// depends on the chain being reachable. Hiding those rows during an RPC outage
// would delete the honest half of the page to protect the unread half. What the
// outage removes is the NUMBERS, and each cell says so on its own behalf.
//
// NO Date.now() ANYWHERE IN THIS FILE, and a test asserts the call count is
// zero. Every age on this page is chain timestamp minus source timestamp, both
// read on-chain. The browser's clock belongs to the visitor: a laptop set a day
// fast would mark every Chainlink feed on the page stale, and one set a day slow
// would mark a genuinely dead feed fresh. Neither failure is the chain's.

export interface YieldMarketsState {
  status: 'loading' | 'ready' | 'partial' | 'unavailable';
  /** Every venue in the catalogue, whether or not anything was read for it. */
  rows: VenueMetrics[];
  /** The block every read on this page came from, or null when unread. */
  block: number | null;
  /** That block's own timestamp in unix seconds. Never the browser's clock. */
  asOf: number | null;
  /** Cells that failed while the clock succeeded, and the total. */
  unreadCells: number;
  totalCells: number;
  /** Plain-language reason. Set in `unavailable`; null when the read succeeded. */
  detail: string | null;
  /** Rocket Pool's live gates, for the deposit plan. Never a source of addresses. */
  rocket: RocketGateReads | null;
  reload: () => void;
}

/** The resting shape before anything has answered. Rows are still the catalogue. */
function pendingRows(reason: string): VenueMetrics[] {
  const cell = { state: 'unavailable', reason } as const;
  return yieldVenues().map((venue) => ({
    venue,
    rate: cell,
    nav: cell,
    market: cell,
    vsNav: cell,
    exit: cell,
    block: null,
    asOf: null,
  }));
}

const LOADING_REASON = 'Ethereum mainnet has not answered yet for this figure.';

export function useYieldMarkets(): YieldMarketsState {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const client = usePublicClient({ chainId: 1 });

  const [state, setState] = useState<Omit<YieldMarketsState, 'reload'>>(() => ({
    status: 'loading',
    rows: pendingRows(LOADING_REASON),
    block: null,
    asOf: null,
    unreadCells: 0,
    totalCells: yieldVenues().length * 5,
    detail: null,
    rocket: null,
  }));

  // A build with no mainnet client cannot read anything, and that is knowable at
  // render time rather than something to discover in an effect — so it is
  // computed here and merged below, which keeps the effect for the one thing
  // effects are for: talking to the chain.
  const noClient: Omit<YieldMarketsState, 'reload'> | null =
    client === undefined
      ? {
          status: 'unavailable',
          rows: pendingRows('No Ethereum mainnet client is configured in this build, so nothing could be read.'),
          block: null,
          asOf: null,
          unreadCells: yieldVenues().length * 5,
          totalCells: yieldVenues().length * 5,
          detail:
            'This build has no Ethereum mainnet client, so no rate, price or depth figure was read. Nothing below ' +
            'is a statement about what these venues pay.',
          rocket: null,
        }
      : null;

  useEffect(() => {
    if (client === undefined) return;

    let cancelled = false;

    (async () => {
      // Inside the async body rather than the effect body: the loading flag
      // belongs to the read's lifecycle, not to mounting, and writing it in the
      // effect body cascades a render inside the commit that scheduled it
      // (the repo's set-state-in-effect rule; useIntegratorFees does the same).
      setState((prev) => ({ ...prev, status: 'loading', detail: null }));
      try {
        // `batchSize: 0` is load-bearing, not tuning. It keeps the whole array in
        // ONE aggregate3 call, which is what makes the two clock legs atomic with
        // the reads they date. Split across requests, the block number could
        // belong to a different block than the figures.
        const resultsA = (await client.multicall({
          contracts: readPlanA() as never,
          allowFailure: true,
          batchSize: 0,
        })) as unknown as CallResult[];
        if (cancelled) return;

        const planB = readPlanB(resultsA);
        let resultsB: CallResult[] | null = null;
        if (planB !== null) {
          resultsB = (await client.multicall({
            contracts: planB.calls as never,
            allowFailure: true,
            batchSize: 0,
          })) as unknown as CallResult[];
          if (cancelled) return;
        }

        const assembled = assembleReadings(resultsA, resultsB, planB);
        setState({
          status: assembled.block === null ? 'unavailable' : assembled.unreadCells > 0 ? 'partial' : 'ready',
          rows: assembled.rows,
          block: assembled.block,
          asOf: assembled.asOf,
          unreadCells: assembled.unreadCells,
          totalCells: assembled.totalCells,
          detail:
            assembled.block === null
              ? 'The block clock could not be read, so nothing on this page can be dated and every figure is shown ' +
                'as unread.'
              : null,
          rocket: assembled.rocket,
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({
          status: 'unavailable',
          rows: pendingRows(`Ethereum mainnet could not be reached, so this figure was not read (${message}).`),
          block: null,
          asOf: null,
          unreadCells: yieldVenues().length * 5,
          totalCells: yieldVenues().length * 5,
          detail:
            'Ethereum mainnet could not be reached from this browser, so no rate, price or depth figure was read. ' +
            'Nothing below is a statement about what these venues pay.',
          rocket: null,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, reloadKey]);

  return { ...(noClient ?? state), reload };
}

/**
 * One panel's slice of the catalogue, plus its ranking.
 *
 * Pure and exported from the hook module so both panels rank through the same
 * code path: a second ranking helper is a second chance for one surface to call
 * something "the best rate" on evidence the other would have refused.
 */
export function marketsForKind(
  rows: readonly VenueMetrics[],
  kind: YieldVenueKind | readonly YieldVenueKind[],
): { rows: VenueMetrics[]; ranking: YieldRanking } {
  const kinds = typeof kind === 'string' ? [kind] : kind;
  const scoped = rows.filter((r) => kinds.includes(r.venue.kind));
  return { rows: scoped, ranking: rankByRate(scoped) };
}
