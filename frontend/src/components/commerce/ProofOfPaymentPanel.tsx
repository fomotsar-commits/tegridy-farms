import { useMemo, useState } from 'react';
import { formatScaled } from '../../lib/tax/csv';
import { getTxUrl } from '../../lib/explorer';
import type { Invoice } from '../../lib/commerce/invoice';
import { settlementStandingText, TX_HASH_RE } from '../../lib/commerce/settlement';
import { previouslyAcceptedFor, recordAccepted } from '../../lib/commerce/acceptedHashes';
import { useReceiptProof } from '../../hooks/useReceiptProof';

// Reading a transaction hash back out of the chain and saying what it proves.
//
// ─── THE SENTENCE THIS PANEL EXISTS TO REFUSE TO WRITE ──────────────────────
//
// "Paid ✓". A merchant releases goods against that word, so every claim here is
// qualified by what was actually read: which chain, which block, at what chain
// time, and — the limit that matters most — that an ERC-20 transfer carries no
// invoice reference, so this receipt is bound to (token, payee, amount, time)
// and NOT to the invoice id. The same hash would confirm any invoice of this
// merchant for this amount. That is disclosed in words, and the merchant's own
// browser-local ledger flags a hash it has seen before.
//
// ─── `from` IS THE FIRST LINE ───────────────────────────────────────────────
//
// Because it is the only field on a confirmed transfer that a merchant can
// compare against something they already know. It comes before the standing
// text on purpose.

export interface ProofOfPaymentPanelProps {
  invoice: Invoice;
  /** A hash carried by a proof link. When null the panel offers an input instead. */
  txHash?: `0x${string}` | null;
  /**
   * Set on the merchant's own tab. Enables the accepted-hash ledger and the
   * accept control; null on the buyer's side, where the ledger would be a
   * different browser's and mean nothing.
   */
  merchant?: `0x${string}` | null;
}

const CARD = 'rounded-xl border border-white/15 bg-white/[0.02] p-4';

export function ProofOfPaymentPanel({ invoice, txHash = null, merchant = null }: ProofOfPaymentPanelProps) {
  const [typed, setTyped] = useState('');
  const [accepted, setAccepted] = useState<{ kind: 'idle' } | { kind: 'saved' } | { kind: 'refused' }>({
    kind: 'idle',
  });

  const trimmed = typed.trim();
  // Gate BEFORE any RPC: a hash-shaped guard here is the difference between one
  // read and a request per keystroke of something that is not a hash.
  const hash: `0x${string}` | null =
    txHash ?? (TX_HASH_RE.test(trimmed) ? (trimmed as `0x${string}`) : null);

  const proof = useReceiptProof(invoice, hash);

  const alreadyFor = useMemo(
    () => (merchant && hash ? previouslyAcceptedFor(merchant, invoice.chainId, hash) : null),
    // `accepted` is in the deps because writing a row must change what this reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [merchant, hash, invoice.chainId, accepted],
  );

  const owed = `${formatScaled(invoice.settleAmount, invoice.settleDecimals)} ${invoice.settleSymbol}`;

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-white">
        {txHash ? 'Proof of payment' : 'Verify a payment'}
      </h2>
      <p className="mt-1 text-[12px] leading-relaxed text-white/60">
        The receipt is read from chain {invoice.chainId} in this browser. Nothing here is cached and no server is
        asked — reload to re-read.
      </p>

      {txHash === null ? (
        <label htmlFor="proof-hash" className="mt-3 block text-[11px] uppercase tracking-wide text-white/55">
          Transaction hash
          <input
            id="proof-hash"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setAccepted({ kind: 'idle' });
            }}
            placeholder="0x…"
            spellCheck={false}
            className="mt-1 block min-h-11 w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 font-mono text-xs text-white"
          />
        </label>
      ) : null}

      {txHash === null && trimmed.length > 0 && hash === null ? (
        <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">
          That is not a 32-byte transaction hash, so nothing was looked up. This is a statement about what was
          typed, not about any payment.
        </p>
      ) : null}

      {hash !== null ? (
        <div className="mt-3 space-y-3">
          <p className="break-all font-mono text-[12px] text-white/85">{hash}</p>

          {proof.status === 'reading' || proof.status === 'idle' ? (
            <p className="text-[13px] text-white/70" aria-busy="true">
              Reading the receipt from chain {invoice.chainId}…
            </p>
          ) : null}

          {proof.status === 'unread' ? (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-3">
              <p className="text-[13px] leading-relaxed text-white/85">{proof.detail}</p>
            </div>
          ) : null}

          {proof.status === 'judged' && proof.verdict.verification === 'chain-confirmed' ? (
            <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-3">
              <p className="break-all text-[13px] font-medium text-white">From {proof.verdict.from}</p>
              <p className="mt-2 text-[13px] leading-relaxed text-white/85">
                {settlementStandingText('chain-confirmed')}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-white/60">
                Read from chain {invoice.chainId}
                {proof.blockNumber !== null ? ` at block ${proof.blockNumber.toString()}` : ''}
                {proof.verdict.minedAt !== null
                  ? ` (chain time ${new Date(proof.verdict.minedAt * 1000).toISOString()})`
                  : ' — block time not read, so nothing here says WHEN it was mined'}
                .
              </p>
              {proof.verdict.afterExpiry ? (
                <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">
                  Mined after the invoice expired — the merchant decides whether a late payment counts.
                </p>
              ) : null}
              <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">
                This receipt is not bound to invoice {invoice.id}. An ERC-20 transfer carries no invoice
                reference, so this same hash would confirm any invoice of yours for {owed}. Accept each hash
                once and compare the sender.
              </p>
            </div>
          ) : null}

          {proof.status === 'judged' && proof.verdict.verification === 'chain-refuted' ? (
            <div className="rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-3">
              <p className="text-[13px] leading-relaxed text-white/85">
                {settlementStandingText('chain-refuted')}
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-white/75">{proof.verdict.detail}</p>
            </div>
          ) : null}

          {merchant && alreadyFor !== null ? (
            <p className="rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-3 text-[13px] leading-relaxed text-white/85">
              Already accepted for invoice {alreadyFor}. A hash counted twice is one payment counted twice.
            </p>
          ) : null}

          {merchant && alreadyFor === null && proof.status === 'judged' && proof.verdict.verification === 'chain-confirmed' ? (
            <div>
              <button
                type="button"
                onClick={() =>
                  setAccepted(
                    recordAccepted(merchant, invoice.chainId, hash, invoice.id, Math.floor(Date.now() / 1000))
                      ? { kind: 'saved' }
                      : { kind: 'refused' },
                  )
                }
                className="btn-secondary min-h-11 px-4 py-1.5 text-[12px]"
              >
                Accept for invoice {invoice.id}
              </button>
              {accepted.kind === 'refused' ? (
                <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">
                  This browser refused the write, so nothing was recorded. Private-mode and full-storage
                  browsers both do this — write the hash down yourself.
                </p>
              ) : null}
              <p className="mt-2 text-[11px] leading-relaxed text-white/50">
                The accepted-hash list lives in THIS browser only. It is not shared with any other device of
                yours, it is gone with a cleared cache, and its silence is not evidence a hash is new.
              </p>
            </div>
          ) : null}

          <a
            href={getTxUrl(invoice.chainId, hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center text-[12px] text-white/70 underline"
          >
            Open this transaction in a block explorer
          </a>
        </div>
      ) : null}
    </section>
  );
}

export default ProofOfPaymentPanel;
