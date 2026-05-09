# Tegriddy Farms — Relaunch Runbook (2026-05-09)

**Canonical entry point for the post-Wave-A relaunch.** Supersedes
`DEPLOY_RUNBOOK.md` (kept as historical reference for the 2026-04
remediation phase).

**Baseline:** `origin/main` HEAD `88d33cc`.
**Test signal:** 2641/2641 (2588 non-invariant + 53 invariant). Zero failing.
**Audit closure:** 1 CRIT + 16/17 HIGH closed; H-4 + 16 MEDs accepted-as-design per `.audit_2026_freshlook/POST_MANDATE_STATE.md`.

---

## 0. Operating principles (read first)

- Every step here uses an existing script. Do **not** write new deploy
  code. Adding code = adding attack surface (per
  `memory/feedback_minimal_surface.md`).
- Each step lists the existing `forge script` invocation + the env vars
  it consumes.
- Multisig holds final ownership of every `OwnableNoRenounce`
  contract. The deployer EOA is a transient role.
- All addresses are EIP-55 checksummed. Source of truth: `frontend/src/lib/constants.ts`.
- After every contract deploys, immediately:
  1. Verify on Etherscan via `forge verify-contract`.
  2. Update `frontend/src/lib/constants.ts`.
  3. Append to `out/relaunch_addresses.json` (operator notebook).

---

## 1. Pre-flight

Refuse to proceed unless every box is ticked.

