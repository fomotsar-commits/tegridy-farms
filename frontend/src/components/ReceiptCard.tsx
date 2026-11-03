import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RECEIPT_WORDS } from '../lib/arrival';
import { clockText, closeReceipt, useReceipt, type Receipt } from '../lib/receipt';
import { useScreenMove } from '../lib/screenMove';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useConfetti } from '../hooks/useConfetti';
import { headTail } from './ui/CoinName';
import { tick } from '../lib/tick';

/** How long the card waits for the confetti to start before it rises: the last pieces may still be falling. */
const RISE_AFTER_MS = 250;

/**
 * The receipt card (island answer twenty-five, screen 3, build 6): one card over the page the
 * action landed on, after the confetti the venue already has. What was done, the fee and where
 * it went (read from the signature: lib/solana/receiptRead.ts), what it did to the wallet's
 * clock, one green button that hands over the island's card, and Back to the room. The toast
 * is for errors only.
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
  const { fire } = useConfetti();
  const [risen, setRisen] = useState(false);
  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (fired.current === receipt.signature) return;
    fired.current = receipt.signature;
    fire();
    const t = window.setTimeout(() => setRisen(true), RISE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [receipt.signature, fire]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeReceipt();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const cardRef = useFocusTrap<HTMLDivElement>(true);
  const close = () => {
    tick();
    closeReceipt();
  };
  const title = receipt.title ?? (receipt.action === 'added' ? `Added SOL + ${receipt.coin.symbol}` : `${receipt.action === 'sold' ? 'Sold' : 'Bought'} ${receipt.coin.symbol}`);

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-start justify-center overflow-y-auto px-4" data-testid="receipt-layer">
      <div aria-hidden="true" className="fixed inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} onClick={close} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="receipt-card"
        className="relative w-full max-w-[358px] my-4 outline-none motion-safe:transition-[opacity,transform] motion-safe:duration-300"
        style={{
          marginTop: 'clamp(16px, calc((100dvh - 520px) / 2), 172px)',
          background: 'var(--color-bg-surface)',
          borderRadius: 20,
          border: '1px solid rgba(139,92,246,0.45)',
          padding: '24px 20px 12px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.65)',
          opacity: risen ? 1 : 0,
          transform: risen ? 'none' : 'translateY(16px)',
        }}
      >
        {/* The check: a 56 px ring in the venue's green, a 28 px check inside, lit. */}
        <div
          aria-hidden="true"
          className="mx-auto flex items-center justify-center rounded-full"
          style={{ width: 56, height: 56, border: '2px solid var(--color-kyle)', boxShadow: '0 0 24px rgba(76,175,80,0.35)' }}
        >
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--color-kyle)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 14.5l4.5 4.5L21 9.5" />
          </svg>
        </div>
        <h2 id={titleId} className="mt-4 text-center text-white text-[24px] leading-[30px]" style={{ fontFamily: 'var(--font-family-heading)', fontWeight: 800 }} data-testid="receipt-title">
          {title}
        </h2>
        {receipt.under && (
          <p className="mt-1 text-center text-[14px]" style={{ color: 'var(--color-text-secondary)' }} data-testid="receipt-under">
            {receipt.under}
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
            className="mt-4 flex items-center gap-3 min-h-[48px] px-4 py-2 rounded-xl text-[14px] font-semibold"
            style={{ background: 'rgba(76,175,80,0.12)', border: '1px solid rgba(76,175,80,0.25)', color: 'var(--color-text-primary)' }}
          >
            <span aria-hidden="true" className="shrink-0 rounded-full" style={{ width: 6, height: 6, background: 'var(--color-kyle)' }} />
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
