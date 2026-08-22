import { scheduleProgress, type VestingStreamInfo } from '../../hooks/useVestingStreams';

/**
 * Start → cliff → end, drawn to scale, with a marker at now.
 *
 * The bar shows the SCHEDULE, not the balance. A stream whose beneficiary has already
 * released everything vested so far still shows the same schedule position — conflating
 * the two would let a fully-released stream look unvested.
 *
 * Before the cliff the vested share is zero however far into the schedule the clock
 * is, which is why the cliff is drawn as a hard edge rather than a gradient.
 */
export function VestingScheduleBar({ info, now }: { info: VestingStreamInfo; now: number }) {
  const span = Math.max(1, info.end - info.start);
  const cliffPct = Math.min(100, Math.max(0, ((info.cliff - info.start) / span) * 100));
  const nowPct = Math.min(100, Math.max(0, ((now - info.start) / span) * 100));
  const vestedPct = scheduleProgress(info, now) * 100;

  return (
    <div className="mt-3">
      <div
        className="relative h-2 rounded-full bg-white/8 overflow-hidden"
        role="img"
        aria-label={`Vesting schedule: ${vestedPct.toFixed(1)} percent vested by the current time`}
      >
        <div className="absolute inset-y-0 left-0 bg-emerald-400/60" style={{ width: `${vestedPct}%` }} />
        {cliffPct > 0 && cliffPct < 100 && (
          <div className="absolute inset-y-0 w-px bg-amber-300/80" style={{ left: `${cliffPct}%` }} />
        )}
        <div className="absolute inset-y-0 w-px bg-white/70" style={{ left: `${nowPct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-white/40 mt-1">
        <span>{new Date(info.start * 1000).toISOString().slice(0, 10)}</span>
        <span className={info.cliffReached ? 'text-white/40' : 'text-amber-300/80'}>
          cliff {new Date(info.cliff * 1000).toISOString().slice(0, 10)}
          {info.cliffReached ? '' : ' — not reached'}
        </span>
        <span>{new Date(info.end * 1000).toISOString().slice(0, 10)}</span>
      </div>
    </div>
  );
}
