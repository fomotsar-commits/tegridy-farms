# Agent 07/100 — Fresh-Eyes Audit: TegridyLending.sol

**Scope as briefed:** "ERC20 money market collateralized by TOWELI and LP tokens" with Chainlink ETH/USD + TWAP for valuation, health factor, partial liquidation flow, etc.

**Scope as found:** TegridyLending is NOT an ERC20 money market. It is a **Gondi-style P2P NFT-collateralised loan protocol** where individual lenders escrow ETH against a borrower's TegridyStaking ERC721 position. There is **no health-factor math, no partial liquidation, no liquidator role, no Chainlink ETH/USD feed read** in this contract. The only oracle path is the OPTIONAL `_positionETHValue` floor used at acceptance only.

The audit lens still applies — re-mapped to this contract:

| Briefed lens | What it maps to here |
|---|---|
| Health calc precision | `_positionETHValue` TWAP path; `minPositionValue` / `minPositionETHValue` checks at accept |
| Self-liquidation bonus | N/A — defaulting borrower forfeits NFT to lender, no bonus |
| Partial-liquidation rounding | N/A — full-loan payoff or full default only |
| Liquidator skips repay | N/A — only the original lender claims default |
| Reentrancy in liquidate | `claimDefaultedCollateral` collateral-out flow |
| Sandwich liquidation (TWAP grind) | `_positionETHValue` TWAP; only matters at `acceptOffer` |
| Bad debt socialisation | N/A — single-counterparty risk |
| Liquidation paused/blacklisted token | `claimDefaultedCollateral` whenPaused gate; PASS7-LENDING-02 stuck-NFT path |
| Close-factor multi-call | N/A |
| Frozen liquidation if oracle reverts | `claimDefaultedCollateral` + `repayLoan` sequencer gates |
| Re-borrow loop within tx | N/A |
| Zero-debt liquidation | N/A — every loan has principal > 0 |

Findings below are written against the actual contract surface.

---

## F-07-01 — `protocolFeeBpsAtCreate == 0` sentinel collides with legitimate 0-bps offers (BATCH-D H9 escape hatch is unintentionally broad) [MEDIUM]

**File:** `contracts/src/TegridyLending.sol`
**Functions:** `_createLoanOffer` (L806), `repayLoan` (L1080-L1082)

### Mechanism

`LoanOffer.protocolFeeBpsAtCreate` is `uint16`, snapshotted at offer creation (L806):

```solidity
protocolFeeBpsAtCreate: uint16(protocolFeeBps),
```

At repayment, the snapshot is consulted with a `0` -> live fallback (L1080-L1082):

```solidity
uint16 snapBps = offers[offerId].protocolFeeBpsAtCreate;
uint256 effectiveFeeBps = snapBps == 0 ? protocolFeeBps : uint256(snapBps);
```

The comment claims this is "backward-compat for legacy offers created before this fix (where `protocolFeeBpsAtCreate == 0`)". Since `uint16` cannot distinguish "zero because unset" from "zero because the live fee was zero at creation", **any new offer minted while `protocolFeeBps == 0`** also falls through to live `protocolFeeBps` at repay — defeating the snapshot's whole purpose for that class of offer.

### Exploit path

1. Owner sets `protocolFeeBps = 0` via the 48h-timelocked admin path (legitimate UX for a launch promotion or fee waiver). Lenders post offers expecting net 100 % of their interest.
2. After offers accumulate, owner proposes raising `protocolFeeBps` to MAX_PROTOCOL_FEE_BPS = 1000 (10 %). 48h delay.
3. Owner executes. `protocolFeeBps` becomes 1000.
4. Borrower repays a loan against an offer minted in step 1. `snapBps == 0` -> fallback to live 1000 -> 10 % of interest siphoned to treasury, lender's expected net silently reduced.

Magnitude at the contract's stated cap: principal up to MAX_PRINCIPAL_CEILING (100 000 ETH) and APR up to MAX_APR_BPS_CEILING (100 000 bps = 1000 %). 1-year max-stake interest = 100 000 × 10 = 1 000 000 ETH (notional, never actually achievable but illustrative). 10 % of that = 100 000 ETH redirected per offer. Realistic single-loan loss for a 100 ETH × 50 % APR × 1y loan is 5 ETH redirected per loan.

### Severity

**MEDIUM.** Requires owner cooperation across two timelock cycles (96 h total exposure window after the second propose), but the harm is silent and retroactive against the lender's posted-offer expectation. Mirror of the `treasuryAtCreate` snapshot pattern (LD3-H3) — that one used `address(0)` as the unset sentinel, which is structurally distinguishable from a valid treasury. The fee-bps version has no such structural escape.

