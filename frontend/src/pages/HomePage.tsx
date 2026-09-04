import { useState, useEffect, useMemo } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { isAddress } from 'viem';
import { GALLERY_ORDER, UNIQUE_GALLERY_COUNT, pageArt, artStyle } from '../lib/artConfig';
import { isLauncherEnabled } from '../lib/launcher/config';
import { isSolanaSwapLive } from '../lib/solana';
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
import { TOWELI_ADDRESS, SITE_URL, ETHERSCAN_TOKEN, GECKOTERMINAL_URL, CURVE_LAUNCHER_ADDRESS, isDeployed } from '../lib/constants';
import { shortenAddress } from '../lib/formatting';
import { safeGetItem, safeSetItem } from '../lib/storage';
import { bungalowTradeBlurb, getBungalowIdentity } from '../lib/bungalows';
import { arrivalVoice, VENUE } from '../lib/arrival';
import { VenueHero } from '../components/VenueHero';
import { VenueDoors } from '../components/VenueDoors';
import { BungalowHero } from '../components/bungalow/BungalowHero';
import { BungalowMarket } from '../components/bungalow/BungalowMarket';
import { BungalowHolders } from '../components/bungalow/BungalowHolders';

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

// ARRIVAL IDENTITY 2026-08-27: the loop and how-it-works copy follow the
// arrival voice. Same mechanics both ways (the fee loop is a venue fact);
// only the Tegridy personality words are contained to the TOWELI bungalow.
const IS_TOWELI_ARRIVAL = arrivalVoice() === 'toweli';

const CORE_LOOP_STEPS = [
  IS_TOWELI_ARRIVAL
    ? { label: 'People trade TOWELI', sub: 'on the venue DEX' }
    : { label: 'People trade here', sub: 'on the venue DEX' },
  // F82: sub no longer just restates the label — it adds the "where" (router,
  // in ETH). The exact fee bps is on-chain (a T3 read) so we keep it generic
  // rather than hardcode a number that can drift.
  { label: 'Every swap skims a fee',  sub: 'taken at the router, in ETH' },
  // 2026-08-04: was 'on-chain, paid in ETH'. Verified on-chain the same day:
  // RevenueDistributor holds 0 wei and SwapFeeRouter.totalETHFees() is 0, so nothing
  // has ever been PAID. The route is real; the payment is not. This diagram explains
  // the DESIGN, so it now describes the route — true today and still true after the
  // first distribution, which is why it is a literal and not a conditional. The
  // history claim belongs on /premium, where it IS conditioned on the live read.
  { label: 'Fees route to stakers',   sub: 'on-chain, in ETH' },
  { label: 'Longer lock + NFT',       sub: 'bigger slice of the ETH' },
];

const HOW_IT_WORKS_STEPS = IS_TOWELI_ARRIVAL ? [
  {
    step: '1',
    title: 'Get Some Towelies',
    desc: 'Swap ETH for TOWELI on the venue DEX. Nine routes checked, best price picked \u2014 Randy does the math so you don\u2019t have to.',
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
    title: 'Harvest the Yield',
    desc: 'Emissions pay you in TOWELI today; the ETH fee-share is wired on-chain and opens with the native pool. Claim whenever the crop looks ripe.',
    to: '/dashboard',
  },
] : [
  {
    step: '1',
    title: 'Get the token',
    desc: 'Swap ETH for TOWELI on the venue DEX. Nine routes checked, best price picked.',
    to: '/swap',
  },
  {
    step: '2',
    title: 'Lock it down',
    desc: 'Lock from 7 days to 4 years. Longer lock + NFT boost = up to 4.5x share.',
    to: '/farm',
  },
  {
    step: '3',
    title: 'Harvest, verified',
    desc: 'Emissions pay in TOWELI today; the ETH fee-share is wired on-chain and opens with the native pool. Claim any time.',
    to: '/dashboard',
  },
];

