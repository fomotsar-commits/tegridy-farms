import { useEffect, useRef, useState } from 'react';
import { readFire, type FireWeek } from '../lib/fire';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { intelLine } from '../lib/baylaLine';
import { QUIET_BUTTON_STYLE, useBaylaLine } from './useBaylaLine';
import { voiceAt } from '../lib/arrival';
import { BUNGALOWS } from '../lib/bungalows';
import { fetchHeat, isSupportedHeatAddress } from '../lib/heat/heatClient';
import { setLastReading, useLastReading } from '../lib/heat/heatStore';
import { useConnectedHeatSubject } from '../hooks/useConnectedHeatSubject';
import { opensSheet, SHEET_PRESS } from '../lib/sheet';
import { reopenReceipt } from '../lib/receipt';
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
  const navigate = useNavigate();
  const reading = useLastReading();
  const fireWeek = useFire();
  const line = useBaylaLine();

  // A connected wallet with no reading yet is read once here; the card's cache shares it. It is the
  // wallet the heat card reads too, whichever wallets the hand holds (hooks/useConnectedHeatSubject.ts).
  const asked = useRef<string | null>(null);
  const connected = useConnectedHeatSubject();
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
        {/* Quiet where the screen's own green button makes the same move: one green button per screen.
            Her Receipt raises the last receipt card again (build 6); with none held, the dashboard. */}
        {line.button.move === 'receipt' ? (
          <button
            type="button"
            onClick={() => {
              tick();
              if (!reopenReceipt()) navigate(line.button.to);
            }}
            data-testid="bayla-line-button"
            data-quiet={line.sameMove || undefined}
            className={`${line.sameMove ? 'rounded-[10px]' : 'btn-primary'} shrink-0 min-h-[40px] px-3 text-[13px] font-semibold inline-flex items-center justify-center`}
            style={line.sameMove ? QUIET_BUTTON_STYLE : { background: 'var(--color-kyle)', color: '#06101a' }}
          >
            {line.button.label}
          </button>
        ) : (
        <Link
          to={line.button.to}
          state={opensSheet(line.button.to) ? SHEET_PRESS : undefined}
          onClick={tick}
          data-testid="bayla-line-button"
          data-quiet={line.sameMove || undefined}
          className={`${line.sameMove ? 'rounded-[10px]' : 'btn-primary'} shrink-0 min-h-[40px] px-3 text-[13px] font-semibold inline-flex items-center justify-center`}
          style={line.sameMove ? QUIET_BUTTON_STYLE : { background: 'var(--color-kyle)', color: '#06101a' }}
        >
          {line.button.label}
        </Link>
        )}
      </div>
      {intel && (
        <p className="page-column mx-auto h-[16px] leading-[16px] truncate text-[11px] text-white/55" data-testid="bayla-intel">
          {intel}
        </p>
      )}
    </div>
  );
}
