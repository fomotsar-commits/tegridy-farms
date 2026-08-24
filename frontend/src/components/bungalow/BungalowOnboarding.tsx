import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../ui/Modal';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';
import { pageArt } from '../../lib/artConfig';

/**
 * First-visit welcome for a token-first bungalow (Bayla). Replaces the
 * TOWELI-scripted OnboardingModal in bungalow mode — same friendly-intro
 * contract (dismiss any way you like, never a gate, never re-shown), its own
 * storage key per bungalow, and the same shared Modal primitive underneath.
 *
 * Copy rule inherited from every first-touch surface here: no yield claims,
 * nothing "coming soon" with a date. Three steps: who she is, what is live
 * today, what the lighthouse pool will be when it exists.
 */
export function BungalowOnboarding({ bungalow }: { bungalow: Bungalow & { identity: BungalowIdentity } }) {
  const storageKey = `tegridy-onboarding-${bungalow.id}-seen`;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(storageKey) !== '1'; } catch { return true; }
  });
  const [step, setStep] = useState(0);

  const close = () => {
    try { localStorage.setItem(storageKey, '1'); } catch { /* private mode */ }
    setOpen(false);
  };

  const steps = [
    {
      title: `Welcome to the ${bungalow.name} bungalow`,
      body: `${bungalow.identity.heroCopy}`,
    },
    {
      title: 'Live today',
      body: `Trade ${bungalow.symbol}, scan it on the two-chain scanner, and check any wallet's heat — the island's held-time oracle. Time held is what counts.`,
    },
    {
      title: 'The lighthouse pool',
      body: `${bungalow.symbol} staking is being built. It ships only when its pool is deployed, verified and funded — a dry pool must read as a real zero, so nothing here will ever advertise rewards that are not already on-chain.`,
    },
  ];
  const isLast = step === steps.length - 1;
  const current = steps[step]!;

  return (
    <Modal open={open} onClose={close} title={current.title} art={pageArt('bungalow-lore', 0).src}>
      <p className="text-white/90 text-[13px] leading-relaxed whitespace-pre-line mb-5">{current.body}</p>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((_, i) => (
            <span key={i} className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: i === step ? 'var(--color-kyle, #2D8B4E)' : 'rgba(255,255,255,0.25)' }} />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={close} className="text-white/60 hover:text-white text-[12px] px-3 py-2 min-h-[44px]">
            Skip
          </button>
          {isLast ? (
            <Link to="/farm" onClick={close} className="btn-primary px-5 py-2 text-[13px] inline-block text-center">
              See the lighthouse
            </Link>
          ) : (
            <button type="button" onClick={() => setStep((s) => s + 1)} className="btn-primary px-5 py-2 text-[13px]">
              Next
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
