# Audit 052 — Art Studio (Dev Tool Surfaces)

**Agent:** 052/101
**Targets:**
- `frontend/src/pages/ArtStudioPage.tsx`
- `frontend/src/lib/artConfig.ts`
- `frontend/src/lib/artOverrides.ts`
- `frontend/src/components/ArtImg.tsx`
- (incidental, since it implements the save endpoint) `frontend/vite.config.ts`

**Mode:** AUDIT-ONLY — no code changes.

---

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH     | 2 |
| MEDIUM   | 4 |
| LOW      | 4 |
| INFO     | 3 |
| **Total**| **13** |

Net assessment: the dev middleware is correctly gated to `apply: 'serve'`, so the `/__art-studio/save` endpoint **is not exposed in production builds** — the primary concern is mitigated. However the **`/art-studio` page route ships in production** and tries to POST to a non-existent endpoint, leaking internal tooling to public users. Save-handler input validation is thin enough that on a dev server bound to `0.0.0.0` an attacker on the LAN could overwrite `frontend/src/lib/artOverrides.ts`.

---

## HIGH

### H1 — `/art-studio` page route is shipped in the production bundle (no auth, no DEV gate) ⚠️
**File:** `frontend/src/App.tsx:115`, `frontend/src/pages/ArtStudioPage.tsx:1-583`

```tsx
<Route path="art-studio" element={<Suspense fallback={<PageSkeleton />}><ArtStudioPage /></Suspense>} />
```

The route is registered at the top of `AnimatedRoutes` (outside any auth gate, outside any `import.meta.env.DEV` check). In production:
- Anyone can navigate to `https://tegridyfarms.vercel.app/art-studio` and load the entire admin tooling UI (1.7k+ lines of state, all surfaces, all art assets enumerated).
- Pressing **Save to disk** issues `POST /__art-studio/save` against the prod CDN, which returns 404/405 — but the endpoint name is now publicly advertised, telling any auditor exactly what dev-server surface to attack if they can reach a developer's localhost.
- Auto-save is `true` by default, so just navigating to the page triggers a 350 ms-debounced background POST. Production users mucking around will see "Save failed: Unexpected token '<'" toasts but no functional damage.
- **Information disclosure:** the surface map (`SURFACES` array, `PAGE_ROUTES`, `ART` keys) leaks the full sitemap and admin route names (`'admin-dashboard'`, `'admin'`) along with internal labels like "F1 — Page bg".

**Fix path (audit only — recommendation):** wrap the route in `import.meta.env.DEV && <Route … />`, or 404/redirect on prod. Same for `LivePreview` route mapping.

---

### H2 — Save endpoint accepts unauthenticated cross-origin POSTs from any localhost-resolvable origin
**File:** `frontend/vite.config.ts:14-67`

```ts
server.middlewares.use('/__art-studio/save', (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body) as Record<…>;
```

Issues:
1. **No origin / referer check** — any page open in the same browser as the dev server (e.g. `http://localhost:5173/art-studio` opened by an attacker via DNS-rebinding or by a malicious npm package's webhook) can POST and rewrite the file. Body is `application/json`, but no preflight is required because `simple` JSON POSTs without custom headers are allowed (note: this code does require `Content-Type: application/json` from the studio's `fetch`, but a bare `text/plain` body is *not rejected* by the handler — the handler accepts any content-type and just `JSON.parse`s the body, so a CSRF POST with `Content-Type: text/plain` and `body=<JSON>` would succeed).
2. **No body size cap** — `body += chunk` concatenates indefinitely. An attacker can POST a 1-GB body and OOM the dev server (or fill the buffer until Node bails).
3. **Vite's default dev host** — historically `0.0.0.0`/all interfaces. If the dev server is on `0.0.0.0` (default in CI/docker-compose flows), anyone on LAN can write the file.
4. **Synchronous `writeFileSync`** to a fixed path inside the working dir. While the path is hard-coded and not user-controllable (so no traversal), the contents (`v.artId`, `v.objectPosition`, `v.scale`) are fed directly into `JSON.stringify(...)` without schema validation. `JSON.stringify` is XSS-safe for JSON output, but the resulting `.ts` file is then **read by Vite/TS at compile time** — a hostile `artId` like `"x\\u0000"` is fine for JSON but if anyone ever switches the writer to template-literal interpolation it becomes a code-injection vector. Today: contained because every value goes through `JSON.stringify`.

