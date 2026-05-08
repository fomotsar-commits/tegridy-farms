# Agent 78 — Fresh-Eyes Aave V3 Pattern Audit

**Scope:** `contracts/src/TegridyLending.sol`, `contracts/src/TegridyNFTLending.sol`, `contracts/src/lib/SequencerCheck.sol`
**Lens:** Aave V3 PriceOracleSentinel, ValidationLogic, GenericLogic; Chainlink L2 sequencer feed canon; recent Aave V3 / BendDAO / Aloe postmortems.
**Date:** 2026-05-07
**Method:** Direct read of all three target files in full + canonical Aave V3 source via WebFetch + Aave & Chainlink incident searches.

---

## EXECUTIVE SUMMARY

Tegriddy's lending stack is a **P2P loan-offer model** (Gondi/NFTfi style), not a pooled-money-market like Aave V3. So most of the Aave-canonical surface (utilization-curve interest rate models, health-factor-driven liquidation, close factor scaling, frozen-vs-paused tri-state, CAPO-style rate-bounded oracles) **does not apply** by design. The fixed-APR pro-rata model removes the entire "interest rate strategy / kink point / variable index" surface; the deadline-based default model removes the entire "health factor / close factor" surface.

That narrows the meaningful comparison to **just two Aave V3 patterns the code claims parity with** — sequencer-uptime gating, and pause/freeze handling — plus oracle staleness. On that narrowed surface I find **6 divergences**, 2 of which are non-trivial:

| ID | Sev | One-liner |
|---|---|---|
| F-78-A | LOW | `SequencerCheck` uses `startedAt` for grace; Aave V3 uses `lastUpdateTimestamp`. Tegriddy is closer to Chainlink canon, but the doc claims "Aave V3 PriceOracleSentinel pattern" — comment is misleading. |
| F-78-B | INFO | `SEQUENCER_GRACE_PERIOD = 1 hour` is a **constant**, not a setter. Aave V3 makes grace mutable. Tegriddy's choice is intentional but the "matches Aave V3 default" comment is unverifiable (Aave's prod value is set by governance). |
| F-78-C | MED | NFTLending pause-asymmetry: `claimDefault` is `whenNotPaused`, but `repayLoan` is NOT. TegridyLending closed this with `MAX_PAUSE_BLOCK_LIQUIDATION = 7 days`; NFTLending **did not get the sibling fix** and remains pause-asymmetric. |
| F-78-D | LOW | `TWAP_MAX_STALENESS = 2 hours` is documented as "matches Aave V3 default oracle window." Aave V3's heartbeat for ETH/USD on Arbitrum is **24 hours** (1h on mainnet); 2h is a tighter, defensible choice but the comment misattributes. |
| F-78-E | LOW | `MAX_FEED_STALENESS = 24 hours` for the sequencer uptime feed: spec-accurate per Aave's "stable-asset default", but the **uptime feed itself is a heartbeat-on-status-change feed**, not a periodic price feed — 24h is loose. Tegriddy already provides a 4h overload at the price-sensitive call sites, so the constant is mainly used by `getResumeTimestamp`. |
| F-78-F | INFO | `LIQUIDATION_GRACE = 1 day` (lockEnd buffer) and `GRACE_PERIOD = 1 hour` (post-deadline cushion): no Aave analogue (P2P fixed-deadline model). Sound choices but not "Aave V3"; comment elsewhere implies more parity than exists. |

The single MED finding (F-78-C) is the only one that is a code-fixable exploit lever; the rest are documentation-vs-reality divergences and tightening recommendations.

---

## F-78-A — `SequencerCheck` grace uses `startedAt`; Aave V3 uses `lastUpdateTimestamp`

**Severity:** LOW (correctness comment vs. semantics, not exploit)
**File:** `contracts/src/lib/SequencerCheck.sol:30,164`

### The divergence
Tegriddy:
```solidity
// SequencerCheck.sol:163-167
unchecked {
    if (block.timestamp - startedAt < gracePeriod) {
        revert SequencerGracePeriodNotOver();
    }
}
```

