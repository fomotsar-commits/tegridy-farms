// The three paths: the whole venue, as three things a stranger can do.
//
// WHY THIS EXISTS. The arrival hero used to carry three buttons of near-equal weight
// (Pick a bungalow / Launch on Heat / Scan any token) directly under four paragraphs.
// A first-time reader met three choices before meeting one number. Wave seven gives
// the hero back to the instrument and moves the choosing HERE, under the hall, where
// a visitor arrives having already seen what the place is.
//
// ONE LINE EACH, AND THE REQUIREMENT AT THE POINT OF INTENT. Every card states its
// own cost of entry in its own sentence, so nobody walks into a door that will turn
// them away: LP says there is no lock, and LAUNCH says what the floor is before the
// click rather than after it.
//
// THE FLOOR IS READ, NEVER TYPED. `heatLaunchFloor()` is the same value the launch
// gate enforces with, resolved at render. A typed 80 here would be a promise the gate
// could silently stop keeping.

import { Link } from 'react-router-dom';
import { heatLaunchFloor } from '../lib/heat/heatGateConfig';

export function ThreePaths() {
  const floor = heatLaunchFloor();

  const paths = [
    {
      to: '/#hall',
      title: 'Hold',
      line: 'Your clock starts at your first buy. Pick a bungalow.',
      accent: 'var(--color-kyle)',
    },
    {
      to: '/liquidity',
      title: 'Provide LP',
      // Lifted from LiquidityPage's own truths rather than written fresh, so the
      // promise on the door and the behaviour behind it cannot drift.
      line: 'Deposit a pair. Withdraw any time. No lock.',
      accent: '#31d0aa',
    },
    {
      to: '/launch',
      title: 'Launch',
      line: `Residents may plant. The floor is ${floor}°.`,
      accent: '#d4a843',
    },
  ];

  return (
    <section aria-label="Three paths" className="pb-16">
      <div className="grid gap-3 sm:grid-cols-3">
        {paths.map((p) => (
          <Link
            key={p.to}
            to={p.to}
            className="group rounded-2xl p-5 transition-all hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            style={{
              background: 'rgba(0,0,0,0.45)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.10)',
            }}
          >
            <h3
              className="text-[13px] uppercase tracking-[0.16em] font-semibold mb-2"
              style={{ color: p.accent }}
            >
              {p.title}
            </h3>
            <p className="text-white/80 text-[13.5px] leading-relaxed">{p.line}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
