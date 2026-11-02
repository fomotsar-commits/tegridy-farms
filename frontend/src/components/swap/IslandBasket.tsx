import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../ui/Modal';
import { FinePrint } from '../ui/FinePrint';
import { pageArt } from '../../lib/artConfig';
import { artSrcSet } from '../../lib/artSrcSet';
import { BUNGALOWS } from '../../lib/bungalows';
import { doorArt } from '../../lib/doorArt';
import { EDITORIAL_INK, HEADING_FONT, pad2 } from '../../lib/editorial';
import { QUICK_USD, acceptUsd, usdText } from '../../lib/islandBasket';

/**
 * "Buy all bungalows": the button on the swap card and the order it opens. Only what both
 * chains draw lives here; IslandBasketEvm and IslandBasketSolana quote, decide and send.
 *
 * The look (owner, 2026-10-22: the button "deserves a lot of attention", "avant-garde, cutting
 * edge") is the island's editorial system (lib/editorial.ts), the menu's and the dashboard's:
 * near-black, cream, the venue's green, heavy heading type, index numbers, hairlines, mono
 * captions, hard corners, grain. The button is a ticket stub, numbered with the count, with the
 * order's coins running on a tape. The order is a numbered sheet: the amount in the heading
 * face, each coin with its room's door picture, and the order's progress as a strip, drawn from
 * the same statuses the rows say in words.
 */

export type RowTone = 'ok' | 'warn' | 'err' | 'busy' | 'muted';

export interface BasketRow {
  key: string;
  /** The room (bungalows.ts id), for its door picture. */
  room?: string;
  symbol: string;
  /** "from Ethereum": a coin carried here by a bridge. */
  tag?: string;
  /** Where it is bought: "Uniswap V3", "PumpSwap", "Our pool". Null while that is not known. */
  venue: string | null;
  /** What it is quoted to pay, already formatted ("≈ 1.2M"). Null while quoting. */
  pays: string | null;
  /** `pays` is from the coin's market price while its quote is on its way: drawn dimmer. */
  estimate?: boolean;
  status?: { tone: RowTone; text: string };
}

const GREEN = '#22c55e';
const INK_DIM = 'rgba(245,228,184,0.3)';

const TONE: Record<RowTone, string> = {
  ok: 'text-[#22c55e]',
  warn: 'text-[#f0b26b]',
  err: 'text-[#ff8080]',
  busy: 'text-[#f5e4b8]',
  muted: 'text-[#f5e4b8]/55',
};
const TONE_INK: Record<RowTone, string> = { ok: GREEN, warn: '#f0b26b', err: '#ff8080', busy: EDITORIAL_INK, muted: INK_DIM };

/** The tape's edges fade out, so a coin never sits cut in half. */
const TAPE_MASK = 'linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent)';

