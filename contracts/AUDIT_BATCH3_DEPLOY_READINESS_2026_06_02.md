# Batch 3 — Pre-Deploy Audit Readiness (2026-06-02)

Pre-deploy security audit-wave on the **10 deploy-gated ("Coming Soon") features**. Each
feature with a contract was reviewed against its canonical battle-tested pattern with a
full attacker pass (≥3 hijack/theft/DoS scenarios + the standard vuln matrix), and **every
finding was adversarially re-verified against the real code** to strip false positives
(these multi-agent runs over-report; the broader contract set already passed a clean
audit on 2026-05-31).

Method: 9 parallel deep audits → adversarial verification of every finding → synthesis.
Raw findings: 2 → survived verification: 2 (0 refuted). No Critical; no Medium/Low.

---

## Executive summary

| Feature | Contract(s) | Canonical | Verdict |
|---|---|---|---|
| LP Farming | `TegridyLPFarming` | Synthetix StakingRewards | ✅ DEPLOY-READY |
| Gauge Voting | `GaugeController` + `lib/VotePowerOracle` | Curve/Velodrome | ✅ DEPLOY-READY |
| Vote Incentives (Bribes) | `VoteIncentives(+Admin)` | Votium/Hidden Hand | ⚠️ → ✅ **FIXED** (1 HIGH) |
| Bounties | `MemeBountyBoard` | custom escrow | ✅ DEPLOY-READY |
| Grants / Governance | `CommunityGrants` | Governor + Escrow | ⚠️ → ✅ **FIXED** (1 HIGH) |
| Premium Access | `PremiumAccess` | custom subscription | ✅ DEPLOY-READY |
| Token Lending (P2P) | `TegridyLending(+Admin)` | Gondi | ✅ DEPLOY-READY |
| NFT AMM Pools | `TegridyNFTPool(+Factory)` | Sudoswap | ✅ DEPLOY-READY |
| NFT Lending (P2P) | `TegridyNFTLending(+Admin)` | Gondi/NFTfi | ✅ DEPLOY-READY |
| **Launchpad V2** | recovered from git | NFT-drop factory (OZ Clones) | ✅ **DEPLOY-READY** (re-audited 2026-06-02; 1 MEDIUM fixed) |

**7 of 9 implemented features were deploy-ready with zero surviving exploits. The 2 with a
confirmed HIGH have been remediated (this batch). Launchpad V2's contracts were recovered from
git and re-audited 2026-06-02 (1 MEDIUM fixed) — now DEPLOY-READY (see §3).**

Confirmed findings by severity: **Critical 0 · High 2 (both now fixed) · Medium 0 · Low 0.**
Both HIGHs were *functional/solvency* blockers — **no external theft/drain/reentrancy/double-spend
exploit survived verification on any contract.**

---

## Remediation applied 2026-06-02

### HIGH-1 — Vote Incentives: `claimBribesBatch` missing claim-window gate (fund loss)

- **Location:** `contracts/src/VoteIncentives.sol` — `claimBribesBatch` loop.
- **Bug:** the single-epoch `claimBribes` gates payout on `block.timestamp > voteEnd`
  (`ClaimWindowNotOpen`, L811-815) so the `totalGaugeVotes` denominator is crystallized
  before any share is paid. `claimBribesBatch` performed the same share math with **no such
  gate**. Because `totalGaugeVotes` keeps growing through the multi-day vote window while
  `epochBribes` is never decremented and all pools share one commingled balance, an early
  batch-claimer over-shares against a too-small denominator; the excess is drawn from other
  epochs' bribes / pending withdrawals / treasury fees, breaking `sum(shares) ≤ bribeAmount`.
  *Exploit:* Alice (sole early voter) batch-claims 100% of a 100-ETH pool mid-window; Bob
  votes later and claims 50 ETH against the grown denominator → 150 ETH out of a 100-ETH pool.
- **Fix:** mirror the single-epoch gate inside the batch loop — for each epoch `e`, compute
  `voteEnd = usesCommitReveal ? revealDeadline(e) : timestamp + VOTE_DEADLINE` and
  `if (block.timestamp <= voteEnd) continue;` (`continue`, not `revert`, to preserve batch
  skip semantics). Self-contained; VoteIncentives is not yet deployed.

### HIGH-2 — Grants: `createProposal` reverts for every caller (feature 100% bricked)

- **Location:** `contracts/src/CommunityGrants.sol` — interface + `createProposal`.
- **Bug:** `createProposal` called `votingEscrow.userPositionCount(msg.sender)`, but on the
  production vote-power source (`TegridyStaking`) that method is declared **`internal`**
  (`TegridyStaking.sol:782`, golfed external→internal for EIP-170) with no `fallback()` — so
  the selector does not exist and **every `createProposal` call reverts**. No proposal could
  ever be created → no votes → no grants. *Masked by CI:* the test injected `MockVEGrants`
  whose `userPositionCount` was `external pure returns(1)`, so the suite went green while
  production bricked.
- **Fix (CommunityGrants-only — the frozen, possibly-live `TegridyStaking` is NOT touched):**
  each staking position is an ERC721 (`TegridyStaking is SoladyERC721`), so the standard
  external **`balanceOf(user)`** returns the exact position count. Swapped the interface
  method and call site to `balanceOf`. Also renamed the test mock's method to `balanceOf`
  so it mirrors the real contract surface — closing the divergence that masked the bug.
