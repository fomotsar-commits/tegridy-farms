# Wave 0 — remaining deploy + wiring tasks

> **Why this file exists**
>
> Wave 0 deploy landed on 2026-04-18 but did not finish — deployer ran out of
> ETH before the last two scripts broadcast, and three live redeploys still
> need the multisig to accept ownership. This file is the authoritative
> checklist of everything that has to happen before Wave 0 can be called
> closed, and is intentionally written as a GitHub-flavoured checklist so
> the same body can be pasted into an issue labelled `await-wave0` without
> reformatting.
>
> **Single source of truth:** when anything here lands on-chain, tick the box
> *and* remove the matching badge on
> [`ContractsPage`](../frontend/src/pages/ContractsPage.tsx) +
> [`MIGRATION_HISTORY.md`](MIGRATION_HISTORY.md) in the same PR.

---

## 1. Pending deploy — not yet broadcast

- [ ] **Deploy `TegridyLaunchpadV2`** via
      [`contracts/script/DeployLaunchpadV2.s.sol`](../contracts/script/DeployLaunchpadV2.s.sol).
      Update `TEGRIDY_LAUNCHPAD_V2_ADDRESS` in
      [`frontend/src/lib/constants.ts`](../frontend/src/lib/constants.ts),
      remove the `pending` row on `/contracts`, and drop the
      `LaunchpadSection` pending banner once `isDeployed()` returns true.

## 2. Redeploy queued — live, but source has been patched

All blocked on deployer `0xaA0caB9826f714A7be8FAC8fC98e87Fc27A54512` topping
up (~0.013 ETH covers both scripts). Scripts use `vm.startBroadcast(pk)` —
no `--private-key` flag needed.

- [ ] **Redeploy `TegridyStaking`** — live at
      `0xcaDc93E96De58EA554c71ca609974625615E046D`, and the source carries two
      2026-09-05 security fixes the deployed bytecode does NOT have (commit
      `539ba990`, tag `lend-eoa-whitelist-2026-09-05`):
      * `[LEND-EOA-WHITELIST]` — the lending whitelist accepted a plain EOA or a
        23-byte EIP-7702 delegated EOA, handing it the same transfer-guard
        relaxation the restaking registry validates for. Now type-filtered at
        propose AND execute time.
      * `[LEND-RESIDUE-DEADLOCK]` — the residue/position guards were both gated
        on `!_approved`, so APPROVING over existing untracked residue was a
        permanent, permissionlessly-armable deadlock. Guard is now unconditional,
        and mirrored onto `applyRestakingContract`'s incoming address.

      Until this redeploy lands, the live contract is still vulnerable to both,
      which is why the §4 whitelist step below carries a mandatory pre-check.
      Neither is remotely exploitable (both writes are `onlyAdmin` behind the 48h
      timelock) and the lending registry has **never held an entry on-chain** —
      verified by log enumeration from deploy block 25,263,328 to head
      25,912,642, against 83 events of positive control. So this is a
      ship-with-the-next-redeploy item, not an emergency.

      Size note: the fixes came in at 24,521 B — **55 B** under the EIP-170
      ceiling, and 33 B SMALLER than the deployed 24,554 B. Ratcheted by
      [`contracts/test/Audit_StakingEIP170Size.t.sol`](../contracts/test/Audit_StakingEIP170Size.t.sol);
      re-measure before broadcasting.

- [ ] **Redeploy `TegridyFeeHook`** with the source-patched constructor
      (`_owner` arg instead of `msg.sender`) so ownership lands on our EOA,
      not the Arachnid CREATE2 proxy. Mine the `0x0044` salt off-chain with
      `cast create2 --ends-with 0044`; the script's in-EVM miner hits
      `MemoryOOG` at ~180k iterations.
      Contract: [`contracts/src/TegridyFeeHook.sol`](../contracts/src/TegridyFeeHook.sol) ·
      Script: [`contracts/script/DeployTegridyFeeHook.s.sol`](../contracts/script/DeployTegridyFeeHook.s.sol)
      · Current stranded address: `0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044`
- [ ] **Redeploy `VoteIncentives`** so it partners the new commit-reveal
      `GaugeController` at `0xb93264aB…0Fdb`. The existing live address
      `0x417F44aee2…7eCf1A` still points at the deprecated pre-commit-reveal
      controller.
      Script: [`contracts/script/DeployVoteIncentives.s.sol`](../contracts/script/DeployVoteIncentives.s.sol)
- [x] ~~**Run `DeployV3Features.s.sol`** — bundle redeploy of V1 launchpad + drop
      template.~~ **Obsoleted 2026-04-19:** V1 `TegridyLaunchpad` + `TegridyDrop`
      source was deleted; the V3Features bundle is retired. Redeploy track for
      `TegridyLending` + `TegridyNFTPool template` + `TegridyNFTPoolFactory` is
      now owned by the individual per-contract deploy scripts. `TegridyDropV2`
      already carries the H-10 refund-flow surface (`MintPhase.CANCELLED`,
      `cancelSale()`, `refund()`, `paidPerWallet`) and ships as the V2 factory's
      drop template.

## 3. Awaiting multisig `acceptOwnership()`

Multisig `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe` must call
`acceptOwnership()` on each before any `onlyOwner` admin function works.

- [ ] `TegridyLPFarming` `0xa7EF711Be3662B9557634502032F98944eC69ec1`
- [ ] `TegridyNFTLending` `0x05409880aDFEa888F2c93568B8D88c7b4aAdB139`
- [ ] `GaugeController` `0xb93264aB0AF377F7C0485E64406bE9a9b1df0Fdb`
- [ ] Same step again for each contract deployed in sections 1 + 2 once
      their `transferOwnership(multisig)` call lands.

