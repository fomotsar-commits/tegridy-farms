# Agent 074 — Responsive / iOS / iPad Audit (AUDIT-ONLY)

## Scope
- `frontend/src/index.css` (full read, 798 lines)
- `frontend/src/styles/` (DOES NOT EXIST — only `index.css` at root)
- `frontend/src/pages/*.tsx` (25 pages) + `frontend/src/components/**/*.tsx` (~80 components)
- Hunt patterns: `100vh`, `100dvh`, `safe-area-inset`, `@media`, `min-width`, `max-width`, `vw`, `overflow-x-hidden`, `min-h-screen`, `text-[Npx]`, `fixed`.

## Counts
- `100vh` occurrences: **14** (across 9 files)
- `100dvh` occurrences: **0** — ZERO USES (every full-viewport surface has the iOS overflow bug)
- `min-h-screen` (Tailwind = `min-height: 100vh`): **38** matches in 22 files (every page wrapper)
- `safe-area-inset` references: 7 (3 in `index.css`, 4 in components — TopNav banner, Towelie, MobileNav, BottomNav via `.safe-area-bottom`)
- `viewport-fit=cover`: PRESENT (`frontend/index.html:18`)
- `@media` queries in `index.css`: **7** total (only `(max-width: 767px)`, `(hover: hover)`, `(prefers-reduced-motion)`, `print`)
- Tailwind responsive prefixes (`md:` / `sm:` / `lg:` / `xl:`) total occurrences: **1156** across 81 files
- Pages with `min-h-screen`: 22 (HomePage, DashboardPage, FarmPage, TradePage, TreasuryPage, ContractsPage, SecurityPage, etc.)
- Pages using ONLY `md:` breakpoint (=768px) without `sm:` fallback for iPad mini (744px): MANY (TokenSelectModal, multiple page wrappers)
- `overflow-x-hidden` / `max-w-screen` defensive clipping: **0 USES** (only `body { overflow-x: hidden }` in index.css line 167 — single line of defense)
- Touch targets `min-h-[44px]` correctly applied: 13 components (StakingCard, NFTLendingSection, LendingSection, LPFarmingSection, Modal, TopNav hamburger). BottomNav uses `min-h-[48px]` ✓.
- Touch targets MISSING `min-h-[44px]`: Footer links, nav-link in `index.css` (only `padding: 6px 14px` ≈ 30px tall — fails Apple HIG), inline icon buttons throughout
- Tiny text sizes under 16px (iOS auto-zoom risk on inputs): **1156 occurrences** of `text-[8px..15px]` / `text-xs` — though `index.css:151` force-overrides inputs to `font-size: max(16px, inherit)` ✓ (mitigation present)
- Fixed-position elements in mobile nav region: BottomNav (`fixed bottom-0`), TowelieAssistant (`fixed bottom-20 md:bottom-4`), wrong-network banner (`fixed top-14`)

---

## Top-5 Device-Specific Breaks (HIGH severity first)

### 1. [HIGH] `100vh` / `min-h-screen` everywhere — iOS Safari URL bar overflow
**0 uses of `100dvh` in entire codebase.** Every page wrapper uses `<div className="-mt-14 relative min-h-screen">` (22 pages). On iOS Safari ≤16 (and even 17 in some viewports), `100vh` includes the URL bar height — content is cropped or scrolls awkwardly, and BottomNav can be obscured by the dynamic toolbar. Affected:
- `frontend/src/index.css:166` — `body { min-height: 100vh; }` (the global root)
- `frontend/src/components/GlitchTransition.tsx:291` — `height: '100vh'` in fixed canvas (overlay over notch)
- `frontend/src/components/swap/TokenSelectModal.tsx:248` — `maxHeight: 'calc(100vh - 160px)'`
- `frontend/src/pages/ArtStudioPage.tsx:431` — `max-h-[calc(100vh-100px)]`
- `frontend/src/nakamigos/components/FilterSidebar.jsx:35` — `height: "100vh"`
- `frontend/src/nakamigos/components/OnChainProfile.jsx:270` — `height: "100vh"`
- `frontend/src/nakamigos/App.css:135,841` — `min-height: 100vh; max-height: calc(100vh - 48px)`
- `frontend/src/nakamigos/components/VirtualGalleryGrid.jsx:154,168,185` — `calc(100vh - 200px)` (3x)
- `frontend/src/nakamigos/components/NotificationCenter.jsx:460` — `calc(100vh - 80px)`

**Fix:** Add fallback CSS variable `--vh100: 100vh` then `@supports (height: 100dvh) { :root { --vh100: 100dvh; } }` and replace all `100vh` with `var(--vh100)`. Or simply `min-h-[100dvh]` Tailwind arbitrary value.

### 2. [HIGH] iPad mini (744px) hits md-only breakpoint cliff
The codebase uses `md:` (Tailwind default = 768px) almost exclusively for desktop-vs-mobile layouts. `BottomNav` (`md:hidden`) and `TopNav` (`hidden md:flex` for desktop nav at line 138) flip at 768px, but **iPad mini portrait is 744px wide** — so it gets the mobile layout including BottomNav, which is wrong. iPhone 14+ Pro Max (430px) is fine, but iPad mini falls into "phone mode" with cramped 5-tab bottom nav and hamburger TopNav. No `@media (min-width: 744px)` or `sm:` (640px) intermediate strategy. `frontend/src/components/layout/BottomNav.tsx:47`, `frontend/src/components/layout/TopNav.tsx:138,310`. Many grid layouts also collapse straight from 1-col → 4-col at md (`pages/TreasuryPage.tsx:159`, `pages/TokenomicsPage.tsx:65`).

