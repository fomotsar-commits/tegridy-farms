import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatUnits } from 'viem';
import { useSwitchChain } from 'wagmi';
import { ArtCard } from '../ui/ArtCard';
import { getAddressUrl } from '../../lib/explorer';
import { useYieldDeposit } from '../../hooks/useYieldDeposit';
import { YIELD_CHAIN_ID, YIELD_NO_FEE_NOTE, YIELD_THIRD_PARTY_NOTE } from '../../lib/yield/deposit';
import type { RocketGateReads } from '../../lib/yield/reads';
import type { YieldVenue } from '../../lib/yield/venues';

// The money path's one screen.
//
// EVERY STEP IS NAMED BEFORE THE FIRST SIGNATURE. An approve→deposit route is
// rendered as a two-item ordered list with the current step marked, so nobody
// signs an approval believing it was the deposit — the single most common way a
// two-transaction flow leaves a user thinking they are done when their money has
// not moved. The step list is rendered from the plan, so it cannot disagree with
// what the button will actually submit.
//
// NO CONTROL IS OFFERED THAT CANNOT FIRE. Every refusal state renders its own
// sentence and a disabled button, or a control that fixes the specific problem
// (connect, switch chain, go and get the asset). A button that is enabled and
// then fails at the wallet is worse than one that was never enabled.
//
// THE DESTINATION IS SHOWN IN FULL, with an explorer link, because "non-custodial"
// is a claim a reader should be able to check rather than take.

export interface YieldDepositPanelProps {
  venue: YieldVenue;
  rocket: RocketGateReads | null;
  /** Rocket Pool's live deposit fee, 1e18-scaled, read on the page. */
  depositFee1e18?: bigint | null;
  block: number | null;
}

