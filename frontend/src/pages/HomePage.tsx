import { useState, useEffect, useMemo } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { isAddress } from 'viem';
import { GALLERY_ORDER, UNIQUE_GALLERY_COUNT, pageArt, artStyle } from '../lib/artConfig';
import { useFarmStats } from '../hooks/useFarmStats';
import { usePoolData } from '../hooks/usePoolData';
import { useRevenueStats } from '../hooks/useRevenueStats';
import { Sparkline } from '../components/Sparkline';
import { PulseDot } from '../components/PulseDot';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { formatCurrency } from '../lib/formatting';
import { FlashValue } from '../components/FlashValue';
import { CountUpText } from '../components/motion';
import { ReferralWidget } from '../components/ReferralWidget';
import { WrongChainBanner } from '../components/ui/WrongChainGuard';
import { usePageTitle } from '../hooks/usePageTitle';
import { YieldCalculator } from '../components/ui/YieldCalculator';
import { TOWELIE_QUOTES, FAQ_INTRO } from '../lib/copy';
import { ArtImg } from '../components/ArtImg';
import { ProtocolStats } from '../components/ProtocolStats';
import { RealYieldProof } from '../components/RealYieldProof';
import { ProtocolPulse } from '../components/ProtocolPulse';
import { ProofOfClaims } from '../components/ProofOfClaims';
import { CopyButton } from '../components/ui/CopyButton';
import { TOWELI_ADDRESS, SITE_URL, ETHERSCAN_TOKEN, GECKOTERMINAL_URL } from '../lib/constants';
import { shortenAddress } from '../lib/formatting';
import { safeGetItem, safeSetItem } from '../lib/storage';

// F91: surfaced from the Footer's community links — keep one source so Home
// and Footer can't drift. (Footer still owns its own copy; these mirror it.)
const SOCIAL_LINKS = [
  { href: 'https://x.com/junglebayac', label: 'Twitter / X' },
  { href: 'https://discord.gg/junglebay', label: 'Discord' },
  { href: 'https://t.me/tegridyfarms', label: 'Telegram' },
] as const;

// F92: persist a valid ?ref= address so attribution survives navigation and
// the connect-ordering (referred visitor clicks Buy → connects on /swap). Uses
// the safe storage wrapper, never overwrites an existing stash.
const REF_STORAGE_KEY = 'tegridy_ref';

const CORE_LOOP_STEPS = [
  { label: 'People trade TOWELI',     sub: 'on the Tegridy DEX' },
  // F82: sub no longer just restates the label — it adds the "where" (router,
  // in ETH). The exact fee bps is on-chain (a T3 read) so we keep it generic
  // rather than hardcode a number that can drift.
  { label: 'Every swap skims a fee',  sub: 'taken at the router, in ETH' },
  { label: 'Fees flow to stakers',    sub: 'on-chain, paid in ETH' },
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
    desc: 'Emissions pay you in TOWELI today; the ETH fee-share is wired on-chain and opens with the native pool. Claim whenever the crop looks ripe.',
    to: '/dashboard',
  },
];

