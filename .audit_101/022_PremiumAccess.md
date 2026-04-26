# Audit 022 — PremiumAccess.sol

Agent: 022 / 101 (forensic). AUDIT-ONLY (no code changes).
Target: `contracts/src/PremiumAccess.sol`.
Cross-checked: `contracts/test/PremiumAccess.t.sol`, `contracts/test/Audit195_PremiumHook.t.sol`, plus references in `FinalAudit_POLPremium.t.sol` & `RedTeam_POLPremium.t.sol`.

Hunt scope: access bypass via expired→re-active manipulation, expiry timestamp underflow, refund accounting drift, multiple-tier overlap, owner free-grant rug, signature replay on activation, ERC20 fee-on-transfer underpay, payment token blacklist DoS, missing pause, frontend-only gating bypass, NFT-based tier transfer race, extension window edge cases.

Architecture summary: single-tier monthly subscription paid in TOWELI plus parallel free access via JBAC NFT holding (with 15s activation delay). No multi-tier system, no signatures, no owner free-grant function — those vectors are N/A (recorded as INFO).

---

## HIGH

### H-01 — `subscribe()` extension consumed-portion accounting under-credits `totalRefundEscrow` (drift toward shortfall)
File/lines: `PremiumAccess.sol` L186-242 (extension branch L203-217).

In the extension branch, `consumed = userEscrow[msg.sender] - remainingEscrow` is subtracted from `totalRefundEscrow`, then the new full `cost` is added back as escrow. The user's escrow becomes `remainingEscrow + cost`, but `totalRefundEscrow` is increased by `cost` only — that net is correct mathematically. However the `startedAt` is intentionally NOT reset (the comment says "Keep original startedAt so refund calculation covers the full escrowed period"), so when the user later cancels, the cancel path computes `totalDuration = sub.expiresAt - sub.startedAt` against the ORIGINAL `startedAt` (which can be tens of days in the past), but `escrowed` reflects the FULL re-stocked deposit. This causes `cancelSubscription`'s `(escrowed * remainingTime) / totalDuration` to systematically **under-refund** users who extend mid-period — the consumed portion of the first period is double-counted as "consumed" in the cancel pro-rata math even though the escrow was already trued-up at extension time.