### Suggested fix

Either:
- **Sentinel widening** — change the field to `int16` and store `-1` for unset, `0..1000` for valid snapshots.
- **Unset flag** — add a separate `bool feeBpsCaptured` on the struct (one extra slot bit).
- **Cap raise** — make `protocolFeeBpsAtCreate = uint16(protocolFeeBps) | 0x8000` so the high bit indicates "captured", clear the bit on read. (Compact but obscure.)

The field already reserved a half-slot at most; widening to `uint17` (logical) by stealing a bit is essentially free.

---

## F-07-02 — `getOffer` view omits `expiry` and `protocolFeeBpsAtCreate` — frontends cannot detect expired offers via the canonical accessor [LOW]

**File:** `contracts/src/TegridyLending.sol`
**Function:** `getOffer` (L1401-L1427)

The struct gained `expiry` (L377) and `protocolFeeBpsAtCreate` (L386) in pass-8 batch-15 / BATCH-D H9, but `getOffer` was last extended for `originationFee` and `treasuryAtCreate` (LD3-L1) and not re-touched. A frontend that calls `getOffer(offerId)` to render an offer's terms cannot read either new field.

The public `offers(uint256)` array auto-getter does expose all fields, but the order is positional and breaks every time a struct member is added. `getOffer` is the documented, ABI-stable accessor — and it now lies.

Concrete UX impact: a borrower's frontend that displays "this offer expires in 1d 4h" cannot read `expiry` without falling through to the public mapping with positional decoding (fragile). A lender who expects the BATCH-D H9 fee-snapshot to be observable cannot verify their snapshotted fee from the documented view.

**Severity LOW.** No on-chain damage; an observability gap that ought to land before mainnet relaunch.

**Fix:** extend the `getOffer` tuple with `expiry` and `protocolFeeBpsAtCreate` (append-only is backward-compatible for existing callers).

---

## F-07-03 — `_clearPosition` orphan-stamp interaction: per-tokenId rewards survive position burn, deferred-loan beneficiary may pull from a "phantom" tokenId [LOW / informational]

**Files:** `contracts/src/TegridyLending.sol` (`pullEscrowRewards` L1786-L1908), `contracts/src/TegridyStaking.sol` (`_clearPosition` L2049-L2077, `claimUnsettledForTokenId` L1627-L1670)

`TegridyStaking._clearPosition` (called by `emergencyExitPosition`, full `withdraw`, etc.) deletes `positions[tokenId]` and burns the NFT but **does not zero `unsettledRewardsByTokenId[tokenId]`**. After burn, the per-tokenId entry persists indefinitely.

`TegridyLending.pullEscrowRewards` then catches `ownerOf` revert (token doesn't exist) at L1820-L1824, treats it as `nftHeldHere = false`, and proceeds to `claimUnsettledForTokenId(tokenId, recipient)`. Staking happily drains the orphan entry and pays the deferred-loan beneficiary.

**Why this is benign in practice (and listed as informational):**
- `claimUnsettledForTokenId` caps drain at `unsettledRewards[lending]` (the holder bucket), which is decremented in lockstep with the per-tokenId mapping on every credit. The orphan entry cannot exceed the holder bucket.
- The recipient is the legitimate loan beneficiary recorded in storage, not an arbitrary caller.
- This is actually a feature: it keeps deferred shares pullable even if the borrower nukes the position post-loan.

**Why it is still worth a finding line:** the invariant `sum(unsettledRewardsByTokenId[*]) <= unsettledRewards[holder]` documented in `_isTrackedHolder`'s NatSpec is preserved only by the `_settleUnsettled` lockstep on writes. A future refactor of `_clearPosition` that adds per-position sweep-on-burn (zeroing the per-tokenId stamp) would break a path users rely on. Add a comment in `_clearPosition` saying "DO NOT zero `unsettledRewardsByTokenId[tokenId]` — TegridyLending and TegridyRestaking depend on the orphan stamp for post-burn deferred-claim recovery."

**Severity LOW** (documentation/maintenance hazard, not an active vulnerability).

---

## F-07-04 — Same-block flash-attack against 0-APR offers: closed by `LoanTooRecent`, but the explicit gate is `block.timestamp == startTime` (strict equality — single-block only) [INFO]

**File:** `contracts/src/TegridyLending.sol`
**Function:** `repayLoan` (L1023)

Briefed lens "Re-borrow loop within same tx to avoid liquidation" doesn't directly map. The closest analogue is the **same-block accept-and-repay free flash loan** against a 0-APR offer (the LD3-H2 flat-floor fix's stated motivation).

