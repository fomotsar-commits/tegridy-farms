import { m } from 'framer-motion';
import { JBAC_BONUS_BPS, LOCK_OPTIONS, EARLY_WITHDRAWAL_PENALTY_BPS } from '../../lib/constants';
import { calculateBoost } from '../../lib/boostCalculations';
import { isBootstrapApr, BOOTSTRAP_APR_NOTE } from '../../lib/copy';
import { ArtImg } from '../ArtImg';
import { FinePrint } from '../ui/FinePrint';

// Derive from the canonical constant so this table can't drift from the on-chain penalty.
const EARLY_WITHDRAWAL_PENALTY_PCT = EARLY_WITHDRAWAL_PENALTY_BPS / 100;

interface BoostScheduleTableProps {
  selectedLockLabel: string;
  aprNum?: number;
}

/**
 * The lock ladder as numbers in rows. Owner, 2026-10-14: as few words as
 * possible, the explanations in a closed drop-down. So the card is its heading,
 * one line, the rows, and the two small cards for the exit penalty and the
 * auto-max lock, each with one line; every sentence that explains them sits in
 * the one FinePrint at the foot of the card, word for word.
 */
export function BoostScheduleTable({ selectedLockLabel, aprNum }: BoostScheduleTableProps) {
  const baseApr = aprNum ?? 0;
  return (
    <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
      <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
        <div className="absolute inset-0">
          <ArtImg pageId="boost-schedule" idx={0} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 p-4 sm:p-6">
        <h3 className="heading-luxury text-white text-[20px] mb-3" id="boost-schedule-heading">Boost Schedule</h3>
        <p className="text-white text-[12px] mb-4">Lock longer, earn more.</p>

        {/* Desktop / tablet: flex-table layout with horizontal scroll fallback. Hidden below 480px.
            A11Y-R06: this used to declare role="table" over role="row" divs that
            contained no role="cell" at all — an invalid structure (axe
            aria-required-children), so a screen reader was told "table" and then
            found it empty — and it put aria-selected on a row, which is only
            valid inside a grid/treegrid (aria-allowed-attr). The mobile branch
            50 lines below already had the honest answer for the same data: a
            list with aria-current. Both breakpoints now say the same thing;
            only the visual layout still differs. */}
        <div className="hidden max-[480px]:hidden min-[481px]:block space-y-1.5 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <ul className="min-w-[320px] list-none p-0 m-0" aria-labelledby="boost-schedule-heading">
          {LOCK_OPTIONS.map((opt) => {
            const b = calculateBoost(opt.seconds);
            const withNft = b + JBAC_BONUS_BPS;
            const isSelected = selectedLockLabel === opt.label;
            return (
              <li key={opt.label} aria-current={isSelected ? 'true' : undefined}
                className="flex items-center justify-between rounded-lg px-3 sm:px-4 py-2 sm:py-2.5 mb-1.5"
                style={{
                  background: isSelected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.50)',
                  border: isSelected ? '1px solid var(--color-purple-20)' : '1px solid transparent',
                }}>
                <span className="text-white text-[12px] sm:text-[13px] flex-shrink-0">{opt.label}</span>
                <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
                  <span className="stat-value text-[13px] sm:text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(b / 10000).toFixed(2)}x</span>
                  {baseApr > 0 && <span className="text-emerald-400 text-[10px] sm:text-[11px] font-mono">{(baseApr * b / 10000).toFixed(1)}% APR</span>}
                  {baseApr === 0 && <span className="text-[10px] sm:text-[11px]" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>({(withNft / 10000).toFixed(2)}x w/NFT)</span>}
                </div>
              </li>
            );
          })}
          </ul>
        </div>

        {/* Mobile (<=480px): the same list, one row per lock. It used to print
            three label/value pairs per lock ("LOCK 7 Days / BOOST 0.40x / APR
            389.3%"), ninety pixels a row, so the seven rows ran a screen and a
            half; the labels now sit once, in a header row above the list. */}
        <div className="hidden max-[480px]:block">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 pb-1 text-[10px] uppercase tracking-wider text-white/60" aria-hidden="true">
            <span>Lock</span>
            <span className="text-right">Boost</span>
            <span className="text-right">{baseApr > 0 ? 'APR' : 'With NFT'}</span>
          </div>
          <ul className="flex flex-col gap-1.5 list-none p-0 m-0" aria-labelledby="boost-schedule-heading">
            {LOCK_OPTIONS.map((opt) => {
              const b = calculateBoost(opt.seconds);
              const withNft = b + JBAC_BONUS_BPS;
              const isSelected = selectedLockLabel === opt.label;
              return (
                <li key={opt.label} aria-current={isSelected ? 'true' : undefined}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 rounded-lg px-3 py-2.5"
                  style={{
                    background: isSelected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.50)',
                    border: isSelected ? '1px solid var(--color-purple-20)' : '1px solid transparent',
                    minHeight: '44px',
                  }}>
                  <span className="text-white text-[13px] font-medium">{opt.label}</span>
                  <span className="stat-value text-[14px] text-right" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(b / 10000).toFixed(2)}x</span>
                  {baseApr > 0 ? (
                    <span className="text-emerald-400 text-[12px] font-mono text-right">{(baseApr * b / 10000).toFixed(1)}%</span>
                  ) : (
                    <span className="text-[12px] text-right" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{(withNft / 10000).toFixed(2)}x</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* The one line that stays out of the drop-down: it is where money
            leaves, and what the treasury takes. */}
        <div className="mt-6 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(255,178,55,0.12)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="boost-schedule" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-4">
            <p className="text-warning/80 text-[12px] font-medium mb-1">Early Withdrawal</p>
            <p className="text-white text-[11px]">
              Leave early: {EARLY_WITHDRAWAL_PENALTY_PCT}% penalty, paid to the treasury.
            </p>
          </div>
        </div>

        <div className="mt-4 relative overflow-hidden rounded-lg" style={{ border: '1px solid var(--color-purple-75)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="boost-schedule" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-4">
            <p className="text-white text-[12px] font-medium mb-1">Auto-Max Lock</p>
            {/* STAKING_LOOK §2.7: "Disable anytime to let it expire naturally"
                was flagged FALSE in the contract's own natspec 2026-08-12 —
                enabling writes a full 4-year lockEnd immediately and nothing
                ever shortens it. The corrected copy is in the small print. */}
            <p className="text-white text-[11px]">
              A full 4-year lock, renewed on every claim.
            </p>
          </div>
        </div>

        <FinePrint summary="How it works" className="mt-3">
          <p>Lock longer = higher boost + more voting power. JBAC NFT holders get +0.5x bonus.</p>
          {/* The max-boost row shows base APR x4 — the largest number anywhere on
              the page. IncentivesStrip already refused to show a four-digit rate
              without this sentence; this table was rendering a bigger one without
              it. Same threshold, same words, one source (lib/copy.ts). */}
          {isBootstrapApr(baseApr) && (
            <p>
              {BOOTSTRAP_APR_NOTE}. These are the current rate multiplied by each lock&apos;s boost, not a promised yield.
            </p>
          )}
          <p>
            Early withdrawal: exit any time for a {EARLY_WITHDRAWAL_PENALTY_PCT}% penalty, which goes to the treasury.
          </p>
          <p>
            Auto-max lock sets a full 4-year lock now and re-extends it on every claim. Enable auto-max
            lock to keep maximum boost (4.0x) perpetually. Enabling immediately sets a full 4-year lock,
            and it re-extends on every claim. Disabling stops future re-extensions, but the current
            4-year lock stays; exiting before it ends always costs the {EARLY_WITHDRAWAL_PENALTY_PCT}%
            early-withdrawal penalty.
          </p>
        </FinePrint>
        </div>
      </div>
    </m.div>
  );
}
