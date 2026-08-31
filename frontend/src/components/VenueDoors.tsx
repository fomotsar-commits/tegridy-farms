import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { BUNGALOWS, type Bungalow } from '../lib/bungalows';

/**
 * THE HALL OF DOORS — the venue arrival's island map.
 *
 * ARRIVAL IDENTITY 2026-08-31 (island order): memetics.finance opens as the
 * island itself, and the island is its bungalows. The venue home shows every
 * door in one hall: the open doors lit in their own accent, the settled doors
 * greyed while their communities move in, the unmarked spot dark. This is the
 * visible version of the BungalowPicker modal, rendered in the venue's own
 * voice only (HomePage gates it off for toweli and identity arrivals).
 *
 * WHICH DOORS COUNT AS OPEN is the island's word, not a registry read:
 * a door is OPEN when its full experience is finished (its own art, its own
 * voice, its own walls) — TOWELI (the classic experience, whole) and BAYLA
 * (the muse's canon skin) today. The other residents are live in placeholder
 * skins ("their voice now, their art later"), which the island presents as
 * SETTLED: greyed in the hall, door still walkable to the plaque landing
 * (contract, trade route, market, heat). When the island words another door
 * open, move its id into OPEN_DOOR_IDS — nothing else changes.
 *
 * Honesty rules, same bar as VenueHero:
 *  - Registry-driven: every tile reads lib/bungalows.ts; nothing invented.
 *  - No certification claim, no yield numbers, no dates.
 *  - Zero Tegridy strings in the hall: the classic door shows its NAME
 *    (Toweli), and the classic branding stays behind it.
 */
export const OPEN_DOOR_IDS = new Set(['toweli', 'bayla']);

const CHAIN_LABEL: Record<Bungalow['chain'], string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
  tbd: 'TBD',
};

type DoorState = 'open' | 'settled' | 'quiet';

export function doorState(b: Bungalow): DoorState {
  if (b.chain === 'tbd') return 'quiet';
  return OPEN_DOOR_IDS.has(b.id) ? 'open' : 'settled';
}

const CHIP: Record<DoorState, { label: string; style: CSSProperties }> = {
  open: {
    label: 'LIVE',
    style: {
      background: 'rgba(45,139,78,0.9)',
      color: '#eafff2',
      border: '1px solid rgba(140,240,190,0.6)',
    },
  },
  settled: {
    label: 'SETTLED',
    style: {
      background: 'rgba(0,0,0,0.72)',
      color: 'rgba(255,255,255,0.72)',
      border: '1px solid rgba(255,255,255,0.22)',
    },
  },
  quiet: {
    label: 'QUIET',
    style: {
      background: 'rgba(0,0,0,0.72)',
      color: 'rgba(255,255,255,0.5)',
      border: '1px solid rgba(255,255,255,0.14)',
    },
  },
};

function DoorTile({ bungalow }: { bungalow: Bungalow }) {
  const state = doorState(bungalow);
  const chip = CHIP[state];

  const face = (
    <>
      <div className="h-28 md:h-32 w-full overflow-hidden">
        <img
          src={bungalow.thumb}
          alt=""
          loading="lazy"
          decoding="async"
          width={300}
          height={128}
          className={`w-full h-full object-cover transition-transform duration-500 ${
            state === 'open' ? 'group-hover:scale-[1.06]' : 'grayscale'
          }`}
          style={bungalow.thumbPosition ? { objectPosition: bungalow.thumbPosition } : undefined}
        />
      </div>
      {/* Scrim so the nameplate reads over bright door art. */}
      <div
        className="absolute inset-x-0 bottom-0 h-16 pointer-events-none"
        aria-hidden="true"
        style={{ background: 'linear-gradient(to top, rgba(3,7,14,0.92), rgba(3,7,14,0))' }}
      />
      <span
        className="absolute top-2 right-2 text-[9px] font-bold tracking-[0.14em] rounded-full px-2 py-0.5"
        style={chip.style}
      >
        {chip.label}
      </span>
      <div className="absolute inset-x-0 bottom-0 p-2.5">
        <p className="text-white text-[13px] font-semibold leading-tight" style={{ textShadow: '0 1px 5px rgba(0,0,0,0.95)' }}>
          {bungalow.symbol}
        </p>
        <p className="text-white/70 text-[10.5px] leading-tight">
          {/* The quiet spot whispers its plaque line instead of a chain. */}
          {state === 'quiet' ? bungalow.tagline : <>{bungalow.name} &middot; {CHAIN_LABEL[bungalow.chain]}</>}
        </p>
      </div>
    </>
  );

  const frame: CSSProperties =
    state === 'open'
      ? {
          border: `1px solid ${bungalow.accent ?? 'var(--color-kyle)'}`,
          boxShadow: `0 0 18px -6px ${bungalow.accent ?? 'rgba(111,217,168,0.8)'}`,
          background: 'rgba(4,9,18,0.85)',
        }
      : {
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(4,9,18,0.85)',
        };

  if (state === 'quiet') {
    return (
      <div
        className="relative rounded-xl overflow-hidden opacity-45"
        style={frame}
        aria-label={`${bungalow.name} spot: quiet. ${bungalow.tagline}`}
      >
        {face}
      </div>
    );
  }

  return (
    <Link
      to={`/${bungalow.id}`}
      aria-label={
        state === 'open'
          ? `Enter the ${bungalow.name} bungalow (${bungalow.symbol}, live)`
          : `${bungalow.name} bungalow (${bungalow.symbol}), settled and building. Open its plaque.`
      }
      className={`group relative block rounded-xl overflow-hidden transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8ef0d8] ${
        state === 'open' ? 'hover:scale-[1.03]' : 'opacity-75 hover:opacity-100'
      }`}
      style={frame}
    >
      {face}
    </Link>
  );
}

export function VenueDoors() {
  const openCount = BUNGALOWS.filter((b) => doorState(b) === 'open').length;
  return (
    <m.section
      className="pb-16"
      initial={{ opacity: 0, y: 15 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      aria-label="The bungalows of Jungle Bay Island"
    >
      <div className="mb-6">
        <p className="text-[11px] uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Jungle Bay Island
        </p>
        <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          The bungalows
        </h2>
        <p className="text-white text-[13px] max-w-2xl leading-relaxed" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Every island community keeps a door at the venue. {openCount} {openCount === 1 ? 'door is' : 'doors are'} open
          in full color. Settled doors are greyed while their people move in; each one still opens to its plaque,
          contract and trade route. Walk in where you hold.
        </p>
      </div>
      {/* The hall is a ROOM: the grid sits on its own dark panel (same glass
          as the picker) so thirteen doors read as one place, not thirteen
          tiles floating on loud page art. */}
      <div
        className="rounded-2xl p-3"
        style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.10)' }}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {BUNGALOWS.map((b) => (
            <DoorTile key={b.id} bungalow={b} />
          ))}
        </div>
        {/* The island's growth line: quiet, true, forward-pulling. */}
        <p className="mt-3 mb-1 text-center text-[12px] italic text-white/70">
          The island grows a door at a time. More open as their people move in.
        </p>
      </div>
    </m.section>
  );
}
