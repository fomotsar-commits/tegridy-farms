import { useId, useState } from 'react';
import { pageArt } from '../../lib/artConfig';

/**
 * Lightweight hover tooltip with a "?" icon for explaining DeFi terms.
 * Pure CSS positioning — no external dependencies.
 *
 * Audit H-F14: keyboard + SR accessible. The "?" icon is a real button with
 * aria-describedby → tooltip id, and focus/blur toggle the popup so keyboard
 * users can reveal it without a pointing device. The tooltip itself has
 * role="tooltip" so AT can announce it rather than silently reading the
 * containing span.
 */
export function InfoTooltip({
  text,
  className = '',
  position = 'top',
}: {
  text: string;
  className?: string;
  position?: 'top' | 'bottom';
}) {
  const [show, setShow] = useState(false);
  const tipId = useId();

  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <button
        type="button"
        aria-label="More info"
        aria-describedby={tipId}
        aria-expanded={show}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        onClick={(e) => {
          // Click/tap toggle so touch users can also dismiss.
          e.preventDefault();
          setShow((p) => !p);
        }}
        className="w-[15px] h-[15px] rounded-full border border-white/25 bg-white/5 flex items-center justify-center cursor-help text-[9px] font-semibold text-white/70 hover:text-white hover:border-white/40 focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:outline-none transition-all duration-200 select-none"
      >
        ?
      </button>
      {show && (
        <span
          id={tipId}
          role="tooltip"
          className={`absolute z-50 w-56 px-3 py-2.5 rounded-lg text-[11px] leading-relaxed text-white font-normal pointer-events-none ${
            position === 'top'
              ? 'bottom-full mb-2 left-1/2 -translate-x-1/2'
              : 'top-full mt-2 left-1/2 -translate-x-1/2'
          }`}
          style={{
            background: 'rgba(10, 16, 40, 0.95)',
            border: '1px solid var(--color-purple-25)',
            backdropFilter: 'blur(12px)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {text}
          <span
            className={`absolute left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 ${
              position === 'top' ? '-bottom-1' : '-top-1'
            }`}
            style={{
              background: 'rgba(10, 16, 40, 0.95)',
              borderRight: position === 'top' ? '1px solid var(--color-purple-25)' : 'none',
              borderBottom: position === 'top' ? '1px solid var(--color-purple-25)' : 'none',
              borderLeft: position === 'bottom' ? '1px solid var(--color-purple-25)' : 'none',
              borderTop: position === 'bottom' ? '1px solid var(--color-purple-25)' : 'none',
            }}
          />
        </span>
      )}
    </span>
  );
}

/**
 * Collapsible "How It Works" section used across all NFT Finance tabs.
 * State persisted to localStorage.
 */
export function HowItWorks({
  storageKey,
  title,
  steps,
}: {
  storageKey: string;
  title: string;
  steps: { label: string; description: string }[];
}) {
  const [open, setOpen] = useState(() => {
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
    } catch { /* noop */ }
  };

  // Each HowItWorks panel uses its storageKey as a unique pageId so the
  // header art and step-card arts are pulled from the global pool with
  // no collisions against the parent page (which uses a different pageId).
  const artSrc = pageArt(`how-it-works:${storageKey}`, 0).src;

  return (
    <div
      className="relative rounded-xl overflow-hidden transition-all duration-300"
      style={{
        border: '1px solid rgba(255, 255, 255, 0.14)',
      }}
    >
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <img src={artSrc} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <button
        onClick={toggle}
        className="relative w-full flex items-center justify-between px-4 py-3 text-left group"
      >
        <span className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-purple-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"
            />
          </svg>
          <span className="text-[13px] font-medium text-white/80 group-hover:text-white transition-colors">
            {title}
          </span>
        </span>
        <svg
          className={`w-4 h-4 text-white/70 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="relative px-4 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {steps.map((step, i) => {
              // Each step gets the next pieces from the same storageKey-derived
              // pool. idx 0 is the panel header art (above), so steps start at 1.
              const stepArt = pageArt(`how-it-works:${storageKey}`, i + 1).src;
              return (
                <div
                  key={i}
                  className="relative overflow-hidden flex gap-3 p-3 rounded-lg"
                  style={{ border: '1px solid rgba(255,255,255,0.10)' }}
                >
                  <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                    <img src={stepArt} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </div>
                  <span className="relative z-10 flex-shrink-0 w-6 h-6 rounded-full bg-purple-500/40 border border-purple-500/60 flex items-center justify-center text-[11px] font-bold text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}>
                    {i + 1}
                  </span>
                  <div className="relative z-10">
                    <p className="text-[12px] font-semibold text-white mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9)' }}>{step.label}</p>
                    <p className="text-[11px] text-white leading-relaxed" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9)' }}>{step.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Two-step or three-step visual progress indicator for multi-transaction flows.
 */
export function StepIndicator({
  steps,
  currentStep,
}: {
  steps: string[];
  currentStep: number; // 0-indexed
}) {
  return (
    <div className="flex items-center gap-1 mb-3">
      {steps.map((label, i) => {
        const isComplete = i < currentStep;
        const isActive = i === currentStep;
        return (
          <div key={i} className="flex items-center gap-1 flex-1">
            <div
              className={`flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold uppercase tracking-wider transition-all duration-300 ${
                isComplete
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : isActive
                  ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                  : 'bg-white/3 text-white/30 border border-white/8'
              }`}
            >
              {isComplete ? (
                <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <span className="w-3 text-center">{i + 1}</span>
              )}
              <span className="truncate">{label}</span>
            </div>
            {i < steps.length - 1 && (
              <svg className={`w-3 h-3 flex-shrink-0 ${isComplete ? 'text-emerald-500/50' : 'text-white/15'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Warning / info banner for risk disclosures and transaction context.
 */
export function RiskBanner({
  variant = 'warning',
  children,
}: {
  variant?: 'warning' | 'info' | 'danger';
  children: React.ReactNode;
}) {
  const colors = {
    warning: {
      bg: 'rgba(234, 179, 8, 0.06)',
      border: 'rgba(234, 179, 8, 0.2)',
      icon: 'text-yellow-400',
    },
    info: {
      bg: 'rgba(96, 165, 250, 0.06)',
      border: 'rgba(96, 165, 250, 0.2)',
      icon: 'text-blue-400',
    },
    danger: {
      bg: 'rgba(239, 68, 68, 0.06)',
      border: 'rgba(239, 68, 68, 0.2)',
      icon: 'text-red-400',
    },
  };
  const c = colors[variant];

  return (
    <div
      className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl text-[12px] text-white/80 leading-relaxed"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
    >
      <svg
        className={`w-4 h-4 flex-shrink-0 mt-0.5 ${c.icon}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        {variant === 'info' ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        )}
      </svg>
      <span>{children}</span>
    </div>
  );
}

/**
 * Inline transaction summary card shown above action buttons.
 */
export function TxSummary({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl px-3.5 py-3 text-[12px] text-white/70 leading-relaxed"
      style={{
        background: 'rgba(16, 185, 129, 0.06)',
        border: '1px solid rgba(16, 185, 129, 0.15)',
      }}
    >
      {children}
    </div>
  );
}
