import { Link } from 'react-router-dom';

/**
 * WAVE SEVEN, ruling 2 (row Q): THE TOWELI ROOM'S BAND.
 *
 * TOWELI's protocol pages (lib/routeVoice.ts, TOWELI_ROOM_PATHS) describe one
 * resident's protocol. A visitor who lands on one by URL is told whose room
 * they are in and handed the way back, instead of the venue's name sitting over
 * TOWELI's numbers with nothing said.
 *
 * IN THE PAGE'S FLOW, NEVER OVER IT (element E): the first thing inside main,
 * not sticky and not fixed, so it scrolls away with the page it labels.
 *
 * WHAT IT DOES NOT DO: switch the stored skin or reload. The venue's name stays
 * in the nav by the owner's 2026-08-31 rule; this band is the room's label under
 * it. "Back to memetics.finance" is the index route, the same door the wordmark
 * opens, so it clears any stored skin exactly as that does.
 */
export function ToweliRoomStrip() {
  return (
    <div
      data-room="toweli"
      className="relative z-20 border-b text-[12px] md:text-[13px]"
      style={{ background: 'rgba(6,12,26,0.85)', borderColor: 'var(--color-purple-20)' }}
    >
      <div className="max-w-[1200px] mx-auto px-4 md:px-6 py-1 flex flex-wrap items-center justify-between gap-x-4">
        <p className="text-white/85 py-2" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          You are in the{' '}
          <Link to="/toweli" className="underline underline-offset-4 hover:text-white">
            TOWELI room
          </Link>
          . This page describes TOWELI&apos;s own protocol.
        </p>
        <Link
          to="/"
          className="text-white/85 underline underline-offset-4 hover:text-white min-h-[44px] inline-flex items-center"
          style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
        >
          Back to memetics.finance
        </Link>
      </div>
    </div>
  );
}
