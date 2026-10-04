/**
 * Shared art-surface inventory — the single list of every (pageId, idx) the
 * app renders, plus the route each pageId lives on.
 *
 * Extracted from ArtStudioPage.tsx (2026-08-28) so BOTH studios read the same
 * inventory: /art-studio (classic skin) and /bayla-studio (bungalow skins).
 * The coverage guard in pages/artStudioCoverage.test.ts scans THIS file, so a
 * new pageId in app code still has to be registered here or CI fails.
 */
// ─────────────────────────────────────────────────────────────────────────────
// Surface inventory — every (pageId, idx) the app renders.
// Mirrors the spec the user provided. Add entries here as new pageArt() call
// sites are added to the codebase.
// ─────────────────────────────────────────────────────────────────────────────

export type Surface = { group: string; pageId: string; idx: number; label: string };

// Where each pageId actually renders in the app — used by the "Live page"
// preview tab to iframe the real route. If a pageId belongs to a section
// component (e.g. 'farm-stats', 'gauge-voting'), it routes to the page that
// embeds it.
export const PAGE_ROUTES: Record<string, string> = {
  home: '/',
  'venue-home': '/',
  // Pop-up / modal surfaces — route where each card appears (the modal itself
  // pops up on interaction, so the live-preview iframe shows the host page).
  onboarding: '/',
  'tx-receipt': '/dashboard',
  'connect-prompt': '/earn/toweli',
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
  'curve-launch': '/curve-launch',
  'eth-curve': '/eth-curve',
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
  farm: '/earn/toweli',
  'farm-stats': '/earn/toweli',
  'boost-schedule': '/earn/toweli',
  'lp-farming': '/earn/toweli',
  'live-pool': '/earn/toweli',
  'staking-card': '/earn/toweli',
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
  checkout: '/checkout',
  tax: '/tax',
  // pageId 'swap' is the Solana swap page; the EVM one is pageId 'trade'.
  // Modals render over any route; home is just somewhere to load.
  terminal: '/terminal',
  developer: '/developers',
  'nav-drawer': '/',
  seasonal: '/',
  'legacy-exit': '/earn/toweli',
  wizard: '/nft-finance',
  // 2026-10-03: the pageIds minted for card art, plus the older ones that had
  // surfaces but no route (their Live page said "No route mapping").
  'bungalow-burn': '/dashboard',
  'bungalow-holders': '/dashboard',
  'bungalow-market': '/dashboard',
  'flames-board': '/',
  'three-paths': '/',
  'venue-doors': '/',
  'yield-calculator': '/',
  'bungalow-dashboard': '/dashboard',
  portfolio: '/dashboard',
  'position-health': '/dashboard',
  'price-alert-widget': '/dashboard',
  'bungalow-farm': '/earn/toweli',
  'bungalow-heat-card': '/earn/toweli',
  earn: '/earn',
  'evm-ladder-pool-live': '/earn/toweli',
  'evm-lighthouse-pool-live': '/earn/toweli',
  'incentives-strip': '/earn/toweli',
  'lighthouse-claim-strip': '/earn/toweli',
  'lighthouse-pool-live': '/earn/toweli',
  'solana-ladder-pool-live': '/earn/toweli',
  'wrong-chain': '/earn/toweli',
  island: '/island',
  gallery: '/gallery',
  'heat-card': '/leaderboard',
  'clock-line': '/swap',
  'solana-swap': '/solana',
  'il-calculator': '/liquidity',
  liquidity: '/liquidity',
  'pending-trade': '/solana-lp',
  'solana-lp': '/solana-lp',
  'venue-amm': '/solana-lp',
  zap: '/zap',
  'venue-launch-lines': '/curve-launch',
  'gate-audit-panel': '/launch',
  'launch-gate': '/launch',
  'launch-token': '/launch',
  shield: '/nft-finance',
  referrals: '/referrals',
  'copy-trading': '/copy-trading',
  competitions: '/competitions',
  trust: '/trust',
  chart: '/chart',
  alerts: '/alerts',
  'terms-cards': '/terms',
  'privacy-cards': '/privacy',
  'risk-cards': '/risks',
  'proof-of-claims': '/toweli',
  'protocol-pulse': '/toweli',
  'protocol-stats': '/toweli',
  'real-yield-proof': '/toweli',
  'toweli-section-band': '/community',
  'birth-queue-panel': '/admin',
  'integrator-fees': '/admin',
};

