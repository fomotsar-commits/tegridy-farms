// The countdown (island answer twenty-five, screen 2; twenty-four, build 5; twenty-six): what a
// wallet sees on /launch, the launch door, and on the heat card. The door is not open yet (answer
// twenty-six): under the floor a timer, one line, one green button and the roster; at the floor and
// up the wallet's degrees and its place on the list; a stranger the timer from a standing start.
// The words are the island's (lib/arrival.ts COUNTDOWN_WORDS), never reworded here. The measures
// are the drawing's, at 390 wide; colors and fonts are index.css tokens.

import { createContext, useContext, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { COUNTDOWN_WORDS } from '../../lib/arrival';
import { countdownTimer, type HeatReading } from '../../lib/heat/heatOracle';
import { heatLaunchFloor } from '../../lib/heat/heatGateConfig';
import { sheetHref, sheetRoom, SHEET_PRESS } from '../../lib/sheet';
import { useScreenMove, type ScreenMove } from '../../lib/screenMove';
import { useActiveBungalowId } from '../../hooks/useActiveBungalowId';
import { useIslandTorches } from '../../hooks/useIslandTorches';

const MONO: CSSProperties = { fontFamily: 'var(--font-family-mono)' };
const ARCHIVO = 'var(--font-family-heading)';

export interface CountdownProps {
  /** The wallet read: its own degrees and the island's days to the door. Null when nothing has
   *  been read: the launch door still opens on the countdown, from a standing start. */
  reading: HeatReading | null;
  /** 'screen' is the launch page's own band: 28 px under the header, on the page's ground with
   *  the violet glow behind, the whole first screen on a phone. 'card' sits inside a heat card,
   *  which is its own ground. */
  look?: 'screen' | 'card';
}

/** The warm state's number, the wallet's degrees: 96 px as the days are drawn, smaller only as
 *  the digits grow, so a Builder's or an Elder's degrees stay on one line at 390. */
function degreesSize(text: string): number {
  return text.length <= 6 ? 96 : text.length === 7 ? 80 : 68;
}

export function Countdown({ reading, look = 'card' }: CountdownProps) {
  const floor = heatLaunchFloor();
  const { pathname, search } = useLocation();
  const warming = useIslandTorches()?.warming ?? null;
  // The room the visitor is in, when its coin has its pool on the venue: the warm state's Add.
  const room = sheetRoom(useActiveBungalowId());
  const screen = look === 'screen';
  // At the floor and up, the door closed: warm enough, on the list the day it opens (§2.6).
  const warm = reading !== null && reading.degrees >= floor;
  // One green button per screen (answer twenty-five, §2): on the launch door's own screen her line
  // is quiet whatever it says (answer twenty-six, §2.7); in a heat card, where its button is her move.
  const move: ScreenMove | null = screen ? 'door' : warm ? (room ? 'add' : null) : 'start';
  useScreenMove(move);
  const eyebrowId = useId();

  // A stranger counts from a standing start, as a cold wallet does; the warm state has no timer.
  const timer = warm ? null : reading ? countdownTimer(reading) : ({ unserved: true } as const);
  // "0° today" is true only of a wallet read at zero: a stranger's track names no today.
  const atZero = reading !== null && (reading.isCold || !(reading.degrees > 0));
  // Degrees over the floor of the width, from the reading alone: it never moves on its own.
  const at = reading ? Math.min(1, Math.max(0, reading.degrees / floor)) : 0;
  // Left out unread, at 0 ("never 0"), and at 1, which the island's words have no singular for.
  const roster = warming !== null && warming >= 2 ? COUNTDOWN_WORDS.roster(warming) : null;
  const degrees = reading ? COUNTDOWN_WORDS.standing(reading.degrees.toFixed(2)) : null;
  // Under the floor the clock starts with a buy; at it, the move is an add, in the room or picked.
  const button = warm
    ? { label: room ? COUNTDOWN_WORDS.add(room.symbol) : COUNTDOWN_WORDS.pick, kind: 'add' as const }
    : { label: COUNTDOWN_WORDS.button, kind: 'buy' as const };

  return (
    <section
      data-testid="countdown"
      data-look={look}
      data-state={warm ? 'warm' : reading ? 'under' : 'unread'}
      aria-labelledby={eyebrowId}
      // z-10 lifts the band over a page's art layer (PageArtBackdrop sits at z-0): the drawing puts
      // the countdown on the page's own ground. On a phone the band is the whole first screen, as
      // drawn; the page's tabs and the rest of it follow below.
      className={
        screen ? 'relative z-10 max-[799px]:min-h-[calc(100dvh_-_var(--app-header-h,122px))]' : 'relative mb-4 rounded-xl p-4'
      }
      style={
        screen
          ? { background: 'linear-gradient(180deg, var(--color-bg-base) calc(100% - 40px), transparent)' }
          : // A heat card can sit straight on a painting (the home's hero): its own ground, the
            // page's at the heat panel's 78%, keeps the small mono words readable over bright art.
            { background: 'color-mix(in srgb, var(--color-bg-base) 78%, transparent)', border: '1px solid var(--color-purple-25)' }
      }
    >
      <div data-column className={screen ? 'relative max-w-3xl mx-auto px-5 pt-7 pb-8' : 'relative'}>
        <div className="flex items-baseline justify-between gap-3">
          <p id={eyebrowId} data-eyebrow className="text-[11px] leading-none tracking-[0.14em]" style={{ ...MONO, color: 'var(--color-kyle)' }}>
            {COUNTDOWN_WORDS.eyebrow}
          </p>
          {degrees && (
            <p data-standing className="text-[11px] leading-none tracking-[0.14em] text-right" style={{ ...MONO, color: 'var(--color-text-secondary)' }}>
              {degrees}
            </p>
          )}
        </div>

        {warm && degrees ? (
          <p className="mt-[22px] text-white" style={{ fontFamily: ARCHIVO, fontWeight: 900, fontSize: degreesSize(degrees), lineHeight: 0.8, letterSpacing: '-0.04em' }}>
            {degrees}
          </p>
        ) : (
          timer &&
          ('days' in timer ? (
            <p className="flex items-baseline gap-2.5 mt-[22px] text-white">
              <span style={{ fontFamily: ARCHIVO, fontWeight: 900, fontSize: 96, lineHeight: 0.8, letterSpacing: '-0.04em' }}>
                {timer.days.toLocaleString('en-US')}
              </span>{' '}
              <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: 28, lineHeight: 1 }}>{COUNTDOWN_WORDS.days}</span>
            </p>
          ) : (
            // 40 px as drawn on the launch screen; in a heat card's narrower column it shrinks to stay one line at 390.
            <p className="mt-[22px] text-white" style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: screen ? 40 : 'clamp(28px, 9.4vw, 40px)', lineHeight: 1.05 }}>
              {COUNTDOWN_WORDS.unserved}
            </p>
          ))
        )}
        {(warm || timer) && (
          <p className="text-[15px] leading-snug mt-[18px]" style={{ color: 'var(--color-text-secondary)' }}>
            {warm ? COUNTDOWN_WORDS.warmUnder : COUNTDOWN_WORDS.under}
          </p>
        )}

        <div aria-hidden="true" className="relative h-[14px] mt-[19px]">
          <div
            className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[6px] rounded-full"
            style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
          />
          <div
            data-marker
            className="absolute top-0 size-[14px] rounded-full left-[calc((100%_-_14px)*var(--at))]"
            style={{ '--at': String(at), background: 'var(--color-kyle)' } as CSSProperties}
          />
        </div>
        <div className="flex justify-between gap-3 mt-2 text-[11px] leading-none" style={{ ...MONO, color: 'var(--color-text-muted)' }}>
          {atZero ? <span>{COUNTDOWN_WORDS.today}</span> : <span />}
          <span>{COUNTDOWN_WORDS.door(floor)}</span>
        </div>

        <p className="text-[16px] font-semibold leading-6 mt-[27px]" style={{ color: 'var(--color-text-primary)' }}>
          {warm ? COUNTDOWN_WORDS.warmLine : COUNTDOWN_WORDS.line}
        </p>
        <div className="relative mt-5">
          {screen && (
            // The venue's violet glow, as drawn: a 240 px circle on the green button, behind the
            // words (-z-10 inside the band), across the band's width and never past it, fading out
            // about 200 px under the button.
            <div
              data-glow
              aria-hidden="true"
              className="pointer-events-none absolute -z-10 -inset-x-5 top-[calc(50%_-_240px)] h-[445px]"
              style={{ background: 'radial-gradient(circle 240px at 50% 240px, var(--color-purple-20), transparent)' }}
            />
          )}
          {/* A press on this page: the sheet's Back pops back to it (lib/sheet.ts SHEET_PRESS). */}
          <Link to={sheetHref(pathname, search, button.kind)} state={SHEET_PRESS} className="btn-primary w-full h-[52px] flex items-center justify-center text-[15px]">
            {button.label}
          </Link>
        </div>
        {roster && (
          <p data-roster className="text-[13px] leading-5 mt-3" style={{ color: 'var(--color-text-secondary)' }}>
            {roster}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Where a launch page opens: the top of the launch hub, above its tabs (pages/LaunchHubPage.tsx).
 * Undefined outside a hub, so a door anywhere else draws its countdown in its own place; null
 * while the hub's top is not yet in the page, when nothing is drawn rather than drawn twice.
 */
const CountdownSlot = createContext<HTMLElement | null | undefined>(undefined);

/** The launch hub's top: the door's countdown rises here, so the page opens on it. */
export function CountdownTop({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <div ref={setSlot} />
      <CountdownSlot.Provider value={slot}>{children}</CountdownSlot.Provider>
    </>
  );
}

/** The launch door's countdown: at the hub's top when the door is in one, else where the door is. */
export function DoorCountdown({ reading }: { reading: HeatReading }) {
  const slot = useContext(CountdownSlot);
  if (slot === null) return null;
  const countdown = <Countdown reading={reading} look="screen" />;
  return slot ? createPortal(countdown, slot) : countdown;
}
