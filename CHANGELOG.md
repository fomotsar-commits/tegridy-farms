# Changelog

All notable changes to Tegriddy Farms are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Ongoing investor-polish and audit-closure work. Lands on `mvp-launch` as it
ships; a tagged release will cut from here once Wave 0 redeploys are complete.

> **Trunk correction (2026-07-30):** this preamble read "Lands on `main`" until
> today, and had for some time — **`mvp-launch` is the
> real trunk** and every entry below landed there. `main` has diverged
> substantially: `git merge-tree origin/main HEAD` reports **63 conflicting files**
> (1,051 files differ in total). `main` carries its own duplicate fixes — e.g. PR
> #100 duplicates a CommunityGrants fix that landed on `mvp-launch` in `1b9b2690`
> on 2026-06-02 — and a red vitest baseline that `mvp-launch` does not. Read "Lands
> on `mvp-launch`" until the two branches are reconciled.
>
> **Correction to the "ABI-supplement generator consolidated (2026-07-22)" entry
> below:** that entry is `main`-lineage and its closing claim — that
> `abi-supplement.ts` is down to "the single export the dApp actually imports,
> `TEGRIDY_TWAP_ABI`" — is false on this trunk. The file is 4,000 lines with **two**
> exports (`TEGRIDY_TWAP_ABI` line 11, `POL_ACCUMULATOR_ABI` line 1999), because
> `hooks/useProtocolEvents.ts:4` imports the latter. See the 2026-07-23 #101 entry,
> which supersedes it.
>
> **On numbers:** figures drawn from live-chain probes, production bundles, or CI
> runs are attributed to the commit that recorded them. They are internally
> consistent but are **not** reproducible from the repository.

### Fixed — The token scanner turned failed reads into verdicts, and rebuilt balances from a rounded percentage (2026-08-01)

`/scan` is live and the Ethereum holder route behind it is serving real data —
probed today against USDC and SHIB through `memetic.fun/api/v1?route=erc20scan`, so
none of the below is latent.

