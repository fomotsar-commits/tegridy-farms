# Front-End Audit — 2026-05-27

**Method:** 3 parallel browser-automation agents (Claude-in-Chrome extension) walking every
route on the running dev server (`http://localhost:5173`). Each agent inspected DOM /
accessibility tree, console (errors + warnings), network (4xx/5xx, slow, duplicate), and
attempted desktop / iPhone-14+ / iPad viewports.

**Scope:** ~30 routes across the React + Vite app, partitioned:
- **Agent A — Trade & Data:** `/`, `/farm`, `/swap`, `/liquidity`, `/dashboard`, `/history`, `/leaderboard`, `/premium`
- **Agent B — NFT surfaces:** `/gallery`, `/nft-finance`, `/nakamigos/*`, `/art-studio`, `/admin`
- **Agent C — Info & Community:** `/tokenomics`, `/lore`, `/faq`, `/security`, `/terms`, `/privacy`, `/risks`, `/contracts`, `/treasury`, `/changelog`, `/community`, all redirects, 404

> ⚠️ **VIEWPORT CAVEAT — read before triaging mobile/iPad rows.** The host runs an ultrawide
> (3440×1392) and every `resize_window` call returned success but the OS window stayed at
> 3432 px wide (`window.innerWidth` confirmed). This is the classic symptom of a **maximized**
> Chrome window — `chrome.windows.update({width,height})` silently no-ops on a maximized window.
> **Mobile (390) and iPad (1024) findings below are CSS/structure-derived, NOT visually
> verified.** A re-run is queued: restore-down (un-maximize) the Chrome window first, then the
> agents can hit true narrow viewports.

---

## Tally

| Agent | CRIT | HIGH | MED | LOW | PERF |
|-------|:----:|:----:|:---:|:---:|:----:|
| A — Trade & Data | 1 | 9 | 22 | 7 | 6 |
| B — NFT surfaces | 1 | 9 | 11 | 6 | 2 |
| C — Info & Community | 0 | 4 | 11 | 24 | 5 |
| **Total** | **2** | **22** | **44** | **37** | **13** |

**118 issues total.**

---

## Fixed in this session (2026-05-27)

- ✅ **[HIGH] `fetchpriority` → `fetchPriority`** — `frontend/src/nakamigos/components/NftImage.jsx:167`.
  React DOM warning fired on every Nakamigos render. Now camelCase. (tsc clean)
- ✅ **[CRIT] `/nft-finance` disconnected tabs** — `frontend/src/pages/LendingPage.tsx`.
  All 4 tabs (Token Lending / NFT Lending / NFT AMM / Launchpad) rendered the identical
  generic `<ConnectPrompt surface="lending">` when disconnected, so switching tabs looked
  broken. Added `SECTION_PROMPTS` map; each section now shows distinct title/description. (tsc clean)

## Open — needs decision

