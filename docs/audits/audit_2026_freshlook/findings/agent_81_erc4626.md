# Agent 81 — ERC4626 Vault Standard / Inflation Attack / Share-Price Manipulation

Lens: ERC4626 compliance, virtual-share / dead-share inflation defense, totalAssets() vs balanceOf donation, rounding directions, preview consistency, vault hook reentrancy, max(deposit/redeem) ratio invariants.

Scope reviewed: every `.sol` under `contracts/src/` (incl. `base/` and `lib/`).

---

## TL;DR

Tegriddy Farms ships **no ERC4626 vault**. There is no `IERC4626` import, no `convertToShares` / `convertToAssets` / `previewDeposit` / `previewWithdraw` / `previewMint` / `previewRedeem` / `maxDeposit` / `maxMint` / `maxWithdraw` / `maxRedeem` / `totalAssets` function anywhere in the codebase, and no contract inherits from `ERC4626` (OZ or Solmate). The closest mint/redeem-with-shares surface is **TegridyPair** (UniswapV2-style LP), which is a constant-product AMM, not a 4626 yield vault — and even there, the well-known first-depositor inflation attack is hardened with both **MINIMUM_LIQUIDITY (1000) burn-to-dead** and a **`rawLiquidity > MINIMUM_LIQUIDITY * 1000` initial-mint floor** that makes the inflation attack economically infeasible.

All "share-like" reward accounting elsewhere uses **MasterChef accumulators** (`accBonusPerShare` over `totalRestaked` / `accRewardPerShare` over per-user `boostedAmount`) or **Synthetix StakingRewards** (`rewardPerToken` over `totalEffectiveSupply`), or **Curve FeeDistributor** (per-epoch checkpoint snapshots of `votingPowerAtTimestamp / epoch.totalLocked`). None of these mint a fungible share token whose price-per-share floats with a separately-accounted asset balance, so the 4626 inflation taxonomy doesn't apply.

**Net finding count for this lens: 0 confirmed exploit, 0 medium/high.** One INFO-level note re: `notifyRewardAmount` rate-cap-vs-donation in TegridyLPFarming, included for completeness — non-exploitable as a share-attack.

---

## F-81-1 [INFO] — No ERC4626 vault exists; share-inflation taxonomy doesn't apply

**Status:** Informational (architectural finding, not a vulnerability)

**Files:** all of `contracts/src/`

**Search receipts (Grep over `contracts/src/`):**

- `ERC4626 | IERC4626` — **0 matches**
- `convertToShares | convertToAssets | previewDeposit | previewWithdraw` — **0 matches**
- `pricePerShare | sharePrice | getPricePerFullShare` — **0 matches**
- `maxDeposit\( | maxMint\( | maxWithdraw\( | maxRedeem\(` — none
- `totalAssets` — **0 matches** (no 4626-style asset accounting)

**Mint/redeem surfaces present in the protocol:**

| Contract | `mint` / `redeem`-style entrypoint | Pattern |
| --- | --- | --- |
| `TegridyPair.sol` | `mint(address to)`, `burn(address to)` | Uniswap V2 LP — constant-product AMM, not a 4626 vault |
| `TegridyDropV2.sol` | `mint(uint256 quantity, ...)` | ERC721A NFT mint with merkle allowlist — irrelevant to 4626 |
| `TegridyLPFarming.sol` | `stake / withdraw` | Synthetix StakingRewards (no fungible share) |
| `TegridyStaking.sol` | `stake / withdraw` | Per-tokenId NFT positions, no share token |
| `TegridyRestaking.sol` | `restake / claim / claimAll` | MasterChef `accBonusPerShare` over `totalRestaked` |
| `RevenueDistributor.sol` | `claim / claimUpTo / withdrawPending` | Curve FeeDistributor checkpoint pattern |
| `TegridyStakingJbacVault.sol` | `pullJbac / returnJbac / claimStrandedJbac` | ERC721 custody only — not a share vault |
| `TegridyLending.sol` | per-position lending | No cToken/aToken-style supply share |
| `TegridyNFTPool.sol` | NFT pool | Per-NFT accounting |

**Implication for this lens:**
The classic 4626 inflation attack vector — first depositor mints 1 wei share, donates assets to inflate `totalAssets / totalSupply`, then second depositor's deposit rounds down to 0 shares — does not exist in this codebase because no contract maintains a `(totalAssets, totalShares)` ratio that converts user deposits into a fungible share with floating price-per-share. There is no surface where `convertToShares(assets) = assets * totalSupply / totalAssets` is computed.

