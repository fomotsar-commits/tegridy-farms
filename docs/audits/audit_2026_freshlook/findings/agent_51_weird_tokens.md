# Agent 51 — Fresh-Eyes Weird ERC20 Behavior Audit

**Lens:** Fee-on-transfer, rebase, blacklist, double-entry, decimals, missing-returns, transfer hooks, pause-mid-life, permit-no-allowance.

**Scope:** All Solidity under `contracts/src/`.

## Quick Triage

| Token used | Where | Behaviors observed | Audit verdict |
|---|---|---|---|
| `Toweli` (TOWELI) | Most contracts (immutable refs) | Fixed supply, no FoT, no rebase, no blacklist, no pause, no hook, no permit-no-op (proper EIP-1271 dispatch). 18 decimals. | Plain — confirmed safe |
| `WETH` | Router, Lending, NFTLending, NFTPool, MemeBounty, Splitter, Grants, RevenueDistributor, POLAccumulator, **TegridyRestaking.bonusRewardToken** | Canonical WETH9 — plain. | Plain — confirmed safe |
| `LP token` (Uniswap V2 pair) | POLAccumulator, TegridyLPFarming.stakingToken | UNI-V2 LP — plain (mint/burn semantics, no FoT, no rebase). | Plain — confirmed safe in current deployment |
| Whitelisted bribe tokens | `VoteIncentives.depositBribe` | Owner-curated, can include FoT/blacklist/pause tokens (USDT etc.). | **REVIEWED — see findings below** |
| Path tokens | `SwapFeeRouter.*`, `TegridyFeeHook` | User-supplied or PoolManager-routed; arbitrary ERC20. | **REVIEWED — see findings below** |

Toweli token confirmed plain by full read of `contracts/src/Toweli.sol` lines 1-231.

---

## F-51-1 — TegridyRestaking.fundBonus: NO balance-delta on bonus token (FoT/rebase land mine)

**File:** `contracts/src/TegridyRestaking.sol`
**Function:** `fundBonus(uint256 _amount)` lines 1309-1314
**Severity:** Medium (operational; no exposure with current WETH deployment)

```solidity
function fundBonus(uint256 _amount) external nonReentrant updateBonus {
    if (_amount == 0) revert ZeroAmount();
    bonusRewardToken.safeTransferFrom(msg.sender, address(this), _amount);
    totalBonusFunded += _amount;            // <-- credits FULL _amount
    emit BonusFunded(_amount);
}
```

**The bug class:** `bonusRewardToken` is declared `IERC20 public immutable` at line 92 with the comment _"// ETH (WETH) or any ERC20 for bonus"_. The contract's own NatSpec advertises support for any ERC20.

If the deployer ever points `bonusRewardToken` at a fee-on-transfer token (e.g., a deflationary reward token, rebase wrapper, or token that adopts FoT post-deploy via proxy upgrade), the contract will:

