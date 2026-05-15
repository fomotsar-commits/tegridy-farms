import { m } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArtImg } from '../components/ArtImg';
import { DropCard } from '../components/launchpad/DropCard';
import { useLaunchpadList } from '../hooks/useLaunchpadList';
import { useFarmStats } from '../hooks/useFarmStats';
import { useRevenueStats } from '../hooks/useRevenueStats';
import { usePageTitle } from '../hooks/usePageTitle';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { formatCurrency } from '../lib/formatting';

const SECTION_HEADER: React.CSSProperties = {
  textShadow: '0 1px 6px rgba(0,0,0,0.95)',
};

/**
 * Launchpad-first landing page (P0-1 of the 30-day UX push).
 *
 * The page is built around drop discovery rather than marketing copy:
 *   • Live Drops — anything with an open mint phase and capacity left.
 *   • Upcoming Drops — phase 0 (CLOSED, pre-mint) or paused with capacity.
 *   • Sold Out — full collections + cancelled drops, kept browseable.
 *
 * When the V2 factory is still the zero placeholder (day 0), the page
 * shows an explicit empty hero pointing creators at the launch wizard.
 * The original marketing-style home is preserved verbatim at `/classic`
 * and linked from the footer + a small link at the bottom of this page.
 *
 * Stats strip (TVL + ETH distributed + Live drops count) is the only
 * non-gallery surface — it's the trust signal that survives the swap
 * from the old hero. Memory rule: never delete personality surfaces;
 * the page art and the link to /classic preserve all of it.
 */