---

## F-81-2 [INFO / mitigated] — TegridyPair (Uniswap V2) inflation defense is hardened beyond stock V2

**Status:** Confirmed mitigated. Listed only because `mint()` is the only "shares from assets" surface in the protocol and a fresh-eyes audit must verify it.

**File:** `contracts/src/TegridyPair.sol`

**The defense layers:**

```
Line  88: uint256 private constant MINIMUM_LIQUIDITY = 1000;
Line 149: if (_totalSupply == 0) {
Line 150:     require(amount0 >= 1000 && amount1 >= 1000, "MIN_INITIAL_TOKENS");
Line 152:     uint256 rawLiquidity = FixedPointMathLib.sqrt(amount0 * amount1);
Line 155:     require(rawLiquidity > MINIMUM_LIQUIDITY * 1000, "INSUFFICIENT_INITIAL_LIQUIDITY");
Line 156:     liquidity = rawLiquidity - MINIMUM_LIQUIDITY;
Line 157:     _mint(address(0xdead), MINIMUM_LIQUIDITY);
```

This adds a `1000 * MINIMUM_LIQUIDITY` floor on top of the stock UniswapV2 pattern. Stock V2's MINIMUM_LIQUIDITY=1000 lock alone has been historically sufficient against first-depositor inflation in V2 because the LP token denominates raw token1*token2 sqrt — not a yield vault. The added floor pushes the minimum economic outlay for an attacker setting up a first-depositor inflation grief from "negligible" to "expensive enough to be irrational vs. payoff." 

Subsequent mints (`else` branch, lines 158-162) use the standard `min(liq0, liq1)` proportional formula with no rounding-direction asymmetry that an inflater could exploit — both legs round down equally, and the attacker's prior deposit cannot mint extra shares to themselves on a victim's deposit.

**Verdict:** No exploit. Defense exceeds stock UniV2.

---

## F-81-3 [INFO] — TegridyRestaking `accBonusPerShare` denominator is `totalRestaked`, not contract balance

**Status:** Not exploitable as a 4626-style donation attack.

**File:** `contracts/src/TegridyRestaking.sol`

The reward accumulator math:

```
Line 350: accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
```

`totalRestaked` is `Sum of all deposited boosted amounts` — driven by **internal bookkeeping in `_addRestake / _removeRestake`**, not by `bonusRewardToken.balanceOf(address(this))`. The contract balance only enters as a `min(reward, available)` clamp on the **numerator** (lines 337-348 / 388-394) to gate dispensable reward against shortfall — it cannot dilute existing restakers' share by donation.

Donation of `bonusRewardToken` to the contract:
- Increases `available` → does **not** increase `accBonusPerShare` because the increment is gated by `elapsed * bonusRewardPerSecond`, capped at `available`.
- Effect: a donation acts as an **owner-style top-up** to the reward pool that is dispensed at the configured `bonusRewardPerSecond` over time. No restaker can be diluted; future restakers benefit. Benign / antifragile.

The `bonusDebt` per-user anchoring (`info.bonusDebt = (boostedAmount * accBonusPerShare) / ACC_PRECISION`) ensures each user's claim is `(currentBoosted * accBonusPerShare / ACC_PRECISION) - bonusDebt`, a per-position settlement, not a redemption against a shared asset pool — so 4626 redemption-rounding attacks don't apply.

---

## F-81-4 [INFO] — TegridyLPFarming uses Synthetix `rewardPerToken` over `totalEffectiveSupply`; no share token to inflate

**Status:** Not a vault. Listed for completeness because lens calls for `mint( / redeem(`.

**File:** `contracts/src/TegridyLPFarming.sol`

User stakes raw LP into `effectiveBalanceOf[user]` (and `totalEffectiveSupply` aggregate). No new ERC20 is minted to the user. Withdrawal returns the same raw LP they staked. There is no share/asset conversion path, so:

- No `convertToShares` rounding to weaponize
- No `previewDeposit/previewWithdraw` to drift from actual
- No `totalAssets` → no donation-vs-share-supply ratio