- [ ] **Multisig deployed** at known address. Recommended: Safe v1.4.1+.
- [ ] **MULTISIG env var** points to that address.
- [ ] **TREASURY env var** points to the protocol treasury (may equal MULTISIG).
- [ ] **WETH env var** = `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (mainnet).
- [ ] **JBAC env var** = `0xd37264c71e9af940e49795F0d3a8336afAaFDdA9`.
- [ ] **JBAY_GOLD env var** = `0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3`.
- [ ] **Chainlink ETH/USD env var** = `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` (only if a contract integrates Chainlink price feed; current scope: none).
- [ ] **SEQUENCER_FEED env var** — REQUIRED on any L2 deploy. The Wave A H-9 deploy gate (`block.chainid == 1 || SEQUENCER_FEED != address(0)`) reverts deployment if missing on a non-mainnet chain. Mainnet (chainid 1) skips the check.
- [ ] **Deployer key access:** prefer `--keystore` or `--ledger`. Avoid `--private-key` on cmdline (per Wave 0 hygiene note in `memory/project_relaunch.md`).
- [ ] **`forge clean && forge build`** is green at HEAD `88d33cc`.
- [ ] **`forge test --no-match-test "Slow|Fork"`** passes 2588/2588.
- [ ] **Sepolia dry-run** completed against the canonical script set.
- [ ] **Frontend repo** is on a branch ready to receive the address update PR.

---

## 2. Deploy sequence

Strict dependency order. Run one stage, capture address, paste into
next stage's env, commit address to operator notebook before continuing.

### Stage A — Token + DEX core
| # | Contract | Script | Notes |
|--:|---|---|---|
| 1 | Toweli | `script/DeployToweli.s.sol` | Recipient = MULTISIG (1B fixed-supply minted to MULTISIG) |
| 2 | TegridyFactory | (in DeployFinal.s.sol Stage A) | feeToSetter = deployer initially; rotated to MULTISIG via timelock in Stage E |
| 3 | TegridyPair (TOWELI/WETH) | factory.createPair() | first canonical pair |
| 4 | TegridyTWAP | `script/DeployTWAP.s.sol` | env: FACTORY |
| 5 | TegridyRouter | `script/DeployTegridyRouter.s.sol` | env: FACTORY, WETH |

### Stage B — Staking + Lending
| # | Contract | Script | Env |
|--:|---|---|---|
| 6 | TegridyStakingJbacVault | (DeployFinal Stage B) | JBAC |
| 7 | TegridyStaking | (DeployFinal Stage B) | TOWELI, JBAC, JBAC_VAULT |
| 8 | TegridyStakingAdmin | (DeployFinal Stage B) | STAKING |
| 9 | TegridyRestaking | (DeployFinal Stage B) | STAKING, TOWELI, WETH (bonus token), TWAP |
| 10 | TegridyLending | (DeployFinal Stage B) | TOWELI, STAKING, TREASURY, WETH, TWAP |
| 11 | TegridyLendingAdmin | (DeployFinal Stage B) | LENDING |
| 12 | TegridyNFTLending | `script/DeployNFTLending.s.sol` | TOWELI, STAKING, TREASURY, WETH, **SEQUENCER_FEED** (Wave A R029 gate) |

### Stage C — NFT markets + drops
| # | Contract | Script | Env |
|--:|---|---|---|
| 13 | TegridyNFTPool template | `script/Deploy*.s.sol` | (clone implementation) |
| 14 | TegridyNFTPoolFactory | (in DeployFinal Stage C) | NFT_POOL_TEMPLATE, FEE_RECEIVER |
| 15 | TegridyDropV2 template | `script/DeployLaunchpadV2.s.sol` | (clone implementation) |
| 16 | TegridyLaunchpadV2 | `script/DeployLaunchpadV2.s.sol` | DROP_TEMPLATE, FEE_BPS, TREASURY, WETH, **SEQUENCER_FEED** |
| 17 | TegridyTokenURIReader | `script/DeployTokenURIReader.s.sol` | STAKING |

### Stage D — Revenue / governance / fees
| # | Contract | Script | Env |
|--:|---|---|---|
| 18 | POLAccumulator | (in DeployFinal Stage D) | TOWELI, ROUTER, PAIR, TREASURY, TWAP, **SEQUENCER_FEED** |
| 19 | SwapFeeRouter | `script/DeploySwapFeeRouterV2.s.sol` | TOWELI, WETH, TREASURY, REVENUE_DISTRIBUTOR (set later), POL_ACCUMULATOR (set later), REFERRAL_SPLITTER (set later) |
| 20 | SwapFeeRouterAdmin | (auto in DeploySwapFeeRouterV2) | SWAP_FEE_ROUTER |
| 21 | ReferralSplitter | (in DeployFinal Stage D) | TOWELI, STAKING |
| 22 | RevenueDistributor | (in DeployFinal Stage D) | TOWELI, STAKING, WETH |
| 23 | TegridyLPFarming | `script/DeployTegridyLPFarming.s.sol` | TOWELI, LP_TOKEN, STAKING |
| 24 | GaugeController | `script/DeployGaugeController.s.sol` | STAKING |
| 25 | VoteIncentives | `script/DeployVoteIncentives.s.sol` | STAKING, TREASURY, WETH, FACTORY, TOWELI, **SEQUENCER_FEED**, BRIBE_FEE_BPS |
| 26 | VoteIncentivesAdmin | (auto in DeployVoteIncentives) | VOTE_INCENTIVES |
| 27 | CommunityGrants | (in DeployFinal Stage D) | STAKING, TREASURY, WETH, **SEQUENCER_FEED** |
| 28 | MemeBountyBoard | (in DeployV2.s.sol) | TOWELI, STAKING, WETH, **SEQUENCER_FEED**, TREASURY, RESTAKING |
| 29 | PremiumAccess | (in DeployFinal Stage D) | TOWELI, JBAC, TREASURY, MONTHLY_FEE |

### Stage E — Uniswap V4 hook (CREATE2 salt mining)
| # | Contract | Script | Notes |
|--:|---|---|---|
| 30 | TegridyFeeHook | `script/DeployTegridyFeeHook.s.sol` | env: POOL_MANAGER, REVENUE_DISTRIBUTOR, FEE_BPS, OWNER (= deployer initially), WETH. **Requires CREATE2 salt mining** so address ends in `0x0044` (encodes AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA permission flags). |

---

## 3. Wiring (post-deploy admin calls)

Run via `script/WireV2.s.sol` and `script/WireAuditFixes.s.sol` (in
that order). Each step is a propose + 24-48h timelock + execute.

1. `TegridyStaking.proposeRestakingContract(RESTAKING)` → 48h → `executeRestakingContract()`
2. `TegridyStaking.proposeLendingContract(LENDING, true)` → 48h → `executeLendingContract()`
3. `TegridyStaking.proposeLendingContract(NFT_LENDING, true)` → 48h → `executeLendingContract()`
4. `SwapFeeRouterAdmin.proposeRevenueDistributor(REVENUE_DISTRIBUTOR)` → 24h → `execute*`
5. `SwapFeeRouterAdmin.proposePolAccumulator(POL_ACCUMULATOR)` → 24h → `execute*`
6. `SwapFeeRouterAdmin.proposeReferralSplitterChange(REFERRAL_SPLITTER)` → 24h → `execute*`
7. `POLAccumulator.setSwapFeeRouter(SWAP_FEE_ROUTER)` (one-shot)
8. `RevenueDistributor.setSwapFeeRouter(SWAP_FEE_ROUTER)` (one-shot)
9. `ReferralSplitter.setApprovedCaller(SWAP_FEE_ROUTER, true)` then `completeSetup()` (one-shot)
10. `GaugeController.proposeAddGauge(<gauge>, <pair>)` → 24h → `executeAddGauge()` for each launch gauge
11. `GaugeController.proposeRestakingContract(RESTAKING)` → 48h → `executeRestakingContract()`
12. `VoteIncentives.setGaugeController(GAUGE_CONTROLLER)` (one-shot)
13. `VoteIncentives.setRestakingContract(RESTAKING)` (one-shot per the post-mandate accepted-design)
14. `MemeBountyBoard.proposeRestakingContract(RESTAKING)` → 48h → `executeRestakingContract()` (Wave A F-21-7 timelocked rotation)
15. `ReferralSplitter` likewise via its rotation pattern if needed
16. `TegridyFeeHook.approvePool(<key>)` for each Uniswap V4 pool that should pay the dynamic fee

---

## 4. Multisig handover

Done LAST, after all wiring confirms healthy.

For every `OwnableNoRenounce` contract the deployer still owns:

1. Deployer: `<contract>.transferOwnership(MULTISIG)`
2. From the multisig (collect signatures): `<contract>.acceptOwnership()`

Required for at minimum: TegridyStaking, TegridyStakingJbacVault,
TegridyRestaking, TegridyLending, TegridyLendingAdmin, TegridyNFTLending,
TegridyNFTPoolFactory, TegridyLaunchpadV2, POLAccumulator, SwapFeeRouter,
SwapFeeRouterAdmin, ReferralSplitter, RevenueDistributor,
TegridyLPFarming, GaugeController, VoteIncentives, VoteIncentivesAdmin,
CommunityGrants, MemeBountyBoard, PremiumAccess, TegridyFeeHook.

`TegridyFactory`'s `feeToSetter` rotates via `proposeFeeToSetterChange`
(48h timelocked, Wave A F-30-9 + M-22 hardening — `setGuardian`
non-zero requirement now in constructor).

`Toweli` has no owner — fixed-supply, immutable.

After every `acceptOwnership` succeeds, the deployer EOA has zero
privileged access. Drain remaining ETH from deployer to a cold
storage address; rotate the deployer key; archive the script env file
to a vault.

---

## 5. Etherscan verification

For every deployed contract:

```bash
forge verify-contract \
  --chain-id 1 \
  --num-of-optimizations 200 \
  --watch \
  --constructor-args $(cast abi-encode "constructor(...)" <args>) \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  <ADDRESS> \
  contracts/src/<Contract>.sol:<Contract>
