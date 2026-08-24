import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount, useChainId, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { ERC20_ABI } from '../../lib/contracts';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { formatScaled } from '../../lib/tax/csv';
import { useCheckoutInvoice } from '../../hooks/useCheckoutInvoice';
import { useCheckoutQuote } from '../../hooks/useCheckoutQuote';
import { recordSettlement } from '../../lib/commerce/store';
import { canSign } from '../../lib/commerce/settlement';
import { SettlementDisclosure } from './SettlementDisclosure';

// The buyer's side of a payment link.
//
// ─── WHAT THIS WIDGET SIGNS, AND WHAT IT ONLY DESCRIBES ─────────────────────
//
// It signs ONE transaction: the exact transfer of the invoiced amount to the
// merchant. That is the leg that moves the merchant's money and it is the leg
// whose figure must be exact, so it is the leg this surface takes
// responsibility for.
//
// It does NOT execute the swap. lib/aggregator.ts is quote-only on this
// deployment (useSwap.ts routes an "aggregator" selection through the venue's
// own on-chain pool, not through the aggregator's calldata), so a checkout that
// swapped for you would be filling at a price other than the one on screen. The
// swap leg is therefore a sized, priced instruction the buyer carries to the
// trade surface, and the widget says so in as many words. Every refusal from
// buildSettlementPlan still applies first — if no route can cover the merchant's
// exact amount, nobody is sent anywhere.
//
// ─── THE PAY BUTTON APPEARS ONLY WHEN THE MONEY IS ALREADY THERE ────────────
//
// The transfer is offered when the connected wallet's settlement-asset balance
// covers the invoice, and not before. An offered-then-reverting transfer costs
// the buyer gas to be told what a balance read already knew.
//
// ─── THE RECEIPT IS A CLAIM ─────────────────────────────────────────────────
//
// After a transfer confirms, the hash is posted to the invoice store. That row
// is `client-reported` and the confirmation copy says it: nothing on this
// deployment reads a receipt, so the buyer is told to keep their hash and the
// merchant is told not to release goods on the row alone.

