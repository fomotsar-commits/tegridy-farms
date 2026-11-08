import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RECEIPT_WORDS } from '../lib/arrival';
import { clockText, closeReceipt, useReceipt, type Receipt } from '../lib/receipt';
import { useScreenMove } from '../lib/screenMove';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { headTail } from './ui/CoinName';
import { tick } from '../lib/tick';
import { FlameCatch, type FlameState } from './FlameCatch';
import { FloorHead } from './FloorHead';
import { hueOf, type FloorState } from '../lib/floorMoment';

/** The veil first, then the card rises (its 300 ms transition). */
const RISE_AFTER_MS = 250;
/** The catch begins the moment the card is up: the rise's own 300 ms (index.css counts the same). */
const CATCH_AFTER_MS = 300;
/** An add's flash turns the card's edge white this long, then it holds the token's hue (answer thirty-two). */
const FLASH_EDGE_MS = 120;
/** Each of the floor's three beats flares the card's edge this long. */
const BEAT_EDGE_MS = 240;

/**
 * The catch is once a landing: the signature it last caught for. Bayla's Receipt raises the card
 * again lit, still. An add's moment marks it at its landing, so a card closed before then plays again.
 */
let caughtFor: string | null = null;

/**
 * The receipt card (island answer twenty-five, screen 3, build 6): one card over the page the
 * action landed on. What was done, the fee and where it went (read from the signature:
 * lib/solana/receiptRead.ts), what it did to the wallet's clock, one green button that hands
 * over the island's card, and Back to the room. The toast is for errors only. On a buy's or a
 * sale's card, the island's flame catches in the ring the moment the card is up (answer
 * twenty-nine: FlameCatch.tsx). An add's card has a head instead: the pool, where the flash
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
  // Caught already when this card was raised (Bayla's Receipt): lit at once, nothing moves.
  const [caughtBefore] = useState(() => caughtFor === receipt.signature);
  // A sale never lights: the ember sits in the ring, steady.
  const flame: FlameState = receipt.action === 'sold' ? 'ember' : caughtBefore ? 'lit' : risen ? 'catching' : 'ember';
  // An add's head is the pool, never a flame (island answer thirty-two): the moment plays once per
  // signature, and a card raised again after its landing opens at rest.
  const isAdd = receipt.action === 'added';
  const floor: FloorState = caughtBefore ? 'lit' : 'playing';
  // From the flash on the card's edge holds the token's hue; the line under the title shows from the landing.
  const [lit, setLit] = useState(caughtBefore);
  const [landed, setLanded] = useState(caughtBefore);
  // The flash's white edge and each beat's flare: a class on the card, let go by a timer.
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
  // An add's card is about 680 px tall: on a shorter screen the focus trap's focus scrolls the
  // layer to the card's foot, and the head, where the moment plays, would be off the top. The
  // moment the card is up, the layer goes back to its top.
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isAdd && risen && layerRef.current) layerRef.current.scrollTop = 0;
  }, [isAdd, risen]);
  // The catch: one tick as the flame grows out of the ember, once per signature. A card closed
  // before it has not caught, and catches when raised again. An add's ticks are its moment's.
  useEffect(() => {
    if (isAdd || flame !== 'catching') return;
    const t = window.setTimeout(() => {
      if (caughtFor === receipt.signature) return;
      caughtFor = receipt.signature;
      tick();
    }, CATCH_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [isAdd, flame, receipt.signature]);
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
          // An add's card is about 160 px taller (its head): centred the same way.
          marginTop: `clamp(16px, calc((100dvh - ${isAdd ? 680 : 520}px) / 2), 172px)`,
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
              onLanded={() => {
                setLanded(true);
                caughtFor = receipt.signature;
              }}
              onBeat={() => flare('receipt-beat', BEAT_EDGE_MS)}
            />
          ) : (
            <div className="receipt-floor" aria-hidden="true" />
          )
        ) : (
          // The 56 px ring in the venue's green: the ember, and the flame that catches in it.
          <FlameCatch state={flame} />
        )}
        {/* An add's title clears the ring's lower half, which hangs 28 px below the head. */}
        <h2 id={titleId} className={`${isAdd ? 'mt-10' : 'mt-4'} text-center text-white text-[24px] leading-[30px]`} style={{ fontFamily: 'var(--font-family-heading)', fontWeight: 800 }} data-testid="receipt-title">
          {title}
        </h2>
        {receipt.under && (
          <p className="mt-1 text-center text-[14px]" style={{ color: 'var(--color-text-secondary)' }} data-testid="receipt-under">
            {receipt.under}
          </p>
        )}
        {isAdd && (
          // Always in the layout (nothing below it moves), shown from the landing.
          <p className="receipt-floor-line mt-1 text-center text-[14px]" data-on={landed ? '1' : '0'} data-testid="receipt-floor-line" style={{ color: 'var(--color-text-secondary)' }}>
            {RECEIPT_WORDS.floor(receipt.coin.symbol)}
          </p>
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

        {/* The one green button: the island's card for this wallet, the object that travels. */}
        <a
          href={RECEIPT_WORDS.cardUrl(receipt.wallet)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={tick}
          className="btn-primary mt-5 w-full inline-flex items-center justify-center"
          style={{ height: 52, fontSize: 15, fontWeight: 700 }}
          data-testid="receipt-share"
        >
          {RECEIPT_WORDS.share}
        </a>
        <button type="button" onClick={close} className="mt-1 w-full min-h-[44px] text-[13px] font-semibold" style={{ color: '#c4b5fd' }} data-testid="receipt-back">
          {RECEIPT_WORDS.back}
        </button>
      </div>
    </div>,
    document.body,
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
