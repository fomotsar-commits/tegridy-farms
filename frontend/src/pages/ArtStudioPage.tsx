import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ART, pageArt, type ArtPiece } from '../lib/artConfig';
import { ART_OVERRIDES, type ArtOverride } from '../lib/artOverrides';

// ─────────────────────────────────────────────────────────────────────────────
// Surface inventory — every (pageId, idx) the app renders.
// Mirrors the spec the user provided. Add entries here as new pageArt() call
// sites are added to the codebase.
// ─────────────────────────────────────────────────────────────────────────────

type Surface = { group: string; pageId: string; idx: number; label: string };

// Where each pageId actually renders in the app — used by the "Live page"
// preview tab to iframe the real route. If a pageId belongs to a section
// component (e.g. 'farm-stats', 'gauge-voting'), it routes to the page that
// embeds it.
const PAGE_ROUTES: Record<string, string> = {
  home: '/',
  // Pop-up / modal surfaces — route where each card appears (the modal itself
  // pops up on interaction, so the live-preview iframe shows the host page).
  onboarding: '/',
  'consent-banner': '/',
  'tx-receipt': '/dashboard',
  'connect-prompt': '/farm',
  'token-select': '/trade',
  'typed-confirm': '/admin',
  // Tradermigos pop-ups — the gallery is the host route for all three.
  'wallet-modal': '/nakamigos',
  'make-offer': '/nakamigos',
  'nft-detail': '/nakamigos',
  // Page surfaces that rendered art but weren't registered in the studio (audit
  // 2026-07-25): trust tools, the launch rail, contracts + treasury + solana swap.
  contracts: '/contracts',
  scanner: '/scan',
  deployer: '/deployer',
  'wallet-exposure': '/exposure',
  launch: '/launch',
  'launch-simulator': '/launch-simulator',
  airdrop: '/airdrop',
  vesting: '/vesting',
  'solana-launch': '/solana-launch',
  'curve-launch': '/curve-launch',
  swap: '/solana',
  treasury: '/treasury',
  'nav-logo': '/',
  'token-icon': '/trade',
  loader: '/',
  transition: '/',
  // ArtCard section backgrounds (NFT-Finance/AMM + launchpad flows).
  amm: '/nft-finance',
  'launchpad-collection': '/nft-finance',
  'launchpad-shared': '/nft-finance',
  'launchpad-owner': '/nft-finance',
  'launchpad-wizard': '/nft-finance',
  'launchpad-traits': '/nft-finance',
  dashboard: '/dashboard',
  farm: '/farm',
  'farm-stats': '/farm',
  'boost-schedule': '/farm',
  'lp-farming': '/farm',
  'live-pool': '/farm',
  'staking-card': '/farm',
  'upcoming-pools': '/farm',
  trade: '/swap',
  'liquidity-tab': '/liquidity',
  yield: '/yield',
  'nft-finance': '/nft-finance',
  'nft-lending': '/nft-finance',
  'lending-section': '/nft-finance',
  'launchpad-section': '/nft-finance',
  community: '/community',
  'vote-incentives': '/community',
  bounties: '/community',
  grants: '/community',
  'gauge-voting': '/community',
  tokenomics: '/tokenomics',
  lore: '/lore',
  changelog: '/changelog',
  'changelog-cards': '/changelog',
  leaderboard: '/leaderboard',
  premium: '/premium',
  history: '/history',
  security: '/security',
  risks: '/risks',
  terms: '/terms',
  privacy: '/privacy',
  faq: '/faq',
  admin: '/admin',
  'admin-dashboard': '/admin',
  'tegridy-score': '/dashboard',
  'referral-widget': '/dashboard',
  exposure: '/exposure',
  scan: '/scan',
  gallery: '/gallery',
  checkout: '/checkout',
  tax: '/tax',
  // pageId 'swap' is the Solana swap page; the EVM one is pageId 'trade'.
  // Modals render over any route; home is just somewhere to load.
  'nav-drawer': '/',
  seasonal: '/',
  'legacy-exit': '/farm',
  wizard: '/nft-finance',
};

