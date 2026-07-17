# Tegridy Launch — Strategy v2.1 (2026-07-17, post-red-team, V4-maximal)

> Status: v2.1 — v2 revised after a 42-agent adversarial red-team (6 lenses, 35
> critical/high findings adjudicated; v1's gauge-featuring centerpiece CUT — §8
> register), then upgraded per owner directive to maximize Uniswap V4 leverage
> end-to-end (§2.0). Evidence base: ~280 research agents across 5 verified
> workflows; memory `project_2026_07_16_launcher_research`. Nothing deploys
> before the core-loop go-live + Safe re-homing gates — and the TOWELI-liveness
> gate (§6).

## 0. Verdict base

- Mechanism design does not win launcher markets; order flow does. (Flaunch
  $134/30d, Heaven $0/30d — best-in-class mechanics, zero retention.)
- Buyback/burn sinks failed 3× at scale. Fee recycling = real yield to
  stakers + POL only.
- Solana = pump.fun at ~95–97% of fees. EVM mainnet curated lane: **contested
  evidence** — Fjord may still be operating (red-team finding); Coinbase/Echo/
  Kraken-Legion own the reputation-gated pipeline. Treat the lane as unproven
  demand, not free whitespace.
- Licensing: Doppler = integrate-only (BUSL, empty grants ENS; self-host fallback
  unavailable until ≥2028). Clanker = unlicensed. Flaunch = MIT pattern donor.
  Doppler-Solana = devnet-only.
- Winner-take-most; modal outcome ≈ $0. Phase 1 must be near-zero custom code and
  cheap enough that the modal outcome doesn't hurt.
- **Red-team addition:** token-weighted anything is meaningless while TOWELI sits
  at ~$33k mcap / ~0 staking participation — ballot control costs less than one
  KOL wave. No mechanism may rely on TOWELI voting power before the liveness
  gate (§6) is met.

## 1. Positioning — "The Verifiable Launch Rail (with an Afterlife)"

Neutral **rail + verification tooling**, explicitly NOT a curator-endorser:

> **Every launch is machine-verifiable. Every fee split is published. Every
> graduated token has somewhere to live.**

- We do not pick winners, endorse launches, or sell featured slots. We publish
  machine-checked facts and let buyers verify. (Legal: automated neutral tooling
  posture, not statutory-seller curation — red-team §8-L.)
- **Ethereum mainnet = flagship rail.** Doppler-integrator launches with
  disclosure attestations and post-graduation integration.
- **Solana = deferred satellite** (user-directed, sequenced behind EVM signal —
  red-team priced the standalone lane negative-EV; it ships as Phase 1b only
  once the EVM rail shows a pulse).

## 2. Differentiation stack (v2.1, red-team-surviving, V4-maximal)

### 2.0 The V4-native pipeline — the strategic frame ("V4 summer and winter")
On Ethereum mainnet, no one offers a **fully V4-native launch-to-economy
pipeline**. Doppler launches V4-native but graduates into whatever; Flaunch is
V4 and dead; Clanker is V4 and Base-only. Tegridy's already-built stack closes
the loop on the chain where V4's deepest volume lives (~$190B cumulative):

```
LAUNCH        Doppler V4 hook (Dutch-auction dynamic curve)      [theirs, audited]
   ↓
GRADUATE      Canonical V4 pool via stock UniswapV4Migrator      [theirs, audited]
              + StreamableFeesLocker beneficiaries (creator/
              attention/Tegridy splits, LP locked)
   ↓
FARM          TegridyBoostedLPStaker per pool — V4 PositionManager
              NFT escrow, veTOWELI-boosted Synthetix rewards      [OURS — built, tested]
   ↓
UPGRADE (P2)  TegridyV4Hook pools: OZ LiquidityPenaltyHook JIT
              guard (verbatim), bounded dynamic fees, afterSwap
              POL skim → staker/treasury/POL split                [OURS — built, tested]
              + BidWall floor (Flaunch MIT, forked verbatim)      [MIT, fork]
              + custom Doppler migrator → graduate directly into
                hooked pools (Whetstone whitelist; fallback holds)
```

Key unlock (verified in source): `TegridyBoostedLPStaker` binds one immutable
`allowedPoolId` per instance and escrows PositionManager NFTs — **it works with
ANY V4 pool, canonical or hooked**. So V4-native afterlife farming needs no
Whetstone approval, no custom hook on the pool, and no new mechanism: one
audited-bytecode staker instance deployed per graduated launch. Licensing is
clean throughout: hooks compose against the canonical PoolManager (zero
exposure), v4-core itself flips BUSL→MIT 2027-06-15, OZ uniswap-hooks is MIT.

