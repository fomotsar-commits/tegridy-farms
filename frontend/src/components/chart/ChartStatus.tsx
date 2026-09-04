import type { GeckoCandlesState } from '../../hooks/useGeckoCandles';
import type { IndexedStatus } from '../../hooks/useChartCandles';
import type { CandleSeries } from '../../lib/chart/candles';
import { NETWORK_LABELS, type ChartableMarket } from '../../lib/chart/markets';

// What the chart is, in words, before a single candle is drawn.
//
// A price chart's empty state is the most dangerous surface a venue has: a blank
// plot area with an axis on it reads as "this did not trade", and that is
// exactly the shape an unreachable source produces. So each non-ready state gets
// its own sentence, and NONE of them is ever reached by drawing zero candles —
// in every state but `ready` this banner IS the answer and no chart is rendered.
//
// The `ready` branch is not decoration either. It states the things that bound
// what the candles above mean: how much was read, whether the read was capped,
// what the source declined to say, and how many buckets are gaps. A chart that
// shows its coverage cannot be mistaken for a chart that shows everything.
//
// TWO SOURCES, TWO VOCABULARIES. GeckoTerminal answers with pre-aggregated
// buckets and no trade counts; the F1 indexer answers with individual swaps it
// sequenced itself. They fail differently, they are bounded differently, and
// every line below names which one it is talking about. `source` picks the
// branch; it defaults to 'indexer' so the older call sites read unchanged.

interface IndexedChartStatusProps {
  source?: 'indexer';
  status: IndexedStatus;
  detail: string | null;
  series: CandleSeries | null;
  swapsRead: number;
  unpriceable: number;
  truncated: boolean;
  syncedAt: number | null;
  onRetry: () => void;
}

interface GeckoChartStatusProps {
  source: 'gecko';
  state: GeckoCandlesState;
  /** The pool the state describes. Only ever a registry market. */
  market: ChartableMarket;
  /** e.g. "1H" — named in the off-grid sentence, which is about this frame. */
  timeframeLabel: string;
}

export type ChartStatusProps = IndexedChartStatusProps | GeckoChartStatusProps;

const TITLES: Record<IndexedStatus, string> = {
  // `idle` here means "nothing was asked", and the caller must say why in
  // `detail`. "No pool selected" was the old wording and it was wrong in the
  // state this build ships in: no pool is selected BECAUSE the pool list could
  // not be read, and a title that blames the reader hides that.
  idle: 'No pool to chart',
  loading: 'Reading indexed swaps…',
  ready: 'Candles from indexed swaps',
  backfilling: 'The candle history is incomplete',
  unavailable: 'The candle history is unavailable',
};

const TONES: Record<IndexedStatus, string> = {
  idle: 'border-white/20 bg-white/[0.03]',
  loading: 'border-white/20 bg-white/[0.03]',
  ready: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  backfilling: 'border-amber-400/40 bg-amber-400/[0.07]',
  unavailable: 'border-amber-400/40 bg-amber-400/[0.07]',
};

const NOT_A_ZERO =
  'Nothing here is a statement about this pool’s price or whether it traded. No chart is drawn because none could be read.';

/**
 * Why `backfilling` draws no candles either, even though rows came back.
 *
 * A backfilling indexer is missing OLD rows, and missing old rows become empty
 * buckets — which this chart draws as gaps, correctly, for a synced indexer. On
 * an unsynced one that same gap means "not indexed yet", and the two are
 * indistinguishable on the canvas. Drawing it would make the chart's most
 * carefully honest feature into its most convincing lie, so the rows are
 * summarised in words and the plot is withheld until the sync completes.
 */
const BACKFILL_NO_CHART =
  'No candles are drawn while the indexer is catching up: an un-indexed stretch of history and a stretch where nothing traded would both appear as a gap, and this chart is not willing to guess which one you are looking at.';

const RETRY_CLASS =
  'min-h-[44px] rounded-md border border-white/25 px-3 py-1 text-xs font-medium text-white hover:bg-white/10';

export function ChartStatus(props: ChartStatusProps) {
  if (props.source === 'gecko') return <GeckoStatus {...props} />;
  return <IndexedStatusBanner {...props} />;
}

