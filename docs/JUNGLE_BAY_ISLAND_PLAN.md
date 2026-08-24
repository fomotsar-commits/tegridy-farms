# Jungle Bay Island — the 13-bungalow buildout

*Written 2026-08-24. Companion code shipped the same day on `mvp-launch`
(`island: Jungle Bay bungalows — Bayla background skin + picker after the intro`).*

One island, one protocol, thirteen bungalows. Each bungalow is a Jungle Bay
community token, and entering one re-dresses memetics.finance in that
token's art. The farm, the rails, the contracts and every button stay the
same — **bungalows swap backgrounds, never buttons.** The flow the operator
described is now the app's real flow:

> intro → arrive on the island → pick your bungalow → the app wears its art

---

## 1. What is live today (Phase 1 — shipped)

- **`frontend/src/lib/bungalows.ts`** — the island registry. 13 slots:
  **Toweli** (live, Ethereum, the default — classic art system untouched),
  **Bayla** (live, Solana, mint `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump`,
  24-piece pool at `/public/art/bayla/`), **DRB** (named, awaiting
  token/art), and ten reserved slots.
- **`pageArt()` is bungalow-aware** (`frontend/src/lib/artConfig.ts`). An
  active bungalow's pool feeds every background/card/stat-tile art surface
  app-wide through the same deterministic rotation — zero per-surface edits.
  Two surfaces are pinned classic in every bungalow: `nav-logo` (a button)
  and `loader` (the shared island intro). `/art-studio` overrides apply to
  the classic skin only.
- **`BungalowPicker`** (`frontend/src/components/BungalowPicker.tsx`) — the
  screen after the intro. Auto-opens exactly once (first real splash, no
  persisted choice); any dismissal persists, so it never nags. Reopen it
  anytime from the footer's **🏝️ Bungalows** entry (Product column), or deep
  link with **`?bungalow=bayla`** (persists and sticks).
- **Switching = persist + reload.** `pageArt()` is consumed at module scope
  (loader constants, stat rows), so a reload is the one honest way to
  re-resolve every surface; within a session the splash doesn't replay.
- **Verification harness** — `frontend/scripts/verify-bungalows.mjs`
  (playwright-core, no e2e infra needed):
  `node scripts/verify-bungalows.mjs <outDir> [baseUrl]`. Asserts: art swaps
  on home/farm/swap/dashboard, nav-logo stays classic, every pool image
  returns 200, first-visit picker flow works, no re-nag. 15/15 on ship day,
  desktop + iPhone 14 Pro + iPad.
- **Tests** — `frontend/src/lib/bungalows.test.ts` (12) pin the registry
  shape, pool integrity against files on disk, swap rules, and resolution
  order. Suite on ship day: 5,969/5,969 green, tsc + eslint clean.

## 2. The bungalow contract (what a slot needs to go live)

```ts
{ id, name, symbol, chain, address, tagline, thumb, artPool, live }
```

Backgrounds-only is the Phase-1 contract on purpose: a bungalow with just an
art pool is already a complete, shippable experience, and nothing about a
slot blocks the later phases below.

### Onboarding recipe (repeatable, ~one session per bungalow)

1. **Confirm the token** — name, symbol, chain, contract/mint. Operator
   supplies this; never guess an address.
2. **Gather the art** — 15–30 pieces. Portrait and landscape both work
   (`object-fit: cover`); busy pieces read best behind the darker pages.
3. **Drop files** at `frontend/public/art/<id>/<id>-01.jpg …` (stable
   two-digit names, same as `/art/bayla/`).
4. **Register** — build the pool in `bungalows.ts` (the `BAYLA_ART`
   generator is the template), fill the slot, set `live: true`.
5. **Verify** — `vitest run src/lib/bungalows.test.ts` (extend the pool
   test), then `node scripts/verify-bungalows.mjs` against the dev server
   with the new id.
6. **Commit on `mvp-launch`.** Do not push unasked.

## 3. The island roster — CANON (resolved 2026-08-24)

Read from the island's own landing (memetics.wtf `SPOTS` + `SIGNSV2`
registries) and pinned verbatim in `lib/bungalows.ts` +
`bungalows.test.ts`. Three chains — Ethereum, Base, Solana — exactly the
chains the venue has incorporated.

