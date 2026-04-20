# Governance & Admin Keys

This document describes who controls which parameter of the Tegridy Farms protocol, how changes are proposed and executed, and the ownership-migration roadmap.

## Summary

- Parameter changes on Tegridy Farms contracts are **timelocked** (24–48 hours depending on contract).
- Ownership is currently held by a **single EOA** using `OwnableNoRenounce` (prevents accidental brick; still a single key).
- **Migration to multisig is on the roadmap** — see [ROADMAP.md](../ROADMAP.md).
- No contract has a backdoor, mint function, or emergency-unlock mechanism that bypasses the timelock.

## Access-control primitives

Every admin-controlled contract in the protocol inherits from two custom base contracts:

- **[`OwnableNoRenounce`](../contracts/src/base/OwnableNoRenounce.sol)** — a 2-step ownership transfer (propose + accept) with `renounceOwnership()` explicitly disabled. This prevents accidental bricking but does NOT prevent a compromised owner from transferring ownership to a malicious account.
- **[`TimelockAdmin`](../contracts/src/base/TimelockAdmin.sol)** — enforces a minimum delay between proposing and executing a parameter change. Every parameter change is a three-step flow: `propose(key, delay) → wait → execute(key)`.

## Timelock windows

| Contract | Parameter | Timelock |
|---|---|---|
| TegridyStaking | Reward rate, penalty percent, pause, rewards token | 24h |
| TegridyStaking | Treasury address | 48h |
| TegridyLPFarming | Rewards duration | 24h |
| TegridyLPFarming | Treasury address | 48h |
| SwapFeeRouter | Fee bps, receiver splits | 24h |
| RevenueDistributor | Distribution epoch, token recipients | 24h |
| GaugeController | Gauge addition/removal, emission budget | 24h |
| TegridyLending | Oracle, LTV, fee recipient | 48h |
| TegridyNFTLending | Collection allowlist, grace period | 48h |
| TegridyLaunchpadV2 | Protocol fee bps (capped ≤ 100%) | 24h |
| PremiumAccess | Subscription price | 24h |
| VoteIncentives | Sweep recipient | 48h |

Exact values are authoritative in source (constants in each contract). The user must wait the full timelock after `propose()` before `execute()` can be called.

## What the admin CAN do

Within the timelocked parameter surface:

- Set swap fees (0%–1.0%) and redirect fee splits
- Set the treasury address that receives protocol fees
- Set reward emission rates and durations
- Add/remove gauges from LP farming
- Pause a contract in emergency (no timelock on pause)
- Recover accidentally-sent ERC-20 tokens (excluding staking/reward tokens)
- Update oracle addresses (lending only)
- Update merkle roots and mint phases on Drop contracts (per-Drop owner)

## What the admin CANNOT do

These are hard-coded at the contract level and **cannot be changed by admin action**:

- Mint, burn, or blocklist TOWELI (the token has no such functions — see [TOKEN_DEPLOY.md](TOKEN_DEPLOY.md))
- Confiscate user-staked TOWELI (only the user can `withdraw()`)
- Confiscate user-deposited LP tokens (only the user can `withdraw()`)
- Confiscate NFT collateral in lending (only on default after `deadline + grace`)
- Exceed the 4.5× boost ceiling on staking rewards (defence-in-depth constant)
- Set the launchpad protocol fee above 100% (cap in source)
- Bypass the 25% early-withdrawal penalty redistribution
- Renounce ownership (prevented by `OwnableNoRenounce`)

## What a compromised admin could do (threat model)

If the owner EOA is compromised and the attacker waits out the timelock:

- Redirect fee flows to their own address
- Pause staking indefinitely (users can still `emergencyWithdraw`)
- Add a malicious collection to NFT lending allowlist

These are real risks of a single-EOA admin model. **This is why the multisig migration is a priority.**

## Current owner

The canonical owner address is documented in each contract's storage and can be read via `owner()` on Etherscan. As of this document's last-updated date, ownership has not been transferred to a multisig.

## Multisig migration roadmap

See [ROADMAP.md](../ROADMAP.md) for the target milestone. The planned migration:

1. **Choose multisig provider** — Safe (Gnosis Safe) is the default for Ethereum DeFi.
2. **Deploy 3-of-5 multisig** with public signer identities. Signers can be the core team, a trusted external security engineer, and an independent community member.
3. **Execute `transferOwnership(multisig)`** on every owner-controlled contract in a single co-ordinated pass, with a public announcement and the old EOA's signing key rotated/destroyed.
4. **Accept ownership** from the multisig via `acceptOwnership()` (the 2-step flow enforced by `OwnableNoRenounce`).
5. **Update `GOVERNANCE.md`** with the multisig address, signer set, and a link to the Safe transaction showing the transfer.

Until migration is complete, capital allocation decisions by readers should account for single-key risk.

## Guardian roles

There is currently no separate `guardian` role for fast emergency response. Guardian introduction is planned alongside the multisig migration — a guardian address with `pause()`-only authority that can halt the protocol during an attack, independent of the full owner.

## Reporting governance concerns

If you observe on-chain governance behaviour that appears inconsistent with this document (e.g. a timelock shorter than documented, a parameter change outside the allowed surface), report via the [SECURITY.md](../SECURITY.md) disclosure process.

---

*Last updated: 2026-04-17.*
