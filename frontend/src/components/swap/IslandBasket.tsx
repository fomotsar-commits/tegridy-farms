import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../ui/Modal';
import { FinePrint } from '../ui/FinePrint';
import { pageArt } from '../../lib/artConfig';
import { QUICK_USD, acceptUsd } from '../../lib/islandBasket';

/**
 * "Buy all bungalows": the small button on the swap card and the order it opens. Only
 * what both chains draw lives here; IslandBasketEvm and IslandBasketSolana quote, decide
 * and send.
 */

export type RowTone = 'ok' | 'warn' | 'err' | 'busy' | 'muted';

export interface BasketRow {
  key: string;
  symbol: string;
  /** "from Ethereum": a coin carried here by a bridge. */
  tag?: string;
  /** Where it is bought: "Uniswap V3", "PumpSwap", "Our pool". Null while that is not known. */
  venue: string | null;
  /** What it is quoted to pay, already formatted ("≈ 1.2M"). Null while quoting. */
  pays: string | null;
  status?: { tone: RowTone; text: string };
}

const TONE: Record<RowTone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  err: 'text-red-300',
  busy: 'text-white',
  muted: 'text-white/60',
};

/** The tiny pill on the swap card. */
export function IslandBasketButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      // Not "Buy …" first: the form's own Buy button is the one a reader (or a script) looks for by that word.
      aria-label={`Island order: Buy all bungalows, ${count} coins`}
      data-testid="island-basket-open"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 min-h-[32px] rounded-full text-[11px] font-semibold text-white transition-colors hover:bg-white/15"
      style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.22)' }}
    >
      <span aria-hidden="true">🏝️</span>
      Buy all bungalows
      <span className="px-1.5 rounded-full text-[10px]" style={{ background: 'var(--color-stan)' }}>{count}</span>
    </button>
  );
}

export function IslandBasketDialog(p: {
  open: boolean;
  onClose: () => void;
  /** While a coin is at the wallet or on its way, the order cannot be closed. */
  closable: boolean;
  chainName: string;
  usd: string;
  setUsd: (s: string) => void;
  /** Inputs off while the order runs. */
  locked: boolean;
  /** "7 coins · $1.43 each · ≈ 0.0042 ETH". */
  summary: string | null;
  rows: readonly BasketRow[];
  /** The visible line on what the venue takes. */
  feeLine: string;
  /** A warning or the reason the button is off, said in view. */
  notice?: { tone: RowTone; text: string; action?: { label: string; onClick: () => void } } | null;
  cta: ReactNode;
  /** Under the button, e.g. "Stop after this coin". */
  after?: ReactNode;
  finePrint: ReactNode;
}) {
  // Mounted only while open: a closed order costs the swap card nothing. Portalled to the
  // body: the swap card is animated with a transform, which would trap a fixed dialog in
  // its own layer, under the top bar and the phone's tab bar.
  if (!p.open || typeof document === 'undefined') return null;
  return createPortal(
    <Modal
      open={p.open}
      onClose={p.closable ? p.onClose : () => {}}
      dismissOnBackdrop={p.closable}
      title="Buy all bungalows"
      art={pageArt('island-basket', 0).src}
    >
      {/* Scrolls inside the dialog on a short screen, so the title, the close button and Buy stay reachable. */}
      <div data-testid="island-basket" className="max-h-[calc(100dvh-8.5rem)] overflow-y-auto overscroll-contain -mx-1 px-1">
        <p className="text-white/85 text-[12px] mb-3">One amount, split evenly across every island coin on {p.chainName}.</p>
        <label htmlFor="island-basket-usd" className="sr-only">Dollars to spend</label>
        <div className="flex items-center gap-2 rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.22)' }}>
          <span className="text-white/80 text-[20px] font-mono" aria-hidden="true">$</span>
          <input
            id="island-basket-usd"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={p.usd}
            disabled={p.locked}
            onChange={(e) => acceptUsd(e.target.value, p.setUsd)}
            className="flex-1 bg-transparent text-white text-[20px] font-mono outline-none min-w-0 disabled:opacity-60"
          />
          <span className="flex gap-1">
            {QUICK_USD.map((v) => (
              <button
                key={v}
                type="button"
                disabled={p.locked}
                onClick={() => p.setUsd(v)}
                className="px-2 py-1.5 min-h-[36px] rounded-md text-[11px] font-medium text-white disabled:opacity-50"
                style={{ background: p.usd === v ? 'var(--color-stan)' : 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)' }}
              >
                ${v}
              </button>
            ))}
          </span>
        </div>
        <p className="text-white/70 text-[11px] font-mono mt-1.5 min-h-[16px]" aria-live="polite">{p.summary ?? ''}</p>

        <ul className="mt-2 space-y-1" aria-label="Coins in this order">
          {p.rows.map((r) => (
            <li
              key={r.key}
              data-testid={`island-basket-row-${r.key}`}
              className="px-2.5 py-1 rounded-lg text-[11px]"
              style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.10)' }}
            >
              {/* One line a coin: what, from where, through which pool, and what it pays. */}
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="text-white font-semibold">{r.symbol}</span>
                  <span className="text-white/55 text-[10px]">{r.tag ? ` ${r.tag}` : ''}{` · ${r.venue ?? '…'}`}</span>
                </span>
                <span className="shrink-0 text-white font-mono">{r.pays ?? '…'}</span>
              </span>
              {r.status && <span className={`block text-[10px] leading-snug ${TONE[r.status.tone]}`}>{r.status.text}</span>}
            </li>
          ))}
        </ul>

        <p className="text-white/75 text-[11px] mt-2" data-testid="island-basket-fee">{p.feeLine}</p>
        {p.notice && (
          <p role="status" className={`text-[11px] mt-2 ${TONE[p.notice.tone]}`} data-testid="island-basket-notice">
            {p.notice.text}
            {p.notice.action && (
              <button type="button" onClick={p.notice.action.onClick} className="ml-1.5 px-1 py-2 -my-2 underline underline-offset-2 font-semibold text-white">
                {p.notice.action.label}
              </button>
            )}
          </p>
        )}
        <div className="mt-3">{p.cta}</div>
        {p.after && <div className="mt-2 text-center">{p.after}</div>}
        <FinePrint summary="How it works" className="mt-2">{p.finePrint}</FinePrint>
      </div>
    </Modal>,
    document.body,
  );
}

/** The order's main button. */
export function BasketCta({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid="island-basket-buy"
      className="w-full btn-primary py-3 min-h-[48px] text-[15px] font-semibold rounded-xl disabled:opacity-40"
    >
      {label}
    </button>
  );
}
