# Contract provenance audit — graded against the battle-tested-upstream ethos

**2026-08-26.** Operator instruction: *"we should only use battle tested billion dollar unhacked
contracts from protocols as our ethos."* This grades every contract we have against that rule.

**Scope.** 72 `.sol` files under `contracts/src`, ~47,000 SLOC, ~20 of them live on mainnet.
**61 contracts received a graded verdict.**

| Verdict | Count |
|---|---|
| ANCHORED — upstream used unmodified | 6 |
| FORK-DRIFTED — trusted lineage, diff reaches the audited surface | 6 |
| BESPOKE-JUSTIFIED — no upstream fits, and that is defensible | 31 |
| BESPOKE-SHOULD-NOT-BE — an upstream exists and was not used | 18 |

**Method, and why the numbers above are not the first numbers produced.** Eight graders each took a
cluster and read the source, comparing against the upstreams actually vendored on disk
(`contracts/lib`: OpenZeppelin 5.6.1, Solady 0.1.26, Solmate 6.8.0, v4-core, v4-periphery). Eight
independent challengers then attacked each grader's verdicts in **both** directions — too generous
*and* too harsh — and were required to cite a line number for any correction.

**Not one cluster survived unchallenged. 38 corrections were filed**, and they changed the
conclusions materially in both directions:

- `OwnableNoRenounce` was graded ANCHORED ("a thin subclass of OZ Ownable2Step") by four separate
  graders. Four separate challengers opened the body and found **259 lines overriding three or four
  of Ownable2Step's public entry points**, including reverting on `transferOwnership(address(0))` —
  which is OZ's *documented cancel primitive*. It is inherited by nearly every contract here. That
  is the exact dangerous category this audit was asked to hunt, and the first pass walked past it.
- In the other direction, several graders recommended "just use OZ `TimelockController`". Challengers
  opened the vendored file: it is `contract`, not `abstract`, so it cannot be inherited to gate a
  contract's own typed setters; its queue is content-addressed by an attacker-chosen `salt`, so it
  has **no** per-key uniqueness rule; and `grep -i expir` over it returns **zero hits**, so it has no
  proposal expiry. Three of the properties it was credited with do not exist. Those remediations were
  struck.

Where a grader and a challenger disagreed, the one citing a line number wins, and the text says so.

**The honest caveat that constrains everything below:** Uniswap V2 is **not vendored** in this tree
(`.gitmodules` pins only v4-core, v4-periphery, solmate, solady). Every V2 comparison here is
therefore from knowledge of the canonical 0.5.16 source, not a mechanical diff. Vendoring
`v2-core` and `v2-periphery` as submodules is the cheapest single action available and would make
every future diff in the AMM reviewable instead of a memory exercise.

---

## 1. The headline number

The live surface is roughly **11,000 SLOC across ~20 deployed contracts and libraries**, and the honest split is:

| Bucket | Live SLOC | Share |
|---|---|---|
| Upstream code used unmodified (OZ 5.6.1, Solady v0.1.26, Solmate, deployed Uniswap V2 Router02) | imported, not counted in our SLOC | — |
| **Our code that is a drifted fork of a named upstream** | ~2,300 | ~21% |
| **Our code that is bespoke and holds or routes money** | ~6,900 | ~63% |
| **Our code that is bespoke and genuinely has no upstream** | ~1,750 | ~16% |

Counting only the files graded in this pass, the live novel-code total is:

```
TegridyStaking.sol            2792   bespoke reward+ve core        LIVE
SwapFeeRouter.sol              795   bespoke fee wrapper           LIVE
RevenueDistributor.sol         806   bespoke ETH distribution      LIVE
lib/StakingRewardLib.sol       900   bespoke IOU ledger            LIVE
ReferralSplitter.sol           506   bespoke referral policy       LIVE
POLAccumulator.sol             525   bespoke POL zap               LIVE
TegridyTWAP.sol                514   bespoke oracle + policy       LIVE
lib/SwapFeeRouterConvertLib    311   re-implemented V2 oracle lib  LIVE
TegridyRouter.sol              411   V2 fork                       LIVE
TegridyFactory.sol             347   V2 fork + 320 SLOC governance LIVE
SwapFeeRouterAdmin.sol         374   bespoke timelock              LIVE
base/OwnableNoRenounce.sol     259   OZ Ownable2Step fork          LIVE (inherited widely)
TegridyPair.sol                215   V2 fork                       LIVE
lib/StakingViewLib.sol         202   bespoke views                 LIVE
StakingMonitorView.sol         173   bespoke views                 LIVE
TegridyStakingAdmin.sol        300   bespoke timelock              LIVE
TegridyStakingJbacVault.sol    132   bespoke escrow                LIVE
lib/WETHFallbackLib.sol         66   bespoke ETH transfer          LIVE
lib/TegridyFactoryLib.sol       46   EIP-170 split                 LIVE
lib/LockerClaimer.sol           45   bespoke claim shim            LIVE
```

**Not a single live contract in the graded set is ANCHORED.** Zero. Every deployed file is either a fork that drifted or bespoke. The closest thing to anchored on the live surface is `SwapFeeRouter`'s AMM leg, which calls the *deployed* Uniswap V2 Router02 rather than reimplementing swap math — and even that file ships a 311-SLOC library that re-derives `UniswapV2OracleLibrary.currentCumulativePrices` from scratch when v2-periphery is MIT and vendorable.

Two structural facts make this worse than the raw numbers:

- **Uniswap V2 is not vendored at all.** `.gitmodules` pins only `v4-core`, `v4-periphery`, `solmate`, `solady`. There is no `v2-core` or `v2-periphery` anywhere in the tree, and no `UniswapV2*.sol` file exists. Four live contracts (`TegridyPair`, `TegridyFactory`, `TegridyRouter`, and the oracle bridge in `TegridyTWAP`) are forks of code that is *not on disk to diff against*. Every V2 comparison in this document is from-knowledge of canonical 0.5.16 source, not from disk. That is not a small thing: it means no future change to these files can be reviewed as a diff.
- **OpenZeppelin is not a submodule.** `.gitmodules` does not list it, and `git ls-files -s contracts/lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol` returns mode `100644`, not a `160000` gitlink. OZ is vendored as ordinary tracked files that can be edited in place with no pointer moving. A grep of `contracts/lib/openzeppelin-contracts/contracts` for `Tegrid`/`AUDIT FIX` returns zero hits, so the copy looks clean today — but "OZ unmodified" rests on that grep, not on a pin.

Undeployed novel code adds another ~1,200 SLOC (`TegridyRestaking` 925, `TegridyRestakingAdmin` 228, `RestakingMonitorView` 65) plus `StreamingRevenueDistributor` at 358.

## 2. What we already do right

This is real and it should not be lost in the list of problems.

**Vendored upstreams are used as intended where they are used at all.**

- **Solady v0.1.26 ERC-721** is imported unmodified into `TegridyStaking` as `SoladyERC721`. The submodule is verifiably pristine (`git diff --stat HEAD -- src/` is empty). The only behavioural delta is logic inside Solady's own `virtual _beforeTokenTransfer` / `_afterTokenTransfer` hooks at `TegridyStaking.sol:1773,1796` — that is exactly the extension surface Solady publishes for this purpose. **This is the model for how to fork correctly: extend at the hooks, never at the audited function bodies.**
- **OZ 5.6.1** `ReentrancyGuard`, `Pausable`, `Checkpoints.Trace208`, `IERC721Receiver`, `IERC20/SafeERC20`, `EnumerableSet` are used unmodified across the tree.
- **Solmate `FixedPointMathLib.sqrt`** at `contracts/lib/solmate/src/utils/FixedPointMathLib.sol:164` backs `TegridyPair`'s liquidity math (submodule HEAD `89365b8`).
- **Solady `SafeTransferLib`** is vendored and correctly used by `LockerClaimer`.

**The parts of the V2 fork that would be catastrophic are intact.** `TegridyPair.sol:297-304` is algebraically identical to V2's k-invariant: `balanceAdjusted = postBalance*1000 - amountIn*3`, `product >= reserve0*reserve1*1e6`. The 997/1000 fee, the `_mintFee` formula (`TegridyPair.sol:554-555`), and the UQ112x112 cumulative accumulator with `Q112 = 2**112`, unchecked wrap and `uint32` modular `timeElapsed` (`TegridyPair.sol:527-530`) are faithful. `TegridyRouter`'s `_getAmountOut` (:553-560), `_getAmountIn` (:563-570), `quote` (:466-470), `_sortTokens` (:572-576) and the `_swap` hop loop (:490-506) are line-for-line `UniswapV2Library`.