function IndexedStatusBanner({
  status,
  detail,
  series,
  swapsRead,
  unpriceable,
  truncated,
  syncedAt,
  onRetry,
}: IndexedChartStatusProps) {
  const showRetry = status === 'unavailable' || status === 'backfilling';

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[status]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{TITLES[status]}</h2>
        {showRetry ? (
          <button type="button" onClick={onRetry} className={RETRY_CLASS}>
            Try again
          </button>
        ) : null}
      </div>

      {detail ? <p className="mt-1.5 text-xs leading-relaxed text-white/80">{detail}</p> : null}

      {status === 'unavailable' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/70">{NOT_A_ZERO}</p>
      ) : null}

      {status === 'backfilling' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/70">{BACKFILL_NO_CHART}</p>
      ) : null}

      {status === 'ready' || status === 'backfilling' ? (
        <Coverage
          series={series}
          swapsRead={swapsRead}
          unpriceable={unpriceable}
          truncated={truncated}
          syncedAt={syncedAt}
        />
      ) : null}
    </div>
  );
}

function Coverage({
  series,
  swapsRead,
  unpriceable,
  truncated,
  syncedAt,
}: {
  series: CandleSeries | null;
  swapsRead: number;
  unpriceable: number;
  truncated: boolean;
  syncedAt: number | null;
}) {
  if (!series) return null;
  const lines: string[] = [];

  lines.push(`${swapsRead} indexed swap${swapsRead === 1 ? '' : 's'} read for this pool.`);

  if (truncated) {
    lines.push(
      'Older swaps exist behind this page. The left edge of the chart is where the read stopped, not where the pool started trading.',
    );
  }
  if (series.droppedOldestBucket) {
    lines.push(
      'The oldest bucket was cut by that page boundary and has been removed — drawing it would have given it an open nobody measured.',
    );
  }
  if (unpriceable > 0) {
    lines.push(
      `${unpriceable} row${unpriceable === 1 ? '' : 's'} could not be priced (a missing or zero leg) and ${unpriceable === 1 ? 'is' : 'are'} not in any candle.`,
    );
  }
  if (series.rejected > 0) {
    lines.push(`${series.rejected} priced row${series.rejected === 1 ? '' : 's'} failed the candle builder's own sanity check and were dropped.`);
  }
  if (series.unsequenced > 0) {
    // Reached only if the indexer stops writing a readable log position. Said
    // out loud because the damage is invisible otherwise: the candles still draw,
    // and only their direction is untrustworthy.
    lines.push(
      `${series.unsequenced} row${series.unsequenced === 1 ? '' : 's'} carried no readable position within ${series.unsequenced === 1 ? 'its' : 'their'} block. Where two of those traded in the same block, which price opened the bucket and which closed it could not be established.`,
    );
  }
  if (series.emptyBuckets > 0) {
    lines.push(
      `${series.emptyBuckets} bucket${series.emptyBuckets === 1 ? '' : 's'} had no trade at all. They are drawn as gaps — no price is invented across them.`,
    );
  }
  if (syncedAt !== null) {
    // Seconds kept here: an indexer head is a block time and the second is real.
    lines.push(`The indexer had reached ${new Date(syncedAt * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC.`);
  }

  return <CoverageList lines={lines} />;
}