export default function HomePage() {
  usePageTitle('Home', 'Stake TOWELI on Ethereum. Protocol swap fees flow on-chain to stakers — verifiable on Etherscan.');
  const { address } = useAccount();
  const stats = useFarmStats();
  const pool = usePoolData();
  const revenueStats = useRevenueStats();
  const price = useTOWELIPrice();
  const priceHistory = usePriceHistory();
  const { history: priceData, error: priceError } = priceHistory;
  const reduceMotion = useReducedMotion();

  // F74: PriceContext is the single source — stats.toweliPrice is derived from
  // the same price.priceInUsd, so its fallback can never differ from "–".
  const effectiveToweliPrice = price.priceInUsd > 0 ? formatCurrency(price.priceInUsd, 6) : '–';

  // F86: true 24h change from the sparkline series (first vs last close). This is
  // a real 24h delta, not the session-since-mount change the PriceContext exposes.
  const priceChange24h = useMemo(() => {
    if (priceData.length < 2) return null;
    const first = priceData[0];
    const last = priceData[priceData.length - 1];
    if (!first || first <= 0 || last == null) return null;
    return ((last - first) / first) * 100;
  }, [priceData]);

  // F92: capture a valid ?ref= on first load so the Buy CTA + ReferralWidget can
  // honor it after navigation/connect. Never overwrite an existing stash.
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get('ref');
      if (ref && isAddress(ref) && !safeGetItem(REF_STORAGE_KEY)) {
        safeSetItem(REF_STORAGE_KEY, ref);
      }
    } catch {
      // window/storage may be unavailable (SSR/test); non-critical.
    }
  }, []);
  const stashedRef = (() => {
    try {
      const r = safeGetItem(REF_STORAGE_KEY);
      return r && isAddress(r) ? r : null;
    } catch {
      return null;
    }
  })();
  const buyToHref = stashedRef ? `/swap?ref=${stashedRef}` : '/swap';

  // F93: canonical share URL + tweet intent (no referral attribution) so even
  // disconnected visitors get a share affordance. Mirrors ReferralWidget's
  // tweet-URL construction with the SITE_URL origin (F64 single source).
  const shareUrl = SITE_URL;
  const shareTweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    'Real yield, paid in ETH, on @TegridyFarms \u{1F33F}',
  )}&url=${encodeURIComponent(shareUrl)}`;

  // Rotating Towelie one-liner under the hero CTAs — pure personality surface,
  // never blocks interaction. Starts on a random quote so repeat visits feel fresh.
  const [quoteIdx, setQuoteIdx] = useState(() => Math.floor(Math.random() * TOWELIE_QUOTES.length));
  // F77: pause rotation in a hidden tab and skip it entirely under
  // prefers-reduced-motion (decorative ticker; no need to animate for opted-out
  // users). The aria-live wrapper is also dropped below — it announced a joke
  // to screen readers every 7s.
  useEffect(() => {
    if (reduceMotion) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setQuoteIdx(i => (i + 1) % TOWELIE_QUOTES.length);
    }, 7000);
    return () => window.clearInterval(id);
  }, [reduceMotion]);

  return (
    <div className="-mt-14 relative min-h-screen overflow-x-clip">
      {/* F82: the hero shell is deliberately theme-invariant — this is an
          art-first page whose white-on-mural legibility (scrims, text-shadows,
          black stat pills) is tuned for the dark backdrop regardless of the
          app theme. The TopNav toggle still themes the chrome; the hero stays
          dark on purpose. Do NOT restyle the art-backed hero per theme. */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        {/* F66: this is the LCP image (preloaded in index.html). fetchPriority
            high ensures the browser fetches it ahead of below-the-fold art. */}
        <ArtImg pageId="home" idx={0} alt="" fetchPriority="high" className="w-full h-full object-cover object-center" />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6">
        <div className="pt-28 pb-20">
          <m.div className="max-w-xl relative" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            {/* Readability scrim — softly darkens the art behind the hero copy so the white
                text stays legible over light patches of the art (e.g. the pale ape on the
                left). Additive only: fades to transparent, so the art elsewhere is untouched. */}
            <div aria-hidden="true" className="absolute -left-6 -right-10 -top-8 -bottom-8 -z-10 pointer-events-none"
              style={{ background: 'radial-gradient(115% 115% at 12% 42%, rgba(6,12,26,0.88) 0%, rgba(6,12,26,0.6) 42%, rgba(6,12,26,0.2) 68%, transparent 84%)' }} />
            <div className="badge badge-primary mb-5 text-[10px]">LIVE ON ETHEREUM</div>

            <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
              Yield with<br /><span className="text-white">Tegridy Farms</span>
            </h1>

            <p className="text-white text-base md:text-lg mb-6 max-w-md leading-relaxed">
              Stake TOWELI. Every protocol fee flows on-chain &mdash; to stakers, the liquidity
              engine, and operations. Verifiable on Etherscan. Real farm. Earned with tegridy.
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
              {/* F92: carry a captured ?ref= through to /swap so attribution
                  survives the disconnected Buy click. F82: add a real hover
                  (brightness) + a visible focus-visible ring (was transition-all
                  with nothing to transition). */}
              <Link to={buyToHref}
                className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#d4a843]"
                style={{ background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)', color: '#0a0a0f' }}>
                Buy TOWELI
              </Link>
            </div>

            {/* Rotating Towelie one-liner — the personality beat right next to
                the CTAs that the front-end critique flagged as missing.
                F57: reserve a fixed min-height (so an empty/short quote can't
                shift the trust badge) and sit the quote in a subtle backdrop-blur
                pill so it stays legible over the busy mural. */}
            {/* F77: no aria-live — a decorative joke ticker shouldn't announce
                to screen readers every 7s. F81: reserve two lines on mobile so a
                wrapping quote (the 56-char line) can't shift the trust badge
                below every rotation. */}
            <div className="mt-4 min-h-[48px] md:min-h-[34px] flex items-center">
              <AnimatePresence mode="wait">
                <m.span
                  key={quoteIdx}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.4 }}
                  className="inline-flex items-baseline gap-2 text-[13px] italic rounded-full px-3 py-1.5"
                  style={{ background: 'rgba(6,12,26,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
                >
                  <span className="text-white/90">&ldquo;{TOWELIE_QUOTES[quoteIdx]}&rdquo;</span>
                  <span className="text-[11px] not-italic" style={{ color: 'var(--color-weed)' }}>&mdash; Towelie</span>
                </m.span>
              </AnimatePresence>
            </div>

            {/* Security trust badge — visible in hero so first-time visitors
                see security posture before scrolling. Links to /security.
                HONESTY PASS 2026-06-11: no paid third-party audit exists, so the
                badge states the actual (checkable) record: internal multi-agent
                audit waves + Slither CI + the 1,500+ test suite. */}
            <Link
              to="/security"
              aria-label="View security details: internal audit waves, Slither CI, and the test suite"
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
              Internal audit waves · Slither CI · 1,500+ tests
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

          {/* F94 (T9): when a connected wallet is on the wrong network the hero
              stats still read mainnet (every read hook is chain-pinned to
              CHAIN_ID), so flag the mismatch additively. Reuses the shared
              WrongChainBanner (renders null when disconnected or on-chain — its
              own mt is only applied when it actually renders), so there's no new
              copy surface and behaviour matches Farm/Community. */}
          <WrongChainBanner className="mt-10 max-w-xl" message="Showing Ethereum mainnet data. Switch your wallet to the canonical network to interact." />

          <m.div className="mt-14 flex flex-wrap gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            {([
              // F85: USD-primary TVL with the TOWELI count secondary when a price
              // is available (Uniswap/Aave-grade). Falls back to TOWELI-only on a
              // price outage (stats.tvlUsd is '' then).
              { l: 'TVL', v: stats.tvlUsd || stats.tvl, sub: stats.tvlUsd && stats.tvl !== '–' ? stats.tvl : undefined },
              { l: 'TOWELI Price', v: effectiveToweliPrice || '–', showSparkline: true },
              { l: 'Base APR', v: pool.isDeployed && pool.apr !== '0' ? `${pool.apr}%` : '–' },
              // F47 (T7 + T11): the global lifetime-ETH read now fires logged-out
              // (useRevenueStats split the global query off the wallet gate), and
              // we stop conflating loaded-zero with loading: shimmer ONLY while
              // genuinely loading; once resolved, render the honest "0.0000 ETH"
              // (the value that backs the on-chain-verifiable pitch) instead of an
              // eternal skeleton. `loading: true` forces the shimmer branch below.
              { l: 'ETH Distributed', v: `${revenueStats.totalDistributed.toFixed(4)} ETH`, loading: revenueStats.isDataLoading },
            ] as { l: string; v: string; sub?: string; showSparkline?: boolean; loading?: boolean }[]).map((s) => (
              <div key={s.l} className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
                style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid rgba(76,175,80,0.35)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                {/* Kyle green on stats text over black pill for maximum visibility on brown/purple art. */}
                <span className="text-[12px] flex items-center gap-1.5" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.l}{s.showSparkline && <PulseDot size={5} />}</span>
                {s.showSparkline ? (
                  <FlashValue value={price.priceInUsd}>
                    <span className="stat-value text-[13px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(s.loading || !s.v || s.v === '–') ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : <CountUpText value={s.v} />}</span>
                  </FlashValue>
                ) : (
                  <span className="stat-value text-[13px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{(s.loading || !s.v || s.v === '–') ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : <CountUpText value={s.v} />}</span>
                )}
                {/* F85: TOWELI count as a secondary figure under the USD TVL. */}
                {s.sub && (
                  <span className="text-[11px]" style={{ color: 'var(--color-kyle)', opacity: 0.7, textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                    {s.sub}
                  </span>
                )}
                {s.l === 'Base APR' && s.v && s.v !== '–' && (
                  <span
                    title="High at launch because total staked is still small — it falls toward steady-state as staking grows. The real yield is the ETH paid to stakers."
                    className="text-[10px] italic cursor-help"
                    style={{ color: 'var(--color-kyle)', opacity: 0.7, textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
                  >
                    early-stage
                  </span>
                )}
                {s.showSparkline && priceData.length > 1 && (
                  <Sparkline data={priceData} width={48} height={16} title="TOWELI price, last 24h" />
                )}
                {/* F86: real 24h change badge (first-vs-last of the 24h series). */}
                {s.showSparkline && priceChange24h !== null && (
                  <span
                    title="Change over the last 24 hours (TOWELI/WETH pool)"
                    className="text-[11px] font-medium"
                    style={{ color: priceChange24h >= 0 ? '#22c55e' : '#ef4444', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
                  >
                    {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(1)}% 24h
                  </span>
                )}
                {s.showSparkline && priceError && priceData.length === 0 && (
                  <span className="text-[10px]" style={{ color: 'var(--color-kyle)' }}>Price data unavailable</span>
                )}
              </div>
            ))}
          </m.div>

          {/* F87/F88/F93: token contract address strip — copy the address, view
              it on Etherscan/GeckoTerminal, and a generic Share affordance that
              works even when disconnected (the referral tweet is connected-only).
              Additive: surfaces the canonical TOWELI address (was only on
              /contracts) the way every buy-page does. */}
          <m.div
            className="mt-6 flex flex-wrap items-center gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid var(--color-purple-40)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
              <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)', opacity: 0.8 }}>TOWELI</span>
              <CopyButton
                text={TOWELI_ADDRESS}
                display={shortenAddress(TOWELI_ADDRESS, 6)}
                className="font-mono text-[12px]"
                style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
              />
            </div>
            <a href={ETHERSCAN_TOKEN} target="_blank" rel="noopener noreferrer"
              aria-label="View TOWELI on Etherscan (opens in new tab)"
              className="px-3 py-2 rounded-lg text-[12px] text-white hover:text-white transition-colors"
              style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid var(--color-purple-40)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
              Etherscan <span className="text-white/40">↗</span>
            </a>
            <a href={GECKOTERMINAL_URL} target="_blank" rel="noopener noreferrer"
              aria-label="View TOWELI on GeckoTerminal (opens in new tab)"
              className="px-3 py-2 rounded-lg text-[12px] text-white hover:text-white transition-colors"
              style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid var(--color-purple-40)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
              GeckoTerminal <span className="text-white/40">↗</span>
            </a>
            <a href={shareTweetUrl} target="_blank" rel="noopener noreferrer"
              aria-label="Share Tegridy Farms on X (opens in new tab)"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] text-white hover:text-white transition-colors"
              style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid var(--color-purple-40)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Share
            </a>
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

        {/* By the Numbers — live on-chain protocol analytics */}
        <m.div className="pb-16" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="mb-6">
            <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>By the Numbers</h2>
            <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Live on-chain stats &mdash; and the protocol guarantees behind them.</p>
          </div>
          <ProtocolStats />
        </m.div>

        {/* Live Protocol Pulse — research-backed "what's moving in TOWELI" hook.
            Self-gating: renders NOTHING while the protocol is dormant (currently
            ~0 trades/24h), lights up automatically when real trading exists. */}
        <ProtocolPulse limit={8} />

        {/* Prove It — every headline claim rendered live from the chain (kills the
            trust-copy drift the June audit caught). Always populated (cheap reads). */}
        <m.div className="pb-16" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <ProofOfClaims />
        </m.div>

        {/* Real-yield proof — self-gating: renders nothing until the first
            ETH distribution lands, then lights up automatically. */}
        <RealYieldProof />

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
            {/* HONESTY PASS 2026-06-11: "Contracts Verified" → "Timelocked Admin"
                (Etherscan source-verify is still rolling out post-relaunch; the
                24-48h timelock IS live and checkable) and "Bug Bounty Active" →
                "Responsible Disclosure" (the bounty has no funded pool yet). */}
            {[
              { label: '82 Findings Resolved', to: '/security' },
              { label: 'Timelocked Admin', to: '/security' },
              { label: 'Responsible Disclosure', to: '/security' },
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

          {/* F91: community/social proof — the same links the Footer carries,
              surfaced near the trust row so first-time visitors see an active
              community without scrolling to the footer. */}
          <div className="flex flex-wrap justify-center gap-3 mt-4">
            {SOCIAL_LINKS.map((s) => (
              <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer"
                aria-label={`${s.label} (opens in new tab)`}
                className="px-4 py-2 rounded-lg text-white text-[11px] hover:text-white transition-colors flex items-center gap-1.5"
                style={{ background: 'rgba(6,12,26,0.78)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', border: '1px solid var(--color-purple-40)' }}>
                {s.label} <span className="text-white/40">↗</span>
              </a>
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
              {/* F75: unique-work count — a few pieces ship in two file formats,
                  so GALLERY_ORDER.length over-counts. Gallery still shows all files. */}
              <p className="text-white text-[12px] mt-0.5">{UNIQUE_GALLERY_COUNT} original pieces</p>
            </div>
            <Link to="/gallery" className="text-white text-[13px] font-medium hover:opacity-80 transition-opacity">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
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

        {/* F90: FAQ teaser — Home never funneled to the FAQ page despite the
            copy + route existing. Additive panel with a CTA, consistent with the
            page's glass-panel styling. */}
        <div className="pb-16">
          <m.div
            className="rounded-2xl p-6 md:p-8 text-center"
            style={{ background: 'rgba(6,12,26,0.78)', border: '1px solid var(--color-purple-40)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}
            initial={{ opacity: 0, y: 15 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="heading-luxury text-xl text-white tracking-tight mb-2" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              {FAQ_INTRO.headline}
            </h2>
            <p className="text-white/90 text-[13px] max-w-xl mx-auto mb-5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              {FAQ_INTRO.subheading}
            </p>
            <Link to="/faq" className="btn-primary px-6 py-2.5 text-[13px] inline-flex items-center gap-1.5">
              Read the FAQ
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Link>
          </m.div>
        </div>

        {/* Referral Widget for connected users */}
        {address && (
          <div className="pb-16">
            <ReferralWidget
              address={address}
              referredCount={revenueStats.referredCount}
              referralEarned={revenueStats.referralEarned}
              referralPending={revenueStats.referralPending}
              referralPendingBig={revenueStats.referralPendingBig}
              hasReferrer={revenueStats.hasReferrer}
              referrer={revenueStats.referrer}
              onClaim={revenueStats.claimReferralRewards}
              onSetReferrer={revenueStats.setReferrer}
              isPending={revenueStats.isPending}
              isConfirming={revenueStats.isConfirming}
            />
          </div>
        )}
      </div>
    </div>
  );
}
