# Agent 033 — Fee-on-Transfer / Rebasing Token Forensic Audit

**Mission:** identify accounting bugs from FOT (fee-on-transfer) / rebasing token interactions across `Toweli` consumers and any token-agnostic contract.
**Mode:** AUDIT-ONLY — no source edits.
**Pragma:** `^0.8.26` for all targets.

---

## Executive Summary

Counts: **HIGH 0 | MEDIUM 2 | LOW 5 | INFO 6**

**Critical baseline finding:** `Toweli.sol` (`contracts/src/Toweli.sol:27`) is a fixed-supply OZ `ERC20 + ERC20Permit` with **no tax / fee / rebase logic** — see line 42 confirms total contract is the constructor only. All "Toweli has tax logic" assumptions in the prompt are **incorrect**. Threats from FOT/rebase against TOWELI specifically are *structurally absent*.

The audit therefore re-scoped to: (a) **token-agnostic** contracts that accept user-supplied tokens (deposit/bribe/swap/farm); (b) **immutable rewardToken/stakingToken** contracts whose constructor accepts an arbitrary `IERC20` and could in principle be paired with a non-Toweli FOT token in a future deploy; (c) Pair-level FOT input/output handling and skim/sync abuse.

The code is **mostly defensive-by-design**. `VoteIncentives.depositBribe`, `SwapFeeRouter.*`, `TegridyLPFarming.notifyRewardAmount`, and `TegridyRestaking` reward-funding paths all use the **balance-diff pattern** (`balBefore` / `balAfter - balBefore`). `TegridyPair.swap` has explicit `FOT_OUTPUT_0` / `FOT_OUTPUT_1` post-swap balance assertions (see `TegridyPair.sol:243-244`). `TegridyRouter` exposes the V2 `*SupportingFeeOnTransferTokens` family and documents exact-output as FOT-incompatible (`TegridyRouter.sol:218-227`).

The two MEDIUM findings cluster around **asymmetric FOT handling** — a few stake/deposit sites record `_amount` rather than the actual delivered delta, while the *funding* path on the same contract uses balance-diff. With TOWELI as the canonical token this is benign, but the asymmetry is a footgun if these contracts are ever cloned for a non-TOWELI deploy (e.g., a community-fork or sidechain re-deploy paired with a FOT staking token).

---

## Per-Contract Triage Table

| Contract | Role | FOT-aware? | Risk | Top finding |
|---|---|---|---|---|
| `Toweli.sol` | Token | N/A (no fee logic) | None | Threat absent by design (see `016_Toweli.md`) |
| `TegridyPair.sol` | AMM | Output: yes (line 243-244). Input: implicit-safe (uses `balance - reserve` deltas). | Low | Skim is permissionless; FOT-input safe via balance-diff; FOT-output reverts. |
| `TegridyRouter.sol` | Swap routing | Yes — exposes `*SupportingFeeOnTransferTokens` variants | None | Exact-output paths documented as FOT-incompatible (line 218-227). |
| `SwapFeeRouter.sol` | Fee aggregator | Yes (lines 408-414, 542-546, 663-674, 1151-1166) | None | Comprehensive balance-diff + FoT-aware swap paths. |
| `TegridyStaking.sol` | Lock+stake | Mixed — `stake()` records `_amount`; `notifyRewardAmount` records `_amount`. **No balance-diff.** | **MEDIUM** | M-01 below |
| `TegridyLPFarming.sol` | LP farm | `notifyRewardAmount` is FOT-aware (lines 390-392). `stake()` records `amount` without balance-diff (line 263). | **MEDIUM** | M-02 below |
| `TegridyLending.sol` | NFT-collateral lending | ETH/WETH only — no ERC20 pull | None | No FOT surface. |
| `TegridyNFTLending.sol` | NFT-collateral lending | ETH/WETH only | None | No FOT surface. |
| `RevenueDistributor.sol` | ETH revenue split | ETH-only distribution; ERC20 sweep is admin pass-through | None | No FOT impact on share math. |
| `POLAccumulator.sol` | Protocol-owned LP | TOWELI hardcoded (immutable, line 53) | None | Toweli-only — FOT impossible. |
| `ReferralSplitter.sol` | Referral fees | ETH-only (no ERC20 transfer) | None | No FOT surface. |
| `VoteIncentives.sol` | Bribe / vote market | Yes — `depositBribe` (lines 412-414) + `commitVote` (lines 1049-1052) | None | Comprehensive FoT-aware deposits. |
| `TegridyRestaking.sol` | Restake aggregator | Yes — reward-funding uses balance-diff (lines 971-977, 1020-1026) | None | Position math driven by NFT amount, not direct token balance. |
| `TegridyDropV2.sol` | NFT drop | No ERC20 deposits | None | No FOT surface. |
| `TegridyLaunchpadV2.sol` | Launchpad | No ERC20 deposits in payable path | None | No FOT surface. |
| `CommunityGrants.sol` | Grants | TOWELI hardcoded (immutable) — records nominal amount on `safeTransferFrom`. | None (in TOWELI deploy) | INFO I-01 |
| `MemeBountyBoard.sol` | Bounty board | No ERC20 transfer matches | None | No FOT surface. |
| `PremiumAccess.sol` | Premium gate | TOWELI hardcoded — records nominal `cost`. | None (in TOWELI deploy) | INFO I-02 |
| `GaugeController.sol` | Gauge weights | Pure accounting — no token transfer | None | No FOT surface. |
| `TegridyFactory.sol` | Pair factory | No token transfer | None | Has `_rejectERC777` creation-time gate (good). |
| `TegridyFeeHook.sol` | Fee hook | No `safeTransferFrom`/`safeTransfer` of ERC20 in this file | None | No FOT surface here. |
| `TegridyNFTPool.sol` | NFT pool | NFT-only transfers | None | No FOT surface. |

