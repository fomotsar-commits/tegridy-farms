// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../../lib/solanaPolyfill';
import { lazy, Suspense, useMemo } from 'react';
import { LpInner } from '../solana/lp/SolanaLpSection';
import { browserLpReaders } from '../solana/lp/readers';
import { useVenueStatus } from '../../hooks/useVenueStatus';
import { useSheet } from './sheetContext';

// The swap page's own form, in its sheet mode, as the home's card loads it.
const SolanaSwapInner = lazy(() => import('../../pages/SolanaSwapPage').then((m) => ({ default: m.SolanaSwapInner })));

const READING = (
  <p role="status" className="text-white/70 text-[13px] py-3">
    Reading the pool…
  </p>
);

/**
 * The sheet's form (island answer twenty-five, build 3), hosting the logic that already
 * exists: Add is the LP section's Add with one coin on the room's own pool, Buy is the swap
 * page's form on SOL to the room's coin. Their checks, review and signing are theirs, unchanged.
 */
export default function SheetBody() {
  const sheet = useSheet();
  if (!sheet) return null;
  if (sheet.kind === 'add') return <SheetAdd />;
  return (
    <Suspense fallback={READING}>
      <SolanaSwapInner sheet />
    </Suspense>
  );
}

/** As the home's LP card: the form waits for the venue's read, as on /pools. */
function SheetAdd() {
  const sheet = useSheet()!;
  const readers = useMemo(() => browserLpReaders(), []);
  const { status, retry } = useVenueStatus();
  const { address: mint, venueSolPool: pool } = sheet.room;
  if (!readers || !mint || !pool) return null;
  if (status?.kind === 'live') return <LpInner readers={readers} home={{ mint, pool }} />;
  if (status === null) return READING;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] py-3" data-testid="sheet-lp-unread">
      <p className="text-white/80">{status.kind === 'unreadable' ? 'The pool could not be read just now.' : 'The pool is not open right now.'}</p>
      {status.kind === 'unreadable' && (
        <button type="button" onClick={retry} className="min-h-[44px] underline underline-offset-4" style={{ color: 'var(--color-kyle)' }}>
          Try again
        </button>
      )}
    </div>
  );
}
