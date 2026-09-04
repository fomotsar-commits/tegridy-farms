import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useAccount,
  useBlock,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { ERC20_ABI } from '../../lib/contracts';
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';
import { SUPPORTED_CHAIN_ID } from '../../lib/aggregator';
import { formatScaled } from '../../lib/tax/csv';
import { CopyButton } from '../ui/CopyButton';
import { useCheckoutInvoice } from '../../hooks/useCheckoutInvoice';
import { useCheckoutQuote } from '../../hooks/useCheckoutQuote';
import { useSettleTokenCheck } from '../../hooks/useSettleTokenCheck';
import type { PaymentLinkState } from '../../hooks/usePaymentLink';
import { recordSettlement } from '../../lib/commerce/store';
import { canSign, settlementStandingText, type SettlementAttestation } from '../../lib/commerce/settlement';
import { judgeReceipt } from '../../lib/commerce/receiptProof';
import { paymentLinkUrl } from '../../lib/commerce/paymentLink';
import { SettlementDisclosure } from './SettlementDisclosure';
import { ProofOfPaymentPanel } from './ProofOfPaymentPanel';

// The buyer's side of a payment link.
//
// ─── TWO WAYS AN INVOICE ARRIVES, AND THEY ARE NOT THE SAME CLAIM ───────────
//
//   /checkout#i=…      a document the MERCHANT SIGNED. It is verified against
//                      their address in this browser before a figure is
//                      rendered as a debt. No server, no account, no migration.
//   /checkout?invoice= an id the invoice STORE resolves. Requires 021_commerce
//                      and Supabase env; unchanged, and it self-activates when
//                      an operator applies them.
//
// `attestation` carries which one it was all the way into buildSettlementPlan,
// which refuses outright on `unverified`.
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
// ─── THREE READS THAT ARE NOT ALLOWED TO COLLAPSE ───────────────────────────
//
//   the signature   verified / forged / unverifiable  (usePaymentLink)
//   the token       matches / no-code / mismatch / unread  (useSettleTokenCheck)
//   the balance     read / short / unread  (below, from useReadContract's flags)
//
// The last one is the oldest bug on this surface: `settleBalance` was read
// without an error branch, so `undefined` — an RPC that did not answer — was
// treated as a short balance and the buyer was sent to the trade page to acquire
// tokens they may already have held. A balance that was not read is not a
// balance of zero.
//
// ─── THE RECEIPT IS NOW JUDGED, NOT ANNOUNCED ───────────────────────────────
//
// The old copy said "The transfer confirmed on chain" from `receipt.status`
// alone. The receipt in hand already carries `logs`, so judgeReceipt reads them:
// a fee-on-transfer token that delivered less than the invoice is REFUTED with
// both figures named, at zero extra RPC. The store post below is unchanged and
// is still `client-reported` — a browser's claim, which is a different sentence.

