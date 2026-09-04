# Island — Wave Five status

The island reads this file from the repo. It is the only "done" the island accepts.

One row per phase. `status` is one of NOT-STARTED · IN-PROGRESS · DONE · BLOCKED.
`evidence` is a commit sha plus the test name that proves the done-means.
BLOCKED rows name exactly what is needed, and from whom.
Updated in the same commit as every phase close.

Opened 2026-08-31. Recut for **v3, the lived-walk recut** (base `15d5458c`, tip `2b8ac393`).

**Two shipments, in order.** v1 (the arrival inversion) landed and deployed as `4ba11618`.
v3 arrived after, superseding it — its `arrival.ts` is byte-identical to the one already
shipped apart from two additions, and its `HomePage` diff is the shipped hero work plus the
hall and the noise cut. So v1 is not a false start; it is v3's first half, already live.

| phase | status | evidence | notes |
|---|---|---|---|
| 01 changeset landed | DONE — transport #3 (intent map, §1) | `arrival.test.ts` (14) · `VenueDoors.test.tsx` (6, mutation-verified) · `OnboardingModal.test.tsx` (14) · `siteIdentity.test.ts` (9) · `bungalows.test.ts` (26) | **No `jbi-memetics-wave5.bundle` was supplied** — transport #1 was unavailable, and the §6 diff arrived as PDF text (indentation collapsed, unicode transliterated), so `git apply` was never possible. Applied by **intent at each named anchor**, with an assertion per anchor so a miss failed loudly instead of skipping silently. Every §1 mechanism is in: the choke point, the hall (`VenueDoors`, `OPEN_DOOR_IDS` as the single ruling the picker imports), the invited welcome, the noise cut, the way back, the door-art pass, the studio to prod. |
| 02 gates green | DONE | typecheck 0 · lint 0 errors · **vitest 6370/6370** · build green · e2e 22 | `tsc -b` and `tsc -p tsconfig.test.json` both exit 0. **vitest: 453/453 files, 6370/6370 tests** on a quiet machine (`--maxWorkers=4 --testTimeout=30000`). The 5 pre-existing PWA `InstallPrompt` failures cleared themselves on trunk `15d5458c`. build green — dist-graph gate holds at **29 static closure chunks** with the studio landing as its own **46.76 kB** lazy chunk, 11 door pages rendered.<br><br>⚠️ **Read the count from a QUIET machine.** This checkout is on OneDrive and the default 5000 ms `testTimeout` sits on top of its I/O latency. Loaded runs reported 8, then 13, then **70** failures across 48 files — including `converts 1 ETH wei to 1.0`, pure arithmetic that cannot regress from a copy change. The same suspects passed 35/35 at 30 s. A red count from a loaded run here is not evidence. |
| 03 deployed and live-walked all four ways | DONE | `cbabae0e` deployed · live walk 2026-08-31, all 13 doors | Walked cold on the LIVE site. **Venue arrival:** venue hero, hall present with 13 doors (2 LIVE, 10 SETTLED, 1 QUIET), no farm body (Core Loop / By the Numbers / How the Farm Works / Protocol Overview all absent), page 4,511px, and **zero Tegridy strings anywhere on the page**. **The noise cut and the hall both hold.** **`/toweli`:** classic hero `Farm TOWELI. Check our work.`, `TEGRIDY FARMS` wordmark, `© 2026 Tegridy Farms`, full farm body back, classic art, no hall. **The way back:** from `/pepe`, the picker opens with the venue card FIRST, 11 of 15 tiles greyed; selecting it lands on `/` with the sentinel stored and the hall rendered. **All 13 doors swept:** every settled resident persists its own id, wears its own art (4/4 surfaces from `/art/<id>/`), carries the venue wordmark and copyright, shows **0 Tegridy strings**, and no resident's voice leaks onto another's doorstep. QR correctly wears classic art (no folder); nb1 correctly persists nothing. Bayla: 5/5 own art, her muse present, Towelie absent. |
| 04 domains canonical | PARTIAL — one operator click | live HTTP probe 2026-08-31 | **`memetics.finance`** — attached, Vercel-served, primary. **`memetic.fun`** — attached, Vercel-served, correctly minting og/canonical on the canonical origin. **`memetics.fun` — NOT on the project**: resolves to `76.223.67.189` (not Vercel's `76.76.21.21`), no Vercel headers, serves a registrar parking stub (`window.location.href="/lander"`). **Needed from the operator:** add it to the Vercel project, then repoint DNS off parking. Claude must not change account settings or DNS. |
| 05 studio reachable in prod, export well-formed | DONE | live 2026-08-31: `/bayla-studio` and `/bungalow-studio/jbm` | `/bayla-studio` and `/bungalow-studio/<id>` ship unlisted (URL-only, no nav entry). Prod has **no write path**: the `/__bungalow-studio/save` middleware is dev-only, so Save becomes **"Export placements"**, a client-side download. The client renderer is byte-identical to `bungalowStudioPlugin`'s writer — verified at codepoint level (both `U+2014`, not hyphens), so an exported file and a middleware-written file match for identical picks. Every resident now has a real pool to place. **Verified live:** `/bayla-studio` renders "Bayla Studio", button reads **Export placements** (not Save to disk), 53 pieces / 325 surfaces / 74 overrides, and the dev-only *Auto-save picks* control and classic-studio link are both absent. `/bungalow-studio/jbm` renders "JBM Studio" with its own 64 pieces. |

## The art drop (owner, 2026-08-31)

Ten folders arrived at the **repo root**, not under `frontend/public/art/`. Copied in whole:
**287 pieces** across bayla (53), bnkr (14), bobo (39), brainlet (21), drb (17), jbm (64),
mfer (7), pepe (37), rizz (30), soy (5). QR has no folder and honestly keeps the classic
fallback until one arrives. `scripts/gen-bungalow-art.mjs` scans the real directory and
writes `src/lib/bungalowArtPools.ts`, so a pool can never name a file the deploy lacks.

**The trap that was one line away.** The curator's placements in `bungalowArtOverrides.ts`
are keyed by `artId` (`"bayla|home:0"` → `bayla-05`). Building pool ids from the array index
— the obvious way — would have silently repointed **all 74 saved placements** the moment
Bayla's folder grew from 24 to 53 files. Ids are derived from the **filename** instead;
verified afterwards that all 23 distinct artIds still resolve.

**What the owner will and will not see change.** Of 315 studio surfaces, **74 are pinned**
by saved placements and every pin targets the 08-24 drop; **241 are free** and will rotate
through the enlarged pools. So the nine residents who had no art at all change completely,
while Bayla's curated surfaces stay exactly as placed — overrides beating rotation is the
design, and that is the curator's own work being honoured, not a wiring failure.

## §4 containment — the strings this wave missed

Found on the operator's own lived walk. Two treatments: **voice-gated** where the string is
classic Tegridy *branding*, **renamed** where "Tegridy" meant the operator and the fact is
true in every room. **23 sites**: the PWA manifests (static — a manifest cannot be
voice-gated, so the installed app is now `MEMETICS.FINANCE`), the install prompt, the
onboarding flow and its steps, the transaction receipt, the referral widget, the bounty
placeholder, the community gallery line, the venue-fee lines, the yield router fee label,
the heat card, the DCA pool line, the curve trade panel, and the admin titles.

**A real bug caught in passing:** three prewritten tweets tagged **`@TegridyFarms`**, a
handle nothing else in the app references — the footer's own link is `x.com/junglebayac`.
These post under a *visitor's* name, so the wrong tag survives any later correction. Owner
confirmed 2026-08-31: **`@TegridyFarms` is not theirs, `@JungleBayAC` is.** Repointed. Same
failure class as the `tegridyfarms.io` fix already recorded two lines away in that file.

**Deliberately not touched**, and why: deployed contract names (`TegridyStaking`,
`TegridyFactory`, …) and the ContractsPage rows carrying their addresses — on-chain
identity; `ChangelogPage` — a dated historical record that must not be rewritten;
`TegridyScore` — a distinct shipped feature, a naming decision of its own; the CoW
`appCode`; the `tegridy_telemetry_consent` key. **"Tegridy Curve" → "Memetics Curve"** was
renamed on the owner's explicit call (27 sites, 11 files, display name only — routes and the
`TegridyCurveLauncher` contract untouched), plus the 9 curve-graduation mentions that would
otherwise have read "Memetics Curve … graduates into a Tegridy pool".