**`SwapFeeRouter` delegates swap execution instead of reimplementing it** — `swapExactETHForTokens` at :716, `swapExactTokensForETH` at :769, plus four FoT variants, all against the deployed mainnet Router02. The audited code lives at a live address; it does not need to be in this tree. Its fee split at :1355 is remainder-safe (treasury takes `amount - stakerAmount - polAmount`) so the three slices sum exactly and no dust can be lost or double-spent.

**`StreamingRevenueDistributor`'s accrual integral is a verbatim Synthetix port.** `lastTimeRewardApplicable` / `rewardPerToken` / `earned` and the `updateReward` ordering at `StreamingRevenueDistributor.sol:356-426` were diffed against `TegridyLPFarming.sol:224-292` and are identical modulo `1e18`→`ACC_PRECISION` and an added `totalStreamed`. `TegridyLPFarming` itself is the repo's one faithful Synthetix `StakingRewards` implementation — it has `periodFinish`, `lastTimeRewardApplicable()`, `rewardsDuration`, and `rewardRate = (reward + leftover) / duration` (`TegridyLPFarming.sol:277-292, 566-600`). **We own a correct copy of the pattern; the problem is that two other contracts wrote their own instead of using it.**

**`SequencerCheck.sol` is fine.** ~120 SLOC of real code in 454 lines, six internal view functions, no delegatecall, correct per-chain feed addresses at :39-43 for Arbitrum/Optimism/Base. Aave V3's `PriceOracleSentinel` is coupled to Aave's addresses-provider and is not a drop-in; Chainlink publishes the L2 uptime check as documentation, not as a contract to inherit. No remediation needed.

**`TegridyFactoryLib`'s delegatecall reasoning checks out.** Because it is DELEGATECALLed, the CREATE2 executor stays the Factory, so pair addresses and `pair.factory` are unchanged (`TegridyFactoryLib.sol:21-26`). Every external staticcall is capped at 30,000 gas, correctly closing the OOG-grief vector.

## 3. ⛔ Drifted forks — the dangerous middle

These carry a trusted lineage whose diff has reached the audited surface. Highest priority regardless of size.

### 3.1 `base/OwnableNoRenounce.sol` — OZ Ownable2Step, overridden at the audited functions

**259 lines. Inherited by TegridyStaking, TegridyStakingAdmin, TegridyRestaking (:111), TegridyRestakingAdmin (:64), and more.** The original grader called this "ANCHORED — a thin, well-scoped subclass." Two independent challengers, both citing line numbers, say otherwise. **I took the challengers.** The distinction that decides it: Solady's `_beforeTokenTransfer` is an *empty extension point*; OZ's `transferOwnership` and `acceptOwnership` *are the functions OZ's audits describe*. Overriding the second kind is drift.

Three deviations:

1. **`OwnableNoRenounce.sol:170` — `if (newOwner == address(0)) revert PendingOwnerZeroAddress();`** OZ `Ownable2Step.sol` documents verbatim: setting `newOwner` to the zero address is allowed and is how you cancel an initiated transfer. **This fork deletes OZ's cancel primitive.** Any Safe transaction-builder runbook written against OZ semantics reverts.
2. **`OwnableNoRenounce.sol:50` + `:182-190` — `OWNERSHIP_TRANSFER_EXPIRY = 14 days`.** OZ's `acceptOwnership` never expires. A multisig that takes more than 14 days to gather signatures must have the transfer re-proposed. This is load-bearing for a risk the restaking grader itself raised: authority across the host/admin split is only equivalent if the same multisig owns both, and each address now runs its own independent 14-day clock. `TegridyRestaking.sol:2466-2474` additionally cancels a queued admin-replacement proposal inside `acceptOwnership`, so a stalled two-contract handoff is not merely incomplete — it is unacceptable without re-proposing.
3. **`OwnableNoRenounce.sol:96` — `renounceOwnership` is `public view override onlyOwner` and reverts**, changing the ABI mutability. Plus a permissionless `pokeOwnershipExpiryWarning()` at :236/:245-257 writing a global mutable `lastPokeTime`.

No theft path. The risk is operational brick and rotation friction on every contract in the repo. **Fix: drop the `acceptOwnership` expiry** — it is the only deviation that can block a legitimate handoff — and document the other two at the call sites of every child.

### 3.2 `WETHFallbackLib.sol` — 66 SLOC carrying three protocol names it shares no code with

The file header (lines 17-19) claims "Solmate SafeTransferLib (Uniswap V3/V4, Seaport)" plus "WETH fallback pattern from Aave V3, Convex." I opened the vendored Solmate at `contracts/lib/solmate/src/utils/SafeTransferLib.sol`: its `safeTransferETH` is 8 lines of assembly, forwards **all** gas via `call(gas(),...)`, and reverts on failure. `grep -rli weth contracts/lib/solmate/src/utils` returns **nothing**. WETHFallbackLib shares zero code with it.

**The upstream that actually solves this is on disk and unused:** Solady `SafeTransferLib` at `contracts/lib/solady/src/utils/SafeTransferLib.sol` — `safeTransferETH` at :95, `forceSafeTransferETH(to,amount,gasStipend)` at :118, `forceSafeTransferETH(to,amount)` at :148, `trySafeTransferETH` at :179, `GAS_STIPEND_NO_GRIEF = 100000` at :52. Solady guarantees delivery via SELFDESTRUCT force-send and **never changes the asset type**.

What ours does instead:
- `WETHFallbackLib.sol:143-155` is a strictly worse re-implementation of Solady `:95`, capping at `ETH_TRANSFER_GAS_STIPEND = 30_000` (:59) — **3.3× below the stipend Solady already reasoned about and named**.
- `:117-124` — any recipient whose `receive()` costs more than 30k **silently receives WETH instead of ETH**. The file's own comment at :45-58 admits this already happened once at 10k and was patched by raising the number rather than adopting the upstream.
- `:243-262` — `safeTransferETHOrWrapNoRevert` mode==2 means "WETH is now stranded in the CALLER and the caller MUST credit it," an obligation enforced nowhere in the library.

**This is not stylistic. It is load-bearing on a live accounting path:** `SwapFeeRouter.recoverCallerCredit` (`SwapFeeRouter.sol:1836-1841`) measures recovery as `address(this).balance - balBefore`. Any amount delivered as WETH instead of ETH reads as `recovered == 0` and is never added to `accumulatedETHFees`.

It is the single ETH exit for `RevenueDistributor.withdrawPending`, `ReferralSplitter.claimReferralRewards`/`withdrawCallerCredit`, `SwapFeeRouter.distributeFeesToStakers` (treasury leg), `POLAccumulator.executeSweepETH`, `StreamingRevenueDistributor.getReward`, and six `TegridyRouter` money paths (`TegridyRouter.sol:161, 218, 280, 335, 362, 436`).

The original grader cited V2's `TransferHelper.safeTransferETH` as the reference — **that file is not on disk anywhere**, while the Solady equivalent that is on disk went unnamed. Correction applied.

**Fix: `SafeTransferLib.safeTransferETH` for plain legs; `trySafeTransferETH(to, amount, GAS_STIPEND_NO_GRIEF)` + wrap for the fallback legs. Keep only the WETH-wrap branch as bespoke, and strike the Solmate/Aave/Convex attribution from the header — it is claiming audit coverage that does not exist.**

### 3.3 `StreamingRevenueDistributor.sol` — verbatim Synthetix integral, non-Synthetix balance source

The math is a faithful port. **The drift is not in the math.** Synthetix `_balances[account]` is written only by `stake()`/`withdraw()`, called by the account itself, backed by tokens it deposited. Here:

