# Deprecated & Orphan Contracts

Contracts with bytecode live on Ethereum Mainnet that are **not** part of the current Tegridy Farms protocol and should not be interacted with. Listed here for historical transparency so that off-chain tooling doesn't mistake them for canonical state.

If you were routed to one of these addresses through an outdated frontend, dashboard, or integration, stop and check [MIGRATION_HISTORY.md](MIGRATION_HISTORY.md) for the current canonical address.

---

## Orphans — source missing from this repo

These contracts were deployed during the protocol's pre-v1 / early development phase. The source code is not tracked in this repo. They hold no protocol state relevant to the current deployment and should be considered abandoned.

| Address | Broadcast label | Last referenced | Status | Action |
|---|---|---|---|---|
| `0xaa8ad310e541f4bb89c44ad7faba74f8b4027f2f` | `TegridyFarm` | `contracts/broadcast/Deploy.s.sol` | Abandoned v1 | Do not interact. Consider pausing if still owner-controlled. |
| `0xefefc0fa229ee0415b803fa1352ce6abbe316240` | `FeeDistributor` | `contracts/broadcast/Deploy.s.sol` | Abandoned v1 | Do not interact. Superseded by `RevenueDistributor`. |
| `0xc5bd3d2e7989c466f95a3056f2ea91763827d7d0` | `WithdrawalFee` | `contracts/broadcast/DeployV3.s.sol` | Abandoned spike | Never wired into current protocol. No migration action. |

*The "broadcast label" column is the contract name that appears in the broadcast JSON. The on-chain bytecode was not subsequently verified against a persistent source in this repo. Readers performing a forensic audit can decompile via Etherscan but should not rely on these contracts for any protocol behaviour.*

## Deprecated — replaced by a canonical version

These addresses ARE matched to source in the repo but have been replaced by newer deployments. See [MIGRATION_HISTORY.md](MIGRATION_HISTORY.md) for the full mapping.

- `TegridyStaking@0x65d8b8…a421` — v1, paused after Spartan C-01 finding; superseded by `0x626644…4819`
- `TegridyStaking@0x00fd53…8079` — DeployFinal attempt; superseded pre-production
- `TegridyRestaking@0xfE2E5b…0268` — DeployAuditFixes batch; superseded
- `TegridyRestaking@0xeD73D8…Ec76` — DeployFinal attempt; superseded
- `TegridyRouter@0xe9a4fb…c215e` — v1 router; superseded by v2
- `SwapFeeRouter@0xd8f13c…ad37`, `0x71eaec…39bd`, `0xc63a48…1436` — deprecated versions
- `RevenueDistributor@0xf00964…a7af` — DeployAuditFixes batch
- `CommunityGrants@0xeb00fb…5b34`, `0xd418a6…dfd6` — deprecated versions
- `MemeBountyBoard@0xad9b32…c647` — DeployAuditFixes batch
- `ReferralSplitter@0x2ade96…b060` — DeployAuditFixes batch
- `PremiumAccess@0x514553…af20`, `0x2a44cb…c60d` — deprecated versions
- `VoteIncentives@0xa79991…d797` — initial deployment; superseded

## Why these addresses can still be dangerous

1. **Stuck approvals.** Users who set `approve(oldContract, MAX)` during the deprecated phase still have that allowance live. Recommended: audit your wallet for stale approvals via [Revoke.cash](https://revoke.cash).
2. **Malicious re-use.** Attackers can front a deprecated address in phishing UIs. Always verify against the canonical set in [constants.ts](../frontend/src/lib/constants.ts) or the [README](../README.md#deployed-contracts-ethereum-mainnet).
3. **Indexer noise.** Third-party indexers that ingested old broadcast JSONs may still surface events from these addresses. Filter by the canonical list.

## Reporting mistaken links

If a public-facing resource (exchange listing, analytics dashboard, aggregator) points at a deprecated address, please open an issue on GitHub with the link so we can request correction.

---

*Last updated: 2026-04-17.*
