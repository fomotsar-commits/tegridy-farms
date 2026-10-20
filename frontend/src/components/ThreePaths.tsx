// The three paths: NFT Finance, Marketplace and Launch, one line each (owner, 2026-10-17:
// "instead of these three buttons we should show nft finance, marketplace and launch").
// The first two lines are lifted from their own pages, so the door cannot promise more
// than the room. LAUNCH says the floor: heatLaunchFloor(), the value the launch gate
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
      to: '/nft-finance',
      title: 'NFT Finance',
      // LendingPage's own line under its heading.
      line: 'Borrow against your NFT, lend to others, or trade NFTs in a pool.',
      accent: '#34d399',
    },
    {
      // The Island section's Marketplace (navConfig), routed outside AppLayout.
      to: '/nakamigos',
      title: 'Marketplace',
      // The marketplace landing's own line under TRADERMIGOS.
      line: 'Browse. Buy. Sell. Make offers.',
      accent: '#6fa8dc',
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
            {/* h2, not h3: since answer twenty the paths sit directly under the hero's h1,
                above the hall's own h2, and axe's heading-order fails a skipped level. */}
            <h2
              className="text-[13px] uppercase tracking-[0.16em] font-semibold mb-2"
              style={{ color: p.accent }}
            >
              {p.title}
            </h2>
            <p className="text-white/80 text-[13.5px] leading-relaxed">{p.line}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
