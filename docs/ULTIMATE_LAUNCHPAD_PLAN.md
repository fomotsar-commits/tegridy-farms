# The ultimate launchpad — every rail graduates to us, every launch gets a war chest, nobody needs to know what a blockchain is

**Written 2026-08-22, from the owner directive of the same day.** Everything below is
grounded in verified mechanics (on-chain reads, SDK dist, verified contract sources) — the
research citations live in the session that produced this; the load-bearing ones are
restated inline. Three workstreams, in dependency order.

---

## 1. Every launcher graduates to us — STATUS: code-complete on all three EVM chains

The venue is the one the repo already chose and tested: **Shape A — canonical Uniswap V4
pools carrying `TegridyV4Hook`**, minted into by `TegridyLiquidityMigrator`
(`GRADUATION_VENUE_DECISION.md` + its 4663 addendum). Every graduated LP lands in a pool
whose fee economics we declared, which is exactly the "those LPs boost TVL" ask.

| Chain | Graduation stack script | Substrate | Whitelist ask |
|---|---|---|---|
| Ethereum | `script/DeployV4.s.sol` (pre-existing) | canonical V4 | main petition (drafted, unsent) |
| Base | `script/base/DeployBaseGraduationStack.s.sol` **(new)** | verified: PM `0x4985…2b2b` ⇄ posm `0x7C5f…9bDc` | multichain rider |
| Robinhood | `script/robinhood/DeployRobinhoodGraduationStack.s.sol` | verified: PM `0x8366…0951` ⇄ posm `0x58da…4fA7` | multichain rider |

All three Airlocks are owned by the **same 3-of-6 Whetstone Safe** — one petition
conversation (`WHETSTONE_MIGRATOR_PETITION.md` + the multichain rider) covers everything.
Honesty note that gates expectations: **no third-party module has ever been whitelisted on
any Airlock**; the realistic outcome may be Whetstone blessing/co-owning the module, which
also satisfies the directive. Until whitelists land, launches graduate through stock
modules and the venue probe reports that truthfully.

The NFT launchpad (LaunchpadV2 drops) has no graduation concept — its contribution to TVL
is mint proceeds; it is covered by workstream 3. Solana is a restart decision, out of scope
here.

## 2. The 5% ecosystem reserve — DESIGNED + facade implemented (dark), custody is the open decision

**"Reserve 5% off of each launch"** resolves to: **5% of token supply, factory-locked at
create time**, via a DopplerERC20V1 pre-mint vesting allocation to a protocol-controlled
custody. Verified mechanics that decided the shape:

- The pre-mint pipe is **stock, on-chain-enforced, and live on mainnet AND 4663** (token
  factory = module state 1 on both Airlocks; 80% caps; schedules of duration 0 or ≥ 1 day).
  It is the exact rail the creator premine already rides — same trust story, disclosed the
  same way.
- **Oversupplying the sale is a burn, not a reserve**: `Airlock.create()` transfers the
  entire unsold/unvested remainder to the launch's timelock in the create tx, and under
  noOp governance (our "listable" tier) the timelock is literally `0xdead`.
