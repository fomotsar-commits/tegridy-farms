# Audit 098 — Frontend Bundle Size & Runtime Performance

**Agent:** 098 / 101
**Scope:** `frontend/package.json`, `frontend/dist/*`, `frontend/vite.config.ts`, top-level imports across `frontend/src/`
**Mode:** AUDIT-ONLY (no code changes)
**Date:** 2026-04-25

---

## Executive Summary

Total `frontend/dist/` = **71 MB** (assets dir 42 MB; static images 27 MB).
Asset chunk count: **529 files** (224 are `.js.map` source maps shipped to prod).
Top JS bundle (un-gzipped) is **`vendor-wagmi` at 1.93 MB** + **`LendingPage` at 1.30 MB** — both shipped on a slow lazy boundary.

Counts:
- Heavy deps eagerly imported: **3** (wagmi, viem, ethers — used side-by-side)
- Routes lazy-loaded: 18/18 (good — all routes use `React.lazy`)
- Source-maps in production dist: **224** (33 MB extra payload, leaks code)
- `src/assets/`: **empty** (good — assets in `/public`)
- `dist/` images > 1 MB: **1** (`art/smoking-duo.jpg` 1.04 MB)
- `dist/` images > 500 KB: **4** (smoking-duo, beach-sunset, jb-christmas, IMG_0137)

---

## Top-5 Size Hogs (uncompressed JS, prod build `dist/assets/`)

| Rank | Chunk | Size | Notes |
|------|-------|-----:|-------|
| 1 | `vendor-wagmi-2OeF4ja9.js` | **1,933,859 B** (~1.93 MB) | wagmi + RainbowKit. Includes `metamask-sdk` (541 KB extra side-chunk) and walletconnect side-chunks. Eagerly loaded via `WagmiProvider` in `App.tsx`. |
| 2 | `LendingPage-Dd8NVtV9.js` | **1,301,288 B** (~1.30 MB) | Lazy-routed but the page eagerly imports all four big sections at module top (`LendingSection.tsx` 1816 LOC, `NFTLendingSection.tsx` 1065 LOC, `AMMSection.tsx` 2652 LOC, `LaunchpadSection.tsx` 222 LOC = 5,755 LOC pulled in even when user only opens one tab). |
| 3 | `vendor-viem-CJTNXHKF.js` | **793,922 B** (~0.79 MB) | viem core. OK as a vendor split. |
| 4 | `App-BjVrMUiD.js` | **736,211 B** (~0.74 MB) | App entry — large because `wagmi`, `RainbowKitProvider`, `QueryClient`, `framer-motion`/LazyMotion, theme + storage all bootstrap synchronously. |
| 5 | `metamask-sdk-D5Hd9Hje.js` | **541,445 B** (~0.54 MB) | Metamask SDK. Pulled by RainbowKit/wagmi connectors. Most users never need it (most have the extension already). |

Honorable mentions: `vendor-crypto` 413 KB (`@noble`/`@scure`), `lib.esm` 333 KB (likely ethers v6), `core` 325 KB (rainbowkit core), `vendor-recharts` 311 KB (charts), `index.es` 279 KB, CSS bundle 232 KB.

---

## Findings

### CRITICAL / HIGH

**[H1] Source maps are shipped to production (224 `.js.map` files, ~33 MB extra payload).**
`vite.config.ts` line 176: `sourcemap: 'hidden'`. The `'hidden'` mode does not embed the `//# sourceMappingURL=` comment but **the `.map` files are still emitted into `dist/` and Vercel serves them**. Anyone who fetches `vendor-wagmi-2OeF4ja9.js.map` gets full deobfuscated source. Largest examples:
- `LendingPage-Dd8NVtV9.js.map` 4.35 MB
- `vendor-wagmi-2OeF4ja9.js.map` 3.57 MB
- `vendor-viem-CJTNXHKF.js.map` 2.99 MB
- `App-BjVrMUiD.js.map` 2.43 MB
- `vendor-crypto-Dab_BKVa.js.map` 1.99 MB
**Fix:** either set `sourcemap: false` for prod, or upload maps to an error-tracker and delete them from `dist` post-build (rsync `--exclude '*.map'` to CDN). Otherwise ship a Vercel `vercel.json` rewrite that 404s `*.map`.

**[H2] Both `ethers` AND `viem` shipped in the same bundle.**
`package.json` declares `"ethers": "^6.16.0"` AND `"viem": "^2.47.6"`. 49 source files import from `'ethers'`. The 333 KB `lib.esm-aTPcUk0T.js` chunk is ethers v6's ESM build sitting alongside the 794 KB viem chunk. Wagmi v2 only requires viem; ethers is duplicated functionality. Used in: `useSwap.ts`, `usePoolData.ts`, `useFarmActions.ts`, all hooks that pre-date the wagmi v2 migration. Migrating these 49 files to viem alone would save **~333 KB** plus dedupe `@noble`/`@scure` overlaps.