---

## HIGH

*(none)*

---

## MEDIUM

### M-01 — `TegridyStaking` records `_amount` without balance-diff on stake / increase / notify
**Files:**
- `contracts/src/TegridyStaking.sol:540` (`stake`): `rewardToken.safeTransferFrom(msg.sender, address(this), _amount)` after `totalStaked += _amount` and `positions[tokenId].amount = _amount`.
- `contracts/src/TegridyStaking.sol:588` (`stakeWithBoost`): same pattern.
- `contracts/src/TegridyStaking.sol:695` (`increaseAmount`): `totalStaked += _additionalAmount; p.amount += _additionalAmount;` then `safeTransferFrom(_additionalAmount)`.
- `contracts/src/TegridyStaking.sol:1207` (`notifyRewardAmount`): `totalRewardsFunded += _amount` then `safeTransferFrom(_amount)`.

**Detail:** The `rewardToken` is a generic `IERC20` set in the constructor (`rewardToken = IERC20(_rewardToken)` at line 291). All deposit and reward-funding paths record the **caller-supplied `_amount`** (or `_additionalAmount`) into `totalStaked` / `p.amount` / `totalRewardsFunded` *before* (or without re-reading after) the `safeTransferFrom`. If `rewardToken` is ever a fee-on-transfer or rebasing token, the contract's actual on-hand balance is `_amount - fee`, but every accounting variable says `_amount`. Consequences:

1. **Last-claimer under-pay** — `_accumulateRewards` reads `rewardToken.balanceOf(address(this))` (line 468) and computes `rewardPool = available - reserved` where `_reserved` includes `totalStaked + totalRewardsFunded`. With FOT shrinkage on stakes/notifies, `reserved > available` is possible → branch at line 473 sets `reward = 0`, silently halting reward accrual until a third-party (ironically) tops up the balance.
2. **Withdraw-revert** — `withdraw` calls `safeTransfer(msg.sender, amount)` where `amount` was the recorded `_amount`. If the contract holds less than `amount` (FOT haircut + later partial withdraws by other users), the safeTransfer reverts → DoS for the last withdrawer of that token's pool.
3. **Penalty math** — `earlyWithdraw` computes `penalty = (amount * EARLY_WITHDRAWAL_PENALTY_BPS) / BPS` from the recorded amount; `userReceives` may exceed actual balance.

**Severity rationale (MEDIUM, not HIGH):** The canonical deployment uses TOWELI which has no FOT (`Toweli.sol` is the OZ `ERC20` default `_update`, no override). This finding only fires if (a) the contract is re-deployed with a different `_rewardToken`, (b) that token has a FOT or rebase mechanism, or (c) a hypothetical future Toweli upgrade to a tax token (impossible — Toweli is non-upgradeable, no admin). No on-chain reachability on the live Mainnet deploy.

**Comparison with codebase peers that already handle FOT correctly:**
- `VoteIncentives.depositBribe` (`VoteIncentives.sol:411-414`) uses `balBefore` / `actualReceived = balAfter - balBefore`.
- `TegridyLPFarming.notifyRewardAmount` (`TegridyLPFarming.sol:390-392`) uses balance-diff.
- `TegridyRestaking._addReward` (`TegridyRestaking.sol:971-977`) uses balance-diff.

The TegridyStaking pattern is the **outlier** in the codebase. The fix would be a one-line `received = bal - balBefore` in the four listed call sites, and book `received` instead of `_amount`.

