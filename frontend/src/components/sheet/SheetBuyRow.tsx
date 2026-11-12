import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';
import { SHEET_WORDS } from '../../lib/arrival';
import { sheetHref, sheetRooms } from '../../lib/sheet';
import { tick } from '../../lib/tick';
import { CoinName } from '../ui/CoinName';
import { SHEET_ROW_WORDS, useSheet } from './sheetContext';

const CHIP = 'flex items-center gap-2 min-h-[44px] rounded-full text-[13px] font-semibold text-white';
// Lit as the amount chips under it are lit: the purple edge.
const chipStyle = (lit: boolean) => ({ background: 'var(--color-bg-input)', border: `1px solid ${lit ? 'rgba(139,92,246,0.70)' : 'var(--color-border)'}` });

/**
 * The bungalow row: the rooms a sheet acts on (lib/sheet.ts sheetRooms), a chip each by its ticker,
 * in the hall's order. It wraps at a phone's width. `lit`, the mint on the sheet, lights its chip
 * (none: nothing lit); without it the chips light nothing, as Add's row with no room. `end` is
 * drawn last, at the right end of whichever line it lands on (Buy's network drop-down).
 */
export function BungalowRow({ lit, onPick, end, all }: { lit?: string | null; onPick: (b: Bungalow) => void; end?: ReactNode; all?: { on: boolean; onPick: () => void } }) {
  return (
    <div role="group" aria-label={SHEET_ROW_WORDS.group} className="flex flex-wrap gap-2 mt-2" data-testid="sheet-bungalow-row">
      {sheetRooms().map((b) => {
        const on = lit !== undefined && b.address === lit;
        return (
          <button key={b.id} type="button" aria-pressed={lit === undefined ? undefined : on} onClick={() => onPick(b)} className={`${CHIP} pl-1.5 pr-3`} style={chipStyle(on)}>
            <img src={b.thumb} alt="" aria-hidden="true" className="w-7 h-7 rounded-full object-cover" style={{ objectPosition: b.thumbPosition ?? '50% 30%' }} />
            {b.symbol}
          </button>
        );
      })}
      {/* Add's last chip: every pool on the venue, with your positions, Remove, Claim fees and Open a pool. */}
      {all && (
        <button type="button" aria-pressed={all.on} onClick={all.onPick} className={`${CHIP} px-3`} style={chipStyle(all.on)} data-testid="sheet-every-pool-chip">
          Every pool
        </button>
      )}
      {end && (
        <div className="ml-auto" data-testid="sheet-row-end">
          {end}
        </div>
      )}
    </div>
  );
}

/**
 * The Buy sheet's bungalow row, above the amount (island answer twenty-seven): the room's coin
 * lit to start, nothing with no room. A room's chip names its coin in the address over the same
 * page (`?sheet=buy&coin=bobo`), so Back and a reload hold it, and the form opens on it. Last on
 * the row, where "Any coin" stood, the swap's network drop-down (owner, 2026-11-07, `network`):
 * any other Solana coin is the You get line's own press. Under the row, the coin on the sheet by
 * its ticker and its whole address.
 */
export function SheetBuyRow({ coin, network }: { coin: { symbol: string; mint: string } | null; network: ReactNode }) {
  const sheet = useSheet();
  const navigate = useNavigate();
  const location = useLocation();
  const room = coin ? (sheetRooms().find((b) => b.address === coin.mint) ?? null) : null;
  const pick = (b: Bungalow) => {
    if (coin && b.address === coin.mint) return;
    tick();
    navigate(sheetHref(location.pathname, location.search, 'buy', b.id), { replace: true, state: location.state });
    // The sheet is on this room already, buying a pick from the You get press: the form opens on the room's coin again.
    if (b.id === sheet?.room?.id) sheet.reopen?.();
  };
  return (
    <div data-testid="sheet-buy-row">
      <BungalowRow lit={coin?.mint ?? null} onPick={pick} end={network} />
      {coin && (
        <div className="flex flex-wrap items-center gap-x-3 mt-1" data-testid="sheet-buy-coin">
          <CoinName name={coin.symbol} address={coin.mint} nameClassName="text-[15px] text-white" addressClassName="text-white/55 text-[12px]" />
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
