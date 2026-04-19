import { useState, useEffect } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { GALLERY_ORDER, pageArt, artStyle } from '../lib/artConfig';
import { useFarmStats } from '../hooks/useFarmStats';
import { usePoolData } from '../hooks/usePoolData';
import { useRevenueStats } from '../hooks/useRevenueStats';
import { Sparkline } from '../components/Sparkline';
import { PulseDot } from '../components/PulseDot';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { formatCurrency } from '../lib/formatting';
import { FlashValue } from '../components/FlashValue';
import { ReferralWidget } from '../components/ReferralWidget';
import { usePageTitle } from '../hooks/usePageTitle';
import { YieldCalculator } from '../components/ui/YieldCalculator';
import { TOWELIE_QUOTES } from '../lib/copy';
import { ArtImg } from '../components/ArtImg';

const CORE_LOOP_STEPS = [
  { label: 'People trade TOWELI',     sub: 'on the Tegridy DEX' },
  { label: 'Every swap skims a fee',  sub: '0.3% on each trade' },
  { label: '100% flows to stakers',   sub: 'paid out in ETH' },
  { label: 'Longer lock + NFT',       sub: 'bigger slice of the ETH' },
];

const HOW_IT_WORKS_STEPS = [
  {
    step: '1',
    title: 'Get Some Towelies',
    desc: 'Swap ETH for TOWELI on the Tegridy DEX. Nine routes checked, best price picked \u2014 Randy does the math so you don\u2019t have to.',
    to: '/swap',
  },
  {
    step: '2',
    title: 'Lock It Down',
    desc: 'From The Taste Test (7d) to Till Death Do Us Farm (4y). Longer lock + NFT boost = up to 4.5x share.',
    to: '/farm',
  },
  {
    step: '3',
    title: 'Harvest the Tegridy',
    desc: '100% of every swap fee pays out in ETH. Not tokens, not IOUs \u2014 ETH. Claim whenever the crop looks ripe.',
    to: '/dashboard',
  },
];

