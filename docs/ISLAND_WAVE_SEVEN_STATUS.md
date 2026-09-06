# Island — Wave Seven status

The island reads this file from the repo. It is the only "done" the island accepts.

One row per phase. `status` is one of NOT-STARTED · IN-PROGRESS · DONE · BLOCKED · RETIRED.
`evidence` is a commit sha plus the test name that proves the done-means.
BLOCKED rows name exactly what is needed, and from whom.
Updated in the same commit as every phase close.

Opened 2026-09-06 against base `8b6144ae` on `mvp-launch`, from
`jbi-greencifer-wave7-share-v1.3.pdf` (§0–§9, elements A–P).

This file opened the wave at `5f77da9e`, as §7 requires, before any code moved. **One half
of one element has landed since:** element G's flames proxy, which the corrected order puts
ahead of B (see below). Everything else is NOT-STARTED or BLOCKED, and an evidence cell stays
empty until a sha exists. Amended at every phase close, not written once.

## What the opening pass established

Before any edit, all 16 elements were verified claim-by-claim against `8b6144ae`. **250
concrete file:line claims** were checked by reading the files: **155 CONFIRMED · 11
ALREADY_FIXED · 11 LINE_DRIFTED · 36 WRONG · 37 NOT_FOUND.**

The directive's recon is real and current — `VenueDoors.tsx:27` builds
`grayscale(1) brightness(${k})` exactly as written, `AppLoader.tsx:104` gates the click on
exactly `hold | textForm | vortex`, and `AppLayout.tsx:139` reads `tf_loaded` exactly as
described. Its paths omit the `frontend/` prefix and its line numbers have drifted
(`api/aggregator.js:313` is `frontend/api/aggregator.js:303`), so **every anchor is
re-verified at edit time**, per wave five's intent-map method. The PDF text layer is
corrupted the same way wave five's was (`ST A TUS`, `BA YLA`, `TW AB`, every curly
apostrophe flattened), so **no copy string is lifted verbatim from extraction** — each is
normalised against the existing `VENUE` constants, and anything ambiguous is asked, not
guessed.

## The island's upstream was probed live, and it is up

Six of the "does this exist" blockers were closed by reading the island directly rather than
asserting from the repo. Read 2026-09-06:

| probe | result |
|---|---|
| `GET /api/heat/0x279E7CFF…` (our own pinned reference address) | **200** — and the envelope **does** carry `x_handle` (`null` on this cold address, but the key is served) |
| `GET /api/flames?limit=3` | **200** — shape is exactly §4.1's: `x_username · x_pfp · degrees · tier · held_since_unix · token_count · wallet_count · person_id`, plus `as_of_unix` |
| `GET /flames` · `/register` · `/heat` | **200 · 200 · 200** — none is a dead link |

Two findings that change the work:

1. **The §4.1 strip is a real privacy requirement, not a formality.** The live board serves
   `person_id` as a genuine UUID and `wallet_count` up to 14 on the top flame. Those two
   keys link many wallets to one human. The proxy strips them **before** responding, and the
   unit test asserting neither key survives is the structural guarantee — exactly as the
   directive designed it. That test is non-negotiable.
2. **The two endpoints disagree on the field name**, and the directive is right about both:
   `/api/heat` serves `x_handle`, `/api/flames` serves `x_username`. Anything reading both
   must not assume one name. `x_pfp` is served and is **not** in §4.2's type — it is not
   painted this wave.

Element K is unblocked by the same probe: the island's published law page carries its own
sentences to lift — *"The island measures one thing: held time."*, *"TWAB is your
time-weighted average balance: your share of a token's supply, averaged over your whole held
time."*, *"the Apes carry triple weight, JBM and BAYLA carry their edge, the home team leans
warm."* That last grammar directly retires `HeatCard.tsx`'s "The period the average is taken
over has not been published."

## The mandated order is not safe as written

§0 orders A+E first, then B/G/M/N, then C/D/O/P, then F/H/I/K. Four dependencies the
directive missed, each verified by reading the files:

1. **A's gate depends on B.** A's done-means includes `/?heat=<address>` cold-mounts no
   canvas. No `?heat=` reader exists anywhere in `frontend/src`. That clause cannot be
   written until B ships the param.
2. **A alone breaks the art rule.** Cutting `T_ART_COUNT` 4→1 removes three gallery pieces
   from the arrival. The repo never removes art without an additive home, and A's own escape
   hatch is element G's "Watch the arrival" mount — which is phase 2. **A must carry G's
   film mount, or A does not ship.**
3. **C and D are one edit, not two.** The four blocks C deletes are **ungated today**
   (`HomePage.tsx` 780 / 952 / 1000 carry no `bungalowIdentity` gate; only FAQ at 1046
   does). So C is "add a gate", and D changes that same gate on the same lines in the
   opposite direction. Sequenced, whichever runs second reverts the first.
