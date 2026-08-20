import { useMemo, useState } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { DEFAULT_TOKENS } from '../../lib/tokenList';
import { formatScaled } from '../../lib/tax/csv';
import { invoiceProblems, MAX_INVOICE_TTL_SECONDS, type Invoice } from '../../lib/commerce/invoice';
import { CommerceStoreError, fetchSettlements, publishInvoice, type SettlementClaim } from '../../lib/commerce/store';
import { settlementStandingText } from '../../lib/commerce/settlement';

// The merchant's side: publish a debt, then read what people claim about it.
//
// ─── THE PAYEE IS NEVER A FIELD ─────────────────────────────────────────────
//
// This form has no merchant input. The server takes the payee from the
// authenticated wallet claim, so an invoice can only ever name the wallet that
// published it. A payee field here would be a payee field on the API, and that
// lets anyone burn an id for its real owner while pointing a stranger's address
// at this venue's checkout.
//
// ─── THE SETTLEMENT LIST IS A LIST OF CLAIMS ────────────────────────────────
//
// Every row a merchant reads here was asserted by a browser. Nothing on this
// deployment reads a transaction receipt, so the standing text on every row says
// so and the merchant is told to check the hash before releasing anything. Two
// outcomes are kept apart on purpose: an empty list from a successful read means
// nobody has claimed to pay, and a failed read means nothing at all — the second
// must never render as the first while somebody decides whether to ship.

/** Whole-token string → smallest units, exactly. Null on anything lossy. */
function toSmallestUnits(whole: string, decimals: number): bigint | null {
  const s = whole.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return BigInt(w + f.padEnd(decimals, '0'));
}

type Publish =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'published'; invoice: Invoice }
  | { kind: 'failed'; detail: string; operatorStep: string | null };

type Claims =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'read'; rows: SettlementClaim[]; notice: string }
  | { kind: 'failed'; detail: string };

