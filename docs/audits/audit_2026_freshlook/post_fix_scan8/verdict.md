# Scan8 — Deploy Scripts + Sibling Drift + Slither — 2026-05-09

**HEAD before scan:** `37bb216` (post-scan7)
**HEAD after scan:** `<scan8-commit>`
**Method:** 1 focused agent on 22 deploy scripts + sibling-contract storage drift; Slither skipped (not installed).

---

## Summary

| Severity | Count | Action |
|---|---|---|
| EXPLOITABLE | 0 | n/a |
| Sibling-canonical 1-liner applied | 1 | SE-1: `DeployToweli` chain-id guard |
| DELETE candidates DEFERRED to operator pre-relaunch hygiene | 4 | not in mandate scope (operator action per `project_relaunch.md`) |
| NON-ISSUE (architectural divergence intentional) | 2 | TegridyLendingAdmin sister vs NFTLending inline; dead `else` branch in 3 already-hardened scripts |

---

## Applied — SE-1: DeployToweli chain-id guard

**File:line:** [DeployToweli.s.sol:17](../../contracts/script/DeployToweli.s.sol)

**Pre-fix:** No chain-id guard. Operator typo (`--rpc-url $MAINNET_RPC` instead of testnet RPC) would deploy a non-vanity TOWELI on mainnet, fragmenting from the vanity-prefix canonical token.

**Post-fix:** Added `require(block.chainid != 1, "USE_VANITY_DEPLOY_FOR_MAINNET");` at top of `run()`.

**Mandate-compliance:**
- 1-line addition.
- Sibling-canonical: every other deploy script in `script/` has `require(block.chainid == 1, "MAINNET_ONLY")` for mainnet-only paths. This is the inverse — mainnet-forbidden — for the testnet/local-only deployer.
- No new state, no new admin functions, no new mappings.
- Closes legitimate operator foot-gun.

---

## Deferred — 4 stale-script DELETE candidates (operator pre-relaunch hygiene, NOT in scan scope)

The agent surfaced 4 deploy scripts that hardcode leaked-wallet-era addresses (`TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e` and the 9 V2 contract addresses):

1. **`contracts/script/WireV2.s.sol`** — Post-deploy wiring helper; hardcodes 9 stale legacy contract addresses.
2. **`contracts/script/Verify.s.sol`** — Read-only invariant runner; hardcodes the same 9 stale addresses.
3. **`contracts/script/DeployTegridyRouter.s.sol`** — Standalone router deploy; hardcodes `TEGRIDY_FACTORY` legacy + `TREASURY` leaked-wallet.
4. **`contracts/script/DeployVoteIncentives.s.sol`** — Standalone bribe-market deploy; hardcodes `TEGRIDY_STAKING` + `TREASURY` + `TOWELI` + `TEGRIDY_FACTORY` legacy.

**Why DEFERRED (not applied this scan):**

Per `memory/project_relaunch.md`:

> "Any reference to a previously-deployed contract address in a script or `.env` should be re-verified against the relaunch addresses, not the stale Wave 0 ones."

This is a global pre-relaunch hygiene task — *every* deploy script that hardcodes addresses needs the operator's re-verification once new (post-relaunch wallet) addresses are decided. **This includes `DeployFinal.s.sol`** which also hardcodes `TOWELI = 0x420698CF...`, `TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e`, and `JBAC_NFT = 0xd37264c7...`.

Scope of a proper fix:
- Decide new TOWELI vanity address (CREATE2 mining).
- Decide new MULTISIG (Safe address).
- Decide new TREASURY (Safe address).
- Update every hardcoded address in `script/Deploy*.s.sol` + `WireV2.s.sol` + `Verify.s.sol` to env reads.
- Update `RELAUNCH_RUNBOOK.md` env-var inventory.

This is a **multi-step operator workflow** that requires off-chain decisions (new wallet selection, new vanity prefix, new multisig signer setup). Per `memory/feedback_bulletproof_mandate.md`:

> "Skip and *document* items that genuinely need external action rather than block on them: mainnet redeploys ... `.env` key rotation ..."

The bulletproof mandate explicitly lists `.env` key rotation as a deferred operator task — script-address hygiene falls in the same category.

**Recommendation for the relaunch operator:**

1. Before broadcasting any deploy script, audit it for hardcoded addresses and replace with `vm.envAddress("X")` for any value that's wallet- or relaunch-specific (TOWELI, TREASURY, MULTISIG, JBAC_NFT, the 9 V2 contract addresses if redeployed).
2. WETH9 (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) is the ONLY hardcoded address that should remain — it's canonical mainnet.
3. Test the converted script on a local fork before mainnet broadcast.

---

## NON-ISSUE entries

### NI-1: Dead `else { console.log("SKIPPED ownership transfer"); }` branch in 3 scripts
**Files:**
- `DeployTegridyLPFarming.s.sol:53-58`
- `DeploySwapFeeRouterV2.s.sol`
- `DeployGaugeController.s.sol`

These are the 3 scripts scan3 hardened from `vm.envOr("MULTISIG", address(0))` to `vm.envAddress("MULTISIG")`. The post-hardening `vm.envAddress` reverts on unset env, making the `else` branch unreachable.

**Why NON-ISSUE:** Cosmetic only. Removing 3 lines per script is a low-value DELETE; the branch is already known-dead. Could be applied as a future hygiene pass; not security-relevant.

### NI-2: TegridyLendingAdmin sister vs TegridyNFTLending inline timelocks
TegridyLending is split (Lending + LendingAdmin) due to EIP-170 (~27kB pre-split). TegridyNFTLending stays inline (~19kB, fits under 24kB).

**Why NON-ISSUE:** Architectural divergence is intentional — both contracts enforce the same delays (`PROTOCOL_FEE_TIMELOCK = 48h`, `TREASURY_TIMELOCK = 48h`) and identical caps. Drift is documented; no security gap.

---

## Verdict

**Scan8 = 0 EXPLOITABLE findings + 1 sibling-canonical 1-liner applied (SE-1).**

The asymptotic-floor signal from scan6/scan7 holds for the contract source surface AND the deploy-script surface. The 4 stale-script DELETE candidates are project-hygiene items (post-relaunch operator workflow), explicitly deferred per the bulletproof mandate's "external action" category.

After three consecutive 0-finding scans (scan6 + scan7 + scan8), the in-house adversarial scan budget has reached saturation. Future audit budget should target **paid-firm engagement** (Spearbit / OpenZeppelin / ChainSecurity) for the architectural cluster: per-tokenId attribution, V4 hook semantics, boost-cache lifetime, multisig key model, restaking↔staking↔lending tri-contract reward flow.

— **End of scan8 verdict.**