- `effectiveBalanceOf` is written by a **permissionless `sync(address)`** at :490, from an external oracle read that **fails open to zero**. `_tryEffectivePower` (:455) computes a `readable` flag and `_effectivePower` (:442) throws it away — so a reverting `TegridyStaking` read is written into the mirror as a real zero and subtracted from `totalEffectiveSupply`. No Synthetix audit covers a third-party-writable balance sourced from a fallible external read.
- `_syncAndMaybeRecycle` (:513) **zeroes `rewards[account]`** — permissionless confiscation of crystallised accrual. Synthetix never zeroes an earned balance. There is no forfeit in Synthetix at all.
- `_observeLockEnd` (:753) assigns rather than max-guards: `if (readable && lockEnd != 0) lastObservedLockEnd[account] = lockEnd;` — a stranger can drive a victim's grace anchor **backwards**. Measured as stranger-executed theft on trunk (`docs/V2_FORFEIT_ATTEMPT4_REFUTED_2026_08_26.md` P1). P2 measured **22× amplification**: an attacker holding 1/51 of power taking 3.078 ETH of a 7 ETH schedule via `syncMany` over 50 victims.

Five attempts at one mechanism, 13 adjudicated claims, 9 confirmed. **Not deployed** — this is a quick win. **Fix: delete the forfeit/recycle path entirely and make `_updateReward` refuse to write a non-readable zero.**

### 3.4 `TegridyPair.sol` — kLast no longer refreshes unconditionally

V2 does `if (feeOn) kLast = reserve0*reserve1` in both `mint` and `burn`. Here it is `if (feeOn && kLast != 0 && !factory.disabledPairs(this))` at :199 and :242, and the **first** `kLast` write is moved into a new permissioned path. If `kLast` is never bootstrapped, `_mintFee`'s inner `if (_kLast != 0)` (:550) short-circuits forever and the protocol collects zero fee; re-enabling `feeTo` after a disable no longer self-heals. **This is squarely inside what V2's audits reasoned about.**

Around it: `harvest()` (:403-488, ~50 SLOC) has no V2 equivalent — permissionless `_mintFee` trigger, 5-minute `HARVEST_INTERVAL`, three-way bootstrap/cleanup/normal branching with a `feeToSetter` gate at :467-469. `swap()` is inverted from optimistic to pull-then-push (balances read before the output transfer at :284-293, reserves written before transfer at :309) — algebraically equivalent for standard ERC-20, but it deletes flash swaps outright (`require(data.length == 0, "NO_FLASH_SWAPS")` at :263). `skim()` and `sync()` — V2's always-available desync escape hatches — are now gated behind the factory circuit breaker.

**Correction applied, against the grader:** the grader claimed the `FOT_OUTPUT_0/1` checks at :335-336 mean the router's FoT variants "only work for FoT tokens on the INPUT side." The challenger cites the actual lines: they are `require(balanceOf(this) >= postBalance0)` — a `>=` against a *predicted* postBalance, not an equality against a measured one. A reflection/tax token (the dominant FoT design) debits the sender by exactly `amount` and credits the recipient `amount - fee`, so the pair's balance falls by exactly `amount0Out`, `>=` passes, and `_update` at :309 already wrote true post-transfer reserves. Output-side FoT works end-to-end through the router's balance-delta variants (`TegridyRouter.sol:382, 386, 392, 416`). The pair's own comment at :324-334 says the 2026-05-16 M13 fix loosened `==` to `>=` for exactly this reason. **Only the rarer sender-burn deflationary design trips it.** The adjacent stale-doc finding survives and should still be fixed: `TegridyPair.sol:41-43` asserts the router has no `*SupportingFeeOnTransferTokens` variants; it has three.

### 3.5 `TegridyFactory.sol` — 90% bespoke governance reaching into the pair's hot path

`createPair` (:245-293) is recognisably V2 — that is ~25 of 347 SLOC. The other ~320 is governance V2 does not have, and it reaches into the pair: `blockedTokens` and `disabledPairs` are read by `TegridyPair` on **every** swap/mint/skim/sync/harvest (`TegridyPair.sol:140-141, 259-261, 353-354, 376-377, 412-413`), 2-3 external staticcalls per call where V2 pays zero.

**Correction applied, against the grader:** the grader described "five TimelockAdmin keys" including `FEE_TO_SETTER`. The challenger counts the actual declarations: there are **four** bytes32 keys — `FEE_TO_CHANGE` (:24), `TOKEN_BLOCK_CHANGE` (:25), `PAIR_DISABLE_CHANGE` (:26), `GUARDIAN_CHANGE` (:33). **There is no `FEE_TO_SETTER` key.** The feeToSetter rotation runs on its own storage slot `feeToSetterChangeTime` (:130), proposing at :352-362 by direct-writing `block.timestamp + FEE_TO_SETTER_DELAY` at :360 — **never calling `_propose`** — with its own expiry constant `MAX_SETTER_PROPOSAL_VALIDITY` (:143) instead of `TimelockAdmin.PROPOSAL_VALIDITY`, and `cancelFeeToSetterProposal` (:426-433) direct-writing both slots to zero. The source documents this at :419-424: it "does NOT use the TimelockAdmin._cancel(KEY) pattern (and so does NOT emit ProposalCancelled)."

This matters beyond bookkeeping. **`feeToSetter` is the role that gates the first `kLast` write in the pair** — `TegridyPair.sol:466-468` reverts `HARVEST_BOOTSTRAP_GATED` unless `msg.sender == factory.feeToSetter()`. So the pair's protocol-fee bootstrap is anchored to the one admin path in the factory that bypasses the shared timelock and emits no `ProposalCancelled` for monitors. **Four keys plus one hand-rolled path, not five keys.**

Also: the CREATE2 salt at :275 is `keccak256(abi.encode(chainid, address(this), token0, token1))`, **not** V2's `keccak256(abi.encodePacked(token0, token1))`. Any integrator using standard V2 `pairFor` prediction computes the wrong address. Documented at :272-274, but it is an integration break, not an implementation detail.

### 3.6 `TegridyRouter.sol` — arithmetic anchored, wrapper drifted

Lowest risk of the four V2 forks. The math is line-for-line `UniswapV2Library`. Drift is in the wrapper: `MAX_DEADLINE` caps deadlines at 2 hours (:68, :77) where V2 only requires `deadline >= now` — the contract's own NatSpec at :44-53 lists CoW Protocol, 1inch Limit Orders, Safe multisig flows and 0x RFQ as incompatible. `_pairFor` (:538-542) resolves through `factory.getPair` and reverts `PairDisabled`, inheriting the freeze switch on every hop. `_validatePathNoCycles` (:476-488) is a novel O(n²) pre-check V2 does not have. Missing vs Router02: `removeLiquidityWithPermit` (the pair has no EIP-2612) and `removeLiquidityETHSupportingFeeOnTransferTokens` — **an LP in an FoT pair has no ETH-unwrapping exit.**

### 3.7 `TegridyStaking.sol` — Synthetix named, Synthetix's solvency invariant absent

The file cites `Synthetix StakingRewards` at :132/:2268/:2292 and `Curve veCRV` at :738/:1580, and calls itself "replacing TegridyFarm + VotingEscrow" at :82. **It inherits, forks and copies nothing from either.** That places it in section 4 as bespoke — but the citation pattern is the drifted-fork failure mode in prose form, so it belongs flagged here too. Details in §4.1.

## 4. Bespoke code holding real money

Ordered by value at risk.

### 4.1 `TegridyStaking.sol` + `lib/StakingRewardLib.sol` — 3,692 SLOC, live at `0xcaDc93E96De58EA554c71ca609974625615E046D`

**The single largest novel-code position in the repo.** Two retired instances at `addresses.json:288-289` **still hold user positions**.

**Synthetix's central solvency invariant is absent.** There is no `periodFinish`, no `lastTimeRewardApplicable()`, no `rewardsDuration`, no `rewardRate = (reward + leftover) / duration`. Repo-wide grep finds all four **only** in `TegridyLPFarming.sol`, never here. `notifyRewardAmount` (:2300) only pulls tokens and increments `totalRewardsFunded`; it never touches `rewardRate`, which is set independently by timelock via `applyRewardRate` (:2460). **Emission is unbounded by funding.**

The substitute is a per-accrual balance cap at `StakingRewardLib.sol:391-398`: `reserved = totalStaked + totalUnsettledRewards; if (reward > available - reserved) reward = available - reserved`. **That cap is not cumulative** — `reserved` never includes rewards already baked into `rewardPerTokenStored` but unclaimed — so across N accrual steps with no claims the contract can promise up to N× the free pool against a balance that never moved. Under-funding surfaces at claim time as the bespoke shortfall cascade.