1. Receive `_amount * (1 - feeBps)` actually,
2. Credit `totalBonusFunded += _amount` (full nominal),
3. Schedule `bonusRewardPerSecond` distribution against `totalBonusFunded` (line 1864 sister-pattern lives in `notifyRewardAmount` of TegridyStaking which DOES delta — this is NOT a private staking-side issue, but a discrepancy with the same protocol's own pattern).

Late bonus claimers will revert at `bonusRewardToken.safeTransfer(...)` once the on-hand balance runs out before `totalBonusFunded` exhausts. Insolvency.

**Compare:** `TegridyStaking.notifyRewardAmount` lines 1860-1865 correctly does:
```solidity
uint256 balBefore = rewardToken.balanceOf(address(this));
rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
uint256 received = rewardToken.balanceOf(address(this)) - balBefore;
if (received < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall();
totalRewardsFunded += received;     // <-- delta-credited
```

`TegridyRestaking.fundBonus` should mirror this pattern.

**Current exposure:** ZERO — `DeployV2.s.sol` line 86 wires `WETH` as bonusRewardToken, which is plain. But the immutable + "any ERC20" wording locks the failure mode for any future TegridyRestaking deployment with a non-plain bonus token. A simple drop-in fix is recommended for defense-in-depth even on the current WETH deployment.

---

## F-51-2 — TegridyLPFarming.stake: NO balance-delta on stakingToken (FoT-LP land mine)

**File:** `contracts/src/TegridyLPFarming.sol`
**Function:** `stake(uint256 amount)` lines 316-338
**Severity:** Low (no exposure — UNI-V2 LP tokens are plain by construction)

```solidity
uint256 effective = _getEffectiveBalance(msg.sender, amount);
rawBalanceOf[msg.sender] += amount;          // <-- raw amount, pre-transfer
effectiveBalanceOf[msg.sender] += effective;
totalRawSupply += amount;
totalEffectiveSupply += effective;
stakingToken.safeTransferFrom(msg.sender, address(this), amount);
emit Staked(msg.sender, amount, effective);
```

If `stakingToken` is FoT, accounting credits user `amount` but contract receives `amount - feeAmount`. On withdraw (line 379), `stakingToken.safeTransfer(user, amount)` will revert when the share would deplete the contract below other users' raw balances. Late withdrawer DoS / insolvency.

**Why low:** stakingToken is immutable, and the deployment uses a Uniswap V2 LP token (Toweli/WETH), which is itself a standard ERC20 with no FoT or rebase. Comment on line 158 already rejects the `rewardToken == stakingToken` MasterChef-class footgun, but does not document the FoT-LP precondition.

**Recommendation:** Either (a) add a `balanceOf` delta-measure in `stake()` mirroring the `notifyRewardAmount` pattern at line 476, or (b) add a NatSpec precondition stating `stakingToken` MUST NOT be FoT/rebase.

---

## F-51-3 — VoteIncentives.applyTreasuryChange: no token-blacklist dry-run

**File:** `contracts/src/VoteIncentives.sol`
**Functions:** `applyTreasuryChange(address newTreasury)` line 1094-1099; `depositBribe` line 672
**Severity:** Low (DoS vector for specific (treasury, bribe-token) pairs)

`depositBribe` line 672 unconditionally `safeTransfer`s the bribe `fee` to `treasury`. If a whitelisted bribe token blacklists the new treasury (e.g., USDC compliance freeze), every `depositBribe` for that token reverts. The token cannot be used for bribes until the treasury is rotated again or the token is removed from the whitelist.

`CommunityGrants` already has the precedent for this defense via `FeeReceiverDryRunFailed` (CommunityGrants.sol line 261). VoteIncentives has no equivalent guard at `applyTreasuryChange`.

**Concrete attack:** Owner sets new treasury → an OFAC/USDC-compliance update later blacklists that treasury → all USDC bribes are bricked. Mitigation requires a treasury rotation through the timelocked admin.

---

## F-51-4 — VoteIncentives bribe outflow vs. total-balance accounting under FoT

**File:** `contracts/src/VoteIncentives.sol`
**Functions:** `claimBribes` (line 869-887), `refundOrphanedBribe` (line 1180-1207), `refundUnvotedBribe` (line 1227-1264), `refundSubQuorumBribe` (line 1297-1331), `sweepToken` (line 1389-1401)
**Severity:** Informational / operational

`depositBribe` correctly delta-measures inbound (line 655-657). `claimBribes` uses try/catch around outflow (line 874-880) so a single recipient blacklist cannot DoS the whole epoch; it falls into `pendingTokenWithdrawals`.

However:
- The contract's per-token reservation `totalUnclaimedBribes[token] + totalPendingTokens[token]` is denominated in nominal `share`/`amount` units.
- For a FoT token, every outbound `safeTransfer(claimer, share)` decreases the contract's actual balance by `share` (correct), while only the recipient sees `share - haircut`. The contract's accounting matches its own balance.
- BUT the recipient consistently under-receives. This is documented behavior for FoT tokens (Uniswap Router02 has the same observable behavior), so it is not a bug but is worth flagging to operators who whitelist FoT bribe tokens.

The orphan/unvoted/sub-quorum refund paths (lines 1203, 1260, 1327) all `safeTransfer` `bribeDeposits[e][p][t][msg.sender]` (the post-fee netBribe). Same observation: refunder sees less than they deposited even after the protocol fee, which compounds the FoT haircut.

**Recommendation:** Add NatSpec to `applyWhitelistChange` warning that FoT/rebase tokens will short-change every claim+refund recipient and that operators should consider this when whitelisting deflationary tokens. (No code change required.)

---

## F-51-5 — TegridyRestaking emergencyForceReturn: blacklist DoS in admin recovery

**File:** `contracts/src/TegridyRestaking.sol`
**Function:** `emergencyForceReturn(uint256 tokenId)` line 1687-1819, specifically line 1715
**Severity:** Low (admin recovery path; affects single user; bonus token is currently WETH which has no blacklist)

```solidity
if (bonusPending > 0) {
    bonusRewardToken.safeTransfer(restaker, bonusPending);   // <-- raw, no try/catch
    totalBonusDistributed += bonusPending;
    emit BonusClaimed(restaker, bonusPending);
}
```

If `bonusRewardToken` ever gains a blacklist surface and freezes `restaker`, `safeTransfer` reverts and the entire `emergencyForceReturn` rolls back. The user's NFT cannot be force-returned even though the function is meant to be the last-resort recovery path. The accrual itself uses `_accrueBonusChecked()` which is wrapped in try/catch (DEEP-DR-06 fix), but the actual `safeTransfer` is not.

**Compare:** `claimBribes` line 874-881 uses `try this._safeTransferExternal(...) { ... } catch { pending* += share; }`. The same pattern applied to bonus-token transfers in `emergencyForceReturn`, `revalidateBoost*`, `unrestake`, `claimBonusReward`, etc. would survive a bonus-token blacklist.

**No exposure today** with WETH as bonus token.

---

## F-51-6 — Decimal default `DEFAULT_MIN_TOKEN_BRIBE = 1e15` documented but not enforced

**File:** `contracts/src/VoteIncentives.sol`
**Constant:** line 385; reference line 663
**Severity:** Informational (mitigation is operational documentation)

`DEFAULT_MIN_TOKEN_BRIBE = 1e15` (= 0.001 of an 18-decimal token). For a 6-decimal token like USDC/USDT, raw 1e15 = 10^15 / 10^6 = 10^9 USDC = 1B USDC — an unreachable floor. Whitelisting a 6-decimal token without first calling `proposeMinBribeAmount` for that token will completely brick `depositBribe` for that token.

The comment at line 379-385 acknowledges this and instructs operators. The deployment runbook (not in scope here) MUST sequence `whitelistedTokens` → `minBribeAmounts` correctly.

**No code change recommended** — flagging for operational review.

---

## F-51-7 — bonusRewardToken NatSpec mismatch with deploy reality

**File:** `contracts/src/TegridyRestaking.sol`
**Location:** line 92 NatSpec
**Severity:** Informational

```solidity
IERC20 public immutable bonusRewardToken;  // ETH (WETH) or any ERC20 for bonus
```

The "or any ERC20" claim is incorrect given F-51-1 — only plain ERC20s are safe with the current `fundBonus` implementation. Either fix `fundBonus` to delta-measure (preferred) or tighten the NatSpec to "ETH (WETH) or any plain (non-FoT, non-rebase) ERC20."

---

## Notes / Dead-Ends

- **ERC777 / hook tokens:** `TegridyFactory._rejectERC777` (line 317-360) rejects ERC777 at pair creation by querying ERC-1820 registry for `ERC777Token`, `ERC777TokensRecipient`, `ERC777TokensSender` interfaces. Pair-side defense is solid. No bypass found.
- **Missing-return tokens (USDT-class):** All ERC20 calls go through OpenZeppelin `SafeERC20.safeTransfer*` / `forceApprove` everywhere except direct `toweli.transfer(...)` in CommunityGrants (lines 515, 548, 784, 857) and `IWETH.transfer(...)` in TegridyRouter / WETHFallbackLib. Toweli and WETH both return bool correctly, so the direct calls are safe-in-context. No missing-return exposure.
- **Permit-no-op tokens:** No production code calls `IERC20Permit.permit()` on user-supplied tokens — the only on-chain `permit` surface is Toweli's own (correctly EIP-1271 dispatch). No gateway for permit-no-allowance bypass.
- **Pausable token mid-life:** VoteIncentives `claimBribes` (line 874) and `claimBribesBatch` (line 977) handle pause/blacklist via try/catch → pending withdrawals. TegridyRestaking does NOT (raw `safeTransfer`s in claim/restake/unrestake paths) — flagged as F-51-5 above.
- **Rebase shares:** No rebase-style share accounting found. TegridyStaking and TegridyRestaking use additive `accBonusPerShare`/`rewardPerToken` patterns against fixed `boostedAmount` snapshots; no rebase-induced share drift.
- **Output-side FoT in pair swap:** `TegridyPair.swap` lines 263-273 explicitly reject FoT outputs via post-transfer balance equality check (`FOT_OUTPUT_0`/`FOT_OUTPUT_1`). Strong defense.
- **TegridyFeeHook** (Uniswap V4): `convertERC20FeesToETH` reads `IERC20(currency).balanceOf(address(this))` directly (line 588), uses `forceApprove` + router; ETH leg is delta-measured (line 599-607). FoT-currency safe by balance-delta on ETH side.
- **SwapFeeRouter**: All variants (FoT + non-FoT) use balance-delta both for input pulls (line 751-753, 816-818, 945-947, 1006-1008) and ETH receipts (767-769, 985-988, 1015-1017). Output forwarding via `safeTransfer(to, ...)` accepts the recipient FoT haircut as expected behavior.
- **Decimals**: `POLAccumulator` reads `IERC20Metadata(_toweli).decimals()` at constructor (line 290) and uses `toweliUnit` for TWAP consults — defends against future non-18-decimal Toweli reissues. `SwapFeeRouter.MIN_TOKEN_FEE_FOR_CONVERSION = 1e18` is 18-decimal-biased but only gates a cooldown (line 220, 1657) — not a payout, so the worst case is a too-strict floor blocking USDC fee conversions. Acceptable.

---

## Summary

7 findings, all medium-or-lower severity. No exploitable issues with the **current** deployment because every on-chain ERC20 in the code path resolves to either Toweli (plain), WETH (plain), or a Uniswap V2 LP token (plain). The findings cluster around future-deployment / future-token-upgrade footguns where the code's documented "any ERC20" support breaks the moment a FoT/blacklist/pause token is wired in.

Highest-priority code change: **F-51-1** (`TegridyRestaking.fundBonus` → balance-delta) — small, defensive, and matches the pattern already used in the sister contract `TegridyStaking.notifyRewardAmount`.
