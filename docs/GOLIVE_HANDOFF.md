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

### TegridyFactory `0xa24C7287eC56A7DEFDc70033803451240e267a52` (re-read 2026-08-19, block 25794250)

The factory is not in the table above because it is not `Ownable2Step` — its owner-equivalent
role is `feeToSetter`, on a separate timelock. Live values:

| Slot | Value | Meaning |
|---|---|---|
| `guardian()` | `0x14898258…456E` | **the deployer EOA, zero code** — audit M6 is NOT satisfied on this factory. The EOA still holds `emergencyDisablePair`, which is instant and has no timelock. |
| `feeToSetter()` | `0x14898258…456E` | still the deployer EOA |
| `feeTo()` | `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d` | still the treasury Safe, **not** the RevenueDistributor |
| `pendingGuardian()` | `0xCDCA0F06…F354` | queued at deploy, ready 2026-06-09, **expired 2026-06-16** |
| `pendingFeeToSetter()` | `0xA3605347…b7F8` | queued at deploy, ready 2026-06-08, **expired 2026-06-15** |

Both proposals are expired but their slots are still non-zero, and `TimelockAdmin._propose`
rejects on `_executeAfter[key] != 0` regardless of expiry. So the deployer must call
`cancelGuardianChange()` and `cancelFeeToSetterProposal()` before anything can be re-proposed.

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

**3. The factory. ORDER MATTERS — the guardian rotation goes AFTER the acceptance, not before.**

An earlier draft of this step read `executeFeeToChange()`, `acceptFeeToSetter()`,
`executeGuardianChange()` in that order. **It cannot complete.** Audit F-30-10
([TegridyFactory.sol:396-401](../contracts/src/TegridyFactory.sol#L396-L401)) makes
`acceptFeeToSetter` force-cancel any pending `GUARDIAN_CHANGE` queued by the *outgoing*
setter — so the multisig's own acceptance destroys the proposal the next call tries to
execute, and `executeGuardianChange()` reverts `NoPendingProposal`. A guardian change must
be proposed by whoever is feeToSetter *at the end*, which means the multisig, which means
after it has accepted. The correct sequence:

| # | Caller | Call | Wait before the next step |
|---|---|---|---|
| 3a | deployer EOA | `cancelGuardianChange()` then `cancelFeeToSetterProposal()` | — clears the expired slots; without this 3c reverts `CANCEL_EXISTING_FIRST` / `ExistingProposalPending` |
| 3b | deployer EOA | `proposeFeeToChange(revenueDistributor)` if `feeTo` is not already the distributor | 48h (`FEE_TO_CHANGE_DELAY`) |
| 3c | deployer EOA | `proposeFeeToSetter(<multisig>)` | 24h (`FEE_TO_SETTER_DELAY`), then a 7-day acceptance window |
| 3d | **deployer EOA** | `executeFeeToChange()` — 48h after 3b | — `require(msg.sender == feeToSetter)` (`TegridyFactory.sol:312`), and the deployer is still the setter until 3e. **This step MUST precede 3e.** |
| 3e | **multisig** | `acceptFeeToSetter()` — inside the 7-day window or it reverts `PROPOSAL_EXPIRED` | — this force-cancels any queued `GUARDIAN_CHANGE`, which is why the next step comes after it |
| 3f | **multisig** | `proposeGuardianChange(<pauseGuardian Safe>)` | 48h (`GUARDIAN_CHANGE_DELAY`) |
| 3g | **multisig** | `executeGuardianChange()` | — the deployer EOA now has zero factory authority |

⛔ **3d before 3e, and the delays invite the opposite.** 3e becomes available 24h after 3c
(`FEE_TO_SETTER_DELAY`) while 3d needs 48h after 3b (`FEE_TO_CHANGE_DELAY`), so an operator who
runs each step the moment it unlocks will run 3e first. `acceptFeeToSetter` force-cancels the
pending `FEE_TO_CHANGE` (`TegridyFactory.sol:381-386`, the C6 fix directly above the F-30-10
guardian block), and 3d then reverts `NoPendingProposal` permanently — `feeTo` never reaches the
RevenueDistributor. Recovery costs a fresh `proposeFeeToChange` from the multisig plus another 48h.
The acceptance window is 24h → 24h+7d, so waiting past 48h to run 3e is comfortably inside it.

Steps 3f/3g cannot be pulled earlier or merged into the deploy: anything queued before 3e is
force-cancelled by 3e. `pauseGuardian` must be a contract whose code length is neither 0 nor
23 — `proposeGuardianChange` rejects EOAs and 7702-delegated EOAs outright.

> On a **fresh** deploy none of 3f/3g exists: `script/DeployMVP.s.sol` now constructs
> `TegridyFactory` with the PAUSE_GUARDIAN Safe as `_guardian`, so the guardian is final from
> block one and there is no window in which the deployer EOA holds pair-disable power. The
> ordering above is the recovery path for a factory that was already deployed the old way —
> which the live mainnet factory was.

**4. Verify:** re-read `owner()` on all 8 == the multisig, and `pendingOwner()` == 0. Run
`script/VerifyMVP.s.sol` — all invariants green before announcing. INV-11c is the one that
fails while the factory guardian is still the deployer EOA.

## Why re-initiate (not just accept)
`OwnableNoRenounce` sets `ownershipTransferExpiresAt = now + 14 days` on `transferOwnership`;
past it, `acceptOwnership()` reverts. The original transfer (deploy, ~Jun 6) lapsed Jun 21.
Re-calling `transferOwnership` overwrites the pending slot and resets the clock.
