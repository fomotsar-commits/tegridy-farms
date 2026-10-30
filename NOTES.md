# NOTES

A running log of things learned while working in this repo: measured constants,
traps that cost real time, and techniques that are not obvious from the code.

Rules for entries, so this stays worth reading:

- **Measured, not assumed.** If an entry states a number, it came from running
  something. Say what was run. A default you read in docs is not a measurement.
- **Lead with the belief that was wrong.** The useful part of a trap is the thing
  a competent person would otherwise have believed.
- **Transferable only.** Facts about *this codebase's shape* belong in the code
  or its comments. This file is for what you could not have learned by reading.
- Newest first.

---

## 2026-10-30: CSL's `PlutusScript.from_bytes_v2` gave an Aiken script the wrong hash

**Believed:** an Aiken `plutus.json` `compiledCode` loads into CSL 17 with
`PlutusScript.from_bytes_v2(bytes)`. **Measured:** the batcher's test-world order script
(`feat/cardano-batcher` `test/fixtures/test-deployment.json`) hashed to `53ed6f4e…` that way, not its
real `e9690f33…`, so a reference UTxO made from it would have run nothing of ours.
`PlutusScript.new_with_version(bytes, Language.new_plutus_v2())` gave `e9690f33…`, as the batcher's
`test/world.ts` loads it. **Do:** load compiled code with `new_with_version`, and check the hash
before trusting a simulate run against it (`aiken tx simulate`, Aiken 1.0.24, is in WSL at
`/root/aiken-1.0.24/aiken`).

## 2026-10-30: CSL's script data hash goes stale when coin selection adds inputs, and "square root" in any string is a formula

**Believed:** with CSL 17, `calc_script_data_hash` is called once, after the scripts' redeemers
are set. **Measured:** building our pool opening (one factory spend, one mint, both from
reference scripts) in `ownPools/openPoolTx.ts`. Called before `add_inputs_from_and_change`, the
hash covered redeemer index 0; the wallet's coins then sorted in ahead of the factory input,
`build_tx` wrote the redeemer with its real index, and the hash no longer matched (our read-back
caught it: "its script data does not match its own instructions"). Called only after, CSL's fee
missed the hash's own bytes ("Fee is less than the minimum fee. Min fee: 534840, Fee: 533476").
**Do:** call it before the coin selection (so the fee counts it) AND again after (the index is
final only then); the hash is 32 bytes either way, so the fee holds.

**Believed:** a developer-facing error string is not user-facing copy. **Measured:**
`src/lib/heat/islandClaims.test.ts` "states no a formula line" reads every string literal in
shipped source; `throw new Error('square root of a negative number')` in a Cardano maths file
failed it. **Do:** name the contract function (`calculate_sqrt`) in error strings, never the maths.

## 2026-10-29: a pushed tag holds a PR's merge, a failed vault execute still reads "Approved", and funding a wallet can turn the registry red

**Believed:** tagging a PR's head on origin is free bookkeeping.
**Measured:** pushing `wip/todo-batch-numbers-1` started a full `solana-ci` run with event `push`
on that tag (run 40821977089, created 05:11 UTC; at 05:31 two of its jobs were still queued). It
attaches to the PR's head commit, so the PR showed four pending checks after its own
`pull_request` run of the same workflow had passed. A "merge once its checks finish" word then
waited on a run nobody needed. **Do:** keep rescue tags local (`git tag`), or push them only for
commits that are not a PR's head.

**Believed:** a vault proposal whose execute failed is closed.
**Measured:** Squads proposal #18 (multisig `EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`) failed
its execute on 2026-10-27 because its buffer was gone, and on 2026-10-29 its account still reads
`Approved`. A failed execute changes nothing in the proposal, so every signing page keeps offering
it as ready, and pressing it again only burns a fee. **Do:** in any list of proposals to press,
name the dead ones by number.

**Believed:** a registry row that says a wallet is gone is a record of the past.
**Measured:** `bayla-ladder-deployer` (`Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6`) has
`expect: { type: "absent" }`, which `verify-addresses.mjs --onchain` enforces unconditionally. The
ladder upgrade plan funds that wallet with 2.70 SOL, and its PR does not touch the registry. With
the row flipped to `{ type: "wallet", funded: true }` and the wallet still empty, the live read
fails on exactly that row (`registry expects this account to exist and it DOES NOT`), so the
original row would fail the morning after the send. **Do:** a plan that funds or empties a
registered wallet carries the registry change, merged the same day.

## 2026-10-28: WebKit can report art it mounted 1.6 s earlier as just visible, so a clock paused from that moment stops the splash after it has left

**Believed:** `e2e/splash-reduced-motion.spec.ts` stops the Tradermigos splash well inside its
1.8 s loading beat: it waits for the first art piece to be visible, reads the page's `Date.now()`
and pauses the page clock 200 ms on. So "share of /splash/frogking.jpg in sight: 0" on
`ipad-safari` (PR #1043, three attempts) meant the splash buried that picture.

**Measured** (PR #1043 run 40742549494, `ipad-safari`, the first retry's trace): the splash
mounted, by its first `/splash/` image request, 797 ms after `goto`; WebKit's `waitFor` reported
the piece visible 1620 ms after that; the pause landed 1840 ms after the mount, 40 ms after the
loading bar had run out, and the error context read WELCOME, the bar's end word. The passing
retries of spreads 1 and 17 saw the piece 85 ms after the mount and paused at 314 ms. The
600 ms the spec then steps carry the exit through glitch (450) and flash (100) into cover: 120
dark blocks at `z-index: 100` without `pointer-events: none`, so the hit test finds no picture at
any point and all ten pieces read 0. The one named is the first in the DOM: frogking on spread 2,
the watercolour on 1 and 17. Trunk's green runs 40707167299 and 40723022656 flaked the same way;
Chromium sees the piece within a frame and never did. On the WSL rig (Ubuntu 24.04,
Playwright 1.62.1, the CI build of ee44d33d6, one worker, no retries, both WebKit projects) the
spec failed 24 of 132 reduced-motion runs while vitest ran on the Windows host, and 0 of 108 with
the host quiet or six WSL cores spun: the lateness needs the host busy, not the rig. Every one of
the 15 retained failures read WELCOME, had every piece at 0 and had paused 1.8 to 8.3 s after the
mount; the art was seen 0.08 to 6.7 s after it, and in three of them a single `page.evaluate`
round trip took 3 s, so any real-time gap before the pause lets the bar run out, not only
`waitFor`. Stopped before `goto` and stepped 50 ms at a time, the spec passed 132 of 132 in the
same windows, and its 44 motion runs.

**Do:** to catch a page before one of its timers fires, stop its clock before `goto` and step it
with `runFor` until the element exists (`locator.count()` between steps): a `waitFor` on WebKit
can answer seconds after the DOM did, while the page's timers run on time. A hit test that reads 0
for every piece is something over all of them: say what `elementFromPoint` returns before blaming
the layout. PR #996 held this fix from 2026-10-24 and sat unmerged while the flake cost two trunk
retries and a red PR.

## 2026-10-27: a zeroed address constant is not "never deployed", and six files hold a contract besides its tests

**Believed:** a contract whose `*_ADDRESS` is zeroed in `frontend/src/lib/constants.ts` was never
deployed, and deleting it is its source plus its tests and deploy scripts.

**Measured** (the dead-EVM-contract removal: 21 contracts, 92 files): five of the zeroed ones are on
mainnet, verified 2026-07-16 and gated off: GaugeController
`0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054`, VoteIncentives
`0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF` and its admin
`0xf87Ec231BA7FA3975619309bc16C698B2ea3B300`, CommunityGrants
`0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471` and MemeBountyBoard
`0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890`. `eth_getBalance` and TOWELI `balanceOf` read 0 on
all five. The zero constant means "the site does not show it"; `addresses.json`'s `status` field
and `docs/CONTRACTS.md` are where "deployed" lives.

Deleting a contract pulled on, in order found: `scripts/check-interface-selectors.mjs` (every
`*_ABI` export in `contracts.ts` must resolve to an artifact, so a retired ABI needs its own named
list), `.github/contracts-test-slices.json` (a brace alternative matching zero files fails the slice
guard), `NOTICE.md`'s SPDX count and GPL list, `frontend/src/lib/whetstonePetitionTruth.test.ts` (a
Doc-guards test that reads three `contracts/src/v4` files at import, which is why the four V4
graduation-stack contracts stayed), and two airdrop tests that opened campaigns through the factory.
`forge build` finds none of these.

**Do:** before deleting a contract, grep its name across `scripts/`, `.github/`, `NOTICE.md` and
`frontend/src/**/*.test.ts`, and read the registry row's `status`, never the constant.

## 2026-10-25: the LP door's "one jump" to its form was three scroll moves

**Believed** (island, answer twenty-two, and the 2026-10-16 entry below): the door moves the
page once, when the Add panel mounts and scrolls its heading into view, about 1,650px.

**Measured** (e2e/door-lands.spec.ts on a trunk `1ca85025` production build, 390x844, Bayla room
to Add SOL + BAYLA, `scrollY` read every animation frame): 0, then 796 (the finder scrolls to its
answer when the lookup starts), back to 0, then 1,654 (the panel). With no wallet connected it
went on to 5,642 and settled at 5,245; I did not trace those two.

**Do:** a check of one `scrollIntoView` call misses the others. Read `scrollY` on every frame
from the landing on a production build, and assert the whole list. A form opened by code goes
where the visitor already is (the door draws it at the top through a portal) instead of
scrolling the page to it.

## 2026-10-24: a pool on fee tier 0 read as a cheaper public pool, but only a graduation may open one there

**Believed:** the pool finder, the swap route and the builders may treat every pool of ours
alike, whatever its fee tier: tier 0 (0.25%) is just the cheaper tier.

**Measured** (vitest, 2026-10-24, on trunk 2ae979945 before the fix): with a free pool on
tier 0 beside a tier-1 pool, the swap route quoted both, and the router picks the free one
when reserves match (a lower fee pays more); the venue-swap and deposit builders built
transactions into it. A test, "prices each pool with the fee of the tier it is on", pinned the
router choosing it as correct. The write testkit's default pool sat on tier 0 at the standard
address: every builder test's "ordinary pool" was the case the owner now refuses. 14 new
tests failed on trunk; 16 of 16 mutants of the guards were killed.

**Do:** judge a pool's tier with its address. Tier 0 is the launch tier: the one pool on it
the site uses is `["launchpool", mint]` under the launch program (`PoolView.launchTierWithoutLaunch`,
poolFinder.ts). The write testkit's default pool is on tier 1 now. In jsdom a fixture cannot
derive program addresses, so a flag a fixture works out reads the config's own bytes.

## 2026-10-24: a Tailwind `min-[720px]:` lost to `sm:` on a wider screen, because v4 sorts breakpoints by unit before width

**Believed:** the wider breakpoint wins, so `min-[720px]:aspect-[3/4]` overrides
`sm:aspect-[5/2]` (640px) from 720px up, as `md:` would.

**Measured** (tailwindcss 4.3.3, the repo's version, 2026-10-24: `compile('@import
"tailwindcss"')` from `dist/lib.js`, `build()` on px, rem and named breakpoint classes, then
the order of the `@media` rules read): `640px`, `720px`, `40rem`, `45rem`, `48rem`, `64rem`.
The sort compares
units first, as text, and widths only within a unit. The named breakpoints are rem (`sm` is
40rem), so every px arbitrary rule comes out before every named one, and at equal specificity
the later rule wins. In PR #1009's branch build the upright iPad's frame took `sm:`'s 5/2 and
came out 163px tall instead of 372 (the PR's Playwright walk). `min-[45rem]:` sorted between
`sm` and `md`, where its width puts it.

**Do:** never mix px arbitrary breakpoints with named ones on one property unless every named
one there is wider than every px one; write an arbitrary breakpoint in rem to sort it among the
named ones. Check by reading rule order in the built `dist/assets/index-*.css`, not the class
list. The selector escapes `[ ] / :`, so `min-[720px]:aspect-[3/4]` is
`.min-\[720px\]\:aspect-\[3\/4\]`.

## 2026-10-24: a sticky grid item pinned past the end of its row, because a grid area does not hold a sticky box

**Believed:** a `position: sticky` frame in grid area `fig` of `'board fig' 'pools pools'`
pins while row 1 scrolls by and stops where row 1 ends.

**Measured** (PR #1009's branch build, Playwright Chromium and WebKit at an upright iPad's
820px, 2026-10-24): it pinned on past row 1 and over the full-width pool list in row 2, hiding
the rows' arrows. In both engines the sticky box was held by the grid container's box, not its
grid area. With the area moved to a wrapper slot and `sticky` on the slot's child, it stopped
at the end of row 1: a grid item stretches to its row's height, so the slot is a box exactly
as tall as the row. `e2e/dashboard-frame.spec.ts` checks that no pool row is under the frame at
points through the list, and fails on the old structure.

**Do:** never put `sticky` on the grid item itself when it must stop at its row: give the area
to a slot and pin the slot's child. Where the same markup is block layout (a phone), make the
slot `display: contents`, so the child pins against the card as before.

### Incidental

- The desktop frame's `lg:sticky` had never stuck: the card was `overflow: hidden`, which makes
  it a scroll box of its own, so the frame pinned to a box that never scrolls. `overflow: clip`
  clips the same and is not a scroll box: `overflow-hidden supports-[overflow:clip]:overflow-clip`
  keeps `hidden` for a browser without `clip`. body's `overflow-x: hidden` did not stop it:
  with `html` left `visible`, body's overflow goes to the viewport.

## 2026-10-24: a `mouseenter` is not a pointer that moved: WebKit fires one on a row that scrolls under a resting pointer

**Believed:** an enter on a row means a mouse or finger moved onto it, so on a screen where the
frame follows the scroll, an enter can safely mean "the pointer takes over".

**Measured** (PR #1009's branch build, Playwright WebKit with `hasTouch`, 2026-10-24): with the
pointer resting where it last was, scrolling fired `mouseenter` on each row that slid under it,
and each took the frame from the row the scroll had reached.

**Do:** treat an enter that arrives within about 300ms of the last `scroll` event as the
scroll's, and ignore it. Test the guard in WebKit with `hasTouch`, where this was seen.

## 2026-10-24: a test pool's round share count looked neutral, but no pool program ever makes one

**Believed:** the LP testkits' default `lp_supply` (1,000,000 in `buildPool`, 1,000,000,000 in
`addPool`) and a "traded" price record of two slots an hour apart are harmless placeholders.

**Measured** (vitest, 2026-10-24, the launch-pool moved-price check of M-1009-6 on trunk's
fixtures): 44 of 4,845 Solana tests failed. Apart from 11 timeouts in files the change does not
reach, and pins of the "10 minutes" copy that changed on purpose, they failed on fixtures only:
- a never-traded launch pool whose `lp_supply` is not `isqrt(side0 x side1)` holds more than
  its shares account for, which on chain means tokens were sent straight into a vault;
- two slots an hour apart is one swap, an hour of silence, one swap: the shape of a price
  moved by a transfer and written over by a dust swap.

**Do:** build a launch pool with the shares the program opens it with (`isqrt(quote x token)`;
`addPool({ launch: true })` now defaults to that) and a traded pool's record with
`steadyRecord` (lp `testkit.fixture.ts`). A fixture is a claim about the chain: make it one
the chain can produce.

### Incidental

The first mutation run left one mutant alive: a guard that re-read the price record could
never see "not read", because the average had read the same record and clock a line earlier.
A branch no test can reach is code no one has checked. It was deleted, not tested.

## 2026-10-24: a `.max(200)` on a zod array did not stop a huge body, because zod below 4.6.6 parsed every element first

**Believed:** `z.array(row).max(200)` refuses an oversized batch before it costs anything, so
the cap in `frontend/api/_lib/proxy-schemas.js` kept a stranger's giant body from running the
write proxy out of memory.

**Measured** (vitest, 2026-10-24: `validateBody` on 201 rows whose `wallet` is a counting
getter): zod 4.4.3 read the getter 201 times, then reported the cap. zod 4.6.6 read it 0
times. Both returned the same error. The change is zod commit a0ebf970, "check array, set and
map size bounds before parsing elements", the fix for GHSA-mrhx-c7xc-m3w5. Before it, every bad
element added an issue before the cap was looked at.

**Do:** to prove a size cap protects, count reads of the elements (a getter or a Proxy), not
only that the call fails. A cap checked after the elements limits what is stored, not what is
spent.

### Incidental

npm audit called the fix "semver-major" and named `@base-org/account` 2.5.5, which still
depends on the same cdp-sdk and its zod 3. The fix for the copy our code imports was a minor
bump, 4.4.3 to 4.6.6. Read which copy each `nodes` path is before trusting the fix column.

## 2026-10-23: a trunk failure that the next run passed was two green PRs red together, not a flake

**Believed:** five tests that failed once on trunk (merge `08596661`, run 38501066916) and
passed on the next trunk run were intermittent. Each one waited out its 20 s `findByRole`
and said `Unable to find role="button"`, which is what a slow runner looks like.

**Measured** (2026-10-23, vitest on an idle machine, `-t` set to only those five tests):

- #790 changed the coin the Solana swap page shows while a link's token is looked up, from
  USDC to $BAYLA, and merged at 2026-10-14 02:26:32Z. #791 merged 19 s later. #791's last
  CI had run on 2026-10-10 21:09Z, before #790 was on trunk, and its tests waited for
  "Buy USDC".
- The merge commit failed all five on every run. #791's own head passed all five. With
  `DEBUG_PRINT_LIMIT=200000`, the DOM dump showed "Buy BAYLA" on the button the whole time.
- The next trunk run passed these five because the next merge (#809) carried a commit that
  changed them to wait for "Buy BAYLA". Nothing about the failure was random.
- `git merge-tree --write-tree <trunk just before #791> <#791's head>` gave exactly the
  real merge tree. It differed from the tree #791's CI tested by 33 files, among them the
  page and the rule that picks the opening coin. The 2026-10-01 entry's tree check
  ("compare the merged tree with the PR's tree") would have caught this before the merge.

**Do:** before calling a trunk failure intermittent, run the failing tests alone on the
merge commit and on the PR's own head. If one is red every time and the other is green,
it is a collision: look at what merged just before. When a test leans on a value that
other code decides (a default, a fallback), check that value right after render, with a
message that names it. A `findBy*` on the old value only says "Unable to find", and only
after its timeout. PR #963 does this for these five tests: a moved fallback now fails in
28–184 ms and names both coins, where before it took 5 × 20 s.

### Incidental

- In CI's log, the DOM dump stopped at the amount box, above the Buy button, so the log
  never showed what the button said. Testing Library cuts its dump at `DEBUG_PRINT_LIMIT`,
  7000 characters unless that is set (read in `@testing-library/dom/dist/pretty-dom.js`).
  To see the rest, rerun locally with the limit raised.

---

## 2026-10-23: "Swap not checked" blamed the test run, but the test run never failed: one Jupiter press is four Jupiter calls

**Believed:** a Solana swap toast saying the check "keeps failing on our side" means the
pre-sign test run (`simulateTransaction` through `/api/solrpc`) is failing, so the RPC is
the place to look.

**Measured** (2026-10-23 ~04:20Z, a node script making the browser's exact calls against
production, read-only: fee quote and build through `/api/jupiter`, the test run through
`/api/solrpc` with a funded mainnet wallet as payer, nothing signed): the test run answered
200 with a result every time. For SOL to BAYLA (a Token-2022 pump coin, fee taken in WSOL)
the fee-bearing build's test run is Jupiter's 6014 on every press, so every press also runs
the no-fee re-quote and rebuild: four calls to Jupiter's keyless tier, which refuses at
random behind Vercel's shared egress (our relay says 502). Five presses spaced 8 s apart:
3 died on a 502, at the fee quote twice and the fee build once. A refusal in the no-fee half
is reported as a test run that could not run, so the toast named the wrong step. PR #958
asks again on a 502 or 429 (`lib/solana/swap/jupiterBusy.ts`).

**Do:** before blaming the RPC for an "unchecked" test run, list every network call between
the press and the simulate, and run them yourself in order with the page's exact parameters
and a funded wallet as payer (a simulation with `sigVerify: false` needs no signature). Count
the failures per call, not per press.

### Incidental

- `vercel logs` on this project returned at most 50 rows per query whatever `--limit` said,
  and nothing older than about 50 minutes: a `--since 24h --status-code 5xx` query gave 46
  rows, the oldest 50 minutes old. To read a window, slice it under a minute; for anything
  older, reproduce instead of reading.
- `--query solrpc` and `--query jupiter` matched; `--query jupiter/swap/v1/swap` matched
  nothing. A path with slashes is not a usable query.

## 2026-10-22: testing the indexer's GraphQL needs no RPC, no Postgres and no sync

**Believed:** a change under the indexer's GraphQL (graphql-yoga, @graphql-tools) can only be
tested against a running `ponder start`, which needs an RPC and a synced database.

**Measured** (ponder 0.8.33, node 24.13, 2026-10-22): ponder's own handler runs outside
`ponder start`. Import `getSql`, `buildGraphQLSchema` and `graphql` from
`node_modules/ponder/dist/chunk-*.js`; node 24 imports `ponder.schema.ts` as is. Create the tables
in an in-memory PGlite from `getSql(schema).tables.sql`, insert rows, set `db` (drizzle-orm/pglite,
`casing: "snake_case"`), `metadataStore` and `graphqlSchema` on the Hono context as
`createServer` in `dist/bin/ponder.js` does, and serve it with `@hono/node-server`. 24 probes
(the site's own queries, `@include`/`@skip` on variables, fragments, paging, the armor limits,
errors) gave the same answers on trunk's tree and on graphql-yoga 5.24.6. Five differed only in key
order: executor 2 returns fields in the order the query asks, executor 1 put `_meta` first.
Forcing utils 12.1.0 under executor 1.5.2 failed the five directive probes, the break found on
2026-10-06, so the probe does catch it.

**Do:** prove an indexer GraphQL bump this way: old tree against new tree, queries with variables
in directives, answers compared with key order ignored.

## 2026-10-22: an inline `style` colour silently cancels every `hover:` class on the element

**Believed:** a Tailwind `hover:bg-[#22c55e]` on a button works whatever else the
element carries, so a base colour may live in `style={{ background }}` while the
hover state lives in a class.

**Measured** (branch build of PR #954, Playwright chromium, `getComputedStyle` after
`locator.hover()`): the "Buy all bungalows" stub with `style={{ background:
'rgba(5,8,15,0.92)' }}` and `hover:bg-[#22c55e]` read `backgroundColor:
rgba(5, 8, 15, 0.92)` on hover while its inner span's `group-hover:text-[#05080f]` had
already turned the ink `rgb(5, 8, 15)`: near-black on near-black, an empty box. An
inline declaration outranks any class, hover variants included, and no lint or test
says so; jsdom unit tests pass because they never compute styles. With the
background moved to `bg-[#05080f]/90` the same read gave `rgb(34, 197, 94)`. Two
dashboard controls shipped a week earlier had the same shape (`style={{ color }}` plus
`hover:text-*`) and had never changed colour on hover.

**Do:** a colour that changes on hover, focus or `group-hover` is a class, and so is
its resting value; keep `style` for what no class expresses (a per-row accent read
from data, a font family). Verify a hover state by computed style in a real
browser, not by the class list.

### Incidental

- An `inline-grid` whose column holds a `width: max-content` marquee grows to the
  whole run (a seven-ticker tape made the stub 510 px). `w-0 min-w-full` on the
  tape's wrapper fills the column without asking for any width.
- A clipped `page.screenshot({ clip })` taken after `locator.hover()` can catch the
  card's own hover transform mid-move and show the wrong element; `locator.screenshot()`
  re-resolves the box.

## 2026-10-22: a backfill that saves nothing when it stops never finishes on GitHub's shared runners

**Believed:** a history read that works from this machine works the same in a scheduled
workflow, so an all-or-nothing write is enough.

**Measured** (venue-volume.yml runs 39725739438 and 39726068637, 2026-10-22 05:02Z and 05:06Z):
Base's backlog was about 45,000 blocks, which the keyless RPCs serve only 100 blocks a call
(`base.drpc.org`, `base.gateway.tenderly.co`; publicnode answers "archive", `mainnet.base.org`
"request limit reached"). Both runs were cut off by HTTP 429 after about 100 seconds, kept
nothing, and the backlog grew by about 1,800 blocks an hour. The same read from this machine
finished in 332 seconds.

**Do:** save progress as windows succeed and resume from it, with a time budget per run and
a long wait after a 429; keep the source marked as never counted until it reaches the head once.

## 2026-10-22: Blockscout trails the finalized head, so a reader that waits for it to reach the head never finishes

**Believed:** an indexer that has caught up with the chain covers every block up to the finalized
one, so "read old history from Blockscout up to the head" is one call.

**Measured** (the volume counter's first live run on GitHub, 2026-10-22 02:13Z): eth.blockscout.com
had indexed to 26,245,041 while the finalized head was 26,245,050, nine blocks short, so the guard
refused the whole Ethereum range. On Base, `base-rpc.publicnode.com` refused logs 50,000 blocks back
(about 28 hours) as archive, `mainnet.base.org` answered every `eth_getLogs` with "request limit
reached", `base.blockscout.com` answered 403 (Cloudflare) from this machine, and `base.drpc.org`
served any age in 100-block windows.

**Do:** take from an indexer only up to the block it says it has indexed and read the rest from an
RPC; when no indexer answers, shrink the RPC window to the free limit instead of failing.

## 2026-10-21: GitHub calls a train CONFLICTING when it shares two merge bases with trunk, though git merges it cleanly

**Believed:** `git merge-tree --write-tree` exiting 0 against trunk means GitHub will call the
pull request mergeable and run its CI.

**Measured** (train #928, 2026-10-21): the train carried #922, whose branch held #910's two commits
unchanged. #910 then merged on its own (`8147c6aeb`). The train and trunk now had two merge bases
(`cf385ec45` and `51e3036b6`, from `git merge-base --all`). `git merge-tree` exited 0, while
`gh pr view 928 --json mergeable` read CONFLICTING and no workflow ran. Merging trunk into the
train changed no file (`80e26e098`) and made it mergeable; CI started.

**Do:** when a train carries a PR whose commits another PR also carries, and that one lands alone,
merge trunk into the train at once. After every trunk move, read `mergeable` from GitHub, not
only `merge-tree`.

## 2026-10-21: a train ships each PR's head as it was when the train was cut, and a DIRTY PR can already be red

**Believed:** merging a train closes every PR it carries, and a PR listed as DIRTY only needs trunk.

**Measured** (train #928, merged 2026-10-21 15:40Z): 23 of its 24 PRs closed as merged. #903 stayed
open: a trunk merge (`e4b78095d`) was pushed to its branch at about 13:59Z, after the train took
its head `2e397e5e9`. Separately, #895 had been listed as "DIRTY, bring trunk in", but its last
E2E run, from 2026-10-19, was red (`/bayla` at 432 to 488 words, against a 320 cap). A DIRTY PR
runs no new CI, so that red sat on the page unread until the train ran it again.

**Do:** before cutting a train, read each DIRTY PR's last run for reds. Right before merging,
check that every carried PR's current head is in the train (`git merge-base --is-ancestor`).
Close by hand any PR GitHub leaves open.

## 2026-10-21: a property test that rejects nearly every draw of a branch fails "at random", and Raydium's compute_swap_step_test is one

**Believed:** a red `compute_swap_step_test` in the range program's `clmm-build` ("amount_used (2)
should equal amount_remaining (1) when target not reached") means the program can pay a swap
wrong, and a test that passes most runs checks every branch it names.

**Measured** (2026-10-21, a WSL copy of the deployed source): the test is wrong, not the program.
For an exact output with the fee on the output coin it adds the fee to what the user received
and expects the amount asked, which holds only at a zero fee (raydium-io/raydium-clmm `c6789199`).
It fails rarely because its `prop_assume!` bounds reject all but about one draw in a million of
that kind: about 0.02 such cases in a 65,536-case run (`bf7c2413` set the count), so a few runs
in 100 go red. A test drawing each kind directly (`programs/amm/tests/swap_math_fee_rule.rs`)
runs about 10,000 of those steps per run; the user got exactly the amount asked in every one.

**Do:** read a property test's reject counts (`global rejects: ... times at <line>` in its
failure output) before trusting a branch it names. Draw each branch directly instead of
rejecting into it, and assert per-branch counts so a later sampler change cannot quietly empty
one. Kill a mutant per guarded line: here two of four survived upstream's price and liquidity
ranges until prices were drawn by tick and liquidity up to 2^80.

## 2026-10-21: a concentrated-liquidity deposit with liquidity 0 and a base coin is protected on that coin only, so a sandwich passes

**Believed:** an `open_position` / `increase_liquidity` sent with `liquidity: 0`, a base coin
(`base_flag: Some`) and a tolerance maximum on both coins is refused when the price moves past
the tolerance either way.

**Read** (the range program's `add_liquidity`, `solana/tegridy-clmm/programs/amm/src/instructions/open_position.rs`,
which Raydium's CLMM shares): with liquidity 0 the program works the liquidity out from the base
coin's maximum at the price the deposit lands at, so the base coin always fits its maximum. Only
the other coin's maximum can refuse, and only for a move that raises it. A price pushed the other
way (front-run, then back-run) passes, and the deposit goes in at the pushed price: the review on
#915 found it, and a test replaying the program's rule lets the old opening through a 300-tick move one way.

**Do:** send the liquidity planned from a fresh read with `base_flag: None` and a tolerance
ceiling on both coins; then a move either way raises one side past its ceiling. To keep the typed
amount as the most it takes, plan from the amount less the tolerance.

## 2026-10-21: hiding one layer at a time finds nothing when a page's frame cost is a sum, and headless Windows WebKit pays it per pixel

**Believed:** that Playwright WebKit drawing almost no animation frames on /nakamigos, while
its timers ran close to on time, meant one heavy layer that hiding layers one at a time would
find. And that this frame count says how an iPad runs the page.

**Measured:** 2026-10-21, a production build on `vite preview`, Playwright 1.62.1, the
`ipad-safari` descriptor (810x1080, DPR 2), reduced motion on as in every e2e project. An
init script ran its own `requestAnimationFrame` loop and counted frames per 250 ms over the
Tradermigos splash (0.75 to 3.2 s), two runs per row. Windows WebKit:

- As built: 0.1 to 0.2. Hiding any one of the splash's eleven layers: still 0.1 to 0.2.
- Keeping only one layer: all hidden 6.5, backdrop 4.9, title block 3.8, spotlight 3.5,
  grain 3.5, sparks 2.6, bokeh 2.0, grid/scanline/vignette 1.1, aurora 0.3, the ten art
  pieces 0.2 (canvas and dust motes: no cost). Per frame that adds about 1.2 s for the
  pieces, 0.8 s for the aurora, 0.2 s for the overlays and 13 to 90 ms for each of the rest:
  about one frame per 2.5 s, which is what the page as built draws.
- It is paid per pixel. Aurora with its 80/80/100px blurs 0.3, blurs at 8px 1.5, blurs off
  3.5. Art images alone: 1 piece 3.5, 3 pieces 2.0, 10 pieces 0.8. DPR 1 instead of 2 made
  every layer about four times faster (images 0.8 to 3.0, all hidden 6.5 to 13.5). During
  the splash timers ran at most 0.3 s late, so most of the time went off the main thread.
- Same build and viewport in Chromium: 3.6 to 6.1 on the splash, with SwiftShader and with
  the Intel GPU (D3D11) alike. Its main thread was 61% busy over the splash (style 26%,
  script 14%), about 35 ms per frame on this desktop CPU.
- The landing after the splash is a separate stall that ends: main-thread stalls of 0.6 to
  3.4 s, then about 15 per 250 ms from 3 to 5 s after it mounts (1.5 to 2.5 s with images
  hidden).
- Linux WebKit (WSL Ubuntu 24.04, the release CI runs, same Playwright): the splash also
  starves (0.1 to 1.8; 7.8 to 11.4 with its layers hidden), but there the main thread stalls
  0.3 to 2.1 s at a time and /risks and /swap also drew almost nothing for 2 to 18 s after
  load, so Linux does not single the route out. CI run 39535606941 failed /nakamigos on the
  two WebKit projects only.

**Do:** bisect a frame cost both ways, hide one and keep only one. When no single hide helps
and every keep-one costs something, the cost is a sum: rank layers by their keep-one rates.
Change DPR once: a rate that moves about four times is paid per pixel by the compositor, not
by the page's script. A headless WebKit frame count is a fact about the test browser; what an
iPad draws on the same page stays unmeasured until a real one is timed (Safari's Web
Inspector, Timelines).

## 2026-10-21: npm always takes the newest release in a transitive range, so the floor needs an override or a hand edit

**Believed:** when a fixed package asks for a newer transitive (vite 8.3.3 asks for rolldown
`~1.2.11`), npm resolves it to the newest match (1.2.14, a week old), and holding it at the floor
means an `overrides` entry, which blocks the next bump, or editing the lockfile by hand.

**Measured** (npm 11.21.0, `frontend/package-lock.json`, 2026-10-21): `npm install -D
rolldown@1.2.11 --package-lock-only`, then `npm uninstall -D rolldown --package-lock-only`. The
second command drops the direct dependency and keeps the 1.2.11 node, because it still satisfies
vite's range. package.json ends as it started, rolldown's 15 bindings and its `@oxc-project/types`
pin follow, and `npm install --package-lock-only` afterwards changes nothing.

**Do:** to land a transitive at the oldest release that works, install it as a direct dependency
at that version and uninstall it. Then check the lock is stable with a second lock-only install.
## 2026-10-21: a button "detached from the DOM" under a click was not re-mounted; it left by itself, and the click raced it

**Believed:** a `locator.click` call log reading "element is visible, enabled and stable … element
was detached from the DOM, retrying" on the Tradermigos splash meant the app re-mounted the button
under the tap: a parent re-render, a key change, a lazy chunk swapping it.

**Measured** (Playwright 1.62, production build on `vite preview`, Windows WebKit, 2026-10-21): a
MutationObserver counted one mount (+0.6 s), the exit's class (+2.6 s) and one unmount (+4.0 s),
never a second mount; CI's call log never printed a second "locator resolved to". The splash has
left by itself at 3.2 s since 2026-10-14. On WebKit `/nakamigos` drew about 0 frames per 250 ms
(`/risks` and `/swap` about 12) with timers on time, and Playwright's "stable" check counts frames,
so the click was still checking when the splash left, then waited for a button that never came
back, to the 120 s test timeout. Turning off filters, shadows, CSS animations, `will-change` or
canvas each left the frames at 0; hiding every image and background brought the landing's back,
not the splash's.

**Do:** before calling a detach a re-mount, look for a second "locator resolved to" in the log.
Never click a control that removes itself on a timer; wait for what replaces it. To make a lost
race certain in a test, keep the target moving (a linear `translate` animation, `!important` past
the reduced-motion rule) so no click can find it stable.

## 2026-10-21: art laid out to move can bury a piece once held still, and a bounding-box check passes it

**Believed:** under reduced motion, holding the Tradermigos splash's pieces where they spawn keeps
every piece in sight, and a check that each piece's box is on screen proves it.

**Measured** (production build, Playwright 1.62.1, chromium 1280x720 and ipad-safari 810x1080, 20
loads each, 2026-10-21): held where they spawn, the most-covered desktop piece had 1-32% of its
picture in sight (median 9%), and the on-screen box check passed every piece. The spawn rule clamps
two zones to points 128 px apart at 1280x720, so one tall piece sits under another. Choosing the
draw order alone still left 9% in 2 loads of 20. Easing overlaps apart first (a tenth of each
overlap per round, 100 rounds), then drawing the most buried last, kept every piece at 31% or more
on seeds 4 to 40, on both devices.

**Do:** count what a visitor sees with the browser's own hit test: turn `pointer-events` on for the
pictures, sample `document.elementFromPoint` on a grid, turn it back off. Step a
`requestAnimationFrame` loop with `page.clock`, which fakes rAF too: `runFor(100)` fires about six
frames whatever WebKit's starved compositor draws. Stop the clock before `goto` and step it until
the art is up: a pause aimed at the page's `Date.now()` once the art shows can land after the
splash has left (the 2026-10-28 entry above).

## 2026-10-20: a press area made of padding and a matching negative margin loses its lower part to the rows after it

**Believed:** `py-3.5 -my-3.5` on an inline-block in a list of rows makes a 44px press area
that moves nothing, and a 44px `getBoundingClientRect().height` proves it.

**Measured** (/pools price flip, production build, chromium at 390, 820 and 1280, hit-tested
every 0.5px down the box): the box was 45.9px on a pool card and 48.3px in All pools, but a
press landed on it over only 39 to 42px. The next row's text and the "No trades yet" tag come
later in the page, paint over the box's lower 6 to 7px, and take the press. Nothing above it
did. With `relative` on the button it is painted above them and the whole box answers.

**Do:** give such a button `relative` (it stays under the z-50 bars), and certify the area by
hit tests down the box, not by its height. The 2026-10-14 entry on `::before` is the same trap.

## 2026-10-20: the local Solana e2e suite is not green on trunk, because no CI job runs it

**Believed:** `frontend/e2e-solana` passes on trunk with today's pool program, so after moving its
tier-0 fixtures a run on the upgrade build should come back fully green.

**Measured** (WSL validator, the four LP specs on chromium and mobile-chrome, 2026-10-20): trunk
`50b34098f` on the release build already fails P1, P6, P19, E1, E18, E20 and two lp-read tests. They
check page copy and a 44 px tap target that /pools has since changed (`aa3973a46`, `d3e239d31`,
`36a08925c`). Each failure restarts the worker, and fresh fixtures then fail E2 and E16 too. Separately,
E19's `not.toMatch(/APR|APY|yield of/i)` on the section's text failed once on a random pool address
(`DYbyM8apn7KA5g1ApYWR…`): base58 keys can spell those letters, so the check flakes.

**Do:** before reading a red e2e-solana run as your change, run the same tests on trunk against the same
validator (`-g` on the failing titles takes about 20 minutes). Match copy guards on word boundaries, or
on text with the addresses taken out.
## 2026-10-20: where two buttons' padded press areas meet, `relative` only picks which one loses

**Believed:** a padded press area that loses its lower part to the rows after it is fixed by
`relative` on the button (the 2026-10-20 entry on padding and a matching negative margin).

**Measured** (venue status card on /pools and /solana-lp, production build, chromium,
mobile-chrome, iPhone and iPad, hit-tested every 0.5px down each box): on a phone the Program
and Config copy chips wrap onto rows 12px apart, and each 46px area reached 7px out of its chip.
Config, later in the page, took Program's bottom 3px of press, 1px more than the boxes overlap.
`relative` on either button only moves the loss to the other.

**Do:** split the padding so the two reaches into the shared gap add up to less than the gap
(1px clear held on all four devices), each area still 44px or more. Certify by the sweep.
## 2026-10-20: a build step that reads a file outside frontend/ passes every local build and every CI job, and fails every production deploy

**Believed:** a Vite plugin that reads `../CHANGELOG.md` is safe once `vite build` passes locally
and in CI, because Vercel builds the same repository.

**Measured** (Vercel build logs, `npx vercel inspect dpl_EnewCRdDML6XsV2PkmxTZrhV2N5a --logs`,
2026-10-19/20): every production build from #878 on stopped at
`[plugin changelog-files] Error: ENOENT: no such file or directory, open '/vercel/path0/CHANGELOG.md'`.
`.vercelignore` opens with `*` and re-includes only `frontend/`, so the upload has no repo-root
files, while a local or CI checkout has all of them. Three merges (#878, #882, #893) went in over
about ten hours and none went live. The site kept serving the build before them, and nothing went
red where anyone was looking: previews are skipped for this project, so every PR showed the usual
skipped Vercel check.

**Also measured:** re-including the file alone is not enough when it sits in a folder.
`*` then `!docs/CHANGELOG_EARLIER.md` still leaves it out under the `ignore` package (git's rule:
a file can't come back while its folder is excluded). It takes `!docs` first, and `*` still keeps
the rest of `docs/` out.

**Do:** after a merge, read the merge commit's `Vercel` status, not the PR's
(`gh api repos/<owner>/<repo>/commits/<sha>/statuses`); "merged" is not "live". For a file a build
reads from outside the uploaded folder, add the `.vercelignore` line and a test that evaluates the
ignore file against the plugin's own file list.

## 2026-10-19: under a Squads time lock, a proposal checked the day it is approved is checked against the wrong day

**Believed:** a vault proposal that simulates green when it is approved will execute green, and one
that simulates red is wrong. That held while the vault had no lock.

**Measured** (2026-10-19): Squads v4 executes an approved vault proposal only when
`Clock - approvedAt >= time_lock` (`vault_transaction_execute.rs`), so the execute meets the chain 48
hours after the approval; on a local validator with mainnet's multisig the page and the chain both
refused it until then (6021). A ladder reload simulated as the vault on mainnet, inside the running
window (`notify_reward`, 0 fresh + 1,000 from budget, sigVerify off, nothing sent) came back 6028
(`RewardRateWouldDecrease`). Approved two days before the window's end, that same reload is right:
the guard is `now >= period_finish || new_rate >= old_rate` (math.rs), so it is off when the lock
releases. The reverse also holds: mainnet epochs were ~26 h that day, so a 48 h wait spans at least
one feature-activation boundary; what can change in 48 hours must be read again at the execute.

**Do:** a page that proposes under a lock must run every gate again before the execute, read the
network's Clock sysvar (not the computer's clock) for "is the wait over", and, where a step is
meant to wait for a chain event, accept exactly the one refusal that event lifts, and only when the
event falls before the release.

## 2026-10-19: a JSON round trip of a `solana account --output json` file stops the test validator from starting

**Believed:** reading an account file the harness wrote, changing one field of its data, and writing
it back with `JSON.stringify` keeps it loadable by `solana-test-validator --account`.

**Measured** (solana-test-validator 3.1.11, 2026-10-19): the validator exited during startup, three
times in a row. The file's `"rentEpoch": 18446744073709551615` (u64::MAX) came back as
`18446744073709552000`, a float past u64.

**Do:** treat the file as text: replace only the base64 data string, and assert `rentEpoch` is still
`18446744073709551615` before writing.

## 2026-10-19: drpc's free tier says it caps eth_getLogs at 10,000 blocks, but it refuses anything over 100

**Believed:** keyless Ethereum logs come from `eth.drpc.org` in windows under 10,000 blocks (the
2026-10-14 entry below), and an empty Blockscout answer means no logs.

**Measured** (2026-10-19, the all-time volume counter's backfill): drpc answered "ranges over
10000 blocks are not supported on free plan" to windows of 5,000, 1,000 and 300 blocks, and
returned logs at 100. `ethereum-rpc.publicnode.com` and `base-rpc.publicnode.com` served 5,000-block
windows near the head and "Archive requests require a personal token" from 20,000 blocks back.
Blockscout v1 `getLogs` returned the pair's whole history in one call; its empty answer is exactly
`{"message":"No logs found","result":[],"status":"0"}`, and `/api/v2/main-page/blocks` gives the
block it has indexed to.

**Do:** read recent windows from publicnode; read older ranges from Blockscout, accepting only its
`OK` or exact `No logs found` shape, and only up to its indexed block, so a rate-limited or lagging
answer cannot pass as a range with no swaps (`frontend/scripts/lib/venue-volume-chain.mjs`).

## 2026-10-19: a SwapFeeRouter swap is also a Swap log on our pair, so adding the two counts it twice

**Believed:** the venue's Ethereum volume is the pair's Swap logs plus the router's `SwapExecuted`.

**Measured:** the router's one swap (tx
`0x7bc084a4304ad497222b7d666863a91ded491b8af2fb1062509387c3bdba415c`, block 25,723,600) is also one of the pair's
29 Swap logs: `router()` is the Tegridy router, whose `factory()` is our factory. The hand read of
2026-10-19 said 68 swaps; there were 67. On Solana, a Jupiter `route` that takes our fee from the
input emits its `FeeEvent` first and a `SwapEvent` whose input is already net of the fee, so the
swap's own input is the SwapEvent's plus the fee (0.06965 + 0.00035 = 0.07 SOL in tx
`4zSJhJGt9DEGqmzy4Vi4DCxpQE6WH9NDX4KzDzbyf8cuaT4XJx1cu84eyxAxhmL3cYY8E5rNpUGnFskoSq3X5J2o`).

**Do:** count our factories' pairs only. For Jupiter, read the leg from its events, adding the
fee back when it came off the input; that matches fee ÷ rate without knowing the rate.
## 2026-10-19: `forge coverage --ir-minimum` over a whole suite needs more RAM than a runner has, and `--match-path` does not shrink its compile

**Believed:** the weekly coverage job was red because it lacked the IR-minimum workaround for
"stack too deep".

**Measured** (forge 1.7.1, ubuntu-latest 16 GB, 2026-10-19): the workflow already passed
`--ir-minimum`, and two things were wrong. (1) A Yul exception, bisected by keeping a subset of
`src/` and `--skip`ping the rest, to a 20-argument `string.concat` in one deployed contract; plain
`forge coverage` (no flag) dies in legacy codegen instead, and a per-file `additional_compiler_profiles`
entry with `via_ir` did not escape `--ir-minimum`'s settings. (2) With that file gone, the ~480-file
compile was killed at exit 143 after 3.5 to 6 minutes: `free -m` every 10 s showed solc rising about
70 MB/s into the 16 GB ceiling. `--match-path` filters which tests run, not what compiles; `--skip
<path>` does. Skipping every test file outside a slice gave 7.5 GB, 2 to 4 minutes per slice.

**Do:** slice coverage like the test matrix and merge the lcov by line. Exit 143 with no annotation
is the runner killing a step for memory, not a timeout; a `| tail` on the step hides everything it
printed, so sample memory to the log live. Do not repeat these compiles in WSL: three of them took
the whole WSL service down (`Wsl/Service/E_UNEXPECTED`, back after 20 to 60 s), and a poll loop
that calls `wsl` every few seconds keeps it down.
## 2026-10-19: a pool-program upgrade's file hash and enlarge size can be known before the pack is rebuilt

**Believed:** the hash of the file an upgrade pack uploads is only known once the pack is
rebuilt, and the enlarge size only once the real upload is tried.

**Measured** (WSL, 2026-10-19): `cargo build-sbf -- --locked` (2.3.0, platform-tools v1.48,
rustc 1.84.1) in `programs/cp-swap` of a clean `git archive` of trunk `71a7bba8` gave
the 2026-10-06 build, 724,688 bytes: byte for byte the pack's file, built on another day in other folders.
The same build of a source change gives that change's pack hash. On a local validator holding
mainnet's binary, `solana program extend <id> <new − current bytes>` and then
`solana program deploy --no-auto-extend` upgraded with no error, so that byte count is enough.

**Do:** before rebuilding a pack for a source change, build its archive this way and quote the
hash. Prove the enlarge number with `--no-auto-extend`, so the CLI can't quietly enlarge for you.

## 2026-10-19: `pkill -f` sent through `wsl -e bash -lc "…"` kills the shell that runs it

**Believed:** `pkill -f '<pattern>'` never matches itself, so it is safe as a one-liner.

**Measured** (2026-10-19): `wsl -e bash -lc "pkill -f 'ledger-old'; …"` returned exit 15 and
never ran the rest. pkill skips its own process, not its parent: the `bash -lc` process carries
the pattern in its own command line, so it matched and got SIGTERM.

**Do:** make the pattern unable to match its own text: `pkill -f '[s]olana-test-validator --ledger …'`.
Or kill by a pid you saved when you started the process.
## 2026-10-19: Tailwind v4 cannot order `2xl:` against `min-[1920px]:`, so the px rule lands first and loses

**Believed:** `2xl:grid-cols-3 min-[1920px]:grid-cols-6` reads mobile-first, as `md:` and `lg:`
do: three columns from 1536px, six from 1920px.

**Measured:** a Playwright screenshot of the BAYLA door at 1920 (`npx vite --port 5199` of the
worktree) still showed three columns. Tailwind v4 sorts min-width variants by value only when
they share a unit; `2xl` is `96rem`, `1920px` is not comparable, so the arbitrary one was
emitted first and the later `2xl` rule won at every width above 1536. `min-[120rem]` sorts
after `2xl` and the six columns appeared. The repo's `min-[1440px]:` + `min-[1700px]:` pairs
work because both are px. Beside a named breakpoint, write an arbitrary min-width in rem.

## 2026-10-19: a container query is not a drop-in for a viewport breakpoint when the column's padding changes on that breakpoint

**Believed:** a card's `md:grid-cols-3 lg:grid-cols-6` could become `@min-[42rem]:grid-cols-3
@min-[58rem]:grid-cols-6` on the card itself, so the same card adapts to a narrower slot on a
wide screen with no change at any window width: in the 1200px column (`px-4 md:px-6`) a `p-6`
card's content box is exactly 672px (42rem) at a 768px window and 928px (58rem) at 1024px.

**Measured** (Playwright, Chromium, `vite` dev of the BAYLA door, screenshots hashed before and
after): identical at 390, 810, 1280, 1440 and 1535; different at 768 and 1024. The card's content
box by `getComputedStyle`: 687px at a 767px window, 672px at 768, 927px at 1023, 928px at 1024.
The column's padding steps from 16px to 24px at md, so the card SHRINKS by 16px as md turns on,
and it is already 42rem wide from a 752px window where md is still off: the container query is
on 16px early, and no single card width maps to the breakpoint. (At exactly 768 and 1024 the
shots differed too, in the sliver of card above the fold; that cause was not run down.) What
worked: keep the viewport breakpoints and add the narrow-slot ones behind a prop that the one
host with a narrow slot passes (`wideGrid`, `HomePage.tsx`). The slot's width is then a function
of the window alone, every other host is untouched by construction, and all seven widths hashed
the same again.

## 2026-10-19: Git Bash hands a Node script `/bayla` as `C:/Program Files/Git/bayla`

**Believed:** `node shoot.mjs /bayla 1920` passes the route through.

**Measured:** the script navigated to `http://localhost:5199C:/Program Files/Git/bayla`. MSYS
path conversion rewrites any argument that starts with `/`. `MSYS_NO_PATHCONV=1 node shoot.mjs
/bayla 1920` passes it untouched (PowerShell has no such rule). Also, an ESM script in the
scratchpad cannot `import '@playwright/test'`, since resolution starts from the script's own
folder: `createRequire('<worktree>/frontend/package.json')('@playwright/test')` loads the
worktree's copy.

## 2026-10-20: a test with one `expect` per item in a 130,000-step loop passes alone and times out in the full suite

**Believed:** a round trip over every 7th tick of the range program (about 130,000 ticks, up to
three `expect` calls each) is a few seconds of plain arithmetic, inside vitest's default 5 s.

**Measured** (vitest 5.0.3, `npx vitest run` of all 1,028 files on the shared box, 2026-10-20):
the test passed when its file ran alone, then failed the full run at 6,169 ms with `Test timed
out in 5000ms`. The arithmetic was not the cost: with plain `!==` comparisons, mismatches pushed
to an array and one `expect(bad).toEqual([])`, the whole file ran in 1.08 s.

**Do:** in a big loop, compare without `expect`, collect what differs, assert once, and give the
test its own timeout as headroom. A test that only passes alone is a CI flake waiting for a busy runner.

## 2026-10-20: in Raydium's range-pool program, a top-up of someone else's reward goes to that reward's starter

**Believed:** when the admin (our vault) pays into a reward a pool's opener started, by re-windowing
or topping it up, whatever is not paid out comes back to the vault.

**Measured** (`solana/clmm-localnet`, check R14, a local chain): the vault paid 30,000 base units to
move alice's reward on pool B to a 30 s window; after the end, `collect_remaining_rewards` gave
alice her 604,800,000 and the vault's 30,000. The unpaid rest goes to `reward_info.authority`, the
reward's starter, whoever paid in.

**Do:** the vault never tops up or re-windows a reward it did not start.

## 2026-10-20: Git Bash rewrites a `/root/...` path inside an environment variable it hands to node

**Believed:** `CLMM_SO=/root/clmm-p1/.../raydium_clmm.so node run.mjs` in Git Bash passes that WSL
path through, as it would on Linux.

**Measured** (Git Bash on Windows 11, node 24): the validator was started with
`C:/Program Files/Git/root/clmm-p1/...` and exited at once. MSYS converts anything that looks like a
POSIX path, in arguments and in the environment of a native program.

**Do:** set such variables from PowerShell (`$env:CLMM_SO = '/root/...'`), or exclude them with
`MSYS2_ENV_CONV_EXCL=CLMM_SO`.

## 2026-10-20: a comment that moves lines changes an Anchor program's build hash

**Believed:** editing only a comment in an Anchor program's source leaves the `.so` byte for byte
the same, so a build hash pinned before the edit still holds.

**Measured** (WSL, Solana 3.1.11, `cargo build-sbf -- --locked`, tegridy-clmm with a throwaway id):
splitting one comment line of `lib.rs` into two (and adding a gated `compile_error!`) changed the
1,523,176-byte build's sha256 from `4180d4a9...` to `cd8f7647...`, same size. Anchor's error paths
compile in the file and line they were raised from, so every line below the edit moved.

**Do:** pin a build hash only from the exact commit that will be deployed, and rebuild after any
edit, comments included.

## 2026-10-20: a program address made public before its deploy can be blocked for good with 0.001 SOL

**Believed:** a program's address is safe to publish before the deploy (in the source, on the
website), because only the holder of its key can deploy there.

**Measured** (`solana/clmm-deploy/rehearsal/rehearse.mjs`, check S1, a local chain, solana-cli
4.1.1): 0.001 SOL sent to the address's program-data account (the loader's PDA of the program id)
made `solana program deploy --program-id <that key>` fail, and nothing was created. The loader makes
that account with a plain create, which refuses an account that already holds SOL, and nobody can
sign to empty it.

**Do:** keep a program address private until the deploy itself; build from a local branch, deploy,
then publish. Before any upload, check the data address holds nothing (`addressesFree` in
`solana/clmm-deploy/scripts/lib/pack.mjs`).

## 2026-10-20: a deploy from a buffer never needs two buffers' worth of SOL

**Believed:** `solana program deploy --buffer` needs the program's data rent on top of the
buffer's, so an exact-size deploy of a 1.5 MB program peaks at about twice its rent (15.49 SOL on
mainnet for the range program).

**Measured** (`solana/clmm-deploy/rehearsal/rehearse.mjs`, a local chain, solana-cli 4.1.1): the
paying wallet held exactly buffer rent + the 36-byte program account + (data rent - buffer rent)
+ 0.03 SOL. The upload left it 0.023 SOL; the deploy then cost it only 0.0012 more, because the
loader moves the buffer's lamports into the program's data inside the same instruction. Peak on
mainnet: about 7.77 SOL.

**Do:** fund one buffer's worth plus fees; ask for the measured sum, not twice the rent.

## 2026-10-20: a key the program compares against is not in the `.so` as 32 plain bytes

**Believed:** a program built with `pubkey!("<vault>")` as its admin carries those 32 bytes, so
searching the build for them proves which admin it names.

**Measured** (the range program's no-features build, 1,523,176 bytes): its own program id is in
the file; the vault, its admin in seven places, is not. The compiler folds a compared constant into
instructions. Every check that searched for it refused a correct build.

**Do:** prove the admin on chain: simulate the admin's own call (it must work) and a stranger's
(it must be refused), and check the source's keys at staging.

## 2026-10-20: vite 8 installs no esbuild

**Believed:** a frontend with vite has esbuild in `node_modules`, so a script can bundle with it.

**Measured** (this repo's `frontend/node_modules`, vite 8.3.0): no `esbuild`; vite 8 bundles with
`rolldown` (1.2.8 here).

**Do:** bundle with `rolldown` from `frontend/node_modules`, as the owner packs' pages do.

## 2026-10-20: the list of Raydium's keys also holds the SPL Memo program, so "no transaction touched a deny key" fails on every v2 swap

**Believed:** `solana/guards/upstream/deny-keys.txt` lists Raydium's own addresses, so a run of
the range-pool program that touches none of them pays Raydium nothing, and a run that touches one
has found a leak.

**Measured** (`solana/clmm-localnet`, check G1, 135 transactions): the one deny key touched was
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`, SPL's Memo program, which `swap_v2` and the v2
withdrawals must name (`address = anchor_spl::memo::ID`). The list is every key Raydium's two
repositories write, less the three system keys `allowed-keys.json` names, so it also holds Memo
and four stablecoin mints.

**Do:** in a runtime check, treat Memo as named-only (a program, never paid) and fail on any other
deny key; take its address from the crate the program builds with, not from memory.

## 2026-10-20: `cargo build-sbf` writes a fresh program key beside the program when none exists

**Believed:** building a program makes no keys; a program key exists only when someone runs
`solana-keygen`.

**Measured** (WSL, Solana 3.1.11, `cargo build-sbf --features placeholder-id -- --locked` in a
copy of `solana/tegridy-clmm`): `target/deploy/raydium_clmm-keypair.json` appeared next to the
1,523,176-byte `.so`. A plain `solana program deploy target/deploy/raydium_clmm.so` would use it
and claim that random address as the program id.

**Do:** delete it after every build that is not the owner's deploy (`shred -u`); the deploy pack
names its key file explicitly.

## 2026-10-20: a Squads vault can sign on a local chain at its real address

**Believed:** testing admin actions "signed by the vault" locally needs a build whose admin is a
local key (`localnet`, `devnet`), so the release build's own admin checks are never run.

**Measured:** a Squads vault's address comes from its multisig's address and the vault index,
not from the members. Loading mainnet's multisig account (`EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK`) with its two member keys
swapped for local keys and its time lock shortened (bytes 74..78) gave vault 0 = the real vault
`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`, and the release-shaped build's every admin check accepted it through
`vault_transaction_execute` (`solana/clmm-localnet`, checks T1 to T9).

**Do:** keep the threshold and config authority as mainnet's, write the member keys sorted, and
keep each member's permission mask.

## 2026-10-20: a validator detached inside WSL still dies when the last `wsl.exe` client exits

**Believed:** `solana-test-validator` started in WSL with `setsid nohup ... &` keeps running until
it is stopped, whatever happens on the Windows side.

**Measured:** started from Node with `spawn('wsl', ['-e','bash','-lc', cmd])`, it exited 0 when the
Windows side ended. Detached with `setsid nohup`, it ran for a 25-minute suite only while another
session's validator held a `wsl.exe` client open; once that ended, WSL's machine restarted
(`uptime` 17 s) and took every process with it, that other session's validator included, leaving
stale PID files whose numbers a new process may reuse.

With four validators starting at once, about one start in ten also died at birth under
`setsid nohup cmd &`: empty log, ledger untouched, a PID file naming nothing. The exiting shell's
hang-up reached it before `setsid` detached it; `nohup setsid cmd &` (hang-up ignored first) and a
2-second `kill -0` check stopped it.

**Do:** hold a `wsl.exe` client open for the length of the run (`spawn('wsl', ['-e','bash','-lc',
'exec sleep 86400'])`, killed at the end), start with `nohup setsid`, confirm the PID is alive
before saying it started, and treat a PID as yours only if `/proc/<pid>/cmdline` names
`solana-test-validator` (`solana/clmm-localnet/run.mjs`, `validator.mjs`).

## 2026-10-20: Base's public RPCs answer eth_call but refuse eth_getLogs, so "no PairCreated found" from them is a search that did not run

**Believed:** the three Base hosts in `viemChains.ts` can find a factory's `PairCreated` event, as
they read its `allPairsLength()`.

**Measured** (viem `getLogs` from Node, 2026-10-20/21, Base factory `0x12a2…9fEC`): every 2,000-block
window on `mainnet.base.org` failed ("RPC Request failed"), `base-rpc.publicnode.com` refused a
500-block window ("Invalid parameters"), and `base.drpc.org` failed six 500-block windows in a row.
The same hosts answered every `eth_call`. `base.blockscout.com/api/v2` gave curl a Cloudflare
challenge page. A loop that swallows those errors prints "not found" for a pair that exists.

**Do:** count the failed windows and say "did not complete" when any failed. Read the pair's own
state by `eth_call` (`allPairs(i)`, `token0`, `getReserves`), which these hosts do serve.

## 2026-10-19: a dev-server walk that stubs every /api/ request renders a blank page, because the app imports from /api/_lib/

**Believed:** on `vite dev`, which has no serverless functions, answering every same-origin
`/api/*` request with a 503 JSON body only turns the page's live reads into dashes.

**Measured** (Playwright 1.x chromium against `npx vite --port 5199`, 2026-10-19): with
`page.route('**/api/**', 503)` the BAYLA door was an empty `<body>` with no `pageerror`; the one
request the stub answered was `GET /api/_lib/errorPolicy.js`, loaded by the bundle as an ES module.
Unstubbed, the page's own `fetch('/api/aggregator.js?...')` made vite try to compile the function,
fail on `./_lib/aggregator-proxy.js`, and draw its error overlay over the page, which then
intercepted every click.

**Do:** stub by path, and spare the shared code: `page.route((url) => url.pathname.startsWith('/api/')
&& !url.pathname.startsWith('/api/_lib/'), …)`. The reads fail honestly, the layout renders, no overlay.

## 2026-10-19: a framer-motion stand-in built on a Proxy remounts the tree on every render, so an element held across a state change goes stale

**Believed:** `vi.mock('framer-motion', …)` with `m = new Proxy({}, { get: () => (props) => <div/> })`
is a transparent pass-through, so a dialog element captured once can be queried after typing into it.

**Measured** (`TopNav.primaryBar.test.tsx`, vitest 5, 2026-10-19): every read of `m.div` returns a
new function, so React sees a new component type on each render and remounts the whole panel. After
`fireEvent.change` on the menu's search field, the captured dialog node was detached and still held
all 38 links; the live dialog held 2. The test passed the assertion only once it re-queried
`screen.getByRole('dialog', …)` after the change.

**Do:** with that mock, re-query the container and the field after every state change, or return
one memoised component per tag from the Proxy.

## 2026-10-18: a three-minute fake-clock watch is over in milliseconds, so a real hash before the timer outlasts it

**Believed:** `watch()` (`frontend/src/test/quietHost.ts`), stepping a fake clock 180 s in
500 ms steps, leaves plenty of room for a call that hashes with WebCrypto before it arms its
own timeout.

**Measured** (vitest 5.0.3, Node 24, this Windows box): all 360 steps of
`vi.advanceTimersByTimeAsync(500)` passed in 5 to 16 ms of real time. With each
`crypto.subtle.digest` held 1.5 s by a spy, both "an answer that stops part-way" tests in
`launchMetadata/upload.test.ts` returned null ("still pending after 180 s"), the message CI
gave once on #866 (run 39081813182). The fake clock moves on whether or not the hash has
answered. How long the CI runner's hash took was not measured.

**Do:** when real-async work runs before the timer, have the stub fetch resolve a promise,
wait for it in real time, then start the watch, counting from that moment.

## 2026-10-18: a staking pot paid over four years cannot run short, but upstream Synthetix strands every stretch with nobody staked

**Believed:** a reward rate set by hand is fine while someone watches the pot; Synthetix
`notifyRewardAmount` can be dropped in as it is; a contract over EIP-170 is fixed by shaving
small things; and one edited contract is a quick rebuild.

**Measured** (PR #824, the new `TegridyStaking`, commits `c57c22e6` and `cef7720c`):
- Each funding sets `rate = (received + still scheduled) / (4 * 365 days)`, so a day pays the
  pot ÷ 1,460 and the total paid cannot pass the total received. The old contract's rate is set
  by the admin and is tied to nothing it holds. `MAX_REWARD_RATE` (1e18 wei a second) turns into
  a pot ceiling: one schedule tops out at 126,144,000 TOWELI.
- Upstream Synthetix keeps its clock running while nothing is staked (here also while paused),
  credits nobody, and leaves that stretch out of the next funding's leftover, so it stays in the
  contract for good. Funding before the first stake is the usual case. The fix moves the end back
  by the skipped stretch: `if (periodFinish > lastUpdateTime) periodFinish += now - lastUpdateTime`
  (`StakingRewardLib.accumulateRewards`).
- Size, limit 24,576 B, ratchet 24,489 B: written inline, 24,693 B. Three small cuts (two
  constants made internal, the rate-cap check and one event dropped): 24,548 B, with a check
  lost. The end date moved out of the library's state struct into host code, plus those cuts:
  24,629 B. A two-line inline unpause instead of a call to the private settle routine: +39 B.
  The whole funding body moved into the delegatecalled `StakingRewardLib`, no cuts: 24,356 B
  (the library went from 7,760 to 8,506 B).
- 64 test and script files import `TegridyStaking.sol`, so one edit meant a full `via_ir`
  rebuild: 1 h 58 min, solc sampled at 18.2 GB. A scratch copy of `src/`, `test/` and `script/`
  with lib paths made absolute in `foundry.toml` built the contract alone
  (`forge build src/TegridyStaking.sol`) in 14.5 s, and
  `FOUNDRY_SPARSE_MODE=true forge test --match-path <file>` ran one suite in about 4 min. Sparse
  mode still parses every test file: with `script/` left out it failed with "Source not found".
- The full suite after the change: 3,039 passed, 26 failed, each failure a test written for a
  fixed rate: a rate in the constructor, TOWELI sent straight to the contract, a shortfall rig
  that needed emission to outrun the pot (it no longer can), a known-defect test asserting the
  over-mint the schedule removes, and a top-up test that funded an empty pool (whose end now
  moves back).

**Do:** pay a reward pot on a fund-backed schedule and move its end back over any stretch that
pays nobody. Near EIP-170, move the biggest body into a library before cutting checks, and
measure each candidate with a one-contract build in a scratch copy. When the rate model changes,
keep each old test's property and rebuild its rig: simulate a loss with `deal()` instead of
over-emission.

## 2026-10-18: a plain `git worktree remove` empties a junction's target, and Git Bash splits a `C:/` folder on `PATH` at its colon

**Believed:** removing a worktree removes only the worktree; a `C:/...` folder put first on
`PATH` in Git Bash is searched first; and adding `MSYS_NO_PATHCONV=1` is always harmless.

**Measured** (2026-10-18, Git for Windows 2.53.0, Windows 11, while archiving idle sessions):
- One app-made worktree under `.claude\worktrees` had `frontend\node_modules` as a junction to
  the main checkout's `node_modules`. The app's archive setting says an archived session's
  worktree is removed unless it has uncommitted changes (read in the settings text, not run).
  In a scratch repo with `node_modules` gitignored and junctioned to a 7-entry folder, a plain
  `git worktree remove` (no `--force`) exited 0 and left the target with 0 entries. Not ignored,
  the junction made it refuse ("contains modified or untracked files"). `cmd /c rmdir <link>`
  (no `/s`) removed the link and left all 7.
- `PATH="C:/.../fakebin:$PATH"`: Git Bash splits `PATH` at every colon, so the first entry was
  `C` and the next `/Users/...`, and `command -v gh` found the real `gh`. With
  `$(cygpath -u C:/.../fakebin)` the fake ran.
- `MSYS_NO_PATHCONV=1 git -C /c/Users/... rev-parse HEAD` failed with "cannot change to
  '/c/Users/...'". Without the variable, or with `C:/Users/...`, it worked: `git.exe` is a
  native program and needs the conversion the variable switches off.

**Do:** before a worktree is removed or its session archived, list its junctions
(`cmd /c dir /AL <folder>` shows `<JUNCTION>`), unlink each with `cmd /c rmdir <link>`, and
count the target's entries before and after. In Git Bash, put folders on `PATH` only in `/c/...`
form (`cygpath -u`). When a command sets `MSYS_NO_PATHCONV=1`, pass every path as `C:/...`.

## 2026-10-18: a coin with no name in a wallet can still be a room's coin, and a pool someone else opens gives no signal

**Believed:** a pool whose coin shows no name in a wallet pairs some stranger's coin, and a
room's "Add SOL + <coin>" door appears once its coin has a SOL pool on the venue.

**Measured** (`getProgramAccounts` and `getAccountInfo` on the public mainnet RPC,
2026-10-18): the venue's pool program held seven pools, and four were SOL pools of room coins
that no room named: RIZZ's (opened 10-16 18:56Z), BRAINLET's, BOBO's and SOY's (10-17 and
10-18). An earlier note had called RIZZ's coin unnamed. It is not unnamed on chain: mint
`5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k` has a Metaplex metadata account
(`GYw8brrmdibD5S2RwksCmpqqZNtdA9RJeszeowh593dr`) whose name is
"SigmaGyattOhioFanumSkibidiGooner" and whose symbol is "Rizz". Its details link points at
`cf-ipfs.com`, which no longer resolves, so a wallet that loads the coin's details from that
link gets nothing. The door is hand-written (`venueSolPool` in `lib/bungalows.ts`): until
#871 named the four pools, those rooms had no door, and nothing said so. #873's check, run
against the registry before #871, named exactly those four rooms and pools.

**So:** before calling a pool's coin unnamed or a stranger's, match its mint against
`lib/bungalows.ts`. A coin's on-chain name need not match its room, and a dead details link
blanks it in a wallet. And any list written by hand that mirrors what others can create on
chain needs something that reads the program, or it falls behind without anyone knowing.

## 2026-10-18: a token with the same name and a smaller market can be the real coin, carried over a bridge

**Believed:** a second token with the same name and symbol as a resident, on another chain, with a
far smaller market, is an impostor (the 08-30 check called Base RIZZ `0x58d6…b238` one).

**Measured** (`cast call` on Base, 2026-10-18): Wormhole's token bridge on Base
(`0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627`, `chainId()` = 30) answers
`wrappedAsset(1, <RIZZ's Solana mint as bytes32>)` with exactly `0x58d6…b238`, and that token's own
`chainId()` = 1 and `nativeContract()` = the mint. Same bridge, `wrappedAsset(2, TOWELI)` = Base
`0x279e…87ca`; the 52,681,394 TOWELI held by Wormhole's Ethereum bridge
(`0x3ee18B2214AFF97000D974cf647E7C347E8fa585`) equal that token's whole Base supply. The OP-stack
standard bridge marks its tokens the same way: Base BOBO `0x570b…3947` answers `remoteToken()` =
Ethereum BOBO. None of this shows in `name()`/`symbol()`, and the market-size test reads a bridge
copy exactly like a fake.

**So:** before calling a namesake real or fake, ask the bridges. `wrappedAsset(chain, address)` on
Wormhole's token bridge, and `remoteToken()`/`l1Token()` on the token for the OP standard bridge, are
one call each. A wrapped copy is the same coin; whether it is worth listing is a separate question
(Wormhole's PEPE and $mfer copies on Solana exist and have no market that trades).

## 2026-10-18: Uniswap's SwapRouter02 on Base cannot reach a V2 pair

**Believed:** SwapRouter02 swaps through V2 and V3 on every chain it is deployed to, so one
`multicall` can buy a basket across both.

**Measured** (`cast call`, 2026-10-18): on Ethereum, `0x68b3…Fc45.factoryV2()` = Uniswap V2's
factory. On Base, `0x2626…1e481.factoryV2()` = `0x0000…0000`: its `swapExactTokensForTokens` has no
pairs to reach. Its V3 side works; a fork run (anvil on mainnet.base.org) bought six coins through
one `multicall(deadline, [exactInputSingle × 6, refundETH])`, each leg paid from the ETH sent with
the call (the router wraps exactly that leg's amount), no approval. Promising one leg 20% more than
its pool paid made the whole transaction revert: no coin bought.

**So:** read `factoryV2()` before routing a V2 leg through SwapRouter02 on an L2. A V2 leg on Base is
its own transaction through the V2 Router02. A `multicall` of exact-input legs paid from `msg.value`
is all-or-nothing, which is the property a basket wants.

## 2026-10-18: Jupiter's keyless tier refuses the sixth quote in a burst, for longer than a short retry waits

**Believed:** five or six quotes a second apart, or one retry after a 429, stay inside Jupiter's free
tier.

**Measured** (`curl` through a local `vite preview` relay to lite-api.jup.ag, 2026-10-18): six quotes
250 ms apart answered 200, 200, 200, 200, 200, 429, and the next one 3 s later was still 429. A
production build walked with Playwright quoted five coins 1.1 s apart, then the first two quotes at
the press failed even after a 2.5 s retry; the third, a few seconds later, passed. Before the fix, a
coin whose Jupiter quote failed was shown as going to the other venue that did quote.

**So:** a failed quote is "price not read", never a reason to route elsewhere. Space a burst about a
second apart, and give the quote a trade is about to be sent on a longer backoff (2.5, 5, 10 s) than
a figure on screen. The site's own relay also caps Jupiter at 60 calls a minute per visitor.

## 2026-10-18: a fixed dialog inside an animated card is trapped under the page's fixed bars

**Believed:** a `position: fixed` dialog with `z-index: 101` covers a top bar and a tab bar at
`z-index: 50`, wherever it is rendered.

**Measured** (Playwright, production build, 1280 px and 390 px, 2026-10-18): rendered inside the swap
card, which framer-motion animates with a `transform`, the dialog was laid out against the card
and stacked inside it. The top bar covered its title and close button and, on a phone, the tab bar
covered its main button. Portalled to `document.body`, the same dialog covered both bars.

**So:** a dialog opened from inside a card renders through `createPortal(…, document.body)`. Any
ancestor with a transform, filter or `will-change` becomes the containing block and the stacking
context of a fixed child.
## 2026-10-18: a `?raw` import of a file outside `frontend/` is denied, and allowing the file does not fix it

**Believed:** a file outside the Vite root can be imported as text with `?raw` once that file is
listed in `server.fs.allow`.

**Measured** (Vite 8.3, `frontend/`, 2026-10-18, building #878):
`import t from '../../../CHANGELOG.md?raw'` fails with `Denied ID <path>?raw`, in vitest and in
the dev server. Listing the file itself in `server.fs.allow` changed nothing. Vite's
`isServerAccessDeniedForTransform` checks the id with and without its `?raw` query, and
`isFileInTargetPath` matches the id that carries the query only against a directory entry. So
only a directory (the repo root) clears it, and that lets the dev server serve every file in
the repo.

**Do:** read the file in a small plugin and hand its text over as a virtual module
(`frontend/changelogFilesPlugin.ts`, #878: `load()` reads the two named files and exports their
text; `vite.config.ts` and `vitest.config.ts` both register it). A virtual id starts with `\0`,
so it skips the file-serving check. Keep the plugin in its own file and import it with its `.ts`
extension: when `vitest.config.ts` imports `vite.config.ts`, Vite prints the
`configLoader: 'native'` warning for `vite.config.ts`'s extensionless imports.

## 2026-10-17: Solscan values a pool's address at its rent; the pool's coins are in its vaults

**Believed:** an explorer link to a pool's address shows the pool and what is in it.

**Measured** (Solscan in Chrome and `getAccountInfo` on the public mainnet RPC, 2026-10-17,
while fixing #867): `solscan.io/account/ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4`, the
BAYLA/SOL pool's state account, showed "Total Value $0.4008" and "SOL Balance 0.0038862":
its rent. The pool held 36.209 SOL and 5,699,019.6679 BAYLA. Its two vaults (the keys at
byte offsets 72 and 104 of the pool account) did show the coins:
`4HjxickXVJ98vdosH9idfKfsombYrk2nNbWZETS8PjVN` held 36.217428047 WSOL, and
`8YBj4RCdDKKs4MG6Ck9A3TSciRRocASr12ie7EsxLTe` held 5,699,019.66797 BAYLA. The 0.0084 SOL
gap is the venue's cut, which stays in the vault until it is collected. A mint sent to
`solscan.io/account/<mint>` loads a blank account page and then redirects to
`/token/<mint>`.

**So:** to show what a pool holds, link its vaults, and expect their balances to run a
little above the reserves until fees are collected. Link a mint to `/token/` directly. Name
what each link opens: four rows all saying "Explorer" read as one broken link.

## 2026-10-17: a CoW order signed as quoted is refused, and a partner fee is charged on orders it is never paid out for

**Believed:** a CoW order can be signed from the `/quote` response as it comes back, and a
partner fee named in an order's appData is paid out whatever the order type.

**Measured** (live mainnet calls on 2026-10-17, preparing #861): `POST /api/v1/quote` for 0.1
WETH returned `feeAmount` 167205522446820 (a network-cost estimate), and `sellAmount` +
`feeAmount` came to exactly 0.1 WETH. `GET /api/v1/app_data/<hash>` for a made-up hash: 404.

**Found** (read, not run): the orderbook refuses any order whose signed `feeAmount` is above 0
(`NonZeroFee`, cowprotocol/services #2454, merged 2024-03-04), so a quote signed as returned is
never placed. The settlement engine charges a partner fee on any order whose appData names one
(services `crates/autopilot/src/domain/fee/mod.rs`), but docs.cow.fi/governance/fees/partner-fee
pays it out on market orders only. CoW keeps 25% (CIP-75), pays weekly in WETH, and voids a
week under 0.001 WETH. The current app-data schemas live in cow-sdk `packages/app-data`
(v1.15.0, `partnerFee` v1.1.0, `volumeBps`); the old cowprotocol/app-data repo stops at v1.6.0,
and the legacy `{bps}` shape is still parsed as a volume fee.

**Do:** sign like cow-sdk's `amountsToSign` (`packages/order-book/src/quoteAmountsAndCosts`):
`sellAmount = quote.sellAmount + quote.feeAmount`, `feeAmount = 0`, and a buy floor of the
quote after all fees, less slippage. Put a partner fee only on a market swap's appData
document. To learn whether a document ever reached CoW, read
`https://api.cow.fi/<network>/api/v1/app_data/<hash>`: 404 means no order carrying it was ever
accepted. A fee taken on a filled order shows in `GET /api/v1/trades?orderUid=<uid>` as
`executedProtocolFees`.

## 2026-10-16: a Solana card on a page makes the top bar Solana-only, even where the page connects Ethereum too

**Believed:** mounting `SolanaProviders` for the home's two Solana cards (stake BAYLA, add
SOL + BAYLA, #858) adds Solana to the home and leaves the top bar as it was.

**Measured** (#858 `9d3fa054`, on the branch build): any page-level `SolanaProviders` reports
`page` to `lib/solanaSurface.ts`, and TopNav reads that as "a Solana page". Its Connect became
the Solana-only button ("Connect a Solana wallet") and Ethereum left the top bar. On the same
page, a Connect then Solana pressed before the lazy cards loaded mounted the top bar's own
connection (`TopBarSolana`), which steps aside when a page's connection arrives and took the
open wallet list with it: its buttons stayed detached for 30 s in the e2e walk.

**Do:** on a page that connects Ethereum too, mount `<SolanaProviders mixed>` and list the path
in `hasMixedSolanaSection` (`lib/routeVoice.ts`). `mixed` keeps the Solana-or-Ethereum sheet;
the path rule stops the top bar mounting a connection of its own while the page's is on its
way. Still one Solana connection per page.

## 2026-10-16: an LP form opened by code moves whatever page it is mounted on

**Believed:** the LP door's auto-open (Add with one coin on the room's pool) could be reused on
the home: its LP card asked for the same form once, when it first drew.

**Measured** (#858 `8f5312c3`, the first walk of the branch build): the home scrolled itself
about 2,000px down to the card. Two effects do it, both right on the LP tab, where a press or a
door link asked for the form. An Add panel (`PanelFrame`) focuses its heading and calls
`scrollIntoView({ block: 'start' })` when it mounts. `PoolFinder` scrolls to a lookup's answer
when `asked` is set, and every `lookUp`, so every `openAdd`, sets it.

**Do:** where a page that is not the LP tab mounts LP cards, show the Add buttons and open a
form only on a press. Pin it the way `LpDoor.test.tsx` does: mock
`Element.prototype.scrollIntoView` and assert it was never called.

## 2026-10-16: a word-budget pass can come from a run where the cards it budgets for never drew

**Believed:** `e2e/word-budget.spec.ts` passing on `/` means the home, cards and all, fits its
ceiling.

**Measured** (#858): a local run with other specs in parallel passed `/` while the home's lazily
loaded Solana cards never drew (the public RPC answered 429). The spec cannot tell:
`waitForQuiescence` resolves silently at its 12 s cap, the cards are a `lazy()` import, and the
LP card is drawn only once a chain read says the venue is `live`. The same build with the
ceiling set to 1 failed at 373 words, and its longest blocks showed what was on screen,
including the LP card's "2 pools found for this token" (a screen-reader line: sr-only text is
counted too), which #858 then fixed.

**Do:** to read a route's real count, set its ceiling to 1 for one run: the failure prints the
count and the six longest blocks, so you see that the cards drew. The `[word-budget]` log line
gives the count on a pass, but not what drew. Put the ceiling back before you commit.

## 2026-10-15: a shorter footer is a change to every page's scroll room

**Believed:** cutting the footer from about 30 links to 8 (#838) touches only the footer's own
specs.

**Measured:** trunk CI went red in all four projects on `e2e/tab-strip-clears-focus.spec.ts`,
whose precondition is that a page scrolls more than 200px. /scan at 1280x800 scrolled 100px
once the footer was 250px tall (read with `scrollHeight - innerHeight` on the production
build). The local runs before merge had not included that spec.

**Do:** when shared chrome changes height (footer, header, bars), run every spec that reads
`scrollHeight - innerHeight` or asserts a page scrolls: today `tab-strip-clears-focus`,
`tab-target-size` and `phone-layout`.

## 2026-10-15: a NavLink lights itself, so two words that open one page both light

**Believed:** a bar word pointing at `/#hall` lights only on the hall, and a `NavLink` whose
`className` is a plain string carries only the classes it was given.

**Measured** (react-router 7.18.3, `NavLink` in `dist/development`, and the bar's own unit test):
a string `className` gets ` active` appended, and `aria-current="page"` is set, whenever
`isActive`, and `isActive` compares the pathname alone. So `/` and `/#hall` are both active on
`/`: Heat and Rooms lit together on the home. A second trap in the same drawer: index.css makes
`.nav-link` `inline-flex` under its touch media queries, unlayered, so it beats Tailwind's
`flex` and two bare drawer links shared a line at 390 and 820 (a Playwright box check, red on
that build).

**Do:** a word that shares a pathname with another is a plain `Link` with `aria-current` from
its own rule; give each drawer row its own block (`<li>`).

## 2026-10-14: a Solana address is not always 44 characters; a random one is 43 about 1 time in 17

**Believed:** a Solana address is 44 base58 characters, so a test may pin `toHaveLength(44)` on
a key from `Keypair.generate()`.

**Measured:** 32 bytes spell 44 characters only when their number is at least 58^43, about
14.9 × 2^248: a first byte of 15 or more always gives 44, 13 or less never does. A random key
falls short 5.8% of the time; 25 of 500 drawn in a test were 43. The pool card test pinned 44
on two random keys and failed 19 of 200 runs on trunk `6c3119e0` (and real checks on #821 and
#800). The testkit's `keyStartingWith(6)`, a token that sorts before wrapped SOL, is never 44.

**Do:** pin a length only on a fixed address. The LP testkit's `key()` hands out seeded
keypairs, skipping any under 44, so its keys are the same on every run. Where a key must be
random, assert 32 to 44 characters.

## 2026-10-14: an element fading out with `visibility` still takes presses, and WebKit can call it hidden while it does

**Believed:** a control hidden with `opacity-0 invisible` and a `transition-[opacity,visibility]`
stops taking presses when it is hidden, and `checkVisibility()` returning false means a press
there cannot reach it.

**Measured** (Playwright 1.62, production build, the Towelie corner over /nft-finance's tabs):
a `visibility` transition keeps the element `visible` until it ends, so for the whole 200ms
fade it is hit-tested. With motion on, Chromium's press on the tab under it landed on the
corner at opacity 0.98. With reduced motion every e2e project shortens the fade to 0.01ms, and
Chromium passed; CI's iPad WebKit failed every attempt with `checkVisibility()` false and
`elementFromPoint` returning the corner's own picture, on the one scroll step where the class
had just landed. The press point sat on the rim of the round picture, and only the DPR 2
device counted the rim.

**Do:** take presses away with something that is not transitioned (`inert`, or
`pointer-events-none`) in the same render that starts the fade, and test the press with motion
on, at the first frame the opacity drops below 1. Name the control a stray press lands in
(`closest('[aria-label]')`), not just its tag: "lands on img" cost a trace dig.

## 2026-10-14: four loads of one heavy page in one WebKit tab is where the iPhone project fails to load

**Believed:** a test that sets a width and reloads the same route four times in one page is
the same as four tests.

**Measured:** seven full E2E runs on 2026-10-14 held four flakes of the one such test on
WebKit (`tab-strip-scroll.spec.ts`), all on `iphone-safari` (DPR 3), on four routes, every one
inside the load: a 60s wait for `load`, "WebKit encountered an internal error", and a page that
never mounted after a 2.3s load where the first two loads took 0.16 to 0.28s. No other test
flaked on a WebKit project in those runs. The retry passed each time.

**Do:** read the failing step before calling a flake a race in the page. Give each load its own
test, as the sibling width specs do; whether that alone ends this flake was not yet shown when
this was written.

## 2026-10-14: a wallet send error that is not a "cancel" can still mean the swap was sent

**Believed:** when `sendTransaction` from the Solana wallet adapter throws, nothing left the
browser, so the visitor can press Buy again.

**Measured** (PR #806, wallet-adapter as pinned on trunk): `StandardWalletAdapter` wraps
everything `signAndSendTransaction` throws in `WalletSendTransactionError`, so for Phantom,
Solflare and Backpack a failure before signing and a send whose answer was lost look the same.
Only `WalletSignTransactionError` (a decline) and the adapter's own pre-prompt errors
(`WalletNotConnectedError`, `WalletConfigError`, `WalletAccountError`) mean "nothing sent". A
bare `new WalletSendTransactionError()` with no message is byte-identical to a wallet that
rejected with `undefined` after it may have sent. The case can be played safely on a production
build: a stand-in Wallet Standard wallet whose `signTransaction` returns the bytes unsigned
(chains mainnet and localnet listed), and `route.abort` on the `sendTransaction` RPC. The
adapter then throws `WalletSendTransactionError('Failed to fetch')` and nothing leaves the
browser.

**Do:** read every non-cancel throw, including an empty one, as "may have been sent", and hold
the button until the blockhash is dead (next entry). For Streamflow, which reads only
`publicKey` and `signTransaction` of its invoker, a small wrapper that notes the signature tells
"never signed" from "signed, then stopped" without forking the SDK.

## 2026-10-14: `isBlockhashValid` says false for a blockhash the server has never seen, and Jupiter's blockhash is already old

**Believed:** `isBlockhashValid(...) === false` means a transaction can no longer land, and a
Jupiter `/swap` transaction carries a fresh blockhash.

**Measured** (PR #806, mainnet, 2026-10-14): a lagging RPC node answers false for a blockhash it
has not seen yet. Jupiter's `/swap` transaction arrived with a blockhash that was valid at slot
456,744,303 and gone by 456,744,489, about 40 seconds after the wallet step, which fits a
finalized-commitment blockhash. A release built on "height after build plus 300 blocks" waits
far longer than needed.

**Do:** treat false as "can no longer land" only from a server at or past a slot where the
blockhash was once seen valid: pass `minContextSlot` and check `context.slot >= ` that slot. A
note for a transaction the wallet sends itself has no last valid height; the height read after
the build plus 150, plus a margin for node lag, is a safe upper bound (too high only delays the
release).

## 2026-10-14: a storage event never fires in the tab that wrote, and a hold that disables a button misses presses already under way

**Believed:** listening for `storage` keeps every tab's copy of a cross-tab hold current, and
disabling the button is the hold.

**Measured** (PR #806): the event fires only in the other tabs. A note another tab wrote counts
before its event arrives, so a press read from hook state can go through. A review that rebuilt
itself, or a press already awaiting a quote, passed a disabled button. Merging a "written while
storage threw" backup into the notes on every read brought back a note another tab had cleared.

**Do:** update the writing tab directly and use the event only for the others. Read storage
again at the press and put the last check in the shared send wrapper, at the point just before
the wallet with nothing awaited after it (here `useVenueSwap`'s `submitPrepared`). Keep the
in-memory backup only when the storage write really failed (make the save return whether it
stored). In jsdom, `window.dispatchEvent(new StorageEvent('storage', { key }))` tests the other
tab. A mid-press race replays on a production build: hold one request with `page.route` while
another tab writes `localStorage`.

## 2026-10-14: a red run before the fix can be red for a reason that has nothing to do with the fix

**Believed:** the named test failed on the old code, so it guards the fix.

**Measured** across five pull requests on 2026-10-13 and 14: a break-it check on a line the test
never reaches passed quietly, because a failed read returned early above it (#805). New tests run
against old product files failed only on their import of a new helper (#806). A test whose first
failing assertion was bookkeeping never showed the harm in numbers (#799). A restore by
`git show HEAD:path > path` also erased uncommitted edits (#801).

**Do:** read which path the named test takes before trusting its result. For pre-fix runs, put
the product files back to the old commit but keep new pure helpers, with a small uncommitted shim
for new exports. Put the money assertion first. Mutate by copying the file to a backup, applying
one edit, running the test, copying the backup back and comparing sha256: that proves the
restore without `git stash` and touches nothing else.

## 2026-10-14: a green pull request can turn red on the merge itself, with no conflict

**Believed:** a PR green on its own head, merged with no conflict, leaves trunk green.

**Measured:** PR #791 was written before `35c2b92c` changed how the swap page waits for a linked
coin. It merged with no conflict and five own-pool page tests went red on trunk `08596661`.
Every PR opened afterwards showed the same red "Lint, Type Check & Test" job for a reason that
was not its own.

**Do:** before blaming a PR for a red job, compare it with trunk's last run of the same job.
When a train carries copy changes, run `moneyWordsMatchTheChain` after every copy merge: on
2026-10-14 a sentence shortened in #803 carried a fact #801 had corrected, and only that test
caught it.

## 2026-10-14: a train branch made of merge commits hides each pull request's secret scan

**Believed:** a train's green "Scan for secrets" covers every PR it carries.

**Measured** (train #809): gitleaks runs here as `git log -p --no-merges --first-parent
base^..head`, so a branch made of `--no-ff` merges scans only its own non-merge commits. A PR
that is red on that check is green inside the train.

**Do:** read each carried PR's own scan before the train merges, and apply any skip rule by
hand. Merging each PR's exact head (read `headRefOid` right before each merge) lets GitHub mark
every carried PR merged.

## 2026-10-14: a new contract test file can switch off every contract test on GitHub

**Believed:** adding `contracts/test/Foo.t.sol` adds tests and changes nothing else.

**Measured** (PR #799): a file whose name matches no pattern in
`.github/contracts-test-slices.json` fails the slice coverage guard. Every `forge test` slice
depends on that guard, so all were skipped and no contract test ran. A skipped job reads as
not red. A fresh worktree also needs `git submodule update --init --recursive`; a non-recursive
init fails the first build on `permit2/src/...`.

**Do:** run `node scripts/check-test-slice-coverage.mjs` before pushing a new test file.

## 2026-10-14: zero as "switched off" is also a real value

**Believed:** setting a price to 0 is a clean way to mark a feature off.

**Measured** (PR #799): a mint price of 0 means a free drop, so "off" became "free". A guard
keyed on "after the first sale" (`totalSupply > 0`) left the zero-sale window open.

**Do:** use a separate flag and let only the timelocked setter clear it. Test every state switch
with nothing sold as well as after a sale.

## 2026-10-14: the contract size levers were not exhausted: a modifier is copied into every function that uses it

**Believed:** TegridyStaking has no EIP-170 room left without moving logic out.

**Measured** (PR #799, `via_ir`): a modifier used at N sites is inlined N times. Moving its body
into one private function the modifier calls (the same move as `_requireContract`) saved 48 bytes
over 6 sites.

**Do:** before calling a contract full, count modifier uses and fold the bodies.

## 2026-10-14: an Ethereum read that "reverted" can be a broken RPC, and some questions need no archive node

**Believed:** a revert from a read means the function is missing or refused, and full event
history needs a paid archive RPC.

**Measured** (PRs #799 and #801): viem labels a JSON-RPC -32603 "Internal error" as
`ContractFunctionRevertedError`. drpc's free tier caps `getLogs` at 10,000 blocks and publicnode
refuses archive ranges, but Blockscout's Etherscan-style API
(`eth.blockscout.com/api?module=logs&action=getLogs`, and `module=contract&action=getcontractcreation`)
returned a contract's whole history and its creation transaction in one keyless call.

**Do:** to learn whether a deployed contract has a function, read `eth_getCode` and search for
`PUSH4 <selector>` (`63xxxxxxxx`; a selector starting `00` is pushed with `PUSH3`, `62`). For an
EIP-1167 clone, read the template address out of the 45-byte proxy first. A Python script on
Windows prints `\r\n`: strip `\r` before passing a hash to `cast`.

## 2026-10-14: the "failed: custom program error" line in Solana logs cannot be written by a program, and 6000 means a different thing in each program

**Believed:** a Streamflow error is opaque, and one error number means one thing across a
vendor's programs.

**Measured** (PR #806): the Streamflow staking SDK throws `ContractError` with `cause` set to
web3's `SendTransactionError`, whose `transactionLogs` hold the full simulation. Program output
is always prefixed `Program log:`, so the runtime's `Program <id> failed: custom program error:
0x...` line is the reliable source of program and code. Code 6000 is `ArithmeticError` in the
reward programs, `InvalidDuration` in the stake pool and `Unauthorized` in the fee manager.

**Do:** read the program id and the code together from that runtime line, and map codes per
program. This complements the 2026-10-10 entry on reasons a token's own program can write.

## 2026-10-14: vendoring an upstream Solana program has three quiet traps

**Believed:** `git archive` gives the upstream bytes, a path dependency is just a path, and a
new `.so` hash means new code.

**Measured** (PR #800, Raydium CLMM): `git archive` applies `core.autocrlf`, so `diff -rq` flagged
every file. A path dependency inside the workspace folder joined the workspace and dragged its
dev-dependencies into the lockfile. Moving a git dependency to a vendored path kept the SBF `.so`
the same size (1,523,176 bytes) but changed its hash, because crate identity feeds the mangled
symbol hashes. Two builds of the same source, Solana tools 3.1.11 in WSL and 3.1.10 on GitHub,
both platform-tools v1.52, were byte-identical.

**Do:** vendor with `git -c core.autocrlf=false archive` and clone upstream the same way. Add
`exclude = ["vendor"]` to the workspace. Compare Cargo.lock by (name, version, source, checksum)
tuples. Treat a local WSL build as a cross-check for CI. A committed manifest of upstream hashes
plus the reviewed diff in plain `diff` format can replace a CI clone: undo the diff strictly
(every `>` line must match) and compare with upstream's hash. To tie an unverified deployed
program to a commit, compare its programdata's last-deploy slot time with upstream merge times
and find an error string unique to one commit with `git log -S`; searching the binary for raw
32-byte keys fails because the compiler inlines constant keys.

## 2026-10-14: a press area made with `::before` can be zero wide, or covered by a later sibling

**Believed:** `before:-inset-y-[N]` grows a button's press area to 44px.

**Measured** (PR #802): with only the vertical insets set, `left` and `right` stay auto and the
absolutely positioned `::before` is zero wide. A later positioned sibling (a `relative` wrapper)
painted over another element's `::before` extension. On paper 10px gave 44.5px; a hit test at
+22px missed.

**Do:** add `before:inset-x-0`, or use `-inset-[N]` on all sides. Hit-test with
`elementFromPoint` at the exact edge points, with about 1px of slack for pixel snapping.

## 2026-10-14: WebKit ignores a focused field's `scroll-margin-top`, and an empty anchor lets a margin collapse through it

**Believed:** `scroll-margin-top` on a field keeps it clear of a fixed bar when it takes focus,
and an empty anchor sits where it is placed.

**Measured** (PR #802): WebKit reveals a focused element using only the scroller's
`scroll-padding`, landing it up to about 10 to 15px short; Chromium centres it, so the bug cannot
be seen there. A zero-height empty anchor let a later sibling's negative `margin-top` (the
panels' `-mt-14`) collapse through it and moved the anchor up 56px.

**Do:** raise `scroll-padding` only while a field has focus with
`html:has(:is(input,select,textarea):focus)`, and check focus landings on WebKit. Give an
empty anchor `display: flow-root`. This adds to the 2026-10-03 entry on WebKit lining up a
field by its text.

## 2026-10-14: small tool traps met this week

- `spawnSync('npx', args, { shell: true })` splits a multi-word vitest `-t` name into words, so
  the filter runs the wrong set or none. Run `node_modules/vitest/vitest.mjs` with
  `process.execPath` and no shell (#805).
- Git Bash turns a Playwright `-g` pattern that starts with `/` into a Windows path, and the run
  reports "No tests found". Drop the slash (#802). It also rewrites a lone `/root/...` argument
  to `wsl`: prefix `MSYS_NO_PATHCONV=1` (#800).
- `gh run view --log` returns nothing while any job of the run is still going;
  `gh api repos/<o>/<r>/actions/jobs/<id>/logs` returns a finished job's log at once (#800).
  Match `^::error::` in guard logs: a printed diff can hold `use crate::error::ErrorCode`.
- The workflow scratchpad is shared by every agent of a run: a generic `commit-msg.txt` was
  overwritten by another agent's message twice (#800, #802). Prefix scratch files with the task.
- A wait for `[aria-busy]` count 0 passes at once, before React has mounted anything. Wait for
  the fallback to appear, then to go (#802).
- `vite preview` reuses `server.proxy`, so `/api/solrpc` and `/api/jupiter` reach mainnet, but
  Vercel functions (`/api/pools`, `/api/aggregator`) are not there: a local walk sees only
  pools the browser finds by address, and console 404s production does not have (#804, #809).
  Restart the preview after every build before measuring (#802).
- Playwright's Chromium "Pixel 5" device matches `(hover: hover) and (pointer: fine)`, so
  mouse-only UI shows and touch-only tests skip on `mobile-chrome` (#809).
- `em-dash-zero` counts text nodes that hold a dash, not dashes: removing one of two dashes in
  one paragraph leaves that route's count unchanged (#801; read in the spec's `proseDashes`).
- A Python heredoc turns a typed `\b` into a backspace byte inside a regex. Write files that
  hold backslashes with the file tool (#804).
- A test that mocks framer-motion with a Proxy returning a new component per access remounts the
  subtree on every render; element references taken before a click go stale. Re-query (#801).
- In a TypeScript test that imports an `.mjs`, a default of `= []` is typed `never[]`. Add a JSDoc
  cast (#800).
- `gitlabCi.test.ts` needs each `local-gates.sh` command word for word on one CI line: use
  `run: |` with backslash continuations, never a folded `run: >-` block (#800).
- To confirm a walk build matches production, build with the two Jupiter fee `VITE_` values:
  the small `solana-*.js` chunk then has a byte-identical name to the live one (#805).
- To build trunk without touching a worktree: `git archive <sha> frontend | tar -x` into a
  scratch folder, junction `node_modules`, `npm run build`, then
  `npx vite preview --outDir <abs path>` (#802).

## 2026-10-10: an error screen that shows 40 seconds late is not a slow host; it is a timer in a tab that runs timers late

**Believed:** a tab left open across a deploy that showed "Loading..." for about 40 seconds
before "Something went wrong" had waited that long on the network for a file that no longer
exists.

**Measured:** the host answers at once. `curl` on the live site for the previous build's
main bundle, two made-up asset names and a made-up stylesheet: status 200,
`Content-Type: text/html`, 0.3 to 0.5 s each, and
`Cache-Control: public, max-age=31536000, immutable`, because vercel.json keys that header
on the request path and the single-page fallback answers under the asset's name. In a
browser on the live site, with the service worker in control, `import()` of a missing
asset rejected after 0.15 to 0.5 s. With two real builds (the commit before PR 782, and
trunk) on a local host that can switch between them, a tab on the old build that pressed
the Solana LP tab had its six files answered as HTML within 0.1 s and showed the error
screen at 0.3 s. The 0.2 s between is one `setTimeout` set inside React: it holds the
change from a spinner to anything else until 300 ms after the spinner appeared. With
every timer in the page made 5 s late, the same error screen appeared at 5.27 s, and with
animation frames stopped instead, at 0.36 s. So the wait is that timer and nothing else. A
hidden tab is where a browser runs timers late; the tab that was seen live could not be
made hidden here, so "it was in the background" is the fitting explanation and not a
measurement.

**Do:** when a screen changes late, time the network and the screen separately before
blaming either, and make the page's timers late on purpose (wrap `setTimeout` in an init
script) to see whether the screen follows them. Do anything urgent from the event itself,
never from the render after it: `vite:preloadError` is dispatched in the same task the
import fails in, and a reload started there took 0.23 s with the timers still 5 s late.
Know what the test browser will not show: Playwright starts Chromium with background
throttling switched off, a headless page never reports `hidden` (minimising its window
through CDP changed nothing), and `page.waitForFunction` polls on animation frames, so in
a tab that really is hidden it never returns. A headed window opens on the desktop of
whoever is at the machine: in the one headed run here the page was already on the new
build before the scripted press, by nothing the script did, and the run was thrown away.

## 2026-10-14: viem's `fallback` moves to the next RPC on an error, never on a `null`

**Believed:** over `fallback([publicnode, drpc])`, a receipt the first host lacks is read from
the second.

**Measured:** for an Ethereum transaction in block 25,038,892, `ethereum-rpc.publicnode.com`
answered `eth_getTransactionReceipt` with HTTP 200 and `"result": null`, while `eth.drpc.org` and
`eth-mainnet.public.blastapi.io` returned it with 28 logs. A viem client over publicnode then drpc
threw `TransactionReceiptNotFoundError` ("could not be found. The Transaction may not be processed
on a block yet."); the same two hosts in the other order returned the receipt. A `null` is an
answer, so the fallback never asks the second host. A ranked transport picks the first host at
run time, so one page reads fine for one visitor and fails for the next.

**Do:** for a historical read through a fallback, treat "not found" as "the host that answered
has no record" and ask a named second host before saying anything. The Solana form of this trap
is the 2026-10-10 entry "a public RPC host can answer 200 with a history it does not have".

## 2026-10-14: a page's visible words are a number a test can hold, and the first pass only looks finished

**Believed:** once the explanations sit in closed drop-downs, a page stays short; a second
"fewer words" pass finds little.

**Measured** on the production build (Chromium, `vite preview`, Bayla skin, words of
`main.innerText`, which excludes a closed details element's body): six days after the
first pass, the phone showed /pools at 570 words, /solana-lp 390, /bayla 351,
/nft-finance 320, /dashboard 246, /liquidity 176, /earn 160, and the marketplace landing
675 behind a splash that stayed up to 12 s with no visible way in. The same fee split was
on /pools four times. One pass by six builders took them to 295 / 206 / 290 / 233 / 203 /
126 / 109 / 227, with every card, control and art surface kept and every moved sentence
in the DOM; the Open button on /earn moved from off the right edge of a 520 px table to
the first screen, and the TOWELI room's Connect from the eighth screen to the first.
`e2e/word-budget.spec.ts` now pins a ceiling per route and width, about a tenth above the
measurement (a count moves with the chain: the marketplace read 227 and 265 on two runs).

**Do:** count, do not read; pin the number so it can only go down; walk the phone and
look at where the first control is, not whether it exists. Two measuring traps: a
Playwright `addInitScript` runs before `document.documentElement` exists, so observe
`document`; and a count taken before a chain read lands is the loading state, so wait for
the section (a Streamflow pool is ~13 sequential RPCs; the LP section ~20 s).

## 2026-10-14: `vite preview` listens on `localhost` only, and a Bash pipeline commits on grep's exit code

**Believed:** `127.0.0.1:4173` and `localhost:4173` are the same server; `test | grep
summary && git commit` commits only on a green test.

**Measured:** `vite preview --port 4173` on this machine binds `::1`; `127.0.0.1` is
refused (Playwright's baseURL says `localhost`, which is why the suite never noticed).
And one commit went in with a red test because the pipeline's status was grep's (0, it
matched a line), not vitest's.

**Do:** address the preview by `localhost`. Run the test alone, or capture its status in
a variable, before the commit in the same chain.

## 2026-10-14: a rebuilt review compared line for line shuts on lines that move by themselves

**Believed:** when a stale review is built again before signing, requiring every rendered
line to read the same is the safe rule: nothing the reader did not see can reach the wallet.

**Found** (island, answer eighteen: a holder could not get a 1 SOL add signed from a phone).
Some lines move with nothing in the transaction changed. A price checked against an outside
market moves every few seconds. A gap estimate printed to the lamport moves with it. A
priority fee re-read from recent fees moves block to block, and its "share of this trade"
text with it. In unit tests on the review, a 0.1 SOL add read 0.01% at 12,000 lamports and
0.03% at 30,000. A review read at phone speed outlives the blockhash, so the rebuild ran on
almost every press, one of those lines had always moved, and the wallet never opened. The
rule that was meant to be strict kept a careful reader from ever signing.

**Do instead:** sort the lines by what can move them (mark the element; treat an unknown
mark as the transaction's own). Hold the transaction's own lines and its instruction bytes
to equality. Let market and fee lines move, and show what moved while the wallet is open.
Shut on what is news: a warning in words the reader has not seen, or a move past the
page's own warning gap. When it does shut, list every line that differs, market lines
included, so "every other line reads as it did" stays true. Measuring a fee move needs the
lamports: the review prints SOL to 0.0001, so a few thousand lamports leave the printed
SOL change unchanged. (`frontend/src/components/solana/curve/useTxFlow.ts` `compare`,
`reviewLines.ts`.)

## 2026-10-10: a scroll reset in `useEffect` lands after the page is drawn, on every page change, and a test can see it without losing a race

**Believed:** scrolling to the top in `useEffect` on a route change is the standard pattern
and lands with the new page; where it is late that is a WebKit race, so a test for it can
only fail now and then.

**Measured** on production builds (Chromium, mobile Chrome, iPhone, iPad and desktop WebKit
from Playwright 1.62, React 19.3, react-router 7.18). The router commits every navigation
inside `startTransition`, so the new page and the effect that resets the scroll are one
commit, and a passive effect of that commit runs in a later task. When the new page's DOM
landed the window was still where the old page had been scrolled to (600 px), and the jump
came 3 to 56 ms later; on a page with its own mount jump a second one came at 32 to 355 ms.
A `MutationObserver` callback runs after the commit's layout effects and before its passive
ones. A test that scrolls the window inside that callback and then asks whether anything
jumped to the top afterwards failed 30 of 30 on the old code, in every engine, and passed
150 of 150 on the new.

**Do:** make the jump in `useLayoutEffect`. React re-runs layout effects (not passive ones)
when a Suspense boundary hides and re-shows a subtree, so keep the key last handled in a ref
and do nothing for the same key twice. Test with the observer, not with a wheel and a timer.
Assert `scrollY > 0`, not the number you set: when content above the fold grows, the browser
moves the window to keep the visitor's place (250 became 359 in Chromium, 1022 on the iPhone
build).

## 2026-10-10: one walk of the old build and one of the new cannot tell a race from a regression

**Believed:** walking a flow once on the build before a change and once on the build after,
and comparing the numbers, shows what the change did. "The same on both" means unchanged and
working.

**Measured:** a link to a section of a lazily loaded page (`/island` to `/#hall`) landed on
its section on both builds in the first walk, in 3 of 3 browsers, and was written down as
working. In a second walk the new build missed it in one browser, which read as a regression.
Ten runs a browser on each build: 19 of 30 on the old, 18 of 30 on the new. It was a coin
flip in code the change does not touch (two tries 120 ms apart against a lazy chunk). The
same second walk put Back 736 px lower on the new build; three more runs on each showed
both positions on both builds, because that page is 736 px taller once a live read answers.

**Do:** repeat a step ten times on each build before reading a difference, or a sameness,
and compare counts. Compare what the code decides (was a jump made: the same in every run
here) before what the browser and the network decide (the final pixel).

## 2026-10-10: a worktree named after its spec makes the spec's name match every test file

**Believed:** `npx playwright test opens-at-the-top` runs `e2e/opens-at-the-top.spec.ts`.

**Measured:** the filter is matched against the whole path. In a worktree at
`...\wt\opens-at-the-top\frontend` it matched all 39 spec files (591 tests a project), and
the run looked like a hang for thirteen minutes. `"opens-at-the-top\.spec"` ran the 6. The
same folder taught a second thing: `npx eslint .` does not read `.gitignore`. A scratch
folder ignored by git as `*.local`, holding copies of `dist`, turned a clean lint into
15,835 errors, 126 files from each copy.

**Do:** filter by `name\.spec`, never by a bare name a branch or folder may share. Keep
scratch builds outside `frontend/`, or move the scratch folder out before the lint gate.
## 2026-10-14: a button past a table's right edge passes every check that scrolls to it

**Believed:** a phone test that finds a row's button, lets Playwright scroll it into view and
clicks it shows a visitor can tap it.

**Measured:** /earn, trunk 08596661 production build, iPhone 15 WebKit and Pixel 5 Chromium.
Every pool's Open button sat at x 394 to 521 on a 393px screen, inside the table's own
`overflow-x-auto` box. `toBeVisible` passed (the box is not empty), the page itself was not too
wide (`scrollWidth` 393, so a page-width check passes), and `click()` on "Open TOWELI" reached
the pool: Playwright scrolled the TABLE sideways first, which no visitor knew to do.

**Do:** scroll the page down only (`window.scrollTo`), then in one evaluate read the button's
rect against `documentElement.clientWidth` and ask `elementFromPoint` at its centre.
`e2e/pool-open-buttons.spec.ts` does this.

## 2026-10-14: a see-through bar in a Windows WebKit screenshot can be a blur that browser never draws

**Believed:** page text readable behind the fixed top bar in a Playwright iPhone screenshot
means the bar lets text through on an iPhone.

**Measured:** /earn, same build, the bar's own contents hidden, brightest pixel inside the bar.
Playwright WebKit on Windows: 31/255 with `backdrop-filter: blur(20px)` on and 31 with it off,
while `CSS.supports` said yes to both spellings. Pixel 5 Chromium: 8 on, 31 off. Bar made
opaque: 0. The Windows WebKit build reports the blur and paints none of it.

**Do:** before calling a glass surface see-through from a WebKit screenshot, switch its blur
off and compare. Identical pixels mean the test browser; check in Chromium or on a real phone.

## 2026-10-10: `origin/<trunk>` moves under a long job, and without your fetch

**Believed:** the trunk commit named at the start of a job holds for the job, and
`origin/mvp-launch` in my own worktree moves only when I fetch.

**Measured:** thirteen jobs worked from one clone that day. Two merges 29 seconds apart moved
trunk 21 commits and 76 files under them, a third followed about 100 minutes later, and nine
of the thirteen reports listed it as a surprise. Worktrees of one clone share their remote
refs, so another session's fetch moved mine: `git diff origin/mvp-launch --numstat` went from
7 files to about 80 with no command of my own in between. A merge simulation of one change
against a draft exited 0 from the old trunk and 1 from the new, because the new trunk alone
conflicted with that draft in three files. And where trunk had only gained what a branch
already held, `git merge-tree --write-tree` of trunk into the branch printed the branch's own
tree id.

**Do:** read `git rev-parse origin/<trunk>` again before the last diff, before the push and
before the report. Same tree id: record the merge and keep every gate result. An unpushed
commit can be replayed on the new trunk with no force push. When a simulation turns red after
a move, simulate trunk alone too and report only the files that differ. Merging a newer trunk
into an old branch can also move the lockfile under an install already made (here sharp
0.35.4 to 0.35.5): compare its hash before the last gates.

## 2026-10-10: a pull request page counts what the branch holds and prints more than the body says

**Believed:** a pull request's page describes that pull request: its own commits, its own
checks, and the body as it was written.

**Measured:** three readings in one day. A notes pull request of one commit, opened on top of
an open train, read 75 commits and 111 changed files: the train's 74 and 111, which in turn
held the 45 commits of the train under it. A branch push had already run a workflow, so at
the moment another pull request opened, `gh pr checks` listed 10 finished rows from the push
beside the pending rows of its own run. And GitHub unfurls every `#N` inside a list item into
that pull request's full title with a state icon: 19 lines of `- #778 <title>` each showed
their title twice.

**Do:** say in the body what the branch sits on and which commits are its own. Do not read
"the listed rows are green" just after opening as the pull request's own run. Write
`#N <title>` lines as plain lines in a paragraph (a body keeps single newlines as line
breaks) and "pull request N" inside bullets, then read the rendered page before calling the
body done.

## 2026-10-10: the end of the day's block is where every same-day changelog line collides

**Believed:** two pull requests that each add a line under today's heading in `CHANGELOG.md`
must conflict, and a line git merges with no conflict has landed in the right place.

**Measured:** with a train open whose line sat at the end of the `### 2026-10-10` block, the
same new line conflicted at the end and merged cleanly in the middle, one unchanged line away
from both the top and the end (`git merge-tree --write-tree` exit 0, both lines present).
Against six open pull requests the end collided with three, the top with one, after the
second entry with one, and after the first, third or fourth entry with none. The other way
round, git merged two carried lines with no conflict under 2026-10-03 and 2026-10-04, where
their old bases had them, and one head's two notes after the file's last entry, out of date
order.

**Do:** while other pull requests are open, place the line mid-block and prove the spot
against each open head with plumbing only (`hash-object`, a temporary index, `commit-tree`,
then `merge-tree --write-tree`, exit 0 required). After every merge of a dated file, conflict
or not, check that each added line is under today's heading and that the dates never rise
reading down. Two notes of one date go to the same spot and collide (one did): send notes
through one pull request.

## 2026-10-10: two timeouts in two layers passed every test of both and gave the wrong one

**Believed:** two pull requests that each make "a read ends after N seconds" can be stacked
once both test sets pass on the result.

**Measured:** one put a 10 second clock in the transport, the other a 20 second clock in the
fetch handed to that transport. Git merged them with no conflict and every existing test of
either passed, because each set times its own layer alone. The composed read ended at 10
seconds with the transport's sentence, on a page whose words and tests say 20. Only a test of
the wiring failed: the transport built the way the page builds it, held, still pending just
past 10 seconds and ended at 20. While writing it, a fake fetch that ignored its abort signal
left a correct test hanging: the transport aborted and nothing rejected.

**Do:** when stacking timeout work, grep for a fetch wrapper passed into a transport and test
the composed read at both limits. Let the layer that owns the clock say so on the thing it
hands over, so a wrapper that drops the note leaves the shorter clock running: the failure is
a read that ends early, never one that does not end. Make every never-answering fake reject
on abort, as a browser's fetch does.

## 2026-10-10: a test that opens a page with no parameter is testing the page's default

**Believed:** after merging trunk into a branch that changes what a page opens on, fixing the
tests that fail is the whole job.

**Measured:** the branch made a swap page open on another coin. Three of trunk's newest tests
failed. A fourth, about the first coin's notes, kept passing, and still passed with its guard
line deleted, because that coin was no longer on the form: it was testing nothing.

**Do:** when a change alters a page's default, grep every test that opens that page with no
parameter, make each one name its subject in the link, and assert the subject is on screen
before anything else.

## 2026-10-10: a scroll worked out from rendered boxes lands short while an ancestor is scaled

**Believed:** a Safari-only miss of 2 to 5px in "bring the selected tab into view" is font
metrics, and a looser threshold is the fix.

**Measured:** every page arrives drawn at 99.4% (an entrance pose, `scale: 0.994`), held a
few frames even with reduced motion on. `getBoundingClientRect` carries an ancestor's
transform; `clientWidth`, `scrollLeft` and `offsetLeft` do not. A scroll computed from both
while the page was still scaled landed short, and a transform ending fires no
`ResizeObserver`, so it stayed short. The signature: the miss was the same for every tab at
one width and different between widths. For a room R asked for and a scale s, the room left
settles at `R - (clientWidth - R) x (1/s - 1)`: 22.0px at a 390px window and 19.5px at 820,
where CI had logged 22, 22, 21 and 19, 19, 19. One machine passed 18 of 18 while CI failed,
because the lazy page chunk raced the end of the pose.

**Do:** compute scroll positions from `offsetLeft`, `offsetWidth` and `clientWidth`, never
from rendered boxes (a transformed element is the offset parent of its children). To pin it,
hold the pose: an init script that scales the page container before the app mounts, at a
rough 0.9, because at 0.994 a 2px rounding allowance hides the miss at phone width. Assert
the hold applied (rendered width over `offsetWidth`), or the test proves nothing. When a miss
is constant at one width, look for a scale before touching a threshold.

## 2026-10-10: a view is on screen before its mount effects have run

**Believed:** once a page's header is visible the page has finished opening, so a test may
act; and a scroll-to-top on open is something no visitor can see.

**Measured:** over 82 loads, React 19 ran a view's mount effects in a later task than the
commit that showed it: 70 to 148 ms later on Chromium, 407 to 953 ms with the CPU slowed four
times, 91 to 1,031 ms on WebKit. A test that scrolled straight after "header visible" had its
scroll undone by the page's own `scrollTo(0)`: 5 first-try failures in 4 of the 6 newest
trunk runs, all on iPhone Safari. A simulated wheel turned as the page appeared lost its
first 120px in 9 of 16 loads on WebKit and 0 of 10 on Chromium. CPU throttling never
reproduced the order on Chromium (0 of 6). Holding back the scheduler's `MessageChannel` tick
did, 26 of 26, but only when held at delivery (wrapping `port1.onmessage`): React posts the
tick inside the commit, so a hold at `postMessage` delayed nothing.

**Do:** before a one-shot action in a test, wait for something the same effect sets (here the
tab's title, set one line above the jump). Count a flake without re-running CI: `gh run view
<run> --job <job> --log` and a grep for the "N flaky" block read six runs in under two
minutes.

## 2026-10-10: reverting the whole fix can pass where one line reverted fails

**Believed:** the strongest break-it check reverts every line of a fix, each added guard can
be seen red by itself, and a browser test's mutant costs a second full build.

**Measured:** with both lines of an inset fix reverted (the code before the fix) one of its
tests passed, because the old second line had already counted the inset; only that line
reverted alone turned it red (48px). Two waits added to a flaky test masked each other:
either one removed passed 6 of 6, both removed failed 6 of 6. And a mutant bundle from
`npx vite build --outDir <a folder outside the worktree>` took 5.6 and 8 seconds in two jobs
and about 2 minutes in a third, against 53 seconds to 5 minutes for `npm run build`;
`vite preview --outDir` served it on a second port, and a `dist` kept from before a change
turned a reworked test red in 19 seconds.

**Do:** where lines of a fix can cancel, break them one at a time as well as together. Where
two guards imply each other, report the pair as the proven unit and name the single removals
that survive. Build mutants outside the worktree, so `dist` stays the fixed build and no
mutant is left in it. That covers specs that need only the app bundle: the 2026-10-03 entry
on a plain `vite build` names the ones that need more.

## 2026-10-10: a port that answers 200 is not your server

**Believed:** I started a preview on a port I had checked was free and the port answers 200,
so the browser run is against my build; and a port I stopped my server on is still mine.

**Measured:** port 4391 answered 200 from another session's build while my own server had
exited with "Port 4391 is already in use". In another job a preview was stopped by PID and
the port was still listening: another session's server had taken it within the same second.
Stopping a backgrounded `npx vite preview` leaves two node processes, npx and vite, on
Windows.

**Do:** start with `--strictPort`, read the server's own log for "already in use", and
byte-compare the served `index.html` with your own build folder before every browser run.
Stop a server by PID only after its command line (`Get-CimInstance Win32_Process`) names your
own worktree or output folder, and read the listener's command line again afterwards.

## 2026-10-10: three totals that were not what ran or what was seen

**Believed:** `vitest list` gives the number of tests to reconcile a partial run against,
chunked browser runs add up to "the whole folder", and after reading 50 screenshots I have
looked at each.

**Measured:** `vitest list` prints one line per `it.each` template, not per case: 894 lines
against 1,141 tests run for the same 67 files, and 36 listed for a file that runs 54. A tally
kept across chunked Playwright runs said 601 tests had run; ticking each spec file off
against `--list` gave 494. And the image reader dropped older pictures from context past a
per-request limit ("media removed"), 11 of 27 in one set.

**Do:** reconcile a partial vitest run by file count, and take test counts from the run's own
"Tests N passed" line. For chunked runs write the per-file counts from `--list` first and
tick each file off per chunk. Read screenshots three or four at a time and write one line per
picture before loading more; re-read any that were dropped before saying it was looked at.

## 2026-10-10: a remembered verdict holds only for every input of the check that made it

**Believed:** a verdict kept in page state ("this route's transaction failed its test run")
is safe when keyed on the trade: the pair and the amount.

**Measured:** the test run that produced it also depended on the slippage and on the wallet.
After the trader widened the slippage the page still said the transaction had failed its test
run, for a transaction nobody had tested; a test with only the slippage changed failed on the
old key. The fix added slippage to the key and missed the wallet, which a reviewer found. The
verdict was also ended by a check that could not run, and "is it kept" was being read from a
flag derived for display, which is false whenever the other route has caught up on screen.

**Do:** list every input of the check and key the verdict on all of them. Give it an ending
for each way it can stop being true, and end it only on a check that ran and passed. Decide
"a verdict is kept" from the kept state, never from a flag made for display.

## 2026-10-10: the reason a failed simulation gives can be written by the token's own program

**Believed:** the reason string parsed from a failed simulation's logs is the network's
account of the failure, so it can be shown to the person about to sign.

**Measured:** the parser returned the first log line matching failed, insufficient, slippage
or 0x, with `Program log: ` stripped. A `Program log:` line is whatever a program in the
transaction chose to print, so a token's own program could word the cause on the page. After
the fix, a walk on the built site whose only log was a forged `Program log:` line showed no
cause.

**Do:** derive anything shown on a standing line or a consent screen only from lines the
runtime writes: `Program <id> failed: ...` (anchored), a native program's line with no
`Program log:` prefix, such as the System Program's "Transfer: insufficient lamports X, need
Y", or a one-word RPC error. Pin it with a test that feeds the forged `Program log:` twin of
each line. Give advice only where the cause is attributed for certain: the short-transfer
line names two amounts and not whose account it was.

## 2026-10-10: what a constant-product pool has earned its shares can be read with no history

**Believed:** to say what a pool has paid its liquidity providers you must add up its swaps,
which means reading its transactions or running an indexer.

**Measured:** in a pool that mints its first shares as the square root of the two deposits
(Raydium's cp-swap, Uniswap v2), `isqrt(reserve0 * reserve1) / share supply` is exactly 1 at
opening and can only rise. Read from the BAYLA/SOL pool's current state alone on 2026-10-10:
372,663,147,122 over 372,631,821,673, so 0.0084065% growth per share, which matched the fees
of its three swaps counted one by one (4,208,400 lamports to providers). Two things it is not.
It is not exactly zero before the first trade: every deposit rounds in the pool's favour, and
29 deposits had already made it 234 units (0.0000000641%). And it is not only fees: 1 SOL sent
straight into the vault, with no trade, read as 1.9%.

**Do:** use the ratio for "how much each share has grown", free, on every read. Take "has it
traded at all" from the pool's own trade record, never from the ratio being zero. Before
stretching it into a rate, ask a second witness that only trades move: here the venue's
uncollected fee counter, which explained 30,575,562 of the 31,325,449 units of growth.

## 2026-10-10: a public RPC host can answer 200 with a history it does not have

**Believed:** `getSignaturesForAddress` returns an account's transactions on any mainnet host,
and a missing transaction comes back as an error.

**Measured:** for a pool with 34 transactions over six days, `solana-rpc.publicnode.com`
returned 1 signature, and `null` with HTTP 200 for transactions one to four days old.
`api.mainnet-beta.solana.com` returned all 34 and every transaction. Current state (balances,
accounts) agreed on both hosts, so nothing looked wrong until the counts were compared.

**Do:** before trusting a count or a "first deposit" read from history, ask the host for one
transaction you know is old. Treat a `null` transaction as "this host has no record", a state
of its own, never as "it did not happen".

## 2026-10-10: one refused call out of twenty threw the whole page away, every time

**Believed:** reading a page of 20 transactions with `Promise.all` and pressing again on a
failure gets there in the end.

**Measured:** against a keyless public host, 10 of the 20 calls were turned away with HTTP 429
on the first press of every walk. `Promise.all` rejected on the first refusal and the code kept
transactions only after all 20 had answered, so the next press sent all 20 again and half were
refused again: the page never finished. Waiting for every call to settle and keeping each
finalized answer that did arrive made the second press ask for 10 and the third for 8.

**Do:** when a batch is retried by a person pressing a button, keep what answered. Count the
calls on the wire for the second press: if it equals the first, nothing was kept.

## 2026-10-10: a value handed up through an effect is on screen one render late

**Believed:** once a test has waited for a block to leave its "reading" state, everything that
block derives is on the page.

**Measured:** a row moved into a fold was told its text by the block through an effect, so it
arrived one render after the figures. Two tests read it straight after the wait. The file
passed 12 of 13 runs alone and failed in 3 of 4 runs of the wider set on a busy machine, always
the same two tests, always "unable to find an element". The page itself was right every time.

**Do:** when a fix moves where something is drawn, re-read how it gets there. Wait for the
thing you assert, not for a neighbour. Then run the wider set several times in a row before
calling it fixed: five runs of 1,548 tests passed after the two waits were added.

## 2026-10-10: a wallet can grow a transaction you built at 763 bytes to exactly the limit

**Believed:** a transaction's size is what the site built, so one that is 763 bytes has 469
bytes to spare under the 1,232-byte limit.

**Measured:** on mainnet, 3 of a pool's 30 deposits were signed with 10 extra guard
instructions the wallet added (about 469 bytes) and each landed at exactly 1,232 bytes. The
three swaps carried 8 such instructions (427 bytes) and the pool's opening 12. The other 27
deposits carried none.

**Do:** when sizing a new transaction, leave room for what the wallet adds, and take that
figure from real signed transactions, not from the docs. Before building two steps into one
transaction, sign one of that shape in a real wallet.

## 2026-10-10: a price feed's candles are for the pool's first-named token, and a builder's 200 is not the program's yes

**Believed:** asking a candle feed for a token's top pool gives that token's price, and an
order API that returns a transaction has accepted the order.

**Measured:** GeckoTerminal's candles describe the first-named token of the pool. For USDC
the top pool that day was another coin paired with USDC, so the same lookup that is right for
BAYLA would have printed the other coin's price as USDC's. Separately, Jupiter's recurring
order API built a transaction for a Token-2022 token in both directions, and the program
rejected it when simulated (error 3007).

**Do:** check that the feed's base token is the one you asked about and say "unread" when it
is not. Simulate what a builder hands back before offering it to someone to sign.

## 2026-10-09: an expected value built by the function under test cannot see a wrong constant inside it

**Believed:** the address a launch's details file says it was made on (`createdOn`) was
covered. Five test files build or fake that file, and the canonical host has its own guard
tests.

**Measured:** the address was written on 2026-09-26 as the host the venue had left on
2026-09-20, and every test stayed green for 13 days. Three of the files build the file with
`buildMetadataJson`, the function that writes the address: two compare its output with its
own output, so both sides held the same wrong host, and one reads the file back through a
parser that ignores the field. The other two typed a host into a fake upload, two different
hosts, and asserted nothing about either. Each canonical-host guard pins a
surface it names (index.html, the sitemap, the middleware, the bot's defaults); a surface
written after the move was on no list. One assertion against `SITE_URL` failed on its first
run: `expected 'https://memetic.fun' to be 'https://memetics.finance'`.

**Do:** pin a constant that is written out and never read back against its source of truth,
not against the function that writes it. A test that calls that function for its expected
value is checking the plumbing, which is worth having, and says nothing about the value.
After a host moves, also search shipped code for the old host as text: the listed surfaces
are only the ones somebody thought of.

## 2026-10-08: a workflow's green runs can all have skipped the job that is broken

**Believed:** a manual workflow whose last five runs are green builds what it says it builds.

**Measured:** `solana-deploy-artifact.yml` has two jobs, each behind an `if:` on which
program was asked for. All five green runs from 2026-09-09 on built bayla-ladder; the job
that builds cp-swap and tegridy-launch read `skipped` in each (`gh run view <id> --json
jobs`). That job's last step printed `$((SIZE * 2))` under `set -euo pipefail` with `SIZE`
never set. Run as the runner runs it (`bash -e <script>`, a dummy `.so`, Git Bash 5.2.37) it
exited 1 with `SIZE: unbound variable`, before the checksum file and the upload; with only
`-u` taken off it exited 0 and printed `solana rent 0`. GitHub accepted the file throughout.

**Do:** for a workflow with jobs behind `if:`, read which jobs ran, not the run's conclusion.
To try a step without a runner, take its script out of the file, fill in its expressions, and
run it under the same shell options beside a dummy input. An unset name is fatal only under
`-u`, and in arithmetic it would otherwise read as 0 and print a wrong number in silence.

## 2026-10-08: after fetching two refs, FETCH_HEAD is the first one

**Believed:** `git fetch origin mvp-launch pull/695/head`, then
`git merge-tree --write-tree HEAD FETCH_HEAD`, simulates a merge with the pull request.

**Measured:** `FETCH_HEAD` resolved to the first ref fetched, the trunk. The simulation
exited 0, clean, for a pull request that conflicts in two files (exit 1 once its own sha was
passed).

**Do:** fetch the one ref, put `git rev-parse FETCH_HEAD` in a variable straight away, and
check it against `gh pr view <n> --json headRefOid` before simulating anything.

## 2026-10-08: every caller had a branch for a read that failed, and the failure never reached one

**Believed:** the swap page treated an unanswered read as "no answer" (law 8): every
caller of a read had a branch for a read that failed.

**Measured:** the failure never reached those branches. Three functions answered "could not
check" with the same value as a finding. `refresh()` returned `[]` for "no pools" and for a
read of our pools that failed. `prepareJupiterSwap` returned `blocked` both for a test run
that refused the transaction and for a no-fee retry whose quote, build or test run threw.
Its fail-open `ready` (first test run threw) looked the same as a clean run. A reviewer
reproduced each in a page test: Jupiter's transaction sent with our pools unread; our pool
built with a review saying Jupiter's transaction "failed its test run" when it was never run.

**Do:** give "could not check" its own value where it is made (`null`, `unchecked: true`),
then read every caller. A caller cannot honour a distinction its input does not carry.

## 2026-10-08: `tsc -b` in a throwaway worktree can write the main checkout's build cache

**Believed:** a git worktree with `node_modules` symlinked from the main checkout is
isolated: what runs there does not touch the main tree.

**Measured:** `tsc -b` keeps its incremental state in `node_modules/.tmp/*.tsbuildinfo`, so a
worktree that symlinks `node_modules` shares that state. An agent's `tsc -b --noEmit` in such
a worktree rewrote the three files the main checkout's `tsc -b` reads. A later clean result
in the main checkout could have been an answer about the worktree's sources.

**Do:** in a shared `node_modules`, run the gate as `npx tsc -b --noEmit --force`, or give the
worktree its own `node_modules/.tmp`. Re-run with `--force` before trusting a clean `tsc -b`
after any worktree run.
## 2026-10-10: a cache told not to store a wrong answer still hands it on, when the cache behind it holds the same answer

**Believed:** the service worker stored the app's page under an asset's name, so a check
that stops it storing HTML fixes a visitor whose browser runs the worker.

**Measured:** Chromium 151, the built app and the real `public/sw.js`, on a local host that
sends what production sends for an asset name it does not have (status 200, `text/html`,
`Cache-Control: public, max-age=31536000, immutable`). With the check alone the worker's
cache stayed empty, and once the host had the file again `fetch()` still got the page,
`import()` failed and the host was asked 0 times: the worker's own `fetch(request)` is
answered from the browser's HTTP cache, which had kept the page for its year. Asking a
second time with `fetch(request, { cache: 'reload' })` when the first answer is a page
reached the host, returned the file and replaced the browser's entry: with the worker then
unregistered and its caches deleted, the browser answered with the file and asked the host
0 times. A `<link rel="stylesheet">` (a no-cors request) healed the same way. Playwright's
WebKit 26.5 showed the worker's half and the same repair, but its own cache kept nothing
between two page loads with no worker at all, so it says nothing about Safari's cache.

**Do:** when a worker sits in front of the browser's cache, name both caches and prove each
alone. Read the worker's with `caches.open(name)`; then unregister the worker, delete its
caches, and count the requests that reach the host. `cache: 'reload'` is how a worker gets
past the browser's cache and repairs it in one request. A browser with no worker in control
is not reached by any of this.

## 2026-10-10: `vite preview` does not answer a missing asset the way the host does

**Believed:** `vite preview` answers a file it does not have with index.html and status 200,
as production does, so it can stand in for the host when the question is what a browser
keeps.

**Measured:** vite 8.3.0, `curl` on a made-up `/assets/` name with each `Sec-Fetch-Dest`:
`script` gets status 404 and an empty body; `style`, `font`, `image` and `empty` (a
`fetch()`) get the page with status 200. Production gave the page to all of them. Every
answer from `vite preview`, real files included, carries `Cache-Control: no-cache` and
`Vary: Origin`; production sent `public, max-age=31536000, immutable` and no `Vary`. Seen in
Chromium as a result: the browser's own cache never kept the page, so that half of the
fault cannot be shown there; and the worker's Cache held one URL apart by request. An
`import()` carries an `origin` request header and a `fetch()` does not, so a page stored
for a `fetch()` was not matched by an `import()` of the same URL, which went to the network
and loaded while `fetch()` still got the stored page. `cache.match(url)` said "no entry"
for a response an `import()` had stored; `{ ignoreVary: true }` found it.

**Do:** read the real host's headers first (`curl -s -o /dev/null -D -`), and build the
local host from them: a Node server of about 60 lines did. Ask the way the page asks: an
`import()`, a `<link>` and a `fetch()` are three different requests. When a test looks in a
Cache, pass `ignoreVary: true` or list `cache.keys()`.

## 2026-10-10: on Vercel a 404 carries the header rules of its path

**Believed:** leaving `/assets/` out of the single-page rewrite in `vercel.json` makes a
missing asset a plain 404, and a 404 is not something a browser keeps.

**Measured:** on memetics.finance only `/api/` paths can answer 404 today (the rewrite
leaves them out). `/api/zz-not-a-file` answered 404 with `Cache-Control: public, max-age=0,
must-revalidate`, the platform's default, and the `X-Frame-Options` of the `/(.*)` rule.
`/api/zz-not-a-file.map` answered 404 with `Cache-Control: no-store` and `X-Robots-Tag:
noindex`, both from the `/(.*).map` rule. So a header rule is applied to a 404 by its path,
Cache-Control included. A 404 under `/assets/` could not be read, because nothing there can
answer 404 today; by the same rule it would carry `max-age=31536000, immutable`. Chromium
151 keeps a 404 sent with that header: on a local host that answers a missing asset that
way, the next ask after the host had the file again was answered 404 from the browser's
cache, 0 requests reached the host, and `import()` failed. The path decides the header for
the page too: a made-up `/icons/` name got the page with the year-long header, and made-up
`/art/` and `/_derived/` names got it with seven days.

**Do:** before turning a wrong 200 into a 404, find a path that already answers 404 under a
header rule and read what it sends. `headers` in `vercel.json` matches the request, never
whether a file exists. Vercel's reference (read 2026-10-10) lists the one thing that did,
`handle` in `routes`, as deprecated. And a repair written for the wrong answer of today
(`public/sw.js` asks again when it is handed a page) does not fire for another wrong answer:
change what the host sends for a missing name, and that check changes with it.

## 2026-10-08: a test rewritten for a new rule can stop holding the old rule it also held

**Believed:** a pull request that changes one assertion in an existing test (a pool's price
state from "no market" to "disagrees", because the scenario now has something to compare
with) leaves that test proving what it proved before.

**Measured:** that test was the only one holding a second rule: when Add liquidity is pressed
without naming a pool, the page passes over a pool whose price was compared with nothing if
another pool takes the deposit with no price warning. Once the scenario changed, no test
reached that branch. A reviewer took the rule out of the page (one line) and 4,006 of 4,006
tests passed on the result; the same break on trunk's code failed trunk's own copy of the
test (1 failed, 50 passed). What found it was running trunk's copy of each changed test file
against trunk's code, and against the result, with the rule removed.

**Do:** when a change edits an existing assertion instead of adding a test, ask what else the
old scenario was exercising. Before rewriting it, break each rule the old test touches and
note which ones only it catches; after rewriting, break them again on the new code. A rule
that nothing catches any more needs its own test for the case that is left.

## 2026-10-08: keeping both sides of a conflict drops the closing lines the two blocks share

**Believed:** when both sides add a block at the same place, the resolution is mechanical:
ours, a blank line, theirs.

**Measured:** git leaves lines that both sides share outside the markers. Two `describe`
blocks added at the same spot both ended with the same two closing lines, so those lines sat
after the closing marker, once. Ours-then-theirs left the first block without its closers.
The type-check reported `'}' expected` at the last line of the file, about 600 lines below
the join, and the test runner reported the whole file as failed, not one test. The same
script had resolved three other keep-both conflicts that week correctly, because their
blocks ended differently.

**Do:** after any keep-both, parse the file (the test project's type-check is enough) and
compare the number of tests per joined file with the two sides (here 309 in five files,
against 279 on trunk and 288 on the branch). "No conflict markers left" says nothing about
either.

## 2026-10-08: tests for the new branches do not show that nothing else moved; the old rule run beside the new one does

**Believed:** a change to a rule that decides whether money may move was safe once every
new branch had a test and every way of breaking a new branch failed one (53 tests added,
52 mutations, 52 caught).

**Measured:** that shows the new branches are held. It says nothing about the cases the
change was not meant to touch. A reviewer put the four rule files from the commit before
beside the new ones and ran both over every combination of their inputs: 5,391,360 cases
of the deposit check and 8,640 of the opening check, from throwaway tests. Outside the two
new answers the results were identical. Inside them, each new answer came from exactly one
old state, and the verdict moved one way only, from "not checked" to "allowed", and only
when no other reason stood. No refusal was lifted. That is the sentence the owner needed,
and no number of hand-picked cases could have said it.

**Do:** when a rule is a pure function of a handful of inputs with a few states each, keep
the old file (`git show <before>:path > old.ts` in a throwaway folder), list every state of
every input, run old and new over the whole grid and print only the differences. Then say
what the differences are, in one sentence. Here the grid was one throwaway test file.

## 2026-10-08: a state the live site cannot be in can still be looked at on the live build, one changed answer at a time

**Believed:** the new screen for "Jupiter has no price for this pairing coin" could not be
checked on the live site, because Jupiter does price the coin.

**Measured:** one upstream answer was replaced on its way into the page: in Playwright, a
route on the price proxy's quote path answered the two requests for that coin (and no
other) with the proxy's own "no route" reply, a 404 with `{"error":"No route","code":
"NO_ROUTE"}`. Everything else was the live site's own. The live build then showed the three
new sentences, no "Match the market price" button and no sideways scroll at 320 and 390
wide, with no signing request and no send. Two things the run taught: the walk's own
counter of failed API calls read 1, and that one was the replaced answer; and the Review
button was off because no wallet was connected in that step, so "Review is on" was seen
in unit tests only, not there.

**Do:** replace the upstream's answer with the upstream's own answer for that case, never
an invented one; replace as few requests as will do it; write in the same breath that it
was a simulation and what was replaced; and read your own error counters knowing your
replacement is in them.

## 2026-10-08: a screen that is taken out was doing jobs nobody listed

**Believed:** the "Review your swap" screen was only a second look, so a swap whose test run
passed could skip it and go from Buy to the wallet with every check still made.

**Measured:** an independent review of the first cut found four things only that screen did.
It was where the trader saw the figures of the transaction itself (the form's quote can be
minutes old, and the swap is built on a fresh one). It was the only place that said a sale
for SOL would be paid as wrapped SOL into an account the wallet already had. It was the only
place that showed the one-time deposit for a new token account. And its card was what held a
refusal of what a wallet handed back on screen long enough to read. All checks still ran; the
trader simply no longer saw their results.

**Do:** before removing a screen, write down every line it can show and every state it can
hold, and give each one a new home or a reason to stop. "The checks still run" is about the
code. What the person was shown is a separate list.

## 2026-10-08: a mutation run that is cut short leaves its mutant in the source

**Believed:** a runner that mutates one line, runs the tests and restores the file in
`finally` always leaves the tree clean.

**Measured:** a run of sixteen was ended after the fourteenth. The page kept
`if ((false as boolean) && deposit > 0n)`. `finally` does not run when the process is killed,
and the background job still reported exit code 0, because the last command in its chain was
a `grep`. The missing lines in its output and a search of the source were the only signs.

**Do:** after every mutation run, prove the restore: every "from" string is back in its file
and no "to" string is left. Do not build, commit or start a review while a run is going:
each of them reads the mutant.

## 2026-10-08: on localhost one swap route works and the other says "Swap failed", and neither is the site

**Believed:** a wallet stand-in that works on the live site works the same on a local build.

**Measured:** the wallet-standard adapter maps an RPC address that contains `localhost` to
the localnet chain. A stand-in wallet whose account lists only mainnet is refused before it
is asked, with an error that has no message, and the page shows "Swap failed" with nothing
under it. The swap through our own pool signs through another call and was not affected, so
one route worked and the other looked broken. On the live site the address maps to mainnet.

**Do:** a stand-in wallet for a local walk lists `solana:localnet` beside `solana:mainnet`.
An error with no message from a wallet call is the adapter refusing, not the wallet.

## 2026-10-08: a fold keeps its words in the page and takes its warnings out of sight

**Believed:** moving rows under a "Details" line only saves space.

**Measured:** price impact was one of the rows. On a route with no review step it was the
only place a 35% move was said, and folded shut it was said nowhere. The em dash guard and
the unit tests did not notice, because a closed `details` element keeps its text in the
page: they count and find it whether or not anyone can see it.

**Do:** when rows are folded, go through each and ask whether any value of it is a warning.
Draw that case outside the fold. A test that finds text in a closed fold proves the text
exists, not that it is shown: assert it is not inside the `details`.

## 2026-10-07: a `WalletSignTransactionError` means the person declined

**Believed:** the Solana write path's decline test could match the adapter's error class
name, because a sign that throws is a prompt the person said no to.

**Read, in `@solana/wallet-adapter-base` and every adapter in `lib/solanaWallets.ts` and
`lib/solanaWalletConnect.ts`:** each one rethrows ANY failure inside `signTransaction` as
`new WalletSignTransactionError(inner.message, inner)`: a wallet that broke before its prompt
opened, a WalletConnect session that never granted signing, and a real "no" all wear the same
class. A Trust Wallet LP add that failed with no prompt read "You cancelled in your wallet".
And Trust's real "no" is not words at all: `trust-web3-provider`'s `CallbackAdapter` turns the
app's numeric answer into `RPCError(4001, '4001')`, and an older build rejects with a bare
string, so `inner.message` can be `"4001"` or `undefined`. And the library adapter throws
three errors unwrapped, with a name and no words, before the wallet is asked at all
(`WalletNotConnectedError`, `WalletConfigError`, `WalletAccountError`).

**Do:** decide a decline from the wallet's own error under the wrapper (`.error`, then
`.cause`): code 4001, or reject/declin/denied/cancel in its words. Anything else says what
the wallet said, so the next report carries the real reason. Where there are no words, say
the code or what the error's name tells before settling for "it gave no reason".

## 2026-10-07: a request timeout covers the whole request

**Believed:** a transport's timeout ends any request that is not answered in time. So
"viem gives up after 10 s per endpoint" means an Ethereum or Base read is never waited on
for longer than that, and a hand-written timer copied from it bounds the read the same way.

**Measured:** viem 2.56.8 on Node 24.13.0, its `http` transport with no retries, against two
local servers. One never answers: the request threw `TimeoutError` after 10.1 s. One sends
a 200, its headers and half a JSON body, then nothing: the request was still pending after
the 30 s watched. viem's timer wraps only the `fetch` call and is cleared when the headers
land; the body is read after it, with no clock. The same shape written by hand for the
Solana transport (`browserRpc`), with the clock stopped at the headers, passed 39 of its 40
tests. The one that failed used a response whose `json()` never ends. A second trap sat
beside it: an abort that lands during the body read does not come back as an abort. With a
fake whose `json()` rejects as a browser's does, the call reported "the response was not
JSON (The operation was aborted.)", because the wrapper around the parse caught it first.

**Do:** keep the timer running until the body has been read, and clear it in a `finally`.
Decide "timed out" from the controller (`signal.aborted`), never from the error's name or
message. Test with two fakes: a fetch that only ends by being aborted, and a response whose
`json()` only ends by being aborted. Before leaning on a library's timeout, run it against
a server that sends headers and half a body.

## 2026-10-07: a Playwright route can play any way a host goes wrong

**Believed:** `page.route` covers every network failure a browser test needs: refuse the
request, hold it, or answer it.

**Measured:** a route answers with a whole body or not at all (`route.fulfill` takes the
body in one piece), so "headers and half a body, then nothing" cannot be played through it.
What worked, on Chromium 151 with the production build untouched: a local Node `https`
server with a self-signed certificate that writes the headers and half the body and never
ends the response; Chromium started with
`--host-resolver-rules=MAP <rpc host> 127.0.0.1:<port>` for each host; and the context
opened with `ignoreHTTPSErrors: true`. The bundle, its URLs and its CSP stay as shipped.
The server sees when the browser hangs up (`res.on('close')`), which is the moment an
abort landed: 10.0 s for every read, 2.0 s for every ranker ping. While any route was
registered on the context, no CORS preflight reached the server; only the POSTs did. In two
runs started together on a busy machine, the first round of 2 s pings never reached the
server and the round a minute later did; in a run by itself they arrived at once. Why was
not established.

**Do:** to stall a body in a real browser, resolve the hostname to a server of your own
instead of routing the request. Run one browser at a time when the first seconds matter,
and log every timestamp against one start point.

## 2026-10-07: timing a body read that a library leaves untimed takes a second timer

**Believed:** viem's request timeout stops at the headers, so covering the body means
wrapping `fetch` with our own `AbortController`, our own timer and our own timeout figure.

**Measured:** viem 2.56.8, on Node 24.13.0 and in Chromium 151 (a production build, the
RPC hostnames resolved to a local TLS server). viem clears its timer when the `fetchFn` it
was handed returns, and the signal that timer aborts is the one it hands that function. So
a `fetchFn` that reads the body before it returns puts the body on viem's own clock. With
every host sending headers and half a body, a read through the Ethereum roster ended as
viem's `TimeoutError` after 81.05 s of fake clock, the same instant as with silent hosts
(Base, three hosts: 121.05 s); before, it was still pending after 300 s. In Chromium the
burn card said "Reading" for the 150 s watched before, and gave up 81.5 s in after. Three
things came with it:

- Reading the body yourself steps around viem's 10 MiB limit on an answer, which it
  applies while it streams. The wrapper has to stop at the same limit.
- viem's ranker waits for every ping of a round. One ping whose body stalled ended ranking
  for the visit: one round in 70 s where there should be two.
- Given a caller's signal, viem's `http` transport hands `fetch` that signal instead of its
  timer's, and then nothing times the request at all. `fallback` drops a caller's signal
  today, which is the only reason this does not bite.

**Do:** before putting a timer beside a library's, read when the library clears its own and
what it passes to the function you are allowed to replace. Pin the result on the real
config: a fake clock, a body that only ends by being aborted, and the assertion that the
read ends exactly when a silent host's does. When you buffer a body a library would have
streamed, keep its size limit.

## 2026-10-07: moving the body read under the timer is the whole fix, and an AbortError fake proves it

**Believed:** a hand-written `fetch` whose timer is cleared at the headers needs one line
moved, and a test fake whose body rejects with an `AbortError` when the request is aborted
shows the fix works.

**Measured:** vitest 5.0.3 on Node 24.13.0, ten sites fixed in one round.

- The fake decides what the test can see. Each fix was mutated to ask the error's name
  (`e.name === 'AbortError'`) where it asks the controller's signal. With a body that
  errors as an `AbortError`, 4 of 5 mutations passed every test. With a body that errors as
  a `SyntaxError`, which is what half a JSON body is to a parser, 5 of 5 failed.
- In three sites the `finally` that stopped the timer at the headers also removed the
  caller's abort listener. A caller that cancelled 1 s into the body read was ignored: the
  call was still pending after the 30 s watched.
- In two sites one timer was shared by a three-attempt retry loop and cleared at the first
  headers. After a 500 the second attempt had no timer: still pending after the 120 s
  watched. A request that was never answered ended after 33 s and 3 requests where 30 s and
  1 were meant, because the loop slept and retried twice on a signal already aborted.
- The scan for the shape had been run over `frontend/`. Run over the repo (1,125 files) it
  found a tenth site, in the Solana indexer, a process with nothing else to end the wait.
- The code under test loaded a mocked library with `await import()` on first use. On the
  fake clock the first test gave up before that load ended, and its call ran on into the
  next two tests, which reached the real class: 3 of 16 failed until the test file
  imported the library statically. Why the real class was reached was not established.

**Do:** make the fake body fail as a parse error, and mutation-check the fix by making it
ask the error's name. Before moving a body read under its timer, list what else the same
`finally` undoes and what else shares the timer, and test each. Run a shape scan over the
repo, not the folder the first hit was in. Import statically, in the test file, whatever
the code under test imports lazily.

## 2026-10-06: a lookup that derives one address answers about that address, not about "our pool"

**Believed:** the Solana swap page compared "our pool for this pair" with Jupiter, so a line
reading "no pool of ours" meant there was none.

**Measured:** read on chain on 2026-10-06, the venue's BAYLA and SOL pool
`ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4` sits at the standard address for fee tier 1
(settings account `CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy`, 1% a trade). The page
derived the tier 0 address only, found no account there, and reported no pool. Every pool a
person can open from `/pools` is on tier 1, so the lookup could not find any of them. Where
it did find one it priced it with tier 0's fee whatever tier the pool was on.

**Do:** a derived address that holds nothing proves "nothing at this address". Before a line
says "none", list every place a real one can be (each fee tier's standard address, and the
index of pools at their own addresses) and quote each with its own settings account.

## 2026-10-06: a pool can be the better route one way and the worse route the other

**Believed:** "our pool is more efficient than Jupiter" is a fact about the pool, so one
direction is enough to check a routing change.

**Measured:** on 2026-10-06 (mainnet reserves from a public RPC, Jupiter's quote API with no
site fee) selling 1,000, 10,000 and 100,000 BAYLA for SOL paid 5.83%, 5.67% and 4.09% more in
our pool than through Jupiter. Buying BAYLA with 0.01 to 1 SOL paid 5.5% to 8.8% more through
Jupiter. Same pool, same minute. A walk of the buy alone shows "Routed to Jupiter" before
and after the fix and looks like nothing changed.

**Do:** test and walk a routing change in both directions, and name the direction when
reporting which route won.

## 2026-10-06: the other route's quote is not what the other route would pay

**Believed:** holding our pool to Jupiter's quote holds it to what Jupiter would pay.

**Measured:** the quote on screen has the site fee taken off. On a route where that fee
cannot be taken (Jupiter's error 6014, as on BAYLA's route) the site sends Jupiter's
transaction with no fee, which pays the fee's worth more than the quote. A pool that beat the
quote by less than the fee would have taken a trade Jupiter was about to pay more for. An
independent review found it; no test did, because every test used the quote as the bar.

**Do:** compare against what the transaction that would really be sent pays. Where two
builds are possible, find out which one it is the way the send path does (build it and
test-run it) before deciding the route.

## 2026-10-06: a sentence that says the site cannot do something goes false the day it can

**Believed:** making the swap send trades to our pools was a change to the swap page.

**Measured:** a search of the copy for "Jupiter" found the pool disclosure ("Jupiter does
not send trades to our pools", with the swap on this site named as going through Jupiter),
the routing card on `/pools`, five unit tests and two local-validator specs that pinned those
sentences word for word. Left alone they stay green and the page tells a pool owner
something that is no longer true.

**Do:** when a change gives the site a new ability, search the copy and the tests for
sentences that deny it. A test that pins a denial passes on the stale sentence.

## 2026-10-06: "You cancelled in your wallet" in the local-validator suite can be the stand-in wallet refusing a shape it was never taught

**Believed:** a new kind of transaction that builds, test-runs and reviews correctly will be
signed by the suite's wallet, so "cancelled" means the app or the test pressed the wrong thing.

**Measured:** the first on-chain run of a swap in a pool at its own tier ended "You
cancelled in your wallet". The stand-in wallet (`e2e-solana/fixtures/walletGuard.ts`) decodes
every transaction on its own and refuses any shape it does not know; the page hears that
refusal as a person pressing Reject. It knew a swap in a launch pool only.

**Do:** a new transaction kind brings its rule in the wallet guard and harness tests (one
that signs, several that refuse) in the same change. On "cancelled", read the guard's reason
before the app.

## 2026-10-06: a press area made of padding carries the focus ring with it

**Believed:** a finger-sized press area built as padding that an equal negative margin takes
back (`py-3 -my-3`) is invisible. Nothing around the target moves, so nothing a person sees
changes.

**Measured:** the keyboard's focus ring is drawn round the border box, and the padding is
inside it. On a 21px line of text the ring was 53px tall (45px of area, plus a 2px offset and
a 2px stroke on each side) and its edges ran through the words of the lines above and below,
in all 16 states of one sentence at 320 to 768 wide (Chromium). Under one link the bottom edge
was hidden behind the button below it, so the ring was an open box. Every measurement the
builder had taken (boxes, line gaps, a hit test at the middle of each target) was right and
none of them could see it. A reviewer who pressed Tab found it.

The same build has a second cost that is not a bug but has to be said: plain words within
12px of a target act as that target. A press on the line under a link opened the link.

**Do:** when the press area is bigger than what is drawn, put the ring on the words (an
inner element; here one CSS rule that takes the outline off the target and draws it on a
child) and Tab through every target before calling it done. After: rings 20 to 27px tall,
crossing no other word, and the press map and every box unchanged.

## 2026-10-06: a wait loop whose condition was never seen true waits on a finished job

**Believed:** "the live stylesheet contains the new class" is a simple, direct test that a
deploy has landed.

**Measured:** the loop searched the stylesheet for an escaped class name (`min-w-\[96px\]`)
with a pattern full of backslashes. It matched nothing for 20 minutes and gave up. The deploy
had finished at minute 4: the commit's own status said `Vercel=success` from then on, and a
plainer search of the same file for the same rule (`96px`) matched once. Which layer changed
the backslashes on the way to `grep` was not found; the loop had only ever been run against
the old build, where "no match" was the right answer.

**Do:** before waiting on a condition, run it once against something where it is already
true (here: the local build of the same commit) and once where it is false. Wait on the
system's own answer first (`gh api repos/<repo>/commits/<sha>/status`) and use a marker in
the served files only to confirm it.

## 2026-10-06: which of two overlapping press areas wins can hang on a class name no test reads

**Believed:** a reviewer pressed every pixel row of every target in a real browser and every
press went to the right thing, so the layout was safe to ship.

**Measured:** it was right, and nothing held it there. Two targets on neighbouring lines had
press areas that covered each other's words, and three stacking layers decided each press.
With one class (`z-10`) taken off in the page, a press on the Copy button opened another
page. With another (`z-20`) taken off, a press on a link copied an address. Every unit test
and every browser test passed with either class removed: the browser tests never reach that
state, and jsdom lays nothing out.

**Do:** when behaviour hangs on stacking order and no browser test can reach the state, hold
the order itself in a unit test (the link's words above the button, the button above the
bare areas, all inside one isolated block) rather than the class names, and take each layer
away to see the test fail. Here: 7 ways to break it, 7 caught.

## 2026-10-06: a token's name in a wallet is an on-chain record, and when a program's own address is the mint authority only that program can write it

**Believed:** a nameless token row in Phantom can be fixed from outside the program that
minted it: by a script, the multisig, a token list, or Metaplex, whose public source lets its
own "seed authority" create the record for any mint that has none.

**Measured:** Phantom's docs (read 2026-10-04) take a classic SPL mint's name, symbol and
picture from its Metaplex record, and a Token-2022 mint's from the metadata held on the mint;
with neither, the row reads "Unknown". The old Solana token list is archived. On mainnet, by
`simulateTransaction` with `sigVerify: false` (2026-10-04, slot 453,337,242), Metaplex's
create for our BAYLA/SOL pool-share mint succeeded with the mint authority marked as a signer
(38,478 units, a 607-byte record) and failed without it: custom error 9, "You must be the
mint authority and signer on this transaction". That authority is a program-derived address
of the pool program, so no wallet and no multisig can sign as it. The seed-authority route,
simulated the same way with `AqH29mZfQFgRpfwaPoTMWSKJ5kqauoc1FwVBRksZyQrt` as the signer, was
refused with error 10, "Mint authority provided does not match the authority on the mint"
(2026-10-06, slots 454,103,164 and 454,110,797). That address's 32 bytes are not in the
deployed 793,991-byte program, though it did sign the create for Raydium's v4 SOL-USDC
pool-share record on 2021-11-01.

**Do:** before planning a name for any mint, read its mint authority. An ordinary key means
one transaction. A program's own address means a new instruction in that program, shipped as
an upgrade: Meteora, Kamino and Jupiter each added one for their pool shares, and Raydium's
CPMM and PumpSwap leave theirs nameless. Test any exception found in Metaplex's source with a
mainnet simulation first: the deployed program has no upgrade authority and is not the repo.

## 2026-10-06: a Streamflow stake pool can name its own receipt token, and the key that signs is the pool's authority, not its creator

**Believed:** a nameless staking receipt needs Streamflow's help, the pool's creator key is
the one that would sign, and the metadata pointer already on the receipt mint is a naming
step somebody left half done.

**Measured (2026-10-04, mainnet, `simulateTransaction` with no signatures):** Streamflow's
stake program (`STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH`) has
`set_token_metadata_t22(name, symbol, uri)` for Token-2022 receipts and
`set_token_metadata_spl` for classic ones, in the npm IDL (`@streamflow/staking` 13.4.0) and
in the IDL published on chain. Signed and paid by the pool's current `authority`, it
succeeded on our pool (17,844 units, the mint grew from 234 to 379 bytes). Signed by the
pool's `creator`, which had handed the pool on in September, it was refused: "Unauthorized",
6005. With the authority signing and another wallet paying the fee it failed with "writable
privilege escalated": the IDL marks `authority` read-only, but the program moves rent from it
into the mint, so it must be the fee payer. Run on another project's already-named pool, the
call updated the name, so it is not one-shot. Of 1,176 stake pools, all 192 with a Token-2022
receipt carry the same self-pointing `metadataPointer`, and 6 of those carry a name. With the
real link, 35 characters longer than the placeholder, the rent moved was 233,840 lamports and
not 56,040 (dry run, 2026-10-06): every character costs 5,080.

**Do:** decode the pool and read `authority` (see the 2026-09-21 entry for the offset); never
take the creator for it. Make the authority the fee payer. Read a metadata pointer with no
`tokenMetadata` as the normal state of every Streamflow Token-2022 receipt. Simulate with the
final words, since the cost follows their length. Streamflow documents this only in its SDK
README and its `staking-cli`, whose default network is devnet (read, not run).

## 2026-10-06: making room in a Solana program needs no authority and at least 10,240 bytes, and an upgrade does not do it for you

**Believed:** a program upgraded through a multisig simply takes the new file. If the file is
bigger, making room is one more vault action (the go-live checklist in the release folder
said so) of whatever size is needed.

**Measured (2026-10-04, mainnet, solana-core 4.3.0):** our pool program's ProgramData account
was 691,685 bytes for a 691,640-byte file: the 45-byte header and no spare byte. By
`simulateTransaction` (`sigVerify: false`), `ExtendProgram` by 1 byte was refused,
"ExtendProgram requires a minimum of 10240 additional bytes or to extend to maximum size"
(feature `YbbRLkvenrocjGPGyoQE4wjnvYzTgfsk38NFmcYK7a5`, active since slot 432,864,000). By
10,240 bytes, paid by an ordinary wallet with no authority signing, it succeeded: 691,685 to
701,925 bytes for 52,019,200 lamports of rent, which never comes back. Read and not run: the
feature that would resize the account on upgrade
(`EhisBfVtGvEA8bVCVN5VMaYEaX6iTfoUrmcDi8LY7Kxy`) has no account on mainnet, and the loader
(agave `57707436`, `programs/bpf_loader/src/lib.rs`) refuses a second deploy-type change to
one program in the same slot. On 2026-10-06 one added instruction grew our build by 33,032
bytes, so the growth and not the minimum set the price: 167,802,560 lamports (worked out
from 5,080 a byte, not paid).

**Do:** before an upgrade to a larger file, read the ProgramData length, take away 45, and
set the new file's size against what is left; do not assume there is room. If it does not
fit, extend first, in its own transaction and an earlier slot, from any funded wallet:
`solana program extend <program> <bytes>`, at least 10,240 and at least the growth. Use the
4.1.1 CLI; the 2.3.0 one in WSL has an older code path (read, not run). Then upgrade. Because
anyone can extend, a "last deployed slot moved" alarm does not prove an upgrade (inferred from
the loader, not run). Extend then upgrade to a larger file has not been rehearsed here on any
cluster yet.

## 2026-10-06: Metaplex's public source and a local validator each give a wrong price for a metadata record

**Believed:** what a Metaplex record costs can be worked out from the program's repo, or read
off a local validator that cloned mainnet's feature set and Metaplex itself.

**Measured:** the source (`mpl-token-metadata` at `353d01be`, `state/fee.rs`) works the create
fee out from rent: rent for 1,308 bytes plus 5,440 lamports, 7,300,320 at the rent read on
2026-10-04. The deployed program charged a flat 10,000,000. A mainnet simulation that day left
a new 607-byte record holding 13,733,800 lamports (3,733,800 rent plus 10,000,000), and a
record somebody else created on mainnet at 18:44Z held the same. On a `solana-test-validator`
3.1.11 started with `--clone-feature-set` and Metaplex cloned from mainnet (2026-10-06), the
same record held 15,115,600: the same flat fee, but rent for 607 bytes was 5,115,600 there
against 3,733,800 on mainnet. Mainnet rent that week was 5,080 lamports a byte over the
account's size plus 128, so an 82-byte mint is 1,066,800 and not the 1,461,600 older notes
carry. Also seen locally: lamports a stranger sends to the record's address first neither
block the create nor make it cheaper.

**Do:** take every lamport figure that will be quoted, budgeted or asserted for mainnet from
a mainnet `simulateTransaction` (read the account after) or from
`getMinimumBalanceForRentExemption` asked of mainnet that day. A local run proves the logic,
not the price. Where a deployed program and its repo disagree, the deployed one is the fact.

## 2026-10-06: a name and a picture do not bring a pool share a dollar value or a verified mark in Phantom

**Believed:** once a pool-share or staking-receipt token has proper metadata, Phantom shows
what it is worth, and "verified" is something a project applies to Phantom for.

**Measured (2026-10-04):** Phantom's docs say it prices a token that is verified on
CoinGecko and falls back to Birdeye, and that it does not run verification itself: the mark
comes from outside sources, of which it names CoinGecko and Jupiter. CoinGecko lists only
what trades on an exchange it tracks. CoinGecko's price API and Jupiter's
(`lite-api.jup.ag/price/v3`) returned no price for any sampled pool share of Raydium (CPMM
and v4, pools of about $5M and $30M), Meteora, Kamino or PumpSwap, named or nameless, and
Jupiter tags each of them `unknown`. Both priced JLP and JitoSOL, which trade. Birdeye was
not read (403, and its API wants a key). Phantom's own token service, `api.phantom.app`,
answered 403 to a plain request for all 23 mints tried, so what Phantom itself says about a
given mint was not read.

**Do:** for a token that cannot trade, promise a name, a symbol and a picture, and never a
value or a mark. Show the value on our own pages; Jupiter's docs point a protocol that wants
its positions priced to their portfolio team. Do not get past Phantom's 403 by imitating its
client: use Phantom's published docs, or look in a real wallet.

## 2026-10-06: a file that wallets and other sites fetch from this Vercel site can be wrong three ways while answering 200

**Believed:** put the JSON and the picture under `frontend/public/`, see the link answer 200,
and a wallet can read it.

**Measured on https://memetics.finance (curl, 2026-10-04; read again 2026-10-07 about 05:00Z):**

- Every static answer carries `Cross-Origin-Resource-Policy: same-site`, set site-wide in
  `frontend/vercel.json`. Only `/record/` answers `cross-origin`, from a later and narrower
  rule. MDN: a browser blocks a cross-site `<img>` of a `same-site` resource, and a server
  that fetches the file ignores the header. Which wallets show a picture straight from our
  address, and which through their own proxy, was not found out.
- A path with no file answers 200 `text/html`, the app page. Inside `/tokens/`, a folder with
  a week-long cache rule, `/tokens/DoesNotExist111.png` came back as that page with
  `Cache-Control: public, max-age=604800` and `X-Vercel-Cache: HIT`. `/mint/default.json`,
  built on a branch but not deployed, answered the same page.
- Paths are case-sensitive: `/tokens/USDC.png` is the app page and `/tokens/usdc.png` is the
  PNG. Mint addresses are mixed-case and this machine's disk ignores case, so an `existsSync`
  check passes here on a name that is one letter's case off. A pin test built on a directory
  listing went red when one file was renamed from B to b.

**Do:** give such a folder its own rules in `vercel.json`: a cache rule,
`Cross-Origin-Resource-Policy: cross-origin`, and a rewrite above the app fallback so a
missing file answers JSON and never the app page. Pin the files by exact name from
`readdirSync`, check a picture's first bytes, and probe production for words only the real
file holds. Put a hash of a picture's bytes in its path and keep every picture that was ever
deployed. Deploy and see the files answer before any link to them is written on chain. Only a
deployment can show three things, and none had happened when this was written: that a rewrite
to a static default file works here, that the narrower header rules win, and that
`Access-Control-Allow-Origin` arrives once and not twice.

## 2026-10-06: a script that refuses a public cluster still writes to another session's local validator

**Believed:** the start script refuses a busy port and the proof script refuses a public
genesis hash, so a proof run can only ever send to the validator it has just started.

**Measured (2026-10-06):** two other sessions had validators up in WSL, on RPC ports 28899
and 38899. A second validator of ours was given 28899. Its start script refused the busy
port, the command line carried on regardless, and the proof ran against the other session's
chain. Before it stopped on a missing account it had airdropped SOL to three new wallets,
created three test mints and opened one pool there, paying that chain's 0.15 SOL create fee
into a fee account that a test of theirs was reading at the time. The public-genesis guard
passed, and rightly: the chain was private, only not ours.

**Do:** make "is this MY validator" a check inside the script, before its first send, and not
a property of the command line. The fix here: the script reads accounts that only its own
chain holds and stops if they are missing, and the wrapper runs it only when our own start
printed READY; run again at the wrong port, it sent nothing. Stricter, and not what was run:
`start-validator.sh` prints `READY genesis=<hash>` and two validators here had different
hashes (2026-10-03 entry), so hand that hash to the script and compare it with
`getGenesisHash`. Join the commands so that a refused start ends the run. Look before taking
a port: validators here sat on 18899, 28899 and 38899. Never stop one you did not start.

## 2026-10-06: Jupiter's free verification lane now signs in with X, and a dead picture link stops its form

**Believed:** the free lane on verified.jup.ag works as our September pack described it:
connect a wallet, fill in the form, and a metadata change is a separate request for 1,000 JUP.

**Measured (2026-10-07, 01:15 to 02:02 UTC; a headless walk with no sign-in and nothing typed,
and the form's own script):** the free lane's button reads "Sign in with X to Continue" (seen
on screen), the last button stays disabled until that sign-in (script), and the X handle is
kept in Jupiter's public list as the sender. The free lane now has a Metadata step (seen in
the step bar) and its last screen says "No payment required." (script), while Jupiter's docs
still price a metadata update at 1,000 JUP. That step shows the Logo URL as a plain image tag
and disables Continue when the image fails to load (script). BAYLA's on-chain picture link is
an ipfs.io address: in a real browser it failed as an image, and the same file on Pinata
loaded at 320 by 320. Eight of Jupiter's doc pages were byte for byte what they were on
2026-10-04, so the docs announced none of this. Not done: no request was sent, so whether a
free metadata update is approved is unknown, and the Metadata and Review screens were read
from the script and never seen.

**Do:** walk the live form again before handing an owner a pack, however recent the last one:
the docs can stand still while the form moves. Settle whose X account applies first, because
it becomes public. Test the token's picture link as an image in a browser, and have a working
address ready to paste.

## 2026-10-06: a retry rule that looks for "429" anywhere in an RPC error finds it in a compute-unit count

**Believed:** testing `/429|rate.?limit|too many/` against a node's whole error is a safe way
to tell "rate limited, ask again" from "refused".

**Measured (2026-10-06, the receipt-naming script run against a made-up node):** a failed
simulation or send carries the program's logs, and logs carry numbers. A real refusal
(Unauthorized, 6005) whose log read "consumed 17429 of 200000 compute units" matched the
pattern, so the script sent the transaction a second time and then told the operator to go
and look for one the node had refused. The real dry runs that week used 17,844 and 17,993
units, so such a figure is an everyday one. The same script's send went through a helper with
two tries: when the node took the transaction and its answer was lost, the second try came
back "already processed", which the script printed as NOT SENT.

**Do:** sort an RPC error by `error.code` and `error.message` only, never by its logs or its
whole JSON, and anchor the digits (`\b429\b`). Send once. An answer to a send that was lost,
or that says "already processed", is followed by a lookup of the signature: it is not a
refusal, and it is not a reason to send again.

## 2026-10-06: an override that forces the patched major is a safe way to clear a transitive advisory

**Believed:** when the fix for an advisory in a transitive package is a newer major, an
`overrides` entry that forces it is a lockfile-level change. It installs, so it works.

**Measured:** GHSA-7mx3-vvmw-hjmv is fixed in `@graphql-tools/utils` 12.0.1. The indexer has
10.x and 11.x under `graphql-yoga` 5.21.0 and `@graphql-tools/executor` 1.5.2. A scratch
install with utils forced to 12.0.3 installed cleanly and answered a plain query. Then every
query with `@include` or `@skip` on a variable came back as an error: 4 wrong answers out of 7
probe queries, and all 7 right without the override. utils 12.0.0 had changed what
`collectFields` takes, and executor 1.x still passes the old shape. `npm audit` was no guide:
npm 11.6.2 called the fix "available", npm 11.21.0 called it semver-major, and the fix it
named was `ponder` 0.0.1.

**Do:** before forcing a major with an override, read the BREAKING notes of each major
crossed, find which installed package calls what changed, and run that package's real path
against the forced version. For a server that means queries with variables, not one plain
query. A clean install and one answered query prove nothing.

## 2026-10-06: two npm 11 releases write the same lockfile

**Believed:** a one-package lockfile bump comes out the same from any npm 11, so the npm
that happens to be installed is fine.

**Measured:** `npm update source-map-js --package-lock-only`, on the same two lockfiles, with
two npm versions.

- npm 11.6.2 on `frontend/package-lock.json` also deleted the `libc` field from six
  `@rolldown/binding-linux-*` entries it had no reason to touch. A newer npm had written them.
- npm 11.21.0 on the same file kept those six.
- npm 11.21.0 on `indexer/package-lock.json`, which 11.6.2 had written, also deleted
  `"peer": true` from eleven entries. npm 11.6.2 there gave a three-line diff.

The default `git diff` shows none of this. `.gitattributes` marks lockfiles binary, so it
prints one "Bin" line.

**Do:** after any lockfile edit, read `git diff --text -U0 -- <lockfile>` and look at every
line that is not a `version`, `resolved` or `integrity` of a package you meant to move. If
untouched entries changed, run the same edit with the other npm (`npx -y npm@<version> ...`)
and keep the one that leaves them alone. Say in the commit which npm wrote each file.

## 2026-10-06: an id on the advisory gate's "prune them" line is dead

**Believed:** when the npm advisory gate prints "Suppressions no longer matching any advisory
(prune them)", every id on that line can be deleted from
`.github/npm-advisory-allowlist.json`.

**Measured:** the gate runs once per project (`.`, `frontend`, `indexer`) and each run prints
its own line. A `baseline` id belongs to one project, so its line was right. An `accepted`
entry belonged to no project: it applied to all three, and each run called it dead when that
project's audit did not contain it. On 2026-10-06 the root run and the `frontend` run both
said to prune GHSA-vfj7-8cjw-p6xm (braces) while the `indexer` run was using it. Deleting it
would have turned the indexer red.

**Fixed 2026-10-07:** an accepted entry now names its `projects`. It counts in those projects
only, and a run reports it stale only for a project it names. An entry with no `projects`
counts nowhere. The line now says which project it is about.

**Do:** when one check runs once per project over a shared list, a "nothing uses this" line
from one run is a claim about that project and no other. Give each entry the projects it
belongs to, or collect every run before deleting anything.

## 2026-10-06: a fake-clock test that runs ten periods in one jump proves a timer never fires

**Believed:** `await act(async () => { await vi.advanceTimersByTimeAsync(10 * PERIOD) })`
straight after `renderHook`, then "the read was called once", shows that a retry timer did
not fire in ten periods.

**Measured:** React 19.3.0, vitest 5.0.3, `@testing-library/react` 16.3.3, the gate hook's
retry (`useWriteGate.ts`). The hook's first answer is a promise. The state it sets, and the
effect that arms the timer, are drawn only when that `act` call ends, and by then the fake
clock has already moved the whole jump. So the timer is armed after the wait, and nothing
could have fired inside it. With the rule broken on purpose (every closed gate counted as
unread, so every one should have been read again), all five "never asked again" cases
stayed green at one read each. A removed `clearTimeout` stayed green for the same reason:
the timer armed by the first answer and the one armed after a pressed Refresh were both
armed at the same clock time, so they fired together as one read. After the tests were
changed to land the first answer in its own zero-length `act`, then move one period per
`act`, the first break failed seven tests where it had failed one, and the second failed
one where it had failed none.

**Do:** under a fake clock, give the first answer its own `act` with a zero-length wait,
then advance one period per `act`. A "never fires" check is only worth keeping once
breaking the rule it guards has turned it red.

## 2026-10-06: a vitest worker that runs out of memory leaves a summary with passes and no failure line

**Believed:** a test file with a broken test shows a failed test in the summary, so a
filter on the failure marks and the totals is enough to read a run.

**Measured:** vitest 5.0.3. A new test passed `load: async () => api` inside `renderHook`'s
callback. That makes a new function on every render, the hook's effect depends on it, and
each run of the effect sets state: an endless render loop. The worker died with
`FATAL ERROR: ... JavaScript heap out of memory` and `Worker exited unexpectedly with exit
code 134`. The summary read `Test Files  (1)` and `Tests  7 passed (30)`: no failed file,
no failed test, and 23 tests never ran. Run with two other files, the totals of all three
were mixed together, and the crash showed only as an error line a filter can drop.

**Do:** read the totals as a sum: passed plus failed plus skipped must equal the number in
brackets, and the file count must name a result. When they do not, the run did not
complete, which is not a pass and not a fail. In a hook test, make every function the hook
depends on once, outside the render callback.

## 2026-10-04: a test that asks the app's own planner what a row should read agrees with the app whatever it does

**Believed:** the end-to-end check of the "Locked in the pool forever" row was independent of
the app: the spec worked out the expected figure and compared it with the screen.

**Measured:** the spec imported the app's own `planCreate` to get that figure. When the
formula changed (from `floor(100 x put / supply)` to what really stays behind, rounded up), the
spec and the page changed together and the test stayed green without anyone deciding the new
figure was right. A second check, done by hand, went through an "about" row printed to four
decimals, where a one-unit change cannot show. Only a test with whole-unit amounts (2 tokens
of a token with no decimals: 1 stays behind, the old figure said 0) could tell the two apart.

**Do:** where a test pins a money figure, work the figure out in the test from the rule in
words, not by calling the code under test. Pin it on a row printed to the last digit, or with
amounts where one unit is visible. A helper imported from `src/` into a spec is the app
checking itself.

## 2026-10-04: a "sent" card is drawn before the first byte leaves

**Believed:** once the page shows "sent", a reload tests "a reload while the transaction is
in the air".

**Measured:** the page writes its note and draws the card BEFORE the first broadcast, on
purpose (the note must exist before the first send). In a whole run of the local-validator
suite a reload came 87 ms after the broadcast began: the browser stopped the request, the
transaction never reached the chain, and the test that then asked the chain for it failed.
It had passed for weeks because the reload was usually slower than the request.

**Do:** in a test, "in the air" is "the network answered the broadcast with this signature
and the transaction is not yet confirmed". Wait for the response to the `sendTransaction`
request (ask for it before pressing Sign), not for a card on the page.

## 2026-10-04: when a verdict gains a middle state, every reader of the old top state was reading two things

**Believed:** turning four refusals into warnings (pull request 742: a token with no market
price, a price more than 3% off, a freezable token, a copied name) was a change to the check,
the builders and the forms that show the warnings. Each of those was built, tested and
reviewed on its own, and each review passed.

**Measured:** `allowed` had been standing in for "nothing to say" in places nobody listed. A
whole-change review of the merged branch, five readers and then a second reader told to refute
each finding, confirmed twelve and refuted none. The pattern in most of them: a consumer that
took "the biggest allowed pool" or "the first pool that offers" now picked a pool the page
itself warned about, and three sentences still said "passes the checks" of a pool whose own
card was headed "with warnings". One consumer had been fixed for exactly this an hour earlier;
its sibling, forty lines of another file away, was found by three reviewers independently.

**Do:** when a verdict gains a state between yes and no, grep every reader of the old yes and
decide for each one which question it was asking: "may this go ahead" or "is there nothing to
warn of". They were the same question until the change. Review the pieces, then review the
whole: the defects were all between the pieces.

## 2026-10-04: an entry rule is only checked when the exit's own sum is run on what it lets in

**Believed:** an opening that passes the pool program's minimum, and this site's stricter one
(the locked 100 shares at most 0.1% of the pool), can always be taken out again.

**Measured:** 1 token of a token with no decimals against 10 SOL gives `isqrt(1e10 x 1)` =
100,000 shares: exactly 0.1%, so both rules pass and the real builder built it. The opener's
99,900 shares then pay `floor(99,900 x 1 / 100,000)` = 0 tokens, and the pool program refuses a
withdrawal that pays 0 on a side: at 100%, at 50% and at 0.01%. The share could never leave.
With 2 tokens it leaves. The same floor was in the "locked forever" figure,
`floor(100 x put / supply)`, which said "0 tokens" while one whole token stayed behind.

**Do:** for any rule that lets money in, take what it lets through and run the EXIT's own
arithmetic on it, rounding the way the program rounds, before calling the rule safe. A figure
that tells someone what they can never get back is rounded up, not down. Whole-unit tokens
(0 decimals) are the case that finds these: one base unit is the whole thing.

## 2026-10-04: a mutation no test catches is sometimes a line that does nothing

**Believed:** when breaking a line leaves the suite green, a test is missing.

**Measured:** twice in one change it was the line. A guard that stopped a late lookup answer
from scrolling the page off an open form survived its mutation because the page scrolls when
the lookup STARTS, not when it lands: the guard could never fire. And one half of a two-part
condition on a button could never be true while the thing it guarded was on screen. Both were
written with a reason in a comment, and both were deleted. Of 18 mutations in that round, 16
were caught and these 2 were dead code.

**Do:** when a mutation survives, first ask whether the line can ever change an outcome, and
find the moment it would. Write the test only if that moment exists. Otherwise delete the line
and its comment: a guard that cannot fire reads as protection that is not there.

## 2026-10-04: a rule over a list passes with one item whatever it does

**Believed:** "the fallback opens the first warned pool" and "a rejected token extension is
refused" were pinned: each had a test, and each test failed when the rule was removed.

**Measured:** changing "first" to "last" left 669 tests green, because the only fallback test
had one pool. Making each guard look at the FIRST extension only left 453 tests green in five
places, because every test minted a token with one extension: a transfer hook behind a name
and a picture would have been let in and then let out by three builders that all agreed.

**Do:** a test of a rule over a list needs at least two items, with the one that matters not
in the first place, and where order matters, first and last being different items.

## 2026-10-04: a box that is the same on two frames has come to rest

**Believed:** two things. That `locator.boundingBox()` followed by a `page.evaluate` using
that box asks one question. And that an element whose box is unchanged across two animation
frames (Playwright's own test for "stable") has settled.

**Measured:** `e2e/modal-close.spec.ts` on an `npm run build` bundle under `vite preview`,
chromium, one worker, 12 repeats: 3, 5 and 10 of 12 failed, the X "covered" by the dialog's
own content wrapper. Sampled every frame from the moment the dialog mounts, the X is never
covered. The dialog mounts in its entrance pose (`matrix(0.95, 0, 0, 0.95, 0, 10)`, X at
950.7,149.7 and 41.8px wide), holds that pose unchanged for 3 or 4 frames (about 100 ms),
then snaps to rest (`transform: none`, X at 967.0,123.4 and 44px). That is with reduced
motion on, which the suite sets: the transform is not animated, but it still lands late. The
centre of the entrance box is 3.2px below the X at rest. Ten runs with a 400 ms pause
between the spec's two reads: the 6 that read the entrance box hit the wrapper, the 4 that
read the rest box hit the X. So a pass meant both reads fell on one side of the snap, on
either side, and a fail meant the snap fell between them. In all four sampled runs a wait for
two unchanged frames alone would have stopped in the entrance pose.

**Do:** read a box and use it inside ONE `page.evaluate`: `getBoundingClientRect` and
`elementFromPoint` in the same task cannot have a frame between them. To measure at rest,
wait first for a sign that the entrance is over (here the dialog's computed `transform` is
`none`) and then for an unchanged box. With both: 60 of 60 on chromium, 18 of 18 on the other
three projects, and still red when the wrapper is given the X's z-index.

## 2026-10-04: a page too wide for its window can be scrolled sideways in every test browser

**Believed:** `scrollWidth <= innerWidth`, or `scrollTo(500, 0)` and then reading `scrollX`,
shows a page that is too wide in any Playwright project.

**Measured:** /nft-finance on trunk bcafb7b3, production build, Chromium, viewport set to
820px. The section tabs made the document 1,119px wide. Desktop project: `innerWidth` 820,
`scrollWidth` 1119, and `scrollTo(500, 0)` left `scrollX` at 299. Pixel 5 project
(`isMobile`): `innerWidth` 1119, `scrollWidth` 1119, and `scrollX` stayed 0. A phone browser
widens its layout viewport to fit the page, so the page has nothing left to scroll and both
checks pass on the broken page. `documentElement.clientWidth` read 820 in both. `hasTouch`
alone does not do it (`innerWidth` 820, `scrollX` 299): `isMobile` does. WebKit's two phone
projects were not measured: WebKit would not launch (next entry).

**Do:** compare `scrollWidth` with `documentElement.clientWidth`, or with the width the test
set. A check written the `scrollX` way cannot fail for this reason in a phone project, so a
green there says nothing about a page that is too wide.

## 2026-10-04: WebKit that dies at launch is the machine being busy

**Believed:** `browserType.launch: Target page, context or browser has been closed` on the
WebKit projects means load. Run WebKit alone with `--workers=1` and it passes.

**Measured:** alone, with one worker, all 12 WebKit tests failed in 1 to 3 ms each, and a bare
`webkit.launch()` failed three times in a row. `Playwright.exe --version` exited
`0xC0E90002`, which the launch log prints as `exitCode=3236495362`. The Code Integrity log
(`Get-WinEvent -LogName Microsoft-Windows-CodeIntegrity/Operational`, event 3077) named the
cause: Windows Smart App Control refused the unsigned `libEGL.dll` inside
`ms-playwright\webkit-2336`. The same log holds one such block on 10-02 and none during the
WebKit runs other sessions made earlier on 10-03, so the block comes and goes. Chromium ran
throughout.

**Do:** when WebKit fails in milliseconds, read the exit code in the launch log before
retrying. `3236495362` is this block, and waiting for the machine to go quiet does nothing.
Leave Smart App Control on. Say WebKit did not run, and let CI's `iphone-safari` and
`ipad-safari` projects be the WebKit check.

## 2026-10-04: a local validator answers for every transaction that landed on it

**Believed:** `solana-test-validator` keeps its whole history while it runs, so
`getSignatureStatuses` with `searchTransactionHistory` always finds a transaction that
landed on it. A "reload while unconfirmed" spec that is red in a full run and green alone
is therefore the machine being busy.

**Measured:** its `--help` gives `--limit-ledger-size` a default of 10,000 shreds. Two
validators (3.1.11) were started side by side from `start-validator.sh`, one with that
default and one with 50,000,000. Each was sent 14 airdrops between slots 1166 and 1465
and asked about them every 5 seconds.

- Default: `getFirstAvailableBlock` read 0, then 1057, 1625, 2161 and 2658. About every
  550 slots, four minutes at the 0.47 seconds a slot it ran at, it dropped all but its
  newest 30 or so slots. `getTransaction` answered null for all 14 from the next drop, 192
  to 491 slots after they landed. `getSignatureStatuses` with history answered null for
  all 14 at 330 to 491 slots: the recent-status cache covered the younger ones to about
  340.
- 50,000,000: the first available block was still 0 at slot 2369, and all 14 still
  answered, the oldest 1,203 slots old.

The page reads two empty history reads past the blockhash window as "expired". `lp-create`
P2, with a five-minute pause put in before its last Check again, failed on the default
validator (`data-advice` was "exists", not "opened-here", after 632 slots) and passed on
the other (609 slots). A fresh validator drops nothing before slot 1057, about eight
minutes in: a first probe that stopped at slot 998 found nothing wrong on either one, and
a spec file run alone on a fresh validator passes.

The price: the ledger was 3.7 GB after 24 minutes at 50,000,000, against 2.2 GB at the
default, and still growing at about 10 GB an hour. Not measured: where it stops growing.

**Do:** when a test asks a local validator about a transaction it sent earlier, start
the validator with `--limit-ledger-size` far above the run, and stop it afterwards. Before
reading "expired" or "did not land" in a long run as load, ask `getFirstAvailableBlock`:
anything but 0 means the chain forgot. A probe for this has to run past the first drop,
1,100 slots or more.

## 2026-10-04: a script that sets `scrollLeft` puts the strip where it set it

**Believed:** scroll snap shapes where a finger's flick comes to rest. A script that sets
`scrollLeft` to show the selected tab is obeyed.

**Measured:** production build, Chromium, the NFT Finance tab strip with `snap-x
snap-mandatory` and `snap-start` tabs. The browser snaps a scripted scroll too, to the tab
start nearest the value asked for. At 820px the strip rests at 4 with the fourth tab ending
flush at its edge. Pressing that tab asked for 28, to leave 24px of room and bring the next
tab within reach; the strip went back to 4 (the next tab start is 196), and the last tab
stayed cut 315px. The same code's landings passed at 390 and 820, and a press at 390 asked
for 138 and got 166, a tab start that happened to leave the tab whole. A test of landings
alone is green with the snap on.

**Do:** on a strip that code scrolls to a computed offset, drop mandatory snap, or compute
the offset as one of its snap points. Test it by walking: press, check, press the next.

## 2026-10-04: a test that clicks a tab shows what a visitor's press does

**Believed:** `locator.click()` on a tab cut by its scrolling strip tests the press.

**Measured:** Playwright scrolls its target into view before it clicks. On the pre-fix
build, where a real press on a cut tab selects it and leaves it cut 110px,
`tabs.last().click()` took the strip's `scrollLeft` from 4 to 562 by itself and the tab was
whole. A bare `page.mouse.click(x, y)` inside the part of the tab that shows left the strip
at 4. Two more things the bare press needs: `elementFromPoint(x, y)` read in the same
`evaluate` as the point, to prove the press lands on the tab; and the strip brought back to
the middle of the window before every press. Centred once at the start, the second press
no longer hit a tab (the hit came back null: each press swaps in a section of another
height). Centred before every press, all of them landed, in four browser projects.

**Do:** to test what a press does to a scroll position, press by coordinates. A locator
click proves only that the control works once something has scrolled it into view.

## 2026-10-04: `overflow-x: hidden` on `body` makes `scrollWidth` lie, so push the page and read `scrollX`

**Believed:** two e2e helpers said it in their comments: `body` is `overflow-x: hidden`, so
`scrollWidth` and `clientWidth` can disagree on a page that does not move, and the honest
check is to push the page (`scrollTo(500, 0)`) and read `scrollX`. A second belief rode
with it: every phone project (`isMobile`) hides a page that is too wide from that push.

**Measured:** production build of trunk bcafb7b3, all 68 auditable routes, the width set by
the test. On `chromium` and `mobile-chrome` at 390, 768, 820 and 1024px, and on
`ipad-safari` at 390, 820 and 1024px, `documentElement.scrollWidth` equalled
`documentElement.clientWidth` on every page that did not move, and `clientWidth` equalled
the width set on every reading. On desktop Chromium `scrollX` after the push equalled
`scrollWidth - clientWidth` on 269 of 269 readings: the push measures nothing the two
widths do not. One page was too wide, /nft-finance at 820px. With `body` at
`overflow-x: hidden` its `scrollWidth` read the full 1,119px, and the push moved it 299px
on `chromium`, `iphone-safari` and `ipad-safari`. On `mobile-chrome` the push moved it 0
and `innerWidth` read 1119. So the rule on `body` changed neither width and did not stop
the page moving, and only Chromium's phone emulation widened the window: WebKit's two phone
projects did not.

**Do:** compare `documentElement.scrollWidth` with `documentElement.clientWidth`. Before
trusting a width check in a project, see it fail there: append a 1,100px `<div>` to `body`
in an 820px window and require a reading 280px over. With `scrollX` as the ruler, or with
`innerWidth` as the window, that test passed on three projects and failed on
`mobile-chrome`.

## 2026-10-04: a new card that passes on a phone means the change passes on a phone

**Believed:** the burn tracker was checked on phones: every new card at 320, 393, 810 and
1280px, measured and looked at. So the change was phone-safe.

**Measured:** the same change also made one EXISTING value longer. TOWELI's older "Burned
forever" row went from "25.8% of supply" to "25.76% of everything minted", inside a span
with `truncate`, 2,700px down a page nobody re-opened. Live, an independent phone walk found
"25.76% of everythi…" at 360px: the text needs 219px and the box is 134 to 214px on every
phone width. The percent was intact, so no test on the figure could see it. The same box had
been cutting "1,000,000,000 TOWELI" to "1,000,000,0…" all along.

**Do:** when a change alters the TEXT of a component it did not create, open that component
at 320 and 393 as well. A truncating box is a length limit nobody wrote down: grep the
component for `truncate` and `whitespace-nowrap` before making its text longer.

## 2026-10-04: pressing Refresh always does something

**Believed:** a Refresh button wired to a query's `refetch()` either shows a new figure or
shows the failure.

**Measured:** on the live site, with the device offline, Refresh on an Ethereum or Base card
did nothing for the 30 s watched: no request, the button never said "Reading", the old figure
stayed up. TanStack Query's default `networkMode: 'online'` PAUSES a query while
`navigator.onLine` is false, so `refetch()` returns without running the read and without
changing any state. The Solana card beside it, a plain `fetch`, printed its outage line at
once. A browser test that only refuses requests cannot see this: the read has to be asked
for while the browser reports itself offline (`context.setOffline(true)`).

**Do:** for a read whose failure must be shown, set `networkMode: 'always'` so it runs and
fails. Test it offline, not only with refused requests.

## 2026-10-04: a read either lands or fails

**Believed:** every way a read can go wrong ends in the card's "could not be read" line.

**Measured:** a request that is held open and never answered is neither. With the Solana
proxy call held, the card said "Reading…" with Refresh disabled for the whole 300 s watched,
and showed the real figure 0.6 s after the request was let through. The Ethereum and Base
card under the same hang gave up by itself after about 81 s, because viem's transport has a
10 s timeout per endpoint; the hand-rolled `fetch` had none.

**Do:** give every hand-rolled `fetch` a timeout that ends in the same unread state as a
failure (an `AbortController` and a timer, cleared on answer and on unmount). Test it with a
fetch that only ever ends by being aborted, under fake timers.

## 2026-10-03: no Ethereum connect can ask a wallet for Solana, and a note saying so stops no one

**Believed:** a wallet that holds both networks (Trust, MetaMask, Phantom), picked in the header's
connect list, can be offered Solana as well; and where it cannot, a sentence on the page saying
"the top Connect does not connect Solana" is enough.

**Measured:** the owner picked Trust from the header on a Solana pool and Trust's approval sheet
listed Ethereum, Robinhood Chain and Base: exactly wagmi's chains `[1, 4663, 8453]`. The proposal is
`eip155` only by construction, not by configuration: `@wagmi/connectors` 8.2.0
`walletConnect.js:8` has `const NAMESPACE = 'eip155'`, `@walletconnect/ethereum-provider` 2.25.0
has `namespace = "eip155"` as a class field, and wagmi's `WalletConnectParameters` type removes
`chains`, `methods` and `events` from what a caller may pass. The note had been live for two days
(PR #681). The Solana connect button it pointed at sat 786px down on a 915px-tall Android page,
1900px down on /pools and 2300px down on /curve-launch.

**Do:** do not look for an option that adds Solana to an Ethereum connect; there is none short of
replacing the connector. Make the button people already tap do the right thing for the page: on a
Solana page it opens that page's Solana list, and elsewhere it asks which network first
(`frontend/src/lib/solanaSurface.ts`, `components/layout/WalletSheet.tsx`). Jumper's "select an
ecosystem" step and Uniswap's one chip listing both wallets are the same answer.

---

## 2026-10-03: a child's first effect runs before `WalletProvider` is listening

**Believed:** a component under `@solana/wallet-adapter-react`'s `WalletProvider` may call
`connect()` from its own mount effect, the way a click handler does.

**Measured:** React runs a child's effects before its parent's, and `WalletProviderBase` attaches
`adapter.on('connect', …)` and starts autoConnect in ITS effects. A wallet that awaits a popup
emits `connect` later and nothing shows. A trusted Wallet Standard wallet with accounts already
present (Trust's in-app browser after a first approval; any test fake that emits with no await)
emits synchronously, before the listener exists. Result, with a fake that emits synchronously:
`connectCalls === 1`, provider `publicKey === null`, and every later connect returns early on
`wallet.adapter.connected`. Stuck until a reload. The same ordering makes the provider's first
visible state `connecting: false` even when a restore is about to start one effect later.

**Do:** never act on a queued or deferred connect in a mount effect under `WalletProvider`. Wait a
render (gate on something only a later render can see; `SolanaSurfaceBridge` gates on its own
report showing in an external store), and treat "not connecting" as unknown until then. A test fake
must emit `connect` with no await to expose this; one that awaits hides it.

---

## 2026-10-03: `requestAnimationFrame` is not "after the close" when the close was asked for from an effect

**Believed:** to hand over from one dialog to the next, close the first and open the second on the
next animation frame; by then the first has released the page.

**Measured:** `components/ui/Modal.tsx` locks `body` overflow in an effect and restores it in the
cleanup. The Solana wallet list reads the COMPUTED overflow in a layout effect as it opens and
writes that value back when it closes. A `setState` made inside a passive effect is rendered by a
later Scheduler task, and nothing orders that task before a frame. When the frame came first, the
list mounted in the same commit that closed the sheet, read `hidden` as the page's own state, and
put `hidden` back on close: no scroll until a reload, focus on `<body>`. On the built app, first
Solana connect from the home page: locked in 1 try of 10 at full CPU, 7 of 10 at 2x slowdown,
10 of 10 at 4x. A close made in a click handler is flushed synchronously, so only the
effect-driven path raced, and manual testing on a desktop never saw it. jsdom with `act()` hides
it, and the e2e suite runs with reduced motion, which nearly does.

**Do:** use no clock. Leave "what to open next" in a ref, close the first dialog, and open the
next from a `useEffect` keyed on the first dialog's `open`. In the commit that closes it React runs
every effect cleanup before any effect body, so the lock is released and focus handed back first.
Pin it with the real second dialog in a unit test (`document.body.style.overflow === ''` and focus
after it closes) and with `Emulation.setCPUThrottlingRate { rate: 4 }` over CDP in the e2e.

---

## 2026-10-03: `.then(ok, failed)` on a Vite `import()` never hears a failed stylesheet, and an in-place retry cannot work

**Believed:** `import('./Chunk').then(use, onFail)` reports every way that load can fail, and a
"tap to try again" that runs the import again will fetch it again.

**Measured:** Vite compiles `import()` into a preload helper that also loads the chunk's CSS, and
the helper is what rejects when a stylesheet fails. With `.then(ok, failed)` attached to the inner
import, aborting `SolanaProviders-*.css` left the row on "Loading…" past the e2e's 8 s allowance,
until the row's own 15 s limit; with `try { await import() } catch` the failure showed inside the
8 s (e2e, both forms run). A
browser does not refetch a failed chunk or stylesheet in the same tab, and after a deploy the old
file name is gone, so retrying in place can only fail again. The e2e first passed on the broken
form because the time limit eventually printed the same words.

**Do:** await a dynamic import inside `try`, make the retry a page reload and say so, and give a
"loading" state a limit. In the test, allow less time than the limit, or the limit passes it.

---

## 2026-10-03: `font-mono` is the device's own font, so Windows measures the narrowest case; simulate the widest with a width, not a font

**Believed:** a header chip that fits at 360px here fits at 360px; and the widest device font can
be simulated in Playwright by swapping the font family and adding a little letter-spacing.

**Measured:** `.font-mono` resolves to the system stack, not the self-hosted face. Nine characters
at 11.5px are 56.9px in Consolas (Windows), 62.1px in Liberation Mono (CI) and on Android, 64px in
SF Mono (iPhone). The 360px header row has 0px to spare, so the chip that fit on Windows overflowed
by 3px at the widest case, and by 1px at 800px. Then the simulation itself failed: with
`font-family: "Courier New", "Liberation Mono"; letter-spacing: 0.02em` the same code measured
over 0.615em per character in one CI run and 0.6001em in the next, three attempts running. Which
font a name resolves to on a runner, and whether a quarter-pixel of spacing survives glyph
rounding, is the runner's business.

**Do:** sweep a width-critical element at the widest case, and set that case as a WIDTH:
`span { display: block; flex: none; width: 5.58em }` for nine characters at 0.62em, checked with
`toBeCloseTo(0.62, 2)` before the sweep is trusted. Nothing had swept a connected header at all;
`e2e/topbar-solana-connect.spec.ts` does.

---

## 2026-10-03: the wallet adapter saves a wallet's name when its row is tapped, not when it connects

**Believed:** `localStorage.walletName` set means a Solana wallet was connected here, so it is the
thing to restore on.

**Measured:** `WalletProvider` writes `walletName` in `select()`, before any connect, and clears it
only on a connect error or a disconnect. On a phone the usual row is "Open app", which hands the
page to the wallet's app and returns normally: the name stays saved in a browser where that wallet
can never connect. A restore keyed on it downloaded `vendor-solana` (405 KB raw, about 105 KB
compressed) plus the provider chunk on every page load, for nothing.

**Do:** restore on a flag that only a real connection writes (set when an address is first
reported, cleared when that same connection reports none), and require the saved name as well.

---

## 2026-10-03: gitleaks reads `const KEY = '<a Solana address>'` as a credential, and scans every commit of the pull request

**Believed:** a made-up public address in a test cannot trip the secret scanner, and if it does,
renaming the variable in a new commit clears it.

**Measured:** `generic-api-key` needs a keyword (`key`, `token`, `secret`, `auth`, …) before the
assignment plus an entropy of about 3.5 or more; `const KEY = 'Bq6j…'` scored 4.74 and failed
"Scan for secrets" on PR #706. The action runs `git log -p <first commit>^..<head>`, so the line in
the first commit still fails after a later commit renames it. Rewriting the branch is not available
(a forced branch move is refused here). A `.gitleaksignore` line with the finding's fingerprint
(`<commit>:<file>:<rule>:<line>`) clears exactly that one line of that one commit, and the new root
file then failed `frontDoor.test.ts`, whose `ROOT_ALLOWLIST` names every entry tracked at the root.

**Do:** never name test data `key`, `token` or `secret`. If a finding is already pushed, add its
fingerprint to `.gitleaksignore`, rename the variable in the same commit, and do not widen
`.gitleaks.toml`'s allowlist for a value that is not a real public id on trunk.

---

## 2026-10-03: minted minus today's supply is what was burnt

**Believed:** for a fixed-supply ERC-20, everything ever minted minus `totalSupply()` is the
burn, so a burn figure needs one constant per token and one read.

**Measured:** QR, DRB and JBM on Base are ClankerTokens (IERC7802). Their verified source has
`crosschainBurn` and `crosschainMint`, callable only by the SuperchainTokenBridge predeploy
`0x4200000000000000000000000000000000000028`. At Base block 52136964 that proxy's EIP-1967
implementation slot reads zero, so the bridge is off today, and its admin slot reads
`0x4200000000000000000000000000000000000018`, the standard ProxyAdmin, so an ordinary upgrade
can switch it on. A bridge-out would then lower `totalSupply()` with nothing destroyed. The
same contract also has a public `burn()`, and the two cannot be told apart from the supply.
A first read of that proxy reported "no admin": the script held a mistyped slot constant, and
a slot nobody writes returns zero, which reads exactly like "no admin".

**Do:** before counting a fall in supply as a burn, read the token's source for every path
that lowers supply. Where a second one exists, count only the burn-address balance, show the
fall beside it as not counted, and do not print a "not burnt" figure. Paste the EIP-1967
slots from the standard (implementation `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`,
admin `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`): never retype one,
and treat a zero from a storage read as "nothing here OR the wrong slot".

## 2026-10-03: a pump.fun mint ends in "pump"

**Believed:** RIZZ (`5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k`) was not a pump.fun mint,
because its address has no "pump" suffix, so its minted supply could not be taken as
pump.fun's 1,000,000,000.

**Measured:** its create transaction
`4mKCtSuQtBgtFfpThuqgDxaVJzz7fhpkFTvbRj7xMYHysjPgNynzkYP5QU81Cs7b9hLuZBUATPbj3hazE8Vbs5Sc`
(slot 263919365, 2024-05-05) is pump.fun's `Create`: InitializeMint2 with pump's PDA as mint
authority, one MintTo of 1,000,000,000,000,000 base units, then the authority set to none.
Its bonding-curve account (seeds `bonding-curve` and the mint, under
`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) exists and is owned by pump, in the older
49-byte layout. The suffix came later. It proves nothing in the other direction either:
anyone can grind an address that ends in "pump". Finding the create transaction did not need
the mint's own history, which is too deep to page on a free RPC: the oldest signature of the
mint's Metaplex metadata account, or of its bonding-curve account, is the create transaction
and sits one or two pages down.

**Do:** prove pump.fun origin from the owner of the bonding-curve account or from the create
transaction, never from the address. To find a busy mint's first transaction, page an account
that only its creation and a few later events touch, not the mint.

## 2026-10-03: no element box past the card means every number fits

**Believed:** "no descendant's box runs past the card, and the page is no wider than the
window" proves a long figure fits on a phone. The first run printed zero overflow for twelve
bungalows at four widths, and its screenshots were filed as the proof.

**Measured:** two blind spots, both in that run. (1) The figure sat in a `min-w-0` cell
inside an `overflow-hidden` panel. A figure too wide for its row shrinks the cell and is
clipped, or its unit drops under it, and no element's box moves. Run with the figures set
to 26px on a 393px WebKit phone: the box check read 0 past the card and 0 page overflow,
and the page did not slide, while a check on the TEXT (a `Range` over the cell) reported 4
of the 5 rows, four with the unit on a second line and two with digits past the row. At
320px in Chromium the same: box check 0, text check 4 of 5. (2) Every screenshot from that run was
Vite's red error overlay. The page's market card fetches `/api/aggregator`; `vite` (dev) has
no such function, serves `api/aggregator.js` as a module, fails its import analysis and
paints the overlay over the whole page. The DOM under the overlay measured fine.

**Do:** measure a figure's fit on its text: `range.selectNodeContents(cell)`, then require
the rects to sit inside the row's padding box and to share one line. See the check fail
once at a size that cannot fit before trusting its zero. Take screenshots from
`vite preview` of a build, and open them: a measurement that passes says nothing about
what was painted.

## 2026-10-03: a helper that asks "the wallet" picks a network when the browser carries two

**Believed:** a "use my wallet" helper that tries the Ethereum provider and falls back to
Solana serves both kinds of visitor, and a Solana wallet's provider is at `window.solana`.

**Measured:** at 393px on a production build, with a stand-in for Trust Wallet's own
browser (`window.ethereum` and `window.trustwallet.solana`, each recording its calls), the
Heat reader's button sent `eth_accounts`, then `eth_requestAccounts`, and never called the
Solana provider. It did so on the home page, on the Solana launch door, and on trunk with
#714 merged after the top bar showed the connected Solana address. Once each network had
its own button, an Ethereum prompt approved after the Solana button was pressed replaced
the Solana address in the field.

**Do:** a fill or connect helper takes the network as an argument, and the caller names it:
the page's own network, or one button per network. Where the site already holds the
address (a connected wallet), use it and ask no provider. Two buttons are two answers that
can arrive in either order: drop an answer only when the field was written after its press
(typing, or another fill). "Latest press wins" was tried first and lost a prompt the
visitor approved after a second press on the same button had been refused. Read
`window.trustwallet.solana` wherever `window.solana` is read.

## 2026-10-03: a plain `vite build` is not the build the e2e suite runs against

**Believed:** `vite build --outDir <temp>` plus `vite preview --outDir <temp>` is the
production build, so any spec can run against it.

**Measured:** against such a folder `e2e/door-first-frame.spec.ts` failed 11 tests on
chromium ("/bayla: served the stock shell"). Against the `dist/` that `npm run build`
writes, the same eleven spec files listed 456 tests on chromium and mobile-chrome: 284
passed, 172 skipped by design, none failed. `npm run build` runs
`render-bungalow-doors.mjs` after `vite build`, and the door pages exist only after it.

**Do:** walk a flow on a plain `vite build`; run specs against `npm run build`. A local,
uncommitted config that spreads `playwright.config.ts` and overrides `webServer` (its own
port, `reuseExistingServer: false`), `use.baseURL` and `outputDir` keeps the run off
another session's preview on 4173.

## 2026-10-03: a `flex: 1 1 0; min-width: 0` field does not let a sibling wrap; it shrinks

**Believed:** `flex-wrap` on a form drops a third control to the next row on a phone.

**Measured:** at 393px the address field (`flex-1 min-w-0`), Read Heat and one wallet
button stayed on one row. The field's hint needs 158px and the field was left 99px on the
home page and 57px on the launch door. A line wraps on the items' starting sizes, and a
zero basis with no minimum starts at zero. With the wallet button in a `w-full sm:w-auto`
row of its own the field had 212px and 170px.

**Do:** give the control that must not squeeze the field its own full-width row below the
breakpoint, or give the field a real minimum. Pin it by measuring the hint's drawn width
(canvas `measureText` with the field's computed font) against the field's content width.

## 2026-10-03: a Solana blockhash lasts about 40 seconds on mainnet now, not a minute

**Believed:** a block takes about 0.4 seconds, so a blockhash (150 blocks) is good for
about a minute, and a 45-second clock on a review "stays well inside" it.

**Measured:** on mainnet (api.mainnet-beta.solana.com, apiVersion 4.3.0),
`getRecentPerformanceSamples` gave 219 to 228 slots a minute over five samples, and
`getBlockHeight` at 'confirmed' rose 114 in 30.6 seconds with the slot rising the same 114:
0.27 seconds a block, 150 blocks in about 40 seconds. Two `getLatestBlockhash` answers 46.7
seconds apart were 171 blocks apart, so the first was dead before the second was read: the
45-second clock ran out after the blockhash had died. A phone walk of Add liquidity (Pixel
5, a production build, mainnet reads, a wallet that refuses) took 3.0 seconds to prepare
and showed "too old" 42.4 seconds after the review appeared: the timer, not the chain.
Worked out from that rate and not pressed: the review's block-height check (25 blocks to
spare) refuses from 125 blocks, about 33 seconds after the blockhash is read.

**Do:** never turn blocks into seconds from a remembered block time; read
`getRecentPerformanceSamples` (numSlots over samplePeriodSecs) the day you size a clock, and
pin the clock to that number in a test. Let a block-height read decide, and treat any
wall-clock limit as the fallback for when the height cannot be read.

## 2026-10-03 — Phantom's "This dApp could be malicious" is a review note, not a blocklist, and no code change clears it

**Believed:** a red "Request blocked / This dApp could be malicious" in Phantom on a plain
Add liquidity deposit means the domain sits on a blocklist (as MetaMask's did on 09-25),
or that the transaction is doing something a wallet dislikes, so the code must change.

**Measured** (10-03, memetics.finance, the owner's own deposit
`4Jg1XVqkF1gr4h74FaPqeocqD5mGUtBibP8RHQTLBp1cYfpCJrc2mykXxkCM5zbcvS2JGy21zDD82vfiYn7fAUz9`):

| source | answer |
|---|---|
| Phantom's open blocklist (`github.com/phantom/blocklist`, 2321 lines) | no memetics entry |
| MetaMask/Blockaid `dapp-scanning.api.cx.metamask.io/v2/scan?url=memetics.finance` | `NONE` (was `BLOCK` on 09-25) |
| the warned transaction, read back | legacy, 1 signature, 8 instructions, no lookup table, standard programs only, confirmed |
| Phantom's developer docs ("Domain and transaction warnings") | the red note = "Phantom could not simulate the transaction"; the yellow "domain is new" = their age check, clears after their review; over a week → their Google Form |

Phantom's own developer checklist is: one signer (wallet signs FIRST if more), simulate
with `sigVerify:false` before asking the wallet, stay under the size limit. Our write path
already does all three (`write/liquidity.ts` `extraSigners: []`, `write/prepare.ts simulate()`,
`write/submit.ts` signs with `signTransaction` and broadcasts itself). So the only lever is
Phantom's review form, which must come from the team (name, email, a Solscan link of the
warned transaction): `phantom-flag-dispute.md` at the repo root is the paste-ready pack.

**One real code-side cause remains:** a review window that outlives the blockhash
(`REVIEW_TTL_MS` 45 s vs about 40 s of blockhash life now). A visitor who reads slowly signs
a dead transaction, which Phantom cannot simulate, and that is this exact note. PR #728
rebuilds on fresh numbers at Sign.

**Do:** when a wallet shows a "malicious" note, check the public lists with `curl` and read
the warned transaction back BEFORE touching code; then compare the write path with the
wallet vendor's own developer checklist. Never tell users to press "Proceed anyway": it
reads as drainer behaviour and counts against the domain.

## 2026-10-03 — the Chrome extension refuses `*.vercel.app` previews; walk a branch build against mainnet instead

**Believed:** a PR's Vercel preview is the place to walk a change live, and the Chrome
extension (which holds the Vercel session) can open it.

**Measured:** `navigate` to
`tegridy-farms-git-<branch>-fomotsar-3237s-projects.vercel.app` answers
`Cannot access this page. Claude cannot assist with the content on this page.` (a
browsing-policy refusal of the host, not a load error); `curl` gets the deployment
protection redirect.

**What worked, in about ten minutes:** `vite build` the branch, `vite preview --port 4199
--strictPort` (never :4173, a stale server may hold it), and a Playwright script that
routes `**/api/**`:

- `/api/pools*` → **the branch's own handler**, imported into the script
  (`pathToFileURL(...)` on Windows, `NODE_ENV=test`, `SOLANA_RPC_URL` = the public RPC),
  called with a fake `req`/`res`: real chain, this PR's code;
- `/api/solrpc` → forwarded to `api.mainnet-beta.solana.com` with the page's own body;
- Jupiter `price/v3` → forwarded to `lite-api.jup.ag`;
- everything else aborted and LISTED, so the walk names what the page still wanted.

Resolve `playwright` with `createRequire('<main checkout>/frontend/package.json')`; set
the init-script keys (`tf_loaded`, onboarding seen, consent `denied`, bungalow `venue`).
Screenshots at 1280x900 and 390x664, then LOOK at them: the phone shot showed the
tab strip covering the card's heading after `scrollIntoView` (the #723 defect), which no
DOM assertion would have said.

## 2026-10-03: a flag carried through a wallet's "Open app" link is an input anyone can write

**Believed:** after a phone visitor presses a wallet's "Open app" row and the page reopens
inside that wallet's own browser, the job is done, or at least the next step is obvious. And
once a marker in the address was added to make that page connect by itself: that only our
own press could ever put it there.

**Measured:** four testers who had not seen the code walked the built site as a Trust user.
Inside the wallet's browser the page asked the wallet for nothing and looked exactly like the
start; the same three presses had to be repeated, and one tester called it "the spot most
likely to produce: there was no way to connect". With a marker in the query the page
connected with zero presses, 1.6 s after arrival (3.4 s with a provider injected 2.5 s late).
Then three reviewers and three skeptics, each running real code, broke the first versions
nine ways. The ones that transfer:

- `WalletProvider autoConnect` (wallet-adapter-react 0.15.39) restores WHATEVER wallet name is
  saved. For a Wallet Standard wallet that is `connect({ silent: true })`; for a legacy
  injected adapter (`autoConnect() { await this.connect() }`) it is a full connect, the
  wallet's own prompt. So mounting a provider because of a link made a wallet prompt, or
  reconnect after the visitor had disconnected, with no press. `autoConnect` also takes a
  function `(adapter) => Promise<boolean>`: gate the restore there.
- The tab that WROTE the marker loads its own marked address again: Back from the wallet's
  link page, a reload, a tab the phone discarded. A 3 second timer does not cover it (a tab
  that has navigated away never runs it, and Playwright's WebKit recorded no `pagehide` at
  all), and a link pressed inside the 3 seconds leaves the marked entry in history, where
  the timer never looks. What held: a `sessionStorage` note in the origin tab that lasts as
  long as the tab (the wallet's browser has its own storage and never sees it), plus
  stripping the marker on `popstate`. Used up on first read, the note failed on the second
  marked load.
- Every wallet's app link is built from `window.location.href` inside `connect()`, upstream
  Phantom's included, so one `history.replaceState` just before the press covers them all.
  Put the flag in the QUERY: MetaMask's link is rebuilt from host, path and query and drops a
  fragment.
- With tab storage blocked the marker was not written, and the notice still promised the
  page would connect by itself. A helper that can fail must say so to the caller that words
  the notice.

**Do:** treat a URL flag that triggers behaviour as hostile input from the first line. Read
nothing out of it. Decide separately what a crafted link may cause in each kind of browser
(a computer, an ordinary phone browser with a wallet of its own, a wallet's own browser),
and write one test per kind against the REAL provider and adapters: fakes whose
`autoConnect` is a no-op passed while the real ones prompted. Not settled here: the rule
that tells a wallet's own browser from an ordinary one (no adapter offers "Open app" there)
rests on user agents nobody has read off a real device.

## 2026-10-03: React Router matches a path whatever its case; a hand-written path test does not

**Believed:** `isSolanaPage(pathname)` and the router agree about which page is on screen,
because both are given the same pathname.

**Measured:** `/Earn/bobo`, `/earn/%62obo`, `/Dashboard` and `/Curve-Launch/<mint>` all render
their route (React Router ignores case and decodes params), while a predicate comparing the
raw string said "not a Solana page". Two wallet providers were then mounted for one page and
the wallet was asked twice, 80 to 330 ms apart; with a wallet that refuses a second request
the approval landed nowhere. The same shape, without the case trick: a route (`/solana-lp`)
added to the router and not to the predicate.

**Do:** a predicate that mirrors the router has to match the way the router does:
`decodeURI`, and the `i` flag on the static part of the pattern (keep ids and addresses as
written), or mark the routes `caseSensitive`. And when a route is added, grep for every
hand-kept list of paths.

## 2026-10-03: three things a Playwright walk and a wording guard got wrong before they were right

**Believed:** `context.on('page')` is how to catch a popup; `route.abort()` on a navigation
models "the phone opened an app instead"; and a test that greps for `>Connect Wallet<`
proves the bare words are gone.

**Measured:**

- `context.on('page', ...)` registered before `context.newPage()` fires for that page too. A
  handler that closes "the popup" closed the page under test: `page.goto: net::ERR_ABORTED;
  maybe frame was detached`. Register it after creating the page, or skip `popup === page`.
- Aborting a main-frame navigation leaves Chromium on a blank error page, while WebKit stays
  where it was. A real phone that hands a link to an app leaves the browser ON the page. To
  model that in both engines, answer the link with `route.fulfill({ status: 204 })`.
- The guard caught `>Connect Wallet<` and a stock `<ConnectButton />`, and passed
  `{'Connect Wallet'}`, a ternary, a variable, and `Connect wallet` with a small w (each
  tried by mutation). After stripping comments, refuse the phrase anywhere in code, case
  ignored, and count uses of the replacement constant rather than its presence: the import
  line alone satisfied "contains".

**Do:** when a test guards WORDS, mutate the ways the words can be spelled, not only the
one spelling that existed.

## 2026-10-03: a local WebKit red that survives a solo re-run can still be trunk's: `e2e/arrival.spec.ts:79` is, on Windows

**Believed:** a spec that fails in a full run and again alone with one worker was broken
by the branch under test.

**Measured:** `arrival.spec.ts:79` ("Escape did not clear the film") failed on iphone-safari
and ipad-safari in a full run at `--workers=2` and alone at `--workers=1` (Playwright
1.62.1, WebKit build 2336, Windows 11). Trunk's own tree, built in a second folder
(`git archive af44844e frontend | tar -x -C <dir>`, a `node_modules` junction, `vite build`)
and served from this checkout with `vite preview --outDir <dir>/frontend/dist --port 4392
--strictPort`, failed the same test the same way on both projects. Trunk's CI run
37143678391 on that commit was green. The page under test, /island, has no tab strip, so
the branch's change was not active on it. Three `trade-page.spec.ts` reds from the same
full run passed alone.

**Do:** before reading a local WebKit red as yours, run the same spec against trunk's build
from a second folder and port. It took three minutes and needs no second worktree.

## 2026-10-03: WebKit lines a focused text field up by its text, so a `scroll-padding` sized to a bar's edge leaves the field's top under the bar

**Believed:** `scroll-padding-top` set to a fixed bar's lower edge plus a few pixels keeps
every focused control clear of the bar in every browser.

**Measured:** Playwright 1.62.1 (WebKit build 2336), 390x664, a tab strip fixed from 68 to
122px, `scroll-padding-top: 130px`. Each field on 16 tabbed pages was placed under the
strip and given `focus()`. Selects, checkboxes and radios landed with their top at 130px.
Text inputs landed at 115 to 129px: a 44px input with an 18.75px line at 115, a 109px
textarea at 124, a 24px input with no padding at 129. The line of text is what reaches the
padding; the box starts above it by its padding and half its spare height, 15px at most
here, so up to 7px of the field sat under the strip. Chromium (build 1234) left no control
overlapping the strip at 130 on the five pages it was run on, two of them with a text
input. `scrollIntoView({ block: 'start' })` put the box itself at the padding in both.

**Do:** add the largest text inset to a top scroll-padding (15px here, so 140px under a bar
that ends at 122), and measure a focused text field in WebKit, not only a button or a link.

## 2026-10-03: focusing a control that starts off screen does not show whether a fixed bar covers it

**Believed:** to reproduce "the focused control lands behind the sticky bar", scroll the
control off screen and focus it.

**Measured:** /solana-lp at 390x664, Chromium build 1234 and WebKit build 2336,
`scroll-padding-top: 64px`, a tab strip fixed from 68 to 122px. A button wholly above or
wholly below the screen, then `focus()`: both engines put it in mid-screen (top at 301 to
316px), except WebKit from just below the screen, which moved it the least it could (539).
None ended behind the strip. The same button with its top at 28px, half under the 56px top
bar, then `focus()`: top at 64px, behind the strip, in three of four runs. With its top at
72px, inside the padding and under the strip, `focus()` moved nothing in either engine.
`scrollIntoView({ block: 'start' })` put it at 64px every time.

**Do:** to test a bar, start the control under the bar, focus it, and separately scroll it
to the start. A control that begins fully off screen is centred, and passes on broken code.

## 2026-10-03: "the page says nothing" from a text probe misses a sheet drawn in a closed shadow root

**Believed:** after a tap on the Mobile Wallet Adapter row on Android Chrome with no wallet app,
the page says nothing and then throws "Wallet connection timed out". A phone walk of production
read the page's text and its dialogs and found none.

**Measured:** on a production build of trunk af44844e, in Chromium with Pixel 5's user agent at
360x640, a screenshot after that tap shows the package's own sheet, "Allow connections to your
wallet" (`@solana-mobile/wallet-standard-mobile` 0.5.3). It is drawn in a closed shadow root at
z-index 2147483647, so `document.body.innerText`, `getByRole('dialog')` and every other query
return nothing. The adapter's `connect()` (`wallet-adapter-mobile` 2.2.9) calls its private
`#connect()` and awaits nothing, so wallet-adapter-react's `connecting` is false at once. The
failure came 32 seconds later, from a 30 second timer that runs while that sheet is still up: an
`error` event, which WalletProvider only logs, and the same error rejected into a promise nobody
holds (Playwright's `pageerror`). By the package's code the attempt is not over then: the timer
only wins a `Promise.race`, and the other branch goes on.

**Do:** take a screenshot before writing "the page says nothing". To report a failure like this
one, listen on the adapter itself for `error`; the unhandled rejection carries the same object,
so it can be matched by identity. React only to an attempt the visitor tapped for, because
`autoConnect()` takes the same path at page load. Done in
`frontend/src/components/solana/usePhoneWalletFailure.ts` (branch `fix/solana-wallet-list-phone`).

## 2026-10-03: a phone walk of `/solana-lp` can meet the Ethereum Connect, because its Solana section waits on a chain read

**Believed:** `/solana-lp` always has the Solana Connect in the top bar, so a wallet-list test can
open the list from there.

**Measured:** against a local production build, in 1 of 6 fresh browser launches the top bar read
"Connect wallet" (the Ethereum list) for a full 25 second wait, and the screenshot showed the
page saying "Reading the venue's status from the chain...". 8 of 8 loads in one already-open
browser were fine. Two earlier runs timed out waiting for the same button; what they showed was
not captured. `SolanaLpPage.tsx` mounts its Solana section only once that read says the venue is
live, and the top bar borrows its Solana connect from that section.

**Do:** open the wallet list from a page whose Solana section is there from the first render,
`/earn/bayla`, as `frontend/e2e/topbar-solana-connect.spec.ts` and
`frontend/e2e/solana-wallet-list-phone.spec.ts` do. On `/solana-lp`, wait for the Solana button by
name and treat its absence as "the read has not answered", not as a missing wallet list.

## 2026-10-03: a button disabled "while connecting" is a dead end when the wallet never answers

**Believed:** the site could not see Phantom ("it wont even recognize my phantom wallet", the
owner's words), so the fault was in wallet detection.

**Measured:** in the owner's browser `window.phantom.solana.isPhantom` was true and a Wallet
Standard wallet named Phantom was registered with the Solana chains; the swap card read
"Connecting…" and was disabled, and the top bar's Connect did nothing. On production, a
Wallet Standard wallet named Phantom whose `standard:connect` returned a promise that never
settles, with `walletName` saved, gave the same screen 9 and 30 seconds after load: card
disabled, top bar `aria-disabled`, no dialog. wallet-adapter-react 0.15.39 keeps
`connecting` true until that promise settles, and resets it only when the adapter changes
or emits `disconnect`. The page connected by itself once the real wallet answered.

**Do:** never tie `disabled` to a promise that the user's own wallet settles. Keep the
control pressable and let the press lead somewhere (here the wallet list, where another
wallet can be picked: the provider resets on an adapter change), and say which wallet is
being waited on. Do not cancel the wait: an approval prompt may be open. A second connect
on the same Standard wallet does nothing while the first is pending (`StandardWalletAdapter`
1.1.5 returns early), so retrying the same wallet needs it to answer, or a reload. Fixed
in PR #715. A scripted `button.click()` on Connect in someone's real browser starts a real
wallet prompt that only they can answer: say so when a probe does that.

## 2026-10-03: a form that only greys out its button reads as "it does not work"

**Believed:** the open-a-pool form was broken or missing ("i still am not able to create lp
on solana").

**Measured:** in the owner's browser the form was open and correct. Under its two boxes, in
10px grey, it said "You have 0.005960758 SOL. Up to 0 SOL can go in after the fee to open,
the account deposits and network fees." and "You have 0 tokens.", and Review was greyed
out. Opening needs about 0.183 SOL before any SOL goes into the pool: a wallet with
0.879012984 SOL was told 0.695744984 could go in.

**Do:** when nothing the visitor types can make the button work, say that in one sentence
beside the button, with the number needed and the number held, before anything is typed.
A hint under an input answers "what is the most I can enter", not "why can I not proceed".
Done for the open and add forms in PR #716 (`cannotFundText`).

## 2026-10-03: a live money flow can be walked to the sign step with a wallet that is only a public address

**Believed:** checking the live site's open, add and remove flows needs a real wallet with
real money, or a local validator.

**Measured:** against https://memetics.finance at trunk a5c3d19a, Playwright registered a
Wallet Standard wallet whose account was a public mainnet address
(3wAjKgQN6HEV58wgsbedVb4ZSmJXc7i5wkRtZ9GTu9Dm, found as a recent fee payer on the BAYLA
mint) and whose `signTransaction` handed the bytes to Node through `exposeBinding` and then
threw `User rejected the request.` The site read that address's balances (0.879012984 SOL,
1,393,591.753468 BAYLA), built an 888-byte legacy transaction of 7 instructions that opens
a BAYLA/SOL pool on fee tier 1, ran its own test run and reached "Sign in wallet". After
the refusal it said "Not sent. Your wallet did not sign it." The captured bytes, run from
Node with `simulateTransaction` (`sigVerify: false`, `replaceRecentBlockhash: true`),
returned no error, 117,094 units, and a fee payer 480,774,560 lamports lower: the 0.4807
SOL the review printed. Nothing was signed and nothing was sent.

**Do:** copy the registration block from `frontend/e2e-solana/fixtures/testWallet.ts`,
drop the keypair, and make every sign feature capture and refuse. To find a funded address
use `getSignaturesForAddress` on the mint and then `getTransaction` for the fee payers:
`getTokenLargestAccounts` answered 429 on api.mainnet-beta.solana.com and "requires a
personal token" on publicnode. This cannot reach add or remove while no pool exists.

## 2026-10-03: the on-chain suite can run beside another session's, given its own validator ports, preview port and build folder

**Believed:** one machine runs one `npm run e2e:solana` at a time, because the validator
port, the preview port and the build folder are fixed.

**Measured:** another session's `solana-test-validator` 3.1.11 was listening on 8899 and
on 9900, the default faucet port (`ss -ltn` in WSL). A second one, started from a copy of
`start-validator.sh` with `--faucet-port 9911 --gossip-port 8111 --dynamic-port-range
8112-8160` added, `E2E_RPC_PORT=8999` and its ledger under `$HOME/audit1003/` (the script
writes its log beside the ledger's parent, so a shared parent shares the log), reached
READY with its own genesis hash while the first kept its own. `playwright.solana.config.ts`
fixes port 4180 and `os.tmpdir()/tegridy-solana-e2e` with `--emptyOutDir`, so a second run
of that config would empty the first run's build; an untracked config that spreads the
base one and overrides `webServer`, `use.baseURL` and `outputDir` (port 4191, its own
folder), run with `E2E_SOLANA_RPC=http://127.0.0.1:8999`, ran all 157 tests: 124 passed,
31 skipped by design, 2 failed. Not measured: whether the second validator starts without
the faucet flag.

The two failures were load, not code: both were "reload while unconfirmed" tests, run
while two other jobs were running vitest sweeps on the same machine. One (`lp-write` E12,
"transaction did not land", a 10-second wait in `landedTx`) passed in the same run at
phone size, and both passed when their files were run again alone on the same commit.

**Do:** give a parallel run all four of its own: validator ports, ledger folder, preview
port, build folder. Read "did not land" and "visible but not clickable" in a full run on
a busy machine as a reason to re-run that file alone, not as a break, and say which it was.

## 2026-10-03: create-if-missing opens a token account over an address a stranger already sent SOL to

**Believed:** an account that exists at a wallet's associated token address but is not a
token account is a broken account, so refuse to build on it.

**Measured:** two mainnet test runs from Node (`simulateTransaction`, `sigVerify: false`),
each one transaction: a System transfer of 650,240 lamports to a never-used associated
address, then `createAssociatedTokenAccountIdempotent` for that address. For the BAYLA
mint (Token-2022) and for wrapped SOL (classic) both returned no error, and the address
ended owned by the token program as an initialized account with amount 0. The fee payer
paid only the top-up: the wrapped-SOL run moved it by 1,493,440 lamports, which is the
650,240 it sent itself, 838,200 to reach the 1,488,440 deposit, and the 5,000 fee.

**Do:** treat an address owned by the System program with no data as an account that has
not been opened, wherever "absent" is decided, and refuse only another owner or data that
is not a token account. Treating only `null` as absent let anyone block a wallet's
withdrawals on the site for the price of one dust transfer. Fixed in PR #716 (`opened` in
`frontend/src/lib/launcher/solana/write/wsol.ts`).

## 2026-10-03: in `String.prototype.replace`, a replacement text that holds `$'` pastes in the rest of the input

**Believed:** `s.replace(oldLine, newLine)` with two plain strings swaps one line for the
other.

**Measured:** a scripted edit of `DashboardPage.tsx` whose new line held `prefix: '$', sub:`
left the file unparseable (vitest: "Transform failed with 1 error"). `$'` in a replacement
string means "the text after the match", so everything after the matched line had been
spliced into the middle of it; the tail of the new line turned up about 950 lines further
down, at line 1381. `$&`, `` $` `` and `$1` are read the same way.

**Do:** pass a function, `s.replace(oldLine, () => newLine)`, which is used as written,
and afterwards grep for a phrase from the new line and expect exactly one hit.

## 2026-10-03: a tab the browser extension cannot screenshot can still report what it drew, through the console

**Believed:** when the extension's tab is hidden and every evaluate and screenshot times
out, the owner's own browser can tell us nothing.

**Measured:** in Edge the extension's tab had `document.hidden` true. One synchronous
evaluate straight after `navigate` returned (readyState `interactive`, `<main>` empty);
every later one timed out at 45 seconds, and screenshots failed with "Script injection
timed out". A `MutationObserver` installed by that first evaluate, writing one
`console.log('[AUDIT] ' + JSON)` line whenever the page changed, was read back with the
extension's console reader: 11.3 seconds after navigation the page had its title, the
`lp-section` test id and "VENUE · LIVE". `clientWidth` was 0 in that tab, so it says
nothing about layout.

**Do:** install the observer in the one evaluate that works and read the console, not the
page. Use it for "did it render, and what did it read"; measure layout somewhere visible.

## 2026-10-03: a screenshot taken the moment a dialog exists shows it half see-through

**Believed:** the phone wallet list was transparent, with the page's text readable through
it.

**Measured:** the wallet adapter's `.wallet-adapter-modal-fade-in` wrapper had computed
opacity 0 at the moment `getByRole('dialog')` first resolved on desktop, 0.33 on an 820px
viewport, and 1 by 400ms on all three sizes. A screenshot at 4 seconds was solid.

**Do:** before judging or capturing a dialog, wait until the computed opacity of its fade
wrapper is 1. The same goes for a tall element screenshot: where the element passes under
a fixed header, the header is painted across the middle of the picture.

## 2026-10-03: a guard that names one spelling of a call covers one spelling

**Believed:** after #603/#609/#622 every receipt wait passed `onReplaced` and checked the hash,
because `receiptConsumers.guard.test.ts` failed any file that did not. And a status poller that
throws when its time runs out is fine, because the caller's `catch` can say what happened.

**Measured** (PR #696, trunk `ab739ff3`):

- The guard matched `useWaitForTransactionReceipt(`, the wagmi hook. `git grep
  waitForTransactionReceipt` found 11 direct `publicClient.waitForTransactionReceipt` calls and
  4 `getTransactionReceipt` re-reads it never saw. A real viem 2.56.8 public client driven
  through a scripted node (`frontend/src/lib/txErrors.direct.test.ts`) resolves a cancel, a
  speed-up and any other same-nonce transaction with the replacement's success receipt, the
  same as through the hook. On the pre-fix hooks, in vitest: a cancelled DCA swap was counted, a
  cancelled limit-order swap marked the order filled, a cancelled registration toasted "TWAP
  registered", and a zap recorded a cancelled approval as confirmed and sent the next step.
- A third spelling is inside `node_modules`: `@whetstone-research/doppler-sdk` 1.0.39
  `createDynamicAuction` waits with no `onReplaced` and returns `transactionHash: hash`, the
  submitted hash, so after a speed-up the caller holds a hash that never mined (read in
  `dist/evm/index.js`, not run).
- A re-read by hash cannot find a replacement. `getTransactionReceipt(sent)` answers only for
  `sent`, and viem's live wait finds a replacement from the pending transaction's sender and
  nonce, which it can no longer read once the original is dropped. So a transaction replaced
  after the live wait gave up stays unread for good.
- The Solana swap page's own poller threw `Could not confirm in time` after 60s and let a
  `getSignatureStatuses` rejection escape. With the real page under vitest and a scripted
  connection, a watch that ran out toasted `Swap failed`, and one rejected status read toasted
  `Swap failed` for a swap whose next read said confirmed.
- ethers is the other way round. Read in the installed ethers 6.17.0 source
  (`lib.esm/providers/provider.js`, `TransactionResponse.wait`; not run): a revert throws
  `CALL_EXCEPTION`, so `receipt.status === 0` after `await tx.wait()` is dead code, and every
  replacement throws `TRANSACTION_REPLACED`, a speed-up included (`reason: 'repriced'`,
  `cancelled: false`, with `receipt`). An ethers `catch` is three facts: reverted, replaced but
  ran, and unread.

**Do:**

- Pin a rule on the library call, not on the wrapper you fixed first. Grep every spelling
  (hook, client method, bare action import, SDK internals) and make the guard forbid the raw
  call outside one helper, with any exception named beside its reason.
- A wait that can outlive its transaction needs the sender and nonce if a later re-read must
  learn it was replaced. A hash alone cannot.
- A confirm poller returns an outcome (`confirmed`, `reverted`, `unknown`). It never throws
  for "time ran out" or for one failed read: a caller's `catch` will call both a failure.
- With ethers, `TRANSACTION_REPLACED` with `cancelled === false` is a success: take
  `error.receipt`.

---

## 2026-10-03: a bare warming import runs a file's mock factories before its own consts exist

**Believed** (the 2026-09-10 entry "a slow vitest "test" is often a slow *hook*"): any test file
that re-imports a module under `vi.resetModules()` can take a bare `import "../thing.js";` at the
top, and that import is what gives the resets teeth.

**Measured** (vitest 4.1.11, trunk `288a7948`, the six `api/__tests__/orderbook*.test.js` files
with no warming import): five took it. `orderbook-r053.test.js` did not. Its factories read
top-level consts when they run (`vi.mock("viem", () => ({ recoverMessageAddress: recoverMock }))`).
From a hook that is long after the consts exist. A static import is hoisted above them, so the
file failed at collection, `Cannot access 'recoverMock' before initialization`, with 0 tests run.
An `await import("../orderbook.js")` below the last mock warms the same graph: first hook 137 to
373ms before, 1.5 to 2.4ms after. It also runs after that file's top-level
`process.env.SUPABASE_URL = ...`, so the warmed instance has a live client and the reset pins
nothing: deleting it failed 0 of 11 before and 0 of 11 after. In the five that took the bare
import the same deletion went from 0 to 6 of 6, 12 of 22, 5 of 5, 3 of 4 and 10 of 10.

**Do:** before adding a warming import, read each `vi.mock` factory for a name it reads when it
runs, as opposed to inside a function it returns. If there is one, warm with `await import()`
below the last mock. Then delete the reset on both sides of the change: where the warm load sits
relative to the file's env writes decides whether the reset pins anything.

---

## 2026-10-03: Windows' `% Processor Utility` reads 100% on a machine that is half idle

**Believed:** a Windows counter is the reference to check an `os.cpus()` idle-time meter against,
so a run recorded at "Windows 100%" ran on a saturated machine.

**Measured** (18 logical CPUs, typeperf at 1s): `\Processor Information(_Total)\% Processor
Utility` read 164 to 253% across six seconds in which `\Processor(_Total)\% Processor Time` read
48 to 71%, and an `os.cpus()` meter read 64% over the next five. Capped at 100, Utility said 100%
beside every one of 16 single-file vitest runs that the `os.cpus()` meter put at 39 to 60%, with
no other vitest process at either end of them. Microsoft describes Utility as scaled by clock
speed (read, not measured), which fits. The `os.cpus()` meter has a ceiling of its own: with 17
to 20 other vitest processes it read 89% in 76 of 80 runs and never more, and 89% is 16 of 18.

**Do:** record `% Processor Time` or the `os.cpus()` figure, and beside it the count of other
test runners (`Get-CimInstance Win32_Process`, matched on the command line). Treat 89% on this
machine as full.

---

## 2026-10-03: "above the fold at 390x844" measures the phone's screen, not the page its browser gets

**Believed:** a field that is whole inside 390x844 in a first-screen test is on an iPhone's
first screen.

**Measured:** 390x844 is the iPhone 13 and 14 screen. Playwright 1.62.1's own descriptors give
the page 390x664 on those two and 393x659 on an iPhone 15, the device behind the repo's
`iphone-safari` project (`frontend/playwright.config.ts`). The /solana-lp token address field
passed at 390x844; at those heights the whole field sat under the bottom bar and ended 47 to
52px past the first screen (fixed in b06445e1, PR #704, branch `feat/pools-solana-lp-tab`).

**Do:** measure a first-screen claim at the device's `viewport`, not its `screen`
(`FIRST_SCREENS` in `frontend/e2e/tab-target-size.spec.ts` on that branch adds 390x664 and
393x659), and do not set a device project's height to the screen's. Assert that
`window.innerHeight` is the height the case names, since a project may not give it.

---

## 2026-10-03: the "Main navigation" role matches the top bar from 800px up, so find the phone's bottom bar by position

**Believed:** `getByRole('navigation', { name: 'Main navigation' })` is the phone's bottom bar,
so its height is what to take off the first screen.

**Found:** two elements carry that label: `frontend/src/components/layout/BottomNav.tsx`
(`fixed bottom-0`, hidden from 800px) and the row in `frontend/src/components/layout/TopNav.tsx`
(hidden below 800px). A role query skips whichever is hidden, so at 800px and wider it returns
the top bar, and a height read from it is the wrong bar's.

**Do:** pick the bar by where it is. `bottomBarHeight` in `frontend/e2e/tab-target-size.spec.ts`
(branch `feat/pools-solana-lp-tab`, added in 3858c927) walks `nav[aria-label="Main navigation"]`
and keeps the one whose computed `position` is `fixed`, that has height, and whose bottom edge
is at `window.innerHeight`. It returns 0 when there is none, and each case asserts which it
expects.

---

## 2026-10-03: React's `useId` values differ between two loads of the same build, so normalise them before comparing HTML

**Believed:** the same build loaded twice renders the same HTML, so comparing a page's HTML
before and after a change shows only what the change did.

**Measured:** two loads of one build gave different `useId` values for the same elements, so
every comparison "differed" until the ids were normalised. react-dom 19.3.0 builds a client id
as `_r_<n>_` from one page-wide counter, in the order components first mount, so anything that
changes mount order changes every id after it. The ids land in `id`, `aria-describedby` and
`aria-labelledby` (`frontend/src/components/ui/InfoTooltip.tsx`,
`frontend/src/components/solana/lp/PanelFrame.tsx`).

**Do:** before comparing rendered HTML, replace every `_r_[0-9a-v]+_` with one fixed token on
both sides. A "same HTML before and after" claim (b06445e1 makes one for /pools) holds only
with that step.

---

## 2026-10-03: in Git Bash on Windows, an argument that starts with a slash is rewritten to a Windows path

**Believed:** a quoted argument reaches the program as typed.

**Measured:** in Git Bash, printing `process.argv` from node: `"/pools shows the tab"` arrives
as `C:/Program Files/Git/pools shows the tab`, so `npx playwright test -g "/pools ..."` is
given a pattern no test title matches. `git show origin/mvp-launch:.gitignore` arrives as
`origin\mvp-launch;.gitignore` and fails with "ambiguous argument", while `HEAD:.gitignore` and
`origin/mvp-launch:frontend/package.json` pass through untouched.

**Do:** prefix the command with `MSYS_NO_PATHCONV=1` (both then arrive as typed), or keep the
leading slash out of the pattern (`-g "pools ..."`). When a `-g` run finds no tests, print the
arguments the program received before doubting the test.

---

## 2026-10-03: `tests | tail -4 && git push` pushes on a red run, because a pipeline's status is its last command's

**Believed:** `&&` after a test command stops the push when the tests fail.

**Measured:** in bash, `false | tail -4 && echo pushed` prints `pushed`: the pipeline's exit
status is `tail`'s, which is 0. On 2026-10-03 a line of this shape pushed a branch with one
test red. That test was a load flake and passed on a re-run, but the guard had done nothing.
With `set -o pipefail` the same line exits 1 and prints nothing.

**Do:** `set -o pipefail` before the line, or run the tests on their own and check their exit
code (or `${PIPESTATUS[0]}`) before the push. Trimming output with `tail` or `head` is the
usual way this gets in.

---

## 2026-10-03: a near-full Solana transaction has no room for a memo, so give readers a read recipe instead

**Believed:** the way to make a kind of transaction findable later is to tag it with an SPL
Memo.

**Measured:** the curve launch's worst-case create, with the plant, is 1,210 of a legacy
transaction's 1,232 bytes (pinned in `frontend/src/lib/launcher/solana/write/prepare.test.ts`),
so 22 are left. A "PLANT <mint>" memo costs about 85: the memo program's 32-byte key, 3 bytes
of instruction framing and about 50 of text.

**Do:** name an account every such transaction must touch, and say what to filter by. Every
plant pays the Workshop's $BAYLA account (`WORKSHOP_BAYLA_ACCOUNT` in
`frontend/src/lib/launcher/solana/write/plant.ts`), so the recipe is that account's signatures
(`getSignaturesForAddress`), keeping the transactions that carry the plant's two instructions
(`plantInstructions`: a burn and a transfer of 50,000 $BAYLA each).

---

## 2026-10-03: two renders of a hook that stamps the clock are equal only inside one second

**Believed:** rendering a hook twice, back to back, and deep-comparing the two reports is a
stable test when nothing in the stubs changed.

**Measured:** `useWalletExposure` stamps `observedAt` with `Math.floor(Date.now() / 1000)` on
every render (`deriveHoldingExposure`). `walletChainDisplayReads.test.ts` compared two renders
with `toEqual` and failed CI run 37116193466 on that one field, 1791023351 against 1791023350:
a second boundary fell between the renders. To find every test of this kind at once, a
throwaway setup file made each `Date.now()` read land one second after the last
(`Date.now = () => base + reads++ * 1000`) and the whole unit suite ran under it at 288a7948:
13,267 tests, 16 failed. Two were this test. The other 14, in three files, time themselves
with a stopwatch or a deadline (`fork-relay`, `orderbook.bundle-guards`,
`seaport-verify.bundle-ownership`), which that clock breaks by design; all pass on the real
clock. `new Date()` with no argument reads the clock on its own and was not swept.

**Do:** freeze the clock in any test that compares two reports (`vi.useFakeTimers({ toFake:
['Date'] })`, `vi.setSystemTime(NOW)`, real timers back in `afterEach`), and assert one stamp
equals the frozen time, so taking the freeze away fails every run and not only when a second
turns.

---

## 2026-10-03: a slow `waitFor` can be a cold import inside the code under test

**Believed:** a test body with no `await import()` in it, in a file that loads its component at
collection, has no cold load left, so a 5000ms timeout there is real work.

**Measured** (vitest 4.1.11, trunk `288a7948`, `LighthousePoolLive.readOrder.test.tsx`, the body
split with `performance.now()`): 1299 to 1342ms at 57 to 66% CPU load and 3420ms at 89%, with 829
to 2392ms of it inside one `waitFor`. Which `waitFor` changed between runs. The card calls
`readConfirmedSlot` after a confirmed write. The test mocked four functions of
`lib/bungalowStaking` and not that one, so the real one ran `import('@streamflow/staking')` cold:
948 to 2691ms, then null, because no RPC answers a test. Module evaluation blocks the event loop,
so the open wait took the time, and a 1542ms timeout was reported as 2732 to 3341ms. With the one
line mocked: 339 to 560ms at about 50% load, 744 to 2821ms at 89%.

**Do:** when a split shows one wait holding the time, time the functions the mock left real
before blaming the render. A `vi.mock(path, importOriginal)` spread keeps every function you did
not name.

---

## 2026-10-03: moving an import to collection also moves when the module reads its env

**Believed:** the fix for a cold `await import()` in a test body is always a static import, or a
bare warming import, at the top of the file.

**Measured:** `api/__tests__/canonical-origin.test.js` stubbed NODE_ENV to production in a
`beforeAll`, then imported ten handlers inside test bodies (`orderbook.js`: 1117 to 4199ms of a
5000ms bound; the rest of that body 3 to 6ms). `api/etherscan.js` builds its CORS allowlist at
module scope from NODE_ENV. An import at the top of the file is evaluated before any hook, and
with no `vi.resetModules()` the body gets that same instance: the handlers would have been tested
in test shape, every assertion still green. The check that sees it: mutate `etherscan.js` to
widen its list whenever NODE_ENV is not "production". The old file passes, the new file passes,
and the new file with its two `vi.stubEnv` lines deleted fails.

**Do:** before hoisting, grep the imported modules for `process.env` at module scope. If any
reads it there, stub the env at the top level of the test file, ahead of a top-level
`await import()`, and run a mutation that only the right env hides.

---

## 2026-10-03: a timeout gate sized at one load is wrong five minutes later

**Believed** (the 2026-09-11 entry "a per-test timeout is a third clock"): a threshold between
the pre-fix and post-fix durations, with the runs interleaved, separates the two.

**Measured:** other sessions ran suites on the same machine, and load moved between 33% and 89%
within minutes. One test, fixed: 339 to 2821ms. The same test before the fix: 956 to 5031ms, the
last a real `Test timed out in 5000ms`. A 1100ms gate sized near 80% load failed the fixed file 2
of 5 once load rose. A 3230ms gate sized at 89% passed the pre-fix file 5 of 5 once load fell.
Sizing and gating in the same minutes held: three pairs at the default timeout, the log midpoint
of the slowest fixed and the fastest pre-fix run, refuse if they overlap, gate at once. Pre-fix
timed out 5 of 5 and fixed passed 5 of 5.

**Do:** size the gate in the run that uses it, and check the load meter against the system's
own: an `os.cpus()` idle-time meter read 89% here, its ceiling, while Windows reported 100%, so
every 89% in these three entries means saturated. When a script reads vitest's JSON report: a
timeout is written `Error: STACK_TRACE_ERROR` (the words "timed out" are only in the default
reporter), and `numTotalTestSuites` counts describe blocks, not files.

---

## 2026-10-03: ethers' `wait()` throws on a replaced transaction only if the signer sent it; through a contract method it never settles

**Believed:** in ethers v6, `await tx.wait()` throws `TRANSACTION_REPLACED` when the wallet
speeds up or cancels a pending transaction, so a `catch` around it sees every replacement.
And a `repriced` replacement is the same call, so it worked.

**Measured** against ethers 6.17.0: the real `BrowserProvider` over a scripted EIP-1193 node,
one transaction replaced at its nonce, sent two ways
(`frontend/src/nakamigos/lib/txOutcome.ethers.test.js`):

| Sent by | A speed-up, a cancel, or another call at that nonce |
|---|---|
| `signer.sendTransaction(...)` | `wait()` throws `TRANSACTION_REPLACED`, reason `repriced` / `cancelled` / `replaced` |
| `contract.method(...)` | `wait()` never settles. `wait(1, 250)` ends only on ethers' own `TIMEOUT` |

`JsonRpcSigner.sendTransaction` returns `tx.replaceableTransaction(blockNumber)`. A contract
method wraps that in `new ContractTransactionResponse(iface, provider, tx)`, whose constructor
copies the fields and leaves the private start block at -1, and `wait()` skips the replacement
scan when it is -1. `provider.getTransaction(hash)` hands back the same unarmed kind. 16 of the
marketplace's 18 waits were on contract methods: a sped-up cancel or approval sat on its spinner
until a reload, and the two signer sends called a sped-up purchase "failed".

Two more shapes from the same run:

- A speed-up that REVERTED still throws `TRANSACTION_REPLACED` / `repriced`. ethers never
  checks the replacement's receipt, so `error.receipt.status` is 0 inside a "repriced" error.
- A reverted receipt throws `CALL_EXCEPTION`, the code a failed gas estimate also uses. Only
  `error.receipt?.status === 0` says this transaction was mined and reverted.

**Do:** re-arm before waiting: `tx.replaceableTransaction(head - n)` is public and works on any
response; `n` has to reach the block before the send (`lib/txOutcome.js` uses 5). Then sort the
throw on positive evidence only: `repriced` is judged by its own receipt, `cancelled` and
`replaced` did not happen, a `CALL_EXCEPTION` carrying a status 0 receipt reverted, and
everything else is "we can't tell".

### A scripted node needs `cacheTimeout: -1`

`BrowserProvider` caches each JSON-RPC answer for 250 ms. A script that moves the head when
`eth_sendTransaction` runs is read back at the old head, the first scan stops one block short,
and the case passes only on the next poll: 1.5 s of wall clock that reads as a hang. With
`{ cacheTimeout: -1, pollingInterval: 20 }` every case is one pass.

---

## 2026-10-02: `import.meta.env.DEV` is true in a `vite build` run with NODE_ENV=development

**Believed:** a dial honoured only when `import.meta.env.DEV` is true can count on a dev server
and never in a shipped bundle.

**Measured:** Vite inlines DEV from NODE_ENV even in `vite build`. A real build with
NODE_ENV=development and `VITE_HEAT_GATE=off` (a dashboard variable or a `.env` line is enough)
produced a bundle whose heat door opened to any wallet (920b8fc0, on #682 and #691; the
real-build test is now `frontend/src/lib/devServerDefine.test.ts`). The first fix read the flag
from a shared module, and the build split that into a 37-byte chunk `index.html` then
modulepreloaded (22 preloads, was 21; 8a83d9bc).

**Do:** decide from the command that compiled the code. `frontend/vite.config.ts` defines
`__VITE_DEV_SERVER__` as `command === 'serve'`; each gate reads it in place, beside DEV
(`src/lib/heat/heatGateConfig.ts`, `src/lib/launcher/solana/curveWriteFlag.ts`), so every build
folds the check to false inside its own file.

---

## 2026-10-02: a Doppler vesting's `releasedAmount` is what the maker claimed, not what has vested

**Believed:** `vestingOf(beneficiary, scheduleId).releasedAmount` on a DopplerERC20V1 token is how
much of the allocation has unlocked, so 0 means still locked.

**Measured:** it counts only what was taken through `release()`. Vested but unclaimed tokens
sit in `computeAvailableVestedAmount(beneficiary, scheduleId)` (both are in the Doppler SDK's
`dopplerERC20V1Abi`). The /launch maker card read a real launch with a one-day vesting as
"locked ... 0 tokens released so far" five months after all of it had unlocked (1435b4cd, #691).

**Do:** say "claimed so far". Before saying "locked", compare the schedule's dates with the time
of the read: ended is claimable now, before the cliff is locked, between is partly claimable, and
unreadable dates are not a lock (`lockText` in
`frontend/src/components/launcher/makerPlatesCopy.ts`).

---

## 2026-10-02: a Doppler vesting event proves nothing unless the Airlock created that token

**Believed:** a `VestingScheduleCreated` or `VestingAllocated` log at a token's address, in the
transaction that made it, is that token's maker allocation and lock.

**Found:** any contract can emit those events at its own address; they are ordinary logs. Before
982ccf28 (#691) the /launch maker card printed a lock for any token whose transaction carried
them, and called the transaction's sender the maker even when the call went through a smart
wallet or another contract.

**Do:** read an allocation only for a token the Airlock created: its own `Create` log for this
asset in the birth receipt (exactly one), or the Airlock's `getAssetData`
(`readAirlockAssetData` in `frontend/src/lib/launcher/tokenDossier.ts`). Name a maker only when
the birth transaction's `to` is the Airlock (`dopplerBirthFromReceipt` in
`frontend/src/lib/launcher/birthPlates.ts`); otherwise say it could not be named.

---

## 2026-10-02: an exact balance check on an account strangers can pay into lets anyone block the transaction

**Believed:** a pre-sign simulation should hold every token account to the exact change its
instructions make, since the instructions move exact amounts.

**Measured:** the curve launch's create held the maker's $BAYLA account to exactly -100,000 and
the island Workshop account to exactly +50,000, each against a balance read a moment earlier.
Anyone can send $BAYLA to either account in between (another launch's plant, or 1 base unit), and
every launch's plant pays the same Workshop account, so blocking every launch was cheap. 757b5cb8
(#682, #691) made both bounds one-sided; its new `prepare.test.ts` case is red on the exact bounds.

**Do:** on an account others can pay into, bound one way: the payer loses at most X, the
destination gains at least Y (`prepareCreateLaunch` in
`frontend/src/lib/launcher/solana/write/launch.ts`). Keep the exact amount, destination, mint and
decimals pinned in the instruction bytes the intent decoder checks (`write/intent.ts`).

---

## 2026-10-02: a local stand-in for a mainnet mint can be mainnet's own bytes with one field changed

**Believed:** a local validator gets either a copy of the real Token-2022 mint, whose null mint
authority means no test wallet can be given any, or a look-alike mint that is not mainnet's.

**Measured:** af62d286 (#682, #691) seeds $BAYLA at its real address from a read-only
`getAccountInfo` dump (`frontend/scripts/solana-localnet/golden/bayla-mint.mainnet.json`, slot
452541742) with only the mint authority (bytes 0-35) set to a test key from a fixed phrase.
`baylaMintStandIn` in `genesis-accounts.mjs` refuses a dump that is not that mint, a test pins
that the stand-in differs only in bytes 0-35, and `frontend/e2e-solana/global-setup.ts` refuses a
validator whose mint differs from the seeded bytes anywhere but the supply.

**Do:** copy mainnet's bytes, change the one field the test needs, pin that nothing else
changed, and have global setup refuse any other validator state.

---

## 2026-10-02: `tsc -b` does not type-check `frontend/e2e-solana`, because no project includes it

**Believed:** the type gate (`npx tsc -b --noEmit`, or `--force` locally) checks every
TypeScript file under `frontend/`.

**Measured:** `frontend/tsconfig.json` references three projects: app (`src`), node
(`vite.config.ts`, `playwright.config.ts`) and test (`src` tests). `tsc --showConfig` (5.9.3) on
each, at #691's head, lists none of the 17 `.ts` files in `frontend/e2e-solana`, nor
`playwright.solana.config.ts`. Playwright strips types without checking them, so a type error
there passes the gate and the run.

**Do:** until a project reference covers it, check it with a scratch config,
`{ "extends": "./tsconfig.node.json", "include": ["e2e-solana", "playwright.solana.config.ts"] }`,
run with `tsc -p`. Before calling a folder type-checked, find it in an `include` list.

---

## 2026-10-01 — a PR whose base moved can still merge exactly what its CI tested

**Believed:** once trunk moves under an open PR, its green checks no longer describe what a
merge would land, so the PR has to be updated and re-tested (about 70 minutes here, most of it
E2E) before it merges.

**Measured:** `git merge-tree --write-tree origin/mvp-launch origin/<branch>` prints the tree
the merge would produce, without touching any checkout. When that equals
`git rev-parse origin/<branch>^{tree}`, the merge lands byte for byte what the PR's CI ran on,
however far trunk has moved. On 2026-10-01 nine PRs landed in a row with no second CI run:
seven with equal trees, two by the file check below. Three of them (#680, #683, #681) had
merged the head of the PR ahead of them before their CI ran, so each was already tested on
the trunk it was about to become. Where the trees
differ, `git diff --name-only origin/<branch> <merged tree>` lists exactly what CI did not
see. For #677 and #678 that was only `.gitleaks.toml`, and `git grep` showed no build or test
reads its contents (one test checks that it exists, one mentions it in a comment), so their
green carried over.

**Do:** before merging, compare the merged tree with the PR's tree. Equal: merge, pinned with
`--match-head-commit`. Different: read the file list. Re-test unless no build or test can read
those files. To save the cycle, merge the head of the PR ahead into the next PR before its CI
runs. `mergeStateStatus` cannot tell you any of this: with no branch protection it reads
`CLEAN` on a stale base.

---

## 2026-10-01 — a recorded RPC read keyed `method:address` trips gitleaks on public data

**Believed:** a fixture that holds only public on-chain data cannot trip the secret scan.

**Measured:** gitleaks 8.30.1's `generic-api-key` rule flagged
`frontend/e2e/fixtures/baylaLadderPool.ts` lines 25 and 37 in #683. Those are keys of a
recorded Solana RPC read shaped `"getTokenAccountBalance:<base58 address>"`, and both
addresses are the BAYLA ladder's public token vaults (Token-2022 accounts owned by the pool
PDA, read on mainnet). Over #683's range (`5d7c363e..7328eac8`) the scan found 2 leaks with
the old config and 0 with both addresses listed as exact strings in `.gitleaks.toml` (#684). A
later commit on the same PR cannot clear the finding: the PR scan walks every commit in its
range, and the address is still in the commit that added it.

**Do:** key a recorded read by a label (`stakeVaultBalance`), not by `<method>:<address>`.
Where the address must appear, list it in `.gitleaks.toml` as an exact string, never as a
base58 shape (that file records why), and do it before or with the fixture, not after.

---

## 2026-10-01 — with `--no-options`, gpg will not create a missing home, and exits 2

**Believed:** gpg creates `~/.gnupg` on first use, so a script that runs it on a fresh
machine or CI runner just works.

**Measured:** with `--batch --no-options` and no existing home, gpg exits 2 with
`keyblock resource '<home>/pubring.kbx': No such file or directory`, even though it still
writes the ciphertext. This held for symmetric encrypt and decrypt alike, on GitHub's
`ubuntu-latest` (#677's CI), WSL gpg 2.4.4 with a fresh `HOME`, and Git for Windows gpg 2.4.9
with `GNUPGHOME` pointing at a folder that did not exist. It passed on this PC only because a
home already existed. `--no-autostart` is not a way around it: symmetric encryption needs
gpg-agent to choose its key-stretching strength, and without the agent gpg exits 2.

**Do:** give each gpg call its own fresh home: `mkdtemp`, mode 0700, passed with `--homedir`,
deleted afterwards. Git for Windows gpg (MSYS) reads a `C:\` home as a relative path, so pass
it the `/c/...` form. `scripts/ops/lib/gpg.mjs` does all of this. Judge success by the exit
status, never by output existing.

---

## 2026-10-01 — after `await findByRole(...)`, a re-render a promise queued meanwhile may not have committed

**Believed:** once `await screen.findByRole('dialog')` returns, the page is settled, so a
click on the next line reads the latest state.

**Measured** (React 19.2.8, @testing-library/react 16.3.3, vitest 4.1.11, jsdom): RTL's
`asyncWrapper` switches act mode off for the whole `findBy*`/`waitFor`, then resolves after
a `setTimeout(0)`. A promise that settles in that window (here, WalletProvider restoring a
saved wallet on mount) sets state outside any act scope, so React queues the re-render on
its Scheduler, which in Node is a `setImmediate`. The event loop decides which runs first.
On PR #684 (a `.gitleaks.toml`-only diff) the timer won on a CI runner: the row click
closed over the render that still said `connecting: true`, skipped `connect()`, and
`waitFor` timed out with `expected +0 to be 1` after ~1044 ms. A probe that forced that
order (open the dialog, drain microtasks only, click) failed the same way every run, with
the committed `connecting` still `true`.

**Do:** let async work started at mount finish inside an awaited `act()` before the first
`findBy*`. React keeps an async act's queue open until a later `setImmediate` finds it
empty (`recursivelyFlushAsyncActWork`), so a state update from a microtask chain is
queued and committed before act resolves. Where a click acts synchronously, assert right
after it: a `waitFor` around a call that never happens only turns a wrong state into a
one-second timeout.

---

## 2026-09-30 — the Vite dev server does not 404 an `/api/x` it has no proxy for: it serves `api/x.js` as a browser module

**Believed:** a same-origin `/api/aggregator?...` read under `npx vite` goes through some dev
middleware that runs the function, and an import error naming `api/aggregator.js?resource=...`
means that middleware loaded the module with the query attached.

**Measured** (Vite 8.3.0, trunk `a9efbf05`, curl and Playwright Chromium against
`npx vite --host 127.0.0.1`): no such middleware existed. Vite's transform middleware takes any
extensionless URL for a module request and resolves `/api/aggregator` to `api/aggregator.js`
under the root. With `?resource=heat` it answered 200 `text/javascript`: the server source,
where the page wanted JSON. With `?resource=gecko-read&path=/simple/...` the query stays in the
module id, the importer's directory is cut inside that query, `./_lib/*.js` fails to resolve,
and the request gets a 500 plus the error overlay (stack ends in `viteTransformMiddleware`).
Plugin middleware added in `configureServer` runs after Vite's host check and CORS, before
`server.proxy` and the transform middleware.

**Do:** read the overlay's stack before blaming config: `viteTransformMiddleware` means Vite
served the URL as a module. `/api/<route>` in dev is now `devApiPlugin` in `vite.config.ts`.
`src/` imports `api/_lib/*.js`, so the browser fetches `/api/_lib/*.js` as modules: a dev
route for `/api/*` must leave URLs with an extension to Vite.

---

## 2026-09-30 — keeping both sides of a NOTES or TODO conflict can turn a paragraph into a heading

**Believed:** a conflict in `NOTES.md` or `docs/TODO_OPERATOR.md` where two branches each add
sections at the top is resolved by keeping every section and joining them with the file's `---`
separator.

**Measured:** merging three branches that each added sections (2026-09-30), a script split each
side on `\n---\n\n` and joined them the same way. The last section of each side has no blank
line after it inside the conflict, so the join put `---` straight under a paragraph: 4 places
in the two files. In Markdown a `---` right under a text line is a setext heading underline, so
the whole paragraph above renders as a heading. No test reads for it.

**Do:** after resolving, list every `---` line whose previous line is not blank:
`awk 'NR>1 && $0=="---" && prev!="" {print FILENAME": "NR} {prev=$0}' NOTES.md docs/TODO_OPERATOR.md`.
The list must be empty.

---

## 2026-09-30 — with two push URLs, a push the first host refuses still reaches the second

**Believed:** an `origin` with two `pushurl`s (GitHub, then GitLab) stops at GitHub when GitHub
refuses a push, for example because its secret scanning found a key in it.

**Measured:** git pushes to each push URL in turn and goes on after one refuses (git 2.53,
throwaway repos, 2026-09-30). The "GitHub" repo's pre-receive hook refused `feat/leak`; the same
`git push` then printed `* [new branch] feat/leak -> feat/leak` for the "GitLab" repo, and
exited 1. The standby is public, so that push would have published the key.

**Do:** give the clone a pre-push hook. git runs it once per push URL, with that URL as `$2`. For
every URL after the first, ask the first host (`git ls-remote`) whether it now holds each ref
exactly as pushed, and refuse otherwise. `scripts/git-hosting/pre-push-standby.sh` does this and
`set-remotes.sh` installs it; without it, the set-remotes tests go red. A `--dry-run` push then
reports the second URL as refused, because the first took nothing.

---

## 2026-09-30 — a GitHub schedule that stops running tells someone

**Believed:** if GitHub's scheduled workflows stopped, a failed run, an issue or an email would
say so.

**Measured:** reported by the lead on 2026-09-30 (not re-read here: this work made no GitHub
calls). After the account's suspension (2026-09-24) and reinstatement (2026-09-29), no scheduled
workflow had run for more than five days, and none had resumed when this was written. Nothing
told anyone. A schedule that does not fire produces no run, so there is nothing to fail, and
every alarm those jobs had (issues, run emails) lived on GitHub too. One piece was checked
here: the nine backups downloaded on 2026-09-29, reported as every artifact GitHub held, end at
2026-09-21 (the folder names), so the Monday 2026-09-28 backup left no artifact. The exact date
of the last scheduled run needs `gh run list`, which this work did not call.

**Do:** watch a schedule from outside its host, by silence rather than by failure. The last step
of `synthetic-monitor.yml` pings healthchecks.io every 30 minutes; the check alarms when the
pings stop (`docs/OPS_SCHEDULER.md`, section 2). Ping on every run, pass or fail: a "fail"
ping holds the check DOWN, and a check that is already DOWN sends no email when the pings then
stop. Keep a copy of anything the host stores, too: `scripts/ops/pull-github-backups.mjs`
copies the weekly backup off GitHub.

---

## 2026-09-30 — a fake tool put first on PATH is the one a Git Bash child runs

**Believed:** a test that spawns Git Bash with a fake `curl` folder at the front of PATH runs
the fake.

**Measured:** `C:\Program Files\Git\bin\bash.exe` is a launcher that puts `/mingw64/bin` and
`/usr/bin` ahead of the PATH it was given, so `type -a curl` listed the real curl first. A test
meant to catch a ping sent real requests to hc-ping.com (a made-up check id, so nothing was
pinged) and took 8 seconds of retries.

**Do:** set PATH inside the shell (`bash -c 'PATH="$(cd "$FAKE_DIR" && pwd):$PATH"; . "$1"'`),
assert the fake actually ran, and point test URLs at a host that cannot resolve, such as
`.invalid` (RFC 2606), so a bypassed fake sends nothing.

---

## 2026-09-30 — a paged read whose row count matches the server's total read every row once

**Believed:** paging a PostgREST table with `Range` and `Prefer: count=exact`, then checking
that the rows read equal the reported total, proves every row was read.

**Measured:** against a fake PostgREST that pages in heap order, as a query with no `ORDER BY`
may, and moves one row to the end between page 1 and page 2 (what an UPDATE can do to a heap):
1,500 rows read, total 1,500, row 1000 missing and row 10 read twice. Sorted by primary key,
the update was harmless, but a delete before the page boundary plus an insert after it still
read 1,500 of 1,500 with row 1000 missing and no key repeated, so a duplicate check alone does
not catch it. Same fake; no real Postgres was run.

**Do:** page in primary-key order, and start each page on the last row of the page before. If
that row is not where it was, rows shifted: fail and re-run. Then check that no key repeats.
`scripts/ops/lib/supabase-dump.mjs` does all three.

---

## 2026-09-29 — a gitleaks config read from the base commit stops a change loosening its own scan

**Believed:** run gitleaks with `--config` and `--gitleaks-ignore-path` taken from the commit a
merge request builds on, and the merge request cannot loosen the scan of its own commits.

**Read in gitleaks v8.30.1's source** (`cmd/root.go`, by this branch's reviewer; not run here,
there is no gitleaks binary on this PC): gitleaks also loads `.gitleaksignore` from the folder
it scans, which is the change's own checkout. It also honours `gitleaks:allow` comments unless
`--ignore-gitleaks-allow` is set. So a change can add a secret and either its fingerprint in
`.gitleaksignore` or a `# gitleaks:allow` on the same line, and pass.

**Do:** scan a `git clone --no-checkout --shared` of the checkout (the same history, no
working-tree files), and pass `--ignore-gitleaks-allow`. `scripts/ci/gitleaks-range.sh` does
both.

---

## 2026-09-29 — a job on our own act runner starts as clean as a job on GitHub's VMs

**Believed:** each act job on a self-hosted runner starts from its image, as a GitHub-hosted
job does, so one pipeline cannot change what the next one runs.

**Read in act v0.2.89's source** (by this branch's reviewer; act is not installed here): every
job container gets the named volume `act-toolcache` at `/opt/hostedtoolcache`, and act never
removes it. Any job can plant a tool there, such as a fake node that `actions/setup-node` then
picks, for every later run on that Docker daemon. act's actions/cache server matches entries by
key and version only, with no branch scope. **Reproduced with git:** GitLab's shell executor
reuses one build folder, and a job that skips submodules sees them at the last job's commit, so
`git status` shows ` M contracts/lib/<x>`.

**Do:** run one job at a time, drop the volume before each run, give merge requests a
throwaway copy of the cache store, and leave submodules out of a clean-checkout check.
`scripts/ci/act-job.sh` does all of these.

---

## 2026-09-29 — copying `refs/stash` copies one stash, not the stash list

**Believed:** fetching or bundling a clone's `refs/stash` saves its stashes, and old stash
entries expire after 30 or 90 days like any other reflog entry.

**Measured:** only `stash@{0}` is a ref. The rest are the reflog of `refs/stash`, and no fetch,
push or bundle carries a reflog. Our first vault fetched `refs/stash` from a clone with 12 entries
and held 1 (git 2.53). They do not expire, though: git exempts `refs/stash` from reflog expiry
unless a `gc.refs/stash.*` setting exists. Three entries dated six months back survived `git gc`,
even with `gc.reflogExpire=1.day`; with `gc.refs/stash.reflogExpire=1.day` all three went.

**Do:** fetch each id from `git reflog show --format=%H refs/stash` into its own ref (the source
side needs `uploadpack.allowAnySHA1InWant`). `scripts/git-hosting/consolidate-refs.sh` does this,
and a mutant that keeps only the top entry goes red.

---

## 2026-09-29 — a bundle of a clone's branches does not hold the host's newest trunk

**Believed:** `git bundle create <file> --branches --tags` in a working clone backs up the trunk.

**Measured:** after the host merged a request and the clone fetched it, the new trunk was only
`refs/remotes/origin/mvp-launch`; the clone's own `mvp-launch` stayed at the old commit. The
bundle held the old one, so a restore from it would have deployed an older site.

**Do:** bundle with `--remotes` too, and when restoring, list every `*/mvp-launch` in every
bundle, then check that the chosen one contains what production serves
(`git merge-base --is-ancestor`). `backup-bundles.sh` and `docs/GIT_HOSTING.md` 5C do both.

---

## 2026-09-29 — act fails a workflow when one of its jobs did not run

**Believed:** a GitHub workflow run under act (or under Forgejo's runner, which is built on
act) exits non-zero when one of its jobs never ran.

**Read in act's source** (`pkg/runner/runner.go` and `pkg/runner/run_context.go` on master,
2026-09-29; not yet run here, there is no runner): a matrix act cannot expand, such as
`fromJSON(needs.x.outputs.y)` with an empty output, is logged as `Error while get job's
matrix` and then runs zero times. A job whose `runs-on` label has no `-P` mapping is skipped
with one info line and no result. act's exit code counts only jobs whose result is
`failure`, so both runs exit 0. act also expands a matrix before it checks the job's
`needs`, so a matrix job whose needs were skipped logs that same error where GitHub just
skips the job. And act ignores `on.push.paths`.

**Do:** never read act's exit code alone. List the jobs first (`act -l`), require a result
line for each one (`jobResult` in `--json --verbose` output; skips are logged at debug
level), and accept a job with no result only when a job it needs was skipped.
`scripts/ci/act-job.sh` does this and proves it with `--self-test`.

---

## 2026-09-29 — `node --env-file` hands the program each value as written

**Believed:** a `NAME=value` file loaded with `node --env-file` gives the program everything
after the `=`.

**Measured:** on node 24.13.0, an unquoted `B=has#hash` loads as `has`: a `#` anywhere in an
unquoted value starts a comment, not only after a space. `E=with=equals==` and CRLF endings load
intact, and quoted values keep their `#`. For a backup passphrase the cut is silent and
permanent: every file is encrypted with the shortened passphrase, and the offline copy never
opens one. `scripts/ops/lib/env-file.mjs` now reads the ops env file itself, and the ops CLIs
warn when node's own flag was used.

**Do:** never feed a secret through `node --env-file` unquoted. Prove a stored passphrase by
decrypting with the offline copy typed in, not with the file that did the encrypting.

---

## 2026-09-29 — `bash` spawned from a Windows-native process is Git Bash

**Believed:** a node test that spawns `bash` gets Git Bash on this PC.

**Measured:** from PowerShell, `bash` resolves to
`%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`, the WSL launcher. It does not pass the
caller's environment through, so a gpg round-trip test there decrypted with an empty passphrase
and failed. `scripts/lib/redact-url.test.mjs` fails 4 of 18 from PowerShell and passes 18 of 18
from Git Bash, for the same reason.

**Do:** probe the property the test needs (does the child see an env var you set?) rather than
trusting the name, and on Windows try `C:\Program Files\Git\bin\bash.exe` first.

---

## 2026-09-29 — a gpg that fails writes nothing to stdout

**Believed:** gpg either produces its output or produces none.

**Measured:** gpg 2.4.9 (Git for Windows). With one byte of a symmetric file flipped,
`gpg --decrypt` wrote all 262,144 bytes of unauthenticated plaintext to stdout, then printed
"encrypted message has been manipulated" and exited 2. Separately, the MSYS gpg called from a
native process read `--homedir C:\...` (and `C:/...`) as a relative path, failed, exited 2, and
still wrote a full ciphertext to stdout.

**Do:** the exit status is the verdict, never the presence of output. From a native process,
hand MSYS tools their data on stdin, or `/c/...` paths.

---

## 2026-09-29 — renaming `origin` takes every branch's upstream with it, so a bare `git push` still goes to the old host

**Believed:** after `git remote rename origin github` and `git remote add origin <new host>`, a
plain `git push` or `git pull` talks to the new origin.

**Measured:** `git remote rename` rewrites `branch.<name>.remote` for every branch that tracked
the old name (git 2.53, throwaway clone). After the rename and the add,
`branch.mvp-launch.remote` was `github`, `git push --dry-run -v` printed `Pushing to` the old
URL, and `git status -sb` showed `mvp-launch...github/mvp-launch`. The old host is the one being
left, so the day it comes back, a bare push lands there and skips the primary.

**Do:** after a rename, set every `branch.*.remote` that names the old remote to `origin`, and
give the old remote an unusable `pushurl` so a push to it fails loudly. The rename also carries
every `pushurl` the remote had, so with two of them a plain `git config remote.<name>.pushurl <x>`
fails ("cannot overwrite multiple values", git 2.53, 2026-09-29); use `--replace-all`.
`scripts/git-hosting/set-remotes.sh` does all of this, and a mutant without the re-point goes red.

---

## 2026-09-29 — a GitLab link to a file the repo does not have does not 404

**Believed:** a link check that follows each source link and fails on a 404 catches a link
to a path the repo does not hold.

**Measured** (curl, 2026-09-29, against the public `gitlab.com/gitlab-org/gitlab`):
`/-/blob/master/does-not-exist.md` answers `302` to `/-/tree/master`, which answers `200`.
So a wrong path lands on the repo root and every HTTP check passes. A folder under
`/-/blob/` also answers `302`, to `/-/tree/`. These answers do not depend on the request
headers. `/-/issues` does: with `Accept: text/html` it answers `302` to `/-/work_items`;
without that header it answers `404`, even with a browser's user agent. So a script that
does not send `Accept: text/html` can see a different answer from a browser.

GitHub, where the links go today, does answer a missing path with `404` (measured 2026-09-30
on our repo; a folder under `/blob/` answers `301` to `/tree/`). So a status check that passes
against GitHub says nothing about the day the links fail over to GitLab.

**Do:** check a source link's path against `git ls-files`, never against the host's status
code. `frontend/src/test/sourceLinks.test.ts` does this for every literal path in the code
and for every link the pages that link source render.

---

## 2026-09-26 — the "Treasury Safe" row in one chain's table is an address nobody controls on another chain

**Believed:** the treasury Safe is the treasury everywhere, so one `VITE_SWAP_FEE_RECIPIENT`
could serve every chain, and a checker that finds the var set has found it fine.

**Measured:** production baked `0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0`, the README's
Base-section "Treasury Safe", as ParaSwap's `partnerAddress` on Ethereum quotes.
`eth_getCode` returned 171 bytes (a SafeProxy) on Base and `0x` on Ethereum. ParaSwap's fee
vault credits the partner address, and only that address can withdraw, so a mainnet credit
there waits until someone deploys that Safe on mainnet. Nothing was lost, only because the
venue never builds a ParaSwap transaction. `verify-env.mjs` reported the gate `OK`.

The address is recoverable. An `eth_call` of `createProxyWithNonce` on the mainnet
SafeProxyFactory, with the singleton, initializer and salt from the Base broadcast
(`contracts/broadcast/DeployRoleSafes.s.sol/8453/run-latest.json`), returned exactly
`0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0`. The resulting Safe has the owners in the
initializer, not any owners changed later on Base.

**Do:** treat a Safe address as a (chain, address) pair. Accept a money recipient only if
it is the registry's entry for the chain the money moves on, and fail closed otherwise
(`lib/fees/swapFee.ts` does this now). Where a var's hazard is a wrong value, a presence
check is not a check: compare the value too, and never echo it.

---

## 2026-09-25 — a differential test against a generated fixture proves the port matches the program as it was, not as it is

**Believed:** `math.test.ts` replays 3,815 rows produced by compiling the real `curve.rs`, so
while it is green the TypeScript port quotes what the program executes.

**Measured:** the fixture was generated on 2026-08-01 at `3cc2b0ba`. On 2026-08-18,
`b990f8b2` made `quote_sell` refuse a sell whose whole proceeds go to the fee
(`ZeroAmount`) and added a `ShareTooHigh` variant to `CurveError`. The port never got the
check, and CI stayed green for 38 days: it replays the committed rows and never regenerates
them. The generator's exhaustive `match` on `CurveError` had also stopped compiling, so the
tool that would have shown the drift could not run. Rebuilt and rerun on 2026-09-25, it
changed 6 of 820 `quoteSell` rows from `['1','1','0']` to `'ZeroAmount'`. On the trade page
that was "You receive 0 SOL" for a sell the program rejects.

**Do:** read a green differential as "matches the fixture". When the source of truth
changes, regenerate before trusting it, and make the generator's build part of the gate
that runs the program's own tests.

---

## 2026-09-25 — MetaMask's "Malicious" pill is a stored domain label, not a reading of the site

**Believed:** if MetaMask calls a dapp malicious, it is reacting to something the site does
(a signature on load, an unlimited approval, a scam list someone put it on), so the fix is in
the code or on a public blocklist.

**Measured:** the red "Malicious — flagged as unsafe" pill on MetaMask's connect screen is
drawn when `GET https://dapp-scanning.api.cx.metamask.io/v2/scan?url=<host>` answers
`recommendedAction` `BLOCK` or `WARN` (extension v13.50.0, `multichain-accounts-connect-page.tsx`
~525-684). The unversioned `/scan?url=<host>` gives the reason: for memetics.finance and
memetic.fun it was `DRAINER / CRITICAL / "Domain identified as a wallet drainer."` The label
covered the whole domain: a made-up subdomain that does not resolve in DNS came back `BLOCK`,
and memetic.fun stayed `BLOCK` while serving a page with no wallet code at all. Neither domain was
on eth-phishing-detect, MetaMask's stalelist or hotlist, ChainPatrol, ScamSniffer, Phantom's list,
GoPlus or Google Safe Browsing. An instrumented wallet across 27 routes saw only EIP-6963 discovery
and a silent `eth_accounts` on load. Separately, every obscure `*.vercel.app` host tested came back
`BLOCK` by default, including live sites and our own deployment URL, while popular ones were `NONE`.
The wallet caches a verdict for one minute (`DEFAULT_URL_SCAN_CACHE_TTL`, phishing-controller).

**Do:** check the verdict with `curl` before touching code; the full-page "Deceptive site" block is
a different mechanism (the eth-phishing-detect lists), and so is its dispute. Clearing the pill
takes a vendor dispute (Blockaid's project verification), and asking to be allowlisted rather than
just cleared. Never send users to a hostname, alias or preview URL until `v2/scan` answers `NONE`
for it. `scripts/monitoring/walletReputationWatch.mjs` asks MetaMask what it asks, hourly.

---

## 2026-09-24 — MetaMask's SDK does not read through your wagmi transports, and `enableAnalytics: false` does not switch its analytics off

**Believed:** once the CSP allows every RPC host in the wagmi transports, a connected wallet
can read; RainbowKit's MetaMask row disables MetaMask's analytics; and a desktop probe
with the extension, which shows no SDK socket, clears the CSP for MetaMask everywhere.

**Measured** (RainbowKit 2.2.11, wagmi connectors 8.2.0, @metamask/connect-evm 2.1.1,
viem 2.56.5; Playwright Pixel 5 and iPhone 15 against a production build with the
vercel.json CSP injected):
- On a phone, and on desktop with the extension, the row uses wagmi's `metaMask()`. It
  hands the SDK `supportedNetworks` = each chain's `rpcUrls.default.http[0]`, and the SDK
  `fetch`es 33 methods straight there (reads such as eth_call, eth_estimateGas,
  eth_getTransactionCount and receipts, plus eth_sendRawTransaction), with no fallback to
  the wallet. viem's mainnet default
  is `https://ethereum.reth.rs/rpc` (it moves between viem versions). Refused by the CSP,
  mainnet reads threw `RPCErr52 ... Failed to fetch` while Base (default allowed) answered.
  WalletConnect differs: wagmi builds its rpcMap from the transports.
- A phone browser gets the SDK's relay transport: it opens `metamask://connect/mwp?...`,
  then a websocket to `wss://mm-sdk-relay.api.cx.metamask.io/connection/websocket`.
  Refused, WebKit drops the session to `disconnected` and throws
  `null is not an object (evaluating 'this._transport.close')`. Desktop with the extension
  uses a browser transport and never opens that socket.
- RainbowKit passes `enableAnalytics: false`, the old `@metamask/sdk` option. connect-evm
  v2 reads `analytics.enabled`, and wagmi spreads your parameters and then sets
  `analytics: { integrationType: 'wagmi' }`, so no config reaches it. It POSTs to
  `mm-sdk-analytics.api.cx.metamask.io`; refused, it retries on a backoff capped at 30s
  and logs `Sender: Failed to send batch` each time.

**Do:** allowlist what the SDK build contains, not what your config names: read `wss://`
and RPC URLs out of the shipped package and each chain's `rpcUrls.default`. To test a CSP
locally, `vite preview` sends no Vercel headers: inject it with Playwright
`route.fetch()` + `fulfill({ response, headers })` on document requests, with
`serviceWorkers: 'block'`. `route.abort()` a custom-scheme deep link (a 204 blanks the
page in WebKit). `globalThis.__METAMASK_CONNECT_MULTICHAIN_SINGLETON__` resolves to the
SDK core; `invokeMethod({ scope: 'eip155:1', request })` drives its read router with no
wallet present.

---

## 2026-09-24 — a CORS allowlist in a framework's user routes does not decide who can read

**Believed:** the indexer's `allowedOrigins` in `indexer/src/api/index.ts` is its CORS policy,
so removing a host there stops that host reading the indexer.

**Measured:** against the live indexer, `OPTIONS /graphql` from four origins (three on the list,
one invented) all answered `204` with `Access-Control-Allow-Origin: *`, and
`allow-methods: GET,HEAD,PUT,POST,DELETE,PATCH`. That is Hono's default method list, not the
`GET, POST, OPTIONS` the file sets, so a different layer answered. Ponder 0.8.33 mounts
`cors({ origin: "*" })` before user routes (`src/server/index.ts:94` in its source), and
Hono's cors answers OPTIONS without calling `next`. On `POST`, a listed origin was echoed by
name and an invented one kept `*`. Every response also carried `allow-credentials: true`,
which neither layer sets.

**Do:** before trusting a CORS change, send the preflight and compare the answered
`allow-methods` with the ones you configured. If they differ, your middleware never saw the
request.

---

## 2026-09-24 — a comment that names a guard is not a guard until the guard reads the file

**Believed:** `bot/src/config.test.js` said the bot's default origins were held to `SITE_URL`
by `frontend/src/lib/__tests__/canonicalHost.test.ts`, so the bot's documented defaults
could not drift from the code.

**Measured:** `canonicalHost.test.ts` has never read anything under `bot/`; its only "bot" is
a Twitterbot user agent. #478 (2026-09-12) moved the defaults in `bot/src/config.js` to
memetics.finance and wrote that pointer in the same commit, and `bot/.env.example` and
`bot/DEPLOY.md` went on naming memetic.fun as the default for twelve days. A second pointer,
in `bot/src/venueClient.js`, credited `venueClient.test.js` with the signing-parity proof
that the test's own header hands to `api/__tests__/bot-noncustodial.test.js`.

**Do:** when a comment says "X is pinned by Y", grep Y for X before relying on it or
repeating it. If Y does not read X, write the guard or drop the claim.

---

## 2026-09-22 — a `toContain('80°')` pin stays green on a page that says 180°

**Believed:** a test that asserts a threshold goes red when the page shows a different
threshold.

**Measured:** `'180°'.includes('80°')` is true (node), so an assertion written as
`toContain('80°')` passes against a page that reads 180°. Such a pin cannot fail on the one
value it exists to pin. The heat floor and band pins match a standalone number
(`(^|[^0-9])80°`) or the whole sentence instead.

**Do:** anchor a numeric assertion. Substring matching on a number is safe only while no
longer number contains it, which is a fact about the future value, not the present one. The
same shape hides 3 inside 13 and 30 inside 130.

---

## 2026-09-22 — a regex comment stripper turns one `//` line into a 93-line blind spot

**Believed:** a `prose()` helper that deletes comments before scanning source is a fair way
to ask "does the shipped text still say this".

**Measured:** `prose()` removes `/* ... */` with a regex. Line 4 of
`frontend/api/_lib/flames.js` is a `//` line that contains `/*`, so the strip ran from there
to the next `*/` on line 97 and the guard read nothing for 93 lines of real code. It was
passing against an empty string. The replacement reads strings and JSX text through the
TypeScript compiler instead of stripping text. Mutation check over 22 single-mutation runs:
9 mutations the old guard passed are red under the new one, the 8 it already caught stay
red, and 3 negative controls (the same sentence in a `//` comment, in a JSX comment, and
inside a URL string) stay green.

**Do:** a guard that answers "is this text shipped" has to parse, not strip. Prove it the
way a mutation proves a test: put the forbidden text in code and in a comment, and check the
guard goes red exactly once.

---

## 2026-09-22 — a fixed `webServer` port with `reuseExistingServer` makes the second checkout test the first one's build

**Believed:** two worktrees of one repo can run Playwright at the same time, because each
has its own `dist`.

**Measured:** `frontend/playwright.config.ts` sets `baseURL: 'http://localhost:4173'`,
`webServer.command: 'npx vite preview --port 4173'`, `port: 4173` and
`reuseExistingServer: !process.env.CI`. The second run finds 4173 already listening, does
not start its own preview, and drives every spec against the other worktree's build. It
reports a clean pass and names no tree. Five worktrees shared this box this session; each
run used an uncommitted `frontend/playwright.local.config.ts` with its own port, and none
went near 4173.

**Do:** when a runner can reuse a server, the port belongs to the checkout, not to the repo.
Give each worktree its own port in a local, uncommitted config, and do not trust a green
e2e run that could not say which build it loaded.

---

## 2026-09-22 — an exact-count pin over prose from a live read fails downward, and that is not a regression

**Believed:** `e2e/em-dash-zero.spec.ts` counts em dashes per route, so a red means someone
added one.

**Measured:** one run went red on four routes for counting FEWER than pinned: `/yield` 14 of
21, `/launch` 23 of 26, `/eth-curve` 14 of 15, `/curve-launch` 12 of 14, with no shipped
source changed in that pass. Those routes render prose out of live reads, so a failed read
or a loaded box renders less prose and the count drops. The spec's own failure message then
invites you to lower the pin. All four passed on retry, and the same command run again was
103 passed, 0 failed.

**Do:** read the direction before believing a count pin. Lowering it on a downward failure
writes a bad reading into the guard. A count over content the build does not contain wants
an upper bound plus a separate assertion that the section rendered at all.

---

## 2026-09-21 — to find everything a key controls, search the field that names the key

**The belief:** "which Streamflow pools does this key run?" can be answered by listing
the pools for the token and checking each one's authority. **It can't.** A search by the
BAYLA mint (`searchStakePools({ mint })`) found **2** stake pools administered by the
OneDrive faucet key. A search on the authority field itself — `getProgramAccounts` on the
stake program with a `memcmp` of the key at `StakePool.authority`, offset 74 — found **6**.
The other four were pools for other tokens (BOBO, SOY, RIZZ and one more). A mint search
can only find the mint you already thought to ask about. Each of the 6 stake pools also
had a reward pool, so the real answer was 12 accounts. All 12 were then handed to a new
admin in one transaction.

Take the offset from the program's IDL (the account's field order, plus 8 bytes of
discriminator), not from memory. Check it by confirming the matches decode as that
account type with that field set to the key. **A wrong offset returns an empty list,
which reads exactly like "this key controls nothing"** — measured: the same query for the
current admin returns 6 accounts at offset 74, and 0 at offsets 73 and 42.

### A simulated call's first error can be about a precondition, not your question

To learn whether the key could pull funds, a `clawback` was simulated with signature
checking off. It failed with `3012 AccountNotInitialized` on the `to` account — the
key's own token account for BAYLA did not exist. **That says nothing about whether
clawback is allowed**, only that the program never got as far as checking. Anyone can
create that account first, so the honest simulation creates it in the same transaction
and then claws back. That run reached the real check: `6015 ClawbackNotPossible` at
`clawback.rs:94`. Before reading "impossible" into a simulation error, confirm the error
names the thing you asked about. If it names a missing account, a wrong owner or a
blockhash, satisfy that and simulate again.

### `git fetch` never moves your local `mvp-launch`

A "what does my PR add" check over `mvp-launch..HEAD` reported **3,421** added lines for
a PR that adds **56**: in a worktree the local `mvp-launch` branch sat **48 commits**
behind `origin/mvp-launch` — one day's merges — so the range included trunk's own new
commits. `git fetch` updates `origin/mvp-launch` and leaves
the local branch where it was, so even "fetch first" doesn't fix a check that names the
local ref. Every range check — diff, scan, `git log` — should say `origin/mvp-launch`.

---

## 2026-09-20 — gitleaks checks every commit in a PR, so fixing a flagged value in a later commit does nothing

Found while fixing an ops CLI that printed its RPC URL, API key included, on every run
([#648](https://github.com/fomotsar-commits/tegridy-farms/pull/648),
[#646](https://github.com/fomotsar-commits/tegridy-farms/pull/646)).

**The belief:** if gitleaks flags a string in a PR, a follow-up commit that removes it
turns the check green. **It doesn't.** `gitleaks-action` scans the PR's whole **commit
range**, not the final tree, so the commit that added the string stays in range and the
check stays red. Measured on #646: a random-looking 32-character test fixture was flagged
as `generic-api-key` on entropy alone. It went green only after the branch was rewritten
so the string never entered history, then force-pushed.

What to do instead:

- **Make fixtures dull on purpose.** `FAKEKEYFAKEKEYFAKEKEYFAKEKEY0000` is the same length
  as a real key and exercises the same code, but has low entropy and says what it is.
  Shannon entropy in bits per character, computed with `-Σ p·log2 p`: the flagged random
  fixture **5.00** (gitleaks reported the same 5.0, so this is the number it uses),
  `0123456789abcdef` ×2 **4.00**, `FAKEKEY…0000` **2.50**, `deadbeef` ×4 **2.16**.
  Repeating a string does not lower its entropy; using fewer distinct characters does.
- **Don't add a `.gitleaks.toml` allowlist entry for a value you made up.** That allowlist
  applies to every rule, and the file itself says entries should get deleted, not added.
- **To rewrite without losing commit messages:** `git rebase <base> --exec '<fix> && git
  commit --amend --no-edit'`. Then check both ways — `git log -S` only looks at diffs, so
  also `git grep` the tree of every commit in the range.
- **Delete the safety tags afterwards.** A local tag that still points at a pre-rewrite
  commit keeps the string reachable, and this repo's origin does carry tags, so
  `push --tags` would ship it. Don't bundle the tag before deleting it, the usual habit
  with a ref: the bundle keeps exactly what the rewrite removed.
- **Check whether a value already passed the gate.** If a merged commit added it, the rule
  accepts it. The ladder program id (44-character base58, entropy 4.74, not allowlisted)
  came in through #579, so repeating it is safe.

The flip side: because it only scans new commits, gitleaks **cannot** see a secret that
was committed before the scanner existed. An Etherscan key committed in `9b59e212` is
still readable in this public repo's history, and the gitleaks check is green.

### A test that shows a vulnerable pattern by running it gets flagged for that pattern

A test was added to stop anyone reverting a URL check to a substring match. It contained
the substring match, to show that it passes on an attacker's URL. CodeQL flagged that line
as a new high-severity `js/incomplete-url-substring-sanitization` alert (#646, `:206`) — one
commit after the original instance was fixed. CodeQL reads the line, not the purpose.

Fix: describe the weak form in a comment; don't execute it. The test kept its teeth —
reverting the helper to a substring check still fails it (2 of 17 tests in
`scripts/lib/redact-url.test.mjs`, 5 of 14 in the `frontend/` copy). Unmeasured: whether
vitest's `expect(x).toContain(host)` form triggers the rule the way `x.includes(host)`
does. Nobody here has a CodeQL run on that form.

### The `\b` trap in the 2026-09-12 entry happened again — so don't build the regex at all

The 2026-09-12 entry below explains the mechanics: in a template literal `\b` is a
backspace character, not a word boundary, and writing a file through a shell heredoc can
eat a backslash, so `\\b` arrives as `\b`. It recommends `String.raw`. That entry existed,
and the trap still hit again here in a new form.

A check meant to find every place a script printed an endpoint built its regex out of the
variable names it had just found:

```js
const wanted = new RegExp(`\b(?:${idents.join('|')})\b`);   // written as \\b
```

It matched nothing, so it reported **zero** problems against four scripts that were
definitely printing a key.

The better fix is not to escape it correctly. It is to not build a regex at all: split the
expression into identifiers and look each one up in a `Set`.

```js
const mentions = (expr.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).some((t) => idents.has(t));
```

That is right for a second reason too. `$` is allowed in a JavaScript variable name and is
a special character in a regex, so a pattern built from names can be wrong however
carefully it is written. It also stops `rpc` matching inside `rpcTimeoutMs`.

Running the mutation check **first**, against the known-bad code, is what caught it.
Written after the fix, the check would have passed for a reason that looked right, and
guarded nothing.

### A mutation check that silently didn't happen looks exactly like a pass

To prove a test has teeth, you break the code on purpose and expect the test to fail. Here
one of those deliberate breaks was eaten by shell quoting, so the file didn't change — and
the suite reported **17 of 17 passing**. That result proved nothing, and it looked the same
as a real pass. Before believing it, grep for the line you broke and confirm it changed.

Re-run the mutation check after **deleting** an assertion too, not only after adding one.
Removing a line is exactly when a test can quietly stop proving anything.

### "Was the leaked key rotated?" can be answered without the ledger, and without seeing either key

`docs/SECRET_ROTATION.md`'s incident log was empty. That looks exactly like "never rotated",
and it could also mean "rotated, not written down". It can't tell you which.

Compare fingerprints instead: `sha256` the value in the old commit
(`git show '<commit>^:<path>' | grep … | sha256sum`) and the value configured today, and
compare the two digests. Neither key is printed. Measured on the Etherscan key: 34
characters in both, different digests, so it **was** replaced. That still doesn't say
whether the **old** key was revoked at the provider — that's a separate check.

### A vitest rooted at `frontend/` can import files above its root

`frontend/vitest.config.ts` stresses that nothing above `frontend/` can be **collected** as a
test. That's true, but it's easy to read as "nothing above `frontend/` can be used". A test
under `frontend/` importing `../../../scripts/lib/caller-credit.mjs` resolved and passed.
So one helper at repo-root `scripts/lib/` can serve both trees.

### An ignore file that starts with `*` and then `!dir/**` needs globs, not names

`.vercelignore` starts with `*`, then re-includes `!frontend` / `!frontend/**`. The last
matching line wins, so everything under `frontend/` is uploaded **unless a later line
excludes it**. It excluded `frontend/.env` and `frontend/.env.local` by name, so
`.env.production`, `.env.staging` and every other env file would have been uploaded with
their values by a repo-root `vercel --prod`. A test that applies the file's own rules to
ten env filenames found eight uploaded. Fixed with `frontend/.env*`.

## 2026-09-20 — a `waitFor` on a string that renders outside the async state is not a gate

`HeatCard.test.tsx` → `element D … paints the room's row FIRST and the whole flame
SECOND` went red on [#640](https://github.com/fomotsar-commits/tegridy-farms/pull/640),
a PR whose diff was **one markdown file**, and passed on a plain re-run:

```
AssertionError: the scoped number never rendered: expected -1 to be greater than -1
```

The test waited on the card's heading before reading `container.textContent`:

```ts
await waitFor(() => expect(screen.getByText(/Your held time in PEPE/i)).toBeTruthy());
const text = container.textContent ?? '';
const scoped = text.indexOf('338.21');           // -1 under load
```

That heading renders **outside** `state.kind === 'ready'` — on purpose, so a cold
room still names what it reads. It is on screen from the first frame, so the
`waitFor` returned on its **first poll**, with no relation to the read resolving.
The two strings it then compared live only in the ready branch.

### The rule

**The gate string and the asserted strings must come from the same render branch.**
A gate that renders unconditionally cannot tell you an async read has landed. When
you write `waitFor`, ask *which* branch prints the string you are waiting on — not
merely whether that string eventually shows up.

Corollary for `findBy*` / `waitFor` over `container.textContent`: waiting for
**each string you are about to index** is self-checking, because a string that only
exists post-read doubles as the read's own completion signal.

### `-1` from `indexOf` is a race tell, not a defect

An ordering assertion that fails `expected -1 to be greater than -1` has not caught
a mis-ordering — it never rendered the thing at all. Same family as
the repo's recurring "an unreadable value must not read as fine": the sentinel for *absent* got
compared as if it were a *position*. Ordering tests over `indexOf` should establish
presence inside the wait, then compare positions outside it, so the two failure
modes cannot be confused in the log.

### A negative assertion behind a false gate passes vacuously — forever

The sibling test, one function down, had the identical gate and was worse for it:

```ts
await waitFor(() => expect(screen.getByText(/Your held time in PEPE/i)).toBeTruthy());
expect(container.textContent).not.toMatch(/Where the .* comes from/i);
```

An **absence** is satisfied by an empty room. Mutating the component so `scopeTo`
stopped applying — the exact defect the test names — left it **green**, because the
gate returned before anything rendered. It never had a chance to fail. Unlike the
ordering test it did not flake, so nothing ever drew attention to it.

**Do:** whenever a test asserts `not.toMatch` / `not.toContain` / `queryBy… toBeNull`,
check what proves the DOM was *populated* at that moment. An absence assertion needs
a positive gate that the same render produced.

### Reproducing a CI-only async race locally: 250ms, not 0

`setTimeout(…, 0)` on the mock's resolve did **not** reproduce it — RTL's `waitFor`
runs inside React's async `act`, whose microtask flush drains a 0ms timer before the
callback's first poll. The suite stayed 59/59 green and the race looked unreproducible.

A **real** delay does it, deterministically:

```ts
h.fetchHeat.mockImplementation(
  () => new Promise((resolve) => setTimeout(() => resolve(wireReading({ … })), 250)),
);
```

250ms is far past any microtask flush and well inside `waitFor`'s 1000ms default, so
a *correctly* gated test still passes while a falsely gated one fails every run. This
turns "flaky on a loaded runner" into a deterministic local red — which is what makes
it mutation-checkable at all.

### Mutation-check the race and the defect *together*

The cell that matters is not "does the fix stop the flake" but **"does the fix still
catch the real defect on a slow runner"**:

| # | Mutation | Pre-fix | Post-fix |
|---|---|---|---|
| 2 | swap render order | RED (ordering) | RED (ordering) |
| 3 | read resolves 250ms late | **RED (`-1`)** | green |
| 4 | **2 + 3** | RED (`-1` — *wrong reason*) | **RED (ordering)** |
| 5 | `scopeTo` stops applying | RED | RED |
| 6 | **5 + 3** | **green — vacuous** | RED |

Cells 4 and 6 are the ones a "just make it wait longer" fix fails. A fix that made
the race disappear by loosening the assertion would show green in cell 4, and that
is indistinguishable from a fix that works — unless you run the defect mutation and
the race mutation *at the same time*.

## 2026-09-20 — a backgrounded build reads the worktree it finds, not the branch you launched it from

**Believed:** a long `npm run build && playwright test` started in the background is
pinned to the branch that was checked out when it started, so it is safe to switch
branches in the same worktree while it runs and come back for the result.

**Measured:** it is not. The build and the test run are ordinary processes reading
files off disk when they get to them, and a worktree has exactly one checkout. A
build launched on a branch carrying a new `vercel.json` alias, with `git checkout`
of a docs branch run a minute later, produced `dist/llms.txt` at **4,052 bytes** —
the *other* branch's output — where the correct build is **4,077**. Nothing warned;
the build exited 0 and the e2e run that followed would have reported a clean pass
for a tree nobody intended to test. The 25-byte difference was the only tell, and
only because that file's size was already known.

This is the same hazard as "your worktree is not private", with the sharp edge
pointed inward: the other session that moves your files can be *you*, one tool call
later. The e2e result is the dangerous half — a green run against the wrong tree
reads exactly like a green run against the right one.

**Do:** while a build or test is running, treat that worktree as owned by it —
no `checkout`, no `stash`, no rebase. Work that must happen meanwhile goes in a
second worktree, or waits. Cheap insurance when it matters: have the job print one
fact that identifies the tree it actually built (a byte count, a grep -c of the
change under test) as its first line of output, so a wrong-tree run announces
itself instead of passing quietly.

---

## 2026-09-19 — a grep of `dist/` proves a string is absent, never that a link is

**Believed:** to prove the site ships no community link, grep the built output for
`discord.gg` and `t.me/`. A clean grep means clean.

**Measured** on a full `npm run build` of trunk `34095814`. `discord.gg` really is absent
from every file in `dist/`. `t.me/` is not: `dist/assets/CurveTradePanel-*.js` contains
`function U(e){return` `` `https://t.me/${e}` `` `}`. That is
`telegramUrl()` from `src/lib/launcher/curveIdentity.ts:274` — a URL **builder** for a
launched token's own declared handle, read from that token's Arweave identity metadata and
rendered only when a token declares one. No venue handle ships, and the handle is filtered
by `cleanHandle()` first (`curveIdentity.ts:116`, and `cleanWebsite` accepts `https:` only),
so the grep hit is not a defect. But it is a hit, and "zero `t.me` strings" was the wrong
claim to make from a grep.

The inverse of the same mistake sits in the invite scanner that answer eleven built.
`shippedFiles()` (`scripts/lib/discord-invites.mjs`) picked files by directory and
extension, and so read `public/*.svg` but not `public/sample-collection.csv` — a file users
download from the upload wizard (`Step2_Upload.tsx:262`) — and read `scripts/llms-txt.mjs`
but not `scripts/addresses.json`, the ledger that script renders into `dist/llms.txt`. The
writer was scanned while one of its two text inputs was not. Both are now in the scan, each
mutation-checked red.

**Do:** when the question is "does this ship", grep to find candidates and then **read what
builds the string** — a template literal in a minified bundle is one identifier away from
looking like a link. And when choosing a scan's surface, include a file because its text
reaches a user, not because of the folder it lives in: the inputs to a generator ship just
as surely as the generator does.

---

## 2026-09-18 — two copies of one poller under fake timers never overlap, so neither is ever stale

**Believed:** mounting a polling hook twice in one jsdom window (two `renderHook`s sharing
its localStorage) and advancing fake timers is a fair two-tab test. Both intervals are due
at the same instant, so each copy acts on what it read before the other one wrote.

**Measured** while writing the cross-tab test for `useLimitOrders` (PR #629), with the RPC
mocks resolving immediately. `vi.advanceTimersByTimeAsync` runs due timers one at a time and
drains the microtask queue between callbacks. Tab A's whole interval callback (price read,
lock claim, send, receipt, mark filled, lock released) therefore finished before tab B's
callback started, although B was due in the same millisecond. On the old hook the first poll
fired one order **twice**: B acted on the lock A had just released. With the fix, B re-read
storage right after A's write and was never stale when it wrote. As a result, the test built
to catch a stale tab's whole-list save ("creating an order in a stale tab does not put a
filled order back to active") **passed with `createOrder` reverted to exactly that save**,
the mutant it existed to kill.

**Do:** mount the second copy half an interval later (`renderHook`, then
`advanceTimersByTimeAsync(interval / 2)`, then `renderHook`). Each step is then one copy's
check (A, B, A, B), and between a check of A's and B's next one, B holds whatever it last
read. With that stagger the same test failed on the mutant, as intended. Run the mutant
against the staggered version to prove the window exists. Separately, jsdom fires no
`storage` event for a write in the same window. Two mounted hooks never hear each other,
which is the right worst case for a guard, but a `storage` listener then needs its own test
that dispatches the event by hand.

---

## 2026-09-18 — a record saved before the wallet answers cannot know its on-chain index, and a OneDrive file is not a file to `Dirent.isFile()`

### The chain numbers only what lands

**Believed:** a contract that assigns an index on push (`commitIndex = list.length`, then
push) gives this browser's Nth commit index N-1, so the client can save the index along
with the salt. The source said so in a comment ("index ≈ current length") and promised a
reconciliation ("we'll reconcile by reading `voterCommits.length` on next refetch") that no
code ever carried out.

**Measured** (PR #628) against a model of exactly the checks the contract's reveal makes:
index in range, not revealed, hash at THAT index. Commit, reject it in the wallet, then
commit again and let the second one land. The page offered two reveals and the model
rejected both: `['CommitHashMismatch', 'CommitNotFound']`. The rejected commit's record
took index 0, so the real commit was saved at index 1 while the chain holds it at 0. A
commit made from another browser, or a cleared list, shifts the numbering the same way.

**Do:** persist the content (salt, pair, power, hash), never an identifier the chain has
not assigned yet. Resolve the identifier by matching the content against the chain
(`voterCommitCount`, then every `voterCommits(i)`, and match on the hash), and offer nothing
while any slot is unread, since an unread slot may be the one the record lives at. Keep
every saved record: a record whose commit has not landed can mean still pending,
rejected, or reverted, and the chain cannot tell those apart until the commit window
closes (the same rule as #616, from the other side).

### A OneDrive placeholder is a symlink to Node

**Believed:** two docs-honesty tests going red locally with "FAQ.md is not being scanned"
meant a scanner or path regression.

**Measured** in a worktree under OneDrive: `Get-Item FAQ.md` reported
`Archive, ReparsePoint`, and `fs.readdirSync(root, { withFileTypes: true })` returned it
with `isFile() === false`, `isSymbolicLink() === true`. `ROADMAP.md` was the same;
`README.md` and `CONTRACTS.md` in the same directory were plain files. Both scanners keep
`e.isFile()` entries only, so they dropped exactly those two files. A Linux CI checkout has
no reparse points, so CI stays green. The scanners' must-scan lists are what turned a silent
skip into a loud red.

**Do:** before trusting a local red from a test that enumerates files, check the attributes
of the files it names. A scanner that must not miss a file should `statSync` the entry,
which follows the link, rather than trust the dirent type; and it should carry a must-scan
list, as these do.

---

## 2026-09-18 — a deploy receipt's CREATE transactions are not the list of contracts it created

**Believed:** the top-level `transactions[]` of a Foundry broadcast receipt
(`contracts/broadcast/<Script>.s.sol/<chainId>/run-*.json`) whose `transactionType` is `CREATE`
or `CREATE2` list every contract the run deployed. A registry guard that walks them would then
have a closed world.

**Measured** (newest receipts on trunk `f0e3ca7b` + PR #614, fixed in PR #626): a contract
created *inside* a transaction never appears as a top-level CREATE. Foundry lists it under that
transaction's `additionalContracts` (`transactionType`, `contractName`, `address`, `initCode`),
whatever the parent's own type is. There were 6 on mainnet and 4 on Base. Five of the six
mainnet ones had no registry row, and two of those were **live**: the clone templates that the
TegridyLaunchpadV2 and TegridyNFTPoolFactory constructors deploy and expose as immutable
`dropTemplate()` / `poolImplementation()`, which every clone DELEGATECALLs. On Base, the four
role Safes from `createProxyWithNonce` were the chain's **only** creations, so the guard printed
"read ZERO Base CREATEs". That reads as "no receipts". The receipts were there; the guard had
not read them.

### Where nested creations come from

- A constructor that deploys a helper (`dropTemplate = address(new TegridyDropV2())`) nests it
  under the parent's CREATE.
- A factory call (`createPair`, `createProxyWithNonce`) nests it under a CALL.
- `contractName` is `null` when Foundry has no artifact for the created code. That was all four
  Safe proxies, so a scan keyed on names would drop them too.

### A nested address cannot be keyed by (from, nonce)

#614 re-derives each top-level CREATE from its sender and nonce, because a receipt's labels can
be wrong. That does not carry over. A CALL child's creator nonce lives in the creator's on-chain
history, and a CREATE2 salt lives in the call's arguments. The one derivable case is a
constructor's children: a contract's nonce starts at 1 (EIP-161), so its first child is
`getContractAddress({ from: parent, nonce: 1n })`. That held for all four here. For anything
else, read the chain: each parent's getter returned its child's address.

### A non-zero exit is not a killed mutant

Two of my own mutations of the "unreadable nested entry fails" branch misled me. The first
changed only the `fail(...)` message and left the call in place, so the self-test stayed green,
correctly, and looked like a missing test. The second turned `fail(` into `void (` in front of a
trailing comma. `void (x,)` is a **syntax error**, so the verifier and the self-test both exited
1 without printing a single FAIL line, and that looked like a kill. A mutant is killed only when
the run prints the assertion you expected it to trip.

---

## 2026-09-18 — a bare `vite build` ships every derived-image URL and none of the images

**Believed:** `vite build` is the build, and `npm run build` only wraps it in checks.

**Measured** in a fresh worktree of trunk `c446ac67`, where `frontend/public/_derived/` does not
exist because it is gitignored: `npx vite build` exits 0. The shipped JS still computes
every `srcset` from `src/lib/artDerivatives.generated.json`, which IS committed, so the page
asks for images that were never generated. The nav logo is the first casualty: its 128 px
candidate, `/_derived/art/island-mark-png-128.webp`, is in no output directory. Served by
`vite preview`, that URL answered **200 `text/html`** (the SPA fallback handing back the app
shell), not a 404. Jungle Bay Island's answer eleven reported a 404 for it; its answer
twelve withdrew that — the island saw the broken-image glyph and inferred the code without
reading the status. So there is one reading, not two, and it is the 200: the failure nothing
that checks status codes notices. Re-measured 2026-09-19 on a full `npm run build` of trunk
`34095814`: the real derivative answers `200 image/webp`, while any missing asset path
(`/_derived/...`, `/assets/...`, `/art/...`) answers `200 text/html`.

`npm run build` avoids it only by order: `generate-image-derivatives.mjs` runs first, and
`verify-dist-derivatives.mjs` runs last. Pointed at the bare build, that gate exits 1 and
lists all 1,314 advertised candidates as missing, so it is the check that knows. Its header
records the production outage this shape has already caused once (20 of 27 homepage
images, when the generator ran as a skipped `prebuild` hook). Production builds with the
full chain, so production is fine.

**Do:** build with `npm run build`, never `vite build` alone, for anything that will be
looked at: a preview, a probe, a reviewer's box. If a build has to be hand-rolled, run
`node scripts/generate-image-derivatives.mjs` before it and
`node scripts/verify-dist-derivatives.mjs` after it.

---

## 2026-09-17 — a replaced transaction's receipt wait resolves, and a speed-up looks exactly like a cancel

**Believed:** when a wallet cancels or speeds up a pending transaction, viem's
`waitForTransactionReceipt` throws `TransactionReplacedError` (ethers did), so a success
receipt means your transaction ran. And if it does resolve instead, checking
`receipt.transactionHash === hash` is the fix.

**Measured** against @wagmi/core 3.6.5 / viem 2.56.5, driving the real action and the real
`useWaitForTransactionReceipt` hook through a scripted EIP-1193 node: the submitted hash has
no receipt, `eth_getTransactionByHash` still returns it pending, and the next block holds a
same-sender, same-nonce transaction whose receipt is success. All three reasons (`cancelled`,
`repriced`, `replaced`) RESOLVE the wait with the replacement's receipt: `status: 'success'`,
the replacement's hash. Nothing throws. viem 2 does not define `TransactionReplacedError` at
all. The reason arrives only through `onReplaced`, which wagmi's hook forwards to the action
and leaves out of its query key.

A wallet cancel is a 0-value send to yourself, so its receipt is a success, and every surface
that read `isSuccess` confirmed the action that was cancelled.

### The hash check is wrong the other way

A speed-up (same to, value and calldata, more gas) resolves exactly like a cancel: another
hash, a success receipt. It is the same call, and it ran. Calling it "did not happen" invites
a resend that pays twice, and speed-up is the most common replacement there is. Nothing in
the receipt tells the two apart; only `onReplaced`'s reason does.

**Do:** pass `onReplaced` on every wait and record the reason per submitted hash. Count a
foreign receipt as success only when the reason is `repriced`. With no recorded reason, say
you can't tell, and never "it did not happen". Bind any proof or stored record to the hash
that mined, not the one you submitted: a proof link to a hash that was sped up points at a
transaction that never mined. (PR #622.)

---

## 2026-09-17 — `git log -G` dates code by its first *mention*, comments included

**Believed:** the oldest commit that `git log --all --reflog -G '<call>' -- <file>` returns
is the commit that introduced the call.

**Measured:** while re-verifying `MICROSCOPE_REMEDIATION_2026_05_01.md` (#620), row H5
("restaking calls `staking.kick(tokenId)` first") was checked this way.
`-G 'staking\.kick\('` on `TegridyRestaking.sol` put the oldest hit at `f9a3656b`
(2026-05-02). That commit only adds a *comment* that mentions `staking.kick(tokenId)`. The
first real call, `try staking.kick(info.tokenId) {} catch {}`, landed in `86b69f70` on
2026-05-16, two weeks later. `-G` greps every changed diff line, comments and NatSpec
included, and this repo's comments routinely name the fix they anticipate.

The same trap works in reverse. `_jsonEscape` appears in history only inside a comment
saying it was removed; no commit ever defined it.

**Do:**

- Treat the first `-G` hit as a lead, then open its diff.
- When the question is "did this code ever exist, and when", anchor the pattern on code
  shape (`-G 'try staking\.kick\(info'`) rather than on a name.
- For a negative claim, extract the function body from every historical version and grep
  it with comments stripped: `git log --all --reflog --format=%H -- <path>`, then
  `git show <sha>:<path>`, then a brace-matcher. That disproved H4's "the transfer path
  decays" across all 124 versions of `_settleRewardsOnTransfer`, where a name grep could
  only have said "no hits".

---

## 2026-09-17 — viem returns the revert that wagmi throws, and a receipt waiter outlives the component that started it

**Believed:** a `catch` around a receipt wait means the transaction failed; and a hook that
settles its own state when the receipt arrives keeps that state right, because the wait
lives in the hook.

**Measured** on the DCA and limit-order keepers and three create flows (PR #618), against
the installed viem 2.56.5 source and pre-fix vitest runs. Both were wrong.

### Same function name, opposite contract

`useWaitForTransactionReceipt` (wagmi) THROWS on a reverted receipt, so its `isError` is two
facts. `publicClient.waitForTransactionReceipt` (viem, called directly) RETURNS the reverted
receipt; its promise rejects only when no receipt could be read (180s default timeout,
`TransactionReceiptNotFoundError`, transport). So in a `publicClient` catch nothing at all is
known about the transaction. Five sites called that catch a failure. Two were keepers that
then released the schedule or order; one unread receipt produced a second swap on every
poll (3 in 3 polls, measured).

**Do:** in a `publicClient` wait, the `status !== 'success'` branch is the revert and the
catch is "unread". Decide per site what state is safe while unread, and never let it mean
"try again automatically".

### Settling state after an await: unmounted means never

viem waits up to 180 seconds. A user who leaves the page in that time unmounts the hook, and
a functional `setState` on an unmounted component is dropped without running, including any
`localStorage` write placed inside the updater. The DCA hook's success path saved that way,
so a swap that landed was never recorded, and the next mount found the schedule due again.
A vitest that unmounts before rejecting the wait reproduces it.

**Do:** record the in-flight hash when the wallet returns it, and write it through storage
first, then apply the same change to state by id. Settle keyed on that hash, so the old
waiter coming back after a re-read (or a second tab) cannot count it twice.

---

## 2026-09-17 — a registry section the verifier never iterates is unchecked, whatever `expect` it carries

**Believed:** a registry row that carries `expect: { type: "contract" }` is asserted. The
verifier runs offline on every push and `--onchain` daily, both are green, and the fix for a
missed section is to add its name to the loops.

**Measured** (PR #614; the pre-fix mutation was run first, on trunk's verifier). Every check
walked `reg.solana` and `reg.ethereum` by name. In a `base` row, each of these exited 0: a
truncated address, a non-address, two rows on one address, `expect.type: "contarct"`, a deleted
`role`. A new top-level `"arbitrum"` array holding `0xdead…beef` also exited 0. The 31 rows in
`base` and `robinhood`, 10 of them with `expect` blocks, had never been read by anything. The
green was real. It covered fewer rows than the file holds.

Adding the names to the loops got two things wrong. Both showed up only once the rows were
actually read:

- **A uniqueness check keyed on the raw value false-positives across scopes.** A CREATE address
  depends only on (deployer, nonce). So `0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3` is three
  different contracts on chains 1, 8453 and 4663, and CREATE2 twins repeat by design. Keyed by
  (chain, address), the widened check found 9 real duplicates: the same L2 Safe registered in
  `base` or `robinhood` and again as an `ethereum` row with `chainId: [8453, 4663]`. Folding the
  copies together turned up two statuses that said "nonce()==0 everywhere". On Base the nonces
  were 5 and 1.
- **Reading a section can still mean skipping it.** `mainnet.base.org` answered batches of 5 and
  10 `eth_getCode` calls. A batch of 16 got back a single
  `-32014 maximum 10 calls in 1 batch` object. With 20 Base pairs in the read, every Base row came
  back NOT CHECKED. That was correctly UNKNOWN rather than ABSENT, and exactly as inert as never
  reading them. The old read held only 4 Base pairs, so it never hit the cap. CI reports 20 of 127
  skipped as a *partial* warning, so the job stays green.

**Do:** when a checker names the sections it reads, close the set. Fail on any top-level key it
does not handle, so the next section added fails loudly instead of passing silently. Key
uniqueness by the scope it must hold in (here, the chain), not by the raw value. After widening a
read, check the NOT CHECKED count *for the new scope*, not the total.

---

## 2026-09-17 — a ledger row that holds on trunk today can still be false: read it at the ledger's own commit

**Believed:** a remediation ledger row saying "Closed" can be checked against today's
trunk. If the property it names holds on trunk, the row is right.

**Measured** re-checking the staking and LP Medium rows of
`.audit_101/MICROSCOPE_REMEDIATION_2026_05_01.md` (#608). Three rows each described a
specific change. None of those changes exists on any ref, reflog or stash, and a trunk-only
check passes two of the three rows anyway:

| Row | Ledger's closure | At the ledger's own commit `7e7a4a15` | Trunk today |
|---|---|---|---|
| M-S1 | `emergencyWithdrawPosition` gains `updateReward` | still open | holds, via a different fix (`d6b1f5b1`, next day) |
| M-S5 | `notifyRewardAmount` drops its `duration` argument | still open | holds, via a different fix (`f89c97a7`, next day) |
| M-S7 | floor division becomes ceiling division | still open | still open |

The ledger was committed at 23:31 the night before the fixes that actually closed M-S1 and
M-S5 landed. "The property holds today" gets two rows right while their descriptions stay
fiction. A later session trusting the M-S1 row would then believe `updateReward` guards the
path. It doesn't: three other pieces do, and the committed suite doesn't see them. With all
three reverted, all 554 tests in the 16 suites that deploy and pause staking still pass.

**Do:** check a "Closed" row at three points, not one:
1. **The ledger's own commit:** `git show <ledger-commit>:<file>`. Was the row true when written?
2. **All history:** `git log --all --reflog -G '<pattern>'`. Did the described change ever exist?
3. **Trunk and the deployed build:** does the property hold now, and *by what*?

If (3) holds by a different mechanism than the row names, rewrite the row. The mechanism is the
thing the next reader will rely on.

### A commit message's "no code change" is a claim too

`d6b1f5b1`'s message says DS2-04 "documented the pause-aware accumulator design choice in
NatSpec; no code change". Its diff adds the `&& !paused()` guard, a pre-pause
`_accumulateRewards()` call and the `unpause()` reset: the three lines that actually close M-S1.
Read `git show <c> -- <file>`, not `git show -s`.

### `git log -G` is always an extended regex

`git log -G 'notifyRewardAmount\(uint256 [a-z_]+, *uint256'` matched three commits. Under a
basic regex, `\(` would open a group that never closes, which is an error, and `+` would be a
literal plus sign. So `-G` parses the pattern as an extended regex whether or not `-E` is given,
and `\(` there is a literal parenthesis.

### Under via_ir, `vm.warp(block.timestamp + dt)` can reuse a stale timestamp

A test body that called `vm.warp(block.timestamp + ...)` three times paid out exactly the
pre-unpause share and zero for the day after unpause. That is only possible if the last warp
landed at or before the unpause timestamp, i.e. that `block.timestamp` read returned an earlier
value. The same test paid the exact expected amount once every warp went through a storage
clock seeded from a literal (`uint256 t = 1_000_000;` then `t += dt; vm.warp(t);`), which never
reads `block.timestamp`. The failure was a plausible number, not a revert. Seed the clock from a
literal, not from a local copy of `block.timestamp`, or read time with
`vm.getBlockTimestamp()`, which several suites here already do.

---

## 2026-09-17 — a rule moved into a tested helper is not pinned where it is called

**Believed:** once an honesty rule is a pure, well-tested function, a page that calls it
is covered. If someone put the page's old inline logic back, the helper's tests would
catch it.

**Measured** while porting `verdictFromReads` (#597), the rule that keeps "couldn't read
the locker" apart from "this token hasn't graduated". It has 6 unit tests, and 6 mutations
of the helper's body were each killed. Then the *caller* was restored verbatim to its
pre-fix form: `LaunchPage.tsx`'s inline `if (!stream) → 'not-graduated'`, with the helper
left intact. **All 31 tests in the helper's file stayed green.** Only a source-level pin on
the call site (`launchReattestVerdictWiring.test.ts`) went red. A helper test proves the
rule exists. It says nothing about whether anyone calls it.

**Do:** make "restore the caller verbatim" its own mutation, separate from mutating the
helper. When the caller can't be rendered cheaply (an unexported component, or a path
that needs a connected wallet), pin the call site in source, as
`launchPriceWiring.test.ts` does. Strip comments before matching, so prose about the old
bug can't satisfy the pin.

### Incidental: an "unknown" message can make the opposite claim

The rescued copy for the new unknown state said the gap "says nothing about this token",
then ended with "the fee split committed at launch is unaffected and still on-chain". That
asserts a launch split exists for whatever address was pasted, including tokens that
never came through the rail. Fixing a false *negative* claim is exactly when a false
*positive* one slips in. Check both directions: does an unknown state avoid the negative
claim, and does it avoid asserting anything positive about the input?

---

## 2026-09-17 — wagmi reports a revert as an ERROR, so `isError` is two facts that need opposite advice

**Believed:** `useWaitForTransactionReceipt()` hands back a reverted transaction the way the
JSON-RPC does, as a receipt on `data` with `status: 'reverted'` and `isSuccess: true`, and
`isError` means the receipt could not be read. Every money hook here was written to that:
revert branches keyed off `isSuccess && data.status !== 'success'`, and `isError` toasted
"Transaction failed". A unit suite mocked exactly that shape and stayed green.

**Measured** by driving the installed `@wagmi/core` 3.6.5 `waitForTransactionReceipt` against
a local anvil through a switchable JSON-RPC proxy (one scratch script, each case a real
mined transaction):

| Real outcome | What the action throws |
|---|---|
| revert | `CallExecutionError` → `ExecutionRevertedError` |
| revert, state changed afterwards | `CallExecutionError` (the replay is pinned to the tx's own block) |
| revert, replay `eth_call` slower than 10s | bare `Error('unknown reason')` |
| success, `eth_getTransactionReceipt` → `{result: null}` | `TransactionReceiptNotFoundError` |
| **revert**, `eth_getTransactionReceipt` → `{result: null}` | `TransactionReceiptNotFoundError` |
| success, receipt/tx reads HTTP 500 | `HttpRequestError` |
| revert, `getTransaction` 500s during the replay | `HttpRequestError` |
| node unreachable, or 429 on every call | nothing: **never errors**, loads forever |

On `status === 'reverted'` wagmi does not return the receipt. It replays the transaction with
viem's `call` to recover a reason and **throws**. So no revert ever reaches `isSuccess`, and
every revert branch keyed off it was unreachable code. A real revert went down the `isError`
path and said "Transaction failed" (or, in `useSwap`, nothing, with the in-flight latch left
set). The unit mock encoded the wrong belief, so it could not notice.

Three consequences that transfer to any wagmi app:

1. **Split `isError` by error type, and default to "unreadable".** A `CallExecutionError`
   can only come from wagmi's revert branch, because viem's receipt waiter never calls
   `call`. Everything else is "we could not read it". That includes the bare `Error` in
   row 3: it also comes from the revert branch, but a bare `Error` is a shape anything can
   throw. The default matters because the two mistakes are not symmetric: calling an
   unreadable success "reverted, try again" makes the user pay twice, while calling a
   revert "unconfirmed, check the explorer" costs them one click.
2. **"Unreadable" copy must not guess the outcome.** Rows 3, 5 and 7 are real reverts that
   land on the unreadable side. "It may well have succeeded" is false for them. The honest
   sentence is "we can't tell whether it went through; check before you resend".
3. **An outage is not an error at all.** With wagmi's default `timeout: 0`, a node that is
   simply down never rejects: the hook sits in `isLoading` forever. Any UX that waits for
   `isError` to release a spinner or a latch waits forever.

**Do:** pin the library's error shapes with a test that runs the REAL action against a
scripted EIP-1193 provider (`custom({ request })`, `retryCount: 0`, `pollingInterval: 20`
runs a whole receipt wait in ~16ms), not a hand-built mock of the hook. A mock of the hook
repeats whatever the author believed. Then pin the hooks against both shapes.

### A ref latch leaves the button enabled, so `toBeEnabled` cannot see a dead CTA

`useSwap` guards `executeSwap` with `isPendingRef`. Left set, it does not re-render, so the
Swap button stays enabled and every click returns at the guard's line. The rescued e2e leg
asserted `toBeEnabled()` after the fault, and that passes on the broken code. **Do:** assert
the click reaches the chain. Read the fork's send count before the click, click, and poll
for it to grow. In unit form, call the action twice and count `writeContract` calls.

---

## 2026-09-17 — `gh`'s `--json files` stops at 100 files, and says nothing

**Believed:** a sibling-PR check ("does any open PR touch the files I touched?") is one
query: `gh pr list --json number,files`, filtered on your paths. An empty result means no
overlap.

**Measured** (gh 2.92.0, PR #591 in this repo): `changedFiles` is **113**, and `.files` has
**100** entries, from both `gh pr view 591 --json files` and `gh pr list --json files`.
There is no warning, no truncation marker and no flag to page it. `frontend/src/pages/TradePage.tsx`
was one of the 13 dropped, so an open-PR filter for that path came back **empty** while
#591 changes it. `gh pr diff 591 --name-only` listed all 113, and the REST endpoint
`pulls/591/files?per_page=100&page=2` returned the missing 13.

The PRs this hides are the big ones, which are the likeliest to overlap with you.

**Do:** treat `.files` as a sample whenever it is shorter than `changedFiles`, and re-read
those PRs in full:

```bash
gh pr list --state open --limit 100 --json number,changedFiles,files \
  --jq '.[] | select(.changedFiles > (.files|length)) | .number' |
  while read -r n; do gh pr diff "$n" --name-only | sed "s/^/#$n /"; done
```

---

## 2026-09-17 — "element(s) not found" on `getByRole(role, { name })` does not say which half failed

**Believed:** when `getByRole('dialog', { name: /select token/i })` fails with
`element(s) not found`, the dialog did not open.

**Measured** while mutation-checking an a11y test (a dist copy with the dialog's
`aria-labelledby` pointed at an id nothing renders): the failure text was identical to a
dialog that never opened. The dialog **was** open. The locator matches role and name
together, so an unnamed dialog is "not found" too. A mutant that fails for the wrong reason
proves nothing about the assertion it was aimed at.

**Do:** read `error-context.md` in the test's output directory before trusting the
reason. Its page snapshot prints a named node as `- dialog "Select Token":` and an unnamed one as
`- dialog:`. Here it showed `- dialog:` directly above `- heading "Select Token"`: open,
titled, unlabelled. That settles it in one grep, with no rerun.

---

## 2026-09-17 — a Foundry broadcast's `hash` can belong to a different transaction of the same run

**Believed:** in `contracts/broadcast/<Script>.s.sol/<chainId>/run-*.json`, `transactions[i].hash`
is the hash of `transactions[i]`. If that hash exists on chain, succeeded, and sits in the
recorded block, the entry is proven.

**Measured** while verifying receipts rescued from abandoned branches (PR #598). For every
entry I fetched the on-chain tx at the same `(from, nonce)`, choosing only among the file's own
recorded hashes, then compared `to`, the full calldata and the created address:

- `DeployBaseMVP.s.sol/8453` (14 txs, all in one Base block): **10 of 14 entries carry the hash
  of a different entry.** The *set* of hashes is exact. Each entry's nonce, calldata and
  `contractAddress` are exact. `receipts[]` is internally consistent: each receipt's fields
  belong to its own `transactionHash`. Only the `transactions[i].hash` pairing is wrong. The file
  says TegridyFactory was created by the tx that actually called `setSequencerFeed`.
- `DeployRoleSafes.s.sol/8453`, already on trunk: 3 of 4 wrong.
- Mainnet runs from the same deployer (1, 2, 5 and 5 txs): all correct.
- Blockscout's explorer index gave the same pairing independently.

Every mislabelled hash passes the "exists, status 1, right block" check. That check therefore
cannot catch it; only comparing the tx *content* can. The cause was not established (forge
version, concurrent sends on 2-second blocks?). Do not write it down as known.

Two traps on the verification path, measured the same day:

- `ethereum-rpc.publicnode.com` answers `eth_getTransactionByHash` / `eth_getTransactionReceipt`
  for June-2026 mainnet txs with HTTP 200 and `"result": null`. `eth.drpc.org` and
  `eth-mainnet.public.blastapi.io` return those same txs. A null looks exactly like "this hash was
  never mined".
- An Etherscan v2 free key gets `NOTOK "Free API access is not supported for this chain"` for
  `chainid=8453`. `https://base.blockscout.com/api/v2/transactions/<hash>` is keyless and returns
  status, block, nonce, `created_contract` and the decoded method.

**Do:** key broadcast entries by `(from, nonce)`, never by `hash`. When the question is "which tx
created X", take the answer from the chain (the receipt at that nonce) or from an explorer's
creation index, not from the JSON. Treat a null tx lookup as UNKNOWN until a second provider
agrees.

---

## 2026-09-17 — mutate an effect's condition without its deps and the mutated line never runs

**Believed:** to prove a test pins an effect's gate, swap the flag in its condition
(`if (!isSuccess …)` → `if (!isReceiptFetched …)`) and watch the test go red. If it
stays green, the test is missing a case.

**Measured** in PR #613's mutation rig, on the success-toast effects in PoolCard
(AMMSection) and OwnerAdminPanelV2. The condition-only swap SURVIVED both revert tests
(5/5 and 4/4 green), and the tests were fine. The deps still read `[isSuccess, txHash]`.
A reverted receipt sets the fetched flag but leaves the derived `isSuccess` false and the
hash unchanged, so React never re-ran the effect and the mutated condition was never
evaluated. Swapping the deps too, `[isReceiptFetched, txHash]`, which is how the
regression would actually be written, killed both, each by its own revert test.

eslint tells the two mutants apart. On AMMSection the condition-only one raised
`react-hooks/exhaustive-deps` ("missing dependency: 'poolTxReceiptFetched'"): 8 warnings
against trunk's 7. The faithful one was lint-clean at 7.

**Do:** mutate an effect's condition and its deps together. Before you believe a
survivor, lint the mutant: an `exhaustive-deps` warning on it means the mutant was not
faithful and the survival proves nothing.

---

## 2026-09-17 — a value handed across a Suspense render is gone if the render that took it is thrown away

**Believed:** carrying a value from pre-React markup into a lazily loaded component is a
module variable plus `useState(() => takeDraft())`, where take reads and clears; a unit
test that the store hands the value over proves the handoff; and an e2e that aborts the
entry chunk covers the seconds before the app loads.

**Measured** on a production build of the venue's static first frame (answer ten, PR #591),
with chunks held by a Playwright route handler and released by hand. All three were wrong,
and the store's own unit test was green the whole time.

### A render thrown away by Suspense runs your initializer again

An address typed into React's fallback was in the store, and the real field mounted empty,
every run. The home page's first render suspends on a sibling lazy chunk, React discards
that render with its state, and the retry's initializer ran again and found the store
already cleared. Reproduced in vitest by rendering the component beside a child that throws
a promise once: red with the take in the initializer, green with a peek in render and the
clear in `useEffect`.

**Do:** in render, only read (repeatable); consume in an effect, which runs only for a render
that committed. Test a handoff through a boundary that really suspends, not through the store.

### DOMContentLoaded waits for module scripts; `readyState === 'interactive'` does not

A classic script in `<head>` deferred its wiring of the static form to `DOMContentLoaded` so
the body markup would exist. On the phone throttle (150 ms RTT, 1.6 Mbps, CPU 4x) the markup
painted at about 0.7 s and `DOMContentLoaded` fired only after the entry module graph had run,
about 7.5 s. With the entry chunk held, the listener never ran at all. A `readystatechange`
listener that acts once `readyState !== 'loading'` wired the form while the chunk was still
held: readiness turns interactive when parsing ends, before deferred and module scripts run.

### Chromium fires `blur` on a focused node as it is removed, while it is still connected

Focus an input, then remove it with `replaceChildren`. Chromium dispatched `blur`
synchronously with `isConnected === true` and `document.activeElement` already moved; WebKit
dispatched no `blur` at all. So at event time a blur handler cannot tell "React swapped this
field out" from "the visitor tapped away". What worked: decide one microtask later and check
`isConnected` then. React's commit, including the replacement field's layout effect, finishes
before any microtask runs.

### An aborted chunk proves the no-script path, not the slow-script path

`route.abort()` on the entry chunk tested the static form's plain GET and could not see any
of the three defects above, which only exist while the markup is on screen and the app is on
its way. Holding the request (`await gate; await route.continue()`) and releasing it by hand
showed all three. Two traps in that harness: `page.waitForURL` waits for `load` by default,
which a page whose entry chunk is held never reaches (use `waitUntil: 'commit'`); and a
`page.goto` that must not wait for scripts needs `waitUntil: 'commit'` too.

### On Windows, stopping the shell that ran `npx vite preview` leaves node serving

Killing the backgrounded Git Bash shell left its `node.exe` child running; four previews
survived that way. The survivor holds `lightningcss.win32-x64-msvc.node` open, and the next
`npm ci` failed EPERM on that file after it had already deleted most of `node_modules`. Find
them by command line (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`) and stop
them by PID before reinstalling.

---

## 2026-09-17 — a view that copies a write path's arithmetic has to copy its guards too

**Believed:** `StakingMonitorView.earned` could be trusted during a pause because its math is a
line-for-line copy of the write path. `StakingViewLib.earnedFromMem` does the same
elapsed × rate projection, the same pool cap and the same debt subtraction as
`accumulateRewards` followed by `getReward`, and it carries a comment demanding lockstep with its
storage twin.

**Measured** (`contracts/test/StakingMonitorViewPause_2026_09_17.t.sol`, forge 1.5.1, PR #624): the copy
took the arithmetic and left out the condition around it. `accumulateRewards` projects only
`if (… && !cfg.isPaused)`, and the pause flag is not among the view's inputs. Two equal stakers,
one day, pause, one emergency withdrawal, three paused days: the view showed **302,400** TOWELI
and `getReward` at the unpause instant paid **43,200**. The lockstep comment could not catch
this. Both copies inside the library agree with each other; the guard lives in the caller's
`Cfg`, which neither copy sees.

### Pin the view to the write path while the guard is active, and in both directions

- "While paused, `earned()` equals what `getReward` pays at the unpause instant" failed on the old
  code (302,400 vs 43,200).
- A test asserting only "the view does not move while paused" passes a view that never projects
  at all. That mutant (always anchor at now) passed the paused leg and was killed only by the
  second leg: "while running, `earned()` equals what the claim pays."
- Mutation results: pre-fix, always-frozen and inverted-check each fail at least one leg. Neither
  leg compares against a literal, so both survive a change of rate, pool size or boost curve.

### Read the guard in the same call as the math

The fix reads `paused()` inside the view's own `eth_call`, so pause state is never unknown: a
failed read reverts the whole view. The frontend alternative was to read `paused()` in a separate
multicall batch and redo the math in TypeScript. That adds a third state, "pause unread", which
then needs its own withheld display (an unread flag must not read as "running"), plus a second
copy of the math that can drift the same way this one did. When a guard can be read on-chain next
to the numbers it gates, read it there.

---

## 2026-09-17 — `git bundle verify` passes a bundle cut in half, so a safety net is only proven by restoring from it

**Believed:** a bundle that `git bundle verify` accepts is a backup you can delete against.
The command is named for exactly that check, it exits 0, and it prints "The bundle records a
complete history."

**Measured** (git 2.53.0.windows.1). A throwaway repo with 6 commits of random 200 KB files,
bundled with `git bundle create full.bundle --all` (1,201,601 bytes); `half.bundle` is the
first 600,800 bytes of that file:

| check | `full.bundle` | `half.bundle` |
|---|---|---|
| `git bundle verify` in the source repo | pass | **pass** |
| `git bundle list-heads` | pass | **pass** |
| `git bundle verify` in an empty repo | pass | **pass** |
| `git fetch <bundle> 'refs/*:refs/r/*'` in an empty repo | pass | fail: `early EOF`, `index-pack died` |

`verify` and `list-heads` read the bundle's header (its ref list and prerequisite commits) and
check the prerequisites against the current repository. Neither reads the pack data that follows.
A partial copy, an interrupted download or a disk-full write can leave the header intact, and then
both checks still pass.

This was caught while reviewing a branch cleanup whose design was "bundle it, verify the bundle,
then delete": the verify step proved nothing about the part that mattered.

**Do:** prove a bundle by restoring from it before you delete what it backs up. Fetch it into a
fresh repository that holds only the bundle's prerequisites, check that every oid you meant to
keep is present (`git cat-file --batch-check`), and run `git fsck --connectivity-only`. Record a
hash of the proven file, so anything that later trusts the bundle can check that it is still the
file that was proven.

### Two more places a zero-loss cleanup quietly loses the last copy

- **`.git/lost-found/other/` can hold the only copy of a blob.** `git fsck --lost-found` writes
  each dangling blob's *content* into a file named by its oid. Once gc prunes the object, that
  file is all that remains. In this repo 3 of the 13 files there hashed to their own names
  (`git hash-object --no-filters <file>` equals the filename) while `git cat-file -e <oid>`
  failed. A cleanup that treats `lost-found` as a folder of names and deletes it destroys
  content. Move it instead. The files in `lost-found/commit/` really are just names.
- **Loose-ref file timestamps are not evidence of recent use.** A guard that skipped tags whose
  `.git/refs/tags/<name>` file had changed in the last 72h protected nothing within the same
  hour: another session's `gc --auto` packed every ref into `packed-refs`, and the loose files
  disappeared. Use something the packing cannot erase, such as the tagged commit's date, or a
  name convention that live work actually follows.

---

## 2026-09-16 — a merge train's green ticks are claims about a base, a scope and a moment

**Believed:** working a backlog of open PRs is bookkeeping. A PR whose checks read green
is ready, `gh pr checks` exiting 0 means the checks passed, and a stale branch is one
click from current.

**Measured** while triaging the open-PR backlog against `mvp-launch`, every one of those
was wrong in a way that would have merged something nobody had checked.

### `gh pr checks` exits 0 on the checks that exist, not the checks that should

On a PR whose base is not a trunk branch, `gh pr checks <n>` exits **0** with 11 of the 32
gates a trunk-based PR runs. It reports the check-runs that were created, and a job whose
workflow never triggered creates none, so nothing in the output is red and nothing says
"missing". The 2026-09-12 stacked-branch entry below records a stacked PR reading
`all-checks-pass: SUCCESS`; the extra fact here is that the exit code agrees with it, so a
script that gates on `$?` is exactly as blind as a human reading the tick.

**Do:** list the NAMED contexts the touched paths must produce, look each one up in
`gh pr checks --json name,state,workflow`, and treat an absent context as a failure. A
count floor does not fix this (see the 2026-09-12 `all-checks-pass` entry below): which
workflows run at all is path-dependent.

### The aggregators finish before the frontend gate starts

`all-checks-pass` and `all-tests-pass` are the terminal jobs of `solana-ci` and
`Contracts CI` (the 2026-09-12 entry below has the table). On #576, a frontend PR, both
were green at 15:54, `Build` started at 16:03 and both E2E jobs at 16:07, and the long
E2E run finished at 16:47. A reviewer who stopped at the two green "all-*" names would
have merged before the frontend was built, and nearly an hour before its E2E finished.
They are not a frontend gate at any point in the run, not just early in it.

### A green is computed against the base as of the last push

A PR's checks ran against the trunk that existed when it was last pushed. Across the
backlog, PRs sat **48 to 216 commits** behind `mvp-launch`. The oldest of them predate
`em-dash-zero.spec.ts` entirely (it arrived in `350dfa9d` on 2026-09-09), and the rest had
run it only in an earlier revision, before the per-route budgets they would be merged
against were rewritten. Their greens were true statements about a tree that no longer
exists: nothing had re-run them.

**Do:** refresh a PR onto current trunk before trusting its green, and wait for the new
run. An old tick is evidence about its merge base, not about the merge.

### `allow_update_branch: false` does not turn `update-branch` off

The repository reads `allow_update_branch: false`
(`gh api repos/<owner>/<repo> --jq .allow_update_branch`), and the first draft of this
plan concluded from that value that `gh pr update-branch` was unavailable. It is not. On
2026-09-16 `gh pr update-branch 567` answered "PR branch updated" and GitHub pushed
`536976e7`, a two-parent merge committed as GitHub, and the same call then refreshed
fourteen more PRs. The setting governs whether GitHub always *suggests* the button, not
whether the API works; GitHub had authored update-branch merges here on 2026-09-04 too. A
setting's value is only a claim about its effect until the effect has been measured.

**Do:** refresh with `gh pr update-branch <n>`. For a stacked PR, retarget first
(`gh pr edit <n> --base mvp-launch`) and update second, so the one push runs against the
trunk gates. #482's refresh was pushed a minute before its retarget, ran against the old
base, and the retarget did not re-run anything.

### A lockfile marked `binary` cannot be three-way merged

`.gitattributes` declares `package-lock.json  binary`, and the `binary` macro unsets
`merge`, so git will not three-way merge `frontend/package-lock.json`: any two branches
that both change it conflict on the whole file, however disjoint the edits. Dependabot
PRs that touch the lockfile therefore land **one per rebase cycle** — merge one, and every
other lockfile PR goes CONFLICTING until Dependabot regenerates it against the new trunk.
Sequence them, and do not read a wall of conflicts as a wall of broken PRs.

### A monitor alarm about a healthy site, fifteen times

The literal-301 probe in the 2026-09-15 entry below had failed **15 consecutive runs** and
commented **14 times** on issue #566 by the time its fix (#573) was opened, about a site
that was serving correct 308 redirects the whole time. With #573 still open a day later,
the issue held **19** of those comments (the latest at 2026-09-16 10:05Z). The durable rule is that entry's:
assert a redirect's class and target, not a literal code. What the backlog adds is the
count: fourteen false comments on one issue is fourteen chances to learn to skip it.

---

## 2026-09-15 — a monitor that pins a vendor's status code fails the day the vendor is right

**Believed:** a permanent redirect is a 301, so a synthetic probe can assert
`[ "$code" = "301" ]` and thereby be asserting "this alias redirects permanently".

**Measured:** Vercel's `redirects` array never emits 301. `"permanent": true` emits
**308**; `"permanent": false` emits **307**. Measured with `curl -sI` against three
live aliases — all three 308, one hop, path and query preserved. There is no setting
on a `redirects` entry that yields 301; you have to abandon `permanent` for a raw
`statusCode` to get one.

The failure mode this produced is the transferable part. **One commit** both created
the redirect with `permanent: true` *and* rewrote the monitor to demand a literal
`301`. It went red on the first scheduled run after merging and stayed red for **14
consecutive runs** across three trunk commits, while production behaved exactly as
designed. The check asserted a status code the config it shipped alongside could not
emit — and because both halves rode in one commit, there was no "it used to pass"
signal to bisect toward.

**Why a literal is the wrong pin.** The invariant the probe exists to defend is
*permanent, and onto the canonical host*. `301` is one vendor's spelling of half of
that. Pinning the spelling fails on a correct implementation-detail change and, worse,
stays silent if the platform later emits a permanent code you never enumerated. Assert
the property:

```bash
case "$code" in 301|308) : ;; *) fail ;; esac
```

That is *stricter* than the `30[0-9]` it replaced, because 302/303/307 now fail: a
temporary here means someone flipped `permanent` to false and the canonicalisation
signal quietly stopped consolidating.

**308 is not a downgrade.** It is the method-preserving twin of 301 (RFC 7538) and
search engines consolidate on it identically. There was nothing to fix in production
— "make the monitor green" and "fix the site" were different tasks and only one of
them was real. A red monitor is a claim about production that itself needs checking.

**Do:** when probing a managed platform, enumerate every code that satisfies the
property you actually care about, and find out what the platform emits — one
`curl -sI` — rather than inferring it from what the config field is *named*.
`permanent: true` does not mean 301.

### The corollary that cost the two days: an alarm must say what tripped it

The probe wrote its failure text to `$GITHUB_OUTPUT` only, for use as an issue body.
**`gh run view <id> --log-failed` does not render `$GITHUB_OUTPUT`** — it showed the
`run:` script source and a bare `exit 1`. The one fact needed to act (WHICH host, and
what it actually returned) was recoverable only by re-running the probe by hand.

An alarm whose own log cannot name what tripped it gets ignored, and this one was, for
two days, by everyone who looked at it. If a step composes a human-readable failure
report, print it to stdout **as well as** to wherever the automation consumes it. The
duplication costs one line and is the difference between a triaged alarm and wallpaper.

---

## 2026-09-15 — the knob that makes one file input strict does not make the action strict

**Believed:** hand a GitHub Action a path to a file that is not there and the step fails.
`softprops/action-gh-release` even advertises an input called `fail_on_unmatched_files`,
which reads like the action's policy for missing files.

**Read** (not run — see the caveat at the end) from the action's own source at the SHA this
repo pins, `efb35369`:

- `body_path` is **soft, with no opt-out**. `releaseBody()` in `src/util.ts:57-69` wraps the
  read in a try/catch that only `console.warn`s, then returns `config.input_body`:

      if (config.input_body_path) {
        try { return readFileSync(config.input_body_path, 'utf8'); }
        catch (err) { console.warn(`⚠️ Failed to read body_path ... Falling back to 'body' input.`); }
      }
      return config.input_body;

  If `body` is not also set, that returns `undefined`, and the consumer coerces it:
  `src/github.ts:688` reads `releaseBody(config) || ''`. So an unresolvable `body_path`
  publishes an **empty release body on a green run**. Nothing in the action's 19 declared
  inputs can harden this.
- `fail_on_unmatched_files` governs a **different** input. Its only two consumers are
  `src/run.ts:16` and `:46`, both on `config.input_files` — the release *assets*. It never
  reaches `releaseBody`. It also defaults to soft: `parseConfig` reads
  `env.INPUT_FAIL_ON_UNMATCHED_FILES == 'true'`, so unset is `false`, so an asset glob that
  matches nothing warns and publishes a release with no assets.

So one action carries two file inputs with two different policies, and the strictness knob
that exists names the one you were not worried about. **Seeing a hardening option in an
action's input list is not evidence that the action is strict; check which input it is
wired to.**

The same shape has a third policy elsewhere in this repo's workflows. `actions/upload-artifact`
takes `if-no-files-found`, which is configurable *and* defaults to `warn`. Surveyed across
`.github/workflows/` by walking the parsed YAML: 11 upload steps, 8 set the flag (5 `error`,
3 `warn`), and 3 sit on the default — so **6** sites treat "produced nothing" as a warning and
a green job. Three policies for one idea (no opt-out / opt-in-and-defaults-soft /
configurable-and-defaults-soft) across two actions is why this has to be checked per input
rather than remembered per action.

That survey had to be structural, and the first pass of this entry got it wrong by not being.
`grep -c if-no-files-found` over the same files returns **9**, not 8, because one of the matches
is inside a *comment* explaining the setting rather than setting it (`solana-ci.yml:439`). The
grep-derived numbers were in this entry's first draft and were corrected before it left the
worktree. A
comment naming a setting is a claim about configuration, not configuration — the same trap the
2026-09-11 entry records for gate comments and wrong-chain notices, arriving here through a
counting tool instead of a reader.

**How to check it**, without trusting a README that may describe a different version than the
one pinned:

    gh api repos/<owner>/<repo>/contents/src/util.ts?ref=<pinned SHA> --jq '.content' | base64 -d

Reading the pinned SHA is the point. A floating tag's docs and the bytes that actually run in
CI are different artifacts.

**Caveat, stated because this file's rule requires it:** the empty-body consequence is derived
from reading that source plus the fact that the caller leaves `body` unset. It was **not**
observed in a release run — the workflow it was found in has never executed even once. The
line numbers and the input survey are reads; the consequence is an inference from them.

**Why it is worth knowing beyond the warning:** it changes what counts as a safe edit. Renaming
the generated file this repo feeds to `body_path` looked like a free string swap. Because the
failure mode is a silent green, "move it to `${{ runner.temp }}`" — a change to how the path
*resolves*, not just what it says — would have had no rehearsal that could catch it going
wrong. When an input is soft, the cost of being wrong about it is paid silently and later, so
the change that touches the fewest mechanisms wins.

## 2026-09-14 — a wallet adapter's declared capability is the SHIM's opinion, not the wallet's

**Believed:** `supportedTransactionVersions` on an official `@solana/wallet-adapter-*`
package tells you what that wallet can sign. On 2026-09-02 this repo read
`@solana/wallet-adapter-trust`'s `supportedTransactionVersions = null`, correctly
decoded it (null narrows to legacy-only; it does **not** mean "all versions"), and
excluded Trust from every Solana surface on the grounds that the wallet could not
sign the v0 transactions this venue sends. A guard test was written to keep it out.

**Measured, twelve days later:** the package was right about itself and wrong about
Trust. Read from Trust's own sources, not the shim:

- `trustwallet/trust-web3-provider`, `adapter/src/wallet.ts` — Trust's **own** Wallet
  Standard implementation — declares `supportedTransactionVersions: ['legacy', 0]` on
  both `solana:signTransaction` and `solana:signAndSendTransaction`.
- Its injected provider, `src/solana_provider.js`, reads `tx.version` and serializes
  with `requireAllSignatures: false, verifySignatures: false` — the versioned path.
- `wallet-core` has shipped `VersionedTx` / `V0Message` since PR #2935, merged
  **2023-02-20**, which closed "[Solana] Support versioned transactions".

`@solana/wallet-adapter-trust@0.1.18`, published **2026-09-10**, still says `null`.
So the metadata had been wrong for roughly three and a half years and was republished
wrong four days before it was read.

**Why this generalises past Solana.** These adapter packages are third-party shims
around someone else's product. The wallet ships on its own cadence; the shim is
updated when a volunteer gets to it. A capability *claim* in the shim is evidence
about the shim. A capability *denial* is not evidence about the wallet at all.

**Do:** when a wallet shim says a wallet cannot do something, and that denial is the
reason you are about to exclude the wallet, go read the wallet's own provider or
Wallet Standard source before believing it. It is a ten-minute read and it is the
difference between "this wallet is broken" and "this package is stale". Vendor an
adapter with the honest declaration rather than adopting the package — a wallet's own
`registerWallet` implementation is the authority, and it is public.

### The declared capability gates only SOME paths — find out which one your SDK takes

The version check does **not** live in the adapter. In `@solana/wallet-adapter-base`
(`esm/signer.js`) it lives in exactly two methods on `BaseSignerWalletAdapter`:
`sendTransaction` and `signAllTransactions`. **`signTransaction` has no gate at all.**

That matters because SDKs disagree about which one they call. Measured here:

| Path | Route | Hits the declared-version gate? |
| --- | --- | --- |
| swap / limit / DCA | `adapter.sendTransaction` | yes |
| Streamflow staking | `client.execute()` → `signAndExecuteTransaction` → `invoker.signTransaction(tx)` | **no** |

Both send a v0 `VersionedTransaction` (`@streamflow/common` compiles one via
`compileToV0Message`). So a legacy-only adapter throws the adapter's clean
`Sending versioned transactions isn't supported by this wallet` on one path, and on
the other sails past the check and fails inside the wallet with whatever that wallet
says. Same defect, two symptoms, and a guard asserting the declared value catches
neither on the second path.

**Do:** before reasoning about what a declared capability protects, `grep` the SDK for
which method it actually calls. `isSignerWallet(invoker) → invoker.signTransaction` is
the common bypass shape and it appears in more than one SDK.

### A dist grep is evidence only after you prove the code path is REACHABLE in that build

Checking that a wallet refactor had not dropped Trust from the EVM connect modal,
`grep -rl "com.trustwallet.app" dist/assets/*.js` returned **nothing**. Read naively
that says the refactor deleted the wallet. It did not: `wagmi.ts` builds its wallet
list inside an `if (projectId)` branch, no `.env` exists in a fresh worktree, so
`VITE_WALLETCONNECT_PROJECT_ID` was undefined and rolldown eliminated the **entire**
list — Phantom, Trust, WalletConnect, Rainbow, Base and Rabby together. The tell was
cheap and should have been the first check: grep for a *sibling* that the change did
not touch (`phantom.ethereum`). It was also absent, so the absence was about the
build, not the diff.

Rebuilt with `VITE_WALLETCONNECT_PROJECT_ID=<any 32 hex chars>`: `com.trustwallet.app`
present in the wagmi chunk, and the shared icon module resolved into its own chunk
imported by both sides rather than pulling one stack into the other.

**Do:** a zero from a dist grep is a *reading*, and an unreachable code path returns
the same zero as a deleted one. Before believing it, grep for an untouched sibling
symbol from the same branch. If the sibling is missing too, you measured your env.

### `autoConnect` + a `Loadable` deep-link branch = a page that navigates itself away

Wallet adapters model "app not installed, but we can hand off to it" as
`WalletReadyState.Loadable`, and `connect()` in that state is not a connection — it
assigns `window.location.href` to a universal link. `WalletProvider` is commonly
mounted with `autoConnect`, and the default `autoConnect()` just calls `connect()`.
Composed, that is: every returning visitor whose stored wallet selection is the
deep-linkable one gets navigated off the site on page load, having clicked nothing.

Upstream's Phantom adapter guards it (`autoConnect` runs only from `Installed`) with a
two-line comment and no test. Any hand-rolled or vendored adapter has to re-derive the
guard, and nothing fails loudly if it does not — on desktop, where adapters get
written, `Loadable` never occurs.

**Do:** if an adapter has a `Loadable`/redirect branch, override `autoConnect` to run
only from `Installed`, and pin it with a test that asserts `location.href` is
**unchanged** after `autoConnect()`. Also make an injected provider always win over
the redirect, or the wallet's own in-app browser can bounce itself in a loop.

### Incidental

- `useStandardWalletAdapters` dedupes a legacy adapter against a registered Wallet
  Standard wallet by **exact `name` string match** (it drops yours and logs a
  `console.warn`). A vendored adapter's `name` is therefore a load-bearing contract,
  not a label: Trust registers as `"Trust"`, so an adapter calling itself
  `"Trust Wallet"` — which is what the EVM modal calls it — would render a second,
  dead row beside the real one.
- `scopePollingDetectionStrategy` runs its detector **synchronously** as its last step
  ("Strategy #4"), so an adapter's `readyState` is already settled when the constructor
  returns. Tests can assert it without waiting; the 1s interval only covers late
  injection.
- SLIP-44 for Solana is **501**; Trust's dApp-browser handoff is
  `https://link.trustwallet.com/open_url?coin_id=<slip44>&url=<encoded>`. A wrong
  `coin_id` still opens the browser, so this fails silently on the wrong chain.

## 2026-09-13 — correct bytes at an unchanged URL reach nobody who already resolved that URL

**Believed:** if a site's icon files are wrong, replacing the bytes fixes it. The
HTTP cache is the only thing between the file and the viewer, so serving the
icon with `Cache-Control: public, max-age=0, must-revalidate` means every client
re-checks and picks up the new art on its next visit.

**Measured:** the venue's `apple-touch-icon.png` and both manifest icons carried
a retired project's pixel logo, and a commit replaced all three with the correct
mark. Production served the correct bytes from that moment — verified live,
`curl -sI https://<site>/apple-touch-icon.png` returning `200 image/png`,
`Cache-Control: public, max-age=0, must-revalidate`, ETag matching the new file.
Weeks later the retired icon was still showing in a wallet's in-app browser, on
its tab cards and in its search bar.

The reason is that `Cache-Control` governs *the HTTP cache*. It says nothing to
a client that resolved this origin's icon once, wrote the image into its own
store keyed by **origin**, and never asks the network again. Browsers, in-app
webviews, home-screen launchers and link unfurlers all keep a store like this.
For them a new icon at an old filename does not exist — there is no request for
a header to be attached to.

What reaches them is a URL they have never seen, so the version token has to move in
the markup and in every manifest, not just on disk. **Where in the URL it moves
matters too.** The first fix put the token in a query (`/favicon.png?v=<token>`); two
days later it moved into the path (`/icons/<token>/favicon.png`). A store that
normalises or strips the query sees the URL it already holds, and nothing on the
server side reveals which stores do that. A new path is a strict superset of a new
query: every store that would notice the query notices the path, and so do the
ones that ignore queries. Keep the canonical root files (`/favicon.ico`,
`/apple-touch-icon.png`) as copies and never move them, because a deleted one falls
into the SPA rewrite described below.

Two things that follow:

- **The revalidation headers were never the problem, so tightening them is not
  the fix.** It is easy to spend the whole investigation on `Cache-Control`,
  `ETag` and CDN `Age` — all of which were already correct here — because those
  are the knobs a server exposes. The stale copy was never in a layer the server
  can address.
- **Derive the version token from the icon bytes, not by hand.** A hand-bumped
  literal lets someone change the art and leave the token alone, which is the
  original bug reproduced exactly. Hashing the icon files and asserting the
  markup carries that hash means art that moves without its URL moving fails,
  and the failure prints the token to paste in. The invariant worth pinning is
  "when the bytes change, the URL changes with them" — **not** "the icon is the
  right one", which was true for the entire life of the bug and would have
  proved nothing.

**The second half, and the reason a client had nothing better to fall back to:**
under an SPA rewrite, a missing well-known asset is not a 404. The config here
rewrites `/((?!api/).*)` to `/index.html`, and there was no `favicon.ico` on
disk, so `GET /favicon.ico` returned **`200 text/html`, 12801 bytes** — verified
live. Plenty of in-app browsers probe that root path before they parse a single
`<link>` tag. A fetcher that gets a 200 it cannot decode has no failure to fall
back *from*: it does not learn "no icon here", it just keeps whatever it already
had. A real `.ico` on disk both answers the probe and removes the ambiguity.

Generalises past favicons: any SPA-rewritten origin returns a decodable-looking
200 for `/robots.txt`, `/.well-known/*`, `/sitemap.xml` and every other
convention-probed path it does not actually ship. Absence and success are the
same response, and only the client's parser can tell them apart.

---

## 2026-09-13 — a source scanner's exemptions are where the bugs live, and `[^>]*` cannot match a JSX tag

**Believed:** a registry that must stay in step with the code can be held there by
a scan: read every call site, compare against the list, fail on the difference.
Call sites the scan cannot resolve — a computed argument, a loop index — are a
small, harmless remainder, so skipping them keeps the guard honest.

**Measured:** the skipped remainder was where both real defects were.

A hand-maintained inventory of 418 art surfaces had two guards over it, and both
asked only *"is everything the code renders in the list?"*. Running the reverse
question for the first time: **54 of the 418 were rendered by nothing at all** —
whole retired pages, and 17 cards on a page that had been rebuilt down to 2.
Nothing had ever asked, so nothing had ever said.

And the exemption itself hid the opposite defect. The scanners matched
`pageId="literal"`, so a surface selected by a computed value was invisible to
them — it could neither be flagged as missing nor as dead. Two of the most-seen
surfaces on the site were reachable *only* that way:

    pageId={IS_ARRIVAL || identity ? 'home' : 'venue-home'}
    const PAGE_ID = 'eth-curve';  …  <PageArtBackdrop pageId={PAGE_ID} />

The home-page hero was unregistered and unplaceable in the editing tool for
months, while an overrides file carried a saved pick for it the whole time —
a pick nothing could display, edit, or reconcile.

Three things that transfer:

- **Run the reverse direction of any consistency guard at least once.** "Is
  everything used in the list?" and "is everything in the list used?" are
  different questions with different failure modes, and a codebase that only
  ever asks the first accumulates dead entries silently — forever, because the
  guard is green. A dead registry entry is worse than clutter when the registry
  is an editing surface: it accepts input, writes a record, and affects nothing.
- **`[^>]*` cannot match a JSX tag.** Any prop holding an arrow function
  (`onClick={() => x}`) contains a `>` that truncates the match, so the parse
  silently pairs an attribute with one from a *later* tag. This produced
  confident, entirely wrong findings until the extractor was rewritten to walk
  the tag tracking brace and quote depth. Same trap for any regex over a
  brace-delimited language.
- **Enumerate the components before scanning for them, and read each one's
  defaults.** The first pass covered two of the five components that resolve
  this value, and reported live entries as dead because their call sites were in
  the other three. Three of the five default the index to `0`, so a tag with no
  index prop anywhere in it still renders index 0 — a scan looking for an
  explicit index sees nothing and concludes the surface is unused.

The general shape: a static scanner is an argument with premises — *these*
components, *this* call syntax, *these* defaults. The premises are invisible in
the output, and a green result asserts them just as loudly as it asserts the
conclusion. Before trusting a sweep, check the number it resolved: this one
found 282 surfaces before the missing components were added and 302 after, and
the 20-surface gap was the whole difference between a wrong answer and a right
one.

---

## 2026-09-12 — a route stub whose pattern stops matching does not fail, it silently measures the unstubbed page

**Believed:** if a Playwright `page.route(glob, r => r.abort())` is in the spec, the
branch under it is the aborted one. A stub is either applied or the test errors.

**Measured:** neither. When the app moved its GeckoTerminal reads from
`api.geckoterminal.com` to a same-origin edge, the spec's
`'**api.geckoterminal.com/**'` matched nothing and Playwright reported *nothing at
all* — no warning, no unmatched-route error. The spec kept passing for two days
against a branch it was not pinning, then reddened trunk when that branch's copy
happened to differ by one character class.

Proof it was inert, three runs on the same build, same route, identical source:

| stub | prose em dashes on `/competitions` |
|---|---|
| `'**api.geckoterminal.com/**'` (dead) | 16 |
| `'**resource=gecko-read**'` (live) | 17 |
| no `page.route` at all | 16 |

The dead stub and *no stub* agreeing exactly is the signature. If a stub is
load-bearing, assert that: count `requestfailed` under it, or fail the test when
the handler was never invoked. A stub you cannot prove fired is a comment.

### Under `vite preview`, a missing `/api/*` is not a 404 — it is 200 text/html

This is what turned an inert stub into a *wrong* measurement rather than merely a
live one. `vite preview` runs no serverless function, and the SPA fallback answers
any unmatched path with the index document, 200. So a client that checks
`res.ok` before parsing sails through the status check and dies at
`res.json()`. The failure is classified at a different layer:

- aborted at the socket → `network` → *"The trades feed could not be reached — that
  is an outage, not an empty tape."*
- 200 text/html → `schema` → *"The trades feed returned something unreadable."*

Same outage to the user, different sentence, and here a different em-dash count.
Any assertion over the WORDS of a failure — not just its presence — is really an
assertion about which layer the read died at, and `vite preview` moves that layer
relative to production. Fail-closed code paths are not interchangeable just
because they both render "could not read".

### Writing down the correct pattern is not the same as applying it

The fixture had already been updated, in prose, to say the old glob
"intercepts nothing now; the equivalent is `'**resource=gecko-read**'`". Two specs
still holding the old literal were not changed in that commit, so the note
documented the breakage instead of preventing it. A note describing the right
value, next to callers still using the wrong one, reads as done and is not.

**Do:** when a URL a test depends on moves, export the pattern as one constant and
import it. `grep` for the old literal in the same commit that writes the note —
the note is the weakest possible fix.

### An exact count over text built from a failed read cannot hold

The guard budgeted `/competitions` at 17 prose em dashes. Thirteen were the read
ledger: one `not read — <why>` chip per resident pool, plus one sentence per
distinct failure reason. That number is a function of how many pools are
registered, how many answered, and which reason each failure got — a third
party's behaviour, not reviewable copy. It was fated to drift and it did.

**Do:** exclude such a subtree by structure (a marker attribute the walker skips,
plus a source guard pinning who may declare it), rather than budgeting it. The
test of a good exclusion is that the remaining number stops moving: with that
structural fix, proposed in #564 and still open, the route read 4 aborted, 4 on
the fallback, and 4 unstubbed.

---

## 2026-09-12 — the same string at a second site is not automatically the same bug: read the GATE before the copy

**Believed:** a known-bad string still live at a second site, present at the fixing
PR's merge base, is a site the sweep did not reach — the same defect, closed by
applying the same rewrite.

**Measured** (PR #561 against #474, the string `'Trade ETH ↔ TOWELI via Uniswap V2
with custom slippage controls.'`, byte-identical at `TradePage.tsx:92` and
`HomePage.tsx:832`): the two sites render under different gates, so the rule that
condemned the first does not reach the second. TradePage has no arrival-voice gate
at all. The HomePage grid is inside `IS_TOWELI_ARRIVAL && !bungalowIdentity` — one
resident's own page, where naming that resident is correct and deliberate. The
cheapest evidence was two lines down in the SAME array literal: the neighbouring
card names the same ticker on purpose (`farmCardDesc` → "Stake TOWELI to earn now"),
hoisted to a lib and already pinned by a different test. Applying #474's rule here
would have turned a reviewed line red, and the ruling's own test header warns
against exactly that — "banning the word would have forced the venue to hide one
resident to prove it favours none".

There WAS a real defect at the second site, but a different one that the string
match happened to sit on: the copy named one of the NINE sources `useSwapQuote`
races, so it understated the surface rather than mis-voicing it. The correct fix
and the assumed fix pointed opposite ways on the ticker — keep it, not delete it.

**Do:** when a known-bad string turns up at a second site, read the gate that site
renders under before reusing the first site's fix. Two occurrences of one string
can be one bug, two unrelated bugs, or one bug and one correct usage. Check the
siblings in the same literal first: a neighbour that keeps the "bad" pattern
deliberately is the cheapest available proof that the rule does not apply there.

### Incidental — `\b` inside a template literal is a BACKSPACE, and a negated matcher then passes vacuously

A regex assembled as ``new RegExp(`\b(?:W?ETH)\b\s*…`)`` is not the regex you
wrote. In a template literal `\b` is U+0008 and `\s` is a literal `s`, so the
compiled source came out as `\b(?:W?ETH)\bs*[…]+s*TOWELI\b` — measured in node
against the pre-fix string: the intended pattern matches, that one does not. Because
the assertion was `.not.toMatch()`, the broken pattern would have PASSED, silently,
against the very string it existed to ban. The mutation check is what surfaces this;
a guard written this way and never watched fail reads green forever.

Generating the file through a script adds a second, independent backslash level to
lose (heredoc → script → disk ate one here, turning the intended `\\b` into `\b`).
`String.raw` removes both problems at once and is the right default for any regex
source built from a template.

## 2026-09-12 — a green that ran nothing, a green that covers a different workflow, and a red that only timed out

**Believed:** a vitest run that exits 0 ran the suite, a context called
`all-checks-pass` covers the PR's checks, and a pre-fix test that goes red has
done its job whichever way it went red.

### `--reporter=<name-that-does-not-exist>` is a silent no-op

`npx vitest run --reporter=basic` in `frontend/` printed a stack ending in

```
code: 'ERR_LOAD_URL'
...
[exited with code 0]
```

`basic` is not a reporter in this vitest, so vitest tried to resolve it as a
**custom reporter module**, failed to import it, and exited **0** with **zero test
files collected**. Nothing in the output says "0 tests" — the summary lines a real
run prints (`Test Files`, `Tests`) are simply absent, which reads like truncation.
`--reporter=dot` on the same tree reported `Test Files 603 passed (603)`.

Same shape as the cancellation trap in
`reference_trunk_ci_starved_by_cancellation`: the exit code is not the question.
**Gate on the summary line, not the status** — `grep -E "Tests  " out` is the
check, `$?` is not. This bites twice, because piping vitest into anything
(`| tail`, `; echo $?`) also reports the *last* command's status: a run that
printed `VITEST EXIT: 1` was reported by the surrounding shell as exit 0.

### Await a sentinel that exists in BOTH worlds, then assert synchronously

Writing a render-level test for a read-honesty fix, the natural shape is

```js
expect(await screen.findByText(/floor depth not measured/i)).toBeInTheDocument();
```

Against the **pre-fix** component that copy does not exist, so `findByText` burns
the whole `waitFor` budget and fails with a timeout — measured at **1022ms**, next
to 38–627ms for the legs that failed on a value. A timeout is a weak result: it is
also what you get from a component that never finished loading, a mock that never
resolved, or a typo in the matcher. It cannot separate "the copy is absent" from
"nothing rendered at all".

Rewritten to await a heading that renders in both the pre- and post-fix worlds,
then assert synchronously:

```js
expect(await screen.findByRole("heading", { name: /Floor Depth/i })).toBeInTheDocument();
expect(screen.getByText(/floor depth not measured/i)).toBeInTheDocument();
```

the same pre-fix run fails in **241ms** with `TestingLibraryElementError: Unable to
find an element with the text: …` — an immediate, specific statement that the
component rendered and the copy is not in it.

**Do:** in a mutation check, `await` something both versions render. Only the
assertion should target what changed.

### `all-checks-pass` is not the PR's checks

Measured on a docs-only PR (#552). `gh pr checks --json name,bucket,workflow`:

| context | workflow |
| --- | --- |
| `all-checks-pass` | **solana-ci** |
| `all-tests-pass` | **Contracts CI** |
| `Lint, Type Check & Test` | **CI** |
| `CodeQL (javascript-typescript)` | **CodeQL** |

Neither aggregate spans the PR. They are the terminal jobs of the solana and
contracts workflows, so on a docs or frontend change those workflows skip every
job, their aggregate passes **in seconds**, and the frontend's real gate is still
running in a different workflow. Watching the list settle, `all-checks-pass` and
`all-tests-pass` both read `pass` while `Lint, Type Check & Test` and `CodeQL`
were still `pending`.

It looks like a race and is not one — it is a **scope** error. The name claims the
PR; the job covers one workflow. This is the mechanism behind the existing rule
that a check-COUNT floor is unsound: which workflows contribute at all is
path-dependent, so both the count and any "all-*" name mean something different
per PR.

**Do:** assert the NAMED contexts that matter for the paths you touched — for a
frontend change that is `Lint, Type Check & Test`, not `all-checks-pass`. Add
`workflow` to the `gh pr checks --json` field list; without it a context's real
scope is invisible.

### Incidental

- `getByText` with a **regex** matches every node whose text contains it, so adding
  the same phrase to a summary line and to a detail line breaks a query that was
  unique the day before (`Found multiple elements`). Matching the exact full string
  separates them without scoping to a container.
- A render-level outage test does not automatically need fake timers. Retry sleeps
  only exist on paths that retry: in `frontend/src/nakamigos`, a proxy rejection
  carrying a plain `Error` is non-retryable to `api.js`'s `withRetry` (it retries
  `TypeError` and `ApiError.isRetryable` only), and the orderbook's `degraded: true`
  answer is deliberately not retried. Picking those legs let 11 render tests run on
  real timers in 3.81s of test time.

## 2026-09-12 — an equality-based invariance test is blind to every field that is equal for the wrong reason

**Believed:** the strongest way to pin "X must not change what this reports" is to
assert the whole report is equal with X set and unset. Nothing can hide in an
object comparison.

**Measured** (PR #514's `farmReadsWalletChain.test.ts`, whose stated subject is
"the wallet's chain does not decide what the farm reports"; the subject under test
was `usePoolData`'s `batchRan`, carrying a `chainId === CHAIN_ID` term the
`enabled` gate beside it had already lost):

- The suite builds one all-success fixture and asserts
  `figures(reportOn(hook, 8453))` equals `figures(reportOn(hook, CHAIN_ID))`, with
  one scalar checked non-zero first so two unread reports cannot pass as equal.
- Put the chain term back on `batchRan` and that suite still passes **10/10**, run
  alone, while the hook's own suite fails 4 of 31 on the same tree. The three
  unread flags are `false` on both sides of the equality, because under an
  all-success fixture there is nothing to be unread about. The equality held, and
  held for the wrong reason.
- The 4 that fail are the ones that break **one** read off mainnet. Breaking a read
  is what makes a failure flag take a value worth comparing.

The guard against "two unread reports are equal too" was already there and was not
enough: it proves the READS landed, not that any FLAG was exercised.

**Do:** for each boolean in a report, ask what fixture makes it `true`. If no case
in the invariance suite produces that fixture, the equality assertion is not
covering that field, however wide the object comparison looks. An invariance test
needs one fixture per interesting value, not one fixture and a wide `toEqual`.

## 2026-09-12 — a stacked branch can hold a reference that exists in neither parent

**Believed:** a semantic conflict between a branch and trunk shows up as a merge
conflict, a type error in the branch, or a red check. A clean `merge-tree` and a
green branch mean the merge is sound.

**Measured** (PR #490 `fix/pool-reserve-unread`, stacked four deep under
`mvp-launch`; trunk's #514 had deleted the `onMainnet` declaration from
`usePoolData.ts` while #490 added a new line using it):

- Both parents are internally consistent. On #490's branch `onMainnet` is declared
  and `npx tsc -b --force` is clean; on trunk the name does not appear at all. The
  dangling reference exists **only in the merge**, so neither branch's own build
  can see it, and there is nothing for `merge-tree` to report: all nine commits
  cherry-pick onto trunk with zero conflicts.
- In the merged tree `npx tsc -b --force` gives
  `src/hooks/usePoolData.ts(59,34): error TS2304: Cannot find name 'onMainnet'`.
- That undersells it. An undeclared free variable is a **runtime**
  `ReferenceError`, not a type complaint: vitest on the cherry-picked stack gives
  27 failures, all `ReferenceError: onMainnet is not defined`, across every test
  that renders the hook. So the hook throws on every render rather than returning
  a wrong number — a different and louder class of consequence for the pages
  that call it, which a type error alone does not suggest.
- The branch's own CI cannot catch it, and says so in green. Of 15 workflows, the 7
  with a `pull_request` trigger and a branch filter all read `branches: [main,
  mvp-launch]`; the only unfiltered one is `solana-ci.yml`. On a PR opened with
  base `fix/pool-reserve-unread`, `gh pr checks` reported **`all-checks-pass:
  SUCCESS`** with only `scope` and `all-checks-pass` actually run: the other 7
  Actions jobs, `build` and `diff-guard` among them, were `SKIPPED`, so the
  frontend was never built. A stacked PR's green tick is an assertion
  about which jobs were eligible, not about the code — and a job that did run
  would be testing the parent that compiles.

**Do:** for a branch whose base is not trunk, `git merge-tree --write-tree trunk
<head>` and then typecheck **and run the tests of** the resulting tree; a clean
merge-tree exit only means git found no textual conflict. When trunk has DELETED a
declaration a stacked branch still reads, expect a free variable rather than a type
mismatch, and expect it to throw rather than to compute wrongly.

## 2026-09-12 — a guard whose two operands come from one source, hidden by a correct refusal from the wrong cause

**Believed:** the zap had a chain guard. `planZap(descriptor, routes, expectedChainId)`
refuses on `descriptor.chainId !== expectedChainId` with a dedicated refusal code
(`chain-mismatch`), a message naming both chains, and a passing test. The hook that calls
it reads `useChainId()`. Every part a reviewer looks for was present.

**Measured:** the caller built `descriptor.chainId` from `useChainId()` and then passed
that same `chainId` as `expectedChainId`. Two different expressions, two sensible names,
one variable — so the comparison was `x !== x`. Unreachable on every chain, for every
wallet, under every config. Not weakened: absent.

Rendering the hook with the wallet on 8453 and on 4663, with usable routes in hand,
returned `{ ok: true }` — a composed plan for contracts that exist on neither chain.
`planner.test.ts` was green throughout, because it calls `planZap` directly and supplies
both numbers itself: it pinned the FUNCTION, and the defect was in the CALL. Restoring
the old argument after the fix failed exactly the three new caller-level tests and
nothing else — including a positive control on the right chain, which passed both before
and after.

**What made it read as working:** a wallet on the wrong chain *was* refused — by
something else. `useSwapQuote` gates its reads on the wallet's chain, so off mainnet
every leg came back without a floor and the zap refused with `route-unavailable`:
"no floor to submit". The user saw a refusal, so nobody went looking. But it blamed the
route for a network problem, and the real guard sat dead behind two unrelated gates,
either of which could move without anyone knowing it was load-bearing.

**Do:**

- Read a guard's operands back to their **source**, not their names. A parameter named
  for what it *should* be is not evidence that it is that. The question is not "does this
  compare the right things" but "can these two expressions ever differ".
- A unit test that supplies **both** sides of a comparison cannot see this class, however
  thorough it is. The test has to be written at the caller, where only one side is free.
  This is the same shape as a mock that answers a query the real thing would refuse
  (2026-09-10, below): the double removes the very degree of freedom under test.
- When a bad state *is* refused, check **which** refusal. A misattributed refusal is the
  strongest camouflage available: the visible behaviour is correct, so the wrong
  component gets the credit and the right one rots. Grep the refusal a user actually
  sees back to the branch that emits it before concluding a guard works.
- A guard standing behind other gates is not redundancy — it is untested code with a
  test-shaped comment on it. Either something must reach it, or it should not be there.

## 2026-09-12 — a threshold fitted to a sample with a GAP is a guess wearing a measurement's clothes

**Believed:** a Streamflow CLASSIC reward entry stops being payable once its cumulative
`accounted_amount` passes `u64::MAX`. This was not reasoned from an IDL — it was established by
simulating the real `claim_rewards` against all eight live entries of a mainnet pool, with every
entry above the value reverting 6000 and every entry below it succeeding. Eight for eight.

**Measured, six days later:** wrong twice over. Scanning the whole program with
`getProgramAccounts` plus a `dataSlice` over just the counter field, **5,868 of 9,797** entries
with a non-zero counter are already past that value, and the largest is **22,000,000x past it** —
each written by a successful claim, since only a successful claim writes that field. And on the
pool itself the verdicts split perfectly on something else entirely: the pool's reward RATE was
changed at a known instant, and the 2 entries created before it revert while all 16 created after
it pay.

**Why eight-for-eight was not enough.** The sample had a hole in exactly the wrong place — its
successes topped out at 78% of the candidate threshold and its reverts started at 265%. Nothing
measured the band between, so a LOWER BOUND was indistinguishable from an exact line. And the two
reverting entries were also the two oldest, so a second variable ("predates a rate change") fit
the same eight points just as well. The first hypothesis named won by default.

**Technique, whenever a boundary is inferred from live samples:**

- **Check the sample BRACKETS the boundary.** Points either side of a gap do not locate a line,
  they bound a region. If nothing was measured between the highest pass and the lowest fail, the
  honest output is an interval — and code must not act as though it is a point.
- **Ask what else explains the same split.** Sort the failures by every field you have, not only
  the one you suspect. Here, sorting by `created_ts` against the pool's `last_amount_update_ts`
  gave a perfect 2/16 split that the counter could not improve on.
- **Widen the population before trusting the mechanism.** One pool's 8 entries said one thing and
  the program's 9,797 said the opposite. A program-wide scan over a single sliced field is cheap:
  `dataSize` + `dataSlice` returns thousands of rows in one call.
- **Measure the PAYOUT, not the exit code.** Simulate with
  `{sigVerify:false, replaceRecentBlockhash:true, accounts:{encoding:'base64', addresses:[ata]}}`
  and diff the returned post-state against the current balance. A claim that "succeeds" while
  transferring zero is not evidence a position is alive. (That config-object overload needs a
  `VersionedTransaction`; a legacy `Transaction` fails with "Invalid arguments".)

**The design rule this produced, which is the durable part:** a threshold may WARN; only the
program may VETO. The cost asymmetry is enormous and one-directional — a claim that reverts costs
a network fee, a claim never offered costs the whole balance. The code now attempts every claim
that has a pending balance and takes its verdict from the chain's own error, even where a
predicate is right 18 times out of 18.

---

## 2026-09-12 — a source guard that searches the whole file answers about the file, not the code it names

**Believed:** a guard for "this timer is armed in a layout effect" could be written
as: find the timer, then compare the last `useLayoutEffect(` before it against the
last `useEffect(` before it. Whichever is nearer is the effect it sits in.

**Measured:** nearness in a file is not enclosure. With the deadline moved back into
a passive effect AND one comment above the timer naming the layout hook in passing,
the guard stayed GREEN: the exact mutation it exists to catch walked through it. The
fooling text was not hypothetical either, since that effect's own comments name both
kinds of hook.

**Technique:** a source guard must read the construct that ENCLOSES the code it is
about, and must ignore comments. Walk back from the line you matched to the nearest
line that opens the construct, skipping comment lines, and assert on that line. Then
mutate twice: the plain break (it must red), and the plain break PLUS the text that
could fool it (it must still red). A guard is only as good as its second mutation.

## 2026-09-12 — a timeout and the animation it bounds can be counting from different moments

**Believed:** one line of arithmetic settles whether a deadline cuts an animation
short: the deadline fires at 2,500 ms, the animation needs 2,400 ms, so the animation
always finishes first.

**Measured:** the two numbers start from different moments. The deadline was armed in
a layout effect, during the commit that puts the overlay in the DOM. The animation's
clock is stamped later, in a passive effect that first builds a WebGL post-processing
pass. Whatever that gap costs -- paint, chunk parse, GL context creation -- is spent
before the animation starts counting and not before the deadline does, so the real
margin is smaller than the arithmetic, and on a slow machine the deadline can cut an
animation that is running on time.

**Technique:** before comparing a timeout against a duration, write down which moment
each side counts from. If they differ, either anchor both to the same stamp, or keep
the bound and say in the test what it is: a floor, short by however long the gap runs.
The arithmetic is not wrong, it is optimistic, and the comment is where that belongs.

---

## 2026-09-12 — `Page.captureScreenshot` is served by the renderer it is screenshotting

**Believed:** a CDP screenshot is taken by the browser, so it can observe a page
whose main thread is blocked.

It cannot. Probing whether a compositor-driven opacity animation still advances
during a long task, the driver slept to a wall-clock instant and called
`Page.captureScreenshot`. Every sample came back *after* the block ended: asking
for +2,000 / +2,600 / +2,900 / +3,500 ms returned frames at +3,261 / +3,295 /
+3,326 / +3,396 ms. The screenshot path waits on the same blocked renderer, so
the clock it appears to offer is the clock being investigated. It read "the
overlay was still opaque at the deadline" — agreeing with the bug, for the wrong
reason.

**`Page.startScreencast` is a different channel.** Frames are *pushed* as the
compositor produces them, and each carries `metadata.timestamp` (epoch seconds),
so delivery latency does not smear the measurement. Re-probed with a solid
3,000 ms busy loop across the deadline: 20 frames arrived *during* the block, with
the overlay's opacity ramping smoothly to 0.

**Do:** to answer "what was on screen at time T" for any T where script might be
busy, use the screencast and the frame's own timestamp. Convert the page's clock
with `performance.timeOrigin + performance.now()` to compare against it. Treat
`captureScreenshot`, `page.screenshot()`, and anything routed through
`page.evaluate` as main-thread instruments — fine for a quiescent page, useless
for this question.

---

## 2026-09-12 — a compositor animation's `startTime` is set at the first frame, not at creation

**Believed:** `el.animate(...)` starts the animation now, so a fade given the same
duration as a deadline finishes at the same moment.

It starts at the first frame the browser produces after creation, and on a loaded
machine that frame is not soon. Measured on a real app under a blocked main
thread: the overlay's first painted frame came **107 ms** after a MutationObserver
stamped the node's insertion, and the fade finished at **3,002 ms** against a
3,000 ms budget — having spent an entire 100 ms slack allowance on nothing but
waiting to begin. The animation was correct; its zero was late.

`animation.startTime = document.timeline.currentTime` dates it from the current
commit instead. Same build, same block: the fade completed at **2,892 ms**.

**Not the same trap as "a timeout and the animation it bounds can be counting from
different moments" above**, though it is the same theme. That one is about a clock
*your own code* stamps in a later effect; this one is the browser assigning a clock
you never wrote, inside an API that looks synchronous.

**Do:** pin `startTime` whenever an animation's *end* is a deadline rather than a
decoration. `document.timeline.currentTime` is `null` before the document's first
frame, so guard it. Note this is the same error as arming a `setTimeout` *at* a
budget instead of inside it, one layer down — a deadline that begins late can only
end late, and the lateness is invisible because the animation's own duration is
exactly right.

---

## 2026-09-12 — a compositor emits frames only when something changes, so "assert a frame in [a, b]" fails correct code

**Believed:** with a screencast running at `everyNthFrame: 1`, frames arrive
continuously, so a test can assert that some frame inside a window shows the
expected state.

Frames are produced on change. Once a fade settles at opacity 0 the compositor has
nothing further to draw and goes quiet: in one run the last frame of the fade was
at **+2,918 ms** and the next at **+3,598 ms**, a 680 ms hole straddling the
3,000 ms instant under test. An assertion requiring a frame inside
`[budget, budget + 400]` therefore failed a curtain that was demonstrably gone.

The opposite shape fails too, and more dangerously. "The first frame at or after
the budget" was satisfied on one run by a frame at **+3,568 ms** — 168 ms after
the blocked thread came back — so the *ordinary timers* answered it and the
assertion would have passed on the unfixed build.

**Do:** what is on screen at time T is **the last frame at or before T**, because
that frame persists until the next one. Assert on that, and separately assert it
post-dates whatever perturbation the test introduced, so a stale pre-test frame
cannot answer for it.

---

## 2026-09-12 — a timing constant can make a whole code path unreachable, and the profile will not mention it

**Believed:** the expensive function you can see in the phase that is running is
the one to optimise.

An arrival overlay's suspected cost was a glitch effect doing a full-canvas
`getImageData` → per-pixel loop → `putImageData`, twice per call. It never ran.
The phase branches on `pieceTime >= 1400`, and the variant's own `artDuration` is
1,200, so `pieceTime` is bounded at 1,200 and the branch is dead — for that
variant only; the other one, at 2,600, runs it every time.

Reading the arithmetic found it, but **counting** is what settled it: patching
`CanvasRenderingContext2D.prototype.getImageData`/`putImageData` to log size and
count over one full overlay lifetime returned **0 `putImageData` calls** and 2
`getImageData`, both at viewport size and both belonging to a different function
entirely. A sampling profile agreed by omission, which is the weakest possible
form of agreement — absent entries are indistinguishable from cheap ones.

The same profile named the real top consumer: a decorative background component
animating 530 particles **behind the opaque overlay**, at 597 ms per run, more
than anything the overlay itself spent. It was not in the file under
investigation.

**Do:** before optimising a named suspect, instrument the primitive it is accused
of over-using and count calls over one real run. A census answers "did this run at
all, and how much", which is two questions a flame chart answers only by
inference. And profile the whole page, not the component you suspect: work that is
invisible is still work.

---

## 2026-09-11 — dropping a read gate re-arms every control the unread state was holding down

**Believed:** a gate like `enabled: … && useChainId() === CHAIN_ID`, on reads already pinned
with `chainId: CHAIN_ID`, only decides whether a figure shows. Delete it and the worst case is
one more RPC call.

**Found** (#526): CollectionDetailV2's Mint button had no chain term in its `disabled` expression.
Off mainnet it was held down by `!drop.priceReadOk`, and that was false only because the gated
price read never ran. Deleting the gate, correctly, lets the price land on Base, and the button
arms under its own label "Switch to Ethereum Mainnet". `mint()` refused by itself, so a click
only toasted, but the disabled state had been an accident of the read gate. Measured with the
fix in place: removing the explicit `!drop.onMainnet` from `mintDisabled` fails both connected
off-mainnet cases in `CollectionDetailV2.offMainnet.test.tsx`, on `toBeDisabled()`.

**Do:** before deleting a read gate, grep its consumers for controls that need a positive read
(`*ReadOk`, `status === 'success'`, `!== undefined`) and ask whether the gate was that control's
real guard. If it was, write the guard into the control.

**The test-side twin, same session: a guard's test can be held by an upstream copy of the
guard.** `useAutoRefreshBoost` gates on the wallet's chain, and its test "stays quiet on the
wrong chain" looked like it pinned that. It did not. The hook's input `holdsJBAC` came from
`useNFTBoost`, which carried the same gate, so off mainnet it was `null` and the hook was
disabled regardless. Measured (vitest, the original test file):
- with the pre-fix `useNFTBoost` and `useAutoRefreshBoost`'s own gate deleted, the test
  **passes**;
- with `useNFTBoost`'s gate dropped, the same deletion **fails** it.

The mutation that proves a guard is "delete this guard, with every upstream copy of it gone",
not "delete this guard" in a tree where something else still holds the line.

## 2026-09-11 — the partial-coverage scan over- AND under-reports, and a pre-fix run can fail for the wrong reason

**Believed:** the per-index scan's gap list (method: #502) is the set of reads that
publish an outage as a zero. Fix the list and the file is clean.

**Measured** on six candidate files at trunk `1325f685`. Each gap index was
adjudicated by what its zero *asserts*, then fixed and mutation-checked in PRs #508
#512 #515 #517 #518, which are still open, so those fixes are not on trunk yet:

- **It over-reports.** 25 gap indices; 15 made a claim or armed a control. Of the
  other 10: a fail-closed owner panel, two reads with no consumer, a display
  fallback, three allowances whose only failure mode is an extra Approve, two reads
  whose failure renders the same `–` as a real zero, and one claim that is **true by
  construction**. An unread `paidPerWallet` renders "No refund owed", but only on a
  cancelled sale, and `cancelSale()` reverts `CancelAfterFirstMint` once anything has
  minted. Read the contract before signalling.
- **It under-reports.** Four claim sites have no `status === 'success' ? … : 0` to
  match:
  - a collapse through an intermediate `undefined`
    (`x = ok ? r : undefined; n = x ? f(x) : 0`), twice in one hook;
  - a separate `useBalance` feeding the same "Not enough ETH" claim as a batch read;
  - an early `return { …, lpSupply: 0n }` that zeroed a value the hook *had* read,
    whenever the price feed was stale. That became "0.00% of LP supply" on the
    treasury page.
- **The claim can be the bug when the control is already safe.** A CTA was disabled
  on an unread balance before any fix, because a collapsed 0 is short of any amount.
  "Fails closed" was true, and the button still said "Not enough TOWELI" about a
  wallet nobody read.

**New vacuity shape for the pre-fix run.** Testing an unexported component meant
adding `export` in the fix. Restoring trunk's file for the pre-fix run then fails
*every* test on the missing named export. That is a red run that proves nothing about
behaviour. Reconstruct pre-fix as trunk **plus only the test-enabling change**. The
honest split was then 4 fail / 2 pass, and the 2 are the genuine-zero guard rails.

**Redundant gates make equivalent mutants.** Gating `insufficientX` on
`balanceXKnown` *and* the CTA's `disabled` on `balanceUnknown` makes removing either
one unobservable: the label checks "unknown" first, and `disabled` has the other
gate. One of two belt-and-braces gates always survives a single-line mutation.
Decide which one the tests pin and say so, rather than chasing it.

**An animated figure asserted at t=0 proves nothing.** A score ring that eases
from 0 over 1200ms of `requestAnimationFrame` is empty one frame after render
whatever the score is, so "the ring is empty during an outage" passed — and a
mutation that fills the ring from the UNDERSTATED score survived it. Driving the
clock instead killed it: `vi.useFakeTimers({ toFake: ['requestAnimationFrame',
'cancelAnimationFrame', 'performance'] })` then `act(() =>
vi.advanceTimersByTime(1500))`. That also took the file from ~4s of real waiting
(one `waitFor` was already timing out at 4000ms) to 70ms. A wall-clock wait would
have been the threshold flake this file warns about elsewhere.

**Tooling trap.** JSX *text* does not process `\u` escapes: `Minting closed —
the creator…` rendered six literal characters with tsc and eslint clean. The Claude
Code Edit tool normalises `—` in both strings, so it cannot target the literal
escape ("old_string and new_string are exactly the same"). Fix it with a script that
builds the backslash from `String.fromCharCode(92)`.

**Do:** read the scan's output as a lower bound on where to look and an upper bound
on what to fix. For each gap, write down what the zero asserts before touching it.
Reconstruct pre-fix states rather than just `git show`-ing them.

---

## 2026-09-11 — a callee that never rejects has failure shapes a `.catch` cannot see

**Believed:** a flag set in the `.catch` around a fetcher tells an outage from an empty
result. `fetchListings` relied on one to choose between "temporarily unavailable" and
"No active listings", and the first fix proposed was to read the fetcher's returned
`error` instead.

**Measured** (PR #535, vitest 4.1.11, trunk `ce4fac5e`): the native-orderbook fetcher
fails in three shapes, and the `.catch` saw only the rarest.

- A network failure **resolves** as `{ orders: [], error }`, because the fetcher's own
  `try` wraps its retry loop. With the proxy down, the real function resolved in
  3015ms, and `fetchListings` returned the healthy `source: "opensea"` with no error,
  3 runs of 3.
- The server's soft-fail for an unreachable database is a **200** with
  `degraded: true` and no `error` field at all. Reading `error` still misses it. Only
  the server's handler shows the shape exists.
- Only a chunk-load failure of the lazily imported module **rejects**.

The rule on top was too narrow as well. It called an outage only when *every* source
failed, so OpenSea down beside an empty native book still read as an empty market. A
one-line mutation back to that rule, with the flag already fixed, left 4 of 6
unread-source tests reading as healthy.

**Do:** before choosing a failure detector, list every shape the callee can produce: a
rejection, a resolved error field, and a success status carrying a soft-fail flag. For
the third, read the server. Then fold them into one shape at the callee, so no caller
has to know there were three.

### A turn-capped fake-timer drain passes alone and times out in the file

**Believed:** `for (let i = 0; i < 120 && !settled; i++) await
vi.advanceTimersByTimeAsync(500)` is a bounded way to skip a retry's sleeps.

**Measured:** in the full file two tests hit `Test timed out in 5000ms`, while alone
each ran correctly in 8–9ms. Instrumented, the trigger was an
`afterEach(() => vi.doUnmock(...))`. After it, 6 of 11 tests spent all 120 turns with
the request under test still unsent: 0 `fetch` calls when the loop exited. Four of
those settled on their own afterwards, because they had no timers left to run. The two
whose request fails needed the retry's fake timers advanced, and nothing advanced them
any more. Without that `afterEach`, the request went out at turn 0–1 in every test
that sent one. Across five variants, moving a `vi.resetModules()` test to the start or
the end changed nothing; removing the `afterEach`, or draining until settled, fixed it.

That first pre-fix run went red on the two timeouts, one of them a counter-test that
should have passed: a red for the wrong reason, like the missing export in #520.

**Do:** drain until the promise settles (`while (!settled) await
vi.advanceTimersByTimeAsync(n)`) and let the test's timeout be the bound. A turn cap
bounds turns, not the work they wait on.

## 2026-09-11 — an exact gas estimate is only good for the second it was taken in

**Believed:** if `eth_estimateGas` returns N, the same transaction against the same
state mines at limit N. (A step earlier in the same chase: that the cost was
"non-monotonic in the gas limit" — offer more gas, burn less. It was neither.)

**Measured** (anvil 1.5.1, mainnet fork, `removeLiquidityETH` on a Uniswap-V2-style
pair; automine off, every block timestamp pinned by hand with
`evm_setNextBlockTimestamp` + `evm_mine`; byte-identical calldata and state):

| estimate taken at | mined at | limit | used | result |
|---|---|---|---|---|
| T (= the pair's last update) | T | 207,033 | 163,888 | success |
| T | **T+1** | 207,033 | **206,923** | **reverted — out of gas** |
| T | T+1 | 310,549 (×1.5) | 172,080 | success |

A V2 pair's `_update` writes both cumulative prices only when `block.timestamp` has
moved since its last update. `pair.burn` cost 101,958 in the same second and 112,199
one second later: the +10,241 is exactly those two SSTOREs. **Anvil lets consecutive
blocks share a timestamp**, and a transaction sent with no `gas` is priced by anvil's
own estimate against the pending block, exact to the gas — so anything estimated in
the same second as the pair's last touch and mined in the next one is ~10k short.
"Burn less at a higher limit" was the same-second block being cheaper, not the limit.

Where it bit: an e2e bridge that forwarded the app's gas-less `eth_sendTransaction`
unpadded. The UI runs add → approve → remove inside about a second, so the remove
was often estimated in the add's second. The real spec against a fresh fork, trunk
code: 2 of 9 runs failed, both out of gas one second after the add. Padded +50%, as a
wallet would: 0 of 14, including one run where the race happened and the padding
absorbed it.

**Also measured:** anvil does **not** reject a gas-less send whose estimate fails. It
mines it at the block gas limit (60,000,000 observed) and it reverts on-chain.

**Do:** pad any transaction you hand a node without a limit. When a revert's
`gasUsed` is within ~1% of its limit it ran out of gas — look at what changed
between estimate and inclusion (timestamp, block, state), not at the arguments.

### A test that dies at 3.0m and passes in 4.8s is an unbounded wait

The first attempt ran into the whole 180s test budget; every assertion in the spec
had a 20-30s budget. The error was `locator.getAttribute: Test timeout of 180000ms
exceeded`: a Playwright locator read with no `timeout` inherits the TEST's, and the
receipt link it wanted had been removed (the surface clears it 4s after a success).
So the run printed nothing about what went wrong. A duration far beyond every
assertion budget means an unbounded wait, not a slow system — find it, and bound
every locator read that sits inside a poll.

## 2026-09-11 — anvil's `--retries` never retries a 408, and `--compute-units-per-second` never throttles

**Believed:** anvil's fork flags let it ride out a flaky upstream. Raise `--retries`,
lengthen `--fork-retry-backoff`, lower `--compute-units-per-second`, and a free RPC
plan's intermittent timeout gets absorbed.

**Checked** in the source of anvil 1.7.1 (tag `v1.7.1`, the version CI pins) and the
alloy-transport 2.0.1 it locks. The fork provider retries through alloy's
`RetryBackoffLayer`, whose `should_retry` is `TransportErrorKind::is_retry_err`: HTTP
**429 and 503** and no other status (plus a few rate-limit JSON-RPC bodies, a null
response, a missing batch item). A 408 returns on the first answer. `--retries` caps that
layer and `--fork-retry-backoff` is its sleep, so neither ever engages on a 408.
`compute_units_per_second` is read only *inside* the retry branch, to lengthen a backoff.
It is not a rate limiter and never delays a first attempt; `--no-rate-limit` just sets it
to `u64::MAX`.

**Measured** on anvil 1.5.1 (alloy-transport 1.1.1, the same predicate), with a logging
shim between anvil and drpc that answered drpc's own 408 body to the first ask of a fresh
account's reads:

| arm | `anvil_setBalance` | upstream asked |
|---|---|---|
| 408, no flags | `failed to get account … HTTP error 408` | once |
| 408, `--retries 10 --fork-retry-backoff 100` | same error | once |
| 408, `--no-rate-limit --compute-units-per-second 50 --timeout 90000` | same error | once |
| **429**, no flags (control) | ok | twice (`429,200`) |

The control is what makes "once" mean something: the counter sees a retry when anvil
makes one.

**Worse on 1.7.1 — and reproduced there.** A failed fork read inside block building hits
`apply_pre_execution_changes().expect(…)`, a panic. CI's anvil died with SIGABRT on the
EIP-2935 history-contract read (`GetStorage(0x0000f908…2935, …, HTTP error 408`) and
every later test failed in ~150ms. anvil 1.5.1 does not read that contract when mining
(checked, also under `--hardfork prague`), so this one needs the pinned binary: unzip the
release into a scratch dir and point the harness at it with an env var, leaving the
machine's `~/.foundry/bin` alone. Done that way, the panic reproduces byte-for-byte, down
to `mem/mod.rs:1324`, under every flag combination in the table — and does not happen at
all with the retry sitting below anvil.

**Do:**

- Retry *below* anvil, in front of `--fork-url`, and pass refusals (401/403/404/410)
  through on the first answer so a dead endpoint still fails in its own words.
- To learn whether a client retries status X, put a counting shim in front of it and
  inject X, **with a control status the client is known to retry**. A soak against the real
  endpoint cannot stand in for this. On 2026-09-11, 40 drpc forks at ~180 reads each saw
  zero 408s, though the same endpoint had cost 2 of 30 CI jobs. The rate moves with the
  provider's load and cannot be summoned.
- A deadline-bounded retry loop must hand back the last *real* answer when the deadline
  cuts a retry short. A first draft turned drpc's 408 into a relay-made 504 whenever a
  backoff landed the next attempt just before the deadline (a 504 at 431ms against a 400ms
  deadline, in the unit test that caught it). That swaps the upstream's words for the
  retrier's.
- **A proxy owes the client the upstream's response HEADERS, not just its body.** anvil
  builds the `HTTP diagnostics:` block in its error out of them — on a real failure that is
  `cf-ray` and `server`, the ids the provider asks you to quote. A relay answering with
  `content-type` alone loses them on the one answer that matters, the one it gave up on.
  Encoding and framing headers still stop at the proxy, because `fetch` has already decoded
  the body.

## 2026-09-11 — a gate's comment and a hook's wrong-chain notice are claims, not evidence

**Believed:** when sweeping read gates, a gate whose comment explains it, or a hook
that already tells the user it is on the wrong chain, can be left as it is.

**Measured** (PR #537: eight hooks gated on `useChainId() === CHAIN_ID`, every
read in them pinned `chainId: CHAIN_ID`):

- Three comments justified the gate with a wrong-chain read that would "silently
  return garbage" (useSwapQuote), "returns 0 garbage" (useSwapAllowance) or would
  "price another chain's assets" (`lib/portfolio/sources.ts`). All three were
  false: the per-call pin sends each of those reads to mainnet. Two of the gates
  were still right to keep, for reasons nobody had written down. A quote is the
  swap's arguments, and its aggregator leg is scoped to the wallet's chain on
  purpose. An allowance is displayed nowhere and only decides writes. The third
  gate was wrong to keep: the portfolio refused to total legs that the Dashboard
  showed beside it, read from the same contracts.
- `useWalletExposure` did signal the wrong chain. Its page said "Switch to Ethereum
  mainnet to read your holdings." Directly beneath, the same page said "No tracked
  ERC-20 balances in this wallet": the gated read left `holdings` empty, and the
  empty-state branch never looked at the flag.

**Technique:** decide a gate by what its value reaches. A displayed figure loses
the gate. A write's argument, or the only thing disarming a control, keeps it.
Re-derive the reason from the code rather than inheriting the comment, and write
the real one down. Judge "already honest" by every branch the collapsed value
reaches, not by whether a notice exists somewhere on the page.

## 2026-09-11 — a line-ending check that fires on every file is counting lines

**Believed:** `git show <rev>:<path> | grep -c $'\r'` counts a blob's CRLF lines.

**Measured:** inside a `$( … )` substitution, in the Git Bash this repo's agents
run on, it returned each file's total line count: 272 of 272, 609 of 609, and
"CRLF" for all 40 of 40 sampled hooks. It nearly got #526's replayed files
re-committed to "fix" endings that were already LF. The same substitution over a
known-LF string (`printf 'a\nb\n'`) returned 2. `tr -dc '\r' | wc -c` read 0 CR
bytes in every blob, and the replayed blobs had the same OIDs as the originals.

**Technique:** before acting on a check that reports "all N", run it on a known
negative. Count the byte (`tr -dc '\r' | wc -c`), not lines matching a pattern.
Prove a replay exact with blob OIDs (`git rev-parse <rev>:<path>`), not
`git patch-id`, which ignores whitespace.

## 2026-09-11 — a per-test timeout is a third clock, and a slow body can be a sleep

**Believed** (the candidate list in the 2026-09-10 entry "a flake-candidate list
ranked by duration mixes two clocks"): `holderOutageRender` was the one thin test
— 3528ms, "about 1.4x headroom" against the 5000ms body bound — because of its
in-body `await import()`, and `--testTimeout=2000` would reproduce it on demand,
as it had for the previous instance of this class.

**Measured** (vitest 4.1.11, trunk `dd7885ba`, each body split with
`performance.now()`, 3 runs of the file alone):

| test | bound | in-body import | the rest of the body |
|---|---|---|---|
| CollectionHealth (the "thin" one) | **20000ms**: `it(name, fn, 20000)` | 36–41ms | `findByText` **3160–3198ms** |
| HolderAnalytics | 5000ms | **276–315ms** | ~70ms |

All three beliefs were wrong.

1. **The third argument to `it()` is its own clock**, and the CLI does not
   override it. Under `--testTimeout=200` the 20000ms test passed at ~3170ms
   while its 5000ms neighbour timed out, 3 runs of 3. So read the closing
   `}, N)` before calling a test near-timeout. That entry's table is wrong for
   `holderOutageRender` :53 and for every in-body import in
   `offerBookOutageHonesty` — each of those tests passes 20000 or 30000.
2. **The slow part was a sleep, not a load.** Three seconds of that body is a
   retry backoff: `lib/orderbook.js`'s `withRetry` sleeps 1s, then 2s. It runs
   because Node's `fetch` cannot parse the relative URL `/api/orderbook` under
   jsdom (`Failed to parse URL from /api/orderbook?...`), and the code treats
   that as transient. It measured 3012–3027ms every run. A cold import grows
   with CPU load and a timer barely does, so a split that shows one near-constant
   segment of whole seconds is a timer. No import hoist moves it.
3. **A repro gate has to be sized from the split, not the reported duration.**
   `--testTimeout=2000` **passed** on the unfixed file, because the real in-body
   cost was ~300ms. A 200ms gate then failed one post-fix run of three at 235ms
   during a load spike. What separated the two cleanly: a threshold between the
   quiet pre-fix (≥292ms) and post-fix (≤98ms) durations, 165ms, with pristine
   and fixed runs **interleaved** so load drift lands on both. The unfixed file
   timed out 6 of 6 and the fixed one passed 6 of 6 (45–147ms, CPU load 3–100%).

**Do:** split a slow test with `performance.now()` before choosing a fix; read the
`it()` call's third argument before naming its bound; size any timeout gate from
the split, interleave it, and record the load next to every number.

### A timeout's second failure is a ghost

The full-suite run after the fix was the heavier of the two (415s vs 314s). In
it, `volumeFallbackHonesty`'s Hero test — 4921ms in the run before — hit `Test
timed out in 5000ms.`, and the test after it failed as well, with
`expected [ <span …(2)></span> ] to have a length of +0 but got 1`. That second
failure is not a second defect. Forcing the first test to time out
(`-t Hero --testTimeout=400`) produced the identical assertion 3 runs of 3;
letting it finish (`--testTimeout=1500`) passed 6 of 6. A timeout does not cancel
the body. Vitest stops waiting, runs cleanup and moves on, and the body resumes
when its import resolves — rendering into the next test's document.

**Do:** in a red run, fix the first timeout in a file and re-run before reading
any failure that follows it.

### Incidental

- A relative-URL `fetch` under jsdom is an instant `TypeError`. Any component
  that calls its own `/api/...` therefore runs its error path, and its retry
  schedule, in every test that renders it — whatever the test thinks it covers.
- A "mutation applied" check can be defeated by the fix's own comment. `grep -c
  'await import('` counted the new comment explaining why the import was hoisted,
  and the script correctly refused to run. Anchor the check on the code's shape
  (`= await import(`), not on a phrase a comment can repeat.
- The fix itself, full suite on the same base, before → after: HolderAnalytics
  874ms → 208ms, and a botLink signature test with the same shape 1033ms → 2ms.
  Both were measured in the heavier of the two runs.

## 2026-09-11 — a test that lets two endings race pins only the one that wins

**Believed:** the arrival curtain has a hard deadline so that it is gone within its
3,000 ms budget, and `arrival.spec.ts` asserted exactly that budget with no input, so the
deadline was taken to be under test.

**Measured:** the curtain ends on whichever comes first, its own animation or the
deadline, and on an unloaded box the animation won at about 2,880 ms. So the test never
ran the deadline: deleting the deadline timer left it green. The deadline's own bug
(armed at the budget, so always a few ms late) surfaced only when a slow CI runner let
the animation lose, at 3,002 to 3,010 ms in three tries of three (PR #524). Throttling the
CPU makes that path likely, never certain. Taking the curtain's 2D context away stops the
animation outright, and then only the deadline can end the curtain. That test failed 10
of 10 on the pre-fix build (3,011 to 3,021 ms), passed 20 of 20 on #530's fix (2,903 to
2,916 ms), and failed 4 of 4 with the deadline timer deleted.

**Technique:** when two mechanisms race to end something, test each one with the other
disabled. A test that lets them race pins only the winner on the machine running it, so
a mutation of the loser cannot fail it. Disable the rival at a boundary the test can
reach (here, an init script that makes `getContext` return null for the curtain's canvas
only), assert that the disabling happened, and assert something only the loser's path
produces (the curtain was still up when the deadline's dissolve began), so that a third
way of ending cannot pass for it.

## 2026-09-11 — a deadline armed at the budget can only be met late

**Believed:** `setTimeout(finish, BUDGET)` enforces "gone within BUDGET". The arrival
curtain's timer was armed at exactly 3,000 ms, and its e2e asserted `lifetime <= 3000`.

**Measured:** CI read the curtain at 3,002 to 3,010 ms in five tries on one PR, and the
same commit passed at 2,935 ms on a retry. A timer fires at or after its delay, the
removal it triggers still costs a render, and this timer was armed in a passive effect,
which runs after paint, so its clock started after the one the test reads. With the CPU
throttled locally, trunk's curtain lived 3,105 to 3,288 ms (x4) and 3,421 to 3,542 ms
(x6). Arming it in a layout effect and ending it 100 ms early brought those to 2,982 to
3,021 ms and 3,030 to 3,090 ms. That holds the budget at CI's load, and at x4 in five
runs of six. At x6 it still misses: the timer cannot fire until the frame in progress
ends, and on a saturated main thread nothing fires on time.

**Technique:** a timer can keep an "at most N ms" promise only by firing early. Keep a
measured slack back from the budget, bound it in a test from both sides (larger than the
lateness measured, smaller than the time the on-time path needs), and start the timer's
clock where the test's clock starts. To reproduce a few-ms timing flake locally, throttle
the CPU with CDP (`Emulation.setCPUThrottlingRate`) until the slow path is the one that
runs. Then measure the old build and the new build interleaved at the same rate, because
back-to-back batches measure the box's load as much as the change.

## 2026-09-11 — a callback prop in a useCallback's deps restarts every effect that lists it

**Believed:** listing `finalize` in a long-lived effect's dependencies was harmless,
because nothing about the component changes while it plays.

**Measured:** `finalize` was `useCallback(..., [onComplete])`, and the parent passed
`onComplete={() => setSplashDone(true)}`, a new function on every render (this build has
no React Compiler). So every render of the parent cleared the curtain's deadline and
armed a fresh one, and re-ran the canvas effect, which starts the animation again from
its first phase. A unit test showed it on trunk code: after a re-render at 2,000 ms the
deadline had not fired by 3,000 ms, and the canvas effect had run 3 times for one mount.

**Technique:** keep a callback prop out of long-lived effects' dependency chains. Hold it
in a ref updated in a layout effect, and call `ref.current` from a stable callback. Test
it by re-rendering with a NEW function and asserting two things: the effect did not
re-run (count something it does once per run, here `getContext`), and the new function
is the one that gets called.

### A callback prop in an effect's deps is only a bug if the SETUP has side effects

A sweep flagged five components that list an `onClose` prop in an effect's deps
while the parent passes an inline arrow, so the effect tears down and re-runs on
every parent render. Only **two** were worth changing.

The separator is what the effect's *setup* does:

- **Real:** setup focuses an element or locks body scroll. Every parent render
  runs cleanup (restore focus to the opener) then setup (focus the panel), so the
  caret is yanked away from whoever is typing and the scroll-lock save/restore
  churns. `SolanaSwapPage` re-renders about once a second while a quote is live.
- **Benign:** setup only does `addEventListener`. Removing and re-adding the same
  document listener in the same tick is invisible. Three of the five were this,
  and their focus / scroll-lock effects already carried correct deps.

**Do:** classify by what the setup *does* before fixing all N. "Prop in deps" is a
smell, not a defect; fixing the benign ones is churn in files you then owe a
re-verify.

**The measurement that settles it**, and it is cheap: spy on
`HTMLElement.prototype.focus`, render the component under a parent that re-renders,
and count. Pre-fix, one re-render moved the count 1 -> 3 -- +2 per render, one from
the cleanup and one from the setup. That +2 *is* the caret theft, and it makes the
invariant ("a parent re-render adds no focus calls") pinnable without asserting any
literal about dep arrays.

Fix shape is the latest-ref: hold the prop in a ref updated in a layout effect, read
`ref.current` from the handler, and let the setup effect be mount-scoped.

## 2026-09-11 — a local fallback that accepts a bad argument hides it until production

**Believed:** a green unit suite plus a working dev server means a rate-limited
API handler works, because every call to the limiter goes through the same module
in both places.

**Measured:** `/api/aggregator?resource=tape` answered `500
FUNCTION_INVOCATION_FAILED` on every production request (both domains, reproduced
with curl) while its unit suite and every local run were green. The handler called
the global limiter without `windowSec`. The shared limiter builds Upstash's sliding
window as `` `${windowSec} s` ``, so production built `"undefined s"` and Upstash
threw ("Unable to parse window size"). Off Vercel the same module falls back to an
in-memory limiter, which took `undefined` without complaint: the window became
`NaN` and never reset, and nothing threw. The handler's own suite mocked the limiter
module entirely. Three layers each looked fine: the mock, the fallback, and an
untyped options object.

**Technique:** when a library has a lenient local fallback and a strict production
backend, test the ARGUMENTS a caller passes, not the fallback's behaviour. Here:
assert the mocked limiter was called with `windowSec`, and add a source check that
every call site passes one (45 of them; one was missing it). No runtime test can see
this class, because every path the tests reach is the lenient one.

## 2026-09-11 — a guard calibrated in CI measures CI's environment, not production's

**Believed:** an exact-count e2e guard that is green in CI means the deployed page
reads the same, because the bundle is byte-identical.

**Measured:** the same per-route spec (a count of prose em dashes, asserted exactly),
run against production after a deploy, read five routes differently: `/chart` 36
against CI's 0, `/developers` 11 (10), `/copy-trading` 12 (11), `/alerts` 14 (17),
`/launch` 30 (31). The bundle was identical; the environment was not. Production had
an indexer URL configured and answering, serverless functions running, and push
keys set. CI's `vite preview` build had none of the three, so no branch gated on them
ever rendered there. `/chart`'s 36 were tooltips and table rows on the indexed chart,
a branch CI can never reach.

**Technique:** write down where a guard's numbers hold, and for branches CI cannot
render, pin the copy at the source instead (here, a scan of the chart's components,
its lib and the hooks that feed it). Then run the same guard against production
after each deploy: every difference is an environment-gated branch the CI run never
saw.

## 2026-09-11 — a test for one clause of an OR is vacuous under an all-fail fixture

**Believed:** "every read fails" is the strongest fixture for an unread flag. If the
flag fires when everything fails, it fires.

**Measured** (PR #514, `useLPFarming`'s
`statsUnread = poolStatsUnread || minStakeUnread || <clause over four more reads>`):
with a chain term put back on the clause alone, both new tests, one hook-level and
one rendered, still PASSED, 60/60, under an all-fail fixture. `poolStatsUnread` had
set the union by itself, so the clause under test never decided anything. Failing
ONE leg that only the clause covers, while the totals and the minimum land, the same
mutation failed exactly 6 of 63.

**Do:** to test one member of an OR, make every other member false, and assert that
they are false in the test itself. Then the member under test is the only thing
that can answer. "Everything failed" tests the union, not the clause.

## 2026-09-10 — a reverted tx renders no receipt, so DOM assertions blame the UI

**Believed:** asserting a receipt link appeared is a sufficient check that a money-path
transaction landed.

It is not, and the failure mode is actively misleading. These surfaces render **one**
receipt line, for **any** confirmed transaction (an approval included), and render
**nothing at all** for a reverted one. So when a burn reverts, the assertion is left
looking at whichever earlier receipt is still on screen. The same single root cause
produced three different messages depending only on poll timing — the previous step's
receipt still being up, an approval's receipt satisfying the check and a puzzling
failure four lines later, or no link at all. None of them says "it reverted".

**Do:** on a fork, read the transaction's fate off the node, not off the DOM —
`expectMinedSuccessfully(page, what, forkTxCount(page))` in `e2e/fixtures/wallet.ts`.
Assert the chain *first*, then keep the DOM assertion; one pins the chain, the other
pins the UI.

---

## 2026-09-10 — pinning a fork block costs you the archive, and then the deadline

Two traps that both look like "the app is broken", both hit while pinning
`ANVIL_FORK_BLOCK` to reproduce a flake.

**1. A pinned block is an archive request.** Forking at *latest* works on every public
endpoint; forking at a block a few hours old does not. Measured, forking at a block
~1,900 behind head: `eth.drpc.org` 408 "Request timeout on the free plan",
`ethereum-rpc.publicnode.com` 403, `eth.merkle.io` 429, `1rpc.io` and
`eth.rpc.blxrbdn.com` "historical state not available". Working:
`eth-mainnet.public.blastapi.io`, `gateway.tenderly.co/public/mainnet`,
`rpc.flashbots.net`. CI does not pin, so CI is unaffected — this bites the person
reproducing.

**2. A pinned block's clock lags, and every router call then reverts.** The app stamps
`deadline = Date.now()/1000 + 1800` from the *browser's* clock;
`TegridyRouter.MAX_DEADLINE` is 2 hours. So once the fork's `block.timestamp` lags
wall-clock by more than **90 minutes**, every add, remove and swap reverts
`DEADLINE_TOO_FAR` — not `EXPIRED`. Pinning a block that was fresh in the morning and
re-running it after lunch silently converts a working suite into a wall of failures.
This is the mirror of the `advanceForkTime` trap already noted in `wallet.ts`: pushing
the chain *ahead* gives `EXPIRED`, letting it fall *behind* gives `DEADLINE_TOO_FAR`.

---

## 2026-09-10 — zeroing an input does not withdraw the claim built on it

**Believed:** F100 fixed "the LP farm advertises a live APR after its reward
period ends" by zeroing the reward rate once `periodFinish` passed. Its commit
said the UI would "never advertise a dead emission schedule". The per-day tile
did read 0, so the fix looked complete.

**Measured** by mounting the real `useLPFarming` hook under `LPFarmingSection`
with mainnet's own state: past `periodFinish` 1781493095, and a residual
`rewardRate` of 3306878306878306 still in storage. The APR hero rendered `0.00%`
in green, captioned "estimated from staked TVL · falls as more LP is staked".
The derived figure's null-guard tested whether its *inputs* were present (pool
loaded, supply non-zero, something staked, price positive), and they all were.
A zero numerator over a finite denominator is a well-formed number, so the guard
let it through as a confident, live-looking APR. The caption written for the
ended state sat in the null branch the guard never took, so it was unreachable
in exactly the state it was written for.

**Do:** when a fix neutralises an input by setting it to 0, don't stop at that
input. Trace every value derived from it, and ask whether the zero reaches the
screen as "absent" or as "zero". Guards that test whether data is present cannot
see a semantic state such as "ended". The state has to be passed down as its own
flag and checked first. An unreachable branch whose copy names a real state is
the cheapest detector there is.

### A counter-test's fixture default can pin the next bug

A sibling PR on the same section added a "genuine zero" counter-test, `reports
a real empty farm as 0, and keeps the invitation`. Its point was sound: an empty
farm is publishable, and a fix that blanked every zero would be a bug. But its
base fixture was documented as "all reads landed, on an **ended** schedule with
nothing staked". So it asserted "be the first to stake LP" on a farm paying
nothing, which is exactly the bug above. Merging the two branches locally left
**1 failure in 103: that test**. Giving it a live schedule made it 103/103.
"Every read landed, every value zero" is not a neutral state. It is a specific
state of the system, with claims attached.

**Do:** in a counter-test ("the honest case must still render X"), set the state
the claim depends on explicitly, and never inherit it from a base fixture's
defaults. Before calling a fix done, list open PRs (`gh pr list --state open`),
check which of them touch your files (`gh pr diff <n> --name-only`), merge the
overlapping ones into a throwaway branch, and run both suites. Two PRs can each
be green and still contradict each other.

Aside, from the same simulation: `git merge --abort` refuses ("not uptodate")
once you edit a file the merge *added*. On a throwaway branch that still points
at your own HEAD, `git reset --hard` is the clean exit.

## 2026-09-10 — "deployed == source" means the BROADCAST's commit, and a write mock never encodes

**Believed:** to confirm a live contract behaves like `contracts/src`, build trunk
and compare it with the chain; and a hook test that asserts
`functionName: 'x'` on the wagmi write mock proves the button can send `x`.

**Measured** on TegridyStaking (`0xcaDc93E96De58EA554c71ca609974625615E046D`) while
re-wiring its paused exit (#510):

- **Trunk was the wrong build target.** Five commits had touched
  `TegridyStaking.sol` since the deploy. The Foundry broadcast
  (`contracts/broadcast/<Script>.s.sol/<chainId>/run-latest.json`) records a
  top-level `"commit"`, here `833b757`. Built at that commit in a detached
  worktree (`forge build src/TegridyStaking.sol`, via_ir, 21 s wall), the executable
  runtime matched the chain byte for byte: **24,284 of 24,337 bytes.**
- **The other 53 bytes are CBOR metadata, and they did not match although the
  code did.** A metadata mismatch is not a code mismatch. Strip
  `2 + uint16(last two bytes)` from the end of both before comparing.
- **Two kinds of slot differ by construction; handle both rather than skipping
  them.** Library link slots (`deployedBytecode.linkReferences`): fill them from
  the broadcast's `libraries` and assert the chain holds the same 20 bytes at
  every offset (10 of 10 matched). Immutables (`immutableReferences`) compile as
  zeros: adopt the chain's values and PRINT them, so a wrong constructor argument
  is visible (20 slots, 2 addresses).
- **A wagmi write mock never ABI-encodes.** With the new ABI entry deleted
  (mutation), 58 of 59 tests in the affected files still passed, including the
  one asserting `functionName: 'emergencyWithdrawPosition'`. A real wallet would
  have thrown `AbiFunctionNotFoundError` at encode time. The only test that
  failed runs `encodeFunctionData` against the real ABI and checks the selector
  (`0x5f667fc0`) read out of the deployed dispatcher, which pins the ABI to the
  chain and not just to itself.
- **Fork-proving behaviour does not need the repo's build.** A standalone Foundry
  project (only `forge-std` plus an inline interface) compiled 20 files in 2.3 s,
  and 4 tests against `vm.createSelectFork("https://eth.drpc.org")` ran in 10 s.
  Every call hit the on-chain bytecode, so repo source was not what got tested.
  Make the rig BINDING first: top up the reward reserve and assert
  `earned() > 0` before comparing "pays" with "forfeits". Otherwise both look
  like "returned the principal".

**Do:** before changing UI semantics on a live contract, build the broadcast's
`commit`, not trunk, and compare with metadata stripped, link slots asserted and
immutables printed. Then diff just the functions you depend on between that
commit and trunk. For every hand-written ABI entry a button relies on, keep one
test that ENCODES the call against the real ABI.

---

## 2026-09-10 — the retry's error is not the failure's error

**Believed:** when an E2E test fails all three attempts, the last attempt's error
is the failure — and a money-path spec that goes red on the first trunk commit
containing a PR that touched that page is that PR's regression.

**Observed** (`E2E Tests (Anvil fork — money paths)`, trunk `1325f685`, run
`34558450845`, `e2e/stake.spec.ts` stake → claim → unstake):

| attempt | error |
|---|---|
| 1 | `anvil_setBalance: failed to get account … HTTP error 408 … "Request timeout on the free plan, please upgrade to paid plan"` |
| retry #1 | `stake: no explorer link to a transaction hash appeared` (30s) |
| retry #2 | the same, 30s |

Only attempt 1 named the cause: the fork's upstream RPC refused during test
setup. Both retries reported a downstream symptom that reads exactly like an app
defect — on a commit that had just merged a change to `/farm`.

**Re-running the same job on the same SHA: 22/22 clean, 0 flaky.** Same code,
different outcome — the upstream, not the merge.

**Do**, when a fork-backed E2E goes red:

1. Read attempt 1's error, not the last retry's. Here only attempt 1 named the
   cause.
2. Grep the log for the upstream's own words — `free plan`, `HTTP error 4`,
   `failed to get account` — before reading any assertion.
3. Re-run the job on the same SHA. It is the one test that separates "the code
   changed" from "the world changed", and it costs a single job.

The fork upstream is `eth.drpc.org`'s keyless tier (`.github/workflows/ci.yml`).
Until a funded key goes in `secrets.ANVIL_FORK_URL`, expect this to recur — and
to land on whichever PR merged last.

## 2026-09-10 — a guard that cannot fire is armed, not inert

**Believed:** a condition that is always true under the current config is dead
weight at worst. `enabled: isDeployed && chainId === CHAIN_ID` on a read that is
already pinned `chainId: CHAIN_ID` looks like harmless belt-and-braces.

**Measured** (`@wagmi/core` 3.6.5 source as installed, git history, and a real
browser):

- Under a ONE-chain wagmi config, `useChainId()` cannot leave that chain.
  `createConfig` ignores a connector's move to an unconfigured chain ("If chain
  is not configured, then don't switch over to it"), and `validatePersistedChainId`
  rejects an unconfigured persisted one. The gate was added (R043, 2026-04-26)
  under `chains: [mainnet]`, so it was always true and never observed doing
  anything.
- Adding Base and Robinhood (2026-08-21) made `useChainId()` follow the wallet.
  That commit pinned 135 reads so they would come from mainnet "exactly as
  before", and left the gates next to those pins alone. From that day the gates
  fired, and nothing had ever tested what happens when they do.
- `useChainId()` is a PERSISTED store value, not "the wallet's chain":
  `partialize` writes `chainId` to localStorage and `actions/disconnect.js` never
  resets it. In Playwright Chromium, logged out, with `wagmi.store` seeded
  `{ chainId: 8453, current: null }` (what a disconnect leaves behind), the store
  still read 8453 after the app loaded.
- A disabled TanStack query is neither loading nor failed. `isLoading` is
  `isPending && isFetching` (query-core `queryObserver.js`), fetchStatus is
  `idle`, and `data` is undefined. So there is no skeleton, every per-index
  `status` check reads as not-success, and any unread flag scoped by the same
  gate stays silent. In that browser run the LP farm printed "Total LP Staked
  0.0000", "Total Funded 0 TOWELI" and "be the first to stake LP" on 8453, while
  the same run on chain 1 printed 528.1998 and 2,000 TOWELI. With the gate
  removed, both chains printed the chain-1 text.

**Why no test saw it:** the shared wagmi mock answered reads whatever
`query.enabled` said, so every gate was invisible to every test that used it.
Making it honour `enabled` broke exactly one suite of 38 (`useBribes.test.ts`,
5 tests). Those tests stubbed reads of a contract whose address is zeroed, which
are reads production never issues.

**Do:**
- When a config widens (one chain to many, a flag to a list), grep for guards
  that compare against the OLD single value. They change meaning with no diff.
- Treat `useChainId()` as "last known chain", including for disconnected
  visitors. Gate WRITES on it; pin READS with `chainId` instead of gating them.
- A test double must refuse what the real thing refuses. A mock that serves
  disabled queries turns every `enabled:` condition into untested code.

## 2026-09-10 — a partial-coverage gap gets fixed one leg at a time, by whoever trips on which leg

**Believed:** a green `node frontend/scripts/check-unread-signal.mjs` means no file
outside its baseline publishes an unread contract read as a zero.

**Measured:** the guard's verdict is one `SIGNAL_RE.test(src)` per **file**, so one
`…Unread` flag anywhere passes a file that collapses eleven reads and signals three.
At `f8bda8b9`, `useLPFarming.ts` was exactly that: `positionUnread` over indices 5–7,
nothing over the other eight, beside a green guard. It then took **three separate
changes** to cover the farm-wide reads of that one file, each fixing the leg it had
tripped over: `3610c147` (MIN_STAKE, [10]), `7d6fdab6` (the pool totals, [0][4]) and
#499 (the rest of the set, [1][2][3][9]). `032af111` has since put this shape on the
guard's printed blind-spot list and added a census, which on trunk `1325f685` reads
**16 files, 69 collapse sites** exempted by a file-scoped signal. By its own comment
the census measures exposure and does not go down as legs are fixed — so it cannot
say *which* reads are unguarded.

**Do:** turn the census into findings with a per-index diff, per `data`-ish variable:

- collapsed = `X?.[i]?.status === 'success' ? … : 0n | 0 | [] | false | ''`
- covered = `X?.[i]?.status !== 'success'` — **and** the bare `X[i]?.status` form
  written after a `!!data` guard, **and** `=== 'success'` inside a positive-polarity
  `const …ReadOk = …;` flag. Without the last two the scan reported covered reads as
  gaps (two false alarms on trunk) and missed a real signal (`useNFTDropV2.ts:111`).
- Match the ternary's middle with `[^;]{0,200}?`, **not** `[\s\S]{0,200}?`. The
  permissive form lets a lazy match run into the next statement, pairing an index
  whose fallback is *not* a zero with the next line's `: ''` — it reported the wrong
  index and hid the real one until tightened.

The output is a candidate list, not a verdict. On trunk `1325f685` it finds eight
guard-passing files with uncovered collapses. Adjudicated: `useLPFarming` [1][2][3][9]
(#499; [8] is left out on purpose, see below); `useUserPosition` [3], where `paused`
collapses to `false`; and `useNFTDropV2`, which signals index 1 of its eleven
collapses, so an unread `maxSupply` makes `isSoldOut = maxSupply > 0 && …` read "not
sold out". Not yet adjudicated: `AMMSection`, `useAddLiquidity`, `useFarmStats`,
`usePoints`, `usePoolTVL`.

**A gap is not automatically a bug — ask which way the zero fails, then what it
costs.** In the same batch, `allowance → 0n` reads "not approved": no stake is ever
armed on it, but Approve re-arms after every approval while the read keeps failing,
so "fails closed" is not a bound on cost. `MIN_STAKE → 0n` fails the other way —
`minStake > 0n && …` *disarms* the minimum guard — and is still deliberately not
blocked: the contract enforces the minimum regardless, so the section says the
minimum is unread and leaves Stake armed, because refusing a legitimate stake over one
unanswered read of a constant costs more than a revert. Same collapse, same batch,
three different right answers.

### How a read failure actually arrives on this stack

**Believed:** a whole-batch failure leaves `data` undefined; and one hook's eleven
calls cannot be split across requests, because `lib/wagmi.ts` configures no `batch`.
Both wrong — and #499 was first written, reviewed and committed against them.

**Measured** (installed wagmi 3.7.7, @wagmi/core 3.6.5, viem 2.56.1 — read from source):

- The query does **not** reject. `allowFailure` defaults to `true` (viem
  `actions/public/multicall.js:54`; @wagmi/core `actions/readContracts.js:5`). A
  rejected aggregate3 request becomes one `status: 'failure'` entry per call
  (`multicall.js:164-174`), and any other throw falls back to per-call `allSettled`
  failure entries (`readContracts.js:33-42`; only `ContractFunctionExecutionError` is
  rethrown). A total outage is eleven `'failure'` entries with `data` **defined** and
  `isError` **false**. `data` is undefined only before the first fetch or while the
  query is disabled.
- Absent config is not "off": @wagmi/core `createConfig.js:132` defaults
  `batch: { multicall: true }`. Every call is then queued into one scheduler shared by
  the whole client and cut into aggregate3 requests at 1024 bytes of calldata, so one
  hook's reads can land in different requests and fail independently.

So on this stack `!data` and `isError` catch **no** RPC failure, whole or partial —
only per-index `status` checks do. Partial failure exists by construction; how often
it happens in production has not been measured.

**Do:** before reasoning from what a config file leaves out, read the library's
default for it. Before writing "the query failed", check whether the library can make
the query fail at all.

---

## 2026-09-10 — an accordion that unmounts closed answers is invisible to every DOM audit

**Believed:** mounting an accordion's answer only while it is open
(`{isOpen && <div id={panelId}>…</div>}`, framer-motion's `AnimatePresence`
pattern) is the accessible shape, as long as the button carries `aria-expanded`
and `aria-controls`.

**Measured** on `/faq` with the repo's axe sweep (`e2e/a11y-routes.spec.ts`,
Chromium, production build under `vite preview`, `--workers=1`). The route carried
`aria-valid-attr-value` as a known violation: every closed button's
`aria-controls` named an id that was not in the document. With every panel always
rendered and given the `hidden` attribute while closed, the finding is gone. The
route's exact known-violation list went from `['aria-valid-attr-value']` to `[]`
and the sweep stayed green.

**The second cost is silent.** Anything that reads the page's text (a
banned-string guard, a copy census, an em-dash count) has nothing to read in an
answer that is not mounted, so on an unmount-on-close page it checks the
questions and nothing else. Seen directly with the panels mounted: one forbidden
answer added under a harmless question ("How does staking work?") turned the
voice census red, although that answer was closed and nothing on screen showed
it.

**Technique:** keep the panel mounted and toggle `hidden`. That takes it out of
view and out of the accessibility tree, so a screen reader still meets only the
open answer, while its text stays in the DOM. A walker that judges a page's copy
must then NOT skip `hidden` subtrees. Skipping `aria-hidden` is still right,
because that marks decoration rather than content.

## 2026-09-10 — `toHaveURL(/x$/)` anchors on the query string, and a redirect inside a lazy page waits for that page

**Believed:** after `page.goto('/swap?tab=liquidity')`, `await expect(page).toHaveURL(/liquidity$/)`
proves the app redirected to `/liquidity`.

**Measured** (Playwright 1.62, chromium, `frontend/e2e/liquidity.spec.ts`, 50 runs with an
init script logging every `history.replaceState`): the assertion passed on its first poll
while the page was still on `http://host/swap?tab=liquidity` in **48 of 50** runs — that
URL ends in "liquidity" too. The line asserted nothing; the only real wait was the next
one (the `h1`), so a failure "at the URL check" was really the heading line. Assert the
path: `toHaveURL(url => url.pathname === '/liquidity')`.

**Second trap, same test.** The redirect was a `useEffect` inside the lazy page it was
redirecting *away from*. A stack captured inside the `replaceState` hook named
`TradePage-<hash>.js` as the caller, and the request log gave the order: host chunk →
page chunk (109 KB) → full swap render → *then* the destination's two chunks — four
serial lazy loads where a direct visit has two. Moving it to a route-level `<Navigate>`,
normalised to each run's `load` event under 8 workers: redirect p50 665ms → 164ms,
heading p50 1274ms → 728ms, runs that fetched the swap chunks 30/30 → 0/30.

**Reproducing it:** 50 unthrottled runs, at 1 and at 8 workers, never failed. A 6x CDP
CPU throttle (`Emulation.setCPUThrottlingRate`, chromium only) reproduced the reported
failure in 1 of 5 — URL check passed on `/swap?tab=liquidity`, then the heading timed
out after 5s with `Received string: "Swap"`, the redirect firing 6.6s after `load` —
while the fixed build passed 5/5 with the redirect at most 1.05s after `load`. A load
flake you cannot reproduce is a throttle level you have not tried.

**Do:** decide URL-only redirects where the URL is first read (the route element), never
in an effect inside a lazy component. To pin it, *hold* the chunks the redirect must not
need — `page.route(pattern, () => {})` never answers — so a regression fails every run,
not only the slow one (pre-fix: 4/4 device projects failed; post-fix: 4/4 passed). Pair
it with a control that the pattern still matches a request somewhere, or a chunk rename
silently turns the hold into a no-op.

---

## 2026-09-10 — a waited `count()` can still be vacuous: the role was wrong

**Believed:** a `count()`-gated assertion that reads 0 right after `page.goto` is
a timing bug. Wait for the page to mount and the count becomes honest.

**Measured** (#519: `e2e/a11y-smoke.spec.ts`, "TradePage swap amount input has a
contextual aria-label", instrumented; all four device projects at `--workers=1`,
production build under `vite preview`). The old test ran `goto('/swap')`, then
`if ((await getByRole('textbox', { name: /amount of .* to pay/i }).count()) > 0)`
assert visible. `count()` read 0 on every project:

| project | count() ran at | route mounted then? | count() |
|---|---|---|---|
| chromium | +153ms after load | no (skeleton `aria-busy`) | 0 |
| iphone-safari | +739ms | no | 0 |
| ipad-safari | +152ms | no | 0 |
| mobile-chrome | +902ms | **yes**, input in the DOM | **0** |

After mount, on every project: textbox **0**, spinbutton **1**.

`<input type="number">` has the implicit role **spinbutton**, not textbox, and
Playwright's role engine follows that mapping. So `getByRole('textbox')` never
matches a number input. There's no error and no timeout, just 0. A fix that
waited for mount and kept the textbox locator would have been exactly as vacuous,
with a convincing-looking wait in front of it. mobile-chrome is the proof: the
timing was already fine there, and the count was still 0.

Mutation check: with the label changed so it no longer matched, the OLD test
still PASSED 4/4. The rewrite locates the input by structure, then asserts
`toHaveAccessibleName`. It FAILED 4/4 with
`Received string: "Amount of ETH a11ymutant"`, a value rather than
"element not found".

**Do:** before trusting a role locator on an `<input>`, read its `type`: number →
spinbutton, range → slider, search → searchbox. When a conditional reads 0,
separate "not there yet" from "never matches": count the raw CSS selector next to
the role locator, before and after mount.

### A fix recipe derived from one gate can miss the second

Its sibling test (OnboardingModal) skipped on every run. The known reason was
real: the fixture pre-seeds the modal's seen-key. But clearing the key alone still
rendered nothing: no dialog within 8s, 4/4 projects. That's because a second,
unrelated condition decides whether the auto-open variant is mounted at all.
Written straight into the test, the one-gate recipe would have turned a false
green into a new red.

**Do:** run a fix recipe as a probe (log the state it claims to produce) before
encoding it as an assertion. A skip reason that was never measured can be wrong
twice.

---

## 2026-09-10 — a flake-candidate list ranked by duration mixes two clocks

**Believed:** a list of slow tests with "headroom vs 5000ms" is a fix queue, and
the fix for a cold `await import(...)` inside a test is to hoist it to a static
import at the top of the file.

**Checked** against the source of four candidates listed that way:

| file | the import sits in | bound |
|---|---|---|
| `holderOutageRender.test.jsx` :34, :53 | `it()` body | 5000ms |
| `offerBookOutageHonesty.test.jsx` :48 (and 9 more at the same depth) | `it()` body | 5000ms |
| `offerErrorHonesty.test.jsx` :85 | top-level `beforeEach` | **10000ms** |
| `cancelAllWalletGuard.test.jsx` :124-125 | top-level `beforeEach` | **10000ms** |

*Corrected 2026-09-11 (see "a per-test timeout is a third clock, and a slow body
can be a sleep"): `holderOutageRender` :53 and every in-body import in
`offerBookOutageHonesty` sit in tests that pass an explicit `20000` or `30000`,
so neither is on the 5000ms clock.*

Half the list was on the other clock. And `cancelAllWalletGuard` calls
`vi.resetModules()` before that import **on purpose**: its comment says a static
import "would give them two" `CollectionContext` instances, so the provider and the
component would stop sharing state. Hoisting it would not fix a flake; it would
break the thing the test exists to check.

**Do**, before touching any slow-test candidate:

1. Find where the cost sits — body (5s) or hook (10s). See the entry below.
2. `grep resetModules` in the file. If it resets, a hoist is illegal. The only move
   that keeps module identity is a bare warming import at the top, because every
   post-reset import still comes from one registry.
3. Only then rank by duration.

Measured on merged trunk `f8bda8b9` (full suite, 588 files / 8343 tests, 0
failures, a quiet 188s run), slowest test per file: `holderOutageRender` **3528ms,
its import in the body — about 1.4x headroom, the only thin one** ·
`offerBookOutageHonesty` 1810ms · `offerErrorHonesty` 1638ms (hook plus one body
import, not split) · `cancelAllWalletGuard` 1494ms (hook) · `bot-noncustodial`
251ms — the same test that was seen timing out at 5020ms under heavy load. One run
ranks nothing.

**The general form:** a conclusion is only as wide as the population screened. The
first sweep for this flake class looked only at files that reset inside hooks,
found nothing close to its bound, and reported that — while a body-bound test sat
at 1.4x in a directory the sweep never covered.

## 2026-09-10 — "flaky" can be a UI defect, and a warn-only gate hides it forever

**Believed:** a test that fails then passes on retry is nondeterministic — timing
noise in the harness — and a CI job that ends green has nothing to report.

**Measured** (`e2e/claim-rewards.spec.ts`, the Anvil-fork job, six consecutive CI
runs on trunk, read from the job logs):

| outcome | attempt 1 | retry #1 |
|---|---|---|
| clean pass | 2.5s / 3.8s / 3.9s | — |
| fail → pass | 6.4s / 6.4s / 6.7s | 2.6s / 2.6s / 3.3s |

(Whole-test durations, not read latency — 5s of each failure was the assertion
waiting and giving up, so the underlying read is known only to EXCEED 5s. Its
ceiling was never observed, because nothing waited long enough to see it. Worth
saying out loud: a failed assertion measures your budget, not the thing.)

The retry is not a second roll of the same die. Attempt 1 pays an Anvil fork's
COLD state — the first read of every storage slot is a round trip to the public
upstream — and by retry the fork has cached it. **A retry that is consistently
~2.5x faster than the attempt it replaces is measuring a warm cache, not luck.**
That signature separates "slow" from "broken" before you read any app code.

The 5s number on the other side of it is Playwright's default `expect` timeout.
Nothing in the repo chose it; the assertion simply never named one, and the
cold-fork cost straddles it.

**Do:** when a test is called flaky, diff attempt-1 against retry duration first.
Comparable → nondeterminism. Retry much faster → first-run cost, and the fix is
either a named budget or removing the dependency on that cost.

### The gate that let it live on trunk

`playwright.config.ts` sets `retries: process.env.CI ? 2 : 0`, and ci.yml's
money-path guard fails the run on `skipped != 0` but only `::warning`s on
`flaky != 0` — deliberately, so one fork-RPC flake cannot read as a coverage
loss. Both decisions are individually right. Together they mean a defect that
fails EVERY first attempt still produces a green job, forever, with the evidence
sitting in a warning nobody opens.

**Do:** a warn-only flaky lane needs someone reading the warnings. Grep job logs
for `passed only on retry` across recent runs — a title that appears in most of
them is not flaky, it is failing with a retry budget covering for it.

### The defect underneath: a skeleton that hides its section's name

`LPFarmingSection` early-returned a loading skeleton that drew two grey
`animate-pulse` bars where its `<h2>LP Farming</h2>` and subtitle go. Both are
compile-time constants — no read gates them — so the section withheld its own
identity for the length of an RPC round trip: an unnamed region to a screen
reader, and the one unlabelled box among five labelled sections to everyone else.

That is not a brief flicker. Read from the installed packages, not from docs:
viem 2.56.1's `http` transport defaults to a **10s** timeout and retries **3x**
per transport (`buildRequest.js`: `retryCount = 3`), the app puts two endpoints
behind a `fallback`, and `App.tsx` sets `retry: 2` on the QueryClient with
TanStack's default backoff (`min(1000 * 2**n, 30000)` — 1s then 2s). A degraded
RPC therefore holds a "loading" state for tens of seconds.

**Do:** a skeleton should shimmer what the read decides and print what it does
not. Text that is a literal in the component has nothing to wait for.

### Why this made the test unfixable-by-timeout

The assertion was `getByRole('heading', {name: /lp farming/i})`. With no heading
in the skeleton, that single locator had to mean two different things — "the
section mounted" and "its reads landed" — so there was no budget that was both
tight enough to catch a section wedged in its skeleton and loose enough to
tolerate a cold fork. Splitting it (heading = mounted, a read-derived stat =
landed, each with its own budget) is what made a named timeout honest rather
than a way to stop the test complaining.

**Do:** if you cannot pick a timeout without trading away a real failure, the
assertion is conflating two facts. Split it before tuning the number.

### Incidental

- `anvil.exe` and `cast.exe` are blocked by Windows Application Control on this
  box, sandboxed or not ("An Application Control policy has blocked this file").
  The fork job cannot be reproduced locally here — CI job logs are the
  measurement of record. `vitest` and `playwright` (mock mode) run fine.
- The default preview port 4173 is routinely held by another session's `vite
  preview`, and `playwright.config.ts` sets `reuseExistingServer: !CI` — so a
  local run silently tests whatever build that server holds. Verify the port is
  free (`netstat -ano | grep :4173`) or run with a config on another port.

---

## 2026-09-10 — a slow vitest "test" is often a slow *hook*, and hooks get 10s

**Believed:** a test reported at 2353ms is 2353ms from its 5000ms `testTimeout`,
so ranking tests by reported duration ranks them by flake risk.

**Measured** (vitest 4.1.11, `frontend/`):

| construct | bound | failure text |
|---|---|---|
| test body | **5000ms** | `Test timed out in 5000ms.` |
| `beforeEach` | **10000ms** | `Hook timed out in 10000ms.` |

A 6s `beforeEach` **passes**, and vitest reports the test as 6016ms — hook time is
folded into the *test's* duration. So a "2.3s test" whose body is
`expect(x).toBe(1)` is really a 2.3s hook with 4x headroom, not 2x.

**Do:** before calling a slow test near-timeout, find out whether its cost is in a
hook or a body. Duration alone does not rank risk.

### The cheap fix when the cost is one cold module load

Files that do `vi.resetModules()` + `await import(...)` pay the cold
fetch+transform **once**, in whichever block runs first; every later re-import is
~1ms, because `resetModules` clears the module *registry*, not the transform
cache. A bare top-level `import "../thing.js";` warms the graph during collection,
which nothing bounds, and leaves every reset in place.

Measured under full-suite load (581 files / 8145 tests): 2353ms → **5ms** and
3173ms → **11ms**, with zero source changes. Comment it as NOT dead code, or the
next reader deletes an import that appears unused.

### When you may NOT replace resets with a seam

Swapping per-test `vi.resetModules()` + re-import for a static import plus an
exported `__resetXCaches()` is only sound if the module reads env **exclusively
inside functions** and the seam clears **all** its top-level mutable state.

- `frontend/api/_lib/apiAuth.js` **qualifies** — env is read inside `getRedis()` /
  `getKeyStore()`, and `__resetApiAuthCaches()` clears all five memos.
- `frontend/api/_lib/seaport-verify.js` **does not** — `SEAPORT_CHAIN_ID` and
  `IS_PRODUCTION` are read at module scope, `_publicClient` has no seam, and two
  tests assert the *throw module scope raises* on a bad chain id, which a static
  import cannot express at all.
- `frontend/api/orderbook.js` **does not** — `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`
  are read at module scope and feed a `createClient` **singleton**, with no seam.

**Do:** grep the module for top-level `let` / `var` / `new Map()` / `new Set()` and
for `process.env` outside a function body, *before* touching the test.

### Run the mutation check AFTER the change, not only before

Neutering the resets in `orderbook.bundle-guards.test.js` failed **0** tests before
the warming import — the reset was inert, true only by coincidence, because every
block set identical env. After the import it fails **22**: the warmed instance is
evaluated before any `beforeEach` sets the Supabase env, so its client is `null`
and only the per-block re-import picks up a live one.

The change turned a coincidence into a pinned invariant — but a pre-change mutation
check alone would have reported the weaker, and by then stale, conclusion.
Mutation-check both sides of a change that alters *when* a module is evaluated.

### Incidental

- Suite wall-clock is a poor signal on a shared box. Between two runs of the same
  581 files it moved 249s → 307s, driven by jsdom `environment` setup going
  2169s → 2823s across *untouched* files. Compare per-test durations, not totals.
  Load moves the verdict too, not only the total. Two later full-suite runs of one
  tree, ~4 hours apart (2026-09-12), went 196.65s and 450.16s,
  with jsdom `environment` at 1787s and 3638s — across *untouched* files. The slow
  one failed 4 tests in 2 files, each a 5000ms body timeout plus one follow-on
  failure from the timed-out test's un-cleaned DOM (`Found multiple elements`,
  `expected length 0 got 1`). Both files passed in isolation and neither imported
  the change under test. **A timeout cascade under load is not a defect in the code
  you just wrote** — re-run before believing it, and compare per-phase durations,
  not the verdict.
- `no-unused-vars` does not flag a bare side-effect `import "x";` — it declares no
  binding. Lint will not remove the warming import; a human might.