### 3. [HIGH] `nav-link` desktop touch target = ~30px (fails Apple HIG 44px)
`frontend/src/index.css:370-380` — `.nav-link { padding: 6px 14px; font-size: 14px; }`. With 14px line-height that's ~26-30px tall. The mobile-only override at `index.css:155-159` only bumps `.btn-primary, .btn-secondary, .btn-gold` to 44px — does NOT touch `.nav-link`. So the TopNav links and hamburger drawer items fail iOS minimum tap target requirements. Hamburger button itself is correctly `min-w-[44px] min-h-[44px]` (TopNav.tsx:310) ✓ but the inline links inside the drawer are not. Footer links (`components/layout/Footer.tsx`) also have no min-height enforcement.

### 4. [HIGH] No defensive `overflow-x-hidden` on page containers — horizontal scroll risk
Only `body { overflow-x: hidden }` in `index.css:167` guards the entire app. Zero `max-w-screen` or `overflow-x-hidden` on the 22 page-level `<div className="-mt-14 relative min-h-screen">` wrappers. Combined with `-mt-14` pulling content under TopNav, any descendant that overflows (long token addresses, contract IDs, SVG charts, monospace prices, untranslated text) will trigger horizontal scroll on the page level even though the body clips. Particularly risky on:
- `pages/ContractsPage.tsx` (24 `text-xs` instances of long addresses)
- `pages/HistoryPage.tsx` (27 small-text instances of tx hashes)
- `pages/ActivityPage.tsx` (whitespace-nowrap usage with no parent overflow guard)
- ParticleBackground / Background canvas (line 1 of `Background.tsx` — verify no horizontal bleed)

### 5. [MEDIUM] BottomNav clashes with iOS home indicator + TowelieAssistant overlap
`frontend/src/components/layout/BottomNav.tsx:47-54` uses `.safe-area-bottom` (correct — pads bottom by `env(safe-area-inset-bottom, 0px)`). BUT:
- BottomNav height is fixed `h-16` (64px) + safe area, while `AppLayout.tsx:123` uses `pb-20` (80px) — only 16px clearance over a 64px nav, with no buffer for iOS's 34px home indicator. On iPhone 14 Pro: 80 - 64 - 34 = -18px, content hides BEHIND BottomNav.
- TowelieAssistant is `fixed bottom-20 md:bottom-4` (`TowelieAssistant.tsx:295`) → on mobile, `bottom: 80px` puts it RIGHT ON TOP of BottomNav (also at bottom 0-64px+safearea). The Towelie chat bubble FAB will overlap the rightmost BottomNav tab (Tradermigos) on iPhone 14.
- Wrong-network banner is `fixed top-14` (line 107) and uses safe-area-inset-LEFT/RIGHT but NOT TOP. iPhone 14 Pro Dynamic Island (54-59px from top) eats into top:56px → banner under the island.

---

## Other Notes (LOW / INFO)
- `index.css:131-140` defines `.safe-area-bottom` and `.pb-safe` correctly using `env(safe-area-inset-bottom, 0px)` — good baseline.
- `index.html` viewport meta has `viewport-fit=cover` ✓ (verified the TODO comment in `index.css:136` is actually satisfied).
- Reduced motion media query is properly handled (`index.css:685-695`).
- Mobile glass-card backdrop-blur removed for performance (`index.css:234-239`) — good iOS battery decision.
- `nakamigos/App.css` is a large legacy stylesheet (4400+ lines) with 84 media queries — uses 360/390/480/600/640/680/767/768/810/900/1024 breakpoints (rich coverage), but it's siloed to the `/nakamigos` sub-app. The MAIN app (luxury purple shell) has just **7 media queries**.
- `min-h-screen` is on TWENTY-TWO pages — fixing this is a single-Tailwind-class find/replace to `min-h-[100dvh]` once supported.

## Suggested Remediations (NOT done — audit only)
1. Add `:root { --app-vh: 100dvh; }` with `100vh` fallback; replace `min-h-screen` → `min-h-[var(--app-vh)]` or use Tailwind `min-h-dvh` plugin (Tailwind v4 supports `dvh` natively).
2. Bump TopNav nav-link `min-height: 44px` in `index.css`.
3. Add `overflow-x-hidden` to every page wrapper or to `main#main-content` in `AppLayout.tsx:124`.
4. Move TopNav md:hidden breakpoint to `min-width: 820px` (or use `lg:`) so iPad mini & iPad portrait get desktop nav.
5. Bump `pb-20` → `pb-[calc(5rem+env(safe-area-inset-bottom))]` on `AppLayout.tsx:123` and shift TowelieAssistant `bottom-20` → `bottom-24` on mobile to clear BottomNav + home indicator.
6. Move wrong-network banner to use `top: max(56px, env(safe-area-inset-top))` for Dynamic Island clearance.
