import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
// R039: refactor onto the shared Modal primitive. Modal already handles focus
// trap, focus restore, body scroll lock, Escape close, and aria-labelledby.
// Onboarding is dismissOnBackdrop={true} so it's NON-BLOCKING: a first-timer can click
// the backdrop (or press Escape / Skip) to dismiss the welcome and start exploring the
// hero immediately. It's a friendly intro, not a TOS gate — forcing a 4-step click-through
// before the value prop is usable was pure funnel leakage on mobile.
import { Modal } from './Modal';
import { ART } from '../../lib/artConfig';

const STORAGE_KEY = 'tegridy-onboarding-seen';

// A fresh Tegridy piece behind each onboarding slide — art-first from the very
// first screen. Cycled by step so the four slides feel distinct.
const SLIDE_ART = [ART.card01.src, ART.card02.src, ART.card03.src, ART.card04.src];

const steps = [
  {
    title: 'Welcome to Tegridy Farms',
    body: 'An art-first yield farming protocol on Ethereum. 100% of protocol swap fees go to TOWELI stakers as ETH.',
  },
  {
    title: 'How It Works',
    body: '1. Buy TOWELI on our DEX or Uniswap\n2. Stake & lock for 7 days to 4 years\n3. Earn TOWELI rewards now — plus ETH from protocol fees as the fee rail fills\n4. Longer locks = higher boost (up to 4.5x with NFT)',
  },
  {
    title: 'Stay Safe',
    body: 'This is an experimental DeFi protocol. Smart contract risk exists. Never invest more than you can afford to lose. Review our Risk Disclosure and Security pages.',
  },
  {
    title: 'Your First Move',
    body: 'Head to Farm to stake TOWELI, or Trade to buy TOWELI first. Lock for 90+ days to earn a meaningful boost. JBAC NFT holders get +0.5x on top.',
    cta: true,
  },
];

const variants = {
  enter: (dir: number) => ({ x: dir > 0 ? 120 : -120, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -120 : 120, opacity: 0 }),
};

export function OnboardingModal() {
  // Lazy initializer reads localStorage exactly once on mount, replacing the
  // effect-then-setState pattern that the React Compiler treats as a
  // cascading render.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== '1'; } catch { return true; }
  });
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  const close = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  };

  const isLast = step === steps.length - 1;

  return (
    <Modal
      open={open}
      onClose={close}
      dismissOnBackdrop={true}
      title={steps[step]!.title}
      art={SLIDE_ART[step % SLIDE_ART.length]}
    >
      {/* Step content — Modal renders the title via aria-labelledby, so the
          step body lives below it. The visible heading inside the slide
          stays for visual rhythm but the dialog announcement comes from the
          Modal title prop. */}
      <div className="overflow-hidden min-h-[160px] flex items-center">
        <AnimatePresence mode="wait" custom={dir}>
          <m.div
            key={step}
            custom={dir}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.25 }}
            className="w-full text-center"
          >
            <p className="text-sm text-gray-300 whitespace-pre-line leading-relaxed">
              {steps[step]!.body}
            </p>
          </m.div>
        </AnimatePresence>
      </div>

      {/* Dots */}
      <div
        className="flex justify-center gap-2 mt-4 mb-5"
        role="tablist"
        aria-label={`Onboarding step ${step + 1} of ${steps.length}`}
      >
        {steps.map((_, i) => (
          <span
            key={i}
            role="tab"
            aria-selected={i === step}
            aria-label={`Step ${i + 1} of ${steps.length}`}
            className={`w-2 h-2 rounded-full transition-colors ${
              i === step ? 'bg-purple-500' : 'bg-gray-600'
            }`}
          />
        ))}
      </div>

      {/* Buttons */}
      <div className="flex justify-between">
        <button
          onClick={() => { setDir(-1); setStep((s) => s - 1); }}
          className={`px-4 py-2 text-sm rounded-lg transition-colors min-h-[44px] ${
            step === 0
              ? 'invisible'
              : 'text-gray-300 hover:text-white border border-gray-600 hover:border-gray-400'
          }`}
        >
          Back
        </button>

        {isLast ? (
          <div className="flex gap-2">
            <Link to="/farm" onClick={close}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors text-center min-h-[44px] flex items-center">
              Start Farming
            </Link>
            <Link to="/swap" onClick={close}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors text-center min-h-[44px] flex items-center">
              Buy TOWELI
            </Link>
          </div>
        ) : (
          <button
            onClick={() => { setDir(1); setStep((s) => s + 1); }}
            className="px-5 py-2 text-sm font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors min-h-[44px]"
          >
            Next
          </button>
        )}
      </div>
    </Modal>
  );
}