| # | Bungalow | Chain | Address / mint | Island status | Skin |
|---|----------|-------|----------------|---------------|------|
| 1 | TOWELI | Ethereum | `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D` | SETTLED | **LIVE (default)** |
| 2 | BAYLA | Solana | `7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump` | NEWEST — "The muse was always here." | **LIVE + token-first identity** |
| 3 | PEPE | Ethereum | `0x6982508145454ce325ddbe47a25d4ec3d2311933` | SETTLED | art drop needed |
| 4 | QR | Base | `0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf` | SETTLED | art drop needed |
| 5 | MFER | Base | `0xe3086852a4b125803c815a158249ae468a3254ca` | SETTLED | art drop needed |
| 6 | BNKR | Base | `0x22af33fe49fd1fa80c7149773dde5890d3c76f3b` | SETTLED | art drop needed |
| 7 | DRB | Base | `0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2` | SETTLED | art drop needed |
| 8 | BOBO | Solana | `4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump` | SETTLED · hammers up | art drop needed |
| 9 | JBM | Base | `0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d` | SETTLED | art drop needed |
| 10 | SOY | Solana | `4G3kNxwaA2UQHDpaQtJWQm1SReXcUD7LkT14v2oEs7rV` | SETTLED | art drop needed |
| 11 | BRAINLET | Solana | `8NNXWrWVctNw1UFeaBypffimTdcLCcD8XJzHvYsmgwpF` | SETTLED | art drop needed |
| 12 | RIZZ | Base | `0x58d6e314755c2668f3d7358cc7a7a06c4314b238` | SETTLED | art drop needed |
| 13 | (unmarked) | — | — | QUIET — "Someone is building here." | reserved |

**Open ask (was: the whole roster; now just):** an art drop per settled
bungalow to open its skin, and each community's blessing. Addresses and
chains are canon — never edit them by hand without re-reading the island
source (the registry test pins them).

Also canon, for later phases: the island's non-bungalow spots — THE PIER
(arrival), THE GALLERY (lit, 24 credited works by the Jungle Bay Artists
Collective), THE BODEGA (opening soon), DMT LAGOON (portal), LOTs N/W/S
("Qualifying heat builds here"), and the three doors (CHECK YOUR HEAT /
BRING YOUR COMMUNITY HOME / CLAIM YOUR SPOT). The Phase-3 island-map picker
should be drawn from THIS geography.

## 4. Phase 2 — bungalow token utility (backgrounds → economy)

Reuse existing rails; near-zero new surface:

- **Default trade route per bungalow.** Solana bungalows: the `/solana`
  Jupiter swap already handles any SPL mint — preset the output mint to the
  active bungalow's token. Ethereum bungalows: preset `/swap`. One
  `getActiveBungalow()` read in each page's default-token init.
- **Bungalow contract card.** Footer already renders the TOWELI contract
  with a copy button; render the active bungalow's mint alongside it.
- **Price/scan integration.** `/scan` reads both chains today — link the
  active bungalow's token to its scanner page from the picker card.
- **Buy button target.** The hero "Buy TOWELI" stays TOWELI (it's a button,
  and TOWELI is the protocol token). Additively, the picker card can carry
  a small "Trade BAYLA →" link into the preset swap route.

## 5. Phase 3 — the island map (picker v2)

The grid modal is the functional v1. V2 replaces the grid with an island
map screen after the intro — bungalows as locations (the `jungle-bus`
"Jungle Bay Island" piece is the reference vibe), hover/tap to peek a
bungalow's art, enter to skin. Keep the grid as the reduced-motion and
screen-reader path; the map is presentation over the same registry, so no
registry changes are needed.

## 6. Phase 4 — island-wide play (all additive)

- **Island passport** — visited/entered bungalows tracked client-side; a
  gallery-style page showing each bungalow's art you've unlocked.
- **Per-bungalow leaderboards** — the points system already exists; add a
  bungalow dimension to season points once >2 bungalows are live.
- **Bungalow events** — the SeasonalEventBanner already rotates; scope
  event skins to bungalows (e.g. Bayla week).
- **Cross-chain staking surfaces per bungalow token** — see §7; nothing in
  the bungalow layer assumes it.

## 7. Chains and staking reality check (as of 2026-08-24)

- **Ethereum mainnet** — full stack live (staking, farm, launcher).
- **Solana** — Jupiter swap + scanner live; our own launch rail is dark
  (previous program ids are spent; redeploy is an operator ceremony).
  Solana bungalow tokens get instant swap support via Jupiter — no new
  contracts needed for Phase 2.
- **Base + Robinhood (4663)** — code-complete on `claude/jolly-ritchie-*`,
  awaiting the operator merge/ceremony. When it lands, bungalow slots can
  carry those chains with no bungalow-layer changes (`chain` is a string
  union — extend it then).
- **Staking** — the operator flagged it; a dedicated code-audit pass ran
  alongside this work — see `docs/STAKING_LOOK_2026_08_24.md`. Headlines to
  hold in mind while planning bungalow economies: the TOWELI emissions
  reserve is a one-time seed with a visible runway on /farm (~35 days at
  the ship-day rate), ETH real-yield to stakers waits on the native pool,
  and TegridyStaking sits ~22 bytes under the EIP-170 size limit — treat
  the deployed artifact as frozen.

## 8. House rules that bind this work

1. **Backgrounds, not buttons.** Token logos, CTAs, nav chrome never swap.
2. **Additive only** — the classic Towelie skin is never edited, only
   layered over. Removing/replacing existing art requires an explicit ask.
3. **Minimal surface** — the whole feature is one lib + one component +
   one `pageArt()` branch. Keep it that shape; resist per-page forks.
4. **Verify against the rendered thing** — run the harness script per
   bungalow, per device class, before calling a skin done.
5. **Commit to `mvp-launch`, never push unasked.**
