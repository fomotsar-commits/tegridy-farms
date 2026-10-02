# Agent 006 — TegridyLending.sol Forensic Audit

**Target:** `contracts/src/TegridyLending.sol` (972 lines)
**Tests reviewed:** `TegridyLending.t.sol` (1278), `TegridyLending_ETHFloor.t.sol` (297), `TegridyLending_Reentrancy.t.sol` (488)
**Scope:** P2P NFT-collateralized lending (Gondi-pattern, no liquidation engine — collateral is escrowed staking NFTs, default = lender claims NFT).
**Threat model contextualization:** Several items in the requested checklist (liquidation incentive griefing, dust-position liquidation, partial-repay health-factor recheck, hardcoded LTV per asset) do not apply structurally — TegridyLending has no liquidation auction, no LTV ratio, no partial repays, no health factor. The collateral is a single ERC721 staking position that is forfeit at deadline+grace. Findings below focus on what *does* apply: oracle, ETH/ERC20 mixing, accrual rounding, reentrancy, paused-flow griefing, flash-loan / spot-price manipulation.

---

## HIGH

### H-006-1 — ETH-floor oracle uses raw spot reserves; flash-loan / sandwich manipulable
**Location:** `_positionETHValue` (L715–724), used in `acceptOffer` (L429–432).
**Severity:** HIGH (acknowledged in-code as `SECURITY_DEFERRED`, but still an open exposure when feature is enabled).
The lender-elected ETH floor calls `ITegridyPair(pair).getReserves()` and computes `mulDiv(toweliAmount, wethReserve, toweliReserve)`. There is no TWAP, no `blockTimestampLast` staleness check, no manipulation guard. A borrower with sufficient capital (or a flash loan against any DEX router that touches the same pair) can:
1. Pump the WETH-side reserve in the same block.
2. Call `acceptOffer` — `_positionETHValue` returns an inflated number, satisfying `minPositionETHValue`.
3. Receive principal and walk away.
Test `test_sandwich_sameBlockManipulation_succeeds` (ETHFloor.t.sol L211–228) explicitly demonstrates the attack succeeding by 10×-ing the WETH reserve. The mitigation comments cite (a) lender opt-in (true — non-zero floor required), (b) 1-day `minDuration` (does NOT mitigate price manipulation, only lock-end alignment), and (c) "TWAP migration once V3 lands" — deferred. A lender who relies on this floor for risk pricing has an asymmetric attack surface.
**Recommendation:** Either (a) gate the ETH-floor feature behind a `floorEnabled` admin switch defaulted off until TWAP is ready, (b) integrate a `TegridyPair`-cumulative-price TWAP read with a minimum elapsed-window, or (c) read from a Chainlink/V3 oracle when available. At minimum, surface the manipulation risk on the lender UI when a non-zero floor is set.

### H-006-2 — `repayLoan` is callable while the collateral source (`TegridyStaking`) is paused, but the borrower repays cash and gets nothing back
**Location:** `repayLoan` L488–554, NFT return at L534 (`staking.transferFrom(address(this), borrower, tokenId)`).
**Severity:** HIGH.
`repayLoan` is intentionally NOT gated by `whenNotPaused` (L484 comment: "prevents forced defaults during pause"). However, it calls `staking.transferFrom(address(this), borrower, tokenId)` which delegates to `TegridyStaking._update`. While the inherited OZ `_update` is not directly `whenNotPaused`-gated, the staking contract has a custom `_update` override (`TegridyStaking.sol` L880–950 area) — IF the staking team ever pauses transfers, repay would revert. Current test `test_repayLoan_succeedsWhenStakingPaused` (Lending.t.sol L762–780) confirms today's `_update` is not whenNotPaused-gated, so this is currently safe — but it's a **silent coupling**: a future TegridyStaking change adding `whenNotPaused` to `_update` would brick repay (loss-of-funds for borrower), enabling griefing where the lending owner pauses staking specifically to force defaults. There is no explicit `_update`-not-paused invariant test in the staking suite either.
**Recommendation:** Add an invariant test in TegridyStaking ensuring `_update` cannot become `whenNotPaused`-gated without breaking lending repay. Or formally couple via interface: TegridyLending should detect `paused()` on the collateral contract and revert with a clear error (or attempt fallback) rather than letting the inner call surface.