/** The ticket stub on the swap card: its number is the count, its tape the coins in the order. */
export function IslandBasketButton({ count, symbols, onOpen }: { count: number; symbols: readonly string[]; onOpen: () => void }) {
  // Two copies of the run slide by one copy's width (index.css editorial-tape): no seam.
  const run = symbols.join('   ·   ');
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      // Not "Buy …" first: the form's own Buy button is the one a reader (or a script) looks for by that word.
      aria-label={`Island order: Buy all bungalows, ${count} coins`}
      data-testid="island-basket-open"
      // Colours that change on hover are classes, never inline style: an inline background
      // beats hover:bg-*, and the stub went near-black on near-black (walked 2026-10-22).
      className="group/stub relative isolate inline-grid grid-cols-[auto_minmax(0,1fr)] items-stretch max-w-full min-h-[40px] overflow-hidden text-left border border-[#f5e4b8]/40 bg-[#05080f]/90 text-[#f5e4b8] transition-colors duration-300 hover:bg-[#22c55e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22c55e] focus-visible:ring-offset-1 focus-visible:ring-offset-[#05080f]"
      style={{ textShadow: 'none' }}
    >
      {/* The stub's number, on its perforated edge. */}
      <span
        aria-hidden="true"
        className="flex items-center px-2.5 font-mono text-[13px] tabular-nums text-[#22c55e] border-r border-dashed border-[#f5e4b8]/40 transition-colors group-hover/stub:text-[#05080f] group-hover/stub:border-[#05080f]/40"
      >
        {pad2(count)}
      </span>
      <span className="min-w-0 flex flex-col justify-center gap-[3px] px-2.5 py-1.5 transition-colors group-hover/stub:text-[#05080f]">
        <span className="whitespace-nowrap font-black uppercase leading-none tracking-[-0.01em] text-[12px]" style={HEADING_FONT}>
          Buy all bungalows
        </span>
        {/* w-0 min-w-full: the tape fills the column but asks for no width of its own, so the
            stub is as wide as its word, not as wide as the run (seven coins would be 500px). */}
        <span
          aria-hidden="true"
          className="relative block w-0 min-w-full overflow-hidden font-mono text-[9px] uppercase tracking-[0.14em] leading-none text-[#f5e4b8]/65 group-hover/stub:text-[#05080f]/75"
          style={{ WebkitMaskImage: TAPE_MASK, maskImage: TAPE_MASK }}
        >
          <span className="editorial-tape" style={{ '--tape-s': `${Math.max(12, symbols.length * 3)}s` } as CSSProperties}>
            <span className="pr-5 whitespace-nowrap">{run}</span>
            <span className="pr-5 whitespace-nowrap">{run}</span>
          </span>
        </span>
      </span>
    </button>
  );
}

/** The order's split on screen: each row's share and dollars, and what moving a slider does. */
export interface BasketSplitView {
  /** Each row's share of the order, in percent (the even split's exact figure while `even`). */
  pcts: readonly number[];
  /** Each row's dollars of the order. */
  dollars: readonly number[];
  even: boolean;
  onPct: (i: number, pct: number) => void;
  onEven: () => void;
}

/** A share in words: whole percents, one decimal for an even split that is not whole (7 coins: 14.3%). */
function pctWords(p: number): string {
  return Number.isInteger(p) ? `${p}%` : `${p.toFixed(1)}%`;
}

