import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { lpWriteMode } from '../lib/launcher/solana/lpWriteFlag';
import { poolsFrameOnScreen, poolsFrameReplaced } from '../lib/poolsFrame';
import { PageSkeleton } from './PageSkeleton';
import { SwapSkeleton } from './PageSkeletons';

/** LpDoorFrame's card (curve/uiFormat CARD and CARD_STYLE), without its art. */
const DOOR_STYLE = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;

/**
 * The pools page's first frame, as its static HTML paints it (scripts/render-pools-frame.mjs):
 * PoolsPage's own shell and heading, class for class, under the host's pt-14, and the LP door's
 * waiting card when the address asks for an add. `data-route-loading` keeps the e2e readiness
 * probe (gotoRoute) waiting for the page. Wallet-free, and it never says "Loading".
 */
export function PoolsFrame() {
  const [params] = useSearchParams();
  const door = lpWriteMode() !== 'off' && params.get('task') === 'add' && params.has('mint');
  return (
    <div className="pt-14" aria-busy="true" data-route-loading>
      <div className="relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }} />
        <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
          {door && (
            <section aria-label="Add liquidity" className="rounded-2xl p-5 relative overflow-hidden isolate mb-6" style={DOOR_STYLE}>
              <p role="status" className="text-white/70 text-[13px]">Reading this pool from the chain…</p>
            </section>
          )}
          <div className="mb-6">
            <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">Liquidity pools.</h1>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * What /pools shows while its chunks arrive. When this document opened on the page, its
 * heading is already on screen and must not leave: the frame. On any later visit, the
 * skeleton each place had (`panel`: the host's, else the route's).
 */
export function PoolsFallback({ panel = false }: { panel?: boolean }) {
  const [framed] = useState(poolsFrameOnScreen);
  if (framed) return <PoolsFrame />;
  return panel ? <PageSkeleton /> : <SwapSkeleton />;
}

/**
 * Beside DeepLinkSheet's redirect (sheet/ActionSheet.tsx): a room's add link opens on this
 * frame, and the redirect draws nothing for one commit. The frame stays up for it, so the
 * heading never gives way to an empty page. Once: a later press is a navigation.
 */
export function PoolsLeaving() {
  const [framed] = useState(poolsFrameOnScreen);
  useEffect(() => poolsFrameReplaced(), []);
  return framed ? <PoolsFrame /> : null;
}