`StakingRewardLib` cites a Synthetix "no silent forfeiture" pattern three times (:479, :543, :784) to justify the `maxUnsettledRewards` cap bypass. **Synthetix has no such pattern** — it has no forfeiture to be silent about, because `rewardRate` derives from what was actually funded. That citation is the trusted name doing work the code has not earned.

**Correction applied to the remediation scope.** The grader said porting the funded-period invariant makes "most of StakingRewardLib deletable." The challenger traced the call sites and is right that it does not. Every `unsettledRewardsByTokenId` credit funnels through `_creditByTokenId` (:278-288), and every call site sits inside an `_isTrackedHolder(...)` branch — :511-514, :562-566, :624-627, :640-644, :806-810. `_isTrackedHolder` (:290-300) returns true only for `restakingContract` or `isLendingContract[holder]`. **The three-level ledger exists to attribute rewards accrued while a staking NFT is escrowed inside restaking/lending back to its tokenId** (the library says so at :797-805, naming `PendingLendingResidue`/`PendingRestakingResidue` retirement gates). That requirement comes from making positions transferable-and-escrowable and **survives a Synthetix port untouched.** Also: `unsettledRewards[user]` is functionally Synthetix's `rewards[account]`, and the faithful version is in this repo at `TegridyLPFarming.sol:264, 291-295` — so "no upstream anywhere" was half wrong. Only `maxUnsettledRewards` flow-capping and per-(tokenId,holder) attribution are genuinely upstream-less.

**Correction applied — one grader finding is void.** The grader ranked "`votingPowerAtTimestamp` has no future-timepoint guard, so stake-then-vote in one transaction reads full power" as remediation #2, citing `GaugeController.sol:22` and `CommunityGrants.sol:15`. Those are **interface declarations, not call sites.** The challenger found the real callers: `lib/VotePowerOracle.sol:115/117` and `RevenueDistributor.sol:999/1885`. `VotePowerOracle.powerAt` carries the exact guard at `:114` — `require(ts < block.timestamp, "VPO_FUTURE_TS")` — semantically identical to OZ `Votes._validateTimepoint`, with a comment at :102-113 naming the flash-stake scenario as the reason. `GaugeController.sol:415-420` calls it with `epochStartTime(epoch) - 1`; `CommunityGrants.sol:473-475` with `proposal.snapshotTimestamp`; `RevenueDistributor` pins `snapshotTime = block.timestamp - 1` at :516. Both governance consumers additionally clamp `min(historical, current)` (`GaugeController.sol:421-422`, `CommunityGrants.sol:478-479`). **Stake-then-vote is not reachable. I dropped this finding.**

Two other real drifts remain: **ve decay** — Curve veCRV decays linearly to zero; here boost is fixed at stake time and drops on a cliff (`_decayIfExpired`, :739) that fires lazily, so a 4-year lock with one day left carries full 4.0× weight. And **ERC-721 positions** — Curve's non-transferability is a load-bearing security property; making positions transferable forced ~380 non-comment lines of novel invariant-critical code (settle-on-transfer, 24h `TRANSFER_COOLDOWN`, 1h `TRANSFER_RATE_LIMIT` at :124-125, the three-level IOU ledger, `MAX_POSITIONS_PER_HOLDER = 50`).

Also live and self-documented: `tokenURI` (:1853) returns `""` for every token — every deployed position renders blank on every marketplace.

**Fix: port `TegridyLPFarming.sol:277-292, 566-600` — 40 metres away in this same repo — rather than writing a third variant. Add a `ts < block.timestamp` guard to `votingPowerAtTimestamp` anyway as defence in depth, since the guard currently lives only in a caller.**

### 4.2 `RevenueDistributor.sol` — 806 SLOC, live at `0xF993316E2fC079de4358c489A935E01e03E23E17`

Claims "the Curve FeeDistributor auto-checkpoint pattern" (header :49-73, cited again at :566, :604, :972). Curve FeeDistributor is **Vyper** — no code can be shared across the language boundary. Category (c), inspired-by.

**The battle-tested Solidity upstream for exactly this exists and was not used: Velodrome V2 / Aerodrome `RewardsDistributor.sol`** — ve-checkpoint pro-rata fee distribution, nine figures, unhacked, ~200 lines. Not vendored (from-knowledge).

Curve's is week-aligned epochs, a `time_cursor`, `ve_supply[week]`, one payout token. Here: arbitrary-timestamp epochs pinned at `block.timestamp - 1` (:519); denominator from an external `totalBoostedStakeAtTimestamp` with a live-value catch fallback (:549-583); an **additive** restaking-power fallback summed into the numerator (:1006); per-epoch overdraw caps (:1019); a `claimedAtEpoch` settle seal (:1039); **owner claim-recovery paying against owner-attested historical power** behind a 48h delay (:1655-1840); forfeit-reclaim with a 1% lifetime cap (:1473-1524); dust sweep; token sweep; a `pendingWithdrawals` queue fed by a 10,000-gas push stipend (:880-890). All of it accounting or access control.

**It has already been wrong in production shape.** Lines 75-90 record REV-SWEEP-01 (HIGH, 2026-08): `sweepDust()` was "a byte-for-byte clone of `executeEmergencyWithdrawExcess` MINUS the `_execute()` call" — the owner could move the entire pre-distribution float to treasury with **delay 0 and no cap**, while the NatSpec claimed 48h timelock. Companion REV-RESERVE-01 (:490-508) over-reserved by `totalPendingWithdrawals` at five sites, stranding distributable revenue.

**Most urgent single action in this document: verify whether the deployed bytecode at `0xF993316E2fC079de4358c489A935E01e03E23E17` predates the REV-SWEEP-01 fix.** If it does, the owner currently holds an untimelocked drain of the entire undistributed float. I could not check deployed bytecode from this read-only local tree — this must be confirmed on-chain.

### 4.3 `SwapFeeRouter.sol` + `lib/SwapFeeRouterConvertLib.sol` — 1,106 SLOC live

The router itself is BESPOKE-JUSTIFIED (§6). The library is not. `SwapFeeRouterConvertLib` is deployed as a live DELEGATECALL library at `0x96A4Ed675eA203c4b4ae02F8Ad6D4f300Ee97295`, and `_readCurrentCumulative` (:424) **reconstructs `UniswapV2OracleLibrary.currentCumulativePrices` from scratch** — pair-native cumulative plus a spot×elapsed bridge — with `_enforceTWAPMinETHOut` (:471) building a UQ112x112 TWAP floor on top. **uniswap/v2-periphery is GPL-3.0 (this sentence originally said MIT — corrected 2026-08-27) and vendorable. It is not vendored.** This is a live slippage floor on a live money path, hand-derived. *(2026-08-27: vendored + re-anchored in source — see row 8; the deployed lib still runs the equivalent old bytecode until the next deploy.)*

Also actionable now: `recoverCallerCredit()` (`SwapFeeRouter.sol:1829`) is permissionless and has **never been called** — `addresses.json:253` records 2.4e12 of 3e12 lifetime wei parked in `ReferralSplitter.callerCredit`.

### 4.4 `TegridyTWAP.sol` — 514 SLOC, live, sole slippage floor for two money paths

**Correction applied, against the grader — and this one cuts both ways.** The grader said this is "a from-scratch reimplementation of Uniswap V3 core Oracle.sol" and should be replaced with it. The challenger, citing lines, shows that is not transplantable: V3's Oracle is a **pool-internal** library whose observations are written by the pool inside its own swap, storing `tickCumulative` and `secondsPerLiquidityCumulativeX128` derived from V3 ticks and in-range liquidity. `TegridyPair` is constant-product and produces UQ112x112 **price** cumulatives only — `TegridyPair.sol:66-67` declares `price0CumulativeLast`/`price1CumulativeLast` and :527-530 is the only accumulator write. **There is no tick and no per-liquidity accumulator for V3's Oracle to consume**, and no path for an external observer to invoke V3's `write()`/`observe()` against a pair it does not control. "Port V3 Oracle.sol" means "replace the AMM." **I took the challenger.**

The honest framing: **the ~100 SLOC ring buffer is unavoidable bespoke** — `MAX_OBSERVATIONS = 48` (:95), linear nearest-at-or-before scan at :1459-1484. v2-periphery's `ExampleSlidingWindowOracle` is the only transplantable shape, and it is explicitly *example* code, never audited as production, never having custodied nine figures — it fails the operator's own bar too.

