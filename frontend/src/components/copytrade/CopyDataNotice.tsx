import type { IndexedStatus } from '../../hooks/useCopyLeaderboard';

// What a copy-trading read is, in words, before a single wallet is drawn.
//
// The empty state on this page is a claim about OTHER PEOPLE — "nobody is
// trading", "this wallet has done nothing", "none of your mirrors filled" — and
// all three are the exact shape an unhosted indexer produces. So each non-ready
// state gets its own sentence and none of them is ever reached by drawing zero
// rows: the caller renders this instead of the table, not around it.
//
// `subject` is what the caller could not read, so the same component can say
// "the follow board" and "your mirror history" without either inheriting the
// other's claim.

export interface CopyDataNoticeProps {
  status: IndexedStatus;
  detail: string | null;
  /** Noun phrase for what was being read, e.g. "the follow board". */
  subject: string;
  /** What an empty result must NOT be read as. Rendered on every dark state. */
  notAZero: string;
  syncedAt?: number | null;
  onRetry?: () => void;
}

const TONES: Record<IndexedStatus, string> = {
  idle: 'border-white/20 bg-white/[0.03]',
  loading: 'border-white/20 bg-white/[0.03]',
  ready: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  backfilling: 'border-amber-400/40 bg-amber-400/[0.07]',
  unavailable: 'border-amber-400/40 bg-amber-400/[0.07]',
};

function title(status: IndexedStatus, subject: string): string {
  switch (status) {
    case 'idle':
      return `${capitalise(subject)} is not being read`;
    case 'loading':
      return `Reading ${subject}…`;
    case 'ready':
      return `${capitalise(subject)}, read from the indexer`;
    case 'backfilling':
      return `${capitalise(subject)} is incomplete`;
    case 'unavailable':
      return `${capitalise(subject)} could not be read`;
  }
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

export function CopyDataNotice({
  status,
  detail,
  subject,
  notAZero,
  syncedAt,
  onRetry,
}: CopyDataNoticeProps) {
  const dark = status !== 'ready';
  const showRetry = onRetry !== undefined && (status === 'unavailable' || status === 'backfilling');

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[status]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">{title(status, subject)}</h3>
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
      {dark ? <p className="mt-1.5 text-xs leading-relaxed text-white/70">{notAZero}</p> : null}

      {status === 'ready' || status === 'backfilling' ? (
        syncedAt !== null && syncedAt !== undefined ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">
            Indexer head block timestamp: {new Date(syncedAt * 1000).toISOString()}.
          </p>
        ) : (
          <p className="mt-1.5 text-[11px] leading-relaxed text-white/60">
            The indexer did not report a head block, so how current this is cannot be stated.
          </p>
        )
      ) : null}
    </div>
  );
}
