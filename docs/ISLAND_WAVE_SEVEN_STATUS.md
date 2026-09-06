# Island — Wave Seven status

The island reads this file from the repo. It is the only "done" the island accepts.

One row per phase. `status` is one of NOT-STARTED · IN-PROGRESS · DONE · BLOCKED · RETIRED.
`evidence` is a commit sha plus the test name that proves the done-means.
BLOCKED rows name exactly what is needed, and from whom.
Updated in the same commit as every phase close.

> **CLONE THIS TO READ THE WORK:** branch **`feat/island-wave-seven`** on
> `github.com/fomotsar-commits/tegridy-farms`, based on `8b6144ae`. Pushed 2026-09-06.
> Session one's tip is tagged `wave7-session1-latest`. Trunk has since moved to
> `6dddd9dc` (PR #443, multichain liquidity); this branch is not yet rebased onto it.

Opened 2026-09-06 against base `8b6144ae` on `mvp-launch`, from
`jbi-greencifer-wave7-share-v1.3.pdf` (§0–§9, elements A–P), and amended from
`jbi-greencifer-wave7-answer1-share-v1.pdf` (answer one) the same day.

**Answer one resolved all four island asks**, and its rulings are folded in below: the
proxy's allowlist is adopted as the route contract (row 06); wave six's and wave four's
phase lists are opened as their own files; the painted card URL is not yet published;
`/api/flames?token=` does not exist and must not be mocked against a guess.

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
| B the instrument is the hero | IN-PROGRESS — **plumbing DONE** | `heatOracle.test.ts` (75, mutation-verified ×2) | The wave's engine. **B1 landed:** `x_handle` now rides the reading. `HeatReading.xHandle` is stored BARE (no `@`), so §5's "never compare handles with the @ in place" is structural rather than a discipline — there is one form in memory and painting adds the single `@`. `normalizeXHandle()` is exported from `heatOracle.ts` as the ONE implementation, so B, G's board and N's tape cannot drift. **It validates as well as normalises, and that half is a security boundary:** the handle becomes an `href` to x.com and a public byline, and `//evil.example`, `https://…`, `../../login`, `javascript:`, query/fragment smuggling and an RTL override all survive a naive `replace(/^@+/, '')`. Only X's own charset (1-15 of `[A-Za-z0-9_]`) is accepted; anything else reads as unnamed, which is honest, where a spoofed byline is not. A missing handle is explicitly NOT an envelope failure. Mutations: dropping the validation reds 13; stripping one `@` instead of every `@` reds 1. Typecheck 0 (one construction site fixed, `launchPricing.honesty.test.ts:146`), eslint clean, 1149/1149 across heat + launcher.<br><br>**B2 landed — the read surface.** `HeatCard` now paints the island's order (tier · days · degrees · since · tokens), the delta, the cold read and the name-or-door. **`HeatCard` had NO component test before this**, so its whole result area could have been recut on a green suite that never looked at it; `HeatCard.test.tsx` (18) is new and pins the order, both honesty states and the byline. Days are counted `held_since` → `as_of`, **never to our clock** — the span since the island's last reckoning is time it has not counted, and adding it would state a number the oracle never served. The delta is derived during render and remembered in an effect, so first read prints nothing and the second compares; storage is bounded at 24 addresses and every read/write is try/caught (private mode prints nothing, never an error). The cold read gives the sentence plus one door and suppresses ladder, delta and byline. Mutations ×3: counting days to our clock reds 1, dropping the hall link reds 1, remembering before comparing reds 5. Typecheck 0, eslint 0 errors, **1016/1016 across 102 component + heat files**. Also added `id="hall"` to `VenueDoors` (the missing anchor C, G and H all need) with `scroll-mt-24` so the heading clears the sticky bar.<br><br>**B3 landed — the hero is the instrument.** `VenueHero` is three lines now (h1 · `heroPlain` · `heroHook`) and the address field renders always, directly under the hook: a disclosure that hid the answer to the sentence immediately above it was a wall with a handle on it. The three CTAs are gone and **none is orphaned** — verified before removing, not assumed: "Launch on Heat" and "Scan any token" are both in the bar (`navConfig.ts:353`, `:569`), the picker keeps three other doors (`TopNav:292`, `Footer:175`, `BungalowDoorLanding:193`), and the hall sits directly below. `VENUE.heroCopy` was NOT deleted; it now opens `/start`, which this same hero already links to and which rendered no such lede before. The two per-wallet honesty lines are under the card, and `heatPlain`/`heatExample` moved below it rather than being dropped. **B4 landed — the insertion rank.** An UNNAMED flame now reads "Against the island's board right now, this wallet's number would sit at #n of m", computed in the browser from `limit=500` **without** `claimed` (a rank against named flames only would flatter the number), never persisted, never called heat. A NAMED flame gets no such line and the board is not even read for one: their real position is the island's to state, not ours to simulate. A tie sits BELOW the flame already on the board, because ranking above it would assert a placement the island never made. Board off or unreachable, the line is simply absent. **B5 landed — `?heat=` and the share.** `initialAddress` seeds the field and reads on mount while leaving it EDITABLE (unlike `address`, which pins and hides the form): somebody who followed a stranger's number should be one paste from their own. An address that is not one reads as the field's own invalid state rather than being silently swallowed. The share button now ships, because element M shipped first and `/read/<address>` resolves — posting it earlier would have had holders broadcasting dead links. Text is §4.4's exactly, off `SITE_URL` rather than a literal host, and there is **no share on a cold read**: a cold wallet has nothing to post and asking would be the one moment this instrument shames someone. Mutations: showing the share on a cold read reds 1, breaking the seeded auto-read reds 3. **Still open in B:** the five-rung ladder and the wallet fill. **The share button is deliberately NOT built yet** — it posts `memetics.finance/read/<address>` publicly, and that route does not exist until element M, so shipping it first would have holders broadcasting dead links. Same class of error as O. It lands with M or after it. |
| C the home, cut to the line | IN-PROGRESS — **three paths DONE** | `ThreePaths.test.tsx` (7, mutation-verified ×3) | `ThreePaths` is built and mounted on the venue arrival directly after the hall, on the same gate. It is where the hero's three CTAs went, and each card states its requirement at the point of intent. The launch floor is READ from `heatLaunchFloor()` at render, never typed — the one thing here that could rot silently, since a hardcoded 80 renders identically until the day an operator moves the dial and the home promises a different number than the gate enforces. Mutations: typing the floor reds 1, dropping a path reds 3, putting an em dash in venue voice reds 2. **Still open in C: the removals** (Launch & Verify, Ecosystem, Collection, FAQ, the hero trust-badge row), which are **one gate edit shared with D** — see below.<br><br>**Merge with D — one gate edit on one line range.** Rated M by the directive; it is the riskiest element in the wave. `trustCopyHonesty.test.ts:125` requires `<Link to="/jbm"` to survive in `HomePage.tsx` source, and that link sits at :975 **inside the Ecosystem block C removes**. Also orphans art slots `pageId="home" idx={9..14}` against the additive-art rule, and no HomePage render harness exists. |
| D the room, cut to the token | NOT-STARTED | | **Merge with C.** The scoped-read primitive exists and works (`HeatBreakdownRow.tokenAddress` / `firstSeenAtUnix`, `heatClient.ts:85`). `lpEmissions.ts:81-85` is TOWELI-room copy and must be unreachable from the other twelve doors after this. |
| E zero unasked overlays | NOT-STARTED | | Anchors confirmed. Deleting the `MuseBubble` mount **reds two currently-green e2e outright**, not by flake: `bungalow-doors.spec.ts:116` expects the `— the island` byline on /pepe (it comes only from MuseBubble), and `ambient-bubble-taps.spec.ts:96` asserts the bubble rendered. Both must land in the same commit as the deletion. |
| F the launch page folds | NOT-STARTED | | Anchors confirmed with drift. `heat-gate.spec.ts:136` pins the literal gate sentence — if F edits `gateDecision().detail` in `heatOracle.ts` rather than the render layer, F breaks its own phase. |
| G the board on the venue, and the flames proxy | IN-PROGRESS — **proxy half DONE** | `api/_lib/__tests__/flames.test.js` (36, mutation-verified) | **The proxy landed first, ahead of B**, because B's insertion rank reads it at `limit=500`: it is a prerequisite of the engine, not a peer. `api/_lib/flames.js` + the `?resource=flames` branch at `aggregator.js:326`, verified above `const provider` (:424). Gates copied from `heat.js`, not re-derived. ✅ **THE ALLOWLIST IS NOW THE ROUTE CONTRACT** — answer one adopted this shape for `/api/flames`: exactly `x_username · degrees · tier · held_since_unix · token_count`, with `x_pfp` dropped. Adding a key is a change to the island's contract, not a local edit. **The strip is an allowlist, not the directive's denylist** — a denylist holds only for the two keys known today, so a third identifying field the island adds later would reach a public board silently; the allowlist drops it instead. `x_pfp` is served upstream and deliberately not forwarded (off-origin avatar = a new CSP img-src entry and a viewer-IP leak; its own decision). Own rate-limit bucket (`identifier: "flames"`), so a board read never starves the tape's heat budget — element N's collision does not spread here. Mutation run: removing the strip reds 4 tests including the headline key assertion; restored, 36/36. Neighbours green (heat + all aggregator suites, 774/774). **The card landed too.** `flamesClient.ts` + `FlamesBoard.tsx`, mounted on the home at `limit=5` and opening the Island lobby at `limit=25`. The client keeps **three outcomes distinct** where a careless one would collapse them: a board, a board that is OFF (204 → `null`), and a read we could not make (throws). A 200 whose shape moved, or rows that arrived but none of which parsed, **throw** rather than answering "nobody is on the island" — the repo's most repeated bug class, and the one this file exists to refuse. Failures are never cached, so an outage cannot outlive itself; an OFF board is cached, so a dark board is not re-asked every render. The card **unmounts rather than apologising**: no error string ever reaches a visitor. Board handles run through the SAME `normalizeXHandle` as the reading rather than §4.2's local `handleOf`, which strips but does not validate — one implementation, so a spoofed handle cannot enter through whichever surface forgot to check. Mutations ×4: an unreadable board reading as empty reds 1, the card apologising reds 4, a tie displacing an existing flame reds 1, caching a failure reds 4. `flamesClient.test.ts` (30) + `FlamesBoard.test.tsx` (11), 41/41. **Still open in G:** A's "Watch the arrival" film mount and the lobby's em-dash rewrite. `id="hall"` shipped with B2. |
| H the doors in color | NOT-STARTED | | `VenueDoors.tsx:27` / `:134` confirmed exactly. Deleting `dimmedFilter` reds `VenueDoors.test.tsx` (its `isDesaturated` helper asserts settled doors **are** desaturated) and orphans the luma pipeline `doorThumbLuma.test.ts` guards in lock-step with `scripts/generate-image-derivatives.mjs`. |
| I em-dash zero, the guard | NOT-STARTED | | **All 16 claims CONFIRMED — and the element collides head-on with this repo's degraded-read law.** The em dash is the venue's *unreadable* placeholder: `usePoolMarket.ts:13` states the rule outright, "render it as `—`, never as 0", and `LiquidityTab.tsx:391` emits it when a read fails. A body-wide "zero U+2014" assertion therefore **goes red on an RPC outage** — it converts a degraded read into a copy regression, in direct tension with "unreadable must not read as fine". Also: the directive's eight-file census omits `HomePage.tsx`, which carries 67 occurrences — a ~40% undercount. **RULED 2026-09-06 (owner): option (a)** — the rendered assertion is scoped to venue-voice text nodes and leaves degraded-read placeholders alone. No honesty behaviour changes and no existing test moves. Unblocked; the census must be re-sized to include `HomePage.tsx`. |
| J the status file | IN-PROGRESS | `5f77da9e` opened it; amended per phase close | Opened at base `8b6144ae`. Two shape divergences from waves three and five, both deliberate and both flagged: `RETIRED` is a **new** fifth status word (both prior files document four), and §7 says "one row per element A to L" while the directive defines **A to P** — rows are written for all sixteen, since M/N/O/P have done-means of their own. |
| K the published law | NOT-STARTED | | **Unblocked** — the island's `/heat` page is up and its sentences are quoted above. Retires `HeatCard.tsx:446-520`'s computed table and single-token-share sentence, and `heatOracle.ts:1-21`'s "one token caps at 100°". The no-N-day-window and no-decay guards stay exactly as written. Note: the oracle's `HeatBreakdownRow` carries no weight or loyalty term, so no **per-token** breakdown of the law can be painted — only the served figure and the island's words. |
| L the phone wallet class | **BLOCKED** | | **Needs a phone in the operator's hand, once.** `Object.keys(window)` inside Trust Wallet's in-app browser, plus `window.solana?.isTrust`, `window.trustwallet?.solana`, and whether the Standard registry lists anything. Which of the two fixes applies is undecidable until then. If the legacy-adapter branch wins there is nothing in the repo to build on — `package.json:35-38` carries no Trust adapter — making it materially larger than the deep-link branch. Only Phantom's link shape is verified in-repo (`phantomMobile.ts:28`); the MetaMask and Trust formats appear nowhere here and are **unverified against vendor docs**. Trust's `coin_id` splits 501/60 by chain, so the shared "On a phone?" row needs a chain prop. |
| M the read link and the card | **DONE** | `middleware.test.js` (17, mutation-verified ×3) · `HeatCard.test.tsx` (30) | Built at the EDGE in `middleware.js`, not as an aggregator branch, and that is a deliberate departure with three reasons. (1) The directive's own design 403s its readers: reusing `heat.js`'s origin gate would refuse a human arriving from a tweet (no `Origin`, `Sec-Fetch-Site: cross-site`) while admitting the crawler. The edge has no such gate. (2) `middleware.js` already serves per-address unfurl cards for `/scan` and `/deployer` by exactly this pattern, intercepting **unfurl bots only** and letting humans fall through to the SPA, so no meta-refresh hop exists at all. (3) Zero serverless functions added, against a 11/12 budget. **No `vercel.json` rewrite was needed either** — the catch-all `/((?!api/).*)` → `index.html` already serves `/read/<address>`, and middleware runs before rewrites, so a bot gets the card and a human gets the app. og:title carries tier, days and degrees; days are the island's measured span, never our clock; `summary_large_image`; `noindex` (≈10^47 addresses answer 200 here, so it is a share surface, not a crawl surface); `s-maxage=300`. **A cold wallet and a failed read BOTH fall back to the generic card** — neither is "0°". og:image is the venue's static card until the island publishes its painted one. Human path: `/read/:address` → `/?heat=<address>`, so `?heat=` is the ONE hydration path and a shared link cannot drift from a pasted one. `middleware.js` had NO test before this; 17 now. Mutations: dropping og:title reds 1 (the directive's own named mutation), printing a zero on a cold wallet reds 1, serving the stub to humans reds 1. **The card rule at `middleware.js:15-20` was amended in the same commit** rather than left contradicting itself: it forbids asserting a verdict *we* compute, and a heat tier is the island's number quoted, not ours asserted. | The route ships on its own static-og fallback; its **headline feature cannot** — the island's painted per-wallet card URL does not exist yet (**needed from the island**). One real bug to design around: reusing `heat.js`'s origin gate verbatim would **403 the human clicking from a tweet** (no Origin, `Sec-Fetch-Site: cross-site`) while passing the crawler. Done-means must test a cross-site click, not only curl. Also unbudgeted: `handleHeat` writes the HTTP response on every branch, so "read through the existing path" needs a value-returning extraction under a 500-line test suite. |
| N the named tape | NOT-STARTED | | Upstream `x_handle` **confirmed served**. Two collisions: the proxy caps at `limit: 20/60s per IP` (`heat.js:106-110`), so twelve rows spend 12 of 20 and a second room 429s inside the minute; and raising the cache header 60/120 → 300/600 **reds `heat.test.js:508-511`** and overturns `heat.js:168-172`'s written rationale for the short window. `poolTrades.ts:29` allows `wallet: null`, so null rows must be skipped before the limiter or they burn calls on an empty string. |
| O the first-buy post | **BLOCKED** | | **The trigger does not exist.** No swap anywhere raises `TransactionReceipt`; the only production `showReceipt` calls are `FarmPage.tsx:301/338/348`, all `token:'TOWELI'`. Reads as a one-string change; is actually a new swap-receipt callsite on both `TradePage` and `SolanaSwapPage`. `ReceiptData` carries symbol **strings** only — no token address, no chain, no buyer — so the room-match is not expressible today. And the headline fixture is BAYLA, which is Solana, while the overlay is EVM-only (`sanitizeTxHash` rejects base58; no solscan branch). Depends on M for a link that 404s until M ships. |
| P the planter's flame | **BLOCKED** | | **The creator EOA is `null` in both producers** — `discovery.ts:205` ("not exposed by `new_pools`") and `ourLaunches.ts:127`, which states the Airlock record exposes only `timelock`/`governance`, "neither of which is the creator EOA". With no creator, "a failed read prints nothing" collapses to **prints nothing, always**: the feature would be invisible in production while passing every fixture test. A creator source is a prerequisite, not a detail. Adding it to `LaunchFactSheet` moves the disclosures digest and is a `schemaVersion` call. Both card surfaces are also declared **fetch-free by contract**, so reads must lift to the parent and de-dupe by creator wallet. |
| W4-02 the ninety-day grammar | **DONE** | this commit · `heatOracle.ts` + `BirthQueuePanel.tsx:67` | Answer one supplied the grammar verbatim ("Arrivals prove ninety days. Births don't.") and named ONE site to fix. **There were two.** The comment at `heatOracle.ts` was there as described. But `BirthQueuePanel.tsx:67` is rendered JSX, not a comment, and told every reader of the birth-queue panel that Heat is measured from birth "rather than after a half-year wait" — so answer one's "no rendered venue surface states the old figure any more" was false, and the site it missed is the one a person actually reads. Both corrected. Full record in `docs/ISLAND_WAVE_FOUR_STATUS.md`. |
| W4-03 the published law | NOT-STARTED | | Element K. Unblocked by the live read above. Wave four's full phase list now lives in `docs/ISLAND_WAVE_FOUR_STATUS.md`. |
| 16 the art runbook | NOT-STARTED | | New in answer one, carried from wave six G, and **deliberately last: infra and UI first**. `docs/ISLAND_ART_RUNBOOK.md`, five steps, plain words, zero em dashes: per-bungalow folders at the repo root · `scripts/gen-bungalow-art.mjs` · ids from FILENAMES, never from array index (the repo's own art law — overrides key on artId, and an index-keyed override silently repaints the wrong piece) · placement in the live per-door studios · export DMed back. The QR has no folder. The art itself is the owner's lane and nothing in this wave waits on it. |

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

**All four session-one asks were answered on 2026-09-06 (answer one).** Recorded closed:

1. ~~Wave six's phase list~~ → supplied, seven elements, opened as
   `docs/ISLAND_WAVE_SIX_STATUS.md`. Six RETIRED into wave seven; **row C is not**, because
   the tab it concerns is not gated off (see that file).
2. ~~Wave four's numbering~~ → supplied, six phases, opened as
   `docs/ISLAND_WAVE_FOUR_STATUS.md`. This also closes the ask standing since
   `ISLAND_WAVE_FIVE_STATUS.md:147-150`.
3. ~~The painted card URL~~ → answered, and the answer is "not yet". The card is a PAGE at
   `memetics.wtf/card/<wallet>`, live but **not fired** (the owner's two taps in the island's
   growth lane, not ours). The IMAGE url behind its `og:image` is unpublished and will be
   handed over exact in a later status exchange. Element M's `og:image` stays the venue's
   static card, which is what it already does. **Explicitly forbidden and not done:** do not
   scrape the card page for its image URL, and do not point `og:image` at a page.
4. ~~`/api/flames?token=`~~ → answered: **does not exist tonight.** Nothing to read and
   nothing to mock against a guess. No room paints a per-token board; element D's "Your held
   time in `<SYMBOL>`" is the per-token read that exists, and it is enough for this wave.

**Still open, and now the only island-side blockers:**

- The card IMAGE url, once the card is fired (element M's headline feature).
- `/api/flames?token=<address>`, if a per-token board is ever wanted (element N/D).

## Counts

**vitest 5619/5622 across 383 files** over `src/components`, `src/pages`, `src/lib` and
`middleware.test.js`, on a quiet machine (`--maxWorkers=2 --testTimeout=30000`, 521 s).
Typecheck 0 across both projects (`tsc -b --force` and `tsc -p tsconfig.test.json`) for every
file this wave owns. eslint 0 errors on every file this wave has touched. Server-side: 774/774
across the heat and aggregator suites.

**The 3 reds are the other session's, and that is provable rather than assumed.** They are
`bungalowStakingRates.test.ts > lockPresets`, failing because "6 Months" and "1 Year" vanished
from the ladder. `git log mvp-launch..HEAD -- frontend/src/lib/bungalowStaking.ts
frontend/src/lib/bungalowStakingRates.test.ts` is **empty** — no wave-seven commit has ever
touched either file — and the uncommitted diff in `bungalowStaking.ts` introduces
`OFFERED_LOCK_CEILING_DAYS = 90` and `offeredMaxLockDays()`, which is exactly what removes
those two presets. That is the u64 claim-ceiling work in flight with its sibling test not yet
updated. Wave seven's own effective count is 5619/5619.

**One pre-existing red, not ours and not touched:** `src/lib/bungalowStakingCeiling.test.ts`
is UNTRACKED (no git history, present in the worktree before this wave opened) and fails at
import on five exports `bungalowStaking` does not have — `CLASSIC_ACCOUNTED_CEILING`,
`claimCeilingReached`, `anyClaimCeilingReached`, `maxSafeStakeRaw`, `maxSafeStakeAcrossPools`.
It is WIP for the Streamflow u64 claim ceiling and it fails identically with every wave-seven
commit reverted. Excluded from the count above; named here so nobody reads it as ours.

⚠️ **A SECOND SESSION IS EDITING THIS CHECKOUT.** From 2026-09-06 a parallel task (the
Streamflow u64 claim-ceiling guard, see the pre-existing red above) began editing
`frontend/src/lib/bungalowStaking.ts`, `frontend/src/components/bungalow/LighthousePoolLive.tsx`
and `frontend/scripts/bayla-lighthouse-ceremony.mjs` in this same working tree. Those files are
**not wave seven's** and are not staged by any wave-seven commit; each commit here stages an
explicit file list rather than `git add -A` for exactly this reason, and `wave7-session1-…` tags
the tip. A `tsc -b` run may therefore report errors in `LighthousePoolLive.tsx` that belong to
that work mid-edit. Check `git status` before reading any red as ours.

Per wave five's standing warning, **counts are read from a quiet machine only**: this checkout
is on OneDrive and loaded runs have reported up to 70 false failures, including pure arithmetic
that cannot regress from a copy change. A red from a loaded run is not evidence.

Not yet run this wave: the full e2e suite, the production build, and the rest of the §6 cold
walk (element L still needs a phone).

## Walked on a real deploy, 2026-09-06

Vercel's GitHub integration auto-built a preview from the pushed branch (deployment for
`50e0c97a`). **Walked in a browser against that deploy, not a dev server**, reading the live
island. What was seen, not inferred:

- **Element M's human path works.** `/read/0xd71caf9f…` redirected to `/?heat=0xd71caf9f…`
  and the instrument hydrated and read on load, with no click.
- **The read paints the island's order**, live: `ELDER` · `1,694 days held` · `1787.63°` ·
  `on the island since January 2022` · `18 tokens counted`, then `Reckoned 7h ago`, then
  `@_seacasa · On the board.`, then the 18-row breakdown summing to 1787.63°.
- **The insertion rank was correctly ABSENT** — this flame is named, so its real position is
  the island's to state. The suppression is not just unit-tested; it was observed.
- **The board rendered five named flames** with degrees, tier verbatim, since-month and token
  counts, both island doors under it, and `read Sep 6, 19:16 UTC`.
- **THE STRIP HOLDS IN PRODUCTION.** Neither `wallet_count` nor `person_id` appears anywhere
  in the rendered page. The unit test asserts it; the deploy confirms it.
- The three paths render with `The floor is 80°.`, and the hero is three lines with the field
  always open and one filled button.
- Both proxy calls were observed at the network layer and both answered **200**:
  `?resource=heat&address=…` and `?resource=flames&limit=5&claimed=1`.

**Element A's premise is confirmed live, and it is worse than the source read suggested.**
`get_page_text` returned the FULLY hydrated home — reading, board, paths, hall — while a
screenshot at the same instant showed only the arrival film. The app is mounted and complete
underneath an opaque `z-index: 9999` canvas for the full ~14.5 s. Nothing is waiting to
render; it is purely a visibility and interactivity wall, exactly as element A argues.

**Still not done, and it needs the operator:** the X card validator walk against
`/read/<address>`. The preview sits behind **Vercel SSO deployment protection** (a bot request
302s to `vercel.com/sso-api`), and X's crawler cannot authenticate. Turning protection off, or
issuing a Protection Bypass for Automation token, is an account setting and therefore the
operator's click, never Claude's. The same middleware path DID pass the validator on the live
`/scan` card the same day (`Page fetched successfully · 14 metatags · twitter:card =
summary_large_image · Card loaded successfully`), so the mechanism is proven; only this route's
title is unwalked.
