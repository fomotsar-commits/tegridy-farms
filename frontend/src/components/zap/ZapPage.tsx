// The /zap route.
//
// It lives under components/ rather than pages/ because the page and the panel are one
// feature and there is nothing else on it — the same reason OnboardingFlow does. Routing it
// is what makes the panel reachable: a surface nobody can navigate to is a claim the app
// cannot keep, and this repo already has a guard that says so for hooks.

import { usePageTitle } from '../../hooks/usePageTitle';
import { ZapPanel } from './ZapPanel';

export default function ZapPage() {
  usePageTitle('Zap');
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Zap</h1>
        <p className="mt-2 text-[13px] text-white/65">
          Any asset into any position. The swap, the pairing and the deposit are composed for you and, on a wallet
          that supports it, grouped into fewer confirmations.
        </p>
        <p className="mt-2 text-[12px] text-white/50">
          A zap is several transactions, not one. It can stop part-way — this page keeps track of exactly which steps
          landed, holds that state across a reload, and resumes without repeating anything already confirmed.
        </p>
      </header>
      <ZapPanel />
    </div>
  );
}
