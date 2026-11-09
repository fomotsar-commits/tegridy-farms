import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RECEIPT_WORDS } from '../lib/arrival';
import { clockText, closeReceipt, useReceipt, type Receipt } from '../lib/receipt';
import { sheetRoom } from '../lib/sheet';
import { useScreenMove } from '../lib/screenMove';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { headTail } from './ui/CoinName';
import { tick } from '../lib/tick';
import { FlameCatch, type FlameState } from './FlameCatch';
import { FloorHead } from './FloorHead';
import { hueOf, type FloorState } from '../lib/floorMoment';

/** The veil first, then the card rises (its 300 ms transition). */
const RISE_AFTER_MS = 250;
/** The strike comes the moment the card is up: the rise's own 300 ms (index.css counts the same). */
const CATCH_AFTER_MS = 300;
/** Each beat (the shore's three, the floor's three) flares the card's edge this long (island answers thirty and thirty-two). */
const BEAT_MS = 240;
/** An add's flash turns the card's edge white this long, then it holds the token's hue (answer thirty-two). */
const FLASH_EDGE_MS = 120;

/**
 * The moment is once a landing: the signature whose light (a buy's, on the shore) or brick (an add's,
 * on the pool's floor) last landed. Bayla's Receipt raises the card again at rest; a card closed
 * before its landing plays again.
 */
let caughtFor: string | null = null;

/**
 * The receipt card (island answer twenty-five, screen 3, build 6): one card over the page the
 * action landed on. What was done, the fee and where it went (read from the signature:
 * lib/solana/receiptRead.ts), what it did to the wallet's clock, one green button that hands
 * over the island's card, and Back to the room. The toast is for errors only. Its head answers the
 * action the moment the card is up: a buy's or a sale's is the coin's shore (answer thirty:
 * FlameCatch.tsx and the island's engine, lib/shoreMoment.ts); an add's is the pool, where the flash
 * plays and the adder's brick lands on the floor of every LP's (answer thirty-two: FloorHead.tsx).
 */
export function ReceiptCard() {
  const { receipt, open } = useReceipt();
  // The card's green button is the receipt itself: Bayla's Receipt goes quiet while it is up.
  useScreenMove('receipt', open && receipt !== null);
  if (!open || !receipt) return null;
  return <OpenReceipt receipt={receipt} />;
}

