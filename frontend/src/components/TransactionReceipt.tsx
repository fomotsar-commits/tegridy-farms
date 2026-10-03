import { useRef, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useChainId, useWaitForTransactionReceipt } from 'wagmi';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  TransactionReceiptContext,
  useTransactionReceiptState,
  type ReceiptData,
  type ReceiptType,
} from '../hooks/useTransactionReceipt';
import { formatTokenAmount } from '../lib/formatting';
import { getTxUrl, getChainLabel } from '../lib/explorer';
import { noteReplacement, receiptOutcome } from '../lib/txErrors';
import { pageArt } from '../lib/artConfig';
import { RECEIPT_COPY } from '../lib/copy';
import { VENUE } from '../lib/arrival';
import { getActiveBungalow } from '../lib/bungalows';
import { artImgProps } from '../lib/artSrcSet';
import { flattenModernColors } from '../lib/flattenModernColors';

// 'unconfirmed': the receipt wait gave up without reading a result. Not 'failed',
// which claims a revert nobody saw.
// 'replaced': the wallet cancelled or replaced it, so it did not happen as sent
// (the wait resolves with the REPLACEMENT's receipt; see lib/txErrors.ts).
type TxStatus = 'pending' | 'confirmed' | 'failed' | 'unconfirmed' | 'replaced';

/* ─── Sanitize text for rendered receipts ───
   F10: every value here is rendered as a JSX text node (and via html2canvas of
   that same DOM), so React already escapes it — HTML-entity-encoding the input
   only corrupted display ("Randy's Pool" → "Randy&#x27;s Pool"). We keep an
   identity + length cap (defensive against pathological metadata strings); the
   tx-hash validator below still enforces the strict 0x… format. There is no
   innerHTML path in this component — if one is ever added, escape THERE.
   The cap counts CODE POINTS: counted in UTF-16 units it could keep half of an
   emoji, and the share link's encodeURIComponent threw a URIError on that half,
   so Share to X did nothing. A half already in the value is dropped too. */
const MAX_RECEIPT_FIELD = 120;
export function sanitize(str: string | undefined): string {
  if (!str) return '';
  return wholeChars(str).slice(0, MAX_RECEIPT_FIELD).join('');
}

/**
 * `text` as code points with any half of a surrogate pair left out, so that
 * encodeURIComponent can always encode it. Array.from yields a lone half as an
 * element of its own. (Not a lookbehind regex: iOS Safari before 16.4 cannot
 * parse one, and that would break the whole bundle there.)
 */
function wholeChars(text: string): string[] {
  return Array.from(text).filter((ch) => {
    const unit = ch.charCodeAt(0);
    return ch.length === 2 || unit < 0xd800 || unit > 0xdfff;
  });
}

/** Sanitize and validate an Ethereum tx hash */
function sanitizeTxHash(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  // Tx hash must be 0x + 64 hex chars
  if (/^0x[a-fA-F0-9]{64}$/.test(hash)) return hash;
  return undefined;
}

/* ─── Provider ─── */

export function TransactionReceiptProvider({ children }: { children: ReactNode }) {
  const state = useTransactionReceiptState();
  return (
    <TransactionReceiptContext.Provider value={state}>
      {children}
      <AnimatePresence>
        {state.receiptData && (
          <TransactionReceiptOverlay
            receipt={state.receiptData}
            onClose={state.hideReceipt}
          />
        )}
      </AnimatePresence>
    </TransactionReceiptContext.Provider>
  );
}

/* ─── Type config ─── */

// Labels & verbs sourced from lib/copy.ts (Full Tegridy voice).
// Icons remain here since they're presentation-specific.
const TYPE_ICONS: Record<ReceiptType, string> = {
  swap:             '\u{1F504}',
  stake:            '\u{1F512}',
  unstake:          '\u{1F513}',
  claim:            '\u{1F4B0}',
  vote:             '\u{1F5F3}\u{FE0F}',
  bounty:           '\u{1F3AF}',
  lock:             '\u{26D3}\u{FE0F}',
  approve:          '\u{2705}',
  liquidity_add:    '\u{1F4A7}',
  liquidity_remove: '\u{1F4A8}',
  subscribe:        '\u{1F451}',
  claim_revenue:    '\u{1F4B0}',
};