Aave V3 PriceOracleSentinel canonical:
```solidity
function _isUpAndGracePeriodPassed() internal view returns (bool) {
  (, int256 answer, , uint256 lastUpdateTimestamp, ) = _sequencerOracle.latestRoundData();
  return answer == 0 && block.timestamp - lastUpdateTimestamp > _gracePeriod;
}
```
(Verified via raw GitHub fetch of `aave-v3-core/.../PriceOracleSentinel.sol`.)

The doc-comment at `SequencerCheck.sol:30` says:
> "Battle-tested model: Aave V3 PriceOracleSentinel (`isAnswerNotStale`)."

But Aave's PriceOracleSentinel uses `lastUpdateTimestamp` (= the 4th return value `updatedAt`), **not** `startedAt`.

### Which is correct?
On Chainlink's L2 sequencer uptime feed:
- `startedAt` = wall-clock when the **status answer** last changed (i.e., when the sequencer most recently transitioned up→down or down→up).
- `updatedAt` = wall-clock when the round was most recently posted (which on a status-change-only feed normally equals `startedAt`, but a future-keeper may post a heartbeat round without a status change).

Chainlink's official docs (and the BendDAO #24 finding) recommend `startedAt`. Aave V3 deviates from that recommendation.

**In normal operation the two are equal** because L2 sequencer uptime feeds only post a new round when the answer changes. So the divergence is mostly cosmetic — but the doc-comment claiming "Aave V3 PriceOracleSentinel pattern" is technically false; Tegriddy actually follows Chainlink's recommended pattern.

### Exploit theory
None practical, given the equivalence in normal operation. Theoretical: if Chainlink were to add periodic heartbeat rounds without status changes (no precedent), Aave's `lastUpdateTimestamp`-based grace would shorten and Tegriddy's `startedAt`-based grace would extend — Tegriddy would be the **safer** of the two.

### Recommendation
Fix the doc-comment at `SequencerCheck.sol:30` to read:
> "Battle-tested model: Chainlink L2 Sequencer Uptime Feed best-practice pattern (`startedAt` for grace, per Chainlink docs and BendDAO C4 #24). Approximate parity with Aave V3 PriceOracleSentinel (which uses `lastUpdateTimestamp`)."

The L165 reference comment ("Aave V3 default for stable assets" — `MAX_FEED_STALENESS = 24h`) is also misleading; see F-78-E.

