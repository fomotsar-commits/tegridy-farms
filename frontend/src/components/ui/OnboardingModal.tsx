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
import { pageArt } from '../../lib/artConfig';
import { isToweliVoice } from '../../lib/arrival';

const STORAGE_KEY = 'tegridy-onboarding-seen';

// A fresh Tegridy piece behind each onboarding slide — art-first from the very
// first screen, cycled by step. Resolved through pageArt('onboarding', idx) so
// each slide is an art-studio surface (seeded to card01–04 in artOverrides).

// ARRIVAL IDENTITY 2026-08-27: the first-visit welcome follows the arrival
// voice. The venue speaks as itself by default; the classic TOWELI
// onboarding (below, byte-identical) runs inside the TOWELI bungalow.
// Copy rules unchanged from the 2026-08-07 honesty pass: no percentage
// claims, no unpaid yield, no certification language anywhere.
const venueSteps = [
  {
    title: 'Welcome to memetics.finance',
    body: 'The venue of Jungle Bay Island. Bungalows for meme communities, launches that open on Heat instead of hype, and staking and swaps with every fee routed on-chain where you can read it.',
  },
  {
    title: 'Bungalows',
    body: 'Every island community has a door here. Enter one and the whole venue wears its skin. TOWELI keeps the classic Tegridy Farms bungalow; Bayla holds the lighthouse.',
  },
  {
    title: 'Heat',
    body: 'Heat is held time, read from the island\u2019s own instrument. Launches open at a floor of proven holding. No token lists, no calendars, no exceptions \u2014 the gate refuses before anything is broadcast.',
  },
  {
    title: 'Stay Safe',
    body: 'This is an experimental DeFi venue. Smart contract risk exists. Never invest more than you can afford to lose. Review our Risk Disclosure and Security pages.',
  },
  {
    title: 'Your First Move',
    body: 'Pick a bungalow, scan any token on either chain, or head to Farm. Your heat already exists \u2014 it started counting at your first buy.',
    cta: true,
  },
];

const toweliSteps = [
  // 2026-08-07, two corrections in one line — this is the FIRST sentence a new
  // visitor reads, and it was wrong twice:
  //
  //  1. "on Ethereum" full stop. We run on two chains. The Solana swap is live and
  //     routed through Jupiter, and /scan reads both. Saying one chain on the
  //     welcome screen is how a two-chain product gets remembered as one.
  //  2. "100% of protocol swap fees are routed to TOWELI stakers" is FALSE, and the
  //     repo already knew: HomePage.tsx's own H1 comment cites AUDIT R073 (swap fees
  //     split 5/6 to LPs, 1/6 to the protocol), and the protocol's own share then
  //     splits again between stakers, the liquidity engine, and operations — which
  //     is what the hero paragraph on that same page says. So the claim is wrong on
  //     BOTH readings of "protocol swap fees". ConnectPrompt.tsx:30 already softened
  //     the identical sentence (F109) and left the reason in a comment; this surface
  //     and the Footer were simply missed by that pass.
  //
  // Replacement claims only what routes on-chain, names no percentage that can drift
  // when governance retunes the split, and does not promise yield that has not been
  // paid (RevenueDistributor still holds 0 wei).
  {
    title: 'Welcome to Tegridy Farms',
    body: 'An art-first protocol on Ethereum and Solana. Stake TOWELI on Ethereum and protocol swap fees route on-chain to stakers in ETH; on Solana, swap through Jupiter and scan any token on either chain.',
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

const steps = isToweliVoice() ? toweliSteps : venueSteps;

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
      art={pageArt('onboarding', step % steps.length).src}
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

      {/* Dots.
          A PROGRESS INDICATOR, not tabs. These were role="tablist" / role="tab"
          on plain spans: not focusable, no click handler, no aria-controls, no
          tabpanel anywhere. That announces selectable tabs to a screen-reader
          user and then does nothing when they try to select one — worse than
          leaving the dots undescribed, because it invites an interaction the
          component cannot honour.
          It also put a second tablist on every page the modal renders over,
          which is how this was found: a page-level [role="tablist"] locator
          started matching two elements. */}
      <div
        className="flex justify-center gap-2 mt-4 mb-5"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={step + 1}
        aria-valuetext={`Step ${step + 1} of ${steps.length}`}
      >
        {steps.map((_, i) => (
          <span
            key={i}
            aria-hidden="true"
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
            {/* ARRIVAL IDENTITY 2026-08-27: the second CTA follows the
                arrival voice — Buy TOWELI belongs to the TOWELI bungalow;
                the venue welcome hands the no-wallet scanner instead. */}
            {isToweliVoice() ? (
              <Link to="/swap" onClick={close}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors text-center min-h-[44px] flex items-center">
                Buy TOWELI
              </Link>
            ) : (
              <Link to="/scan" onClick={close}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors text-center min-h-[44px] flex items-center">
                Scan a token
              </Link>
            )}
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
