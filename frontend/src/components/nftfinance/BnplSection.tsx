import { useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { m } from 'framer-motion';
import { HowItWorks, RiskBanner, InfoTooltip, TxSummary } from '../ui/InfoTooltip';
import { useBnplDesk, BNPL_WRITTEN_TERMS } from '../../hooks/useBnplDesk';
import { useBnplQuote } from '../../hooks/useBnplQuote';
import { usePooledLendingVaults } from '../../hooks/usePooledLendingVault';
import { isBnplLive, POOLED_VAULT_WRITTEN_TERMS } from '../../hooks/usePooledLendingConfig';

// Buy-now-pay-later at the point of sale (#62).
//
// WHY THIS IS NOT A BUTTON ON THE MARKETPLACE'S BUY PATH. Every buy route in
// the marketplace binds the paying wallet to the connected wallet, and that
// guard exists because users once paid from the wrong account. A financed
// purchase genuinely has a different payer — a contract fronts part of the
// price — so it settles through its own contract path rather than through a
// flag that would switch the guard off for everyone. Nothing on this surface
// touches a Seaport order, a conduit approval or the marketplace's fulfil code.
//
// The desk is deployed nowhere. Every figure below is either read live or
// labelled as an ESTIMATE against the written terms; none of it is presented as
// a live reading while there is no contract to read.

const CARD_BG = 'rgba(6, 12, 26, 0.80)';
const CARD_BORDER = 'rgba(255, 255, 255, 0.18)';
const LABEL_STYLE: React.CSSProperties = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' };
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function eth(wei: bigint): string {
  const n = Number(formatEther(wei));
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 5 })} ETH`;
}

function parsePrice(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // A sale price is never this long, and the cap bounds the work a paste into the
  // price field can make this function do.
  if (trimmed.length > 80) return null;
  // Written as an unambiguous alternation rather than `^\d*\.?\d*$`: two adjacent
  // `\d*` around an optional dot let the engine split a long digit run many ways,
  // which is quadratic backtracking on a near-miss (CodeQL js/polynomial-redos).
  // Same form as parseDecimalToBaseUnits in lib/launcher/solana/curve/format.ts.
  // It also rejects a bare '.', which parseEther threw on anyway — both paths
  // return null, so nothing this surface renders changes.
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  try {
    const wei = parseEther(trimmed);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

// Where each half of the estimator's terms came from. Four states, because
// collapsing them is how a surface ends up telling a visitor "no deployment
// exists to read" about a desk that is deployed and merely unreachable, or
// quoting a pool APR nothing was asked for. Two contracts have to be live for
// the estimator to be quoting anything real, and the label names whichever one
// is not.
type TermsSource = 'live' | 'desk-not-deployed' | 'desk-unreadable' | 'pool-unavailable';

const TERMS_PROVENANCE: Record<TermsSource, string> = {
  live: 'Terms read live from the deployed desk and its funding pool.',
  'desk-not-deployed':
    'Terms taken from the contract source, because no deployment exists to read. Treat every figure below as an illustration of the written terms.',
  'desk-unreadable':
    'The desk exists but could not be read just now, so the terms below are the ones written in the contract source rather than the ones it is running. They may differ.',
  'pool-unavailable':
    'The desk’s own terms are live, but the pool that would fund the financed leg could not be read, so the APR and origination fee below are the written defaults rather than what the pool charges.',
};

export function BnplSection() {
  const desk = useBnplDesk();
  const vaults = usePooledLendingVaults();
  const live = isBnplLive();

  // The pool that would fund the financed leg sets the APR and the origination
  // fee; the desk sets the deposit and the schedule. Either side can be absent
  // independently, so neither borrows the other's numbers.
  const fundingPool = vaults.find((v) => v.status === 'live') ?? null;
  const termsSource: TermsSource =
    desk.status === 'not-deployed'
      ? 'desk-not-deployed'
      : desk.status === 'unreadable'
        ? 'desk-unreadable'
        : fundingPool === null
          ? 'pool-unavailable'
          : 'live';

  const terms = {
    depositBps: desk.depositBps ?? BNPL_WRITTEN_TERMS.depositBps,
    // Origination is the POOL's dial, not the desk's `saleFeeBps` — the latter
    // comes out of the seller's proceeds and never reaches the buyer's upfront.
    aprBps: fundingPool?.aprBps ?? POOLED_VAULT_WRITTEN_TERMS.aprBps,
    originationFeeBps: fundingPool?.originationFeeBps ?? POOLED_VAULT_WRITTEN_TERMS.originationFeeBps,
    instalments: desk.instalments ?? BNPL_WRITTEN_TERMS.instalments,
    instalmentIntervalSeconds:
      desk.instalmentIntervalSeconds ?? BNPL_WRITTEN_TERMS.instalmentIntervalSeconds,
  };

  // Two preconditions sit between a quote and a plan the chain would actually
  // open, and both are enforced by the contracts rather than by this surface.
  // An estimator that showed a schedule without naming them would imply a plan
  // is available at any price, which is the same lie as implying depth.
  const planSpanSeconds =
    terms.instalments * terms.instalmentIntervalSeconds +
    (desk.paymentGraceSeconds ?? BNPL_WRITTEN_TERMS.paymentGraceSeconds);
  const poolTermSeconds = fundingPool?.loanDurationSeconds ?? POOLED_VAULT_WRITTEN_TERMS.loanDurationSeconds;
  const poolTermCoversPlan = poolTermSeconds >= planSpanSeconds;
  // The pool lends a fraction of a floor it has been told, so the financed leg
  // has a ceiling. It is only knowable from a live pool with a fresh floor;
  // absent that, the honest answer is that it cannot be checked here.
  const financedCeilingWei = fundingPool?.maxPrincipalWei ?? null;

  const [priceInput, setPriceInput] = useState('');
  const priceWei = parsePrice(priceInput);
  const quote = useBnplQuote(priceWei, terms);

  return (
    <m.div
      className="space-y-6"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
    >
      <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <h2 className="text-[16px] font-semibold text-white mb-1" style={LABEL_STYLE}>
          Pay in instalments
        </h2>
        <p className="text-[12px] text-white/70 leading-relaxed" style={LABEL_STYLE}>
          A buyer puts a deposit down, the lending pool fronts the rest, and the seller is paid in full immediately. The
          token sits in the pool&rsquo;s escrow until the plan is cleared. There is no promotional rate and no interest-free
          window: the financed part is a loan from the pool and it costs what the pool charges.
        </p>
      </div>

      <RiskBanner variant="danger">
        <span className="font-semibold">Missing a payment costs you the token.</span> If an instalment goes unpaid past
        its grace period, anyone may wind the plan up: the escrowed token is sold through the pool&rsquo;s liquidation route,
        the pool is repaid first, and only what is left over comes back to you. Payments you have already made reduce
        the debt, so they sit inside that leftover rather than being lost ahead of it — but a sale below the debt returns
        nothing. Nothing here reminds you or pays for you; this venue runs no keeper, and a due date passes whether or
        not anything notices.
      </RiskBanner>

      {!live && (
        <div
          className="rounded-xl p-4"
          style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)' }}
        >
          <p className="text-[13px] font-semibold text-amber-300 mb-1" style={LABEL_STYLE}>
            The instalment desk is not deployed.
          </p>
          <p className="text-[12px] text-white/70 leading-relaxed" style={LABEL_STYLE}>
            {desk.detail} No listing can be made and no plan can be opened. The estimator below runs entirely in your
            browser against the terms written in the contract source, so you can see what a plan would cost — it is not
            a quote from a live desk, and no live desk exists to give one.
          </p>
        </div>
      )}

      {/* ── Cost-of-credit estimator ───────────────────────────────── */}
      <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <div className="flex items-center gap-1 mb-2">
          <h3 className="text-[14px] font-semibold text-white" style={LABEL_STYLE}>
            What a plan would cost
          </h3>
          <InfoTooltip text="Interest accrues against elapsed time, not against the schedule. Paying late costs more than this and paying early costs less." />
        </div>

        <label className="block text-[11px] uppercase tracking-wide text-white/55 mb-1" style={LABEL_STYLE}>
          Sale price (ETH)
          <input
            type="text"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            placeholder="1.5"
            className="mt-1 w-full rounded-lg px-3 py-2 text-[14px] text-white bg-black/40 border border-white/15 outline-none focus:border-emerald-500/50"
          />
        </label>

        <p className="text-[11px] text-white/50 mt-2 leading-relaxed" style={LABEL_STYLE}>
          {TERMS_PROVENANCE[termsSource]}{' '}
          Deposit {(terms.depositBps / 100).toFixed(2)}%, APR {(terms.aprBps / 100).toFixed(2)}%,{' '}
          {terms.instalments} payments {Math.round(terms.instalmentIntervalSeconds / 86400)} days apart.
        </p>

        {priceInput.trim() !== '' && priceWei === null && (
          <p className="text-[12px] text-amber-300 mt-3" style={LABEL_STYLE}>
            That is not a price this can quote against, so nothing is shown rather than a zero.
          </p>
        )}

        {quote && (
          <div className="mt-4 space-y-3">
            <TxSummary>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <span>Deposit, paid now</span>
                <span className="text-right text-white font-semibold">{eth(quote.depositWei)}</span>
                <span>Origination fee, paid now</span>
                <span className="text-right text-white font-semibold">{eth(quote.originationWei)}</span>
                <span>Financed by the pool</span>
                <span className="text-right text-white font-semibold">{eth(quote.financedWei)}</span>
                <span>Interest over the schedule</span>
                <span className="text-right text-white font-semibold">{eth(quote.interestWei)}</span>
                <span className="font-semibold">Total you pay</span>
                <span className="text-right text-white font-semibold">{eth(quote.totalWei)}</span>
                <span>Cost of credit over the price</span>
                <span className="text-right text-white font-semibold">
                  {(quote.costOfCreditBps / 100).toFixed(2)}%
                </span>
              </div>
            </TxSummary>

            <div
              className="rounded-lg p-3"
              style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)' }}
            >
              <p className="text-[11px] uppercase tracking-wide text-amber-300 mb-1.5" style={LABEL_STYLE}>
                What still has to be true for this plan to open
              </p>
              <ul className="space-y-1.5 text-[11.5px] leading-relaxed text-white/70" style={LABEL_STYLE}>
                <li>
                  <span className="text-white/85 font-semibold">The pool has to be willing to lend {eth(quote.financedWei)}.</span>{' '}
                  {financedCeilingWei === null ? (
                    <>
                      The financed leg is capped at a fraction of the floor the pool has been told, and no live pool with a
                      fresh floor could be read, so that cap cannot be checked from here. This estimate is not a
                      confirmation that the amount is available.
                    </>
                  ) : quote.financedWei > financedCeilingWei ? (
                    <>
                      Right now the pool would lend at most {eth(financedCeilingWei)} against one token, so a plan at this
                      price would be refused on-chain.
                    </>
                  ) : (
                    <>The pool would currently lend up to {eth(financedCeilingWei)} against one token, so this amount fits.</>
                  )}
                </li>
                <li>
                  <span className="text-white/85 font-semibold">The pool&rsquo;s loan term has to outlast the schedule.</span>{' '}
                  The plan runs {Math.round(planSpanSeconds / 86400)} days including grace, against a pool term of{' '}
                  {Math.round(poolTermSeconds / 86400)} days
                  {fundingPool === null ? ' in the written source' : ''}.{' '}
                  {poolTermCoversPlan
                    ? 'That covers it.'
                    : 'That does not cover it, and the desk refuses the purchase rather than letting the loan mature mid-schedule and cost a paying buyer the token.'}
                </li>
              </ul>
            </div>

            <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <p className="text-[11px] uppercase tracking-wide text-white/55 mb-1.5" style={LABEL_STYLE}>
                Payment schedule
              </p>
              <ul className="space-y-1">
                {quote.instalmentsWei.map((amount, i) => (
                  <li key={i} className="flex justify-between text-[12px] text-white/75" style={LABEL_STYLE}>
                    <span>
                      Payment {i + 1} &mdash; day {Math.round(((i + 1) * terms.instalmentIntervalSeconds) / 86400)}
                    </span>
                    <span className="text-white font-semibold">{eth(amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <HowItWorks
        storageKey="tegridy-bnpl-how"
        title="How an instalment purchase works"
        steps={[
          {
            label: 'The seller states an on-chain intent',
            description:
              'A price and an expiry, with an approval granted to the instalment contract alone. The marketplace listing approval is never reused for this — a permission to sell at a signed price must not double as a permission to move a token for nothing.',
          },
          {
            label: 'The buyer pays the deposit',
            description:
              'The deposit plus the pool’s origination fee leave the buyer’s wallet in one transaction. The seller receives the full price in the same transaction and has no further exposure to the plan.',
          },
          {
            label: 'The pool fronts the rest and holds the token',
            description:
              'The financed part is an ordinary loan from the collection’s lending pool, and the token sits in that pool’s escrow — one escrow and one liquidation path, not a second copy of the same machinery.',
          },
          {
            label: 'Each payment retires principal plus accrued interest',
            description:
              'Payments reduce the real debt, so a buyer’s equity is inside the loan rather than a number tracked beside it. The final payment clears the loan and the token is released to the buyer.',
          },
          {
            label: 'A missed payment can be wound up by anyone',
            description:
              'After the grace period the plan can be forfeited by any caller. Nothing does this on a schedule. The token goes to the pool’s liquidation route, the pool is repaid first, and any surplus is paid to the buyer by the pool directly.',
          },
        ]}
      />
    </m.div>
  );
}
