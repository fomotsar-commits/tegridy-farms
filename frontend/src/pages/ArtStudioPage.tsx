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
  // Bumped after each successful save → iframe key changes → forces reload
  // so the live preview reflects what just got written to disk.
  const [iframeNonce, setIframeNonce] = useState(0);
  const [autoSave, setAutoSave] = useState(true);

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
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5"
            >
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
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
          <section className="bg-white/5 rounded-lg border border-white/10 overflow-hidden">
            <div className="px-4 py-2 border-b border-white/10 flex items-center gap-3 flex-wrap">
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
              {selectedOverride && (
                <button
                  onClick={clearOverride}
                  className="text-[10px] px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 border border-red-500/30"
                >Clear override</button>
              )}
            </div>

            {previewMode === 'art' ? (
              <>
                <div className="h-[45vh] max-h-[500px] bg-black relative overflow-hidden">
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
                <div className="p-4 space-y-2">
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

// In-context preview — iframes the actual app route where the surface lives.
// Reflects what's currently saved to disk (drafts apply only after Save).
function LivePreview({ pageId, nonce }: { pageId: string; nonce: number }) {
  const route = PAGE_ROUTES[pageId];
  if (!route) {
    return (
      <div className="h-[55vh] flex items-center justify-center text-xs text-white/50 p-4 text-center">
        No route mapping for <code className="mx-1 px-1 bg-white/10 rounded">{pageId}</code> yet.
        Add it to <code className="mx-1 px-1 bg-white/10 rounded">PAGE_ROUTES</code> in ArtStudioPage.tsx.
      </div>
    );
  }
  // Cache-bust the iframe URL on each save so it reloads with fresh overrides.
  const url = `${route}?_studio=${nonce}`;
  return (
    <div className="bg-black relative">
      <div className="px-3 py-1.5 border-b border-white/10 flex items-center gap-2 text-[10px] text-white/60">
        <span>Loading: {route}</span>
        <span className="text-white/30">·</span>
        <span>Save your pick to see it land here</span>
        <a
          href={route}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-emerald-400 hover:underline"
        >Open in new tab ↗</a>
      </div>
      <iframe
        key={`${route}-${nonce}`}
        src={url}
        title={`Live preview: ${route}`}
        className="w-full h-[60vh] bg-black border-0"
        loading="lazy"
      />
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