- **Proceeds-skim shapes are dead ends today**: the V4 split migrator isn't whitelisted on
  mainnet and doesn't exist on 4663; the V2 split abandons our venue; our migrator decodes
  the plain V4 shape only. A raise-skim would mean new audited Solidity for less-aligned
  economics (taking the buyers' ETH vs. aligning on the token).

**Why supply-side is also the right economics:** the reserve is denominated in the launch's
own token — it funds LP rewards *in the token whose pool it defends*, it never touches the
raise, and its value survives only if the launch does. Incentive-aligned by construction.

### What is already built (this change-set)

- `TegridyLaunchConfig.ecosystemReserve` in `airlock.ts` — the facade builds the two-line
  `allocations` vesting (creator premine + reserve, distinct schedules), **hard-refuses a
  zero-address custody** ("refusing to burn 5% of a launch") and over-allocation, and
  leaves the legacy path byte-identical when the reserve is absent (all pinned by tests).
- `ECOSYSTEM_RESERVE_BPS = 500` + `ECOSYSTEM_RESERVE_RECIPIENT = 0x0` in `config.ts` —
  the repo's flag-gated-off pattern.

### The go-live change-set (one PR, in this order)

1. **Custody decision + deploy** (see below).
2. `ECOSYSTEM_RESERVE_RECIPIENT` filled (per-chain when the launch rail goes multichain).
3. Wizard supply math: `numTokensToSell = supply × (10000 − premineBps − RESERVE_BPS) / 10000`,
   reserve passed via `ecosystemReserve`.
4. **Fact Sheet: a dedicated "Ecosystem reserve — 5%" line.** Never lumped into
   `teamAllocationVestedBps` (that means CREATOR allocation; the disclosure tests pin the
   equivalence and would rightly go red). New knob ⇒ same pre-signature round-trip guard
   discipline as the market-cap band.
5. Plain-language wizard copy: "5% of supply is locked to fund this pool's rewards,
   bribes, and bounties after graduation."

### Custody + distribution (Phase 2 — the one open decision)

Nothing in the tree takes a per-launch token tranche end-to-end today. The receivers split
by asset shape:

- **LP yield on the graduated pool** — `TegridyBoostedLPStaker` is the purpose-built
  vehicle and the launch token is its natural reward, but its rewardToken + allowedPoolId
  are per-deploy immutables ⇒ needs a small **per-launch staker factory + notify glue**
  (the one new-Solidity item in this plan; deliberately Phase 2, after the reserve
  mechanism has launches feeding it).
- **Bribes** — `VoteIncentives` is gauge-keyed (and its un-gate is blocked on the one-shot
  `setGaugeController`); wire per-launch bribes only after gauges exist for graduated pools.
- **Bounties** — `CommunityGrants`/`MemeBountyBoard` are mainnet TOWELI/ETH-shaped; a
  launch-token bounty line needs either conversion or board support.

### DECIDED 2026-08-22 (owner: "do what you think is best" + research) — the architecture

The research reshaped the design (full evidence in the session's survey; the load-bearing
findings): **no surviving launchpad funds LP incentives from per-launch supply-mining** —
pump.fun admitted its creator-fee incentive design failed and pays $1M/day buybacks from
FEES; Clanker routes 2/3 of fees to buybacks+grants; naive LP mining is the documented dead
pattern (Uniswap 2020: TVL −38% in 24h after rewards ended). The one supply-reserve analog
that works (Virtuals Genesis) works because of hard locks + curation + transparent custody,
and its #1 risk is vesting overhang. And **only ~0.2–0.3% of launches graduate** (832,941
pump.fun launches analyzed; 68.7% die on launch day) — so a reserve that activates before
graduation is dead weight on 99.7% of launches.

**The architecture that follows:**

