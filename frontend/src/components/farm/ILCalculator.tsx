import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { formatCurrency } from '../../lib/formatting';

/**
 * ⚠️ THE LABELS ARE PAIR-AGNOSTIC AS OF 2026-09-05, and that is a correctness
 * fix rather than a wording preference.
 *
 * This component was written inside LPFarmingSection, on the TOWELI farm, where
 * naming TOWELI was simply naming the pool in front of the reader. It was then
 * promoted onto the venue's /liquidity page — which is the Pools section's
 * landing tab and the second BottomNav tab, so EVERY arrival reaches it — and
 * sits below a form where the visitor may have selected any ERC-20 pair. There
 * it taught impermanent loss in one resident's ticker to a reader the venue was
 * speaking to, about a pair they may not have chosen: the same
 * one-resident's-token-as-the-venue's shape the 2026-09-05 voice fix removed
 * from /farm and /dashboard, arriving by RELOCATION instead of by a bad gate.
 *
 * The maths at the top of this file was always pair-agnostic — only three
 * strings were not. `pairLabel` lets a caller that genuinely knows the pair name
 * it; both current call sites sit under a heading that already does, so neither
 * passes one.
 */
export function ILCalculator({ pairLabel }: { pairLabel?: string } = {}) {
  const [open, setOpen] = useState(false);
  // Percentage change in the pooled token's price against the other side.
  const [priceChange, setPriceChange] = useState(50);
  const token = pairLabel ?? 'the pooled token';

  // IL formula: IL = 2 * sqrt(r) / (1 + r) - 1, where r = new_price / old_price
  const r = 1 + priceChange / 100;
  const rPositive = Math.max(r, 0.01); // prevent division by zero
  const il = 2 * Math.sqrt(rPositive) / (1 + rPositive) - 1;
  const ilPercent = il * 100;

  // Example with $1000 deposit
  const deposit = 1000;
  const holdValue = deposit * (1 + (rPositive - 1) / 2); // 50% in each token, one changed
  // IL is defined RELATIVE TO HOLDING, so it must be applied to holdValue — not to
  // the deposit. Applying it to the deposit understated LP downside on a price drop
  // (it could even show LPing beating HODL on a 50% dump). Equivalent to
  // deposit * Math.sqrt(rPositive); kept in this form so the relationship is explicit.
  const lpValue = holdValue * (1 + il);

  return (
    <div className="mt-4">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-[12px] text-white hover:text-white transition-colors cursor-pointer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
        {open ? 'Hide' : 'Impermanent Loss Calculator'}
      </button>

      <AnimatePresence>
        {open && (
          <m.div className="glass-card rounded-xl p-5 mt-3"
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <h4 className="text-white text-[14px] font-semibold mb-1">Impermanent Loss Calculator</h4>
            <p className="text-white text-[11px] mb-4">
              Estimate how much you&apos;d lose vs. simply holding, based on the price change of{' '}
              {token} against the other side of the pair.
            </p>

            {/* Price change slider */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-white text-[11px]">Price change</span>
                <span className={`stat-value text-[14px] ${priceChange >= 0 ? 'text-success' : 'text-danger'}`}>
                  {priceChange >= 0 ? '+' : ''}{priceChange}%
                </span>
              </div>
              <input type="range" min="-90" max="500" value={priceChange}
                aria-label="Price change percentage of the pooled token"
                onChange={e => setPriceChange(parseInt(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{ background: `linear-gradient(90deg, var(--color-danger) 0%, var(--color-primary) 50%, var(--color-success) 100%)` }} />
              <div className="flex justify-between text-white text-[9px] mt-1">
                <span>-90%</span>
                <span>0%</span>
                <span>+500%</span>
              </div>
            </div>

            {/* Results */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="rounded-lg p-3 text-center" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-1">IL</p>
                <p className="stat-value text-[15px] text-danger">{ilPercent.toFixed(2)}%</p>
              </div>
              <div className="rounded-lg p-3 text-center" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-1">LP Value</p>
                <p className="stat-value text-[13px] text-white">{formatCurrency(Math.max(lpValue, 0))}</p>
              </div>
              <div className="rounded-lg p-3 text-center" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-1">HODL Value</p>
                <p className="stat-value text-[13px] text-white">{formatCurrency(Math.max(holdValue, 0))}</p>
              </div>
            </div>

            <p className="text-white text-[10px] mt-3 text-center">
              Based on $1,000 initial deposit. IL is offset by trading fees & farm rewards.
            </p>

            {/* What is IL tooltip */}
            <details className="mt-3">
              <summary className="text-[11px] text-white cursor-pointer hover:text-white transition-colors">
                What is Impermanent Loss?
              </summary>
              <p className="text-white text-[11px] mt-2 leading-relaxed">
                When you provide liquidity to an AMM pool, the ratio of your tokens changes as the price moves.
                If you had simply held the tokens instead, you might have more value — that difference is called
                impermanent loss. It's "impermanent" because it reverses if prices return to their original ratio.
                Farm rewards and trading fees can offset IL over time.
              </p>
            </details>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