function OpenReceipt({ receipt }: { receipt: Receipt }) {
  const titleId = useId();
  const [risen, setRisen] = useState(false);
  const [up, setUp] = useState(false);
  // Played already when this card was raised (Bayla's Receipt): at rest at once.
  const [caughtBefore] = useState(() => caughtFor === receipt.signature);
  const sold = receipt.action === 'sold';
  // An add's head is the pool, never the shore (island answer thirty-two).
  const isAdd = receipt.action === 'added';
  // A sale never strikes: the ember sits in the ring and the light on the shore cools.
  const flame: FlameState = sold ? 'ember' : caughtBefore ? 'lit' : 'catching';
  // An add's moment plays once per signature; a card raised again after its landing opens at rest.
  const floor: FloorState = caughtBefore ? 'lit' : 'playing';
  // The line under the title: from the landing; at once for a card at rest and for a sale.
  const [landed, setLanded] = useState(() => caughtBefore || sold);
  // From an add's flash on, the card's edge holds the token's hue.
  const [lit, setLit] = useState(caughtBefore);
  // A beat's flare and an add's white flash: a class on the card, let go by a timer.
  const [edge, setEdge] = useState('');
  const edgeTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(edgeTimer.current), []);
  const flare = (cls: string, ms: number) => {
    window.clearTimeout(edgeTimer.current);
    setEdge(cls);
    edgeTimer.current = window.setTimeout(() => setEdge(''), ms);
  };
  const hue = isAdd ? hueOf(receipt.coin.symbol) : null;
  useEffect(() => {
    const t = window.setTimeout(() => setRisen(true), RISE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [receipt.signature]);
  useEffect(() => {
    if (!risen) return;
    const t = window.setTimeout(() => setUp(true), CATCH_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [risen]);
  // Every card has a head now and is taller than a short screen: the focus trap's focus scrolls
  // the layer to the card's foot, and the head, where the moment plays, would be off the top.
  // The moment the card is up, the layer goes back to its top.
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (risen && layerRef.current) layerRef.current.scrollTop = 0;
  }, [risen]);
  // Once per signature, marked when the light (or the brick) lands: a card closed before the landing plays again when raised.
  const onLanded = () => {
    caughtFor = receipt.signature;
    setLanded(true);
  };
  const onBeat = () => flare('receipt-beat', BEAT_MS);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeReceipt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const cardRef = useFocusTrap<HTMLDivElement>(true, { focusContainer: true });
  const close = () => {
    tick();
    closeReceipt();
  };
  const title = receipt.title ?? (receipt.action === 'added' ? `Added SOL + ${receipt.coin.symbol}` : `${receipt.action === 'sold' ? 'Sold' : 'Bought'} ${receipt.coin.symbol}`);
  // An add shares on X (island answer thirty-one): its link names the coin's room, else its mint.
  const lpTarget = receipt.action === 'added' ? (sheetRoom(receipt.coin.mint)?.id ?? receipt.coin.mint) : null;

  return createPortal(
    <div ref={layerRef} className="fixed inset-0 z-[85] flex items-start justify-center overflow-y-auto px-4" data-testid="receipt-layer">
      <div aria-hidden="true" className="fixed inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} onClick={close} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="receipt-card"
        data-flame={isAdd ? undefined : flame}
        data-floor={isAdd ? (lit ? 'lit' : 'playing') : undefined}
        className={`receipt-card relative w-full max-w-[358px] my-4 outline-none motion-safe:transition-[opacity,transform] motion-safe:duration-300${edge ? ` ${edge}` : ''}`}
        style={{
          // Centred by the card's height: the pool's head is a little taller than the shore's.
          marginTop: `clamp(16px, calc((100dvh - ${isAdd ? 680 : 670}px) / 2), 172px)`,
          background: 'var(--color-bg-surface)',
          borderRadius: 20,
          // An add's edge is index.css's (".receipt-card[data-floor]"): the flash and the beats are classes on it.
          ...(isAdd ? {} : { border: '1px solid rgba(139,92,246,0.45)' }),
          padding: '24px 20px 12px',
          ...(isAdd ? {} : { boxShadow: '0 24px 64px rgba(0,0,0,0.65)' }),
          opacity: risen ? 1 : 0,
          transform: risen ? 'none' : 'translateY(16px)',
          ...(hue ? { ['--floor-hue' as string]: hue.rgb.join(','), ['--floor-hue-mid' as string]: hue.mid.join(',') } : {}),
        }}
      >
        {isAdd ? (
          // The pool: its place held while the card rises (so nothing jumps), the moment from the card up on.
          risen || caughtBefore ? (
            <FloorHead
              state={floor}
              wallet={receipt.wallet}
              symbol={receipt.coin.symbol}
              lps={receipt.lps}
              onFlash={() => {
                setLit(true);
                flare('receipt-flash', FLASH_EDGE_MS);
              }}
              onLanded={onLanded}
              onBeat={onBeat}
            />
          ) : (
            <div className="receipt-floor" aria-hidden="true" />
          )
        ) : (
          // The coin's shore across the card's head, the ring on its bottom edge: the moment waits for the card to be up.
          <FlameCatch state={flame} up={up} wallet={receipt.wallet} holders={receipt.holders} onLanded={onLanded} onBeat={onBeat} />
        )}
        {/* The title clears the ring's lower half, which hangs below either head. */}
        <h2 id={titleId} className="mt-10 text-center text-white text-[24px] leading-[30px]" style={{ fontFamily: 'var(--font-family-heading)', fontWeight: 800 }} data-testid="receipt-title">
          {title}
        </h2>
        {receipt.under && (
          <p className="mt-1 text-center text-[14px]" style={{ color: 'var(--color-text-secondary)' }} data-testid="receipt-under">
            {receipt.under}
          </p>
        )}
        {isAdd ? (
          // Always in the layout (nothing below it moves), shown from the landing.
          <p className="receipt-floor-line mt-1 text-center text-[14px]" data-on={landed ? '1' : '0'} data-testid="receipt-floor-line" style={{ color: 'var(--color-text-secondary)' }}>
            {RECEIPT_WORDS.floor(receipt.coin.symbol)}
          </p>
        ) : (
          // The line under the title. Its two lines are kept from the start, as the island drew it, so
          // nothing below moves when the light lands.
          <div className="mt-1 min-h-[40px]" data-testid="receipt-shore-slot">
            {landed && (
              <p className="text-center text-[14px] leading-[20px]" style={{ color: 'var(--color-text-secondary)' }} data-testid="receipt-shore-line">
                {sold ? RECEIPT_WORDS.shoreCooling : <ShoreWords coin={receipt.coin.symbol} />}
              </p>
            )}
          </div>
        )}

        <div className="mt-5 pt-2 pb-2" style={{ borderTop: '1px solid rgba(139,92,246,0.25)', borderBottom: '1px solid rgba(139,92,246,0.25)' }} data-testid="receipt-rows">
          <FeeRows receipt={receipt} />
          <Row label={RECEIPT_WORDS.signature}>
            <a href={receipt.explorerUrl} target="_blank" rel="noopener noreferrer" className="font-mono" style={{ color: '#c4b5fd' }} aria-label={`The transaction ${receipt.signature} on the explorer (opens in new tab)`}>
              {headTail(receipt.signature)} <span aria-hidden="true">↗</span>
            </a>
          </Row>
        </div>

        {receipt.clock && (
          <p
            data-testid="receipt-clock"
            className="receipt-clock mt-4 flex items-center gap-3 min-h-[48px] px-4 py-2 rounded-xl text-[14px] font-semibold"
            style={{ background: 'rgba(76,175,80,0.12)', border: '1px solid rgba(76,175,80,0.25)', color: 'var(--color-text-primary)' }}
          >
            <span aria-hidden="true" className="receipt-clock-dot shrink-0 rounded-full" style={{ width: 6, height: 6, background: 'var(--color-kyle)' }} />
            {clockText(receipt.clock, receipt.coin.symbol)}
          </p>
        )}

        {/* The one green button: after an add, X with the post written; else the island's card for this wallet, the object that travels. */}
        <a
          href={lpTarget ? RECEIPT_WORDS.lpIntent(receipt.coin.symbol, lpTarget) : RECEIPT_WORDS.cardUrl(receipt.wallet)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={tick}
          className="btn-primary mt-5 w-full inline-flex items-center justify-center"
          style={{ height: 52, fontSize: 15, fontWeight: 700 }}
          data-testid="receipt-share"
        >
          {lpTarget ? RECEIPT_WORDS.shareX : RECEIPT_WORDS.share}
        </a>
        <button type="button" onClick={close} className="mt-1 w-full min-h-[44px] text-[13px] font-semibold" style={{ color: '#c4b5fd' }} data-testid="receipt-back">
          {RECEIPT_WORDS.back}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** "You're on $BAYLA's shore. Every light here holds it.", the coin's shore marked as the island drew it. */
function ShoreWords({ coin }: { coin: string }) {
  const line = RECEIPT_WORDS.shore(coin);
  const mark = RECEIPT_WORDS.shoreMark(coin);
  const at = line.indexOf(mark);
  if (at < 0) return line;
  return (
    <>
      {line.slice(0, at)}
      <strong style={{ color: '#a0f8d0', fontWeight: 700 }}>{mark}</strong>
      {line.slice(at + mark.length)}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-[28px] text-[13px]">
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
      <span className="text-right [overflow-wrap:anywhere]" style={{ color: 'var(--color-text-primary)' }}>
        {children}
      </span>
    </div>
  );
}

/** The rows the signature paid: our pool's fee and its split, Jupiter's route's venue fee, or an add's network cost. */
function FeeRows({ receipt }: { receipt: Receipt }) {
  const f = receipt.fee;
  if (f.kind === 'reading') {
    return (
      <p role="status" className="min-h-[28px] flex items-center text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
        Reading the fee from the transaction…
      </p>
    );
  }
  if (f.kind === 'unread') return <Row label={RECEIPT_WORDS.fee}>could not be read from the transaction</Row>;
  if (f.kind === 'add') return <Row label={RECEIPT_WORDS.noFee}>{f.network}</Row>;
  if (f.kind === 'site') return <Row label={RECEIPT_WORDS.toVenue}>{f.venue ?? 'nothing on this route'}</Row>;
  return (
    <>
      <Row label={RECEIPT_WORDS.fee}>{f.fee}</Row>
      <Row label={RECEIPT_WORDS.toLps}>{f.lps}</Row>
      <Row label={RECEIPT_WORDS.toVenue}>{f.venue}</Row>
      {f.creator && <Row label="To the pool's creator">{f.creator}</Row>}
    </>
  );
}
