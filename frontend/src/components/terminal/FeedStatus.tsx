import type { IndexedStatus } from '../../hooks/useTerminalFeed';
import type { TerminalFeed } from '../../lib/terminal/feed';

// What the feed is, in words, before any row is drawn.
//
// A discovery feed's empty state is the single most dangerous surface in this
// build: "no new pairs" is a claim about the whole chain, and it is the exact
// shape an unhosted indexer produces. So the four non-ready states each get
// their own sentence, and NONE of them may be reached by rendering zero rows.
// The banner is not decoration around the table — in every state but `ready` it
// is the answer, and the table is not drawn at all.

export interface FeedStatusProps {
  status: IndexedStatus;
  detail: string | null;
  feed: TerminalFeed | null;
  syncedAt: number | null;
  onRetry: () => void;
}

const TITLES: Record<IndexedStatus, string> = {
  idle: 'The feed is not running',
  loading: 'Reading the pair feed…',
  ready: 'Live pair feed',
  backfilling: 'The feed is incomplete',
  unavailable: 'The pair feed is unavailable',
};

const TONES: Record<IndexedStatus, string> = {
  idle: 'border-white/20 bg-white/[0.03]',
  loading: 'border-white/20 bg-white/[0.03]',
  ready: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  backfilling: 'border-amber-400/40 bg-amber-400/[0.07]',
  unavailable: 'border-amber-400/40 bg-amber-400/[0.07]',
};

const NOT_A_ZERO =
  'Nothing on this page is a statement about what is or is not launching right now.';

export function FeedStatus({ status, detail, feed, syncedAt, onRetry }: FeedStatusProps) {
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

      {status === 'unavailable' || status === 'idle' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/70">{NOT_A_ZERO}</p>
      ) : null}

      {status === 'ready' || status === 'backfilling' ? (
        <FeedCoverage feed={feed} syncedAt={syncedAt} />
      ) : null}
    </div>
  );
}

function FeedCoverage({ feed, syncedAt }: { feed: TerminalFeed | null; syncedAt: number | null }) {
  if (!feed) return null;
  const lines: string[] = [];

  lines.push(
    `${feed.rows.length} pair${feed.rows.length === 1 ? '' : 's'} read${feed.hasMorePairs ? ' (more exist past this page)' : ''}.`,
  );
  if (feed.excludedPairs > 0) {
    lines.push(
      `${feed.excludedPairs} pair${feed.excludedPairs === 1 ? '' : 's'} withheld by the indexer's allowlist — they reference no canonical protocol token.`,
    );
  }
  if (feed.eventWindowTruncated) {
    // The whole reason PairActivity has an `unknown` arm. Said out loud here so a
    // reader knows why some rows show no activity figure at all.
    lines.push(
      'The activity window filled before it ran out of events, so activity counts are a floor and some pairs were not reached.',
    );
  }
  lines.push(
    'Pair age is not shown: the indexer has no pair-creation timestamp, so any age here would be invented.',
  );
  if (syncedAt !== null) {
    lines.push(`Indexer head block timestamp: ${new Date(syncedAt * 1000).toISOString()}.`);
  }

  return (
    <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-white/70">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