```

`script/Verify.s.sol` is provided but covers a subset (per Wave 0
finding F-97-2). Operator must verify by-hand for any contract not
covered: POL, LaunchpadV2, NFTLending, FeeHook, TWAP, LPFarming,
GaugeController, TokenURIReader.

---

## 6. Post-deploy verification checklist

Run before announcing the relaunch.

### On-chain invariants (smoke tests)
- [ ] `TegridyStaking.boostingTokens(TOWELI)` returns `true`
- [ ] `TegridyStaking.lendingContracts(LENDING)` and `(NFT_LENDING)` both `true`
- [ ] `TegridyStaking.restakingContract()` == RESTAKING
- [ ] `TegridyStaking.MAX_REWARD_RATE() == 1e18` (Wave A F-35-2 cap)
- [ ] `TegridyPair.kLast() == 0` until first `harvest()` by feeToSetter (Wave A H-7)
- [ ] `TegridyLending.MAX_PAUSE_BLOCK_LIQUIDATION() == 7 days` (Wave A re-fix CD-1)
- [ ] `TegridyNFTLending.MAX_PAUSE_BLOCK_LIQUIDATION() == 7 days` (Wave A H-8)
- [ ] `TegridyLaunchpadV2.MAX_COLLECTIONS() == 10000`, `MIN_DEPLOY_FEE_WEI() == 1e15` (Wave A H-18)
- [ ] `RevenueDistributor.totalETHReceived()` returns 0 (the `_totalETHReceivedRaw == 1` prewarm is hidden by the view; Wave A H-11)
- [ ] `lib/SequencerCheck.checkSequencerUp(SEQUENCER_FEED, ...)` no-ops on chainid==1 (Wave A H-9)
- [ ] `TegridyFactory.guardian()` is non-zero (Wave A F-30-9 constructor requirement)

### Storage layout
- [ ] `forge inspect <Contract> storage-layout` matches `.audit_2026_freshlook/storage_layout/<Contract>.txt` for every contract.

### Frontend integration
- [ ] `frontend/src/lib/constants.ts` updated; `npm run wagmi:generate` regenerated `src/generated.ts`; CI green.
- [ ] Dashboard loads without console errors against new addresses.
- [ ] Stake/unstake/swap/repay round-trip works on mainnet through the UI.

### Indexer
- [ ] `ponder.config.ts` updated with new addresses + deployment block per contract.
- [ ] `rm -rf indexer/.ponder/` then `npm run codegen && npm run start`.
- [ ] Re-sync completes; no phantom 0x0-address rows in any table.

---

## 7. Operator runbook (accept-as-design items from Wave A)

These are intentional design choices that operators must observe to
avoid the corresponding finding's exploit shape.

| Action | Pre-condition |
|---|---|
| Disable a TegridyFactory pair (`emergencyDisablePair` or timelocked `proposePairDisabled`) | **First drain outstanding bribes** on that pair via `VoteIncentives.refundOrphanedBribe` / `claimBribesBatch`. (H-4 mitigation.) **Additionally:** if the disable lands MID-EPOCH (after votes are committed but before `voteEnd`), already-voted bribes will strand — the claim window is closed and refund paths reject disabled pairs. Use `emergencyDisablePair` only for true emergencies; for non-urgent disables, use the timelocked `proposePairDisabled` and announce the disable BEFORE the next epoch begins so voters can rotate their commitments. |
| Spam-deploy NFT pools for a single collection | Sudoswap-V2 `LSSVMPair` factory uses identical OR-seeding semantics (`msg.value >= MIN_DEPOSIT \|\| initialTokenIds.length > 0`) — accept-as-design under the mandate (battle-tested canonical). Spam is bounded by `MAX_POOLS_PER_COLLECTION = 200`. Front-end can RPC-rate-limit if needed. |
| Rotate treasury (`proposeTreasuryChange`) | Use multisig only. 48h timelock applies. POLAccumulator's harvest will respect the new treasury automatically. |
| Set `feeToSetter` (Factory) | Use `proposeFeeToSetterChange` + 24h timelock. The 48h FEE_TO_CHANGE delay is intentionally longer so a captured setter can't outrun a legitimate rotation (Wave A M-22 fix). |
| Add a JBAC NFT collection / approve a new collateral collection | `proposeWhitelistCollection` → 24h → `executeWhitelistCollection`. Wave A F-14-2 requires the collection to pass `supportsInterface(0x80ac58cd)` (ERC721). |
| Bump `MAX_REWARD_RATE` above 1e18 | Forbidden by hard cap. To increase emission cap requires a contract redeploy. |
| Deploy on an L2 | `SEQUENCER_FEED` env var **MUST** be set to the Chainlink L2 sequencer uptime feed for that chain. Wave A H-9 deploy gate refuses non-mainnet deploys without it. |
| Pause a contract | All `Pausable` contracts have a `MAX_PAUSE_BLOCK_LIQUIDATION = 7 days` cumulative cap (rolling 30-day window) on any path that gates user withdrawal-equivalent flows. Operators cannot indefinitely block lender claims (Wave A H-8 + re-fix CD-1). |
| Trigger `recoverStuckPrincipal` / `claimStrandedX` paths | These are pull-pattern recovery flows for users whose ETH/NFT couldn't be delivered. User self-claims; admin cannot redirect (Wave A F-95-K-7 etc.). |

---

## 8. Rollback / abort criteria

Abort the deploy if **any** of:

- A pre-flight checkbox is unchecked.
- A deploy stage's `forge script` reverts and the cause is not the H-9
  SEQUENCER_FEED gate (which is intentional fail-loud).
- An on-chain invariant smoke test fails.
- Storage-layout `forge inspect` diverges from the baseline file.
- Multisig `acceptOwnership` fails on any contract (deployer
  retains ownership — high-blast-radius if announced).

Recovery for partial deploys is contract-specific. The relaunch is
from a new wallet (no old state to migrate, per
`memory/project_relaunch.md`), so any contract not yet wired to other
contracts can simply be re-deployed from its individual script. The
abort cost is gas only; do not announce until every smoke test passes.

---

## 9. References

- Audit findings: `.audit_2026_freshlook/EXECUTIVE_SUMMARY.md`
- Accept-as-design list: `.audit_2026_freshlook/POST_MANDATE_STATE.md`
- Storage baseline: `.audit_2026_freshlook/storage_layout/`
- Minimal-surface mandate: `memory/feedback_minimal_surface.md`
- Legacy runbook (pre-Wave-A, kept for historical context): `DEPLOY_RUNBOOK.md`
- Existing deploy scripts: `contracts/script/`
- Existing wire scripts: `contracts/script/WireV2.s.sol`, `contracts/script/WireAuditFixes.s.sol`
- Verify script: `contracts/script/Verify.s.sol`
