# Agent 043 — Admin-Key Blast-Radius Matrix

**Audit-only.** Privileged-role surface across `contracts/src/`. 28 .sol files, 305 access-control hits across 20 contracts. Goal: enumerate single-point-of-compromise admin keys and rank by blast radius.

## Headline Counts

| Metric | Count |
|---|---|
| .sol files in src | 28 (24 contracts + 2 base + 2 lib/iface) |
| Files with `onlyOwner` / `onlyRole` / `hasRole` | 20 |
| Files inheriting `OwnableNoRenounce` (OZ Ownable2Step + renounce-disabled) | 17 |
| Files inheriting `TimelockAdmin` (MakerDAO DSPause pattern, propose→delay→execute) | 19 |
| Files with `propose*`/`execute*` timelocked admin pairs | 18 |
| Files with `_pause()` / `whenNotPaused` | 18 |
| Admin-free contracts (no owner, no role) | 4: `Toweli`, `TegridyPair`, `TegridyRouter`, `TegridyTokenURIReader` |
| Custom (non-OZ) 2-step ownership | 2: `TegridyDropV2`, `TegridyTWAP` |
| Pause functions with **automatic expiry / max-pause-duration** | **0** |

Toweli token is fully ownerless — fixed 1B mint, no admin, nothing to rug at the token layer. TegridyPair/Router/URIReader are stateless pure-AMM/view contracts with no privileged surface.

## Single-Compromise Map (governance-multisig → blast radius)

The protocol uses ONE owner per contract (set in constructor → `OwnableNoRenounce(msg.sender)`). Per `project_wave0_pending.md` 3 contracts still pending multisig `acceptOwnership`. If the deploying EOA / multisig is compromised, the radius below applies — but ONLY after the per-contract timelock delay (typically 24–48h, fee/treasury changes, sweeps) UNLESS the admin call is in the non-timelocked set.

### Top-5 Highest-Blast-Radius Keys (ranked by what an attacker can grab + whether timelocked)

| # | Key (Contract.function) | What it controls | Timelocked? | Blast Radius | Severity |
|---|---|---|---|---|---|
| **1** | `SwapFeeRouter.proposeFeeSplit / proposeTreasuryChange / proposeRevenueDistributor / proposePolAccumulator / proposeReferralSplitterChange` (owner) | Routes 100% of swap-fee flow. Treasury target, staker/POL split, downstream distributor, referral splitter — every dollar of swap fee revenue. | YES (TimelockAdmin) | Re-direct ALL future protocol fees + redirect distribution chain | CRITICAL but timelocked |
| **2** | `SwapFeeRouter.sweepETH() / withdrawTokenFees(token) / sweepTokens(token) / recoverCallerCreditFrom()` (owner, NOT timelocked) | Direct withdraw of accumulated ETH/token fees + sweep of "stuck" tokens. Reserves `accumulatedETHFees + totalPendingDistribution` so user pending is safe, but anything above is owner-grabbable instantly. Lines 1043, 1062, 1176, 1222. | **NO** | Instant grab of unallocated fee balance + any token "dust" | HIGH |
| **3** | `RevenueDistributor.emergencyWithdraw() / proposeTokenSweep / proposeForfeitReclaim / proposeTreasuryChange / proposeRestakingChange` | Holds protocol revenue earmarked for stakers. `emergencyWithdraw` is `onlyOwner nonReentrant` (line 268) — gated by EMERGENCY_WITHDRAW_EXCESS timelock proposal, but `pause()` is direct. | MIXED (emergency is timelocked via `proposeEmergencyWithdrawExcess`, pause is not) | Freeze staker rewards instantly via pause; drain "excess" after timelock | HIGH (because of pause leverage) |
| **4** | `TegridyFactory.proposeFeeToChange + executeFeeToChange` (`feeToSetter`-only) **+** `TegridyFactory.guardian.emergencyDisablePair` (instant, no timelock) | feeToSetter controls protocol fee recipient on ALL pairs (every pool). Guardian (separate role, set by feeToSetter) can **instantly** disable any pair (no timelock — line 358). | feeTo: YES (48h). Guardian disable: **NO** (intentional circuit-breaker) | Re-route swap protocol fees (timelocked); halt trading on any pair instantly | HIGH (guardian compromise = DoS any pair) |
| **5** | `TegridyStaking.proposeRewardRate / proposeTreasuryChange / proposeRestakingContract / proposeLendingContract / sweepToken` + `pause()` | Holds stakers' tsTOWELI-NFT positions + pending rewards. Rate/treasury/restaking are timelocked. `pause()` is direct (line 491). `sweepToken(token)` is direct (line 1267) — claims to skip Toweli, must verify. | MIXED | Pause locks stakers out (no expiry); sweep grabs non-Toweli dust | HIGH (lock-out via pause) |