const TYPE_CONFIG: Record<ReceiptType, { label: string; icon: string; verb: string }> = {
  swap:             { ...RECEIPT_COPY.swap,             icon: TYPE_ICONS.swap },
  stake:            { ...RECEIPT_COPY.stake,            icon: TYPE_ICONS.stake },
  unstake:          { ...RECEIPT_COPY.unstake,          icon: TYPE_ICONS.unstake },
  claim:            { ...RECEIPT_COPY.claim,            icon: TYPE_ICONS.claim },
  vote:             { ...RECEIPT_COPY.vote,             icon: TYPE_ICONS.vote },
  bounty:           { ...RECEIPT_COPY.bounty,           icon: TYPE_ICONS.bounty },
  lock:             { ...RECEIPT_COPY.lock,             icon: TYPE_ICONS.lock },
  approve:          { ...RECEIPT_COPY.approve,          icon: TYPE_ICONS.approve },
  liquidity_add:    { ...RECEIPT_COPY.liquidity_add,    icon: TYPE_ICONS.liquidity_add },
  liquidity_remove: { ...RECEIPT_COPY.liquidity_remove, icon: TYPE_ICONS.liquidity_remove },
  subscribe:        { ...RECEIPT_COPY.subscribe,        icon: TYPE_ICONS.subscribe },
  claim_revenue:    { ...RECEIPT_COPY.claim_revenue,    icon: TYPE_ICONS.claim_revenue },
};

/* ─── Detail rows per type ─── */

function buildDetailRows(receipt: ReceiptData): { label: string; value: string }[] {
  const { type, data } = receipt;
  const rows: { label: string; value: string }[] = [];

  switch (type) {
    case 'swap':
      if (data.fromAmount && data.fromToken && data.toAmount && data.toToken) {
        rows.push({ label: 'From', value: `${formatTokenAmount(data.fromAmount, 6)} ${sanitize(data.fromToken)}` });
        rows.push({ label: 'To', value: `${formatTokenAmount(data.toAmount, 6)} ${sanitize(data.toToken)}` });
      }
      if (data.rate) rows.push({ label: 'Rate', value: sanitize(data.rate) });
      if (data.fee) rows.push({ label: 'Fee', value: sanitize(data.fee) });
      if (data.slippage) rows.push({ label: 'Slippage', value: sanitize(data.slippage) });
      break;

    case 'stake':
    case 'lock':
      if (data.amount && data.token) {
        rows.push({ label: 'Amount', value: `${formatTokenAmount(data.amount, 4)} ${sanitize(data.token)}` });
      }
      if (data.lockDuration) rows.push({ label: 'Lock Duration', value: sanitize(data.lockDuration) });
      if (data.boost) rows.push({ label: 'Boost', value: `${sanitize(data.boost)}x` });
      if (data.estimatedAPR) rows.push({ label: 'Est. APR', value: `${sanitize(data.estimatedAPR)}%` });
      break;

    case 'unstake':
      if (data.amount && data.token) {
        rows.push({ label: 'Withdrawn', value: `${formatTokenAmount(data.amount, 4)} ${sanitize(data.token)}` });
      }
      break;

    case 'claim':
      if (data.rewardAmount && data.token) {
        rows.push({ label: 'Rewards', value: `${formatTokenAmount(data.rewardAmount, 6)} ${sanitize(data.token)}` });
      }
      break;

    case 'vote':
      if (data.poolName) rows.push({ label: 'Pool', value: sanitize(data.poolName) });
      if (data.voteWeight) rows.push({ label: 'Weight', value: sanitize(data.voteWeight) });
      break;

    case 'bounty':
      if (data.bountyTitle) rows.push({ label: 'Bounty', value: sanitize(data.bountyTitle) });
      if (data.bountyReward) rows.push({ label: 'Reward', value: `${sanitize(data.bountyReward)} ETH` });
      break;

    case 'approve':
      if (data.token) rows.push({ label: 'Token', value: sanitize(data.token) });
      if (data.spender) rows.push({ label: 'Spender', value: sanitize(data.spender) });
      if (data.amount) rows.push({ label: 'Amount', value: `${formatTokenAmount(data.amount, 4)} ${sanitize(data.token)}` });
      break;

    case 'liquidity_add':
      if (data.tokenA && data.amountA) rows.push({ label: 'Token A', value: `${formatTokenAmount(data.amountA, 6)} ${sanitize(data.tokenA)}` });
      if (data.tokenB && data.amountB) rows.push({ label: 'Token B', value: `${formatTokenAmount(data.amountB, 6)} ${sanitize(data.tokenB)}` });
      if (data.poolName) rows.push({ label: 'Pool', value: sanitize(data.poolName) });
      break;

    case 'liquidity_remove':
      if (data.tokenA && data.amountA) rows.push({ label: 'Token A', value: `${formatTokenAmount(data.amountA, 6)} ${sanitize(data.tokenA)}` });
      if (data.tokenB && data.amountB) rows.push({ label: 'Token B', value: `${formatTokenAmount(data.amountB, 6)} ${sanitize(data.tokenB)}` });
      if (data.poolName) rows.push({ label: 'Pool', value: sanitize(data.poolName) });
      if (data.percent) rows.push({ label: 'Removed', value: `${sanitize(data.percent)}%` });
      break;

    case 'subscribe':
      if (data.tier) rows.push({ label: 'Tier', value: sanitize(data.tier) });
      if (data.amount && data.token) rows.push({ label: 'Cost', value: `${formatTokenAmount(data.amount, 4)} ${sanitize(data.token)}` });
      if (data.duration) rows.push({ label: 'Duration', value: sanitize(data.duration) });
      break;

    case 'claim_revenue':
      if (data.rewardAmount && data.token) rows.push({ label: 'Revenue', value: `${formatTokenAmount(data.rewardAmount, 6)} ${sanitize(data.token)}` });
      if (data.epoch) rows.push({ label: 'Epoch', value: sanitize(data.epoch) });
      break;
  }

  return rows;
}

