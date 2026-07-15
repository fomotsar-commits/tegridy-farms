# Gated-Feature Deploy Runbook (turn-key)

Everything to deploy the audited gated batch to mainnet — **the only thing that's yours is the
signature.** Every command below uses `--account deployer` (or `--ledger`) as the signer
placeholder; you supply the key, nothing else. **NEVER paste a raw private key** into a command
or this file.

Status (2026-07-15): all 9 gated deploy scripts pre-deploy-audited + hardened (mainnet /
Safe-owner / feed-zero guards). Contracts pre-deploy-audited: **8 GO + LaunchpadV2 GO, 0 blockers.**

---

## 0. Prerequisites (do these first — from [[project_pending_operator_tasks]])
1. **Rotate the leaked read-only Etherscan API key** → set `ETHERSCAN_API_KEY` in your shell (NOT `VITE_`-prefixed).
2. **Rebuild the 3 Safes** → the **`MULTISIG`** below MUST be the rebuilt **3-of-N governance Safe** (a *contract* — the scripts now `require(multisig.code.length > 0)`), and **`TREASURY`** the rebuilt 2-of-2 fee Safe. Don't deploy with the compromised-quorum Safes.
3. **Keystore or Ledger** for the deployer: `cast wallet import deployer --interactive`, or plug in a Ledger and use `--ledger`. The deployer key never touches disk in plaintext.
4. Deploy from **`contracts/`** on a machine where `forge build` completes (local hangs — use CI-cached or a clean checkout).

## 1. Canonical env — source this before any deploy
```bash
# ── Live MVP core (relaunch 2026-06-06 — DO NOT edit; verified vs constants.ts) ──
export TOWELI=0x420698CFdEDdEa6bc78D59bC17798113ad278F9D
export STAKING=0xcaDc93E96De58EA554c71ca609974625615E046D
export FACTORY=0xa24C7287eC56A7DEFDc70033803451240e267a52
export PAIR=0x55875887B43C2E23aE424AF0FC8606Fdb058a481          # TOWELI/WETH LP (for TegridyLending floor)
export TWAP=0xdFdd6D72539A425dC917F49FB834901105cA98c9
export WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
export JBAC_NFT=0xd37264c71e9af940e49795F0d3a8336afAaFDdA9
export TREASURY=0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d     # rebuilt 2-of-2 fee Safe (NOT stale 0xE9B7…f53e)
export SEQUENCER_FEED=0x0000000000000000000000000000000000000000  # mainnet = 0 (scripts enforce this)

# ── YOURS to set: the rebuilt governance Safe (owner target) ──
export MULTISIG=0x<REBUILT_3_of_N_GOVERNANCE_SAFE>              # (prev pendingOwner of record: 0xA36053477568Fb5382492F3A5970D35Fe896b7F8 — confirm on-chain)

# ── Policy params — REVIEW each before broadcast (defaults = last-known; scripts flag them) ──
export EMISSION_BUDGET=1000000000000000000000000                # Gauge: 1,000,000 TOWELI/epoch — REVIEW
export BRIBE_FEE_BPS=300                                        # VoteIncentives: 3% — REVIEW (max 500)
export PROTOCOL_FEE_BPS=500                                     # lending: 5% — REVIEW (max 1000)
export NFT_POOL_FEE_BPS=50                                      # NFTPoolFactory: 0.5% — REVIEW (used as PROTOCOL_FEE_BPS for that deploy)
export MONTHLY_FEE=<TOWELI_wei_per_month>                       # PremiumAccess: REQUIRED, no default — set it
```

## 2. Deploy loop — per contract

**Recommended order** (foundational first): GaugeController → VoteIncentives → PremiumAccess →
NFTPoolFactory → NFTLending → MemeBountyBoard → CommunityGrants → LaunchpadV2. **TegridyLending
is LAST and gated** (§4).

For **each** script: (a) dry-run, (b) broadcast, (c) `acceptOwnership` from the Safe, (d) verify,
(e) set the address in `constants.ts`.

```bash
# (a) DRY-RUN first (no broadcast, no key) — confirm the console echoes the RIGHT addresses/policy:
forge script script/DeployGaugeController.s.sol:DeployGaugeControllerScript --rpc-url mainnet --sender 0x<DEPLOYER>

# (b) BROADCAST via the Flashbots private send-path (anti-sandwich). YOU add the signer:
forge script script/DeployGaugeController.s.sol:DeployGaugeControllerScript \
  --rpc-url flashbots --slow --with-gas-price 500000000 \
  --account deployer \          # ← OR --ledger  (YOUR signature; never a raw key)
  --broadcast \
  --verify --etherscan-api-key "$ETHERSCAN_API_KEY"
```
The same two-command shape applies to every script — just swap the script name and `:Script` contract:

