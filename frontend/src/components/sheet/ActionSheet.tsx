import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { getActiveBungalow, type Bungalow } from '../../lib/bungalows';
import { useActiveBungalowId } from '../../hooks/useActiveBungalowId';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { SHEET_WORDS } from '../../lib/arrival';
import { isRoomDoor } from '../../lib/navConfig';
import { deepLinkSheet, readSheet, roomNet, sheetHref, sheetRoom, withoutSheet, SHEET_ALL, type SheetAsk, type SheetKind, type SheetNet } from '../../lib/sheet';
import { ModuleNetworkPicker, ModuleNetworkProvider, moduleNetworkOr } from '../layout/moduleNetwork';
import { OffSolanaPools, OffSolanaSwap } from '../swap/NetworkForms';
import { evmRoomToken } from '../../lib/sheetRooms';
import { setSheetOpen, useSheetOutletHead } from '../../lib/sheetStore';
import { useReceipt } from '../../lib/receipt';
import { useScreenMove } from '../../lib/screenMove';
import { tick } from '../../lib/tick';
import { CoinName } from '../ui/CoinName';
import { SHEET_WAIT } from './sheetContext';
import { SheetRoomRow } from './SheetBuyRow';

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
  return <OpenSheet ask={ask} />;
}

function OpenSheet({ ask }: { ask: SheetAsk }) {
  const { kind, coin: named } = ask;
  const location = useLocation();
  const navigate = useNavigate();
  // The coin named in the address, else the room entered last when the sheet can act on it, else the bungalow row.
  const active = getActiveBungalow();
  // The sheet's network (owner, 2026-11-11): the one its drop-down picked, held in the address; else a named coin's
  // (Solana); else the room's own, so a room on Base opens on Base; else Solana. A pick changes the form in place.
  const section = kind === 'buy' ? 'swap' : 'pools';
  const net = moduleNetworkOr(section, ask.net ?? (named || ask.all ? 'solana' : roomNet(active)));
  const onSolana = net === 'solana';
  // Every pool (Add): the whole pools section. /pools is that section already, so there the sheet is one room's.
  const all = ask.all && onSolana && location.pathname !== '/pools';
  const room = all ? null : (named ?? sheetRoom(active?.id));
  // Buy's form is drawn with no coin too: its own bungalow row picks one (answer twenty-seven). Add's waits for a room,
  // or draws every pool. Another network's form is drawn here, by the sheet: it needs no Solana connection.
  const drawn = onSolana && (room !== null || kind === 'buy' || all);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const pageOutlet = useSheetOutletHead();
  // The sheet's green button is her move, whatever her line says: her header button goes quiet under it.
  useScreenMove('sheet');
  const pressed = (location.state as { sheet?: boolean } | null)?.sheet === true;
  const close = useCallback(() => {
    // Opened by a press on this page: Back pops back to it. Opened by a link: the page replaces the sheet.
    // Every pool writes the coin looked up into the address (as /pools does): the page under it keeps none of it.
    if (pressed && !all) navigate(-1);
    else {
      const bare = withoutSheet(location.pathname, location.search);
      if (!all) navigate(bare, { replace: true });
      else {
        const at = bare.indexOf('?');
        const params = new URLSearchParams(at >= 0 ? bare.slice(at) : '');
        for (const k of ['mint', 'task', 'pool']) params.delete(k);
        const query = params.toString();
        navigate(query ? `${location.pathname}?${query}` : location.pathname, { replace: true });
      }
    }
  }, [pressed, all, navigate, location.pathname, location.search]);
  // The sheet's own moves, each in place: its network, its other form (Swap or Add), every pool.
  const go = useCallback(
    (nextKind: SheetKind, coin: string | null, nextNet: SheetNet) => {
      tick();
      navigate(sheetHref(location.pathname, location.search, nextKind, coin, nextNet), { replace: true, state: location.state });
    },
    [navigate, location.pathname, location.search, location.state],
  );
  const pickNet = useCallback((n: SheetNet) => go(kind, null, n), [go, kind]);

  useEffect(() => {
    if (!drawn || !slot) return;
    setSheetOpen({ kind, room, slot, close, all, pickNet });
    return () => setSheetOpen(null);
  }, [drawn, kind, room, slot, close, all, pickNet]);

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
  const label = room && onSolana ? (kind === 'add' ? SHEET_WORDS.add(room.symbol) : SHEET_WORDS.buy(room.symbol)) : kind === 'add' ? 'Add' : 'Buy';
  const network = <ModuleNetworkPicker section={section} align="end" compact={kind === 'buy'} />;
  // On the room's own EVM network the swap opens on the room's coin.
  const evmToken = evmRoomToken(active);
  const roomToken = evmToken && roomNet(active) === net ? evmToken : null;
  const everyPool = location.pathname !== '/pools';

  return createPortal(
    <ModuleNetworkProvider active={net} pick={pickNet}>
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
        data-network={net}
        // A phone: a sheet from the bottom edge. A tablet and wider: the same card in the middle of the screen,
        // a little wider, so its form is not pinned to the foot of a tall window.
        className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-[480px] flex flex-col outline-none rounded-t-[20px] border-t border-[rgba(139,92,246,0.45)] md:bottom-auto md:top-1/2 md:-translate-y-1/2 md:max-w-[520px] md:rounded-[20px] md:border"
        style={{
          maxHeight: 'calc(100dvh - 16px)',
          background: 'var(--color-bg-surface)',
          boxShadow: '0 -16px 48px rgba(0,0,0,0.55)',
        }}
      >
        <div className="overflow-y-auto overscroll-contain px-4 has-[[role=listbox]]:min-h-[min(520px,calc(100dvh-16px))]" style={{ paddingBottom: 'max(48px, calc(16px + env(safe-area-inset-bottom, 0px)))' }}>
          <div aria-hidden="true" className="mx-auto mt-2 rounded-full" style={{ width: 36, height: 4, background: 'rgba(255,255,255,0.22)' }} />
          <div className="flex items-center justify-between gap-3 mt-1.5">
          <button
            type="button"
            onClick={() => {
              tick();
              close();
            }}
            className="flex items-center gap-3 min-h-[44px] text-[14px] font-semibold"
            style={{ color: '#c4b5fd' }}
            data-testid="sheet-back"
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2L2 8l6 6" />
            </svg>
            {isRoomDoor(location.pathname) ? SHEET_WORDS.back : SHEET_WORDS.backOff}
          </button>
          {/* The sheet's two forms, one press apart: the coin and the network stay. */}
          <div role="group" aria-label="Swap or add" className="flex p-0.5 rounded-full" style={{ background: 'var(--color-bg-input)', border: '1px solid var(--color-border)' }} data-testid="sheet-kind">
            {(['buy', 'add'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => kind !== k && go(k, onSolana ? (named?.id ?? null) : null, net)}
                className="min-h-[40px] px-4 rounded-full text-[13px] font-semibold"
                style={kind === k ? { background: 'rgba(139,92,246,0.30)', color: '#fff' } : { color: 'var(--color-text-secondary)' }}
              >
                {k === 'buy' ? 'Swap' : 'Add'}
              </button>
            ))}
          </div>
          </div>
          {/* Buy names its coin on the form's own chip (SheetBuyRow), whose press opens the swap's coin list; its network
              drop-down ends that row. Add's chip is here: its list is the rooms and Every pool; then the network. */}
          {onSolana && kind === 'add' && (
            <>
              <SheetRoomRow room={room} all={all} onPick={pick} onAll={everyPool ? () => go('add', SHEET_ALL, 'solana') : undefined} end={network} />
              {room && <CoinRow room={room} />}
            </>
          )}
          {!onSolana && kind === 'add' && (
            <div className="flex justify-end mt-2" data-testid="sheet-network-row">
              {network}
            </div>
          )}
          {!onSolana && (
            <div className="mt-3" data-testid="sheet-off-solana">
              {kind === 'buy' ? <OffSolanaSwap chain={net} buy={roomToken?.address} lead={<ModuleNetworkPicker section="swap" align="start" />} /> : net !== 'cardano' ? <OffSolanaPools chain={net} /> : null}
            </div>
          )}
          <div ref={setSlot} data-testid="sheet-body" hidden={!onSolana} className={drawn ? `mt-4 ${SHEET_WAIT[kind].slot}` : 'mt-4'} />
          {drawn && pageOutlet === null && (
            <Suspense fallback={null}>
              <SheetOwnConnection />
            </Suspense>
          )}
        </div>
      </div>
    </div>
    </ModuleNetworkProvider>,
    document.body,
  );
}

/** Under the chip: the coin's whole address, a press that copies it, and its pool. The chip above carries its art. */
function CoinRow({ room }: { room: Bungalow }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 mt-1" data-testid="sheet-coin">
      <CoinName name={room.symbol} address={room.address!} nameClassName="sr-only" addressClassName="text-white/55 text-[12px]" />
      <span className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        {SHEET_WORDS.poolLine(room.symbol)}
      </span>
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
