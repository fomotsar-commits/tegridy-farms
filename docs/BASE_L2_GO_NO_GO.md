# Base L2 — go / no-go

**Status: recommendation, not a decision.** The operator takes the decision. This memo exists
to make it cheap to take, in either direction, without re-deriving anything.

**What is being decided:** whether to deploy the protocol's AMM + fee spine to Base mainnet
(chain 8453) and point venue surfaces at it.

**What is not being decided here:** anything about TOWELI. TOWELI is fixed-supply and lives on
Ethereum. No version of Base launch mints, bridges, or mirrors it. See
[§ 5](#5-what-a-base-deployment-actually-is).

**Recommendation: NO-GO for now.** Ship the scripts (done — `contracts/script/base/`), keep the
chain seam (done — `frontend/src/lib/chains/`), leave mainnet as the only configured chain, and
re-open this memo when the four conditions in [§ 7](#7-what-must-be-true-first) are met. The
reasoning is [§ 8](#8-the-reasoning-in-one-paragraph). The single sentence version: **the
venue cannot yet custody the chain it is already on, and cannot yet fund the pool it already
has.** Adding a second of each does not fix either.

The roadmap's own success metric for this item is *"ship-ready deploy scripts merged and a
published decision memo; if launched, $500K+ TVL within 60 days"* ([`ROADMAP.md:82-85`]). The
first half is now met. The second half is the thing this memo declines to attempt yet.

---

## 1. Provenance of every number below

Read from this repo on 2026-08-19 unless noted. Nothing here is estimated from memory.

- Gas: measured in the Foundry harness (`contracts/test/base/DeployBaseMVP.t.sol`), not on a
  live Base RPC.
- USD: converted at **ETH $1,878.50**, the price recorded in
  [`docs/CAPITAL_REQUIREMENTS_2026_08_15.md`] on 2026-08-15. **Four days stale.** Re-quote
  before spending anything.
- Balances, TOWELI distribution, and the TWAP-floor arithmetic: all from that same capital
  doc, which states its figures are live on-chain reads taken 2026-08-15.
- No live Base RPC, Base gas oracle, Base TVL source, or external market data was consulted in
  producing this memo. Where a number would have required one, this memo says so instead of
  supplying one.

---

## 2. What it costs

### 2.1 Gas — not the constraint, and it is worth saying so plainly

The full Base deploy-and-wire sequence measures **≈16.6M gas** end to end
(`test_DeploysTheFiveContractsAndWiresThem`, 16,651,540). Runtime bytecode across the five
contracts is ≈79 KB (SwapFeeRouter 21,531 B · SwapFeeRouterAdmin 15,552 B · TegridyTWAP
14,977 B · TegridyRouter 14,853 B · TegridyFactory 12,133 B).

| chain | gas price assumed | execution cost | USD @ $1,878.50 |
|---|---|---|---|
| Base | 0.005 gwei | 0.000083 ETH | ≈ $0.16 |
| Base | 0.05 gwei | 0.00083 ETH | ≈ $1.56 |
| Ethereum (for contrast) | 1 gwei | 0.0166 ETH | ≈ $31 |

Base execution gas is a rounding error. Add the L1 data-availability fee for ~79 KB of
initcode, which this memo does not have a live blob-price for; single-digit dollars all-in is
the right order of magnitude, and it is not the number the decision turns on.

The number the decision turns on is one line down: **total protocol liquid assets across every
account are about $61** ([`docs/CAPITAL_REQUIREMENTS_2026_08_15.md`], "The treasury, read
today" — deployer EOA 0.009199 ETH = $17.28; Treasury Safe, RevenueDistributor, SwapFeeRouter,
POLAccumulator all zero). The venue can afford Base gas. It cannot afford the step after it,
on either chain.

### 2.2 Liquidity to seed — the real bill, and it is unpaid on mainnet first

There is no TOWELI on Base, so there is no protocol pair to seed there. The liquidity cost
lands somewhere less obvious: **the fee rail's token leg is TWAP-gated, and the TWAP has a
reserve floor that mainnet does not currently clear.**

- `TegridyTWAP.DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether` per side
  (`contracts/src/TegridyTWAP.sol:201`).
- The mainnet native TOWELI/WETH pair holds **0.0230 WETH**. Filling it to 10 WETH at market
  ratio would take 344,562,363 TOWELI — **1.29× the entire Uniswap pool**, which
  constant-product makes unreachable at any price.
- The adversarially-reviewed stopping point is 1.0 WETH, and getting there costs **≈2.07 ETH
  ≈ $3,886** (buy 32.9M TOWELI at 14.4% slippage, then add proportionally).
- Protocol-spendable TOWELI today: **813,751 tokens = $44.**

Two things follow. First, a Base deployment inherits the identical floor on any Base pool we
want to oracle-gate. Second — and this is the part that decides the memo — **the mainnet
instance of this rail has never run.** Shipping a second copy of a mechanism that has not yet
worked once is how you get two things to debug instead of one.

Worth being precise, because overstating this would be its own dishonesty: the **ETH-denominated
fee leg needs no TWAP at all.** Native-swap fees land straight in `accumulatedETHFees`
(`SwapFeeRouter.sol:713, 783, 976`) and `distributeFeesToStakers()` moves them without touching
an oracle. Only *token*-denominated fee conversion (`convertTokenFeesToETH{,FoT}`, lines
1683/1719) is TWAP-gated. So a Base deployment's ETH leg would work on day one. Its token leg
would sit exactly where mainnet's sits.

### 2.3 Audit delta

[`docs/BATTLE_PLAN.md`] #37 rates this **NET+** and calls for "verbatim redeploys of audited
code — F7 config review, no new audit wave." The source claim holds: `contracts/script/base/`
deploys five contracts and adds **zero new Solidity**. The *config* claim needs qualifying,
because the Base wiring is not the mainnet wiring:

| difference | why | review needed |
|---|---|---|
| `SwapFeeRouter.revenueDistributor` = a Safe, not a distributor | no veTOWELI on Base | **yes** — changes what `FeesDistributed` means |
| `referralSplitter` = `address(0)` | no voting-power source to tier against | yes — confirms the absence is intended |
| `polAccumulator` = `address(0)` | no TOWELI pair to buy | yes |
| factory guardian set at construction, not rotated | see [§ 6.1](#61-the-mainnet-guardian-rotation-cannot-complete-as-written) | yes |
| sequencer feed non-zero and mandatory | `SequencerCheck` refuses the no-op off mainnet | yes |

So: a config review, genuinely scoped, not a wave. Budget it as a review, not as a line item
with a firm attached. The unpriced audit item on this venue's books is the Solana program, not
this.

### 2.4 Ops surface — the largest cost, and it is denominated in keys, not dollars

A second chain needs a second custody set. [`docs/SAFE_REHOME_RUNBOOK.md`] specifies three
disjoint Safes per chain (Treasury 3-of-5, Admin 3-of-5, Guardian 2-of-3) with **15 distinct
independent hardware keys**, no two signers on the same hardware model, and no EIP-7702
delegation overlap.

**On mainnet, that re-home has not happened yet.** Per the same runbook's § 1: the hot deployer
EOA `0x1489…456E` still owns nearly every contract, and the current Safe `0xA360…b7F8` has "a
cross-role minority quorum and EIP-7702 delegation overlap." Base would require a *second* set
of 15 keys before it is allowed to own anything — and `DeployBaseMVP` enforces the cheap half
of that (four disjoint roles, all contract-code-checked, EIP-7702 designators rejected) while
being structurally unable to check the expensive half.

Everything else on the ops list is real but secondary: a second indexer network
(`indexer/ponder.config.ts` declares `mainnet` only, and the indexer is **not hosted at all** —
with `VITE_INDEXER_URL` unset every consumer already reports unavailable), a Base RPC roster
verified by real reads rather than `eth_chainId`, a Basescan verification key, a second
monitoring target, and a bridge cadence that must be **published before the first fee lands,
not after**.

---

## 3. What it earns

### 3.1 The Heat argument is real, and it is the strongest one on this page

The launch gate reads Heat from the island. Heat is per-wallet, summed across the island's
measured registry, and **the registry demonstrably measures Base tokens.** The captured real
reading in `frontend/src/lib/heat/heatOracle.test.ts` — documented there as "a real Elder: 12
measured tokens, island_heat 195.54", trimmed to four rows — breaks down as:

| token | chain | degrees |
|---|---|---|
| TOWELI | **base** | 96.84 |
| RIZZ | **base** | 51.37 |
| Jungle Bay Memes | **base** | 32.85 |
| TOWELI | ethereum | 1.44 |

Three Base rows supply 181.06° of that wallet's 195.54°. The mainnet row supplies 1.44°. The
reputational instrument this venue gates launches on already lives, overwhelmingly, on Base.
That is not a vibe; it is the fixture.

Two honest qualifications. (a) This shows the registry *measures* Base tokens. It does not show
the island would admit **our** Base-launched tokens to the registry — inclusion is the island's
decision and no repo artifact settles it. Ask before counting on it. (b) Our own birth-record
rail does not reach Base: per [`docs/HEAT_WAVE_TWO.md`], `chain=base` 404s because there is no
Base address book and no Base RPC server-side, and answering with mainnet addresses "would be a
fabricated record." So today we can *read* Base heat and cannot *publish* a Base birth record.

### 3.2 The launch economy

Base is where the launch culture the venue is built for actually transacts, and § 3.1 is
corroborating evidence rather than an assertion about a market this memo did not measure. #37's
build note records that Doppler — the launcher's graduation rail — is deployed on Base, so the
launch path does not need inventing there.

This memo deliberately does not quote a Base TVL, launch-volume, or user figure. It had no
source for one and a fabricated market number is exactly the class of defect this codebase
keeps finding.

### 3.3 Cheap-gas UX

Genuine, and larger for this product than for most: a launch flow is many small transactions,
and mainnet gas prices a $20 experiment out of existence. § 2.1's table is the argument.

### 3.4 A proven multichain playbook

#36 (BNB) lists as a precondition: *"the multichain playbook must be proven on Base first."*
Base is therefore worth something beyond Base. That value is real and it is also entirely
contingent — an unproven playbook proves nothing, and a playbook proven on a chain we cannot
custody proves the wrong thing.

---

## 4. What it risks

**A second deployment to monitor and re-home.** The mainnet re-home is a HIGH-STAKES CUSTODY
OPERATION that has not been performed. Doubling the surface before performing it once doubles
an outstanding liability rather than adding a new asset.

**Split liquidity.** Less acute here than usual, because TOWELI does not cross — but real for
launched tokens, whose depth would divide between chains while the venue's own aggregation and
routing (`src/lib/aggregator.ts`, `swapRouting.ts`) remain mainnet-shaped.

**The honesty burden of two chains where one is thin.** This is the risk that outranks the
others under house law, so it gets specifics:

1. **`FeesDistributed` would mean two different things on two chains.** On mainnet it means a
   staker got paid. On Base it would mean ETH moved into a Safe to await a bridge cycle. Any
   surface, indexer, or treasury page summing the two and labelling the total "staker yield"
   publishes a future event as a past one. `DeployBaseMVP` prints this at deploy,
   `VerifyBaseMVP` prints it at verify (B-INV-9), and `frontend/src/lib/chains` encodes it as
   `feeSink: 'remittance' | 'distributor'` with `feesBecomeStakerYieldOn()` returning false for
   the former — but code cannot stop a copywriter.
2. **A thin second chain reads as an outage.** Every "0 launches / 0 volume / no positions" a
   Base surface renders is indistinguishable from a Base RPC failure unless it is gated. The
   seam's `contractOn()` keeps `chain-unconfigured` and `not-deployed` as distinct answers for
   exactly this reason; the day Base is added, each consuming surface needs its own pass.
3. **The indexer is not hosted.** Base launches would be invisible until it is. #37's "done
   when (4) indexer serves Base launches to the explorer" cannot be satisfied today on either
   chain.
4. **The bridge cadence is a promise.** Publish it before the first fee lands, never imply
   real-time, and print it where the money is claimed (`TreasuryPage.tsx`).

---

## 5. What a Base deployment actually is

Five contracts, all verbatim mainnet-audited source, all in `contracts/script/base/`:

`TegridyFactory` · `TegridyRouter` · `TegridyTWAP` · `SwapFeeRouter` · `SwapFeeRouterAdmin`

**Nine mainnet contracts are deliberately absent**, and the reason is one rule rather than nine
oversights — *TOWELI is fixed-supply and lives on Ethereum:*

- `TegridyStaking`, `TegridyStakingJbacVault`, `TegridyStakingAdmin`, `TegridyTokenURIReader`,
  `StakingMonitorView` — all take TOWELI.
- `RevenueDistributor` — its constructor takes a `votingEscrow` and its whole job is paying
  veTOWELI holders pro rata. There is nothing on Base for it to read or to pay.
- `ReferralSplitter` — its constructor **requires a non-zero staking contract**
  (`ReferralSplitter.sol:253`) and it reads `votingPowerOf` to tier referral rates. Pointing it
  at any non-staking address would make every read fall into the catch arm and silently
  base-tier every referrer: a rail that looks live and pays nobody. `address(0)` is the honest
  configuration.
- `POLAccumulator` — buys TOWELI/WETH LP. No TOWELI, no pair, no POL.

So **Base captures fees; it does not distribute them.** `SwapFeeRouter.revenueDistributor`
holds a remittance Safe whose only job is to hold captured ETH until the operator bridges it to
the mainnet distributor. `DeployBaseMVP` requires that Safe to be disjoint from Treasury, Admin,
and Guardian — a balance the treasury also spends from cannot be reconciled against a published
cadence.

This is the honest correction to #37's build note, which reads as though the mainnet spine
transplants wholesale. **It does not typecheck.** Two of the contracts it names cannot be
constructed on a chain without veTOWELI.

---

## 6. Findings this slice produced

### 6.1 The mainnet guardian rotation cannot complete as written

`DeployMVP.s.sol` constructs `TegridyFactory` with the **deployer EOA** as guardian and queues
`proposeGuardianChange(pauseGuardian)` at deploy (audit M6). Its printed runbook then asks the
multisig to (2) `acceptFeeToSetter()` after 48h, and (3b) `executeGuardianChange()`.

**Step 2 destroys step 3b.** Audit F-30-10 made `acceptFeeToSetter` force-cancel any pending
`GUARDIAN_CHANGE` queued by the outgoing setter (`TegridyFactory.sol:396-401`). The Safe's own
acceptance cancels the proposal the next step tries to execute; reaching a Safe guardian
requires the Safe to propose it again itself and wait a further 48h. `VerifyMVP` INV-11c
(`factory.guardian() == pauseGuardian`) is therefore unreachable by the runbook it documents.

The Base scripts do not reproduce this: `TegridyFactory`'s constructor accepts the guardian
directly, so `DeployBaseMVP` constructs with the Guardian Safe. No rotation window, no
proposal to lose, and the deployer EOA never holds the factory's pair-disable power.
`test_GuardianIsTheSafeFromBlockOneWithNoRotationQueued` pins it.

**Mainnet is out of this slice's ownership and was not touched.** Someone should either fix the
ordering in `DeployMVP`'s runbook printout or adopt the construct-with-guardian pattern there
too, and either way re-check live mainnet state against INV-11c.

### 6.2 `code.length > 0` is no longer a Safe check

A 23-byte runtime is an EIP-7702 delegation designator: it has code and it is still one key.
`TegridyFactory.proposeGuardianChange` already rejects it (`codeLen != 23`), but the
`multisig.code.length > 0` guard in `TransferOwnershipToMultisig.s.sol` and the gated-deploy
scripts does not. `BaseChainConfig.requireSafe` and `VerifyBaseMVP` B-INV-2 reject it for all
four Base roles. The mainnet-side guards are unchanged and remain worth a look.

---

## 7. What must be true first

Four conditions. All are checkable; none is a matter of taste. Any "no" is a no.

1. **Mainnet custody is finished.** [`docs/SAFE_REHOME_RUNBOOK.md`] executed end to end: three
   disjoint Safes live, every privileged role off `0x1489…456E` and off `0xA360…b7F8`, verified
   by live on-chain reads. *Rationale: a second chain multiplies the custody problem by two;
   two times an unsolved problem is not a plan.*
2. **A Base Safe set exists with signers proven.** Three disjoint Safes, 15 independent
   hardware keys, **each Safe's nonce > 0 from a real executed transaction before it is named
   as an owner.** *Rationale: the Squads loss and the 0xA360 finding are the same lesson twice.
   `DeployBaseMVP` can check code and disjointness; only the operator can check signers.*
3. **The fee rail has worked once, on mainnet.** One complete cycle: fee captured →
   `distributeFeesToStakers()` → a staker's balance changes → the figure reconciles against an
   independent read. *Rationale: today `totalDistributed` is still 0 and 80% of the 3e12 wei
   earned sits stranded in `ReferralSplitter.callerCredit` ([`docs/CAPITAL_REQUIREMENTS_2026_08_15.md`],
   Tier 0 item 5). Copying a rail before it has run once copies whatever is wrong with it.*
4. **Either the indexer is hosted, or every Base surface ships gated to "unavailable" from day
   one.** *Rationale: #37's own "done when" requires the indexer to serve Base launches. Until
   `VITE_INDEXER_URL` is set, a Base explorer page renders an empty result set that is
   indistinguishable from an outage — the exact defect this codebase has found repeatedly.*

**Not on this list, deliberately:** money. The gas is trivial (§ 2.1) and there is no Base pool
of ours to seed (§ 2.2). Base is not blocked on funding. It is blocked on custody and on
finishing the first chain.

---

## 8. The reasoning in one paragraph

Base is the right second chain and this is the wrong time. The evidence *for* it is stronger
than expected — the Heat registry the launch gate depends on is overwhelmingly Base-resident
(§ 3.1), the deploy is five contracts of already-audited source, and the gas is a rounding
error. But every one of those advantages survives waiting, and none of the blockers does. The
protocol's privileged roles still sit on a hot EOA and a Safe its own red team flagged; the fee
rail it would duplicate has never completed a cycle; the indexer that would make a Base surface
honest is not running; and the venue holds about $61. Deploying into that produces a second
chain to custody, a second rail to debug, and a second set of surfaces that must tell users
"unavailable" — in exchange for a launch economy the venue is not yet positioned to serve. The
scripts are the right deliverable *because* they make the decision cheap later: when § 7 is
satisfied, this is an afternoon plus a ceremony, not a project.

## 9. If the answer becomes yes

1. Re-read § 7 against live state. Do not accept this memo's word for anything in it.
2. Build the three Base Safes; prove signers (nonce > 0) before naming any of them.
3. Dry-run `forge script script/base/DeployBaseMVP.s.sol --rpc-url $BASE_RPC --sender $OP -vvv`.
   Read all fourteen `D-INV-*` printouts. It refuses every chain but 8453, so it cannot be
   pointed at mainnet by accident.
4. Broadcast. Complete the ceremony the summary prints: accept three ownerships within the
   14-day expiry, then `acceptFeeToSetter()` after 48h. There is no guardian rotation step.
5. `script/CheckCanonicalWETH.s.sol`, then `script/base/VerifyBaseMVP.s.sol`. All green or stop.
6. **Publish the bridge cadence before the first fee lands.**
7. Add a second `ChainConfig` to `frontend/src/lib/chains/registry.ts` with
   `feeSink: 'remittance'` and `capabilities.stakerYield: false`. Fix
   `registry.test.ts`'s "serves exactly one chain" assertion **by editing the expectation
   deliberately**, never by loosening it — that test failing is the intended alarm.
8. Walk every surface that renders a fee, a yield, a count, or a zero, and give each one a
   per-chain answer. This is the longest step and the one worth doing slowly.

## 10. If the answer stays no

Nothing to undo. The scripts are inert until an operator broadcasts them, the seam has one
entry, `frontend/src/lib/constants.ts` still pins `CHAIN_ID = 1`, and no surface has been told
Base exists. Re-open this memo when § 7 changes, not on a calendar.

---

*Related: [`docs/BATTLE_PLAN.md`] #37 (and #36, which depends on this being proven first) ·
[`docs/YEAR_PLAN_2026_2027.md`] Q4 · [`ROADMAP.md:82-85`] ·
[`docs/CAPITAL_REQUIREMENTS_2026_08_15.md`] · [`docs/SAFE_REHOME_RUNBOOK.md`] ·
[`docs/HEAT_WAVE_TWO.md`]*