**Audit-only recommendation:** flag for hardening pass; add a deployment-time invariant test asserting `_rewardToken` matches the canonical TOWELI vanity address, OR adopt the balance-diff pattern.

### M-02 — `TegridyLPFarming` asymmetric FOT awareness — funding is safe, staking is not
**File:** `contracts/src/TegridyLPFarming.sol`
- Line 263 (`stake`): `stakingToken.safeTransferFrom(msg.sender, address(this), amount)` after `rawBalanceOf[msg.sender] += amount; effectiveBalanceOf[msg.sender] += effective; totalRawSupply += amount; totalEffectiveSupply += effective;` — **records `amount` not balance delta**.
- Line 390-392 (`notifyRewardAmount`): correctly uses `balanceBefore` / `actualReward = balanceAfter - balanceBefore`.

**Detail:** The asymmetry is the bug. If `stakingToken` is a Uniswap V2 LP from a pair where one leg is FOT, the LP token itself is *not* FOT — Uniswap V2 LP shares are pure OZ `_mint` / `_burn`. So in the canonical deploy this is moot. However the contract's constructor (`TegridyLPFarming.sol:139-152`) accepts arbitrary `_stakingToken`. If ever paired with an FOT-style LP token (theoretical: a fork, a custom pair, an ERC4626 share with deduction), `rawBalanceOf` over-records and `withdraw`'s `stakingToken.safeTransfer(user, amount)` (line 306) reverts on insufficient balance for the last withdrawer.

The Synthetix-pattern `rewardPerToken` math (line 175-180) divides by `totalEffectiveSupply` — over-reported supply means **per-staker rewards are diluted** (under-pay) until the funded pot drains.

**Severity:** MEDIUM by symmetry with M-01. Not HIGH because the canonical staking token (TOWELI/WETH UNI-V2 LP) is not FOT.

**Audit-only recommendation:** apply the same balance-diff pattern at line 263 that's already used at line 390-392 of the same file. One-line change.

---

## LOW

### L-01 — `TegridyPair.skim` is permissionless; FOT skim donation race
**File:** `contracts/src/TegridyPair.sol:255-265`
**Detail:** `skim(to)` is permissionless — anyone can `skim` excess tokens to any address. With FOT input tokens, the `safeTransfer(to, amount0)` at line 261 will haircut the recipient (recipient gets `amount0 - fee`). The pair's balance after skim is therefore higher than `reserve0` by `fee`. Subsequent `swap()` will revert at line 243 (`FOT_OUTPUT_0` check), but the *next* `mint` reads `balance - reserve` and treats the residual as fresh deposit — donating the FOT-fee to the next minter. Documented at line 252-254 ("Tokens sent to the pair in a separate transaction (not via Router) can be skimmed by anyone before mint()") but the FOT-flavoured corollary (skim leaves residual that becomes a mint donation) is not documented.

**Recommendation (audit-only note):** doc-only — extend the comment block to call out the FOT-skim-donation footgun. No code change needed; this is a known V2 pattern.

### L-02 — `TegridyPair.mint` uses `balance - reserve` directly without sanity check
**File:** `contracts/src/TegridyPair.sol:112-115`
**Detail:** `mint(to)` reads `balance0 = balanceOf(this); amount0 = balance0 - _reserve0` — i.e., it implicitly relies on the balance-diff pattern, so FOT input is *naturally* handled (the contract simply uses what it has, not what the depositor sent). This is correct.

The only edge case: if a FOT token's fee-recipient is the pair itself (degenerate), `balance0 > _reserve0 + actualSent`, breaking the K-invariant assumption on the **next** swap. Such a token is pathological and the factory's `_rejectERC777` creation gate doesn't catch it. Recommend: governance-level token blocklist when a pair is created against a token whose fee-recipient is the pair.

**Recommendation (audit-only note):** off-chain monitoring on `Sync` events for unexpected `reserve` increases without preceding `Swap` / `Mint` would catch this.

### L-03 — `CommunityGrants.submitProposal` records nominal `PROPOSAL_FEE` not delivered amount
**File:** `contracts/src/CommunityGrants.sol:217-221`
**Detail:** `nonRefundable + refundable == PROPOSAL_FEE` is recorded as `totalRefundableDeposits += refundable` and `totalFeesCollected += PROPOSAL_FEE`, but the actual amount transferred via `safeTransferFrom` is not measured. With Toweli (non-FOT), this is exact. If this contract were re-pointed at a different governance token (the constructor accepts `address _toweli` — search `CommunityGrants.sol` for the immutable assignment), accounting would drift.

**Recommendation:** confirm `toweli` immutability + match-against-canonical at deploy time. Code change unnecessary in canonical TOWELI deployment.