/* ─── Overlay ─── */

function TransactionReceiptOverlay({
  receipt,
  onClose,
}: {
  receipt: ReceiptData;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const chainId = useChainId();
  const config = TYPE_CONFIG[receipt.type];
  const rows = useMemo(() => buildDetailRows(receipt), [receipt]);
  // A11Y-R01: this overlay is a modal in every way except the semantics — it
  // covers the viewport at z-[9999] and dismisses on a backdrop click. Without
  // a dialog role, a focus trap and Escape, a keyboard or screen-reader user
  // who completes ANY transaction on the site is left tabbing the page behind
  // an opaque sheet with no announced way out. The trap/restore contract is the
  // shared one (hooks/useFocusTrap — the same logic ui/Modal runs); it lives on
  // a hook precisely so inline overlays like this one can adopt it without
  // being restructured onto Modal, which would re-chrome the card and drop the
  // gradient/art that html2canvas captures for "Copy Image".
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  const titleId = useId();

  // Capture timestamp once when the receipt is first shown (stable across re-renders).
  // If receipt data includes a blockTimestamp, prefer that over wall-clock time.
  const initialTimestampRef = useRef<string | null>(null);
  if (initialTimestampRef.current === null) {
    const dateSource = receipt.data.blockTimestamp
      ? new Date(Number(receipt.data.blockTimestamp) * 1000)
      : new Date();
    initialTimestampRef.current = dateSource.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }
  const timestamp = initialTimestampRef.current;

  const safeTxHash = sanitizeTxHash(receipt.data.txHash);
  const etherscanUrl = safeTxHash ? getTxUrl(chainId, safeTxHash) : null;

  // R040 M5: wait for 2-block finality before treating the tx as final. A
  // single-block confirmation can still revert under reorg; sharing or
  // declaring "Confirmed" before that has bitten users with a viral receipt
  // pointing at a reverted tx. Tri-state covers pending / confirmed / failed.
  //
  // 2026-09-17: wagmi's isError is a revert (it THROWS on a reverted receipt) OR
  // a receipt it never read, and every isError used to print "Failed" and disable
  // Share — a claim about a transaction nobody saw revert. receiptOutcome splits them.
  const rcptQuery = useWaitForTransactionReceipt({
    hash: safeTxHash as `0x${string}` | undefined,
    confirmations: 2,
    query: { enabled: !!safeTxHash },
    onReplaced: noteReplacement,
  });
  const {
    isSuccess: rcptOk, isReverted: rcptReverted, isReceiptUnreadable: rcptUnreadable,
    isReplaced: rcptReplaced, replacement: rcptReplacement,
  } = receiptOutcome(rcptQuery, safeTxHash ?? undefined);
  // With no recorded reason the replacement may be a speed-up: that is "can't
  // tell", not "did not happen".
  const rcptReplacedUnknown = rcptReplacement?.reason === 'unknown';
  const status: TxStatus = useMemo(() => {
    if (!safeTxHash) return 'confirmed'; // legacy / synthetic receipts
    if (rcptReverted) return 'failed';
    if (rcptUnreadable) return 'unconfirmed';
    if (rcptReplaced) return rcptReplacedUnknown ? 'unconfirmed' : 'replaced';
    if (rcptOk) return 'confirmed';
    return 'pending';
  }, [safeTxHash, rcptOk, rcptReverted, rcptUnreadable, rcptReplaced, rcptReplacedUnknown]);

  const chainLabel = getChainLabel(chainId);

  // Share-to-X gating: pending shows a confirmation modal; failed disables.
  const [showPendingShareModal, setShowPendingShareModal] = useState(false);
  // What to tell the poster after a share. An X web intent cannot carry an
  // attachment, so they paste the card, and we must not tell them to paste
  // something that is not there. `null` = nothing to say.
  const [shareHint, setShareHint] = useState<ShareHint | null>(null);

  // Escape closes the topmost layer only: the pending-share confirm sits INSIDE
  // the receipt card, so dismissing it must not also throw away the receipt.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showPendingShareModal) {
        setShowPendingShareModal(false);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showPendingShareModal, onClose]);

  /**
   * Render the card to a PNG. Null when it could not be produced at all, so a
   * caller never promises the user an image that does not exist.
   */
  const renderCardBlob = useCallback(async (): Promise<Blob | null> => {
    const node = cardRef.current;
    if (!node) return null;
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(node, {
        backgroundColor: '#060c1a',
        scale: 2,
        logging: false,
        useCORS: true,
        onclone: (_doc, el) => {
          // A render can start while the card is still sliding in: draw it at rest.
          el.style.opacity = '1';
          el.style.transform = 'none';
          // html2canvas throws on the oklab()/lab() colors Tailwind v4 computes
          // for the status badge, which failed every render of this card.
          flattenModernColors(el);
        },
      });
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/png');
      });
    } catch {
      return null;
    }
  }, []);

  // THE CARD IS RENDERED BEFORE ANYONE TAPS. The share sheet, the clipboard
  // write and the X window all need the tap's user gesture, and iOS Safari (and
  // Firefox, for the clipboard) refuses them once the click handler has awaited
  // anything, such as a lazy html2canvas import and a render. So the PNG is made
  // ahead, once per status because the badge is part of the picture, and a tap
  // only reads it. A tap that comes first starts the render itself.
  const shotRef = useRef<CardShot | null>(null);
  const cardShot = useCallback((): CardShot => {
    const have = shotRef.current;
    if (have && have.status === status) return have;
    const shot: CardShot = { status, png: renderCardBlob() };
    shot.png.then((blob) => { shot.blob = blob; });
    shotRef.current = shot;
    return shot;
  }, [status, renderCardBlob]);
  useEffect(() => {
    const t = setTimeout(cardShot, CARD_SHOT_DELAY_MS);
    return () => clearTimeout(t);
  }, [cardShot]);

  const performShare = useCallback(() => {
    // THE RECEIPT, AND WHERE IT HAPPENED (owner, 2026-10-02). This posted "Just
    // <verb> on @JungleBayAC!" plus hashtags and a bare Etherscan link: a slogan
    // that told a reader nothing. It now posts the receipt block people actually
    // post (see buildShareText) and keeps the @JungleBayAC mention and the room's
    // hashtag. THE HASHTAG FOLLOWS THE ROOM (2026-09-05): this component mounts
    // app-wide from AppLayout, so a hardcoded `#TOWELI` once tagged a BAYLA
    // staker's post with another resident's ticker. With nothing chosen the venue
    // tags itself, never a resident.
    const active = getActiveBungalow();
    const tag = active?.symbol ? `#${active.symbol}` : '#MemeticFinance';
    const text = buildShareText(receipt, config, rows, chainId, tag);
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    const shot = cardShot();

    // EVERYTHING BELOW RUNS INSIDE THE TAP: nothing is awaited before a call
    // that needs the gesture. Only outcomes are awaited, to word the hint.
    //
    // 1. Web Share, on a PHONE OR TABLET only (see isTouchFirst), when the
    //    platform takes FILES: the card goes to the share sheet as a real
    //    attachment. `canShare({ files })` is the only honest probe;
    //    `navigator.share` exists in browsers that silently drop files. It needs
    //    a finished PNG, which the pre-render gives.
    if (shot.blob && isTouchFirst()) {
      const file = new File([shot.blob], 'memetics-receipt.png', { type: 'image/png' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], text }).then(
          () => setShareHint(null), // the image went with it; nothing to tell them
          (err: unknown) => {
            // The gesture is spent either way, so a popup now would be blocked:
            // offer the intent as a link, which the user's own tap opens. A
            // CLOSED sheet gets the link too, because the usual reason to close
            // it is that X is not in it, and nothing else here reaches X.
            const closed = (err as { name?: string })?.name === 'AbortError';
            setShareHint({ image: null, xLink: intent, xLinkWhy: closed ? 'closed' : 'blocked' });
          },
        );
        return;
      }
    }

    // 2. Otherwise the X intent, with the card on the clipboard to paste. The
    //    write starts BEFORE the window opens, while this page still has focus.
    const copied = writeCardToClipboard(shot);
    const win = window.open(intent, '_blank');
    try {
      if (win) win.opener = null; // x.com gets no handle on this tab
    } catch { /* already cross-origin: nothing to sever */ }
    // A blocked popup comes back null: hand the user the link instead.
    const xLink = win === null ? intent : null;
    copied.then((ok) => setShareHint({ image: ok ? 'copied' : 'missing', xLink, xLinkWhy: 'blocked' }));
  }, [cardShot, receipt, config, rows, chainId]);

  const handleShareX = useCallback(() => {
    if (status === 'failed' || status === 'replaced') return; // disabled
    if (status === 'pending' || status === 'unconfirmed') {
      setShowPendingShareModal(true);
      return;
    }
    performShare();
  }, [status, performShare]);

  const handleCopyImage = useCallback(() => {
    const shot = cardShot();
    // Fallback text. `chainId` is in the dep list now - it is read here and was
    // missing, so after a chain switch this closure kept building the previous
    // chain's explorer link.
    const text = buildReceiptText(receipt, config, rows, timestamp, chainId);
    // Say what reached the clipboard, keeping any link to X already offered.
    const note = (image: ImageHint) =>
      setShareHint((h) => ({ image, xLink: h?.xLink ?? null, xLinkWhy: h?.xLinkWhy ?? 'blocked' }));

    // Every write starts inside the tap, like Share's; only outcomes are awaited.
    // When no picture can be copied at all (the render failed, or this browser
    // cannot put an image on the clipboard), the TEXT goes in now: Safari and
    // Firefox refuse a write that comes after an await.
    if (shot.blob === null || !canCopyImages()) {
      void writeText(text).then((ok) => note(ok ? 'text' : 'refused'));
      return;
    }
    void writeCardToClipboard(shot).then(async (ok) => {
      if (ok) {
        // An earlier "could not copy, use Copy Image" is no longer true.
        setShareHint((h) => (h ? { ...h, image: 'copied' } : h));
        return;
      }
      // The tap is over now. Chrome still takes text; Safari and Firefox refuse,
      // and then the hint says nothing was copied.
      note((await writeText(text)) ? 'text' : 'refused');
    });
  }, [cardShot, receipt, config, rows, timestamp, chainId]);

  return (
    <m.div
      className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Backdrop */}
      <m.div
        className="absolute inset-0"
        style={{ background: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(8px)' }}
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />

      {/* Card */}
      <m.div
        // Two consumers, one node: html2canvas captures this card for "Copy
        // Image", and the focus trap needs it as the dialog container.
        ref={(node: HTMLDivElement | null) => {
          cardRef.current = node;
          trapRef.current = node;
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-[400px] mx-4 rounded-2xl overflow-hidden outline-none"
        style={{
          background: 'linear-gradient(145deg, rgba(6,12,26,0.95) 0%, rgba(16,30,54,0.95) 100%)',
          border: '1px solid var(--color-purple-25)',
          boxShadow: '0 0 0 1px var(--color-purple-75), 0 24px 64px rgba(0,0,0,0.6), 0 0 48px var(--color-purple-75)',
        }}
        initial={{ opacity: 0, y: 40, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.97 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      >
        {/* Art-first background: LIGHT scrim + soft blur so the piece shows, with
            legibility of amounts/hashes carried by the text-shadow on the content
            below rather than a near-opaque scrim. */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          <img src={pageArt('tx-receipt', 0).src} {...artImgProps(pageArt('tx-receipt', 0).src)} alt="" loading="lazy" className="w-full h-full object-cover" style={{ filter: 'blur(1.5px) saturate(1.05)' }} />
          <div className="absolute inset-0" style={{ background: 'rgba(8, 14, 32, 0.55)' }} />
        </div>

        {/* Gradient top border accent */}
        <div
          className="absolute top-0 left-0 right-0 h-[2px] z-10"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, var(--color-purple-60) 30%, var(--color-purple-80) 50%, var(--color-purple-60) 70%, transparent 100%)',
          }}
        />

        {/* Content — text-shadow (inherited) keeps amounts/hashes crisp over art */}
        <div className="relative z-10 p-6" style={{ textShadow: '0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)' }}>
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="text-[18px]">{'\u{1F33F}'}</span>
              <span
                className="heading-luxury text-white text-[16px] tracking-wide"
                style={{ fontFamily: 'var(--font-family-heading)' }}
              >
                {VENUE.name}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="badge badge-primary text-[10px] px-2 py-0.5">
                {chainLabel}
              </div>
              <div
                role="status"
                aria-live="polite"
                className={`text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wide ${
                  status === 'confirmed'
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : status === 'failed' || status === 'replaced'
                      ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                      : status === 'unconfirmed'
                        ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        : 'bg-amber-500/15 text-amber-300 border border-amber-500/30 animate-pulse'
                }`}
              >
                {status === 'confirmed'
                  ? 'Confirmed'
                  : status === 'failed'
                    ? 'Reverted'
                    : status === 'replaced'
                      ? 'Replaced'
                      : status === 'unconfirmed'
                      ? 'Unconfirmed'
                      : 'Pending'}
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="accent-divider mb-5" />

          {/* Type label */}
          <div className="flex items-center gap-2 mb-5">
            <span className="text-[20px]">{config.icon}</span>
            <span
              id={titleId}
              className="stat-value text-[18px] text-white tracking-wider"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              {config.label}
            </span>
          </div>

          {/* Swap hero line */}
          {receipt.type === 'swap' && receipt.data.fromAmount && receipt.data.toAmount && (
            <div className="mb-5 px-4 py-3 rounded-xl" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <div className="flex items-center justify-center gap-2 md:gap-3 flex-wrap">
                <span className="stat-value text-[14px] md:text-[16px] text-white">
                  {formatTokenAmount(receipt.data.fromAmount, 6)} {sanitize(receipt.data.fromToken)}
                </span>
                <span className="text-white text-[14px] md:text-[16px]">{'\u{2192}'}</span>
                <span className="stat-value text-[14px] md:text-[16px] text-white">
                  {formatTokenAmount(receipt.data.toAmount, 6)} {sanitize(receipt.data.toToken)}
                </span>
              </div>
            </div>
          )}

          {/* Detail rows */}
          <div className="space-y-2.5 mb-5">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center justify-between">
                <span className="text-white text-[12px]">{row.label}</span>
                <span className="stat-value text-[13px] text-white">{row.value}</span>
              </div>
            ))}
          </div>

          {/* Tx Hash */}
          {etherscanUrl && (
            <div className="flex items-center justify-between mb-4">
              <span className="text-white text-[12px]">Tx Hash</span>
              <a
                href={etherscanUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="stat-value text-[12px] text-white hover:text-white transition-colors"
              >
                {safeTxHash!.slice(0, 6)}...{safeTxHash!.slice(-4)} {'\u{2197}'}
              </a>
            </div>
          )}

          {/* Timestamp */}
          <div className="text-white text-[11px] text-center mb-5">
            {timestamp}
          </div>

          {/* Divider */}
          <div className="accent-divider mb-4" />

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleShareX}
              disabled={status === 'failed' || status === 'replaced'}
              aria-disabled={status === 'failed' || status === 'replaced'}
              title={
                status === 'failed'
                  ? 'Cannot share — transaction reverted'
                  : status === 'replaced'
                    ? 'Cannot share: your wallet cancelled or replaced this transaction, so it did not happen'
                  : status === 'pending'
                    ? 'Tx still pending — confirm before sharing'
                    : status === 'unconfirmed'
                      ? "We couldn't read this tx's result — check the explorer before sharing"
                      : 'Share this receipt to X'
              }
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: 'var(--color-purple-75)',
                border: '1px solid var(--color-purple-25)',
                color: '#ffffff',
              }}
            >
              Share to X
            </button>
            <button
              onClick={handleCopyImage}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold cursor-pointer transition-all"
              style={{
                background: 'rgba(0,0,0,0.55)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.6)',
              }}
            >
              Copy Image
            </button>
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold cursor-pointer transition-all"
              style={{
                background: 'rgba(0,0,0,0.55)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.78)',
              }}
            >
              Close
            </button>
          </div>

          {/* data-html2canvas-ignore: the card is re-rendered when its status
              changes, and this note is not part of the receipt. */}
          {shareHint && (
            <div
              data-testid="receipt-share-hint"
              data-html2canvas-ignore="true"
              className="text-[11px] text-center mt-3 space-y-1"
            >
              {shareHint.image && (
                <p style={{ color: shareHint.image === 'copied' ? 'rgba(255,255,255,0.62)' : 'rgba(255,178,55,0.85)' }}>
                  {IMAGE_HINT[shareHint.image]}
                </p>
              )}
              {shareHint.xLink && (
                <p style={{ color: shareHint.xLinkWhy === 'closed' ? 'rgba(255,255,255,0.62)' : 'rgba(255,178,55,0.85)' }}>
                  {shareHint.xLinkWhy === 'closed' ? 'X not in the share menu?' : 'Could not open the share window.'}{' '}
                  <a href={shareHint.xLink} target="_blank" rel="noopener noreferrer" className="underline text-white">
                    Post it on X
                  </a>
                </p>
              )}
            </div>
          )}

          {/* R040 M5: pending-share warning. Modal lives inside the card so a
              tap on backdrop dismisses just the modal, not the receipt. */}
          {showPendingShareModal && (
            <div
              data-html2canvas-ignore="true"
              role="alertdialog"
              aria-labelledby="pending-share-title"
              aria-describedby="pending-share-desc"
              className="absolute inset-0 z-20 flex items-center justify-center px-5"
              style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}
              onClick={() => setShowPendingShareModal(false)}
            >
              <div
                className="w-full max-w-[300px] rounded-xl p-4"
                style={{ background: 'rgba(13,21,48,0.98)', border: '1px solid rgba(245,158,11,0.4)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <p id="pending-share-title" className="text-[13px] text-amber-300 font-semibold mb-2">
                  {status === 'unconfirmed' ? "Couldn't confirm this tx" : 'Tx still pending'}
                </p>
                <p id="pending-share-desc" className="text-[12px] text-white/75 mb-4">
                  {status === 'unconfirmed'
                    ? "We couldn't read its result, so we can't tell whether it went through. Check the explorer before sharing."
                    : 'Wait for confirmation before sharing — pending transactions can revert under reorg.'}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowPendingShareModal(false)}
                    className="flex-1 py-2 rounded-lg text-[12px] font-semibold bg-white/10 hover:bg-white/15 text-white transition-colors"
                  >
                    Wait
                  </button>
                  <button
                    onClick={() => { setShowPendingShareModal(false); performShare(); }}
                    className="flex-1 py-2 rounded-lg text-[12px] font-semibold bg-amber-600/80 hover:bg-amber-600 text-white transition-colors"
                  >
                    Share anyway
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </m.div>
    </m.div>
  );
}