export interface CheckoutWidgetProps {
  /** From the payment link. Null renders the "paste a link" state. */
  invoiceId: string | null;
  /** Injection seam for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

type PostState = { kind: 'idle' } | { kind: 'sent'; detail: string } | { kind: 'failed'; detail: string };

export function CheckoutWidget({ invoiceId, fetchImpl }: CheckoutWidgetProps) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [payTokenAddress, setPayTokenAddress] = useState<string>(DEFAULT_TOKENS[1]?.address ?? '');
  const [posted, setPosted] = useState<PostState>({ kind: 'idle' });

  const invoiceState = useCheckoutInvoice({ invoiceId, fetchImpl });
  const invoice = invoiceState.invoice;

  const payToken = useMemo(
    () => DEFAULT_TOKENS.find((t) => t.address.toLowerCase() === payTokenAddress.toLowerCase()) ?? null,
    [payTokenAddress],
  );

  const quote = useCheckoutQuote({
    invoice,
    buyer: address ?? null,
    payToken: (payToken?.address as `0x${string}`) ?? null,
    paySymbol: payToken?.symbol ?? '',
    payDecimals: payToken?.decimals ?? 18,
    connectedChainId: chainId ?? null,
    enabled: invoice !== null && payToken !== null,
  });

  const { data: settleBalance } = useReadContract({
    address: invoice?.settleToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: invoice?.chainId,
    query: { enabled: Boolean(invoice && address) },
  });

  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const {
    data: receipt,
    isLoading: isConfirming,
    isSuccess: isReceiptFetched,
  } = useWaitForTransactionReceipt({ hash: txHash });
  // AUDIT (receipt-status, 2026-08-24): wagmi's `isSuccess` only means the receipt
  // was FETCHED — it latches true for an on-chain REVERTED transfer too, which
  // would have rendered "The transfer confirmed on chain" and offered "Tell the
  // merchant" for a payment that never moved. Only `receipt.status === 'success'`
  // is a real success.
  const isReverted = isReceiptFetched && !!receipt && receipt.status !== 'success';
  const isSuccess = isReceiptFetched && !isReverted;

  const holdsEnough =
    invoice !== null && typeof settleBalance === 'bigint' && settleBalance >= invoice.settleAmount;

  async function payNow() {
    if (!invoice || !address) return;
    writeContract({
      address: invoice.settleToken,
      abi: ERC20_ABI,
      functionName: 'transfer',
      // The INVOICE amount. Never a balance, never a quote output.
      args: [invoice.merchant, invoice.settleAmount],
      chainId: invoice.chainId,
    });
  }

  async function reportPayment() {
    if (!invoice || !address || !txHash) return;
    try {
      const res = await recordSettlement(
        { invoiceId: invoice.id, txHash, payer: address },
        { fetchImpl },
      );
      setPosted({
        kind: 'sent',
        detail:
          `The merchant's store recorded this as "${res.verification}". Nothing on this deployment read a ` +
          'receipt, so keep your transaction hash — it is the only proof that binds.',
      });
    } catch (err) {
      setPosted({
        kind: 'failed',
        detail:
          (err as Error)?.message ??
          'The record could not be written. Your transaction is unaffected — keep the hash.',
      });
    }
  }

  if (!invoiceId) {
    return (
      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-white">No invoice</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-white/70">
          A payment link carries an invoice id, like <code className="text-white/85">/checkout?invoice=…</code>.
          Open the one your merchant gave you. Nothing is claimed here about any invoice.
        </p>
      </section>
    );
  }

  if (invoiceState.status === 'loading' || invoiceState.status === 'idle') {
    return (
      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4" aria-busy="true">
        <p className="text-[13px] text-white/70">Reading the invoice…</p>
      </section>
    );
  }

  if (invoiceState.status !== 'found' || !invoice) {
    // The two failures are kept apart in the copy, because a buyer told "this
    // invoice does not exist" when the truth is "we could not ask" concludes
    // they were phished.
    const missing = invoiceState.status === 'missing';
    return (
      <section
        className={`rounded-xl border p-4 ${missing ? 'border-white/15 bg-white/[0.02]' : 'border-amber-400/30 bg-amber-400/[0.06]'}`}
      >
        <h2 className="text-sm font-semibold text-white">
          {missing ? 'No invoice is published under that id' : 'The invoice could not be read'}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-white/75">{invoiceState.detail}</p>
        {!missing ? (
          <p className="mt-2 text-[12px] leading-relaxed text-white/60">
            This is a statement about this deployment, not about your merchant's invoice. Do not conclude the
            link is fake.
          </p>
        ) : null}
        {invoiceState.operatorStep ? (
          <p className="mt-2 text-[11px] leading-relaxed text-white/50">Operator: {invoiceState.operatorStep}</p>
        ) : null}
        <button type="button" onClick={invoiceState.reload} className="btn-secondary mt-3 px-4 py-1.5 text-[12px]">
          Try again
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-white">Invoice {invoice.id}</h2>
        {invoice.memo ? <p className="mt-1 text-[13px] text-white/75">{invoice.memo}</p> : null}
        <p className="mt-2 text-[12px] text-white/60">
          Due: {formatScaled(invoice.settleAmount, invoice.settleDecimals)} {invoice.settleSymbol} on chain{' '}
          {invoice.chainId}
        </p>

        <label htmlFor="checkout-pay-token" className="mt-4 block text-[11px] uppercase tracking-wide text-white/55">
          Pay in
          <select
            id="checkout-pay-token"
            value={payTokenAddress}
            onChange={(e) => setPayTokenAddress(e.target.value)}
            className="mt-1 block rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
          >
            {DEFAULT_TOKENS.filter((t) => !t.isNative).map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </label>
      </section>

      {quote.status === 'quoting' ? (
        <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4" aria-busy="true">
          <p className="text-[13px] text-white/70">Pricing this payment…</p>
        </section>
      ) : quote.plan ? (
        <SettlementDisclosure plan={quote.plan} onRefreshQuote={quote.refresh} />
      ) : null}

      {quote.detail ? <p className="text-[12px] leading-relaxed text-amber-200/85">{quote.detail}</p> : null}

      {quote.plan && canSign(quote.plan) ? (
        <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
          {holdsEnough ? (
            <>
              <p className="text-[13px] leading-relaxed text-white/75">
                This wallet already holds the {invoice.settleSymbol}. The button below signs one transfer of
                exactly {formatScaled(invoice.settleAmount, invoice.settleDecimals)} {invoice.settleSymbol} to the
                merchant.
              </p>
              <button
                type="button"
                onClick={payNow}
                disabled={isPending || isConfirming}
                className="btn-primary mt-3 px-5 py-2 text-[13px]"
              >
                {isPending ? 'Confirm in your wallet…' : isConfirming ? 'Waiting for the chain…' : 'Pay the exact amount'}
              </button>
            </>
          ) : (
            <>
              <p className="text-[13px] font-medium text-white">Step 1 happens on the trade surface</p>
              <p className="mt-2 text-[13px] leading-relaxed text-white/75">
                This checkout does not swap for you. The routers it compares are quote-only on this
                deployment, so a swap signed here would fill at a price other than the one shown above.
                Acquire {formatScaled(invoice.settleAmount, invoice.settleDecimals)} {invoice.settleSymbol} on{' '}
                <Link to="/swap" className="underline">
                  the trade page
                </Link>
                , then come back — the exact transfer is signed here.
              </p>
            </>
          )}

          {isSuccess && txHash ? (
            <div className="mt-4 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-3">
              <p className="text-[13px] text-white/85">The transfer confirmed on chain.</p>
              <p className="mt-1 break-all text-[11px] text-white/60">{txHash}</p>
              {posted.kind === 'idle' ? (
                <button type="button" onClick={reportPayment} className="btn-secondary mt-2 px-4 py-1.5 text-[12px]">
                  Tell the merchant
                </button>
              ) : (
                <p
                  className={`mt-2 text-[12px] leading-relaxed ${posted.kind === 'sent' ? 'text-white/70' : 'text-amber-200/85'}`}
                >
                  {posted.detail}
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  reset();
                  setPosted({ kind: 'idle' });
                }}
                className="btn-secondary mt-2 px-4 py-1.5 text-[12px]"
              >
                Done
              </button>
            </div>
          ) : null}

          {isReverted && txHash ? (
            <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/[0.06] p-3">
              <p className="text-[13px] text-white/85">
                The transfer reverted on-chain. No {invoice.settleSymbol} moved and the merchant was not
                paid — do not report this hash as a payment.
              </p>
              <p className="mt-1 break-all text-[11px] text-white/60">{txHash}</p>
              <button
                type="button"
                onClick={() => {
                  reset();
                  setPosted({ kind: 'idle' });
                }}
                className="btn-secondary mt-2 px-4 py-1.5 text-[12px]"
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export default CheckoutWidget;
