# Island — Wave Five status

The island reads this file from the repo. It is the only "done" the island accepts.

One row per phase. `status` is one of NOT-STARTED · IN-PROGRESS · DONE · BLOCKED.
`evidence` is a commit sha plus the test name that proves the done-means.
BLOCKED rows name exactly what is needed, and from whom.
Updated in the same commit as every phase close.

Opened 2026-08-31.

| phase | status | evidence | notes |
|---|---|---|---|
| 01 changeset applied | DONE (uncommitted) | `arrival.test.ts` (14) · `OnboardingModal.test.tsx` (14, incl. the TOWELI containment case) · `siteIdentity.test.ts` (9) | All 26 files of the wave's changeset are applied, plus 2 the wave did not know it needed (see **Deviations** 4–5). The choke point `src/lib/arrival.ts` is byte-for-byte the specified 116 lines. Independent confirmation the head landed exactly as designed: `node scripts/csp-hash.mjs` recomputed the JSON-LD pin as `sha256-WR/hd42NyzJ3gQFnlod56e7EhmUcVi4Hj2JOmKk/eC4=` — **identical to the hash in the wave's own diff**, so our index.html inline block matches the author's byte for byte. `og.svg` and `docs/banner.svg` are byte-identical to each other (125 lines) and `og.png`/`banner.png` re-rendered from the shared source. |
| 02 gates green | DONE | typecheck exit 0 · **vitest 6359/6364** · build green · **e2e 22 passed** | **typecheck:** `tsc -b tsconfig.app.json tsconfig.node.json` exit 0; `tsc --noEmit -p tsconfig.test.json` exit 0. **lint:** 0 errors. **vitest (clean run, machine otherwise idle, `--maxWorkers=4 --testTimeout=30000`): 451/452 files, 6359/6364 tests. The only red is the 5 pre-existing PWA `InstallPrompt` tests**, red on the pre-change baseline too, and they fail on an *assertion* (`<body><div /></body>` — the component renders nothing), not a timeout. **build:** green — dist-graph gate passed (entry closure 29 chunks, vendor-solana lazy), 11 door pages rendered. **e2e:** `arrival-voice` + `smoke` + `bungalow-doors` = 22 passed.<br><br>⚠️ **Read the test count from a QUIET machine.** This checkout lives on OneDrive and the default 5000 ms `testTimeout` sits right on top of its I/O latency. Runs taken while a Playwright suite shared the box reported 8, then 13, then **70** failures across 48 files — including `converts 1 ETH wei to 1.0`, pure arithmetic that cannot regress from a copy change. Re-running the suspects at `--testTimeout=30000` passed 35/35. A red count from a loaded run here is not evidence. |
| 03 deployed and live-walked both voices | BLOCKED — needs the operator | local walk DONE (`arrival-voice.spec.ts`, both directions, screenshotted) | The code is walked and proven **locally against the production build**, both directions: `/` forms the venue and lands on `VenueHero` (h1 `MEMETICS.FINANCE.` / `Held time counts here.`, nav wordmark `MEMETICS.FINANCE`, footer `© 2026 memetics.finance`, no `Farm TOWELI.` h1, no Towelie assistant); `/toweli` persists the choice, keeps the address, and lands on the classic hero whole (`Farm TOWELI.`, `TEGRIDY FARMS` wordmark, Towelie quote + assistant, the yield calculator and TOWELI contract strip). Served-HTML identity verified in `dist/`: `<title>MEMETICS.FINANCE …`, canonical and `og:url` `https://memetics.finance/`, `og:site_name` `MEMETICS.FINANCE`, and **zero** `memetic.fun` strings left in any built HTML. **Needed from the operator: authorisation to commit.** The branch is `mvp-launch`, which is trunk, and **trunk auto-deploys to production** — so committing this IS the deploy and IS the public identity change (every share unfurl, the canonical domain, the front door). That is the operator's call to make, not Claude's. Nothing here is blocked on code. |
| 04 domains canonical | PARTIAL — one operator click | live HTTP probe 2026-08-31 | Probed all three directly. **`memetics.finance` — already attached and serving from Vercel** (`Server: Vercel`, `X-Vercel-Id: pdx1::…`), which is why the canonical move is safe: the origin the app is about to declare already answers 200 with the app on it. **`memetic.fun` — attached and serving from Vercel** (same headers); stays as the redirect alias. **`memetics.fun` — NOT on the Vercel project.** It resolves to `76.223.67.189` (not Vercel's `76.76.21.21`), sends no Vercel headers, and serves a registrar parking stub: `<script>window.onload=function(){window.location.href="/lander"}</script>`. That is a GoDaddy-style forwarding rule, not a deployment. **Needed from the operator:** add `memetics.fun` to the Vercel project (one click per message on request), then repoint its DNS off parking. Claude must not change account settings or DNS. |

## Deviations from the changeset, and why

The wave says: apply exactly; if trunk has moved and a hunk does not land, apply that hunk's
intent at the same anchor and say so here; do not redesign. Trunk moved **107 commits** since
the diff's base (`9fbab37`, 2026-08-26 → `5513f0ba`), so this section is the required record.

1. **Applied by intent, not by `git apply`.** The changeset arrived as a PDF, so the diff text
   is not byte-appliable (indentation collapsed, unicode transliterated). Every hunk was applied
   at its named anchor with an assertion that the anchor matched exactly once — a missed anchor
   failed the run loudly rather than silently skipping. Anchors that had drifted and were applied
   by intent: **`AppLayout.tsx`** (trunk added an `onSettledDoorstep` gate and gave `MuseBubble`
   a `bungalow` prop, so the `isToweliVoice()` gate was folded into the existing conditions rather
   than replacing them), **`index.html`** (the description line had been rewritten by the launcher
   wave), **`BungalowDoor.tsx`** (the 2026-08-28 anti-reload-loop guards restructured the
   initializer; only the `?? DEFAULT_BUNGALOW_ID` → `?? null` intent was applied, both guards left
   intact), **`HomePage.tsx`** (the contract-strip gate is now one of two `!bungalowIdentity`
   blocks, so it was anchored on its own comment).
2. **CSP re-pinned from our own tree**, per §2's instruction — and it came out **identical** to
   the diff's hash, confirming the JSON-LD block matches the author's exactly.
3. **Social card badge widened, 214 → 250.** The only visual change made beyond the spec. At the
   specified width the rendered PNG clipped its own text — "BOUNTY" sat outside the pill (checked
   by rendering and zooming the actual `og.png`, not by reading the SVG). A badge that clips its
   text fails the hunk's intent, so the pill was widened to fit; nothing else about the card moved.
4. **`frontend/scripts/render-bungalow-doors.mjs` — not in the changeset, and it had to be.** It
   carries its **own** copy of the canonical origin (`const SITE`) because it runs under bare Node
   at postbuild and cannot import the TS constant. Moving `SITE_URL` to `memetics.finance` without
   it would have shipped all **11 pre-rendered bungalow doors** declaring `canonical` and `og:url`
   on the **old** origin while `index.html` declared the new one — the exact two-halves-disagree
   failure `siteIdentity.test.ts` exists to prevent, one directory outside its reach. Fixed, and
   verified in the built output (`dist/pepe/index.html` → `https://memetics.finance/pepe`).
5. **`siteIdentity.test.ts` — one new case**, pinning (4) so the next origin move cannot leave the
   doors behind. Mutation-verified: reverting the script's origin fails it, and only it.
6. **`e2e/arrival-voice.spec.ts` — new.** The voice resolves at module scope in six separate files;
   a regression in any one is a front-door branding leak that typechecks and unit-tests green. This
   walks both directions in a real browser against the production build.
7. **`SITE_URL` move is API-safe — checked, not assumed.** All **14** origin-gated `api/` surfaces
   already allowlist `https://memetics.finance` (verified one by one). Had any been missing, the
   live venue would have taken `403 Origin not allowed` on every browser-side call — the outage
   class `api/__tests__/canonical-origin.test.js` was written for.

## Tegridy strings found on default-arrival surfaces

§4 asks for any missed string to be contained the same way and listed here. Swept the shared
chrome and the venue home. Everything found was already inside a voice gate — `TowelieAssistant`
(only under `isToweliVoice()`), the Footer copyright, the Towelie quote ticker and the
`@TegridyFarms` share-tweet plus its `aria-label` (all inside the classic hero cluster or the
TOWELI contract strip, both gated).

**Walked all 13 doors to prove it, rather than reasoning about it** (`/toweli` `/bayla` `/pepe`
`/qr` `/mfer` `/bnkr` `/drb` `/bobo` `/jbm` `/soy` `/brainlet` `/rizz` `/nb1`). All 12 non-TOWELI
doors render nav `MEMETICS.FINANCE`, footer `© 2026 memetics.finance`, and a title suffixed
`| MEMETICS.FINANCE`, each over its own resident hero. `/toweli` alone renders `TEGRIDY FARMS`,
`© 2026 Tegridy Farms` and `Farm TOWELI.` The sweep found exactly **one** Tegridy string on all
13 doors: `Tegridy Curve`.

- **"Tegridy Curve" → "Memetics Curve" — RENAMED 2026-08-31, on the owner's call.** It was first
  flagged here as a deliberate non-change (the name of a live on-chain product, the same class as
  the CoW `appCode`); the owner ordered it renamed so nothing outside `/toweli` speaks Tegridy.
  **27 occurrences across 11 files** — the launch-rails card, both nav entries, every curve page
  H1 and `usePageTitle`, the contracts page, and Towelie's knowledge base — plus the 2
  "zero-toll Tegridy bonding curve" meta descriptions that sit on the *same lines* as the renamed
  H1s and would otherwise have contradicted them. **Copy only: routes (`/eth-curve`,
  `/curve-launch`), contract names and addresses are untouched.** Guarded during the rename by
  assertions that `Tegridy Farms` (the CoW `appCode` §4 protects) and `Tegridy pool` counts came
  out unchanged in every file.

**Still saying Tegridy, deliberately:** `Tegridy pool` (17 sites) is the **AMM**, a different
product from the curve, and was not in scope — flagged, not ordered. `TegridyScore` is a distinct
shipped feature. `docs/AUDIT_FRONTEND_2026_08_28.md` keeps the old name because it is a historical
record and must not be rewritten. The CoW `appCode 'Tegridy Farms'` stays untouched per §4.

## Note for the island

`memetics.finance` was already attached to the Vercel project and already serving the app before
this wave — it was simply declaring `memetic.fun` as its canonical and titling itself
"Tegridy Farms | TOWELI Yield Farm". So this wave does not point the venue at a new address; it
makes the venue stop introducing itself as somewhere else.