/* ─── Sharing ─── */

/** What reached the clipboard: the card, nothing after Share ('missing'), the
 *  receipt as text, or nothing after Copy Image ('refused'). */
type ImageHint = 'copied' | 'missing' | 'text' | 'refused';

const IMAGE_HINT: Record<ImageHint, string> = {
  copied: 'Receipt image copied. Paste it into the post.',
  missing: 'Could not copy the receipt image. Use Copy Image, then paste.',
  text: 'The receipt was copied as text, because the image could not be copied.',
  refused: 'Could not copy the receipt. This browser did not allow it.',
};

/** What the poster is told after a share or a copy: what reached the clipboard
 *  (null when no write was involved), and the X intent as a plain link when no
 *  X window opened for them, because it was blocked or the share sheet closed. */
type ShareHint = { image: ImageHint | null; xLink: string | null; xLinkWhy: 'blocked' | 'closed' };

/**
 * TOUCH-FIRST DEVICES ONLY GET THE SHARE SHEET (owner, 2026-10-02). Desktop
 * Chrome and Edge on Windows, and Safari 15+ on macOS, also say yes to
 * canShare({ files }), but X is rarely in a desktop share sheet, and closing it
 * left the poster no way to X. On a phone the X app is a share target, so the
 * sheet is where X is.
 *
 * `(pointer: coarse)` asks about the PRIMARY pointer: a phone or tablet held in
 * the hand. A touchscreen laptop driven by its trackpad is `fine` and gets the X
 * window, which is right for it (`any-pointer: coarse` would match it, and is
 * not used). No matchMedia at all reads as a desktop: the X window is the path
 * that works everywhere.
 */
