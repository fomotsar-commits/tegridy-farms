// ─── R069 — TypedConfirmation ────────────────────────────────────────
//
// Shared confirmation primitive for destructive admin/operator actions.
// Extracted from the inline pause-control flow in AdminPage so any
// ContractCard write call site can require an explicit typed phrase
// before firing. A single misclick should never trigger pause(),
// transferOwnership(), withdrawAll(), etc.
//
// Usage:
//   <TypedConfirmation
//     phrase="PAUSE"
//     description="Pausing halts staking, withdrawals, and claims."
//     ctaLabel="Pause Contract"
//     pending={isSigning || isConfirming}
//     onConfirm={handleConfirm}
//   />
//
// The component manages its own open / typed state. Callers only handle
// the actual write on `onConfirm`. We compare the typed phrase
// case-insensitively after trimming so paste-with-trailing-space still
// works, but otherwise demand an exact match.

import { useState } from 'react';
import { ART } from '../../lib/artConfig';

interface TypedConfirmationProps {
  /** Phrase the operator must type to enable the execute button. */
  phrase: string;
  /** Short description shown above the input. */
  description: string;
  /** Label on the trigger button (when collapsed). */
  ctaLabel: string;
  /** Label on the execute button. Defaults to "Execute". */
  executeLabel?: string;
  /** Pending state from wagmi (isSigning || isConfirming). */
  pending?: boolean;
  /** Called when the typed phrase matches and execute is clicked. */
  onConfirm: () => void;
  /** Visual variant. "danger" = red, "warning" = amber. Default "danger". */
  variant?: 'danger' | 'warning';
  /** Extra aria-label for the trigger button. */
  triggerAriaLabel?: string;
}

const VARIANTS: Record<NonNullable<TypedConfirmationProps['variant']>, {
  trigger: string; box: string; text: string; ring: string;
}> = {
  danger: {
    trigger: 'linear-gradient(135deg, rgb(239 68 68), rgb(185 28 28))',
    box: 'rgba(239,68,68,0.08)',
    text: 'text-red-400',
    ring: 'focus:border-red-500',
  },
  warning: {
    trigger: 'linear-gradient(135deg, rgb(245 158 11), rgb(217 119 6))',
    box: 'rgba(245,158,11,0.08)',
    text: 'text-amber-400',
    ring: 'focus:border-amber-500',
  },
};

export function TypedConfirmation({
  phrase,
  description,
  ctaLabel,
  executeLabel = 'Execute',
  pending = false,
  onConfirm,
  variant = 'danger',
  triggerAriaLabel,
}: TypedConfirmationProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const v = VARIANTS[variant];
  const matches = typed.trim().toUpperCase() === phrase.trim().toUpperCase();

  const reset = () => {
    setOpen(false);
    setTyped('');
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label={triggerAriaLabel ?? ctaLabel}
        className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-black"
        style={{
          background: v.trigger,
          color: 'white',
          textShadow: '0 1px 3px rgba(0,0,0,0.5)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}
      >
        {ctaLabel}
      </button>
    );
  }

  return (
    <div className="w-full">
      <div className="flex justify-end mb-2">
        <button
          onClick={reset}
          className="text-[12px] text-white/60 hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
      {/* Art-first: a Tegridy piece sits beneath a LIGHT dark scrim (so it's
          actually visible), with the variant tint (v.box) kept on the top layer —
          the red/amber danger identity (border, heading, button) fully survives,
          and the type-to-confirm copy stays high-contrast via its text-shadow. */}
      <div
        className="p-4 rounded-xl"
        style={{
          background: `${v.box}, linear-gradient(180deg, rgba(10,12,22,0.55) 0%, rgba(10,12,22,0.6) 100%), url(${ART.card07.src}) center / cover no-repeat`,
          border: `1px solid ${variant === 'danger' ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'}`,
          textShadow: '0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)',
        }}
      >
        <p className={`text-[13px] ${v.text} font-semibold mb-2`}>Confirm action</p>
        <p className="text-[12px] text-white/70 mb-3">
          {description} Type <span className="font-mono text-white">{phrase}</span> to confirm.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={phrase}
            autoFocus
            aria-label={`Type ${phrase} to confirm`}
            className={`flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono outline-none transition-colors ${v.ring}`}
          />
          <button
            onClick={() => {
              if (!matches || pending) return;
              onConfirm();
            }}
            disabled={!matches || pending}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: v.trigger, color: 'white' }}
          >
            {pending ? 'Confirming...' : executeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
