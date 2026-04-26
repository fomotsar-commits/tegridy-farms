import { useRef, useCallback, useMemo, useState, type ReactNode } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useChainId, useWaitForTransactionReceipt } from 'wagmi';
import {
  TransactionReceiptContext,
  useTransactionReceiptState,
  type ReceiptData,
  type ReceiptType,
} from '../hooks/useTransactionReceipt';
import { formatTokenAmount } from '../lib/formatting';
import { getTxUrl, getChainLabel } from '../lib/explorer';
import { RECEIPT_COPY } from '../lib/copy';

type TxStatus = 'pending' | 'confirmed' | 'failed';

/* ─── Sanitize text to prevent HTML/script injection in rendered receipts ─── */
function sanitize(str: string | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
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
  const { data: rcpt, isSuccess: rcptOk, isError: rcptErr } = useWaitForTransactionReceipt({
    hash: safeTxHash as `0x${string}` | undefined,
    confirmations: 2,
    query: { enabled: !!safeTxHash },
  });
  const status: TxStatus = useMemo(() => {
    if (!safeTxHash) return 'confirmed'; // legacy / synthetic receipts
    if (rcptErr) return 'failed';
    if (rcpt?.status === 'reverted') return 'failed';
    if (rcptOk && rcpt?.status === 'success') return 'confirmed';
    return 'pending';
  }, [safeTxHash, rcptOk, rcptErr, rcpt]);

  const chainLabel = getChainLabel(chainId);

  // Share-to-X gating: pending shows a confirmation modal; failed disables.
  const [showPendingShareModal, setShowPendingShareModal] = useState(false);

  const performShare = useCallback(() => {
    const verb = config.verb;
    const text = `Just ${verb} on @TegridyFarms! \u{1F33F} #TOWELI #DeFi`;
    const url = etherscanUrl ?? 'https://tegridyfarms.io';
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      '_blank',
    );
  }, [config.verb, etherscanUrl]);

  const handleShareX = useCallback(() => {
    if (status === 'failed') return; // disabled
    if (status === 'pending') {
      setShowPendingShareModal(true);
      return;
    }
    performShare();
  }, [status, performShare]);

  const handleCopyImage = useCallback(async () => {
    if (!cardRef.current) return;
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: '#060c1a',
        scale: 2,
        logging: false,
        useCORS: true,
      });
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob }),
          ]);
        } catch {
          // Fallback: copy receipt as text
          const text = buildReceiptText(receipt, config, rows, timestamp, chainId);
          await navigator.clipboard.writeText(text);
        }
      }, 'image/png');
    } catch {
      // Fallback: copy receipt as text
      const text = buildReceiptText(receipt, config, rows, timestamp, chainId);
      await navigator.clipboard.writeText(text);
    }
  }, [receipt, config, rows, timestamp]);

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
        ref={cardRef}
        className="relative w-full max-w-[400px] mx-4 rounded-2xl overflow-hidden"
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
        {/* Gradient top border accent */}
        <div
          className="absolute top-0 left-0 right-0 h-[2px]"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, var(--color-purple-60) 30%, var(--color-purple-80) 50%, var(--color-purple-60) 70%, transparent 100%)',
          }}
        />

        {/* Content */}
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="text-[18px]">{'\u{1F33F}'}</span>
              <span
                className="heading-luxury text-white text-[16px] tracking-wide"
                style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
              >
                Tegridy Farms
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
                    : status === 'failed'
                      ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                      : 'bg-amber-500/15 text-amber-300 border border-amber-500/30 animate-pulse'
                }`}
              >
                {status === 'confirmed' ? 'Confirmed' : status === 'failed' ? 'Failed' : 'Pending'}
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="accent-divider mb-5" />

          {/* Type label */}
          <div className="flex items-center gap-2 mb-5">
            <span className="text-[20px]">{config.icon}</span>
            <span
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
              disabled={status === 'failed'}
              aria-disabled={status === 'failed'}
              title={
                status === 'failed'
                  ? 'Cannot share — transaction reverted'
                  : status === 'pending'
                    ? 'Tx still pending — confirm before sharing'
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
                color: 'rgba(255,255,255,0.4)',
              }}
            >
              Close
            </button>
          </div>

          {/* R040 M5: pending-share warning. Modal lives inside the card so a
              tap on backdrop dismisses just the modal, not the receipt. */}
          {showPendingShareModal && (
            <div
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
                  Tx still pending
                </p>
                <p id="pending-share-desc" className="text-[12px] text-white/75 mb-4">
                  Wait for confirmation before sharing — pending transactions can revert under reorg.
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

/* ─── Text fallback for clipboard ─── */

function buildReceiptText(
  receipt: ReceiptData,
  config: { label: string },
  rows: { label: string; value: string }[],
  timestamp: string,
  chainId?: number,
): string {
  const lines = [
    '\u{1F33F} Tegridy Farms',
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
