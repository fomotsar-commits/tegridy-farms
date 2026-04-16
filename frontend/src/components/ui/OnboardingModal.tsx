import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const STORAGE_KEY = 'tegridy-onboarding-seen';

const steps = [
  {
    title: 'Welcome to Tegridy Farms',
    body: 'An art-first yield farming protocol on Ethereum. 100% of swap fees go to TOWELI stakers.',
  },
  {
    title: 'How It Works',
    body: '1. Buy TOWELI on Uniswap\n2. Stake for 1-52 months\n3. Earn ETH from swap fees\n4. Longer locks = higher yields (up to 2.5x)',
  },
  {
    title: 'Stay Safe',
    body: 'This is an experimental DeFi protocol. Smart contract risk exists. Never invest more than you can afford to lose. Review our Risk Disclosure and Security pages.',
  },
];

const variants = {
  enter: (dir: number) => ({ x: dir > 0 ? 120 : -120, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -120 : 120, opacity: 0 }),
};

export function OnboardingModal() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) !== '1') setOpen(true);
  }, []);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setOpen(false);
  };

  if (!open) return null;

  const isLast = step === steps.length - 1;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Tegridy Farms"
      onClick={close}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border p-6 shadow-2xl"
        style={{
          background: 'rgba(13, 21, 48, 0.95)',
          borderColor: 'var(--color-purple-20)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={close}
          className="absolute top-3 right-3 text-gray-400 hover:text-white transition-colors text-xl leading-none"
          aria-label="Close"
        >
          &times;
        </button>

        {/* Step content */}
        <div className="overflow-hidden min-h-[160px] flex items-center">
          <AnimatePresence mode="wait" custom={dir}>
            <motion.div
              key={step}
              custom={dir}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25 }}
              className="w-full text-center"
            >
              <h2 className="text-xl font-bold text-white mb-3">{steps[step]!.title}</h2>
              <p className="text-sm text-gray-300 whitespace-pre-line leading-relaxed">
                {steps[step]!.body}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Dots */}
        <div className="flex justify-center gap-2 mt-4 mb-5">
          {steps.map((_, i) => (
            <span
              key={i}
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
            className={`px-4 py-2 text-sm rounded-lg transition-colors ${
              step === 0
                ? 'invisible'
                : 'text-gray-300 hover:text-white border border-gray-600 hover:border-gray-400'
            }`}
          >
            Back
          </button>

          {isLast ? (
            <button
              onClick={close}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors"
            >
              Get Started
            </button>
          ) : (
            <button
              onClick={() => { setDir(1); setStep((s) => s + 1); }}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