| # | Script : contract | Needs env | Ownership | Post-deploy |
|---|---|---|---|---|
| 1 | `DeployGaugeController.s.sol:DeployGaugeControllerScript` | STAKING, EMISSION_BUDGET, MULTISIG | 2-step | Safe `acceptOwnership()`; set `GAUGE_CONTROLLER_ADDRESS` |
| 2 | `DeployVoteIncentives.s.sol:DeployVoteIncentivesScript` | STAKING, TREASURY, WETH, FACTORY, TOWELI, BRIBE_FEE_BPS, MULTISIG | 2-step ×2 (VI + Admin) | `acceptOwnership()` on **both**; set `VOTE_INCENTIVES_ADDRESS` |
| 3 | `DeployPremiumAccess.s.sol:DeployPremiumAccessScript` | TOWELI, JBAC_NFT, TREASURY, MONTHLY_FEE, MULTISIG | 2-step | `acceptOwnership()`; set `PREMIUM_ACCESS_ADDRESS` |
| 4 | `DeployNFTPoolFactory.s.sol:DeployNFTPoolFactoryScript` | MULTISIG, `PROTOCOL_FEE_BPS`=$NFT_POOL_FEE_BPS, TREASURY, WETH | **ctor-direct** (no accept) | set `TEGRIDY_NFT_POOL_FACTORY_ADDRESS` |
| 5 | `DeployNFTLending.s.sol:DeployNFTLendingScript` | TREASURY, PROTOCOL_FEE_BPS, WETH, SEQUENCER_FEED, MULTISIG | 2-step ×2 (Lending + Admin) | `acceptOwnership()` on **both**; set `TEGRIDY_NFT_LENDING_ADDRESS` |
| 6 | `DeployMemeBountyBoard.s.sol:DeployMemeBountyBoardScript` | TOWELI, STAKING, WETH, TREASURY, SEQUENCER_FEED, MULTISIG | 2-step | `acceptOwnership()`; set `MEME_BOUNTY_BOARD_ADDRESS` |
| 7 | `DeployCommunityGrants.s.sol:DeployCommunityGrantsScript` | STAKING, TOWELI, TREASURY, WETH, MULTISIG | 2-step | `acceptOwnership()`; set `COMMUNITY_GRANTS_ADDRESS` |
| 8 | `DeployLaunchpadV2.s.sol:DeployLaunchpadV2Script` | MULTISIG (WETH/TREASURY hardcoded) | 2-step | `acceptOwnership()`; verify the **dropTemplate** too (see §3); set `TEGRIDY_LAUNCHPAD_V2_ADDRESS` |

> ⏱ **acceptOwnership within 14 days** of each 2-step transfer — the OwnableNoRenounce expiry clock starts at broadcast, and **prior project handoffs EXPIRED unaccepted.** Submit each as its own Safe tx (`data: 0x79ba5097`); batches fail on these Safes.

## 3. LaunchpadV2 extras
- The ctor auto-deploys a **TegridyDropV2 template** — `--verify` won't catch it. After deploy, verify it separately (address printed in the script output):
  ```bash
  forge verify-contract <dropTemplate> src/TegridyDropV2.sol:TegridyDropV2 --chain mainnet --etherscan-api-key "$ETHERSCAN_API_KEY"
  ```
- **Tegridy Pro Pass is a LaunchpadV2 operation, not a contract.** Once LaunchpadV2 is live + owned by the Safe, create the pass collection via `createCollection(...)` (an ETH-priced DropV2 clone → proceeds to treasury), then set `TEGRIDY_PRO_PASS_ADDRESS` in `constants.ts` to the clone. No deploy script.

## 4. TegridyLending — ORACLE-GATED (deploy last)
Do **not** deploy `DeployTegridyLending.s.sol` until **`BootstrapTWAP` has warmed** the TOWELI/WETH
oracle (which needs the pool deepened past its reserve floor — see [[project_2026_07_12_coreloop_golive]]
/ docs/GOLIVE_CORELOOP.md). Its ETH-floor reads `consult()` the TWAP; deploying early ships a
contract whose valuations revert. When ready:
```bash
forge script script/DeployTegridyLending.s.sol:DeployTegridyLendingScript \
  --rpc-url flashbots --slow --with-gas-price 500000000 --account deployer --broadcast \
  --verify --etherscan-api-key "$ETHERSCAN_API_KEY"
```
`acceptOwnership()` on **both** TegridyLending + TegridyLendingAdmin; set `TEGRIDY_LENDING_ADDRESS`.
Also land the deferred **sweepUnsolicitedNFT reverse-index** (pre-deploy batch LOW) in this window.

## 5. Frontend wiring (after each deploy)
1. Set the address constant in `frontend/src/lib/constants.ts` (zeroed → deployed address) — the gated
   page auto-un-gates.
2. If the ABI is new: update `frontend/wagmi.config.ts` + `cd frontend && npm run wagmi:generate`.
3. Deploy prod: `vercel deploy --prod --yes` from the **repo root** (CLI-triggered; per [[reference_vercel_deploy_procedure]]).

## 6. Post-deploy verification
- `owner() == MULTISIG` and `pendingOwner() == address(0)` on every deployed contract (+ each Admin sister).
- Both the contract AND its Admin sister verified on Etherscan **and** Sourcify (`--verifier sourcify`).
- For fee-takers: `protocolFeeRecipient()`/`treasury()` == `0x7D26…Bd7d` and the fee bps == your reviewed value.
- Consider a mainnet-fork dry run of one full lifecycle per contract before real funds flow.

---

**What only YOU can do:** supply the signer (`--account`/`--ledger`), the Safe `acceptOwnership()`
signatures, and the reviewed policy values. Everything else — scripts, guards, addresses, order,
verification, wiring — is prepped above.
