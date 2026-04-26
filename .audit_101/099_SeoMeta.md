# Audit 099 — SEO + Meta + OG + Favicon + Sitemap + Robots

**Agent:** 099 / 101 — AUDIT-ONLY
**Scope:** `frontend/index.html`, `frontend/public/*`, `frontend/src/pages/*` (Helmet usage), `scripts/render-og-png.mjs`, `vercel.json` (root + frontend)
**Date:** 2026-04-25

---

## Summary Counts

| Severity | Count |
|---|---|
| HIGH | 3 |
| MED | 5 |
| LOW | 4 |
| INFO | 3 |
| **TOTAL** | **15** |

---

## Inventory (what exists, status)

| Asset | Path | Status |
|---|---|---|
| `index.html` | `frontend/index.html` | Present, lang="en", charset+viewport set |
| `favicon.svg` | `frontend/public/favicon.svg` | Present (9.5 KB), `<link rel="icon">` set |
| `apple-touch-icon` | `frontend/public/art/bobowelie.jpg` | Wrong format/size — see HIGH-1 |
| `manifest.json` | `frontend/public/manifest.json` | Present (uses `.json` not `.webmanifest`) |
| PWA icons 192/512 | `frontend/public/splash/icon-192.png`, `icon-512.png` | Present |
| `robots.txt` | `frontend/public/robots.txt` | Present, allows all |
| `sitemap.xml` | `frontend/public/sitemap.xml` | Present, 21 URLs, `lastmod=2026-04-19` |
| `og.png` / `og.svg` | `frontend/public/og.{png,svg}` | Present, 1280x640 |
| `usePageTitle` hook | `frontend/src/hooks/usePageTitle.ts` | Custom, no `react-helmet` dep |
| Helmet provider | none | No `react-helmet` / `react-helmet-async` installed |
| `vercel.json` | `frontend/vercel.json` | Present (root has none) |

---

## HIGH

### HIGH-1 — apple-touch-icon points at 1024×1024 art JPG, not a 180×180 PNG
**File:** `frontend/index.html:20`
```html
<link rel="apple-touch-icon" href="/art/bobowelie.jpg">
```
- `bobowelie.jpg` is 189 KB and is the homepage hero artwork; iOS home-screen spec wants a square 180×180 PNG named `apple-touch-icon.png`.
- iOS Safari downloads the full 189 KB artwork on every "Add to Home Screen" / share-card render. PWA install will use `manifest.json` icons instead, but bare-Safari users get the wrong asset.
- Also: `apple-touch-icon-precomposed` and the size-suffixed variants (120×120, 152×152, 167×167) are absent, so iPad/iPhone retina users fall back to the 1024×1024 JPG.

**Fix sketch:** generate `frontend/public/apple-touch-icon.png` (180×180 PNG) from the splash icon and point the `<link>` at it.

---

### HIGH-2 — `usePageTitle` is a custom DOM-mutation hook — duplicate `<meta>` tags can leak between routes
**File:** `frontend/src/hooks/usePageTitle.ts:7-25`
```ts
function setMetaTag(attr, key, content) {
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement('meta'); ... }
  el.content = content;
}
```
- Hook does `useEffect → document.querySelector → set content` directly. Cleanup only resets `document.title`; **`og:image`, `og:description`, `description`, `og:url`, `twitter:*`, `<link rel="canonical">` are never reverted on unmount.**
- If a user navigates `/farm → /privacy`, the og:image set by Farm persists until `/privacy` re-mounts and overwrites — but if Privacy uses `usePageTitle('Privacy', desc)` with no `ogImage`, the hook falls back to `DEFAULT_OG_IMAGE` (`/art/gallery-collage.jpg`), masking the bug. Any page that does **not** call `usePageTitle` (4 wrapper pages — see HIGH-3) inherits the previous route's tags.
- React Strict Mode double-mount in dev runs the effect twice → safe for content, but the `setLinkTag` for canonical creates the element only once and reuses, OK.
- Server-side rendering: project ships SPA only (no SSR); crawlers that don't execute JS see only the index.html defaults. Twitter/Facebook/Slack/Discord all run head-only fetchers — **per-page OG tags are invisible to them**. Every shared link previews as the homepage.