4. **`id="hall"` does not exist.** C, G and H all link to `/#hall`; `VenueDoors.tsx` carries
   no `id` at all. It is a prerequisite of the earliest of the three, not of C.

## Rows

| phase | status | evidence | notes |
|---|---|---|---|
| 00 wave six absorbed | RETIRED | this file | §0 states wave six never landed and its still-true parts ride inside this wave. **The wave six directive is not in this repo** — `rg 'wave six\|W6-'` over `docs/` and `frontend/src` finds only `BATTLE_PLAN.md`'s unrelated venue roadmap. Recorded as a pointer only; we cannot state what was absorbed beyond element I's own aside ("wave six B and D"). **Needed from the island:** wave six's phase list, or confirmation that A–P supersede it wholesale. |
| A the curtain, not the wall | NOT-STARTED | | Anchors confirmed: `AppLayout.tsx:185` `<AppLoader onComplete>`, `AppLoader.tsx:104` click phases, `constants.ts:74-86` timings (current 1500 / 4 / 2600, `T_TEXT_END` 14500). Two corrections: children **already** render outside the lazy boundary (`loader/index.tsx:51`) so the gap is visibility, not mounting; and the art pieces **do** carry titles (`phases/art.ts:76-87`), contra "four art pieces with no words". The `tf_loaded` move is **seven src sites**, not two, and silently kills the replay easter egg at `TopNav.tsx:210`. Reds `loader/index.test.tsx:52,96` and vacuums three e2e seeders. **RULED 2026-09-06 (owner): A ships only together with element G's "Watch the arrival" full-film mount**, so no art is ever homeless — part of G is pulled forward into A's change. The replay easter egg's fate is still open. |
| B the instrument is the hero | IN-PROGRESS — **plumbing DONE** | `heatOracle.test.ts` (75, mutation-verified ×2) | The wave's engine. **B1 landed:** `x_handle` now rides the reading. `HeatReading.xHandle` is stored BARE (no `@`), so §5's "never compare handles with the @ in place" is structural rather than a discipline — there is one form in memory and painting adds the single `@`. `normalizeXHandle()` is exported from `heatOracle.ts` as the ONE implementation, so B, G's board and N's tape cannot drift. **It validates as well as normalises, and that half is a security boundary:** the handle becomes an `href` to x.com and a public byline, and `//evil.example`, `https://…`, `../../login`, `javascript:`, query/fragment smuggling and an RTL override all survive a naive `replace(/^@+/, '')`. Only X's own charset (1-15 of `[A-Za-z0-9_]`) is accepted; anything else reads as unnamed, which is honest, where a spoofed byline is not. A missing handle is explicitly NOT an envelope failure. Mutations: dropping the validation reds 13; stripping one `@` instead of every `@` reds 1. Typecheck 0 (one construction site fixed, `launchPricing.honesty.test.ts:146`), eslint clean, 1149/1149 across heat + launcher. **Still open in B:** the hero recut, the read card order, delta, ladder, insertion rank, cold copy, wallet fill, share intent, `?heat=`. |
| C the home, cut to the line | NOT-STARTED | | **Merge with D — one gate edit on one line range.** Rated M by the directive; it is the riskiest element in the wave. `trustCopyHonesty.test.ts:125` requires `<Link to="/jbm"` to survive in `HomePage.tsx` source, and that link sits at :975 **inside the Ecosystem block C removes**. Also orphans art slots `pageId="home" idx={9..14}` against the additive-art rule, and no HomePage render harness exists. |
| D the room, cut to the token | NOT-STARTED | | **Merge with C.** The scoped-read primitive exists and works (`HeatBreakdownRow.tokenAddress` / `firstSeenAtUnix`, `heatClient.ts:85`). `lpEmissions.ts:81-85` is TOWELI-room copy and must be unreachable from the other twelve doors after this. |
| E zero unasked overlays | NOT-STARTED | | Anchors confirmed. Deleting the `MuseBubble` mount **reds two currently-green e2e outright**, not by flake: `bungalow-doors.spec.ts:116` expects the `— the island` byline on /pepe (it comes only from MuseBubble), and `ambient-bubble-taps.spec.ts:96` asserts the bubble rendered. Both must land in the same commit as the deletion. |
| F the launch page folds | NOT-STARTED | | Anchors confirmed with drift. `heat-gate.spec.ts:136` pins the literal gate sentence — if F edits `gateDecision().detail` in `heatOracle.ts` rather than the render layer, F breaks its own phase. |
| G the board on the venue, and the flames proxy | IN-PROGRESS — **proxy half DONE** | `api/_lib/__tests__/flames.test.js` (36, mutation-verified) | **The proxy landed first, ahead of B**, because B's insertion rank reads it at `limit=500`: it is a prerequisite of the engine, not a peer. `api/_lib/flames.js` + the `?resource=flames` branch at `aggregator.js:326`, verified above `const provider` (:424). Gates copied from `heat.js`, not re-derived. **The strip is an allowlist, not the directive's denylist** — a denylist holds only for the two keys known today, so a third identifying field the island adds later would reach a public board silently; the allowlist drops it instead. `x_pfp` is served upstream and deliberately not forwarded (off-origin avatar = a new CSP img-src entry and a viewer-IP leak; its own decision). Own rate-limit bucket (`identifier: "flames"`), so a board read never starves the tape's heat budget — element N's collision does not spread here. Mutation run: removing the strip reds 4 tests including the headline key assertion; restored, 36/36. Neighbours green (heat + all aggregator suites, 774/774). **Still open in G:** `FlamesBoard.tsx`, the `IslandPage` lobby recut, `id="hall"`, and A's "Watch the arrival" film mount. |
| H the doors in color | NOT-STARTED | | `VenueDoors.tsx:27` / `:134` confirmed exactly. Deleting `dimmedFilter` reds `VenueDoors.test.tsx` (its `isDesaturated` helper asserts settled doors **are** desaturated) and orphans the luma pipeline `doorThumbLuma.test.ts` guards in lock-step with `scripts/generate-image-derivatives.mjs`. |
| I em-dash zero, the guard | NOT-STARTED | | **All 16 claims CONFIRMED — and the element collides head-on with this repo's degraded-read law.** The em dash is the venue's *unreadable* placeholder: `usePoolMarket.ts:13` states the rule outright, "render it as `—`, never as 0", and `LiquidityTab.tsx:391` emits it when a read fails. A body-wide "zero U+2014" assertion therefore **goes red on an RPC outage** — it converts a degraded read into a copy regression, in direct tension with "unreadable must not read as fine". Also: the directive's eight-file census omits `HomePage.tsx`, which carries 67 occurrences — a ~40% undercount. **RULED 2026-09-06 (owner): option (a)** — the rendered assertion is scoped to venue-voice text nodes and leaves degraded-read placeholders alone. No honesty behaviour changes and no existing test moves. Unblocked; the census must be re-sized to include `HomePage.tsx`. |
| J the status file | IN-PROGRESS | `5f77da9e` opened it; amended per phase close | Opened at base `8b6144ae`. Two shape divergences from waves three and five, both deliberate and both flagged: `RETIRED` is a **new** fifth status word (both prior files document four), and §7 says "one row per element A to L" while the directive defines **A to P** — rows are written for all sixteen, since M/N/O/P have done-means of their own. |
| K the published law | NOT-STARTED | | **Unblocked** — the island's `/heat` page is up and its sentences are quoted above. Retires `HeatCard.tsx:446-520`'s computed table and single-token-share sentence, and `heatOracle.ts:1-21`'s "one token caps at 100°". The no-N-day-window and no-decay guards stay exactly as written. Note: the oracle's `HeatBreakdownRow` carries no weight or loyalty term, so no **per-token** breakdown of the law can be painted — only the served figure and the island's words. |
| L the phone wallet class | **BLOCKED** | | **Needs a phone in the operator's hand, once.** `Object.keys(window)` inside Trust Wallet's in-app browser, plus `window.solana?.isTrust`, `window.trustwallet?.solana`, and whether the Standard registry lists anything. Which of the two fixes applies is undecidable until then. If the legacy-adapter branch wins there is nothing in the repo to build on — `package.json:35-38` carries no Trust adapter — making it materially larger than the deep-link branch. Only Phantom's link shape is verified in-repo (`phantomMobile.ts:28`); the MetaMask and Trust formats appear nowhere here and are **unverified against vendor docs**. Trust's `coin_id` splits 501/60 by chain, so the shared "On a phone?" row needs a chain prop. |
| M the read link and the card | NOT-STARTED | | The route ships on its own static-og fallback; its **headline feature cannot** — the island's painted per-wallet card URL does not exist yet (**needed from the island**). One real bug to design around: reusing `heat.js`'s origin gate verbatim would **403 the human clicking from a tweet** (no Origin, `Sec-Fetch-Site: cross-site`) while passing the crawler. Done-means must test a cross-site click, not only curl. Also unbudgeted: `handleHeat` writes the HTTP response on every branch, so "read through the existing path" needs a value-returning extraction under a 500-line test suite. |
| N the named tape | NOT-STARTED | | Upstream `x_handle` **confirmed served**. Two collisions: the proxy caps at `limit: 20/60s per IP` (`heat.js:106-110`), so twelve rows spend 12 of 20 and a second room 429s inside the minute; and raising the cache header 60/120 → 300/600 **reds `heat.test.js:508-511`** and overturns `heat.js:168-172`'s written rationale for the short window. `poolTrades.ts:29` allows `wallet: null`, so null rows must be skipped before the limiter or they burn calls on an empty string. |
| O the first-buy post | **BLOCKED** | | **The trigger does not exist.** No swap anywhere raises `TransactionReceipt`; the only production `showReceipt` calls are `FarmPage.tsx:301/338/348`, all `token:'TOWELI'`. Reads as a one-string change; is actually a new swap-receipt callsite on both `TradePage` and `SolanaSwapPage`. `ReceiptData` carries symbol **strings** only — no token address, no chain, no buyer — so the room-match is not expressible today. And the headline fixture is BAYLA, which is Solana, while the overlay is EVM-only (`sanitizeTxHash` rejects base58; no solscan branch). Depends on M for a link that 404s until M ships. |
| P the planter's flame | **BLOCKED** | | **The creator EOA is `null` in both producers** — `discovery.ts:205` ("not exposed by `new_pools`") and `ourLaunches.ts:127`, which states the Airlock record exposes only `timelock`/`governance`, "neither of which is the creator EOA". With no creator, "a failed read prints nothing" collapses to **prints nothing, always**: the feature would be invisible in production while passing every fixture test. A creator source is a prerequisite, not a detail. Adding it to `LaunchFactSheet` moves the disclosures digest and is a `schemaVersion` call. Both card surfaces are also declared **fetch-free by contract**, so reads must lift to the parent and de-dupe by creator wallet. |
| W4-02 the ninety-day grammar | NOT-STARTED | | Venue-side half verified by reading: no ninety-day certification text exists, and `GardenLane.tsx:78-79` / `certification.ts:12-13` state no criteria at all. None is required unless a surface states what certification takes. The island-side half is **the island's own probe**, attributed here rather than restated as our finding. |
| W4-03 the published law | NOT-STARTED | | Element K. Unblocked by the live read above. |

