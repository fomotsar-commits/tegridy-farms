# The Island Build-Out — master plan, all 13 bungalows, the whole 9 yards

**Written 2026-08-30 against trunk `da8f05d4`, by the 5D-architect pass the operator asked for:
"every single bungalow still needs building with their respective chain and staking pools…
what we did for TOWELI and are still doing for BAYLA."** Identification ran first (two
exhaustive sweeps over trunk + the unmerged `claude/bungalow-buildout`); every claim below
carries a file:line or an on-chain address. Companion docs this plan builds on, does not
replace: `JUNGLE_BAY_ISLAND_PLAN.md` (the island's shape), `BAYLA_BUNGALOW.md` (the
lighthouse record), `BAYLA_PARITY_2026_08_28.md` (the parity sweep),
`BAYLA_LIQUID_LIGHTHOUSE_DESIGN.md` (the gated wrapper), `ISLAND_ROSTER_DOSSIER.md`
(community warmth), `CONSOLIDATION_2026_08_28.md` (branch state).

---

## 0. The one fact that makes this plan tractable

**Almost every BAYLA surface is already generic and registry-driven.** The hero, farm
panel, lighthouse module, dashboard, market strip + candlestick chart, trade tape,
distribution card, gallery wing, onboarding, doors, picker, footer card, heat — all of them
self-gate on registry fields (`live`, `identity`, `artPool`, `market`, `stakePool`,
`address`) and light up with **zero component changes** the moment those fields are set
(`BAYLA_PARITY_2026_08_28.md:136-138`; verified per-surface in the parity checklist).

So "build every bungalow" decomposes into exactly four kinds of work:

| Kind | What it is | Who |
|---|---|---|
| **RAILS** | Things built once and reused 12× — most exist; two must be built (EVM lighthouse, Base-chain plumbing) | Claude |
| **CEREMONIES** | On-chain acts per token: staking pools, funding, (later) own-venue LP pools | OPERATOR (Claude preps everything) |
| **DATA** | Registry fills per bungalow: market pool, identity copy, community links, decimals, unfurl entries | Claude drafts, OPERATOR approves voice |
| **ART** | 15–30 pieces + a blessing per community — **never fabricated**, the standing rule | COMMUNITY + OPERATOR outreach |

House rules that bind every work order below: backgrounds-not-buttons, additive-only,
minimal surface, honest surfaces (a zero is a zero, an outage is an outage, nothing
advertises what it cannot pay), and **Rule 0**: only battle-tested billion-dollar upstreams
for new contracts, forks pinned with written diffs (`docs/TODO_OPERATOR.md:337-356`,
enforced by `contracts/provenance/`).

---

## 1. State of the island (identified 2026-08-30)

### 1a. The 13 rows, compressed

| # | Bungalow | Chain | Warmth (dossier 08-25) | Has today | Missing for BAYLA parity |
|---|---|---|---|---|---|
| 1 | **TOWELI** | Ethereum | venue token | The full native venue (its own staking contract, LP farming, real-ETH yield, seasons) | N/A — TOWELI *is* the default skin. Own health items in WO-7 |
| 2 | **BAYLA** | Solana | $578k MC, the living demo | ~Everything: art ×24, identity, lighthouse pool `EFWpSpH9…EZ9f` (5× ladder, 1d 21.9% → 365d 109.5% APR), market strip/chart/tape/distribution, studio, doors/unfurl/sitemap | Vault funding (pays a real 0% today) · keyed `SOLANA_RPC_URL` · env footgun check (§WO-8) |
| 3 | PEPE | Ethereum | **$1.59B MC** — biggest by far | Door route + greyed picker card only; door renders the TOWELI home | Everything: data, identity, art, EVM lighthouse |
| 4 | QR | Base | $217k | same | Everything + Base rails |
| 5 | MFER | Base | $693k | same | Everything + Base rails |
| 6 | BNKR | Base | $26M, active bot community | same | Everything + Base rails |
| 7 | **DRB** | Base | $13.1M, **$1.24M/day vol — most alive after PEPE**; its boxing-ring art is already in the classic set | same | Everything + Base rails — **warmest EVM door** |
| 8 | **BOBO** | Solana | $7.2M, island status "SETTLED · hammers up" — **the only one the island calls actively building** | same | Everything — but the Solana staking rail is DONE, so it's data + ceremony + art |
| 9 | JBM | Base | no indexed pair | same | Everything; **no market pool exists — chart/tape stay honestly absent** |
| 10 | SOY | Solana | $17k | same | Everything (Solana rail ready) |
| 11 | BRAINLET | Solana | $38k | same | Everything (Solana rail ready) |
| 12 | RIZZ | Base | no indexed pair | same | Everything; no market pool — same honest absence as JBM |
| 13 | nb1 | — | QUIET by design | Door + card | **Nothing. Stays quiet on purpose.** |