**Fix path:** require a custom header (`X-Art-Studio: 1`) so it becomes a non-simple CORS request and CSRF is impossible; reject `Origin !== http://localhost:<port>`; cap body at 64 KB; type-validate (`artId: string`, position regex, scale numeric `1<=x<=3`).

---

## MEDIUM

### M1 — Auto-save races against in-flight writes; can drop edits during rapid sliding
**File:** `frontend/src/pages/ArtStudioPage.tsx:303-309, 373-394`

```ts
useEffect(() => {
  if (!autoSave) return;
  if (!didMountRef.current) { didMountRef.current = true; return; }
  const t = setTimeout(() => { void saveToDisk(overrides, true); }, 350);
  return () => clearTimeout(t);
}, [overrides, autoSave]);
```

`saveToDisk` is fire-and-forget. There is **no `inflight` guard**: if the user drags an X slider, releases, drags again 400 ms later, the first POST may still be writing the file when the second POST arrives. `writeFileSync` is synchronous within Node but the **two requests can interleave at the JS event-loop boundary** between the `req.on('end')` callbacks, producing a last-writer-wins race. With auto-save on every keystroke the disk file can briefly contain a stale snapshot, then the iframe `nonce++` reload fires twice (one per save), forcing two iframe loads = thrash.

User mandate: auto-save is silent, so the user doesn't know which version landed.

### M2 — `localStorage` draft state can mask `ART_OVERRIDES` regressions across machines
**File:** `frontend/src/pages/ArtStudioPage.tsx:271-277, 295-299`

```ts
const [overrides, setOverrides] = useState<Record<string, ArtOverride>>(() => {
  try {
    const draft = localStorage.getItem(STORAGE_KEY);
    if (draft) return { ...ART_OVERRIDES, ...JSON.parse(draft) };
  } catch {/* ignore */}
  return { ...ART_OVERRIDES };
});
```

Local draft *overlays* file overrides. If a teammate pulls a fresh `artOverrides.ts` from git, their draft from a previous session is silently merged on top — looks like work that wasn't committed actually was, but their branch is regressed. There is no draft-vs-disk diff indicator. **Any unparseable draft** from an old format throws inside `JSON.parse`, the catch swallows it, and `ART_OVERRIDES` loads — silent drift.

### M3 — `pageArt` override `artId` lookup is case-sensitive but file system is not
**File:** `frontend/src/lib/artConfig.ts:250-272`

```ts
const picked = artById().get(override.artId);
if (picked) { … }
// Fall through to rotation if artId is unknown (e.g. file deleted).
```