The gate at L1023 is:

```solidity
if (block.timestamp == startTime) revert LoanTooRecent();
```

Strict equality — anything *one second* later is allowed, at which point the LD3-H2 flat floor kicks in (5 bps of principal, ~0.05 %). Combined with the LD-M6 1-day APR floor (zero for `aprBps == 0`), the floor at the earliest legal repayment is `principal * 5 / 10000`.

Numerically: 100 000 ETH × 5 / 10 000 = 50 ETH. So a flash-loan abusing a 0-APR 100k ETH offer pays at minimum 50 ETH of "interest" to the lender, plus gas. That's a meaningful but not crushing economic deterrent.

**This is documented and intentional**, mirrors NFTLending LD2-H2. Listed for completeness — no fix recommended unless the 5 bps floor is judged insufficient given the contract's 100x larger principal cap vs NFTLending. (The LD3-H2 NatSpec acknowledges this concern but argues the fix is sufficient.)

---

## F-07-05 — Sequencer-staleness asymmetry between `repayLoan` and `claimDefaultedCollateral`: between 4h and 24h feed staleness, lender is locked out while borrower is not [INFO / by design]

**File:** `contracts/src/TegridyLending.sol`
**Functions:** `repayLoan` (L1032-L1038), `claimDefaultedCollateral` (L1223, L1241-L1247)

- `claimDefaultedCollateral` calls `SequencerCheck.checkSequencerUp(feed, 1h, 4h)` at L1223 — reverts if feed is more than 4h stale.
- `repayLoan` only calls `SequencerCheck.getSequencerOutageBuffer(feed, 1h)` at L1032 — soft-fail with default `MAX_FEED_STALENESS = 24h`.