function CoverageList({ lines }: { lines: string[] }) {
  return (
    <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-white/75">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function utcStamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

const GECKO_TITLES: Record<GeckoCandlesState['status'], string> = {
  idle: 'No pool to chart',
  loading: 'Reading GeckoTerminal…',
  ready: 'Candles from GeckoTerminal',
  unavailable: 'The candle history is unavailable',
};

const GECKO_TONES: Record<GeckoCandlesState['status'], string> = {
  idle: 'border-white/20 bg-white/[0.03]',
  loading: 'border-white/20 bg-white/[0.03]',
  ready: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  unavailable: 'border-amber-400/40 bg-amber-400/[0.07]',
};

/**
 * The refusal, in the source's own terms.
 *
 * Each sentence says WHO refused and WHAT that does and does not imply. The two
 * that matter most are 404 — which is a statement about GeckoTerminal's index,
 * never about whether a pool exists on-chain — and 429, which is a refused read
 * and therefore not a reading of anything.
 */
function geckoReasonSentence(
  state: GeckoCandlesState,
  market: ChartableMarket,
  timeframeLabel: string,
): string {
  switch (state.reason) {
    case 'network':
      return 'GeckoTerminal did not answer, so no candles were read.';
    case 'rate-limited':
      return 'GeckoTerminal refused this read (HTTP 429). Its published keyless limit is about thirty reads a minute, shared by every open island page. Nothing is drawn from a refused read; wait a moment and try again.';
    case 'not-found':
      return `GeckoTerminal has no pool at this address on ${NETWORK_LABELS[market.network]} (HTTP 404). That says this source has not indexed it — not that the pool does not exist on-chain.`;
    case 'http':
      return `GeckoTerminal answered HTTP ${state.httpStatus ?? '(no status)'}, so nothing was read.`;
    case 'off-schema':
      return 'GeckoTerminal answered in a shape this page does not recognise, so the answer was refused rather than charted.';
    case 'off-grid':
      return `GeckoTerminal returned buckets that do not sit on a ${timeframeLabel} grid, so nothing was drawn — a bent time axis is a chart that lies about when.`;
    default:
      return 'No candles were read.';
  }
}

function GeckoStatus({ state, market, timeframeLabel }: GeckoChartStatusProps) {
  const { status, series } = state;
  const pair = `${state.baseSymbol ?? market.label} / ${state.quoteSymbol ?? 'quote token (unnamed upstream)'}`;

  const lines: string[] = [];
  if (status === 'ready' && series) {
    lines.push(
      `${series.candleCount} bucket${series.candleCount === 1 ? '' : 's'} read from GeckoTerminal for ${pair} on ${NETWORK_LABELS[market.network]}.`,
    );
    if (series.newestStartSec !== null) {
      lines.push(
        `Newest bucket opened ${utcStamp(series.newestStartSec)} UTC — the source's own newest bucket, not this page's clock.`,
      );
    }
    // UNCONDITIONAL for any series that has a newest bucket. Whether that bucket
    // is still filling depends on the source's clock, which this page cannot see
    // and will not guess at by comparing against its own — so "may" is said every
    // time rather than only when some heuristic thinks it applies. (The one
    // exclusion is a read that returned nothing: there is no newest bucket to
    // describe, and the empty-window sentence above is the whole answer.)
    if (series.candleCount > 0) {
      lines.push(
        'The newest bucket may still be open at the source: its close is the last trade GeckoTerminal had recorded when this page read it, not a closed candle.',
      );
    }
    if (series.emptyBuckets > 0) {
      lines.push(
        `${series.emptyBuckets} bucket${series.emptyBuckets === 1 ? '' : 's'} were not returned by the source. They are drawn as gaps — no price is invented across them.`,
      );
    }
    if (series.zeroVolumeBars > 0) {
      lines.push(
        `${series.zeroVolumeBars} bucket${series.zeroVolumeBars === 1 ? '' : 's'} came back with a price but zero reported volume; GeckoTerminal did not say whether a trade sat behind them, so they are drawn as candles and counted here.`,
      );
    }
    if (series.capped) {
      lines.push(
        `This read was capped at ${state.limit} buckets; older buckets may exist behind the left edge and were not read.`,
      );
    }
    if (series.duplicates > 0) {
      lines.push(
        `${series.duplicates} duplicate timestamp${series.duplicates === 1 ? '' : 's'} were returned; the later bar was kept.`,
      );
    }
    if (series.rejected > 0) {
      lines.push(
        `${series.rejected} bar${series.rejected === 1 ? '' : 's'} failed this page's own sanity check and were dropped.`,
      );
    }
    lines.push('Trade counts are not reported by this source and are not shown.');
  }

  return (
    <div className={`rounded-xl border px-4 py-3 ${GECKO_TONES[status]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{GECKO_TITLES[status]}</h2>
        {status === 'unavailable' ? (
          <button type="button" onClick={state.reload} className={RETRY_CLASS}>
            Try again
          </button>
        ) : null}
      </div>

      {status === 'unavailable' ? (
        <>
          <p className="mt-1.5 text-xs leading-relaxed text-white/80">
            {geckoReasonSentence(state, market, timeframeLabel)}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-white/70">{NOT_A_ZERO}</p>
        </>
      ) : null}

      {status === 'idle' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/80">
          No pool is selected, so nothing was asked of GeckoTerminal.
        </p>
      ) : null}

      {/* READY BUT EMPTY is its own screen. CandleChart's own fallback says "no
          priceable swap landed in this window", which is the indexed path's
          vocabulary and would be a claim this page has not measured — nothing is
          priced here, buckets are read. So no plot mounts and this sentence
          stands in its place. */}
      {status === 'ready' && series && series.candleCount === 0 ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/80">
          GeckoTerminal returned no bucket for this window. This is the window being empty at the
          source, not the price being zero.
        </p>
      ) : null}

      {lines.length > 0 ? <CoverageList lines={lines} /> : null}
    </div>
  );
}

export default ChartStatus;