1. **Graduation-activated, burn-on-failure.** The 5% reserve only means anything for
   launches that graduate into our pools. A launch that dies pre-graduation gets its
   reserve BURNED (extends the Airlock's own unsold-remainder-to-0xdead story). This kills
   the "5% tax to a Safe" read: it is an option that pays only when the launch succeeds —
   and its custodian provably cannot profit from failure.
2. **Custody (M.11 — DECIDED):** the pre-mint recipient is the MULTISIG (verified
   constraint: TegridyLockVault only accounts tokens arriving through `lock()`, so vesting
   straight to the vault would burn them), which immediately locks each tranche as a
   **per-launch `TegridyLockVault` entry** — on-chain-visible earmark keyed to its launch,
   deployed on all three chains by the rail scripts already. Never a commingled pot.
3. **LP incentives (post-graduation):** fixed-amount, epoch-capped, decaying — never
   APR-targeted (the Bancor lesson) and never front-loaded (Nansen: 42% of day-one farmers
   gone in 24h). Interim rail with ZERO new Solidity: **AirdropFactory Merkle epoch
   campaigns** (our own Merkl pattern — live on all three chains, multisig-attested roots,
   unclaimed reclaims), honestly labeled operator-attested. Phase 2 upgrades to the
   **per-launch `TegridyBoostedLPStaker` factory + notify glue** (on-chain attribution,
   vest-only-while-staked mechanics per GMX/Camelot evidence) — the one genuinely new
   Solidity surface, and it goes through audit before it custodies anything.
4. **Community grants:** **retroactive, objective-deliverable bounties decided by a small
   named committee — never open voting** (per-launch communities are maximally sybil-able;
   Gitcoin/RPGF3 attack literature). Paid **VESTED via `VestingFactory`** (live on all
   three chains) with no-sale terms, Optimism-style. The existing ETH/TOWELI-shaped boards
   (CommunityGrants/MemeBountyBoard) cannot take launch tokens and are not pretended to.
5. **The survivor pattern runs alongside:** fee-recycling is what actually kept peers
   alive, and we already have its skeleton — the hook's POL skim + the fee constitution.
   A Flaunch-style bid wall / buyback line out of pool fees is the natural next lever,
   funded from FEES so it never adds sell-side supply. Tracked, not built here.
6. **SEC surface, minimized by construction:** distribution rules fixed programmatically
   at create time, permissionless epoch cranks where possible, copy frames the reserve as
   pool-bound infrastructure — never "we work to make the token go up". Legal review
   before Fact Sheet copy ships.

**Heat tie-in:** entry curation (already live) + heat tiers set `durationSeconds`/epoch
caps per tier at create — hotter launches release faster. The tier table reuses the shipped
HEAT_TIER monotonicity-validator discipline (warmer never worse). Policy, not code.

## 3. "Full control, zero blockchain knowledge" — the gap list, by leverage

From the wizard-surface audit (facts in the session research; every gap is UI over
already-written contracts unless noted):

1. **Ship the built-but-invisible tools.** `LaunchRugEscrow` (the strongest trust
   primitive in the repo — zero frontend surface), `TegridyLockVault` create-form,
   `VestingFactory` create-form. All gate on `isDeployed()` like AirdropPage already does,
   so UI can land before deploy ceremonies. *No new Solidity.*
2. **Token-metadata uploader** on the token wizard (reuse the NFT rail's Irys pipeline) —
   removes the ONE step a no-knowledge creator literally cannot complete (raw tokenURI paste).
3. **NFT allowlist CSV builder** (client-side merkle, mirroring CampaignBuilder) —
   replaces the raw 32-byte root paste that currently requires offline dev tooling.
4. **In-flow chain switching + plain-language gas estimates** — replace every "switch to
   Ethereum" refusal with a switchChain button; ETH+USD estimate next to every
   irreversible button (the Arweave quote proves the pattern).
5. **Advanced fold for the hidden Doppler knobs** (proceeds band, auction duration,
   static-vs-dynamic curve — SDK-side only). Default-hidden: the zero-knowledge path stays
   four steps; "full control" lives behind the fold. Every new knob gets the
   market-cap-band round-trip-guard treatment.
6. **ENS + recent-address picker on every 0x paste** — the perpetual-fee-split beneficiary
   rows are the scariest paste fields in the app.
7. Hygiene: the stale "/solana-launch never signs" comment (it submits since the submit
   path landed); NFT wizard's positional log-decode; wire allowlist/dutch/phase into
   createCollection (the struct already accepts them).

Already strong and worth preserving: the heat gate's plain-language door, the fact-sheet
live preview, the double-launch broadcast guard, the EIP-5792 one-confirmation flows.

## Operator asks this plan adds (append to the M-series)

| # | Step | Notes |
|---|---|---|
| M.9 | Base graduation stack broadcast (`DeployBaseGraduationStack`) + 48h initializer allowance + acceptOwnership | After the Base Safes exist. Same runbook shape as 4663's M-steps. |
| M.10 | Send the mainnet petition + multichain rider to Whetstone | One conversation, three chains. Pre-send checklist in the main petition governs. |
| M.11 | ~~Custody decision~~ **DECIDED**: multisig receives → per-launch LockVault earmark; burn-on-failure policy; Merkle-epoch LP campaigns + VestingFactory grants interim; Phase-2 audited staker factory | Decision rationale in §2. Operator executes, does not re-decide. |
| M.12 | Reserve go-live change-set (recipient + wizard math + Fact Sheet line) | One PR, order above. |
