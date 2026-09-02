import { useMemo, useState } from 'react';
import { useAccount, usePublicClient, useSignTypedData } from 'wagmi';
import { formatScaled } from '../../lib/tax/csv';
import { getChainLabel } from '../../lib/explorer';
import { invoiceProblems, MAX_INVOICE_TTL_SECONDS, type Invoice } from '../../lib/commerce/invoice';
import { CommerceStoreError, fetchSettlements, publishInvoice, type SettlementClaim } from '../../lib/commerce/store';
import { settlementStandingText } from '../../lib/commerce/settlement';
import {
  PAYMENT_LINK_CHAIN_IDS,
  settleTokenKnownOnChain,
  settleTokensFor,
} from '../../lib/commerce/settleTokens';
import {
  browserRandomBytes,
  encodePaymentLink,
  invoiceTypedData,
  newInvoiceId,
  paymentLinkUrl,
} from '../../lib/commerce/paymentLink';
import { CopyButton } from '../ui/CopyButton';
import { ProofOfPaymentPanel } from './ProofOfPaymentPanel';

// The merchant's side: SIGN a debt, hand out the link, then read the chain.
//
// ─── THE LINK IS THE PRODUCT, THE STORE IS AN ACCESSORY ─────────────────────
//
// Until 2026-09-02 the only way to mint an invoice here was `publishInvoice`,
// which needs a SIWE cookie and a table behind `021_commerce.sql` — a migration
// an operator applies by hand and may never apply. So no merchant on this
// deployment could produce a payment link at all.
//
// Now the primary action is an EIP-712 signature from the merchant's own wallet,
// carried in the URL fragment. It needs no server, no database, no migration and
// no account, and it is verified in the buyer's browser against this address.
// The store path is kept, unchanged, as an OPTIONAL short-link enrichment that
// self-activates the day 021 lands — and its failure copy says the signed link
// above works without it.
//
// ─── THE PAYEE IS STILL NEVER A FIELD ───────────────────────────────────────
//
// The merchant is the connected wallet, because the merchant is whoever the
// wallet SIGNS as. A payee field would let somebody sign a document naming a
// stranger's address, which is a phishing kit with a form.
//
// ─── THE CHAIN COMES FROM THE WALLET, NOT FROM wagmi's useChainId ───────────
//
// `useChainId()` reports the CONFIGURED chain and never reports a wallet sitting
// on a chain this app does not serve (@wagmi/core createConfig syncs
// `state.chainId` only for configured chains). Signing typed data whose
// `domain.chainId` disagrees with the wallet's actual chain is rejected by
// MetaMask, so the draft and the guard both key on `useAccount().chain?.id`,
// which is `undefined` exactly when the wallet is somewhere we do not serve.
//
// ─── AND THE SIGNATURE IS CHECKED BEFORE THE LINK IS SHOWN ──────────────────
//
// A smart-account wallet (Safe and friends) verifies through ERC-1271/6492, and
// a Safe below its threshold cannot produce a signature that verifies at all. So
// this component runs the SAME verifier the buyer will run, against the same
// document, before it prints a link. A link that would fail in the buyer's
// browser is never handed out.

/** Whole-token string → smallest units, exactly. Null on anything lossy. */
function toSmallestUnits(whole: string, decimals: number): bigint | null {
  const s = whole.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return BigInt(w + f.padEnd(decimals, '0'));
}

type Mint =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'rejected'; detail: string }
  | { kind: 'signed'; link: string; invoice: Invoice }
  | { kind: 'self-check-failed'; detail: string };

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

const CARD = 'rounded-xl border border-white/15 bg-white/[0.02] p-4';
const FIELD =
  'mt-1 block min-h-11 w-full rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white';

const MINTABLE_CHAIN_NAMES = PAYMENT_LINK_CHAIN_IDS.map((id) => getChainLabel(id)).join(', ');