### H-006-3 — No ETH/ERC20 collateral mixing, but `originationFee` is collected before `acceptOffer`, opening a free-money path for malicious lenders
**Location:** `createLoanOffer` L327–375, originationFee L346–351.
**Severity:** HIGH (economic).
At offer creation, the protocol *immediately* sends `originationFee` to treasury (L349). The stored `effectivePrincipal` is the net (msg.value − fee). When the lender later calls `cancelOffer`, only `effectivePrincipal` is refunded (L388 `offer.principal`) — the lender has paid the origination fee with no offer ever accepted. This is by design (comment at L98: "now every accepted offer pays a fee, regardless of repay/default"). But the comment is misleading: the fee is paid even when the offer is **never accepted** and the lender simply wishes to retract. With `MAX_ORIGINATION_FEE_BPS = 200` (2%) and a 1000 ETH max principal, an admin who flips the fee to its cap and then a lender who creates and immediately cancels a 1000 ETH offer eats a 20 ETH irrecoverable fee. This is more griefing-vector than vuln — but it's surprising-by-design and arguable as adversarial admin extraction. There is no test verifying the cancel-flow refunds the gross or that lenders are warned.
**Recommendation:** EITHER refund the origination fee on cancel (track it on the offer struct) OR lock cancelOffer behind a minimum-on-shelf delay (e.g. 1 hour) so an admin fee-bump can't be sniped against in-flight offers. Add a `test_originationFee_refundOnCancel` verifying intended behavior either way.

---

## MEDIUM

### M-006-1 — Interest rounding (Math.Rounding.Ceil) can over-charge by 1 wei per (P×APR×Δt) bucket; protocol-favoring but still asymmetric vs the documented "pro-rata"
**Location:** `calculateInterest` L660–678.
The OZ `Math.mulDiv(_, _, _, Ceil)` rounds *up* on every call. Comment (L668–671) calls this "protocol-favoring." For tiny loans this 1-wei round-up is multiplied by every distinct repayment timestamp the protocol observes (i.e. each repay), but since each loan is only repaid once, the cumulative drift is ≤1 wei per loan. Acceptable. However:
- `getRepaymentAmount` (L683–688) uses the same ceil math, so a borrower who fetches the quote and pays exactly that amount succeeds. But if the borrower pays 1 wei less than `getRepaymentAmount` (and the block timestamp advances by 1s between quote and call), `calculateInterest` recomputes higher → reverts `InsufficientRepayment`. UX issue, not a vuln, but no test covers the "pay quote then 1s elapses" path. Borrowers must always over-pay.
- The ceiling rounds up even when `_currentTime == _startTime + 1` and `principal * aprBps < BPS * SECONDS_PER_YEAR` — yielding interest = 1 wei. Test `test_calculateInterest_oneSecond` confirms. For a 10 wei loan at 1 bps APR this is a 10% effective minimum interest. No `MIN_PRINCIPAL` enforcement in `createLoanOffer` (only `msg.value > 0`), so dust loans (e.g. 1 wei principal) accrue 1 wei interest instantly — economically meaningless but lender can spam the storage array.
**Recommendation:** Add `MIN_PRINCIPAL` constant (e.g. 0.001 ether) in `createLoanOffer`. Document the 1-wei-overpay convention in the borrower UI / NatSpec. Add test `test_repay_quoteThen1SecLater_revertsInsufficient`.