/** A coin's door picture, or its room's colour while it has none. */
function Door({ room }: { room?: string }) {
  const b = room ? BUNGALOWS.find((x) => x.id === room) : undefined;
  const door = b ? doorArt(b) : null;
  const set = door ? artSrcSet(door.src) : undefined;
  return (
    <span aria-hidden="true" className="relative w-9 h-9 flex-shrink-0 overflow-hidden border border-[#f5e4b8]/15" style={{ background: b?.accent ?? 'rgba(245,228,184,0.08)' }}>
      {door && (
        <img
          src={door.src} {...(set ? { srcSet: set, sizes: '36px' } : {})} alt="" loading="lazy" decoding="async" width={36} height={36}
          className="w-full h-full object-cover" style={door.objectPosition ? { objectPosition: door.objectPosition } : undefined}
        />
      )}
    </span>
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
  /** Each coin's share, on a slider under its row. */
  split?: BasketSplitView;
}) {
  // Mounted only while open: a closed order costs the swap card nothing. Portalled to the
  // body: the swap card is animated with a transform, which would trap a fixed dialog in
  // its own layer, under the top bar and the phone's tab bar.
  if (!p.open || typeof document === 'undefined') return null;
  // The progress strip is the rows' own statuses, drawn: a coin that moved has a tone that
  // is not "muted" (muted is a note before anything was sent).
  const moved = p.rows.filter((r) => r.status && r.status.tone !== 'muted').length;
  const bought = p.rows.filter((r) => r.status?.tone === 'ok').length;
  return createPortal(
    <Modal
      open={p.open}
      onClose={p.closable ? p.onClose : () => {}}
      dismissOnBackdrop={p.closable}
      title="Buy all bungalows"
      art={pageArt('island-basket', 0).src}
      maxWidth="max-w-lg"
      chrome="editorial"
    >
      {/* Scrolls inside the dialog on a short screen, so the title, the close button and Buy stay reachable. */}
      <div data-testid="island-basket" className="max-h-[calc(100dvh-8.5rem)] overflow-y-auto overscroll-contain -mx-1 px-1">
        <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#f5e4b8]/60">
          <span aria-hidden="true" className="w-1.5 h-1.5 bg-[#22c55e]" />
          Island order · {p.chainName} · {pad2(p.rows.length)} coins
        </p>
        <p className="mt-1.5 text-[13px] leading-snug text-[#f5e4b8]/80">
          {p.split ? `One amount, split across every island coin on ${p.chainName}. Slide a coin to change its share.` : `One amount, split evenly across every island coin on ${p.chainName}.`}
        </p>

        <label htmlFor="island-basket-usd" className="sr-only">Dollars to spend</label>
        <div className="mt-4 flex items-end gap-2 border-b border-[#f5e4b8]/35 pb-1.5">
          <span aria-hidden="true" className="font-black leading-none text-[30px] text-[#f5e4b8]/45" style={HEADING_FONT}>$</span>
          <input
            id="island-basket-usd"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={p.usd}
            disabled={p.locked}
            onChange={(e) => acceptUsd(e.target.value, p.setUsd)}
            className="flex-1 min-w-0 bg-transparent outline-none font-black leading-none tracking-[-0.04em] text-[44px] text-[#f5e4b8] placeholder:text-[#f5e4b8]/25 disabled:opacity-60"
            style={HEADING_FONT}
          />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {QUICK_USD.map((v) => (
            <button
              key={v}
              type="button"
              disabled={p.locked}
              onClick={() => p.setUsd(v)}
              className={`min-h-[36px] px-3 border font-mono text-[11px] tracking-[0.1em] transition-colors disabled:opacity-50 ${
                p.usd === v ? 'bg-[#22c55e] border-[#22c55e] text-[#05080f]' : 'border-[#f5e4b8]/30 text-[#f5e4b8] hover:border-[#22c55e]'
              }`}
            >
              ${v}
            </button>
          ))}
        </div>
        <p className="mt-2 min-h-[16px] font-mono text-[11px] tracking-[0.04em] text-[#f5e4b8]/70" aria-live="polite">{p.summary ?? ''}</p>

        {moved > 0 && (
          <div data-testid="island-basket-progress" className="mt-3">
            <div aria-hidden="true" className="flex h-[3px] w-full gap-px">
              {p.rows.map((r) => (
                <span key={r.key} className="h-full flex-1 transition-colors duration-500" style={{ background: r.status && r.status.tone !== 'muted' ? TONE_INK[r.status.tone] : 'rgba(245,228,184,0.14)' }} />
              ))}
            </div>
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f5e4b8]/60">
              {bought} of {p.rows.length} bought{p.locked ? ', buying…' : ''}
            </p>
          </div>
        )}

        {p.split && (
          <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[#f5e4b8]/60">
            <span data-testid="island-basket-split-mode">Split · {p.split.even ? 'even' : 'yours'}</span>
            {!p.split.even && (
              <button type="button" disabled={p.locked} onClick={p.split.onEven}
                className="min-h-[32px] px-1 underline underline-offset-4 uppercase tracking-[0.14em] text-[#f5e4b8] hover:text-[#22c55e] disabled:opacity-50">
                Split evenly
              </button>
            )}
          </div>
        )}
        <ul className={`${p.split ? 'mt-1' : 'mt-3'} border-t border-[#f5e4b8]/30`} aria-label="Coins in this order">
          {p.rows.map((r, i) => (
            <li
              key={r.key}
              data-testid={`island-basket-row-${r.key}`}
              className={`relative grid grid-cols-[1.5rem_2.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 py-2 border-b border-[#f5e4b8]/12${p.split && p.split.pcts[i] === 0 ? ' opacity-60' : ''}`}
            >
              {/* The coin's state, as a rule up the row's edge. */}
              <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-[2px] transition-colors duration-500" style={{ background: r.status ? TONE_INK[r.status.tone] : 'transparent' }} />
              <span aria-hidden="true" className="pl-2 font-mono text-[10px] tabular-nums text-[#f5e4b8]/45">{pad2(i + 1)}</span>
              <Door room={r.room} />
              <span className="min-w-0">
                <span className="block truncate font-black leading-none tracking-[-0.03em] text-[17px]" style={HEADING_FONT}>{r.symbol}</span>
                {/* From where and through which pool: one line, its own text, as the tests read it. */}
                <span className="mt-1 block truncate font-mono text-[10px] tracking-[0.04em] text-[#f5e4b8]/60">{r.tag ? ` ${r.tag}` : ''}{` · ${r.venue ?? '…'}`}</span>
                {r.status && <span className={`mt-0.5 block text-[11px] leading-snug ${TONE[r.status.tone]}`}>{r.status.text}</span>}
              </span>
              <span className={`shrink-0 pr-1 text-right font-mono text-[13px] tabular-nums${r.estimate ? ' text-[#f5e4b8]/55' : ''}`}>{r.pays ?? '…'}</span>
              {p.split && (() => {
                const pct = p.split.pcts[i] ?? 0;
                return (
                  <span className="col-start-2 col-span-3 flex items-center gap-2.5">
                    <input
                      type="range" min={0} max={100} step={1}
                      value={Math.round(pct)}
                      disabled={p.locked}
                      onChange={(e) => p.split!.onPct(i, Number(e.target.value))}
                      aria-label={`${r.symbol}’s share of the order`}
                      aria-valuetext={`${pctWords(pct)}, ${usdText(p.split.dollars[i] ?? 0)}`}
                      data-testid={`island-basket-split-${r.key}`}
                      className="basket-split flex-1 min-w-0"
                      style={{ '--fill': `${pct}%` } as CSSProperties}
                    />
                    <span className="shrink-0 w-[7.5rem] pr-1 text-right font-mono text-[11px] tabular-nums text-[#f5e4b8]/80">
                      <span className={pct > 0 ? 'text-[#22c55e]' : ''}>{pctWords(pct)}</span> · {usdText(p.split.dollars[i] ?? 0)}
                    </span>
                  </span>
                );
              })()}
            </li>
          ))}
        </ul>

        <p className="mt-3 text-[12px] leading-snug text-[#f5e4b8]/80" data-testid="island-basket-fee">{p.feeLine}</p>
        {p.notice && (
          <p role="status" className={`mt-2 text-[12px] leading-snug ${TONE[p.notice.tone]}`} data-testid="island-basket-notice">
            {p.notice.text}
            {p.notice.action && (
              <button type="button" onClick={p.notice.action.onClick} className="ml-1.5 px-1 py-2 -my-2 underline underline-offset-4 font-semibold" style={{ color: EDITORIAL_INK }}>
                {p.notice.action.label}
              </button>
            )}
          </p>
        )}
        <div className="mt-4">{p.cta}</div>
        {p.after && <div className="mt-2 text-center">{p.after}</div>}
        <FinePrint summary="How it works" className="mt-2">{p.finePrint}</FinePrint>
      </div>
    </Modal>,
    document.body,
  );
}

/** The order's main button: the venue's green, the heading face, an arrow that leads. */
export function BasketCta({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid="island-basket-buy"
      className="group/cta flex w-full min-h-[52px] items-center justify-between gap-3 px-4 font-black uppercase leading-none tracking-[-0.01em] text-[15px] bg-[#22c55e] text-[#05080f] transition-colors hover:bg-[#f5e4b8] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#22c55e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5e4b8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#05080f]"
      style={{ ...HEADING_FONT, textShadow: 'none' }}
    >
      <span>{label}</span>
      <span aria-hidden="true" className="transition-transform duration-300 group-hover/cta:translate-x-1">→</span>
    </button>
  );
}
