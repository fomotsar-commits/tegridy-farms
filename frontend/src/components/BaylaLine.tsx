import { useEffect, useRef, useState } from 'react';
import { readFire, type FireWeek } from '../lib/fire';
import { Link, useLocation } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { baylaLine, intelLine } from '../lib/baylaLine';
import { voiceAt } from '../lib/arrival';
import { BUNGALOWS, getActiveBungalow } from '../lib/bungalows';
import { useActiveBungalowId } from '../hooks/useActiveBungalowId';
import { fetchHeat, isSupportedHeatAddress } from '../lib/heat/heatClient';
import { setLastReading, useLastReading } from '../lib/heat/heatStore';
import { heatLaunchFloor } from '../lib/heat/heatGateConfig';
import { useLanded } from '../lib/landed';
import { useSolanaSurface } from '../lib/solanaSurface';
import { LAUNCH_SECTION, poolsRoute } from '../lib/navConfig';
import { isSolanaSwapLive } from '../lib/solana';
import { useRoomSlow } from '../lib/solana/lp/roomPrice';
import { tick } from '../lib/tick';

function useFire(): FireWeek | null {
  const [value, setValue] = useState<FireWeek | null>(null);
  useEffect(() => {
    let live = true;
    void readFire().then((v) => {
      if (live) setValue(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return value;
}

/**
 * Bayla at the door (island answer twenty-four, build 4): one line in her voice under the
 * nav on every venue route, always in the same place, reading the state and saying the one
 * next move with its number, and the button beside it that does the move. Under it, one
 * live fact. Never a modal, never a tour. Not on the farm's own pages (law 21: the farm
 * speaks only in its room) and not on a settled resident's doorstep. In flow at the top of
 * the page, never pinned (safe-area law: nothing lands behind chrome).
 */
export function BaylaLine() {
  const location = useLocation();
  useActiveBungalowId();
  const reading = useLastReading();
  const landed = useLanded();
  const fireWeek = useFire();
  const room = getActiveBungalow();
  const solanaPool = room !== null && room.chain === 'solana' && !!room.address;
  const slow = useRoomSlow(solanaPool ? room.address! : null);
  const { address: evm } = useAccount();
  const sol = useSolanaSurface().surface?.address ?? null;

  // A connected wallet with no reading yet is read once here; the card's cache shares it.
  const asked = useRef<string | null>(null);
  const connected = sol ?? evm ?? null;
  useEffect(() => {
    if (!connected || !isSupportedHeatAddress(connected) || asked.current === connected) return;
    if (reading && reading.address.toLowerCase() === connected.toLowerCase()) return;
    asked.current = connected;
    void fetchHeat(connected)
      .then((r) => setLastReading(r))
      .catch(() => undefined);
  }, [connected, reading]);

  if (voiceAt(location.pathname, location.search) === 'toweli') return null;
  if (BUNGALOWS.some((b) => !b.live && location.pathname === `/${b.id}`)) return null;
  // A door landing (a room's Add wish, /pools?task=...) keeps its green button on the first
  // screen at 390x844 (e2e/door-lands.spec.ts, the owner's pin): the line stands down there until
  // build 3's sheet carries it inside. The pools page itself keeps the line.
  if (location.pathname === '/pools' && new URLSearchParams(location.search).has('task')) return null;

  const line = baylaLine({
    reading,
    room: room ? { coin: room.symbol, solanaPool } : null,
    floor: heatLaunchFloor(),
    landed: landed?.kind ?? null,
    slow,
    to: {
      pools: poolsRoute(),
      buy: isSolanaSwapLive() ? (solanaPool ? `/solana?out=${room.address}` : '/solana') : '/swap',
      launch: LAUNCH_SECTION.primaryTo ?? LAUNCH_SECTION.hub,
      read: '/',
      pick: '/#hall',
      receipt: '/dashboard',
    },
  });
  const intel = intelLine(fireWeek);

  return (
    // In flow, not pinned: a pinned band under the header would cover whatever scrolls up to it
    // (e2e/safe-area-insets.spec.ts: no control lands behind chrome). The same place on every
    // screen is the top of it, under the nav, on arrival.
    <div
      data-testid="bayla-line"
      className="relative z-10 px-3 min-[480px]:px-4"
      style={{
        background: 'rgba(6,12,26,0.92)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div className="page-column mx-auto flex items-center gap-3 min-h-[48px] py-1">
        <p className="flex-1 min-w-0 text-[13px] leading-snug text-white/90" data-testid="bayla-line-text">
          {line.text}
        </p>
        <Link
          to={line.button.to}
          onClick={tick}
          data-testid="bayla-line-button"
          className="btn-primary shrink-0 min-h-[40px] px-3 text-[13px] font-semibold inline-flex items-center justify-center"
          style={{ background: 'var(--color-kyle)', color: '#06101a' }}
        >
          {line.button.label}
        </Link>
      </div>
      {intel && (
        <p className="page-column mx-auto pb-1.5 text-[11px] text-white/55" data-testid="bayla-intel">
          {intel}
        </p>
      )}
    </div>
  );
}
