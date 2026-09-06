// The guided first-run flow, at its own route.
//
// A ROUTE, NOT A SECOND MODAL. The existing first-visit modal
// (components/ui/OnboardingModal) is a dismissible hello over the hero; it is deliberately
// non-blocking and it always will be, because a four-step gate in front of the value prop
// leaks the funnel. This is the destination that hello can point at: a page a newcomer can
// come back to, link to, and read without a wallet — and the only place the funding wall is
// addressed at all.
//
// It renders no figure of its own. Every number a user acts on comes from the page that
// reads it on-chain, and every destination comes from onboardingSteps(), which is built
// from the same gates those pages read. Neither is a stylistic choice: this is the surface
// a first-time visitor takes literally.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../../hooks/usePageTitle';
import { VENUE } from '../../lib/arrival';
import { PageArtBackdrop } from '../PageArtBackdrop';
import { FiatOnrampPanel } from './FiatOnrampPanel';
import { onboardingSteps } from './onboardingSteps';

export default function OnboardingFlow() {
  usePageTitle(
    'Start here',
    `What ${VENUE.name} is, what can go wrong, how to get funds in, and the one thing to do first.`,
  );

  const steps = useMemo(() => onboardingSteps(), []);
  const [index, setIndex] = useState(0);
  const { address } = useAccount();

  // Clamped on read, never corrected in an effect: the step list is built from live gates,
  // so it can be shorter on a deployment where surfaces are re-gated, and a held index past
  // the end must render the last step rather than nothing.
  const current = Math.min(Math.max(index, 0), steps.length - 1);
  const step = steps[current];
  if (!step) return null;

  const isLast = current === steps.length - 1;

  return (
    <>
      <PageArtBackdrop pageId="onboarding" />
      <div className="relative z-10 max-w-3xl mx-auto px-4 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Start here</h1>
          {/* WAVE SEVEN, element B: the venue's four-sentence self-description used
              to be the third paragraph of the arrival hero, where it sat between
              the hook and the instrument and pushed the number below the fold. The
              hero keeps three lines now; this is where the paragraph LANDS, so it
              is moved rather than deleted. It is still the only place the venue
              describes itself at length, and /start is the page a newcomer can
              come back to and read without a wallet. */}
          <p className="text-white/75 text-[13.5px] leading-relaxed mt-3 max-w-2xl">
            {VENUE.heroCopy}
          </p>
          <p className="text-white/50 text-xs mt-3">
            Step {current + 1} of {steps.length}
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/25 p-6">
          <h2 className="text-white font-semibold text-lg mb-3">{step.title}</h2>
          <div className="space-y-3">
            {step.body.map((paragraph) => (
              <p key={paragraph.slice(0, 40)} className="text-white/70 text-[13px] leading-relaxed">
                {paragraph}
              </p>
            ))}
          </div>

          {step.showOnramp && (
            <div className="mt-5">
              <FiatOnrampPanel walletAddress={address} />
            </div>
          )}

          {step.actions.length > 0 && (
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {step.actions.map((surface) => (
                <Link
                  key={surface.id}
                  to={surface.route}
                  className="rounded-xl border border-white/12 bg-black/20 px-4 py-3 hover:border-emerald-400/40 transition-colors"
                >
                  <span className="block text-white/90 text-[13px] font-semibold">{surface.label}</span>
                  <span className="block text-white/50 text-[11px] mt-0.5 leading-relaxed">{surface.blurb}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center mt-5">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={current === 0}
            className="btn-secondary px-4 py-2 text-[13px] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Back
          </button>
          {isLast ? (
            <Link to="/" className="btn-secondary px-4 py-2 text-[13px]">
              Done
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))}
              className="btn-primary px-5 py-2 text-[13px]"
            >
              Next
            </button>
          )}
        </div>

        <p className="text-white/30 text-[11px] mt-6 leading-relaxed">
          Nothing on this page moves funds or asks you to sign anything. It links to
          surfaces that are running right now; a surface that is switched off is not listed
          here at all, and no timeline is implied for one that is missing.
        </p>
      </div>
    </>
  );
}