## The owner's override: the Tegridy name is retired, not relocated

**This reverses §0 of the island's own wave doc**, and is recorded here as the
owner's decision so the island is not left thinking its instruction was missed.
The wave RELOCATES the classic identity behind `/toweli`; the owner asked for it
retired from every surface. Done 2026-08-31 across **171 sites** — the toweli
room's own copy, then Terms, Privacy, Risks, FAQ, Lore, every page title, the
fee copy on every route, the knowledge base, gallery titles, the leaderboard,
the launcher's graduation copy, and wagmi's appName (what wallets show at
signing). Towelie survives as a **character** — voice, bubble, art. Only the
brand word went.

**Four names did not move, none of them oversights.** Deployed contract names
(`TegridyStaking`, …) are on-chain and printed beside their verified addresses,
so renaming them would make ContractsPage disagree with Etherscan.
`t.me/tegridyfarms` is a real channel. `curveIdentity`'s Arweave tags are
**lookup keys** — already-published token identities are found by them.
`tegridy-*` storage keys would log every visitor out and orphan their saved
bungalow, consent and studio placements.

**One was changed and then reverted, by the suite.** CoW's `appCode` was renamed
under "everything". `cowProtocol.test.ts` caught it: appCode lives INSIDE the
appData document whose keccak256 CoW re-derives and verifies at submission, so
changing it re-hashes appData and **rejects every in-flight order signed against
the old hash** — the exact failure the 2026-08-22 fee-leak audit pinned. Reverted
with the reasoning written into the file. Renaming it is a migration (drain
in-flight orders, then cut), not a copy edit. Still the owner's to order.

