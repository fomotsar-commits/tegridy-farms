import { useEffect, useState } from 'react';
import { HINT } from '../curve/uiFormat';

/** The stamp moves on this tick; every form it prints changes on a five-second step or slower. */
const TICK_MS = 5_000;
/** From here the figures beside the stamp are old enough to say so in amber. */
const STALE_MS = 120_000;

/** "Read just now" under 5 s; "Read {n} s ago" in steps of five to a minute; "Read {n} min ago" after. Never a negative age. */
function readAtText(elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  if (s < 5) return 'Read just now';
  if (s < 60) return `Read ${s - (s % 5)} s ago`;
  return `Read ${Math.floor(s / 60)} min ago`;
}

/**
 * When the figures beside it were read: `at` is the device's clock (`Date.now()`) at the
 * read, and the age is that clock at the render. The chain's clock is never mixed in. A 44px
 * Read again when a caller gives one; while a read runs it stays focusable and does nothing.
 */
export function ReadAt({ at, onReadAgain, busy = false }: { at: number; onReadAgain?: () => void; busy?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const elapsed = now - at;
  const stale = elapsed >= STALE_MS;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="lp-read-at" data-stale={stale}>
      <span className={stale ? 'text-[12px] text-amber-300/90' : HINT} data-text-role="hint" data-testid="lp-read-at-text">
        {readAtText(elapsed)}
      </span>
      {onReadAgain && (
        <button
          type="button"
          className="btn-secondary min-h-[44px] px-4 text-[13px] aria-disabled:opacity-60"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onReadAgain();
          }}
        >
          Read again
        </button>
      )}
    </div>
  );
}