**Recommendation:** Switch to `react-helmet-async` with proper cleanup, OR run a build-time prerender (e.g. `vite-plugin-ssg` or Vercel's static prerender) for the 21 routes already in `sitemap.xml`.

---

### HIGH-3 — 4 page entrypoints never call `usePageTitle` → stale title/description
**Files (no `usePageTitle` import or call):**
- `frontend/src/pages/ActivityPage.tsx` — wraps Leaderboard/Premium/History/Changelog (4 routes)
- `frontend/src/pages/ArtStudioPage.tsx` — internal dev tool
- `frontend/src/pages/InfoPage.tsx` — wraps Terms/Privacy/Risks/Contracts/Treasury (5 routes)
- `frontend/src/pages/LearnPage.tsx` — wraps Tokenomics/Lore/Security/FAQ (4 routes)

In `App.tsx:122-147` these wrappers serve **13 of 21 sitemap URLs**:
| Sitemap URL | Component | Has usePageTitle? |
|---|---|---|
| `/tokenomics` `/lore` `/security` `/faq` | `LearnPage` | No (children do) |
| `/leaderboard` `/premium` `/history` `/changelog` | `ActivityPage` | No (children do) |
| `/terms` `/privacy` `/risks` `/contracts` `/treasury` | `InfoPage` | No (children do) |

The wrappers lazy-load the actual child pages (TokenomicsPage, FAQPage, etc.) which DO call `usePageTitle` — **on initial load, the inner Suspense fallback `<PageSkeleton />` renders first with no title set; the hook fires only after the chunk arrives.** During chunk load (~100-400ms cold), social crawlers and tab-title indexers see "Tegridy Farms | TOWELI Yield Farm" only.

Combined with HIGH-2: any crawler that bails before the chunk loads gets the default index.html tags for all 13 wrapper-routed URLs.

---

## MED

### MED-1 — `og:url` and `<link rel="canonical">` in index.html hardcoded to `https://tegridyfarms.xyz/` regardless of route
**File:** `frontend/index.html:22, 38, 46`
```html
<link rel="canonical" href="https://tegridyfarms.xyz/" />
<meta property="og:url" content="https://tegridyfarms.xyz/" />
<meta name="twitter:url" content="https://tegridyfarms.xyz/" />
```
- All 21 sitemap URLs share the same canonical/og:url until `usePageTitle` runs (see HIGH-2). Crawlers that don't execute JS (Twitterbot, facebookexternalhit, Slackbot — all of which ignore JS) will see every page as `/`.
- `tegridyfarms.xyz` is the production domain, not a dev/preview domain — at least the domain is correct. But Vercel preview deploys (`tegridyfarms-three.vercel.app`) inherit the same hardcoded canonical, which is then **redirected** by `frontend/vercel.json:51-57` (only redirects the `-three.vercel.app` host, not `tegridyfarms.vercel.app`).
- A search engine indexing a preview URL will see `canonical = https://tegridyfarms.xyz/` — which would actually be correct dedup behavior — but the **redirect chain on `tegridyfarms-three.vercel.app` returns 308 to `tegridyfarms.vercel.app`, NOT to `tegridyfarms.xyz`**, so canonical and redirect target disagree. Confusing for crawlers.

---

### MED-2 — `manifest.json` is named `.json`, not `.webmanifest`
**File:** `frontend/public/manifest.json` (referenced from `index.html:6` as `/manifest.json`)
- Spec-compliant filename is `manifest.webmanifest` with MIME `application/manifest+json`. Vercel will serve `.json` as `application/json`. Most browsers tolerate this, but Lighthouse PWA audit flags it as a warning, and some Android Chrome versions ignore the manifest entirely.
- Manifest is missing several recommended fields: `id`, `scope`, `lang`, `dir`, `categories`, `screenshots`, and a maskable-only icon variant (current icons declare `purpose: "any maskable"` which may render with bleed).

---

### MED-3 — Sitemap missing 5+ live routes; some sitemap routes redirect
**File:** `frontend/public/sitemap.xml`
Compared against `App.tsx:111-148` route definitions:

Sitemap-listed but **redirected** (should not be in sitemap, or should be canonical targets):
- `/tokenomics` → resolves to `LearnPage` (kept tab `tokenomics`) — OK as canonical
- No `/learn` redirect entry — but `/learn` is `<Navigate to="/tokenomics">` (App.tsx:126); not in sitemap, fine.

Sitemap **missing**:
- `/swap` and `/liquidity` are both listed; both render `TradePage` — duplicate content unless canonicalized.
- `/nakamigos/*` — entire marketplace subroute (NakamigosApp) absent from sitemap.

Sitemap entries with **no robots disallow** but **probably shouldn't be indexed**:
- `/admin` — internal admin tool, IS in App.tsx routes but NOT in sitemap (good), but also NOT in robots.txt as Disallow (bad — leaks via referrer/links).
- `/art-studio` — internal dev tool, same problem (App.tsx:115).

Also: `lastmod=2026-04-19` is now 6 days stale; not a bug per se, but indicates manual maintenance burden — should be auto-generated.

---

### MED-4 — `robots.txt` has no `Disallow` for `/admin`, `/art-studio`, or API rewrites
**File:** `frontend/public/robots.txt`
```
User-agent: *
Allow: /
Sitemap: https://tegridyfarms.xyz/sitemap.xml
```
- `/admin` (App.tsx:134) and `/art-studio` (App.tsx:115) are publicly routable. If any internal link, social share, or referrer leaks the URL, Googlebot will crawl them.
- `/api/odos/*`, `/api/cow/*`, `/api/lifi/*`, `/api/kyber/*`, `/api/openocean/*`, `/api/paraswap/*` are aggregator proxies (vercel.json:60-65). Crawlers hitting these will rate-limit / spam upstream APIs.

---

### MED-5 — `og:image` declares `og:image:type` as PNG but `og:image:secure_url` points at SVG
**File:** `frontend/index.html:31-35`
```html
<meta property="og:image" content="https://tegridyfarms.xyz/og.png" />
<meta property="og:image:secure_url" content="https://tegridyfarms.xyz/og.svg" />
<meta property="og:image:type" content="image/png" />
```
- Per OG spec, `og:image:type` describes the MIME of the **most recent** `og:image` group. Some parsers (LinkedIn, older Slack) interpret `og:image:type=image/png` as applying to `secure_url` and reject the SVG. The cleaner pattern is two full image groups.
- `og:image:width=1280` `og:image:height=640` apply to BOTH the PNG and SVG (which is fine since the SVG is also 1280×640 per `scripts/render-og-png.mjs:62`).
- Comment says SVG is for "modern crawlers that want sharpness" — but Twitterbot, Facebook, and Slack image proxies **all reject SVG** (security: SVG can carry script). Only LinkedIn's preview accepts SVG. The hybrid approach risks rejection rather than enhancement.

---

## LOW

### LOW-1 — `theme-color` is a single dark value, breaks light-mode address-bar tinting
**File:** `frontend/index.html:8`
```html
<meta name="theme-color" content="#060c1a">
```
- Project has a `ThemeProvider` (App.tsx:13, contexts/ThemeContext.tsx) with light/dark toggle. Static `theme-color` makes Chrome/Safari address bar the dark navy `#060c1a` even in light mode.
- Modern browsers support `<meta name="theme-color" media="(prefers-color-scheme: light)" content="...">` paired with `(prefers-color-scheme: dark)`.

---

### LOW-2 — No `og:locale:alternate`, no `hreflang` — single-locale assumption
**File:** `frontend/index.html:40`
- `og:locale=en_US` only; no `og:locale:alternate` and no `<link rel="alternate" hreflang>` entries. Acceptable for a v1 launch but lists Tegridy as English-only to crawlers.

---

### LOW-3 — `<link rel="apple-touch-icon">` lacks `sizes` attribute
**File:** `frontend/index.html:20`
- iOS uses the largest `sizes` attribute when multiple icons are declared. With only one un-sized icon, iOS scales the 1024×1024 JPG to 180×180 client-side every time. Combined with HIGH-1.

---

### LOW-4 — Missing standard SEO meta tags
**File:** `frontend/index.html`
Absent:
- `<meta name="author">` — minor SEO signal
- `<meta name="robots" content="index, follow">` — defaults are fine but explicit is auditable
- `<meta property="article:author">` / `<meta property="article:publisher">` — n/a (not a blog)
- `<meta name="format-detection" content="telephone=no">` — iOS Safari auto-linkifies token amounts that look like phone numbers (e.g. "100,000 TOWELI" → "100,000")
- `<meta name="application-name">` — declared in manifest but should mirror in HTML for older crawlers

---

## INFO

### INFO-1 — `vercel.json` only exists in `frontend/`, not repo root
**Path:** `frontend/vercel.json` (no root `vercel.json`)
- Vercel auto-detects `frontend/` as the project root via the dashboard config; functional but unusual. If a future agent moves to a monorepo with multiple Vercel apps, the layout will need rework. No bug today.

### INFO-2 — `usePageTitle` resets `document.title` on unmount but not other meta — intentional?
**File:** `frontend/src/hooks/usePageTitle.ts:58`
```ts
return () => { document.title = BASE_TITLE; };
```
- Cleanup only restores title to "Tegridy Farms". og:image, og:url, canonical, twitter:* keep the previous page's values until the next page sets them. For an SPA where every route calls the hook, this works in practice. Documented as intentional in the JSDoc comments, just worth flagging.

### INFO-3 — `scripts/render-og-png.mjs` writes to two paths but sitemap/index.html only references one
**File:** `scripts/render-og-png.mjs:33-34`
```js
const PNG_OUT_A = join(REPO_ROOT, 'frontend', 'public', 'og.png');
const PNG_OUT_B = join(REPO_ROOT, 'docs', 'banner.png');
```
- `docs/banner.png` is for README/docs use, not crawlers. Not a bug, but the two-output behavior is undocumented in the SVG sources committed to the repo. If `docs/banner.svg` is ever modified without re-running the script, `og.png` and `docs/banner.png` will drift from `og.svg`. Recommend a CI step or git pre-commit hook.

---

## Top-3 (priority for fix)

1. **HIGH-2** — `usePageTitle` is JS-only meta mutation; crawlers see only index.html defaults. Per-page OG/canonical/description are invisible to Twitter, Facebook, Slack, Discord. Requires SSG/prerender or `react-helmet-async` + crawler-friendly rendering.
2. **HIGH-1** — `apple-touch-icon` points at the 1024×1024 / 189 KB hero JPG. iOS home-screen / share-card breaks; replace with proper `apple-touch-icon.png` (180×180).
3. **HIGH-3** — 4 wrapper pages (`ActivityPage`, `InfoPage`, `LearnPage`, `ArtStudioPage`) skip `usePageTitle`; 13 of 21 sitemap URLs serve homepage tags during chunk load and to JS-disabled crawlers.

---

## Files Audited

- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\index.html`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\favicon.svg`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\manifest.json`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\robots.txt`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\sitemap.xml`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\og.png`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\og.svg`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\splash\icon-192.png`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\public\splash\icon-512.png`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\hooks\usePageTitle.ts`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\App.tsx`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\src\pages\*.tsx` (25 files)
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\frontend\vercel.json`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\scripts\render-og-png.mjs`
