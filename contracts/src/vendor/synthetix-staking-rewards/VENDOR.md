# Vendored: Synthetix StakingRewards (via Uniswap/liquidity-staker)

**Design**: Synthetix's `StakingRewards` — the canonical single-asset staking-rewards
contract, forked by hundreds of protocols and battle-tested across billions in TVL.

**Pin**: `Uniswap/liquidity-staker@3edce550aeeb7b0c17a10701ff4484d6967e345f` —
Uniswap's audited deployment copy of the design (the UNI/WETH liquidity-staking
program). Pinned from Uniswap's repo, not Synthetix's, because the
`Synthetixio/synthetix` v2 repo returned 404 on GitHub when this pin was taken
(2026-08-30; only `synthetix-v3` survives), and the frozen `liquidity-staker`
repo is the highest-value-secured surviving canonical copy. Canonical bytes live
under `contracts/provenance/upstream/liquidity-staker/`, sha256-pinned in
`contracts/provenance/upstream.lock.json`.

**Files**

| here | upstream | divergence |
|---|---|---|
| `StakingRewards.sol` | `contracts/StakingRewards.sol` | 0.8 bridge only (see below) |
| `RewardsDistributionRecipient.sol` | `contracts/RewardsDistributionRecipient.sol` | `abstract` + `virtual` keywords |
| `interfaces/IStakingRewards.sol` | `contracts/interfaces/IStakingRewards.sol` | none — byte-identical vendor |

**The 0.8 bridge, in full** (mechanically pinned by
`contracts/provenance/expected/StakingRewards.expected.diff`; the gate goes red on
any other divergence):

1. `pragma solidity ^0.5.16` → `0.8.26` (repo-wide pinned compiler).
2. OZ 2.3.0 import paths → the repo's OZ 5.x equivalents; the unused
   `ERC20Detailed` import dropped; `IERC20` imported explicitly (OZ 5 SafeERC20
   no longer re-exports it transitively the same way).
3. `using SafeMath for uint256` removed and every `.add/.sub/.mul/.div`
   call-site rewritten as the native operator — 0.8 checked arithmetic has
   identical revert-on-overflow semantics (only the error *type* changes,
   panic vs message).
4. `constructor(...) public` → `constructor(...)` (0.8 forbids the keyword).
5. `override` on `notifyRewardAmount` (required by the now-`virtual` base).

**Why this contract for the island lighthouse (EVM legs)**: `withdraw()` moves
principal only and touches no reward transfer, so a staker's exit can never be
held hostage by an empty reward vault — the exact failure class the Solana
lighthouse proved on devnet (Streamflow error 6012: claim AND unstake&claim
revert while accrued > vault). Funding stays honest: `notifyRewardAmount` +
`periodFinish` give an exact on-chain runway.

**⚠️ SAME-TOKEN POOLS — the one sharp edge (do not remove this section).**
The island stakes X to earn X, so `stakingToken == rewardsToken`. The canonical
funding guard (`rewardRate <= rewardsToken.balanceOf(this) / rewardsDuration`)
then counts **staked principal** as fundable balance: a `notifyRewardAmount`
larger than the actually-funded reward amount passes the guard, `earned()`
grows past what was funded, and `getReward()` pays rewards out of other
stakers' principal — leaving the last withdrawer's `withdraw()` reverting on an
insufficient balance. Canonical deployments (UNI/WETH LP → UNI) had distinct
tokens, so upstream never needed the tighter bound. The contract is vendored
VERBATIM per house Rule 0; the defense is layered around it instead:

- the funding ceremony must enforce `reward ≤ balanceOf(pool) − totalSupply()`
  *before* calling notify (fund-first, notify-exact);
- every UI "vault" figure must be `balanceOf(pool) − totalSupply()`, never the
  raw balance;
- `contracts/test/vendor/StakingRewardsLighthouse.t.sol` pins both the
  anti-hostage property and this insolvency hazard so neither can be forgotten.

**License**: MIT. The underlying work is Synthetix's `StakingRewards.sol`,
published MIT (verified against the `synthetix` npm package, `license: MIT`,
2026-08-30 — the GitHub repo itself is gone). The pinned Uniswap
`liquidity-staker` adaptation (which adds only `stakeWithPermit`) carries **no
license file, no package.json license field and no SPDX headers** of its own;
it is a derivative of the MIT original and is universally forked as such. Our
port carries `SPDX-License-Identifier: MIT` accordingly. (The interface vendor
gains only that SPDX comment line — comments fold in the provenance
normalizer, so its expected diff still pins ZERO drift.)