### L-04 — `PremiumAccess.purchase` records nominal `cost` not delivered amount
**File:** `contracts/src/PremiumAccess.sol:193`
**Detail:** Same pattern as L-03. `safeTransferFrom(msg.sender, address(this), cost)` with no balance-diff. Withdraw path at line 340-343 reads `balance = toweli.balanceOf(this)` so withdraws are naturally bounded, but the contract trusts `cost` for refunds at line 296 (`safeTransfer(msg.sender, refundAmount)`) — refundAmount is computed from prior records, which over-pay if Toweli were FOT.

**Recommendation:** same as L-03 — Toweli immutability is the actual mitigation.

### L-05 — TegridyStaking `_reserved()` includes `totalRewardsFunded` which over-reserves under FOT
**File:** `contracts/src/TegridyStaking.sol:1208` (where `totalRewardsFunded += _amount` runs without balance-diff) feeding into `_reserved()` consumed at lines 469-475 by `_accumulateRewards`.

**Detail:** Compounding consequence of M-01. If `rewardToken` were FOT, `totalRewardsFunded` over-counts vs. on-hand balance. `_reserved() > balanceOf(address(this))` flips the conditional at line 470 and pins `reward = 0` — reward accrual silently halts. Active stakers see APR fall to zero with no obvious indicator.

**Severity LOW** because it's a degraded-mode (no funds lost) and contingent on a non-canonical reward token.

---

## INFO

### I-01 — `Toweli.sol` has no FOT logic; threat is structurally absent for canonical deploys
**File:** `contracts/src/Toweli.sol:27-42`
The contract body is one constructor that calls OZ `_mint(recipient, TOTAL_SUPPLY)`. No `_update` override. No transfer hook. No fee. The audit prompt's claim "Toweli.sol has tax logic" is **wrong** — confirm by code review and by `016_Toweli.md` Agent 016's findings (HIGH 0, MEDIUM 0).

### I-02 — `VoteIncentives.depositBribe` is the canonical FoT-handling pattern in this codebase
**File:** `contracts/src/VoteIncentives.sol:399-415`. Comment at line 400 explicitly documents "Uses balance-diff to handle fee-on-transfer tokens correctly." This is the pattern the staking-side findings (M-01, M-02) should adopt.

### I-03 — `SwapFeeRouter` has multi-layer FoT defenses
**File:** `contracts/src/SwapFeeRouter.sol`. Lines 408-414, 473-475, 542-546, 602-604, 663-674, 1151-1166 all use balance-diff. Lines 1151-1156 specifically handle the case where prior FoT-haircut left the contract with less than `accumulatedTokenFees[token]` — clamps `swapAmount` to actual on-hand. Best-in-class.

### I-04 — `TegridyRestaking` uses balance-diff in `_addReward` and `_addBonusReward`
**File:** `contracts/src/TegridyRestaking.sol:971-977, 1020-1026`. Reward-funding paths consistently re-read balance after `safeTransferFrom`. Good.

### I-05 — `TegridyPair.swap` has explicit FoT-output reverts
**File:** `contracts/src/TegridyPair.sol:243-244`. Documented as `AUDIT NEW-A1 (CRITICAL)` at line 234. Prevents the subtle drain where reserves and balances diverge after an output safeTransfer that triggered an FoT deduction. This is the textbook fix for the "FoT post-creation upgrade" attack vector.

### I-06 — `TegridyRouter` exposes V2 `*SupportingFeeOnTransferTokens` family with explicit exact-output incompatibility doc
**File:** `contracts/src/TegridyRouter.sol:216-227, 296-347`. Comment block explains why exact-output and FoT cannot coexist. Frontends/integrators are responsible for routing FoT tokens through the supporting variants.

---

## Cross-references

- Agent 016 (`016_Toweli.md`) — confirmed Toweli has no fee surface.
- Agent 001 (`001_TegridyPair.md`) — pair-level findings (presumed; not re-read here).
- Agent 015 (`015_TegridyRestaking.md`) — restaking-specific findings.
- Agent 003 (`003_TegridyFactory.md`) — `_rejectERC777` creation-gate behavior.

## Verdict

The codebase is **mostly FOT-safe**. Only the staking deposit/funding paths (TegridyStaking M-01, TegridyLPFarming M-02) lack the balance-diff pattern that's used elsewhere. **Risk on the canonical TOWELI deploy is zero** because Toweli is a fixed-supply, non-FOT, non-rebasing OZ ERC20. The MEDIUM findings are forward-defense — protect against fork redeploys against FOT staking/reward tokens. No HIGH issues. Test gaps suggested at the harness level, not contract level.
