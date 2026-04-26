# Audit 059 — Gallery & NFT Metadata (Frontend)

Agent: 059 / 101 — AUDIT-ONLY

## Targets reviewed
- `frontend/src/pages/GalleryPage.tsx`
- `frontend/src/lib/nftMetadata.ts` (+ `nftMetadata.test.ts`)
- `frontend/src/components/ArtImg.tsx`
- `frontend/src/components/ui/ArtLightbox.tsx`
- `frontend/src/nakamigos/` (api.js, constants.js, components/NftImage.jsx)
- `frontend/src/hooks/useNFTDropV2.ts` (cross-check on contractURI fetcher)

## Counts
- HIGH: 4
- MEDIUM: 5
- LOW: 4
- INFO: 3
- Total: 16

---

## HIGH

### H-1 — `useNFTDropV2.resolveContractUri` accepts arbitrary protocol schemes (data:/javascript:/file:/gopher:)
File: `frontend/src/hooks/useNFTDropV2.ts:13-21`, `:26-32`
The resolver only special-cases `ar://`. Any other URI is returned untouched and then directly passed into `fetch(url)` (line 116). Because `contractURI()` is *attacker-controllable on a malicious drop contract*, a creator can return:
- `data:application/json,...` — bypasses the JSON parse guard, can spoof name/banner.
- `javascript:` — not directly exploitable through `fetch()` but the same string is later passed via `resolveAssetUrl` to `<img src=...>` (rendered through `collectionMetadata.image`). `javascript:` URIs in `<img src>` are inert in modern browsers, BUT `data:image/svg+xml,<svg onload=...>` is fully renderable and runs script in the page's origin if the `<img>` tag is replaced with an iframe/object elsewhere. Today the consumer renders an `<img>`, which is safe for SVG (no script), but the contract can still serve `data:image/svg+xml` containing tracking pixels / external requests.
- `file://` / `gopher://` — fetch is blocked in browsers, but uncaught reject still surfaces.
There is **no allowlist of schemes**. Recommend: enforce `https://`, `ar://`, `ipfs://` only, reject everything else with a clean error.

### H-2 — `NftImage.jsx` IPFS gateway is a single point of failure (`ipfs.io`)
File: `frontend/src/nakamigos/components/NftImage.jsx:13-17`
```
if (url.startsWith("ipfs://")) return url.replace("ipfs://", "https://ipfs.io/ipfs/");
```
The companion `nakamigos/api.js:74-78` *defines* a 3-gateway list `IPFS_GATEWAYS` but `resolveIpfs()` (line 80-84) only ever uses `IPFS_GATEWAYS[0]`. When `ipfs.io` is rate-limiting or down (frequent) every IPFS-only NFT renders broken. The component falls back to placeholder eventually, but only after a full 503/timeout cycle per token. Recommend: rotate gateways on `onError`, or use a deterministic-per-CID gateway pick.

### H-3 — Metadata gateway calls have no client-side rate limit
Files: `frontend/src/nakamigos/components/NftImage.jsx:69-93`, `:95-147`; `frontend/src/nakamigos/api.js`.
On a grid of 40+ NFTs, every cache miss (and every `failCount===0` event) fires a `/api/alchemy?endpoint=getNFTMetadata` request immediately. There is **retry with backoff** in `api.js` (`withRetry`) but no concurrency cap and no debounce on the per-image fallback path. A single visit to a fresh collection page can fan-out 40 parallel proxy hits. The proxy (`/api/alchemy`) then talks to Alchemy with a paid key — cost amplification + 429s from upstream. Recommend: a `pLimit(6)` concurrency wrapper or a leaky-bucket. The cache (`MAX_CACHE_SIZE=2000`, `CACHE_TTL=5min`) helps repeat visits but not first-paint storms.

### H-4 — `ArtImg.tsx` has zero failure handling — broken `<img>` will render
File: `frontend/src/components/ArtImg.tsx:32-44`
The component renders `<img src={art.src} ... />` with no `onError`, no fallback, no `loading` attribute. The 2026-04-19 regression comment explicitly notes "the browser happily renders a broken `<img>`" — and the chosen fix is "use plain `<img>`" with no recovery path. Combined with art-studio overrides (which can be edited by the user and persisted via `/__art-studio/save`), a typo in the override file produces an invisible-broken render across the whole site. Recommend: `loading="lazy"` + `onError` swap to a known-good placeholder + width/height attributes to avoid CLS.

---

## MEDIUM

### M-1 — `GalleryPage.tsx` images lack explicit width/height — guaranteed layout shift on slow networks
File: `frontend/src/pages/GalleryPage.tsx:99-100`
`<img src={piece.src} alt={piece.title} className="w-full h-auto ... " loading="lazy" />` — `h-auto` means the browser cannot reserve box height before the image decodes. Combined with a masonry-style `columns-1 sm:columns-2 md:columns-3` layout and `whileInView` framer animations (line 96), this thrashes the page on iPhone 14 / iPad scroll. Recommend: ship aspect-ratio metadata in `GALLERY_ORDER` or wrap in `aspect-[N/M]` containers.

### M-2 — Lightbox image also missing dimensions / `loading` hint
File: `frontend/src/components/ui/ArtLightbox.tsx:88-90`
`<img src={piece.src} ... className="w-full h-auto max-h-[70vh] object-contain bg-black" />` — opens fullscreen with no skeleton, no decode hint, no `decoding="async"`. On a slow LTE connection the user gets a flash of empty black box.

