// The countdown (island answer twenty-five, screen 2; twenty-four, build 5): what a wallet under
// the launch floor sees on /launch and on the heat card. A timer, one line, one green button and
// the roster, in the island's words (lib/arrival.ts COUNTDOWN_WORDS), never reworded here. The
// measures are the drawing's, at 390 wide; colors and fonts are index.css tokens.

import { createContext, useContext, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { COUNTDOWN_WORDS } from '../../lib/arrival';
import { countdownTimer, type HeatReading } from '../../lib/heat/heatOracle';
import { heatLaunchFloor } from '../../lib/heat/heatGateConfig';
import { sheetHref } from '../../lib/sheet';
import { useScreenMove } from '../../lib/screenMove';
import { useIslandTorches } from '../../hooks/useIslandTorches';

const MONO: CSSProperties = { fontFamily: 'var(--font-family-mono)' };
const ARCHIVO = 'var(--font-family-heading)';

export interface CountdownProps {
  /** The wallet read: its own degrees, tier and the island's days to the door. */
  reading: HeatReading;
  /** 'screen' is the launch page's own band: 28 px under the header, on the page's ground with
   *  the violet glow behind, the whole first screen on a phone. 'card' sits inside a heat card,
   *  which is its own ground. */
  look?: 'screen' | 'card';
}

export function Countdown({ reading, look = 'card' }: CountdownProps) {
  const floor = heatLaunchFloor();
  const { pathname, search } = useLocation();
  const warming = useIslandTorches()?.warming ?? null;
  // One green button per screen (answer twenty-five, §2): Bayla's line goes quiet while this is up.
  useScreenMove('start');
  const eyebrowId = useId();

  const timer = countdownTimer(reading);
  // "0° today" is true only of a wallet standing at zero; past it the label would misplace it.
  const atZero = reading.isCold || !(reading.degrees > 0);
  // Degrees over the floor of the width, from the reading alone: it never moves on its own.
  const at = Math.min(1, Math.max(0, reading.degrees / floor));
  // Left out unread, at 0 ("never 0"), and at 1, which the island's words have no singular for.
  const roster = warming !== null && warming >= 2 ? COUNTDOWN_WORDS.roster(warming) : null;
  const screen = look === 'screen';

  return (
    <section
      data-testid="countdown"
      data-look={look}
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
          <p className="text-[11px] leading-none tracking-[0.14em] uppercase text-right" style={{ ...MONO, color: 'var(--color-text-secondary)' }}>
            {COUNTDOWN_WORDS.standing(reading.tier, reading.degrees.toFixed(2))}
          </p>
        </div>

        {timer &&
          ('days' in timer ? (
            <p className="flex items-baseline gap-2.5 mt-[22px] text-white">
              <span style={{ fontFamily: ARCHIVO, fontWeight: 900, fontSize: 96, lineHeight: 0.8, letterSpacing: '-0.04em' }}>
                {timer.days.toLocaleString('en-US')}
              </span>{' '}
              <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: 28, lineHeight: 1 }}>{COUNTDOWN_WORDS.days}</span>
            </p>
          ) : (
            <p className="mt-[22px] text-white" style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: 40, lineHeight: 1.05 }}>
              {COUNTDOWN_WORDS.unserved}
            </p>
          ))}
        {timer && (
          <p className="text-[15px] leading-snug mt-[18px]" style={{ color: 'var(--color-text-secondary)' }}>
            {COUNTDOWN_WORDS.under}
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
          {COUNTDOWN_WORDS.line}
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
          <Link to={sheetHref(pathname, search, 'buy')} className="btn-primary w-full h-[52px] flex items-center justify-center text-[15px]">
            {COUNTDOWN_WORDS.button}
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