const SURFACES: Surface[] = [
  // HomePage (15)
  { group: 'Home', pageId: 'home', idx: 0, label: 'H1 — Hero bg' },
  { group: 'Home', pageId: 'home', idx: 1, label: 'H2 — Core-loop bg' },
  { group: 'Home', pageId: 'home', idx: 2, label: 'H3 — Core-loop card 1' },
  { group: 'Home', pageId: 'home', idx: 3, label: 'H4 — Core-loop card 2' },
  { group: 'Home', pageId: 'home', idx: 4, label: 'H5 — Core-loop card 3' },
  { group: 'Home', pageId: 'home', idx: 5, label: 'H6 — Core-loop card 4' },
  { group: 'Home', pageId: 'home', idx: 6, label: 'H7 — Protocol: Swap' },
  { group: 'Home', pageId: 'home', idx: 7, label: 'H8 — Protocol: Farm' },
  { group: 'Home', pageId: 'home', idx: 8, label: 'H9 — Protocol: Dashboard' },
  { group: 'Home', pageId: 'home', idx: 9, label: 'H10 — How-it-works step 1' },
  { group: 'Home', pageId: 'home', idx: 10, label: 'H11 — How-it-works step 2' },
  { group: 'Home', pageId: 'home', idx: 11, label: 'H12 — How-it-works step 3' },
  { group: 'Home', pageId: 'home', idx: 12, label: 'H13 — Ecosystem: JBAC' },
  { group: 'Home', pageId: 'home', idx: 13, label: 'H14 — Ecosystem: $JBM' },
  { group: 'Home', pageId: 'home', idx: 14, label: 'H15 — Ecosystem: Story' },

  // Dashboard (14)
  { group: 'Dashboard', pageId: 'dashboard', idx: 0, label: 'D1 — BG disconnected' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 1, label: 'D2 — BG connected' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 2, label: 'D3 — Stat: TOWELI Balance' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 3, label: 'D4 — Stat: ETH Balance' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 4, label: 'D5 — Stat: Claimable' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 5, label: 'D6 — Stat: TOWELI Price' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 6, label: 'D7 — Tegridy Score block' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 7, label: 'D8 — ETH Revenue Claim' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 8, label: 'D9 — POL Accumulator' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 9, label: 'D10 — DCA Due Alerts' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 10, label: 'D11 — Active Limit Orders' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 11, label: 'D12 — Outstanding Loans' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 12, label: 'D13 — Position (has)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 13, label: 'D14 — Position (none)' },

  // Farm (3 page + sections)
  { group: 'Farm', pageId: 'farm', idx: 0, label: 'F1 — Page bg' },
  // Jungle Bay bungalow farm panel (renders at /farm in a non-default
  // bungalow; note bungalow pools bypass overrides, so these picks apply
  // only when viewed in the classic skin — registered for inventory parity).
  { group: 'Farm', pageId: 'bungalow-farm', idx: 0, label: 'BF1 — Pool status card' },
  { group: 'Farm', pageId: 'bungalow-farm', idx: 1, label: 'BF2 — Funding routes card' },
  { group: 'Farm', pageId: 'bungalow-farm', idx: 2, label: 'BF3 — Page bg' },
  { group: 'Home', pageId: 'bungalow-lore', idx: 0, label: 'BL1 — Bungalow lore card' },
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 0, label: 'BD1 — Page bg' },
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 1, label: 'BD2 — Wallet card' },
  { group: 'Farm', pageId: 'farm', idx: 1, label: 'F2 — Season banner' },
  { group: 'Farm', pageId: 'farm-stats', idx: 0, label: 'FS1 — TVL stat' },
  { group: 'Farm', pageId: 'farm-stats', idx: 1, label: 'FS2 — TOWELI price stat' },
  { group: 'Farm', pageId: 'farm-stats', idx: 2, label: 'FS3 — APR stat' },
  { group: 'Farm', pageId: 'farm-stats', idx: 3, label: 'FS4 — Season stat' },
  { group: 'Farm', pageId: 'boost-schedule', idx: 0, label: 'FB1 — Boost table bg' },
  { group: 'Farm', pageId: 'boost-schedule', idx: 1, label: 'FB2 — Early withdrawal' },
  { group: 'Farm', pageId: 'boost-schedule', idx: 2, label: 'FB3 — Auto-max lock' },
  { group: 'Farm', pageId: 'lp-farming', idx: 0, label: 'FL1 — LP coming-soon' },
  { group: 'Farm', pageId: 'lp-farming', idx: 1, label: 'FL2 — LP active' },
  { group: 'Farm', pageId: 'live-pool', idx: 0, label: 'FLP1 — Live pool card' },
  { group: 'Farm', pageId: 'staking-card', idx: 0, label: 'FSC1 — Staking form' },
  { group: 'Farm', pageId: 'upcoming-pools', idx: 0, label: 'UP1 — USDT/USDC' },
  { group: 'Farm', pageId: 'upcoming-pools', idx: 1, label: 'UP2 — ETH/WBTC' },
  { group: 'Farm', pageId: 'upcoming-pools', idx: 2, label: 'UP3 — DOT/ETH' },
  { group: 'Farm', pageId: 'upcoming-pools', idx: 3, label: 'UP4 — MANA/ETH' },

  // Trade (4)
  { group: 'Trade', pageId: 'trade', idx: 0, label: 'TR1 — Page bg' },
  { group: 'Trade', pageId: 'trade', idx: 1, label: 'TR2 — Swap tab' },
  { group: 'Trade', pageId: 'trade', idx: 2, label: 'TR3 — DCA tab' },
  { group: 'Trade', pageId: 'trade', idx: 3, label: 'TR4 — Limit Order tab' },
  { group: 'Trade', pageId: 'liquidity-tab', idx: 0, label: 'TRL1 — Liquidity header' },
  { group: 'Trade', pageId: 'liquidity-tab', idx: 1, label: 'TRL2 — Liquidity pool card' },
  { group: 'Trade', pageId: 'yield', idx: 0, label: 'YR1 — Yield routing backdrop' },

  // NFT Finance
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 0, label: 'NF1 — Page bg' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 1, label: 'NF2 — Token Lending intro' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 2, label: 'NF3 — NFT Lending intro' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 3, label: 'NF4 — NFT AMM intro' },
  { group: 'NFT Finance', pageId: 'nft-lending', idx: 0, label: 'NL1 — Total Offers stat' },
  { group: 'NFT Finance', pageId: 'nft-lending', idx: 1, label: 'NL2 — Active Loans stat' },
  { group: 'NFT Finance', pageId: 'nft-lending', idx: 2, label: 'NL3 — Protocol Fee stat' },
  { group: 'NFT Finance', pageId: 'nft-lending', idx: 3, label: 'NL4 — Collections stat' },
  { group: 'NFT Finance', pageId: 'nft-lending', idx: 4, label: 'NL5 — Empty borrow tab' },
  ...Array.from({ length: 15 }, (_, i): Surface => ({
    group: 'NFT Finance',
    pageId: 'lending-section',
    idx: i,
    label: `LS${i + 1} — Lending panel ${i + 1}`,
  })),
  { group: 'NFT Finance', pageId: 'launchpad-section', idx: 0, label: 'LP1 — Launchpad overview' },
  { group: 'NFT Finance', pageId: 'launchpad-section', idx: 1, label: 'LP2 — Launchpad featured' },
  { group: 'NFT Finance', pageId: 'launchpad-section', idx: 2, label: 'LP3 — Launchpad create pool' },

  // Community
  { group: 'Community', pageId: 'community', idx: 0, label: 'CP1 — Page bg' },
  { group: 'Community', pageId: 'community', idx: 1, label: 'CP2 — Connect wallet bg' },
  { group: 'Community', pageId: 'vote-incentives', idx: 0, label: 'CV1 — Vote stat 1' },
  { group: 'Community', pageId: 'vote-incentives', idx: 1, label: 'CV2 — Vote stat 2' },
  { group: 'Community', pageId: 'vote-incentives', idx: 2, label: 'CV3 — Vote stat 3' },
  { group: 'Community', pageId: 'vote-incentives', idx: 3, label: "CV4 — Cartman's Market" },
  { group: 'Community', pageId: 'bounties', idx: 0, label: 'CB1 — Bounty stat 1' },
  { group: 'Community', pageId: 'bounties', idx: 1, label: 'CB2 — Bounty stat 2' },
  { group: 'Community', pageId: 'bounties', idx: 2, label: 'CB3 — Bounty stat 3' },
  { group: 'Community', pageId: 'bounties', idx: 3, label: 'CB4 — Bounty stat 4' },
  { group: 'Community', pageId: 'bounties', idx: 4, label: 'CB5 — New bounty form' },
  { group: 'Community', pageId: 'bounties', idx: 5, label: 'CB6 — Active bounties list' },
  { group: 'Community', pageId: 'grants', idx: 0, label: 'CG1 — Total proposals' },
  { group: 'Community', pageId: 'grants', idx: 1, label: 'CG2 — Total granted' },
  { group: 'Community', pageId: 'grants', idx: 2, label: 'CG3 — Create form' },
  { group: 'Community', pageId: 'grants', idx: 3, label: 'CG4 — Proposals list' },
  { group: 'Community', pageId: 'gauge-voting', idx: 0, label: 'CGV1 — Gauge stat 1' },
  { group: 'Community', pageId: 'gauge-voting', idx: 1, label: 'CGV2 — Gauge stat 2' },
  { group: 'Community', pageId: 'gauge-voting', idx: 2, label: 'CGV3 — Gauge stat 3' },
  { group: 'Community', pageId: 'gauge-voting', idx: 3, label: 'CGV4 — Controller fallback' },
  { group: 'Community', pageId: 'gauge-voting', idx: 4, label: 'CGV5 — Wallet-connect fallback' },
  { group: 'Community', pageId: 'gauge-voting', idx: 5, label: 'CGV6 — Gauge weights list' },
  { group: 'Community', pageId: 'gauge-voting', idx: 6, label: 'CGV7 — Cast vote form' },

  // Tokenomics (9)
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 0, label: 'TK1 — Page bg' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 1, label: 'TK2 — Token stat' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 2, label: 'TK3 — Total Supply stat' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 3, label: 'TK4 — Price stat' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 4, label: 'TK5 — FDV stat' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 5, label: 'TK6 — Supply chart' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 6, label: 'TK7 — Emission schedule' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 7, label: 'TK8 — Community treasury' },
  { group: 'Tokenomics', pageId: 'tokenomics', idx: 8, label: 'TK9 — Contracts list' },

  // Lore (8)
  { group: 'Lore', pageId: 'lore', idx: 0, label: 'LO1 — Page bg' },
  ...Array.from({ length: 7 }, (_, i): Surface => ({
    group: 'Lore',
    pageId: 'lore',
    idx: i + 1,
    label: `LO${i + 2} — Phase ${i + 1} card`,
  })),

  // Changelog (17)
  { group: 'Changelog', pageId: 'changelog', idx: 0, label: 'CH1 — Page bg' },
  ...Array.from({ length: 16 }, (_, i): Surface => ({
    group: 'Changelog',
    pageId: 'changelog-cards',
    idx: i,
    label: `CHC${i + 1} — Changelog card ${i + 1}`,
  })),

  // Leaderboard (6)
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 0, label: 'LB1 — Page bg' },
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 1, label: 'LB2 — Your Stats' },
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 2, label: 'LB3 — Empty state' },
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 3, label: 'LB4 — How Points Work' },
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 4, label: 'LB5 — Tier Breakdown' },
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 5, label: 'LB6 — All Badges' },

  // Premium (3)
  { group: 'Premium', pageId: 'premium', idx: 0, label: 'PR1 — Page bg' },
  { group: 'Premium', pageId: 'premium', idx: 1, label: 'PR2 — Gold Card icon' },
  { group: 'Premium', pageId: 'premium', idx: 2, label: 'PR3 — JBAC NFT thumb' },

  // History (3)
  { group: 'History', pageId: 'history', idx: 0, label: 'HI1 — BG disconnected' },
  { group: 'History', pageId: 'history', idx: 1, label: 'HI2 — BG connected' },
  { group: 'History', pageId: 'history', idx: 2, label: 'HI3 — Transactions table' },

  // Security (22)
  { group: 'Security', pageId: 'security', idx: 0, label: 'SE1 — Page bg' },
  { group: 'Security', pageId: 'security', idx: 1, label: 'SE2 — Audit Methodology' },
  { group: 'Security', pageId: 'security', idx: 2, label: 'SE3 — Audit Artifacts' },
  ...Array.from({ length: 6 }, (_, i): Surface => ({
    group: 'Security',
    pageId: 'security',
    idx: 3 + i,
    label: `SE${4 + i} — Smart Contract Design ${i + 1}`,
  })),
  ...Array.from({ length: 6 }, (_, i): Surface => ({
    group: 'Security',
    pageId: 'security',
    idx: 9 + i,
    label: `SE${10 + i} — Contract Address ${i + 1}`,
  })),
  { group: 'Security', pageId: 'security', idx: 15, label: 'SE16 — Transparency' },
  { group: 'Security', pageId: 'security', idx: 16, label: 'SE17 — Bug Bounty header' },
  ...Array.from({ length: 4 }, (_, i): Surface => ({
    group: 'Security',
    pageId: 'security',
    idx: 17 + i,
    label: `SE${18 + i} — Severity tier ${i + 1}`,
  })),
  { group: 'Security', pageId: 'security', idx: 21, label: 'SE22 — Multisig & Governance' },

  // Single-bg pages
  { group: 'Misc pages', pageId: 'risks', idx: 0, label: 'R1 — Risks page bg' },
  { group: 'Misc pages', pageId: 'terms', idx: 0, label: 'TM1 — Terms page bg' },
  { group: 'Misc pages', pageId: 'privacy', idx: 0, label: 'PV1 — Privacy page bg' },
  { group: 'Misc pages', pageId: 'faq', idx: 0, label: 'FQ1 — FAQ page bg' },
  { group: 'Misc pages', pageId: 'admin', idx: 0, label: 'AD1 — Admin auth bg' },
  { group: 'Misc pages', pageId: 'admin-dashboard', idx: 0, label: 'AD2 — Admin dashboard bg' },

  // Misc widgets
  { group: 'Misc widgets', pageId: 'tegridy-score', idx: 0, label: 'TS1 — TegridyScore widget' },
  { group: 'Misc widgets', pageId: 'referral-widget', idx: 0, label: 'RW1 — Referral widget' },

  // Pop-up / modal cards — the surfaces that appear over other pages. Registered
  // here so every pop-up card is identifiable and adjustable in the studio.
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 0, label: 'PU1 — Onboarding slide 1 (Welcome)' },
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 1, label: 'PU2 — Onboarding slide 2 (How It Works)' },
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 2, label: 'PU3 — Onboarding slide 3 (Stay Safe)' },
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 3, label: 'PU4 — Onboarding slide 4 (First Move)' },
  { group: 'Pop-ups / Modals', pageId: 'consent-banner', idx: 0, label: 'PU5 — Privacy & telemetry banner' },
  { group: 'Pop-ups / Modals', pageId: 'tx-receipt',     idx: 0, label: 'PU6 — Transaction receipt' },
  { group: 'Pop-ups / Modals', pageId: 'connect-prompt', idx: 0, label: 'PU7 — Connect-wallet gate' },
  { group: 'Pop-ups / Modals', pageId: 'token-select',   idx: 0, label: 'PU8 — Token-select modal' },
  { group: 'Pop-ups / Modals', pageId: 'typed-confirm',  idx: 0, label: 'PU9 — Type-to-confirm (admin)' },
  // The three Tradermigos pop-ups. These rendered NO art at all until 2026-08-12
  // — they were never a regression, they were simply never wired, so the
  // "art on every popup" pass missed them (they live under src/nakamigos/, not
  // src/components/). `nft-detail` backs ONLY the details column; the image side
  // stays clean so the collection's own artwork remains the hero.
  { group: 'Pop-ups / Modals', pageId: 'wallet-modal',   idx: 0, label: 'PU10 — Connect-wallet modal (Tradermigos)' },
  { group: 'Pop-ups / Modals', pageId: 'make-offer',     idx: 0, label: 'PU11 — Make-offer modal (Tradermigos)' },
  { group: 'Pop-ups / Modals', pageId: 'nft-detail',     idx: 0, label: 'PU12 — NFT detail modal, details column' },

  // Page surfaces found rendering art but NOT registered in the studio (coverage
  // audit 2026-07-25: pageIds used by ArtImg/PageArtBackdrop vs the SURFACES list).
  { group: 'Trust tools',   pageId: 'scanner',          idx: 0, label: 'TT1 — Token Scanner backdrop' },
  { group: 'Trust tools',   pageId: 'deployer',         idx: 0, label: 'TT2 — Deployer Graph backdrop' },
  { group: 'Trust tools',   pageId: 'wallet-exposure',  idx: 0, label: 'TT3 — Wallet Exposure backdrop' },
  { group: 'Trust tools',   pageId: 'alerts',           idx: 0, label: 'TT4 — Alerts backdrop' },
  { group: 'Trust tools',   pageId: 'chart',            idx: 0, label: 'TT5 — Pro Charting backdrop' },
  { group: 'Engage',        pageId: 'referrals',        idx: 0, label: 'EN1 — Referrals backdrop' },
  { group: 'Engage',        pageId: 'copy-trading',     idx: 0, label: 'EN2 — Copy Trading backdrop' },
  { group: 'Engage',        pageId: 'competitions',     idx: 0, label: 'EN3 — Competitions backdrop' },
  { group: 'Engage',        pageId: 'checkout',         idx: 0, label: 'EN4 — Checkout backdrop' },
  { group: 'Stats',         pageId: 'tax',              idx: 0, label: 'ST1 — Tax Reports backdrop' },
  { group: 'Launch & Solana', pageId: 'launch',           idx: 0, label: 'LS1 — Launch rail backdrop' },
  { group: 'Launch & Solana', pageId: 'launch-simulator', idx: 0, label: 'LS2 — Launch Simulator backdrop' },
  { group: 'Launch & Solana', pageId: 'airdrop',           idx: 0, label: 'LS2d — Airdrop campaigns backdrop' },
  // idx 1 is the SOON placeholder art on the vesting rails, which is the only state
  // that page has until VestingFactory / LaunchLockView are deployed.
  { group: 'Launch & Solana', pageId: 'vesting',           idx: 0, label: 'LS2e — Vesting & Locks backdrop' },
  { group: 'Launch & Solana', pageId: 'vesting',           idx: 1, label: 'LS2f — Vesting rail SOON placeholder' },
  { group: 'Launch & Solana', pageId: 'launch-token',     idx: 0, label: 'LS2b — Token record backdrop' },
  { group: 'Launch & Solana', pageId: 'launch-token',     idx: 1, label: 'LS2c — Token record Fact Sheet strip' },
  { group: 'Launch & Solana', pageId: 'solana-launch',    idx: 0, label: 'LS3 — Solana Launch backdrop' },
  { group: 'Launch & Solana', pageId: 'curve-launch',     idx: 0, label: 'LS3b — Tegridy Curve backdrop' },
  { group: 'Launch & Solana', pageId: 'curve-launch',     idx: 1, label: 'LS3c — Tegridy Curve status banner' },
  { group: 'Launch & Solana', pageId: 'swap',             idx: 2, label: 'LS4 — Solana Swap surface' },
  { group: 'Contracts',     pageId: 'contracts',        idx: 0, label: 'CO1 — Contracts page bg' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 0, label: 'TR1 — Treasury page bg' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 5, label: 'TR2 — Treasury surface 5' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 6, label: 'TR3 — Treasury surface 6' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 7, label: 'TR4 — Treasury surface 7' },

  // ArtCard section backgrounds — moved from fixed ART.<piece> onto pageArt so the
  // studio can tune them too (coverage audit 2026-07-25).
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 0,  label: 'AMM art 1' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 1,  label: 'AMM art 2' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 2,  label: 'AMM art 3' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 3,  label: 'AMM art 4' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 4,  label: 'AMM art 5' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 5,  label: 'AMM art 6' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 6,  label: 'AMM art 7' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 7,  label: 'AMM art 8' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 8,  label: 'AMM art 9' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 9,  label: 'AMM art 10' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 10, label: 'AMM art 11' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 11, label: 'AMM art 12' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 12, label: 'AMM art 13' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 13, label: 'AMM art 14' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 14, label: 'AMM art 15' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 15, label: 'AMM art 16' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 16, label: 'AMM art 17' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 17, label: 'AMM art 18' },
  { group: 'ArtCard: NFT-Finance/AMM', pageId: 'amm', idx: 18, label: 'AMM art 19 (pool owner-view)' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-collection', idx: 0, label: 'Collection detail 1' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-collection', idx: 1, label: 'Collection detail 2' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-collection', idx: 2, label: 'Collection detail 3' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-shared', idx: 0, label: 'Launchpad shared 1' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-shared', idx: 1, label: 'Launchpad shared 2' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-owner', idx: 0, label: 'Owner admin panel' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-wizard', idx: 0, label: 'Create wizard' },
  { group: 'ArtCard: Launchpad', pageId: 'launchpad-traits', idx: 0, label: 'Trait editor' },
  // Chrome art — loader splash / page transitions / nav logo / token icon.
  { group: 'Chrome', pageId: 'nav-logo', idx: 0, label: 'Nav brand logo' },
  { group: 'Chrome', pageId: 'token-icon', idx: 0, label: 'TOWELI token icon' },
  { group: 'Loader splash', pageId: 'loader', idx: 0, label: 'Splash 1' },
  { group: 'Loader splash', pageId: 'loader', idx: 1, label: 'Splash 2' },
  { group: 'Loader splash', pageId: 'loader', idx: 2, label: 'Splash 3' },
  { group: 'Loader splash', pageId: 'loader', idx: 3, label: 'Splash 4' },
  { group: 'Loader splash', pageId: 'loader', idx: 4, label: 'Splash 5' },
  { group: 'Loader splash', pageId: 'loader', idx: 5, label: 'Splash 6' },
  { group: 'Loader splash', pageId: 'loader', idx: 6, label: 'Splash 7' },
  { group: 'Loader splash', pageId: 'loader', idx: 7, label: 'Splash 8' },
  { group: 'Loader splash', pageId: 'loader', idx: 8, label: 'Splash 9' },
  { group: 'Loader splash', pageId: 'loader', idx: 9, label: 'Splash 10' },
  { group: 'Loader splash', pageId: 'loader', idx: 10, label: 'Splash 11' },
  { group: 'Loader splash', pageId: 'loader', idx: 11, label: 'Splash 12' },
  { group: 'Loader splash', pageId: 'loader', idx: 12, label: 'Splash 13' },
  { group: 'Loader splash', pageId: 'loader', idx: 13, label: 'Splash 14' },
  { group: 'Loader splash', pageId: 'loader', idx: 14, label: 'Splash 15' },
  { group: 'Loader splash', pageId: 'loader', idx: 15, label: 'Splash 16' },
  { group: 'Loader splash', pageId: 'loader', idx: 16, label: 'Splash 17' },
  { group: 'Loader splash', pageId: 'loader', idx: 17, label: 'Splash 18' },
  { group: 'Loader splash', pageId: 'loader', idx: 18, label: 'Splash 19' },
  { group: 'Loader splash', pageId: 'loader', idx: 19, label: 'Splash 20' },
  { group: 'Loader splash', pageId: 'loader', idx: 20, label: 'Splash 21' },
  { group: 'Loader splash', pageId: 'loader', idx: 21, label: 'Splash 22' },
  { group: 'Loader splash', pageId: 'loader', idx: 22, label: 'Splash 23' },
  { group: 'Loader splash', pageId: 'loader', idx: 23, label: 'Splash 24' },
  { group: 'Loader splash', pageId: 'loader', idx: 24, label: 'Splash 25' },
  { group: 'Loader splash', pageId: 'loader', idx: 25, label: 'Splash 26' },
  { group: 'Loader splash', pageId: 'loader', idx: 26, label: 'Splash 27' },
  { group: 'Loader splash', pageId: 'loader', idx: 27, label: 'Splash 28' },
  { group: 'Loader splash', pageId: 'loader', idx: 28, label: 'Splash 29' },
  { group: 'Loader splash', pageId: 'loader', idx: 29, label: 'Splash 30' },
  { group: 'Loader splash', pageId: 'loader', idx: 30, label: 'Splash 31' },
  { group: 'Loader splash', pageId: 'loader', idx: 31, label: 'Splash 32' },
  { group: 'Loader splash', pageId: 'loader', idx: 32, label: 'Splash 33' },
  { group: 'Loader splash', pageId: 'loader', idx: 33, label: 'Splash 34' },
  { group: 'Loader splash', pageId: 'loader', idx: 34, label: 'Splash 35' },
  { group: 'Loader splash', pageId: 'loader', idx: 35, label: 'Splash 36' },
  { group: 'Loader splash', pageId: 'loader', idx: 36, label: 'Splash 37' },
  { group: 'Loader splash', pageId: 'loader', idx: 37, label: 'Splash 38' },
  { group: 'Loader splash', pageId: 'loader', idx: 38, label: 'Splash 39' },
  { group: 'Loader splash', pageId: 'loader', idx: 39, label: 'Splash 40' },
  { group: 'Page transition', pageId: 'transition', idx: 0, label: 'Transition frame 1' },
  { group: 'Page transition', pageId: 'transition', idx: 1, label: 'Transition frame 2' },
  { group: 'Page transition', pageId: 'transition', idx: 2, label: 'Transition frame 3' },
  { group: 'Page transition', pageId: 'transition', idx: 3, label: 'Transition frame 4' },
  { group: 'Page transition', pageId: 'transition', idx: 4, label: 'Transition frame 5' },
  { group: 'Page transition', pageId: 'transition', idx: 5, label: 'Transition frame 6' },
  { group: 'Page transition', pageId: 'transition', idx: 6, label: 'Transition frame 7' },
  { group: 'Page transition', pageId: 'transition', idx: 7, label: 'Transition frame 8' },
  { group: 'Page transition', pageId: 'transition', idx: 8, label: 'Transition frame 9' },
  { group: 'Page transition', pageId: 'transition', idx: 9, label: 'Transition frame 10' },
  { group: 'Page transition', pageId: 'transition', idx: 10, label: 'Transition frame 11' },
  { group: 'Page transition', pageId: 'transition', idx: 11, label: 'Transition frame 12' },
  { group: 'Page transition', pageId: 'transition', idx: 12, label: 'Transition frame 13' },
  { group: 'Page transition', pageId: 'transition', idx: 13, label: 'Transition frame 14' },
  { group: 'Page transition', pageId: 'transition', idx: 14, label: 'Transition frame 15' },
  { group: 'Page transition', pageId: 'transition', idx: 15, label: 'Transition frame 16' },
  { group: 'Page transition', pageId: 'transition', idx: 16, label: 'Transition frame 17' },
  { group: 'Page transition', pageId: 'transition', idx: 17, label: 'Transition frame 18' },
  { group: 'Page transition', pageId: 'transition', idx: 18, label: 'Transition frame 19' },
  { group: 'Page transition', pageId: 'transition', idx: 19, label: 'Transition frame 20' },
  { group: 'Page transition', pageId: 'transition', idx: 20, label: 'Transition frame 21' },
  { group: 'Page transition', pageId: 'transition', idx: 21, label: 'Transition frame 22' },
  { group: 'Page transition', pageId: 'transition', idx: 22, label: 'Transition frame 23' },
  { group: 'Page transition', pageId: 'transition', idx: 23, label: 'Transition frame 24' },
  { group: 'Page transition', pageId: 'transition', idx: 24, label: 'Transition frame 25' },
  { group: 'Page transition', pageId: 'transition', idx: 25, label: 'Transition frame 26' },
  { group: 'Page transition', pageId: 'transition', idx: 26, label: 'Transition frame 27' },
  { group: 'Page transition', pageId: 'transition', idx: 27, label: 'Transition frame 28' },
  { group: 'Page transition', pageId: 'transition', idx: 28, label: 'Transition frame 29' },
  { group: 'Page transition', pageId: 'transition', idx: 29, label: 'Transition frame 30' },
  { group: 'Page transition', pageId: 'transition', idx: 30, label: 'Transition frame 31' },
  { group: 'Page transition', pageId: 'transition', idx: 31, label: 'Transition frame 32' },
  { group: 'Page transition', pageId: 'transition', idx: 32, label: 'Transition frame 33' },
  { group: 'Page transition', pageId: 'transition', idx: 33, label: 'Transition frame 34' },
  { group: 'Page transition', pageId: 'transition', idx: 34, label: 'Transition frame 35' },
  { group: 'Page transition', pageId: 'transition', idx: 35, label: 'Transition frame 36' },
  { group: 'Page transition', pageId: 'transition', idx: 36, label: 'Transition frame 37' },
  { group: 'Page transition', pageId: 'transition', idx: 37, label: 'Transition frame 38' },
  { group: 'Page transition', pageId: 'transition', idx: 38, label: 'Transition frame 39' },
  // ───────────────────────────────────────────────────────────────────────────
  // 2026-07-30 backfill. This inventory is hand-maintained, and 53 live art
  // surfaces had accumulated in the app without ever being listed here — they
  // rendered rotation art with no way to override it from the studio.
  // ───────────────────────────────────────────────────────────────────────────

  { group: 'NFT Finance', pageId: 'nft-finance', idx: 4, label: 'NF5 — Feature: Launchpad' },

  // Deployer page (/deployer)
  { group: 'Deployer', pageId: 'deployer', idx: 4, label: 'DP1 — Search / address input' },
  { group: 'Deployer', pageId: 'deployer', idx: 5, label: "DP2 — What this can and can't tell you" },
  { group: 'Deployer', pageId: 'deployer', idx: 3, label: 'DP4 — Empty: no direct deploys' },
  { group: 'Deployer', pageId: 'deployer', idx: 1, label: 'DP5 — Deployed contracts list' },
  { group: 'Deployer', pageId: 'deployer', idx: 2, label: 'DP6 — Related wallets' },

  // Launch simulator (/launch-simulator)
  { group: 'Launch sim', pageId: 'launch-simulator', idx: 4, label: 'LX1 — Projected fact sheet' },
  { group: 'Launch sim', pageId: 'launch-simulator', idx: 1, label: 'LX3 — Contract template' },
  { group: 'Launch sim', pageId: 'launch-simulator', idx: 2, label: 'LX4 — Empty: nothing to measure' },
  { group: 'Launch sim', pageId: 'launch-simulator', idx: 3, label: 'LX5 — Distribution report' },
  { group: 'Launch sim', pageId: 'launch-simulator', idx: 5, label: 'LX6 — How the score is built' },

  // Scanner (/scan)
  { group: 'Scanner', pageId: 'scan', idx: 0, label: 'SC1 — Token address input' },
  { group: 'Scanner', pageId: 'scan', idx: 3, label: 'SC2 — Gated: not enabled yet' },
  { group: 'Scanner', pageId: 'scan', idx: 1, label: "SC3 — What you'll get" },
  { group: 'Scanner', pageId: 'scan', idx: 2, label: 'SC4 — Scan result card' },

  // Treasury (/treasury)

  // Wallet exposure (/exposure)
  { group: 'Exposure', pageId: 'exposure', idx: 0, label: 'EX1 — Custom token check' },
  { group: 'Exposure', pageId: 'exposure', idx: 1, label: 'EX2 — Balances panel' },
  { group: 'Exposure', pageId: 'exposure', idx: 2, label: 'EX3 — Empty: no balances' },

  // Solana surfaces

  // Launcher (/launch)
  { group: 'Launcher', pageId: 'launch', idx: 40, label: 'LA1 — Afterlife panel' },
  { group: 'Launcher', pageId: 'launch', idx: 41, label: 'LA2 — Afterlife stat card' },
  { group: 'Launcher', pageId: 'launch', idx: 42, label: 'LA3 — Explorer empty state' },

  // Gated "not deployed yet" walls — these render whenever a feature flag is
  // off, so they are the first thing a visitor sees on those routes.
  { group: 'Gated walls', pageId: 'community', idx: 2, label: 'GW1 — Bounty board not live' },
  { group: 'Gated walls', pageId: 'community', idx: 3, label: 'GW2 — Vote incentives not live' },
  { group: 'Gated walls', pageId: 'community', idx: 4, label: 'GW3 — Gauge voting not live' },
  { group: 'Gated walls', pageId: 'community', idx: 5, label: 'GW4 — Launch rail not live (on /launch)' },

  // Popups / overlays. These are global — they render over whatever route you
  // happen to be on, so the Live-page preview can't scroll to them (it will
  // report "not found"). Use the Art tab to place them.
  { group: 'Popups', pageId: 'nav-drawer', idx: 0, label: 'MO3 — Mobile nav drawer' },
  { group: 'Popups', pageId: 'seasonal', idx: 0, label: 'MO5 — Seasonal event banner' },
  { group: 'Popups', pageId: 'legacy-exit', idx: 0, label: 'MO6 — Legacy staking notice' },

  // Launchpad wizard (gated) — the last cards in the app that had no art at all.
  { group: 'Launchpad wizard', pageId: 'wizard', idx: 0, label: 'WZ1 — Arweave upload cost' },
  { group: 'Launchpad wizard', pageId: 'wizard', idx: 1, label: 'WZ2 — Upload progress' },
  { group: 'Launchpad wizard', pageId: 'wizard', idx: 2, label: 'WZ3 — Review before deploy' },

  // Stragglers on pages already covered above
  { group: 'Dashboard', pageId: 'dashboard', idx: 14, label: 'D15 — Your Liquidity' },
  { group: 'Misc pages', pageId: 'gallery', idx: 0, label: 'GA1 — Gallery empty state' },
];