What a settled door renders **today** on trunk: the plain TOWELI homepage under whatever
skin is persisted — not one string about the token (`BungalowDoor.tsx:32-35`). The fix
(per-token door landings) is already built on the unmerged `claude/bungalow-buildout`
branch — reconciling it is WO-0.

### 1b. The BAYLA parity definition ("the whole 9 yards", measurable)

A bungalow is DONE when all of these hold (each is a checkable surface):

1. **Door** at `/<slug>` renders token-first content (landing pre-art; full skin post-art),
   with its own social unfurl (`render-bungalow-doors.mjs` entry) and sitemap line.
2. **Identity** — hero/muse/onboarding copy in the registry; TOWELI surfaces muted.
3. **Art** — 15–30 community pieces at `/public/art/<id>/`, `live: true`, picker card lit,
   gallery wing, studio route, per-surface overrides tuned, a11y pin flipped to clean.
4. **Market** — `market: {network, pool, label}` set where a real pool exists → strip +
   candlestick chart + trade tape light up (GeckoTerminal, registry-driven). Where no
   indexed pool exists (JBM, RIZZ): honestly absent, never faked.
5. **Distribution** — holders card runs the venue's own scanner on the right chain.
6. **Trade route** — in-venue where the rail exists (`/solana?out=` today; EVM in-venue is
   WO-9), honest external chart link otherwise.
7. **Staking** — a lighthouse pool on the bungalow's own chain, funded-last with the full
   honesty guardrail set (rate-paying-now vs configured, runway, no-early-exit warning
   before the wallet, shortest-lock default, dry-vault exit semantics stated).
8. **Heat** — already universal.
9. **Verification** — harness run for its skin, e2e door test, unit pins for its registry
   row, built-bundle check.

---

## 2. The rails ledger

### 2a. BUILT — reuse as-is (do not rebuild; the fastest way to lose a week is re-solving these)