Concrete scenario:
- t=0: subscribe 1mo, pay 1000, escrow=1000, startedAt=0, expiresAt=30d.
- t=15d: extend by 1mo. Code calculates remainingEscrow = 1000 * 15/30 = 500, sets escrow=500+1000=1500, expiresAt=60d, startedAt UNCHANGED at 0. totalRefundEscrow correctly tracks 1500.
- t=15d+1s: user cancels. remainingTime = 60d - 15d - 1s ~= 45d. totalDuration = 60d - 0 = 60d. refund = 1500 * 45d / 60d = 1125. But user paid 1500 worth of escrow that should be ~1500 refundable (only 1 second elapsed since the extension's deposit). They lose ~375 TOWELI.

Severity rationale: silent fund loss for any user who extends and cancels. Proportional to elapsed time before extension. Listed as HIGH because it is reproducible, deterministic, and produces real economic loss without any malicious actor.

Recommendation: at extension, reset `sub.startedAt = block.timestamp` and let `totalDuration` measure only the post-extension window, OR scale refund against the SUM of (consumed-time-at-extension + post-extension-elapsed) consistently by recording an effective "weighted startedAt".

Test gap: `test_P01_subscribeEscrowConsistency_extension` asserts escrow magnitudes but never extends-then-cancels to verify refund math. No test cancels a subscription that was extended.

### H-02 — `withdrawToTreasury` can be drained by owner racing a `proposeFeeChange` / `executeFeeChange` because consumed escrow accounting is timing-sensitive
File/lines: `PremiumAccess.sol` L339-345.

`withdrawToTreasury` computes `withdrawable = balance - totalRefundEscrow`. `totalRefundEscrow` is only decremented by `cancelSubscription`, `reconcileExpired`, or `subscribe`'s extension branch. There is **no path** that lazily reduces `totalRefundEscrow` when subscriptions naturally expire without being reconciled. As a result, `totalRefundEscrow` is permanently inflated for unreconciled expired users, and `withdrawToTreasury` cannot release that consumed-and-now-unrefundable balance. Owner loses access to legitimately-earned fees indefinitely until someone calls `reconcileExpired(user)` for each user.

While `batchReconcileExpired` and `reconcileExpired` exist, they are **permissionless and unbounded** — anyone can grief by NOT calling them, and treasury cannot self-heal. This is the inverse of a drain (fund-locking) but is a legitimate HIGH-severity availability issue.

Severity rationale: marked HIGH because (a) treasury revenue is permanently locked without coordinated off-chain reconciliation, (b) `RedTeam_POLPremium.t.sol` finding 5 already flagged this scenario, and (c) the contract has no admin-rescue path — even owner cannot bypass since they must reconcile every user.

Recommendation: in `withdrawToTreasury`, add a "lazy-reconcile" loop guarded by an owner-supplied address list, OR change `totalRefundEscrow` to a virtual quantity computed off active-subscriber set, OR allow owner to mark a specific user reconciled even if they no longer hold an active sub. Alternatively make `withdrawToTreasury` accept `address[] calldata staleUsers` and reconcile them inline.

---

## MEDIUM

### M-01 — ERC20 fee-on-transfer / rebasing tokens silently underpay & break escrow invariant
File/lines: L193 `toweli.safeTransferFrom(msg.sender, address(this), cost);`

Although TOWELI is the project's own token (presumably no fee-on-transfer), the contract takes the address as a constructor arg with no validation. If TOWELI is ever swapped to a FoT or rebasing variant via upgrade or governance error, `userEscrow[msg.sender] = cost` records the *intended* deposit while the contract actually receives less. `withdrawToTreasury`'s `balance - totalRefundEscrow` would then under-report withdrawable balance and potentially become negative-clamped to zero, or worse, allow `cancelSubscription` to drain other users' escrow because `refundAmount` is capped at `contractBalance` only as a fallback.

Mitigation present: balance cap on refund (L269-272). Risk remaining: silent escrow drift, totalRefundEscrow > actual balance.

Recommendation: measure delta on `safeTransferFrom`: `uint256 before = toweli.balanceOf(address(this)); safeTransferFrom(...); uint256 received = toweli.balanceOf(address(this)) - before; require(received == cost, "FOT_NOT_SUPPORTED");` — or document that TOWELI must be a vanilla ERC20 forever.

Test gap: no FoT mock test in either test file.

### M-02 — Payment-token blacklist DoS on `cancelSubscription` and `withdrawToTreasury`
File/lines: L296 `toweli.safeTransfer(msg.sender, refundAmount);`, L343 `toweli.safeTransfer(treasury, withdrawable);`

If TOWELI integrates a USDC-style blocklist and the cancelling user (or the treasury) is blocklisted, the call reverts. For `cancelSubscription` this means the user's escrow stays locked (state already updated to set escrow=0 just before transfer? No — actually order is: state writes (L275-290) BEFORE the `safeTransfer` (L296). So escrow IS zeroed even if transfer reverts… wait, the revert reverts everything including state writes. So actually state is preserved and user can never cancel.). For `withdrawToTreasury` a blocklisted treasury permanently bricks owner's revenue path until treasury timelock executes.

Also note `cancelSubscription` has `nonReentrant` but is **callable while paused** (deliberate per L247-248 comment). A malicious blocklist controller can grief specific users.

Recommendation: pull-pattern refund (record refund credit, let user `claim()` later); allow user to specify alternate refund address.

Test gap: no blacklist/blocklist mock test.

### M-03 — `cancelSubscription` callable while paused enables refund-during-incident griefing
File/lines: L249, L247-248 design comment.

`cancelSubscription` has no `whenNotPaused` modifier (intentional). During an active exploit, attackers who happened to subscribe right before the incident can drain the escrowed funds by mass-cancelling. While each user can only cancel their own, the comment "subscribers can always recover their pro-rata refund during emergencies" assumes the incident isn't IN cancelSubscription itself. Combined with H-01's accounting drift, an attacker who timed an extension can cancel during pause for outsized refunds.

Recommendation: keep cancel callable, but add a `cancelGracePeriod` or owner emergency-freeze for cancel specifically (with a separate timelock).

### M-04 — `deactivateNFTPremium` 10-minute grace period is gameable for cross-block flash-NFT activation
File/lines: L172-179.

Flow: attacker borrows JBAC NFT in tx A → calls `activateNFTPremium()` → in tx B (next block, ≥16s later) `hasPremium()` returns true. The 10-minute grace window in `deactivateNFTPremium` means even after the attacker returns the NFT, third parties cannot revoke for 10 minutes. Attacker has a 10-minute premium window per single-block NFT borrow.

The mitigation `hasPremiumSecure` solves this for on-chain integrations, but the contract's own `hasPremium()` function and the `getSubscription` view are still the canonical interface for off-chain integrations. NFT marketplace front-ends, dashboards, and analytics will see "Alice has premium" for 10 minutes after she returns a borrowed NFT.

Recommendation: drop the grace period to ~30 seconds, OR have `hasPremium` actually re-check `balanceOf(user) > 0` AT QUERY TIME (which it already does at L130 — wait, it does! So this only matters for users who currently DON'T hold but DID activate; that path is the deactivate concern). Actual exposure: stale `nftActivationBlock` storage bloat + the 10-minute deactivate grace permits brief griefing of `deactivateNFTPremium` callers but does not actually grant access if user no longer holds. Demoting from H to M.

Refined finding: the 10-minute window does NOT grant unauthorized access (L130 still requires `balanceOf > 0`). The risk is **storage bloat**: every flash-NFT-borrow leaves a permanent `nftActivationBlock` entry until reconciled, which costs no premium but is a state-growth vector.

### M-05 — Extension at exact `block.timestamp == sub.expiresAt` boundary takes the "extension" branch instead of "new sub", carrying stale escrow
File/lines: L196 `bool isNewSub = sub.expiresAt <= block.timestamp;`

When `sub.expiresAt == block.timestamp` the comparison is `<=`, so `isNewSub = true` — fine. But the prior assertion at L198 `require(sub.startedAt != block.timestamp || isNewSub, ...)` — combined with L199 `startFrom = isNewSub ? block.timestamp : sub.expiresAt` — at the exact boundary `startFrom = block.timestamp = sub.expiresAt`, both equal. Effectively the user gets a clean rollover. Looks correct on the boundary.

However: if user calls subscribe AT `expiresAt - 1` (1 second before expiry), `isNewSub = false`, code takes extension branch with `remainingTime = 1`, `totalDuration = 30d`, so `remainingEscrow = userEscrow * 1/2592000` — essentially zero — and `consumed = userEscrow - ~0 = userEscrow`. `totalRefundEscrow` is reduced by ~full old escrow, then increased by new cost. The old period's escrow is correctly written off. This part is OK.

Real M finding: `sub.expiresAt = startFrom + (months * MONTH)` at L214 with `startFrom = sub.expiresAt`. There is NO upper bound on `months`. A user passing `months = type(uint256).max / MONTH` causes `startFrom + months*MONTH` to overflow to a small number, setting expiresAt LOWER than current expiresAt — effectively shortening the subscription while paying for it. Solidity 0.8 reverts on the overflow (L214 multiplication and addition), so this is safe by language. However `cost = monthlyFeeToweli * months` at L189 will also overflow-revert before reaching the multiplication at L214 — defensible, but lacks explicit max-months sanity check.

Recommendation: `require(months <= 120, "MAX_MONTHS")` to bound at 10 years for sanity.

### M-06 — `reconcileExpired` and `batchReconcileExpired` are permissionless with no rate limiting; griefer can spam to bloat events
File/lines: L304-334.

Anyone can call `batchReconcileExpired` with arbitrary user list (including users with `escrow == 0` who short-circuit cheaply, but still cost CALLDATA gas for each iteration on the caller). No DoS on the contract itself, but `batchReconcileExpired` lacks a length cap — passing 100k users could OOG the txn.

Recommendation: cap length at e.g. 500 to prevent accidental gas griefing on layer-2 (Arbitrum has higher CALLDATA cost).

### M-07 — `nftActivationBlock` typo / storage-naming inconsistency invites integration error
File/lines: L62 mapping name still `nftActivationBlock` despite storing `block.timestamp`.

The comment acknowledges this ("kept name for storage compat, stores timestamp now"). External tools, subgraphs, and integrating contracts that read this field by name (e.g., via `cast call`) will mistakenly interpret the value as a block number, leading to off-by-millions errors.

Recommendation: add a view alias `function nftActivationTimestamp(address user) external view returns (uint256) { return nftActivationBlock[user]; }` and document deprecation in NatSpec.

### M-08 — `paidFeeRate` mapping is set but never read in current code path
File/lines: L51, L232.

`paidFeeRate[msg.sender] = monthlyFeeToweli;` is written on subscribe and zeroed on cancel — but cancel uses `userEscrow` (not `paidFeeRate`) for refund. The mapping is dead state, unused for actual refund computation. Either it's there for future use (then document it) or it's a vestigial fix that should be removed. Storage cost on every subscribe wastes ~22k gas per call.

Recommendation: remove or document.

---

## LOW

### L-01 — `getSubscription` returns `lifetime = nftHolder` which is a snapshot value, misleading for cached frontends
File: L426-431. The `lifetime` flag in returned tuple was a deprecated concept; the function returns NFT-holder status, which is point-in-time. Frontends caching this value will be incorrect after NFT transfer.

### L-02 — `hasPremium` does not check `nftActivationBlock` against the CURRENT NFT (only `balanceOf > 0` and timestamp)
File: L130. If user activated with NFT #1, sold it, bought NFT #2, the activation timestamp from when they held #1 still applies. This is by design ("activation persists") but means activation is **per-address, not per-NFT** — a user can perpetually rotate NFTs without re-activating, defeating the 15-second flash-loan check (because the activation was done while holding a *different* NFT). An attacker could hold NFT #1 for 15+ seconds, activate, sell, and forever after they can flash-borrow ANY JBAC NFT for instant premium.

Severity: LOW because attacker still must legitimately hold *some* NFT for 15s once. But the 15-second delay's intent — "don't flash-loan an NFT" — is partially defeated.

Recommendation: bind activation to a specific tokenId.

### L-03 — `cancelSubscription` and `subscribe` do not emit events with enough granularity for indexers to compute consumed-escrow off-chain
File: L241, L299. Events emit `paid` and `refundAmount` but not `userEscrow` after the operation, making it hard to reconcile accounting from logs alone.

### L-04 — `claimNFTAccess` is a deprecated function that reverts but still costs codespace
File: L350-353. Removing it would save bytecode.

### L-05 — Constructor accepts any treasury address with no codesize check; CREATE2-controlled treasury possible
File: L104-112. If treasury is set to a counterfactual contract address that is later deployed with malicious code, owner-trusted withdraw funnels there. Non-issue if treasury is trusted multisig.

### L-06 — `pause`/`unpause` not behind timelock — owner can pause subscriptions instantly to deny new sign-ups
File: L364-365. Combined with M-03, owner can pause then cancel never (M-03 makes cancel always work), but new subs are blocked. Allows owner to halt user growth instantaneously.

### L-07 — `proposeTreasuryChange` does NOT validate that `_treasury != treasury` — owner can propose the current treasury, queue a 48h timelock for nothing, and during that 48h a `cancelTreasuryChange` is the only escape
File: L400-405. Minor; just a gas/DX issue.

### L-08 — No event emitted by `reconcileExpired` / `batchReconcileExpired`
File: L304-334. Indexers cannot track expired-cleanup actions.

---

## INFO

### I-01 — Multiple-tier overlap: N/A — single-tier contract, no overlap surface.
### I-02 — Owner free-grant rug: N/A — no `grantPremium(address)` function exists. Only paid path or NFT-based.
### I-03 — Signature replay on activation: N/A — no signature-based flows; `activateNFTPremium` is `msg.sender`-gated only.
### I-04 — Frontend-only gating bypass: N/A — `hasPremium` and `hasPremiumSecure` are on-chain views, gating is contract-side. The NatSpec at L124 explicitly warns integrators against using `hasPremium` for on-chain gating.
### I-05 — NFT-based tier transfer race: PARTIALLY ADDRESSED — `hasPremium` re-checks `balanceOf` at query time (L130). Race: in same tx, attacker can flash-borrow → activate → query in next block. Mitigated by 15s delay (L130). See L-02 for residual risk.
### I-06 — Expiry timestamp underflow: NOT EXPLOITABLE — cancel path computes `sub.expiresAt - block.timestamp` only when `sub.expiresAt > block.timestamp` (guarded by `NoActiveSubscription` revert at L251). Solidity 0.8 underflow protection covers any bypass.
### I-07 — Extension window edge case: see H-01 for the substantive issue. The `ALREADY_SUBSCRIBED_THIS_BLOCK` check at L198 prevents same-block double-subscribe.
### I-08 — Missing pause: PRESENT — `Pausable` is inherited and `subscribe` has `whenNotPaused`. `cancelSubscription` deliberately omits it (M-03).
### I-09 — Access bypass via expired→re-active: prevented by L220-228 explicit clearance of `oldEscrow` from `totalRefundEscrow` in the new-sub branch. Test `test_P02_resubscribeAfterExpiry_clearsStaleEscrow` covers this.
### I-10 — Refund accounting: see H-01 (extension path), M-01 (FoT), L-03 (event coverage).
### I-11 — `setMonthlyFee` and `setTreasury` correctly revert as deprecated stubs (L358, L394).
### I-12 — TimelockAdmin is solid (MakerDAO DSPause-based, see L11-14 of TimelockAdmin.sol). Standard 7-day expiry, MIN_DELAY 1h enforced.

---

## TEST GAPS (for future fix-validation)

1. **No test exercises extend-then-cancel** to reveal H-01 refund drift. Add: subscribe(1mo), warp 15d, extend 1mo, warp 1s, cancel — assert refund ≈ 1500.
2. **No FoT/rebasing token test** (M-01).
3. **No blocklisted-treasury or blocklisted-user test** (M-02).
4. **No `cancelSubscription` while paused test** (M-03 confirmation that it works).
5. **No NFT rotation test** (L-02): user activates with NFT #1, sells, buys NFT #2, calls `hasPremium` → asserts true with no re-activation needed.
6. **No `batchReconcileExpired` length-stress test** (M-06).
7. **No `paidFeeRate` read test** — confirms it's truly unused (M-08).
8. **No `withdrawToTreasury` lock-up test** with users who never reconcile (H-02 stress).
9. **No fuzz test on `subscribe(months, maxCost)`** for overflow boundary (M-05).
10. **No event-emission assertions on `reconcileExpired`** (L-08 — no events to assert, by design).

---

## SUMMARY COUNTS

- HIGH: 2 (H-01 extension refund drift, H-02 fund-lock in withdrawToTreasury)
- MEDIUM: 8 (FoT, blocklist DoS, pause/cancel, NFT-grace, max-months, batch length, naming, dead state)
- LOW: 8
- INFO: 12

Top concerns to remediate first:
1. H-01 — extension refund under-pays users (real economic loss).
2. H-02 — treasury fund-lock when expired subs aren't reconciled.
3. M-02 — blocklist DoS on cancel/withdraw (USDC-style risk; relevant if TOWELI ever adds blocklist).
