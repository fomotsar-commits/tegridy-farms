import { useState } from 'react';
import { rationale, type FeatureKey } from '../../lib/featureRationale';

/**
 * Collapsible "Why this matters" panel that explains a feature in
 * user-benefit + network-benefit terms. Shown above transaction-heavy
 * surfaces so first-time users get the "why bother" before the "how to."
 *
 * Open-state persisted to localStorage per feature so returning users
 * who already read the explainer don't have to scroll past it on every
 * visit. (Manual close also persists.)
 */
export function WhyThisMatters({ feature }: { feature: FeatureKey }) {
  const r = rationale(feature);
  const storageKey = `tegridy_why_${feature}`;

  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) !== 'closed';
    } catch {
      return true;
    }
  });

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(storageKey, next ? 'open' : 'closed');
    } catch {
      /* localStorage disabled — open state is per-session only */
    }
  };

  return (
    <div
      className="mb-4 rounded-xl overflow-hidden"
      style={{
        background: 'rgba(34, 197, 94, 0.06)',
        border: '1px solid rgba(34, 197, 94, 0.18)',
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left group"
      >
        <span className="flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            style={{ color: '#86efac' }}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <span className="text-[13px] font-medium" style={{ color: '#bbf7d0' }}>
            {r.title}
          </span>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          style={{ color: 'rgba(187, 247, 208, 0.6)' }}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-3.5 pt-0.5 space-y-2.5">
          <div>
            <p
              className="text-[10px] uppercase tracking-wider mb-1"
              style={{ color: 'rgba(187, 247, 208, 0.65)' }}
            >
              For you
            </p>
            <p className="text-white/85 text-[12px] leading-relaxed">{r.forYou}</p>
          </div>
          <div>
            <p
              className="text-[10px] uppercase tracking-wider mb-1"
              style={{ color: 'rgba(187, 247, 208, 0.65)' }}
            >
              For crypto
            </p>
            <p className="text-white/85 text-[12px] leading-relaxed">{r.forCrypto}</p>
          </div>
        </div>
      )}
    </div>
  );
}