export const SURFACES: Surface[] = [
  // HomePage (17)
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
  // Feature-gated cards — they only mount when their rail is live (idx 16 is
  // unused), so they were missed by earlier passes that read the page top-down.
  { group: 'Home', pageId: 'home', idx: 15, label: 'H16 — Protocol: Solana Swap (gated)' },
  { group: 'Home', pageId: 'home', idx: 17, label: 'H17 — Ecosystem: Memetics Curve (gated)' },
  // The venue's own hero. HomePage picks between 'home' and 'venue-home' at
  // render time (`pageId={isToweliArrival || bungalowIdentity ? 'home' : 'venue-home'}`),
  // and a computed pageId is invisible to BOTH coverage guards — so the most-seen
  // surface on the site was unregistered and unplaceable in either studio until
  // 2026-09-13, even though artOverrides.ts has carried a pick for it all along.
  { group: 'Home', pageId: 'venue-home', idx: 0, label: 'H0 — Venue hero bg (non-bungalow)' },

  // Dashboard (14)
  { group: 'Dashboard', pageId: 'dashboard', idx: 0, label: 'D1 — BG disconnected' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 1, label: 'D2 — BG connected' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 2, label: 'D3 — Stat: TOWELI Balance' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 3, label: 'D4 — Stat: ETH Balance' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 4, label: 'D5 — Stat: Claimable' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 5, label: 'D6 — Stat: TOWELI Price' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 6, label: 'D7 — Venue Score block' },
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
  // Settled-door landing (renders at /<slug> for a not-yet-live bungalow).
  { group: 'Island', pageId: 'bungalow-door', idx: 0, label: 'ID1 — Settled-door landing bg' },
  { group: 'Island', pageId: 'bungalow-door', idx: 1, label: 'ID2 — Art-drop invitation card' },
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

  // Trade (4)
  { group: 'Trade', pageId: 'trade', idx: 0, label: 'TR1 — Page bg' },
  { group: 'Trade', pageId: 'trade', idx: 1, label: 'TR2 — Swap tab' },
  { group: 'Trade', pageId: 'trade', idx: 2, label: 'TR3 — DCA tab' },
  { group: 'Trade', pageId: 'trade', idx: 3, label: 'TR4 — Limit Order tab' },
  { group: 'Trade', pageId: 'liquidity-tab', idx: 0, label: 'TRL1 — Liquidity header' },
  { group: 'Trade', pageId: 'yield', idx: 0, label: 'YR1 — Yield routing backdrop' },
  { group: 'Trade', pageId: 'yield', idx: 1, label: 'YR2 — What this page does card' },
  { group: 'Trade', pageId: 'yield', idx: 2, label: 'YR3 — Buying over time card' },
  { group: 'Trade', pageId: 'yield', idx: 3, label: 'YR4 — Venue deposit card' },

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
  // LendingSection calls pageArt('lending-section', N) for N = 1..14 — it has no
  // idx 0, so the range starts at 1. (It listed 0..14 until 2026-09-13; the
  // extra card was placeable in the studio and rendered nowhere.)
  ...Array.from({ length: 14 }, (_, i): Surface => ({
    group: 'NFT Finance',
    pageId: 'lending-section',
    idx: i + 1,
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
  // Pages that rendered NO art surface at all until 2026-09-01 — both studios
  // were blind to them, so no skin could reach either page.
  { group: 'Misc pages', pageId: 'terminal', idx: 0, label: 'TM1 — Pro Terminal page bg' },
  { group: 'Misc pages', pageId: 'developer', idx: 0, label: 'DV1 — Developer API page bg' },

  { group: 'Misc widgets', pageId: 'tegridy-score', idx: 0, label: 'TS1 — TegridyScore widget' },
  { group: 'Misc widgets', pageId: 'referral-widget', idx: 0, label: 'RW1 — Referral widget' },

  // Pop-up / modal cards — the surfaces that appear over other pages. Registered
  // here so every pop-up card is identifiable and adjustable in the studio.
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 0, label: 'PU1 — Onboarding slide 1 (Welcome)' },
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 1, label: 'PU2 — Onboarding slide 2 (How It Works)' },
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 2, label: 'PU3 — Onboarding slide 3 (Stay Safe)' },
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 3, label: 'PU4 — Onboarding slide 4 (First Move)' },
  // The venue voice runs FIVE slides (Welcome · Bungalows · Heat · Stay Safe ·
  // First Move) against the Toweli voice's four, so slide 5 only ever paints
  // off the venue copy — and went unregistered when that voice was added.
  { group: 'Pop-ups / Modals', pageId: 'onboarding',     idx: 4, label: 'PU4b — Onboarding slide 5 (venue voice only)' },
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
  { group: 'Trust tools',   pageId: 'alerts',           idx: 1, label: 'TT4b — Alerts resident quick-pick' },
  { group: 'Trust tools',   pageId: 'alerts',           idx: 2, label: 'TT4c — Alerts rule builder' },
  { group: 'Trust tools',   pageId: 'alerts',           idx: 3, label: 'TT4d — Alerts inbox' },
  { group: 'Trust tools',   pageId: 'alerts',           idx: 4, label: 'TT4e — Alerts delivery' },
  { group: 'Trust tools',   pageId: 'chart',            idx: 0, label: 'TT5 — Pro Charting backdrop' },
  { group: 'Trust tools',   pageId: 'chart',            idx: 1, label: 'TT5b — Pro Charting pool picker card' },
  { group: 'Trust tools',   pageId: 'chart',            idx: 2, label: 'TT5c — Pro Charting sources card' },
  { group: 'Engage',        pageId: 'referrals',        idx: 0, label: 'EN1 — Referrals backdrop' },
  { group: 'Engage',        pageId: 'copy-trading',     idx: 0, label: 'EN2 — Copy Trading backdrop' },
  { group: 'Engage',        pageId: 'competitions',     idx: 0, label: 'EN3 — Competitions backdrop' },
  { group: 'Engage',        pageId: 'checkout',         idx: 0, label: 'EN4 — Checkout backdrop' },
  // idx 1 is the merchant's minted payment link; idx 2 is the buyer's
  // merchant-signature strip. Both are the cards a person stares at while
  // deciding whether to trust a stranger's invoice, so both get real art.
  { group: 'Stats',         pageId: 'tax',              idx: 0, label: 'ST1 — Tax Reports backdrop' },
  { group: 'Launch & Solana', pageId: 'launch',           idx: 0, label: 'LS1 — Launch rail backdrop' },
  // Also reached only through a computed pageId (`const PAGE_ID = 'eth-curve'`
  // in EthCurvePage and CurveTokenPage), so it was never registered. One surface
  // covers all three call sites — both backdrops and the SOON card use idx 0.
  { group: 'Launch & Solana', pageId: 'eth-curve',        idx: 0, label: 'LS1b — Memetics curve (ETH) backdrop' },
  { group: 'Launch & Solana', pageId: 'launch-simulator', idx: 0, label: 'LS2 — Launch Simulator backdrop' },
  { group: 'Launch & Solana', pageId: 'airdrop',           idx: 0, label: 'LS2d — Airdrop campaigns backdrop' },
  // idx 1 is the SOON placeholder art on the vesting rails, which is the only state
  // that page has until VestingFactory / LaunchLockView are deployed.
  { group: 'Launch & Solana', pageId: 'vesting',           idx: 0, label: 'LS2e — Vesting & Locks backdrop' },
  { group: 'Launch & Solana', pageId: 'vesting',           idx: 1, label: 'LS2f — Vesting rail SOON placeholder' },
  { group: 'Launch & Solana', pageId: 'launch-token',     idx: 0, label: 'LS2b — Token record backdrop' },
  { group: 'Launch & Solana', pageId: 'launch-token',     idx: 1, label: 'LS2c — Token record Fact Sheet strip' },
  { group: 'Launch & Solana', pageId: 'curve-launch',     idx: 0, label: 'LS3b — Memetics Curve backdrop' },
  { group: 'Launch & Solana', pageId: 'curve-launch',     idx: 1, label: 'LS3c — Memetics Curve status banner' },
  { group: 'Launch & Solana', pageId: 'swap',             idx: 2, label: 'LS4 — Solana Swap surface' },
  // The Pools page paints its full-page backdrop off the 'swap' pageId, so this
  // surface lives on /pools even though PAGE_ROUTES sends 'swap' to /solana —
  // the Live-page tab will show the Solana route, the Art tab is the true one.
  { group: 'Launch & Solana', pageId: 'swap',             idx: 0, label: 'LS4b — Pools page bg' },
  // The Solana Swap page used to paint ONE surface (the swap card at idx 2) —
  // the staking rail, the trending grid and every margin sat on the bare app
  // gradient, so no skin could reach the page. idx 1 is the page backdrop, 3-6
  // the four liquid-staking cards, 7-18 the trending grid (index wraps at 12).
  { group: 'Contracts',     pageId: 'contracts',        idx: 0, label: 'CO1 — Contracts page bg' },
  // One card per contract GROUP (idx = groupIdx + 1), so the seven groups on
  // the page each get their own wall instead of sharing the page backdrop.
  { group: 'Contracts',     pageId: 'contracts',        idx: 1, label: 'CO2 — Group card: Core' },
  { group: 'Contracts',     pageId: 'contracts',        idx: 2, label: 'CO3 — Group card: DEX' },
  { group: 'Contracts',     pageId: 'contracts',        idx: 3, label: 'CO4 — Group card: Token Launcher' },
  { group: 'Contracts',     pageId: 'contracts',        idx: 4, label: 'CO5 — Group card: Revenue' },
  { group: 'Contracts',     pageId: 'contracts',        idx: 5, label: 'CO6 — Group card: Governance' },
  { group: 'Contracts',     pageId: 'contracts',        idx: 6, label: 'CO7 — Group card: NFT Finance' },
  { group: 'Contracts',     pageId: 'contracts',        idx: 7, label: 'CO8 — Group card: External deps' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 0, label: 'TR1 — Treasury page bg' },
  // The four top stat tiles, which carry their own idx on the stats array.
  { group: 'Treasury',      pageId: 'treasury',         idx: 1, label: 'TR2 — Stat: Total Value Locked' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 2, label: 'TR3 — Stat: Lifetime Fees' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 3, label: 'TR4 — Stat: Treasury Balance' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 4, label: 'TR5 — Stat: POL Holdings' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 5, label: 'TR6 — Treasury surface 5' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 6, label: 'TR7 — Treasury surface 6' },
  { group: 'Treasury',      pageId: 'treasury',         idx: 7, label: 'TR8 — Treasury surface 7' },

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

  // Launch simulator (/launch-simulator)

  // Scanner (/scan)

  // Treasury (/treasury)

  // Wallet exposure (/exposure)

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
  // ───────────────────────────────────────────────────────────────────────────
  // 2026-10-03: art on every card of every tab. The tabs added since the section
  // hosts landed (Solana LP, Venue AMM, the Island lobby, the Earn list, most of
  // Check) rendered bare dark boxes, so neither studio could list them. Each now
  // carries a CardArt layer (components/ui/CardArt.tsx), and six tabs that had
  // no background at all got one. Grouped by the tab they render on, in nav
  // order; a label in brackets says when a card only shows in some state.
  // ───────────────────────────────────────────────────────────────────────────

  // Home
  { group: 'Home', pageId: 'bungalow-burn', idx: 0, label: 'Burn card (room with a token)' },
  { group: 'Home', pageId: 'bungalow-holders', idx: 0, label: 'Who holds her card (room with a token address)' },
  { group: 'Home', pageId: 'bungalow-market', idx: 0, label: 'Market card (room with a market pool)' },
  { group: 'Home', pageId: 'flames-board', idx: 0, label: 'The board card (venue home and /island, when the island bo…)' },
  { group: 'Home', pageId: 'home', idx: 18, label: 'Your held time card (room with a token)' },
  { group: 'Home', pageId: 'three-paths', idx: 0, label: 'Three paths card 1' },
  { group: 'Home', pageId: 'three-paths', idx: 1, label: 'Three paths card 2' },
  { group: 'Home', pageId: 'three-paths', idx: 2, label: 'Three paths card 3' },
  { group: 'Home', pageId: 'venue-doors', idx: 0, label: 'Hall of doors panel (venue home)' },
  { group: 'Home', pageId: 'yield-calculator', idx: 0, label: 'Yield calculator (TOWELI room, not connected)' },

  // Dashboard
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 2, label: 'At the lighthouse card (Solana room with an open stake pool)' },
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 3, label: 'Retired lighthouse pool card (members-only pool, wallet has an open posi…)' },
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 4, label: 'Lock ladder card (members-only pool, no open position)' },
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 5, label: 'Live surfaces card' },
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 6, label: 'EVM dashboard header card (EVM room)' },
  { group: 'Dashboard', pageId: 'bungalow-dashboard', idx: 7, label: 'EVM lighthouse position card (EVM room with a stake pool)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 15, label: 'Reconnecting wallet card (TOWELI room, wallet reconnecting)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 16, label: 'Price chart card (not connected) (TOWELI room, not connected)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 17, label: 'Wrong network banner (TOWELI room, connected on the wrong network)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 18, label: 'Price chart card (TOWELI room, connected, Overview tab)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 19, label: 'Position could not be read notice (TOWELI room, connected, Positions tab, error)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 20, label: 'Liquidity could not be read card (TOWELI room, connected, Positions tab, error)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 21, label: 'Loans could not be loaded card (TOWELI room, connected, Loans tab, error)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 22, label: 'Some loan records unread card (TOWELI room, connected, Loans tab, partial…)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 23, label: 'Unsettled rewards card (TOWELI room, connected, Rewards tab, has u…)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 24, label: 'All caught up card (TOWELI room, connected, Rewards tab, nothi…)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 25, label: 'ETH revenue could not be loaded row (TOWELI room, connected, Rewards tab, error)' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 26, label: 'Earnings projection tile 1' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 27, label: 'Earnings projection tile 2' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 28, label: 'Earnings projection tile 3' },
  { group: 'Dashboard', pageId: 'dashboard', idx: 29, label: 'Earnings projection tile 4' },
  { group: 'Dashboard', pageId: 'portfolio', idx: 0, label: 'Unified portfolio card' },
  { group: 'Dashboard', pageId: 'position-health', idx: 0, label: 'Position health card (TOWELI room, connected, has a position)' },
  { group: 'Dashboard', pageId: 'price-alert-widget', idx: 0, label: 'Price alerts card (TOWELI room, connected, Overview tab)' },

  // Earn · Staking
  { group: 'Earn · Staking', pageId: 'bungalow-farm', idx: 3, label: 'Live today card' },
  { group: 'Earn · Staking', pageId: 'bungalow-heat-card', idx: 0, label: 'Check your heat card' },
  { group: 'Earn · Staking', pageId: 'earn', idx: 0, label: 'Page background' },
  { group: 'Earn · Staking', pageId: 'earn', idx: 1, label: 'Pool list card' },
  { group: 'Earn · Staking', pageId: 'evm-ladder-pool-live', idx: 0, label: 'EVM lock ladder pool card (EVM room whose pool is a lock ladder)' },
  { group: 'Earn · Staking', pageId: 'evm-lighthouse-pool-live', idx: 0, label: 'EVM lighthouse pool card (flag off)' },
  { group: 'Earn · Staking', pageId: 'farm', idx: 2, label: 'LP boost refresh notice (connected, LP boost out of date)' },
  { group: 'Earn · Staking', pageId: 'farm', idx: 3, label: 'Restaking card (connected, has a position, restaking deplo…)' },
  { group: 'Earn · Staking', pageId: 'incentives-strip', idx: 0, label: 'Incentives tile 1' },
  { group: 'Earn · Staking', pageId: 'incentives-strip', idx: 1, label: 'Incentives tile 2' },
  { group: 'Earn · Staking', pageId: 'incentives-strip', idx: 2, label: 'Incentives tile 3' },
  { group: 'Earn · Staking', pageId: 'incentives-strip', idx: 3, label: 'Incentives tile 4' },
  { group: 'Earn · Staking', pageId: 'incentives-strip', idx: 4, label: 'Incentives tile 5' },
  { group: 'Earn · Staking', pageId: 'legacy-exit', idx: 1, label: 'Legacy staking check failed notice (connected, error)' },
  { group: 'Earn · Staking', pageId: 'lighthouse-claim-strip', idx: 0, label: 'Retired pool claim card (connected, members-only pool, open positio…)' },
  { group: 'Earn · Staking', pageId: 'lighthouse-pool-live', idx: 0, label: 'Lighthouse pool card (Streamflow pool open or closed to deposits)' },
  { group: 'Earn · Staking', pageId: 'solana-ladder-pool-live', idx: 0, label: 'Lock ladder pool card' },
  { group: 'Earn · Staking', pageId: 'wrong-chain', idx: 0, label: 'Wrong network banner (wrong network)' },

  // Island
  { group: 'Island', pageId: 'bungalow-door', idx: 2, label: 'Live today card (settled door) (flag off)' },
  { group: 'Island', pageId: 'island', idx: 0, label: 'Page background' },
  { group: 'Island', pageId: 'island', idx: 1, label: 'Door card: Gallery' },
  { group: 'Island', pageId: 'island', idx: 2, label: 'Door card: Marketplace' },
  { group: 'Island', pageId: 'island', idx: 3, label: 'Door card: Community' },
  { group: 'Island', pageId: 'island', idx: 4, label: 'Door card: Venue Score' },
  { group: 'Island', pageId: 'island', idx: 5, label: 'Door card: Treasury & numbers' },

  // Island · Gallery
  { group: 'Island · Gallery', pageId: 'gallery', idx: 0, label: 'Page background' },
  { group: 'Island · Gallery', pageId: 'gallery', idx: 1, label: 'No gallery pieces card (empty)' },

  // Community
  { group: 'Community', pageId: 'toweli-section-band', idx: 0, label: 'TOWELI protocol band above the tabs' },
  { group: 'Community', pageId: 'bounties', idx: 6, label: 'Bounty claims could not be read notice (error)' },
  { group: 'Community', pageId: 'community', idx: 6, label: 'Venue Score link card' },
  { group: 'Community', pageId: 'community', idx: 7, label: 'Community chat link card' },
  { group: 'Community', pageId: 'community', idx: 8, label: 'Gallery link card' },
  { group: 'Community', pageId: 'gauge-voting', idx: 7, label: 'Pending reveal banner (gauge controller wired, vote committed and…)' },
  { group: 'Community', pageId: 'vote-incentives', idx: 4, label: 'For projects card (vote incentives wired)' },
  { group: 'Community', pageId: 'vote-incentives', idx: 5, label: 'For voters card (vote incentives wired)' },
  { group: 'Community', pageId: 'vote-incentives', idx: 6, label: 'Pending fee change banner (vote incentives wired, fee change queued)' },
  { group: 'Community', pageId: 'vote-incentives', idx: 7, label: 'Commit-reveal voting banner (vote incentives wired, commit-reveal on)' },
  { group: 'Community', pageId: 'vote-incentives', idx: 8, label: 'Orphaned bribe refund banner (vote incentives wired, refund window near)' },
  { group: 'Community', pageId: 'vote-incentives', idx: 9, label: 'Pull-pattern refunds card (vote incentives wired, refund parked for t…)' },
  { group: 'Community', pageId: 'vote-incentives', idx: 10, label: 'Your claimables card (vote incentives wired)' },

  // Leaderboard
  { group: 'Leaderboard', pageId: 'heat-card', idx: 0, label: 'Heat card (panel variant only)' },
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 7, label: 'Season line under the heading' },
  { group: 'Leaderboard', pageId: 'leaderboard', idx: 6, label: 'On-chain verified points banner' },

  // Premium
  { group: 'Premium', pageId: 'premium', idx: 3, label: 'Connect your wallet card (not connected)' },
  { group: 'Premium', pageId: 'premium', idx: 4, label: 'Error loading data card (connected, error)' },
  { group: 'Premium', pageId: 'premium', idx: 5, label: 'Gold card active banner (connected, has a membership)' },
  { group: 'Premium', pageId: 'premium', idx: 6, label: 'Gold Card stat tile 1' },
  { group: 'Premium', pageId: 'premium', idx: 7, label: 'Gold Card stat tile 2' },
  { group: 'Premium', pageId: 'premium', idx: 8, label: 'Gold Card stat tile 3' },
  { group: 'Premium', pageId: 'premium', idx: 9, label: 'Gold Card stat tile 4' },
  { group: 'Premium', pageId: 'premium', idx: 10, label: 'Gold Card benefit card 1' },
  { group: 'Premium', pageId: 'premium', idx: 11, label: 'Gold Card benefit card 2' },
  { group: 'Premium', pageId: 'premium', idx: 12, label: 'Membership could not be read notice (connected, error)' },
  { group: 'Premium', pageId: 'premium', idx: 13, label: 'Plan choice card 1' },
  { group: 'Premium', pageId: 'premium', idx: 14, label: 'Plan choice card 2' },
  { group: 'Premium', pageId: 'premium', idx: 15, label: 'Plan choice card 3' },
  { group: 'Premium', pageId: 'premium', idx: 16, label: 'Plan choice card 4' },
  { group: 'Premium', pageId: 'premium', idx: 17, label: 'Total cost and subscribe card (no membership yet)' },
  { group: 'Premium', pageId: 'premium', idx: 18, label: 'Total distributed card' },
  { group: 'Premium', pageId: 'premium', idx: 19, label: 'Your pending card' },
  { group: 'Premium', pageId: 'premium', idx: 20, label: 'Referral earnings card' },
  { group: 'Premium', pageId: 'premium', idx: 21, label: 'JBAC holders card' },

  // Swap · Ethereum
  { group: 'Swap · Ethereum', pageId: 'clock-line', idx: 0, label: 'Your clock line card (after a buy is recorded)' },
  { group: 'Swap · Ethereum', pageId: 'trade', idx: 4, label: 'Launching something card' },
  { group: 'Swap · Ethereum', pageId: 'trade', idx: 5, label: 'Swapping not live here banner (wallet on a chain with no swaps)' },

  // Swap · Solana
  { group: 'Swap · Solana', pageId: 'solana-swap', idx: 0, label: 'Page background' },
  { group: 'Swap · Solana', pageId: 'solana-swap', idx: 1, label: 'Price chart card (swap mode, buy token is not a stablecoin)' },

  // Pools · Add / Remove
  { group: 'Pools · Add / Remove', pageId: 'il-calculator', idx: 0, label: 'Impermanent loss calculator card (calculator opened)' },
  { group: 'Pools · Add / Remove', pageId: 'liquidity', idx: 0, label: 'Page background' },
  { group: 'Pools · Add / Remove', pageId: 'liquidity', idx: 1, label: 'Pools on this venue table' },
  { group: 'Pools · Add / Remove', pageId: 'liquidity', idx: 2, label: 'New to this? primer' },

  // Pools · Solana LP
  { group: 'Pools · Solana LP', pageId: 'pending-trade', idx: 0, label: 'Transaction may still be landing (a sent transaction is not confirmed yet)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 0, label: 'Before you provide liquidity (venue live)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 1, label: 'Fee tiers card (venue live)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 2, label: 'Create, add or remove liquidity (venue live)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 3, label: 'Your positions card (venue live)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 4, label: 'Adding and removing liquidity notice (liquidity writes blocked or not loaded)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 5, label: 'The token card (after a token lookup)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 6, label: 'Pools result card (after a lookup)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 7, label: 'Pool card (after a lookup, one per pool found)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 8, label: 'Pool not read card (after a lookup, a pool that could not be r…)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 9, label: 'Open a new pool card (after a lookup, liquidity writes on)' },
  { group: 'Pools · Solana LP', pageId: 'solana-lp', idx: 10, label: 'Risk line above the forms' },
  { group: 'Pools · Solana LP', pageId: 'venue-amm', idx: 0, label: 'Venue status card' },
  { group: 'Pools · Solana LP', pageId: 'venue-amm', idx: 1, label: 'The program card' },

  // Pools · Venue AMM
  { group: 'Pools · Venue AMM', pageId: 'venue-amm', idx: 2, label: 'Fee sheet card' },
  { group: 'Pools · Venue AMM', pageId: 'venue-amm', idx: 3, label: 'For liquidity providers card' },
  { group: 'Pools · Venue AMM', pageId: 'venue-amm', idx: 4, label: 'How the swap routes card' },

  // Pools · Zap
  { group: 'Pools · Zap', pageId: 'zap', idx: 0, label: 'Page background' },
  { group: 'Pools · Zap', pageId: 'zap', idx: 1, label: 'Zap form card' },
  { group: 'Pools · Zap', pageId: 'zap', idx: 2, label: 'Zap cannot be composed card (error)' },
  { group: 'Pools · Zap', pageId: 'zap', idx: 3, label: 'Zap steps summary card (a zap plan exists)' },
  { group: 'Pools · Zap', pageId: 'zap', idx: 4, label: 'Zap progress card (a zap is running or saved)' },
  { group: 'Pools · Zap', pageId: 'zap', idx: 5, label: 'Saved zap for this wallet (a saved zap does not match the form)' },

  // Launch · Solana Curve
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 2, label: 'Look up a launch card (read-only view)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 3, label: 'Curve state card (read-only view on /curve-launch)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 4, label: 'Trade the curve card (read-only view)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 5, label: 'Open a launch card (read-only view)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 6, label: 'Wallet card (read-only view)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 7, label: 'What this is card' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 8, label: 'What graduation promises card' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 9, label: 'What this page will not show you' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 10, label: 'Open a launch by address card (write mode)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 11, label: 'Launch a token card (write mode, wallet allowed through the door)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 12, label: 'Launches list card (write mode)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 13, label: 'Launch and trade status card (writes configured)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 14, label: 'Launching not switched on card (flag off)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 15, label: 'Launch identity card (writes configured)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 16, label: 'Your launch is still landing (a launch this browser sent is not on chain…)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 17, label: 'No launch at this address (empty)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 18, label: 'Before you trade card (writes open and the launch is read)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 19, label: 'Trade on the curve card (launch is tradable and no trade is pending)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 20, label: 'Finish graduation card (launch is awaiting migration, or a graduat…)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 21, label: 'Graduated card (launch has graduated)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 22, label: 'Trade in the pool card (launch has graduated)' },
  { group: 'Launch · Solana Curve', pageId: 'curve-launch', idx: 23, label: 'Not a token address card (error)' },
  { group: 'Launch · Solana Curve', pageId: 'venue-launch-lines', idx: 0, label: 'Venue launch lines under the door' },

  // Launch · Launchpad
  { group: 'Launch · Launchpad', pageId: 'gate-audit-panel', idx: 0, label: 'Gate decisions panel (opened by the visitor)' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 50, label: 'Launch wizard card' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 51, label: 'What the launch rail does' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 52, label: 'Why an audited template' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 53, label: 'What a Fact Sheet is' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 54, label: 'Fee split explainer card' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 55, label: 'Launch afterlife explainer card' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 56, label: 'TOWELI rails explainer card' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 57, label: 'What is built and open' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 58, label: 'Where launches graduate card' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 59, label: 'Re-attest the real fees' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 60, label: 'Launch history unread notice (error)' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 61, label: 'Launch status banner (after a launch is sent)' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 62, label: 'Launch Radar status card (loading, error and empty)' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 63, label: 'Launch outcome row 1' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 64, label: 'Launch outcome row 2' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 65, label: 'Launch outcome row 3' },
  { group: 'Launch · Launchpad', pageId: 'launch', idx: 66, label: 'Launch outcome row 4' },
  { group: 'Launch · Launchpad', pageId: 'launch-gate', idx: 0, label: 'Who may plant card' },
  { group: 'Launch · Launchpad', pageId: 'launch-token', idx: 2, label: 'Token record loading card (loading)' },
  { group: 'Launch · Launchpad', pageId: 'launch-token', idx: 3, label: 'Token record notice card (error, no contract, unverified presence, b…)' },
  { group: 'Launch · Launchpad', pageId: 'launch-token', idx: 4, label: 'Provenance card (record loaded)' },
  { group: 'Launch · Launchpad', pageId: 'launch-token', idx: 5, label: 'Disclosure attestation card (record loaded)' },
  { group: 'Launch · Launchpad', pageId: 'launch-token', idx: 6, label: 'Post-graduation state card (record loaded)' },
  { group: 'Launch · Launchpad', pageId: 'launch-token', idx: 7, label: 'Maker\'s allocation card' },

  // Launch · Memetics Curve
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 1, label: 'Launch on chain picker' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 2, label: 'Trade by address card (launcher deployed)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 3, label: 'How the curve works' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 4, label: 'Create launch panel (launch door open)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 5, label: 'Live launches status card (reading, empty and error)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 6, label: 'Live launch card (one card per launch in the grid)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 7, label: 'Curve trade panel' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 8, label: 'Token lookup status card (bad address, looking up, not found)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 9, label: 'Market cap and price card (token found and not graduated)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 10, label: 'Curve price chart card (token found and not graduated)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 11, label: 'Graduated token card (token found and graduated)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 12, label: 'Your creator fees card (connected wallet is the token\'s creator)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 13, label: 'Verify it yourself card (token found)' },
  { group: 'Launch · Memetics Curve', pageId: 'eth-curve', idx: 14, label: 'Maker\'s create-buy card (token found)' },

  // Launch · Simulator
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 1, label: 'Proposed allocation card' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 2, label: 'Structural configuration card' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 3, label: 'Nothing to measure yet (empty)' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 4, label: 'Projected Fact Sheet card (allocation entered)' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 5, label: 'Distribution report card (allocation entered)' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 6, label: 'Band target card 1' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 7, label: 'Band target card 2' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 8, label: 'Band target card 3' },
  { group: 'Launch · Simulator', pageId: 'launch-simulator', idx: 9, label: 'How the score is built' },

  // Launch · Airdrop
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 1, label: 'Campaign address card (Claim tab)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 2, label: 'Claim list source card (Claim tab, campaign address entered and wa…)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 3, label: 'Eligibility verdict card (Claim tab)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 4, label: 'Paste a manifest card (Claim tab)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 5, label: 'Campaign as the chain reports (Claim tab, campaign address entered)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 6, label: 'Token to distribute card (Create a campaign tab)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 7, label: 'Allocations list card (Create a campaign tab)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 8, label: 'List could not be built notice (error)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 9, label: 'Root preview card (Create tab, merkle root built)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 10, label: 'Host the claim list card (Create tab, merkle root built)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 11, label: 'Fund the campaign card (Create a campaign tab)' },
  { group: 'Launch · Airdrop', pageId: 'airdrop', idx: 12, label: 'How a campaign is built' },

  // Launch · Vesting
  { group: 'Launch · Vesting', pageId: 'vesting', idx: 2, label: 'Vesting stream card (My streams tab, wallet connected)' },
  { group: 'Launch · Vesting', pageId: 'vesting', idx: 3, label: 'Vesting data unavailable notice (error)' },
  { group: 'Launch · Vesting', pageId: 'vesting', idx: 4, label: 'Lock viewer token card (Lock viewer tab, lock view deployed)' },
  { group: 'Launch · Vesting', pageId: 'vesting', idx: 5, label: 'Vesting rail card (Lock viewer tab, token read)' },
  { group: 'Launch · Vesting', pageId: 'vesting', idx: 6, label: 'Lock rail card (Lock viewer tab, token read)' },
  { group: 'Launch · Vesting', pageId: 'vesting', idx: 7, label: 'What these numbers say' },

  // NFT Finance
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 5, label: 'Connect wallet intro card (not connected)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 6, label: 'Pooled lending intro card' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 7, label: 'No pool deployed notice (no pool deployed)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 8, label: 'Pooled lending pool card 1' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 9, label: 'Pooled lending pool card 2' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 10, label: 'Pooled lending pool card 3' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 11, label: 'No pool history notice (history unavailable)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 12, label: 'Pay in instalments intro card' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 13, label: 'Instalment desk not deployed notice (desk not deployed)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 14, label: 'What a plan would cost card' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 15, label: 'Launchpad not deployed card (launchpad factory not deployed)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 16, label: 'Deployed collections list card' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 17, label: 'Estimated interest earned card (Lend tab, once principal and APR are typed)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 18, label: 'Loan offer card (Borrow tab, one per offer, every offer sha…)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 19, label: 'My loans empty card (My Loans tab)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 20, label: 'Loan card (My Loans tab, one per loan, every loan sha…)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 21, label: 'Pool unreachable card (error)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 22, label: 'Pool factory unset notice (flag off)' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 23, label: 'Pooled lending small-market warning' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 24, label: 'Pay-later missed payment warning' },
  { group: 'NFT Finance', pageId: 'nft-finance', idx: 25, label: 'Lend offer summary (amounts typed)' },
  { group: 'NFT Finance', pageId: 'shield', idx: 0, label: 'Loan repayment position card (connected, has NFT loans)' },
  { group: 'NFT Finance', pageId: 'shield', idx: 1, label: 'How this shield works notice' },
  { group: 'NFT Finance', pageId: 'shield', idx: 2, label: 'Not covered by this page notice' },
  { group: 'NFT Finance', pageId: 'shield', idx: 3, label: 'Deadline alerts card (has deadline alert rules)' },

  // Earn · Referrals
  { group: 'Earn · Referrals', pageId: 'referrals', idx: 1, label: 'Before you share a link card' },
  { group: 'Earn · Referrals', pageId: 'referrals', idx: 2, label: 'Your referral link card' },
  { group: 'Earn · Referrals', pageId: 'referrals', idx: 3, label: 'What the splitter holds card' },
  { group: 'Earn · Referrals', pageId: 'referrals', idx: 4, label: 'Who referred you card' },
  { group: 'Earn · Referrals', pageId: 'referrals', idx: 5, label: 'What this page promises card' },

  // Earn · Yield
  { group: 'Earn · Yield', pageId: 'yield', idx: 4, label: 'Chain read status card' },
  { group: 'Earn · Yield', pageId: 'yield', idx: 5, label: 'Yield venue card 1' },
  { group: 'Earn · Yield', pageId: 'yield', idx: 6, label: 'Yield venue card 2' },
  { group: 'Earn · Yield', pageId: 'yield', idx: 7, label: 'Yield venue card 3' },
  { group: 'Earn · Yield', pageId: 'yield', idx: 8, label: 'Yield venue card 4' },
  { group: 'Earn · Yield', pageId: 'yield', idx: 9, label: 'Yield venue card 5' },

  // Earn · Copy Trading
  { group: 'Earn · Copy Trading', pageId: 'copy-trading', idx: 1, label: 'Island tape read notice' },
  { group: 'Earn · Copy Trading', pageId: 'copy-trading', idx: 2, label: 'Router data read notice (indexer configured)' },
  { group: 'Earn · Copy Trading', pageId: 'copy-trading', idx: 3, label: 'Follow an address card' },
  { group: 'Earn · Copy Trading', pageId: 'copy-trading', idx: 4, label: 'Your mirrors record card' },
  { group: 'Earn · Copy Trading', pageId: 'copy-trading', idx: 5, label: 'Mirror queue card (tape readable)' },
  { group: 'Earn · Copy Trading', pageId: 'copy-trading', idx: 6, label: 'Wallets trading the venue card (indexer configured and router board read)' },

  // Earn · Competitions
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 1, label: 'Pool coverage notice' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 2, label: 'Volume board card (a pool board was read)' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 3, label: 'Find a sender card (a pool board was read)' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 4, label: 'How this is scored card' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 5, label: 'No season declared card (indexer configured, no season declared)' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 6, label: 'Season picker card (indexer configured, season declared)' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 7, label: 'Standings read notice (indexer configured)' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 8, label: 'Season standings card (indexer configured and standings read)' },
  { group: 'Earn · Competitions', pageId: 'competitions', idx: 9, label: 'Season standings not open yet' },

  // Earn · Checkout
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 1, label: 'Link names two invoices card (Pay tab, URL carries both a signed invoice…)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 2, label: 'Payment link status card (Pay tab before an invoice is loaded)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 3, label: 'Signed by the merchant card (Pay tab, invoice opened from a signed link)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 4, label: 'Invoice details card (Pay tab, invoice loaded)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 5, label: 'Settlement token check card (Pay tab, token re-read)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 6, label: 'Before you sign card (Pay tab, token matches)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 7, label: 'Pay the exact amount card (Pay tab, a signable plan exists)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 8, label: 'Sign an invoice card' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 9, label: 'Signed link result card (Get paid tab after signing)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 10, label: 'Also publish a short link card' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 11, label: 'Short link result card (Get paid tab after publishing)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 12, label: 'Reported payments card (Get paid tab after Check for reported paym…)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 13, label: 'Verify a payment card (Get paid tab once an invoice is drafted, a…)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 14, label: 'Subscription terms card' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 15, label: 'What this authorises card (Subscriptions tab, terms filled in)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 16, label: 'On-chain standing card (Subscriptions tab, terms filled in)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 17, label: 'Allowance card (Subscriptions tab, merchant-pull terms)' },
  { group: 'Earn · Checkout', pageId: 'checkout', idx: 18, label: 'Subscription prompt card (Subscriptions tab, no terms yet)' },

  // Treasury
  { group: 'Treasury', pageId: 'treasury', idx: 8, label: 'Treasury rotation pending banner (router treasury differs from the one this…)' },
  { group: 'Treasury', pageId: 'treasury', idx: 9, label: 'Fee routing paused banner (swap fee router is paused)' },
  { group: 'Treasury', pageId: 'treasury', idx: 10, label: 'Price oracle stale banner (price oracle stale)' },

  // Numbers · Tax
  { group: 'Numbers · Tax', pageId: 'tax', idx: 1, label: 'Period picker card' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 2, label: 'Cost-basis method card' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 3, label: 'Bring your own lots card' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 4, label: 'What was read card' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 5, label: 'Standing of this report card' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 6, label: 'Coverage gaps card (coverage incomplete)' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 7, label: 'What this venue cannot tell you card (report has limitations)' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 8, label: 'Capital gains card' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 9, label: 'Income card' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 10, label: 'Recorded but not classified card (informational rows exist)' },
  { group: 'Numbers · Tax', pageId: 'tax', idx: 11, label: 'Export card' },

  // Check · Overview
  { group: 'Check · Overview', pageId: 'trust', idx: 0, label: 'Trust tool card 1' },
  { group: 'Check · Overview', pageId: 'trust', idx: 1, label: 'Trust tool card 2' },
  { group: 'Check · Overview', pageId: 'trust', idx: 2, label: 'Trust tool card 3' },
  { group: 'Check · Overview', pageId: 'trust', idx: 3, label: 'How to read a result card' },

  // Check · Scanner
  { group: 'Check · Scanner', pageId: 'scanner', idx: 1, label: 'Token address form card' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 2, label: 'What you\'ll get card (empty)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 3, label: 'Scan notice card (error)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 4, label: 'Scan loading card (loading)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 5, label: 'Scan verdict summary card (scan result)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 6, label: 'Why this band card (scan result)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 7, label: 'Concentration components card (scan result)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 8, label: 'Hard-fact checks card (scan result)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 9, label: 'What was excluded card (scan result)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 10, label: 'Data confidence card (scan result)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 11, label: 'Read this with card (scan result, only when coverage notes or c…)' },
  { group: 'Check · Scanner', pageId: 'scanner', idx: 12, label: 'Method and dispute card (scan result)' },

  // Check · Deployer
  { group: 'Check · Deployer', pageId: 'deployer', idx: 1, label: 'Deployer address form card' },
  { group: 'Check · Deployer', pageId: 'deployer', idx: 2, label: 'What you\'ll get card (empty)' },
  { group: 'Check · Deployer', pageId: 'deployer', idx: 3, label: 'Deployer notice card (error)' },
  { group: 'Check · Deployer', pageId: 'deployer', idx: 4, label: 'Deployer loading card (loading)' },
  { group: 'Check · Deployer', pageId: 'deployer', idx: 5, label: 'Deployer summary card (lookup result)' },
  { group: 'Check · Deployer', pageId: 'deployer', idx: 6, label: 'Deployed token card (lookup result)' },
  { group: 'Check · Deployer', pageId: 'deployer', idx: 7, label: 'What this can and can\'t tell you card (lookup result)' },

  // Check · Exposure
  { group: 'Check · Exposure', pageId: 'wallet-exposure', idx: 1, label: 'Add a token card (connected)' },
  { group: 'Check · Exposure', pageId: 'wallet-exposure', idx: 2, label: 'Token holding card (connected, has holdings)' },
  { group: 'Check · Exposure', pageId: 'wallet-exposure', idx: 3, label: 'Balances could not be read card (connected, error)' },
  { group: 'Check · Exposure', pageId: 'wallet-exposure', idx: 4, label: 'No balances found card (connected, empty)' },

  // Check · Terminal
  { group: 'Check · Terminal', pageId: 'terminal', idx: 1, label: 'Safety filter and feed table card' },
  { group: 'Check · Terminal', pageId: 'terminal', idx: 2, label: 'Market feed status notice' },
  { group: 'Check · Terminal', pageId: 'terminal', idx: 3, label: 'Venue pairs status notice (Venue pairs tab)' },

  // Check · Charting
  { group: 'Check · Charting', pageId: 'chart', idx: 3, label: 'Link refusal notice (error)' },
  { group: 'Check · Charting', pageId: 'chart', idx: 4, label: 'Candle chart card (candles read)' },
  { group: 'Check · Charting', pageId: 'chart', idx: 5, label: 'Venue pairs candle chart card (indexer configured, candles read)' },
  { group: 'Check · Charting', pageId: 'chart', idx: 6, label: 'Chart status notice' },
  { group: 'Check · Charting', pageId: 'chart', idx: 7, label: 'Venue pairs status notice (indexer configured)' },

  // Check · Alerts
  { group: 'Check · Alerts', pageId: 'alerts', idx: 5, label: 'What this page does and does not promise card' },
  { group: 'Check · Alerts', pageId: 'alerts', idx: 6, label: 'Telegram link card' },

  // Developers
  { group: 'Developers', pageId: 'developer', idx: 1, label: 'Scan response contract note' },
  { group: 'Developers', pageId: 'developer', idx: 2, label: 'API endpoint row 1' },
  { group: 'Developers', pageId: 'developer', idx: 3, label: 'API endpoint row 2' },
  { group: 'Developers', pageId: 'developer', idx: 4, label: 'API endpoint row 3' },
  { group: 'Developers', pageId: 'developer', idx: 5, label: 'API endpoint row 4' },
  { group: 'Developers', pageId: 'developer', idx: 6, label: 'API endpoint row 5' },
  { group: 'Developers', pageId: 'developer', idx: 7, label: 'API endpoint row 6' },
  { group: 'Developers', pageId: 'developer', idx: 8, label: 'API endpoint row 7' },
  { group: 'Developers', pageId: 'developer', idx: 9, label: 'Key issuance not enabled notice (key issuance not configured on this deploy…)' },
  { group: 'Developers', pageId: 'developer', idx: 10, label: 'Issued key box (after a free key is issued)' },
  { group: 'Developers', pageId: 'developer', idx: 11, label: 'API status unreadable notice (error)' },
  { group: 'Developers', pageId: 'developer', idx: 12, label: 'Proposed prices notice' },

  // Start
  { group: 'Start', pageId: 'onboarding', idx: 5, label: 'Step card' },

  // Security
  { group: 'Security', pageId: 'security', idx: 22, label: 'No paid audit notice' },

  // FAQ
  { group: 'FAQ', pageId: 'faq', idx: 1, label: 'FAQ question group 1' },
  { group: 'FAQ', pageId: 'faq', idx: 2, label: 'FAQ question group 2' },
  { group: 'FAQ', pageId: 'faq', idx: 3, label: 'FAQ question group 3' },
  { group: 'FAQ', pageId: 'faq', idx: 4, label: 'No matching questions card (empty)' },

  // Legal · Terms
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 0, label: 'Terms clause card 1' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 1, label: 'Terms clause card 2' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 2, label: 'Terms clause card 3' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 3, label: 'Terms clause card 4' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 4, label: 'Terms clause card 5' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 5, label: 'Terms clause card 6' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 6, label: 'Terms clause card 7' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 7, label: 'Terms clause card 8' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 8, label: 'Terms clause card 9' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 9, label: 'Terms clause card 10' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 10, label: 'Terms clause card 11' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 11, label: 'Terms clause card 12' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 12, label: 'Terms clause card 13' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 13, label: 'Terms clause card 14' },
  { group: 'Legal · Terms', pageId: 'terms-cards', idx: 14, label: 'Terms clause card 15' },

  // Legal · Privacy
  { group: 'Legal · Privacy', pageId: 'privacy', idx: 1, label: 'Error reports change notice' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 0, label: 'Privacy section card 1' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 1, label: 'Privacy section card 2' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 2, label: 'Privacy section card 3' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 3, label: 'Privacy section card 4' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 4, label: 'Privacy section card 5' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 5, label: 'Privacy section card 6' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 6, label: 'Privacy section card 7' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 7, label: 'Privacy section card 8' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 8, label: 'Privacy section card 9' },
  { group: 'Legal · Privacy', pageId: 'privacy-cards', idx: 9, label: 'Privacy section card 10' },

  // Legal · Risks
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 0, label: 'Venue risk card 1' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 1, label: 'Venue risk card 2' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 2, label: 'Venue risk card 3' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 3, label: 'TOWELI protocol risk card 1' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 4, label: 'TOWELI protocol risk card 2' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 5, label: 'TOWELI protocol risk card 3' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 6, label: 'TOWELI protocol risk card 4' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 7, label: 'TOWELI protocol risk card 5' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 8, label: 'TOWELI protocol risk card 6' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 9, label: 'TOWELI protocol risk card 7' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 10, label: 'Protocol limits card 1' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 11, label: 'Protocol limits card 2' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 12, label: 'Protocol limits card 3' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 13, label: 'Protocol limits card 4' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 14, label: 'Protocol limits card 5' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 15, label: 'Protocol limits card 6' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 16, label: 'General DeFi risk card 1' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 17, label: 'General DeFi risk card 2' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 18, label: 'General DeFi risk card 3' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 19, label: 'General DeFi risk card 4' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 20, label: 'General DeFi risk card 5' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 21, label: 'General DeFi risk card 6' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 22, label: 'General DeFi risk card 7' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 23, label: 'General DeFi risk card 8' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 24, label: 'General DeFi risk card 9' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 25, label: 'General DeFi risk card 10' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 26, label: 'General DeFi risk card 11' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 27, label: 'General DeFi risk card 12' },
  { group: 'Legal · Risks', pageId: 'risk-cards', idx: 28, label: 'General DeFi risk card 13' },
  { group: 'Legal · Risks', pageId: 'risks', idx: 1, label: 'Experimental software banner' },

  // Contracts
  { group: 'Contracts', pageId: 'contracts', idx: 8, label: 'Relaunch closure notice' },
  { group: 'Contracts', pageId: 'contracts', idx: 9, label: 'App is a convenience notice' },

  // Home · TOWELI room
  { group: 'Home · TOWELI room', pageId: 'home', idx: 19, label: 'FAQ teaser card (TOWELI room only)' },
  { group: 'Home · TOWELI room', pageId: 'proof-of-claims', idx: 0, label: 'Do not trust, verify card (TOWELI room, once a claim is verified)' },
  { group: 'Home · TOWELI room', pageId: 'protocol-pulse', idx: 0, label: 'Live protocol pulse card (TOWELI room, only when there is activity)' },
  { group: 'Home · TOWELI room', pageId: 'protocol-stats', idx: 0, label: 'Protocol stat tile 1' },
  { group: 'Home · TOWELI room', pageId: 'protocol-stats', idx: 1, label: 'Protocol stat tile 2' },
  { group: 'Home · TOWELI room', pageId: 'protocol-stats', idx: 2, label: 'Protocol stat tile 3' },
  { group: 'Home · TOWELI room', pageId: 'protocol-stats', idx: 3, label: 'Protocol stat tile 4' },
  { group: 'Home · TOWELI room', pageId: 'protocol-stats', idx: 4, label: 'Protocol stat tile 5' },
  { group: 'Home · TOWELI room', pageId: 'protocol-stats', idx: 5, label: 'Protocol stat tile 6' },
  { group: 'Home · TOWELI room', pageId: 'real-yield-proof', idx: 0, label: 'Real yield status card (distribution read failed, or nothing paid…)' },
  { group: 'Home · TOWELI room', pageId: 'real-yield-proof', idx: 1, label: 'Real yield stat tile 1' },
  { group: 'Home · TOWELI room', pageId: 'real-yield-proof', idx: 2, label: 'Real yield stat tile 2' },
  { group: 'Home · TOWELI room', pageId: 'real-yield-proof', idx: 3, label: 'Real yield stat tile 3' },

  // Admin
  { group: 'Admin', pageId: 'birth-queue-panel', idx: 0, label: 'Birth notifications card' },
  { group: 'Admin', pageId: 'integrator-fees', idx: 0, label: 'Launcher integrator fees card' },
];

export const surfaceKey = (s: Pick<Surface, 'pageId' | 'idx'>) => `${s.pageId}:${s.idx}`;

// Parse "X% Y%" or "center 30%" into [x, y] percent (0-100). Returns
// [50, 50] for unrecognized strings so the sliders have a sensible default.
export function parsePosition(pos?: string): [number, number] {
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
export const formatPosition = (x: number, y: number) => `${x}% ${y}%`;

export function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
