import type { IndexedStatus } from '../../hooks/useCompetitionStandings';

// What a standings read is, before a single competitor is drawn.
//
// The empty state of a leaderboard under a season name is the worst fabricated
// zero this feature can produce: it says nobody entered, about everybody at once,
// and it is exactly what an unhosted indexer looks like. So the four non-ready
// states each get their own sentence and the table is not drawn in any of them.

export interface CompetitionDataNoticeProps {
  status: IndexedStatus;
  detail: string | null;
  syncedAt: number | null;
  onRetry: () => void;
}

const TITLES: Record<IndexedStatus, string> = {
  idle: 'Standings are not being read',
  loading: 'Scoring the season…',
  ready: 'Standings, scored from indexed history',
  backfilling: 'These standings are incomplete',
  unavailable: 'The standings could not be read',
};

const TONES: Record<IndexedStatus, string> = {
  idle: 'border-white/20 bg-white/[0.03]',
  loading: 'border-white/20 bg-white/[0.03]',
  ready: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  backfilling: 'border-amber-400/40 bg-amber-400/[0.07]',
  unavailable: 'border-amber-400/40 bg-amber-400/[0.07]',
};

const NOT_A_ZERO =
  'An unread board is not an empty competition. Nothing here is a statement about who entered, who is ahead, or whether anybody traded at all.';

export function CompetitionDataNotice({
  status,
  detail,
  syncedAt,
  onRetry,
}: CompetitionDataNoticeProps) {
  const showRetry = status === 'unavailable' || status === 'backfilling';

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[status]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">{TITLES[status]}</h3>
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
      {status !== 'ready' ? (
        <p className="mt-1.5 text-xs leading-relaxed text-white/70">{NOT_A_ZERO}</p>
      ) : null}

      {(status === 'ready' || status === 'backfilling') && syncedAt !== null ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">
          Indexer head block timestamp: {new Date(syncedAt * 1000).toISOString()}.
        </p>
      ) : null}
    </div>
  );
}