## 4. Post-deploy wiring

These don't need redeploying — they're the `proposeX` / `executeX` +
allowance + reward-funding calls the deploy scripts print as "NEXT STEPS".

- [ ] **LP reward epoch** — `TOWELI.approve(farm, amount)` +
      `farm.notifyRewardAmount(amount)` to fund the first 7-day cycle.
- [ ] **Staking ↔ NFT lending whitelist** —
      `TegridyStaking.proposeLendingContract(TEGRIDY_NFT_LENDING, true)` →
      wait 48h → `executeLendingContract()`.

      > ⚠️ **READ TWO VALUES ON-CHAIN BEFORE PROPOSING — 2026-09-05
      > [LEND-RESIDUE-DEADLOCK].** Against the CURRENTLY DEPLOYED staking
      > bytecode (`0xcaDc93E96De58EA554c71ca609974625615E046D`), whitelisting an
      > address that already carries unpaid reward residue **permanently
      > deadlocks that residue and locks the registry slot**: once whitelisted
      > the address counts as a tracked holder, so `claimUnsettled()` and
      > `claimUnsettledFor()` both revert `Unauthorized`,
      > `claimUnsettledForTokenId` pays from a per-tokenId ledger that is empty
      > (it was never written, because the credit happened while the address was
      > untracked), and the revoke that would undo it reverts
      > `PendingLendingResidue`. The amount stays pinned inside
      > `totalUnsettledRewards`, shrinking the reward pool for every staker,
      > with no recovery path (`sweepToken` refuses the reward token).
      >
      > ```bash
      > cast call 0xcaDc93E96De58EA554c71ca609974625615E046D "unsettledRewards(address)(uint256)" $TEGRIDY_NFT_LENDING --rpc-url $ETH_RPC_URL
      > cast call 0xcaDc93E96De58EA554c71ca609974625615E046D "balanceOf(address)(uint256)" $TEGRIDY_NFT_LENDING --rpc-url $ETH_RPC_URL
      > ```
      >
      > **Both MUST read 0.** Verified 0 / 0 on 2026-09-05 at head block
      > 25,912,642 — but re-read them immediately before proposing, because
      > `kick(uint256)` is PERMISSIONLESS and the 48h proposal window is public,
      > so the value can change between propose and execute. If `unsettledRewards`
      > is non-zero, drain it FIRST with `claimUnsettledFor(<addr>)` (which works
      > precisely because the address is still untracked), then propose.
      >
      > The source fix makes this refuse itself rather than deadlock — the guard
      > is now unconditional — but that fix is **NOT on the live contract**; it
      > ships with the staking redeploy queued in §2 above. Until then this
      > pre-check is the only protection.

- [ ] **Staking ↔ new `TegridyLending`** (once V3Features lands) — same
      two-step propose/execute pair, and the SAME pre-check above applies to it.
- [ ] **`GaugeController` register gauges** —
      `proposeAddGauge(lpFarmAddress)` → wait 24h → `executeAddGauge()`
      per gauge that needs to vote-eligible.
- [ ] **`VoteIncentives` whitelist** (post-redeploy) —
      `proposeWhitelistChange(TOWELI, true)` → wait 24h →
      `executeWhitelistChange(pendingWhitelistToken(), pendingWhitelistAction(), whitelistChangeTime())`.
      Wave-2 (2026-05-20): the executor now binds against the pending
      `(token, add, executeAfter)` triple — capture all three on
      `VoteIncentivesAdmin` immediately before sign and pass them as args
      so a captured-key cancel-and-re-propose race can't slip a different
      value through the multisig's signed execute. Then repeat for WETH
      (only one pending proposal at a time).
- [ ] **`SwapFeeRouter` premium wiring** — `proposePremiumAccessChange(PremiumAccess)`
      + `proposePremiumDiscountChange(5000)` after VoteIncentives lands.

## 5. Etherscan verification backlog

All six 2026-04-18 broadcasts failed auto-verify because
`ETHERSCAN_API_KEY` in `contracts/.env` is `Invalid API Key (#err2)|14`.

- [ ] Regenerate key at <https://etherscan.io/myapikey>, update
      `contracts/.env`.
- [ ] `forge verify-contract` for each of the six Wave 0 addresses
      (`0xa7EF…9ec1`, `0x0540…B139`, `0xb932…0Fdb`, `0xfec9…1eb2`,
      `0xddbe…4995`, `0xB6cf…0044`) and for every address deployed in
      sections 1 + 2.

## 6. What NOT to do

- Do **not** run `contracts/script/DeployFinal.s.sol`. It redeploys the
  core staking + factory + router + pair, which would strand every live
  user. Wave 0 deliberately kept the existing core.
- Do **not** redeploy contracts already done unless the source changes
  again. The six Wave 0 addresses are authoritative until audit work lands
  in a future wave.

---

## How to mirror this list into a GitHub issue

1. Copy everything from the H1 header down to the end of section 6.
2. Open a new issue titled **"Wave 0 — remaining deploy + wiring tasks"**.
3. Apply label `await-wave0` (create it if missing, colour suggestion
   `#f59e0b` to match the amber UI banner).
4. Pin the issue so the board stays visible.
5. As boxes get ticked here, tick the matching boxes in the issue body —
   or vice versa. PRs that close Wave 0 items should reference both.

*Last updated: 2026-04-19.*