export function InvoiceBuilder({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const { address, chain } = useAccount();
  const walletChainId = chain?.id;
  const publicClient = usePublicClient({ chainId: walletChainId });
  const { signTypedDataAsync } = useSignTypedData();

  const assets = settleTokensFor(walletChainId);

  // Generated once per mount from real randomness, and editable — a merchant
  // with their own order numbering should use it, and a merchant without one
  // should not have to invent an id to get paid.
  const [id, setId] = useState(() => newInvoiceId(browserRandomBytes));
  const [tokenAddress, setTokenAddress] = useState('');
  const [amountWhole, setAmountWhole] = useState('');
  const [memo, setMemo] = useState('');
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [mint, setMint] = useState<Mint>({ kind: 'idle' });
  const [publish, setPublish] = useState<Publish>({ kind: 'idle' });
  const [claims, setClaims] = useState<Claims>({ kind: 'idle' });
  const [showStore, setShowStore] = useState(false);
  const [shared, setShared] = useState(false);

  // Falls back to the first asset OFFERED on this chain rather than to a
  // remembered mainnet address: a select whose value is not among its options
  // renders blank and would sign a token this chain has never been asked about.
  const token = useMemo(
    () => assets.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase()) ?? assets[0] ?? null,
    [assets, tokenAddress],
  );

  const now = Math.floor(Date.now() / 1000);
  const amount = token ? toSmallestUnits(amountWhole, token.decimals) : null;

  const draft: Invoice | null =
    address && token && amount !== null && walletChainId !== undefined
      ? {
          id: id.trim().toLowerCase(),
          merchant: address,
          chainId: walletChainId,
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
  // cannot sign something the checkout will refuse to price.
  const problems = draft ? invoiceProblems(draft) : [];

  const chainIsMintable = walletChainId !== undefined && PAYMENT_LINK_CHAIN_IDS.includes(walletChainId);
  // Belt and braces on top of the select: the asset must be in the table for
  // THIS chain, so a stale address can never be signed into a document.
  const assetIsKnown = draft !== null && settleTokenKnownOnChain(draft.chainId, draft.settleToken) !== null;
  const canMint = draft !== null && problems.length === 0 && chainIsMintable && assetIsKnown;

  async function onSign() {
    if (!draft || !canMint) return;
    setMint({ kind: 'signing' });
    const typed = invoiceTypedData(draft);

    let signature: `0x${string}`;
    try {
      signature = await signTypedDataAsync({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
    } catch (err) {
      setMint({
        kind: 'rejected',
        detail: (err as Error)?.message ?? 'The wallet did not return a signature, so no link was produced.',
      });
      return;
    }

    // The buyer's verification, run here first. No link is shown until it passes.
    try {
      const ok = publicClient
        ? await publicClient.verifyTypedData({
            address: draft.merchant,
            domain: typed.domain,
            types: typed.types,
            primaryType: typed.primaryType,
            message: typed.message,
            signature,
            blockTag: 'latest',
          })
        : false;
      if (!ok) {
        setMint({
          kind: 'self-check-failed',
          detail: `Your wallet returned a signature this browser could not verify against ${draft.merchant} (smart-account wallets need their on-chain validator to accept it). No link was produced.`,
        });
        return;
      }
    } catch (err) {
      setMint({
        kind: 'self-check-failed',
        detail: `The signature could not be checked against ${draft.merchant} on chain ${draft.chainId} (${(err as Error)?.message ?? 'no answer from this chain'}). No link was produced, because a link that fails in the buyer's browser is worse than none.`,
      });
      return;
    }

    setMint({ kind: 'signed', link: paymentLinkUrl(encodePaymentLink(draft, signature)), invoice: draft });
  }

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

  const proofInvoice = mint.kind === 'signed' ? mint.invoice : draft;

  return (
    <div className="space-y-4">
      <section className={CARD}>
        <h2 className="text-sm font-semibold text-white">Sign an invoice</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-white/60">
          The payee is the wallet you sign with — there is no field for it, so an invoice can only ever name
          you. The amount is denominated in the asset you pick and in nothing else: a fiat price would have to
          be converted at a rate nobody agreed to. Nothing on this venue stores what you sign; the link IS the
          invoice.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label htmlFor="inv-id" className="text-[11px] uppercase tracking-wide text-white/55">
            Invoice id
            <input
              id="inv-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="order-10231"
              className={`${FIELD} font-mono`}
            />
          </label>

          <label htmlFor="inv-token" className="text-[11px] uppercase tracking-wide text-white/55">
            Settlement asset
            <select
              id="inv-token"
              value={token?.address ?? ''}
              onChange={(e) => setTokenAddress(e.target.value)}
              disabled={assets.length === 0}
              className={FIELD}
            >
              {assets.length === 0 ? <option value="">No verified asset on this chain</option> : null}
              {assets.map((t) => (
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
              className={FIELD}
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
              className={FIELD}
            />
          </label>

          <label htmlFor="inv-memo" className="text-[11px] uppercase tracking-wide text-white/55 sm:col-span-2">
            Memo (shown to the buyer)
            <input id="inv-memo" value={memo} onChange={(e) => setMemo(e.target.value)} className={FIELD} />
          </label>
        </div>

        {draft && problems.length > 0 ? (
          <ul className="mt-3 space-y-1 text-[12px] leading-relaxed text-rose-200/90">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}

        <button
          type="button"
          onClick={onSign}
          disabled={!canMint || mint.kind === 'signing'}
          className="btn-primary mt-3 min-h-11 px-5 py-2 text-[13px]"
        >
          {mint.kind === 'signing' ? 'Confirm in your wallet…' : 'Sign the invoice'}
        </button>

        {!address ? (
          <p className="mt-2 text-[12px] text-white/60">Connect a wallet to sign as the payee.</p>
        ) : !chainIsMintable ? (
          <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">
            Signed payment links are minted on {MINTABLE_CHAIN_NAMES} in this build. Your wallet is on{' '}
            {walletChainId === undefined ? 'a chain this build does not serve' : getChainLabel(walletChainId)}.
            A link minted elsewhere would name a settlement asset this venue has not verified on that chain, and
            a buyer could never pay it.
          </p>
        ) : null}
      </section>

      {mint.kind === 'rejected' ? (
        <section className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
          <p className="text-[13px] leading-relaxed text-white/85">{mint.detail}</p>
          <p className="mt-2 text-[12px] leading-relaxed text-white/60">
            Nothing was signed and nothing was sent anywhere. Press the button again when you are ready.
          </p>
        </section>
      ) : null}

      {mint.kind === 'self-check-failed' ? (
        <section className="rounded-xl border border-rose-400/30 bg-rose-400/[0.06] p-4">
          <h2 className="text-sm font-semibold text-white">The signature did not verify</h2>
          <p className="mt-2 break-all text-[13px] leading-relaxed text-white/85">{mint.detail}</p>
        </section>
      ) : null}

      {mint.kind === 'signed' ? (
        <section className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4">
          <h2 className="text-sm font-semibold text-white">Your payment link</h2>
          <code className="mt-2 block break-all rounded bg-black/40 px-2 py-2 font-mono text-[12px] text-white/85">
            {mint.link}
          </code>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CopyButton
              text={mint.link}
              display="Copy the link"
              className="btn-secondary min-h-11 px-4 py-1.5 text-[12px]"
            />
            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? (
              <button
                type="button"
                onClick={() => {
                  void navigator
                    .share({ title: `Invoice ${mint.invoice.id}`, url: mint.link })
                    .then(() => setShared(true))
                    .catch(() => {
                      /* the sheet was dismissed — not an error, and not a claim that it sent */
                    });
                }}
                className="btn-secondary min-h-11 px-4 py-1.5 text-[12px]"
              >
                Share
              </button>
            ) : null}
            <a
              href={mint.link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center px-2 text-[12px] text-white/70 underline"
            >
              Open as the buyer
            </a>
          </div>
          {shared ? <p className="mt-2 text-[11px] text-white/50">Handed to your device's share sheet.</p> : null}
          <p className="mt-3 break-all text-[13px] leading-relaxed text-white/75">
            This link IS the invoice. It was signed by {mint.invoice.merchant} and carries every figure a buyer
            will sign against — {formatScaled(mint.invoice.settleAmount, mint.invoice.settleDecimals)}{' '}
            {mint.invoice.settleSymbol} on chain {mint.invoice.chainId}. Nothing on this venue stores it: if you
            lose the link, sign a new one. It is payable until{' '}
            {new Date(mint.invoice.expiresAt * 1000).toISOString()}.
          </p>
        </section>
      ) : null}

      {proofInvoice ? <ProofOfPaymentPanel invoice={proofInvoice} merchant={address ?? null} /> : null}

      {/* ── The optional store, behind the signed link ─────────────────── */}

      <section className={CARD}>
        <button
          type="button"
          onClick={() => setShowStore((v) => !v)}
          aria-expanded={showStore}
          className="btn-secondary min-h-11 px-4 py-1.5 text-[12px]"
        >
          {showStore ? 'Hide the short-link option' : 'Also publish a short link'}
        </button>
        <p className="mt-2 text-[12px] leading-relaxed text-white/60">
          A short <code className="text-white/80">/checkout?invoice=…</code> link is nicer to paste and is
          strictly weaker: it needs this deployment's invoice store to answer, and it can 404 on a link that has
          already gone out. The signed link above needs nothing.
        </p>

        {showStore ? (
          <div className="mt-3 space-y-3">
            <label htmlFor="inv-webhook" className="block text-[11px] uppercase tracking-wide text-white/55">
              Callback URL (optional, https only)
              <input
                id="inv-webhook"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://your-shop.example/hooks/memetic"
                className={`${FIELD} font-mono`}
              />
            </label>
            <p className="text-[11px] leading-relaxed text-amber-200/80">
              The callback is ONE signed POST, sent inline when a payment is reported. This venue runs no
              keeper, so a failed delivery is never retried — poll the claims list below rather than depending
              on it. If no signing secret is configured on the deployment, nothing is sent at all, because an
              unsigned callback is one anybody could forge.
            </p>
            <button
              type="button"
              onClick={onPublish}
              disabled={!draft || problems.length > 0 || publish.kind === 'publishing'}
              className="btn-secondary min-h-11 px-5 py-2 text-[13px]"
            >
              {publish.kind === 'publishing' ? 'Publishing…' : 'Publish the short link'}
            </button>
          </div>
        ) : null}
      </section>

      {publish.kind === 'failed' ? (
        <section className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
          <p className="text-[13px] leading-relaxed text-white/85">{publish.detail}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-white/75">
            The short-link store is not on this deployment. The signed link above works without it.
          </p>
          {publish.operatorStep ? (
            <p className="mt-2 text-[11px] leading-relaxed text-white/55">Operator: {publish.operatorStep}</p>
          ) : null}
        </section>
      ) : null}

      {publish.kind === 'published' ? (
        <section className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4">
          <h2 className="text-sm font-semibold text-white">Short link published</h2>
          <p className="mt-2 break-all text-[13px] text-white/85">
            {formatScaled(publish.invoice.settleAmount, publish.invoice.settleDecimals)}{' '}
            {publish.invoice.settleSymbol} to {publish.invoice.merchant}
          </p>
          <p className="mt-1 text-[12px] text-white/60">
            These are the figures the DATABASE stored, not the ones typed above.
          </p>
          <code className="mt-2 block break-all rounded bg-black/40 px-2 py-1 text-[12px] text-white/85">
            /checkout?invoice={publish.invoice.id}
          </code>
          <button
            type="button"
            onClick={() => loadClaims(publish.invoice.id)}
            className="btn-secondary mt-3 min-h-11 px-4 py-1.5 text-[12px]"
          >
            Check for reported payments
          </button>
        </section>
      ) : null}

      {claims.kind !== 'idle' ? (
        <section className={CARD}>
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
