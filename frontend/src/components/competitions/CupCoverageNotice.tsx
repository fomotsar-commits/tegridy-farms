import {
  CUP_NO_ARCHIVE,
  CUP_UNAVAILABLE,
  CUP_WASH_LIMIT,
  cupFailureWord,
  utcMinute,
  type PoolCoverage,
} from '../../lib/competitions/islandCup';
import type { IslandCupStatus } from '../../hooks/useIslandCup';

// WHAT WAS READ, BEFORE ANY RANK IS SHOWN.
//
// Twelve pools, twelve separate answers. A board that summed the ones that
// worked and said nothing about the rest would be presenting a subset as the
// whole, and the reader has no way to tell the difference — a pool that 429'd
// and a pool with no trades produce the same absence on a leaderboard and mean
// opposite things.
//
// So every pool gets a chip: how many fills it gave, or that its page was full
// and where its coverage therefore starts, or that it was not read and why. The
// two limits of the wash rule and the absence of any archive are printed here
// too, next to the numbers they qualify, rather than behind a link.

export interface CupCoverageNoticeProps {
  status: IslandCupStatus;
  coverage: readonly PoolCoverage[];
  poolsTotal: number;
  onReload: () => void;
}

const TONES: Record<IslandCupStatus, string> = {
  idle: 'border-white/20 bg-white/[0.03]',
  loading: 'border-white/20 bg-white/[0.03]',
  complete: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  partial: 'border-amber-400/40 bg-amber-400/[0.07]',
  unavailable: 'border-amber-400/40 bg-amber-400/[0.07]',
};

const CHIP = 'rounded-md border px-2 py-1 text-[11px] leading-tight';

function title(status: IslandCupStatus, answered: number, total: number): string {
  switch (status) {
    case 'complete':
      return "Island Cup, scored from the resident pools' trade feeds";
    case 'partial':
      return `${answered} of ${total} pools answered — totals are floors and the order is provisional`;
    case 'unavailable':
      return CUP_UNAVAILABLE;
    case 'loading':
      return `Reading ${total} pools…`;
    default:
      return `${total} resident pools are on the board. Nothing has been read yet.`;
  }
}

export function CupCoverageNotice({
  status,
  coverage,
  poolsTotal,
  onReload,
}: CupCoverageNoticeProps) {
  const answered = coverage.filter((c) => c.state !== 'failed').length;
  const details = [
    ...new Set(coverage.filter((c) => c.state === 'failed').map((c) => c.detail)),
  ];

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONES[status]}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{title(status, answered, poolsTotal)}</h2>
        <button
          type="button"
          onClick={onReload}
          className="min-h-[44px] rounded-md border border-white/25 px-3 py-1 text-xs font-medium text-white hover:bg-white/10"
        >
          Read again
        </button>
      </div>

      {coverage.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="What each pool answered">
          {coverage.map((c) => {
            if (c.state === 'read') {
              return (
                <li
                  key={`${c.pool.network}:${c.pool.pool}`}
                  className={`${CHIP} border-white/15 text-white/75`}
                >
                  {c.pool.label}: {c.trades} fill{c.trades === 1 ? '' : 's'}
                  {c.dropped > 0 ? ` (${c.dropped} unreadable)` : ''}
                </li>
              );
            }
            if (c.state === 'capped') {
              return (
                <li
                  key={`${c.pool.network}:${c.pool.pool}`}
                  className={`${CHIP} border-amber-300/30 text-amber-100`}
                >
                  {c.pool.label}: page cap reached, covered from {utcMinute(c.coveredFrom)}
                </li>
              );
            }
            return (
              <li
                key={`${c.pool.network}:${c.pool.pool}`}
                className={`${CHIP} border-red-300/30 text-red-100`}
              >
                {c.pool.label}: not read — {cupFailureWord(c.reason)}
              </li>
            );
          })}
        </ul>
      ) : null}

      {details.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-white/65">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2.5 text-[11px] leading-relaxed text-white/70">{CUP_WASH_LIMIT}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-white/70">{CUP_NO_ARCHIVE}</p>
    </div>
  );
}