export interface CheckoutWidgetProps {
  /** From `?invoice=`. Null on the signed-link path. */
  invoiceId: string | null;
  /** From `#i=`. The signed document, already decoded and verified (or not). */
  link: PaymentLinkState;
  /** Injection seam for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

type PostState = { kind: 'idle' } | { kind: 'sent'; detail: string } | { kind: 'failed'; detail: string };

const CARD = 'rounded-xl border border-white/15 bg-white/[0.02] p-4';
const AMBER_CARD = 'rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4';
const ROSE_CARD = 'rounded-xl border border-rose-400/30 bg-rose-400/[0.06] p-4';

export function CheckoutWidget({ invoiceId, link, fetchImpl }: CheckoutWidgetProps) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [payTokenAddress, setPayTokenAddress] = useState<string>(DEFAULT_TOKENS[1]?.address ?? '');
  const [posted, setPosted] = useState<PostState>({ kind: 'idle' });

  // The store path is asked about only when a `?invoice=` id is present; on the
  // fragment path this parks in `idle` and asks nothing of any server.
  const invoiceState = useCheckoutInvoice({ invoiceId, fetchImpl });

  const signedInvoice = link.status === 'verified' ? link.invoice : null;
  const invoice = signedInvoice ?? invoiceState.invoice;
  const attestation: SettlementAttestation = signedInvoice ? 'merchant-signed' : 'store-published';

  const tokenCheck = useSettleTokenCheck(invoice, invoice !== null);

  // On any chain the meta-aggregator does not serve, the ONLY payable asset is
  // the settlement asset itself — offering a route-priced list there would put a
  // dozen tokens in front of a buyer that the router was never asked about, and
  // then blame "the routers" for the silence.
  const routesQuotedHere = invoice === null || invoice.chainId === SUPPORTED_CHAIN_ID;
  const payTokenOptions: TokenInfo[] = useMemo(() => {
    if (invoice && !routesQuotedHere) {
      return [
        {
          address: invoice.settleToken,
          symbol: invoice.settleSymbol,
          name: invoice.settleSymbol,
          decimals: invoice.settleDecimals,
          logoURI: '',
        },
      ];
    }
    return DEFAULT_TOKENS.filter((t) => !t.isNative);
  }, [invoice, routesQuotedHere]);

  // Falls back to the first OFFERED option rather than to a remembered address
  // that is not in the list — a select whose value is not among its options
  // renders blank and prices something nobody chose.
  const payToken =
    payTokenOptions.find((t) => t.address.toLowerCase() === payTokenAddress.toLowerCase()) ??
    payTokenOptions[0] ??
    null;

  const quote = useCheckoutQuote({
    invoice,
    buyer: address ?? null,
    payToken: (payToken?.address as `0x${string}`) ?? null,
    paySymbol: payToken?.symbol ?? '',
    payDecimals: payToken?.decimals ?? 18,
    connectedChainId: chainId ?? null,
    attestation,
    settleTokenOnChain: tokenCheck.verdict ?? 'unread',
    enabled: invoice !== null && payToken !== null && tokenCheck.status === 'done',
  });

  const {
    data: settleBalance,
    isLoading: balanceLoading,
    isError: balanceFailed,
    refetch: refetchBalance,
  } = useReadContract({
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
  // is a real success, and since 2026-09-02 not even that is enough: judgeReceipt
  // reads the logs.
  const { data: block } = useBlock({
    blockNumber: receipt?.blockNumber,
    chainId: invoice?.chainId,
    query: { enabled: receipt?.blockNumber !== undefined && invoice !== null },
  });

  const verdict = useMemo(
    () =>
      invoice && receipt
        ? judgeReceipt(
            invoice,
            { status: receipt.status, logs: receipt.logs },
            block ? { timestamp: block.timestamp } : null,
          )
        : null,
    [invoice, receipt, block],
  );

  // Three states, not two. `undefined` from a read that has not answered is not
  // a balance and must never be compared against the invoice.
  const balance: { kind: 'reading' } | { kind: 'unread' } | { kind: 'read'; value: bigint } | { kind: 'none' } =
    !invoice || !address
      ? { kind: 'none' }
      : balanceLoading
        ? { kind: 'reading' }
        : typeof settleBalance === 'bigint'
          ? { kind: 'read', value: settleBalance }
          : balanceFailed || settleBalance === undefined
            ? { kind: 'unread' }
            : { kind: 'unread' };

  const holdsEnough = invoice !== null && balance.kind === 'read' && balance.value >= invoice.settleAmount;
  const knownShort = invoice !== null && balance.kind === 'read' && balance.value < invoice.settleAmount;

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
      const res = await recordSettlement({ invoiceId: invoice.id, txHash, payer: address }, { fetchImpl });
      setPosted({
        kind: 'sent',
        detail:
          `The merchant's store recorded this as "${res.verification}". That row is a claim the store wrote ` +
          'down; the proof link below is read from the chain and needs no store at all.',
      });
    } catch (err) {
      setPosted({
        kind: 'failed',
        detail:
          (err as Error)?.message ??
          'The record could not be written. Your transaction is unaffected — keep the hash and send the proof link.',
      });
    }
  }

  // ─── Nothing to pay ───────────────────────────────────────────────────────

  if (link.status === 'none' && !invoiceId) {
    return (
      <section className={CARD}>
        <h2 className="text-sm font-semibold text-white">No invoice</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-white/70">
          A payment link looks like <code className="text-white/85">/checkout#i=…</code> (signed by the
          merchant, verified here) or <code className="text-white/85">/checkout?invoice=…</code> (a short link
          the merchant published). Open the one your merchant gave you. Nothing is claimed here about any
          invoice.
        </p>
      </section>
    );
  }

  // ─── The link itself ──────────────────────────────────────────────────────

  if (link.status === 'unreadable') {
    return (
      <section className={CARD}>
        <h2 className="text-sm font-semibold text-white">This is not a payment link this build can read</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-white/75">{link.detail}</p>
        <p className="mt-2 text-[12px] leading-relaxed text-white/60">
          Nothing here is a statement about any merchant. A chat app that truncates long links, or a newer
          version of this format, both land here.
        </p>
      </section>
    );
  }

  if (link.status === 'verifying') {
    return (
      <section className={CARD} aria-busy="true">
        <p className="text-[13px] text-white/70">Checking the merchant signature…</p>
      </section>
    );
  }

  if (link.status === 'forged') {
    return (
      <section className={ROSE_CARD}>
        <h2 className="text-sm font-semibold text-white">This link does not verify</h2>
        <p className="mt-2 break-all text-[13px] leading-relaxed text-white/85">
          The signature on this link does not verify against {link.merchant}. Either the link was edited after
          it was signed, or it was never signed by that wallet. Nothing is offered to pay.
        </p>
      </section>
    );
  }

  if (link.status === 'unverifiable') {
    return (
      <section className={AMBER_CARD}>
        <h2 className="text-sm font-semibold text-white">The merchant signature could not be checked</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-white/85">
          {link.detail}. This is a statement about this browser's connection, not about the link — do not
          conclude it is fake.
        </p>
        <button type="button" onClick={link.retry} className="btn-secondary mt-3 min-h-11 px-4 py-1.5 text-[12px]">
          Try again
        </button>
      </section>
    );
  }

  // ─── The store path, unchanged ────────────────────────────────────────────

  if (link.status === 'none') {
    if (invoiceState.status === 'loading' || invoiceState.status === 'idle') {
      return (
        <section className={CARD} aria-busy="true">
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
        <section className={missing ? CARD : AMBER_CARD}>
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
          <button
            type="button"
            onClick={invoiceState.reload}
            className="btn-secondary mt-3 min-h-11 px-4 py-1.5 text-[12px]"
          >
            Try again
          </button>
        </section>
      );
    }
  }

  if (!invoice) return null;

  const due = `${formatScaled(invoice.settleAmount, invoice.settleDecimals)} ${invoice.settleSymbol}`;

  return (
    <div className="space-y-4">
      {signedInvoice ? (
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-white">Signed by the merchant</h2>
          <p className="mt-2 break-all text-[13px] leading-relaxed text-white/85">
            Signed by {signedInvoice.merchant} on chain {signedInvoice.chainId}.
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-white/75">
            The signature proves nothing in this link changed since that wallet signed it. It does not prove the
            wallet belongs to who you think — compare the address with the one your merchant gave you. The note
            below is the merchant's own words; nothing here vouches for what it says.
          </p>
        </section>
      ) : null}

      <section className={CARD}>
        <h2 className="text-sm font-semibold text-white">Invoice {invoice.id}</h2>
        <p className="mt-2 text-[12px] text-white/60">
          Due: {due} on chain {invoice.chainId}
        </p>
        {invoice.memo ? (
          <>
            <p className="mt-3 text-[11px] uppercase tracking-wide text-white/55">
              Merchant's note — signed, not checked
            </p>
            <p className="mt-1 text-[13px] text-white/75">{invoice.memo}</p>
          </>
        ) : null}

        <label htmlFor="checkout-pay-token" className="mt-4 block text-[11px] uppercase tracking-wide text-white/55">
          Pay in
          <select
            id="checkout-pay-token"
            value={payToken?.address ?? ''}
            onChange={(e) => setPayTokenAddress(e.target.value)}
            className="mt-1 block min-h-11 rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
          >
            {payTokenOptions.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </label>
        {!routesQuotedHere ? (
          <p className="mt-2 text-[12px] leading-relaxed text-white/60">
            Routes are quoted on Ethereum only in this build; on chain {invoice.chainId} this checkout accepts
            the settlement asset directly.
          </p>
        ) : null}
      </section>

      {/* ── The signed token, re-read from the chain ───────────────────── */}

      {tokenCheck.status === 'reading' || tokenCheck.status === 'idle' ? (
        <section className={CARD} aria-busy="true">
          <p className="text-[13px] text-white/70">
            Reading the settlement token from chain {invoice.chainId}…
          </p>
        </section>
      ) : null}

      {tokenCheck.verdict === 'unread' ? (
        <section className={AMBER_CARD}>
          <h2 className="text-sm font-semibold text-white">The settlement token could not be read</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-white/85">
            Nothing answered on chain {invoice.chainId} for {invoice.settleToken}. This is a statement about
            this browser's connection, not about the invoice.
          </p>
          <button
            type="button"
            onClick={tokenCheck.retry}
            className="btn-secondary mt-3 min-h-11 px-4 py-1.5 text-[12px]"
          >
            Try again
          </button>
        </section>
      ) : null}

      {tokenCheck.verdict === 'no-code' ? (
        <section className={ROSE_CARD}>
          <h2 className="text-sm font-semibold text-white">There is no contract at that address</h2>
          <p className="mt-2 break-all text-[13px] leading-relaxed text-white/85">
            Chain {invoice.chainId} has no code at {invoice.settleToken}, so nothing could be paid to it.
            Nothing is offered to sign.
          </p>
        </section>
      ) : null}

      {tokenCheck.verdict === 'mismatch' ? (
        <section className={ROSE_CARD}>
          <h2 className="text-sm font-semibold text-white">That address is not the token this invoice names</h2>
          <p className="mt-2 break-all text-[13px] leading-relaxed text-white/85">
            The contract at {invoice.settleToken} reports a different symbol or a different decimal count than
            the {invoice.settleSymbol} ({invoice.settleDecimals} decimals) the invoice was signed for. Nothing
            is offered to sign.
          </p>
        </section>
      ) : null}

      {/* ── The plan ───────────────────────────────────────────────────── */}

      {tokenCheck.verdict === 'matches' ? (
        <>
          {quote.status === 'quoting' ? (
            <section className={CARD} aria-busy="true">
              <p className="text-[13px] text-white/70">Pricing this payment…</p>
            </section>
          ) : quote.plan ? (
            <SettlementDisclosure plan={quote.plan} onRefreshQuote={quote.refresh} />
          ) : null}

          {quote.detail ? <p className="text-[12px] leading-relaxed text-amber-200/85">{quote.detail}</p> : null}

          {quote.plan && canSign(quote.plan) ? (
            <section className={CARD}>
              {balance.kind === 'reading' ? (
                <p className="text-[13px] text-white/70" aria-busy="true">
                  Reading your {invoice.settleSymbol} balance…
                </p>
              ) : null}

              {balance.kind === 'unread' ? (
                <>
                  <p className="text-[13px] leading-relaxed text-white/85">
                    Your {invoice.settleSymbol} balance on chain {invoice.chainId} could not be read — this is
                    about the RPC, not your wallet. Nothing is concluded about what you hold.
                  </p>
                  <button
                    type="button"
                    onClick={() => void refetchBalance()}
                    className="btn-secondary mt-3 min-h-11 px-4 py-1.5 text-[12px]"
                  >
                    Try again
                  </button>
                </>
              ) : null}

              {holdsEnough ? (
                <>
                  <p className="text-[13px] leading-relaxed text-white/75">
                    This wallet already holds the {invoice.settleSymbol}. The button below signs one transfer of
                    exactly {due} to the merchant.
                  </p>
                  <button
                    type="button"
                    onClick={payNow}
                    disabled={isPending || isConfirming}
                    className="btn-primary mt-3 min-h-11 px-5 py-2 text-[13px]"
                  >
                    {isPending
                      ? 'Confirm in your wallet…'
                      : isConfirming
                        ? 'Waiting for the chain…'
                        : 'Pay the exact amount'}
                  </button>
                </>
              ) : null}

              {knownShort ? (
                <>
                  <p className="text-[13px] font-medium text-white">Step 1 happens on the trade surface</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-white/75">
                    This checkout does not swap for you. The routers it compares are quote-only on this
                    deployment, so a swap signed here would fill at a price other than the one shown above.
                    Acquire {due} on{' '}
                    <Link to="/swap" className="underline">
                      the trade page
                    </Link>
                    , then come back — the exact transfer is signed here.
                  </p>
                </>
              ) : null}

              {isReceiptFetched && txHash && verdict ? (
                <div
                  className={`mt-4 rounded-lg border p-3 ${
                    verdict.verification === 'chain-confirmed'
                      ? 'border-emerald-400/25 bg-emerald-400/[0.06]'
                      : 'border-rose-400/30 bg-rose-400/[0.06]'
                  }`}
                >
                  <p className="text-[13px] leading-relaxed text-white/85">
                    {settlementStandingText(verdict.verification)}
                  </p>
                  {verdict.verification === 'chain-refuted' ? (
                    <p className="mt-2 text-[13px] leading-relaxed text-white/75">{verdict.detail}</p>
                  ) : null}
                  <p className="mt-2 text-[12px] leading-relaxed text-white/60">
                    {receipt?.blockNumber !== undefined ? `As of block ${receipt.blockNumber.toString()}` : 'As of the receipt'}
                    {verdict.verification === 'chain-confirmed' && verdict.minedAt !== null
                      ? ` (chain time ${new Date(verdict.minedAt * 1000).toISOString()})`
                      : ' — block time not read'}
                    .
                  </p>
                  <p className="mt-2 break-all font-mono text-[11px] text-white/60">{txHash}</p>

                  {verdict.verification === 'chain-confirmed' && link.status === 'verified' ? (
                    <div className="mt-3">
                      <p className="text-[12px] font-medium text-white/85">Proof of payment</p>
                      <p className="mt-1 text-[12px] leading-relaxed text-white/70">
                        Send this to the merchant. Anyone who opens it reads the receipt from the chain — it
                        needs no account and no server. Keep the hash: it is the only proof that binds.
                      </p>
                      <code className="mt-2 block break-all rounded bg-black/40 px-2 py-1 text-[11px] text-white/85">
                        {paymentLinkUrl(link.payload, txHash)}
                      </code>
                      <CopyButton
                        text={paymentLinkUrl(link.payload, txHash)}
                        display="Copy the proof link"
                        className="btn-secondary mt-2 min-h-11 px-4 py-1.5 text-[12px]"
                      />
                    </div>
                  ) : null}

                  {verdict.verification === 'chain-confirmed' ? (
                    posted.kind === 'idle' ? (
                      <button
                        type="button"
                        onClick={reportPayment}
                        className="btn-secondary mt-3 min-h-11 px-4 py-1.5 text-[12px]"
                      >
                        Tell the merchant
                      </button>
                    ) : (
                      <p
                        className={`mt-3 text-[12px] leading-relaxed ${posted.kind === 'sent' ? 'text-white/70' : 'text-amber-200/85'}`}
                      >
                        {posted.detail}
                      </p>
                    )
                  ) : null}

                  <button
                    type="button"
                    onClick={() => {
                      reset();
                      setPosted({ kind: 'idle' });
                    }}
                    className="btn-secondary mt-2 min-h-11 px-4 py-1.5 text-[12px]"
                  >
                    Done
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      {/* A proof link the buyer re-opened: the hash was signed by somebody else's
          browser, so nothing here is in hand and the panel reads it fresh. */}
      {link.status === 'verified' && link.tx ? (
        <ProofOfPaymentPanel invoice={invoice} txHash={link.tx} />
      ) : null}
    </div>
  );
}

export default CheckoutWidget;