| Rail | Where | Note |
|---|---|---|
| Doors + alias + anti-reload guards | `BungalowDoor.tsx`, `App.tsx:331-341` | |
| Unfurl pipeline (fail-loud postbuild) | `scripts/render-bungalow-doors.mjs` + lock-step test | Entries are per-bungalow data |
| Picker / TopNav chip / Footer card / nav trade-route | `BungalowPicker.tsx`, `TopNav.tsx:174-195`, `Footer.tsx:123-173`, `navConfig.ts:106-124` | |
| Identity gating across home/farm/dashboard/gallery/layout | `getBungalowIdentity()` consumers | |
| **Solana lighthouse** — UI + adapter + ladder math + 9 honesty guardrails | `LighthousePoolLive.tsx`, `bungalowStaking.ts` | Weight/rate math pinned against the SDK itself |
| **Ceremony script** — `--mint`-parametrized, 7-day ceiling default, `--accept-long-lock` gate, ladder printed before signing | `scripts/bayla-lighthouse-ceremony.mjs:238-257` | Decimals hardcoded at 4 sites — WO-1 |
| **Market strip + chart + tape + distribution** — registry `market` field, chain-generic GeckoTerminal | `BungalowMarket/Trades/Holders.tsx`, `usePoolMarket/Trades.ts`, `lib/chart/market.ts` | EVM works via `network: 'eth'\|'base'` — near-free |
| Per-bungalow art studio | `BungalowArtStudioPage.tsx` — generic over `bungalowId` | One route line per bungalow |
| Art overrides store + shared surface inventory | `bungalowArtOverrides.ts`, `artSurfaces.ts` | |
| Heat | `HeatCard.tsx` + proxy | ETH/Base/Solana wallets |
| Scanner (Ethereum + Solana on trunk; **Base leg on #341**) | `lib/scanner/*`, `api/_lib/scannerApi.js` | |
| Deploy rails: per-chain config scripts, deterministic 4-role Safes, verify scripts, CI slice/size/selector gates | `script/base/*`, `script/safes/DeployRoleSafes.s.sol`, `contracts-ci.yml` | |
| On the unmerged #341: door landings, DOORS ×10, Base scanner, community links, dry-vault ceremony mode, exit-safety gating, curve trust strip/chart | `claude/bungalow-buildout` | WO-0 lands them |

### 2b. BUILD ONCE (Claude) — the two real engineering items

**R-1 · The EVM Lighthouse (stake X, earn X — Ethereum + Base).** No contract in the repo
does this (verified: `TegridyStaking` is TOWELI-shaped and 22 B under EIP-170;
`TegridyLPFarming` explicitly reverts on `rewardToken == stakingToken`;
`TegridyBoostedLPStaker` is V4-NFT-bound). Per Rule 0: **vendor Synthetix
`StakingRewards` verbatim** — the canonical, multi-billion-dollar, unhacked answer to
exactly this shape. Its semantics are *better* than Streamflow's for exits: `withdraw()`
moves only principal and never touches rewards, so **principal is never hostage to the
reward vault** (the 6012 class cannot exist). Full instructions in WO-2.

**R-2 · Base-chain plumbing.** Three pieces: (a) the Base scanner leg (already built on
#341 — WO-0 lands it); (b) `EFvmLighthouse` UI over R-1 via wagmi (new component, mirrors
`LighthousePoolLive`'s guardrails); (c) an EVM bungalow dashboard variant (trunk's panel is
Solana-only: `SolanaProviders` + `getParsedTokenAccountsByOwner`). WO-2 §UI.

### 2c. GATED — designed, deliberately not built until their triggers fire

| Design | Gate (all must hold) | Where |
|---|---|---|
| **Liquid-lighthouse wrapper** (transferable receipt over Streamflow) | locks materially >7d wanted · staked TVL >~$500k · users asking · buffer capital exists — **none hold** (TVL ≈ $0.53) | `BAYLA_LIQUID_LIGHTHOUSE_DESIGN.md` §7 — revisit at ~$100k staked |
| **Own Solana LP venue pools** (`/pools`, cp-swap fork) | 6-step operator ceremony: fresh program keypair + `declare_id!` · `admin::ID` = signable funded system account (NOT the Squads account — that bricked 08-08) · `create_pool_fee_reveiver` = WSOL **token account** · deploy · `create_amm_config` · publish `VITE_SOLANA_CPSWAP_PROGRAM` | `SOLANA_LP_VENUE_2026_08_29.md` §3. After it: any bungalow token can get an own-venue pool permissionlessly; router + page light up with no code change |
| In-venue EVM trade for foreign tokens on Base | per-chain aggregator `matchPath` entries + a spender/executor map refactor in `swapRouting.ts`/`useSwap` | WO-9; Ethereum-mainnet arbitrary-ERC20 trade already ≈ works via `TokenSelectModal` import |

---

## 3. Work orders

Owner tags: **[C]** Claude session · **[O]** OPERATOR (keys/money/policy) · **[CO]** Claude
preps + operator signs/approves · **[COMM]** community.

### WO-0 · Reconcile `claude/bungalow-buildout` (#341) — the gate for everything else [C]

Trunk moved 65 commits; 21 of #341's 43 files overlap; the repo's own consolidation doc
calls it "two divergent implementations of the same bungalow surface — pick one." The full
file-by-file verdict map lives in the 2026-08-30 identification (this plan's companion
session record). The short law: **trunk's rebuilt files are the base; #341 contributes only
its still-novel deltas.** Rebase in this order:

1. **Base scanner block first** (PR-only files, zero conflicts) — it unblocks every
   `&chain=base` scan link that five other files reference.
2. **DOORS ×10 unfurls + harness/e2e/test updates** (PR-only) — unblocks the 10 sitemap lines.
3. `bungalows.ts` — keep trunk's `market` field + pool repin + `bungalowArtContext`; layer
   on #341's `community` + `decimals` fields, `kind: 'swap'|'chart'` trade routes with the
   host-anchored `isDexscreenerUrl` (the CodeQL fix), `bungalowScanRoute()`.
4. `bungalowStaking.ts` — take trunk's weight/rate/preset API wholesale; add ONLY the three
   honesty fixes trunk lacks: **6012 mapping**, **post-broadcast-timeout "outcome unknown"
   guard**, **account-not-found ≠ outage**. Ship exactly one runway helper (port the
   materially-empty predicate onto trunk's `vaultRunwaySecs`).
5. `LighthousePoolLive.tsx` — start from trunk's 605-line rebuild; port in the four things
   it lacks: **stake pause while the vault is materially empty** (the devnet-proven
   exit-safety gate), the dust-proof materiality predicate, the **entries-outage guard**
   (a failed read must not render as "you have nothing staked"), the **same-mint vault
   filter**. This file is why the rebase exists.
6. Everything else per the map — adopting trunk's `isSolanaSwapLive` name and its
   "ecosystem reserve" / "internally reviewed" vocabulary (do NOT re-introduce "survival
   reserve" or any audit claim), renumbering our doc section to §6h, renaming the studio
   surface labels to `ID1/ID2`.
7. **Drop entirely** (trunk shipped better versions): the door reload-loop mechanism, the
   farm-panel swap-fee copy, the dashboard copy+decimals hunks, sitemap `/solana-launch`
   removal, `maxWeightRaw`.

Acceptance: full unit suite + tsc + doors/a11y e2e + `verify-bungalows.mjs` 37/37 + built-
bundle chunk check, then merge #341. Also rebase **`prep/island-wave-five`** (the homepage
arrival inversion, 25 files — only the CSP line in `index.html`/`vercel.json` genuinely
conflicts with the avantgarde audit; both edits are wanted).

### WO-1 · The generalization pass — kill every BAYLA-hardcode [C]

Each of these is small; together they make the next 11 bungalows pure data:

1. **Decimals**: registry `decimals` field lands in WO-0; generalize the ceremony script's
   4 hardcoded sites (`:123,145,267,371` — `calculateRewardAmountFromRate(rate, 6, 6)`,
   `*1e6` in `fund()`) behind a `--decimals` flag that defaults by reading the mint.
2. **Muse per bungalow**: move the 5 rotating lines + byline + accent from `MuseBubble.tsx`
   hardcode into `identity` (optional `museLines[]`), key dismissal per bungalow
   (`tegridy-muse-<id>-dismissed`), and add the new key pattern to
   `EVICTION_PROTECTED_KEYS` handling (protect by prefix or enumerate).
3. **Lore/community card**: `HomePage.tsx:527-564` renders BAYLA lore for ANY identity
   bungalow — drive the three links + copy from the registry (`community` + a `lore` field)
   so PEPE's home never speaks BAYLA.
4. **Funding-routes copy**: the pump.fun bullet gates on `address.endsWith('pump')`
   (#341 has this — lands in WO-0).
5. **Trade-tape explorer link**: `BungalowTrades.tsx:85` hardcodes `solscan.io/tx/` —
   switch on `market.network` (solscan / etherscan / basescan).
6. **Holders card Base fix**: `BungalowHolders.tsx:32` maps every non-Solana chain to
   `'ethereum'` — after WO-0's Base scanner, pass `'base'` through.
7. **Verify harness**: parametrize `verify-bungalows.mjs` over `{id, symbol, artDir}`
   (today: 10+ literal `bayla` assertions) so each art drop gets the same 33-assertion
   sweep. Keep the bayla run as the reference invocation.
8. **Studio routes**: replace the literal `/bayla-studio` route with `/:id-studio` or one
   route line per live bungalow (dev-only, R002 tree-shake gate stays).
9. **Sitemap**: add a lock-step test like the DOORS one (every live+identity door must have
   a sitemap line) — today the file is hand-maintained with no pin.
10. **Env-key generality**: `VITE_BAYLA_STAKE_POOL` is BAYLA-named; new pools use
    per-bungalow keys only if needed — prefer hardcoded registry constants (the env
    override is the proven footgun, see WO-8.1).
11. **Stale prose sweep**: `LighthousePoolLive.tsx:47-51` + `bungalowStaking.ts:80-83`
    still describe the retired flat pool; `TODO_OPERATOR.md:107-118` decision 1 was
    resolved on-chain by the repin — mark it.

### WO-2 · The EVM Lighthouse rail (Ethereum + Base) [C code, O deploys]

The one new contract this plan needs. **Vendor, don't write** (Rule 0):

1. **Vendor** Synthetix `StakingRewards.sol` (the canonical single-asset staker) into
   `contracts/src/vendor/synthetix-staking-rewards/`, sha256-pinned in
   `contracts/provenance/upstream.lock.json`, expected-diff generated, a `PROVENANCE.md`
   entry naming every divergence with rationale + pinning test — **snapshot + entry in the
   same commit** (the provenance gate's law). Target diff: ideally zero beyond pragma/import
   paths; if the OZ-version bridge forces edits, each line gets named.
   *Why it fits*: stake X earn X; funded-last via `notifyRewardAmount` (periodFinish
   model = an on-chain runway, displayable exactly like the Solana one);
   `withdraw()` is principal-only so **exits can never be reward-hostage**; owner sets
   only `rewardsDistribution`/duration — no fund-touching admin.
2. **Ownership**: deploy per token per chain with `owner = the chain's MULTISIG role Safe`
   (deterministic Safe addresses already live on Base; mainnet uses the existing Safes),
   `rewardsDistribution = Fee-Remittance Safe`. No EOA owners — the factory-guardian lesson.
3. **Deploy scripts**: follow `DeployBaseLPFarming.s.sol`'s shape exactly — `_loadConfig`
   from env, `_validate` mechanical truths (code exists at token, `decimals()` read and
   recorded, token ≠ reward sanity is N/A here since same-token is the point),
   `_assertDeployInvariants`, economics stay operator env vars. One script, chain-gated
   like `BaseChainConfig` (`CHAIN_ID` refusal), reused for mainnet + Base.
4. **CI wiring** (all mandatory, all cheap): test file claimed by exactly one slice in
   `.github/contracts-test-slices.json`; size budget is automatic (StakingRewards is tiny);
   selector + ABI-supplement guards; Slither/CodeQL run on any Solidity diff. Tests:
   mutation-checked stake/withdraw/getReward/notify cycles + a
   "withdraw succeeds with an EMPTY reward balance" pin (the anti-6012 property, stated as
   a test so it can never regress silently).
5. **Frontend**: `EvmLighthousePoolLive.tsx` (wagmi; lazy chunk like the Solana one) with
   the SAME guardrail set: paying-now vs configured (`rewardRate × 365d`, zero after
   `periodFinish`), runway = `periodFinish - now` (on-chain, exact — nicer than Solana's),
   vault-materiality stake gate NOT needed (exits are safe) but the "earns nothing until
   funded" banner stays, no-lock disclosure (StakingRewards has no locks — say so; locks
   are the Solana pool's property, not this one's). Registry: reuse the same `stakePool`
   field + `chain` to pick the module; farm panel branches by chain.
6. **EVM bungalow dashboard**: a wagmi variant of the standing card (balance via
   `balanceOf`, USD via the existing GeckoTerminal market read, lighthouse position via
   `balanceOf`/`earned`) — mirrors `BungalowDashboardPanel`'s honesty rules.
7. **Funding ceremony** [O]: per pool — transfer reward tokens to the contract, then
   `notifyRewardAmount(amount)` from the distribution Safe; the script prints the implied
   rate + runway before signing, same discipline as the Solana ladder print.

### WO-3 · Solana pool ceremonies — BOBO, SOY, BRAINLET [CO]

The rail is proven three times over. Per token:

1. [C] Verify the mint first (decimals, token program, extensions — the BAYLA method:
   `getAccountInfo` jsonParsed; record it in the registry comment). BOBO is a pump-suffix
   mint like BAYLA; SOY/BRAINLET are not — funding-route copy follows automatically.
2. [C] Dry-run: `node scripts/bayla-lighthouse-ceremony.mjs --mint <MINT> --rate <r>
   --max-weight 5 --max-days 365 --accept-long-lock --decimals <d>` — prints the exact
   ladder; sanity: every rung strictly above the one below (the repin lesson: **maxWeight
   is immutable — no update instruction; a wrong ladder means a NEW pool at a new nonce**).
   Default posture unless the operator chooses otherwise: same shape as BAYLA's replacement
   pool (1–365d, 5× ramp); rate sized so a fundable first top-up covers ≥30 days of burn.
3. [O] Broadcast with `--keypair` + `--broadcast`; paste the printed pool address into the
   registry (hardcoded constant, NOT an env var); [C] wire `stakePool` + tests + repin docs.
4. [CO] Devnet-style expectations for the mainnet live-fire: **a 6012 on claim/unstake
   before funding is the program working as proven** — fund a sliver first if the round
   trip must fully complete.
5. [O] FUND LAST, publicly; the panel's vault number climbs per top-up. Reward sources per
   token: community top-ups always; pump.fun creator-fee share only where the community
   controls it (BOBO); the venue swap-fee tithe stays a candidate until the policy decision
   (`TODO_OPERATOR` item) is made.

### WO-4 · The registry data pass — all 10 settled rows [C drafts, O approves]

1. **Market pools**: read GeckoTerminal/Dexscreener best-pair per token (dossier method;
   numbers move — re-read at fill time): PEPE/QR/MFER/BNKR/DRB/BOBO/SOY/BRAINLET get
   `market: {network: 'eth'|'base'|'solana', pool, label}`. JBM + RIZZ had **no indexed
   pair** — leave `market` unset; the strip/chart/tape self-hide, which is the honest state.
2. **Identity copy** per token: venue-voiced, no partnership claims, no market numbers in
   copy, chain-true (the BAYLA hero is the template; the plaque lines come from the
   island's own canon). Operator reads for voice before `live: true`.
3. **Community links**: 7 already drafted on #341 (pepe.vip, qrcoin.fun, bankr.bot, DRB
   bio.site, bobothebear.io, soyjak.life, @brainletbadger); MFER/JBM/RIZZ pending real
   homes — never guess.
4. **Unfurl entries** ×10 exist on #341 with classic-art og images; upgrade each og image
   when its art drop lands.
5. **Decimals** recorded per mint from chain (WO-3 step 1 for Solana; `decimals()` for EVM).

### WO-5 · The art pipeline — per community [COMM + O, C executes]

Unchanged recipe (`JUNGLE_BAY_ISLAND_PLAN.md` §2), now with the studio:
15–30 pieces → `/public/art/<id>/<id>-01.jpg…` → registry pool + `live: true` → picker
card lights → `/​<id>-studio` route line → tune per-surface overrides (drag/zoom focal
points) → unfurl og image upgrade → gallery wing credits → a11y pin flip to `[]` (measured,
not assumed) → parametrized harness run (desktop + iPhone + iPad) → e2e door test add.
**Outreach order is community warmth, not tech** (dossier): DRB and BOBO first — DRB's
boxing-ring canon is already in the classic set; BOBO is the island's own "hammers up"
resident. PEPE is the flagship ask but the coldest door; approach with the living demo
(`/bayla`) + their landing already live.

### WO-6 · Per-bungalow work orders (the assembly sequence per row)

For each settled bungalow, in order — every step's rail exists by the time it's reached:

**Phase A — the door becomes a destination** (after WO-0; zero per-token code):
landing live (plaque/contract/trade-or-chart/heat/community/scan with the right chain) ·
market field if a pool exists · unfurl + sitemap. *Exit criteria: a community mod clicking
their door sees their token, their numbers, their links — nothing TOWELI, nothing BAYLA.*

**Phase B — the lighthouse** (after WO-2 for EVM rows / WO-3 for Solana rows):
pool ceremony → registry pin → funded-last → live-fire → announce. *Exit criteria: staking
live with every honesty guardrail; runway visible; zero paid-now states labeled.*

**Phase C — the skin** (after WO-5 per community):
art drop → `live: true` → identity speaks → full venue re-skin → studio tuning → harness.
*Exit criteria: the §1b checklist all-green for that row.*

Per-row notes:
- **DRB** (Base): Phase A immediately; B needs WO-2; strongest candidate for the first
  EVM lighthouse deploy (most alive community = fundable vault). Chart: has a live pool.
- **BOBO** (Solana): the warmest door overall — Phase A + B can complete on existing rails
  the same week; target it as **the second full bungalow after BAYLA**.
- **BNKR / MFER / QR** (Base): Phase A now; B batches with DRB's deploy script run.
- **SOY / BRAINLET** (Solana): Phase A now; B is a cheap ceremony each; small communities —
  size rates so tiny vaults still show ≥30d runway.
- **PEPE** (Ethereum): Phase A now; B on mainnet StakingRewards (same script, mainnet
  config); the whale door — don't gate the island's momentum on it.
- **JBM / RIZZ** (Base): Phase A minus market (honest absence); B optional until a real
  pool exists; lead with the skin (dossier's own advice).
- **nb1**: stays quiet. The plan's only permanent ✗ row.

### WO-7 · TOWELI's own row — venue health the island depends on [O-heavy]

1. **Staking over-mint mitigation deadline**: keep the reward pool funded ahead of emission
   (top-up or cut `rewardRate`) **before ~2026-10-11** — the pinned `_KNOWN_DEFECT` turns
   real if the reserve depletes. The durable fix (Synthetix funded-period rebase on a live
   contract) is its own migration project.
2. Emissions runway (~Sept 30) — the same decision, earlier horizon.
3. Fee rail: wire `recoverCallerCredit()` **before** deepening the native pool (standing).
4. `/pools` LP-venue ceremony (§2c) — unlocks own-venue pools for every Solana bungalow.
5. Give TOWELI itself a `market` entry when a Dexscreener-indexed pool exists again.

### WO-8 · Finish BAYLA (she is the demo everything sells on) [O + C]

1. **The env footgun, first**: `VITE_BAYLA_STAKE_POOL` **overrides** the repinned constant
   (`bungalows.ts:128-131`). If Vercel still carries the OLD pool `4WCpdeQ2…GXPp`, prod is
   silently staking into the retired flat pool. Check → delete the var (registry constant
   is the truth) → redeploy.
2. **Fund the vault** (decision: one-click permissionless `fundPool` — the script's
   `fund()` exists; re-add the doc command pointed at the NEW reward pool
   `3ysyH5py…DruF`, disclose Streamflow's funding fee by reconciling vault delta vs sent
   on the first mainnet top-up). Until funded the lighthouse honestly pays 0%.
3. **Keyed `SOLANA_RPC_URL`** server-side → the distribution card's success path.
4. The old pool's 1,000 BAYLA dust stake stays locked to ~2027-08-29 — recorded, not
   recoverable; never fund the OLD reward vault.
5. Announce only after 1–3.

### WO-9 · The awesome layer (after the island stands) [C, some O]

Ranked continuation of the 5D competitive reviews, all additive:
island **map picker v3** (the geography from the plan §5 — grid stays as reduced-motion
path) · **passport** (visited/entered client-side + gallery unlocks) · **per-bungalow
leaderboards + event skins** once >2 live (Phase 4) · homepage **arrival inversion** rebase
(`prep/island-wave-five`) · curve token page inline holder read · "top of the curve"
discovery sort · creator dashboard ("my launches + fees") · nav promotion of the curve out
of the More menu [O taste] · in-venue **Base** trade (the swapRouting chain pass, §2c) ·
own-venue LP pools per bungalow once the cp-swap ceremony lands · curve **v2 parity pair**
(creator-fee multi-wallet split + ownership transfer — pump.fun's headline; free while
launchCount is 0 everywhere, priced in redeploy + re-audit).

---

## 4. Sequencing — six waves, dependency-true

| Wave | Contents | Depends on | Ships |
|---|---|---|---|
| **W0** | WO-0 reconcile + merge #341 · WO-8.1 env footgun check | — | Landings for all 10 doors, Base scan, exit-safety gates |
| **W1** | WO-1 generalization pass · WO-4 data pass (market/identity drafts) · WO-8.2-3 fund BAYLA + RPC key | W0 | Every door a real destination with live numbers; BAYLA pays real yield |
| **W2** | WO-3 Solana ceremonies (BOBO first, then SOY, BRAINLET) · BOBO Phase A polish | W1 | Second + third + fourth lighthouses on the proven rail |
| **W3** | WO-2 EVM lighthouse rail (vendor → tests → Base deploy for DRB, then BNKR/MFER/QR batch; mainnet deploy for PEPE) | W0 (provenance rails), operator Safes (live) | Staking on all three chains |
| **W4** | WO-5 art drops as communities deliver (DRB, BOBO first per warmth) → Phase C flips | outreach [O/COMM] | Full skins; the island visibly alive |
| **W5** | WO-9 awesome layer + WO-7.4 LP-venue ceremony → own-venue pools | any | Category-of-one polish |

The Sept-30 lens: **W0+W1 are this week's work and make every door courtable; W2 needs
only ceremonies; the named-human path (one warm community re-homed) is BOBO or DRB, and
both have complete Phase A+B paths that don't wait on art.**

---

## 5. The traps ledger (every one was hit for real — carry them)

1. **Streamflow has NO early exit at any price**; claim+unstake revert 6012 while accrued >
   vault (devnet-proven); backlog survives funding. Guardrails must never be removed.
2. **`maxWeight` is immutable** — a wrong ladder = a new pool at a new nonce (repin cost).
3. **Env overrides beat registry constants** — the WO-8.1 footgun; prefer hardcoded pins.
4. Dossier/GT **numbers move** — re-read at fill time, never quote stale externally.
5. GeckoTerminal tape coverage varies by network; a thin tape is thin, not broken.
6. `getTokenLargestAccounts` rate-limits keylessly — distribution reads stay on-demand.
7. Vercel Hobby: **12-function cap** (at 11) — new API surface = branches, never files.
8. **EIP-170**: TegridyStaking is 22 B under — never grow it; new contracts auto-checked.
9. Provenance gate: snapshot update + PROVENANCE.md entry **in the same commit**.
10. Art is **community-supplied only**; backgrounds-not-buttons; additive always.
11. OneDrive: build in AppData scratchpad worktrees; junctions removed with `cmd /c rmdir`.
12. The webkit e2e projects can't launch on this machine — chromium+mobile locally, CI
    covers webkit.
13. A settled door pointing at a dexscreener page is a **Chart**, never "Trade".
14. Copy vocabulary is pinned: "ecosystem reserve (not enforced on-chain)",
    "internally reviewed" — never "survival reserve", never "audited".
15. Merged-to-trunk ≠ live: date prod from rendered lazy chunks; built-bundle check after
    any import-graph change.

## 6. Done means done

The island is BUILT when: 12 token rows pass the §1b checklist (nb1 quiet), every
lighthouse shows funded runway ≥ its stated horizon, the harness matrix (12 bungalows × 3
devices) is green, every door unfurls as itself, and a stranger can walk
picker → door → trade → stake → heat on any bungalow without meeting another token's name.