**The ~400 SLOC policy stack is the indefensible part, and none of it has any upstream at all:** owner-only bootstrap for observations #1-#4 (:674, :745, :771 — a permissionless oracle whose bootstrap is a 45-minute manual owner ritual), a per-observation `bypassed` flag that makes `consult()` fail closed (:1489), a 2000-bps per-step deviation gate (:775, :788), dual-side reserve floors re-checked at both `update()` and `consult()` (:574-578, :1050-1055), and an update fee whose failed 30k-gas refund is **banked as protocol income** (:537-548).

Two weaknesses are self-documented rather than fixed: :879-889 records a KNOWN-DEFERRED MEDIUM (Spartan 2026-07-22) — a sole successful keeper can ratchet `lastSpot` via same-block manipulate/update-at-19.9%/unwind until honest updates revert `PriceDeviationTooLarge` and `consult()` ages to `StaleOracle`. :1544-1557 records an unfixed year-2106 wrap.

1,580 raw lines carrying 514 SLOC, with fixes named F-24-1, F-46-1, F-74-11, H-TWAP-OBS4-UNGATED, PASS7-TWAP-01, FRESH-2026 layered on each other. **Each gate was bolted on to patch an interaction the previous gate created.** Two consumers, both on the money path: `POLAccumulator.sol:844, 895, 988` and `TegridyLending.sol:2121, 2152`.

**Fix: delete the ~400 SLOC policy stack, keep the plain V2 sliding-window observer, source Chainlink feeds for assets that have them (the repo already integrates Chainlink at `lib/SequencerCheck.sol`), and pin consumers to the spot-vs-TWAP-bounded read that `POLAccumulator._assertSpotNearTWAP` already implements at 50bps — that bound is the real safety property.**

### 4.5 `ReferralSplitter.sol` — 506 SLOC live

**Correction to the starting hint, verified on disk:** OZ `PaymentSplitter`, `PullPayment` and the `Escrow` contracts are **absent** from the vendored OpenZeppelin (5.6.1; they were removed in OZ v5). `find contracts/lib/openzeppelin-contracts -iname '*PaymentSplitter*' -o -iname '*Escrow*' -o -iname '*PullPayment*'` returns nothing. "Use OZ PaymentSplitter" is not an available option, and its fixed-payee static-share shape does not fit a per-user referrer mapping. GMX `ReferralStorage` is a code/tier registry only — it never custodies or splits fees.

So the provenance is defensible. **The problem is policy volume on a live ETH path.** `recordFee` (:390) alone branches across dust routing, caller-credit pull, an additive staking+restaking qualification read with two independent try/catch degradations, and a ban check. Around it: 30-day `REFERRER_COOLDOWN`, 7-day `MIN_REFERRAL_AGE`, 90-day `FORFEITURE_PERIOD`, 7-day `BELOW_STAKE_GRACE_PERIOD` with a separate owner-armed `forfeitureArmedAt` anchor, circular-referral detection (:350), and a 24h-timelocked ban/unban ceremony. Each added by a numbered finding.

**Fix: cut policy, don't re-anchor. The forfeiture/ban/below-stake machinery (~200 SLOC, :709-908) guards a lifetime fee line currently around 3e12 wei and is not worth its own risk.**

### 4.6 `SwapFeeRouterAdmin.sol` — 374 SLOC live, unforced

Built on `base/TimelockAdmin.sol`, advertised across the cluster as "MakerDAO DSPause pattern (billions TVL, never compromised)" (e.g. `ReferralSplitter.sol:36`). DSPause is not vendored — that lineage is from-knowledge, and it is a claim of *inspiration*, not shared code, so it inherits **none** of DSPause's audit history.

**The upstream is vendored and unused: `contracts/lib/openzeppelin-contracts/contracts/governance/TimelockController.sol`, 470 lines, OZ 5.6.1, on disk in this tree.** The missing piece is role separation: TimelockController splits PROPOSER / EXECUTOR / CANCELLER; here every triplet is `onlyOwner`, so one key proposes, executes and cancels. **A compromised owner's only cost is waiting out the delay it chose.**

`TimelockAdmin` has two further structural weaknesses. Compound queues a **hash** of `(target, value, signature, data, eta)`, binding the queued action to what executes. `TimelockAdmin` queues only a `bytes32` key plus a timestamp; the pending value lives in a plain child storage slot. Binding is preserved only **incidentally** — every `propose*` writes the pending slot then calls `_propose`, which reverts `ExistingProposalPending`, rolling the write back. Correct today; breaks silently if a future propose path writes its slot after `_propose` or short-circuits instead of reverting. And `_executeAfter` is `internal` rather than `private` (`TimelockAdmin.sol:135-160`), so a child can direct-write zero and skip the `ProposalCancelled` event — the file's own comment says the defence is a review convention and recommends a CI lint that does not exist.

### 4.7 `POLAccumulator.sol` — 525 SLOC live, currently receiving nothing

Bespoke additions are defensive, not accounting: `ACCUMULATE_COOLDOWN`, a fixed-window 24h `dailyETHCap` with saturating-subtraction guard (:407), a `SequencerCheck` gate, `_assertSpotNearTWAP` (:804), and TWAP-derived `minOut` floors that can only be **tightened** by the caller (:867, :913). The swap and liquidity-add legs are delegated to the deployed Router02 (:437, :476). Named candidates all fail the operator's own test: OlympusDAO's bond/treasury stack is not unhacked (BondFixedExpiryTeller, ~$300k, Oct 2022); Frax AMOs are an architecture, not a library; Zapper/Beefy-family zaps have been exploited repeatedly.

**Its risk is its dependency, not its code.** The sole attacker-independent slippage floor on both legs comes from `ITegridyTWAP` (§4.4), and DEEP-DR-M-08 already removed the derived floors after finding they degraded together with the attacked spot price. **`addresses.json:253` confirms `polShareBps` is 0 today — this contract currently receives nothing. Keep it at 0 until TegridyTWAP is fixed.**

## 5. Bespoke code NOT yet deployed — the quick wins

Replacing these costs a deploy, not a migration.

### 5.1 `StreamingRevenueDistributor.sol` (358 SLOC) — delete the forfeit path

Covered in §3.3. Two measured theft vectors on trunk (P1 stranger-executed grace-anchor rollback, P2 22× amplification). **Synthetix has no forfeit — unclaimed rewards simply sit. Returning to the upstream's shape kills attempts 1 through 5 outright.** Highest value-per-effort item in the entire document.

### 5.2 `TegridyRestaking.sol` (925 SLOC) — the cheapest large risk reduction

**The LSD comparators do not apply and I want to say so plainly.** There is no share/receipt token, no exchange rate, no validator or operator set, no delegation, no slashing, no withdrawal queue, no oracle. EigenLayer `StrategyManager`/`DelegationManager`, Lido stETH+WithdrawalQueue, and Rocket Pool rETH/minipools are category errors against this file. What it actually is: a single-position vault custodying a `tsTOWELI` NFT and streaming a second reward token. The accrual core is MasterChef V2 — `accBonusPerShare` + per-user `int256 bonusDebt` + 1e18 precision + accrue-on-touch (:116, :140-148, :2374-2403). The `int256` (not `uint256`) debt is MasterChefV2's specific signature. Not vendored; category (c).

**MasterChefV2's accumulator is ~40 lines. Here it carries ~900, and all of it traces to one architectural choice:** the reward share (`info.boostedAmount`) is a **cached copy of state owned by TegridyStaking that decays lazily**. MasterChef's share is the deposit itself and cannot go stale. Every path must therefore re-derive the same five-step dance — settle old boost at pre-accrue `accBonusPerShare`, anchor `bonusDebt` before transfer, shrink `totalRestaked`, `_accrueBonusChecked` against the corrected denominator, re-anchor debt post-accrue. **That dance is hand-written six times:** `refreshPosition` (:892), `claimAll` stale branch (:1001-1046), `unrestake` stale branch (:1140+), `decayExpiredRestaker` (:2237-2360), `_revalidateBoostCore` (:2130), and the post-`getReward` autoMaxLock re-sync (:1077-1113).