### M-3 — Referrer policy not set on cross-origin NFT images
Files: `NftImage.jsx:160-173`, `nakamigos/components/CommunityChat.jsx:325`, `WhaleIntelligence.jsx:781`, `TransactionHistory.jsx:132`, etc.
None of these `<img>` tags set `referrerPolicy="no-referrer"`. Every NFT image fetched from `nft-cdn.alchemy.com` or arbitrary IPFS gateways receives the user's full Tegridy Farms URL (potentially leaking wallet-bound paths like `/portfolio/0x.../...`) via the `Referer` header. Recommend: `referrerPolicy="no-referrer-when-downgrade"` minimum, ideally `no-referrer` for NFT images that come from third-party CDNs.

### M-4 — `validateImages` blocks `image/svg+xml` correctly — but only at upload
File: `frontend/src/lib/nftMetadata.ts:168-173`
The MIME whitelist excludes SVG (good — prevents XSS via uploaded SVG). However, the test confirms the rejection (`nftMetadata.test.ts:170`). The gap is that **rendered NFT metadata** in `NftImage.jsx` will happily display an SVG returned from a third-party `tokenURI` via `<img src>`. SVGs in `<img>` cannot run script (browser sandboxes), but they can cause:
- request fan-out via `<image href="https://attacker">` for tracking,
- DoS via `<filter>` with insane primitives.
Recommend: when `data.image?.originalUrl` ends in `.svg` or content-type sniffing returns SVG, render via `<img>` only (already the case) and add CSP `img-src` with hashes/origins, or proxy through an image rewrite service.

### M-5 — Failure cache in `NftImage.jsx` lacks abort handling on unmount
File: `frontend/src/nakamigos/components/NftImage.jsx:75-92, 95-141`
The `useEffect` and `handleError` both kick off `fetch(...)` with no `AbortController`. On rapid grid scroll (mount/unmount NftImage repeatedly), in-flight requests resolve into stale state setters. `setDynamicSrc` after unmount is a React warning, plus duplicate work. Recommend: AbortController scoped to the effect.

---

## LOW

### L-1 — `ArtImg.tsx` `<img>` missing alt fallback
File: `frontend/src/components/ArtImg.tsx:43`
`{...rest}` may pass `alt`, but the component has no default if the caller omits it. Most consumers pass `alt=""` (decorative), which is correct, but there's no enforcement. ESLint's `jsx-a11y/alt-text` should flag this.

### L-2 — `GalleryPage` image cards have role="button" on the outer `<m.div>` — keyboard-only users get correct semantics, but the inner vote `<button>` is nested inside an interactive parent
File: `frontend/src/pages/GalleryPage.tsx:91-127`
`role="button"` on a div containing a real `<button>` is allowed but accessibility-best practice is to avoid redundant interactive scoping. Comment line 90 even acknowledges this: "outer element is a div (not button) to avoid nested buttons". Screen readers read both. Consider a true `<button>` wrapper without nested buttons (move vote button outside the click target).

### L-3 — `cloudflare-ipfs.com` gateway entry is dead (Sep 2024)
File: `frontend/src/nakamigos/api.js:77`
Cloudflare deprecated their public IPFS gateway. Keeping it in the rotation just means more 404s. Recommend remove or replace with `nftstorage.link`, `4everland.io`, `w3s.link`.

### L-4 — `nftMetadata.test.ts` doesn't cover URI scheme validation
The test file covers parseCsv, buildTokenMetadata, buildContractMetadata royalty/external_link, validateImages. It does **not** test:
- contractURI scheme allow-list (because there is none — see H-1)
- protection against `image: "javascript:..."` in CSV
- protection against `image: "data:image/svg+xml,<svg onload=...>"` injection
Recommend adding negative-path tests once H-1 fix lands.

---

## INFO

### I-1 — `parseCsv` correctly throws on missing headers; warnings non-fatal
Confirmed via `nftMetadata.test.ts:46-66`. Good defensive design.

### I-2 — `useNFTDropV2` properly uses AbortController + 8s timeout for contractURI fetch
File: `useNFTDropV2.ts:111-147`. Cancellation is wired correctly on dependency change/unmount.

### I-3 — Gallery vote system is local-only (not on-chain)
File: `GalleryPage.tsx:78-80`. Banner explicitly states this. No DoS or financial vector — votes can be wiped via localStorage clear; user is informed. ✓

---

## Cross-check vs `nftMetadata.test.ts`
- `parseCsv`, `buildTokenMetadata`, `buildContractMetadata`, `validateImages`, `matchCsvToFiles`, `sanitizeFilename` — all covered.
- No test exercises the **rendering path** (NftImage, ArtImg, GalleryPage). All HIGH findings live in code that has 0% test coverage.

## Top-3 Priority Fixes
1. **H-1** — Lock `resolveContractUri` to https/ar/ipfs schemes only; add tests for data:/javascript: rejection.
2. **H-3** — Add concurrency cap (e.g., `p-limit` 6) on metadata-API fan-out from NftImage grid.
3. **H-4** — Add `onError` fallback + intrinsic dimensions to `ArtImg` to eliminate broken-image renders and CLS.

— end report —
