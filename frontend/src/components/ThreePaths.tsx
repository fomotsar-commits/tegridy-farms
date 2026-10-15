// The three paths: the whole venue as three things a stranger can do, one line each.
// Every card states its own cost of entry before the click: LP says there is no lock,
// and LAUNCH says the floor. The floor is heatLaunchFloor(), the value the launch gate
// enforces, read at render and never typed.

import { Link } from 'react-router-dom';
import { heatLaunchFloor } from '../lib/heat/heatGateConfig';
import { tierAtFloor } from '../lib/heat/heatOracle';
import { CardArt } from './ui/CardArt';

// The three cards; a path added later reuses a registered art surface (idx wraps).
const PATH_ART_SLOTS = 3;

export function ThreePaths() {
  const floor = heatLaunchFloor();
  // Answer ten, ruling 4: name the tier only when the floor sits exactly on its rung.
  const floorTier = tierAtFloor(floor);

  const paths = [
    {
      to: '/#hall',
      title: 'Hold',
      line: 'Your clock on a token starts at your first hold. Pick a bungalow.',
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
      line: floorTier ? `${floorTier}s may plant. The floor is ${floor}°.` : `The floor is ${floor}°.`,
      accent: '#d4a843',
    },
  ];

  return (
    <section aria-label="Three paths" className="pb-16">
      <div className="grid gap-3 sm:grid-cols-3">
        {paths.map((p, i) => (
          <Link
            key={p.to}
            to={p.to}
            className="group relative isolate rounded-2xl p-5 transition-all hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            style={{
              background: 'rgba(0,0,0,0.45)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.10)',
            }}
          >
            <CardArt pageId="three-paths" idx={0 + (i % PATH_ART_SLOTS)} />
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