Result: when the feed is 4h-24h stale (Chainlink keeper is lapsing but the feed hasn't gone fully stale), borrower repay still succeeds (with `outageBuffer = 0` in this window — `getSequencerOutageBuffer`'s 24h threshold isn't tripped), but lender claim hard-reverts.

This is **borrower-favouring asymmetry** — exactly what the BATCH-L3 M4 NatSpec ("price-sensitive path") aims for. Listed because the asymmetry is non-obvious: a hostile keeper or temporary L2 issue can lock a lender out of claiming a defaulted NFT for up to 20h longer than the borrower's repay window. No exploit; just a UX expectation worth documenting in the lender-facing docs.

---

## F-07-06 — Reservation-guard semantics for `applySweepDonatedToweli`: only `totalEscrowRewardsOwed` is reserved; `priorShare` slices held in lending balance for legacy pro-rata payout are also covered IF and only if the prior loan went through the deferral path [INFO]

**File:** `contracts/src/TegridyLending.sol`
**Functions:** `applySweepDonatedToweli` (L1933-L1942), `repayLoan` priorShare retention (L1140-L1149), `claimDefaultedCollateral` priorShare retention (L1290-L1295)

I traced the `priorShare` accounting end-to-end (loan-2 defers -> loan-3 retains priorShare -> loan-2 beneficiary pulls). It is sound: every priorShare slice landing in lending balance has a matching `escrowRewardsOwed[priorLoanId]` entry that was incremented at the prior loan's deferral, so `totalEscrowRewardsOwed` correctly covers it. The sweep guard `bal - totalEscrowRewardsOwed >= amount` therefore protects all legitimate slices.

**Risk surface:** a future code path that lets a loan settle "without deferral but still leaving priorShare in lending balance" would silently break this invariant. The current structure does not have such a path — every priorShare > 0 implies the snapshot was > 0 at acceptance, which implies a prior tracked-holder kick credit, which implies that `totalEscrowRewardsOwed` was incremented when the prior loan deferred (since per-tokenId can only be > 0 as a result of a deferred prior loan or a restaking-contract carry).

Listed as INFO because the logic is correct *today*, but the dependency chain is subtle and future refactors could break it without test coverage flagging the issue. Recommend adding an invariant test: `assert(IERC20(toweli).balanceOf(lending) >= totalEscrowRewardsOwed)` after every state-changing call.

---

## Notes / Dead-ends

The following lens-suggested attack paths were investigated and dismissed:

- **Self-liquidation bonus extraction** — N/A, no bonus economics in this contract; lender's "claim" is the NFT collateral, not a discount on debt.
- **Reentrancy in `claimDefaultedCollateral`** — full CEI: `loan.defaultClaimed = true` (L1250) and `activeLoansAgainstCollateral` decrement (L1252-L1256) run before any external staking call. `nonReentrant` is set. Outbound NFT transfer wrapped in `_safeOutboundTransferStaking` with bounded returndata (GAS-01).
- **Sandwich via TWAP grind** — `_positionETHValue` uses 30-min TWAP_PERIOD, 2h MAX_STALENESS, post-bypass cooldown of `TWAP_PERIOD * 2`, sequencer 4h-staleness gate. R003 / agents 006/031/032 fix is fully wired. Briefed attack would require multi-hour price grinding which makes the attack uneconomical.
- **Re-borrow loop within tx to avoid liquidation** — N/A. Once a loan exists, the only way to "exit" is repay (full) or default (full). There's no rollover.
- **Liquidation of zero-debt position** — `_createLoanOffer` rejects `msg.value == 0` (L757) and `msg.value < minPrincipal` (L758). Default flow has no zero-debt path.
- **Close-factor bypass via multi-call** — there is no close factor; a loan is binary (open or settled).
- **Liquidation when collateral paused/blacklisted** — PASS7-LENDING-02 stuck-collateral surface (`claimStuckCollateral`) handles malicious-collateral no-op + redirect cases. The whitelist (`acceptedCollateralContracts`) is 48h-timelocked with a cancel-rate-limit (LD3-M3), so blacklist/swap attacks have a 96h+ observable window.
- **Self-loan exploit** — possible but uneconomic: borrower==lender flow loses `originationFee` to treasury and pays interest to themselves (net zero on interest, net loss on the fee). Not an attack vector.
- **`escrowRewardsOwed` double-pay** — the PASS7-LENDING-04 reconciliation in `pullEscrowRewards` (L1852-L1861) correctly debits both `escrowRewardsOwed[_loanId]` and `totalEscrowRewardsOwed` by `min(directPaid, owed)`. Verified end-to-end through the loan-2/loan-3 chain.
- **`NFT-CL-L2 DONOR` exploit** — the natspec at L1775-L1784 explicitly notes that direct TOWELI donations to lending are pro-rata-distributed, not sweepable while `escrowRewardsOwed > 0`. Donors lose, but the protocol does not.
- **Lock-extend / amount-increase mid-loan** — staking's `extendLock`/`increaseAmount` require `ownerOf == msg.sender`; while NFT is escrowed, owner is lending, which exposes no such function. Borrower cannot manipulate the position mid-loan.
- **`emergencyExitPosition` mid-loan** — same gate; lending is owner. Plus L919-L921 enforces `lockEnd >= deadline + LIQUIDATION_GRACE`, so even if borrower could trigger it, the lock is still active.
- **`unsettledRewards[lending]` external drain via `claimUnsettledFor`** — staking L1591-L1593 explicitly rejects tracked-holder drains.

---

## Summary

Two real findings on this audit pass:

- **F-07-01 (MEDIUM)**: `protocolFeeBpsAtCreate == 0` sentinel ambiguity — BATCH-D H9 snapshot fails for offers minted during a 0-bps fee regime. Captured admin can retroactively tax those offers via the fallback. Suggested sentinel widening fix.
- **F-07-02 (LOW)**: `getOffer` view omits `expiry` and `protocolFeeBpsAtCreate` fields. Append-only ABI extension closes the observability gap.

Three informational notes:

- **F-07-03**: `_clearPosition` does not zero per-tokenId stamps; the orphan entry is benign and even useful (post-burn deferred-claim recovery still works), but worth a NatSpec note in staking to prevent a future refactor from breaking the dependency.
- **F-07-04**: 0-APR same-block flash-attack flat-floor (LD3-H2) is 5 bps of principal — meaningful but small at 100k-ETH cap; documented choice.
- **F-07-05**: Sequencer-staleness asymmetry (4h vs 24h) borrower-favours during keeper lapses; intentional but non-obvious.
- **F-07-06**: `applySweepDonatedToweli` reservation invariant traces cleanly today but depends on every priorShare-yielding path also having incremented `totalEscrowRewardsOwed` at deferral time. Recommend an invariant test.

The contract is heavily defended — most lens-suggested vectors are explicitly closed by named audit fixes (BATCH-D H9, LD3-H1/H2/H3, PASS7-LENDING-01/02/03/04, DEEP-LD-M1/M5/M6/M7/M8, LD-NEW-H1, R003 / R014 / R062, etc.). The remaining surface area is observability and one snapshot-sentinel hole.
