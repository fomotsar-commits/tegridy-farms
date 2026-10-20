// The /zap route.
//
// It lives under components/ rather than pages/ because the page and the panel are one
// feature and there is nothing else on it — the same reason OnboardingFlow does. Routing it
// is what makes the panel reachable: a surface nobody can navigate to is a claim the app
// cannot keep, and this repo already has a guard that says so for hooks.

import { usePageTitle } from '../../hooks/usePageTitle';
import { PageArtBackdrop } from '../PageArtBackdrop';
import { FinePrint } from '../ui/FinePrint';
import { ZapPanel } from './ZapPanel';

export default function ZapPage() {
  usePageTitle('Zap');
  return (
    <>
    <PageArtBackdrop pageId="zap" />
    {/* `relative` with no z-index: above the backdrop by coming after it, and
        not a stacking context that would trap a dialog under the tab strip. */}
    <div className="relative mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Zap</h1>
        {/* One line: what it does, and the risk of depositing through it. */}
        <p className="mt-2 text-[13px] text-white/65">
          Any coin in, a position out. It can stop part-way.
        </p>
        <FinePrint summary="How it works">
          <p>
            Any asset into any position. Several transactions, so it can stop part-way. The swap, the pairing and the deposit are composed for you and, on a wallet
            that supports it, grouped into fewer confirmations.
          </p>
          <p>
            A zap is several transactions, not one. It can stop part-way, so this page keeps track of exactly which steps
            landed, holds that state across a reload, and resumes without repeating anything already confirmed.
          </p>
        </FinePrint>
      </header>
      <ZapPanel />
    </div>
    </>
  );
}
