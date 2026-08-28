# NftfiPooledLendingVault — stale-NAV seizure race (CONFIRMED, pre-deploy, needs a design call)

**Contract:** `contracts/src/nftfi/NftfiPooledLendingVault.sol` (580 lines, ERC-4626).
**Status:** PRE-DEPLOY — absent from `frontend/scripts/addresses.json` and `constants.ts`. No live funds.
**Repro:** `contracts/test/nftfi/NftfiVaultSeizureRace.t.sol::test_staleNavLetsInformedLpDumpDefaultOnStayer_KNOWN_DEFECT`
(passes today — pins the current unfair behavior).

## The finding

`totalAssets() = _asset.balanceOf(this) + principalOutstanding` — every live loan is counted at **full
par** until `seize` is called. `seize` is only possible at `deadline + SEIZE_GRACE` (1h) and then only
once **someone actually calls it**. But a loan is publicly known-defaulted the instant
`block.timestamp > loan.deadline` (past due, unrepaid), and `maxWithdraw`/`maxRedeem` are bounded only
by idle cash — not by the bad loan. So during the window between default and seizure an **informed LP
redeems at the inflated par NAV, exits whole, and concentrates the entire writedown on the LPs who
remain** when `seize` finally lands. That breaks the core ERC-4626 promise: share price should reflect
true NAV, and no holder should be able to exit at another's expense.

### Reproduced (empirical, zero-recovery default)

Two equal LPs (50 ETH each), one 30 ETH loan, borrower defaults:

| party | got | fair |
|---|---|---|
| informed LP (redeems before `seize`) | **50.0 ETH** (full par) | 35 |
| staying LP (redeems after `seize`) | **20.0 ETH** | 35 |

`previewRedeem` for the informed LP *while the loan is already seizable* returns 50 ETH — the NAV never
reflects the pending loss. The staying LP absorbs the **entire 30 ETH writedown**. The gap is the whole
loss, not half.

The `SEIZE_GRACE` window and the "someone has to call `seize`" dependency both *widen* the race: the
longer seizure is delayed, the longer the stale par NAV is exploitable.

## Why this is a design decision (not a one-line patch)

Default is a **time event with no transaction**. Nothing on-chain fires at `deadline`, so *some* action
must recognize the impairment, and the race lives in the gap before that action. There is no O(1) fix
that closes it without a trade-off — each option trades gas vs. LP liquidity vs. bluntness:

1. **Impair seizable loans in `totalAssets` (recommended).** Subtract the principal of any loan with
   `now > deadline + SEIZE_GRACE && !seized && !closed` from NAV, via a bounded loop over active loans.
   *Pro:* fair NAV at all times; LPs keep full liquidity and simply exit at the correct impaired price;
   restores the ERC-4626 invariant directly; symmetric with the existing seize writedown (recovery still
   flows back via `settleSeizure`). *Con:* O(active loans) gas on every deposit/withdraw — acceptable for
   an NFT-lending pool (each loan escrows an NFT, so realistic concurrency is dozens, not thousands), but
   should be bounded with a `maxActiveLoans` cap or an incremental impaired-principal counter maintained
   by a permissionless `markDefault(loanId)` poke that withdrawals require to be current.
2. **Freeze redemptions while any loan is seizable.** Block `withdraw`/`redeem` when a past-due-unseized
   loan exists (track the earliest unseized deadline). *Pro:* O(1); aligns with the pool's stated ethos
   ("the worst an unattended pool can do is stop lending" → here, stop *withdrawing* during default
   resolution). *Con:* blunt — honest LPs can't exit during any default; needs earliest-deadline upkeep.
3. **Minimize, don't close: incentivized keeper `seize`.** Keep par valuation but pay a bounty so
   `seize` is reliably called at `deadline + SEIZE_GRACE`, shrinking the window to the 1h grace. *Pro:*
   smallest change. *Con:* does not close the race, only narrows it; relies on keeper liveness for
   fairness — fragile.

**Recommendation: Option 1** — it is the only one that keeps the fair-NAV invariant *and* LP liquidity.
Use the incremental `markDefault` counter variant if loan concurrency could be large; otherwise the
bounded loop is simplest. Either way, decide whether to impair at `deadline` or at `deadline +
SEIZE_GRACE` (the grace hour is a genuine cure window, so impairing at `+ grace` is defensible and keeps
par valuation for loans that may still be repaid).

## Status

- ✅ Confirmed + reproduced (`NftfiVaultSeizureRace.t.sol`), pre-deploy, not pushed.
- ☐ **Design call required** (which option; impair-at-deadline vs +grace) before implementing.
- ☐ On decision: implement, flip the test's marked assertion to the fair-outcome form
  (`assertApproxEqAbs(gotEarly, gotStayer, …)`), keep the existing nftfi suites green.
- Note: the same par-until-seize valuation feeds `NftfiBnpl` if it prices against this vault — check
  when the fix lands.