export function YieldDepositPanel({ venue, rocket, depositFee1e18, block }: YieldDepositPanelProps) {
  const [amountText, setAmountText] = useState('');
  const inputId = useId();
  const { switchChain } = useSwitchChain();
  const deposit = useYieldDeposit({ venue, amountText, rocket });
  const { plan } = deposit;

  const route = venue.route;
  const movingAsset = route.kind === 'erc20-supply' ? route.asset.symbol : 'ETH';
  const assetDecimals = route.kind === 'erc20-supply' ? route.asset.decimals : 18;
  const heldRaw = route.kind === 'erc20-supply' ? deposit.assetBalance : deposit.nativeBalance;
  const steps = plan.state === 'ready' || plan.state === 'needs-approval' ? plan.steps : [];
  const busy = deposit.phase === 'submitting' || deposit.phase === 'confirming';

  const setMax = () => {
    if (heldRaw === null || route.kind !== 'erc20-supply') return;
    setAmountText(formatUnits(heldRaw, assetDecimals));
  };

  return (
    <ArtCard pageId="yield" idx={3} className="mt-3" padding="p-4">
      <h4 className="text-text-primary font-semibold text-[13px] mb-2">{route.kind === 'none' ? venue.label : route.cta}</h4>

      {/* Counterparty and loss mode again, ABOVE the button. The reader who
          scrolled past them on the comparison row is exactly the reader about
          to sign, and repeating them here costs nothing they have not chosen. */}
      <div className="rounded-lg p-3 mb-3" style={{ background: 'rgba(0,0,0,0.30)' }}>
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">Whose risk you take</p>
        <p className="text-[12px] text-text-secondary leading-relaxed mb-1.5">{venue.counterparty}</p>
        <p className="text-[12px] text-text-secondary leading-relaxed">{venue.riskNote}</p>
      </div>

      {venue.id === 'etherfi-weeth' && (
        <p className="text-[11px] text-amber-300/90 leading-relaxed mb-2">
          Three signatures. You hold eETH after the first one and may stop there — that is already a real staked
          position. A wei of eETH dust may remain after the wrap.
        </p>
      )}

      {venue.id === 'rocketpool-reth' && depositFee1e18 != null && (
        <p className="text-[11px] text-text-secondary leading-relaxed mb-2">
          Rocket Pool charges a {(Number(depositFee1e18) / 1e16).toFixed(2)}% deposit fee, read from
          RocketDAOProtocolSettingsDeposit at block {block ?? 'unknown'}.
          {rocket?.maxPoolSize != null && rocket.poolBalance != null && (
            <>
              {' '}
              Room in the deposit pool right now:{' '}
              {formatUnits(rocket.maxPoolSize > rocket.poolBalance ? rocket.maxPoolSize - rocket.poolBalance : 0n, 18)} ETH.
            </>
          )}
        </p>
      )}

      <label htmlFor={inputId} className="block text-[11px] text-text-secondary mb-1">
        Amount of {movingAsset} to deposit
      </label>
      <div className="flex gap-2 mb-1">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          placeholder="0.0"
          aria-describedby={`${inputId}-balance`}
          className="flex-1 min-w-0 rounded-lg px-3 min-h-11 text-[16px] font-mono bg-black/40 text-text-primary border border-white/10"
        />
        {route.kind === 'erc20-supply' && (
          <button type="button" onClick={setMax} className="btn-secondary px-4 min-h-11 text-[12px] shrink-0">
            Max
          </button>
        )}
      </div>
      <p id={`${inputId}-balance`} className="text-[11px] text-text-muted mb-3 leading-snug">
        {heldRaw === null
          ? `Your ${movingAsset} balance could not be read, so nothing below assumes one.`
          : `You hold ${formatUnits(heldRaw, assetDecimals)} ${movingAsset}.`}
        {route.kind !== 'erc20-supply' && ' Leave some ETH behind for gas — this page cannot spend your whole balance.'}
      </p>

      {steps.length > 0 && (
        <ol className="list-decimal pl-5 mb-3 space-y-1">
          {steps.map((step, i) => (
            <li
              key={step.label}
              className={`text-[12px] leading-relaxed ${i === deposit.stepIndex ? 'text-text-primary' : 'text-text-muted'}`}
            >
              {step.label}
              {i === deposit.stepIndex && <span className="text-emerald-400/80"> — this signature</span>}
            </li>
          ))}
        </ol>
      )}

      <PlanControl plan={plan} venue={venue} busy={busy} onSubmit={deposit.submit} onSwitch={() => switchChain({ chainId: YIELD_CHAIN_ID })} />

      {deposit.receiptBalances !== null && (
        <p className="text-[11px] text-text-secondary mt-2 leading-relaxed">
          {deposit.receiptBalances.symbol}:{' '}
          {formatUnits(deposit.receiptBalances.before, deposit.receiptBalances.decimals)} at block{' '}
          {deposit.receiptBalances.beforeBlock} →{' '}
          {formatUnits(deposit.receiptBalances.after, deposit.receiptBalances.decimals)} at block{' '}
          {deposit.receiptBalances.afterBlock}. That difference includes any rebase or interest accrued between those
          two blocks.
        </p>
      )}
      {deposit.explorerUrl !== null && (
        <p className="text-[11px] mt-1">
          <a href={deposit.explorerUrl} target="_blank" rel="noopener noreferrer" className="text-emerald-400/80 underline">
            View the transaction on the explorer
          </a>
        </p>
      )}

      <p className="text-[11px] text-text-muted mt-3 leading-relaxed">
        Non-custodial: this transaction goes from your wallet to {venue.issuer} at{' '}
        <a
          href={getAddressUrl(YIELD_CHAIN_ID, venue.depositTarget)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono break-all text-emerald-400/80 underline"
        >
          {venue.depositTarget}
        </a>
        . Nothing on this page holds, forwards or can recover it.
      </p>
      <p className="text-[11px] text-text-muted mt-1.5 leading-relaxed">
        {YIELD_NO_FEE_NOTE} {YIELD_THIRD_PARTY_NOTE}
      </p>
    </ArtCard>
  );
}

/**
 * One control per plan state, and no default branch.
 *
 * The exhaustive switch is the guard: adding a state to `DepositPlan` without
 * deciding what the panel offers for it stops the build, rather than falling
 * through to an enabled button whose behaviour nobody chose.
 */
function PlanControl({
  plan,
  venue,
  busy,
  onSubmit,
  onSwitch,
}: {
  plan: ReturnType<typeof useYieldDeposit>['plan'];
  venue: YieldVenue;
  busy: boolean;
  onSubmit: () => void;
  onSwitch: () => void;
}) {
  const disabled = (label: string, reason: string) => (
    <>
      <button type="button" disabled aria-disabled className="btn-primary w-full min-h-11 text-[13px] opacity-70 cursor-not-allowed">
        {label}
      </button>
      <p className="text-[11px] text-text-muted mt-1.5 leading-snug">{reason}</p>
    </>
  );

  switch (plan.state) {
    case 'unroutable':
      return disabled(venue.route.kind === 'none' ? venue.label : 'Unavailable', plan.reason);
    case 'no-wallet':
      return disabled(
        'Connect a wallet to continue',
        'Nothing can be signed without a wallet. Use the Connect control in the header — this page never asks for a key.',
      );
    case 'wrong-chain':
      return (
        <>
          <button type="button" onClick={onSwitch} className="btn-primary w-full min-h-11 text-[13px]">
            Switch to Ethereum mainnet
          </button>
          <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
            Every venue on this page is on Ethereum mainnet. Your wallet is on another chain, where these contracts do
            not exist.
          </p>
        </>
      );
    case 'invalid-amount':
      return disabled('Enter an amount', plan.reason);
    case 'needs-asset':
      return (
        <>
          <button type="button" disabled aria-disabled className="btn-primary w-full min-h-11 text-[13px] opacity-70 cursor-not-allowed">
            You hold no {plan.asset.symbol}
          </button>
          <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
            This page does not swap. Get {plan.asset.symbol} on the{' '}
            <Link to="/swap" className="text-emerald-400/80 underline">
              trade page
            </Link>{' '}
            first, then come back.
          </p>
        </>
      );
    case 'insufficient':
      return disabled(
        'Not enough to deposit',
        `You hold ${formatUnits(plan.have, plan.decimals)} ${plan.unit} and this deposit needs ${formatUnits(plan.need, plan.decimals)} ${plan.unit}` +
          (plan.unit === 'ETH' ? ', with something left over for gas.' : '.'),
      );
    case 'venue-paused':
      return disabled('Deposits are not open here right now', plan.reason);
    case 'venue-full':
      return disabled(
        'The deposit pool is full',
        `Rocket Pool's deposit pool has room for ${formatUnits(plan.roomWei, 18)} ETH right now, read from the chain — less than this deposit.`,
      );
    case 'below-minimum':
      return disabled(
        'Below the protocol minimum',
        `Rocket Pool will not accept less than ${formatUnits(plan.minimum, 18)} ETH, read from RocketDAOProtocolSettingsDeposit.`,
      );
    case 'needs-approval':
      return (
        <>
          <button type="button" onClick={onSubmit} disabled={busy} className="btn-primary w-full min-h-11 text-[13px] disabled:opacity-70">
            {busy ? 'Waiting for your wallet…' : `Step 1 of 2 — approve ${formatUnits(plan.amount, plan.asset.decimals)} ${plan.asset.symbol}`}
          </button>
          <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
            This approval is for exactly this amount and no more, and it only lets {plan.spender} move that much. It
            does not deposit anything — the deposit is the second signature.
          </p>
        </>
      );
    case 'ready':
      return (
        <>
          <button type="button" onClick={onSubmit} disabled={busy} className="btn-primary w-full min-h-11 text-[13px] disabled:opacity-70">
            {busy ? 'Waiting for confirmation…' : (venue.route.kind === 'none' ? 'Deposit' : venue.route.cta)}
          </button>
          <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
            No amount is quoted back to you before you sign, because this page cannot know what the protocol will mint
            — the balance read afterwards is the only figure it will show you.
          </p>
        </>
      );
  }
}

export default YieldDepositPanel;