## Decisions

Flagged, not forced, per §8. The first three were put to the owner on 2026-09-06 and ruled;
the rest stay open and nothing that depends on them is touched.

### Ruled 2026-09-06

1. **Element I's em-dash guard vs. the degraded-read law — RULED: scope to venue-voice.**
   The two could not both hold as written: the em dash is this venue's *unreadable*
   placeholder, so a body-wide assertion turns an RPC outage into a copy regression. The
   rendered leg now walks venue-voice text nodes only. It is the one option that changes no
   honesty behaviour and moves no existing test. Element I is unblocked.
2. **Element A's art cut — RULED: A ships only with G's film mount.** `T_ART_COUNT` 4→1
   removes three gallery pieces from the arrival, and the repo never removes art without an
   additive home. The "Watch the arrival" full-film mount is pulled forward from element G
   into A's own change, so the cut and the new home land together or neither does.
3. **Git handling — RULED: feature branch, commit as you go.** The wave is built on
   `feat/island-wave-seven` off `mvp-launch`, one commit per element close with this file
   amended in the same commit (§7). Nothing reaches trunk without a PR.

### Still open

4. **The replay easter egg** (`TopNav.tsx:210`) stops working when `tf_loaded` moves to
   localStorage. Point it at localStorage, or retire it in favour of G's link.
