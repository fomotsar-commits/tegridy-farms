import { useEffect, useState } from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { VestingDashboard } from '../components/vesting/VestingDashboard';
import { LockViewer } from '../components/vesting/LockViewer';
import { LAUNCH_LOCK_VIEW_ADDRESS, VESTING_FACTORY_ADDRESS, isDeployed } from '../lib/constants';

/**
 * Vesting streams and token locks (#28).
 *
 * Both rails are undeployed, and each half of this page gates on its own address rather
 * than on a page-wide flag — a deployment that ships one before the other must show the
 * live one and keep saying "no data" about the other.
 */
export default function VestingPage() {
  usePageTitle('Vesting & Locks', 'Vesting streams in and out, cliff and unlock schedules, and a token lock viewer.');
  const [tab, setTab] = useState<'streams' | 'locks'>('streams');

  useEffect(() => {
    trackPageView('/vesting');
  }, []);

  const streamsLive = isDeployed(VESTING_FACTORY_ADDRESS);
  const locksLive = isDeployed(LAUNCH_LOCK_VIEW_ADDRESS);

  return (
    <>
      <PageArtBackdrop pageId="vesting" />
      <div className="relative z-10 max-w-4xl mx-auto px-4 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Vesting &amp; Locks</h1>
          <p className="text-white/60 text-sm mt-1 max-w-2xl leading-relaxed">
            Team vesting on OpenZeppelin's schedule behind a thin registry, and time-locked custody with a public read
            surface. Neither rail has a clawback, a pause on withdrawal, or an admin who can reach the funds — which is
            what makes a lock or a vest worth printing on a fact sheet.
          </p>
          {(!streamsLive || !locksLive) && (
            <p className="text-amber-200/85 text-[12px] mt-3 max-w-2xl leading-relaxed">
              {!streamsLive && !locksLive
                ? 'Neither rail is deployed on this deployment, so neither tab has a contract to read.'
                : !streamsLive
                  ? 'The vesting registry is not deployed here; the lock viewer is.'
                  : 'The lock view is not deployed here; the vesting registry is.'}{' '}
              A tab with no contract reports that, and never a zero.
            </p>
          )}
        </div>

        <div className="flex gap-2 mb-6" aria-label="Vesting views">
          {(['streams', 'locks'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-4 py-2 text-[13px] border transition-colors ${
                tab === t
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-white/12 text-white/60 hover:bg-white/5'
              }`}
            >
              {t === 'streams' ? 'My streams' : 'Lock viewer'}
            </button>
          ))}
        </div>

        {tab === 'streams' ? <VestingDashboard /> : <LockViewer />}

        <div className="mt-10 rounded-2xl border border-white/10 bg-black/20 p-5">
          <h2 className="text-white/80 font-semibold text-sm mb-2">What these numbers do and do not say</h2>
          <ul className="text-white/50 text-xs space-y-1.5 leading-relaxed list-disc pl-4 marker:text-white/25">
            <li>
              “Total vested to date” is cumulative inflow into vesting wallets. It never falls as beneficiaries release,
              so it is not the amount currently vesting.
            </li>
            <li>
              Locked figures cover our vault only. A token locked somewhere else does not appear, so a small number here
              is not a claim about the token's total locked supply.
            </li>
            <li>
              A lock scan is paginated because anyone can open a dust lock against any token. A truncated scan is
              labelled as partial; its unlock dates are not the token's lock expiry.
            </li>
            <li>
              A rail that cannot be read renders as “no data”. It is never drawn as zero, because zero is an answer and
              silence is not.
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