### Honorable Mentions (HIGH but slightly lower)

- **`TegridyLending.pause()` + `proposeMaxAprBps / proposeMaxPrincipal / proposeProtocolFeeChange`** — owner can freeze loan repayments via pause (no expiry); rate caps are timelocked. Borrower funds locked while paused.
- **`TegridyNFTPool.withdrawETH / withdrawNFTs / syncNFTs`** — direct owner withdraw of pool ETH and NFTs. NFT pools are isolated per-pool though, so radius is per-pool not protocol-wide. Lines 410, 417, 436.
- **`POLAccumulator.proposeSweepETH / executeSweepETH + proposeHarvestLP`** — controls protocol-owned-liquidity treasury. Timelocked, owner-only.
- **`TegridyTWAP.setFeeRecipient` (NOT timelocked, line 286) + `setUpdateFee` (NOT timelocked, line 278, capped 0.01 ETH)** — fee recipient instant change. Update fees are dust-tier capped, so radius is small. Custom 2-step ownership (line 40).
- **`TegridyDropV2.withdraw() / cancelSale() / transferOwnership`** — per-clone, isolated. Withdraw gated by `mintPhase == CLOSED || soldOut` (post-AUDIT NEW-L1 fix). Custom 2-step ownership not OZ.
- **`MemeBountyBoard.emergencyCancel / emergencyForceCancel / sweepExpiredRefund`** — owner can cancel any bounty + sweep refund after expiry. Per-bounty, scoped.

## Owner-Can-Rug Patterns Found

| Function | Contract:line | Timelocked? | Notes |
|---|---|---|---|
| `sweepETH` | SwapFeeRouter:1043 | NO | reserves user-pending; remainder owner-grabbable |
| `withdrawTokenFees(token)` | SwapFeeRouter:1062 | NO | sends to `treasury` not arbitrary recipient — timelocked treasury change limits damage |
| `sweepTokens(token)` | SwapFeeRouter:1176, POLAccumulator:500, RevenueDistributor:642 (`sweepDust`), CommunityGrants:554 (`sweepFees`), VoteIncentives:937, TegridyStaking:1267, TegridyRestaking:666 | NO (most) | Various scoping — `sweepDust` excludes accounted balances |
| `executeTokenSweep` | RevenueDistributor:672 | YES | proper `propose→execute` |
| `executeSweepETH` | POLAccumulator:391 | YES | propose→execute |
| `withdrawTreasuryFees` | ReferralSplitter:504, VoteIncentives:846 | NO direct, **but to fixed timelocked `treasury` only** | radius = re-route via timelocked treasury change |
| `withdrawETH(amount)` | TegridyNFTPool:410 | NO | direct owner pull, sends to `msg.sender` (owner). Per-pool isolation. |
| `emergencyRecoverETH(_recipient)` | CommunityGrants:565 | NO, but `whenPaused` only | arbitrary recipient — OWNER CAN PICK ADDRESS during pause |
| `withdrawProtocolFees` | TegridyNFTPoolFactory:389 | NO | sends to fixed `protocolFeeRecipient` (timelocked change) |
| `sweepETH` | TegridyFeeHook:411 | NO | hard-coded sends to `revenueDistributor` (good — no recipient choice) |
| `emergencyForceReturn / rescueNFT` | TegridyRestaking:861, 873 | NO, paused-only for force | rate-limited (FORCE_RETURN_COOLDOWN), can't choose recipient (returns to original restaker) |
| `withdraw()` | TegridyDropV2:418 | NO | gated on `CLOSED || soldOut` post-AUDIT NEW-L1; sends to creator + platformFeeRecipient |

