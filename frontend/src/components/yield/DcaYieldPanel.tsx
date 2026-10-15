import { Link } from 'react-router-dom';
import { useYieldDCA } from '../../hooks/useYieldDCA';
import { DCA_YIELD_ROUND_TRIP_NOTE, type DcaAsset } from '../../lib/yield/dcaYield';
import { formatTokenAmount } from '../../lib/formatting';
import { FinePrint } from '../ui/FinePrint';

// The idle half of a DCA schedule, said out loud.
//
// A schedule that buys 0.05 ETH of something thirty times has 1.5 ETH doing
// nothing for most of a month, and no panel in this app mentioned it. This one
// does — and its first job is to be clear about WHOSE 1.5 ETH: it never left the
// user's wallet, because a schedule here is a reminder rather than an escrow.
// The figure is the size of an opportunity, not a balance under management, and
// the copy has to keep saying so or it becomes a custody claim by implication.
//
// Each leg is keyed to the BUDGET's own token. That distinction cost nothing
// while every venue was unwired and every branch refused; the moment Aave's USDC
// market became a real destination, an unkeyed lookup would have told the holder
// of an ETH schedule their idle ETH "would route to Aave v3 — USDC market" — a
// token they do not hold and a deposit that would revert.
//
// And the available branch describes a DESTINATION, not an action. This schedule
// deposits nothing: the venue holds no funds, runs no keeper, and every leg is a
// transaction the user signs themselves on the Yield Routing page.
//
// FEWER WORDS (owner, 2026-10-13). The face says the amount, where it could go
// and that nothing runs on its own; every full sentence sits in the FinePrint,
// once each (DcaYieldPanel.test finds each by text, so none may be doubled).

export interface DcaYieldPanelProps {
  amountPerSwap: string;
  totalSwaps: number;
  completedSwaps?: number;
  /** What the amount is in. No default — the ticker is printed, not guessed. */
  asset: DcaAsset;
}

export function DcaYieldPanel({ amountPerSwap, totalSwaps, completedSwaps = 0, asset }: DcaYieldPanelProps) {
  const result = useYieldDCA({ amountPerSwap, totalSwaps, completedSwaps, asset });

  if (!result.ok) {
    return (
      <div className="rounded-lg p-3 mt-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
        <p className="text-white text-[11px] uppercase tracking-wider mb-1">Idle budget</p>
        <p className="text-white/80 text-[11px] leading-relaxed">{result.reason}</p>
      </div>
    );
  }

  const { plan } = result;

  return (
    <div
      className="rounded-lg p-3 mt-3"
      style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-white text-[11px] uppercase tracking-wider">Idle budget</span>
        <span className="text-white font-mono text-[13px]">
          {formatTokenAmount(plan.idleAmount)} {plan.asset.symbol}
        </span>
      </div>
      <p className="text-white/80 text-[10px] leading-relaxed mb-2">
        {plan.remainingSwaps > 0
          ? `${plan.remainingSwaps} swap${plan.remainingSwaps === 1 ? '' : 's'} still to make. It waits in your wallet, earning nothing.`
          : 'No swaps left, so nothing is unspent.'}
      </p>

      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] leading-relaxed">
        <dt className="text-white uppercase tracking-wider">Park it</dt>
        <dd className="text-white/80">
          {plan.parking.state === 'available' ? `${plan.parking.venue.label}, on Yield Routing` : 'Not available'}
        </dd>
        <dt className="text-white uppercase tracking-wider">Stake buys</dt>
        <dd className="text-white/80">
          {plan.autoStake.state === 'available' ? `${plan.autoStake.venue.label}, on Yield Routing` : 'Not available'}
        </dd>
      </dl>

      <p className="text-amber-300 text-[10px] leading-relaxed">Nothing runs on its own. You sign each step.</p>

      <FinePrint summary="How it works">
        {plan.remainingSwaps > 0 ? (
          <p>
            That amount stays in your own wallet — this schedule holds nothing — so it earns nothing while it waits.
          </p>
        ) : null}
        <p>
          <span className="text-white">Park it while it waits:</span>{' '}
          {plan.parking.state === 'available'
            ? `Could be deposited into ${plan.parking.venue.label} from the Yield Routing page — this schedule does not do it; each deposit and withdrawal is a transaction you sign there. ${plan.parking.venue.counterparty}`
            : plan.parking.reason}
        </p>
        <p>
          <span className="text-white">Stake completed buys:</span>{' '}
          {plan.autoStake.state === 'available'
            ? `Could be deposited into ${plan.autoStake.venue.label} from the Yield Routing page — this schedule does not do it; each deposit and withdrawal is a transaction you sign there. ${plan.autoStake.venue.counterparty}`
            : plan.autoStake.reason}
        </p>
        <p>{plan.execution}</p>
        <p>{DCA_YIELD_ROUND_TRIP_NOTE}</p>
        <p>
          The venues these legs would use, their rates and what each one exposes you to are listed on{' '}
          <Link to="/yield" className="text-emerald-400/90 hover:text-emerald-300 underline transition-colors">
            Yield Routing
          </Link>
          .
        </p>
      </FinePrint>
    </div>
  );
}

export default DcaYieldPanel;