5. **Element O's receipt.** Should a receipt overlay now interrupt **every** swap? That is a
   product call, not a mechanical edit.
6. **Element M's mechanism.** `middleware.js` already serves dynamic per-address unfurl cards
   at the edge with zero serverless functions (`:23`, `:187-197`). The directive proposes an
   aggregator branch instead. Both work; both should not exist for the same job. Related:
   `middleware.js:15-16` states the card rule "it NEVER asserts a verdict, score or band" —
   M's og:title asserts a tier. Whichever way that goes, the rule text needs amending so the
   next reader is not left with two contradicting laws. And `/read/<address>` should almost
   certainly be `noindex` (both existing card surfaces are); the directive is silent on it.
7. **Element N's rate limit.** Either the per-IP budget moves or the twelve-row cap does.

## Needed from the island

1. Wave six's phase list, or confirmation that A–P supersede it wholesale (row 00).
2. Wave four's full numbering. `ISLAND_WAVE_FIVE_STATUS.md:147-150` already records this ask
   unanswered; W4-02 and W4-03 adopt two labels without their siblings.
3. The painted per-wallet card URL shape for element M's `og:image`.
4. The per-token board route (`/api/flames?token=<address>`) named in §8 as an island rung.
   Until it exists no room paints a per-token board, and nothing here fabricates one.

## Counts

Not yet run. Per wave five's standing warning, **counts are read from a quiet machine only**:
this checkout is on OneDrive and loaded runs have reported up to 70 false failures, including
pure arithmetic that cannot regress from a copy change. A red from a loaded run is not
evidence.
