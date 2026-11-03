import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { holdSheetOutlet, useSheetOpen, useSheetOutletHead } from '../../lib/sheetStore';
import { SheetContext, type SheetPlace } from './sheetContext';
import { SheetBaylaRow } from './SheetBaylaRow';

// The forms themselves, in the Solana chunk: an outlet is cheap to mount on any Solana section.
const SheetBody = lazy(() => import('./SheetBody'));

/**
 * Draws the open sheet's form, inside the Solana connection it is mounted in, into the sheet's
 * frame (lib/sheetStore.ts). A page's own Solana section mounts one (`page`), so the sheet
 * signs with the page's one connection; the sheet's own connection mounts the other kind,
 * which draws only where no page outlet is mounted.
 */
export function SheetBodyOutlet({ page = true }: { page?: boolean }) {
  const [token] = useState(() => Symbol('sheet-outlet'));
  useEffect(() => (page ? holdSheetOutlet(token) : undefined), [page, token]);
  const head = useSheetOutletHead();
  const open = useSheetOpen();
  const place = useMemo<SheetPlace | null>(() => (open ? { kind: open.kind, room: open.room, bayla: <SheetBaylaRow /> } : null), [open]);
  if (!open || !place) return null;
  if (page ? head !== token : head !== null) return null;
  return createPortal(
    <SheetContext.Provider value={place}>
      <Suspense fallback={<p role="status" className="text-white/70 text-[13px] py-3">Reading the pool…</p>}>
        <SheetBody key={`${place.kind}:${place.room.id}`} />
      </Suspense>
    </SheetContext.Provider>,
    open.slot,
  );
}
