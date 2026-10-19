// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../lib/solanaPolyfill';
import { lazy, Suspense, useMemo } from 'react';
import { SolanaProviders } from './solana/SolanaProviders';
import { SolanaLadderPoolCard } from './bungalow/SolanaLadderPoolLive';
import { LighthouseClaimStrip } from './bungalow/LighthousePoolLive';
import { LpInner } from './solana/lp/SolanaLpSection';
import { browserLpReaders, type LpReaders } from './solana/lp/readers';
import { CardArt } from './ui/CardArt';
import { ChainPicker } from './layout/ChainPicker';
import { useSectionChain } from '../hooks/useSectionChain';
import { POOLS_SECTION } from '../lib/navConfig';
import { useVenueStatus } from '../hooks/useVenueStatus';
import { isSolanaSwapLive } from '../lib/solana';
import { BUNGALOWS, bungalowLpDoor, CARDS_ROOM_ID, stakePoolMembersOnly } from '../lib/bungalows';

// The swap page's own form, in its home mode. Its own chunk, so the other two cards never wait on it.
const SolanaSwapInner = lazy(() => import('../pages/SolanaSwapPage').then((m) => ({ default: m.SolanaSwapInner })));

/**
 * The LP card's network drop-down: the Pools tabs' own (PoolsHostPage), lit on Solana because the
 * card is /solana-lp's. A pick leaves for that network's Pools tab (Base: /liquidity?c=8453).
 * Its list opens leftward: the card is the row's last, and a list opening right ran 47px off a
 * 1280px screen.
 */
function PoolsNetwork() {
  const network = useSectionChain(POOLS_SECTION.items, '/solana-lp', { missing: 'No pools here' });
  return <ChainPicker label="Pools network" active={network.active} options={network.options} onPick={network.pick} align="end" />;
}

/**
 * The home's three working cards, in one row: swap, stake BAYLA and add SOL + BAYLA liquidity
 * (owner, 2026-10-16: "right away", then "move the lp module beside the staking one ... the
 * swap is missing ... make them take way less space ... staking module needs to be shorter").
 * Each is the form its own page mounts (the swap of /solana, the ladder of /earn/bayla, the
 * LP section of /solana-lp), in a short mode, so every check before a signature is theirs.
 * ONE SolanaProviders for all three: a second WalletProvider reads the saved wallet only when
 * it mounts, so a visitor who connected in one card would look disconnected in another until
 * a reload. It is also the top bar's Solana connection on the home, the island lobby and BAYLA's
 * door (`mixed`, lib/routeVoice.ts hasMixedSolanaSection), so it mounts even when no card has
 * anything on record to act on; such a card is not drawn.
 */
export default function HomeModules({ readers: given }: { readers?: LpReaders } = {}) {
  const room = BUNGALOWS.find((b) => b.id === CARDS_ROOM_ID);
  const readers = useMemo(() => given ?? browserLpReaders(), [given]);
  // As on /solana-lp: the LP card is drawn only once a chain read says the venue is open.
  const { status } = useVenueStatus();
  const door = room ? bungalowLpDoor(room) : null;
  const lp = status?.kind === 'live' && readers && door && room?.address && room.venueSolPool
    ? { readers, mint: room.address, pool: room.venueSolPool, label: door.label }
    : null;
  const ladder = room?.ladderPool ? { ...room, ladderPool: room.ladderPool } : null;
  // As on /solana: no swap card where the swap is not live.
  const swap = isSolanaSwapLive();

  return (
    // `mixed`: the home connects Ethereum too, so the top bar keeps its Solana-or-Ethereum sheet.
    <SolanaProviders mixed>
      {(swap || ladder || lp) && (
        <div className="mt-6 mb-2 grid grid-cols-1 gap-4 lg:grid-cols-3 items-start" data-testid="home-modules">
          {swap && (
            <div className="min-w-0" data-testid="home-swap">
              <Suspense fallback={null}>
                <SolanaSwapInner home />
              </Suspense>
            </div>
          )}
          {ladder && (
            <div className="min-w-0 flex flex-col gap-4" data-testid="home-stake">
              <SolanaLadderPoolCard bungalow={ladder} compact />
              {room && stakePoolMembersOnly(room) && <LighthouseClaimStrip bungalow={room} />}
            </div>
          )}
          {lp && (
            <section
              aria-labelledby="home-lp-heading"
              data-testid="home-lp"
              className="relative isolate min-w-0 rounded-2xl p-4"
              style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}
            >
              <CardArt pageId="venue-home" idx={1} />
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <h2 id="home-lp-heading" className="heading-luxury text-xl text-white" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                  {lp.label}
                </h2>
                <PoolsNetwork />
              </div>
              <LpInner readers={lp.readers} home={{ mint: lp.mint, pool: lp.pool }} />
            </section>
          )}
        </div>
      )}
    </SolanaProviders>
  );
}