**[H3] LendingPage eagerly imports 4 large sections (1.30 MB single chunk).**
`pages/LendingPage.tsx` lines 7–10 do top-level `import` of all four sections. The page UI is tabbed (`'lending' | 'nftlending' | 'amm' | 'launchpad'`) — only one section is visible at a time. Refactor to `lazy(() => import('../components/nftfinance/AMMSection'))` per section would split the chunk into 4 of ~325 KB each, cutting initial Lending route TTI by ~75%.

### MEDIUM

**[M1] DashboardPage chunk 198 KB (`DashboardPage-BYEicl0P.js`).** 688 LOC page that imports `recharts` indirectly. Acceptable but could pre-fetch on `/dashboard` link hover.

**[M2] CommunityPage chunk 95 KB.** Tabbed page (Bribes/Grants/Bounty merged) — same anti-pattern as LendingPage but smaller.

**[M3] `metamask-sdk` 541 KB ships even for users on browsers with the extension installed.** RainbowKit auto-includes it. Configurable via `getDefaultWallets()` to drop it or move behind on-demand connector loading.

**[M4] `rollup-plugin-visualizer` listed as `devDependency` (correct) but the build doesn't gate on `process.env.ANALYZE` cleanly — `vite.config.ts` line 77 does `process.env.ANALYZE` which works, but the visualizer pulls a large dep tree into devDependencies (~2 MB). Not shipped, just install bloat.**

**[M5] `html2canvas` already dynamic-imported (good).** `frontend/src/components/TransactionReceipt.tsx:217` uses `await import('html2canvas')` — chunked into `vendor-html2canvas-BnxTArM_.js` (200 KB). Not loaded unless user prints a receipt. **No action needed; flagged as positive finding.**

**[M6] No `lodash`, `moment`, `date-fns` in deps tree** (verified via grep on `package.json` and src). **Positive finding** — no historic-bloat libraries.

### LOW / INFO

**[L1] `src/assets/` is empty** — all art served from `public/`/CDN (correct pattern). 4 art images > 500 KB in `dist/art/` exist but are loaded via lazy `<ArtImg>` component with `loading="lazy"` (verified by class name). Could be converted to WebP/AVIF for ~60% size cut.

**[L2] CSS bundle 232 KB (`index-QXmGP-qh.css`).** Tailwind v4 + `@rainbow-me/rainbowkit/styles.css`. Tailwind purge appears active (no obvious unused classes).

**[L3] `@irys/web-upload` + `@irys/web-upload-ethereum`** are deps but only used in `frontend/src/lib/irysClient.ts` — appears to be lazy-loaded on-demand for IPFS uploads. Verify with `grep -r 'import.*irysClient'` to ensure no eager top-level import.

**[L4] React 19.2 + React-Router 7 + Wagmi 2.19** are all current. No duplicate web3-modal libraries (verified — no `@web3modal/*`, no `connectkit` in package.json or lock).

**[L5] `lightweight-charts` (5.1.0) used only in `components/chart/PriceChart.tsx`** — may be eagerly imported on TradePage. Worth verifying for code-split opportunity.

**[L6] Static dist size:** `dist/art/` 18 MB, `dist/splash/` 7.2 MB, `dist/nakamigos/` 2.4 MB, `dist/videos/` 1.4 MB. Splash images especially fat — likely PNGs that should be WebP.

---

## Quick Wins (priority-ordered)

1. **Drop `sourcemap: 'hidden'` to `false` for prod build** OR exclude `*.map` from Vercel deploy. Saves 33 MB of leaked source + bandwidth. (5-min change.)
2. **Lazy-load LendingPage section tabs** → cuts 1.30 MB chunk to ~325 KB initial. (1-hour refactor.)
3. **Audit & remove ethers usage** in 49 hook files; migrate to viem (already a peer of wagmi). Saves 333 KB. (Multi-hour migration.)
4. **Convert art `.jpg` ≥ 500 KB → WebP** (e.g. `cwebp -q 85`). 4 files = ~3.2 MB savings per page that loads them.
5. **Reconsider RainbowKit's bundled `metamask-sdk`** — strip the SDK connector and rely on injected provider only. Saves 541 KB chunk.

---

## Methodology / Evidence

- Listed `dist/assets/` and sorted by size: `ls -la | sort -k5 -nr`
- Confirmed source-map count: `ls dist/assets/*.js.map | wc -l` → 224
- Verified no `lodash`/`moment`/`date-fns` deps via `grep` on `package.json` and source tree
- Checked ethers vs viem coexistence: `grep "from 'ethers'"` → 49 files; `grep "from 'viem'"` → 0 files (likely viem is sub-path imported as `viem/utils` etc.)
- Verified all 18 routes in `App.tsx` use `React.lazy()` (correct)
- Confirmed `src/assets/` is empty (all art lives in `/public/art/`)
- LendingPage section files counted via `wc -l` — 5755 LOC across 4 sibling sections

No build was run; analysis based on existing `dist/` artifacts dated 2026-04-20.