> **Correction (2026-08-02).** An adversarial review of this entry caught three of its
> own measurements overstated. Recorded here rather than edited away, because an entry
> about read-honesty that inflates its evidence is self-refuting.
>
> 1. **"`balance` was an unsafe float in 80%" is wrong — it is 60%.** Re-surveyed the
>    same five tokens (TOWELI/USDC/DAI/UNI/WBTC, top 100 each): **300 of 500 rows**.
>    Three tokens are ~100% unsafe and two are 0%, so "4 of 5 tokens" and "80% of rows"
>    got conflated. `rawBalance` valid in 100% of 500 rows re-confirms unchanged, and
>    that is the claim the fix actually rests on.
> 2. **"none of the below is latent" over-reaches for ONE sub-case.** The shape defects
>    — unparsable body, absent `holders`, the throttled info leg — are live-reachable.
>    The `"1e+21" → 121n` denominator path is NOT: Ethplorer returns `totalSupply` as a
>    plain digit string for every token probed, so that guard is defense-in-depth
>    against a shape this upstream does not currently emit. The hazard is real (the
>    route does `String(info.totalSupply)`, so a numeric total ≥ 1e21 would produce it)
>    but it is latent, and the entry presents it as the headline.
> 3. **"any holder under 0.005% rounds to a zero balance and drops out" was an
>    inference, not an observation.** It follows from the arithmetic, but no surveyed
>    holder actually rounded away — TOWELI's top 100 has **zero** `share == 0` rows and
>    a minimum share of 0.06%. Correct as a property of the old code; not something
>    that was measured happening.
>
> The `share`-quantization error itself (6.01% light on one TOWELI holder, 27.4700%
> vs an exact 27.4657%) and the exclusion measurements (15 of TOWELI's top 100 have
> code; 40 of WBTC's; top holder 27.87% against a top person 1.47%) were re-checked
> and stand.

**A payload we could not read is not a finding about somebody's token.** Every read
has three outcomes and only two are answers: *read it, the answer is no*; *read it,
the answer is yes*; *could not read it*. Both adapters and the route collapsed the
third into the first:

- `parseSolanaScan` read a missing `supply.value.amount` as "No SPL token supply
  found at that address — is it a valid mint?", took `largest.value ?? []` as an
  empty holder set, and — the flattering direction — read a mint account that did
  not come back in `jsonParsed` form as **authority renounced**, silently removing
  the `concentrated` floor a live mint authority imposes.
- `parseEthereumScan` did the same with `Array.isArray(json.holders) ? … : []`: a
  body with no holder list became `ScanError('empty')`, which renders as "No holder
  data for this token — double-check the address is a token (not a wallet or an
  NFT)" — byte-identical to what a genuinely holder-less token produces.
- The `erc20scan` route completed the pattern at the one end that can **cache** its
  mistake. The 2026-07-24 fix caught non-2xx and `{error}` envelopes but not a 200
  carrying a CDN interstitial or a gateway HTML page — the ordinary way an upstream
  fails *without* a status code. `catch { top = {} }` plus `(top.holders || [])`
  made that a 200 with `holders: []`, stamped `s-maxage=120` and served to everyone
  who scanned that token for the next two minutes.

**The value-level half is worse, because it does not fail — it succeeds and renders
a report.** `toBig` stripped a decimal tail and then every remaining non-digit, so a
`totalSupply` that was not a plain decimal became a *different* integer. `"1e+21"` —
exactly what `String(n)` yields for any JSON number ≥ 1e21, the size a meme-coin
supply actually is — became `121n`. Nothing throws: `classifyHolders` only
substitutes the enumerated sum when the total is `0n`, so a wrong-but-nonzero
denominator is used as-is and `ratio()` clamps at `part >= whole`. Measured on a
healthy 100-holder fixture whose largest holds 3% of a 1e33 supply:
`top1ShareOfTotal` **0.03 → 1**, band **"mixed" → "concentrated"**, and the
`single-holder-majority` gate **fired**. A maximum-severity red flag about a clean
token, computed from a field the scan never read. The same coercion one field down
points the other way: a holder reported as `"9.9e32"` parsed as `9n`, and a wallet
that really holds 99% of supply was published at `top1ShareOfTotal` 0.001,
effectiveHolders 99, band **"well-distributed"**, no gate fired.

**And the balances were never the balances.** Ethplorer hands over the exact
base-unit integer in `rawBalance`. The route ignored that field and rebuilt every
balance as `totalSupply × round(share × 1e4) / 1e6` — and `share` is a percentage
rounded to **two decimals**, a fixed ±0.005pp error whose *relative* size explodes as
holdings shrink. Measured against the live route on TOWELI, our own token: one
holder published as `700000000000000000000000` against an actual
`744733489701014745728907` — **6.01% light, 44,733 TOWELI** — and the top holder
reads 27.4700% today against an exact 27.4657%. At the tail it is not merely
imprecise: any holder under 0.005% rounds to a zero balance and **drops out of the
enumerated set**, understating concentration.

Now: unreadable throws `ScanError('network')`, which renders "Couldn't complete the
scan" with a retry — a statement about the READ. The codes deliberately *not* used
for it were checked against what each caller renders first: `'empty'`/`'not-found'`
emit the "double-check the address is a token" copy, and `'unavailable'` renders
deployment copy that literally reads "Solana token scans work today". Both would
launder a failed read into a finding. The route reads `rawBalance` (falling back to
`balance` only when that number is an exact integer), treats an unparsable
`getTokenInfo`, a present-but-unreadable `totalSupply`, and an unreadable holder row
as failed reads, and takes the uncached 502 path. What stays an ANSWER also stays: an
**absent** `totalSupply` is the route's documented gap, `holders: []` is still a
cached 200, a zero balance and a non-address row are still dropped, and an auth
failure is still the 403 the client renders as the honest deployment gap.

An adversarial review of the above caught two cases the first pass missed, both now
closed. **The info leg was never checked at all** — only `getTopTokenHolders` was —
and a typeof-object test cannot see an Ethplorer `{error:{code:429}}` envelope,
because an envelope *is* an object. The two calls race one API key in parallel, so
exactly one being throttled is routine rather than exotic (reproduced live on
`freekey`). That published `totalSupply: null`, which is not a missing label: the
core then substitutes the enumerated top-100 sum as the denominator, inflating every
share by 1/coverage — **1.216× measured on UNI's live top-100** — under a stat tile
captioned "of total supply", and a large enough holder crosses the 50%
`single-holder-majority` gate and floors the band at `concentrated`, cached 120s,
reading clean again once the quota resets. `infoRes.ok` and the info-side error
envelope are now part of the same failure test. Second: rows arriving but **none**
being attributable derived `holders: []` by discarding every one of them — the same
laundering in slow motion. Non-empty in, empty out, is now drift.

Reading `rawBalance` was verified before it was relied on: across 500 real rows
(TOWELI/USDC/DAI/UNI/WBTC, top 100 each) it was a valid digit string in **100%**,
while `balance` was an unsafe float in **60%** (300 of 500 rows; see the correction
note at the head of this entry) — the old fallback was the fabricating
path, not the safe one. The `share` reconstruction and its `totalBig` are deleted.
Two guards were written and then deleted rather than kept, because no mutation could
kill them: a body-level object guard on the client and a parse-failure flag on the
server, both already subsumed by the holder-list check.

Verified against the live upstream rather than fixtures alone: the real handler
driven through real Ethplorer responses returns 200 with 100 holders for all five
tokens (TOWELI 27.4657%, USDC 8.4430%, DAI 17.3775%, UNI 26.7247%, WBTC 27.8745%),
enumerated sum never exceeding total supply. An unspaced run of the same probe 502s
on the freekey rate limit — the hardening doing its job, failing closed on a
transient upstream instead of caching a token with no holders.

Tests mutation-checked individually, not just in bulk: reverting the client source
turns 9 red and the server source 3; each remaining guard then kills only its own
tests (holders-array 3, base-unit digits 4, safe-integer 1, body narrowing 1,
rawBalance preference 5, unparsable info 1, unreadable row 5, fail-vs-drop 2). The
preserved-behaviour tests stay green both ways, which is what shows the hardening did
not blunt the real answers. Frontend suite green — 169 files, 2411 tests — `tsc -b`
and ESLint clean.

**And the exclusion pass was inert on Ethereum the whole time.** The detection core
removes structural holders — LP pairs, CEX wallets, bridges, lockers, vaults — from
the person-held distribution, and its only generic input is `isContract`. Ethplorer
does not send that field, so `!!h.isContract` was `false` for every row: the pass ran
and matched nothing. Measured against the live route, 15 of TOWELI's top 100 holders
have code — including the LARGEST at 27.47%, which is the **Uniswap V2 pair itself**,
and the staking contract at 5.1% — so the headline read "largest holder 27.47%" where
the largest PERSON holds 3.71%, and 6.0 effective holders against a real 23.1. WBTC is
worse: **40 of its top 100 have code**, top holder 27.87% against a top person of
**1.47%**, a 19x overstatement on the one number the page exists to report.

The route now reads it, batching `eth_getCode` over the enumerated holders through a
configured Alchemy key then the three keyless public nodes the repo already trusts
(`_lib/eth-code.js`, mirroring the roster and per-attempt timeout in
`_lib/seaport-verify.js`). A batch that answers only some of its ids, answers one
twice, or returns a non-hex result is rejected rather than partially trusted — partial
trust would silently mark the unanswered addresses EOAs, which is the same defect one
level down. An unreadable batch fails closed: a distribution verdict whose exclusion
pass did not run is exactly what this route has spent three commits removing. The
upstream's own `isContract` is no longer consulted at all; a value we never read is
not a classification.

**Operator note:** this changes numbers on a live surface. Balances become exact, so
published shares shift slightly and sub-0.005% holders reappear in the set. It also
fails closed where it used to degrade: if the upstream changes shape or drops
`rawBalance`, scans 502 rather than publishing approximations.

### Security — Solana partner config went live against a custody gate that could not see a 1-of-1 (2026-08-01)

The operator ran `create-config --send`, so a **Meteora DBC partner config now exists
on Solana mainnet** and the launcher rail is armed. **Zero tokens have launched through
it**; every figure on `/solana-launch` is still a builder default, not a track record,
and the page keeps its no-signer / no-submit design.

The config was created while the in-code custody gate was weaker than its own docs
demanded. `verifySquadsVault` proved only (1) the parent multisig is Squads-v4-owned and
(2) the fee address is that parent's canonical vault PDA. It never deserialized the
account, so two things passed that must not:

- a **1-of-1** Squads multisig — a single-key drain of all accrued Solana fees, wearing
  multisig custody as a label; and
- any **other Squads-owned account type** (`Proposal` / `VaultTransaction` /
  `ProgramConfig`), since only the program-owner was checked and not the 8-byte Anchor
  discriminator that identifies a `Multisig`. Naming one of those as `feeClaimer`
  produces a config **nobody can ever sign a claim for — stranding 100% of partner fees
  irreversibly.**

`frontend/src/lib/launcher/solana/README.md` had carried the instruction *"Fix that
guard BEFORE running create-config"* since it was written. The fix existed — authored
2026-07-26 — but sat on an unpushed local branch and reached no remote, so the trunk
(and every clone of it) still shipped the weak gate.

Now enforced, dependency-free: a discriminator-**guarded** byte read confirms the account
is a genuine Squads v4 `Multisig` (discriminator computed as `sha256("account:Multisig")[0:8]`,
not trusted from memory) and reads `threshold` as u16-LE at offset 72, requiring `>= 2`.
The guard is what makes a hand-rolled offset safe: offset 72 is only ever read on an
account already proven to be a `Multisig`, so a wrong account type, short data, or a
missing account returns `null` → reject, never a spuriously-high threshold that would
*accept* a bad vault.

Mutation-checked: weakening the constant to `>= 1` fails exactly the threshold-1 test and
nothing else. Frontend suite green — 157 files, 2037 tests — and `tsc --noEmit` clean.

Docs and UI reconciled in the same change: the README's Solana rows move from "preview
only" to "rail armed, 0 launches", and `/solana-launch` no longer tells readers
"submission stays disabled until the launcher is enabled and a Squads vault is verified"
— both of those conditions are now met, yet submission is deliberately still absent, so
that sentence had become an implied promise the page never intends to keep.

### Fixed — Launcher unblocked: a 300s oracle gate, a stranded fee line, and 10x-wrong auction bands (2026-07-30)

Three independent launch-path defects, all closed in `3ff679f9`
([#160](https://github.com/fomotsar-commits/tegridy-farms/pull/160)).

- **The launch button refused roughly six attempts in seven.** The EVM wizard
  shared the swap path's Chainlink staleness gate (`MAX_STALENESS_SECONDS = 300`)
  but mainnet ETH/USD publishes on a ~3600s heartbeat. The commit records a
  measurement over 40 consecutive rounds (~25.5h) in which *every* inter-round gap
  exceeded 300s — a creator who filled in the wizard got "ETH price unavailable
  right now" while the feed was perfectly healthy (read live at `updatedAt` age
  2028s, price $1913.41). Swaps keep the tight window, because a quote off a
  50-minute-old round is a real loss; the launch path now reads a separate
  `ethUsdForLaunch` at heartbeat-plus-margin, since the numeraire price only sets
  the auction's opening band. Feed validation was extracted into a pure
  `evaluateEthUsdFeed` so both windows are unit-testable
  ([`frontend/src/hooks/useToweliPrice.ts`](frontend/src/hooks/useToweliPrice.ts)
  — `MAX_LAUNCH_STALENESS_SECONDS = 3900` at line 65, still separate from the
  300s swap window at line 49). New
  [`frontend/src/pages/launchPriceWiring.test.ts`](frontend/src/pages/launchPriceWiring.test.ts)
  exists as a source guard because `LaunchPage`'s `onLaunch` path had no unit
  coverage at all: reverting it to the swap-path `ethUsd` initially broke nothing.
- **100% of the protocol's 15% fee line was pointed somewhere it could never be
  claimed.** RevenueDistributor was named as a Doppler locker beneficiary, but
  `StreamableFeesLocker.releaseFees` pays `msg.sender` only and
  RevenueDistributor's deployed ABI has 35 non-view functions with no
  arbitrary-call or multicall — so no transaction with it as `msg.sender` of a
  locker claim can exist. Both numeraires now route to the Treasury Safe (v1.4.1,
  threshold 2), which can originate the claim. This had to land **before launch
  #1** because the beneficiary set is fixed at create time. A hardcoded
  "Tegridy stakers" literal in `beneficiariesToFeeConstitution`, which would have
  republished a false recipient on every post-graduation re-attestation, was
  caught by a test and removed. **This supersedes the numeraire-aware sink shipped
  days earlier in [#125](https://github.com/fomotsar-commits/tegridy-farms/pull/125)**
  — `protocolFeeSink()` now ignores its numeraire argument entirely
  (`protocolFeeSink(_numeraire = ETH_NUMERAIRE)`, line 247) and returns Treasury /
  "Tegridy treasury" for both pairs. **Two stale JSDoc blocks survive in
  [`frontend/src/lib/launcher/launchService.ts`](frontend/src/lib/launcher/launchService.ts)**
  and still describe the old ETH→RevenueDistributor behaviour: `FeeRoleAddresses`
  at lines 340–353 ("RevenueDistributor for an ETH pair… Defaults to the ETH-pair
  'Tegridy stakers'") and the reverse-resolver's labelling table at line 375
  (`protocolStakers -> 'Tegridy stakers'`).
- **Auction bands would have gone on-chain ~10x wrong.** The Doppler SDK's
  `marketCapToTicksForDynamicAuction` takes `Math.abs()` of both raw ticks then
  min/maxes them, destroying the ordering when the ticks straddle zero — routine
  on a cheap numeraire like TOWELI. On shipped wizard defaults a declared
  $300k → $30k band went on-chain as roughly $30.1k → $8.3k, and `Airlock.create`
  *simulated successfully*, because nothing downstream rejects it.
  `buildTegridyLaunchParams` now reverses the built ticks through the SDK's own
  `tickToMarketCap` and refuses before signature if the round-trip disagrees by
  more than 2% (`MARKET_CAP_ROUND_TRIP_TOLERANCE = 0.02` at line 292;
  `assertMarketCapBandRoundTrips` declared at
  [`frontend/src/lib/launcher/airlock.ts`](frontend/src/lib/launcher/airlock.ts)
  line 340, called at line 287). The inverse is mirrored locally rather than
  statically imported so the SDK's Solana codecs do not get dragged into every
  chunk touching `airlock.ts`; a drift test pins the mirror against the real SDK
  function, and the commit records that the LaunchPage chunk contains 0 SDK
  markers while growing 875 bytes. Also fixed: `airlock.test.ts`'s mock builder
  returned `{ ok: true }`, a shape the real SDK never produces, so that entire
  file had been asserting policy against a fiction.

### Fixed — Launcher revenue and provenance were both invisible: an empty feed, a wrong locker ABI, a wrong Airlock selector (2026-07-30)

Five commits across
[#178](https://github.com/fomotsar-commits/tegridy-farms/pull/178) →
[#179](https://github.com/fomotsar-commits/tegridy-farms/pull/179) →
[#180](https://github.com/fomotsar-commits/tegridy-farms/pull/180) (its fourth
squash section) →
[#181](https://github.com/fomotsar-commits/tegridy-farms/pull/181) →
[#182](https://github.com/fomotsar-commits/tegridy-farms/pull/182). Read them as
one story: the launcher could neither show what it had launched nor see, let
alone move, what it had earned.

- **Explorer and Afterlife could never list a launch** — `LaunchPage.tsx:250`
  read `const baselines: LaunchBaseline[] = []`. The whole enrichment path behind
  it was built and deployed; only the feed was missing. New
  [`frontend/src/lib/launcher/ourLaunches.ts`](frontend/src/lib/launcher/ourLaunches.ts)
  supplies it and deliberately is **not** a topic filter: Airlock's
  `Create(address asset, address numeraire INDEXED, address initializer, address
  poolOrHook)` indexes only the numeraire and the integrator appears nowhere in
  the log (2 topics, 3 data words, confirmed against the SDK ABI and a real log),
  so filtering `Create` by integrator would match nothing forever —
  indistinguishable from "we have not launched yet". Discovery is two-phase:
  enumerate `Create`, then read each asset's `getAssetData(asset)` record (output
  index 9) and keep the ones whose integrator is ours. Fails closed throughout.
- **Graduation attestation was calling a locker function that does not exist on
  our locker.** [`lockerStream.ts`](frontend/src/lib/launcher/lockerStream.ts)
  read `streams(poolId)` on locker V1 and its own header asserted V1 "HAS the
  enumerable `streams(bytes32)` getter" — exactly backwards. Re-probed on
  mainnet: V1 `0xe24F…1eC6` (ours) reverts on `streams(bytes32)` and returns 128
  bytes for `positions(uint256)`; V2 `0xce32…3d47` is the reverse. A revert
  proves absence, since a generated mapping getter returns zeros for a missing
  key. So every read reverted, the catch reported "not graduated", and no token
  could ever be attested — while the tests stayed green because they mocked a
  V2-shaped return the real contract never produces. **This retroactively made
  the post-graduation re-attestation feature shipped in
  [#120](https://github.com/fomotsar-commits/tegridy-farms/pull/120) inert for
  its entire life** — which, from the file's own history, is the **four days**
  between its introduction on 2026-07-26 and this correction on 2026-07-30. (The
  commit body says "for weeks"; `git log -- frontend/src/lib/launcher/lockerStream.ts`
  returns exactly two commits, 07-26 and 07-30.) Rewritten against the probed
  surface as `LOCKER_V1_ABI`
  (`positions(uint256)->(address,uint32,uint32,bool)`,
  `beneficiariesClaims(address,address)`), which makes `readLockPosition` and
  `readBeneficiaryClaim` — real re-attestation against known published
  beneficiaries — work today. **The end-to-end feature is not restored:**
  `readMigrationStream` now returns `unsupported: true` rather than a bare
  `graduated: false`, because V1 is keyed by the UniV4 position `tokenId`, not a
  PoolId, and resolving token → tokenId needs the locker's own `Lock` event, whose
  signature is not derivable from the SDK and cannot be sampled (the path is
  dormant; V1 holds zero positions). The fix makes the failure honest and keeps
  "cannot read" apart from "has not graduated"; it does not make the read work.
- **Integrator revenue was invisible because the hand-rolled Airlock ABI named a
  function the contract lacks.** `AIRLOCK_FEES_ABI` declared
  `integratorFees(address,address)` (`0x2b79198a`), which the deployed Airlock
  `0xde35…9dFA` does not implement; `readClaimableFees` reads through multicall
  with `allowFailure: true` and drops non-success entries, so every read failed
  silently and the UI showed "nothing to claim" over live fees. Funds were never
  stuck — the write path was unaffected — only invisible. Verified on mainnet two
  independent ways (the old selector reverts and is absent from a PUSH-honouring
  opcode walk; `getIntegratorFees(address,address)` = `0xe7f0d8f1` returns a
  uint256 word and is present) and against the canonical
  `whetstoneresearch/doppler` source. Same root cause as the locker bug: the
  fragment was copied from the SDK's `airlockAbi`, stale relative to the deployed
  contract. To stop the class recurring, a dependency-free
  [`frontend/scripts/capture-airlock-selectors.mjs`](frontend/scripts/capture-airlock-selectors.mjs)
  snapshots the contract's real selector set into a fixture and a hermetic test
  derives selectors from the production ABI objects with viem and asserts each
  exists. `LOCKER_V1_ABI` was breadth-checked; no second instance.
- **Nothing in the repo could collect a fee, and nothing could trigger a
  migration.** `Airlock.collectIntegratorFees` was live on-chain with zero callers,
  and nothing called `migrate(asset)` either — so a launch could sit un-migrated
  waiting for a stranger to push it. #178 added
  [`frontend/src/lib/launcher/integratorFees.ts`](frontend/src/lib/launcher/integratorFees.ts)
  with `readClaimableFees`, `collectIntegratorFees`, `migrateAsset` and
  `canMigrate`. Writes simulate before requesting a signature, so a revert
  surfaces before the user signs, and the **simulated** request is what gets
  signed.
- **`readOurLaunches` reported a partial provenance read as a complete one**
  (#180, fourth squash section). It used `multicall(allowFailure: true)` and
  silently skipped every failed asset read, while its own doc comment promised the
  opposite. A rate-limited or flaky RPC could therefore turn a real cohort into a
  confident, clean "nothing has launched yet" — a fabricated track record on the
  one surface whose entire purpose is not fabricating one. Made all-or-nothing:
  any unreadable candidate returns empty.
- **Collection wired to a real operator surface, behind a second admin role**
  (#181). `integratorFees.ts` was correct and had **zero consumers** — proof it was
  dead: the module appeared in no chunk of the deployed bundle (memetic.fun swept
  recursively to convergence, 288 chunks) and had been tree-shaken out entirely.
  [`frontend/src/hooks/useIntegratorFees.ts`](frontend/src/hooks/useIntegratorFees.ts)
  and
  [`frontend/src/components/launcher/IntegratorFeesPanel.tsx`](frontend/src/components/launcher/IntegratorFeesPanel.tsx)
  now render balances plus a per-currency withdraw whose `to` is fixed to the
  connected account, never free text. Fees accrue per `(integrator, token)` where
  token is both the numeraire *and* the launched asset, so both sides are
  enumerated — checking only numeraires would under-report revenue. **`readClaimableFees`
  changed shape for the same honesty reason**: a bare array made "every balance is
  zero" and "the RPC died" indistinguishable at the call site, next to a withdraw
  button; it now returns `{ fees, unreadable }` and the panel renders three
  distinct states — nothing owed, could-not-read, and partially-read ("incomplete,
  not a total"). The admin gate widened to two roles because `collectIntegratorFees`
  debits `msg.sender`, so only `LAUNCHER_INTEGRATOR_ADDRESS` (`0xD355…1051`) can
  withdraw and that is not the protocol owner (`TegridyStaking.owner()` =
  `0x1489…456E`) — gating on `isOwner` alone would have shown "Not Authorized" to
  the only wallet that can move the money. The widening is asymmetric and pinned
  both ways (`AdminPage.tsx:375` is now `if (!isOwner && !isIntegrator)`).
  Reachability verified in a production build: `getIntegratorFees` and the panel's
  strings now appear in `dist/assets/AdminPage-*.js`.
- **The panel's "could not look" state was unreachable — the catch block was dead
  code** (#182). `useIntegratorFees` derived `assetsUnavailable` from a try/catch
  around `readOurLaunches`, but that function never throws — every failure path
  degrades to an empty result — so the flag was permanently false and the panel
  could say "Checked N currencies and every one read back zero" while asset
  discovery had silently contributed nothing. The hook's test passed because it
  mocked `readOurLaunches` with a rejection: a mock can be made to throw, the real
  function cannot — the same mock-tests-the-interface-against-itself blind spot
  that hid the `getIntegratorFees` bug one layer up. **#180 made this sharper
  rather than causing it**: its all-or-nothing rule means one unreadable asset now
  collapses the whole result to empty too, so a bare empty result conflates *four*
  states — no launches yet, `getLogs` failed, aborted, and partial read.
  `readOurLaunches` now returns a `complete` flag, true only when the full
  candidate set was enumerated and every candidate's provenance read back; an empty
  list with `complete: false` is an absence of knowledge, not a finding. Additive,
  and pinned with an explicit test that the function never throws, so the next
  consumer does not rebuild the same dead catch.

### Security — memetic.fun was not on its own API allowlist; 12 origin-gated surfaces 403'd the canonical domain (2026-07-30)

`c59a1c99` ([#180](https://github.com/fomotsar-commits/tegridy-farms/pull/180)).
Verified live before the fix: `POST https://memetic.fun/api/solrpc` with
`Origin: https://memetic.fun` returned **HTTP 403 `{"error":"Origin not
allowed"}`**. Every origin-gated surface under `frontend/api/` hardcoded a
3-entry allowlist naming `nakamigos.gallery` and `tegridyfarms.vercel.app` and
fell back to `process.env.ALLOWED_ORIGIN`, which is not set in production — so
the production domain was excluded from its own allowlist. Consequence: every
browser-side Solana RPC call from the live site was dead, and eleven other
surfaces were one code path away from the same. `https://memetic.fun` and `www`
were added to all twelve.
[`frontend/api/auth/siwe.js`](frontend/api/auth/siwe.js) is one of the twelve and
took the same two-line edit, but needed no separate **domain-list** change,
because it derives its SIWE `domain` allowlist from the same origin set, so origin
and domain binding stay coherent by construction.
[`frontend/api/__tests__/canonical-origin.test.js`](frontend/api/__tests__/canonical-origin.test.js)
pins it with a guard that any file gating on the vercel origin must also list
memetic.fun, so a newly added origin-gated surface fails too — mutation-checked
at 13 tests red, 285/285 api tests passing.

### Added — LockerClaimer (built, **not deployed**), and a Solana operator harness that can finally build a transaction (2026-07-30)

Two further halves of `c59a1c99`
([#180](https://github.com/fomotsar-commits/tegridy-farms/pull/180)). The harness
item is a Fixed, carried here because it shipped in the same commit.

- [`contracts/src/LockerClaimer.sol`](contracts/src/LockerClaimer.sol) is the
  unwind for the fee-sink problem #160 worked around. Doppler's
  `StreamableFeesLocker` is pull-based and self-addressed, so naming
  RevenueDistributor as beneficiary strands the protocol's 15% forever — which is
  why `protocolFeeSink()` points at the Treasury Safe today, at the cost of the
  fee line no longer being real yield to veTOWELI stakers. LockerClaimer is the
  smallest contract that can both *be* a beneficiary and *originate* the claim:
  `claim(tokenId)` releases and pushes ETH to RevenueDistributor;
  `sweepToken(token)` pushes a non-ETH leg to the Treasury (RevenueDistributor
  distributes `address(this).balance`, so an ERC20 sent there is dead weight).
  Both destinations are **immutable** — no owner, setter, proxy or selfdestruct —
  so a re-pointable fee sink cannot become a rug vector, and `forwardETH()` means
  a contract with no rescue function still cannot strand ETH. Grounded in the
  deployed locker `0xe24FC2F7191e850e2D4514aBb4d39305b1871eC6` rather than its
  docs: the commit records an opcode walk of its 7,198-byte runtime finding 4
  `CALL` sites, all preceded by `GAS`, with the 2300-stipend constant
  (`PUSH2 0x08fc`) absent — so the locker forwards all gas and reverts the whole
  release if the beneficiary's `receive()` fails, which is why `receive()` is
  deliberately bare and deliberately **not** `nonReentrant`. A late correction in
  the same PR **retracted** the adoption docs' claim that the beneficiary set is
  immutable per launch: the live locker exposes `updateBeneficiary(uint256,address)`
  (selector `0x3e8eb5a4`, verified present), which lets the current beneficiary of
  a slot re-point it — so **Treasury can migrate an existing launch's slot to a
  deployed LockerClaimer with a Safe transaction, and already-created launches are
  not stranded.** LockerClaimer deliberately cannot call it itself; the lever stays
  with the Safe, because a fee sink that can re-point itself is a rug vector. A
  Slither suppression for a false incorrect-equality on `_forwardETH` was added and
  then **reverted in the same PR**: the `disable-next-line` annotation had five
  lines of justification between it and the `if`, so it silenced a comment, and the
  identical pattern in `TegridyFeeExecutorRouter._payout` is unsuppressed.
  **Status: not deployed, not wired.** There is no deploy script anywhere under
  `contracts/script/`, the only frontend references are prose comments
  (`config.ts:97`, `launchService.ts:239`), and `protocolFeeSink()` still returns
  the Treasury. Adoption path is deploy → on-chain read-back of the three
  immutables → flip the sink.
- **The Meteora DBC operator harness had never been able to construct a
  transaction**, which is why nothing had ever been created on Solana mainnet
  through it. The DBC SDK builds every tx via anchor's `.transaction()`, which
  returns a bare `new Transaction()` with instructions and nothing else — the SDK
  dist contains zero references to `feePayer` or `recentBlockhash` — and web3.js
  refuses to compile a message without both, so `partialSign` threw "Transaction
  recentBlockhash required" and `serialize` threw "Transaction fee payer
  required". Both reproduced directly against web3.js. Every money path
  (create-config / launch / claim) died there. `finishSigning` became
  `prepareAndSign` in
  [`frontend/src/lib/launcher/solana/dbcClient.ts`](frontend/src/lib/launcher/solana/dbcClient.ts),
  stamping `feePayer` (the *descriptor's* payer, not `signer.publicKey` — the
  default print path passes no signer), `recentBlockhash` and
  `lastValidBlockHeight`; the blockhash is fetched at `'finalized'` rather than
  the connection's `'confirmed'` default, because a confirmed-but-unfinalized
  hash can be dropped by a fork switch and silently invalidate a tx sitting in a
  Squads ceremony. A follow-up in the same commit fixed `printValidityWindow`,
  which measured the remaining runway against `'finalized'` and so overstated it by
  ~32 slots (~14s) — the one direction that gets a ceremony submitted after the
  tx is already dead; it measures against `'confirmed'` now, which errs short.
  **Two harness docs were corrected, and the correction was partial**: the
  operator-harness sections that claimed `SOLANA_LAUNCHER_ENABLED` is false and
  that money-path commands "throw at the gate" were fixed (those commands are live
  and `--send` really broadcasts), but the same false statement survives elsewhere
  — see the doc-drift note in the 2026-07-26 entry. No safety invariant changed:
  the enable gate, on-chain Squads vault verification, u64 bounds re-assertion,
  threshold ≥ 2 warning and `claim --send` refusal are all intact. *The commit's
  claim of 8 new tests / 77 passing and a mutation check turning 7 of 8 red was
  not re-run and is unverified here.*

### Added — Graduation into our own venue: a V4 migrator (EVM) and a bonding curve (Solana), both dormant (2026-07-30)

The two halves of the own-venue directive, split out of the abandoned #128 (which
had bundled ~6,000 lines across 23 files that share no code). **Neither is
deployed.**

- **EVM leg** — `63dbfaef`
  ([#161](https://github.com/fomotsar-commits/tegridy-farms/pull/161)) adds
  [`contracts/src/v4/TegridyLiquidityMigrator.sol`](contracts/src/v4/TegridyLiquidityMigrator.sol),
  an Airlock-callable migrator that graduates a Doppler launch into a canonical
  Uniswap V4 pool carrying `TegridyV4Hook`, plus
  [`contracts/src/v4/TegridyFeeLocker.sol`](contracts/src/v4/TegridyFeeLocker.sol),
  which pays out the fee constitution. It also extends
  [`TegridyV4Hook.sol`](contracts/src/v4/TegridyV4Hook.sol) and
  [`TegridyV4HookAdmin.sol`](contracts/src/v4/TegridyV4HookAdmin.sol) and adds the
  deploy wiring in
  [`contracts/script/DeployV4.s.sol`](contracts/script/DeployV4.s.sol) — so unlike
  LockerClaimer, this one *has* a deploy path; what it lacks is a whitelist. Two
  deliberate design points: the migrator decodes exactly the shape the Doppler SDK
  encodes, `(uint24 fee, int24 tickSpacing, uint32 lockDuration, BeneficiaryData[])`
  — an earlier draft decoded a bare `int24` and would have reverted on the first
  real launch — and it **fails closed** when beneficiaries are supplied while
  `feeLocker` is unset, rather than accepting and silently dropping the list,
  which would make every Fact Sheet's published split false. `forge test` on
  `test/v4` went 42 → 73 passing; the `v4` CI slice picks them up automatically.
  `TEGRIDY_V4_MIGRATOR_ADDRESS` in
  [`frontend/src/lib/launcher/constants.ts`](frontend/src/lib/launcher/constants.ts)
  is still `0x000…0`, and **that zero is load-bearing**: launches keep graduating
  via Doppler's own `uniswapV4Migrator` until Whetstone whitelists ours
  (`setModuleState = 4`) and a 48h-timelocked hook initializer allowance is
  granted. Petition drafted at
  [`docs/WHETSTONE_MIGRATOR_PETITION.md`](docs/WHETSTONE_MIGRATOR_PETITION.md).
- **Solana leg** — `458959a4`
  ([#162](https://github.com/fomotsar-commits/tegridy-farms/pull/162)) adds
  `tegridy-launch`, a from-scratch Anchor program implementing a pump.fun-shaped
  constant-product bonding curve over virtual reserves, plus `migrate_to_amm`,
  which CPIs `raydium_cp_swap::initialize` to open a Tegridy CP-AMM pool, seeds
  it with the curve's real reserves, **burns the LP tokens**, and sets `complete`
  + `pool`, all in one instruction. Properties documented in-source so a later
  edit does not undo them: launch terms (`trade_fee_bps`,
  `graduation_target_lamports`) are snapshotted onto each curve at creation so
  governance cannot retroactively rewrite economics; pausing blocks buys but never
  sells; mint authority is revoked at creation so supply can never grow; an
  overshooting buy is capped and refunded rather than rejected. An earlier
  permissionless `graduate` instruction that flipped `complete` **without moving
  funds** was removed — it permanently stranded every lamport of any launch that
  called it, since both `buy` and `sell` require `!complete`. Built, not deployed:
  `declare_id!` carries an explicit "PLACEHOLDER… MUST be replaced" comment, the
  non-devnet build embeds a System-Program sentinel for `deployer::ID` so a
  mainnet binary refuses to initialize, and nothing in `frontend/src` references
  the program. **Doc drift, still open:**
  [`docs/SOLANA_OWN_VENUE_SCOPE.md`](docs/SOLANA_OWN_VENUE_SCOPE.md), added in
  this same commit, still states at line 27 "What does NOT exist: the bonding
  curve" and "`programs/` contains only cp-swap" — false as of the commit that
  introduced it, and `programs/` now holds `cp-swap/` and `tegridy-launch/`.

### Security — Solana graduation targets our own pool PDA, closing a one-transaction permanent-brick vector (2026-07-30)

Same commit as the curve program (`458959a4`,
[#162](https://github.com/fomotsar-commits/tegridy-farms/pull/162)), called out
separately because it is the load-bearing security decision. `migrate_to_amm`
derives `pool_state` as `[b"launchpool", launch_mint]` **from this program** and
signs for it via CPI, rather than using cp-swap's canonical
`[POOL_SEED, amm_config, token_0_mint, token_1_mint]` address. The canonical
address is derivable by anyone and cp-swap's `create_pool` refuses a `pool_state`
it no longer owns, so any stranger could buy one token off a curve, wrap dust SOL,
call cp-swap directly, and **brick that launch's graduation forever for the price
of one transaction** — not theft, but the product promise is gone. cp-swap's own
second branch is the escape: a non-canonical `pool_state` is accepted provided it
*signs* (verified at its `initialize.rs:386-388`), and signer privilege propagates
through CPI, so only this program can occupy the address. The commit body and
`MIGRATE_DESIGN.md` both say explicitly: do **not** "fix" this back to the
canonical derivation, and the migration rehearsal deliberately **occupies** the
canonical pool before migrating, so a regression to the canonical seed fails CI
rather than shipping. Two limits are documented and **not** fixed: `create_pool_fee`
is 0 in CI, so the mainnet fee path that `migration_reserve_lamports` exists to
cover has never executed; and `MIGRATE_DESIGN` §10 records an **open operator
decision** — the rehearsal's 2 SOL graduation target would list at 6.7% of the
last curve buyer's price (a ~15x gap), the price-continuity invariant solves to
T ≈ 85.0164 SOL, and the program does not enforce it.

### Internal — Solana CI grew three jobs and a guard against a vacuously-passing SBF build (2026-07-30)

Test plumbing shipped alongside the curve program; no user-visible effect.
[`.github/workflows/solana-ci.yml`](.github/workflows/solana-ci.yml) gained
`launch-curve` (dependency-free curve math via plain `rustc --test`, then the SBF
build), `launch-constraints` (Anchor account-constraint tests against a local
validator), and `migration-rehearsal` (deploys both programs, creates a launch,
buys it to target, migrates, inspects the pool). Three guards are worth not
deleting: `cargo build-sbf` **can exit 0 having compiled nothing** when
platform-tools is absent — it did exactly that on 2026-07-28 and made the gate
meaningless — so the job asserts the `.so` artifact exists rather than trusting
the exit code; the build log is grepped for `exceeded max offset`, because an SBF
4KB stack-frame overflow is a *linker warning* `cargo check` cannot see that dies
at runtime as an opaque "Access violation"; and the rehearsal asserts measured
compute stays under 400,000 CU (measured cost 264,128 CU, above Solana's 200,000
default — every caller **must** set the limit or migration fails as "Program
failed to complete"). This CI is the only compile gate: the Windows dev box
cannot run `cargo build-sbf` (os error 1314, symlink privilege) or any validator.

### Added — Certora formal-verification scaffold for TegridyStaking, never executed (2026-07-30)

Merge `f9a0fafe` ([#68](https://github.com/fomotsar-commits/tegridy-farms/pull/68))
adds a 326-line [`contracts/certora/`](contracts/certora/) tree: a README runbook
+ property map, [`specs/TegridyStaking.conf`](contracts/certora/specs/TegridyStaking.conf),
[`specs/TegridyStaking.spec`](contracts/certora/specs/TegridyStaking.spec) with 6
CVL rules, and a 28-line
[`harness/TegridyStakingHarness.sol`](contracts/certora/harness/TegridyStakingHarness.sol).
Each rule is a 1:1 translation of an existing symbolic-execution check in
[`contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol`](contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol)
— `globalCapRespected`, `perUserCapRespected`, `principalRecoverableAfterStake`,
`capCannotBeZeroed`, `pauseAuthExclusive`, `guardianCannotUnpause` — and the
layout deliberately mirrors OpenZeppelin's `lib/openzeppelin-contracts/fv/`.
**Stated honestly: no prover run has ever happened.** Running these needs a
Certora license and cloud subscription; the only validation performed was that the
harness compiles under `forge build`. Grep for `certora` across `.github/` and
both `package.json` files returns nothing, so no CI job or npm script invokes the
prover. The commit promised follow-up PRs adding Restaking / RevenueDistributor
rules; `git log -- contracts/certora` shows exactly one commit ever, so those
never landed. **Date note:** the merge is authored 2026-07-30 but the underlying
work commit `4ae6a12f` is authored 2026-05-23 — the PR sat open ~10 weeks.

### Changed — Dependency policy rewritten so majors stop holding safe bumps hostage; wagmi 3 and ESLint 10 taken deliberately (2026-07-30)

- `9f583010` ([#159](https://github.com/fomotsar-commits/tegridy-farms/pull/159)) —
  the three Dependabot groups (web3-stack, react, tooling) had no `update-types`,
  so they swept major bumps in, and because a group is all-or-nothing **one
  unmergeable major blocked every safe bump beside it**. All three grouped PRs
  failed this way on the same day: #149 (wagmi 2→3 blocking a viem minor and a
  rainbowkit patch), #151 (typescript 5.9→7.0 blocking vite/plugin-react/
  react-hooks and carrying eslint 9→10 plus @types/node 24→26 — three majors in
  one PR), and #155 (jsdom 29→30 + undici 7→8). All three groups are now
  `update-types: ["minor", "patch"]` in
  [`.github/dependabot.yml`](.github/dependabot.yml), so majors arrive as
  single-package PRs where the blast radius is legible — which matters most for
  wagmi/viem, since this app signs transactions and a wallet-layer major is a
  migration, not a bump. `typescript` majors are separately added to `ignore`
  because typescript-eslint refuses to load against TS 7.0 (`npm run lint` exits
  2 before linting a single file); tracking typescript-eslint#10940.
- `0e3971d5` + `ad0145dd`
  ([#176](https://github.com/fomotsar-commits/tegridy-farms/pull/176)) — **wagmi
  2.19.5 → 3.7.5.** The blocker on the failed #167 turned out not to be wagmi's
  fault at all: [`frontend/src/lib/irysClient.ts`](frontend/src/lib/irysClient.ts)
  reads `window.ethereum` and compiled only because something in the
  wagmi/viem/RainbowKit tree happened to pull `viem/window` in transitively — a
  contract none of them make. wagmi v3 stops doing it and `tsc` fails with
  `TS2339: Property 'ethereum' does not exist`. New
  [`frontend/src/viem-window.d.ts`](frontend/src/viem-window.d.ts) carries
  `/// <reference types="viem/window" />`, keeping the type exactly what viem says
  it is (`EIP1193Provider`) rather than redeclaring it as `any`; it is required
  rather than tidy because `tsconfig.app.json` sets `"types": ["vite/client"]`,
  suppressing automatic @types inclusion. The lockfile was regenerated on current
  trunk rather than taken from #167, which would have silently reverted that day's
  viem/rainbowkit/ethers/doppler-sdk merges.
- `70d2b151` ([#177](https://github.com/fomotsar-commits/tegridy-farms/pull/177)) —
  **ESLint 9 → 10 plus @eslint/js 10**, with all 9 new errors triaged
  individually. `useSiweAuth.js` now passes `{ cause: err }` so a wallet rejection
  keeps the provider's original code and detail; the other 8
  (`no-useless-assignment` on money paths — `stakeWei`, DCA `minOut`, limit-order
  `onChainOut`, the Seaport order hash) were downgraded to `warn` in **both** the
  JS and TS config blocks rather than deleted, because the safety initialiser is
  what guarantees a defined value if a later edit adds a branch that forgets to
  assign.
- Between 2026-07-22 and 2026-07-30 the repo also absorbed **22 Dependabot
  merges** — 13 npm (React group, tooling group, web3-stack group, zod 4.4.3
  #154, vitest 4.1.10, ethers 6.17.0, @solana/spl-token, @upstash/redis,
  papaparse, doppler-sdk 1.0.33, rollup-plugin-visualizer 7.0.1, typescript-eslint
  8.65.0) and 9 GitHub Actions (codeql-action, setup-node 7, actions/cache 6,
  download-artifact 8, gh-release 3, gitleaks-action 3, slither-action 0.4.2).
  Current pins: `wagmi ^3.7.5`, `viem ^2.55.10`, `eslint ^10.8.0`,
  `@eslint/js ^10.0.1`, `zod ^4.4.3`, `typescript ~5.9.3`. **Caveat stated in the
  commits themselves:** the wagmi bump proves type/unit/build compatibility only,
  because the E2E money-path specs that would exercise real signing are still
  Anvil-gated and run in no pipeline. 137 ESLint warnings remain by design,
  including ESLint 10's new `react-hooks/purity` and `react-hooks/set-state-in-effect`
  findings, explicitly deferred.
- Second, unrelated half of #159: **30 tests added for the R080 boundary schemas**
  ([`frontend/src/lib/schemas/schemas.test.ts`](frontend/src/lib/schemas/schemas.test.ts)),
  the highest-consequence untested frontend code. Found while evaluating the
  zod 3→4 bump — CI was fully green on that PR, but nothing exercised a schema, so
  green said nothing about whether validation still worked. The tests pin security
  behaviour rather than the library: `amountOut`/`wei`/`tokenId` reject scientific
  notation, negatives, decimals, hex, whitespace and empty (each of which throws
  or silently loses precision in `BigInt(value)` downstream); `offerer` must be a
  well-formed 20-byte address because owner gating reads it; GeckoTerminal prices
  reject scientific notation; OHLCV arity and member types are pinned; passthrough
  still tolerates additive upstream fields; and `parseOrNull` never throws on
  hostile input including prototype-polluted objects. Mutation-verified: removing
  the `weiStringSchema` regex fails "rejects a price that would break BigInt
  downstream" (1 failed / 29 passed).

### Fixed — Dune wei→ETH divisor: three passes to get one division right (2026-07-29 → 2026-07-30)

One story across three commits, all merged in
[#143](https://github.com/fomotsar-commits/tegridy-farms/pull/143).
`61cb867a` (2026-07-29) found that every query in
[`docs/DUNE_QUERIES.md`](docs/DUNE_QUERIES.md) divided by `1e18`, a **double**
literal that coerces a uint256 to double and loses precision — Q4's known-answer
6,400,000 TOWELI funding rendered as `6399999.999999999` — and replaced it with
the integer literal `1000000000000000000` (also correcting a doc comment that
dated the funding to 2026-06-06 when the real block time is 2026-06-07 06:44:23
UTC). `12e11c79` (2026-07-29) found that fix was **worse than the bug**: in Trino
`decimal(38,0) / decimal(19,0)` has result scale 0, i.e. integer division, so
every fractional amount truncates to 0 — and since every WETH amount in this
protocol's history is sub-1-ETH, it would have zeroed 100% of the volume data
while still returning rows and rendering a chart. `75bfcbcc` (2026-07-30)
established that the divisor was never the only problem: casting only the divisor
still coerces to double, and the correct form is
`CAST(bytearray_to_uint256(...) AS decimal(38,0)) / CAST(1000000000000000000 AS
decimal(38,18))`, now used in all five queries. Because uint256 casts only to
`decimal(38,0)`, the numerator consumes the 38-digit budget and Trino clamps the
quotient to scale 6 — a ceiling, not a choice — so totals aggregate in wei and
divide once at the end. Methodological lesson recorded in the doc: **Q4 was the
wrong acceptance test**, because 6,400,000 TOWELI is an exact multiple of 1e18
and cannot fail; Q5 (created mid-arc, and carrying 4 real TOWELI/WETH swaps the
doc had claimed did not exist) is now named the divisor acceptance test.
**Incomplete outside the repo:** the doc's own "Still to do" section states
Q1/Q2/Q3/Q5 still carry the old divisor on the live public dune.com queries —
only Q4 was updated there — and no dashboard or frontend embed exists yet.

### Internal — Contract and E2E test coverage recovered: 37 invariants gated for the first time, E2E made a real gate, Anvil backend built (2026-07-29)

All internal test plumbing;
[#134](https://github.com/fomotsar-commits/tegridy-farms/pull/134),
[#136](https://github.com/fomotsar-commits/tegridy-farms/pull/136),
[#137](https://github.com/fomotsar-commits/tegridy-farms/pull/137),
[#138](https://github.com/fomotsar-commits/tegridy-farms/pull/138),
[#140](https://github.com/fomotsar-commits/tegridy-farms/pull/140),
[#142](https://github.com/fomotsar-commits/tegridy-farms/pull/142).

- **37 invariant tests gated for the first time ever.** The slice-coverage PR had
  documented `contracts/test/invariants/` as excluded on the grounds it "needs a
  dedicated job with a longer timeout". Measured instead of assumed, that was
  wrong by two orders of magnitude: 37 tests across 13 files, all passing on their
  first execution ever, take 632s wall / 7,059s CPU at forge's defaults but only
  2.4s at 32 runs × 64 depth while still driving 2,048 calls per invariant. They
  guard AMM k-growth and LP-supply conservation, NFT-pool price monotonicity, fee
  accrual and roundtrip-no-loss, staking and reward-triangle invariants,
  fee-router conservation, restaking principal, DropV2 supply conservation, TWAP
  first-observation bypass, lending reward attribution and vote-incentive shares.
  The mechanism is a per-slice `noMatchTest` override, needed because the shared
  `--no-match-test` filters by test **name** and would have made the invariants
  slice match 13 files, run zero tests and exit 0 — precisely the failure the
  manifest exists to prevent. Depth was then raised 64 → 256 after timing all
  three settings (8,192 calls per invariant, ~1 minute on a 2-core runner against
  a ~2m12s compile step), because a shallow invariant run that always passes is
  the same false green.
- **A 47-agent adversarial self-review of the author's own PRs found 6 real
  defects.** The headline is a **corrected root cause**: `*` *does* cross `/` in
  forge's `--match-path` (forge does not enable globset's `literal_separator`,
  verified against forge 1.5.1), so the reason recorded for the 13 unrun files was
  wrong — they were unreachable because `test/<prefix>*` requires the prefix
  immediately after `test/` and `test/v4/Audit…` continues `v4/`. Same outcome,
  different mechanism. More seriously,
  `--match-path "${{ matrix.pattern }}"` is textual substitution before bash
  parses, so a manifest value was **shell source rather than data** — a value of
  `(Fuzz|$HOME)` expanded before forge saw it while the guard (execFile, no shell)
  verified the literal, silently breaking the "what I check is what CI runs"
  promise; both `pattern` and `noMatchTest` now travel via `env:`. The shared name
  filter — an unanchored substring `(Invariant|invariant|Fuzz|fuzz|testFuzz)` —
  was hiding **15 deterministic unit tests purely by spelling**, including
  `test_ATTACK4_kInvariantDecrease` (a red-team test), four AMM k-invariant
  swap/mint-burn guards and three R018 staking-shortfall pins; anchored to
  `^(invariant_|testFuzz_)`, all 15 run and pass. *Number caveat:* the commit's
  VERIFIED block reports 2,214 runnable tests "was 2,162 pre-anchoring across the
  same 9 slices" while its own per-slice table itemises the anchoring gain as
  **exactly +15** (756→759, 623→625, 187→192, 54→57, 408→410). The two figures in
  the same commit do not reconcile; +15 is the one it actually measured per slice.
  Separately, the guard's own dead-pattern check tested each slice's pattern *as a
  whole*, so a stale prefix inside a long brace list was invisible — the guard's
  own defect class wearing the same hat as the bug it was built to catch. Every
  brace-expanded alternative must now match ≥1 file; the first run found six dead
  ones (AuditDemonstration, M19Port, AuditR016_, PASS, Pass, L2), all removed with
  byte-identical coverage afterwards as proof.
- **E2E made a real gate.** 6 stale specs (12 CI failures behind
  `continue-on-error`) were fixed in #137 — **all six were selector drift, none
  was an app bug**, and each was established from source because the tempting
  move (update the selector until green) would have papered over two intentional
  product decisions: `gauge-voting` asserted a page-level `ConnectPrompt` removed
  **on purpose** in `a8b985d`, and `trust-pages` asserted the sitemap contains
  `/lending` when that route is a redirect. #138 then removed the last **live**
  `continue-on-error` in the repo — added 2026-05-18 for failures the comment
  openly *guessed* at and never triaged — verified first under CI-equivalent
  conditions (`--workers=1`, retries 0, stricter than CI's 2): 98 passed / 44
  skipped / 0 failed in 1.8m. (One `continue-on-error: true` survives at
  [`.github/workflows/contracts-ci.yml:456`](.github/workflows/contracts-ci.yml),
  on a `forge coverage` step permanently disabled with `if: ${{ false }}`.)
  *Date note: `b371f37e`'s author date is 2026-07-29 21:18 -0600 while the comment
  it wrote into `ci.yml:149` says "REMOVED 2026-07-30" — the same moment in UTC,
  not an error.*
- **The Anvil backend behind those 44 skips was built** (#142).
  [`frontend/e2e/fixtures/wallet.ts`](frontend/e2e/fixtures/wallet.ts) carried a
  4-step TODO for an `ANVIL_BACKEND` that was never built, so `ANVIL_RPC_URL`
  gated 40 skipped tests on a capability that did not exist, and the mock's
  `default:` branch returned null for every unhandled method. All four steps are
  implemented, verified against a **keyless** RPC (`ethereum-rpc.publicnode.com`)
  so it costs nothing. The original step 3 was **wrong** in claiming
  `DEFAULT_ACCOUNT` is pre-funded — true for a fresh anvil chain, false for a fork
  inheriting mainnet state (`eth_getBalance` → `0x0`) — so it is funded explicitly
  via `anvil_setBalance`, and `eth_sendTransaction` is signed by the node via
  `anvil_impersonateAccount`, so **no private key exists anywhere** in the
  fixture, specs or CI. Deliberately **not** wired into CI, because adding a red
  gate on day one is the anti-pattern this whole branch of work removed.
  **Still open:** `grep -rn ANVIL_RPC_URL .github/` returns only two explanatory
  comment lines — no workflow sets it — so the entire state-changing money-path
  E2E surface (stake, swap, add/remove liquidity, borrow/repay, claim) still runs
  in **no pipeline at all**, and with the backend working `stake.spec.ts` reports
  1 pass / 3 fail on an `h1` that does not exist. These 20 specs have never
  executed and so have never been validated.
- **Staking invariant handler widened** (#140). A self-review claimed 3 of the 4
  `StakingInvariants` "cannot fail at any runs/depth". Mutation testing at
  32×256 **refuted two of them** and showed the review was aiming at the wrong
  target: the limitation was the *handler*, not the invariants. One claim was
  real — `invariant_totalStakedBounded` asserted `totalStaked <= 50,000,000 ether`
  while `doStake` bounds a stake to 100,000 ether and early-returned once staked,
  so the reachable maximum was ~100k, i.e. 500x slack and unfailable. It is now
  bounded by the token balance the contract actually custodies, a solvency
  statement rather than a magic number. **The commit states plainly that this
  bound is still slack** (~10.09M trip threshold, because the contract also
  custodies the 10M reward pool) — an improvement from "cannot fail" to "fails on
  a real class", not a claim of tightness, and `invariant_accruedLEUnclaimedPool`
  remains unproven-live by the commit's own admission. The real fix was handler
  reach: `doIncrease`/`doExtend`/`doWithdraw` were added, and because withdraw
  zeroes `userTokenId` — the exact guard `doStake` bailed on — `doStake` became
  reachable again; coverage went from 3 selectors with `doStake` dead after its
  first success to 6 selectors at ~1,300 calls each.
- **CommunityGrants real-staking integration tests cherry-picked onto the trunk**
  (#136). A 286-line test file existed only on `main` and was genuinely absent
  from `mvp-launch` (verified with `git ls-tree`, not assumed). It is **pure
  regression coverage** — the bug it was written for never existed on this branch,
  since `mvp-launch`'s `CommunityGrants.sol:364` already reads
  `votingEscrow.balanceOf(...)`, fixed in `1b9b2690` on 2026-06-02, six weeks
  before the 2026-07-16 gated deploy; PR #100 is a main-only duplicate and is not
  an ancestor of `mvp-launch`. Worth having for
  `test_stakingExposesEveryDeclaredVotingEscrowSelector`, which pins the whole
  interface-selector-drift class. No manifest edit was needed, and **the guard
  proved that rather than the author asserting it.**

### Changed — Gitleaks allowlist closed by address *shape*; echidna header stopped overclaiming; indexer bumps paused (2026-07-29)

- `e49ee074` ([#135](https://github.com/fomotsar-commits/tegridy-farms/pull/135))
  then `4307c6d7`
  ([#139](https://github.com/fomotsar-commits/tegridy-farms/pull/139)) — the
  secret scanner went red on trunk over three **public Ethereum addresses** the
  allowlist already intended to cover. Root cause: gitleaks regexes are
  case-sensitive (Go RE2) and the allowlist wrote them in EIP-55 checksummed form
  while the same addresses appear all-lowercase in cast-friendly shell scripts and
  one test fixture. The timing is itself an instance of this cluster's theme: the
  three offending commits were **twelve days old** and gitleaks had been green on
  every trunk push since, because a per-push scan never reached back that far —
  the merge of the CI stack produced a push whose range covered 310 commits, the
  scan reached them, and trunk went red on findings that had been harmless the
  whole time. **#135's per-address `(?i)` fix was superseded the same day by
  #139**, which replaced three per-address entries with one shape-based rule,
  `(?i)\b0x[a-f0-9]{40}\b`
  ([`.gitleaks.toml`](.gitleaks.toml) line 66), because four incidents in three
  weeks were all the same false positive and addresses are spreading across
  contracts, scripts, tests, docs, constants and security.txt, not shrinking. It
  is safe because an address is `0x` + exactly 40 hex while a private key is `0x`
  + 64 hex, and the trailing `\b` means the pattern cannot match the leading 40
  hex of a longer run — verified 8/8 before adopting. `useDefault = true` is
  untouched, so this narrows one heuristic's false-positive surface and disables
  no rules; the cost is stated in the config itself rather than buried — a genuine
  20-byte-hex secret, and SHA-1 hashes, are now exempt.
- `74d049cd` — the NatSpec header of
  [`contracts/test/echidna/MVPLaunch_AMMEchidna.t.sol`](contracts/test/echidna/MVPLaunch_AMMEchidna.t.sol)
  listed **four** invariants; only three exist. `echidna_totalSupplyConsistent`
  was documented as if implemented and never was. The fix corrects the claim
  rather than filling the gap, deliberately and with the reasoning recorded
  in-file: this file cannot currently be *run* to verify a new property — echidna
  2.3.2 is installed but non-functional without `crytic-compile`, and the
  `--config echidna.config.yml` the header itself instructs you to pass does not
  exist in the repo. Writing an unrunnable fourth property would move the
  overclaim, not remove it.
- Same commit: Dependabot's `/indexer` npm ecosystem dropped to
  `open-pull-requests-limit: 0`. Not a judgement on the indexer — a bump there is
  currently **unreviewable because nothing can test it**: no workflow touches
  `indexer/`, `ci.yml` runs everything under `working-directory: frontend`, and
  nothing imports it, so a bump that broke the indexer would leave every gate
  green. Four such PRs (#92, #93, #118, #119) were closed for exactly that reason.
  The reversal condition is written into
  [`.github/dependabot.yml`](.github/dependabot.yml): set it back to 5 as soon as
  either `indexer/` gets a CI job or the frontend gains a real read path. The
  commit body also records a **retraction** — an earlier claim that
  `ConnectPrompt`'s `lend` variant was dead code was wrong twice (the key is
  `lending`, so the grep was invalid; and four of six surfaces are unused but all
  six carry unit tests), so nothing was deleted. *Date note: the in-file comment
  says "PAUSED 2026-07-30" while the git author date is 2026-07-29 22:26 -0600 —
  the same moment in UTC, not an error.*

### Fixed — Four CI gates that were passing while running nothing (2026-07-28)

The theme of the whole 07-28 → 07-29 stretch: **green ≠ checked.**

- **13 contract test files / 126 tests had never run in CI** (`f954c63a`,
  [#130](https://github.com/fomotsar-commits/tegridy-farms/pull/130)). The
  forge-test matrix was six hardcoded `--match-path` globs of the form
  `test/<prefix>*.t.sol`, so nothing under `contracts/test/v4/` (2 files, 42
  tests) or `test/pass5_pocs/` (1 file, 4 tests) was reachable, and ten top-level
  files whose prefixes nobody added to a brace list (80 tests) were unreachable
  too. Among the never-executed files were the **five `Audit20260712_*` regression
  suites — the 2026-07-12 audit's own tests, added 16 days earlier and never once
  run.** The silence is structural: `forge test` exits 0 on "No tests found in
  project!", so an empty match cannot be caught by exit code — and this was the
  **second** occurrence of the class (2026-05-23 was regex-instead-of-glob, where
  all six slices matched zero files and every job went green while running
  nothing). [`.github/contracts-test-slices.json`](.github/contracts-test-slices.json)
  is now the single source of truth: the matrix is generated from it *and* checked
  against it by a zero-dependency guard
  ([`scripts/check-test-slice-coverage.mjs`](scripts/check-test-slice-coverage.mjs))
  asserting every `contracts/test/**/*.t.sol` is claimed by exactly one slice or
  an `excluded[]` entry with a reason, plus a per-slice runtime assertion (from
  forge's own `--list --json`) that forge's matched file set equals the guard's
  prediction and yields ≥1 runnable test. Running the guard today prints
  `104/106 test files covered by 9 slices; 2 explicitly excluded` — it is live and
  has kept pace with new test files. It also corrected two false statements in the
  workflow's own comments: the "nightly cron on a beefier runner" the invariants
  were deferred to was never built, and the slice-balance table claimed
  `pass-r-series` carried 28 files when it carried 6.
- **`test_admin_discountConfigTimelockFlow` had been red for seven weeks**
  (`2d2d2db6`, [#129](https://github.com/fomotsar-commits/tegridy-farms/pull/129)).
  Failing with `NotAContract()` since `38aaad2` (2026-06-07), which added an audit
  guard to `TegridyV4Hook.setDiscountConfig` rejecting a `premiumAccess` with 0
  bytes of code (EOA) or 23 bytes (EIP-7702 delegation designator), because
  `_discountedFee` **calls** `hasPremium` on it and an attacker-controlled
  responder could return true and mint itself the up-to-50% fee discount. That
  commit added two direct-call regression tests but left the timelock-flow test
  proposing a bare `makeAddr("premiumAccess")`. The fix is entirely in the test;
  the production guard was reviewed and confirmed correct. It survived seven weeks
  because no slice matched any subdirectory of `test/` — and `38aaad2`'s own
  message said the author deferred the run "to CI, which compiles on push". CI
  compiled it and ran none of its tests.
- **The Supabase backup workflow had never taken a backup — seven green weekly
  runs, zero bytes** (`cd4fe3f5`,
  [#131](https://github.com/fomotsar-commits/tegridy-farms/pull/131)).
  [`.github/workflows/supabase-backup.yml`](.github/workflows/supabase-backup.yml)
  wrote `ready=false` when its three secrets were unset and gated all three real
  steps on `if: steps.preflight.outputs.ready == 'true'`, so the job reported
  SUCCESS having dumped, encrypted and uploaded nothing, for its entire life.
  Every scheduled run from 2026-06-15 through 2026-07-27 is green; run
  `30247964816` logs "Skipping backup — repo secrets not configured" and produced
  0 artifacts. **What that silence covered matters:** `native_orders` /
  `trade_offers` hold **signed Seaport orders**, and those signatures are bearer
  instruments — the DB row is the only copy and nothing on-chain can reconstruct
  one, so this backup is what would let makers find and cancel still-fulfillable
  orders if the project were paused or lost. The preflight now exits 1 with a
  `::error` annotation and the three unreachable skip guards were deleted; a
  weekly red run is the intended signal. **Note the fail-loud behaviour is code —
  actually taking a backup still requires the operator to set `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY` / `BACKUP_PASSPHRASE`.**
- **Frontend "Type Check" was checking zero files, and the unit suite was not a
  gate** (same commit; internal only). `frontend/tsconfig.json` is a solution file
  (`{"files": [], "references": [...]}`), so plain `tsc --noEmit` found an empty
  `files`, no `include`, followed no references (that is build mode only) and
  checked nothing in ~0.4s — mutation-verified with a deliberate `TS2322` that
  `tsc --noEmit` exited 0 on and `tsc -b --noEmit` caught. Not a coverage hole in
  practice (the Build job runs `tsc -b && vite build`), but the cheap early gate
  and its step name were fiction, and `frontend/package.json`'s `precommit`
  carried the identical broken invocation so the local hook genuinely did not
  type-check. Separately, a `continue-on-error: true` on the vitest step added
  2026-05-18 for 79 failures that pre-existed **on `main`** had outlived its
  premise — run `30419320649` on `mvp-launch` reports 138/138 test files passing,
  so the suite (including 44 serverless-API security tests) had quietly stopped
  being a gate. Removed. *The vitest baseline remains branch-specific: this flip
  is correct for `mvp-launch`; `main` still carries the pre-existing failures.*
- **ESLint was linting nothing in the frontend's JavaScript** (`1a9ecc29`,
  [#133](https://github.com/fomotsar-commits/tegridy-farms/pull/133)).
  [`frontend/eslint.config.js`](frontend/eslint.config.js) had exactly one config
  object, scoped `files: ['**/*.{ts,tsx}']`. Under flat config a file matched by
  no config object gets **no rules** — it is not skipped, it simply passes — so
  `npm run lint` was green over every tracked `.js/.mjs/.cjs` file by
  construction, **including everything under `frontend/api/` that is the live
  request-handling surface** (orderbook, SIWE auth, seaport-verify, aggregator
  proxy, supabase proxy). *Counts corrected:* the commit's own subject says "116
  files… including the 37 under `frontend/api/`"; re-counted at that commit,
  `git ls-tree` reports **118** tracked `.js/.mjs/.cjs` files under `frontend/`,
  of which **44** are under `frontend/api/` (23 excluding `__tests__`). A JS/MJS/CJS
  block extending `js.configs.recommended` was added with globals split (api/ and
  scripts/ are Node; public/ and src/ are browser) so `no-undef` still catches a
  browser global used server-side. 28 findings were triaged individually rather
  than autofixed. A follow-up self-correction (`c1fc023e`, 2026-07-29) added
  `no-empty: allowEmptyCatch` to the new JS block too, because omitting it held JS
  to a stricter standard than TS for no stated reason.

### Security — removed residue of a patched Seaport fill-replay hole; public Sponsors button disabled (2026-07-28)

- The first thing the newly-enabled JS lint rules surfaced (`1a9ecc29`,
  [#133](https://github.com/fomotsar-commits/tegridy-farms/pull/133)) was that
  [`frontend/api/orderbook.js`](frontend/api/orderbook.js) still selected a
  `maker` column into an `orderMaker` variable nothing consumed. **That is residue
  of a removed vulnerability:** the legacy fallback compared the `OrderFulfilled`
  event's indexed offerer to the row's maker, which let anyone who could observe
  any past Seaport sale by that maker replay its tx hash to mark an unrelated
  active listing as filled. The fallback was deleted earlier; the column read
  outlived it. The read is now deleted and the `select()` narrowed to
  `seaport_order_hash`, with a comment warning against re-introducing a maker
  comparison. Worth stating plainly because the naive "fix the lint error by using
  the variable" would have **re-wired a patched hole** — unused-variable findings
  on a money path deserve a read, not an autofix. The `buyerAddress` finding
  deliberately kept `await signer.getAddress()`, because deleting the call would
  remove an early throw for a locked or disconnected wallet.
- `55a53aad` — [`.github/FUNDING.yml`](.github/FUNDING.yml)'s `custom:` entry
  resolved to `etherscan.io/address/0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e`,
  which [`docs/SAFE_REHOME_RUNBOOK.md`](docs/SAFE_REHOME_RUNBOOK.md) lists as
  **both** a current Safe signer address **and** a hardcoded fee recipient
  scheduled for retirement during the Safe rebuild. GitHub renders that as a live
  "Sponsor" button on a public repo — i.e. soliciting public donations to an
  address about to stop being the treasury. It was commented out rather than
  repointed, because every candidate replacement today is either a signer address
  or the pre-rebuild 2-of-2 treasury Safe `0x7D26…Bd7d`, which is itself flagged.
  The re-enable instruction (use the **rebuilt** Safe, not a signer, not
  `0x7D26…Bd7d`) is carried inline. Still awaiting the Safe rebuild, so the button
  remains off.

### Internal — WORKORDER_V2.md committed; a 75-agent review output that had never been in git (2026-07-28)

`git log --all --full-history -- "*WORKORDER*"` returned empty: the 33 KB
[`WORKORDER_V2.md`](WORKORDER_V2.md) existed only as an **untracked** file in the
primary checkout, which is shared with concurrent agent sessions, so a single
`git clean -fd` from any of them would have destroyed the output of a 75-agent
adversarial review. Committing it is the whole fix. One correction was applied on
the way in, using the document's own `[v1-WRONG]` convention: its ground rule 6
("CI placement rule") told future work to put gating tests at `contracts/test/`
root with an `Audit_*` prefix and never in `test/v4/` or `test/invariants/`, on
the theory that no CI slice runs subdirectories. That rule was necessary but not
sufficient and is **superseded by #130** — `Audit20260712_*` matched the
prescribed shape and *still* never ran. What remains true is that the
`--no-match-test` name filter skips anything matching the shared pattern
regardless of slice, and that echidna/halmos run in no pipeline.

### Added — Selector-drift guard extended to the hand-rolled frontend ABIs; 3 dead entries removed on-chain-verified (2026-07-28)

- `1190c56a` ([#123](https://github.com/fomotsar-commits/tegridy-farms/pull/123))
  — every function in every hand-rolled frontend ABI was swept against the
  **deployed runtime bytecode** of its mapped address (298 selectors across 13
  ABI/address pairs) and three dead declarations were found, all silently coerced
  to 0 by their readers. `SwapFeeRouter.totalSwaps()` [`0xb4a800ce`] had been
  removed on-chain by gas fix G-23 as derivable from events, so the Home page's
  "Total Swaps" card could never render, `usePoolTVL` fetched it and never used
  it, and the AdminPage row was permanently stuck on "…";
  `TegridyStaking.totalLocked()` [`0x56891412`] was removed in the 2026-05-30
  EIP-170 golf and `usePoolData` read it forever-reverting;
  `LPFarming.notifyRewardAmount(uint256)` [`0x3c6b16ab`] was a wrong-selector
  entry — the deployed farm's real signature is `(uint256,uint256)`.
  `TEGRIDY_STAKING_ABI`'s `earned`/`getPosition` were verified **not** drift
  (served by `StakingMonitorView` and the legacy exit contracts) and left in place
  with a comment so nobody "fixes" them onto the staking address. Verified by
  `cast call` returning empty reverts on mainnet with control reads succeeding.
- `f855b744` ([#124](https://github.com/fomotsar-commits/tegridy-farms/pull/124))
  — [`frontend/src/lib/contracts.ts`](frontend/src/lib/contracts.ts) had **no
  drift guard of any kind**: `check-interface-selectors` covered Solidity
  interfaces and `extract-missing-abis` covered only the generated
  `abi-supplement.ts`, leaving the hand-rolled ABIs in between unchecked — which
  is how the three selectors above got in and stayed. A frontend ABI is the worse
  half of the class, because **viem encodes the declared selector without ever
  consulting the chain**, so drift does not fail a build; it ships to users as a
  button that always reverts with empty returndata, or a stat tile pinned at 0.
  Phase 2 of
  [`scripts/check-interface-selectors.mjs`](scripts/check-interface-selectors.mjs)
  evaluates each `export const X_ABI = [...]` block, canonicalizes every signature
  (tuples expanded recursively), resolves the target contract by name and checks
  against that artifact's `methodIdentifiers`, **fail-closed** — an ABI export
  resolving to no artifact, or not in the `= [ ... ]` form the scanner reads, is
  an error rather than a silent skip. Its first run found three more live drifts:
  `TegridyRestaking.pendingBonus`/`pendingBase` (golfed onto
  `RestakingMonitorView`, zero call sites) and `TegridyLPFarming.balanceOf` (never
  existed) were removed, while `TegridyRestaking.pendingTotal` and
  `VoteIncentives.pendingFeeBps`/`.feeChangeTime` were recorded in
  `KNOWN_LATENT_FRONTEND_SELECTORS` — reported every run, not failing, because the
  hooks are `isDeployed`-gated at `0x0`. The CI paths filter now lists
  `frontend/src/lib/{contracts,constants}.ts`, without which a frontend-only ABI
  edit would not trigger the workflow at all. Mutation-checked 10/10; **scope is
  source artifacts, not deployed bytecode**, stated as a known residual.
  *Dating note: `f855b744` is authored 2026-07-28 03:49 but only reached trunk on
  2026-07-29 via merge `fc2d9944`.*

### Added — Launch Radar, a Trust & Safety hub, rich unfurl cards, and Launch/Verify on the front door (2026-07-28)

`d1bc3339` ([#125](https://github.com/fomotsar-commits/tegridy-farms/pull/125)),
with same-day and next-day corrections in
[#126](https://github.com/fomotsar-commits/tegridy-farms/pull/126) and
[#127](https://github.com/fomotsar-commits/tegridy-farms/pull/127).

- **Launch Radar** — the discovery mapper, outcomes enrichment and explorer UI had
  all been built and tested, but nothing ever fetched a pool list. This wired the
  missing fetch **without letting market data contaminate the rail's own record**:
  `LaunchExplorer` and `LaunchAfterlife` claim "launched and graduated through
  *this* rail", so they stay integrator-filtered and honestly empty until launch
  #1 graduates; market-wide pools render in a separately-labelled
  [`LaunchRadar`](frontend/src/components/launcher/LaunchRadar.tsx) section that
  states plainly it is not from this rail and endorses nothing, with every row
  deep-linking to `/scan?token=`. The keyless GeckoTerminal `new_pools` fetch was
  added as a `?resource=launch-radar` branch on the **existing** aggregator
  catchall via lazy import, so **no new serverless function was added** against
  the Vercel Hobby cap of 12. (The commit records the count as "unchanged at 7";
  [`frontend/api/SERVERLESS_BUDGET.md`](frontend/api/SERVERLESS_BUDGET.md) states
  9 as of 2026-06-01 and there are 10 top-level handlers today — the absolute
  number in the commit does not reconcile with the repo; the no-new-function claim
  does.) A doctrine pin asserts radar entries carry no tier and no creator so they
  can never masquerade as a Tegridy-rail launch.
- **The Radar then repeated fabricated upstream pricing as fact** (#126, found
  during live post-deploy verification on prod, hours after #125 shipped).
  GeckoTerminal's feed carries fabricated pricing for scam deployments: a
  12-minute-old "LCUC / USDT 1%" pool reported **$1,016,163,865 per token** and a
  $1,006,580,414 reserve, which the (arithmetically correct) ETH derivation
  rendered as "520607 ETH" — by far the largest figure on the page, attached to
  the least trustworthy pool on it. The arithmetic was never wrong; **the input is
  fiction, and repeating fiction faithfully still misleads** on a surface whose
  entire premise is honest measurement. A row whose upstream price is not a
  physically plausible market price is now treated as unmeasured (rendering an em
  dash), consistent with how the rest of the app shows a gap *as* a gap. The pool
  row still appears — the pool is real, only its numbers are untrustworthy. The
  `MAX_PLAUSIBLE_TOKEN_PRICE_USD = 1_000_000` bound is deliberately loose (an
  absurdity filter, not a judgement or a cap) and a test pins that a legitimately
  priced $60k/unit token is untouched. Mutation-checked: with the guard disabled
  the new test fails with `expected 520606.997160665 to be +0` — the exact value
  observed live. #127 then fixed the footnote, which still said a cell reads em
  dash only because "it wasn't reported" — it now states both cases while keeping
  the load-bearing part unchanged: **never that it is zero.**
- **Trust & Safety hub** — the token scanner, deployer graph and wallet-exposure
  tools (shipped 2026-07-22, below) work on any token or wallet and are the
  protocol's one genuine differentiator, but they sat under a generic "Stats"
  heading next to Tokenomics and Treasury (so they read as protocol vanity
  metrics), were absent from the Footer entirely, and had no links between them.
  Pure information architecture and framing — **no detection logic changed.**
  [`frontend/src/lib/navConfig.ts`](frontend/src/lib/navConfig.ts) splits the
  three into a named "Trust & Safety" section led by a new
  [`/trust` hub](frontend/src/pages/TrustHubPage.tsx) that frames them as one
  anti-rug suite and adds a "how to read a result" note (concentration is not
  fraud; a gap is shown as a gap; every read is a shareable link). The Footer went
  5 → 6 columns. The scanner deliberately links to the deployer **tool** rather
  than pre-filling an address, because a scan reads holders not provenance, so a
  guessed deployer would be a dead link.
- **Rich OpenGraph cards for `/scan` and `/deployer`** — both tools emit "Copy
  share link" URLs by design, but the edge unfurl middleware only matched
  `/nakamigos/*`, so every shared scan or deployer report unfurled as the generic
  site card and carried zero signal in the feed where it spreads. The matcher in
  [`frontend/middleware.js`](frontend/middleware.js) widened to
  `["/nakamigos/:path*", "/scan", "/deployer"]`, reusing the file's own helpers
  verbatim, and `ogHtml` gained an optional `siteName` defaulting to "Tradermigos"
  so existing cards stay byte-identical. **The card never asserts a verdict, score
  or band**, because the real read is computed client-side from partly key-gated
  holder data and a card claiming "safe" could contradict the page it links to.
  Runs at the edge, so zero serverless functions added. Verified by direct
  invocation rather than tests: no middleware test harness exists in the repo and
  none was invented. Known gap at the time: Fact Sheets render inside `/launch`
  and have no standalone route, so there is nothing to unfurl for them yet.
- **Launch & Verify on the front door** — the launcher and the detection suite,
  the two most-built and most-differentiated surfaces, appeared nowhere on the
  highest-traffic page, which funnelled every visitor into farm/swap/dashboard. A
  new "Launch & Verify" section uses the exact art-card pattern of Protocol
  Overview, and a third hero CTA "Scan a token" was added because the existing two
  both ask a first-time visitor to connect or buy before the app does anything for
  them. The launch card reads the same `isLauncherEnabled()` gate the nav uses, so
  the front door can never advertise a rail that is switched off. **Strictly
  additive: 59 insertions, 0 deletions** — no existing section, copy or art asset
  moved or removed. Deliberately *not* changed: the hero stat row; the plan called
  for demoting "ETH Distributed: 0.0000", but it was already last and already
  carried an honest sub-caption, and reordering real stats to flatter the eye is
  churn.
- **Anti-double-launch guard** — the SDK's `create()` broadcasts **and** awaits the
  receipt in one call, so an RPC receipt-wait timeout threw a generic
  submit-failed and the UI **re-offered the same launch button**, inviting a
  duplicate token, split liquidity and double payment with the first token's Fact
  Sheet already attested. `LaunchError` now carries `broadcast` and `txHash`; only
  a provable wallet rejection (`isUserRejection`, which walks the cause chain so
  it survives SDK error-wrapping) is treated as pre-broadcast and everything else
  defaults to `broadcast = true`, on the reasoning that over-warning is harmless
  while under-warning risks the duplicate. The page renders a distinct "Your
  launch may already be on-chain" state, links the pending tx, disables the launch
  button, and gates retry behind an explicit acknowledgement.

### Added — Exotic base pairs, post-graduation fee re-attestation, and two panels that had been built but never mounted (2026-07-26)

`6c65b648` ([#120](https://github.com/fomotsar-commits/tegridy-farms/pull/120)),
`e22f9a45` ([#121](https://github.com/fomotsar-commits/tegridy-farms/pull/121)),
`84924bd1` ([#122](https://github.com/fomotsar-commits/tegridy-farms/pull/122)).

- **Exotic base pairs** — an opt-in "exotic" base pair on both rails. On EVM this
  enables token/TOWELI launches while keeping ETH the default: **Doppler's dynamic
  auction accepts an arbitrary ERC20 numeraire**, because it mines the token
  CREATE2 address to sort against *any* numeraire and the initializer's ordering
  check is symmetric with no numeraire allowlist. TOWELI's low address (`0x42…`)
  takes native ETH's exact path; the long-standing `airlock.ts` comment blaming
  WETH's revert on ERC20-ness was a **misdiagnosis** — the cause was WETH's *high*
  address (`0xC0…`) — and was corrected. `launchService` threads the numeraire,
  drives the curve with TOWELI/USD rather than ETH/USD, and re-denominates the
  proceeds band into TOWELI units against a USD-anchored `EXOTIC_RAISE_USD`.
  Proven three ways: source analysis, a re-read of the mining loop, and a **live
  anvil mainnet-fork rehearsal**
  ([`scripts/exotic-toweli-fork-rehearsal.mjs`](scripts/exotic-toweli-fork-rehearsal.mjs))
  that simulated `createDynamicAuction` with `numeraire = TOWELI`: PASS, no
  revert, mined token sorts above TOWELI. On Solana (fee-capture rail, never
  TOWELI) `assertQuoteMint` relaxed from SOL/USDC-only to any valid base58 SPL
  mint, with SOL and USDC curated and a custom mint requiring its on-chain
  decimals (6–9). Shipped gated **off**; #121 flipped `EXOTIC_LAUNCHES_ENABLED` to
  true the same day with operator authorization and full disclosure of the
  residual: the post-graduation lifecycle is architecturally sound but was **not**
  execution-proven with our v4Migrator + V1-locker combination — the same
  unexercised-graduation status the already-live ETH launcher carried and the
  operator accepted at the 2026-07-22 go-live. One-line reversible; a
  `config.test.ts` tripwire forces any flag flip to be conscious.
- **Post-graduation fee re-attestation** — the fully-verifiable half of the
  `/launch` fee disclosure, reading the *real* beneficiaries from Doppler's
  `StreamableFeesLocker` once a token graduates, reversing WAD → bps, labelling
  addresses to roles and attesting the result. On-chain groundwork was done before
  any chain code was written (mainnet, 2026-07-26): v4Migrator `0x0820…` reports
  `locker()` and `migratorHook()` `0x4053…`; `PoolId = keccak256(abi.encode(
  currency0, currency1, fee:uint24, tickSpacing:int24, hooks))` was proven against
  3 real `Initialize` events. **Superseded and retroactively voided by `045acf10`
  (2026-07-30):** the load-bearing on-chain claim was *backwards* — V1 locker
  `0xe24F…` does **not** have `streams(bytes32)` and is keyed by the UniV4 position
  `tokenId`, not a PoolId — so for the four days this shipped, every read reverted,
  the catch reported "not graduated", and no token could ever be re-attested. **The
  07-30 correction did not restore the feature**: `readMigrationStream` now returns
  `unsupported: true`, because resolving token → tokenId needs the locker's own
  `Lock` event, whose signature is not derivable and cannot be sampled. What does
  work post-correction is `readBeneficiaryClaim` against already-published
  beneficiary addresses. The PoolId math itself is still correct UniV4 math, just
  not V1's lookup key.
- **Corrected the 15% "stakers + POL" fee claim** — a doc-vs-code gap flagged
  fixed in an old note but verified still open on the trunk. The constitution's
  protocol line routes to RevenueDistributor, which distributes ETH to veTOWELI
  holders only — **POL lives in the separate POLAccumulator/SwapFeeRouter and is
  not funded by this 15%** — so "Tegridy stakers + POL" and "sub-split half
  stakers half POL" overstated it, and the string was corrected everywhere. *The
  "Tegridy stakers" label it settled on was itself superseded by #160, which
  relabelled the line "Tegridy treasury"; the POL correction still holds.* An
  "Anti-sniper: descending Dutch price — block-0 buys pay the most" row was added
  to the review step, because the descending curve **is** the anti-snipe and it
  was invisible.
- **Canonical Uniswap V4 PositionManager wired into the Afterlife address book** —
  re-lands the number-one Afterlife blocker on the trunk. It had been recorded as
  shipped on 2026-07-22 but was **absent from `origin/mvp-launch`**, deployed from
  a divergent branch and never merged, so prod likely regressed on the 2026-07-26
  redeploy. `AFTERLIFE_V4_POSITION_MANAGER_ADDRESS` is
  `0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e`, verified on-chain 2026-07-26 as
  23,877 bytes whose `poolManager()` is the canonical V4 PoolManager
  `0x0000…08A90` — the same posm the deployed Doppler v4Migrator reports. The
  LaunchPage copy that still said boosted-LP "needs the V4 PositionManager wired /
  pending deployment" was fixed — **the exact self-bug the previous attempt
  shipped** — and now carries the honest caveat that a per-pool
  `TegridyBoostedLPStaker` is still deployed per-launch.
- **CoW market-swap and TWAP panels mounted** — both were fully built and tested
  in the 2026-07-22 scaffold (`cowSwap.ts` / `composableCow.ts` plus their hooks),
  deliberately held back for live-wallet QA because they are a money path, and
  simply **never mounted** afterwards, with no importer anywhere in the app; the
  note calling them scaffold was stale, exactly like the PositionManager claim.
  `CowSwapPanel` now renders in the Swap tab and self-gates so it only appears when
  eligible *and* a real CoW quote returns; `TwapOrderPanel` was added as a new
  self-contained `twap` tab that self-gates to Safe smart-account wallets and shows
  an EOA the exact ComposableCoW calldata instead, with the tab strip made
  `overflow-x-auto` so the 5th tab scrolls on mobile.
- **Solana launcher preview un-gated** (#122) — a one-line flip of
  `SOLANA_LAUNCHER_ENABLED` false → true, unblocked by the operator confirming the
  Squads v4 multisig vault. `/solana-launch` now renders the live config
  **preview** rather than the SOON placeholder. Explicitly **not** a new money
  path: `SolanaLaunchPage.tsx` has no in-app submit or signer, so real launches
  still go through the operator's out-of-band CLI wrapper, which verifies on-chain
  that the `feeClaimer` **is** the derived Squads vault PDA and enforces threshold
  ≥ 2 before the first create. Doctrine unchanged: Solana is fee-capture only, no
  custom program on this rail, TOWELI never on Solana. **Date discrepancy:** the
  git author date is 2026-07-26 23:47 -0600 (= 2026-07-27 05:47 UTC) while the
  commit body and the code comment both say the vault was confirmed "2026-07-27".
  **Doc drift still open** (only the operator-harness sections were corrected by
  #180): `frontend/src/lib/launcher/solana/README.md` line 202 still asserts
  "`SOLANA_LAUNCHER_ENABLED = false` in `dbc.ts`" under a heading "Gating + wizard
  integration (not yet wired)", and line 205 still says "Build
  `frontend/src/pages/SolanaLaunchPage.tsx`", which already exists. The same false
  statement also survives in `solana/dbc.ts`'s own header comment (line 17,
  "SOLANA_LAUNCHER_ENABLED stays false") while the flag below it is set `true`.

### Added — Art on every card, modal and standalone page; art-studio taken to total coverage (2026-07-25)

- `249cba76` ([#111](https://github.com/fomotsar-commits/tegridy-farms/pull/111))
  dropped **26 new art pieces** into `frontend/public/art/new` and wired them onto
  every previously art-less modal, banner and standalone page (Deployer, Launch,
  Launch Simulator, Scanner, Wallet Exposure, Solana Launch). **Two rendering bugs
  from the first pass were fixed at the same time**: scrims sitting at 0.86–0.95
  opacity — effectively near-black boxes *over* the art — were lightened to ~0.5
  with an inherited `text-shadow` carrying legibility, and
  [`PageArtBackdrop`](frontend/src/components/PageArtBackdrop.tsx)'s negative
  `z-index`, which pushed the art **behind** AppLayout's solid `#060c1a`
  background and made it invisible, was replaced with the app's real pattern
  (`absolute inset-0 z-0` backdrop, page content lifted to `relative z-10`). A
  same-day follow-up (`7da6c80e`,
  [#113](https://github.com/fomotsar-commits/tegridy-farms/pull/113)) replaced the
  onboarding modal's flat navy scrim with a middle-dark gradient plus a
  `brightness(1.06)` lift so muted pieces show through while text stays readable
  over bright ones. Verified live in Chrome; 1692 tests green.
- Four commits took the operator-facing art studio from partial to **total**
  coverage of every art surface — `b391af46`
  ([#115](https://github.com/fomotsar-commits/tegridy-farms/pull/115)) registered
  12 unlisted surfaces and added
  [`frontend/src/pages/artStudioCoverage.test.ts`](frontend/src/pages/artStudioCoverage.test.ts),
  a source-scanning guard that fails the build if any statically-referenced
  `pageId` exists in app code but is missing from the studio's hand-maintained
  `SURFACES` inventory (9 such drifted surfaces had been found that day);
  `220ef11d` ([#114](https://github.com/fomotsar-commits/tegridy-farms/pull/114))
  routed every pop-up modal through `pageArt`; `a95aba75`
  ([#116](https://github.com/fomotsar-commits/tegridy-farms/pull/116)) moved 26
  ArtCard section backgrounds onto `pageArt`; `31f15b1c`
  ([#117](https://github.com/fomotsar-commits/tegridy-farms/pull/117)) covered the
  fixed chrome — nav logo, the 40-frame loader splash, the 39 GlitchTransition
  frames, the token icon. **Every registration was seeded with matching overrides
  so the visible app was a pixel no-op**; this is tooling, not a user-visible
  change. `ArtStudioPage.tsx` now registers every art surface. (No count is quoted here on purpose: several entries are `Array.from` spreads, so a grep undercounts and an evaluated count disagrees with it — see the art-surface inventory note.)
- Unrelated second half of #114, and genuinely user-facing: **`/solana-launch` was
  added to the nav dropdown.** It had been reachable only through a cross-link
  buried inside `/launch`'s *gated* explainer — which meant an operator, who sees
  the live wizard rather than the explainer, had **no path to it at all**. It now
  appears in the Launch section with a "Soon" pill driven by
  `SOLANA_LAUNCHER_ENABLED` rather than hardcoded, so the label self-clears when
  the launcher flips on.

### Fixed — Full-surface honesty and correctness sweep: stale copy, unbacked promises, dead CTAs, and eight real defects (2026-07-24)

Five commits —
[#105](https://github.com/fomotsar-commits/tegridy-farms/pull/105),
[#106](https://github.com/fomotsar-commits/tegridy-farms/pull/106),
[#107](https://github.com/fomotsar-commits/tegridy-farms/pull/107),
[#108](https://github.com/fomotsar-commits/tegridy-farms/pull/108),
[#109](https://github.com/fomotsar-commits/tegridy-farms/pull/109),
[#110](https://github.com/fomotsar-commits/tegridy-farms/pull/110) — chasing the
same defect class as the earlier "+10% NFT boost banner no contract paid".

- **Copy swept against the deployed contracts** (#105). Stale absence claims:
  features un-gated on 2026-07-21 (Premium, NFT Lending, NFT Pool Factory,
  Launchpad) were still described as future, and the Risks page's
  `PROTOCOL_LIMITS` status column — previously three hardcoded "Not yet deployed"
  rows — is now **derived from `isDeployed(addr)` so it can never drift again**.
  Unbacked promises: PremiumPage's "earn 3x points" was deleted (no such
  multiplier exists); the Gold Card description was wrong on **all three** of its
  claims; the early-exit penalty was described as "redistributed to stakers" on
  three surfaces when `TegridyStaking` actually does
  `safeTransfer(treasury, penalty)` — the event was even renamed
  `PenaltyRedistributed` → `PenaltySentToTreasury`; the referral tweet promised
  the joiner bonus rewards when `ReferralSplitter` pays only the referrer;
  ProtocolStats' unverifiable "82+ findings resolved" became "Verified ·
  source-verified on Etherscan", and its "Real Yield Generated … distributed to
  stakers" tile was relabelled **"Protocol Fees Collected"** because it reads
  collected router fees, not `RevenueDistributor.totalDistributed`. Dead CTAs: the
  "Restake for bonus yield →" link shown to every position holder pointed back at
  the same page (restaking is Phase-7-deferred, address zeroed) — `StakingCard`
  now shows an honest "Restaking — coming in Phase 7".
- **The impermanent-loss calculator showed LPing beating a crash** (#105, the real
  math bug carried in the same commit). `ILCalculator` applied the IL percentage
  to the **deposit** rather than to the **HODL value**, so at a −75% price move it
  displayed LP $800 against HODL $625 — telling the user liquidity provision
  outperformed simply holding through a crash, the exact opposite of the lesson
  the widget exists to teach. Corrected to `holdValue * (1 + il)` and verified
  numerically equal to `deposit * sqrt(r)` at every point on the curve.
- **The Tradermigos marketplace crashed on every visit** (#106). The nakamigos
  sub-app renders inside the app-wide `<LazyMotion features={domAnimation}
  strict>` wrapper, but four of its components imported the bare `motion` proxy,
  which throws at render under strict LazyMotion (confirmed empirically with a
  probe) — so visiting `/nakamigos` crashed the entire marketplace into the route
  error boundary. 38 usages were swapped to `m.*`. **The obvious render test was a
  false green** (the components' `matchMedia` LITE branch dodges the motion path
  under jsdom), so the guard added instead
  ([`strictMotion.test.tsx`](frontend/src/nakamigos/strictMotion.test.tsx)) is
  source-level, failing if any nakamigos file imports the bare binding *including*
  the `motion as m` alias, which is the same proxy. Mutation-verified.
- **Limit orders could fill below the price you asked for** (#106). The
  browser-watched limit order triggers on the market (Uniswap) price but executes
  on the thin native pool via SwapFeeRouter, and the signing math was
  `minOut = min(targetDerivedMinOut, nativePoolQuote)` — so whenever the native
  pool lagged the market the order silently filled **below** the user's target,
  while the code comment claimed "we never sign for less than the user wanted",
  which `min()` does not guarantee. The only backstop was a coarse "abort if target
  > 2x the native quote" gate, leaving the entire 0–100%-below-target band open: a
  "buy at 25M TOWELI/ETH" order could fill at ~13M. `minOut` is now **floored** at
  the user's target (haircut by the same fee and slippage the native pool imposes)
  and the fill **aborts** rather than underfilling. Extracted to a pure
  [`lib/limitOrderMath.ts`](frontend/src/lib/limitOrderMath.ts)`:resolveLimitFill`
  and pinned by a mutation guard that reconstructs the old `min()` logic and
  asserts it signed below target. Only the browser-watched secondary path is
  affected; the primary on-chain CoW limit path is untouched.
- **Dead referral links, an unreachable Swap tab, keyboard voting that could not
  vote** (#106). The Tegridy Score page built its referral link as
  `${window.location.origin}/swap?ref=…`, but TradePage never reads `?ref` — the
  stash is captured only on the home route — so **every share from that page
  produced zero attribution**; it now matches `ReferralWidget` exactly,
  `${SITE_URL}/?ref=…`, with `SITE_URL` rather than `window.origin` to avoid
  preview-deploy origin drift. On the `/liquidity` deep link the Swap tab was
  unreachable, because `handleTabChange` deleted `?tab` for the default tab and
  the path re-resolved to `liquidity` and bounced the user straight back — and
  both Farm and Dashboard link to `/liquidity`. And the Gallery card's
  `role="button"` `onKeyDown` had no target guard, so Enter bubbling up from the
  inner vote button opened the lightbox instead of casting the vote, meaning
  **keyboard users could never vote**.
- **Scheduled DCA buys now route to whichever venue pays more** (#107). DCA quoted
  and executed only on the thin native pool, so a scheduled buy could miss a better
  Uniswap price and was **stranded entirely when the native pool was empty**, with
  no disclosure of the venue. For ETH-input swaps the keeper now quotes both and
  routes to the winner **net of the native protocol fee**, the same rule the Swap
  tab's Smart Route Selection uses; native wins ties, so when native is chosen the
  signed `minOut` is byte-identical to before. **The scope is deliberate**: ETH
  input needs no ERC-20 approval, so venue selection is free of the
  allowance-spender hazard, whereas token-input swaps stay on the native pool where
  the user's existing approval already points — routing those to Uniswap would need
  a second approval an autonomous keeper cannot assume. Venue choice is a pure
  helper ([`lib/venueSelect.ts`](frontend/src/lib/venueSelect.ts)) with tests
  pinning the fee-net comparison, the tie-to-native rule and both empty-pool
  fallbacks, plus an honest disclosure line on the DCA tab.
- **Three launcher-trust highs closed** (#108). The "Attest disclosures on-chain"
  button **reverted with an opaque error 100% of the time**, because the Fact Sheet
  disclosure schema was never registered on the mainnet SchemaRegistry — verified
  independently via two public RPCs, `getSchema(0x0e4570db…)` returning an empty
  record. The page now probes `getSchema` on launch success and only offers the
  button once the schema is live, disabling it with an honest note until then and
  fail-closing `onAttest` with the same message; the decode reads the named-tuple
  uid defensively so any unexpected shape reads as **not** ready. Operator action
  to enable: one `register()` call on SchemaRegistry
  `0xA7b39296258348C78294F95B872b282326A97BDF` — the UID is deterministic, so the
  gate flips itself with no config change. *Whether the operator has since
  registered it is not checkable from source.* Second, **invalid
  attention-beneficiary rows were silently dropped from a permanent fee stream**:
  a row whose address failed `isAddress`, or had a zero or blank share, was
  dropped at submit while the displayed "you keep X%" remainder still counted it —
  so a launcher who mistyped a KOL's address shipped a launch whose perpetual,
  immutable fee stream differed from what the wizard showed, the promised
  beneficiary receiving nothing, forever. One shared classifier `splitRowStatus`
  is now the single source of truth for the four sites that used to compute over
  different sets; `parseAttentionSplits` **throws** on any non-blank invalid row,
  the Launch button is disabled while any row is invalid, each row trims at the
  input boundary and shows a red border + `aria-invalid`, and `StepReview` — the
  final pre-signature screen — now lists each valid beneficiary and percentage
  plus the creator remainder, disclosure the irreversible action previously
  omitted entirely. Third, **the Fact Sheet displayed and attested a 70/10 split
  the locker does not pay**: `resolveFeeConstitution` treats creator and attention
  as one 8000-bps creator-directed pool, so by default the real split was **80/0,
  never 70/10** — buyers verifying the attested Fact Sheet were reading a fee split
  the locker does not honour. Fixed without reintroducing the post-launch-edit
  forgery vector: `launchToken` captures the *resolved* constitution into
  `LaunchResult` at launch time and `onAttest` attests that, not the static
  template and not the still-mutable wizard state.
- **The Wallet Exposure page scored nothing** (#109) — the highest-severity item
  earlier batches had deferred. `WalletExposurePage` called `useWalletExposure`
  **without passing a `scanToken` adapter**, so every holding self-gated to
  `unmeasured` and the headline concentration/rug scoring — the entire point of
  the page — never rendered, even though `/scan` already had a live holder source
  available. The same `scanTokenLive` path is now injected per-token, with a
  failure falling back to null so the holding stays honestly unmeasured, and the
  `UNMEASURED_REASON` copy that falsely claimed "no holder-list index is deployed"
  was rewritten to describe what actually happened.
- **Honest loading, failure and ownership states** (#109). The NFT AMM toasted
  "NFTs purchased successfully!" from `writeContract`'s `onSuccess` — which fires
  on **submission**, not confirmation — so a transaction that later reverted was
  announced as a success and never corrected. `useMyLoans` returned no error
  signal, so an RPC failure came back as an empty list and the Dashboard rendered
  "No outstanding loans" plus borrow CTAs as though the user had none. The
  HomePage "ETH Distributed" tile rendered a confident "0.0000 ETH" on a **failed**
  read, indistinguishable from a genuine zero, and its shimmer branch treated the
  error sentinel as "loading" so an errored tile shimmered forever. The Trade
  page's Approve button dropped its busy state during confirmation (keyed only on
  `isPending`, not `isConfirming`) and looked clickable while still mining. And in
  NFT AMM "My Pools", `<PoolCard isOwner>` was hard-passed `true` for **every**
  tracked pool, so owner controls appeared for pools the connected wallet does not
  own — directly contradicting the card's own "Pool ownership is verified
  on-chain" copy; the prop was deleted entirely.
- **Honesty mediums across six more surfaces** (#109) — the NFT yield-boost badge
  removed from the Leaderboard header (Points and Tier are on-chain-activity
  scores the staking-yield multiplier does not touch; it stays on Farm and
  Dashboard where it does apply); Tegridy Score tips told users to "vote on grant
  proposals" and "post a bounty", **actions nobody can take** since those contracts
  are zeroed; the Tokenomics "Emissions End In" tile showed "Period ended" while
  pool reads were still loading; `ReferralWidget` gained the missing eligibility
  disclosure (you earn only while holding ≥ 1,000 TOWELI of staking power, verified
  against `ReferralSplitter.MIN_REFERRAL_STAKE_POWER = 1000e18`); the Scanner's
  "pools, exchanges, bridges excluded first" was softened to what is actually
  wired, since there is no CEX/bridge label source; and the transaction-history
  "all protocol contracts" feed had been silently omitting the three NFT-finance
  contracts un-gated on 2026-07-21.
- **Sweep tail** (#110) — NFT lending's `getLoanStatus` flagged a loan overdue the
  instant the deadline passed and enabled the lender's "Claim Default" button from
  that second, but `claimDefault` reverts until `deadline + GRACE_PERIOD` (1 hour),
  so the button **guaranteed a reverting transaction for a full hour**; it is now
  gated on a reactive countdown reading "Claimable in …". The Solana swap re-quoted
  immediately before building and executed on the fresh quote with **no comparison
  against the one the user clicked** — slippage protects the transaction on-chain
  but the re-quoted *baseline* could be materially worse than what was shown — so
  the clicked quote is snapshotted and the swap aborts if the fresh `outAmount`
  drops below the shown amount net of slippage, compared in BigInt base units,
  never floats (same defect class as the EVM limit-order fix). Solana open orders
  defaulted to 9 decimals for any non-curated token, rendering a 6-decimal token
  such as USDC roughly **1000x wrong**. The `erc20scan` backend never checked the
  Ethplorer holder response, so a 403, a rate-limit or an `{error}` envelope
  degraded into a **cached 200 with empty holders** — telling users a valid token
  had no holders, cached for two minutes; it now returns an uncached 403 for auth
  failures or 502 for transient ones. And the Launch Simulator's percent inputs
  derived their value from bps on every keystroke, so typing "12" reformatted "1"
  into "1.0" mid-entry and stored 1.0%.
- **Tradermigos detail modal lost its buy button on most entry paths** (#110). The
  buy branch keys on `orderHash` plus price to choose between a native-orderbook
  fill, a Seaport fill and an OpenSea redirect. The Gallery and Floor grids
  pre-merge those listing fields onto each token, but the Hero, the NFT marquee,
  Favorites and the `?token=` share/deep-link path all set the selection from a
  **raw** token — so a listed NFT opened any of those ways lost its price and its
  buy button, and any purchase fell through to the OpenSea redirect, **sending the
  buyer and the 1% native-orderbook treasury fee off-platform.** Fixed once at
  render time rather than at each `setSelected` call site (the `?token=` effect
  also cannot reference `listings`, declared later, without a TDZ error): the
  canonical listing-merge already used by `addToCart` was extracted into a shared
  `enrichWithListing(nft, listings)`, the open NFT is memoized through it, and
  `addToCart` reuses the same helper so cart and modal enrichment cannot drift
  apart. Pure display/routing enrichment — no fulfillment logic changed.
  **Dating note: #110's two commits (`f525576f`, `6780a059`) are authored
  2026-07-24 but only landed on trunk on 2026-07-29 via merge `053dd92d`.**

### Internal — ABI drift gate in CI, a two-tier contract size gate, and an interface-selector guard (2026-07-23)

- `985d9b33` ([#101](https://github.com/fomotsar-commits/tegridy-farms/pull/101))
  — `frontend/src/lib/contracts.ts` does `export * from './abi-supplement'`, so a
  stale generated ABI ships straight to the client **with no compile error to
  catch it**, and there was no gate on that. One was added at the end of the
  contracts-CI `build` job (where `out/` is already compiled): re-run the
  generator, `git diff --quiet`, fail on any drift, deliberately **not**
  auto-committing. Its very first run found real staleness: `TEGRIDY_TWAP_ABI`
  carried only **53 of 147 entries** — missing the entire timelock/proposal
  surface plus 26 custom errors — and still exported a phantom `NotOwner` error
  that OZ `Ownable2Step` had replaced with `OwnableUnauthorizedAccount`. Impact was
  low **by luck, not design**: the sole consumer calls only `consult`, whose
  signature never changed. The generator itself was also made fail-closed —
  previously a missing artifact produced a `console.warn` and it wrote a truncated
  file anyway (the author hit this for real: an 8-entry list against 1 artifact
  produced "Wrote 1/8" and a −10,927-line diff) — and now refuses to write and
  exits 1. A new
  [`memeBountyBoardAbi.test.ts`](frontend/src/lib/memeBountyBoardAbi.test.ts) pins
  `getBounty`'s 7-value tuple against the deployed board
  `0x3457C2210be35bA7AF6F382a76247Ecd782BF0C9`, documenting that an over-declared
  extra output would **not** have thrown, because the dynamic string makes the
  payload always ≥8 slots so a phantom slot silently reads the string length.
  `abi-supplement.ts` has since grown back to exactly 4,000 lines with two
  exports, but that is the gate working — it now holds two full, artifact-accurate
  ABIs rather than stale ones.
- Second half of #101 (it squashes the earlier #96 and #97 plus branch deltas): a
  **delete-before-add sweep of the ABI surface.** `TEGRIDY_DROP_V2_ABI_FULL`
  (1,948 lines) had zero consumers and two signatures drifted from the deployed
  DropV2 template `0xA35ec3e20C4361144b0D99573DEa00B67873e872` —
  `mint(quantity,proof)` vs the deployed `mint(quantity,allowedAmount,proof)`, and
  `executeMerkleRoot(expectedRoot)` vs `(expectedRoot,expectedExecuteAfter)`. Nine
  more supplement exports were pruned (12,181 → 737 lines). Two divergent copies of
  `extract-missing-abis.mjs` existed and the root one's `MISSING` list was stale,
  so root `npm run extract-abis` would have **silently regenerated the file minus
  two admin ABIs** — the root copy was deleted. Finally `frontend/wagmi.config.ts`
  declared `out: 'src/generated.ts'`, a file that does not exist on this branch —
  a loaded gun that would have recreated 6.6k LOC of drift-prone duplicate ABIs —
  so the config, the `wagmi:generate` script and the `@wagmi/cli` devDependency
  were all removed (the `wagmi` **runtime** dependency was kept). *One deliberate
  branch divergence is recorded in-file: #97 pruned `POL_ACCUMULATOR_ABI` as dead,
  which is true on `main` but **false on `mvp-launch`** — `hooks/useProtocolEvents.ts`
  imports it at line 4 and uses it at lines 74–75, wiring added by the 2026-07-22
  protocol-events commit below — so the entry was restored here with a comment to
  re-check at branch reconciliation.*
- `751018fc` ([#103](https://github.com/fomotsar-commits/tegridy-farms/pull/103))
  — the bytecode size check used a **single flat `EXCEPTIONS` list that softened
  both thresholds**, so an allowlisted contract could grow past the real
  24,576-byte EIP-170 limit and still only warn — i.e. become **undeployable while
  CI stayed green.** That is literally how `TegridyStaking` drifted to 24,569 B (7
  bytes of headroom) on `main`. Split into `FLOOR_EXCEPTIONS` (over the
  conservative 24,000 floor but under EIP-170 → warn) and `OVER_EIP170_DEFERRED`
  (genuinely over EIP-170 and **required to be absent from every deploy path** →
  warn); anything else over EIP-170 is now a hard CI error. Sizes were **re-measured
  against this branch rather than copied from `main`**, because `mvp-launch`
  deliberately did not take #99's 573-byte `TegridyStaking` reclaim (a diverged
  ABI-surface change to a frozen contract): `FLOOR_EXCEPTIONS` = TegridyStaking
  24,337 B and VoteIncentives 24,274 B; `OVER_EIP170_DEFERRED` = TegridyRestaking
  26,760 B. The load-bearing precondition holds — TegridyRestaking is explicitly
  absent from both `DeployMVP.s.sol` and `VerifyMVP.s.sol`, commented as deferred
  to Phase 7.
- Same commit: an **interface-selector guard**, closing the standing hazard the
  size gate creates. A Solidity `interface` is never checked against the contract
  it points at, so an EIP-170 golf that demotes a function `external → internal`
  silently drops it from the ABI and the caller reverts at runtime with **empty
  returndata** — a bare `EvmError: Revert` easily misread as gas or arithmetic. On
  `main` this bricked `CommunityGrants.createProposal`. The new build-job step runs
  [`scripts/check-interface-selectors.mjs`](scripts/check-interface-selectors.mjs)
  (149 lines at the time, zero npm deps) against the just-built `out/`. Its first
  run on `mvp-launch` found **four dead declarations this branch still carried that
  `main` had already pruned**: `IVotingEscrow.totalLocked`,
  `IVotingEscrowGrants.totalLocked` and `.votingPowerAt`, `IStakingVote.votingPowerAt`.
  None had call sites, so nothing was live-bricked, but they were exactly the
  latent footgun; deletion was verified **bytecode-neutral** (VoteIncentives
  24,274, CommunityGrants 19,025, MemeBountyBoard 16,177, all Δ0). Both guard
  scripts were added to the push/PR paths filter so editing a guard re-triggers CI.
  *The script has since grown 149 → 467 lines; see the 2026-07-28 entry for Phase 2.*

### Added — GO LIVE: the EVM token launcher un-gated (2026-07-22)

`06adfae9`. The single most user-facing event in this window, and the one every
later launcher entry presupposes. Flipping `LAUNCHER_ENABLED` to true and setting
the Doppler integrator fee address took `/launch` from a gated explainer to a
**live token launcher on Ethereum mainnet**. Operator explicitly authorized it
after the dormancy and single-key-custody trade-offs were surfaced twice.
Verified before the flip: the integrator `0xD355…1051` was checked on-chain as a
valid EIP-55 address and an EOA (nonce 0) — the operator chose this hot wallet
over the runbook's recommended multisig Safe, and the trade-off was flagged; it
carries **fees only, no admin power**, and is re-pointable by redeploy if ever
compromised. A **fork rehearsal passed in-session**: anvil mainnet fork, the
verbatim `launchService` flow, `simulateCreateDynamicAuction` OK, a real
`createDynamicAuction` mined `status=1`, the token deployed as the whitelisted
DopplerERC20V1 Solady clone, and the fee constitution coalescing correctly
(5 Doppler / 80 creator+attention / 15 protocol). 1658/1658 tests green.
**Two things were deliberately not done:** the TOWELI-liveness and pool-depth
gates were **waived** by the operator (the runbook flags launching onto a dormant
token as a brand risk), and **Solana stayed gated**, because its fee address was
a plain keypair rather than a Squads vault — sequenced after the EVM rail shows
real launches (it flipped on 2026-07-26, see #122). Reversible: set
`LAUNCHER_ENABLED=false` and redeploy. The gate-guard test now mocks
`isLauncherEnabled()` false, so the disabled-refusal invariant keeps being
verified independently of the production flag.

### Added — Trust tooling: a shared detection core, token scanner, wallet exposure, launch simulator, deployer graph and launch afterlife (2026-07-22)

Four commits, unnumbered (pushed direct to trunk): `d7ee2a95` → `52f7c67d` →
`65370691` → `18b7627a`. This is the wave that created the surfaces the
2026-07-24 fixes and the 2026-07-28 Trust hub later act on.

- **Shared detection core** (`d7ee2a95`, 4,088 lines across 23 files) —
  [`frontend/src/lib/detection/`](frontend/src/lib/detection/) is pure and
  framework-agnostic: effective-holder count `N_eff = 1/HHI` as the lead metric,
  with HHI, top-N, Nakamoto and Gini as secondary (carrying the address ≠ person
  caveat), clustered-supply %, bundled % reported as **two** numbers (total vs
  currently-held), and sniper-held %. An exclusion registry (LP / CEX / bridge /
  burn / locked / contract, plus Solana PDA and ATA→owner resolution) runs
  **before** any math. A weakest-link gate over hard facts (mint/freeze authority,
  LP lock, top-1 cluster) blends with soft signals into a 3-band verdict, kept
  **separate** from a data-confidence flag. Unmeasured signals are `null` and drop
  out of the blend rather than defaulting to a flattering 0. 62 tests.
- **Token scanner at `/scan`** — paste any Ethereum or Solana token, get a
  concentration and holder-quality read. The data reality was stated rather than
  papered over: there is no free, keyless way to enumerate an arbitrary ERC-20's
  holders (`eth_getLogs` is dead on the public RPC roster, Etherscan's holder list
  is Pro-gated, no indexer), so on Ethereum it ships as a contract-safety + market
  card (authority / renounce / verification / LP-lock, all real `eth_call` reads)
  with distribution self-gating to "unavailable"; full distribution works on
  Solana via `getTokenLargestAccounts`. The `erc20scan` route is wired to Ethplorer
  and lights the ETH distribution up the moment `ETHPLORER_API_KEY` is
  provisioned — no rebuild.
- **Wallet exposure at `/exposure`** — the scanner pointed inward: score your own
  holdings for concentration, bundle and rug exposure. Self-gates per token until a
  holder source exists; scoped to a curated token set plus pasted addresses, with
  no open balance proxy. *(This is the page whose scoring never actually rendered
  until #109 on 2026-07-24 — it was mounted without a `scanToken` adapter.)*
- **Launch simulator at `/launch-simulator`** — preview a token's distribution band
  and Fact-Sheet tier **before** launching, and see the delta needed to pass each
  band. Pure client-side and deliberately useful before the launch rail opened.
- **Deployer reputation at `/deployer` and Launch Afterlife** (`65370691`
  scaffolded 3,792 lines built-and-tested-but-unwired; `18b7627a` routed the two
  read-only halves). The deployer graph classifies a deployer's past launches
  (active / thin / no-market) from available on-chain reads and is
  **data-constrained** — it self-gates to "unobserved" and never fabricates a track
  record; shareable via `?address=0x…`. Launch Afterlife mounts above the
  LaunchExplorer, fed from outcomes already in page state (no new fetch), and
  self-gates to an honest empty statement. The CoW execution modules
  (`cowSwap` / `composableCow` and their panels) shipped in the same scaffold but
  stayed **deliberately unwired** as a money path pending live-wallet QA — they
  were finally mounted on 2026-07-26. A planned rug-replay feature was **not**
  built, on the stated grounds that without an indexer the timeline would be
  hollow.
- *Build note (`52f7c67d`, internal):* `c8cd2dea` and `71253dfe` landed components
  importing `frontend/src/lib/scanner` and `frontend/src/lib/launchSim` while the
  lib directories themselves were **never committed**, so every commit in between
  failed `tsc -b` (TS2307) on a clean checkout — which is why the CI Type Check
  step could not go green. 1,452 lines committed to close it.

### Added — Proof-of-life extended to real protocol events; NFT market-integrity tab (2026-07-22)

`c8cd2dea`, 2,132 lines. `ProtocolPulse` had shown TOWELI trades only; it is now a
unified feed that also surfaces true protocol events — fee distributions, POL
depth changes, gauge votes, graded launches — via a pure
[`lib/protocolEvents/`](frontend/src/lib/protocolEvents/) plus
[`useProtocolEvents.ts`](frontend/src/hooks/useProtocolEvents.ts). Strict
self-gating is preserved: it renders nothing when the protocol is genuinely quiet
and never fabricates activity. Two feeds are **blocked but wired** and self-gate
to `[]` rather than inventing anything — gauge events stay empty until a
GaugeController redeploys (address is `0x0`), and graded launches stay empty until
a real launcher-outcomes feed exists. Same commit added the Tradermigos
**market-integrity tab** (`/nakamigos` → integrity), pointing the detection idea at
NFT manipulation — wash trades, coordinated ownership clusters, fake floors — over
OpenSea plus on-chain reads, scoped to a recent window (no indexer) with the
coverage gaps disclosed, and worded descriptively rather than accusatorially.
*Side effect worth noting: `useProtocolEvents.ts` is the importer that makes
`POL_ACCUMULATOR_ABI` live on this trunk, which is why #97's prune of it was
correct on `main` and wrong here.*

### Added — Exit surface for funds stranded in two retired staking contracts (2026-07-22)

`718a025c`. Two pre-relaunch `TegridyStaking` deployments still hold live
positions, both Etherscan-verified and unpaused as of 2026-07-22: `0x044A…eEe44`
(1,000 TOWELI, tokenId 2, lock expired, +25 TOWELI of funded rewards) and
`0x6266…4819` (100 TOWELI, tokenId 1, lock expired) — `withdraw()` simulated OK
from each holder. [`LegacyStakingExit`](frontend/src/components/farm/LegacyStakingExit.tsx)
on the Farm page reads `userTokenId`/`getPosition` on both legacy addresses (same
`TegridyStaking` family, reusing `TEGRIDY_STAKING_ABI` with **no new exported
ABI**) and renders nothing unless the connected wallet holds a position. Unlocked
→ `withdraw(tokenId)`; still locked → a two-click confirm on `earlyWithdraw` with
the on-chain penalty percentage shown. **Withdraw-only by design** — there is no
stake or approve path to the old contracts, pinned by test. Both are listed on the
Contracts page under Core as "retired — withdraw only" with a deprecated badge, so
they are discoverable without connecting a wallet.

### Fixed — CoW limit orders 404'd in production; stale status badges exposed by the un-gate (2026-07-22)

- `81fbf4fb` ([#98](https://github.com/fomotsar-commits/tegridy-farms/pull/98)) —
  `cowOrderbookUrl` emitted the **unrouted** `/api/aggregator/cow/...` base, so CoW
  limit-order placement and status polling 404'd in production. It now emits the
  rewritten `/api/cow/...` alias, `cowApiUrl` re-exports it so there is one source
  of truth, and a new test pins the base against the real `vercel.json` rewrites
  (mutation-checked). Same commit passes `GITHUB_TOKEN` to `gitleaks-action`, whose
  **PR-event scans had been silently failing repo-wide**.
- `679e26ec` — the 2026-07-16 batch go-live made four NFT-finance rows visible
  carrying hardcoded pre-relaunch annotations that were **false on prod**: "V3Features
  bundle redeploy queued" on NFT Pool Factory / Tegridy Lending (nothing is queued;
  the factory is live and Lending is oracle-gated) and "Awaiting protocol Safe
  `acceptOwnership()`" on NFT Lending (that pending transfer was deliberately
  cancelled 2026-07-19; owner-only functions work). The same falsehood class was
  cleaned where it was dormant or already visible — LP Farming (accept window
  expired June 2026), Gauge Controller, Vote Incentives. Zero-address rows keep
  their automatic "pending deploy" badge; deployed rows now show only the
  live-verification badge.
- `71253dfe` — honest-framing polish on the two pages where framing matters most.
  On Security, faint gray-on-starfield text was raised to legible and the hero
  subhead was rewritten from a generic "commitment to protecting your assets" into
  a verifiable claim ("every claim here is one you can verify yourself… including
  what we haven't done yet"). NFT-Finance intro cards and tabs now show a green
  "Live" pill for deployed sections, not just "Soon" for undeployed, so users can
  tell what is actually usable. **Two items were flagged for operator review and
  deliberately not auto-changed**, both claim-accuracy calls: Security's "On-Chain
  TWAP Pricing — no external feeds" frames an own-pool TWAP as pure upside when a
  shallow own-pool TWAP carries its own manipulation risk; and "24–48h timelock on
  all admin changes" plus "flash swaps disabled" are on-chain claims the frontend
  cannot verify.

### Internal — branch gates greened, two orphaned components deleted, README brought current (2026-07-22)

No user-visible effect.

- `966515c7` then `46d6c7e7` — the CI lint gate had been red on **every push since
  2026-07-19** over two unused type/function imports in test files
  (`discovery.test.ts`, `detection.test.ts`); repo-wide lint went to 0 errors.
  `966515c7` also allowlisted the public PremiumAccess address `0x9DC2…a3f5` in
  `.gitleaks.toml`, because the constant name `PREMIUM_ACCESS_ADDRESS` contains
  "ACCESS" and tripped the generic-api-key entropy rule — the same known-public-address
  false-positive class the shape-based rule finally closed on 2026-07-29. The
  default ruleset stayed fully active.
- `29e98318` — deleted `Icon.tsx` (160 lines) and `SolanaConnectButton.tsx` (41
  lines), both verified orphaned with zero importers in path, relative and
  dynamic-import forms, and neither carrying a test. Minimal-surface mandate:
  delete before add.
- `f44f5a0e` and `e3ee753e` — README brought in line with the 07-21/07-22
  go-lives: the status banner and feature table now mark NFT lending, NFT AMM,
  launchpad, Premium and the EVM token launcher **live**, while stating that the
  emission/spend side (governance, grants, bounties) stays gated until a revenue
  line funds it — **a policy choice, not a handoff dependency**, and the legend now
  says so. The revenue-flywheel diagram was redrawn with the four new surfaces'
  **real** fee destinations (the treasury Safe) rather than the aspirational
  RevenueDistributor edges. `e3ee753e` added the Trust-tooling section (`/scan`,
  `/exposure`, `/deployer`, `/launch-simulator`, launch afterlife, Tradermigos
  market integrity) and moved limit orders out of "future keeper work" into live
  via CoW solvers, with the market-swap and TWAP panels noted as built-but-held.


### Changed — ABI-supplement generator consolidated, 9 dead exports pruned (2026-07-22)

- Consolidated the two divergent copies of the abi-supplement generator into
  one canonical script: [`frontend/scripts/extract-missing-abis.mjs`](frontend/scripts/extract-missing-abis.mjs).
  The stale root copy `scripts/extract-missing-abis.mjs` is deleted — its
  `MISSING` list predated the 2026-04-26 admin-split additions, so running
  root `npm run extract-abis` would have silently regenerated
  `frontend/src/lib/abi-supplement.ts` without `TEGRIDY_STAKING_ADMIN_ABI` /
  `SWAP_FEE_ROUTER_ADMIN_ABI` (and resurrected the dropped
  `TEGRIDY_STAKING_ABI_FULL`). Root `npm run extract-abis` now runs the
  canonical script.
- Per the minimal-surface mandate, pruned `abi-supplement.ts` from 10 exports
  / 12,181 lines to the single export the dApp actually imports:
  `TEGRIDY_TWAP_ABI` (`frontend/src/hooks/useToweliPrice.ts`). The other 9
  were dead (`TEGRIDY_DROP_V2_ABI_FULL` was independently removed on `main`
  by #96; this change deletes the remaining 8) — no named import anywhere in
  frontend code, two of their sources
  (`TegridyDropV2.sol`, `TegridyFeeHook.sol`) no longer exist in
  `contracts/src/`, and admin timelock propose/execute/cancel is operated via
  direct contract interaction (see `AdminPage.tsx`), not from the dApp. The
  generator's `MISSING` list now documents the rule: an entry requires a live
  named import.

### Security — Monster Audit + adversarial sweep (2026-05-09 → 2026-05-10)

7-cluster fresh-eyes adversarial audit on the post-scan6 codebase plus a
post-fix adversarial sweep on the just-shipped batches. Surfaced **13 NEW
findings** atop the ~693 cumulative prior-pass closures (3 HIGH + 5 MEDIUM
+ 3 LOW + 1 INFO on-chain; 3 HIGH + 2 MEDIUM off-chain) **plus 3 fresh
regressions** caught by the post-fix sweep in batches 1+2. Total **16/16
findings closed** across 5 batch commits on `claude/festive-hofstadter-92bccd`.

Per the minimal-surface mandate: every fix is sibling-canonical or
deletion-only. Custom code additions across the entire batch lineage:
~6 LoC (typed errors + helper flags). Everything else is a verbatim port.

Full per-finding ledger:
[`FIX_STATUS.md` § Monster Audit](FIX_STATUS.md#-monster-audit-2026-05-09--2026-05-10).

Highlights:
- **F1** (HIGH) RevenueDistributor ex-restaker silent loss — dropped the
  `_isRestaker` short-circuit, gated `claimedAtEpoch` seal on
  `userPower > 0`. Pattern: Curve `FeeDistributor.claim`.
- **F-LD** (HIGH) TegridyLending pullEscrowRewards cross-loan drain —
  pull-then-cap pattern (Aave V3): pull to lending, transfer
  `min(received, escrowRewardsOwed[loanId])` to recipient, excess feeds
  the legacy pro-rata path.
- **F10** (MED) Orderbook Seaport fill verification structurally
  broken — pre-fix `topics[1]` matched the indexed offerer (not the
  orderHash). Added migration `005_add_seaport_order_hash.sql` storing
  Seaport's canonical EIP-712 OrderComponents hash; ABI-decode of
  OrderFulfilled's `data` field for verification.
- **Frontend hardening** — JWT revocation fail-closed in prod/preview
  (Auth0 / Okta pattern); CORS allowlist consolidation across 8 endpoints
  (Vercel next-cors / AWS API Gateway pattern); shared cookie builder
  module (Express `res.clearCookie()` flag-mirror).

Post-fix adversarial sweep run on the new code (5 parallel agents): clean
verdict across all attack surfaces. F-FRESH-1 / F-FRESH-2 (frontend
NODE_ENV/VERCEL_ENV gates) + F3-PERMA-STRIP (`lookupOk` flag preserves
cached `hasJbacBoost` on transient restaking-lookup failure) all surfaced
and closed in the same lineage.

Test posture:
- **Foundry: 2593 / 2593 passing** across 149 suites (3 independent
  sweeps, identical results)
- **Frontend vitest: 191 / 191 passing** across 14 files
- 4 new Foundry PoC regression tests under
  [`contracts/test/FRESH2026_*.t.sol`](contracts/test/)
- 22-test vitest regression suite at
  [`frontend/api/__tests__/orderbook.fill.test.js`](frontend/api/__tests__/orderbook.fill.test.js)

Battle-tested anchors per category:
| Class | Canonical reference |
|---|---|
| Reward distribution | Curve `FeeDistributor` |
| Pull-then-cap | Aave V3 pull-pattern |
| EIP-712 struct hashing | Seaport SDK `getOrderHash` / viem `hashStruct` |
| JWT prod-token requirements | Auth0 / Okta `jti` mandatory |
| CORS allowlist | Vercel next-cors / AWS API Gateway / Cloudflare |
| Cookie clear/issue symmetry | Express `res.clearCookie()` |
| L2 sequencer staleness | Aave V3 `PriceOracleSentinel` |
| ERC721-bounded callbacks | Nomad ExcessivelySafeCall |
| EIP-7702 detection | `code.length == 23` carve-out (post-Pectra) |

Per `AUDITS.md` honest TL;DR, the in-house adversarial budget has reached
saturation across 8 prior passes + scan2-scan8 + this monster-audit
lineage. The documented next escalation is a paid human audit firm
(OpenZeppelin / Trail of Bits / Spearbit / Cyfrin / Code4rena).


### Security — pass-8 adversarial 100-agent audit + remediation (2026-05-04 → ongoing)

100-agent fresh-eye adversarial pass run end-to-end against the full source
tree (no prior-audit-doc consultation), organized as five waves: 30 per-contract
deep audits + 40 vulnerability-class scans + 15 cross-contract integration
audits + 10 economic / MEV / game-theory + 5 specialized (compiler / toolchain
/ size / test-coverage / latest-2026-exploit-pattern web research). Surfaced
**~675 raw findings → ~275 unique after dedup**, with **10 Critical / ~140 High
/ ~165 Medium / ~110 Low / ~250 Info**. Master report and full per-agent output:
[`.audit_101/PASS8_2026_05_04.md`](./.audit_101/PASS8_2026_05_04.md).

Remediation organized into 6 phases. Owner-trust findings (admin treasury
rotation, captured-key drain paths, single-key pause, etc.) deferred to Phase 6
per multisig-policy lane.

#### Pass-8 Batch 1 — additive foundations (2026-05-05)

Lowest-blast-radius fixes that unblock later phases. All additive — no edits
to existing function logic, no breaking ABI changes, no semantic shifts.

- **LD-04** — `TegridyNFTLending` now floors `createOffer._principal` at
  `MIN_PRINCIPAL = 0.001 ether`, mirroring [`TegridyLending.minPrincipal`](contracts/src/TegridyLending.sol#L190).
  Pre-fix, sub-2000-wei principals made both `MIN_INTEREST_PRINCIPAL_BPS`
  and the duration-based interest floor round to zero, enabling free
  same-block flash-loan round-trips against dust offers. Closed at
  [TegridyNFTLending.sol:351-357](contracts/src/TegridyNFTLending.sol#L351)
  + new constant
  [TegridyNFTLending.sol:38-46](contracts/src/TegridyNFTLending.sol#L38)
  + new `PrincipalTooSmall` error
  [TegridyNFTLending.sol:262-263](contracts/src/TegridyNFTLending.sol#L262).
- **GOV-ECON-01 (a.k.a. C10) — foundation layer** — added new
  [`contracts/src/lib/VotePowerOracle.sol`](contracts/src/lib/VotePowerOracle.sol)
  (`internal` library, no deploy footprint) that sums staking-side and
  restaking-side voting power into a single read. Pattern reference:
  Frax veFXS + Convex `veFXSStrategy`. Plus
  [`TegridyRestaking.votingPowerOf`](contracts/src/TegridyRestaking.sol)
  /
  [`votingPowerAtTimestamp`](contracts/src/TegridyRestaking.sol)
  aliases delegating to the existing `_boostedAmountAt` lazy-decay-safe
  reader (preserves DEEP-DR-04 / DR2-02 / autoMaxLock carve-outs verbatim).
  Library + aliases are additive only — no consumer is wired yet. Batch 2
  will rewire `GaugeController` / `VoteIncentives` / `MemeBountyBoard` /
  `CommunityGrants` / `ReferralSplitter` / `RevenueDistributor` to use
  `VotePowerOracle.powerAt(...)` in place of the staking-side-only reads
  that silently disenfranchise restakers across all four governance
  consumers today.
- **EIP170-01/02/03/04 — CI infrastructure** — bytecode size-budget
  guard added to
  [`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml).
  Enforces a 24,000-byte safety floor (576-byte EIP-170 headroom) on
  every src/ contract; the four currently-overflowing contracts
  (`TegridyLending` 27,242 / `TegridyStaking` 26,912 / `VoteIncentives`
  25,977 / `TegridyRestaking` 24,011) are tracked-exception warnings until
  Phase 0 contract-splits land. Build step also split: compile-only first
  (real errors block), then size-budget step (with allowlist), so CI no
  longer dies on `forge build --sizes` before anything else gets a chance
  to run.

#### Pass-8 Batch 2 — restaker disenfranchisement closed across 6 governance consumers (2026-05-05)

Wires [`lib/VotePowerOracle`](contracts/src/lib/VotePowerOracle.sol) into
every governance / fee-eligibility consumer so a user who restakes their
staking NFT (custody → `TegridyRestaking`) is no longer silently
disenfranchised. Pre-fix, the restaker's per-owner enumerable set in
TegridyStaking went to zero AND a 0-checkpoint was written at deposit
time, making `staking.votingPower*(restaker)` return 0 across the board.
Five of six consumers had no fallback at all; the sixth used an
OR-fallback that silently dropped restaked share for multi-NFT holders.

Per-consumer changes (each adds a `restakingContract` state var + `onlyOwner`
one-shot `setRestakingContract(address)` setter, mirroring the
`setSequencerFeed` pattern in SwapFeeRouter; existing call sites switched
from direct `staking.votingPower*` reads to `VotePowerOracle.power*` so
power becomes additive across staking + restaking):

- **REV-RESTAKE-01** — `RevenueDistributor._calculateClaim`: changed the
  OR-fallback `if (userPower == 0 && isRestaker)` to additive `if (isRestaker)
  userPower += _restakedPowerAt(...)`. Multi-NFT holders (direct NFT-A staked
  + NFT-B restaked) no longer have the restaked share silently dropped when
  staking-side power happens to be non-zero. Closed at
  [RevenueDistributor.sol:741-754](contracts/src/RevenueDistributor.sol#L741).
- **GOV-ECON-01 / C10** — `ReferralSplitter._recordReferralFee` /
  `markBelowStake` / `forfeitUnclaimedRewards`: every
  `stakingContract.votingPowerOf(referrer)` read (3 sites) now additively
  includes restaked power via a parallel try/catch on
  `IRestakingForReferral(restakingContract).votingPowerOf`. A referrer who
  restakes their staking NFT no longer fails the `MIN_REFERRAL_STAKE_POWER`
  gate. Closed at
  [ReferralSplitter.sol:373-389](contracts/src/ReferralSplitter.sol#L373) +
  [:618-632](contracts/src/ReferralSplitter.sol#L618) +
  [:651-666](contracts/src/ReferralSplitter.sol#L651).
- **GOV-ECON-01 / C10** — `MemeBountyBoard.submitWork` /
  `voteForSubmission`: switched both vote-power read sites to
  `VotePowerOracle.powerAt` / `.powerOf` so restakers can submit and vote
  again. Closed at
  [MemeBountyBoard.sol:419-426](contracts/src/MemeBountyBoard.sol#L419) +
  [:466-475](contracts/src/MemeBountyBoard.sol#L466).
- **GOV-ECON-01 / C10** — `CommunityGrants.voteOnProposal`: vote-power
  read switched to additive (preserves DEEP-GOV-01 min-clamp). Closed at
  [CommunityGrants.sol:417-426](contracts/src/CommunityGrants.sol#L417).
- **GOV-ECON-01 / C10** — `GaugeController.vote` / `revealVote`: both
  vote-power sites switched to additive. Closed at
  [GaugeController.sol:317-326](contracts/src/GaugeController.sol#L317) +
  [:572-581](contracts/src/GaugeController.sol#L572).
- **GOV-ECON-01 / C10** — `VoteIncentives.vote` / `commitVote`: both
  vote-power sites switched to additive. Closed at
  [VoteIncentives.sol:506-516](contracts/src/VoteIncentives.sol#L506) +
  [:1373-1382](contracts/src/VoteIncentives.sol#L1373).

`VotePowerOracle` library was also refactored from typed-interface
parameters to plain `address` parameters so each consumer can keep its own
local staking interface name (`IVotingEscrow`, `ITegridyStakingGauge`,
`IStakingVote`, `IVotingEscrowGrants`) without forcing a cross-cutting
interface rename. Library is `internal`-linkage only; functions inline
into every consumer with negligible deploy-footprint overhead.

Operational note: after deploy, owner must call `setRestakingContract` on
each of the 5 consumers that didn't already have a restaking pointer. The
setter is one-shot, so a future restaking-contract migration would require
a fresh consumer deploy — same liability budget as the existing one-shot
setters in the codebase. The guard fails closed: a consumer with
`restakingContract == address(0)` reads only the staking side (current
behavior) until the setter fires.

#### Pass-8 Batch 3 — surgical exploit-by-anyone fixes across 5 contracts (2026-05-05)

Five fixes touching disjoint files (NFTPoolFactory / NFTLending / Lending /
MemeBountyBoard / NFTPool) — minimizes interaction risk while closing 1
Critical, 1 High, and 3 Mediums reachable by any user without special
permissions.

- **C5 / LOOP-01** — `TegridyNFTPoolFactory`: hard cap on
  `_poolsByCollection[c].length` at `MAX_POOLS_PER_COLLECTION = 200`, plus
  raised `MIN_DEPOSIT` floor from 0.01 ETH to 0.05 ETH. Pre-fix, an attacker
  could spam `createPool` for a target collection (≤0.01 ETH each) until the
  per-collection list exceeded the eth_call gas budget, bricking router
  discovery (`getBestBuyPool` / `getBestSellPool`) and any aggregator that
  depends on enumeration. The combo (count cap + raised cost floor) raises
  the spam attack from ~$5k to ~$25k per collection AND structurally caps
  the worst case. Pattern reference: Sudoswap V2's per-collection pool
  ceiling. Closed at
  [TegridyNFTPoolFactory.sol:43-67](contracts/src/TegridyNFTPoolFactory.sol#L43)
  +
  [:188-198](contracts/src/TegridyNFTPoolFactory.sol#L188).
- **NFTLEND-WL-1** — `TegridyNFTLending.proposeWhitelistCollection`:
  `IERC165.supportsInterface(0x80ac58cd)` preflight added to reject EOAs and
  contracts that don't claim ERC721 support. Wrapped in try/catch so legacy
  pre-ERC165 ERC721s (CryptoPunks v1, Sandbox v1) are still admittable;
  the typo / malicious-paste case where `_collection` is a non-ERC721 (e.g.
  an ERC20 or an arbitrary EOA) is rejected at propose-time, before the 24h
  timelock burns. Pattern reference: standard OZ ERC165 detection. Closed
  at
  [TegridyNFTLending.sol:945-967](contracts/src/TegridyNFTLending.sol#L945).
- **GAS-01** — new
  [`contracts/src/lib/SafeERC721Call.sol`](contracts/src/lib/SafeERC721Call.sol)
  library + applied to `_safeOutboundTransfer` (NFTLending) and
  `_safeOutboundTransferStaking` (Lending). Pre-fix, Solidity's `try/catch`
  ALWAYS performs `returndatacopy(0, 0, returndatasize())` before the catch
  block fires — the `gas:` modifier bounds inner gas but does NOT bound the
  copy. A malicious whitelisted ERC721 returning 16 MB of returndata
  OOG-griefs every caller, bricking `claimDefault` /
  `claimStuckCollateral` permanently and causing total lender principal
  loss. The library uses inline assembly to cap returndata at 0 bytes
  (`safeTransferFromBounded` — return value unused) and 32 bytes
  (`safeOwnerOfBounded` — single address). Pattern references: Nomad's
  `ExcessivelySafeCall`, Solady's `LibCall.callContract`. Library is
  `internal`-linkage only (~85 bytes deployed footprint). Closed at
  [TegridyNFTLending.sol:781-812](contracts/src/TegridyNFTLending.sol#L781) +
  [TegridyLending.sol:1170-1199](contracts/src/TegridyLending.sol#L1170).
- **MBB-VOTE-01** — `MemeBountyBoard.voteForSubmission`: any voter who has
  submitted ANY work to the same bounty is now disqualified from voting on
  ANY submission in that bounty (was: only blocked from voting on OWN
  submission). Pre-fix, three colluding submitters (A, B, C) could each
  submit then cross-vote a confederate's submission (A→B, B→C, C→A) and
  trivially clear `MIN_UNIQUE_VOTERS=3` quorum without any honest voters.
  One-line check via the existing `hasSubmitted[bountyId][voter]` map.
  Closed at
  [MemeBountyBoard.sol:471-477](contracts/src/MemeBountyBoard.sol#L471).
- **CLK-02** — `TegridyNFTPool` cooldowns: every `block.number`-based gate
  (`lastSwapBlock`, `lastWithdrawBlock`, `WITHDRAW_NFT_COOLDOWN_BLOCKS=50`)
  switched to `block.timestamp` semantics. Pre-fix, the "50-block ≈ 10
  minute" cooldown comment held only on Ethereum mainnet (12s blocks).
  On Optimism / Base / opBNB (`block.number` is L2 ≈ 2s/block), 50 blocks
  collapsed to ~100 seconds — a 6× degradation that let an owner sandwich
  trader liquidity in a fraction of the intended window. Constant value
  changed from 50 (blocks) to 600 (seconds = 10 minutes); storage and
  constant NAMES preserved for ABI continuity (autogenerated getters
  still respond at the same selectors). To be renamed in the next major
  version. Pattern reference: Aave v3 timestamp-based cooldowns universally.
  Closed at
  [TegridyNFTPool.sol:45-83](contracts/src/TegridyNFTPool.sol#L45) +
  every read/write site.

Bytecode deltas:
- TegridyNFTPoolFactory: 10,097 → 10,267 (+170)
- TegridyNFTLending: 17,390 → 18,773 (+1,383 — IERC165 import + assembly inlining)
- TegridyLending: 27,242 → 28,177 (+935 — assembly inlining; Phase 0 split now MORE urgent)
- MemeBountyBoard: 14,634 → 14,681 (+47)
- TegridyNFTPool: 11,561 (unchanged — semantic-only refactor)
- New SafeERC721Call: 85 bytes deployed (internal library, inlines)

#### Pass-8 Batch 4 — Phase 0.1: TegridyLending → TegridyLending + TegridyLendingAdmin split (2026-05-05)

EIP-170 unblock for the largest size offender. TegridyLending was 28,177 bytes
of runtime bytecode (3,601 bytes over the 24,576 EIP-170 mainnet limit) AFTER
the batch 3 GAS-01 / SafeERC721Call addition. Splitting the propose/execute/
cancel/pending-state surface out into a sister contract — mirroring the precise
pattern used for SwapFeeRouterAdmin in the 2026-04-26 size-reduction sprint —
brought TegridyLending down to **17,658 bytes (saved 10,519, 6,342-byte EIP-170
headroom)**.

- **EIP170-01** — new
  [`contracts/src/TegridyLendingAdmin.sol`](contracts/src/TegridyLendingAdmin.sol)
  (574 LoC) holds the timelock propose/execute/cancel triplets + `pending*`
  storage + `*Proposed` / `*Cancelled` events for **11 parameter groups**
  (protocol fee, treasury, max principal, max APR, min duration, max duration,
  origination fee, min APR, min principal, sweep donated TOWELI, accepted
  collateral whitelist). Inherits `OwnableNoRenounce + TimelockAdmin`.
  Constructor takes the lending address; reads validation constants
  (ceilings, floors) and current values from lending via interface
  (`MAX_PROTOCOL_FEE_BPS()`, `protocolFeeBps()`, `maxAprBps()`, etc.).
- **TegridyLending changes** —
  removed `TimelockAdmin` inheritance; removed all 11 admin parameter group
  triplets (33 functions) + their `pending*` storage + `*Proposed` / `*Cancelled`
  events + view-helper `*ChangeReadyAt()` getters; added `address public lendingAdmin`
  one-shot setter, `onlyAdmin` modifier, and 11 `applyXxx*` setters that admin
  calls after consuming a timelocked proposal. Each `applyXxx*` re-validates
  against the local constant ceilings/floors as defense in depth (same checks
  the admin performed pre-call).
- **Cross-contract reads** — `TegridyLending.createOffer` previously read
  `pendingAcceptedCollateral`, `pendingAcceptedCollateralAdd`, and
  `_executeAfter[ACCEPTED_COLLATERAL_CHANGE]` directly to short-circuit offer
  creation against pending-removal collaterals. Replaced with a single
  `lendingAdmin.acceptedCollateralRemovalPending(_collateralContract)` view
  call. Reverts with `LendingAdminNotSet` if called pre-`setLendingAdmin`.
- **Cancel-rate-limit invariant preserved** — LD3-M3 cancel-rate-limit on
  REMOVAL proposals was previously a single-contract storage read; now split
  across both contracts (admin invokes
  `lending.bumpCollateralRemovalRetryCount(coll)` on each live cancel; the
  reset-on-successful-removal still happens inside `applyAcceptedCollateralChange`).
- **CI guard** — TegridyLending removed from the bytecode-budget exception
  list in
  [`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml).
  Future regressions over 24,000 bytes hard-fail CI.

Operational note: after deploy, owner must call `lending.setLendingAdmin(adminAddr)`
(one-shot, set-once-immutable thereafter) before any user can create an offer.
Setter requires the admin to be a contract (`code.length > 0`) — the
`require()` precludes wiring an EOA. Admin contract owner is independent of
lending owner; both must point at the trusted multisig.

Pattern reference: identical shape to `SwapFeeRouter` ↔ `SwapFeeRouterAdmin`
already in production. Compound v2 Comptroller + ComptrollerStorage uses the
same separation; Aave v3 splits Pool from PoolConfigurator on the same
principle. Both have billions of TVL and have never been compromised via the
split surface.

Bytecode deltas:
- TegridyLending: **28,177 → 17,658 (saved 10,519 bytes; now under EIP-170)**
- TegridyLendingAdmin: **15,875 bytes (new contract; well under EIP-170)**
- Total system increased by 5,356 bytes across the two — gain in deployability
  outweighs the modest sum increase.

3 Phase 0 split exceptions remain: TegridyStaking (26,912), VoteIncentives
(26,350), TegridyRestaking (24,011 — only 11B over budget; Phase 0.4
pre-emptive). These are scheduled for follow-up batches.

#### Pass-8 Batch 5 — Phase 0.3: VoteIncentives → VoteIncentives + VoteIncentivesAdmin split (2026-05-05)

Second EIP-170 unblock. VoteIncentives was 26,350 bytes (1,774 over EIP-170)
AFTER batch 2's GOV-ECON-01 wiring added 373 bytes. Same split pattern as
TegridyLending Phase 0.1: propose/execute/cancel/pending state moved to
sister contract. VoteIncentives dropped to **21,665 bytes (saved 4,685,
2,911-byte EIP-170 headroom restored)**.

- **EIP170-03** — new
  [`contracts/src/VoteIncentivesAdmin.sol`](contracts/src/VoteIncentivesAdmin.sol)
  (~225 LoC) holds the timelock propose/execute/cancel triplets + pending
  storage + Proposed/Cancelled events for **5 parameter groups**:
  bribe fee, treasury, whitelist, per-token min-bribe amount, and the
  one-way commit-reveal enable. Inherits `OwnableNoRenounce + TimelockAdmin`.
  Constructor takes the VoteIncentives address; reads `MAX_FEE_BPS`,
  `bribeFeeBps`, `commitRevealEnabled` for validation.
- **VoteIncentives changes** — removed `TimelockAdmin` inheritance; removed
  all 5 admin parameter group triplets (15 functions) + `pending*` storage
  + Proposed/Cancelled events + view-helper `*ChangeTime()` getters; added
  `voteIncentivesAdmin` one-shot setter, `onlyAdmin` modifier, and 5
  `applyXxx*` setters (`applyFeeChange`, `applyTreasuryChange`,
  `applyWhitelistChange`, `applyMinBribeAmountChange`,
  `applyEnableCommitReveal`). Each `applyXxx*` re-validates against local
  invariants as defense in depth (FEE_CANNOT_BE_ZERO M-08 fix preserved,
  `whitelistedTokenList` swap-and-pop preserved on removal, idempotent
  commit-reveal toggle preserved).
- **Permissionless execute preserved for commit-reveal** — pre-split,
  `executeEnableCommitReveal` was `external` (NOT `onlyOwner`) so any party
  could fire the timelocked enable once delay had elapsed. Mirrored on the
  admin contract — `executeEnableCommitReveal` is permissionless on admin,
  but the underlying `applyEnableCommitReveal` on VoteIncentives is
  `onlyAdmin`. End-to-end gating preserved (only the immutably-wired admin
  can ever invoke the apply path).
- **CI guard** — VoteIncentives removed from the bytecode-budget exception
  list. 2 Phase 0 splits remain (Staking, Restaking).

Operational note: after deploy, owner must call
`voteIncentives.setVoteIncentivesAdmin(adminAddr)` (one-shot,
set-once-immutable). Until called, every `applyXxx` reverts
`NotVoteIncentivesAdmin`.

Bytecode deltas:
- VoteIncentives: **26,350 → 21,665 (saved 4,685; now under EIP-170 by 2,911 bytes)**
- VoteIncentivesAdmin: **7,420 bytes (new contract)**
- Total system increased by 2,735 bytes — gain in deployability outweighs
  the modest sum increase.

2 Phase 0 split exceptions remain: TegridyStaking (26,912 — Phase 0.2),
TegridyRestaking (24,011 — Phase 0.4 pre-emptive).

#### Pass-8 Batch 6 — Phase 0.2 (partial) + Phase 0.4 (full): TegridyStaking trim + TegridyRestaking under budget (2026-05-05)

**Phase 0.2 (partial)** — TegridyStaking is unusual relative to Lending /
VoteIncentives: TegridyStakingAdmin already exists from the 2026-04-26
sprint, so the propose/execute/cancel surface that drove the prior splits is
already extracted. The remaining bytecode is core ERC721 + lock/reward/JBAC
logic — no obvious large extraction targets without breaking ABI or
restructuring storage. This batch ships the **safe partial reductions** that
shave ~240 bytes; the remaining ~2KB clearance to fit EIP-170 requires a
dedicated follow-up batch.

- **EIP170-02 (partial)** — visibility lowered from `public` to `internal`
  on 5 mappings with zero on-chain consumers across the codebase
  (verified by grep over all `contracts/src/*.sol`):
  - `lastTransferTime` ([line 60](contracts/src/TegridyStaking.sol#L60))
  - `emergencyExitRequests` ([line ~182](contracts/src/TegridyStaking.sol#L182))
  - `strandedJbacOwner` ([line ~201](contracts/src/TegridyStaking.sol#L201))
  - `strandedJbacTokenId` ([line ~202](contracts/src/TegridyStaking.sol#L202))
  - `rewardNotifiers` ([line ~1688](contracts/src/TegridyStaking.sol#L1688))

  Each removed autogenerated `public` getter saves ~80 bytes. Off-chain
  readers query via existing events (`EmergencyExit*`, `JbacStranded`,
  `RewardNotifierUpdated`).

- **EIP170-02 (partial)** — replaced the dual auto-getters for
  `strandedJbacOwner` + `strandedJbacTokenId` with a single explicit
  `getStrandedJbac(uint256 tokenId) returns (address owner, uint256 jbacId)`
  combined getter. Net savings: ~130 bytes (2 × ~80B getters → 1 × ~30B
  combined getter).

- **TegridyStaking total delta:** 26,912 → 26,674 (−238 bytes). Still
  2,098 over EIP-170. Documented remaining options in
  [`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml):
    - **(a) Solady ERC721 swap** — replace OZ ERC721 with Solady's lighter
      implementation (~3KB savings). Trade-off: ABI/event differences require
      coordinated frontend + indexer migration.
    - **(b) External library extraction of `kick(uint256)`** — move the
      110-line cold-path cleanup function to a separate library called via
      DELEGATECALL (~3-4KB savings). Trade-off: ~2,600 extra gas per kick
      (cold delegatecall) and complex storage-pointer plumbing for the
      library to access TegridyStaking's storage layout. Acceptable for a
      permissionless cleanup that runs only when expired positions need
      decay.
  Either approach clears the remaining ~2KB. Both are dedicated batches
  with isolated test migration.

**Phase 0.4 (full)** — TegridyRestaking was 11B over the 24,000-byte budget
floor (and 565B under EIP-170 — already deployable, just not under the
safety cap). Trimmed ~150 bytes by lowering visibility on 2 internal-use
mappings:
  - `residualClaimant` ([line ~128](contracts/src/TegridyRestaking.sol#L128))
  - `hasRecoveredPrincipal` ([line ~170](contracts/src/TegridyRestaking.sol#L170))

  Both have zero on-chain consumers; off-chain readers can subscribe to
  `ResidualClaimant*` and `PrincipalRecovered` events.

- **TegridyRestaking delta:** 24,011 → 23,865 (−146 bytes). Now 711 bytes
  under EIP-170 AND under the 24,000 CI budget. Removed from the
  exception list.

**Phase 0 progress (after this batch):**

| Contract | Pre-fix | Post-fix | Status |
|---|---:|---:|---|
| TegridyLending | 28,177 | 17,658 | ✅ Phase 0.1 split landed |
| VoteIncentives | 26,350 | 21,665 | ✅ Phase 0.3 split landed |
| TegridyRestaking | 24,011 | 23,865 | ✅ Phase 0.4 trim landed |
| TegridyStaking | 26,912 | **26,674** | ⏳ Phase 0.2 partial; needs Solady-ERC721 swap OR `kick` external-library extraction for full clearance |

**1 Phase 0 exception remains: TegridyStaking** (still 2,098 over EIP-170;
documented next-batch options in CI workflow comment).

#### Pass-8 Batch 7 — Phase 0.2: Solmate ERC721 swap on TegridyStaking (2026-05-05)

Replaces OpenZeppelin ERC721 with Solmate's minimalist ERC721 to further
reduce TegridyStaking's runtime bytecode. **TegridyStaking 26,674 → 26,079
(saved 595 bytes; cumulative pass-8 savings: 833 bytes).** Solmate's
implementation lacks the IERC4906 / Errors integration of OZ v5.6.1 and uses
inline assembly in the hot transferFrom/balanceOf paths. Battle-tested at
scale by Uniswap V3 NFT positions (Position Manager NFT), Sudoswap, and
Friend.tech.

- **EIP170-02 (Solmate swap)** — base class change in
  [TegridyStaking.sol](contracts/src/TegridyStaking.sol):
  `import "@openzeppelin/contracts/token/ERC721/ERC721.sol"` →
  `import {ERC721} from "solmate/tokens/ERC721.sol"`.
- **`_update` override removed; replaced with three overrides**:
  - `transferFrom(from, to, id)` — handles pre-transfer cooldown +
    rate-limit + lending/restaking exemption + `_settleRewardsOnTransfer`,
    then calls `super.transferFrom` then `_postTokenTransition`.
  - `_mint(to, id)` — calls `super._mint` then
    `_postTokenTransition(0, to, id)`.
  - `_burn(id)` — captures `from = _ownerOf[id]` BEFORE `super._burn`
    (Solmate clears the mapping in `_burn`), then calls
    `_postTokenTransition(from, 0, id)`.
  - New internal `_postTokenTransition(from, to, id)` helper centralizes
    the `_positionsByOwner` updates, `userTokenId` writes,
    `_writeCheckpoint`, autoMaxLock reset, `emergencyExitRequests` cleanup,
    and the `MultipleNFTsAtAddress` event emission. Logic preserved
    verbatim from the prior `_update` second-half body.
- **`tokenURI(uint256)` override added** — Solmate makes this `abstract`
  (OZ provided a default empty implementation). Returns `""` to match the
  prior behaviour. Frontends/marketplaces still resolve metadata via
  TegridyTokenURIReader off-chain per the existing architecture.
- **`supportsInterface(bytes4)` override added** — Solmate's default
  declares ERC165 + ERC721 + ERC721Metadata. We additionally declare
  `0x150b7a02` (ERC721TokenReceiver) since this contract IS a receiver
  (the JBAC inbound path via `onERC721Received`).
- **`_ownerOf` access pattern** — Solmate exposes `_ownerOf` as an
  `internal mapping`, not a `function`. The single call-site in the prior
  `_update` (`from = _ownerOf(tokenId)`) was naturally removed when
  `_update` was deleted. Inside `_burn` override, the pattern is
  `address from = _ownerOf[id]` before `super._burn`.

**Behaviour preservation:**
- ABI-identical for all standard ERC721 surfaces (`transferFrom`,
  `safeTransferFrom`, `ownerOf`, `balanceOf`, `approve`,
  `setApprovalForAll`, `getApproved`, `isApprovedForAll`, `name`,
  `symbol`, `supportsInterface`).
- Standard `Transfer` / `Approval` / `ApprovalForAll` events are
  byte-identical (same indexed signatures).
- `safeTransferFrom` automatically routes through our overridden
  `transferFrom` (Solmate calls `transferFrom` from `safeTransferFrom`
  internally — no separate override needed).

**Storage layout (breaking change for fresh deploy only):**
- OZ used `_owners`, `_balances`, `_tokenApprovals`, `_operatorApprovals`.
- Solmate uses `_ownerOf`, `_balanceOf`, `getApproved`, `isApprovedForAll`.
- Live deployed contracts (using OZ slots) cannot be upgraded in place.
- This migration applies to **fresh deploys only**. Documented in the
  import-block comment.

**Reverts:**
- Solmate uses string requires (`"NOT_MINTED"`, `"WRONG_FROM"`,
  `"INVALID_RECIPIENT"`, etc.) instead of OZ's typed errors.
- Off-chain tooling that filtered on `ERC721NonexistentToken` /
  `ERC721IncorrectOwner` etc. needs updating to match the string reasons.
- All Tegridy custom errors (`TransferCooldownActive`, `TooManyPositions`,
  `AlreadyHasPosition`) preserved verbatim on the override paths.

**Honest remaining gap:** TegridyStaking still 1,503 bytes over EIP-170
after this batch. OZ ERC721 v5.6.1 was already heavily optimized; the
Solmate swap delivered 595B not the ~3KB I projected.

**Phase 0 progress (after this batch):**

| Contract | Pre-pass-8 | Post-pass-8 | Status |
|---|---:|---:|---|
| TegridyLending | 28,177 | 17,658 | ✅ Phase 0.1 split |
| VoteIncentives | 26,350 | 21,665 | ✅ Phase 0.3 split |
| TegridyRestaking | 24,011 | 23,865 | ✅ Phase 0.4 trim |
| **TegridyStaking** | 26,912 | **26,079** | ⏳ Phase 0.2 partial; needs `kick` extraction for full EIP-170 clearance |

Files touched:
- `contracts/src/TegridyStaking.sol` (Solmate import + `_update` →
  `transferFrom`/`_mint`/`_burn`/`_postTokenTransition` refactor +
  `tokenURI` override + `supportsInterface` override)
- `.github/workflows/contracts-ci.yml` (updated remaining-options
  documentation)

#### Pass-8 Batch 8 — Phase 0.2 final-state assessment (2026-05-05)

After investigating multiple bytecode-reduction levers on TegridyStaking,
documenting the empirical reality:

**Attempts that did NOT save bytecode (measured):**

- **Solmate `ReentrancyGuard` swap:** +135 bytes vs OZ. OZ v5's
  transient-storage variant (`TLOAD` / `TSTORE` on Cancun) is more
  bytecode-efficient than Solmate's `string require("REENTRANCY")` —
  the ABI string + revert encoding is heavier than OZ's typed-error
  selector. Reverted.
- **Inline minimalist Pausable** (replacing OZ inheritance): +46 bytes.
  OZ `Pausable` v5.6.1 is already very compact; inheritance overhead is
  smaller than the custom-error selectors + event topic hashes the
  inline copy adds. Reverted.

**Why Phase 0.2 cannot be fully closed in this batch:**

OZ Contracts v5.6.1 has already squeezed out most obvious optimization
targets — the typed errors + transient-storage idioms it uses are
genuinely byte-efficient. The Solmate ERC721 swap delivered 595B not
the ~3KB the audit's plan projected, and follow-on Solmate utility
swaps measured worse than OZ.

**The remaining 1,503-byte gap requires one of three dedicated paths
(documented in
[`.github/workflows/contracts-ci.yml`](.github/workflows/contracts-ci.yml)):**

1. **Add Solady as a Foundry dependency and swap ERC721 to Solady's
   implementation.** Solady is ~200-500B smaller than Solmate (more
   inline assembly in hot paths). Requires `forge install
   Vectorized/solady` and matching test-fixture updates. Likely the
   cleanest path remaining.
2. **Migrate state to ERC-7201 namespaced storage + extract large
   helpers (`kick`, `_settleRewardsOnTransfer`, etc.) to external
   library via DELEGATECALL** with storage-pointer args. Major refactor;
   storage layout breaks live deploy compatibility (acceptable since
   the Solmate ERC721 swap already broke layout).
3. **Split out non-ERC721 logic (JBAC management, stranded-NFT state,
   emergency-exit flow)** to a sister contract holding its own state,
   with TegridyStaking calling via privileged hooks. Larger surface
   change; preserves storage layout but introduces cross-contract gas
   overhead.

**Honest end-state of Phase 0:**

| Contract | Pre-pass-8 | Post-pass-8 | EIP-170 Status |
|---|---:|---:|---|
| TegridyLending | 28,177 | 17,658 | ✅ Cleared (Phase 0.1) |
| VoteIncentives | 26,350 | 21,665 | ✅ Cleared (Phase 0.3) |
| TegridyRestaking | 24,011 | 23,865 | ✅ Cleared (Phase 0.4) |
| **TegridyStaking** | 26,912 | **26,079** | ⏳ −833B; still 1,503B over |

**3 of 4 Phase 0 contracts are now deployable on mainnet.** The fourth
(TegridyStaking) requires a dedicated deep-refactor batch with one of
the three documented paths.

**Updated 2026-05-04 (pass-8 batch-9):** TegridyStaking grew to **26,312 B**
after the CCR-01 reorder + ABI shims (+233 B over the 26,079 figure
above; 1,736 B over EIP-170). TegridyRestaking landed at **24,011 B**
(11 B over the local 24,000-floor; 565 B under EIP-170). Both
re-added to the CI bytecode-budget exception list.

#### Pass-8 Batch 9 — CCR-01 cross-contract JBAC reentry + test/script migration (2026-05-04)

**Verification (forge test results post-batch):**

- TegridyStaking: 84 / 84 pass (incl. all 5 JBAC exit paths)
- VoteIncentives: 60 / 60 pass
- TegridyRestaking: 36 / 36 pass
- AuditR014_Lending: 9 / 9 pass
- PASS7_LENDING_01-04: 4 / 4 pass
- Pass6_Regressions: 4 / 4 pass
- Full unit suite (excluding invariants): **2,483 pass / 20 fail**.
  All 20 failures are pre-existing fallout from pass-8 batch-3 (raised
  `MIN_DEPOSIT` on TegridyNFTPoolFactory + `block.number` →
  `block.timestamp` cooldown switch on TegridyNFTPool); the test
  fixtures still encode the pre-batch-3 constants. Tracked for a
  dedicated NFTPool test-fixture refresh batch.


**Critical (1) — closed:**

- **CCR-01 / C4 — JBAC return-callback cross-contract reentrancy.** Pre-fix,
  every TegridyStaking exit path (`withdraw`, `earlyWithdraw`,
  `emergencyWithdrawPosition`, `emergencyExitPosition`, `executeEmergencyExit`)
  ran `_returnJbacIfDeposited(...)` BEFORE `_clearPosition(...)`. The JBAC
  `safeTransferFrom` callback fires user-controlled code with the staking NFT
  still owned by the attacker — re-entering `TegridyLending.acceptOffer(...)`
  succeeds (transferFrom pulls the staking NFT from attacker; lending pays
  principal ETH). When the callback returns, the outer `_clearPosition`
  burns the staking NFT — burning the lender's collateral and permanently
  trapping their principal. Closed by reordering all 5 exit paths so
  `_clearPosition` (which calls `_burn`) runs BEFORE the JBAC return; helper
  refactored from `_returnJbacIfDeposited(tokenId, to)` to `_returnJbac(tokenId, jbacId, to)`
  with the JBAC id captured pre-clear (since `_clearPosition` deletes the
  Position struct). After the reorder, Solmate's `_ownerOf[tokenId] == address(0)`
  post-burn means any cross-contract `transferFrom`/`safeTransferFrom`/`acceptOffer`
  attempt during the JBAC callback reverts on `from != _ownerOf[id]` — closes
  the parallel ghost-restake attack on TegridyRestaking (CCR-02) by the same
  defense.

  Files changed:
  - [TegridyStaking.sol:912](contracts/src/TegridyStaking.sol#L912) — `withdraw` reorder
  - [TegridyStaking.sol:932](contracts/src/TegridyStaking.sol#L932) — `earlyWithdraw` reorder
  - [TegridyStaking.sol:1647](contracts/src/TegridyStaking.sol#L1647) — `emergencyWithdrawPosition` reorder
  - [TegridyStaking.sol:1671](contracts/src/TegridyStaking.sol#L1671) — `emergencyExitPosition` reorder
  - [TegridyStaking.sol:1726](contracts/src/TegridyStaking.sol#L1726) — `executeEmergencyExit` reorder
  - [TegridyStaking.sol:1956](contracts/src/TegridyStaking.sol#L1956) — `_returnJbac(tokenId, jbacId, to)` helper

**Toolchain follow-ons that landed alongside the CCR-01 reorder (no
runtime semantic change — compilability + auto-getter ABI shims for
the audit/test surface):**

- **Solmate ERC721 import alias.** [TegridyStaking.sol:28](contracts/src/TegridyStaking.sol#L28)
  changed from `import {ERC721}` to `import {ERC721 as SolmateERC721}` so other
  units that wildcard-import `../src/TegridyStaking.sol` (every script + several
  tests) don't surface a colliding `ERC721` symbol against OZ's. Inheritance and
  constructor renamed accordingly.
- **ABI shims for newly-internal mappings.** Re-exposed
  `emergencyExitRequests(uint256)`, `strandedJbacOwner(uint256)`,
  `strandedJbacTokenId(uint256)` ([TegridyStaking.sol:255-258](contracts/src/TegridyStaking.sol#L255))
  and `residualClaimant(uint256)` + `hasRecoveredPrincipal(address)`
  ([TegridyRestaking.sol:451-454](contracts/src/TegridyRestaking.sol#L451)) as
  external view functions, with the underlying state slots renamed to leading
  underscore. Net effect: Pass-8 EIP170-02/04 visibility-trim savings preserved
  on the assignment/read sites; off-chain readers and the audit test suite
  retain the auto-getter ABI shape.

**Test + deploy-script migration to admin sister contracts (Pass-8 Phase 0
splits):**

- **VoteIncentives → VoteIncentivesAdmin** wiring added (or callsites
  redirected) in:
  [test/VoteIncentives.t.sol](contracts/test/VoteIncentives.t.sol),
  [test/AuditDemonstration.t.sol](contracts/test/AuditDemonstration.t.sol),
  [test/AuditR014_VoteIncentives.t.sol](contracts/test/AuditR014_VoteIncentives.t.sol),
  [test/AuditR016_AMMGov.t.sol](contracts/test/AuditR016_AMMGov.t.sol),
  [test/Deep_Governance_2026_05_01.t.sol](contracts/test/Deep_Governance_2026_05_01.t.sol),
  [test/R020_VoteIncentives.t.sol](contracts/test/R020_VoteIncentives.t.sol),
  [test/invariants/VoteIncentivesShares.t.sol](contracts/test/invariants/VoteIncentivesShares.t.sol),
  [script/DeployVoteIncentives.s.sol](contracts/script/DeployVoteIncentives.s.sol),
  [script/DeployV2.s.sol](contracts/script/DeployV2.s.sol).
- **TegridyLending → TegridyLendingAdmin** wiring added (or callsites
  redirected) in:
  [test/AuditR014_Lending.t.sol](contracts/test/AuditR014_Lending.t.sol),
  [test/PASS7_LENDING_01.t.sol](contracts/test/PASS7_LENDING_01.t.sol),
  [test/PASS7_LENDING_02.t.sol](contracts/test/PASS7_LENDING_02.t.sol),
  [test/PASS7_LENDING_03.t.sol](contracts/test/PASS7_LENDING_03.t.sol),
  [test/PASS7_LENDING_04.t.sol](contracts/test/PASS7_LENDING_04.t.sol),
  [test/Pass6_Regressions.t.sol](contracts/test/Pass6_Regressions.t.sol),
  [test/TegridyLending.t.sol](contracts/test/TegridyLending.t.sol),
  [test/TegridyLending_ETHFloor.t.sol](contracts/test/TegridyLending_ETHFloor.t.sol),
  [test/TegridyLending_Reentrancy.t.sol](contracts/test/TegridyLending_Reentrancy.t.sol),
  [test/invariants/LendingInvariants.t.sol](contracts/test/invariants/LendingInvariants.t.sol),
  [test/invariants/Pass6_LendingSolvency.t.sol](contracts/test/invariants/Pass6_LendingSolvency.t.sol),
  [test/invariants/Pass6_RestakingResidualCrossProto.t.sol](contracts/test/invariants/Pass6_RestakingResidualCrossProto.t.sol),
  [test/invariants/Pass7_LendingExtSolvency.t.sol](contracts/test/invariants/Pass7_LendingExtSolvency.t.sol).

  Migration shape: each test/script now `new`'s the `*Admin` sister immediately
  after the underlying contract, calls `set*Admin(address(<sister>))` on the
  inheriting contract, and redirects every `propose*`/`execute*`/`cancel*`/`pending*`
  callsite from the underlying contract to the admin sister. Mirrors the
  production wiring path from [DeployVoteIncentives.s.sol](contracts/script/DeployVoteIncentives.s.sol)
  and [DeployV2.s.sol](contracts/script/DeployV2.s.sol).

#### Pass-8 Batch 10 — TF-INT-02: TegridyFeeHook ERC20 fee stranding closed (2026-05-04)

**Critical (1) — closed:**

- **TF-INT-02 / hook ERC20 fee stranding.** Pre-fix, `TegridyFeeHook.afterSwap`
  collected fees from V4 swaps into `accruedFees[currency]` for any pool
  currency (TOWELI, USDC, WETH, …) and the permissionless `claimFees` then
  `safeTransfer`'d the ERC20 to `RevenueDistributor`. But `RevenueDistributor`
  is ETH-only — its `distribute()` snapshots `address(this).balance`, with no
  per-currency epoch path — so non-WETH ERC20 fees and even raw WETH (sitting
  as an ERC20 transfer) flowed in but never reached veTOWELI holders. Audit
  finding documented at
  [docs/audits/archive/SECURITY_AUDIT_200_AGENT.md:60](docs/audits/archive/SECURITY_AUDIT_200_AGENT.md#L60).

  Closed by:

  1. **Constructor accepts canonical WETH9** (immutable). Set at deploy time
     so a captured owner cannot redirect the unwrap target. New deploy script
     env var `WETH` documented in
     [DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol).
  2. **`claimFees` restricted to the WETH path.** Now unwraps `amount` of
     WETH on the hook side via `IWETH(WETH).withdraw(amount)` and forwards
     native ETH to `revenueDistributor` via
     `WETHFallbackLib.safeTransferETHOrWrap` (10k-gas-stipend ETH leg with
     WETH-wrap fallback). Non-WETH currencies revert
     `MustConvertERC20First()` — directing callers to the conversion path
     below. Closed at
     [TegridyFeeHook.sol:418-447](contracts/src/TegridyFeeHook.sol#L418).
  3. **New `convertERC20FeesToETH(currency, router, path, minETHOut, deadline)`.**
     Owner-gated. Drains the on-hand ERC20 balance through the supplied
     Uniswap V2-compatible router via `swapExactTokensForETH`, then forwards
     the resulting ETH to `revenueDistributor` via the same WETHFallbackLib
     path. Mirrors `SwapFeeRouter.convertTokenFeesToETH` shape — caller
     supplies `minETHOut` floor; path validation requires `path[0] == currency`
     and `path[end] == hook.WETH` AND `router.WETH() == hook.WETH` (so a
     forked-chain router with a different WETH variant cannot redirect the
     swap). Sync-proposal lockout mirrors `claimFees` so a pending sync
     can't be raced to drain the ERC20 balance during the 24h timelock.
     CEI ordering: `accruedFees[currency]` adjusted before the swap.
     Closed at
     [TegridyFeeHook.sol:467-525](contracts/src/TegridyFeeHook.sol#L467).
  4. **New typed errors** for the conversion path:
     `MustConvertERC20First`, `InsufficientETHOut`, `InvalidConversionPath`,
     `DeadlineOutOfRange`, `NothingToConvert`. Plus `ERC20FeesConverted`
     event for off-chain accounting (records the realized `ethReceived`
     post-swap, NOT just the caller-supplied `minETHOut`).

  Trust model: owner-gated path (sandwich risk on `minETHOut` is bounded by
  the immutable destination — captured owner can route value at swap-time
  slippage cost but the destination remains `revenueDistributor`).
  RevenueDistributor.distribute() will pick up the new ETH on the next
  epoch automatically.

  Files changed:
  - [contracts/src/TegridyFeeHook.sol](contracts/src/TegridyFeeHook.sol)
    (constructor +1 param, new immutable `WETH`, new errors + event,
    `claimFees` rewritten, new `convertERC20FeesToETH`, ~+2,668 B)
  - [contracts/script/DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol)
    (new `WETH` env var, updated CREATE2 init-code-hash recipe to include
    the 5th constructor arg)
  - 4 test files updated for the new constructor param (sentinel WETH OK
    for paths that don't exercise the unwrap/convert legs):
    [test/TegridyFeeHook.t.sol](contracts/test/TegridyFeeHook.t.sol),
    [test/Audit195_PremiumHook.t.sol](contracts/test/Audit195_PremiumHook.t.sol),
    [test/Deep_AMM_2026_05_01.t.sol](contracts/test/Deep_AMM_2026_05_01.t.sol),
    [test/PASS7_HOOK_01.t.sol](contracts/test/PASS7_HOOK_01.t.sol),
    [test/R031_TegridyFeeHook.t.sol](contracts/test/R031_TegridyFeeHook.t.sol),
    [test/AuditR014_Misc.t.sol](contracts/test/AuditR014_Misc.t.sol).

  **Verification:**
  - 10 new tests in
    [test/TegridyFeeHook.t.sol](contracts/test/TegridyFeeHook.t.sol)
    covering happy path, minETHOut floor, owner-gating, path-end-must-be-WETH,
    router/WETH mismatch, currency=WETH rejection, zero-balance, past-deadline,
    far-future-deadline, claimFees(WETH) unwrap.
  - Existing PASS7-HOOK-03 regression
    (`test_PASS7_HOOK_01_claimFeesRevertsManagerLocked`) updated to bind
    `WETH = TOKEN0` so it exercises the new unwrap path; new sibling test
    `test_PASS8_TF_INT_02_claimFeesRejectsNonWETH` validates the
    `MustConvertERC20First` revert.
  - TegridyFeeHook bytecode: 8,763 B → 11,431 B (+2,668 B; under 24,000 B
    budget with 12,569 B headroom).
  - Full unit suite (excluding invariants): 2,495 pass / 20 fail (+12 vs.
    pre-batch-10's 2,483 pass; the same 20 pre-existing batch-3 NFTPool
    fixture failures remain).

#### Pass-8 Batch 11 — GOV-INT-01: GaugeController ↔ VoteIncentives decoupling closed (2026-05-06)

**Critical (1) — closed:**

- **GOV-INT-01 / C8 — disjoint gauge / bribe registries.** Pre-fix,
  `GaugeController` and `VoteIncentives` were two completely separate
  registries with no shared notion of pair ↔ gauge identity. A briber
  could call `VoteIncentives.depositBribe(pair, …)` on any factory-validated
  pair, regardless of whether GaugeController had a gauge for that pair —
  and the bond would sit in the contract with no recovery path because no
  voter had any reason to allocate emission weight to a pair that lacked
  an emission distributor. Velodrome / Aerodrome's `Voter` contract has
  enforced a pair → gauge mapping at gauge-creation time since v2; this
  fix mirrors that pattern.

  Closed by:

  1. **`pairToGauge` / `gaugeToPair` mappings on GaugeController.** Bidirectional
     so the deletion path can clear `pairToGauge[gaugeToPair[gauge]]` without
     an O(n) scan. Stored at
     [GaugeController.sol:91-107](contracts/src/GaugeController.sol#L91).
  2. **`proposeAddGauge(address gauge, address pair)` — new mandatory `pair`
     arg.** Pair must be non-zero, must be a contract, and must not already be
     mapped to a different gauge (`PairAlreadyMapped` error). The pair is
     captured in `pendingPairForAdd` alongside the existing `pendingGaugeAdd`
     and committed atomically inside `executeAddGauge`. Defensive re-check on
     `pairToGauge[pair] == 0` at execute time guards against a parallel admin
     path racing the same pair onto a different gauge between propose and
     execute. Closed at
     [GaugeController.sol:777-812](contracts/src/GaugeController.sol#L777).
  3. **Pair mapping cleared on every removal path** — `executeRemoveGauge`
     (synchronous), `executeRemoveGaugeNextEpoch` (deferred-prune), and
     `cancelAddGauge` (pre-execute abort). The next-epoch path deliberately
     clears `pairToGauge` immediately even though `gaugeList` cleanup defers
     to `executeRemoveGaugeFinalize` — this disarms VoteIncentives bribes the
     moment governance flips `isGauge` to false.
  4. **Events updated** — `GaugeAddProposed(gauge, pair, executeAfter)`,
     `GaugeAdded(gauge, pair)`, `GaugeRemoved(gauge, pair)` carry the pair
     argument so off-chain indexers see (gauge, pair) coupling at every state
     transition.
  5. **`VoteIncentives.gaugeController` + one-shot `setGaugeController`.**
     Mirrors the existing `setVoteIncentivesAdmin` / `setRestakingContract`
     one-shot patterns. Locked once set; rejects address(0) and EOAs. Closed
     at
     [VoteIncentives.sol:115-142](contracts/src/VoteIncentives.sol#L115).
  6. **`_requireGaugedPair(pair)` check** on both `depositBribe` and
     `depositBribeETH`. Conditional: when `gaugeController == address(0)`
     (pre-wiring), the check is a no-op for backwards compat with fixtures.
     Once a GC is wired (production deploy), every bribe deposit must target
     a pair with a registered gauge or revert `NoGaugeForPair()`. Closed at
     [VoteIncentives.sol:548 + 620](contracts/src/VoteIncentives.sol#L548).
  7. **Deploy path documented** — `DeployGaugeController.s.sol` step 4 now
     directs the operator to wire the GaugeController on VoteIncentives:
     `voteIncentives.setGaugeController(<gc>)`.

  Trust model: owner-trusted (`setGaugeController` is `onlyOwner`, one-shot,
  rejects EOAs and address(0)). Once wired, the constraint is enforced
  unconditionally for all bribe deposits.

  Files changed:
  - [contracts/src/GaugeController.sol](contracts/src/GaugeController.sol)
    (mapping pair, `pendingPairForAdd`, propose/execute/cancel/remove paths
    + new `InvalidPair` / `PairAlreadyMapped` errors, +749 B → 14,617 B)
  - [contracts/src/VoteIncentives.sol](contracts/src/VoteIncentives.sol)
    (`gaugeController` + setter, `_requireGaugedPair`, error +
    `IGaugeControllerPairs` interface, +421 B → 22,086 B; under budget with
    1,914 B headroom)
  - [contracts/script/DeployGaugeController.s.sol](contracts/script/DeployGaugeController.s.sol)
    (NEXT STEPS updated for the new arg + new wiring directive)
  - 8 test files updated to pass the new `pair` arg to `proposeAddGauge`
    (helpers etch minimal bytecode at the derived pair address):
    [test/GaugeController.t.sol](contracts/test/GaugeController.t.sol),
    [test/AuditR014_Governance.t.sol](contracts/test/AuditR014_Governance.t.sol),
    [test/Deep_Governance_2026_05_01.t.sol](contracts/test/Deep_Governance_2026_05_01.t.sol),
    [test/GaugeCommitReveal.t.sol](contracts/test/GaugeCommitReveal.t.sol),
    [test/R021_GaugeController.t.sol](contracts/test/R021_GaugeController.t.sol),
    [test/AuditR016_AMMGov.t.sol](contracts/test/AuditR016_AMMGov.t.sol),
    [test/PASS7_GAUGE_01.t.sol](contracts/test/PASS7_GAUGE_01.t.sol),
    [test/invariants/PASS5_GaugeWeightConservation.t.sol](contracts/test/invariants/PASS5_GaugeWeightConservation.t.sol).

  **Verification:**
  - 12 new tests in
    [test/PASS8_GOV_INT_01.t.sol](contracts/test/PASS8_GOV_INT_01.t.sol)
    covering: pre-wiring permissive (legacy compat), post-wiring revert on
    ungauged pair (ERC20 + ETH), success on gauged pair, post-remove
    de-arming, `setGaugeController` one-shot / EOA-rejection / zero-rejection,
    plus GaugeController-side validations
    (`PairAlreadyMapped`, zero pair, EOA pair, cancel clears
    `pendingPairForAdd`).
  - All existing gauge / bribe / governance suites unchanged: GaugeController
    12/12, PASS7_GAUGE_01 2/2, VoteIncentives 60/60, AuditR014_Governance
    5/5, AuditR016_AMMGov 6/6, Deep_Governance 3/3, GaugeCommitReveal 14/14,
    R021_GaugeController 12/12.
  - Full unit suite (excluding invariants): **2,507 pass / 20 fail** (+12 vs.
    pre-batch-11's 2,495 pass; the 20 pre-existing batch-3 NFTPool fixture
    failures remain).

#### Pass-8 Batch 12 — Phase 1.6: VoteIncentives self-bribe arbitrage + min-quorum on claims (2026-05-06)

**High (1) — closed:**

- **Phase 1.6 / VoteIncentives self-bribe arbitrage + sub-quorum claim.**
  Pre-fix, two related bugs let a briber profitably round-trip their own bond:

  1. **Self-bribe arbitrage.** A briber could deposit a bribe on (epoch, pair),
     vote with their own VP on the same (epoch, pair), and claim a share
     proportional to `userVP / totalVotesForPair` of the bribe. When the
     briber's VP dominated the pair's `totalGaugeVotes`, they pocketed up
     to `(1 - protocolFeeBps) * bribeAmount` of their own bond — the
     protocol fee was the only spread separating self-bribe from a
     pure-round-trip drain.
  2. **Sub-quorum claim.** Claims succeeded against any non-zero
     `totalGaugeVotes`. A briber could deposit a bribe, vote with a 1-wei
     VP themselves, and claim ~100% of the bribe back via
     `share = bribeAmount * 1 / 1`.

  Closed by:

  1. **`depositedOnPair[user][epoch][pair]` mapping.** Set on every
     successful `depositBribe` / `depositBribeETH`. Read by `claimBribes`
     (revert) and `claimBribesBatch` (silent skip). Strict per-(epoch, pair)
     granularity — depositors are barred from claiming ANY token on the
     pair they bribed, not just the token they deposited. Closed at
     [VoteIncentives.sol:308-321](contracts/src/VoteIncentives.sol#L308) +
     deposit hooks
     [VoteIncentives.sol:631-636 + 750-754](contracts/src/VoteIncentives.sol#L631).
  2. **`MIN_BRIBE_CLAIM_QUORUM = 100e18` constant.** 10% of the existing
     `MIN_DISTRIBUTE_STAKE` (1000e18). `claimBribes` reverts
     `BribePoolBelowQuorum` when `totalGaugeVotes[epoch][pair]` is below
     this; `claimBribesBatch` silently skips the offending epoch.
     Constant publicly exposed so off-chain tooling can mirror the gate
     without re-deriving it. Closed at
     [VoteIncentives.sol:189-205](contracts/src/VoteIncentives.sol#L189) +
     claim sites.
  3. **New typed errors:** `SelfBribeClaimForbidden`,
     `BribePoolBelowQuorum`. Both carry verbose natspec describing the
     close path.

  Trust model: enforced unconditionally on every claim (no admin / wiring
  prerequisite). Unlike GOV-INT-01's optional GaugeController gate, the
  self-bribe lockout activates the moment any deposit lands.

  **Verification:**

  - 9 new tests in [test/PASS8_PHASE_1_6.t.sol](contracts/test/PASS8_PHASE_1_6.t.sol)
    covering: above-quorum non-depositor success, self-bribe revert
    (single token), self-bribe lockout spans all tokens on the pair,
    sub-quorum revert, batch claim skipping blocked epochs, batch claim
    happy path, depositor flag persisting across multiple deposits,
    depositor flag set on ETH bribe path, public constant exposure.
  - Existing VoteIncentives.t.sol tests refactored to route deposits
    through a new `briber` address (separate from voters), so legacy
    coverage of `claimBribes_proportional`, `claimBribes_ETH`,
    `claimBribesBatch`, `double_claim_prevented`, `testFuzz_depositAndClaim`
    continues to validate the proportional-payout / double-claim
    semantics without tripping the new lockout.
  - Bytecode: VoteIncentives 22,086 B → 22,447 B (+361 B; under budget
    with 1,553 B headroom).
  - Targeted suites: VoteIncentives 60/60, PASS8_PHASE_1_6 9/9.
  - Full unit suite (excluding invariants): **2,516 pass / 20 fail** (+9
    vs. pre-batch-12's 2,507 pass; the 20 pre-existing batch-3 NFTPool
    fixture failures remain).

#### Pass-8 Batch 13 — NFTPool test fixture refresh (2026-05-06)

**Test debt cleanup — clears the 20 pre-existing failures from batch 3.**

Batch 3 raised `MIN_DEPOSIT` on `TegridyNFTPoolFactory` (0.01 → 0.05 ETH)
and migrated `lastSwapBlock` / `lastWithdrawBlock` /
`WITHDRAW_NFT_COOLDOWN_BLOCKS` on `TegridyNFTPool` from `block.number` to
`block.timestamp` semantics (CLK-02). Constant *names* were preserved
for ABI continuity, but every test fixture that exercised these surfaces
was still calling `createPool{value: 0.01 ether}` or using `vm.roll` to
advance past the cooldown — both broken post-batch-3.

This batch refreshes 5 test files mechanically:

- **MIN_DEPOSIT bump** — `createPool{value: 0.01 ether}` →
  `createPool{value: 0.05 ether}` across:
  [test/TegridyNFTPoolFactory.t.sol](contracts/test/TegridyNFTPoolFactory.t.sol),
  [test/R064_PaginationBounds.t.sol](contracts/test/R064_PaginationBounds.t.sol),
  [test/Deep_NFTPool_2026_05_01.t.sol](contracts/test/Deep_NFTPool_2026_05_01.t.sol).
  The intentional below-floor revert test
  (`test_createPool_revertsOnBelowMinDeposit`) at `0.009 ETH` still fires
  the `MIN_DEPOSIT` revert correctly under the raised floor.
- **Cooldown semantics** — `vm.roll(block.number + N)` patterns swapped
  to `vm.warp(block.timestamp + N)` in:
  [test/Deep_NFTPool_2026_05_01.t.sol](contracts/test/Deep_NFTPool_2026_05_01.t.sol)
  (`test_DEEP01_swapNextBlockOK`,
   `test_DEEP01_lastWithdrawBlockTracksETHWithdraw`,
   `test_L4_withdrawNFTs_succeedsAfterCooldown`),
  [test/TegridyNFTPool.t.sol](contracts/test/TegridyNFTPool.t.sol)
  (`test_withdrawETH_respectsProtocolFees`),
  [test/AuditR014_NFT.t.sol](contracts/test/AuditR014_NFT.t.sol)
  (`test_M4_removeLiquidity_succeedsInNextBlock`).
  `lastWithdrawBlock` assertions also re-targeted to `block.timestamp`
  since the storage slot now records timestamp.

No source-side changes — pure test-fixture refresh.

**Verification:**

- Full unit suite (excluding invariants): **2,536 pass / 0 fail**
  (+20 vs. pre-batch-13's 2,516 pass; full suite green for the first
  time since pass-7). No source contracts changed; no bytecode delta.

#### Pass-8 Batch 14 — Phase 0.2 finish: TegridyStaking under EIP-170 (2026-05-06)

**Deploy unblocker — TegridyStaking finally fits within mainnet's
24,576-byte runtime bytecode limit.**

Pre-batch-14 status: TegridyStaking sat at 26,312 B, **1,736 B over EIP-170**.
The contract literally could not be redeployed on mainnet. Three documented
forward paths existed (Solady ERC721 / ERC-7201 namespaced storage / JBAC
sister split). This batch uses the **first and third paths combined**, plus
a final pass of public→internal constant trims, to close the gap.

**Composite reductions (1,768 B saved overall):**

1. **Solady ERC721 swap** (–621 B). Replaced
   `import {ERC721} from "solmate/tokens/ERC721.sol"` with Solady's ERC721
   ([lib/solady](contracts/lib/solady)). Solady consolidates the
   `transferFrom` / `_mint` / `_burn` post-processing into a single
   `_afterTokenTransfer(from, to, id)` hook (Solmate required three
   separate overrides). The collapse + Solady's tighter assembly cut 621 B.
   `name()` / `symbol()` are now constant `pure` overrides (Solady has no
   constructor-args surface for them); `tokenURI()` and `supportsInterface`
   updated to match Solady's abstract surface.
2. **JBAC sister-vault split** (–712 B). Created
   [`contracts/src/TegridyStakingJbacVault.sol`](contracts/src/TegridyStakingJbacVault.sol)
   to custody JBAC NFTs and own the stranded-reclaim bookkeeping. Removed
   from `TegridyStaking`: `_strandedJbacOwner` / `_strandedJbacTokenId`
   mappings, `_returnJbac` / `claimStrandedJbac` / `getStrandedJbac`
   functions, the two ABI shims (`strandedJbacOwner` / `strandedJbacTokenId`),
   `onERC721Received` (no longer a token receiver), `IERC721Receiver`
   inheritance + import, the `JbacReturned` / `JbacStranded` events, and
   the `OnlyJbacNFT` error. Wiring: one-shot
   `staking.setJbacVault(address)` post-deploy. UX preserved — users still
   approve TegridyStaking for their JBAC; `stakeWithBoost` now does
   `jbacNFT.safeTransferFrom(user, vault, jbacId)` so the JBAC lands at
   the vault via `vault.onERC721Received` (gated to the configured JBAC
   sender). CCR-01 invariant carried over verbatim — `_clearPosition`
   calls `vault.returnJbac(...)` AFTER `_burn`, and the vault's
   try/catch falls back to stranded-bookkeeping on a reverting JBAC
   contract.
3. **Inlined CCR-01 capture-and-return into `_clearPosition`** (–80 B).
   The 5 exit paths previously each had a one-line inline
   `uint256 jbacId = p.jbacDeposited ? p.jbacTokenId : 0;` capture and a
   trailing `_returnJbac(...)` call. Both moved inside `_clearPosition`,
   which now captures pre-`delete` and calls `vault.returnJbac` post-`_burn`.
   The CCR-01 ordering invariant is now a property of the helper itself
   rather than a discipline at every callsite.
4. **`supportsInterface` override removed** (–27 B). Pre-batch-14 the
   override added `0x150b7a02` (ERC721TokenReceiver) since
   TegridyStaking implemented `IERC721Receiver` for JBAC inbound. After the
   custody split this contract is no longer a receiver, so Solady's base
   `supportsInterface` (ERC165 + ERC721 + ERC721Metadata) is correct as-is.
5. **`optimizer_runs` 10 → 1** (–15 B). Lower runs prioritise deploy-size
   over runtime-gas — exactly what's needed to land Phase 0.2.
6. **Public → internal constant trims** (–~280 B). Lowered visibility on
   constants with no external readers (or external readers that can
   trivially hardcode the value): `BPS`, `BOOST_PRECISION`,
   `MIN_NOTIFY_AMOUNT`, `MIN_STAKE`, `TRANSFER_COOLDOWN`,
   `TRANSFER_RATE_LIMIT`, `EMERGENCY_EXIT_DELAY`, `USER_INACTIVITY_GATE`,
   `MAX_POSITIONS_PER_HOLDER`, `ADMIN_REPLACEMENT_TIMELOCK`,
   `EXTEND_FEE_BPS_CEILING`. Each public→internal saves ~30 B (auto-getter
   selector + assembly stub). `TegridyStakingAdmin`'s two cross-contract
   reads (`BPS()`, `EXTEND_FEE_BPS_CEILING()`) hardcode the values
   inline; tests that read `MAX_POSITIONS_PER_HOLDER` /
   `USER_INACTIVITY_GATE` / `ADMIN_REPLACEMENT_TIMELOCK` similarly
   hardcode (with inline `/* CONSTANT_NAME; internal in batch-14 */`
   tags).

**Final size: 24,544 B — 32 B under EIP-170.**

| Contract | Pre-batch-14 | Post-batch-14 | EIP-170 |
|---|---:|---:|---|
| **TegridyStaking** | 26,312 | **24,544** | ✅ Cleared by 32 B |
| TegridyStakingJbacVault | — (new) | 1,615 | ✅ |

**File changes:**

- [contracts/foundry.toml](contracts/foundry.toml) — added `solady`
  remapping, lowered `optimizer_runs` from 10 to 1.
- [contracts/lib/solady](contracts/lib/solady) — new dependency
  (Vectorized/solady v0.1.26).
- [contracts/src/TegridyStakingJbacVault.sol](contracts/src/TegridyStakingJbacVault.sol) — new sister contract.
- [contracts/src/TegridyStaking.sol](contracts/src/TegridyStaking.sol) — Solady swap, vault wiring, hook
  collapse, constant trims.
- [contracts/src/TegridyStakingAdmin.sol](contracts/src/TegridyStakingAdmin.sol) — hardcoded `BPS` / `EXTEND_FEE_BPS_CEILING`
  cross-contract reads.
- [.github/workflows/contracts-ci.yml](.github/workflows/contracts-ci.yml) — bytecode-budget guard updated:
  TegridyRestaking removed from exceptions (now under both EIP-170 and the
  24,000 floor); TegridyStaking remains an exception ("hugging the line"
  at 24,544 B / 32 B EIP-170 headroom / 544 B over the 24,000 local
  floor).
- 6 test files (TegridyStaking.t.sol, TegridyRestaking.t.sol,
  AuditFixes_Staking.t.sol, FinalAudit_Staking.t.sol, RedTeam_Staking.t.sol,
  Audit195_StakingCore.t.sol): wire JBAC vault in setUp + redirect JBAC
  custody assertions from `address(staking)` to `address(vault)`.
- 2 test files (Audit195_StakingGov.t.sol, AuditR014_StakingAdmin.t.sol):
  hardcode the now-internal constants.
- 1 test file (Pass6_Regressions.t.sol): rebase the
  `unsettledRewardsByTokenId` storage-slot constant from 21 → 22 (Solady
  swap freed 6 leading slots; vault split removed 2 stranded mappings;
  added 1 `jbacVault` slot — net layout shift documented inline).
- 1 test file (AuditFixes_Staking.t.sol): redirect
  `staking.claimStrandedJbac` / `staking.strandedJbacOwner` /
  `staking.strandedJbacTokenId` to `vault.*`.

**Verification:**

- Bytecode budget: TegridyStaking 24,544 B (32 B under EIP-170).
  Vault 1,615 B. All other src/ contracts under 24,000 floor.
- Full unit suite (excluding invariants): **2,536 pass / 0 fail**
  (no regressions from batch-13's all-green baseline).
- All 6 staking-affected suites still green: TegridyStaking 84/84,
  TegridyRestaking 36/36, AuditFixes_Staking, FinalAudit_Staking,
  RedTeam_Staking, Audit195_StakingCore — all pass.

**Mainnet deployability achieved.** All 4 Phase 0 contracts (TegridyLending,
VoteIncentives, TegridyRestaking, **TegridyStaking**) now fit under EIP-170.
This unblocks the long-stalled Wave 0 redeploy.

#### Pass-8 Batch 15 — Phase 3.5: TegridyLending offer expiry (2026-05-06)

**Medium (1) — closed:**

- **Phase 3.5 / TegridyLending offer expiry.** Pre-fix, an active loan offer
  on TegridyLending could be accepted indefinitely — the `LoanOffer` struct
  had no `expiry` field, `createLoanOffer` accepted no deadline, and
  `acceptOffer` performed no timestamp check. A lender's quote at favorable
  terms (e.g., when ETH was 4,000 USD) remained accept-able after market
  drift; the lender's only escape was to remember to `cancelOffer`. Pattern
  of record: BendDAO, NFTfi, ParaSpace all gate offer acceptance on a
  per-offer expiry.

  Closed by:
  1. New `uint64 expiry` field on `LoanOffer` struct.
  2. **`createLoanOffer(...)` (5-arg, backward-compat)** auto-defaults
     expiry to `block.timestamp + MAX_OFFER_VALIDITY` (90 days). All 14
     existing test/script callsites continue working without modification —
     the change is a strict improvement over the prior unbounded behavior.
  3. **`createLoanOfferWithExpiry(...)` (6-arg, explicit)** for lenders
     wanting a tighter expiry. Bounds:
     `[now + MIN_OFFER_VALIDITY, now + MAX_OFFER_VALIDITY]` (1 hour → 90 days).
     1-hour minimum blocks pure-spam expiries; 90-day maximum caps stale-quote
     attack window.
  4. `acceptOffer` reverts `OfferExpired()` once `block.timestamp > offer.expiry`.
     `cancelOffer` is intentionally NOT gated on expiry — lender can recover
     principal + held origination fee from an expired offer at any time.
  5. New typed errors: `InvalidOfferExpiry`, `OfferExpired`.

  Verification: 10 new tests in
  [test/PASS8_PHASE_3_5.t.sol](contracts/test/PASS8_PHASE_3_5.t.sol).
  Full unit suite: **2,546 pass / 0 fail** (+10 vs. pre-batch-15).
  Bytecode: TegridyLending 17,658 → 18,292 (+634 B; under EIP-170 with
  6,284 B headroom).

#### Pass-8 Batch 16 — TegridyFeeHook PoolKey allowlist (2026-05-06)

**High (1) — closed:**

- **TegridyFeeHook PoolKey allowlist.** Pre-fix, `afterSwap` accepted ANY
  PoolKey from any pool that attached this hook. The V4 PoolManager only
  enforces an address-bit pattern on hooks; it does NOT gate which pools
  can use a given hook contract. An attacker could deploy a V4 pool with
  attacker-controlled tokens (e.g. an ERC20 with `transferFrom` no-op'd),
  attach this hook to the new pool, trigger a swap, and watch the hook
  credit `accruedFees[<malicious token>]` against itself. Combined with
  the existing owner-gated `convertERC20FeesToETH` path, the attacker
  could then route the fake fees through a routing path of their choice
  if a captured-owner / routing-curve manipulation was layered on. Even
  without the drain leg, fake fee accrual corrupts the protocol's fee
  accounting and makes legitimate `claimFees` calls under-recover.

  Closed by:
  1. New `mapping(bytes32 poolKeyHash => bool) public approvedPools`.
  2. Owner-gated single-step `approvePool(PoolKey)` and `revokePool(PoolKey)`.
     No timelock — adding a pool is additive (creates a new fee stream)
     and revoking is defensive (cuts off a misbehaving pool); 24h delay
     would be counterproductive on either path.
  3. `afterSwap` first check: `if (!approvedPools[_poolKeyHash(key)])`
     return zero-fee. Crucially, the path does NOT revert — that would
     brick every swap on a misconfigured pool. The swap completes for the
     user; the hook simply contributes nothing to the swap delta.
  4. New `PoolApproved(hash, currency0, currency1)` and `PoolRevoked(hash)`
     events for off-chain indexing.
  5. New typed error `PoolNotApproved` (currently unused — the silent-
     zero-fee path is preferred — but kept declared for future strict-mode
     deploys that may want to reject swaps outright).

  Files changed:
  - [contracts/src/TegridyFeeHook.sol](contracts/src/TegridyFeeHook.sol)
    (mapping, helper, approve/revoke, gate; ~+670 B → 12,106 B; under
    EIP-170 with 12,470 B headroom).
  - [contracts/test/PASS8_HOOK_ALLOWLIST.t.sol](contracts/test/PASS8_HOOK_ALLOWLIST.t.sol)
    (new — 6 dedicated tests covering: unapproved → zero-fee, approved →
    accrues, revoked → stops accruing, events emitted, only-owner gating,
    different fee-tier PoolKeys are distinct allowlist entries).
  - [contracts/test/PASS7_HOOK_01.t.sol](contracts/test/PASS7_HOOK_01.t.sol)
    + [contracts/test/R031_TegridyFeeHook.t.sol](contracts/test/R031_TegridyFeeHook.t.sol):
    setUp now calls `hook.approvePool(_key())` / `hook.approvePool(_mkKey())`
    so the existing post-fix regressions still validate against an
    approved pool.

  **Verification:** 6 new tests pass; full unit suite **2,552 pass / 0 fail**
  (+6 vs. pre-batch-16).

#### Pass-8 Batch 17 — TegridyNFTPool ERC-2981 royalty enforcement (2026-05-06)

**Medium (1) — closed:**

- **TegridyNFTPool ERC-2981 royalty enforcement.** Pre-fix, both swap
  paths bypassed creator royalties entirely — the contract didn't import
  `IERC2981` nor query `royaltyInfo` on any code path. Mainstream NFT
  marketplaces (Blur, OpenSea Pro, Sudoswap V2) honor on-chain royalty
  enforcement; this pool deviated silently from the marketplace norm,
  exposing the protocol to creator-community pushback and potential
  ecosystem blacklisting.

  Closed by:
  1. New minimal `IERC2981` interface (single `royaltyInfo(tokenId,
     salePrice) → (receiver, royaltyAmount)` function).
  2. New private `_settleRoyalty(totalSale, firstTokenId)` helper that
     try-calls the collection's `royaltyInfo`, validates the response
     (rejects zero receiver, zero amount, or amount ≥ totalSale as
     pathological), and forwards via `WETHFallbackLib.safeTransferETHOrWrapNoRevert`.
     Misbehaving receivers (e.g. revert on `receive()`) cannot brick a
     sale — both ETH and WETH legs failing silently skip the royalty.
  3. **`swapETHForNFTs`** — royalty deducted from pool spot-revenue
     (after protocol fee + LP fee). Buyer pays `inputAmount` regardless
     of royalty; pool's net retained piece shrinks.
  4. **`swapNFTsForETH`** — royalty deducted from seller's payout
     (after protocol fee + LP fee). Seller receives `outputAmount −
     royalty`.
  5. New events: `RoyaltyPaid(receiver, amount, tokenId)` and
     `RoyaltyFallbackToWETH(receiver, amount, tokenId)` for indexers
     tracking royalty flow vs. WETH-fallback-on-receiver-revert.

  Anchoring on `tokenIds[0]` for the royaltyInfo query is faithful to
  the dominant ERC-2981 implementation pattern (single rate per
  collection); tokens with per-token royalty curves are an ERC-2981
  edge case that this implementation explicitly trades against batch-gas
  efficiency.

  Files changed:
  - [contracts/src/TegridyNFTPool.sol](contracts/src/TegridyNFTPool.sol)
    (interface, helper, swap-path integrations, events; ~+800 B → 12,402 B).
  - [contracts/test/PASS8_ROYALTY.t.sol](contracts/test/PASS8_ROYALTY.t.sol)
    (new — 5 dedicated tests).

  **Verification:**
  - 5 new tests covering: BUY path pays royalty out of pool revenue, SELL
    path pays royalty out of seller payout, non-ERC-2981 collection pays
    zero (back-compat), misbehaving receiver doesn't brick the sale,
    pathological 100% royalty rate is refused.
  - Full unit suite: **2,557 pass / 0 fail** (+5 vs. pre-batch-17).

#### Pass-8 Batch 18 — ETH-ingress counters on POLAccumulator + SwapFeeRouter (2026-05-06)

**Low (1) — closed:**

- **ETH-ingress accounting on POLAccumulator + SwapFeeRouter.** Pre-fix,
  both contracts had bare `receive()` paths that accepted ETH without
  any per-deposit accounting trail. POLAccumulator emitted an
  `ETHReceived(sender, amount)` event but did not track a cumulative
  total; SwapFeeRouter had no event at all. Combined with the
  bare-`receive()` design, "donated" / accidental / mistransferred ETH
  drifted into the contract balance with no way for off-chain monitoring
  to distinguish legitimate fee inflow from anomalous deposits — a
  weak signal but a real reconciliation gap.

  Closed by:

  1. **`uint256 public totalETHReceived`** on both contracts. Monotonic
     counter — incremented in `receive()`, never decremented. Distribution
     outflows are tracked on the receiving contracts (RevenueDistributor /
     ReferralSplitter / etc.); this counter is a one-way ETH-ingress
     witness.
  2. **POLAccumulator**: existing `ETHReceived(sender, amount)` event
     preserved; counter increment added at the head of `receive()`.
  3. **SwapFeeRouter**: bare `receive()` upgraded to emit a new
     `ETHReceived(sender, amount)` event AND increment the counter.
     Pre-fix, SwapFeeRouter's `receive()` was completely silent — no
     event, no counter — making indexer-driven anomaly detection
     impossible.

  MemeBountyBoard intentionally has no `receive()` (donated ETH literally
  cannot land), so it's not in scope. The audit-recon flagged it as a
  gap but the underlying mechanism (no-receive) is itself a stronger
  defense than a counter would provide.

  Files changed:
  - [contracts/src/POLAccumulator.sol](contracts/src/POLAccumulator.sol)
    (+ counter declaration + increment).
  - [contracts/src/SwapFeeRouter.sol](contracts/src/SwapFeeRouter.sol)
    (+ counter declaration + event + increment).
  - [contracts/test/PASS8_ETH_COUNTERS.t.sol](contracts/test/PASS8_ETH_COUNTERS.t.sol)
    (new — 4 dedicated tests using a minimal harness with the same
    `receive()` shape as both contracts).

  **Verification:**
  - 4 new tests covering: increment on first deposit, monotonic
    accumulation across multiple deposits, event emission, zero-value
    no-op, monotonic-on-drain (counter does NOT decrement on outflow).
  - Full unit suite: **2,561 pass / 0 fail** (+4 vs. pre-batch-18).

#### Pass-8 final closure — open queue resolution

The remaining audit master-plan items resolved as follows:

- **Phase 1.7 (single-VP across consumers)** — investigated; **NOT a
  bug**. Each governance consumer (RevenueDistributor, VoteIncentives,
  MemeBountyBoard, CommunityGrants) operates an independent reward pool;
  a staker's VP is a *claim* on each pool's distinct budget, not a
  fungible resource that gets "spent." This is the standard Curve /
  Aerodrome / Velodrome / Balancer pattern. None of the per-contract
  audit reports (017 VoteIncentives, 019 CommunityGrants,
  020 MemeBountyBoard, 024 RevenueDistributor) flagged simultaneous
  VP usage as a finding. No code change required.
- **Phase 2.6 / LD-01 (origination-fee live read)** — already fixed.
  `acceptOffer` re-derives the fee from gross deposit using the LIVE
  `originationFeeBps`, honoring fee CUTS between create and accept;
  fee snapshot is NOT stored on the offer.
- **TWAP first-observation hardening** — already closed in pass-6
  HIGH-3 + pass-7 PASS7-TWAP-01. First observation stamped
  `bypassed = true`; consult-time and per-window guards both refuse a
  bypassed-anchor lookup.
- **TegridyDropV2 reveal force-resolve** — by design. Drop is a
  standard mint-then-reveal ERC721, NOT a commit-reveal raffle.
  Reveal is an optional one-shot owner action with no expiry; under-
  reveal cannot brick the drop. Cancellation is pre-mint only
  (DEEP-DROP-05) which prevents the only stuck-funds scenario by
  construction. No fix required.

**All open items from the pass-8 master plan are now resolved.**

### Security — pass-7 adversarial multi-agent audit + remediation (2026-05-03 → 2026-05-04)

Three parallel worktree agents (oracle/AMM/fees, staking/governance, lending/NFT)
attacked the ground claimed closed by the 6 prior internal passes + Spartan,
plus the pass-6 invariant suite (13 props × 1.664M calls). Surfaced **1 Critical
+ 6 Highs + 4 Mediums + 1 Low + 1 Info** (13 NEW findings), all with runnable
Foundry PoCs. **All 13 closed in same-week remediation** using battle-tested
patterns mirrored from existing in-codebase fixes plus the canonical V4 hook
reference (`lib/v4-core/src/test/FeeTakingHook.sol:48`). Master report:
[`.audit_101/PASS7_2026_05_03.md`](./.audit_101/PASS7_2026_05_03.md).

#### Fixed — Critical (1)

- **PASS7-HOOK-01** — `TegridyFeeHook.afterSwap` now calls
  `poolManager.take(feeCurrency, address(this), feeUint)` inside the unlock
  context to settle the hook's positive `hookDelta`. Pre-fix, every V4 swap
  routed through the hook would have reverted `CurrencyNotSettled` because
  the returned `feeAmount` registered a positive delta with no corresponding
  `take()` call. Hook was undeployed (latent), but `script/DeployTegridyFeeHook.s.sol`
  is ready and would have bricked all V4 pools on day one. Pattern:
  [`lib/v4-core/src/test/FeeTakingHook.sol:48`](contracts/lib/v4-core/src/test/FeeTakingHook.sol#L48).
  Closed at [TegridyFeeHook.sol:282-302](contracts/src/TegridyFeeHook.sol#L282).

#### Fixed — Contract Highs (6)

- **PASS7-TWAP-01** — dropped the V3-AMM-L1 `&& found` carve-out at
  [TegridyTWAP.sol:738](contracts/src/TegridyTWAP.sol#L738). Pre-fix, the
  `!found` fallback path on sparse pairs anchored on the bypassed bootstrap
  and returned a poisoned price (PoC: 1e14 wei vs ~1 ETH fair value).
  Post-fix, ANY bypassed anchor reverts `OracleRebootstrapping` —
  fail-closed, exactly the FRESH-EYES H-3 invariant intent.
- **PASS7-GAUGE-H1** — `proposeAddGauge` now reverts `GaugeRemovePending`
  while `pendingGaugeRemove == gauge`, blocking the `executeRemoveNextEpoch
  → proposeAddGauge → executeAddGauge` cycle that previously stranded
  `pendingGaugeRemove`, duplicated the gauge in `gaugeList`, and bricked
  ALL future gauge removals permanently. Closed at
  [GaugeController.sol:743-765](contracts/src/GaugeController.sol#L743).
- **PASS7-LENDING-01** — `TegridyLending.acceptOffer` now post-condition
  checks `staking.ownerOf(_tokenId) == address(this)` after the inbound
  `transferFrom` and reverts `CollateralNotEscrowed` if the staking contract
  no-op'd. Sister to TegridyNFTLending L506-508; closes the lending-side
  parity gap pass-6 LD-NEW-H2 left open. Closed at
  [TegridyLending.sol:824-834](contracts/src/TegridyLending.sol#L824).
- **PASS7-LENDING-02** — `TegridyLending.repayLoan` /
  `claimDefaultedCollateral` now wrap outbound `staking.transferFrom` in
  new `_safeOutboundTransferStaking` helper + `stuckCollateralRecipient` map
  + new `claimStuckCollateral(loanId)` recovery function — full mirror of
  TegridyNFTLending's L743-L793 + L721-L741 + L176 pattern. On no-op
  detection: `stuckCollateralRecipient[loanId] = recipient`, emits
  `CollateralStuck`. Recipient retries via `claimStuckCollateral` once the
  collateral becomes honest. Closed across
  [TegridyLending.sol:993-1163](contracts/src/TegridyLending.sol#L993).
- **PASS7-LENDING-03** — settled-vs-settled cross-loan drain via shared
  per-tokenId reward bucket. `acceptOffer` now snapshots
  `unsettledRewardsByTokenId[tokenId]` into `loanRewardsSnapshot[loanId]`.
  At settlement, `repayLoan` / `claimDefaultedCollateral` drain to LENDING
  (not directly to recipient) and split: `priorShare = min(totalDrained,
  snapshot)` stays in lending balance for prior-holder recovery via
  `pullEscrowRewards`; `myShare = totalDrained - priorShare` forwarded to
  current recipient. On try/catch deferral, the un-claimable slice is
  recorded into `escrowRewardsOwed[loanId]`. Closes the cross-loan
  attribution gap that pass-6 LD-NEW-H1 only defended on the active-vs-
  settled axis. Closed across
  [TegridyLending.sol:840-851 + L955-L1028 + L1108-L1149](contracts/src/TegridyLending.sol#L840).
- **PASS7-NFTLENDING-01** — `TegridyNFTLending.claimStuckCollateral` now
  retries the transfer under `_safeOutboundTransfer` with post-condition
  check and reverts `StuckCollateralStillStuck` if the collection still
  no-ops. Pre-fix, the function deleted the recovery mapping BEFORE issuing
  a raw `transferFrom`, so a still-malicious collection silently consumed
  the recovery right (mapping zero, NFT permanently stuck). Closed at
  [TegridyNFTLending.sol:721-744](contracts/src/TegridyNFTLending.sol#L721).

#### Fixed — Contract Mediums (4)

- **PASS7-POL-02** — `POLAccumulator._twapMinOut` and `_twapHarvestMinOut`
  now mirror TegridyLending's bypass-cooldown defense: refuse any TWAP read
  for `TWAP_PERIOD * 2 = 60 minutes` after a bypass observation. Closes
  the defense-in-depth gap that compounded with PASS7-TWAP-01 to enable
  ~99.5% MEV bleed per accumulate during the bypass window. Closed at
  [POLAccumulator.sol:813-822 + L838-L847](contracts/src/POLAccumulator.sol#L813).
- **PASS7-HOOK-03** — `TegridyFeeHook.claimFees` no longer calls
  `poolManager.take()` outside the unlock context (which always reverted
  `ManagerLocked`). Now does plain `IERC20(currency).safeTransfer(
  revenueDistributor, amount)` against the hook's own ERC20 balance —
  works in any tx context. Auto-resolved by the PASS7-HOOK-01 fix
  (`take()` inside afterSwap means fees live in the hook contract balance
  going forward). Closed at
  [TegridyFeeHook.sol:354-366](contracts/src/TegridyFeeHook.sol#L354).
- **PASS7-LPFARM-M1** — `TegridyLPFarming.updateReward` modifier now
  re-derives `effectiveBalanceOf[account]` from the live staking-side
  boost on every interaction. Pre-fix, the cache was only refreshed on
  user-initiated `stake / withdraw / refreshBoost`; after lock expiry or
  staking-NFT transfer, the cache stayed inflated, letting attackers earn
  at the legacy boost ratio (~29% over-credit on 1y lock, ~300% at MAX_BOOST).
  Pattern of record: Synthetix `StakingRewards` checkpoint-at-every-
  interaction. Closed at
  [TegridyLPFarming.sol:204-241](contracts/src/TegridyLPFarming.sol#L204).
- **PASS7-NFTLENDING-02** — `TegridyNFTLending.cancelRemoveCollection` now
  mirrors TegridyLending's FRESH-EYES L still-live carve-out: only count
  cancels of STILL-LIVE proposals against the retry budget. Pre-fix, three
  propose → expire → cancel cycles permanently bricked the removal lever
  for a flagged collection. Closed at
  [TegridyNFTLending.sol:996-1018](contracts/src/TegridyNFTLending.sol#L996).

#### Fixed — Low (1) + Info (1)

- **PASS7-DOC-04** — `Pass6_TWAPFirstObsBypass.t.sol` invariant updated to
  reflect the post-PASS7-TWAP-01 contract-level guard that makes
  "successful consult ⇒ non-bypassed anchor" hold by construction.
  `FIX_STATUS.md` now narrows the TWAP HIGH-3 closure description to
  acknowledge the V3-AMM-L1 carve-out gap pass-7 closed.
- **PASS7-SFR-05** — `SwapFeeRouter` now declares `address public sequencerFeed`
  + `uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours` + a one-shot
  `setSequencerFeed(address)` owner setter. `_enforceTWAPMinETHOut` calls
  `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD)`
  and a post-resume freshness gate. Mainnet zero-impact (sequencerFeed
  defaults to address(0), all helpers no-op); L2 deploys call
  `setSequencerFeed(...)` once before the first conversion. One-shot
  pattern preserves the existing 4-arg constructor signature so 17 in-tree
  test/script call sites don't need updates. Closed at
  [SwapFeeRouter.sol:172-201 + L494-L515 + L1923-L1946](contracts/src/SwapFeeRouter.sol#L172).

#### Tests

- New regression suite under
  [`contracts/test/PASS7_*.t.sol`](contracts/test/) — 9 files, 15 tests,
  all converted from "asserts exploit" → "asserts fix". Each PoC keeps
  the original adversarial flow but flips assertions to verify the new
  revert behavior (`vm.expectRevert(NewError.selector)`) or correct
  recovery semantics. Run: `forge test --match-path "test/PASS7_*.t.sol"`.
- Patched 5 in-tree mock TWAPs (`POLAccumulator.t.sol`, `Audit195_POL.t.sol`,
  `AuditR014_POL.t.sol`, `FinalAudit_POLPremium.t.sol`,
  `RedTeam_POLPremium.t.sol`, `invariants/LendingInvariants.t.sol`) with
  the new `lastBypassUsed(address) returns (uint256)` getter required by
  the POL bypass-cooldown gate. Mocks return 0 (no-bypass-observed) so
  legacy tests are no-op against the new path.
- `test_consult_succeedsAtMaxPeriod` updated for fail-closed bypassed-anchor
  semantics (seeds 49 observations to overwrite the bypassed bootstrap
  before max-period consult).

#### Sign-off (PASS7 §6)

- **$1M TVL — ACCEPTABLE with operational guardrails.** All 13 fixes
  shipped. Hook still operationally undeployed; if/when V4 deploy lands,
  external V4-hook-specialist review recommended before mainnet.
- **$10M TVL — Need paid-firm engagement (Spearbit / OpenZeppelin /
  ChainSecurity caliber) targeting the architectural cluster (per-tokenId
  attribution, V4 hook semantics, boost-cache lifetime).**
- **$100M TVL — Above PLUS post-firm invariant-suite re-run with targets
  ≥ 5M calls per surface.**

### Security — post-pass-7 invariant-driven hardening (2026-05-04)

Net-new stateful invariant suite extending pass-6's `Pass6_LendingSolvency`
with pause/unpause + claimStuckCollateral handler actions. Ran Slither
v0.11.5 + Foundry invariant fuzzer against the post-pass-7 tree. Slither
surfaced zero new actionable findings vs the pass-6 triage baseline; the
new invariant suite **caught 1 net-new HIGH** introduced by the
PASS7-LENDING-03 closure itself.

#### Fixed — Contract Highs (1)

- **PASS7-LENDING-04** — directPaid + legacy double-claim regression in
  `TegridyLending.pullEscrowRewards`. The PASS7-LENDING-03 deferral-tracker
  records `escrowRewardsOwed[loanId] += myDeferred` when a paused-staking
  try/catch leaves a slice in the per-tokenId bucket. When staking later
  unpaused and the recipient called `pullEscrowRewards`, the `directPaid`
  branch drained the slice from the staking bucket DIRECTLY to the recipient
  but the legacy ledger never reconciled — `payout = 0` because lending's
  TOWELI balance was 0 — leaving `escrowRewardsOwed[loanId]` and
  `totalEscrowRewardsOwed` at the deferred amount. Any subsequent TOWELI
  inflow to lending (donation, sibling loan's `priorShare`, sweep return)
  became double-claimable via a second `pullEscrowRewards` call against the
  legacy pro-rata branch. Trigger preconditions are operational not
  adversarial: any admin pause on staking that coincides with a loan
  settlement auto-arms the desync. Fix: reconcile both per-loan and global
  counters by `min(directPaid, owed)` immediately after computing
  `directPaid`, so the two payout legs decrement in lockstep. Closed at
  [TegridyLending.sol:1845-1869](contracts/src/TegridyLending.sol#L1845).
  Master writeup:
  [`.audit_101/PASS7_LENDING_04.md`](./.audit_101/PASS7_LENDING_04.md).

#### Tests

- **New stateful invariant suite**:
  [`contracts/test/invariants/Pass7_LendingExtSolvency.t.sol`](contracts/test/invariants/Pass7_LendingExtSolvency.t.sol)
  — extends `Pass6_LendingSolvency` with pause/unpause cycles on both
  staking AND lending + `claimStuckCollateral` handler action. Three
  properties:
  - **P7A-1** ETH solvency holds across pause cycles (mirrors Pass6 E1
    under wider sequence space)
  - **P7A-2** TOWELI backing for `totalEscrowRewardsOwed`
    (`toweli.balanceOf(lending) + staking.unsettledRewards(lending) >=
    totalEscrowRewardsOwed`) — the property that surfaced LENDING-04
  - **P7A-3** `stuckCollateralRecipient[loanId] != 0 ⇒ loan settled` —
    locks down LENDING-02's recovery slot semantics
  3/3 invariants × ~10k handler calls each × 13 actions ≈ 130k total
  randomized sequences, 0 reverts post-fix.
- **PoC test**:
  [`contracts/test/PASS7_LENDING_04.t.sol`](contracts/test/PASS7_LENDING_04.t.sol)
  — 7-step deterministic reproduction (open loan → pause → repay defers →
  unpause → first pull → donate → second pull). Pre-fix demonstrated full
  double-claim of a 10k-ether slice; post-fix the second pull reverts
  `NoEscrowRewards` and the donation is untouched.

#### Static analysis

- **Slither v0.11.5** — 603 findings (vs pass-6's 597). 22 High / 155
  Medium, all classes documented as known false-positives in
  [`.audit_101/PASS6_SLITHER_2026_05_03.md`](./.audit_101/PASS6_SLITHER_2026_05_03.md)
  (timestamp PRNG truncation, FoT-pattern reentrancy-balance,
  `nonReentrant`-protected paths Slither's CEI heuristic can't see, strict
  uint equality on counters). Zero net-new actionable findings vs pass-6
  baseline; the LENDING-04 bug is a semantic state-desync that static
  analysis cannot detect — only stateful invariant testing surfaces it.
- **Aderyn** — installation blocked by Windows AppControl on the dev
  workstation; deferred. Slither remains the canonical static-analysis
  surface; the new stateful invariant suite covers what static analysis
  cannot.

### Security — pass-6 fresh-eyes audit (2026-05-03)

Meta-audit informed by 2024-2026 DeFi exploit retrospectives (Curve / Euler /
Conic / KyberSwap Elastic / Onyx / Penpie / Jimbos / Radiant / BonqDAO /
Hundred / Velocore / Atlantis / Munchables / BlueBerry / Pendle / Sturdy /
Inverse / Platypus / Poly Network) re-aimed at the cumulative 388-finding
history of passes 1–5. Surfaced 5 NEW contract HIGHs + 5 NEW contract MEDs +
1 frontend CRIT + 5 frontend HIGHs + 1 frontend LOW — all closed. Master report:
[`.audit_101/PASS6_2026_05_03.md`](./.audit_101/PASS6_2026_05_03.md).

#### Fixed — Contract HIGHs (5)

- **LD-NEW-H1** — `TegridyLending.pullEscrowRewards` no longer drains a NEW
  active loan's per-tokenId rewards via a stale `loanId` on the same tokenId.
  Closed by `staking.ownerOf(loan.tokenId) == address(this)` gate at
  [TegridyLending.sol:1620-1633](contracts/src/TegridyLending.sol#L1620). Commit `722d1f1`.
- **LD-NEW-H1 mirror** — `TegridyRestaking.claimResidualForTokenId` refuses
  to drain `unsettledRewardsByTokenId` while the NFT is escrowed at another
  tracked holder (lending). Returns 0 paid + emits
  `ResidualPullDeferredCrossHolder`. Closed at
  [TegridyRestaking.sol:1163-1195](contracts/src/TegridyRestaking.sol#L1163). Commit `8266289`.
- **LD-NEW-H2** — `TegridyNFTLending` outbound NFT leg
  (`repayLoan` / `claimDefault`) verifies the NFT actually moved
  post-`transferFrom`. Silent no-op malicious collections trigger
  `stuckCollateralRecipient` + `CollateralRedirected` event. New
  `_safeOutboundTransfer` helper at
  [TegridyNFTLending.sol:755-771](contracts/src/TegridyNFTLending.sol#L755);
  call sites at [L620 + L697](contracts/src/TegridyNFTLending.sol#L620). Commit `722d1f1`.
- **TWAP HIGH-2** — `consult()` reverts `PairDisabled` when the factory has
  `disabledPairs[pair] = true`. Closed at
  [TegridyTWAP.sol:472](contracts/src/TegridyTWAP.sol#L472). Commit `722d1f1`.
- **TWAP HIGH-3** — first observation on a new pair is now stamped
  `bypassed = true` so the bootstrap rolls out of any consult lookup window
  before consumers trust it. Closed at
  [TegridyTWAP.sol:309-331](contracts/src/TegridyTWAP.sol#L309). Commit `722d1f1`.
- **SwapFeeRouter HIGH-4** — multi-hop branches in `convertTokenFeesToETH`
  (and the FoT variant) invalidate `lastConversionSnapshot[token]`. Forces
  the next 2-hop call into the bootstrap (owner-only) path. Closed at
  [SwapFeeRouter.sol:1554-1563](contracts/src/SwapFeeRouter.sol#L1554) and
  [SwapFeeRouter.sol:1652-1660](contracts/src/SwapFeeRouter.sol#L1652). Commit `722d1f1`.

#### Fixed — Contract MEDs (5)

- **PASS5-PA-L1** (promoted from pass-5 LOW) — `PremiumAccess.subscribe`
  extension no longer double-counts `consumedEscrow` into `totalRevenue`.
  Closed at [PremiumAccess.sol:309-330](contracts/src/PremiumAccess.sol#L309). Commit `722d1f1`.
- **N-1 GaugeController orphan** — `proposeRemoveGauge` reverts with new
  `error GaugeRemovePending()` when a prior `executeRemoveGaugeNextEpoch`
  left `pendingGaugeRemove != 0`. Closed at
  [GaugeController.sol:201,788](contracts/src/GaugeController.sol#L201). Commit `722d1f1`.
- **F-1 Restaking under-credit** — `_boostedAmountAt` historical lookups for
  `_timestamp < liveLockEnd` now return `cached` directly. Restores honest
  historical accounting in the kick-window without reopening DR-04
  over-credit. Closed at
  [TegridyRestaking.sol:486-512](contracts/src/TegridyRestaking.sol#L486). Commit `722d1f1`.
- **F-2 Restaking attribute-cap** — `executeAttributeStuckRewards` subtracts
  `totalActivePrincipal` AND `totalPendingUnsettled` from the unattributed
  pool, not just `totalUnforwardedBase`. Closed at
  [TegridyRestaking.sol:1389-1408](contracts/src/TegridyRestaking.sol#L1389). Commit `722d1f1`.
- **LD-NEW-M4** — `TegridyLending` TWAP staleness gates add directional
  pre-checks (`latest.timestamp > block.timestamp` → typed `OracleStale`)
  so clock-skewed feeds do not underflow checked-math. Closed at
  [TegridyLending.sol:1245,1256](contracts/src/TegridyLending.sol#L1245). Commit `722d1f1`.
- **MEDIUM-5** — `POLAccumulator.HARVEST_TWAP_DEVIATION_BPS` narrowed
  200 → 50 bps to align with `TWAP_SAFETY_BPS`. Closed at
  [POLAccumulator.sol:131](contracts/src/POLAccumulator.sol#L131). Commit `722d1f1`.

#### Fixed — Frontend (1 CRIT + 5 HIGH + 1 LOW)

- **FE-HIGH-01** — TegridyDropV2 `mint()` ABI corrected from 2-arg to
  3-arg (`mint(uint256 quantity, uint256 allowedAmount, bytes32[] proof)`).
  `useNFTDropV2.mint()` accepts an optional `allowedAmount` (default 0
  preserves PUBLIC-mint callers). Closed in
  [frontend/src/lib/contracts.ts:420-421](frontend/src/lib/contracts.ts#L420)
  and [frontend/src/hooks/useNFTDropV2.ts](frontend/src/hooks/useNFTDropV2.ts). Commit `b1fb6d4`.
- **FE-HIGH-02** — SIWE client sets `expirationTime` (5-min) and `notBefore`
  (30s skew tolerance) so the server's `verifySignature` accepts payloads
  instead of returning HTTP 400. Closed in
  [frontend/src/nakamigos/lib/siweAuth.js:41-60](frontend/src/nakamigos/lib/siweAuth.js#L41). Commit `b1fb6d4`.
- **FE-LOW-04** — `useLPFarming` + `useNFTDropV2`
  `useWaitForTransactionReceipt` pin `chainId: CHAIN_ID`. Commit `b1fb6d4`.
- **FE-CRIT-01** — Seven `vercel.json` aggregator open-proxy rewrites
  (`/api/{odos,cow,lifi,kyber,openocean,paraswap,swapapi}/*`) replaced by
  Vercel serverless wrappers under `frontend/api/{provider}/[...path].js`.
  Shared infra at `frontend/api/_lib/aggregator-proxy.js` enforces seven
  gates: method allowlist, origin allowlist (fail-closed in prod), Upstash
  sliding rate limit (60/min/IP), exact-prefix path allowlist with
  decode-then-check (`%2F..%2F`-safe), 32 KB body cap + 5 MB response cap,
  per-provider query allowlist (no apiKey/cookie/auth forward), response
  cleanup (no Set-Cookie/Authorization echo, opaque 502 on upstream non-2xx).
  53 NEW tests in `frontend/api/__tests__/aggregator-proxy.test.js`; full
  api/ suite green (13 files, 169 tests). Commit `975e5af`.
- **FE-HIGH-03** — SwapAPI quote routed through same-origin `/api/swapapi/*`
  so the third party no longer sees user wallet/IP/referer. Closed in
  [frontend/src/lib/aggregator.ts:86](frontend/src/lib/aggregator.ts#L86). Commit `4b3a47f`.
- **FE-HIGH-04** — DCA hardcoded 5% slippage replaced by per-schedule
  `slippageBps` field bounded to `[10, 300]` bps (0.1%-3%) and defaulted to
  50 bps. UI presets+custom input + storage validator updated. Closed in
  [frontend/src/hooks/useDCA.ts](frontend/src/hooks/useDCA.ts) and
  [frontend/src/components/swap/DCATab.tsx](frontend/src/components/swap/DCATab.tsx). Commit `4b3a47f`.
- **FE-HIGH-05** — Limit-order minOut now derived from on-chain
  `getAmountsOut` re-quote at execute-time:
  `minOut = min(targetDerivedMinOut, onChainOut * (1 - slippage))`. Stale-
  target gate aborts unsatisfiable orders. Default slippage lowered 5% → 1%.
  Closed in
  [frontend/src/hooks/useLimitOrders.ts:284](frontend/src/hooks/useLimitOrders.ts#L284). Commit `4b3a47f`.
- **FE-HIGH-06** — Custom-token decimals/symbol verified via
  `publicClient.readContract` on hydration + add; mismatches evicted with
  toast. `useSwapAllowance` refuses `approve(MAX_UINT256)` for tokens NOT in
  `DEFAULT_TOKENS` (falls back to exact-amount approval). Permanent
  unverified-token banner. Closed in
  [frontend/src/hooks/useSwap.ts](frontend/src/hooks/useSwap.ts),
  [frontend/src/hooks/useSwapAllowance.ts](frontend/src/hooks/useSwapAllowance.ts),
  [frontend/src/pages/TradePage.tsx](frontend/src/pages/TradePage.tsx). Commit `4b3a47f`.

#### Tests

- New regression suite at
  [`contracts/test/Pass6_Regressions.t.sol`](contracts/test/Pass6_Regressions.t.sol)
  — 4 unit-style PoCs covering the 3 NEW HIGHs:
  `test_LD_NEW_H1_oldLoanCannotDrainNewLoanCredits`,
  `test_LD_NEW_H1_mirror_residualClaimantBlockedByLendingEscrow`,
  `test_LD_NEW_H2_silentNoOpRepay_marksStuck`,
  `test_TWAP_HIGH_2_consultRevertsWhenPairDisabled`. Commit `21db70b`.
- New invariant suites at
  [`contracts/test/invariants/Pass6_*.t.sol`](contracts/test/invariants/) — 4 NEW
  files containing 13 stateful-invariant tests locking down the pass-6 fix
  surfaces under randomized adversarial sequences (256 runs × 500 calls each):
  - `Pass6_LendingSolvency.t.sol` — INV-E (3 invariants)
  - `Pass6_DropV2SupplyConservation.t.sol` — INV-G (5 invariants)
  - `Pass6_RestakingResidualCrossProto.t.sol` — INV-H (2 invariants)
  - `Pass6_TWAPFirstObsBypass.t.sol` — INV-I (3 invariants)
  - **1.664M total stateful calls · 0 reverts · ~210s wall clock** · commit `7889f25`.
- 198 affected-scope tests pass for the unit suite.

#### Polish / cleanup (commits `378d70d`, `eed1c65`)

- Deleted two confirmed dead-code helpers — `CommunityGrants._countActiveProposals`
  and `RevenueDistributor._getRestakedAmount` — flagged by the slither pass and
  verified zero-callers via repo-wide `Grep`. Per
  `contracts/src/.slither.deadcode-suppress.md`'s own "delete it, do not suppress"
  guidance.
- Cleaned `slither.config.json` schema — stripped 7 documentary `_*` keys + an
  inert 43-entry `detectors_to_run` array that Slither v0.11.5 rejects as
  "unknown key". Rationale moved verbatim to a new `slither.config.notes.md`
  audit-trail doc. Eliminates "unknown key" warnings on every CI run.
- `AUDITS.md` "Internal AI-agent reviews" count corrected `8 → 10` (pass-5 +
  pass-6); lineage line enumerates the 6 modern passes.
- `FIX_STATUS.md` framing refreshed to acknowledge the 6-pass audit lineage
  and surface the cumulative 405-finding closure count near the top.

#### Deferred

None — every initially-deferred item from `b1fb6d4`'s commit body
(FE-CRIT-01, FE-HIGH-3/4/5/6) landed during the same pass via parallel-agent
commits `975e5af` and `4b3a47f`. Pass-6 closes its scope cleanly.

### 2026-04-26 — Post-remediation audit campaign (3 Crit + 7 High + 5 Med + 2 EIP-170 splits)

#### Summary

A focused multi-pass audit + remediation campaign that discovered the prior
R017/R020/R023/R028 doc-claimed remediations had not actually shipped to
`main`, then closed those gaps plus 4 additional confirmed Mediums plus 2
EIP-170 deployability blockers (TegridyStaking + SwapFeeRouter both exceeded
the 24,576-byte mainnet limit). Reference
[`.audit_101/POST_REMEDIATION_LEDGER.md`](./.audit_101/POST_REMEDIATION_LEDGER.md)
for the full per-finding breakdown.

#### Critical (3)

- **C-1** TegridyDropV2: legacy single-step `setMerkleRoot(bytes32)` replaced
  with timelocked `proposeMerkleRoot` / `executeMerkleRoot(bytes32)` /
  `cancelMerkleRoot` (24h delay, value-bound, phase-gated to CLOSED /
  CANCELLED / paused only). Replaces R023 H-01 doc-claimed-but-unshipped fix.
- **C-2** TegridyStaking: `MAX_POSITIONS_PER_HOLDER` lowered 100 → 50 to halve
  every external integrator's `votingPowerOf` gas cost (ReferralSplitter,
  RevenueDistributor checkpoint-fallback path, governance consumers).
- **C-4** VoteIncentives: zero-vote epoch bribes were permanently locked
  (refundOrphanedBribe required un-snapshotted epoch; claimBribes rejected
  on zero votes). Added `refundUnvotedBribe(epoch, pair, token)` —
  permissionless per-depositor pull, gated by 14-day grace after revealDeadline.
  Replaces R020 H-1.

#### High (7)

- **H-1 / H-1b** TegridyFactory: `setGuardian` was a 1-step setter with no
  validation. Replaced with `proposeGuardianChange` / `executeGuardianChange`
  (48h timelock); legacy `setGuardian` remains for the initial post-deploy
  set only (`guardian == address(0)` gate). Replaces R028 H-01.
- **H-2** TegridyFactory: `emergencyDisablePair` previously cancelled ANY
  pending PAIR_DISABLE_CHANGE proposal — including governance-queued disables.
  Now only cancels pending RE-ENABLE proposals; pending DISABLEs are
  preserved (governance audit trail intact, circuit-breaker still effective).
- **H-5** TegridyFeeHook: `executeSyncAccruedFees` legacy
  `if (actualCredit > old) revert SyncReductionTooLarge()` blocked all
  upward sync corrections, leaving no recovery path for accruedFees drifting
  below true PoolManager balance. Now allows upward sync bounded by
  `IPoolManager.balanceOf(this, currencyId)` (tamper-proof on-chain credit).
- **H-7** TegridyRestaking: `decayExpiredRestaker` reordered per R017 RETRY
  (settle → shrink `totalRestaked` → `_accrueBonus()` → re-anchor). Honest
  restakers no longer underearn during the lock-expiry window. CEI tightened
  (bonusDebt anchored before transfer). Replaces R017 H-3.
- **H-8** TegridyRestaking: per-restaker boost checkpoints via
  `Checkpoints.Trace208`. `boostedAmountAt(_user, _ts)` now returns the
  historical value at `_ts` (via `upperLookup`) instead of the current
  decayed cache. RevenueDistributor restakers no longer silently
  undercompensated post-decay.
- **H-12 / H-12b** VoteIncentives: ERC20 dust deposits (1 wei) could fill
  MAX_BRIBE_TOKENS slots and DoS legitimate bribes. Added
  `DEFAULT_MIN_TOKEN_BRIBE = 1e15` enforced when no per-token min is
  configured. Per-token override via timelocked
  `proposeMinBribeAmount` / `executeMinBribeAmount` (24h delay).
  Replaces R020 H-3.

#### Medium (5)

- **M-2** TegridyTWAP: `DeviationBypassed` event + `lastBypassUsed[pair]`
  mapping surface the rebootstrap-after-dormancy window so consumers (lending,
  POL accumulator, dutch-auction price) can cool-off / require a confirming
  observation.
- **M-16** POLAccumulator: `MIN_BACKSTOP_BPS` raised 5000 → 9000. Caps
  slippage at 10% on the addLiquidityETH leg (was effectively 50%, no
  protection against sandwich attacks).
- **M-24** TegridyStaking: `_splitPenalty` now uses ceiling division so
  sub-wei dust on small early-exit penalties favors stakers (recycle pool)
  rather than treasury.
- **M-28** MemeBountyBoard: `emergencyForceCancel` aggregate-votes branch
  (`totalBountyVotes >= 2x quorum`) now also requires
  `uniqueVoterCount >= MIN_UNIQUE_VOTERS`. Whales alone can no longer
  deadlock bounties.
- **M-30** PremiumAccess: `nonReentrant` added to `batchReconcileExpired`
  for parity with `cancelSubscription`.

#### Architectural fixes (2 EIP-170 splits)

- **TegridyStaking → TegridyStaking + TegridyStakingAdmin**: 29,461 → 22,492
  bytes (saved 6,953; +2,084 margin under EIP-170). All 7 timelocked admin
  triplets moved to the sister contract. Wired via `staking.setStakingAdmin(addr)`.
- **SwapFeeRouter → SwapFeeRouter + SwapFeeRouterAdmin**: 25,930 → 16,735
  bytes (saved 9,195; +7,841 margin). All 9 timelocked admin triplets moved.
  Wired via `router.setSwapFeeRouterAdmin(addr)`.

#### Frontend / indexer integrations

- Restored + extended `frontend/scripts/extract-missing-abis.mjs` to
  generate `TEGRIDY_STAKING_ADMIN_ABI` + `SWAP_FEE_ROUTER_ADMIN_ABI`
  alongside the 8 prior ABIs. Output written to
  `frontend/src/lib/abi-supplement.ts`.
- `frontend/src/lib/constants.ts`: added
  `TEGRIDY_STAKING_ADMIN_ADDRESS` + `SWAP_FEE_ROUTER_ADMIN_ADDRESS`
  placeholders (operators populate post-deploy).
- Indexer subscribes to both admin contracts via shared
  `TimelockAdminMinimalAbi`. ProposalCreated / Executed / Cancelled events
  written to existing `timelockProposal` table with discriminator. Addresses
  sourced from `TEGRIDY_STAKING_ADMIN_ADDRESS` /
  `SWAP_FEE_ROUTER_ADMIN_ADDRESS` env vars.
- `useLPFarming().refreshBoost(target)` action exposed.
  `useAutoRefreshBoost` hook detects boost-not-applied (holdsJBAC && stake &&
  effective < raw * 1.4) and surfaces / auto-fires refresh. Closes F-7.

#### Operator follow-ups

1. Deploy `TegridyStakingAdmin(staking)` + call
   `staking.setStakingAdmin(admin)` (one-shot).
2. Deploy `SwapFeeRouterAdmin(router)` + call
   `router.setSwapFeeRouterAdmin(admin)` (one-shot).
3. Update `frontend/src/lib/constants.ts` admin placeholders with deployed
   addresses.
4. Set indexer env vars `TEGRIDY_STAKING_ADMIN_ADDRESS` +
   `SWAP_FEE_ROUTER_ADMIN_ADDRESS` for production sync.
5. Update `contracts/script/ConfigureFeePolicy.s.sol`
   `SWAP_FEE_ROUTER_ADMIN` constant.

### 2026-04-25 — Wave 1–4 bulletproofing (~80 R-fixes)

#### Summary

Wave 1–4 bulletproofing — ~80 R-fixes; build green; tests pass. Reference
[`.audit_101/MASTER_REPORT.md`](./.audit_101/MASTER_REPORT.md) +
[`.audit_101/DETAILED_REPORT.md`](./.audit_101/DETAILED_REPORT.md) +
[`.audit_101/remediation/REMEDIATION_REPORT.md`](./.audit_101/remediation/REMEDIATION_REPORT.md).
Per-fix change logs at [`.audit_101/remediation/R001.md`](./.audit_101/remediation/R001.md)
through [`R076.md`](./.audit_101/remediation/R076.md).

#### Breaking constructor / behaviour changes (require redeploy)

- **R003** — `TegridyLending` constructor adds `_twap` arg (5→6 args). ETH
  collateral floor now reads `TegridyTWAP.consult()` instead of spot reserves.
- **R015** — `POLAccumulator` constructor adds `_twap` arg (4→5 args) +
  `LPMismatch` factory check that the LP token matches the pair the TWAP watches.
- **R020** — `VoteIncentives` constructor adds `_commitRevealFromGenesis`
  boolean (6→7 args); also adds `refundUnvotedBribe()` (closes Spartan TF-13).
- **R029** — `TegridyNFTLending` no longer auto-whitelists collections at
  construction. Post-deploy must call `proposeWhitelistCollection(addr)` →
  24h timelock → `executeWhitelistCollection(addr)` per collection
  (JBAC / Nakamigos / GNSS).

#### Wave 0 still pending

Per memory `project_wave0_pending.md`: `VoteIncentives` + `V3Features` +
`FeeHook-patch` redeploys plus multisig `acceptOwnership` on 3 contracts
(LP Farming, Gauge Controller, NFT Lending) by Safe
`0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe`. Tracked in
[`docs/WAVE_0_TODO.md`](./docs/WAVE_0_TODO.md) §3.

#### Docs

R008 + R076 + RC3 doc-truth-up sweep across `FAQ.md`, `REVENUE_ANALYSIS.md`,
`SECURITY.md`, `README.md`, `FIX_STATUS.md`, `DEPLOY_RUNBOOK.md`,
`DEPLOY_CHEAT_SHEET.md`, `NEXT_SESSION.md`, `AUDITS.md` — removed fictional
claims (no `burn()` in `Toweli.sol`; no `SWAP_FEE_BPS = 50` constant on
`SwapFeeRouter`; no live Immunefi page; deleted `redeploy-patched-3.sh`),
flagged Wave-0 multisig migration as PENDING.

### 2026-04-19 — Batch 7d: ETH-denominated collateral floor on `TegridyLending`

#### Added

- **`LoanOffer.minPositionETHValue`** — optional ETH floor alongside the
  existing TOWELI floor (addresses audit critique 5.4). `createLoanOffer`
  takes a 5th arg; zero preserves the pre-batch behaviour. `acceptOffer`
  reads `TegridyPair.getReserves()` and reverts `InsufficientCollateralValue`
  when the borrower's position values below the threshold.
- **`ITegridyPair` interface + `pair` / `toweli` immutables** on
  `TegridyLending`. Constructor takes a 4th `_pair` arg; TOWELI orientation
  is resolved at deploy time.
- **`contracts/test/TegridyLending_ETHFloor.t.sol`** — zero-floor no-op,
  floor-met, floor-breached-reverts, same-block sandwich documentation test,
  and a token0/token1 orientation test.
- **`DeployV3Features.s.sol`** — reads `TOWELI_WETH_PAIR` env override for
  the new constructor arg.

#### Notes

- V3Features redeploy is still pending per `docs/WAVE_0_TODO.md`, so the
  breaking ABI change is acceptable and `docs/SECURITY_DEFERRED.md` now
  marks critique 5.4 as partially addressed (spot-reserve risk acknowledged,
  TWAP upgrade still pending).

### 2026-04-19 — Wave 0 status surfaced on /contracts + tracking issue

#### Added

- **Wave 0 status badges** on [`ContractsPage`](frontend/src/pages/ContractsPage.tsx).
  New `redeploy` (orange) and `multisig` (sky-blue) badge types alongside the
  existing `pending` (amber) / `deprecated` (grey) pills, each with a
  one-liner explaining what the user is looking at. A legend block at the
  top of the page mirrors the runbook.
  - **`pending deploy`** — `TegridyLaunchpadV2`. Not yet broadcast; placeholder
    `0x0…0` in `constants.ts`.
  - **`redeploy queued`** — `TegridyFeeHook` (owner stranded on Arachnid
    CREATE2 proxy; constructor patched to accept `_owner`),
    `VoteIncentives` (needs to partner the Wave 0 commit-reveal
    GaugeController), `TegridyLending`, `TegridyLaunchpad (V1)`,
    `TegridyNFTPoolFactory` (V3Features bundle with the H-10 refund-flow
    patch on the TegridyDrop template).
  - **`awaiting multisig`** — `LP Farming`, `Gauge Controller`, `NFT Lending`
    (Wave 0 redeploys live, but the multisig
    `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe` still has to call
    `acceptOwnership()` on each).
- **`TegridyFeeHook`** now surfaced in the DEX group on `/contracts` (was
  previously only linked from MIGRATION_HISTORY). Constant
  `TEGRIDY_FEE_HOOK_ADDRESS` imported explicitly.
- **Wave 0 outstanding-work section** on MIGRATION_HISTORY.md with the same
  four-bucket breakdown (pending, redeploy-queued, multisig-accept, post-
  deploy wiring) so the UI and doc can't drift.
- **`docs/WAVE_0_TODO.md`** — tick-box checklist mirroring the contracts-
  page badges. Written in GitHub-flavoured Markdown so the body pastes
  straight into a tracking issue labelled `await-wave0` without
  reformatting. Referenced from the `/contracts` legend and from
  `WAVE_0_RUNBOOK.md`.

#### Changed

- `ContractEntry` status union extended from `'pending' | 'deprecated'` to
  `'pending' | 'deprecated' | 'redeploy' | 'multisig'`, plus an optional
  `note` rendered under the contract label for the two new states.

#### Fixed

- **Liquidity pool-stats card transparent** ([LiquidityTab.tsx](frontend/src/components/swap/LiquidityTab.tsx)) —
  removed the full-bleed `ArtImg` backdrop and the `rgba(16,185,129,0.05)`
  emerald tint from the "Your share / Rate / Your LP tokens" card. Border
  stays, card fill is now transparent so the page background shows through.
- **Token Lending tab bar** ([LendingSection.tsx `TabNav`](frontend/src/components/nftfinance/LendingSection.tsx)) —
  `Lend / Borrow / My Loans` were rendered as bare text over the mascot
  art, with the active tab using `text-black` that vanished against dark
  backgrounds. Rewrote to match the NFT Lending pattern: solid black
  container (`rgba(0,0,0,0.85)`), `flex-1` buttons, full-pill `var(--color-stan)`
  background on the active tab, white text on both states.
- **NFT Lending tab bar** ([NFTLendingSection.tsx](frontend/src/components/nftfinance/NFTLendingSection.tsx)) —
  container background bumped from `rgba(13,21,48,0.4)` to
  `rgba(0,0,0,0.85)` for the same reason.

### 2026-04-18 — Wave 0 deploys + V2 launchpad build-out

#### Added

- **Wave 0 mainnet redeploys (6 of 8 contracts)**:
  - `TegridyLPFarming` `0xa7EF711Be3662B9557634502032F98944eC69ec1` — C-01 `MAX_BOOST_BPS_CEILING=45000` live.
  - `TegridyNFTLending` `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139` — C-02 1h grace period live.
  - `GaugeController` `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb` — H-2 commit-reveal live on-chain.
  - `TegridyTokenURIReader` `0xfec9aea42ea966c9382eeb03f63a784579841eb2` — points at v2 staking.
  - `TegridyTWAP` `0xddbe4cd58faf4b0b93e4e03a2493327ee3bb4995` — new 30-min oracle.
  - `TegridyFeeHook` `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044` — B7 closed; address ends `0x0044` for V4 `AFTER_SWAP`+`AFTER_SWAP_RETURNS_DELTA` permissions. **Caveat:** initial deploy via Arachnid CREATE2 proxy stranded ownership; constructor patched to accept `_owner` (see Fixed). Redeploy pending.
  - Pending: `VoteIncentives` + `V3Features` (5 contracts) — blocked on deployer ETH top-up.
- **V2 Launchpad contracts (compiled + tested, deploy pending)**:
  - [TegridyDropV2.sol](contracts/src/TegridyDropV2.sol) — ERC-7572 `contractURI()`, single `InitParams` struct for atomic clone-init, `ContractURIUpdated` event, `setContractURI` setter.
  - [TegridyLaunchpadV2.sol](contracts/src/TegridyLaunchpadV2.sol) — click-deploy factory. `createCollection(CollectionConfig)` wires name/symbol/supply/royalty/placeholderURI/contractURI/merkleRoot/dutch-auction/initialPhase in one tx. Preserves legacy `CollectionCreated` event topic + emits `CollectionCreatedV2`.
  - [DeployLaunchpadV2.s.sol](contracts/script/DeployLaunchpadV2.s.sol) + [TegridyLaunchpadV2.t.sol](contracts/test/TegridyLaunchpadV2.t.sol) (11 tests pass).
- **NFT Launchpad creator wizard** under `frontend/src/components/launchpad/wizard/` — 5 steps (Connect → Upload → Preview → Fund+Arweave → Deploy), single-reducer state machine, virtualized preview grid via `@tanstack/react-virtual`, per-token `TraitEditor` modal, responsive `WizardStepper`. 45 Vitest reducer tests.
- **Arweave integration via Irys** — permanent storage, artist pays ETH in one session:
  - [irysClient.ts](frontend/src/lib/irysClient.ts) — `WebUploader(WebEthereum).withProvider(window.ethereum)`.
  - [useIrysUpload.ts](frontend/src/hooks/useIrysUpload.ts) — `quote`, `fund`, `uploadFolder`, `uploadJsonFolder` with progress + retry-friendly errors.
  - [useWizardPersist.ts](frontend/src/hooks/useWizardPersist.ts) — throttled localStorage draft; partial-upload resume (re-funding skipped, completed sub-uploads skipped).
  - [nftMetadata.ts](frontend/src/lib/nftMetadata.ts) — CSV parser (Thirdweb headers, 16-attribute pairs), OpenSea token + contractURI builders, validators (25 Vitest tests).
  - [frontend/public/sample-collection.csv](frontend/public/sample-collection.csv) + "Download template" link in Step 2.
  - npm: `@irys/web-upload`, `@irys/web-upload-ethereum`, `@tanstack/react-virtual`, `papaparse`.
- **V2 detail + admin surfaces**:
  - [useNFTDropV2.ts](frontend/src/hooks/useNFTDropV2.ts) — parallel v1 hook with Arweave `contractURI()` fetch, 8s AbortController timeout, graceful fallback.
  - [CollectionDetailV2.tsx](frontend/src/components/launchpad/CollectionDetailV2.tsx) — banner hero from Arweave JSON, phase indicator, paused banner, mint panel with allowlist proof, owner-only admin.
  - [OwnerAdminPanelV2.tsx](frontend/src/components/launchpad/OwnerAdminPanelV2.tsx) — setContractURI, Dutch auction builder, pause/unpause, ownership transfer.
- **Tabbed pages** (TradePage pattern):
  - [LearnPage.tsx](frontend/src/pages/LearnPage.tsx) — Tokenomics / Lore / Security / FAQ under one route.
  - [ActivityPage.tsx](frontend/src/pages/ActivityPage.tsx) — Points / Gold Card / History / Changelog under one route.
- **V2 wagmi hooks** — [wagmi.config.ts](frontend/wagmi.config.ts) includes `TegridyLaunchpadV2` + `TegridyDropV2`. `TEGRIDY_LAUNCHPAD_V2_ABI` + `TEGRIDY_DROP_V2_ABI` exported. `TEGRIDY_LAUNCHPAD_V2_ADDRESS` placeholder until broadcast; frontend gates reads on `isDeployed()` so no reads fire at zero address.
- **Docs**: [LAUNCHPAD_GUIDE.md](docs/LAUNCHPAD_GUIDE.md) (creator walkthrough), [LAUNCHPAD_V2_ARCHITECTURE.md](docs/LAUNCHPAD_V2_ARCHITECTURE.md) (dev reference), [LAUNCHPAD_V2_NOTES.md](docs/LAUNCHPAD_V2_NOTES.md) (post-deploy flip checklist).

#### Changed

- **Nav IA**: Top nav "Lending" → "NFT Finance". "More" dropdown pruned to Gallery / Tokenomics / Changelog (Points, Gold Card, History, FAQ, Lore, Security still URL-reachable via their tabbed host pages).
- **Top bar theme**: Black in dark mode (default), orange in light mode. Artwork covers full viewport behind the bar.
- **Collateral filter pills** in NFT Lending Borrow tab — resized to aspect-square cards with name + symbol labels, matching the Lend-tab selector.
- **LaunchpadSection** — lists v1 + v2 collections from both factories, `V1`/`V2` chips, detail routing by version tag.
- **Tabbed page hosts** — top padding bumped to `pt-32` on TokenomicsPage, SecurityPage, FAQPage, LeaderboardPage, PremiumPage, HistoryPage, ChangelogPage so content headings clear the sticky tab bar.
- **CONTRACTS.md / README.md / MIGRATION_HISTORY.md** — Wave 0 addresses updated with deprecated→canonical pairs and FeeHook ownership caveat.
- **indexer/ponder.config.ts** — `LPFarming` address swapped to Wave 0 redeploy.

#### Fixed

- **TegridyFeeHook constructor** now accepts `address _owner` instead of `msg.sender` from `OwnableNoRenounce`. Prevents CREATE2-proxy deploys from stranding ownership on the Arachnid factory (which was the failure mode of the 2026-04-18 broadcast at `0xB6cfeaCf…0044`). Tests + 3 audit-t files updated.
- **DeployTegridyFeeHook.s.sol** — rewritten to consume pre-computed `CREATE2_SALT` mined off-chain via `cast create2 --ends-with 0044`, bypassing the in-EVM miner's `MemoryOOG` at ~180k iterations. Runs in milliseconds; includes `require(hook.owner() == hookOwner)` post-deploy check.
- **LaunchpadSection `CARD_BG` undefined** — referenced in two JSX blocks but never declared; crashed the Launchpad tab. Added `const CARD_BG = 'rgba(6, 12, 26, 0.80)'`.

### Added
- **Commit-reveal voting at the contract layer** ([GaugeController.sol](contracts/src/GaugeController.sol)) —
  `commitVote`, `revealVote`, `computeCommitment`, `isRevealWindowOpen` with
  24h reveal window. Hash binds voter + tokenId + gauges + weights + salt +
  epoch; only the committer can reveal; NFT transfer forfeits vote. 14 new
  tests in [GaugeCommitReveal.t.sol](contracts/test/GaugeCommitReveal.t.sol).
  Closes audit H-2.
- **Commit-reveal UI** in [GaugeVoting.tsx](frontend/src/components/GaugeVoting.tsx)
  with mode toggle, localStorage salt persistence, pending-reveal banner,
  missing-salt warning.
- **Drop refund UI** on [CollectionDetail.tsx](frontend/src/components/launchpad/CollectionDetail.tsx)
  when sale is cancelled. Red banner + Claim Refund button bound to
  `paidByUser > 0`. Closes H10.
- **TegridyTWAP third-oracle leg** in [useToweliPrice](frontend/src/hooks/useToweliPrice.ts) —
  30-minute TWAP cross-checks pair-reserve spot price; divergence beyond 2%
  flips to TWAP (manipulation-resistant). `twapOverrideActive` signal exposed
  to consumers.
- **GitHub surface:** LICENSE (MIT), NOTICE.md (third-party attributions +
  South Park fair-use statement), HALL_OF_FAME.md, .gitattributes, .nvmrc,
  FUNDING.yml, dependabot.yml, CodeQL workflow, Slither workflow, contracts-ci
  workflow, release workflow.
- **Docs:** MIGRATION_HISTORY.md (canonical vs deprecated addresses),
  DEPRECATED_CONTRACTS.md (orphans: TegridyFarm, FeeDistributor, WithdrawalFee),
  TOKEN_DEPLOY.md (how TOWELI was deployed + CREATE2 vanity notes),
  GOVERNANCE.md (admin-key threat model + multisig roadmap), DEVELOPING.md,
  DEPLOYMENT.md, API.md, SOCIAL_PREVIEW_SPEC.md (tracked).
- **Toweli.sol source** ([contracts/src/Toweli.sol](contracts/src/Toweli.sol)) +
  reference [DeployToweli.s.sol](contracts/script/DeployToweli.s.sol). Closes
  the biggest audit-trail gap: the live token at `0x420698…78F9D` now has a
  verifiable source in-repo.
- **ConnectPrompt** primitive for wallet-gated empty states on Farm / Lending /
  Trade / Governance surfaces.
- **YieldCalculator** — wallet-less estimator on HomePage so first-time
  visitors see expected yield before committing.
- **Icon primitive** under `components/ui/Icon.tsx` with locked stroke-width.
- **copy.ts** — centralises every character-named string (Randy / Towelie /
  DEA / Cartman) so a rebrand is a single-file diff.
- **Social preview banner** at [docs/banner.svg](docs/banner.svg) +
  `frontend/public/og.svg`; README renders it as hero.
- **README badges:** CI / CodeQL / Slither / License / Solidity / Chain.
- **Scripts:** `redeploy-patched-3.sh`, `diff-addresses.ts`,
  `extract-missing-abis.mjs`.
- **ABI supplement** ([frontend/src/lib/abi-supplement.ts](frontend/src/lib/abi-supplement.ts)) —
  8 missing contracts extracted from forge artifacts.
- **txErrors helper** with viem `UserRejectedRequestError` handling +
  `shortMessage` extraction.
- **Vercel security headers:** HSTS → 2y + preload, X-Permitted-Cross-Domain-
  Policies, Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy,
  extended Permissions-Policy opt-out.

### Changed
- **Nav IA:** top nav cut from 21 routes to 5 primary (Dashboard / Farm /
  Trade / Lending / Governance); mobile mirrors desktop; Footer organised
  into Product / Resources / Community / Legal columns.
- **Meme voice shipped across product** via copy.ts: receipt labels
  ("LOCKED DOWN, WITH TEGRIDY", "HARVEST COMPLETE", "TEGRIDY REGISTERED"),
  lock durations ("The Taste Test" → "Till Death Do Us Farm"), penalty
  reframe ("DEA Raid Tax — for the kids' college fund"),
  [VoteIncentives](frontend/src/components/community/VoteIncentivesSection.tsx)
  section → "Cartman's Market — Totally Not Bribes", FAQ opener rewritten.
- **Nav link contrast** fixed: `#d4a843` (2.8:1, fails WCAG AA) →
  `#f5e4b8` (13.5:1, AAA). Light mode → `#4c1d95` (10.4:1, AAA).
- **Mobile tables → cards** below 480px on BoostScheduleTable and
  ContractsPage with 44×44 tap targets.
- **TransactionReceipt** labels re-sourced from [copy.ts](frontend/src/lib/copy.ts).
- **HomePage audit badge** with link to `/security`.
- **iPhone 14 Pro safe-area:** new `.pb-safe` utility using
  `env(safe-area-inset-bottom)`.
- **isPending guards** on AMMSection (3 buttons); NFTLendingSection already
  had them.
- **useToweliPrice** silent `.catch(() => {})` replaced with scoped
  `console.warn` (ignoring expected AbortError).
- **README rewritten** as an investor-grade reference with elevator pitch,
  TOC, user flow, dev flow, honest audit status.
- **FAQ boost claim** corrected from stale "2.5×" to accurate "0.4×–4.0× +
  0.5× JBAC = 4.5× ceiling".
- **Manifest icon** fixed: broken `skeleton.jpg` refs replaced with existing
  `/splash/icon-192.png` + `/splash/icon-512.png` (added `any maskable`).
- **Sitemap.xml** gets `lastmod` + `changefreq` on every URL; `/contracts`
  and `/treasury` added.
- **usePageTitle** extended with canonical `<link>`, `og:url`, `twitter:url`,
  `twitter:title`, `twitter:description`, and per-page `og:image` override
  (backward-compatible signature).
- **TegridyDrop ABI fix:** `currentPhase` → `mintPhase` (contract-canonical;
  the prior entry reverted on-chain). Added `cancelSale`, `refund`,
  `paidPerWallet`.
- **Indexer TegridyStaking address** fixed from stale v1 `0x65D8…a421` to
  canonical v2 `0x6266…4819` in [ponder.config.ts](indexer/ponder.config.ts).
- **Frontend package.json + indexer/package.json:** added `"license": "MIT"`
  and `"engines": { "node": ">=20.0.0" }`.
- **OwnerAdminPanel Danger Zone** — `cancelSale()` wired with
  `window.confirm` double-prompt.

### Fixed
- Stale contract addresses in 4 deploy scripts (Gap A sed — `0x65D8…` →
  `0x6266…`).
- `TegridyLPFarming.exit()` added — frontend's existing `useLPFarming.exit()`
  call no longer reverts.
- `TegridyNFTLending` added `GRACE_PERIOD = 1 hours` to `repayLoan` +
  `claimDefault`.
- `TegridyDrop`: added `MintPhase.CANCELLED`, `cancelSale()`, `refund()`,
  `paidPerWallet` tracking, `SaleCancelledEvent` + `Refunded` events.
- `ConstantsPage` navigation link routes corrected to SPA `<Link>`.
- `HistoryPage`: fetch cap raised 50 → 500, added 25-per-page pagination,
  resets on wallet change.
- `SecurityPage`: removed the inflated "5C/13H/26M/38L — all resolved"
  block; replaced with honest links to audit files.
- `ChangelogPage`: softened "Fixed all v4 audit findings" claim.
- `useLPFarming`: chain-id guard + proactive allowance check.
- `useSwapQuote`: `useChainId` wired so quotes don't fire on non-mainnet.
- Supabase migration 002: creates `native_orders`, `trade_offers`,
  `push_subscriptions` (tables were referenced but never created).

### Deferred
- **Indexer expansion** (GaugeController events, bounty submissions/votes,
  grants cancel/lapse/refund, restaking tombstone fix) — blocked by
  pre-existing Ponder `Virtual.Registry` TypeScript inference ceiling.
  Comment-form scaffolding retained for future re-enable. Consumers query
  contract state directly via wagmi until then.
- **Full nonce-based CSP** — requires Vite plugin tooling to inject nonces
  per inline script. Deferred in favour of additional security headers that
  don't break the build.
- **OG banner PNG export** — SVG ships now for modern social crawlers;
  PNG conversion for legacy compatibility is a follow-up.

### Removed
- `contracts/src/LPFarming.sol`, `DeployLPFarming.s.sol`, `LPFarming.t.sol`
  (superseded by `TegridyLPFarming`).
- `frontend/src/assets/{hero.png, react.svg, vite.svg}` (Vite starter
  cruft).
- `frontend/src/components/PageTransition.tsx` (unimported).

## [v3.0.0-pre] - 2026-04-17

Scope: fee split + NFT lending grace + drop refund + Gap-A sed sweep + Gap-B
LP farming selection + H-2 commit-reveal voting + Upstash rate limiting.

### Added
- Commit-reveal voting implementation (H-2) in contracts (a2cdcad).
- Real per-IP API rate limiting via Upstash Redis (API-M1) (dd1cf22).
- `DeployTegridyLPFarming` script for C-01 fixed farm (batch 23) (2e0eeae).
- `DeployTokenURIReader` folded into Gap A sed sweep (4f323fe).
- Paste-ready deploy cheat sheet (batch 22) (9c1d713).
- Pre-deploy runbook for audit remediation (batch 17) (414f489).
- TradePage E2E spec and overlay dismiss fixture (batch 16) (25014a0).
- E2E wallet-integrated test foundation (C-05) (d4967ad).
- H-2 commit-reveal design spike and API/indexer audit docs (895bd86).

### Changed
- Gap B locked to B2 — `TegridyLPFarming` selected as canonical farm (fca56a6).
- Gap A locked to A1 — `TokenURIReader` folded into the sed sweep (4f323fe).
- `framer-motion` refactored to `LazyMotion` across 45 files for bundle size
  reduction (batch 19) (a1f6afe).
- `ParticleBackground` and `GlitchTransition` lazy-loaded (batch 15) (3741cf2).
- Lending safety caps moved to timelocked state (TF-06 + H-05) (c0be03d).
- NFT Finance tab added to mobile nav; dashboard outstanding loans surfaced
  (9e8d667).

### Deprecated
- Legacy `LPFarming.sol` deprecated in favor of `TegridyLPFarming.sol`
  (Gap B decision, fca56a6).

### Removed
- `LPFarming.sol`, `DeployLPFarming.s.sol`, `LPFarming.t.sol` removed during
  Gap B consolidation (working tree).
- Inner `Suspense` that broke CSS preload on Nakamigos page (85eda15).
- `modulePreload` polyfill disabled to fix CSS preload crash (1c2ad9d).

### Fixed
- API batch 18: M2 filter regex + M8 SameSite cookie tightening (adcf5d4).
- Indexer batch 14: INDEXER-H1/M1/M2 fixes (3f2dac1).
- API batch 13: six API fixes from `API_INDEXER_AUDIT.md` (4859a4d).
- Frontend batch 12: E2E foundation runs (2 baseline + 1 new-spec) (a200130).
- Frontend batch 10: Spartan TF-03 claim-before-withdraw + contrast sweep
  (45a353d).
- Contracts batch 9: lending safety caps timelocked (TF-06 + H-05) (c0be03d).
- Contracts batch 8: five Spartan MEDIUM/LOW quick-win fixes (6e818e9).
- Contracts batch 7: six HIGH/MEDIUM fixes across Restaking, Factory, Lending,
  Routers (c782293).
- Contracts batch 6: cleared all 16 pre-existing test failures, 1 real bug
  fix (6ed299a).
- Contracts batch 5: lending transfer-gate whitelist (H-01), drop hardening
  (H-10/H-11) (3a6c198).
- Frontend batch 4: Privacy Policy accuracy (C-03) + SecurityPage audit
  links (2cf5135).
- Frontend batch 3: modal aria, tooltip keyboard, mint re-entry, targeted
  contrast (e30df41).
- Contracts batch 2: `TegridyLPFarming` ABI mismatch (C-01), `createOffer`
  guard (ab16308).
- Frontend batch 1: chain-aware explorer, validation, a11y, focus trap
  (434a4ab).
- Step-circle centering and dashboard outstanding loans fixed (9e8d667).
- Nakamigos CSS preload crash: CSS import moved to main bundle (714d839).
- `CommunityPage` crash: missing `Suspense` import (ed93506).
- Browser QA: Suspense tag, loader cleanup, text visibility (ae690eb).
- Seven broken lazy imports from deleted pages — `TradePage` swap UI
  rebuilt (bc9cc6b).

### Security
- All security audit findings cleared: C-01, H-01, H-02, M-01–M-04, L-01
  (2f06f84).
- `TegridyRestaking` and `ReferralSplitter` wired up (eab6e4b).
- 100-agent security scan remediation (1493904).
- `GaugeController` deployed to mainnet at
  `0xb6E4CFCb83D846af159b9c653240426841AEB414` (f217b13).
- Immunefi bounty program added alongside Vitest and deploy scripts (d0ac056).

## [v2.x] - earlier

### Added
- Major UX overhaul, security hardening, new contracts, and full audit fixes
  (3d8799b).
- Full NFT Lending UI with 3-tab interface (d578069).
- `NFTLending` + TWAP deployed; audit M-02 WETH fallback on `acceptOffer`
  fixed (629721a).
- Dark/light mode, 138 frontend tests, mobile responsive fixes (fefa250).
- Gauge voting, CSV export, Immunefi bounty, Vitest, deploy scripts (d0ac056).
- Art backgrounds on NFT Finance intro cards (ed0da44).
- Ten strategic recommendations for conversion optimization (5fdcdd4).

### Changed
- Restake combined into Token Lending tab (0f33c02).
- Marketplace splash renamed from Nakamigos to Tradermigos (7fc4bd5).
- Full audit remediation: 17 issues fixed, CI/CD added, wagmi codegen, new
  community UI (8cd9234).

### Fixed
- NFT Lending mobile responsiveness (050e27b).
- Mobile grid layouts collapse to single column on small screens (5f18a96).
- All v4 audit findings: C-02, C-03, C-04, H-01, H-03, M-01, M-04 (4b4d5d3).

[v3.0.0-pre]: https://github.com/fomotsar-commits/tegriddy-farms/tree/main
[v2.x]: https://github.com/fomotsar-commits/tegriddy-farms/commits/main
