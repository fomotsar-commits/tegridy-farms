// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../lib/solanaPolyfill';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { useVenueStatus } from '../hooks/useVenueStatus';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { CardArt } from '../components/ui/CardArt';
import { FinePrint } from '../components/ui/FinePrint';
import { VenueStatusCard } from '../components/solana/VenueStatusCard';
import { VenueProgramCard } from '../components/solana/VenueProgramCard';
import { LpDoorFrame } from '../components/solana/lp/LpDoorFrame';
import type { LpDoorAnchor } from '../components/solana/lp/lpDoor';
import { lpWriteMode } from '../lib/launcher/solana/lpWriteFlag';

// The actions, positions, rates and routes. Lazy: it brings the Solana wallet stack, which
// only a live venue needs.
const SolanaLpSection = lazy(() => import('../components/solana/lp/SolanaLpSection'));

/**
 * The venue's own Solana liquidity pools: the actions first, then your positions, the
 * rates and where a swap goes (the LP section), then what holding a share means and the
 * venue's status. `?mint=` opens the finder on a token; an old /solana-lp link lands here.
 *
 * Every capability claim here hangs off `readVenue`, never a constant, and every rate is
 * the LP section's own chain read: a pending or failed read shows no fee at all. `readVenue` follows a closed program's
 * stub to its ProgramData, because `getAccountInfo` alone reports a spent id as deployed.
 */
export default function PoolsPage() {
  usePageTitle(
    'Solana liquidity pools',
    'Provide liquidity on the venue’s own Solana AMM: what it charges, what LPs keep, and its live deployment status.',
  );
  useEffect(() => { trackPageView('pools'); }, []);

  // The live read of the venue. The rates are the LP section's own read (its Rates card).
  const { status, refresh, retry } = useVenueStatus();

  // A capability is said in the present tense only once the chain returned a config.
  const liveConfig = status?.kind === 'live' ? status.config : null;

  // Every capability claim on this page hangs off the live probe. A spent program
  // id must never be described in the present tense, and "still reading" is not a
  // licence to assert either, so the conditional copy is the default and the
  // present-tense copy is what the probe has to earn.
  const venueIsOpen = liveConfig !== null;
  // Fixed for the life of a build: a production build reads only the committed constant.
  const lpMode = lpWriteMode();

  // The LP door (a room's Add SOL + coin, island answer twenty-two) is drawn above the hero. Its
  // place is held from the first frame, read from the address once (the section drops the door's
  // words as it opens the form), until the section claims it or the venue does not read live.
  const [params] = useSearchParams();
  const [doorMint] = useState(() => (lpMode !== 'off' && params.get('task') === 'add' ? params.get('mint') : null));
  const [doorAt, setDoorAt] = useState<HTMLDivElement | null>(null);
  const [doorClaimed, setDoorClaimed] = useState(false);
  const claimDoor = useCallback(() => setDoorClaimed(true), []);
  const door = useMemo<LpDoorAnchor>(() => ({ at: doorAt, claim: claimDoor }), [doorAt, claimDoor]);
  // The token whose door the page holds a place for, while it does.
  const doorWaiting = !doorClaimed && (status === null || venueIsOpen) ? doorMint : null;

  // A Refresh that stops reading live unmounts the LP section above the status card, so the
  // card jumps up the page. It is brought back into view: the answer to the press stays on
  // screen. 'nearest' moves nothing when the card is already in view.
  const statusCard = useRef<HTMLElement>(null);
  const wasOpen = useRef(venueIsOpen);
  useLayoutEffect(() => {
    if (wasOpen.current && !venueIsOpen) statusCard.current?.scrollIntoView?.({ block: 'nearest' });
    wasOpen.current = venueIsOpen;
  }, [venueIsOpen]);

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="swap" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.86)' }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
        {doorWaiting !== null && <LpDoorFrame mint={doorWaiting} waiting />}
        <div ref={setDoorAt} />
        <m.div className="mb-6" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {/* No eyebrow and no Details here: the tab strip says Venue AMM and the network, the Rates card
              says the split, and the status card says whether a pool can be opened (owner, 2026-10-13: as
              few words as possible). */}
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            Liquidity pools.
          </h1>
          {/* Only what a read returned: nothing while reading or after a failed read. The line's
              height is held, so the page does not jump when the read lands. */}
          <p className="text-white/85 text-[15px] max-w-xl leading-relaxed min-h-[1lh]">
            {liveConfig
              ? 'Add two coins. Earn from every trade.'
              : status && status.kind !== 'unreadable'
                ? 'Our own Solana AMM. No pool can be opened here yet.'
                : null}
          </p>
        </m.div>

        {venueIsOpen && (
          <div className="mt-2">
            <Suspense fallback={<p className="text-white/60 text-[13px]">Loading the pool finder…</p>}>
              <SolanaLpSection door={door} />
            </Suspense>
          </div>
        )}

        {/* ── Holding a share ────────────────────────────────────────────── */}
        <section className="relative isolate rounded-2xl p-6 mt-6" style={CARD}>
          <CardArt pageId="venue-amm" idx={3} />
          {/* One heading, in a person's words: the share is an LP token, which the small print says. */}
          <h2 className="heading-luxury text-lg text-white mb-3">
            {venueIsOpen ? 'Deposit a pair, hold your share' : 'How it works: deposit a pair, hold your share'}
          </h2>
          {/* "Nothing to claim" is the section's own first line, above; here only what the vault can do. */}
          <p className="text-white/80 text-[13px] leading-relaxed">
            No lock, but the team&apos;s vault can pause removing.
          </p>
          <FinePrint summary="How it works" className="mt-2">
            <p>Fees grow your share as the pool trades. Nothing to claim.</p>
            {!venueIsOpen && (
              <p>
                Depositing from this page waits on a live read of the venue. The status card
                says what the latest read found.
              </p>
            )}
            <ul className="space-y-2 list-disc pl-4">
              <li>Deposit both sides of a pair and the pool mints you an <strong>LP token</strong> for your share.</li>
              <li>Every trade adds its fee to the reserves, so your share is worth more each time the pool trades. There is nothing to claim.</li>
              <li>
                Burning the LP token returns your share of both sides. Pools have no lock, but the
                team&apos;s vault can switch removing off on a pool, and then no one can take money out
                until it is switched back on.
              </li>
              <li>
                Impermanent loss is real: a constant-product pool rebalances against you when
                the price moves, and fees are what compensate for it. This page will never
                quote you an APY it cannot read.
              </li>
            </ul>
          </FinePrint>
        </section>

        {/* ONE status card, under the actions when the venue reads live; when it does not, the
            section is not drawn and the card stands right under the hero. */}
        <div className="mt-6">
          <VenueStatusCard
            ref={statusCard}
            status={status}
            onRefresh={venueIsOpen ? refresh : retry}
            lpMode={lpMode}
            feeSheetBelow={false}
            lpSection="above"
          />
        </div>

        <VenueProgramCard />
      </div>
    </div>
  );
}

const CARD = { background: 'rgba(4,9,18,0.90)', border: '1px solid var(--color-purple-25)' } as const;