function isTouchFirst(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Whether this browser can put a picture on the clipboard at all. */
function canCopyImages(): boolean {
  return typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function';
}

/** Put `text` on the clipboard; true only if it landed. Call inside the tap. */
function writeText(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch {
    return Promise.resolve(false); // no async clipboard here
  }
}

/** The card as a PNG for one status. `blob` is undefined while it renders and
 *  null when the render failed. */
type CardShot = { status: TxStatus; png: Promise<Blob | null>; blob?: Blob | null };

/** Wait out the card's entrance spring (about half a second) before rendering
 *  it, so the render does not compete with the animation for the main thread.
 *  Correctness does not depend on it: the render draws the card at rest. */
const CARD_SHOT_DELAY_MS = 600;

/**
 * Start putting the card on the clipboard and resolve true only if it landed.
 * Call it synchronously inside the tap: a ClipboardItem takes a PROMISE of the
 * PNG, so the write begins within the gesture even while the render finishes.
 */
function writeCardToClipboard(shot: CardShot): Promise<boolean> {
  if (shot.blob === null) return Promise.resolve(false); // the render already failed
  let png: Blob | Promise<Blob>;
  if (shot.blob) {
    png = shot.blob;
  } else {
    png = shot.png.then((b) => b ?? Promise.reject(new Error('no receipt image')));
    // A clipboard that refuses before reading the item leaves this rejection
    // with no one to handle it; the outcome is reported through the write.
    png.catch(() => undefined);
  }
  try {
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false); // no async clipboard or ClipboardItem here
  }
}