If someone hand-edits `artOverrides.ts` (note: doc says don't, but a merge conflict could) and writes `"Naka01"` instead of `"naka01"`, the lookup misses, code silently falls through to the deterministic rotation, and the page renders a *different art piece* with no warning. No logging in dev. Couples to user mandate "preserve art" — silent fallback violates the principle.

### M4 — iframe `X-Frame-Options: DENY` will break `<LivePreview>` in production
**File:** `frontend/vercel.json:8`, `frontend/src/pages/ArtStudioPage.tsx:612-619`

`vercel.json` sends `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` for all paths. The Live preview iframe (`<iframe src={url} … />` where `url = '/dashboard?_studio=N'`) will **fail to load in any deployed environment** — the iframe will be blank or show a "refused to connect" error. Only works on localhost where Vite dev server doesn't honor those headers. Combined with H1 (the page is in prod), Live tab is permanently broken in prod.

---

## LOW

### L1 — Iframe inherits same-origin and shares `localStorage`/`sessionStorage` with parent
**File:** `frontend/src/pages/ArtStudioPage.tsx:288-292, 612-619`

```ts
useEffect(() => {
  try { sessionStorage.setItem('tf_loaded', '1'); } catch {/* ignore */}
}, []);
```

The studio writes to its own session storage to bypass `AppLoader`'s splash inside iframes. Since both contexts are same-origin, this is fine — **but** the iframe is loaded with `loading="lazy"` and **no `sandbox` attribute**. The rendered route is the production app; if any page rendered inside the iframe does something based on `window.top !== window.self` (frame-busting), it could redirect the parent. None of the audited code shows that, but worth noting given user mandate "do not swap art".

### L2 — `confirm()` modal blocks accessibility / mobile flow
**File:** `frontend/src/pages/ArtStudioPage.tsx:368-371`

```ts
const resetAll = () => {
  if (!confirm('Clear ALL overrides …')) return;
  setOverrides({});
};
```

Native `confirm()` is unstyled, blocks the main thread, and on iPad/iPhone (per user responsive mandate) is a system modal that obscures the studio. A custom modal is preferable.

### L3 — Sliders use `parseInt(value, 10)` without NaN guard
**File:** `frontend/src/pages/ArtStudioPage.tsx:519, 528, 537`

`parseInt(e.target.value, 10)` cannot NaN for a `<input type="range">` (browser guarantees a stringified number), but if a user uses devtools to set `value=""`, position becomes `NaN%`, which gets serialized into `objectPosition: "NaN% 50%"` and committed to disk. Edge case but the file then re-renders without that override in `pageArt` (ArtImg.tsx:34 still applies — produces invalid CSS, browser ignores it, art falls back to the inline default). Self-healing but pollutes the file.

### L4 — Responsive — sidebar `lg:w-[360px]` collapses to full-width on mobile but list height is `max-h-[calc(100vh-100px)]`
**File:** `frontend/src/pages/ArtStudioPage.tsx:431`

On iPhone 14 (390px wide), the surface list takes the full width with a 100vh-minus-100 scroll area, and the editor is below it. Functional, but **the user must scroll past 100vh of surface list to reach the editor** — bad mobile UX. Tap a surface, it selects, then you scroll down. The header is `sticky top-0` (line 403) so navigation is fine, but consider collapsible accordion on `<lg`. Per user mandate this is "must be flawless on iPhone14+/iPad" — currently functional, not flawless.

---

## INFO

### I1 — `apply: 'serve'` correctly gates the middleware to dev
`frontend/vite.config.ts:13` declares `apply: 'serve'` on the Vite plugin, which means `configureServer` is **not** invoked during `vite build`/`vite preview`. So the actual file-write code path is dev-only. Good.

### I2 — No SVG, no `dangerouslySetInnerHTML`, no user-uploaded images
All art assets are static files in `/public/art/**` and `/public/splash/**`, listed by hand in `artConfig.ts:ART`. Nothing dynamic, nothing uploaded by users. SVG XSS not applicable here.

### I3 — No `<link rel="preload"|prefetch">` for admin assets
Searched the file and surrounding code — no `preload`/`prefetch` of admin-only resources. `loading="lazy"` on `<img>` is used, which is the correct opposite (defer until in-viewport).

---

## Top-3

1. **H1** — `/art-studio` route is **publicly accessible in production** with no DEV gate. Leaks the full sitemap + admin route names; auto-save fires harmless 404 POSTs every 350 ms.
2. **H2** — Dev save handler has **no Origin/CSRF check, no body size cap, no schema validation**. On a `0.0.0.0`-bound dev server or via DNS rebind, an attacker LAN-side can rewrite `artOverrides.ts`. Also accepts non-`application/json` content-types.
3. **M4** — Production `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` makes the **`<LivePreview>` iframe permanently broken in prod** (combined with H1, the prod-shipped route has a non-functional sub-tab).

**Counts:** 13 findings (0 CRIT / 2 HIGH / 4 MED / 4 LOW / 3 INFO).
