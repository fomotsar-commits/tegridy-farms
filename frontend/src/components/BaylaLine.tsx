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

/** The line's height in CSS pixels: the header's second row, and what the static first frames pad for. */
export const BAYLA_LINE_HEIGHT = 65;

/**
 * Bayla at the door (island answer twenty-four, build 4): one line in her voice under the
 * nav on every venue route, always in the same place, reading the state and saying the one
 * next move with its number, and the button beside it that does the move. Under it, one
 * live fact. Never a modal, never a tour. Not on the farm's own pages (law 21: the farm
 * speaks only in its room) and not on a settled resident's doorstep. The header's second row
 * (TopNav), so the page under it keeps every law it had: nothing lands behind chrome, a tab
 * row hangs from the header, and the first frame's heading does not move.
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
  // A room's door (/pools with a coin in the URL; the finder drops the wish's task once it is
  // taken, the coin stays) keeps its green button on the first screen at 390x844
  // (e2e/door-lands.spec.ts, the owner's pin): the line stands down there until build 3's sheet
  // carries it inside. The pools page itself keeps the line.
  if (location.pathname === '/pools' && new URLSearchParams(location.search).has('mint')) return null;

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
    // The header's second row, exactly BAYLA_LINE_HEIGHT tall on every screen: the sentence and
    // its button, then the one fact. A fixed height is what lets the static first frame pad for
    // it before React arrives (index.html .ff-wrap, scripts/render-bungalow-doors.mjs), so the
    // hero's heading never moves (e2e/door-first-frame.spec.ts).
    <div
      data-testid="bayla-line"
      className="relative px-3 min-[480px]:px-4 overflow-hidden"
      style={{
        height: `${BAYLA_LINE_HEIGHT}px`,
        background: 'rgba(6,12,26,0.55)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div className="page-column mx-auto flex items-center gap-3 h-[46px]">
        <p className="flex-1 min-w-0 text-[12.5px] leading-[15px] max-h-[45px] overflow-hidden text-white/90" data-testid="bayla-line-text">
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
        <p className="page-column mx-auto h-[16px] leading-[16px] truncate text-[11px] text-white/55" data-testid="bayla-intel">
          {intel}
        </p>
      )}
    </div>
  );
}