export default function LaunchpadHomePage() {
  usePageTitle(
    'Tegridy Farms',
    'The fairest way to launch a meme coin and grow it for real.',
  );

  const { categorized, factoryCount, isFactoryDeployed, isLoading } =
    useLaunchpadList();
  const stats = useFarmStats();
  const revenueStats = useRevenueStats();
  // P2-7: ETH/USD via Chainlink (shared price context).
  const price = useTOWELIPrice();
  const distributedUsd =
    !price.oracleStale && price.ethUsd > 0 && revenueStats.totalDistributed > 0
      ? formatCurrency(revenueStats.totalDistributed * price.ethUsd, 0)
      : null;

  const liveCount = categorized.live.length;
  const upcomingCount = categorized.upcoming.length;
  const soldOutCount = categorized.soldOut.length;
  const isEmptyState =
    !isLoading &&
    liveCount === 0 &&
    upcomingCount === 0 &&
    soldOutCount === 0;

  return (
    <div className="-mt-14 relative min-h-screen">
      {/* Background art — preserved additively from the classic home's art
          rotation. The launchpad-home pageId gets its own deterministic
          slice of ART_POOL_ALL so it doesn't collide with the classic page. */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg
          pageId="launchpad-home"
          idx={0}
          alt=""
          className="w-full h-full object-cover object-center"
        />
      </div>

      <div className="relative z-10 max-w-[1280px] mx-auto px-4 md:px-6">
        {/* ─── Hero ──────────────────────────────────────────────── */}
        <div className="pt-24 md:pt-28 pb-10 md:pb-14">
          <m.div
            className="max-w-2xl"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="badge badge-primary mb-5 text-[10px]">
              LIVE ON ETHEREUM
            </div>
            {/* Hero copy lives in P2-10. For now the working subhead
                explains the lifecycle in plain English so the page works
                today even if a copy refresh lands later. */}
            <h1
              className="heading-luxury text-3xl md:text-6xl text-white leading-[1.05] tracking-tight mb-4"
              style={SECTION_HEADER}
            >
              The fairest way to launch
              <br />
              <span className="text-white">a meme coin.</span>
            </h1>
            <p
              className="text-white text-base md:text-lg mb-6 max-w-xl leading-relaxed"
              style={SECTION_HEADER}
            >
              Launch on day one. Earn ETH from every swap. Stake longer for a
              bigger slice. Built for creators, paid out to holders.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/nft-finance?section=launchpad"
                className="btn-primary px-7 py-2.5 text-[14px] inline-block text-center"
              >
                Launch a drop
              </Link>
              <Link
                to="/swap"
                className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center"
                style={{
                  background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)',
                  color: '#0a0a0f',
                }}
              >
                Buy TOWELI
              </Link>
            </div>
          </m.div>

          {/* Stats strip — preserved from the classic home as the trust
              signal that survives the gallery swap. */}
          <m.div
            className="mt-10 flex flex-wrap gap-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
          >
            {[
              { l: 'TVL', v: stats.tvl },
              {
                l: 'ETH Distributed',
                // P2-7: USD subtitle appended via the Chainlink ETH/USD feed
                // (shared price context). Hidden when oracle is stale.
                v:
                  revenueStats.totalDistributed > 0
                    ? `${revenueStats.totalDistributed.toFixed(4)} ETH${distributedUsd ? ` · ${distributedUsd}` : ''}`
                    : '–',
              },
              { l: 'Live drops', v: isFactoryDeployed ? String(liveCount) : '–' },
              {
                l: 'Total drops',
                v: isFactoryDeployed ? String(factoryCount) : '–',
              },
            ].map((s) => (
              <div
                key={s.l}
                className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
                style={{
                  background: 'rgba(0,0,0,0.78)',
                  border: '1px solid rgba(76,175,80,0.35)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                }}
              >
                <span
                  className="text-[12px]"
                  style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
                >
                  {s.l}
                </span>
                <span
                  className="stat-value text-[13px]"
                  style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
                >
                  {!s.v || s.v === '–' ? (
                    <span className="inline-block w-12 h-4 rounded bg-black/60 shimmer" />
                  ) : (
                    s.v
                  )}
                </span>
              </div>
            ))}
          </m.div>
        </div>

        {/* ─── Empty state (day 0: factory not deployed OR zero drops) ── */}
        {isEmptyState && (
          <m.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mb-14 relative overflow-hidden rounded-2xl"
            style={{ border: '1px solid var(--color-purple-75)' }}
          >
            <div className="absolute inset-0 pointer-events-none">
              <ArtImg
                pageId="launchpad-home"
                idx={1}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </div>
            <div
              className="relative p-8 md:p-12 text-center"
              style={{ background: 'rgba(6,12,26,0.78)' }}
            >
              <h2
                className="heading-luxury text-2xl md:text-3xl text-white mb-3"
                style={SECTION_HEADER}
              >
                First drop launching soon
              </h2>
              <p
                className="text-white text-[14px] md:text-[15px] max-w-lg mx-auto mb-6"
                style={SECTION_HEADER}
              >
                {isFactoryDeployed
                  ? 'No live drops yet. Be the creator who lights it up.'
                  : 'The launchpad goes live shortly. Be the creator who lights it up.'}
              </p>
              <Link
                to="/nft-finance?section=launchpad"
                className="btn-primary inline-block px-7 py-2.5 text-[14px]"
              >
                Launch your collection
              </Link>
            </div>
          </m.div>
        )}

        {/* ─── Live drops ─────────────────────────────────────────── */}
        {liveCount > 0 && (
          <Section title="Live drops" tag={`${liveCount} open`}>
            <Grid>
              {categorized.live.map((d, i) => (
                <DropCard key={d.address} drop={d} idx={i} />
              ))}
            </Grid>
          </Section>
        )}

        {/* ─── Upcoming ───────────────────────────────────────────── */}
        {upcomingCount > 0 && (
          <Section title="Upcoming drops" tag={`${upcomingCount} queued`}>
            <Grid>
              {categorized.upcoming.map((d, i) => (
                <DropCard key={d.address} drop={d} idx={i} />
              ))}
            </Grid>
          </Section>
        )}

        {/* ─── Sold out ───────────────────────────────────────────── */}
        {soldOutCount > 0 && (
          <Section title="Recently closed" tag={`${soldOutCount} sold out`}>
            <Grid>
              {categorized.soldOut.slice(0, 8).map((d, i) => (
                <DropCard key={d.address} drop={d} idx={i} />
              ))}
            </Grid>
          </Section>
        )}

        {/* ─── Loading shimmer while reads come back ──────────────── */}
        {isLoading && liveCount === 0 && upcomingCount === 0 && soldOutCount === 0 && (
          <div className="mb-14">
            <Grid>
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl overflow-hidden shimmer"
                  style={{
                    aspectRatio: '4/5',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid var(--color-purple-40)',
                  }}
                />
              ))}
            </Grid>
          </div>
        )}

        {/* ─── Footer link to classic home ────────────────────────── */}
        <div className="pb-16 text-center">
          <Link
            to="/classic"
            className="text-white/70 hover:text-white text-[12px] underline underline-offset-4 transition-colors"
          >
            Looking for the classic Tegridy intro? →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  tag,
  children,
}: {
  title: string;
  tag?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pb-12">
      <div className="flex items-end justify-between mb-4">
        <h2
          className="heading-luxury text-xl md:text-2xl text-white tracking-tight"
          style={SECTION_HEADER}
        >
          {title}
        </h2>
        {tag && (
          <span
            className="text-[11px] uppercase tracking-wider px-2 py-1 rounded-md"
            style={{
              background: 'rgba(0,0,0,0.65)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.85)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
            }}
          >
            {tag}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  // 1 col on iPhone (< 480px), 2 on small tablet, 3 on iPad, 4 on desktop.
  // Memory: must be flawless on iPhone 14+ (390px), iPad portrait (768px).
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
      {children}
    </div>
  );
}