const ART_LIST: ArtPiece[] = Object.values(ART);

const STORAGE_KEY = 'art-studio:draft';
const surfaceKey = (s: Pick<Surface, 'pageId' | 'idx'>) => `${s.pageId}:${s.idx}`;

// Parse "X% Y%" or "center 30%" into [x, y] percent (0-100). Returns
// [50, 50] for unrecognized strings so the sliders have a sensible default.
function parsePosition(pos?: string): [number, number] {
  if (!pos) return [50, 50];
  const tokens = pos.trim().split(/\s+/);
  const toPct = (t: string | undefined): number => {
    if (!t) return 50;
    if (t === 'center') return 50;
    if (t === 'left' || t === 'top') return 0;
    if (t === 'right' || t === 'bottom') return 100;
    const m = t.match(/^(-?[\d.]+)%$/);
    return m ? Math.max(0, Math.min(100, parseFloat(m[1]!))) : 50;
  };
  return [toPct(tokens[0]), toPct(tokens[1])];
}
const formatPosition = (x: number, y: number) => `${x}% ${y}%`;

export default function ArtStudioPage() {
  const [overrides, setOverrides] = useState<Record<string, ArtOverride>>(() => {
    try {
      const draft = localStorage.getItem(STORAGE_KEY);
      if (draft) return { ...ART_OVERRIDES, ...JSON.parse(draft) };
    } catch {/* ignore */}
    return { ...ART_OVERRIDES };
  });
  const [selectedKey, setSelectedKey] = useState<string>(surfaceKey(SURFACES[0]!));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [filterGroup, setFilterGroup] = useState<string>('All');
  const [previewMode, setPreviewMode] = useState<'art' | 'live'>('art');
  // Blows the preview up to the whole window so the crop can actually be
  // judged — a 45vh strip is too small to place art precisely.
  const [zen, setZen] = useState(false);
  // Bumped after each successful save → iframe key changes → forces reload
  // so the live preview reflects what just got written to disk.
  const [iframeNonce, setIframeNonce] = useState(0);
  const [autoSave, setAutoSave] = useState(true);

  // Esc leaves fullscreen. Locking body scroll also drops the page's scrollbar
  // gutter, which otherwise shows a sliver of the grid under the overlay.
  useEffect(() => {
    if (!zen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZen(false); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [zen]);

  // Skip the AppLoader splash inside iframes (it gates on sessionStorage).
  // Same-origin iframes share sessionStorage with this top-level window.
  useEffect(() => {
    try { sessionStorage.setItem('tf_loaded', '1'); } catch {/* ignore */}
  }, []);

  // Persist drafts to localStorage on every change so a refresh doesn't lose work.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {/* ignore */}
  }, [overrides]);

  // Debounced auto-save: any state change (art pick OR position slider drag)
  // is committed to disk 350ms after activity stops. Skips the initial mount.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!autoSave) return;
    if (!didMountRef.current) { didMountRef.current = true; return; }
    const t = setTimeout(() => { void saveToDisk(overrides, true); }, 350);
    return () => clearTimeout(t);
  }, [overrides, autoSave]);

  const selected = useMemo(
    () => SURFACES.find((s) => surfaceKey(s) === selectedKey) ?? SURFACES[0]!,
    [selectedKey],
  );
  const selectedOverride = overrides[selectedKey];
  const currentArt = pageArtWith(overrides, selected.pageId, selected.idx);
  const [posX, posY] = parsePosition(selectedOverride?.objectPosition ?? currentArt.objectPosition);
  const currentScale = selectedOverride?.scale ?? currentArt.scale ?? 1;

  const groups = useMemo(() => {
    const set = new Set<string>(['All']);
    SURFACES.forEach((s) => set.add(s.group));
    return Array.from(set);
  }, []);
  const visibleSurfaces = useMemo(
    () => filterGroup === 'All' ? SURFACES : SURFACES.filter((s) => s.group === filterGroup),
    [filterGroup],
  );

  // Functional updater so concurrent slider/pick changes merge against the
  // latest state, not a closure-captured snapshot.
  const updateOverride = useCallback((key: string, fn: (prev: ArtOverride | undefined) => ArtOverride | null) => {
    setOverrides((prevOverrides) => {
      const next = fn(prevOverrides[key]);
      if (next === null) {
        const { [key]: _removed, ...rest } = prevOverrides;
        return rest;
      }
      return { ...prevOverrides, [key]: next };
    });
  }, []);

  const fallbackArtId = currentArt.id;

  const pickArt = (artId: string) => {
    updateOverride(selectedKey, (prev) => ({ ...(prev ?? {}), artId }));
  };

  const setPosition = (x: number, y: number) => {
    updateOverride(selectedKey, (prev) => ({
      ...(prev ?? {}),
      artId: prev?.artId ?? fallbackArtId,
      objectPosition: formatPosition(x, y),
    }));
  };

  const setScale = (scale: number) => {
    updateOverride(selectedKey, (prev) => {
      const next: ArtOverride = { ...(prev ?? {}), artId: prev?.artId ?? fallbackArtId };
      if (scale !== 1) next.scale = scale;
      else delete next.scale;
      return next;
    });
  };

  const clearOverride = () => updateOverride(selectedKey, () => null);

  const resetAll = () => {
    if (!confirm('Clear ALL overrides (in-progress drafts and saved picks)? This does not write to disk until you click Save.')) return;
    setOverrides({});
  };

  const saveToDisk = useCallback(async (data: Record<string, ArtOverride>, silent: boolean): Promise<void> => {
    if (!silent) setSaving(true);
    if (!silent) setSaveMsg(null);
    try {
      const res = await fetch('/__art-studio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { ok: boolean; count: number };
      if (!silent) {
        setSaveMsg(`Saved ${json.count} overrides to src/lib/artOverrides.ts`);
        try { localStorage.removeItem(STORAGE_KEY); } catch {/* ignore */}
      }
      setIframeNonce((n) => n + 1);
    } catch (err) {
      setSaveMsg(`Save failed: ${(err as Error).message}`);
    } finally {
      if (!silent) setSaving(false);
    }
  }, []);

  const save = () => saveToDisk(overrides, false);

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="min-h-screen bg-[#060c1a] text-white relative z-10">
      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur bg-black/60 border-b border-white/10 px-4 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Art Studio</h1>
        <span className="text-xs text-white/60">{overrideCount} override{overrideCount === 1 ? '' : 's'} · {SURFACES.length} surfaces · {ART_LIST.length} pieces</span>
        <label className="text-[11px] text-white/60 flex items-center gap-1 cursor-pointer select-none" title="When on, picking art saves to disk immediately so the Live page reloads.">
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => setAutoSave(e.target.checked)}
            className="accent-emerald-500"
          />
          Auto-save picks
        </label>
        <div className="flex-1" />
        {saveMsg && <span className="text-xs text-emerald-300">{saveMsg}</span>}
        <button
          onClick={resetAll}
          className="text-xs px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10"
        >Reset all</button>
        <button
          onClick={save}
          disabled={saving}
          className="text-xs px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-semibold"
        >{saving ? 'Saving…' : 'Save to disk'}</button>
      </header>

      {/* Main split */}
      <div className="flex flex-col lg:flex-row gap-4 p-4">
        {/* Left: surface list */}
        <aside className="lg:w-[360px] flex-shrink-0 bg-white/5 rounded-lg border border-white/10 max-h-[calc(100vh-100px)] overflow-y-auto lg:sticky lg:top-[60px] lg:self-start">
          <div className="sticky top-0 bg-[#0a1424] p-2 border-b border-white/10 z-10">
            <select
              value={filterGroup}
              onChange={(e) => setFilterGroup(e.target.value)}
              // colorScheme:dark makes the browser render the native option popup
              // dark (was light text on the default white popup = unreadable); the
              // per-option colors are an explicit fallback for browsers that ignore it.
              style={{ colorScheme: 'dark' }}
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
            >
              {groups.map((g) => (
                <option key={g} value={g} style={{ backgroundColor: '#0f1524', color: '#e5e7eb' }}>{g}</option>
              ))}
            </select>
          </div>
          {Object.entries(groupBy(visibleSurfaces, (s) => s.group)).map(([group, surfaces]) => (
            <div key={group}>
              <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-white/50 font-semibold">{group}</div>
              {surfaces.map((s) => {
                const key = surfaceKey(s);
                const isSel = key === selectedKey;
                const overridden = !!overrides[key];
                const art = pageArtWith(overrides, s.pageId, s.idx);
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedKey(key)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/5 ${isSel ? 'bg-emerald-900/40 border-l-2 border-emerald-400' : ''}`}
                  >
                    <img src={art.src} alt="" loading="lazy" className="w-8 h-8 object-cover rounded flex-shrink-0" />
                    <span className="flex-1 truncate">{s.label}</span>
                    {overridden && <span className="text-[9px] text-emerald-400">●</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        {/* Right: editor */}
        <main className="flex-1 min-w-0 space-y-4">
          {/* Preview */}
          <section
            className={
              zen
                // h-[100dvh] rather than inset-0's implied height: the initial
                // containing block is short by the scrollbar gutter, which left
                // a sliver of the picker grid showing under the overlay.
                ? 'fixed inset-0 h-[100dvh] z-50 bg-[#060c1a] flex flex-col overflow-hidden'
                : 'bg-white/5 rounded-lg border border-white/10 overflow-hidden'
            }
          >
            <div className="px-4 py-2 border-b border-white/10 flex items-center gap-3 flex-wrap flex-shrink-0">
              <span className="text-xs font-semibold">{selected.label}</span>
              <code className="text-[10px] text-white/50">pageArt('{selected.pageId}', {selected.idx})</code>
              <div className="flex-1" />
              {/* Mode tabs */}
              <div className="flex rounded border border-white/10 overflow-hidden text-[11px]">
                <button
                  onClick={() => setPreviewMode('art')}
                  className={`px-2.5 py-1 ${previewMode === 'art' ? 'bg-emerald-700/60 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`}
                >🎨 Art</button>
                <button
                  onClick={() => setPreviewMode('live')}
                  className={`px-2.5 py-1 border-l border-white/10 ${previewMode === 'live' ? 'bg-emerald-700/60 text-white' : 'bg-white/5 text-white/60 hover:text-white'}`}
                  title={PAGE_ROUTES[selected.pageId] ? `Loads ${PAGE_ROUTES[selected.pageId]}` : 'No route mapping for this pageId'}
                >📱 Live page</button>
              </div>
              <span className="text-[10px] text-white/40">{currentArt.title}</span>
              <button
                onClick={() => setZen((z) => !z)}
                title={zen ? 'Exit fullscreen (Esc)' : 'Fill the window — for precise crop placement'}
                className="text-[10px] px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10"
              >{zen ? '⤡ Exit fullscreen' : '⛶ Fullscreen'}</button>
              {selectedOverride && (
                <button
                  onClick={clearOverride}
                  className="text-[10px] px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 border border-red-500/30"
                >Clear override</button>
              )}
            </div>

            {previewMode === 'art' ? (
              <>
                <div
                  className={
                    zen
                      ? 'flex-1 min-h-0 bg-black relative overflow-hidden'
                      : 'h-[62vh] min-h-[320px] bg-black relative overflow-hidden'
                  }
                >
                  <img
                    src={currentArt.src}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                    style={{
                      objectPosition: formatPosition(posX, posY),
                      transform: currentScale !== 1 ? `scale(${currentScale})` : undefined,
                      transformOrigin: currentScale !== 1 ? formatPosition(posX, posY) : undefined,
                    }}
                  />
                  {/* Crosshair */}
                  <div
                    className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 border-2 border-white/80 rounded-full pointer-events-none mix-blend-difference"
                    style={{ left: `${posX}%`, top: `${posY}%` }}
                  />
                </div>
                {/* Position sliders */}
                <div className={`p-4 space-y-2 flex-shrink-0 ${zen ? 'border-t border-white/10 bg-black/40' : ''}`}>
                  <div className="flex items-center gap-3 text-xs">
                    <label className="w-12 text-white/60">X</label>
                    <input
                      type="range" min={0} max={100} value={posX}
                      onChange={(e) => setPosition(parseInt(e.target.value, 10), posY)}
                      className="flex-1"
                    />
                    <span className="w-12 text-right tabular-nums">{posX}%</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <label className="w-12 text-white/60">Y</label>
                    <input
                      type="range" min={0} max={100} value={posY}
                      onChange={(e) => setPosition(posX, parseInt(e.target.value, 10))}
                      className="flex-1"
                    />
                    <span className="w-12 text-right tabular-nums">{posY}%</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <label className="w-12 text-white/60" title="Zoom in to free up X/Y panning. With cover, panning only works in the axis where the image overflows the container — zoom > 1 gives both axes overflow.">Zoom</label>
                    <input
                      type="range" min={100} max={300} step={5} value={Math.round(currentScale * 100)}
                      onChange={(e) => setScale(parseInt(e.target.value, 10) / 100)}
                      className="flex-1"
                    />
                    <span className="w-12 text-right tabular-nums">{currentScale.toFixed(2)}x</span>
                  </div>
                  <p className="text-[10px] text-white/40 italic">
                    X panning only moves when image overflows container — bump <strong>Zoom</strong> above 1.0x to free both axes. Auto-saves to disk.
                  </p>
                </div>
              </>
            ) : (
              <LivePreview
                pageId={selected.pageId}
                surfaceKey={surfaceKey(selected)}
                artSrc={currentArt.src}
                nonce={iframeNonce}
              />
            )}
          </section>

          {/* Art picker grid */}
          <section className="bg-white/5 rounded-lg border border-white/10">
            <div className="px-4 py-2 border-b border-white/10 text-xs font-semibold">
              Pick art ({ART_LIST.length} pieces)
            </div>
            <div className="p-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
              {ART_LIST.map((piece) => {
                const isPicked = (selectedOverride?.artId ?? currentArt.id) === piece.id;
                return (
                  <button
                    key={piece.id}
                    onClick={() => pickArt(piece.id)}
                    title={`${piece.title} (${piece.id})`}
                    className={`relative aspect-square overflow-hidden rounded border-2 transition ${isPicked ? 'border-emerald-400 ring-2 ring-emerald-400/40' : 'border-white/10 hover:border-white/40'}`}
                  >
                    <img src={piece.src} alt={piece.title} loading="lazy" className="w-full h-full object-cover" />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1">
                      <div className="text-[9px] truncate text-white/90">{piece.id}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

// Viewport presets for the live preview. The iframe is rendered at these exact
// pixel dimensions and then CSS-scaled down to fit the studio pane, so the page
// lays out like a real device instead of like a short, squashed panel.
type PreviewDevice = { id: string; label: string; w: number; h: number };
const PREVIEW_DEVICES: PreviewDevice[] = [
  { id: 'desktop', label: 'Desktop', w: 1440, h: 900 },
  { id: 'ipad', label: 'iPad', w: 820, h: 1180 },
  { id: 'iphone', label: 'iPhone', w: 390, h: 844 },
];

// In-context preview — iframes the actual app route where the surface lives.
// Reflects what's currently saved to disk (drafts apply only after Save).
function LivePreview({ pageId, surfaceKey: key, artSrc, nonce }: {
  pageId: string;
  surfaceKey: string;
  artSrc: string;
  nonce: number;
}) {
  const route = PAGE_ROUTES[pageId];
  const [deviceId, setDeviceId] = useState('desktop');
  const [located, setLocated] = useState<'pending' | 'exact' | 'byArt' | 'missing'>('pending');
  const [fullPage, setFullPage] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Measured scrollHeight of the iframe's document — drives "Full page" height.
  const [docH, setDocH] = useState(0);
  const [paneW, setPaneW] = useState(0);
  const [maxH, setMaxH] = useState(() =>
    typeof window === 'undefined' ? 600 : Math.max(320, Math.round(window.innerHeight * 0.72)),
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Latest render's fit-scale, read by focusSurface without making it a dep.
  const scaleRef = useRef(1);

  const device = PREVIEW_DEVICES.find((d) => d.id === deviceId) ?? PREVIEW_DEVICES[0]!;

  // Track how much width the pane actually has, plus a sane max height that
  // follows the window (a short window gets a short — but still fitted — pane).
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPaneW(entry!.contentRect.width));
    ro.observe(el);
    setPaneW(el.clientWidth);
    const onResize = () => setMaxH(Math.max(320, Math.round(window.innerHeight * 0.72)));
    window.addEventListener('resize', onResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onResize); };
  }, []);

  // Same-origin iframe → we can read the real document height and grow the
  // frame to it, so "Full page" genuinely shows the whole route.
  const measureDoc = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.documentElement) setDocH(doc.documentElement.scrollHeight);
  }, []);

  // Measure ONLY while the frame is at the device viewport height. In full-page
  // mode the frame's height *is* docH, so any section sized to 100vh grows with
  // it — re-measuring there feeds back on itself and the page inflates without
  // bound (scale collapses to ~1%). So we freeze the last viewport-mode value.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || fullPage) return;
    let ro: ResizeObserver | undefined;
    const onLoad = () => {
      measureDoc();
      const el = frame.contentDocument?.documentElement;
      if (el) { ro = new ResizeObserver(measureDoc); ro.observe(el); }
    };
    frame.addEventListener('load', onLoad);
    if (frame.contentDocument?.readyState === 'complete') onLoad();
    return () => { frame.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, [measureDoc, fullPage, route, nonce, reloadNonce, deviceId]);

  // Jump the preview to the surface being edited. ArtImg stamps every surface
  // with data-art-surface="pageId:idx"; surfaces rendered through components
  // that take a resolved ArtPiece (not pageId/idx) have no stamp, so we fall
  // back to matching the image file — same picture, right spot on the page.
  const focusSurface = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return false;

    doc.querySelectorAll<HTMLElement>('[data-studio-focus]').forEach((prev) => {
      prev.removeAttribute('data-studio-focus');
      prev.style.outline = '';
      prev.style.outlineOffset = '';
    });

    let hit = doc.querySelector<HTMLElement>(`[data-art-surface="${key}"]`);
    let how: 'exact' | 'byArt' = 'exact';
    if (!hit) {
      const file = artSrc.split('/').pop();
      if (file) {
        hit = [...doc.querySelectorAll<HTMLImageElement>('img')]
          .find((img) => (img.getAttribute('src') ?? '').endsWith(file)) ?? null;
        how = 'byArt';
      }
    }
    if (!hit) { setLocated('missing'); return false; }

    // Outline the card, not the bare <img> — the image is usually a full-bleed
    // background inside the thing you actually recognise on the page.
    const target = (hit.closest<HTMLElement>('[class*="rounded"], section') ?? hit);
    target.setAttribute('data-studio-focus', '');
    target.style.outline = '3px solid #34d399';
    target.style.outlineOffset = '2px';
    hit.scrollIntoView({ block: 'center', inline: 'center' });

    // Full-page mode gives the frame the document's own height, so nothing
    // scrolls inside it — the outer pane has to do the scrolling instead.
    const pane = paneRef.current;
    if (pane) {
      const top = hit.getBoundingClientRect().top + (doc.defaultView?.scrollY ?? 0);
      pane.scrollTop = Math.max(0, top * scaleRef.current - pane.clientHeight / 2);
    }
    setLocated(how);
    return true;
  }, [key, artSrc]);

  // Content streams in (lazy images, async data), so retry a few times rather
  // than trusting a single post-load query.
  useEffect(() => {
    setLocated('pending');
    const timers = [80, 400, 1200, 2500].map((ms) => window.setTimeout(focusSurface, ms));
    return () => timers.forEach(window.clearTimeout);
  }, [focusSurface, route, nonce, reloadNonce, deviceId, fullPage]);

  // Hard ceiling on the full-page height so a runaway measurement can never
  // shrink the preview into an unusable sliver.
  const frameH = fullPage && docH > 0 ? Math.min(docH, device.h * 8) : device.h;
  // Fit to WIDTH, never upscale — shrinking the whole page to fit the pane's
  // height too would render it as an unreadable thumbnail, so the pane scrolls
  // through the full-page frame instead.
  const fitW = paneW > 0 ? paneW / device.w : 1;
  const scale = Math.max(0.15, Math.min(1, fitW) || 1);
  const scaledH = Math.round(frameH * scale);

  useEffect(() => { scaleRef.current = scale; }, [scale]);

  if (!route) {
    return (
      <div className="h-[55vh] flex items-center justify-center text-xs text-white/50 p-4 text-center">
        No route mapping for <code className="mx-1 px-1 bg-white/10 rounded">{pageId}</code> yet.
        Add it to <code className="mx-1 px-1 bg-white/10 rounded">PAGE_ROUTES</code> in ArtStudioPage.tsx.
      </div>
    );
  }

  // Cache-bust the iframe URL on each save so it reloads with fresh overrides.
  const url = `${route}?_studio=${nonce}-${reloadNonce}`;

  return (
    <div className="bg-black relative">
      <div className="px-3 py-1.5 border-b border-white/10 flex items-center gap-2 text-[10px] text-white/60 flex-wrap">
        <span>{route}</span>
        <span className="text-white/30">·</span>
        <span>Save your pick to see it land here</span>

        <div className="flex rounded border border-white/10 overflow-hidden ml-2">
          {PREVIEW_DEVICES.map((d) => (
            <button
              key={d.id}
              onClick={() => setDeviceId(d.id)}
              title={`${d.w}×${d.h}`}
              className={`px-2 py-0.5 ${d.id !== PREVIEW_DEVICES[0]!.id ? 'border-l border-white/10' : ''} ${
                deviceId === d.id ? 'bg-emerald-700/60 text-white' : 'bg-white/5 hover:text-white'
              }`}
            >{d.label}</button>
          ))}
        </div>

        <label
          className="flex items-center gap-1 cursor-pointer select-none"
          title="Grow the frame to the page's real scroll height and shrink it to fit — the whole route at once. Note: sections sized to 100vh stretch with it."
        >
          <input
            type="checkbox"
            checked={fullPage}
            onChange={(e) => setFullPage(e.target.checked)}
            className="accent-emerald-500"
          />
          Full page
        </label>

        <span className="tabular-nums text-white/40">{Math.round(scale * 100)}%</span>

        <span
          className={
            located === 'exact' ? 'text-emerald-400'
              : located === 'byArt' ? 'text-amber-400'
                : located === 'missing' ? 'text-red-400' : 'text-white/40'
          }
          title={
            located === 'exact' ? 'Scrolled to this exact surface and outlined it'
              : located === 'byArt' ? 'This surface has no data-art-surface stamp — matched by art file instead, so it may land on another card using the same piece'
                : located === 'missing' ? 'Not on the rendered page — it may be behind a wallet connection, a tab, or a feature flag'
                  : 'Looking for this surface…'
          }
        >
          {located === 'exact' ? '◎ located'
            : located === 'byArt' ? '◎ matched by art'
              : located === 'missing' ? '◎ not found' : '◎ …'}
        </span>

        <button
          onClick={() => focusSurface()}
          className="px-2 py-0.5 rounded bg-white/5 border border-white/10 hover:text-white"
        >Jump to it</button>

        <button
          onClick={() => setReloadNonce((n) => n + 1)}
          className="px-2 py-0.5 rounded bg-white/5 border border-white/10 hover:text-white"
        >Reload</button>

        <a
          href={route}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-emerald-400 hover:underline"
        >Open in new tab ↗</a>
      </div>

      {/* Outer pane scrolls; inner box reserves the *scaled* footprint so the
          scrollbars match what you actually see. */}
      <div
        ref={paneRef}
        className="overflow-auto bg-black"
        style={{ height: Math.min(scaledH, maxH) }}
      >
        <div
          style={{
            width: Math.round(device.w * scale),
            height: scaledH,
            marginInline: 'auto',
            position: 'relative',
          }}
        >
          <iframe
            ref={frameRef}
            key={`${route}-${nonce}-${reloadNonce}`}
            src={url}
            title={`Live preview: ${route}`}
            style={{
              width: device.w,
              height: frameH,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              position: 'absolute',
              top: 0,
              left: 0,
              border: 0,
              background: '#000',
            }}
          />
        </div>
      </div>
    </div>
  );
}

// pageArt() with a specific overrides map (the live in-memory draft, not the
// imported ART_OVERRIDES from disk). Same resolution semantics as artConfig.
function pageArtWith(overrides: Record<string, ArtOverride>, pageId: string, idx: number): ArtPiece {
  const o = overrides[`${pageId}:${idx}`];
  if (o) {
    const piece = ART_LIST.find((p) => p.id === o.artId);
    if (piece) return o.objectPosition ? { ...piece, objectPosition: o.objectPosition } : piece;
  }
  return pageArt(pageId, idx);
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
