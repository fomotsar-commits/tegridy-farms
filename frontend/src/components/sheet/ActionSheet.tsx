import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { getActiveBungalow, type Bungalow } from '../../lib/bungalows';
import { useActiveBungalowId } from '../../hooks/useActiveBungalowId';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { SHEET_WORDS } from '../../lib/arrival';
import { isRoomDoor } from '../../lib/navConfig';
import { deepLinkSheet, readSheet, sheetHref, sheetRoom, withoutSheet, type SheetKind } from '../../lib/sheet';
import { setSheetOpen, useSheetOutletHead } from '../../lib/sheetStore';
import { useReceipt } from '../../lib/receipt';
import { useScreenMove } from '../../lib/screenMove';
import { tick } from '../../lib/tick';
import { CoinName } from '../ui/CoinName';
import { SHEET_WAIT } from './sheetContext';
import { BungalowRow } from './SheetBuyRow';

// The sheet's own Solana connection, for a page with none: its own chunk, as every Solana section is.
const SheetOwnConnection = lazy(() => import('./SheetSolana'));

/**
 * The sheet (island answer twenty-five, screen 1, build 3): Add or Buy as one screen over the
 * page, the room staying behind under the veil. It lives in the address (`?sheet=add|buy`,
 * lib/sheet.ts), so Back closes it and the page is still there. The frame is drawn here, on
 * every page; the form is drawn into it by an outlet inside a Solana connection
 * (lib/sheetStore.ts). Nothing else is on it: the handle, Back, the coin, the form.
 */
export function ActionSheet() {
  const location = useLocation();
  // The room can change under an open sheet (a pick in the bungalow row, another tab).
  useActiveBungalowId();
  const ask = readSheet(location.search);
  if (!ask) return null;
  return <OpenSheet kind={ask.kind} named={ask.coin} />;
}

function OpenSheet({ kind, named }: { kind: SheetKind; named: Bungalow | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  // The coin named in the address, else the room entered last when the sheet can act on it, else the bungalow row.
  const room = named ?? sheetRoom(getActiveBungalow()?.id);
  // Buy's form is drawn with no coin too: its own bungalow row picks one (answer twenty-seven). Add's waits for a room.
  const drawn = room !== null || kind === 'buy';
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const pageOutlet = useSheetOutletHead();
  // The sheet's green button is her move, whatever her line says: her header button goes quiet under it.
  useScreenMove('sheet');
  const pressed = (location.state as { sheet?: boolean } | null)?.sheet === true;
  const close = useCallback(() => {
    // Opened by a press on this page: Back pops back to it. Opened by a link: the page replaces the sheet.
    if (pressed) navigate(-1);
    else navigate(withoutSheet(location.pathname, location.search), { replace: true });
  }, [pressed, navigate, location.pathname, location.search]);

  useEffect(() => {
    if (!drawn || !slot) return;
    setSheetOpen({ kind, room, slot, close });
    return () => setSheetOpen(null);
  }, [drawn, kind, room, slot, close]);

  // A swap or an add that landed in the sheet ends on the receipt card over the room: the sheet goes.
  const { open: receiptUp } = useReceipt();
  useEffect(() => {
    if (receiptUp) close();
  }, [receiptUp, close]);

  const panelRef = useFocusTrap<HTMLDivElement>(true, { focusContainer: true });
  // Escape closes, but not from a dialog over the form (the swap's picker): that one takes its own.
  // The page under the veil does not scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const over = e.target instanceof Element ? e.target.closest('[role="dialog"]') : null;
      if (over && over !== panelRef.current && panelRef.current?.contains(over)) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = was;
    };
  }, [close, panelRef]);

  const pick = (b: Bungalow) => {
    tick();
    navigate(sheetHref(location.pathname, location.search, kind, b.id), { replace: true, state: location.state });
  };
  const label = room ? (kind === 'add' ? SHEET_WORDS.add(room.symbol) : SHEET_WORDS.buy(room.symbol)) : kind === 'add' ? 'Add' : 'Buy';

  return createPortal(
    <div className="fixed inset-0 z-[80]" data-testid="action-sheet-layer">
      {/* The veil, over the whole page and the header too; a press on it is Back. */}
      <div aria-hidden="true" className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} onClick={close} data-testid="sheet-veil" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid="action-sheet"
        data-sheet={kind}
        className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-[480px] flex flex-col outline-none"
        style={{
          maxHeight: 'calc(100dvh - 16px)',
          background: 'var(--color-bg-surface)',
          borderRadius: '20px 20px 0 0',
          borderTop: '1px solid rgba(139,92,246,0.45)',
          boxShadow: '0 -16px 48px rgba(0,0,0,0.55)',
        }}
      >
        <div className="overflow-y-auto overscroll-contain px-4" style={{ paddingBottom: 'max(48px, calc(16px + env(safe-area-inset-bottom, 0px)))' }}>
          <div aria-hidden="true" className="mx-auto mt-2 rounded-full" style={{ width: 36, height: 4, background: 'rgba(255,255,255,0.22)' }} />
          <button
            type="button"
            onClick={() => {
              tick();
              close();
            }}
            className="flex items-center gap-3 min-h-[44px] mt-1.5 text-[14px] font-semibold"
            style={{ color: '#c4b5fd' }}
            data-testid="sheet-back"
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2L2 8l6 6" />
            </svg>
            {isRoomDoor(location.pathname) ? SHEET_WORDS.back : SHEET_WORDS.backOff}
          </button>
          {/* Buy names its coin in the form's own bungalow row, which follows a pick from Any coin (SheetBuyRow). */}
          {kind === 'add' && (room ? <CoinRow room={room} /> : <BungalowRow onPick={pick} />)}
          <div ref={setSlot} data-testid="sheet-body" className={drawn ? `mt-4 ${SHEET_WAIT[kind].slot}` : 'mt-4'} />
          {drawn && pageOutlet === null && (
            <Suspense fallback={null}>
              <SheetOwnConnection />
            </Suspense>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The coin, a 56 px row: its art in a 40 px disc with the venue's green ring, its name as a press that copies its address, its pool. */
function CoinRow({ room }: { room: Bungalow }) {
  return (
    <div className="flex items-center gap-4 min-h-[56px] mt-2" data-testid="sheet-coin">
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full overflow-hidden"
        style={{ width: 40, height: 40, border: '2px solid var(--color-kyle)', boxShadow: '0 0 12px rgba(76,175,80,0.45)' }}
      >
        <img src={room.thumb} alt="" className="w-full h-full object-cover" style={{ objectPosition: room.thumbPosition ?? '50% 30%' }} />
      </span>
      <div className="min-w-0">
        <CoinName name={room.symbol} address={room.address!} className="-my-2" nameClassName="text-[18px] text-white" addressClassName="text-white/55 text-[12px]" />
        <p className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
          {SHEET_WORDS.poolLine(room.symbol)}
        </p>
      </div>
    </div>
  );
}

/**
 * The island’s deep links open the sheet over the coin’s room instead of a page (answer
 * twenty-four, build 3): /pools?mint=<coin>&task=add and /solana?in=&out=<coin>, for a room the
 * sheet can act on. Every other address on those routes is the page, as before.
 */
export function DeepLinkSheet({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const to = deepLinkSheet(pathname, search);
  return to ? <Navigate to={to} replace /> : <>{children}</>;
}