- 🔲 **[CRIT] `/premium` Gold Card icon shows a cat photo** — the icon (`<ArtImg pageId="premium" idx={1}>`)
  resolves via `frontend/src/lib/artOverrides.ts:125` → `"premium:1": { artId: "iph_0177" }`
  (`/art/iphone/IMG_0177.jpg`). **This is a deliberate art-studio override, not a code bug.**
  Per the never-swap-art rule it was NOT auto-changed. Decision needed: repoint `premium:1`
  (via the art studio, so the running dev middleware doesn't clobber it) to a gold/brand asset,
  or keep as-is. The `<img>` also has `alt=""` → a11y-invisible regardless.

---

## CRITICAL

1. **`/premium` Gold Card icon = cat photo** — see "Open" above. Source: `artOverrides.ts:125`.
2. **`/nft-finance` tabs non-functional when disconnected** — ✅ FIXED. `LendingPage.tsx:191`.

---

## HIGH (by page)

### Landing `/`
- `ETH Distributed` stat tile shows its label but **no value** (sibling tiles render values) — broken data binding.
- `Base APR: >9999%` shown next to `TVL: 100 TOWELI` — mathematically meaningless / looks like a leaked debug value. Cap or hide until pool is bootstrapped.

### `/farm`
- ~2 viewport-heights of **empty background art** between the pre-connect hero and footer. No pool preview / TVL / APR for unconnected visitors → page reads as broken. (Shared "dead-page" pattern across `/farm`, `/swap`, `/liquidity`, `/dashboard`, `/history`.)

### `/dashboard`
- Pre-connect hero: full-bleed busy art with the `Connect Wallet` pill faint over a soldier's face → poor CTA contrast. Add a 35–50% scrim.
- ~1.5 viewports of pure background art below hero, no portfolio preview / demo data / skeleton.

### `/premium`
- All 4 plan cards (1M/3M/6M/1Y) show literal `—` instead of prices; `TOTAL COST: …` / `MONTHLY FEE: …` show three-dot placeholders. Looks frozen — needs skeleton or computed values. (NB: page code has BigInt-derived `…`/Skeleton fallbacks; this fires when `premium.monthlyFee === 0n`, i.e. contract data didn't load — verify the read path / RPC.)

### `/gallery`
- First paint shows 6+ empty card outlines — cards use `whileInView opacity:0→1`, so above-the-fold cards start invisible. `frontend/src/pages/GalleryPage.tsx:109-110`. Use `animate` for the top fold or initial opacity ~0.4.
- Lightbox image not visible after click — modal opens (`dialog "Naka #01"`) but image renders transparent/behind backdrop; only prev/next/close reachable. Check `frontend/src/components/ui/ArtLightbox.tsx` z-index.

### `/nft-finance`
- Full-screen bg art (`IMG_0169.jpg`, 1280px source upscaled 2.7× to 3422px via `object-cover`, `LendingPage.tsx:82-84`) crushes contrast on the white headline + intro card once it paints.

### `/nakamigos/*`
- **Network flood:** opening `/nakamigos/nakamigos` fires **1000+ pending GETs** to `/api/alchemy?endpoint=getNFTMetadata&tokenId=N` (one per token). Console: `Alchemy API unavailable, using fallback: signal is aborted without reason`. Batch via `getNFTMetadataBatch`.
- Splash ("CLICK TO ENTER") **replays on every fresh entry** — `splashDone` is component state only (`frontend/src/nakamigos/App.jsx:157-159`). Hits hard-refresh, deep-link, and even invalid sub-routes.
- ✅ **`Invalid DOM property 'fetchpriority'`** — FIXED (`NftImage.jsx:167`).
- Sub-route page titles wrong — `/nakamigos/nakamigos`, `/art-studio` etc. show default `Tegridy Farms | TOWELI Yield Farm` during initial render (`App.jsx:144,280,298` run after splash).
- First-time-user **tour modal overlays the 404 page** when visiting an invalid sub-route (e.g. `/nakamigos/nakamigos/offers`).

### `/admin`
- Triple overlay on cold visit: onboarding `Welcome to Tegridy Farms` dialog + privacy banner + admin connect-card all at once; dialog overlaps the admin card text.

### `/faq`
- Subtitle + all 6 section headers (`GETTING STARTED`, `STAKING`, …) render faint over bright pink/anime art → **near-invisible** (desktop + iPad). The category structure disappears. Add a scrim or solid-bg pills.

### `/treasury`
- (Mobile, unverified) TVL + Lifetime Fees render `—` with a "Price oracle is stale" banner that did **not** appear on desktop in the same session — possible mobile/iframe fetch parity gap. Reproduce on a real iPhone 14.

---

## MEDIUM (by page)

### `/` Landing
- `TVL: 100 TOWELI` shown in token units, not USD — confusing on a new-user landing.
- First-visit splash runs ~22s with multiple art transitions, no Skip/ESC; also fires globally on deep-links for any user without the splash-done flag.
- Cookie/privacy consent banner overlaps body content while scrolling.
- Towelie chat chip covers footer/CTA; its `X` is ~10px (too small).
- 16 `<img>` with empty/missing `alt`.

### `/swap` + `/liquidity`
- Swap card left-aligned at ~700px on an ultrawide → huge empty right side. Center it or add sidebar.
- Disconnected `Swap` tab: only "Connect your wallet to swap" + low-contrast button; no pair preview / chart / slippage preview.
- `Recurring Swap` (DCA) tab: background art bleeds **through** the card; form text hard to read. Raise card backdrop opacity (~0.5 → ~0.85) or add blur.
- `/liquidity` Connect button very low-contrast (looks disabled); "Pull Crop Out" tab worse — art washes the copy.
- `/swap` and `/liquidity` resolve to identical UI under two URLs — pick one canonical.

### `/history`
- "Transaction History" headline + subtitle wash into busy ape art — contrast. Tab bar (Points/Gold Card/History/Changelog) floats over art, reads as page-nav not section-nav.

### `/leaderboard`
- URL `/leaderboard` but title/content is "Your Tegridy Score" (personal points, not a global leaderboard). Either wrong component mounted or wrong route name.
- "All Badges" tiles degrade to dark-on-dark / illegible once the bear art takes over on scroll.

### `/premium`
- "Revenue Sharing" benefit tile rendered dimmed vs others with no tooltip — looks disabled; add "Coming soon" if intentional.
- Splash fires on this deep-link route when localStorage cleared (22s before content).

### `/gallery` / `/nft-finance` / `/nakamigos`
- `/nft-finance` intro card 3 ("NFT AMM") frequently shows black/empty image while cards 1–2 render — verify `pageArt('nft-finance', 3)` asset/path.
- `/nakamigos` first listings: ~26 empty border-only placeholders for ~5s before images populate; 2 thumbnails (#1640, #9351) render as black boxes (OpenSea CDN miss, no `onError → PLACEHOLDER` fallback).
- `/nakamigos` Traits: "TOKENS LOADED 40 of 20,000" yet per-trait % read like full-supply rarity — add "approximated from sample" tooltip or load full distribution first.

### `/art-studio`
- Page title falls back to global default (no `usePageTitle('Art Studio')`).
- First paint loads 56 images simultaneously (no `loading="lazy"` on the inner Pick-art thumbs).

### `/admin`
- After dialogs dismissed: just a small connect-card over huge bg art; no preview of what admin looks like, footer hidden behind image.

### Info pages (C)
- `/tokenomics`: metric cards (TOKEN/SUPPLY/PRICE/FDV) overlay busy character art with no scrim → glance-readability hit (desktop + mobile). Supply-distribution donut center blends with bg.
- `/lore` (mobile): hero subtitle faint over banana art band; double-overlay (welcome modal + telemetry banner) on first visit.
- `/security`: skull bg art lowers contrast on subtitle; audit link label says "May 4" but file path is `PASS7_2026_05_03.md` (off-by-one date).
- `/terms`: footer "Last updated: April 2026" — stale (today 2026-05-27).
- `/changelog`: most recent entry **May 4, 2026** — 23 days stale despite MVP-launch / V4-migration / fresh-look audit work since.
- `/community`: "Community" subtitle overlaid on skull art's white teeth — low contrast.
- `/tokenomics` (mobile): header logo / "Tradermigos" / "Connect" visually touch (0px gap) — reads as "TradermigosConnect".

---

## LOW (selected — full list in agent appendix)

- `/gallery`: no filter/sort/search for 54 items; outer cards use `role="button"` not semantic `<button>`.
- `/leaderboard`: empty-state copy has no CTA link to `/farm`; tab strip mixes unrelated concerns (Changelog, Gold Card under "points").
- `/nakamigos`: `/offers`, `/orders` 404 despite related components on disk; black-bar GlitchTransition flash for ~3s after splash.
- `/art-studio`: 25+ surface-list buttons have no accessible name; writable `/art-studio` route ungated (dev-only, but confirm it's stripped from prod).
- Info pages: `/terms`, `/privacy`, `/risks` heroes render dim/translucent → look unloaded. Several pages publicly print internal repo file paths (`FIX_STATUS.md`, `frontend/src/pages/PrivacyPage.tsx`, etc.) — confirm intended.
- `/privacy` "Last updated: April 19, 2026", `/risks` faint hero, `/contracts` exposes `contracts/src/*.sol` paths.
- Floating "Towelie" pill overlaps the "Protocol Active" badge and clips right-edge content on mobile across many pages; suppress on legal/policy pages.
- 404 page: onboarding "Welcome" modal + consent banner both fire on a dead-link landing — suppress welcome on 404 route.
- `/treasury`: block number shown with no relative timestamp; "Recent Treasury Transactions" still a "Coming soon" placeholder.

---

## PERFORMANCE / INEFFICIENCY (cross-cutting)

- **Dead RPCs in fallback chain:** `eth.llamarpc.com` → 503 and `eth.merkle.io` → 429/503 on essentially every page load; only `ethereum-rpc.publicnode.com` + `rpc.ankr.com` return 200. Each failed POST adds latency before failover. Drop the dead endpoints or demote to last-resort.
- **WalletConnect on every page:** `pulse.walletconnect.org` / `api.web3modal.org` fire on pure-content pages where the user has no connect intent. Lazy-load the wagmi/walletconnect bundle behind the Connect button.
- **Vite `HEAD /<route>` returns 503** across all routes (GET is 200). Breaks OG/Twitter/Discord/Slack link unfurls that HEAD before GET. Deploy-preflight gotcha.
- **`/gallery`** loads 54 full-quality images (~8 MB on full scroll, 47–285 KB each) at fixed `width/height={800}` with no responsive `srcset` — mobile gets the desktop payload.
- **`/nakamigos`** 1000+ per-token metadata requests (see HIGH).
- **`/art-studio`** 56 images loaded at once on first paint.
- **`/nft-finance`** single heavy `IMG_0169.jpg` (2000px) served as both full-screen bg and a 374px intro-card thumb — no responsive set.
- Console noise: `Lit is in dev mode` (dev only — confirm stripped in prod).

---

## Cross-cutting themes (prioritized)

1. **"Dead page" pre-connect state** on every transactional surface (`/farm`, `/swap`, `/liquidity`, `/dashboard`, `/history`): 1–2 viewports of background art, no preview/demo data. Highest-leverage UX fix — show pools/positions/sample data to logged-out visitors.
2. **Art-over-text contrast.** Background art bleeds through cards/headers on many pages (`/faq` worst, then `/tokenomics`, `/security`, `/community`, DCA tab, `/history`). Needs a consistent scrim/backdrop token applied to text containers. (Do additively per preserve-art rule — darken the text container, don't remove art.)
3. **Splash/onboarding over-fires.** Long landing splash (22s, no skip), Nakamigos splash on every entry, welcome modal on 404, double overlays (modal + consent banner) on first visit.
4. **Stale content / dates.** Changelog (23d), terms ("April 2026"), privacy ("April 19"), security audit off-by-one date.
5. **Wrong `document.title`** on `/art-studio` and during Nakamigos sub-route render.
6. **RPC + network hygiene** (see PERF).
7. **A11y baseline:** many empty `alt`, unnamed buttons, small tap targets (Towelie X, footer links), hover-only affordances unverified on touch.

---

## Re-run checklist (queued)

1. Reconnect Chrome (extension showed connected during the audit, dropped after).
2. **Restore-down / un-maximize** the Chrome window so OS resize works.
3. Relaunch the 3 agents to visually verify the mobile (390) + iPad (1024) rows above —
   especially: `/treasury` mobile oracle-banner parity, `/tokenomics` mobile header collision,
   tap-target sizes, and hover-only affordances on touch.

---

## Re-pass: mobile + iPad verified (2026-05-30)

The original pass couldn't actually drive sub-1287 viewports because the test window was maximized
AND because Chrome on Windows has an OS-level minimum window width that the MCP extension's
`resize_window` can't go below. The fix turned out to be **Chrome DevTools Device Mode**
(F12 → Ctrl+Shift+M → iPhone 14 Pro / iPad Mini) — only DevTools-level emulation overrides the
viewport at the rendering layer so CSS `@media` queries actually fire. With that working, the full
mobile + iPad sweep ran and produced:

| Viewport | CRIT | HIGH | MED | LOW | PERF |
|---|:---:|:---:|:---:|:---:|:---:|
| Mobile (iPhone 14 Pro 390×844) | 0 | 10 | 8 | 2 | 1 |
| iPad (iPad Mini 768 portrait) | **1** | 5 | 13 | 5 | 2 |

### Refutations (no longer accurate)
- `/treasury` `—` TVL + "Price oracle is stale" banner is **NOT mobile-specific** — same on desktop.
  It's a data state from `eth.merkle.io` HTTP 429 RPC throttling, not a viewport regression.
- **Towelie pill ×** is **44×44 with `aria-label="Dismiss Towelie"`** — the prior pass's structural
  ~10px concern was based on stale data; the current code is correct.

### Verified-in-browser ✅
- `/premium` Gold Card icon = gold credit-card SVG glyph (NOT cat photo)
- `/nft-finance` 4 disconnected tabs each show a distinct ConnectPrompt string
- Nakamigos console has no React `fetchpriority` warning

### Highest-leverage new issues
- **Header collision on every global-header page** — the desktop `Tradermigos` link `hidden md:block`
  failed to hide at 390 (CSS specificity) AND overflowed its 50px slot at 768 (iPad portrait),
  visually bleeding under the Connect button. **Fixed in same commit** (see below).
- **`.nav-link` had no `white-space: nowrap`** → "NFT Finance" wrapped to 2 lines at iPad portrait,
  breaking row height alignment. **Fixed in same commit.**
- **CRIT** — `/changelog` body text essentially invisible over the jungle-ape orange/yellow art
  panel at iPad. Scrim was 0.55 + 2px blur, not enough vs the bright bg. **Fixed in same commit.**
- **Body-text contrast over bg-art** — recurring on `/faq`, `/security`, `/risks`, `/terms`,
  `/privacy`, `/lore` at both viewports. Needs the same scrim bump (deferred — single-pattern fix).
- **Floating "Protocol Active" pill** overlaps content on `/treasury` Balance, `/lore` body,
  `/nft-finance` disclaimer, `/community` footer, home Core-Loop card 4. Bottom-collision detection
  or hide-on-info-pages needed.
- **`/swap` + `/liquidity`** "Recurring Swap" / "Price Alert" labels overflow tab buttons at 390.
- **`/nakamigos`** custom-header `Connect` clipped 43px off-screen at 390 (custom header doesn't
  responsive-shrink).
- **3-col stats-grid orphan** on `/tokenomics`, `/treasury`, `/community` — 4 cards in `grid-cols-3`
  leaves an iPad-only middle-breakpoint orphan. Standardize on `grid-cols-2 md:grid-cols-4`.

### Fixed in commit 2026-05-30 (this pass)
1. `frontend/src/components/layout/TopNav.tsx` — Tradermigos NavLink `hidden md:block` → `!hidden lg:!flex`.
   Hides at mobile + iPad (BottomNav already carries Tradermigos for those viewports), only shows
   at true desktop ≥1024 where there's space. `!` prefix forces through any nav-link selector override.
2. `frontend/src/index.css` — added `white-space: nowrap` to `.nav-link` to stop multi-word labels
   wrapping at iPad portrait.
3. `frontend/src/pages/ChangelogPage.tsx` — entry-card scrim bumped `rgba(0,0,0,0.55)` →
   `rgba(0,0,0,0.85)` and blur 2px → 4px so changelog body copy reads against bright bg art.

### Outstanding (recommended next commits)
- Apply the same scrim pattern to `/faq`, `/security`, `/risks`, `/terms`, `/privacy`, `/lore`.
- `grid-cols-3` → `grid-cols-2 md:grid-cols-4` on the 3 affected stats grids.
- Floating Protocol Active pill: bottom-collision logic or hide on info routes.
- `/swap` `/liquidity` tab label fit at 390.
- `/nakamigos` custom-header responsive fit.

---

## Appendix — full per-agent reports

The complete per-page / per-viewport detail (every LOW item, exact selectors, repro steps) is in
the audit session transcript. The bodies above consolidate and de-duplicate the three agents'
findings; nothing was dropped, but near-identical cross-page items (e.g. the Towelie-pill overlap,
the HEAD-503, the RPC failures) were merged into the cross-cutting / PERF sections.