const TWEET_LIMIT = 280;
/** X rewrites every link to a t.co link of exactly this length, whatever the original. */
const TCO_LEN = 23;
const MENTION = '@JungleBayAC';
/** Text X may turn into a link: a bare domain such as MEMETICS.FINANCE. */
const LINKABLE = /[\p{L}\p{N}]\.\p{L}{2,}/gu;

/**
 * X's count for `text`, never below X's own. X weighs characters (twitter-text
 * config v3): U+0000-U+10FF and three punctuation ranges count 1, everything
 * else counts 2, so the box-drawing rule costs double and so does CJK. Anything
 * X may link is charged 23 on top of its own characters: a slight over-count
 * (MEMETICS.FINANCE is linked, so X counts 23 for it), never an under-count.
 */
function xLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const single =
      cp <= 0x10ff ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    n += single ? 1 : 2;
  }
  return n + (text.match(LINKABLE)?.length ?? 0) * TCO_LEN;
}

/** Cut `text` to fit `budget` on X's count, ending in an ellipsis. */
function clipToX(text: string, budget: number): string {
  const chars = Array.from(text);
  while (chars.length > 0 && xLength(`${chars.join('')}\u{2026}`) > budget) chars.pop();
  return `${chars.join('').trimEnd()}\u{2026}`;
}