**Quantified: 175 AUDIT/SECURITY-FIX/REVIEW markers and ≥53 distinct finding IDs across 925 SLOC — one recorded finding per 17 lines.** Several are self-described regressions *of* earlier fixes: :744 calls the DR2-02 carve-out "a NET REGRESSION" that reopened DR-04; F-1 fixes a silent under-credit that DR-04's own fix introduced; R014 is labelled "RETRY"; DEEP-DR-02 records that `emergencyForceReturn` was "the ONLY NFT-exit path that omitted" the principal release; BATCH-C H4 records a 2× double-vote through VotePowerOracle because state was cleared after the ERC721 callback instead of before. **That is the empirical signature of a mechanism never solved once.**

Solvency is hand-rolled too: `_accrueBonus` caps emission at `balanceOf(this) - totalUnforwardedBonus`, and the doc at :565-573 concedes the "donations welcome" consequence — any direct transfer is silently distributed and `totalBonusFunded` does not track it. **That is exactly the balance-reading footgun Synthetix avoids by tracking `rewardRate`/`periodFinish` instead of reading balances.** And `_accrueBonus` is deliberately `virtual` with `_accrueBonusChecked` as a monotonicity tripwire, described at :2371 as "bait for misbehaving subclasses" — a novel invention that adds an override surface in order to guard the surface it added.

**Not live — but "deployed nowhere" is not quite right and the operator should know.** `frontend/src/lib/constants.ts:27` sets the address to zero and :23-26 gates deploy on external re-audit plus a real Safe; `useRestaking.ts:14` gates every read/write on `isDeployed()`. **However `addresses.json` carries three TegridyRestaking CREATEs in `retiredDeploys`:** `0xfE2E5B534cfc3b35773aA26A73beF16B028B0268` (:360-364), `0xeD73D8836D04eab05C36a5c2DaE90d2a73F8eC76` (:375-379), `0xfba4D340759Ae4c36DfFC6C773D171bf7BDCaEe4` (:469-473). Those are older bytecode — current source only became deployable after the 2026-08-19 EIP-170 split. `addresses.json:308-310` warns some retired deploys "still hold dust or stale state." **Check those three for residual balances and stale approvals before the re-audit.**

Also: the restaking hook is wired into **live** contracts as `address(0)` — `GaugeController.sol:132`, `CommunityGrants.sol:68`, `lib/StakingRewardLib.sol:105/296/309`, `v2/StreamingRevenueDistributor.sol`. The un-deployed state is itself a live default in other contracts' logic.

**Fix: rebase bonus accrual on the Synthetix port this repo already owns (`TegridyLPFarming.sol:46-55`), then delete the mirrored share entirely by having accrual read `staking.boostedAmountAt()` live rather than caching `info.boostedAmount`. That erases all six stale-path reconciliations and the root cause behind most of the 53 findings, and it costs a rewrite with no migration.**

### 5.3 `TegridyRestakingAdmin.sol` (228 SLOC) — move onto OZ TimelockController before deploy

Better-written than the host, and honest about its limits: no funds, no pausable surface, no callback (:48-54); `executeRescueNFT` clears the proposal before calling the host (correct CEI across the split seam); `acceptOwnership` sweeps all four timelock keys so a compromised outgoing key cannot leave a booby-trap.

**The risk is the seam.** Three things: every pre-check here is advisory and the file says so (`proposeAttributeStuckRewards`' tokenId check can go stale in the 24h window; `proposeRescueNFT`'s three live-claim guards are re-checked host-side) — the sister must never be read as authority. Authority is only equivalent if the **same** multisig owns both addresses, and `TegridyRestaking.sol:1793-1798` states handoff must be performed on both or one side is left with proposals queued under the outgoing owner — while `constants.ts` records the MULTISIG Safe as still pending. And per-tokenId residual clears are not enumerable and explicitly not swept on handoff, so an incoming owner must triage one tokenId at a time with no on-chain list. Governance events also moved address, so any indexer filtering by host address silently stops seeing proposals.

**Fix at `base/TimelockAdmin.sol`, which `TegridyStakingAdmin` and `SwapFeeRouterAdmin` share — not here alone. Keep the sister split (EIP-170 forces it) but put OZ `TimelockController` underneath with this contract holding only the proposer role.**

### 5.4 `RestakingMonitorView.sol` (65 SLOC) — one duplicated invariant

`pendingBonus` (:46-69) re-implements the host's `_accrueBonus` cap-and-accrue math rather than calling it. Two copies of one formula; change the host and this view lies with no compiler error. It already diverges: it settles against `boostedAmountAt(user, block.timestamp)` while the host settles `claimAll` against `info.boostedAmount`, and the host's `_boostedAmountAt` clamps to `min(cached, current)` inside the kick window (`TegridyRestaking.sol:740-777`) — so `pendingBonus` can under-report what `claimAll` pays. Display-only, zero on-chain consumers, so UX defect not fund loss.

**Doc hazard for whoever runs the re-audit: `docs/TODO_OPERATOR.md:964` and `:1179` attribute `_effectivePower`/`isSynced` findings to `RestakingMonitorView`. Those functions do not exist in that file — they live in `src/v2/StreamingRevenueDistributor.sol:419/443/487`. An auditor following the doc opens the wrong file. Fix the doc before handing over.**

## 6. Where bespoke is genuinely justified

Saying this plainly is what keeps the rest credible.

**`lib/TegridyFactoryLib.sol` (46 SLOC) — no upstream exists.** This is an EIP-170 bytecode split, not a mechanism. No protocol publishes a "move your creationCode blob into a linked library" contract. Two honest caveats rather than drift: the ERC-165/`granularity()`/ERC-1820 probing is best-effort by construction (:38-40 says so) and bypassable by a token omitting ERC-165; the `granularity()` probe (:58-63) rejects any non-ERC-777 token whose fallback returns 32+ bytes. **Only ask: stop treating `_rejectERC777` as a security control — it is a speed bump, and `TegridyPair.sol:36-40` already correctly says ERC-777 is unsupported rather than blocked.**

**`lib/SequencerCheck.sol` (454 lines, ~120 SLOC) — fine as-is.** Detailed in §2. Reported here for completeness because the grader referenced its behaviour without grading the library, and the skip should not read as one-sided.

**`base/PauseGuardian.sol` — bespoke, justified, but should have been named.** `TegridyStaking.sol:100` reads `contract TegridyStaking is SoladyERC721, OwnableNoRenounce, ReentrancyGuard, Pausable, PauseGuardian`. It carries live privileged state (`address public pauseGuardian`, :45) and the `onlyPauseGuardian` modifier (:98-101) gating `TegridyStaking.sol:987 guardianPause()` — **a permissioned halt on the repo's largest live contract.** The upstream exists on disk: OZ `AccessControl.sol`, which is the actual mechanism behind Aave V3's `EMERGENCY_ADMIN_ROLE` that `PauseGuardian.sol:25` cites as its pattern of record. Verdict stands as justified — the mixin is ~12 lines and OZ AccessControl would cost bytecode on a contract pinned at the EIP-170 ceiling — **but a bespoke pause role on a live contract is exactly what this audit was asked to enumerate, and the grader skipped it. Correction applied.**

**`TegridyStakingJbacVault.sol` (132 lines, 65 SLOC) — the healthiest contract graded, with one caveat.** Two immutables set at deploy; `returnJbac` gated `onlyStaking`; `claimStrandedJbac` gated by the per-tokenId stranded record and `nonReentrant`; `onERC721Received` gated to `msg.sender == jbacNFT`. The try/catch stranding pattern (:89-98) plus the host's outer try/catch in `_clearPosition` (`TegridyStaking.sol:2698-2707`) means a reverting or paused JBAC contract cannot brick a staker's exit — the correct trade. Staking tokenIds are monotonic and never reused, so stranded mappings cannot collide. OZ `ERC721Holder` is the wrong fit: it accepts any ERC-721 from anyone, which is precisely what this must not do. ApeCoin Staking's physical-deposit pattern is the named model (`TegridyStaking.sol:1063` cites it as why JBAC is escrowed rather than `balanceOf`-checked, the latter being flash-loanable).

**Caveat the challenger found and the grader's end-to-end read missed:** `onERC721Received` (:124-130) gates only on the **collection**. Any JBAC sent to the vault by anyone, from any path other than `TegridyStaking.sol:1130`, is accepted and then **permanently unrecoverable** — `returnJbac` is `onlyStaking` (:87-89) and only ever invoked with a Position's recorded `p.jbacTokenId` (`TegridyStaking.sol:2663`) or a stranded record (:726); `claimStrandedJbac` (:110) requires a `strandedJbacOwner` entry only the catch branch at :96-100 can create; the vault has no owner, no sweep, no admin. JBAC is a live third-party 5555-supply collection (`addresses.json:290`). **"Healthiest in the cluster" stands, but a mis-sent JBAC is burned. Add an ownerless rescue keyed on the vault holding a tokenId no live Position references, or document the hazard.**