The V4 stack (hook + admin + trusted router + staker, ~1.2k LoC, 98 tests green)
is already a **hard relaunch blocker pending external audit** — the launcher
rides the SAME audit. One audit cycle covers the TOWELI pool and every flagship
launch pool: maximum leverage per audit dollar.

### 2.1 The Launch Afterlife — the defensible centerpiece ⭐
Every other launcher graduates tokens into **nothing** — pump.fun, Doppler,
Clanker launches have no day 2. Tegridy is the only launcher attached to a full,
deployed, audited DeFi suite — and per §2.0, the afterlife is V4-native. A
graduated Tegridy launch can (per existing, per-feature-audited processes, never
automatically):

- get a **boosted V4 LP-farming program** on its graduated pool — a
  `TegridyBoostedLPStaker` instance (position-NFT escrow, veTOWELI boost
  0.4×–4.5×): live day 1 on canonical pools, no dependency on anyone;
- apply for a **gauge** → TOWELI-emission flow via the live GaugeController
  (standard timelocked `proposeAddGauge`, pair-bound to its real pool — the
  machinery's designed purpose, not a featuring hack);
- **Phase 2:** move under `TegridyV4Hook` — JIT-sniping protection for its LPs,
  bounded dynamic fees, and the POL skim that routes a slice of its swap flow
  to TOWELI stakers/POL (the launcher's fee engine and the protocol's are the
  same audited contract);
- plug into the NFT/lending stack where applicable (own risk process);
- inherit the TWAP-oracle + POL infrastructure.

This is the pitch to a creator choosing between Doppler frontends: *Zora gives
you a feed post; Tegridy gives your token a V4-native economy.* It reuses the
entire existing stack, requires no new mechanism, and cannot be copied by a
launcher that doesn't own a DeFi protocol. Honest caveats: each integration is
opt-in, per-feature-gated, and rate-limited by our own review capacity; the
veTOWELI boost only means anything after the liveness gate (§6) — at launch,
staker instances run unboosted-baseline rewards funded by the launch's own fee
stream, not TOWELI emissions.

### 2.2 Launch Fact Sheets (EAS disclosure attestations — NOT certificates)
Renamed and demoted from v1's "certificates" (red-team: a certificate is a
signed endorsement and a liability). A Fact Sheet is a **machine-generated
disclosure**: token-template hash, residual creator powers enumerated in plain
language, LP-lock terms, full unlock/vesting schedule, constitutional fee split.
Generated by open-source automated checks — no human judgment attested, nothing
scored, no "safe" label anywhere. Featuring/promotion status never appears in it.

### 2.3 Automated two-tier gate — code, not opinion
- **Tier L (launchable):** automated checks only — audited template, no
  mint/tax/blacklist/upgrade, LP lock ≥ floor, vesting on-chain. Machine-
  enforced, criteria public, no human approval step (kills the 20–40 hr/week
  editorial burden, the bus-factor single-point-of-death, and the curator-
  liability posture in one move).
- **Tier F (flagship-listed):** structurally-rug-impossible configuration
  (renounced/timelocked-only admin, locked LP ≥ 12 mo, 100% of team allocation
  under on-chain vesting) — required for placement on our flagship surface and
  for the Afterlife fast-track. Still automated; still not an endorsement.
- Off-template/off-chain rugs (post-cliff dumps, abandonment) are **disclosed
  market risks**, tracked on the public outcomes dashboard (§2.5), never
  "prevented" claims.

### 2.4 Constitutional fees
Split fixed at launch, published in the Fact Sheet. Draft (EVM): creator 60 /
attention-beneficiaries 15 / Tegridy 20 (½ stakers, ½ POL) / Doppler ~5.
Honest caveats attached (red-team): Doppler's protocol cut is theirs to define
within their cap, and "constitutional" binds *us*, not the market — it is an
honesty artifact, not a moat.

### 2.5 Outcomes dashboard — the data asset
Public, permanent, per-launch outcome tracking: price/liquidity/holder
trajectory, unlock events honored vs dumped, team activity. Nobody in the
category keeps honest post-launch statistics. Cheap to build (indexer),
compounds into the only credibility claim that survives adversarial scrutiny:
*we publish what happened, including our failures.* Also the honest replacement
for v1's suicidal "zero rugs" promise.

