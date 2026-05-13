# Scan7 — 4-Agent Adversarial Pass — 2026-05-09

**HEAD before scan:** `9f7193a` (post-scan6 + scan3 deploy hardening)
**HEAD after scan:** `37bb216` (scan7 commit)
**Duration:** parallel agents 200s–605s

---

## Summary (5-line)

| Severity | Count | Action |
|---|---|---|
| EXPLOITABLE | 0 | n/a — asymptotic floor reaffirmed (2nd consecutive scan) |
| DELETE-CLEAN applied | 4 | DC-1, DC-2, DC-3, DC-5 |
| DELETE-CLEAN deferred | 1 | DC-4 (via_ir stack-too-deep on cast chain) |
| NON-ISSUE (harden-by-adding rejected) | 14 | documented inline in agent reports |
| Net LoC change | −3 | mandate-positive net-negative |

---

## Method

4 parallel agents dispatched simultaneously, each with a non-overlapping 25-contract slice:

| Agent | Scope | Result |
|---|---|---|
| Staking + Restaking + Lending | TegridyStaking + StakingJbacVault + StakingAdmin + Restaking + Lending + LendingAdmin + NFTLending + LPFarming | 0 EXPLOITABLE + 4 DELETE-CLEAN |
| DEX + Hook + TWAP + NFT pool | TegridyPair + Factory + Router + FeeHook + TWAP + NFTPool + NFTPoolFactory + DropV2 + LaunchpadV2 + TokenURIReader | 0 EXPLOITABLE + 0 DELETE-CLEAN |
| Governance + Revenue + Grants | RevenueDistributor + GaugeController + VoteIncentives + VoteIncentivesAdmin + CommunityGrants + MemeBountyBoard + PremiumAccess + Toweli + lib/VotePowerOracle + base/OwnableNoRenounce + base/TimelockAdmin | 0 EXPLOITABLE + 0 DELETE-CLEAN |
| POL + Fee Routers + Cross-contract | POLAccumulator + SwapFeeRouter + SwapFeeRouterAdmin + ReferralSplitter + lib/WETHFallbackLib + lib/SafeERC721Call + lib/SequencerCheck + 9 cross-contract integration paths | 0 EXPLOITABLE + 1 DELETE-CLEAN |

Each agent operated under the strict minimal-surface mandate: only flag findings whose fix is sibling-canonical or DELETE; reject any finding requiring new state, admin functions, mappings, or claim flows ("harden-by-adding").

---

## DELETE-CLEAN findings (4 applied)

### DC-1: TegridyNFTLending.acceptOffer expiry shim
- **File:line:** [TegridyNFTLending.sol:633](../../contracts/src/TegridyNFTLending.sol)
- **Pre-fix:** `if (offer.expiry != 0 && block.timestamp > offer.expiry) revert OfferExpired();`
- **Post-fix:** `if (block.timestamp > offer.expiry) revert OfferExpired();`
- **Reason:** `createOffer` enforces `_expiry >= block.timestamp + MIN_OFFER_VALIDITY (1h)`; post-relaunch every offer has expiry > 0. Sibling-canonical with TegridyLending.acceptOffer at line 1065 (no shim there). Pre-M10 dead code per `project_relaunch.md`.

### DC-2: TegridyNFTLending.acceptOffer treasuryAtCreate fallback
- **File:line:** [TegridyNFTLending.sol:646–647](../../contracts/src/TegridyNFTLending.sol)
- **Pre-fix:** `if (feeRecipient == address(0)) feeRecipient = treasury;`
- **Post-fix:** removed.
- **Reason:** Constructor + setter enforce `treasury != address(0)`; `createOffer` always writes `treasuryAtCreate: treasury`. Pre-LD2-M3 offers (the only source of address(0)) don't exist post-relaunch.

### DC-3: TegridyLending.acceptOffer treasuryAtCreate fallback
- **File:line:** [TegridyLending.sol:1080–1081](../../contracts/src/TegridyLending.sol)
- **Pre-fix:** `if (feeRecipient == address(0)) feeRecipient = treasury;`
- **Post-fix:** removed.
- **Reason:** Sister-canonical of DC-2 in the staking-collateral lending sibling. Same dead-fallback shape.

### DC-5: POLAccumulator dead validity constants
- **File:line:** [POLAccumulator.sol:942–944](../../contracts/src/POLAccumulator.sol)
- **Pre-fix:** 3 public constants (`BACKSTOP_PROPOSAL_VALIDITY`, `SLIPPAGE_PROPOSAL_VALIDITY`, `ACCUMULATE_CAP_PROPOSAL_VALIDITY`).
- **Post-fix:** all 3 deleted.
- **Reason:** Comment claimed "test compatibility" but `grep` across the entire repo found ZERO references. Pure surface inflation.

---

## DELETE-CLEAN deferred (1)