**Notable strict pattern**: most "sweep" calls send to a `treasury` whose change is itself timelocked — so even if owner wallet is compromised TODAY, attacker must wait 24–48h to redirect treasury, during which time pull functions still flow to old (good) treasury. Defense-in-depth works.

**Notable weak spot**: `CommunityGrants.emergencyRecoverETH(_recipient)` line 565 — owner picks recipient, only requires `whenPaused`. Owner controls pause too. Effectively: pause → wait blocks → recover-to-attacker. NOT timelocked. **MEDIUM-HIGH; recommend tightening to fixed treasury**.

## Owner-Can-Freeze-Users (pause without expiry)

ALL 18 paused contracts have `pause()` + `unpause()` as direct `onlyOwner` calls with **no maximum pause duration** and **no auto-expiry**. Standard for the codebase, matches battle-tested defaults. But: a compromised owner can pause indefinitely → lock stakers, lenders, NFT depositors, voters out of their funds with no on-chain remediation.

**Mitigation in current design**: emergency-exit paths exist:
- `TegridyStaking.emergencyWithdrawPosition(tokenId) external nonReentrant whenPaused` (line 1078) — paused-only emergency exit, anyone can call for their own position. Mitigates pause-rug.
- `TegridyLPFarming.emergencyWithdraw()` (line 335) — no pause guard, callable always.
- `TegridyRestaking.emergencyWithdrawNFT()` (line 789) — `nonReentrant` only, callable always.
- `TegridyNFTLending` — no `whenPaused` emergency exit visible; borrower funds locked during pause. **POTENTIAL FREEZE VECTOR.**
- `TegridyLending` — same risk; needs verification.

**Recommendation**: add max-pause-duration (e.g., `if (paused && block.timestamp > pausedUntil) revert PauseExpired()`) or unconditional emergency exit on TegridyLending / TegridyNFTLending. Aave V3 uses 30-day max pause. Not currently in scope per `project_scope_decision.md` but documented for completeness.

## Owner-Can-Change-Fee-Recipient

All fee recipients are mediated by **timelocked treasury/recipient changes**:
- SwapFeeRouter: `proposeTreasuryChange` (24h+)
- RevenueDistributor: `proposeTreasuryChange`
- TegridyLending / TegridyNFTLending: `proposeTreasuryChange`
- TegridyLaunchpadV2: `proposeProtocolFeeRecipient`
- TegridyNFTPoolFactory: `proposeProtocolFeeRecipientChange`
- POLAccumulator / TegridyLPFarming / TegridyStaking / TegridyRestaking / VoteIncentives / CommunityGrants: all timelocked
- TegridyFactory: `proposeFeeToChange` 48h timelock

**Two NON-timelocked exceptions**:
1. `TegridyTWAP.setFeeRecipient(_recipient) onlyOwner` (line 286) — instant. Acceptable: max grab is `accumulatedFees` from `MAX_UPDATE_FEE` 0.01 ETH cap × calls. Dust-tier.
2. `TegridyDropV2.withdraw()` (per-clone) — `platformFeeRecipient` is **immutable from constructor** (Init struct) — cannot be changed. 

## Owner-Can-Set-Oracle-To-Arbitrary-Contract (price spoof)

**Scanned for**: `setOracle`, `setPriceFeed`, `setTWAP`, `priceOracle =`, `oracle =`. **NO matches.** Tegridy oracle is `TegridyTWAP` which is read-only from external consumers; consumers do not have a settable oracle pointer in any contract. NFT pricing in `TegridyNFTPool` uses internal bonding curve (spotPrice + delta) — both mutated through timelocked `proposeSpotPrice` / `proposeDelta`. **CLEAN.**

## Owner-Can-Mint-Or-Blacklist