- **Follow-up (recommended, not yet done):** add an integration test that builds
  `CommunityGrants` against the **real** `TegridyStaking` (not the mock) and asserts
  `createProposal` succeeds end-to-end, so a selector mismatch can never again pass CI.

**Verification (2026-06-02):** `forge build` OK — CommunityGrants 18,705 B, VoteIncentives
24,274 B (both under the 24,576 EIP-170 limit). `forge test` green — CommunityGrants 31/31
(incl. `createProposal` success), VoteIncentives 68/68.

---

## Per-feature attacker-pass highlights (all verified NOT exploitable)

- **LP Farming** — retroactive-boost theft (anchors on old effective balance before boost
  refresh), boost struct-misalignment (uint16 + 45000 clamp), forfeit-reclaim drain
  (`balance − owedFutureRewards` cap), empty-period windfall (Synthetix forfeit semantics),
  reentrancy (no-hook TOWELI/UniV2 LP, CEI), admin rug (staking/reward tokens unrecoverable).
- **Gauge Voting** — double-vote via NFT transfer (per-tokenId + per-owner + EOA 1-position
  cap), flash-stake (`min(powerAt(epochStart−1), live)`), emission capture (5000-bps cap +
  O(n²) dedup), lone-voter capture (3-NFT quorum fail-closed), restaking-pointer hijack
  (48h timelock).
- **Bounties** — per-bounty escrow; status flips terminal before external call; compromised
  owner cannot redirect to itself (emergency refunds only the creator); 365d sweep gates.
- **Premium Access** — invariant `balance ≥ totalRefundEscrow + totalShortfallOwed` holds by
  construction; flash-loan JBAC spoof contained (only `hasPremiumSecure()` consumed on-chain).
- **Token Lending** — flash-loan free-NFT (interest floors), reentrancy (CEI + 30k-gas WETH
  fallback), cross-loan reward drain (conservation law holds), default-timing complementary
  boundaries, captured-admin bounded by 48h timelock + ceilings, optional TWAP floor
  (30-min, staleness + sequencer gate).
- **NFT AMM** — buy/sell curve re-derived = canonical Sudoswap `LinearCurve`; reserved-ETH
  solvency proven inductively; V4 reentrancy fix (`_swapCaller` cleared before payout);
  CREATE2 anti-front-run salt; royalty 25%-capped + gas-capped.
- **NFT Lending** — offer double-spend (CEI + `active` flip), owner-sweep blocked while
  collateral active, pause-grief bounded (7d/30d), sequencer-outage symmetric buffer,
  EIP-170 Admin split preserves invariants.

---

## Launchpad V2 — RESOLVED 2026-06-02 (recovered, re-audited, deploy-ready)

> **UPDATE 2026-06-02:** RESOLVED. `TegridyDropV2` + `TegridyLaunchpadV2` were recovered from
> git (audited then cut from the MVP, not missing), re-audited fresh, and the one MEDIUM found
> was fixed + regression-tested. **Launchpad V2 is now DEPLOY-READY** — see
> [`AUDIT_LAUNCHPADV2_2026_06_02.md`](AUDIT_LAUNCHPADV2_2026_06_02.md). Original as-found
> assessment preserved below.

**No on-chain contract exists (as originally found).** The Launchpad V2 frontend (create-collection wizard,
`TEGRIDY_LAUNCHPAD_V2_ABI` / `TEGRIDY_DROP_V2_ABI`) calls a contract that an exhaustive
file + function-signature search of `contracts/src` confirms is **not present** — no
`createCollection` / `mintPhase` / `MintPhase` anywhere. It was likely deleted as a "V1
duplicate" and never replaced.

**Implications:** cannot be audited (no source), cannot be deployed (no bytecode). The
frontend + ABIs create a false "built" impression.

**Recommended path (per minimal-attack-surface mandate):**
1. Do **not** hand-roll it. Adapt a canonical NFT-drop / clone-factory pattern (e.g. Solady
   ERC721 + a minimal-proxy factory, or an established drop-minter) with only conservative tweaks.
2. Run the **same full audit wave** as the other 9 features before it is deploy-eligible.
3. Until then, keep the frontend Launchpad surface gated (existing `isDeployed` /
   `FeatureNotDeployed` placeholder) so it never points users at a non-existent contract.

---

## Deploy sequence (operator)

The 9 implemented features are deploy-ready (the 2 fixed ones verified green:
`forge build` + `forge test`, CommunityGrants 31/31 incl. createProposal success,
VoteIncentives 68/68). Each has a deploy script under
`contracts/script/` (`DeployTegridyLPFarming`, `DeployGaugeController`, `DeployVoteIncentives`,
`DeployMemeBountyBoard`, `DeployCommunityGrants`, `DeployPremiumAccess`, `DeployTegridyLending`,
`DeployNFTPoolFactory`, `DeployNFTLending`). Per project rule, the **mainnet deploy + address
wiring in `frontend/src/lib/constants.ts` remains an operator action** (multisig). Features
auto-un-gate in the UI once their real address is set.

**Order note:** `CommunityGrants` and `VoteIncentives` depend on `TegridyStaking` (vote power)
and the gauge epoch; deploy staking + gauge controller first, then wire the one-shot setters
(`setGaugeController`, `setRestakingContract`, `setVoteIncentivesAdmin`) before opening to users.
