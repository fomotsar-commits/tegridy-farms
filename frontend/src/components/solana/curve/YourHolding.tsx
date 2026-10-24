import { formatTokenAmount } from '../../../lib/launcher/solana/curve';
import { TOGGLE_CLS, baseUnitsToInput } from './uiFormat';
import type { Fact } from './facts';

const PICKS = [
  [25n, '25%'],
  [50n, '50%'],
  [100n, 'Max'],
] as const;

/**
 * Under a sell amount: what the connected wallet holds of this token, and 25% / 50% /
 * Max to fill the amount from it. A balance that could not be read says so and
 * offers no buttons: an unread balance is never 0 or an empty box.
 */
export function YourHolding({
  holding,
  decimals,
  onPick,
  disabled,
}: {
  /** The connected wallet's tokens (its main token account). `null` while reading. */
  holding: Fact<bigint> | null;
  decimals: number | null;
  onPick: (amountText: string) => void;
  disabled?: boolean;
}) {
  if (holding === null) return <p className="text-white/50 text-[10px] -mt-2 mb-3">You hold: reading…</p>;
  if (holding.kind === 'unreadable') {
    return <p className="text-white/50 text-[10px] -mt-2 mb-3">You hold: could not read ({holding.detail}).</p>;
  }
  const f = formatTokenAmount(holding.value, decimals, decimals ?? 0);
  return (
    <div className="-mt-2 mb-3 space-y-1.5" data-testid="your-holding">
      <p className="text-white/70 text-[11px]">
        You hold {f.text}
        {f.isBaseUnits ? ' (base units)' : ''}
      </p>
      {holding.value > 0n && (
        <div className="flex gap-1.5" role="group" aria-label="Sell part of what you hold">
          {PICKS.map(([pct, label]) => (
            <button
              key={label}
              type="button"
              disabled={disabled}
              onClick={() => onPick(baseUnitsToInput((holding.value * pct) / 100n, decimals))}
              className={`${TOGGLE_CLS} disabled:opacity-50`}
              style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