- **Mint**: Toweli has no mint. TegridyDropV2 mint is permissionless under merkle/dutch/public phase rules. TegridyStaking `mint` is on staking deposit (NFT-position receipt, not value). NO admin mint of value-bearing tokens.
- **Blacklist of users**: NONE. The strings "blacklist" / "blocklist" appear only as defensive try/catch around external tokens that may blacklist this contract — i.e., the protocol is the victim, not the perpetrator.
- **TegridyFactory.proposeTokenBlocked** — owner can block a token from creating NEW pairs (24h timelock). Does NOT affect existing pair user funds. Reasonable abuse-prevention surface.
- **TegridyNFTLending.proposeWhitelistCollection / proposeRemoveCollection** — collection-level whitelist for NEW loans; existing escrowed NFTs are protected per the comment at line 115 ("scam collection could be blocklisted while its NFTs were still escrowed"). Verified safe.

## Role-Granting-Role / Escalation Paths

**No `AccessControl.sol` usage anywhere in src.** All 20 admin-bearing contracts use Ownable2Step (single owner) — no role hierarchy → no role-granting-role escalation possible. Single-key design.

`TegridyFactory.guardian` is the only multi-actor pattern: `feeToSetter` sets `guardian`, guardian can instantly disable pairs. `feeToSetter → guardian` is a one-way grant; guardian cannot escalate to feeToSetter. Reasonable.

## Role Transfers Without 2-Step

ALL ownership transfers are 2-step:
- 17 contracts: OZ Ownable2Step via `OwnableNoRenounce` base
- TegridyDropV2: custom `transferOwnership` + `acceptOwnership` (line 467/472) — verified 2-step
- TegridyTWAP: custom 2-step in `TWAPAdmin` abstract (line 40/45)
- TegridyFactory.feeToSetter: `pendingFeeToSetter` 48h timelock + accept (effectively 2-step + timelock)

`renounceOwnership` is **disabled everywhere** (`OwnableNoRenounce`, custom revert in TegridyDropV2:478 / TegridyTWAP:52). No accidental admin loss possible.

## TimelockAdmin Cross-Reference: Should-Be-Timelocked-But-Isn't

| Contract.function | Status | Recommendation |
|---|---|---|
| `pause()` / `unpause()` (all 18 contracts) | Direct onlyOwner | INFO — battle-tested standard; consider max-pause-duration on Lending/NFTLending where no emergency-exit exists |
| `SwapFeeRouter.sweepETH / withdrawTokenFees / sweepTokens` | Direct onlyOwner, fixed treasury | LOW — sends to timelocked treasury, indirect protection adequate |
| `CommunityGrants.emergencyRecoverETH(_recipient)` | Direct onlyOwner, **caller-chosen recipient**, paused-only | **MEDIUM — tighten to fixed feeReceiver** |
| `TegridyTWAP.setFeeRecipient` | Direct onlyOwner | INFO — dust-tier (0.01 ETH cap) |
| `TegridyNFTPool.withdrawETH / withdrawNFTs` | Direct onlyOwner | INFO — per-pool isolation, by design (per-pool LP-style ownership) |
| `TegridyRestaking.rescueNFT(_to)` | Direct onlyOwner | LOW — only callable on NFTs not actively restaked; reasonable dust recovery |

## Conclusion

The codebase is **unusually well-hardened** for admin surface:
- Universal `OwnableNoRenounce` (OZ Ownable2Step + renounce-disabled)
- Universal `TimelockAdmin` (MakerDAO DSPause) for all parameter changes
- No `AccessControl` role-hierarchy → no escalation paths
- No admin mint, no user blacklist, no settable oracle
- Sweep functions almost universally route to timelocked treasury, not arbitrary addresses

**Single critical finding**: `CommunityGrants.emergencyRecoverETH(_recipient)` allows arbitrary-recipient ETH recovery during pause — owner controls pause, so this is a 2-step rug (pause → recover) without timelock.

**Single high finding**: TegridyLending / TegridyNFTLending have no callable-during-pause emergency-exit for borrowers/lenders → indefinite freeze risk if owner compromised.

**Top blast radius**: SwapFeeRouter is the financial chokepoint of the protocol; fortunately every value-changing function on it is timelocked. Direct-call sweeps go to fixed timelocked treasury, limiting same-day damage.

**Wave-0 caveat** (per memory): three contracts still on EOA owner pending multisig `acceptOwnership`. Until accepted, those keys are single-EOA risk. Identify-and-prioritize multisig acceptance.