**`lib/StakingViewLib.sol` (202 SLOC) and `StakingMonitorView.sol` (173 SLOC) — no upstream for "read-only mirror of your own protocol's math."** Zero write paths, so even under delegatecall in the host's storage context they cannot corrupt state.

**Correction applied:** the grader flagged that `earned` (storage variant) and `earnedFromMem` (memory variant) are two bodies that must both receive any future fix. The challenger grepped: **there is no invocation of `StakingViewLib.earned(` anywhere in `contracts/src`** — only comments at `TegridyStaking.sol:877, 1324, 2624`. :877-878 says it plainly: the storage variant "remains for any future in-contract use; the sibling uses the memory variant." `StakingMonitorView.sol:71-81` calls `earnedFromMem`, which is `internal` and therefore inlined, not delegatecalled. The two bodies (:132-158 vs :167-200) are currently identical including the `v > uint256(type(int256).max)` guard. **The hazard is inert today — one live body, not two.** Worth noting only because `StakingViewLib` is a deployed library (`addresses.json:286`) carrying a public entrypoint nothing calls.

The real coupling hazard is the other one: `StakingMonitorView` reconstructs `Position` from the public mapping's auto-getter tuple (:10-23), so **any same-arity reorder of like-typed fields in `StakingViewLib.Position` silently mis-decodes** and the compiler catches nothing.

**`TegridyStakingAdmin.sol` (300 SLOC) — declining OZ TimelockController here was defensible.** TimelockController's arbitrary-call model is a strictly larger blast radius than five typed, ceiling-checked parameter setters. All five parameters carry 48h delays and a 7-day validity window; ceilings are enforced on both sides (admin :115 checks `staking.MAX_REWARD_RATE()`, staking re-checks at :2461 — good belt-and-braces). No funds custody, no user-facing surface. **The `TimelockAdmin` base weaknesses in §4.6 still apply and should be fixed there.**

**`SwapFeeRouter.sol`'s wrapper leg (795 SLOC) — the "1inch/Paraswap aggregator fee model" has no vendorable upstream contract**, and the file correctly self-describes it as such. Its swap execution is delegated to deployed Router02. Only `SwapFeeRouterConvertLib` (§4.3) needs re-anchoring.

**`ReferralSplitter.sol` — provenance is defensible (§4.5).** No upstream exists. The issue is policy volume, not lineage.

**`LockerClaimer.sol` (45 SLOC) — no upstream exists.** The problem — "be an address that can be *named* as beneficiary of a pull-based, self-addressed fee locker and can itself *originate* the `releaseFees` call" — is specific to Doppler's `StreamableFeesLocker` paying `msg.sender` only. Dependencies used unmodified: OZ `ReentrancyGuard` and Solady `SafeTransferLib` (submodule clean at `acd959aa`, v0.1.26). The counterparty at `0xe24FC2F7191e850e2D4514aBb4d39305b1871eC6` is third-party Doppler and the interface was verified against deployed runtime by `eth_getCode` + selector scan (:8-15). **This is the one file that both uses Solady's SafeTransferLib correctly and verified its counterparty ABI against bytecode. It is the template.**

## 6b. Row 0, answered in part — the float is currently ZERO

The remediation list opens with "verify whether the owner holds an untimelocked drain of the entire
undistributed ETH float, before anything else." Half of that is answerable from a read, and it was
done 2026-08-26 against mainnet (`eth_getBalance`, publicnode):

```
RevenueDistributor  0xF993316E2fC079de4358c489A935E01e03E23E17
  ETH balance : 0.0 ETH
  code bytes  : 22,926
  keccak(code): 0xa50deedb03bdd537f7203ed77b2338d8592b2cf77d5e86a50ec9ef83921ad864
```

**There is nothing to drain today.** That does not retire the finding — it re-prices it. This is a
*fix-before-it-holds-money* item, not an incident, and the honest sequencing follows from that:

- It stops being free the moment the fee rail starts remitting here. `ReferralSplitter.callerCredit`
  already holds ~2.4e12 wei that `recoverCallerCredit()` would move (remediation row 16), and the
  swap-fee rail is the thing being switched on.
- The second half of row 0 — does the *deployed* bytecode actually contain the untimelocked
  path — is still open and needs a compile-and-compare against the source at the deploy commit,
  not a read. The code hash above is the fixed point to compare against.

Treat row 0 as **blocking the first ETH remittance into this contract**, not as blocking today.

## 6c. Row 7, answered 2026-08-27 — and upgraded from "vendor" to "fail on drift"

The row asked for submodules. Vendoring alone would have put canonical V2 on disk without making
anyone diff against it — the drift-invisibility this document complains about would have survived
the fix. What shipped is the stronger mechanism:

- **`contracts/provenance/upstream/`** — canonical `Uniswap/v2-core@6a9e7c97` and
  `Uniswap/v2-periphery@ed249913` sources (Pair, Factory, ERC20, Math, UQ112x112, Router02,
  UniswapV2Library, UniswapV2OracleLibrary), **sha256-pinned** in `upstream.lock.json` so the
  copies cannot be quietly edited. Tracked files rather than submodules on purpose: the pin is a
  content hash instead of a gitlink, no per-worktree clone multiplication (this machine runs many
  worktrees), and the checker needs no network in CI.
- **`scripts/check-v2-provenance.mjs`** + the `Contracts CI / v2-provenance` job (pull_request
  via the scope job; result read explicitly in `all-tests-pass`): normalizes both sides (comments,
  pragma, formatting, quote style, whole-word rename table, `uint`/`now` aliases, upstream's
  `"UniswapV2: "` revert prefix) and requires the recomputed diff to **byte-match** the pinned
  snapshots in `contracts/provenance/expected/`. Any semantic edit to the three contracts goes red
  until deliberately re-pinned — mutation-verified (a 997→996 fee edit fails with a 2-line delta;
  a comment-only edit passes; tampering a vendored copy, smuggling an unpinned file, or forging a
  snapshot all fail).
- **`contracts/provenance/PROVENANCE.md`** — the named allowlist: every deliberate divergence with
  a one-line rationale and the pinning test, separately for the fee switch (D1), the
  **kLast/harvest lifecycle** (D2 — pinned *as shipped*, explicitly not blessed; row 9 stays open),
  and the guardian hooks (D3), plus full per-contract catalogs (D4-D6).

Rows 8 and 9 are now mechanically startable: `UniswapV2OracleLibrary.sol` is vendored + pinned for
row 8, and row 9's revert-to-canonical would surface in the snapshot delta as the D2 hunks
disappearing. §3.4/§3.5/§3.6's "reasoned from memory" caveat no longer applies to future changes.

## 7. The remediation list

Ordered by (value at risk × novelty) / effort. **Pre-deploy** rows cost a deploy; **Live** rows cost a migration.