### Sources
- [aave-v3-core PriceOracleSentinel.sol (master)](https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/configuration/PriceOracleSentinel.sol)
- [Chainlink L2 Sequencer Uptime Feeds docs](https://docs.chain.link/data-feeds/l2-sequencer-feeds)
- [Code4rena BendDAO #24 — sequencer-down check](https://github.com/code-423n4/2024-07-benddao-findings/issues/24)

---

## F-78-B — `SEQUENCER_GRACE_PERIOD` is a constant; Aave V3 makes it mutable

**Severity:** INFO (design choice)
**Files:**
- `contracts/src/TegridyLending.sol:318` — `uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;`
- `contracts/src/TegridyNFTLending.sol:83` — `uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;`

### The divergence
Aave V3 PriceOracleSentinel exposes `setGracePeriod()` so PoolAdmin/RiskAdmin can adjust as L2 reliability changes. Tegriddy hardcodes 1h with no governance setter.

### Why this is fine
- Tegriddy's lending pools are **single-purpose, single-deploy** (lender's own ETH at risk per offer; not a shared money-market).
- Comments at `SequencerCheck.sol:98` and `TegridyLending.sol:317` explicitly justify "1h matches Aave V3's default for stable assets."
- The on-chain sister `getSequencerOutageBuffer` is called separately on the repay path with the same constant, giving symmetric extension.

### Risk
After a long sequencer outage where Chainlink itself becomes uncertain, governance can't lengthen the grace beyond 1h without a contract redeploy. The protocol's incident-response is to **call `pause()`**, which is correct — but the comment "matches Aave V3 default" is unverifiable: Aave V3's prod grace value depends on governance and is not documented as a fixed default in the source. Aave's test suite uses 1h (3600s); production governance has rotated values.

### Recommendation
Update the comment at `TegridyLending.sol:316-318` and `NFTLending.sol:82-83` to:
> "1 hour matches Aave V3's published test-suite value (3600s) and Chainlink's recommended starting grace. Production Aave grace is governance-mutable; we choose immutable here because the lending pool is single-purpose and incident-response is via `pause()`."

### Sources
- [aave-v3-core/test-suites/price-oracle-sentinel.spec.ts](https://github.com/aave/aave-v3-core/blob/master/test-suites/price-oracle-sentinel.spec.ts) — `BigNumber.from(60 * 60)`
- [Aave Governance V2 Proposal 391: Update PriceOracleSentinel](https://governance-v2.aave.com/governance/proposal/391/)

---

## F-78-C — NFTLending pause-asymmetry: liquidation can be indefinitely blocked

**Severity:** MED
**File:** `contracts/src/TegridyNFTLending.sol:729`

### The divergence
TegridyLending closes pause-asymmetry with `MAX_PAUSE_BLOCK_LIQUIDATION = 7 days`:
```solidity
// TegridyLending.sol:1202-1208 — claimDefaultedCollateral
function claimDefaultedCollateral(uint256 _loanId) external nonReentrant {
    if (paused()) {
        require(
            pauseStartTime != 0 && block.timestamp > pauseStartTime + MAX_PAUSE_BLOCK_LIQUIDATION,
            "PausedShortOfBound"
        );
    }
    ...
}
```
The repay path (`repayLoan`, line 1006) is **not gated by `whenNotPaused`** — borrowers can always exit. The lender's exit unblocks after 7 days even during a pause.

NFTLending **does not have the sibling fix**:
```solidity
// TegridyNFTLending.sol:729
function claimDefault(uint256 _loanId) external nonReentrant whenNotPaused {
```
- Lender's `claimDefault`: **gated by `whenNotPaused`** with no max-pause-block escape valve.
- Borrower's `repayLoan` (line 625): **NOT gated by `whenNotPaused`**.

This is the exact "pause-asymmetry weapon" the BATCH-J3 H10 fix was meant to close on the staking-NFT lending side.

### Aave V3 reference
Aave V3 `validateLiquidationCall` and `validateBorrow` use the **same** `isPaused` flag (set per-reserve) — pause is symmetric: when a reserve is paused, both sides are blocked. The asymmetric "pause borrow but allow liquidation" is **not** an Aave V3 pattern; it's only safe if the contract additionally bounds how long the pause can block liquidation, which is what TegridyLending's `MAX_PAUSE_BLOCK_LIQUIDATION` does.

### Exploit
A captured-key owner pauses TegridyNFTLending and never unpauses. Every active loan whose deadline elapses during the pause becomes **un-liquidatable indefinitely** — borrower can `repayLoan` (no pause gate) at the borrower's leisure forever. Lender's principal is locked.

### Path
1. Borrower with a low-quality NFT borrows near MAX_PRINCIPAL (1000 ETH) against it.
2. Captured-key owner calls `pause()`.
3. Loan deadline elapses; lender attempts `claimDefault` → reverts via `whenNotPaused`.
4. Borrower never repays. NFT stays in escrow. Lender never recovers principal.
5. Even on `unpause`, `effectiveDeadline` extends by the entire paused duration (line 1228-1232) — combined with `claimStuckCollateral`'s `whenNotPaused` carve-out missing here, this is a permanent freeze tool.

Severity is MED rather than HIGH because:
- 48h timelocked owner key bound (Owner's pause is one-shot but pause itself is not timelocked — `pause()` at line 1196).
- NFTLending's MAX_PRINCIPAL is 1000 ETH (vs TegridyLending's 100k ceiling), so per-loan blast radius is bounded.
- Pause-extended deadline (line 1228) means borrower still owes principal + accruing-while-paused interest at unpause; lender is made whole on eventual unpause, just delayed.

But: a captured-key owner who never unpauses can permanently freeze every active NFTLending loan. That's a real DoS surface that the sibling `MAX_PAUSE_BLOCK_LIQUIDATION` already solves on the staking-side contract.

### Recommendation
Mirror the `TegridyLending.sol:1203-1208` block onto `TegridyNFTLending.claimDefault`:
```solidity
function claimDefault(uint256 _loanId) external nonReentrant {  // remove whenNotPaused
    if (paused()) {
        require(
            pauseStartTime != 0 && block.timestamp > pauseStartTime + MAX_PAUSE_BLOCK_LIQUIDATION,
            "PausedShortOfBound"
        );
    }
    ...
}
```
…and add `uint256 public constant MAX_PAUSE_BLOCK_LIQUIDATION = 7 days;` near line 50.

### Sources
- [Aave V3 ValidationLogic.sol (master) — validateLiquidationCall isPaused](https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/logic/ValidationLogic.sol)
- [Aave V3 Frozen Markets and Reserves FAQ](https://docs.aave.com/faq/frozen-markets-and-reserves)
- [MakerDAO Emergency Shutdown Module — bounded-grace pattern](https://docs.makerdao.com/smart-contract-modules/shutdown)

---

## F-78-D — `TWAP_MAX_STALENESS = 2h` doc-comment misattributes to Aave V3

**Severity:** LOW (doc only)
**File:** `contracts/src/TegridyLending.sol:295-305`

### The divergence
The constant is fine (2h is a defensible window), but the comment chain says (line 297-298):
> "30 minutes matches Aave V3's default oracle window — long enough to dilute single-block reserve manipulation, short enough to track real price movement."

Aave V3 uses Chainlink price feeds directly, not TWAP. There is no "Aave V3 default oracle window" of 30 minutes. Aave's actual heartbeat thresholds (configured per-reserve, off-chain governance) range from 1h (mainnet ETH/USD) to 24h (some stables on Arbitrum).

The 30-minute TWAP window is reasonable on its own — it matches Uniswap V3's 30m default and Curve's TWAMM canonical — just not Aave.

### Recommendation
Replace "matches Aave V3's default oracle window" with "matches Uniswap V3 / Curve TWAMM convention; shorter than Chainlink's per-feed heartbeat (1h-24h depending on asset)." No code change.

### Sources
- [Aave V3 Oracle docs — heartbeat per asset](https://aave.com/docs/aave-v3/smart-contracts/oracles)
- [Chainlink ETH/USD heartbeat 3600s on Arbitrum](https://data.chain.link/feeds/arbitrum/mainnet/eth-usd)

---

## F-78-E — `MAX_FEED_STALENESS = 24h` is loose for an uptime feed

**Severity:** LOW
**File:** `contracts/src/lib/SequencerCheck.sol:68`

### The divergence
The constant is documented (line 56-67) as matching "Aave's stable-asset default." That's accurate for *price* feeds — Aave's USDC/USDT heartbeat on Arbitrum is 24h. But the L2 sequencer uptime feed is **not a price feed**; it's a status-change-only feed. A 24h staleness window means a sequencer feed that hasn't updated in 23h59m is still trusted — even though Chainlink's keeper should be posting heartbeats roughly every block when the sequencer is up.

### Why it's mostly fine
1. The library already provides a 3-arg overload that lets call sites pass tighter staleness windows.
2. The lending contracts do exactly that: `SequencerCheck.checkSequencerUp(sequencerFeed, SEQUENCER_GRACE_PERIOD, 4 hours)` at:
   - `TegridyLending.sol:1223` (claimDefaultedCollateral)
   - `TegridyLending.sol:1595` (_positionETHValue)
   - `TegridyNFTLending.sol:744` (claimDefault)
3. The `MAX_FEED_STALENESS = 24h` only affects callers that use the 2-arg overload — primarily `getResumeTimestamp` and `getSequencerOutageBuffer`'s soft-fail overload. Those are non-revert helpers with degraded gracefully semantics, so a stale feed reading there returns the buffer (fail-closed), not a stale price.

### Risk
A keeper-down event of, say, 6h would let the soft-fail helpers trust a stale answer. The reverting helpers all use the tighter 4h override. Off-chain monitoring would catch a 6h keeper lapse before any user is harmed.

### Recommendation
Either:
- (a) tighten the default to 6 hours (still gives Chainlink keepers headroom); OR
- (b) leave 24h and document at line 68 that "consumers should always pass a tighter staleness via the 3-arg overload for price-sensitive paths" — which the lending contracts already do.

(a) is mildly preferred to defend against any future caller that forgets the overload.

---

## F-78-F — Aave parity claims for non-Aave concepts

**Severity:** INFO
**Files:** assorted comments in both lending contracts

### What's not actually Aave-V3-comparable
- **Health factor / liquidation threshold / close factor**: Tegriddy is a fixed-deadline P2P loan, not a margin-position pool. There is no health factor; default is binary (deadline + grace elapsed → defaultable). Aave's `HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18` and `CLOSE_FACTOR_HF_THRESHOLD = 0.95e18` have no analogue.
- **Reserve frozen / paused tri-state**: Aave distinguishes `isFrozen` (no new supply/borrow, allow repay/withdraw) from `isPaused` (no interaction at all). Tegriddy has only one binary `paused()` state. The functional analogue:
  - Aave `frozen` ≈ Tegriddy `proposeRemoveCollection` pending (rejects new offers, allows repay/claim) — **good parity**.
  - Aave `paused` ≈ Tegriddy `paused()` — **partial parity**, see F-78-C for the asymmetry hole.
- **Reserve factor / interest rate strategy / utilization curve**: not applicable. Tegriddy's interest is fixed APR pro-rata, not a kink-curve derived from utilization. No optimal-usage-ratio surface.
- **CAPO / rate-bounded oracle**: not applicable. The recent ($27M) Aave March 2026 CAPO incident does not have a Tegriddy analogue because Tegriddy doesn't compute exchange-rate-derived prices for collateral wrappers.

### Recommendation
None — these are intentional design choices. Just note that future audit waves should not flag missing health-factor logic or kink-curve interest as bugs; they're not in scope by design.

### Sources
- [Aave V3 Health Factor & Liquidations](https://aave.com/help/borrowing/liquidations)
- [Aave V3 Interest Rate Strategy](https://aave.com/docs/aave-v3/smart-contracts/interest-rate-strategy)
- [Aave Oracle Glitch (March 2026 CAPO incident)](https://finance.yahoo.com/news/aave-oracle-glitch-causes-27m-123639335.html)

---

## CHECKED-AND-CLEAN

These were tested against Aave V3 patterns and **passed** — no divergence:

1. **Sequencer-down outage buffer math** — `getSequencerOutageBuffer` (SequencerCheck.sol:246-300) correctly returns `buffer` on every fail-closed branch (uninit, stale-round, clock-skew, keeper-lapse, answer != 0, no-startedAt, in-grace) and `0` on healthy. Both lending contracts call it on the repay path with the same `SEQUENCER_GRACE_PERIOD` they use for the claim-side `checkSequencerUp` — symmetric repay/claim deadline extension is exactly the right pattern (mirrors the LD3-H1 / LD2-H1 fixes per the comments).
2. **Stale price gating defense-in-depth** — `_positionETHValue` (TegridyLending.sol:1585-1628) layers (a) sequencer 4h staleness, (b) TWAP observation 2h staleness, (c) directional check for future-dated timestamps, (d) post-dormancy bypass cooldown of `TWAP_PERIOD * 2` (60 min). That's stronger than Aave V3's single Chainlink heartbeat check. The 4-layer gate would have caught both the BendDAO #24 vector and the recent CAPO-style stale-rate vector.
3. **Clock-skew / future-dated timestamp** — typed `SequencerDown` / `SequencerGracePeriodNotOver` reverts replace the prior `Panic(0x11)` underflow on bridged feeds. v3-LIB-M1 / V2-LIB-M1 / BATCH-I M5 fix-chain looks complete. Mirrors the Aloe Capital / Term Finance lessons on stale-price branches.
4. **Frozen-asset analogue** — `pendingRemoval` + `acceptedCollateralRemovalPending` rejection at `createOffer` (TegridyLending.sol:778, NFTLending.sol:425-430, 539-544) correctly mirrors Aave's `isFrozen` (no new supply but allow repay/claim). The sibling `acceptOffer` re-check at `TegridyNFTLending.sol:539-544` (LD-L3 fix) is the exact symmetric closure that prevents pre-existing offers being accepted with rugged collateral during a removal timelock.
5. **SequencerFeed one-shot setter validation** — `TegridyNFTLending.setSequencerFeed` (line 390-396) checks `code.length > 0`, single-write, owner-only. The doc-comment correctly notes EIP-7702 delegation pointers (length 23) are still rejected because `code.length > 0` accepts them but they'd revert later on `latestRoundData` — actually, they'd succeed if the delegation target is a proper feed. Consider tightening to `_sequencerFeed.code.length > 23` to explicitly reject 7702 delegations, but this is BEYOND-AAVE territory (Aave doesn't check 7702).

---

## NOTES / DEAD-ENDS

- Searched for a recent Aave V3 sequencer-grace exploit — **none found**. The closest incident is the March 2026 CAPO oracle exchange-rate bug, which is a different class (rate divergence, not sequencer outage). Tegriddy doesn't have the CAPO surface.
- Searched for Aave V3 reserve frozen/paused validation in 2024-2026 — confirmed `validateBorrow` checks both, `validateLiquidationCall` only checks `paused`. Tegriddy's pattern (collateral-removal pending blocks new offers + acceptance, `pause()` blocks the captured-key emergency surface) is the correct Aave-equivalent for a P2P pool.
- Searched for direct comparison `startedAt` vs `updatedAt` in 2024-2026 audits — Aloe Capital Sherlock #55 and BendDAO C4 #24 both recommend `startedAt`. Aave's `lastUpdateTimestamp` choice is deliberate but undocumented in their threat model. Tegriddy's `startedAt` is the safer choice; just fix the doc-attribution.
- L2 sequencer uptime outage incidents in 2024-2025: Arbitrum had a ~3h outage (December 2023, post-Inscription event); no full 2024 Arbitrum/Base/Optimism outage in the search results that the existing 1h grace would not have safely covered (post-resume grace + `getSequencerOutageBuffer` repay-path extension).
- Reserve factor / interest rate parity: confirmed not applicable (P2P loan, fixed APR, no utilization curve, no reserve factor extracted from interest accrual). The `protocolFeeBps` (5% default) on interest is the closest analogue to Aave's reserve factor but it's a flat take-rate, not a kink-curve modifier.
- Health factor analogue: searched specifically — Tegriddy has no per-loan margin-call. The deadline + `LIQUIDATION_GRACE = 1 day` `lockEnd` buffer is the time-axis equivalent of "loan stays solvent until time T." No live re-pricing.

---

## SOURCES

Primary references (Aave V3 + Chainlink canon):
- [aave-v3-core PriceOracleSentinel.sol](https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/configuration/PriceOracleSentinel.sol)
- [aave-v3-core ValidationLogic.sol](https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/logic/ValidationLogic.sol)
- [aave-v3-core GenericLogic.sol](https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/logic/GenericLogic.sol)
- [Aave V3 PriceOracleSentinel docs](https://aave.com/docs/aave-v3/smart-contracts/oracles)
- [Aave V3 Reserve Configuration docs](https://aave.com/docs/aave-v3/concepts/reserve)
- [Aave V3 Health Factor & Liquidations](https://aave.com/help/borrowing/liquidations)
- [Aave V3 Interest Rate Strategy](https://aave.com/docs/aave-v3/smart-contracts/interest-rate-strategy)
- [Aave V3 Errors.sol](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/helpers/Errors.sol)
- [Chainlink L2 Sequencer Uptime Feeds](https://docs.chain.link/data-feeds/l2-sequencer-feeds)

Postmortems / incident references (2024-2026):
- [Code4rena BendDAO C4 #24 — sequencer-down check](https://github.com/code-423n4/2024-07-benddao-findings/issues/24)
- [Sherlock Aloe Capital #55 — L2 sequencer-down handling](https://github.com/sherlock-audit/2023-10-aloe-judging/issues/55)
- [Sherlock Aave V3.3 #171 — liquidation 0.95 boundary issue](https://github.com/sherlock-audit/2025-01-aave-v3-3-judging/issues/171)
- [Aave CAPO Oracle Glitch March 2026 ($27M)](https://finance.yahoo.com/news/aave-oracle-glitch-causes-27m-123639335.html)
- [Halborn September 2025 DeFi hacks digest](https://www.halborn.com/blog/post/month-in-review-top-defi-hacks-of-september-2025)
- [Aave V3 Price Oracle Manipulation analysis (Hacxyk)](https://medium.com/@hacxyk/aave-v3-s-price-oracle-manipulation-vulnerability-168e44e9e374)
- [Term Finance V0.9.0 release notes — sequencer handling](https://www.term.finance/post/v090)
- [Arbitrum Sequencer Outage Root Cause (Dedaub)](https://dedaub.com/blog/arbitrum-sequencer-outage/)
- [Cyfrin Chainlink Oracle DeFi Attacks](https://medium.com/cyfrin/chainlink-oracle-defi-attacks-93b6cb6541bf)