export default function HomePage() {
  usePageTitle('Home', 'Earn ETH yields on Ethereum. Stake TOWELI & earn 100% of protocol revenue.');
  const { address } = useAccount();
  const stats = useFarmStats();
  const pool = usePoolData();
  const revenueStats = useRevenueStats();
  const price = useTOWELIPrice();
  const priceHistory = usePriceHistory(price.priceInUsd);
  const { history: priceData, error: priceError } = priceHistory;

  // Use PriceContext price (useToweliPrice already fetches from GeckoTerminal as fallback)
  const effectiveToweliPrice = price.priceInUsd > 0 ? formatCurrency(price.priceInUsd, 6) : stats.toweliPrice;

  // Rotating Towelie one-liner under the hero CTAs — pure personality surface,
  // never blocks interaction. Starts on a random quote so repeat visits feel fresh.
  const [quoteIdx, setQuoteIdx] = useState(() => Math.floor(Math.random() * TOWELIE_QUOTES.length));
  useEffect(() => {
    const id = window.setInterval(() => {
      setQuoteIdx(i => (i + 1) % TOWELIE_QUOTES.length);
    }, 7000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="home" idx={0} alt="" className="w-full h-full object-cover object-center" />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6">
        <div className="pt-28 pb-20">
          <m.div className="max-w-xl" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <div className="badge badge-primary mb-5 text-[10px]">LIVE ON ETHEREUM</div>

            <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
              Yield with<br /><span className="text-white">Tegridy Farms</span>
            </h1>

            <p className="text-white text-base md:text-lg mb-6 max-w-md leading-relaxed">
              Stake TOWELI. Every swap on the DEX feeds ETH back to stakers &mdash; 100% of it.
              Real farm. Real yield. Earned with tegridy.
            </p>

            <div className="flex flex-wrap gap-3">
              <ConnectButton.Custom>
                {({ account, chain, openConnectModal, mounted }) => {
                  const connected = mounted && account && chain;
                  return (
                    <div {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none' } })}>
                      {!connected ? (
                        <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">
                          Connect Wallet
                        </button>
                      ) : (
                        <Link to="/farm" className="btn-primary px-7 py-2.5 text-[14px] inline-block text-center">
                          Start Farming
                        </Link>
                      )}
                    </div>
                  );
                }}
              </ConnectButton.Custom>
              <Link to="/swap"
                className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center"
                style={{ background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)', color: '#0a0a0f' }}>
                Buy TOWELI
              </Link>
            </div>

            {/* Rotating Towelie one-liner — the personality beat right next to
                the CTAs that the front-end critique flagged as missing. */}
            <div className="mt-4 min-h-[22px]" aria-live="polite">
              <AnimatePresence mode="wait">
                <m.span
                  key={quoteIdx}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.4 }}
                  className="inline-flex items-baseline gap-2 text-[12px] italic"
                >
                  <span className="text-white/80">&ldquo;{TOWELIE_QUOTES[quoteIdx]}&rdquo;</span>
                  <span className="text-[10px] not-italic" style={{ color: 'var(--color-weed)' }}>&mdash; Towelie</span>
                </m.span>
              </AnimatePresence>
            </div>

            {/* Audit trust badge — visible in hero so first-time visitors
                see security posture before scrolling. Links to /security. */}
            <Link
              to="/security"
              aria-label="View security audit details and bug bounty program"
              className="inline-flex items-center gap-2 mt-5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all hover:opacity-90"
              style={{
                background: 'rgba(139, 92, 246, 0.12)',
                border: '1px solid rgba(245, 228, 184, 0.25)',
                color: '#f5e4b8',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
              Audited · Bug Bounty Active
            </Link>
          </m.div>

          {/* Wallet-less yield calculator for first-time visitors.
              Only shown when disconnected — once they connect, the live stats
              and Dashboard are the better signal. */}
          {!address && (
            <div className="mt-10 max-w-xl">
              <YieldCalculator />
            </div>
          )}

          <m.div className="mt-14 flex flex-wrap gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            {[
              { l: 'TVL', v: stats.tvl },
              { l: 'TOWELI Price', v: effectiveToweliPrice || '–', showSparkline: true },
              { l: 'Base APR', v: pool.isDeployed && pool.apr !== '0' ? `${pool.apr}%` : '–' },
              { l: 'ETH Distributed', v: revenueStats.totalDistributed > 0 ? `${revenueStats.totalDistributed.toFixed(4)} ETH` : '–' },
            ].map((s) => (
              <div key={s.l} className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
                style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid rgba(76,175,80,0.35)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                {/* Kyle green on stats text over black pill for maximum visibility on brown/purple art. */}
                <span className="text-[12px] flex items-center gap-1.5" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.l}{s.showSparkline && <PulseDot size={5} />}</span>
                {s.showSparkline ? (
                  <FlashValue value={price.priceInUsd}>
                    <span className="stat-value text-[13px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(!s.v || s.v === '–') ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : s.v}</span>
                  </FlashValue>
                ) : (
                  <span className="stat-value text-[13px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(!s.v || s.v === '–') ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : s.v}</span>
                )}
                {s.showSparkline && priceData.length > 1 && (
                  <Sparkline data={priceData} width={48} height={16} />
                )}
                {s.showSparkline && priceError && priceData.length === 0 && (
                  <span className="text-[10px]" style={{ color: 'var(--color-kyle)' }}>Price data unavailable</span>
                )}
              </div>
            ))}
          </m.div>
        </div>

        {/* Core Loop — the 10-second explainer.
            Directly addresses the critique that new visitors don't grasp
            TOWELI-trade → ETH-fee → stakers → bigger-lock flow fast enough. */}
        <m.div
          className="pb-16"
          initial={{ opacity: 0, y: 15 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <div className="relative rounded-2xl overflow-hidden" style={{ border: '1px solid var(--color-weed-40)' }}>
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <ArtImg pageId="home" idx={1} alt="" className="w-full h-full object-cover" loading="lazy" />
            </div>
            <div className="relative p-5 md:p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-weed)' }} />
                <span className="text-[10px] uppercase tracking-[0.18em] text-white/90" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>The Core Loop</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-3 md:gap-2">
                {CORE_LOOP_STEPS.flatMap((step, i) => {
                  const box = (
                    <div
                      key={`loop-step-${i}`}
                      className="relative rounded-xl overflow-hidden text-center flex flex-col justify-center min-h-[88px]"
                      style={{ border: '1px solid var(--color-weed-40)' }}
                    >
                      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                        <ArtImg pageId="home" idx={2 + i} alt="" loading="lazy" className="w-full h-full object-cover" />
                      </div>
                      <div className="relative p-3 md:p-4">
                        <div className="text-white text-[13px] md:text-[14px] font-semibold leading-tight" style={{ textShadow: '0 2px 8px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,1)' }}>{step.label}</div>
                        <div className="text-white text-[11px] mt-1" style={{ textShadow: '0 2px 8px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,1)' }}>{step.sub}</div>
                      </div>
                    </div>
                  );
                  const isLast = i === CORE_LOOP_STEPS.length - 1;
                  if (isLast) return [box];
                  const arrow = (
                    <div
                      key={`loop-arrow-${i}`}
                      className="flex items-center justify-center"
                      style={{ color: 'var(--color-weed)' }}
                      aria-hidden="true"
                    >
                      <span className="md:hidden text-[20px] leading-none">&darr;</span>
                      <span className="hidden md:inline text-[22px] leading-none">&rarr;</span>
                    </div>
                  );
                  return [box, arrow];
                })}
              </div>
            </div>
          </div>
        </m.div>

        {/* Protocol Overview */}
        <div className="pb-16">
          <m.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Protocol Overview</h2>
            <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Farm, swap, and track your positions.</p>
          </m.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { to: '/swap', title: 'Swap', desc: 'Trade ETH ↔ TOWELI via Uniswap V2 with custom slippage controls.', stat: 'Uniswap V2', label: 'Router', art: pageArt('home', 6) },
              { to: '/farm', title: 'Farm', desc: 'Stake TOWELI or LP tokens across two active pools to earn yield.', stat: '2', label: 'Active Pools', art: pageArt('home', 7) },
              { to: '/dashboard', title: 'Dashboard', desc: 'Track your portfolio, positions, claimable rewards, and projections.', stat: 'Real-time', label: 'On-chain Data', art: pageArt('home', 8) },
            ].map((f, i) => (
              <m.div key={f.title} initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }}
                viewport={{ once: true, margin: '-50px' }} transition={{ delay: i * 0.15, type: 'spring', damping: 20, stiffness: 100 }}>
                <Link to={f.to} className="block group relative rounded-xl overflow-hidden glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
                  <div className="absolute inset-0">
                    <img src={f.art.src} alt="" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" style={artStyle(f.art)} />
                  </div>
                  <div className="relative z-10 p-6 min-h-[220px] flex flex-col">
                    <h3 className="heading-luxury text-[17px] text-white mb-2 group-hover:text-white transition-colors" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{f.title}</h3>
                    <p className="text-white text-[13px] leading-relaxed mb-auto" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{f.desc}</p>
                    <div className="pt-4 flex items-center justify-between mt-4" style={{ borderTop: '1px solid var(--color-purple-75)' }}>
                      <span className="stat-value text-white text-[16px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{f.stat}</span>
                      <span className="text-white text-[11px] uppercase tracking-wider label-pill" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{f.label}</span>
                    </div>
                  </div>
                </Link>
              </m.div>
            ))}
          </div>
        </div>

        {/* How It Works */}
        <div className="pb-16">
          <m.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-xl text-white tracking-tight mb-1 text-center" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>How It Works</h2>
            <p className="text-white/90 text-[12px] text-center mb-6" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Three steps. No bullshit. Real tegridy.</p>
          </m.div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {HOW_IT_WORKS_STEPS.map((s, i) => (
              <m.div key={s.step} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }}>
                <Link to={s.to} className="relative block rounded-xl overflow-hidden transition-transform hover:scale-[1.015] h-full"
                  style={{ border: '1px solid var(--color-purple-40)' }}>
                  {/* Art background keeps each step card visually unique.
                      Text readability comes from layered text-shadow, not a scrim —
                      so the art shows at full brightness. */}
                  <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                    <ArtImg pageId="home" idx={9 + i} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </div>
                  <div className="relative p-5">
                    <span className="inline-flex w-8 h-8 shrink-0 rounded-full text-[14px] font-bold leading-none items-center justify-center mb-3"
                      style={{ background: 'var(--color-weed-60)', border: '2px solid #fff', color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.6)' }}>
                      {s.step}
                    </span>
                    <h3 className="text-white text-[15px] font-semibold mb-1" style={{ textShadow: '0 2px 8px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,1)' }}>{s.title}</h3>
                    <p className="text-white text-[12px] leading-relaxed" style={{ textShadow: '0 2px 8px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,1)' }}>{s.desc}</p>
                  </div>
                </Link>
              </m.div>
            ))}
          </div>
        </div>

        {/* Trust Badges */}
        <div className="pb-16">
          <div className="flex flex-wrap justify-center gap-3">
            {[
              { label: '82 Findings Resolved', to: '/security' },
              { label: 'Contracts Verified', to: '/security' },
              { label: 'Bug Bounty Active', to: '/security' },
              { label: 'Open Source', href: 'https://github.com/fomotsar-commits/tegridy-farms' },
            ].map((b) => (
              'href' in b ? (
                <a key={b.label} href={b.href} target="_blank" rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg text-white text-[11px] hover:text-white transition-colors flex items-center gap-1.5"
                  style={{ background: 'rgba(6,12,26,0.78)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', border: '1px solid var(--color-purple-40)' }}>
                  <span className="text-emerald-400">&#10003;</span> {b.label}
                </a>
              ) : (
                <Link key={b.label} to={b.to}
                  className="px-4 py-2 rounded-lg text-white text-[11px] hover:text-white transition-colors flex items-center gap-1.5"
                  style={{ background: 'rgba(6,12,26,0.78)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', border: '1px solid var(--color-purple-40)' }}>
                  <span className="text-emerald-400">&#10003;</span> {b.label}
                </Link>
              )
            ))}
          </div>
        </div>

        {/* Ecosystem */}
        <div className="pb-16">
          <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Ecosystem</h2>
          <p className="text-white text-[12px] mb-5">The Jungle Bay universe</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <m.div initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, margin: '-50px' }} transition={{ delay: 0, type: 'spring', damping: 20, stiffness: 100 }}>
            <a href="https://opensea.io/collection/junglebay" target="_blank" rel="noopener noreferrer"
              className="relative overflow-hidden rounded-xl glass-card-animated group block" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <ArtImg pageId="home" idx={12} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="relative z-10 p-5">
                <p className="text-white text-[14px] font-semibold group-hover:text-white transition-colors mb-1">JBAC NFTs</p>
                <p className="text-white text-[12px]">5,555 customizable apes. The genesis collection that started it all.</p>
              </div>
            </a>
            </m.div>
            <m.div initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, margin: '-50px' }} transition={{ delay: 0.15, type: 'spring', damping: 20, stiffness: 100 }}>
            <a href="https://app.uniswap.org/swap?chain=base" target="_blank" rel="noopener noreferrer"
              className="relative overflow-hidden rounded-xl glass-card-animated group block" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <ArtImg pageId="home" idx={13} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="relative z-10 p-5">
                <p className="text-white text-[14px] font-semibold group-hover:text-white transition-colors mb-1">$JBM on Base</p>
                <p className="text-white text-[12px]">The accidental community token. Born from a bot glitch, adopted by the degens.</p>
              </div>
            </a>
            </m.div>
            <m.div initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, margin: '-50px' }} transition={{ delay: 0.3, type: 'spring', damping: 20, stiffness: 100 }}>
            <Link to="/lore" className="relative overflow-hidden rounded-xl glass-card-animated group block" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <ArtImg pageId="home" idx={14} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="relative z-10 p-5">
                <p className="text-white text-[14px] font-semibold group-hover:text-white transition-colors mb-1">The Story</p>
                <p className="text-white text-[12px]">From rug to riches. How we became the blueprint for community-built DeFi.</p>
              </div>
            </Link>
            </m.div>
          </div>
        </div>

        {/* Art Preview (moved below ecosystem) */}
        <div className="pb-16">
          <div className="flex items-end justify-between mb-6">
            <div>
              <h2 className="heading-luxury text-xl text-white tracking-tight">The Collection</h2>
              <p className="text-white text-[12px] mt-0.5">{GALLERY_ORDER.length} original pieces</p>
            </div>
            <Link to="/gallery" className="text-white text-[13px] font-medium hover:opacity-80 transition-opacity">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {GALLERY_ORDER.slice(0, 4).map((piece, i) => (
              <m.div key={piece.src} initial={{ opacity: 0, y: 25, scale: 0.85 }} whileInView={{ opacity: 1, y: 0, scale: 1 }}
                viewport={{ once: true, margin: '-50px' }} transition={{ delay: i * 0.15, type: 'spring', damping: 20, stiffness: 100 }}>
                <Link to="/gallery" className="block group">
                  <div className="rounded-xl aspect-square relative overflow-hidden glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
                    <img src={piece.src} alt={piece.title}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-all flex items-end">
                      <div className="w-full p-3 opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: 'linear-gradient(to top, rgba(6,12,26,0.8) 0%, transparent 100%)' }}>
                        <span className="text-[12px] text-white font-medium">{piece.title}</span>
                      </div>
                    </div>
                  </div>
                </Link>
              </m.div>
            ))}
          </div>
        </div>

        {/* Referral Widget for connected users */}
        {address && (
          <div className="pb-16">
            <ReferralWidget
              address={address}
              referredCount={revenueStats.referredCount}
              referralEarned={revenueStats.referralEarned}
              referralPending={revenueStats.referralPending}
            />
          </div>
        )}
      </div>
    </div>
  );
}