The `notifyRewardAmount` cap check (line 488-489) does read raw `balance = rewardToken.balanceOf(address(this))` to enforce `rewardRate <= balance/duration`. A donor could donate `rewardToken` to lift this cap in a future `notifyRewardAmount` call — but this is an **anti-grief** cap (preventing the funder from over-rate-setting) not a share-dilution attack, and the donor's own funds get folded into the rate computation pool benefiting all stakers. Benign / antifragile, identical posture to mainline Synthetix.

---

## F-81-5 [INFO] — RevenueDistributor uses Curve FeeDistributor checkpoint pattern; no share

**Status:** Not a vault.

**File:** `contracts/src/RevenueDistributor.sol`

User claim per epoch:
```
Line 772: uint256 share = (epoch.totalETH * effectivePower) / epoch.totalLocked;
```

`effectivePower` is `votingPowerAtTimestamp(user, epoch.timestamp)` — a snapshot read against `epoch.totalLocked` at the same timestamp. There is no fungible share token; the numerator/denominator are **frozen at epoch-checkpoint time**, so post-checkpoint donations to the contract cannot dilute or inflate any user's claim within an already-checkpointed epoch. The `totalETH` per epoch is also frozen at epoch start (write-once on `notifyRevenue`/equivalent), so this is robust against the donation manipulation pattern that 4626 vaults are vulnerable to.

---

## F-81-6 [INFO] — TegridyStakingJbacVault is ERC721 custody, not a share vault

**Status:** Not a vault in the 4626 sense. The name "Vault" reflects "physical NFT escrow," not 4626-style fungible-share custody.

**File:** `contracts/src/TegridyStakingJbacVault.sol`

`pullJbac` / `returnJbac` move specific JBAC `tokenId`s in/out, gated `onlyStaking`. There is no asset-to-share conversion. The "stranded JBAC" pattern (lines 87-99) handles a JBAC contract being paused at exit time — it stores `(strandedJbacOwner[stakingTokenId], strandedJbacTokenId[stakingTokenId])` for later reclaim, again per-tokenId, not via shares. 4626 lens does not apply.

---

## Notes / Dead-ends

- **Restaking-shares pattern as 4626-mimic:** Investigated TegridyRestaking, TegridyStaking, TegridyLPFarming for any "deposit asset, mint shares with floating price" mechanic. None exist. All "share" terminology in those contracts refers to MasterChef accumulator denominators (`accBonusPerShare`), not minted user-side shares.
- **`balanceOf(address(this))` audit:** Searched all 40+ uses across `contracts/src/`. Most are admin sweep/recovery paths (`PremiumAccess`, `CommunityGrants`, `POLAccumulator`, `RevenueDistributor.executeTokenSweep`) or balance-before/balance-after fee-on-transfer guards (`TegridyRestaking._notifyRewardAmount` style). None feed a share-conversion ratio.
- **`_deposit` / `_withdraw` non-standard reentrancy hook:** No 4626 OZ-pattern internal hooks exist. All deposit-style entrypoints are `nonReentrant`-guarded externally and use CEI ordering (verified at `TegridyPair.burn` lines 195-202: state update before token transfer; `TegridyLPFarming.stake / withdraw` use `updateReward` modifier first).
- **`max*` ratio invariants:** N/A — no `maxDeposit / maxMint / maxWithdraw / maxRedeem` functions exist, so ratio invariants between them are vacuously satisfied.
- **Preview consistency:** N/A — no preview functions.
- **Round-direction asymmetry:** N/A — TegridyPair `mint` rounds down on both legs symmetrically (line 161 `min(liq0, liq1)` post raw division), TegridyPair `burn` rounds down both `amount0 / amount1`. No 4626-style "deposit rounds shares down, mint rounds shares up" asymmetry exists because there's no separate `deposit / mint` pair.

---

## Summary

**Total findings under this lens: 0 exploitable.**

The protocol does not implement ERC4626. Reward distribution everywhere uses MasterChef accumulators, Synthetix StakingRewards, or Curve FeeDistributor checkpoints — patterns where the share-inflation taxonomy from EIP-4626 simply doesn't apply because there's no `(asset_balance / share_supply)` ratio mediating user entries and exits. The one share-mint surface (TegridyPair LP) is a UniswapV2 fork with hardened first-depositor defense (MINIMUM_LIQUIDITY burn + 1000× initial-mint floor), exceeding stock V2 protections.

Lens cleared.