### DC-4: TegridyLending.repayLoan int16 negative-sentinel
- **File:line:** [TegridyLending.sol:1297–1300](../../contracts/src/TegridyLending.sol)
- **Pre-fix:** `int16 snapBps = ...; uint256 effectiveFeeBps = snapBps < 0 ? protocolFeeBps : uint256(uint16(snapBps));`
- **Attempted post-fix:** `int16 snapBps = ...; uint256 effectiveFeeBps = uint256(uint16(snapBps));`
- **Status:** DEFERRED — Yul stack-too-deep error in `repayLoan` under via_ir. Both inline (`uint256(uint16(offers[offerId].protocolFeeBpsAtCreate))`) and local-variable forms fail. The original 3-line ternary's `protocolFeeBps` SLOAD branch apparently materializes a stack slot the optimizer needs.
- **Resolution:** kept original code with explanatory comment; per mandate "defer if delete breaks build."
- **Future:** could be resolved by extracting `repayLoan` into smaller functions (free stack pressure), but that would be a refactor — out of mandate scope.

---

## NON-ISSUE (harden-by-adding rejected — would require new state)

| Class | Site | Rationale |
|---|---|---|
| ReferralSplitter live qualification gate | `ReferralSplitter.sol:380, 388, 641, 650, 679, 688` | Economically defended by 7d MIN_LOCK + 25% earlyWithdraw penalty (uneconomic to flash-stake for one boolean check). |
| TegridyFeeHook accruedFees vs PoolManager balance drift | `TegridyFeeHook.sol:472–510` | Closed structurally by 24h-timelocked + 7d-cooldown + 10%-step `proposeSyncAccruedFees / executeSyncAccruedFees` (D-AMM-M4 snapshot). |
| ETH-ingress counter overflow at 2^256 | `POLAccumulator.sol:297, SwapFeeRouter.sol:2057` | Cosmic (~1e51× ETH supply); Solidity 0.8 checked-add cannot panic in universe lifetime. |
| Whitelisted-but-malicious collateral mid-flight loan record | `TegridyNFTLending.sol:704–735, TegridyLending.sol:1134–1175` | Post-condition `ownerOf == address(this)` revert protects fund flow. |
| NFT receiver hook stale views in `swapETHForNFTs` | `TegridyNFTPool.sol:301–317` | No on-chain consumer reads `accumulatedLPFees` / `accumulatedProtocolFees` during state-mutating tx. |
| Same-block claim race (`epoch.timestamp = block.timestamp - 1`) | `RevenueDistributor.sol:440–491` | Trace208 upperLookup excludes same-block stakes (numerator + denominator both pinned to T-1). |
| Sub-quorum bribe DoS | `VoteIncentives.sol:211, 807, 1303` | Symmetric three-path coverage (claim / refundOrphaned / refundSubQuorum / refundUnvoted). |
| Multi-token reservation cross-contamination (CommunityGrants) | `CommunityGrants.sol:157–158, 894–915` | Per-token aggregates bound separately (TOWELI vs ETH); no cross-token sweep path. |
| MemeBountyBoard global-sweep absence | `MemeBountyBoard.sol:626–651, 803–812` | Per-user expiry sweep paths exist; HOLDS-BY-CONVENTION (per scan6) — no global sweep means no aggregate to miss. |
| Toweli ERC20 trapdoor | `Toweli.sol` | No owner; `_initialMintDone` constructor-set; `_update` rejects post-construction mints. |
| OwnableNoRenounce 23-byte EIP-7702 carve-out | `OwnableNoRenounce.sol:124–125` | Length-only check correct under EIP-3541/7702 invariants (no legitimate 23-byte runtime starting `0xef`). |
| TimelockAdmin pending-VALUE replay | `TimelockAdmin.sol:195–207` | `_execute` clears state pre-effects; `pendingX = 0` in every executeXxx body. |
| WETHFallbackLib triple-fallback absence | `lib/WETHFallbackLib.sol:117–143` | Critical-path callers WANT to revert; `NoRevert` variant covers batch-payee callers. Solmate-canonical. |
| ReferralSplitter banned-referrer pendingETH lock | `ReferralSplitter.sol` | Owner-key-compromise abuse, NOT a new vector. 24h ban timelock is documented community-reaction window. |

---

## Posture After scan7

- **Test suite:** forge build clean, full non-invariant test suite green.
- **Asymptotic floor:** reaffirmed (scan6 + scan7 both = 0 EXPLOITABLE).
- **Codebase:** sibling-canonical against Uniswap V2/V4-core/Sudoswap V2/Aave V3/Synthetix StakingRewards/ERC-2981/Solady/Solmate/Gondi MultiSourceLoan/OZ at every load-bearing site.
- **Remaining surface:** intentionally caller-trust (router slippage), cosmically-bounded (counter overflow), or owner-trust (admin keys deferred to multisig phase).

## Recommendation

Continued in-house scanning produces diminishing-to-zero returns. Future audit budget is better spent on:
1. **Paid-firm engagement** (Spearbit / OpenZeppelin / ChainSecurity) targeting the architectural cluster: per-tokenId attribution, V4 hook semantics, boost-cache lifetime, multisig key model, restaking↔staking↔lending tri-contract reward flow.
2. **Off-chain operational hardening:** multisig migration for `owner()`, monitoring on `DeviationBypassed` / `RoyaltyOrphaned` / `ETHToWETHFallback` events, `totalETHReceived` reconciliation.
3. **Deployment-time invariants:** CREATE2 salt mining for hook bitmask, factory-immutable wiring, MULTISIG envvar enforcement on remaining deploy scripts.

— **End of scan7 verdict.**
