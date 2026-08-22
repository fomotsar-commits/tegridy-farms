import { Link } from 'react-router-dom';
import { useYieldDCA } from '../../hooks/useYieldDCA';
import { DCA_YIELD_ROUND_TRIP_NOTE, type DcaAsset } from '../../lib/yield/dcaYield';
import { formatTokenAmount } from '../../lib/formatting';

// The idle half of a DCA schedule, said out loud.
//
// A schedule that buys 0.05 ETH of something thirty times has 1.5 ETH doing
// nothing for most of a month, and no panel in this app mentioned it. This one
// does — and its first job is to be clear about WHOSE 1.5 ETH: it never left the
// user's wallet, because a Tegridy schedule is a reminder rather than an escrow.
// The figure is the size of an opportunity, not a balance under management, and
// the copy has to keep saying so or it becomes a custody claim by implication.
//
// Both legs are unavailable in this build and both say why. The panel still
// renders, because the honest answer to "is my unfilled budget earning?" is "no,
// and here is exactly what would have to be true for it to" — which is more
// useful than the silence it replaces.

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
          ? `${plan.remainingSwaps} swap${plan.remainingSwaps === 1 ? '' : 's'} still to make. That amount stays in your own wallet — this schedule holds nothing — so it earns nothing while it waits.`
          : 'This schedule has no swaps left to make, so there is nothing left unspent.'}
      </p>

      <div className="mb-2">
        <p className="text-white text-[10px] uppercase tracking-wider mb-0.5">Park it while it waits</p>
        <p className="text-white/80 text-[10px] leading-relaxed">
          {plan.parking.state === 'available'
            ? `Would route to ${plan.parking.venue.label}. ${plan.parking.venue.counterparty}`
            : plan.parking.reason}
        </p>
      </div>

      <div className="mb-2">
        <p className="text-white text-[10px] uppercase tracking-wider mb-0.5">Stake completed buys</p>
        <p className="text-white/80 text-[10px] leading-relaxed">
          {plan.autoStake.state === 'available'
            ? `Would route to ${plan.autoStake.venue.label}. ${plan.autoStake.venue.counterparty}`
            : plan.autoStake.reason}
        </p>
      </div>

      <p className="text-amber-300 text-[10px] leading-relaxed mb-1.5">{plan.execution}</p>
      <p className="text-white/70 text-[10px] leading-relaxed">{DCA_YIELD_ROUND_TRIP_NOTE}</p>
      <p className="text-white/70 text-[10px] leading-relaxed mt-1.5">
        The venues these legs would use, their rates and what each one exposes you to are listed on{' '}
        <Link to="/yield" className="text-emerald-400/90 hover:text-emerald-300 underline transition-colors">
          Yield Routing
        </Link>
        .
      </p>
    </div>
  );
}

export default DcaYieldPanel;
