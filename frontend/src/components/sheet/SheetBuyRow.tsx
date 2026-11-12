import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Bungalow } from '../../lib/bungalows';
import { SHEET_WORDS } from '../../lib/arrival';
import { sheetRooms } from '../../lib/sheet';
import { tick } from '../../lib/tick';
import { CoinName } from '../ui/CoinName';
import { SHEET_ROW_WORDS } from './sheetContext';

/**
 * The sheet's coin, one chip (owner, 2026-11-11: "remove all the rest from the top besides bayla ... the one at
 * the top with the art stays, just needs the drop down"): the coin's art, its ticker and a caret. A press opens
 * the list the coin is picked from. The row of every room's chip is gone; the rooms are in that list.
 */
const CHIP = 'flex items-center gap-2 min-h-[44px] pl-1.5 pr-3 rounded-full text-[14px] font-bold text-white transition-colors hover:bg-white/5';
const chipStyle = { background: 'var(--color-bg-input)', border: '1px solid rgba(139,92,246,0.70)', boxShadow: '0 0 14px rgba(139,92,246,0.22)' } as const;
const Caret = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-white/70">
    <path d="M1 1l4 4 4-4" />
  </svg>
);
const roomArt = (b: Bungalow, px = 32) => (
  <img src={b.thumb} alt="" aria-hidden="true" className="rounded-full object-cover shrink-0" style={{ width: px, height: px, objectPosition: b.thumbPosition ?? '50% 30%' }} />
);

function Row({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div role="group" aria-label={SHEET_ROW_WORDS.group} className="flex flex-wrap items-center gap-2 mt-2" data-testid="sheet-bungalow-row">
      {children}
      {end && (
        <div className="ml-auto" data-testid="sheet-row-end">
          {end}
        </div>
      )}
    </div>
  );
}

/**
 * The Buy sheet's coin row: the coin chip, whose press opens the swap's own coin list (every room's coin, the
 * pool coins, any coin by name or address), then what `side` gives (Buy / Sell), then the network drop-down.
 * Under it the coin by its ticker and whole address, and its pool line when it is a room's.
 */
export function SheetBuyRow({ coin, art, onOpen, side, network }: {
  coin: { symbol: string; mint: string } | null;
  /** The coin's picture, as the swap's lists draw it. */
  art: ReactNode;
  onOpen: () => void;
  side?: ReactNode;
  network: ReactNode;
}) {
  const room = coin ? (sheetRooms().find((b) => b.address === coin.mint) ?? null) : null;
  return (
    <div data-testid="sheet-buy-row">
      <Row end={network}>
        <button
          type="button"
          onClick={() => {
            tick();
            onOpen();
          }}
          aria-haspopup="dialog"
          aria-label={coin ? `Coin: ${coin.symbol}. Pick another` : SHEET_ROW_WORDS.group}
          className={CHIP}
          style={chipStyle}
          data-testid="sheet-coin-chip"
        >
          {coin ? art : null}
          <span className={coin ? undefined : 'pl-2'}>{coin ? coin.symbol : SHEET_ROW_WORDS.group}</span>
          <Caret />
        </button>
        {side}
      </Row>
      {coin && (
        <div className="flex flex-wrap items-center gap-x-3 mt-1" data-testid="sheet-buy-coin">
          <CoinName name={coin.symbol} address={coin.mint} nameClassName="sr-only" addressClassName="text-white/55 text-[12px]" />
          {room && (
            <span className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
              {SHEET_WORDS.poolLine(room.symbol)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Add sheet's coin row: the same chip, on the room whose pool the sheet adds to. Its list is the rooms the
 * sheet has a pool for, then Every pool (your positions, Remove, Claim fees, Open a pool, any pool by its coin).
 */
export function SheetRoomRow({ room, all, onPick, onAll, end }: {
  room: Bungalow | null;
  /** Every pool is what the sheet shows. */
  all: boolean;
  onPick: (b: Bungalow) => void;
  /** Absent where Every pool is the page itself (/pools). */
  onAll?: () => void;
  end?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  const label = all ? 'Every pool' : room ? room.symbol : SHEET_ROW_WORDS.group;
  const pick = (go: () => void) => {
    tick();
    setOpen(false);
    go();
  };
  const item = 'flex items-center gap-3 w-full min-h-[48px] px-3 rounded-xl text-left text-[14px] font-semibold text-white hover:bg-white/5';
  return (
    <Row end={end}>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={room && !all ? `Coin: ${room.symbol}. Pick another` : all ? 'Every pool. Pick a coin' : SHEET_ROW_WORDS.group}
          onClick={() => {
            tick();
            setOpen((o) => !o);
          }}
          onKeyDown={(e) => {
            // Its own Escape: the sheet's would close the sheet under an open list.
            if (e.key === 'Escape' && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className={CHIP}
          style={chipStyle}
          data-testid="sheet-coin-chip"
        >
          {room && !all ? roomArt(room) : null}
          <span className={room && !all ? undefined : 'pl-2'}>{label}</span>
          <Caret />
        </button>
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={SHEET_ROW_WORDS.group}
            className="absolute left-0 top-full z-20 mt-2 w-[264px] max-w-[calc(100vw-48px)] p-1.5 rounded-2xl"
            style={{ background: 'rgba(13,21,48,0.98)', border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 12px 32px rgba(0,0,0,0.55)' }}
            data-testid="sheet-coin-list"
          >
            {sheetRooms().map((b) => {
              const on = !all && b.id === room?.id;
              return (
                <li key={b.id} role="option" aria-selected={on}>
                  <button type="button" className={item} style={on ? { background: 'rgba(139,92,246,0.22)' } : undefined} onClick={() => pick(() => onPick(b))}>
                    {roomArt(b, 28)}
                    <span className="flex-1">{b.symbol}</span>
                    <span className="text-[11px] font-normal" style={{ color: 'var(--color-text-secondary)' }}>
                      SOL pool
                    </span>
                  </button>
                </li>
              );
            })}
            {onAll && (
              <li role="option" aria-selected={all}>
                <button type="button" className={item} style={all ? { background: 'rgba(139,92,246,0.22)' } : undefined} onClick={() => pick(onAll)} data-testid="sheet-every-pool-chip">
                  <span aria-hidden="true" className="w-7 h-7 rounded-full flex items-center justify-center text-[13px]" style={{ background: 'rgba(49,208,170,0.18)', color: '#31d0aa' }}>
                    ∞
                  </span>
                  <span className="flex-1 whitespace-nowrap">Every pool</span>
                  <span className="text-[11px] font-normal whitespace-nowrap" style={{ color: 'var(--color-text-secondary)' }}>
                    your positions
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </Row>
  );
}
