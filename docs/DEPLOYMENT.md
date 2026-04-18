# Deployment Runbook

How to deploy or redeploy Tegridy Farms contracts and ship the resulting addresses to production.

## Prerequisites

- Foundry installed and `forge --version` reports `1.5.x+`
- `.env` populated in `contracts/` with:
  - `RPC_URL` (mainnet)
  - `PRIVATE_KEY` (deployer EOA with gas)
  - `ETHERSCAN_API_KEY` (for source verification)
  - `MULTISIG` (multisig address that will become owner — see [GOVERNANCE.md](GOVERNANCE.md))
  - Contract-specific env (e.g. `TEGRIDY_LP`, `TEGRIDY_STAKING` for LP farming deploy)
- A clean git working tree on the commit you intend to deploy
- Contract changes must be audit-reviewed and the diff circulated to the team before any mainnet deploy

## Full-fresh deployment (rare)

New chain, or emergency wipe-and-redeploy. Not the common path.

1. `cd contracts && forge build`
2. `forge script script/DeployToweli.s.sol:DeployToweli --rpc-url $RPC_URL --broadcast --verify`
3. `forge script script/DeployFinal.s.sol --rpc-url $RPC_URL --broadcast --verify`
4. `forge script script/DeployV3Features.s.sol --rpc-url $RPC_URL --broadcast --verify`
5. `forge script script/DeployGaugeController.s.sol --rpc-url $RPC_URL --broadcast --verify`
6. `forge script script/DeployTegridyLPFarming.s.sol --rpc-url $RPC_URL --broadcast --verify`
7. `forge script script/DeployVoteIncentives.s.sol --rpc-url $RPC_URL --broadcast --verify`
8. `forge script script/DeployTWAP.s.sol --rpc-url $RPC_URL --broadcast --verify`
9. `forge script script/DeployTokenURIReader.s.sol --rpc-url $RPC_URL --broadcast --verify`
10. `forge script script/WireV2.s.sol --rpc-url $RPC_URL --broadcast`
11. Update `frontend/src/lib/constants.ts` with every new address
12. Update README.md "Deployed contracts" tables
13. Update [MIGRATION_HISTORY.md](MIGRATION_HISTORY.md) with the old→new mapping
14. Run `node scripts/extract-missing-abis.mjs`
15. `cd frontend && pnpm install && pnpm build` — confirm type-check green
16. Commit: `chore(deploy): full-fresh deployment — addresses in constants.ts`

## Patched-three deployment (common path)

Three contracts have working-tree patches not yet on-chain. Redeploy just these without touching the rest:

```bash
./scripts/redeploy-patched-3.sh          # deploys TegridyLPFarming + TegridyNFTLending + Drop template
npx tsx scripts/diff-addresses.ts         # prints the exact constants.ts patch
```

The diff script will tell you exactly which lines in [`constants.ts`](../frontend/src/lib/constants.ts) to change. Apply the patch, then update the matching rows in the README's "Deployed contracts" section in the same commit.

## Per-contract deploys

Replace just one contract:

```bash
cd contracts
forge script script/DeployX.s.sol:DeployX \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

After broadcast:

1. Note the new address from the broadcast JSON at `contracts/broadcast/DeployX.s.sol/1/run-latest.json`.
2. Update [`constants.ts`](../frontend/src/lib/constants.ts).
3. Update README address table.
4. Add a row to [MIGRATION_HISTORY.md](MIGRATION_HISTORY.md) (old → new + reason).
5. Wire any consumers — for example, if you redeploy `TegridyStaking`, you need to update `TegridyLPFarming`'s `tegridyStaking` reference (it's immutable; redeploy LP farming too).
6. Pause the old contract (if pausable) to prevent accidental re-use.

## Post-deploy checklist

For every mainnet deploy:

- [ ] Contract verified on Etherscan (automated via `--verify`)
- [ ] Ownership transferred to multisig via `transferOwnership(MULTISIG)` — see [GOVERNANCE.md](GOVERNANCE.md). This is the first thing a compromised-EOA attacker would skip, so always verify on Etherscan that ownership is where you intended.
- [ ] Multisig calls `acceptOwnership()` to complete the 2-step transfer
- [ ] `constants.ts` updated on `main`
- [ ] README deployed-contract tables updated
- [ ] [MIGRATION_HISTORY.md](MIGRATION_HISTORY.md) updated
- [ ] [CHANGELOG.md](../CHANGELOG.md) updated
- [ ] If the contract needs seed liquidity / initial reward funding, queue the first funding tx via multisig
- [ ] Announce in [Discussions](../../../discussions)

## Rolling back a failed deploy

If a deploy was broadcast but the contract fails its smoke test:

1. **Do not delete the broadcast JSON** — it's the historical record.
2. Pause the new contract immediately.
3. Leave the old canonical address in `constants.ts`; do not swap yet.
4. Investigate. Write a fix. Test on a fork.
5. Redeploy with the fix; follow the normal post-deploy checklist.
6. The original failed deploy goes into [DEPRECATED_CONTRACTS.md](DEPRECATED_CONTRACTS.md).

## Sepolia testnet

For pre-mainnet validation:

```bash
forge script script/DeployX.s.sol:DeployX \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

Note: the V3 deploy scripts have `require(block.chainid == 1, "MAINNET_ONLY")` guards that will revert on Sepolia. For staging, use [`DeploySepolia.s.sol`](../contracts/script/DeploySepolia.s.sol), which deploys mock tokens + a lite version of the protocol.

## Disaster recovery

If the deployer EOA is compromised or lost:

1. Immediately pause every contract via multisig-owned addresses.
2. If ownership hasn't yet been transferred to multisig: **the protocol is unrecoverable** — disclose via SECURITY.md channel and plan migration.
3. Once ownership is on multisig, the compromised EOA can no longer damage the protocol. Rotate all operational keys, redeploy frontend infrastructure, and announce.

This is the reason multisig migration (see [GOVERNANCE.md](GOVERNANCE.md)) is a top-priority roadmap item.

---

*Last updated: 2026-04-17.*