### 2.6 Attention fee-splits (config, not contracts)
Doppler `StreamableFeesLocker` beneficiaries set at launch — creator-directed
perpetual splits to KOLs/communities. Kept from v1 (it's pure config). The
Bags-style *protocol-run* bribe market is CUT (§8-A/B).

### 2.7 Phase-2+ (traction- and audit-gated)
- **BidWall** (Flaunch MIT) on our V4 hook for flagship graduated pools.
- **Hooked graduation pools**: custom Doppler migrator → graduate directly into
  `TegridyV4Hook` pools (JIT guard + POL skim + dynamic fees from block 1;
  Whetstone whitelist required; fallback = canonical V4 + locker beneficiaries
  + staker instance — the dependency is priced, accepted-with-mitigation, §8-M).
- **Anti-snipe fee decay on graduated pools**: v1 = admin-stepped fee schedule
  through the existing timelocked bounded-fee setter (zero new code, operator
  cadence); a time-decaying `_getFee` extension (Clanker-style 80%→5%/30s
  params) only if audit budget allows — it is new hot-path code and is treated
  as such.
- **V4 TWAP for launched tokens**: the migration plan's OZ oracle-hook adapter
  path extends to flagship pools — launched tokens gain an on-chain TWAP their
  own integrations (and ours) can consume.
- **Token-voted featuring** — resurrectable ONLY behind hard activation floors:
  ≥$1–2M locked veTOWELI AND >100 distinct independent lockers, routed through
  GaugeController (never snapshot), per-owner influence caps, guardian
  de-feature kill-switch, "Promoted — paid placement" labeling. Until those
  floors exist, any flagship-surface ordering is deterministic and published
  (recency, on-chain metrics), with zero paid or voted placement.
- World ID allocations, rug-insurance: research items only.

## 3. Product tiers

| Tier | Chain | Engine | Notes |
|---|---|---|---|
| Flagship | Mainnet | Doppler dynamic (Dutch auction) | Tier-F config required; Fact Sheet; Afterlife fast-track |
| Community | Mainnet | Doppler static/multicurve | Tier-L; Fact Sheet |
| Solana (Phase 1b, deferred) | Solana | Meteora DBC config | Ships only after EVM signal; Jup-Studio-grade config; separate sub-brand to firewall the flagship (§8-G) |

## 4. Distribution (evidence-ranked, post-red-team)

1. **Own-community pipeline**: first cohort from CommunityGrants/MemeBountyBoard
   communities; the launcher ships as a feature of the existing app surface, not
   a standalone destination (Flaunch's corpse says destinations die).
2. **The Afterlife as the creator pitch** (§2.1) — the only non-copyable reason
   to launch through our frontend rather than any other Doppler integrator.
3. **Fact Sheets + outcomes data as an API** — free, attributed, embeddable by
   bots/screeners/terminals. Acknowledged thin moat (§8-N: disintermediable),
   priced as marketing, not product.
4. Cheap listing surface: DexScreener Enhanced per flagship launch; Jupiter
   auto-routing on Solana (DBC) when Phase 1b ships.
5. Explicitly NOT: paid KOL waves; protocol-run bribe markets; "trust us"
   branding (evidence: trust positioning pulls zero flow — differentiation must
   be verifiable utility).

## 5. Execution (all gates in §6 must pass first)

- **Sprint 1:** Doppler SDK spike (mainnet fork); verify Doppler ETH-mainnet
  module completeness + fee-config bounds on-chain; Fact-Sheet schema + automated
  Tier-L/F checkers (open-source repo); fee constitution finalized; legal review
  of rail posture + geoblock scope (real counsel, not pump.fun mimicry — §8-L).
- **Sprint 2–3:** Launch wizard (reuse LaunchpadV2 wizard UX); EAS wiring;
  integrator fees → RevenueDistributor; outcomes-dashboard indexer v0;
  deterministic flagship-surface ordering (published rules); per-pool
  BoostedLPStaker deploy runbook (instance parameters, reward funding from the
  launch's own locker fee stream).
- **Sprint 4:** First curated-cohort launches (3–5, grants/bounty communities);
  Afterlife pathway docs + first gauge application dry-run + first staker
  instance live on a graduated pool.
- **V4 audit alignment:** the external V4-stack audit (already a relaunch
  blocker) is scoped to ALSO cover launcher usage: multi-instance
  BoostedLPStaker deployment, hooked-pool graduation path, BidWall fork. One
  audit, both products.
- **Phase 1b (Solana):** DBC config + Squads vault + wizard — only after EVM
  signal (≥N real launches; definition set at Sprint 1).
- **Phase 2:** BidWall fork + audit; custom migrator proposal; featuring floors
  review.

## 6. Gates, metrics, kill criteria

**Launch gates (all required):** core-loop go-live ✅→ Safe re-homing ✅→
**TOWELI liveness** (non-zero organic daily volume + staking participation
floor — exact numbers set with the go-live plan; a launcher on a dead protocol
advertises the emptiness).

**North star:** fee revenue reaching stakers/POL.

**Kill criteria (recalibrated per red-team §8-J):**
- Brand-critical incident = a rug executed through a power our automated gate
  failed to detect or our Fact Sheet failed to disclose. That halts new launches
  pending a published post-mortem.
- Disclosed-risk outcomes (post-cliff dumps, abandonment) = tracked and
  published, not incidents.
- <10 real launches or negligible volume at +6 months → freeze Phase 1b/2;
  rail stays up (marginal cost ≈ 0).

## 7. Key & authority inventory (red-team §8-K)

| Authority | Holder | Blast radius | Mitigation |
|---|---|---|---|
| Doppler integrator address | Tegridy multisig | Fee stream redirect | Multisig only, no hot key |
| EAS attester key | Automated signer behind multisig-rotatable key | False Fact Sheets | Open-source checker, revocable attestations, key rotation drill |
| Squads feeClaimer (Solana, 1b) | Squads v4 vault | 100% of Solana revenue | Vault from day one; no EOA ever |
| Gauge/farming admin (Afterlife) | Existing timelocked owners | Emission misallocation | Existing 48h timelocks; per-feature review |

No new standing authorities beyond these; anything requiring a new privileged
role is out of scope for Phase 1.

## 8. Red-team disposition register (42 agents, 2026-07-17)

| # | Finding (lens) | Disposition |
|---|---|---|
| A | Featuring ballot capturable for ~$3–5k; Mochi/Curve precedent (gauge-capture, CRIT) | **CUT** v1 §2.1; token voting gated behind §2.7 floors |
| B | Bribes select spend over quality; pay-to-win wearing curation badge (gauge-capture, HIGH) | **CUT**; any future promotion labeled paid, never in Fact Sheet |
| C | One featured rug = self-declared brand death (gauge-capture, CRIT) | **FIXED**: two-tier gate + endorsement decoupling + §6 recalibration |
| D | Bribe flywheel unbuildable on deployed VoteIncentives (snapshot voters unpayable) (mechanism, CRIT) | **CONFIRMED-CUT**: v1 claim was wrong; no custom governance code will be written for it |
| E | GaugeController is an emission machine, not an attention allocator (mechanism, HIGH) | **ACCEPTED**: gauges only used for their designed purpose (Afterlife §2.1) |
| F | Certificates = signed endorsement liability + safety theater (gate/mechanism, CRIT/HIGH) | **FIXED**: renamed Fact Sheets, disclosure-only, automated, revocable |
| G | Solana-lane rug contaminates flagship brand (gate, HIGH) | **FIXED**: sub-brand firewall + Phase 1b deferral |
| H | Gate certifies hygiene; rugs happen off-template (gate, CRIT) | **FIXED**: disclosure posture + outcomes dashboard; no prevention claims |
| I | Hand-curation = platform-as-issuer exposure; pseudonymity fails under subpoena (gate/ops-legal, CRIT) | **FIXED**: automated gate, neutral-rail posture, counsel review in Sprint 1 |
| J | "Zero rugs" = guaranteed-eventual-death criterion (gate, HIGH) | **FIXED**: §6 recalibration |
| K | Key/authority sprawl on team with unfinished custody backlog (ops-legal, HIGH) | **FIXED**: §7 inventory; no new standing authorities |
| L | UK-only geoblock while US-adjacent + curated = incoherent (ops-legal, HIGH) | **FIXED**: real legal review gate in Sprint 1 |
| M | Doppler dependency: whitelist veto, BUSL, pivot/acquisition risk (mechanism, HIGH) | **ACCEPTED-WITH-MITIGATION**: canonical-V4 fallback path; BUSL→GPL ≤2027-12-31 as long-stop |
| N | Integrator SDK disintermediable; certificates copyable in a week (competitive, HIGH) | **ACCEPTED**: priced as marketing; moat claim moved to Afterlife |
| O | Mid-tail TGE pipeline captured by Coinbase/Echo/Legion; Fjord may not be dead (evidence, CRIT) | **ACCEPTED**: lane treated as unproven; §0 amended; modal-outcome budgeting retained |
| P | Two-sided marketplace with zero demand side before core loop lives (evidence, CRIT) | **FIXED**: TOWELI-liveness gate added to §6 |
| Q | Operator self-dealing loop (team curates + holds veTOWELI + collects fees) (ops-legal, HIGH) | **FIXED**: no protocol-run ballot; deterministic ordering; team wallets excluded from any future featuring vote |

Medium/low findings (11) tracked in the red-team archive
(`tasks/wlk90o6wm.output`, session 5785a4e1); notable: flash-stake capture of any
future snapshot vote (moot — snapshot voting cut), per-launch review cost (moot —
automated gate), Solana standalone negative-EV (addressed via Phase 1b deferral).