export function InvoiceBuilder({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const { address } = useAccount();
  const chainId = useChainId();

  const [id, setId] = useState('');
  const [tokenAddress, setTokenAddress] = useState(
    DEFAULT_TOKENS.find((t) => t.symbol === 'USDC')?.address ?? '',
  );
  const [amountWhole, setAmountWhole] = useState('');
  const [memo, setMemo] = useState('');
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [publish, setPublish] = useState<Publish>({ kind: 'idle' });
  const [claims, setClaims] = useState<Claims>({ kind: 'idle' });

  const token = useMemo(
    () => DEFAULT_TOKENS.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase()) ?? null,
    [tokenAddress],
  );

  const now = Math.floor(Date.now() / 1000);
  const amount = token ? toSmallestUnits(amountWhole, token.decimals) : null;

  const draft: Invoice | null =
    address && token && amount !== null
      ? {
          id: id.trim().toLowerCase(),
          merchant: address,
          chainId: chainId ?? 1,
          settleToken: token.address as `0x${string}`,
          settleSymbol: token.symbol,
          settleDecimals: token.decimals,
          settleAmount: amount,
          memo,
          expiresAt: now + ttlMinutes * 60,
          createdAt: now,
        }
      : null;

  // The SAME validator the buyer's plan runs. One implementation, so a merchant
  // cannot publish something the checkout will refuse to price.
  const problems = draft ? invoiceProblems(draft) : [];

  async function onPublish() {
    if (!draft || problems.length > 0) return;
    setPublish({ kind: 'publishing' });
    try {
      const stored = await publishInvoice(
        {
          id: draft.id,
          chainId: draft.chainId,
          settleToken: draft.settleToken,
          settleSymbol: draft.settleSymbol,
          settleDecimals: draft.settleDecimals,
          settleAmount: draft.settleAmount.toString(),
          memo: draft.memo,
          expiresAt: draft.expiresAt,
          ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
        },
        { fetchImpl },
      );
      setPublish({ kind: 'published', invoice: stored });
    } catch (err) {
      const storeErr = err instanceof CommerceStoreError ? err : null;
      setPublish({
        kind: 'failed',
        detail: storeErr?.message ?? 'The invoice was not published.',
        operatorStep: storeErr?.operatorStep ?? null,
      });
    }
  }

  async function loadClaims(invoiceId: string) {
    setClaims({ kind: 'loading' });
    try {
      const res = await fetchSettlements(invoiceId, { fetchImpl });
      setClaims({ kind: 'read', rows: res.settlements, notice: res.notice });
    } catch (err) {
      setClaims({
        kind: 'failed',
        detail:
          (err as Error)?.message ??
          'The settlement record could not be read. This says nothing about whether anyone paid.',
      });
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-white">Publish an invoice</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-white/60">
          The payee is the wallet you are signed in with — there is no field for it, so an invoice can only
          ever name you. The amount is denominated in the token you pick and in nothing else: a fiat price
          would have to be converted at a rate nobody agreed to.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label htmlFor="inv-id" className="text-[11px] uppercase tracking-wide text-white/55">
            Invoice id
            <input
              id="inv-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="order-10231"
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 font-mono text-xs text-white"
            />
          </label>

          <label htmlFor="inv-token" className="text-[11px] uppercase tracking-wide text-white/55">
            Settlement asset
            <select
              id="inv-token"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            >
              {DEFAULT_TOKENS.filter((t) => !t.isNative).map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="inv-amount" className="text-[11px] uppercase tracking-wide text-white/55">
            Amount
            <input
              id="inv-amount"
              value={amountWhole}
              onChange={(e) => setAmountWhole(e.target.value)}
              inputMode="decimal"
              placeholder="100.00"
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>

          <label htmlFor="inv-ttl" className="text-[11px] uppercase tracking-wide text-white/55">
            Payable for (minutes, max {MAX_INVOICE_TTL_SECONDS / 60})
            <input
              id="inv-ttl"
              type="number"
              min={1}
              max={MAX_INVOICE_TTL_SECONDS / 60}
              value={ttlMinutes}
              onChange={(e) => setTtlMinutes(Number(e.target.value))}
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>

          <label htmlFor="inv-memo" className="text-[11px] uppercase tracking-wide text-white/55 sm:col-span-2">
            Memo (shown to the buyer)
            <input
              id="inv-memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
            />
          </label>

          <label htmlFor="inv-webhook" className="text-[11px] uppercase tracking-wide text-white/55 sm:col-span-2">
            Callback URL (optional, https only)
            <input
              id="inv-webhook"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-shop.example/hooks/memetic"
              className="mt-1 block w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 font-mono text-xs text-white"
            />
          </label>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-amber-200/80">
          The callback is ONE signed POST, sent inline when a payment is reported. This venue runs no keeper,
          so a failed delivery is never retried — poll the claims list below rather than depending on it. If
          no signing secret is configured on the deployment, nothing is sent at all, because an unsigned
          callback is one anybody could forge.
        </p>

        {draft && problems.length > 0 ? (
          <ul className="mt-3 space-y-1 text-[12px] leading-relaxed text-rose-200/90">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}

        <button
          type="button"
          onClick={onPublish}
          disabled={!draft || problems.length > 0 || publish.kind === 'publishing'}
          className="btn-primary mt-3 px-5 py-2 text-[13px]"
        >
          {publish.kind === 'publishing' ? 'Publishing…' : 'Publish'}
        </button>
        {!address ? (
          <p className="mt-2 text-[12px] text-white/60">Sign in with your wallet to publish under it.</p>
        ) : null}
      </section>

      {publish.kind === 'failed' ? (
        <section className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
          <p className="text-[13px] leading-relaxed text-white/85">{publish.detail}</p>
          {publish.operatorStep ? (
            <p className="mt-2 text-[11px] leading-relaxed text-white/55">Operator: {publish.operatorStep}</p>
          ) : null}
        </section>
      ) : null}

      {publish.kind === 'published' ? (
        <section className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4">
          <h2 className="text-sm font-semibold text-white">Published</h2>
          <p className="mt-2 text-[13px] text-white/85">
            {formatScaled(publish.invoice.settleAmount, publish.invoice.settleDecimals)}{' '}
            {publish.invoice.settleSymbol} to {publish.invoice.merchant}
          </p>
          <p className="mt-1 text-[12px] text-white/60">
            These are the figures the DATABASE stored, not the ones typed above. Send the buyer:
          </p>
          <code className="mt-2 block break-all rounded bg-black/40 px-2 py-1 text-[12px] text-white/85">
            /checkout?invoice={publish.invoice.id}
          </code>
          <button
            type="button"
            onClick={() => loadClaims(publish.invoice.id)}
            className="btn-secondary mt-3 px-4 py-1.5 text-[12px]"
          >
            Check for reported payments
          </button>
        </section>
      ) : null}

      {claims.kind !== 'idle' ? (
        <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
          <h2 className="text-sm font-semibold text-white">Reported payments</h2>
          {claims.kind === 'loading' ? (
            <p className="mt-2 text-[13px] text-white/70" aria-busy="true">
              Reading the record…
            </p>
          ) : claims.kind === 'failed' ? (
            <p className="mt-2 text-[13px] leading-relaxed text-amber-200/85">{claims.detail}</p>
          ) : claims.rows.length === 0 ? (
            <p className="mt-2 text-[13px] leading-relaxed text-white/75">
              The record answered and nobody has reported a payment against this invoice. That is an answer,
              not an outage.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">{claims.notice}</p>
              <ul className="mt-3 space-y-3">
                {claims.rows.map((row) => (
                  <li key={row.txHash} className="rounded-lg border border-white/10 bg-black/25 p-3">
                    <p className="break-all font-mono text-[12px] text-white/85">{row.txHash}</p>
                    <p className="mt-1 break-all text-[11px] text-white/55">from {row.payer}</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-white/75">
                      {settlementStandingText(
                        row.verification === 'chain-confirmed'
                          ? 'chain-confirmed'
                          : row.verification === 'chain-refuted'
                            ? 'chain-refuted'
                            : 'client-reported',
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

export default InvoiceBuilder;