**The parody disclosure was reworded by hand, not deleted.** The mechanical pass
turned *"The 'Tegridy Farms' / 'Towelie' brand is a parody reference to a
third-party IP (South Park)"* into the same sentence about memetics.finance —
false, and it would have replaced a live disclosure with a wrong one. Towelie's
character, voice and art still ship, so the exposure narrows without
disappearing; `RisksPage` now says exactly that.

## Other owner calls in the same sitting

- **The walls.** The staking card scrim was `rgba(4,9,18,0.85)` over a `0.55`
  page scrim, stacking into near-black over the resident's art. Now `0.52` and
  `0.38`, in all three staking modules, so every bungalow lightens together.
- **The way back moved to the wordmark.** The picker's venue tile is gone (it
  read like a fourteenth bungalow you could move into). The wordmark persists the
  `venue` sentinel and walks home — which a plain `<Link to="/">` cannot do,
  because with a bungalow stored `/` renders THAT bungalow. Two ways to the
  venue now: the arrival, and the mark.
- **The island mark** replaces the purple bobowelie crop and the purple bolt
  favicon across the tab, the TopNav button in all thirteen skins, the Apple
  touch icon and both PWA icons. Excellent from 64px up; at 28px it reduces to a
  green ring with a squiggle, which still reads and beats what it replaced.
- **Tradermigos → Marketplace** on the five surfaces a visitor reads.
  `/nakamigos` unchanged.

## Deviations from the changeset

1. **`AppLoader.tsx` is not in v3's file list**, but §1 requires the intro's words and gallery
   to come from `loaderIdentity()`. It hardcoded `TEGRIDY`/`FARMS` in four places; wired in
   the v1 pass and kept, rather than reverting to a state §1 contradicts.
2. **Badge pill 214 → 250.** v3 still carries the width whose rendered PNG clips its own
   text — "BOUNTY" sits outside the pill. Caught by rendering and zooming the actual raster,
   not by reading the SVG.
3. **`scripts/render-bungalow-doors.mjs`** carries its own copy of the canonical origin
   (bare Node at postbuild). Without it, all 11 pre-rendered doors would have declared the
   old origin while `index.html` declared the new one. Fixed, and pinned by a new
   mutation-verified case in `siteIdentity.test.ts`.
4. **`e2e/arrival-voice.spec.ts`** added: the voice resolves at module scope in six files, so
   a regression is a front-door leak that typechecks and unit-tests green.
5. **Chain pills** cut to `ETHEREUM · SOLANA · BASE` on the owner's call. Base added (the
   curve launches there; several lighthouses are Base pools). The fail-closed Solana route —
   which drops to `/scan` when the swap rail is dark — is untouched; only the words changed.
6. **`react-refresh/only-export-components`** warns twice on `VenueDoors.tsx` because it
   exports `OPEN_DOOR_IDS` and `doorState` beside components. That is v3's own design (the
   picker imports the ruling so the two cannot disagree). 0 errors.

## Wave four

There is **no wave-four directive anywhere in this repo** — only forward references from
wave three ("we would keep that rail for wave four"). The 08-25 window contains the Bayla
lighthouse / Streamflow staking go-live (`4adad446` the mainnet pool pinned, `0a787734`
staking wired, `5d6cb700` the ceremony and four honesty fixes, `129e9479` one-command
funding). That work is real and on trunk, but mapping it to phase rows would mean inventing
done-means the island never published. **Needed from the island:** wave four's phase list,
and the rows will be filled against its own contract rather than a guess.