export default function HomePage() {
  // Jungle Bay bungalows: resolved FIRST because the title below depends on
  // it — the /bayla door serves her <title> statically for crawlers, and
  // without this the SPA would overwrite it back to the venue title the
  // moment it hydrates. Stable per document (switching reloads).
  const bungalowIdentity = getBungalowIdentity();
  // 2026-08-07: the meta description said "Stake TOWELI on Ethereum" and stopped there,
  // so every search result, every link preview, and every share of the front door
  // described a single-chain product. Both halves below are separately checkable:
  // TOWELI staking really is Ethereum-only (do not let that rot into "multichain
  // staking"), and the Solana swap really is live and routed through Jupiter.
  usePageTitle(
    bungalowIdentity ? `${bungalowIdentity.symbol} — ${bungalowIdentity.identity.heroLine}` : 'Home',
    bungalowIdentity
      ? `${bungalowIdentity.name} bungalow on Jungle Bay Island. ${bungalowIdentity.identity.museLine} ${bungalowTradeBlurb(bungalowIdentity, isSolanaSwapLive())}`
      : IS_TOWELI_ARRIVAL
        ? 'Ethereum and Solana. Stake TOWELI on Ethereum — protocol swap fees flow on-chain to stakers, verifiable on Etherscan. Swap Solana tokens via Jupiter, and scan any token on either chain.'
        : VENUE.description,
  );
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
  // 2026-08-04: was 'Real yield, paid in ETH, on @TegridyFarms'. Verified on-chain the
  // same day — RevenueDistributor holds 0 wei, SwapFeeRouter.totalETHFees() is 0, so no
  // yield has ever been paid to anyone.
  //
  // This one is worse than an overclaim on a page: it is a PREWRITTEN tweet the visitor
  // posts under THEIR OWN name. An on-page claim embarrasses us; this one makes a
  // stranger vouch for something untrue to their own followers, and it survives any
  // later correction we make to the site. So it describes what the protocol IS rather
  // than what it has paid.
  const shareTweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    'Fee-routed staking, on-chain and in ETH, on @JungleBayAC \u{1F33F}',
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
            {/* CHAIN RAIL 2026-08-07: this was a single "LIVE ON ETHEREUM" badge, and
                it was the first thing every visitor read. It made a two-chain product
                look like a one-chain product: the Jupiter-routed Solana swap at /solana
                is fully live and fee-earning, /scan reads both chains, and the Solana
                launch rail is real — yet none of that existed above the fold, and the
                Solana entries sat two clicks deep in the More menu.

                Each pill states what is LIVE on that chain and links to it, so the claim
                is one click from being checked. Deliberately NOT a generic "multichain"
                badge: the two chains carry different surfaces and the pills say which.
                The Solana pill names swap + scan only — the Solana LAUNCH rail gets its
                own self-gating card in Launch & Verify below, which reads "Preview"
                until isSolanaSubmitReady() is true, so this rail can never advertise a
                launch surface that cannot launch. */}
            <div className="flex flex-wrap items-center gap-2 mb-5">
              <Link
                to="/farm"
                aria-label="Live on Ethereum: farm and stake TOWELI"
                className="badge badge-primary text-[10px] no-underline hover:brightness-110 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#8b5cf6]"
              >
                ETHEREUM
              </Link>
              {/* FAIL-CLOSED. The Solana swap surface is gated behind
                  VITE_SOLANA_FEE_ACCOUNT: when that is unset, SolanaSwapPage renders a
                  "Solana swap isn't live yet" wall and navConfig drops /solana from the
                  nav entirely. A hardcoded pill would then be a front-door claim
                  pointing at a SOON wall — the precise failure this page's other gated
                  claims (isLauncherEnabled, isSolanaSubmitReady) already avoid.
                  So the pill degrades instead of lying: it drops the swap claim and
                  points at /scan, which is the one Solana surface with NO gate at all
                  (scanner/index.ts dispatches to the Solana adapter unconditionally, so
                  it cannot be dark in any deployment). Mirrors navConfig's SOLANA_LIVE. */}
              <Link
                to={isSolanaSwapLive() ? '/solana' : '/scan'}
                aria-label={isSolanaSwapLive() ? 'Live on Solana: swap and scan' : 'Live on Solana: scan any token'}
                className="badge badge-chain-solana text-[10px] no-underline hover:brightness-110 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#4CAF50]"
              >
                SOLANA
              </Link>
              <Link
                to="/eth-curve"
                aria-label="Live on Base: launch and trade on the curve"
                className="badge badge-chain-base text-[10px] no-underline hover:brightness-110 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#2151f5]"
              >
                BASE
              </Link>
            </div>

            {/* Jungle Bay bungalows: when the active bungalow speaks for itself
                (Bayla), the whole H1→copy→CTA→quote cluster below is replaced by
                its token-first hero. The chain pills above and the security badge
                after stay — they are venue facts either way. The classic cluster
                is untouched for the Toweli default. */}
            {bungalowIdentity ? (
              <BungalowHero bungalow={bungalowIdentity} />
            ) : !IS_TOWELI_ARRIVAL ? (
              /* ARRIVAL IDENTITY 2026-08-27: the venue's own hero is the
                 default first impression. The classic Tegridy cluster below
                 is byte-identical and renders inside the TOWELI bungalow. */
              <VenueHero />
            ) : (
            <>
            {/* H1 2026-07-19: "Yield with Tegridy Farms" was generic — it could have
                headlined any farm. It deliberately does NOT lead with the ETH
                fee-share: that mechanic is wired on-chain but has distributed 0 ETH
                until the native pool opens, so a present-tense yield claim would
                overclaim (and "100% of fees to stakers" is flat wrong — AUDIT R073:
                swap fees split 5/6 to LPs, 1/6 to the protocol). What IS true, and
                became materially truer today, is verifiability: every core contract
                is now Etherscan source-verified and /contracts proves it with live
                per-address badges. So the headline leads with the one differentiator
                a skeptic can check in a single click. */}
            <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
              Farm TOWELI.<br /><span className="text-white">Check our work.</span>
            </h1>

            {/* 2026-08-07: added the Solana sentence. It is deliberately a SEPARATE
                sentence rather than a rewrite of the staking claim — TOWELI staking is
                Ethereum-only and must keep saying so. The Solana clause names only what
                is live today (the Jupiter-routed swap and the two-chain scanner); the
                launch rail is claimed by its own self-gating card further down. */}
            <p className="text-white text-base md:text-lg mb-6 max-w-md leading-relaxed">
              Stake TOWELI on Ethereum. Every protocol fee flows on-chain &mdash; to stakers, the
              liquidity engine, and operations. Every core contract is source-verified on Etherscan,
              so you can read the code that holds your stake. On Solana we swap through Jupiter and
              scan any token &mdash; same rails, second chain.
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
              {/* NO-WALLET entry point. Both CTAs above ask a first-time visitor to
                  either connect or buy before the app does anything for them. The
                  scanner is genuinely useful with no wallet, on any token — so give
                  it a front-door slot as the low-commitment third option. */}
              <Link to="/scan"
                className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#4CAF50]"
                style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                Scan a token
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
            </>
            )}

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
              and Dashboard are the better signal. Suppressed in a token-first
              bungalow: it computes TOWELI staking yield, which is the wrong
              token there (Bayla's farm panel owns that story). */}
          {!address && !bungalowIdentity && IS_TOWELI_ARRIVAL && (
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
          {/* Suppressed in a token-first bungalow like the calculator/stat
              pills above: this banner talks about Ethereum-mainnet TOWELI
              reads that a Solana bungalow's home is not showing. */}
          {!bungalowIdentity && (
            <WrongChainBanner className="mt-10 max-w-xl" message="Showing Ethereum mainnet data. Switch your wallet to the canonical network to interact." />
          )}

          {/* Token-first bungalow (Bayla): the TVL/TOWELI-price stat pills and
              the TOWELI contract strip are the wrong token there — the
              BungalowHero carries its own contract chip. Everything inside
              this gate is untouched for the Toweli default. */}
          {IS_TOWELI_ARRIVAL && !bungalowIdentity && (
          <>
          <m.div className="mt-14 flex flex-wrap gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            {([
              // F85: USD-primary TVL with the TOWELI count secondary when a price
              // is available (Uniswap/Aave-grade). Falls back to TOWELI-only on a
              // price outage (stats.tvlUsd is '' then).
              { l: 'TVL', v: stats.tvlUsd || stats.tvl, sub: stats.tvlUsd && stats.tvl !== '–' ? stats.tvl : undefined },
              { l: 'TOWELI Price', v: effectiveToweliPrice || '–', showSparkline: true },
              { l: 'Emissions APR', v: pool.isDeployed && pool.apr !== '0' ? `${pool.apr}%` : '–' },
              // F47 (T7 + T11): the global lifetime-ETH read now fires logged-out
              // (useRevenueStats split the global query off the wallet gate), and
              // we stop conflating loaded-zero with loading: shimmer ONLY while
              // genuinely loading; once resolved, render the honest "0.0000 ETH"
              // (the value that backs the on-chain-verifiable pitch) instead of an
              // eternal skeleton. `loading: true` forces the shimmer branch below.
              { l: 'ETH Distributed', v: revenueStats.isDataError ? '–' : `${revenueStats.totalDistributed.toFixed(4)} ETH`, loading: revenueStats.isDataLoading, sub: (!revenueStats.isDataLoading && !revenueStats.isDataError && revenueStats.totalDistributed === 0) ? 'fee rail live · first at native-pool launch' : undefined },
            ] as { l: string; v: string; sub?: string; showSparkline?: boolean; loading?: boolean }[]).map((s) => (
              <div key={s.l} className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
                style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid rgba(76,175,80,0.35)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                {/* Kyle green on stats text over black pill for maximum visibility on brown/purple art. */}
                <span className="text-[12px] flex items-center gap-1.5" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.l}{s.showSparkline && <PulseDot size={5} />}</span>
                {s.showSparkline ? (
                  <FlashValue value={price.priceInUsd}>
                    <span className="stat-value text-[13px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.loading ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : (s.v && s.v !== '–') ? <CountUpText value={s.v} /> : <span>–</span>}</span>
                  </FlashValue>
                ) : (
                  <span className="stat-value text-[13px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.loading ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : (s.v && s.v !== '–') ? <CountUpText value={s.v} /> : <span>–</span>}</span>
                )}
                {/* F85: TOWELI count as a secondary figure under the USD TVL. */}
                {s.sub && (
                  <span className="text-[11px]" style={{ color: 'var(--color-kyle)', opacity: 0.7, textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                    {s.sub}
                  </span>
                )}
                {s.l === 'Emissions APR' && s.v && s.v !== '–' && (
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
              aria-label="Share MEMETICS.FINANCE on X (opens in new tab)"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] text-white hover:text-white transition-colors"
              style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid var(--color-purple-40)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Share
            </a>
          </m.div>
          </>
          )}
        </div>

        {/* The bungalow's market — her own pool's chart + numbers, in the slot
            where the default venue puts its TOWELI stat pills. Renders only
            when the bungalow declares a `market` pool; self-hides otherwise. */}
        {bungalowIdentity?.market && (
          <div className="pb-8">
            <BungalowMarket bungalow={bungalowIdentity} />
          </div>
        )}

        {/* Who holds her — the venue's own scanner, run on this bungalow's
            token, with its coverage limits stated rather than smoothed over. */}
        {bungalowIdentity?.address && (
          <div className="pb-16">
            <BungalowHolders bungalow={bungalowIdentity} />
          </div>
        )}

        {/* Jungle Bay bungalow lore — the resident's story card, rendered
            only in its own skin, in the slot where the TOWELI fee-economy
            explainer sits for the default. Registry-driven (identity.lore,
            canon copy only): a resident without lore gets NO card rather
            than another resident's story. */}
        {bungalowIdentity?.identity.lore && (
          <div className="pb-16">
            <div className="relative rounded-2xl overflow-hidden glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0" aria-hidden="true">
                <ArtImg pageId="bungalow-lore" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
              </div>
              <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.72)' }} />
              <div className="relative z-10 p-6 md:p-10 max-w-2xl">
                <p className="text-[11px] uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--color-kyle)' }}>The lore</p>
                <h2 className="heading-luxury text-2xl md:text-3xl text-white mb-4">{bungalowIdentity.identity.lore.title}</h2>
                {bungalowIdentity.identity.lore.paragraphs.map((para, i, all) => (
                  <p key={i} className={`text-white/90 text-[14px] leading-relaxed ${i === all.length - 1 ? 'mb-5' : 'mb-3'}`}>
                    {para}
                  </p>
                ))}
                <div className="flex flex-wrap gap-2">
                  {bungalowIdentity.identity.lore.links.map((l) => (
                    <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
                      aria-label={`${l.label} (opens in new tab)`}
                      className="px-3 py-2 rounded-lg text-[12px] text-white hover:text-white transition-colors"
                      style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-purple-40)' }}>
                      {l.label} <span className="text-white/40">↗</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ARRIVAL IDENTITY 2026-08-31: THE HALL OF DOORS. The venue arrival
            opens onto the island itself — every bungalow door in one hall,
            the open ones lit and the settled ones greyed while their people
            move in. Venue voice only: toweli keeps the classic home whole,
            an identity bungalow keeps its token-first home. */}
        {!bungalowIdentity && !IS_TOWELI_ARRIVAL && <VenueDoors />}

        {/* ARRIVAL FLOW 2026-08-31 (the noise cut): the farm's body speaks
            only in the farm's room. Core Loop, By the Numbers, the pulse and
            the proof strips are TOWELI protocol furniture; on the venue
            arrival they were three competing how-it-works blocks and one
            resident's numbers wearing the venue's name. The venue line is
            now: hero → the hall → Launch & Verify → Ecosystem → the
            Collection → FAQ. Nothing deleted; it all renders inside /toweli. */}
        {!bungalowIdentity && IS_TOWELI_ARRIVAL && (
        <>
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
                {/* 2026-08-07: scoped to Ethereum. The four steps below describe the
                    Ethereum-mainnet fee economy (SwapFeeRouter -> RevenueDistributor ->
                    stakers) and their wording is deliberately audit-corrected. Solana
                    has no part in it. Now that the page reads dual-chain, an unqualified
                    "The Core Loop" would be read as covering both chains — so the
                    diagram's honesty is protected by naming its chain, not by editing
                    a single one of its steps. */}
                <span className="text-[10px] uppercase tracking-[0.18em] text-white/90" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>The Core Loop &middot; Ethereum</span>
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
        </>
        )}

        {/* Protocol Overview — farm-shaped product grid (Stake TOWELI to earn
            now…). The venue arrival keeps its clean line; the nav and the
            hero CTAs carry the product routes there. Toweli and bungalow
            homes keep the grid exactly as it was. */}
        {(bungalowIdentity || IS_TOWELI_ARRIVAL) && (
        <div className="pb-16">
          <m.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Protocol Overview</h2>
            <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Farm, swap, and track your positions &mdash; on Ethereum and on Solana.</p>
          </m.div>

          {/* 2026-08-07: 3 -> 4 cards. The Solana swap has been fully live (Jupiter
              routing, limit orders, SOL liquid-staking discovery, and a platform fee we
              actually collect) while being reachable ONLY from the More menu, so the
              product's second chain was invisible on its own front page. Nothing was
              removed; each card now carries an explicit CHAIN label so a visitor can
              tell at a glance which surface runs where.
              Grid goes 1 -> 2 -> 4 rather than straight to 4: at md (iPad portrait) four
              220px-min cards in a row are unreadably narrow, so tablets get a 2x2. */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { to: '/swap', title: 'Swap', desc: 'Trade ETH ↔ TOWELI via Uniswap V2 with custom slippage controls.', stat: 'Uniswap V2', label: 'Ethereum', art: pageArt('home', 6) },
              // 2026-08-28: "two active pools to earn yield" outlived the LP
              // pool's funded period (periodFinish 2026-06-15, lpEmissions.ts) —
              // the exact literal-vs-phase drift dayTwoEconomyPhrase() exists to
              // prevent. State what pays now without promising the dormant pool.
              { to: '/farm', title: 'Farm', desc: 'Stake TOWELI to earn now; the LP pool rejoins when its next emissions round is funded.', stat: '2 pools', label: 'Ethereum', art: pageArt('home', 7) },
              // Spread-gated on the SAME predicate navConfig uses to decide whether
              // /solana appears in the nav at all. Unset fee account => the page is a
              // SOON wall, so the card is simply absent and the grid falls back to
              // three. A card advertising a wall is worse than no card.
              ...(isSolanaSwapLive()
                ? [{ to: '/solana', title: 'Solana Swap', desc: 'Buy Solana tokens routed through Jupiter, with limit orders and SOL liquid-staking yield. Trending pairs listed, fee shown before you sign.', stat: 'Jupiter', label: 'Solana', art: pageArt('home', 15) }]
                : []),
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
        )}

        {/* Launch & Verify — ADDITIVE section (2026-07-27).
            The two most-built, most-differentiated surfaces — the token launcher
            and the detection suite — appeared NOWHERE on the highest-traffic page,
            which funnelled every visitor into farm/swap/dashboard only. These work
            on any token and need no TOWELI position, so they belong on the front
            door. Same art-card pattern as Protocol Overview; nothing above or below
            was moved or removed. */}
        <div className="pb-16">
          <m.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Launch &amp; Verify</h2>
            <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Ship a token with its disclosure attached, on Ethereum or Solana &mdash; or check someone else&apos;s before you ape.</p>
          </m.div>

          {/* 2026-08-07: 3 -> 4 cards, adding the Solana rail. Same 1 -> 2 -> 4 grid as
              Protocol Overview for the same tablet-width reason. */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              // Memetics Curve — our OWN zero-toll launch curve, LIVE on mainnet
              // 2026-08-24. Placed first because it is the flagship launch surface and
              // the one that just went live. Spread-gated on the SAME live read the
              // page and nav gate on (isDeployed(CURVE_LAUNCHER_ADDRESS)) — if the
              // address is ever zeroed the card simply disappears, so the front door
              // can never advertise a curve that isn't deployed. Distinct from the
              // Doppler card below: no Airlock, no petition, 100% of the fee in-house.
              ...(isDeployed(CURVE_LAUNCHER_ADDRESS)
                ? [{
                    to: '/eth-curve',
                    title: 'Memetics Curve',
                    desc: 'Our own zero-toll bonding curve. Launch in one signature, then graduate into our own pool with the LP burned — no Airlock, no petition, no third-party cut.',
                    stat: 'Zero-toll',
                    label: 'Live · Ethereum, Base & Robinhood',
                    art: pageArt('home', 17),
                  }]
                : []),
              // The launch card follows the SAME gate the nav uses, so the front door
              // can never advertise a rail that is switched off (it reads "Soon" and
              // /launch renders its explainer instead of a wizard).
              {
                to: '/launch',
                title: 'Launch on Ethereum',
                desc: 'A Doppler dynamic auction with an automated hygiene gate and a published Fact Sheet: fee split, LP lock, and vesting, disclosed at launch.',
                stat: isLauncherEnabled() ? 'Doppler V4' : 'Soon',
                label: isLauncherEnabled() ? 'Ethereum' : 'Not yet live',
                art: pageArt('home', 12),
              },
              // The 'Launch on Solana' tile pointed at /solana-launch (Meteora DBC) and
              // was REMOVED 2026-08-23 with that rail — it graduated into a pool we do
              // not own. Its replacement, /curve-launch, is deliberately NOT promoted
              // here: both program ids were closed on mainnet and are permanently
              // spent, so the page would be advertising a rail that cannot launch. The
              // nav pills it "Soon" from a live read of the program id; a home tile has
              // no such read and would be a claim rather than a measurement. Restore a
              // tile here only after the redeploy, and gate it on the same read.
              { to: '/scan', title: 'Scan a token', desc: 'Holder concentration and distribution for any Ethereum or Solana token — with every exclusion listed and a timestamp. No wallet needed.', stat: 'ETH + SOL', label: 'Any token', art: pageArt('home', 13) },
              // 2026-08-07: stat was 'On-chain', which named no chain. That was harmless
              // while the page was ETH-only; it is not now. /deployer accepts EVM
              // addresses ONLY (DeployerPage rejects anything else with "Not a valid
              // Ethereum address yet"), and this card sits directly beside one whose
              // badge reads "ETH + SOL" — so a reader carries the chain scope across and
              // pastes a Solana address into an Ethereum-only tool. Naming the chain is
              // the fix; the copy is otherwise untouched.
              { to: '/deployer', title: 'Check a deployer', desc: 'See what a wallet has shipped before and where each token stands today. Gaps in the data are stated plainly, never papered over.', stat: 'ETH', label: 'Track record', art: pageArt('home', 14) },
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

        {/* How It Works — the three-step TOWELI farm walkthrough; TOWELI room
            only (ARRIVAL FLOW 2026-08-31: the venue teaches the island, not
            the farm; a bungalow's farm story lives on its own /farm panel). */}
        {!bungalowIdentity && IS_TOWELI_ARRIVAL && (
        <div className="pb-16">
          <m.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            {/* 2026-08-07: "How It Works" -> "How the Farm Works". All three steps are
                Ethereum-only and audit-corrected, and they stay verbatim — but titled
                "How It Works" on a dual-chain front page they claimed to explain the
                WHOLE product, so a visitor who came for the launcher or the scanner was
                told the product is a three-step TOWELI farm. Scoping the title, not the
                steps. */}
            <h2 className="heading-luxury text-xl text-white tracking-tight mb-1 text-center" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>How the Farm Works</h2>
            <p className="text-white/90 text-[12px] text-center mb-6" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{IS_TOWELI_ARRIVAL ? 'Three steps, on Ethereum. No bullshit. Held time counts.' : 'Three steps, on Ethereum. No bullshit. Held time counts.'}</p>
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
        )}

        {/* Trust Badges */}
        <div className="pb-16">
          <div className="flex flex-wrap justify-center gap-3">
            {/* HONESTY PASS 2026-06-11: "Bug Bounty Active" → "Responsible
                Disclosure" (the bounty has no funded pool yet).
                UPDATED 2026-07-19: "Contracts Verified" is RESTORED — all 8 core
                contracts are now Etherscan source-verified, and /contracts proves
                it with a live per-address badge. It replaces "82 Findings
                Resolved", which was an aggregate count backed by nothing in the
                repo and which the Security page deliberately refuses to publish
                ("We do not publish aggregate 'resolved' counts here"). Every
                badge here must be checkable in one click. */}
            {[
              { label: 'Contracts Verified', to: '/contracts' },
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

        {/* Ecosystem — ARRIVAL FLOW 2026-08-31: the subline places the island
            ABOVE the venue (the island is the world; the venue lives on it). */}
        <div className="pb-16">
          <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Ecosystem</h2>
          <p className="text-white text-[12px] mb-5">Jungle Bay Island. The world this venue lives on.</p>
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
            page's glass-panel styling. Default-only: the FAQ answers the TOWELI
            farm, the wrong questions inside a bungalow. */}
        {!bungalowIdentity && (
        <div className="pb-16">
          <m.div
            className="rounded-2xl p-6 md:p-8 text-center"
            style={{ background: 'rgba(6,12,26,0.78)', border: '1px solid var(--color-purple-40)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}
            initial={{ opacity: 0, y: 15 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="heading-luxury text-xl text-white tracking-tight mb-2" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              {IS_TOWELI_ARRIVAL ? FAQ_INTRO.headline : 'Questions about the venue'}
            </h2>
            <p className="text-white/90 text-[13px] max-w-xl mx-auto mb-5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              {IS_TOWELI_ARRIVAL ? FAQ_INTRO.subheading : 'Plain answers, checkable claims. Below are the questions we hear most.'}
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
        )}

        {/* Referral Widget for connected users — default-only: referral rewards
            are the TOWELI program. */}
        {address && !bungalowIdentity && (
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
