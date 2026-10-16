// Polyfill MUST load before any @solana/* import, the same rule as SolanaProviders.
import '../lib/solanaPolyfill';
import { useMemo } from 'react';
import { SolanaProviders } from './solana/SolanaProviders';
import { SolanaLadderPoolCard } from './bungalow/SolanaLadderPoolLive';
import { LighthouseClaimStrip } from './bungalow/LighthousePoolLive';
import { LpInner } from './solana/lp/SolanaLpSection';
import { browserLpReaders, type LpReaders } from './solana/lp/readers';
import { useVenueStatus } from '../hooks/useVenueStatus';
import { BUNGALOWS, bungalowLpDoor, stakePoolMembersOnly } from '../lib/bungalows';

/** The room whose pool and liquidity the home offers (owner, 2026-10-16: "the bayla staking module and the lp pool module"). */
const HOME_ROOM_ID = 'bayla';

/**
 * The home's two working cards: stake BAYLA and add SOL + BAYLA liquidity, with no trip to
 * Earn or Pools. Each is the card its own page mounts (the stack of /earn/bayla, the LP
 * section of /solana-lp), so a fix there is a fix here, and every check before a signature
 * is theirs. ONE SolanaProviders for both: a second WalletProvider reads the saved wallet
 * only when it mounts, so a visitor who connected in one card would look disconnected in
 * the other until a reload. It is also the top bar's Solana connection on the home
 * (`mixed`, lib/routeVoice.ts hasMixedSolanaSection), so it mounts even when neither card
 * has anything on record to act on; such a card is not drawn.
 */
export default function HomeModules({ readers: given }: { readers?: LpReaders } = {}) {
  const room = BUNGALOWS.find((b) => b.id === HOME_ROOM_ID);
  const readers = useMemo(() => given ?? browserLpReaders(), [given]);
  // As on /solana-lp: the LP card is drawn only once a chain read says the venue is open.
  const { status } = useVenueStatus();
  const door = room ? bungalowLpDoor(room) : null;
  const lp = status?.kind === 'live' && readers && door && room?.address && room.venueSolPool
    ? { readers, mint: room.address, pool: room.venueSolPool, label: door.label }
    : null;
  const ladder = room?.ladderPool ? { ...room, ladderPool: room.ladderPool } : null;

  return (
    // `mixed`: the home connects Ethereum too, so the top bar keeps its Solana-or-Ethereum sheet.
    <SolanaProviders mixed>
      {(ladder || lp) && (
      <div className="flex flex-col gap-5 mb-6 max-w-md" data-testid="home-modules">
        {ladder && <SolanaLadderPoolCard bungalow={ladder} />}
        {room && stakePoolMembersOnly(room) && <LighthouseClaimStrip bungalow={room} />}
        {lp && (
          <section aria-labelledby="home-lp-heading" data-testid="home-lp">
            <h2 id="home-lp-heading" className="heading-luxury text-xl sm:text-2xl text-white mb-3" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              {lp.label}
            </h2>
            <LpInner readers={lp.readers} home={{ mint: lp.mint, pool: lp.pool }} />
          </section>
        )}
      </div>
      )}
    </SolanaProviders>
  );
}