### M-006-2 — `claimDefaultedCollateral` is `whenNotPaused` while `repayLoan` is NOT; admin pause races with grace-period expiry can grief lenders
**Location:** `claimDefaultedCollateral` L560 (`whenNotPaused`), `repayLoan` L488 (no `whenNotPaused`).
The asymmetry comment at L484 says repay is unpaused to prevent forced defaults. But the inverse is also true: if the admin pauses *during* a borrower-default scenario (deadline + grace already elapsed), the lender cannot `claimDefaultedCollateral` — the borrower can still call `repayLoan` (since it's not paused), even AFTER the grace window expired, because the deadline check (L524) is `> deadline + GRACE_PERIOD` → reverts. So actually borrower can't repay either. **But the lender's NFT is now trapped indefinitely**: repay reverts (deadline expired), claim reverts (paused). Only an unpause unfreezes. A malicious admin could weaponize this to force lender + borrower into a stalemate. No test covers the pause-during-default scenario.
**Recommendation:** EITHER mirror the asymmetry — also let `claimDefaultedCollateral` run when paused (NFT transfer is the only external call, and the lender is the one being protected from forced default already), OR add a `test_paused_duringDefault_lenderTrapped` to make this design explicit.

### M-006-3 — `proposeMinDuration` allows lowering minDuration to 1 hour, which shortens the post-attack mitigation window for the ETH-floor oracle
**Location:** `proposeMinDuration` L860–866, `MIN_DURATION_FLOOR = 1 hours` (L87).
The ETH-floor security comment at L709 cites "2-hour min-loan-duration bound" — but the floor **was reduced from 1 day default to a 1 hour FLOOR** by the timelocked admin path. An admin shortening `minDuration` to 1 hour shrinks the attacker's required hold period. Combined with the spot-reserve manipulation in H-006-1, an attacker can:
1. Wait for admin to set `minDuration = 1 hours`.
2. Sandwich-pump pair reserves.
3. `acceptOffer` with floor satisfied.
4. Hold collateral 1 hour, never repay.
5. Lender claims defaulted NFT — but they got an NFT they specifically priced as "≥X ETH worth" against a manipulated number. Net loss for lender.
The comment in the contract is also inconsistent — `MIN_DURATION_FLOOR = 1 hours` but security comment says "2-hour min-loan-duration bound."
**Recommendation:** Raise `MIN_DURATION_FLOOR` to match the security claim (4 hours minimum, ideally 1 day). Update the security-deferred doc to reflect actual floor.

### M-006-4 — `_positionETHValue` reverts silently to 0 when `toweliReserve == 0`; bypasses ETH-floor check
**Location:** L722 `if (toweliReserve == 0) return 0;`
If a malicious actor (or LP rug) drains the TOWELI side of the pair, `_positionETHValue` returns `0`. In `acceptOffer` (L429–432), `0 < minPositionETHValue` triggers `InsufficientCollateralValue` — that's correct revert behavior. **However**, if `minPositionETHValue == 0` (feature disabled), the function isn't even called, so this is harmless when off. When on with a tiny floor (e.g. 1 wei), and the pair is rugged, the check still reverts — fine. No exploit, but the `return 0` rather than `revert NoLiquidity()` is a code smell — silent zero on degenerate input is fragile.
**Recommendation:** Replace `return 0` with `revert ZeroAmount()` (or a new error) so callers can distinguish "no liquidity" from "low value." Currently no test covers `toweliReserve == 0`.

### M-006-5 — `lockEnd == 0` rejected, but `lockEnd` mutability in TegridyStaking creates a same-block-acceptOffer-then-extendLock window where lender-promised expiration check is irrelevant after issuance
**Location:** `acceptOffer` L438–439.
The check ensures `lockEnd >= deadline` at issuance. But `TegridyStaking.extendLock` (L642) and `getReward` with `autoMaxLock` (L766–768) can extend `lockEnd` AFTER acceptOffer **as long as the borrower still holds `ownerOf` rights** — which they do NOT once the NFT is escrowed (`ownerOf == address(this))`). Critically: `TegridyStaking.toggleAutoMaxLock` and `extendLock` require `ownerOf(tokenId) == msg.sender` (L643). So while the NFT is escrowed, neither borrower nor lender can mutate lockEnd. Good. **But**: the borrower CAN unilaterally call `getReward(tokenId)` only if owner — they cannot. So the lockEnd is effectively frozen at acceptOffer time. **No vuln**, but the L484 comment about "force-defaults during pause" interacts here: if `repayLoan` is paused-bypassed and succeeds at deadline+grace+1s, the borrower gets the NFT back; if the borrower had pre-staked with a lock that ALSO expires at deadline, the borrower can immediately withdraw underlying TOWELI on receiving the NFT, leaving the lender's collateral worthless if they had been counting on a longer lock for default-recovery value. Test `test_acceptOffer_lockExpiresExactlyAtDeadline_borrowerImmediateWithdraw` is missing.
**Recommendation:** Require `lockEnd >= deadline + GRACE_PERIOD + N_DAYS_GRACE_FOR_LENDER` (e.g., +7 days) so that on default, the lender has time to either withdraw underlying TOWELI themselves or sell the NFT. Currently `lockEnd >= deadline` allows zero post-default value preservation.

### M-006-6 — `acceptOffer` performs an `ITegridyStaking.getPosition` external call before the CEI state-change boundary; static today, but inheriting risk if TegridyStaking adds dynamic behavior
**Location:** L422–431.
`getPosition` is a `view` returning struct fields — currently safe. But the `staking.ownerOf(_tokenId)` and `staking.transferFrom` calls happen on the same untrusted `collateralContract` address that the lender supplied at offer creation. The `_collateralContract` parameter (L341) is only checked `!= address(0)`. A malicious "staking" contract supplied by the lender in their offer could:
- Return manipulated `positionAmount` to `getPosition` (passing `minPositionValue`).
- Return `lockEnd = type(uint256).max` (passing the deadline check).
- Return `ownerOf == msg.sender` for any caller.
- `transferFrom` could be a no-op.
Then in `acceptOffer`, the borrower escrows nothing real but receives the principal. This is a lender-self-rug — no protocol funds at risk because the lender deposited the principal. But it pollutes the loan array, grief-blocks gas-bounded indexing, and most importantly: **the lender can pre-arrange a "borrower" sock-puppet to drain protocol fee revenue**. With origination fee on, lender drains `(1 − originationFeeBps/BPS)` of own deposit while sock-puppet borrower walks with principal. Lender pays origination fee but has no real risk. Net: cheap protocol-fee farming using fake collateral.
**Recommendation:** Whitelist `collateralContract` addresses via admin (with timelock). Or explicitly declare in NatSpec that lenders are responsible for their offers and the protocol does not validate the staking contract. Currently no test asserts collateralContract whitelist or rejects malicious staking.

---

## LOW

### L-006-1 — `getRepaymentAmount` view-mode interest does not include the same-block protection of L506 `if (block.timestamp == startTime) revert LoanTooRecent();`
**Location:** `getRepaymentAmount` L683–688.
View returns `principal + ceil-rounded interest` even at `block.timestamp == startTime`, which yields `0` interest (correct), but borrower can call this view in the same block as `acceptOffer` and assume they can repay. They cannot — `repayLoan` reverts `LoanTooRecent`. UX inconsistency.
**Recommendation:** Either return `(0, false)` or revert `LoanTooRecent` in view. Or document.

### L-006-2 — `proposeProtocolFeeChange` accepts `_newFeeBps == 0` (zero-fee setting); does not block setting back to zero
Not a vuln, but admin can lower fee then weaponize against treasury revenue forecast. Already timelocked 48h. Acceptable.

### L-006-3 — `cancelOffer` is not `whenNotPaused`-gated
**Location:** L379. By design (lender retains exit during emergency). But during pause the lender *cannot* deposit a new offer or have one accepted, so they only get refund. Combined with M-006-2, during a pause window a malicious admin could selectively allow refunds (drain offer-side liquidity) but block defaults (lock NFT-side). Edge case.

### L-006-4 — `_positionETHValue` ignores `blockTimestampLast` from `getReserves`
The third return value is read but unused (`_` at L716). Even a coarse "rebase if blockTimestampLast == block.timestamp - 0" check would catch in-block manipulation that didn't go through a sync().
**Recommendation:** Reject when `blockTimestampLast == block.timestamp` (single-block manipulation indicator).

### L-006-5 — No `loanCount` / `offerCount` upper bound — unbounded array growth
`offers.push` and `loans.push` are unbounded. With `MIN_PRINCIPAL = 0` (no floor), an attacker can spam 1-wei offers. Each offer eats ~200 storage slots minimum. Long-term DoS via `offers.length` in `getOffer` (cheap O(1)) is fine, but front-end pagination breaks. Also, `cancelOffer` doesn't reclaim the array slot.
**Recommendation:** Add `MIN_PRINCIPAL = 0.001 ether` floor.

### L-006-6 — `proposeMinApr` can brick `createLoanOffer` if set above `maxAprBps` at runtime
**Location:** L947–954. Check at L950 is `_newBps <= maxAprBps`. But `maxAprBps` itself is mutable via `proposeMaxAprBps`. If admin proposes `minAprBps = 1000`, executes, then proposes `maxAprBps = 500` (< 1000) and executes — `createLoanOffer` reverts for any APR (`_aprBps < minAprBps` OR `_aprBps > maxAprBps` always true). The min-vs-max check is only enforced at min-propose time, not at max-propose time.
**Recommendation:** Add `require(_new >= minAprBps)` in `proposeMaxAprBps`.

---

## INFO

### I-006-1 — Threat model items in the audit prompt that DO NOT apply to this contract
- **Liquidation incentive griefing / dust position attacks**: No liquidation engine. Default is binary — lender claims or borrower repays.
- **Health-factor recheck after partial repay**: No partial repays. `repayLoan` repays the full loan in one call.
- **Hardcoded LTV without per-asset bounds**: No LTV concept. Lender prices their own offer; min collateral value is lender-supplied.
- **Chainlink heartbeat / fallback to TWAP attack**: No Chainlink integration. Only TegridyPair spot reserves (see H-006-1).
- **Repay-on-behalf griefing**: `msg.sender != borrower` reverts at L504. Only borrower can repay. No grief vector.

### I-006-2 — Reentrancy posture
All ETH-paying functions are `nonReentrant` (acceptOffer, cancelOffer, repayLoan, claimDefaultedCollateral). All ETH transfers go through `WETHFallbackLib.safeTransferETHOrWrap` with 10k gas stipend. Reentrancy test suite (488 lines) covers acceptOffer/cancelOffer/repayLoan/claimDefault. No reentrancy issues found.

### I-006-3 — `weth`/`pair`/`toweli` are immutable — good. Constructor resolves pair orientation correctly with ETHFloor test coverage on both `token0`/`token1` slots.

### I-006-4 — `MAX_PROTOCOL_FEE_BPS = 1000` (10%) is hard-coded constant — good. `MAX_ORIGINATION_FEE_BPS = 200` (2%) constant — good.

### I-006-5 — Constants: `BPS = 10000`, `SECONDS_PER_YEAR = 365 days`. Standard. No leap-year drift considered (sub-bps).

### I-006-6 — `pause/unpause` is owner-direct (no timelock). Acceptable for emergency flow but caller-of-record observable.

---

## TEST GAPS (recommend adding)

1. `test_floor_oracle_flashLoan_attack` — explicit flash-loan style attack against ETH floor, asserting documented bypass succeeds (mirrors existing `test_sandwich_*` but with a flash-loan source). [HIGH-1 reproducer]
2. `test_paused_duringDefault_collateralTrapped` — pause after deadline+grace, assert claim reverts and repay also reverts (deadline expired). [MEDIUM-2]
3. `test_originationFee_notRefundedOnCancel` — verify documented behavior. [HIGH-3]
4. `test_repay_quoteThen1sLater_revertsInsufficient` — borrower UX trap. [MEDIUM-1]
5. `test_acceptOffer_maliciousCollateralContract` — lender supplies a stub-staking contract, "borrows" their own deposit. [MEDIUM-6]
6. `test_proposeMaxAprBps_belowMinApr_shouldRevert` — admin bricking. [LOW-6]
7. `test_minPrincipal_dustOffer_spam` — assert no dust spam (would be a NEW invariant). [LOW-5]
8. `test_lockEnd_exactlyAtDeadline_borrowerImmediateWithdraw` — verifies lender-default-recovery value preservation. [MEDIUM-5]
9. `test_positionETHValue_zeroToweliReserve` — silent zero-return. [MEDIUM-4]
10. `test_minDuration_1hour_shortensAttackWindow` — exercise FLOOR claim vs comment. [MEDIUM-3]

---

## Summary
| Severity | Count |
|----------|-------|
| HIGH     | 3     |
| MEDIUM   | 6     |
| LOW      | 6     |
| INFO     | 6     |
| **Test gaps** | 10 |

**Top 3 to fix first:**
1. **H-006-1**: ETH-floor oracle is spot-reserve-manipulable. Either gate behind `floorEnabled` admin off-by-default until TWAP, or migrate now.
2. **M-006-2**: Pause-during-default trap — lender's NFT can be locked indefinitely if admin pauses after grace expires. Make `claimDefaultedCollateral` also pause-bypassed (mirroring repay).
3. **M-006-6**: Whitelist (or document the lender-self-rug risk of) the `collateralContract` parameter — currently any contract with the right ABI can be supplied as collateral source.
