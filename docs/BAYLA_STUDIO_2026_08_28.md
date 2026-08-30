# The Bayla studio — placing art inside a bungalow skin

*Written 2026-08-28. Companion commit on `mvp-launch`, not pushed.*

## The gap it closes

`/art-studio` has been the tool for deciding which piece of art lands on which
of the app's ~250 surfaces, and how it is cropped (`objectPosition`) and zoomed
(`scale`). It writes `frontend/src/lib/artOverrides.ts`.

It never worked for Bayla. `pageArt()` short-circuits before the override
lookup whenever a bungalow with its own `artPool` is active:

```ts
const bungalowPool = bungalowArtPool(pageId);
if (bungalowPool) {
  // hash(pageId) → offset, take consecutive pieces. Return.
}
const override = ART_OVERRIDES[`${pageId}:${idx}`];  // never reached in bayla mode
```

The comment said so out loud — *"ART_OVERRIDES are skipped on purpose — they
pick classic art ids that don't exist in bungalow pools."* That reasoning is
right, and the consequence was that **in Bayla mode the only thing deciding
which of the 24 pieces went where was a hash of the page name.** No pick, no
pan, no zoom. `BAYLA_BUNGALOW.md` §2 registered the bungalow surfaces in the
studio "for inventory parity" while noting they bypass overrides — this is the
follow-up that makes them real.

## What shipped

**A per-bungalow override layer.** `frontend/src/lib/bungalowArtOverrides.ts`,
keyed `` `${bungalowId}|${pageId}:${idx}` `` — e.g. `"bayla|farm:0"`. Keying by
bungalow is the whole point: the classic picks in `artOverrides.ts` are
untouched, and two skins can hold different placements for the same surface.

**`pageArt()`'s bungalow branch now resolves like the classic one.** Override
first (artId resolved against the bungalow's own pool, then the classic `ART`
map so a bungalow can deliberately borrow a classic piece), rotation second,
and an unknown artId degrades to the rotation rather than throwing.
`bungalowArtPool()` is now a thin wrapper over `bungalowArtContext()`, which
also returns the bungalow id — one storage read, not two.

**`/bayla-studio`** (`pages/BungalowArtStudioPage.tsx`), dev-only under the same
R002 gate as `/art-studio`: the chunk is tree-shaken out of production and the
route redirects to `/`. Same three-pane layout — surface list, preview, art
picker — with the Bayla pool in the picker, a "also show classic art" toggle,
X/Y/zoom sliders, **drag-on-the-image to place the focal point**, fullscreen,
and debounced auto-save to disk. The Live-page tab iframes the real route with
`?bungalow=bayla`, so you judge the crop against the actual page, not a square.

The page is generic over `bungalowId`; a second bungalow with an `artPool`
needs one route line, not a new file.

**Shared plumbing, one inventory.** The surface list moved to
`lib/artSurfaces.ts` and the live-preview pane to
`components/studio/LivePreview.tsx` (now taking a `query` prop). Both studios
read the same list, so a new `pageId` cannot be registered in one and missing
from the other. The two tests that scanned `ArtStudioPage.tsx` for the
inventory (`pages/artStudioCoverage.test.ts`, `lib/yield/surface.test.ts`) now
scan `lib/artSurfaces.ts`.

**The save endpoint.** `vite.config.ts`'s dev-only middleware was generalised
into `overrideSavePlugin({ name, route, outFile, keyPattern, render })` and
instantiated twice — `/__art-studio/save` unchanged, plus
`/__bungalow-studio/save`. The new one adds a key-shape guard
(`/^[a-z0-9-]+\|[a-z0-9-]+:\d+$/`) on top of the existing origin allowlist,
body cap and schema validation.

## Verification

- 8 new tests in `lib/bungalowArtOverrides.test.ts` covering the six behaviours
  above plus "shared surfaces (nav-logo, loader) stay classic" and "the classic
  skin is untouched". **Mutation-verified**: neutering the override lookup in
  `pageArt` turns 3 of them red.
- Full frontend suite green (431 files / 6,089 tests), `tsc -b` clean, eslint 0
  errors (the new page carries no warnings).
- Live loop confirmed in the browser: dragging Y to 82% on `H1 — Hero bg` wrote
  `"bayla|home:0": { artId: "bayla-19", objectPosition: "50% 82%" }` to disk,
  and the Live-page iframe re-rendered the real home hero with
  `object-position: 50% 82%`.

## Sharp edge worth knowing

The studio is the single writer for its file. If you hand-edit
`bungalowArtOverrides.ts` (or POST the endpoint yourself) **while a studio tab
is open**, the resulting HMR remount makes the studio save its own state back
over your edit. Close the tab first. The classic studio has always behaved this
way; the file header carries the warning.

Separately: the Live-page iframe loads `?bungalow=bayla`, and
`getActiveBungalow()` persists a deep link — so previewing puts *your* browser
into the Bayla skin. The studio footer says so and offers a one-click reset.

## Running it

```
cd frontend && npm run dev
# → http://localhost:5173/bayla-studio
```
