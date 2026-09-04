import { m } from 'framer-motion';
import { JBAC_BONUS_BPS, LOCK_OPTIONS, EARLY_WITHDRAWAL_PENALTY_BPS } from '../../lib/constants';
import { calculateBoost } from '../../lib/boostCalculations';
import { ArtImg } from '../ArtImg';

// Derive from the canonical constant so this table can't drift from the on-chain penalty.
const EARLY_WITHDRAWAL_PENALTY_PCT = EARLY_WITHDRAWAL_PENALTY_BPS / 100;

interface BoostScheduleTableProps {
  selectedLockLabel: string;
  aprNum?: number;
}

export function BoostScheduleTable({ selectedLockLabel, aprNum }: BoostScheduleTableProps) {
  const baseApr = aprNum ?? 0;
  return (
    <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
      <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
        <div className="absolute inset-0">
          <ArtImg pageId="boost-schedule" idx={0} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 p-4 sm:p-6">
        <h3 className="heading-luxury text-white text-[20px] mb-5" id="boost-schedule-heading">Boost Schedule</h3>
        <p className="text-white text-[12px] mb-4">Lock longer = higher boost + more voting power. JBAC NFT holders get +0.5x bonus.</p>

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

        {/* Mobile (<=480px): semantic card list. Drops role="table" in favor of <ul>/<li>. */}
        <ul className="hidden max-[480px]:flex flex-col gap-2 list-none p-0 m-0" aria-labelledby="boost-schedule-heading">
          {LOCK_OPTIONS.map((opt) => {
            const b = calculateBoost(opt.seconds);
            const withNft = b + JBAC_BONUS_BPS;
            const isSelected = selectedLockLabel === opt.label;
            return (
              <li key={opt.label} aria-current={isSelected ? 'true' : undefined}
                className="rounded-lg px-3 py-3"
                style={{
                  background: isSelected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.50)',
                  border: isSelected ? '1px solid var(--color-purple-20)' : '1px solid transparent',
                  minHeight: '44px',
                }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white/60 text-[10px] uppercase tracking-wider">Lock</span>
                  <span className="text-white text-[13px] font-medium">{opt.label}</span>
                </div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white/60 text-[10px] uppercase tracking-wider">Boost</span>
                  <span className="stat-value text-[14px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(b / 10000).toFixed(2)}x</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60 text-[10px] uppercase tracking-wider">
                    {baseApr > 0 ? 'APR' : 'With NFT'}
                  </span>
                  {baseApr > 0 ? (
                    <span className="text-emerald-400 text-[12px] font-mono">{(baseApr * b / 10000).toFixed(1)}%</span>
                  ) : (
                    <span className="text-[12px]" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{(withNft / 10000).toFixed(2)}x</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(255,178,55,0.12)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="boost-schedule" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-4">
            <p className="text-warning/80 text-[12px] font-medium mb-1">Early Withdrawal</p>
            <p className="text-white text-[11px]">
              You can exit your lock at any time with a {EARLY_WITHDRAWAL_PENALTY_PCT}% penalty. Penalty tokens are sent to the treasury — so locking in is the move.
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
                ever shortens it. This is the corrected copy that natspec
                prescribed and no pass had landed. */}
            <p className="text-white text-[11px]">
              Enable auto-max lock to keep maximum boost (4.0x) perpetually — enabling
              immediately sets a full 4-year lock, and it re-extends on every claim.
              Disabling stops future re-extensions, but the current 4-year lock stays;
              exiting before it ends always costs the 25% early-withdrawal penalty.
            </p>
          </div>
        </div>
        </div>
      </div>
    </m.div>
  );
}