/**
 * The post sent to X: the receipt block people actually post (venue, rule,
 * action, the numbers, the tx link), then the @JungleBayAC mention and the
 * room's hashtag on the last line.
 *
 * The block is the SAME shape as `buildReceiptText` below, because the
 * venue's timeline is full of pasted receipts and a reader learns more from
 * labelled numbers than from any slogan. No timestamp: X stamps the post.
 *
 * It must fit X's 280 as X counts it, or the composer refuses to send. The
 * receipt gives way and the mention and tag never do: first the decorative
 * rule goes (it costs 60 on X's count), then detail rows from the end (the
 * first figure stays), and only then is what is left clipped. The tx link is
 * never cut either, so it always resolves.
 */
function buildShareText(
  receipt: ReceiptData,
  config: { label: string },
  rows: { label: string; value: string }[],
  chainId: number | undefined,
  tag: string,
): string {
  const validHash = sanitizeTxHash(receipt.data.txHash);
  const txUrl = validHash ? getTxUrl(chainId, validHash) : null;
  const tx = txUrl ? `\n\nTx: ${txUrl}` : '';
  const footer = `\n\n${MENTION} ${tag}`;
  // The link is counted at its POSTED length, not its literal one.
  const budget = TWEET_LIMIT - (txUrl ? xLength('\n\nTx: ') + TCO_LEN : 0) - xLength(footer);

  const venue = `\u{1F33F} ${VENUE.name}`;
  let rule = ['\u{2501}'.repeat(30)];
  const body = rows.map((r) => `${r.label}: ${r.value}`);
  const block = () =>
    [venue, ...rule, '', config.label, ...(body.length > 0 ? ['', ...body] : [])].join('\n');

  if (xLength(block()) > budget) rule = [];
  while (body.length > 1 && xLength(block()) > budget) body.pop();
  let text = block();
  if (xLength(text) > budget) text = clipToX(text, budget);
  // Every field is already whole (sanitize); this keeps the link encodable
  // whatever a later field brings, since a URIError makes Share do nothing.
  return wholeChars(text + tx + footer).join('');
}

/* ─── Text fallback for clipboard ─── */

function buildReceiptText(
  receipt: ReceiptData,
  config: { label: string },
  rows: { label: string; value: string }[],
  timestamp: string,
  chainId?: number,
): string {
  const lines = [
    `\u{1F33F} ${VENUE.name}`,
    '━'.repeat(30),
    '',
    config.label,
    '',
  ];
  for (const row of rows) {
    lines.push(`${row.label}: ${row.value}`);
  }
  const validHash = sanitizeTxHash(receipt.data.txHash);
  if (validHash) {
    lines.push('');
    lines.push(`Tx: ${getTxUrl(chainId, validHash)}`);
  }
  lines.push('');
  lines.push(timestamp);
  return lines.join('\n');
}
