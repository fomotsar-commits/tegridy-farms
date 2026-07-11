# Go-Live — Ownership Handoff (verified on-chain 2026-07-11)

## Current state (read from mainnet)
All 8 owned contracts: **owner = deployer EOA `0x14898258…456E`**, pendingOwner = the
0xA360 Safe `0xA36053477568Fb5382492F3A5970D35Fe896b7F8`, and the 14-day transfer window
**EXPIRED Jun 21 2026** → `acceptOwnership()` reverts today. The handoff must be **re-initiated**.

| # | Contract | Address |
|---|---|---|
| 1 | TegridyStaking | `0xcaDc93E96De58EA554c71ca609974625615E046D` |
| 2 | TegridyStakingAdmin | `0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3` |
| 3 | TegridyTWAP | `0xdFdd6D72539A425dC917F49FB834901105cA98c9` |
| 4 | RevenueDistributor | `0xF993316E2fC079de4358c489A935E01e03E23E17` |
| 5 | SwapFeeRouter | `0x6d5791A660e79175F74C6D639584C98422d5956E` |
| 6 | SwapFeeRouterAdmin | `0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060` |
| 7 | POLAccumulator | `0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2` |
| 8 | ReferralSplitter | `0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c` |

## Order of operations (do NOT skip step 0)
**0. Rebuild the Safe signer sets FIRST** (red-team HIGH). Do not accept ownership into a
Safe whose signers share a quorum or a 7702 delegate. Decide the final multisig address —
either the rebuilt 0xA360 Safe or a fresh one.

**1. Deployer (`0x14898258…456E`) re-fires `transferOwnership(<multisig>)` on all 8** — resets
a fresh 14-day clock and re-points the pendingOwner. If the target stays the 0xA360 Safe, the
calldata is (per contract, `to` = the contract, `value` = 0):
```
0xf2fde38b000000000000000000000000a36053477568fb5382492f3a5970d35fe896b7f8
```
(For a different multisig, regenerate: `cast calldata 'transferOwnership(address)' <newMultisig>`.)

**2. The multisig accepts — 8 INDIVIDUAL Safe txs** (a batch fails: "Delegate call is disabled"
on this Safe). Each: `to` = the contract address, `value` = 0, `data` =
```
0x79ba5097
```
Submit within 14 days of step 1.

**3. After the 8 are accepted (+48h for the factory timelock):** from the multisig —
`factory.executeFeeToChange()`, `factory.acceptFeeToSetter()`, `factory.executeGuardianChange()`,
and rotate the factory guardian off the deployer EOA.

**4. Verify:** re-read `owner()` on all 8 == the multisig, and `pendingOwner()` == 0. Run
`script/VerifyMVP.s.sol` — all invariants green before announcing.

## Why re-initiate (not just accept)
`OwnableNoRenounce` sets `ownershipTransferExpiresAt = now + 14 days` on `transferOwnership`;
past it, `acceptOwnership()` reverts. The original transfer (deploy, ~Jun 6) lapsed Jun 21.
Re-calling `transferOwnership` overwrites the pending slot and resets the clock.