| # | Contract | Adopt / do | Cost | Buys | Stage |
|---|---|---|---|---|---|
| 0 | `RevenueDistributor.sol` | **Verify deployed bytecode at `0xF993316E2fC079de4358c489A935E01e03E23E17` predates REV-SWEEP-01 or not** | One `eth_getCode` + compile compare | Resolves whether the owner holds an untimelocked drain of the entire undistributed ETH float. Do this before anything else. | Live |
| 1 | `StreamingRevenueDistributor.sol` | Delete forfeit/recycle entirely (Synthetix has none); make `_updateReward` refuse to write a non-readable zero | ~80 SLOC deleted, one guard added | Kills P1 (stranger-executed grace rollback) and P2 (22× amplification) and attempts 1-5 outright | **Pre-deploy** |
| 2 | `TegridyStaking.sol` + `StakingRewardLib.sol` | Port `TegridyLPFarming.sol:277-292, 566-600` — `periodFinish`, `rewardsDuration`, `rewardRate = (reward+leftover)/duration`, gate accrual on `lastTimeRewardApplicable()` | Rewrite of the accrual core + migration of live positions across 3 instances | Emission bounded by funding. Kills the non-cumulative cap and the shortfall cascade. **Does NOT delete the escrow ledger** (that is gated on `_isTrackedHolder`, not on funding) | Live |
| 3 | `WETHFallbackLib.sol` | Solady `SafeTransferLib.safeTransferETH` (:95) for plain legs; `trySafeTransferETH(to, amount, GAS_STIPEND_NO_GRIEF)` (:179, :52) + wrap for fallback legs. Strike the Solmate/Aave/Convex header attribution | ~60 SLOC replaced; upstream already vendored | Removes silent ETH→WETH asset-type swaps on 11 money paths, including the one that makes `SwapFeeRouter.recoverCallerCredit` read `recovered == 0` | Live (library, so redeploy + relink) |
| 4 | `TegridyRestaking.sol` | Rebase bonus accrual on `TegridyLPFarming`'s Synthetix port; **delete the mirrored `info.boostedAmount` and read `staking.boostedAmountAt()` live** | Rewrite, **zero migration** | Erases all six hand-written stale-path reconciliations and the root cause behind most of the 53 findings | **Pre-deploy** |
| 5 | `TegridyTWAP.sol` | Delete the ~400 SLOC policy stack; keep the ring buffer and the correct V2 `currentCumulativePrices` bridge (:601-614); source Chainlink where feeds exist; pin consumers to `_assertSpotNearTWAP`'s 50bps bound | Large deletion, small addition | Removes owner-gated bootstrap, the `bypassed` fail-closed flag, the fee-refund income leg, and the deviation-ratchet DoS. **Do not attempt V3 Oracle.sol — it is not transplantable onto a constant-product pair** | Live |
| 6 | `base/OwnableNoRenounce.sol` | Drop the 14-day `acceptOwnership` expiry (:50, :182-190); document the zero-address-cancel removal (:170) at every child's call site | ~10 SLOC | Removes a handoff-brick path on every contract in the repo, including the two-address restaking split | Live (inherited — sequence carefully) |
| 7 | **✅ DONE 2026-08-27 (see §6c)** — canonical V2 vendored hash-pinned + a CI gate that FAILS on any un-pinned drift (`contracts/provenance/`, `scripts/check-v2-provenance.mjs`, `Contracts CI / v2-provenance`) | Both **GPL-3.0** (this doc said MIT — corrected 2026-08-27 from the LICENSE files at the pinned commits) | Shipped | Makes `TegridyPair`/`Factory`/`Router` reviewable as a **diff** at every future change instead of reasoned from memory — and makes un-reviewed drift a red check. Enables #8 and #9 | Repo-level |
| 8 | `lib/SwapFeeRouterConvertLib.sol` | **✅ SOURCE RE-ANCHORED 2026-08-27** — `_readCurrentCumulative` now delegates to `src/lib/UniswapV2OracleLibrary.sol`, a verbatim 0.8 port that is itself a v2-provenance diff target (see `contracts/provenance/PROVENANCE.md` D7); equivalence + wrap semantics mutation-tested in `Audit_SFR_H01.t.sol` ROW8 suite. ⚠️ The LIVE delegatecall lib at `0x96A4Ed67…` still runs the old (equivalent) bytecode — the re-anchor rides the next SwapFeeRouter-stack deploy | ~40 SLOC, after #7 | Removes a hand-derived slippage floor from a live delegatecall library | Live |
| 9 | `TegridyPair.sol` | Restore unconditional `if (feeOn) kLast = uint(reserve0)*uint(reserve1)` in `mint`/`burn`; delete `harvest()`; full diff against pinned v2-core | Medium, after #7 | Protocol fee self-heals; deletes ~50 SLOC of bespoke fee lifecycle. **Note: the `harvest()` bootstrap gate is the problem it was invented to solve** | Live |
| 10 | `SwapFeeRouterAdmin.sol` + `base/TimelockAdmin.sol` | OZ `TimelockController` (already on disk) as owner of `SwapFeeRouter`; Safe as PROPOSER, separate CANCELLER. Keep bounds asserts as `onlyAdmin` guards | Low — upstream is vendored | Splits propose/execute/cancel so a single compromised key cannot self-approve | Live |
| 11 | `TegridyRestakingAdmin.sol` | Same as #10, fixed at `TimelockAdmin` so all three admins inherit it | Low | Role separation before first deploy | **Pre-deploy** |
| 12 | `ReferralSplitter.sol` | **Cut, don't re-anchor:** delete forfeiture/ban/below-stake (~200 SLOC, :709-908) | Deletion | Removes 200 SLOC of novel policy guarding ~3e12 wei of lifetime fees | Live |
| 13 | `TegridyFactory.sol` | Move `blockedTokens`/`disabledPairs` behind an immutable circuit-breaker contract; **restate docs as four timelock keys plus one hand-rolled `feeToSetter` path** (:130, :352-362, :419-424) | Medium | A bug in 320 SLOC of bespoke timelock/guardian/flush code can no longer reach into every swap. `feeToSetter` gates the pair's `kLast` bootstrap and currently bypasses the shared timelock | Live |
| 14 | `TegridyStakingJbacVault.sol` | Ownerless rescue for a JBAC the vault holds that no live Position references, or document the burn hazard | ~20 SLOC or one doc line | Stops mis-sent third-party NFTs being permanently destroyed | Live |
| 15 | `TegridyRouter.sol` | After #7, reduce to a thin wrapper inheriting `UniswapV2Router02`. Either lift `MAX_DEADLINE` (:68, :77) or stop advertising aggregator compatibility (:44-53). Add `removeLiquidityETHSupportingFeeOnTransferTokens` | Medium | LPs in FoT pairs get an ETH exit; router math stops being restated | Live |
| 16 | Housekeeping | Call `SwapFeeRouter.recoverCallerCredit()` (:1829, permissionless, never called — 2.4e12 of 3e12 wei parked); check the three retired `TegridyRestaking` addresses for residual balances; fix `docs/TODO_OPERATOR.md:964`/`:1179` mis-attribution; wire `tokenURI` (`TegridyStaking.sol:1853` returns `""` for every live position) | Hours | Recovers stranded funds, stops the re-auditor opening the wrong file | Live |
| 17 | Test debt | Assert `earned(tokenId) == earnedFromMem(...)` over fuzzed positions; pin the `Position` tuple in `StakingMonitorView` with a round-trip test; demote `TimelockAdmin._executeAfter` to `private` and add the CI grep the file already recommends | Test-only | Turns three documented review conventions into enforced ones | Any |

**Where I had to choose between grader and challenger,** I took the side citing line numbers in every case: the `FOT_OUTPUT` mechanism (challenger — `>=` not `==`, `TegridyPair.sol:324-336`), the factory's key count (challenger — four keys, `:24/:25/:26/:33`), `votingPowerAtTimestamp` (challenger — the guard exists at `VotePowerOracle.sol:114`; **finding dropped entirely**), the V3 Oracle recommendation (challenger — not transplantable onto a constant-product pair), `OwnableNoRenounce` (challenger, twice independently — FORK-DRIFTED, not ANCHORED), `StakingRewardLib`'s deletable scope (challenger — the ledger is escrow-gated, not funding-gated), and `StakingViewLib`'s dual-body hazard (challenger — inert, zero callers). Three contracts the grader skipped are now graded: `WETHFallbackLib`, `SequencerCheck`, `PauseGuardian`.

## 8. The rule for new code

1. **Before writing a mechanism, grep `contracts/lib` and this repo for it.** OZ `TimelockController`, Solady `forceSafeTransferETH`, and a faithful Synthetix `StakingRewards` port (`TegridyLPFarming.sol`) were all already on disk and all three were reimplemented anyway. If it is on disk, use it; if it is MIT and not on disk, vendor it as a submodule so every future change is a reviewable diff.
2. **Fork only at the hooks the upstream published.** Extending Solady's `_beforeTokenTransfer` is anchored; overriding OZ's `acceptOwnership` is drift. If your change touches accounting, access control, reentrancy or math inside a function the upstream's audits describe, you now own that function and must say so in the header.
3. **A comment naming a protocol is a claim of shared code, not inspiration.** Either the file imports that upstream — cite the on-disk path and commit — or the name comes out of the header. `WETHFallbackLib` cited Solmate, Aave and Convex while sharing zero lines with any of them; `StakingRewardLib` cited a Synthetix "no silent forfeiture" pattern that does not exist. Those citations bought audit credibility the code had not earned.