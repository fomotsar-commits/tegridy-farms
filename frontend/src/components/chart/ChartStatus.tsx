import type { IndexedStatus } from '../../hooks/useChartCandles';
import type { CandleSeries } from '../../lib/chart/candles';

// What the chart is, in words, before a single candle is drawn.
//
// A price chart's empty state is the most dangerous surface a venue has: a blank
// plot area with an axis on it reads as "this did not trade", and that is
// exactly the shape an unhosted indexer produces. So each non-ready state gets
// its own sentence, and NONE of them is ever reached by drawing zero candles —
// in every state but `ready` this banner IS the answer and no chart is rendered.
//
// The `ready` branch is not decoration either. It states the four things that
// bound what the candles above mean: how many swaps were read, whether older
// ones exist behind the page, how many rows could not be priced, and how many
// buckets are gaps. A chart that shows its coverage cannot be mistaken for a
// chart that shows everything.

export interface ChartStatusProps {
  status: IndexedStatus;
  detail: string | null;
  series: CandleSeries | null;
  swapsRead: number;
  unpriceable: number;
  truncated: boolean;
  syncedAt: number | null;
  onRetry: () => void;
}

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

export function ChartStatus({
  status,
  detail,
  series,
  swapsRead,
  unpriceable,
  truncated,
  syncedAt,
  onRetry,
}: ChartStatusProps) {
  const showRetry = status === 'unavailable' || status === 'backfilling';

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[status]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{TITLES[status]}</h2>
        {showRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-white/25 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/10"
          >
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
  if (series.emptyBuckets > 0) {
    lines.push(
      `${series.emptyBuckets} bucket${series.emptyBuckets === 1 ? '' : 's'} had no trade at all. They are drawn as gaps — no price is invented across them.`,
    );
  }
  if (syncedAt !== null) {
    lines.push(`The indexer had reached ${new Date(syncedAt * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC.`);
  }

  return (
    <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-white/75">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export default ChartStatus;
