# NftfiPooledLendingVault — stale-NAV seizure race (CONFIRMED + FIXED, pre-deploy)

**Contract:** `contracts/src/nftfi/NftfiPooledLendingVault.sol` (ERC-4626).
**Status:** PRE-DEPLOY — absent from `frontend/scripts/addresses.json` and `constants.ts`. No live funds.
**Test:** `contracts/test/nftfi/NftfiVaultSeizureRace.t.sol` — regression suite for the fix (the pre-fix
race was reproduced first; git history holds that revision).

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

## The fix — LANDED: Option 2 (freeze deposits/withdrawals while a default is unrecognized)

Given the go-ahead ("do what's best"), Option 2 was chosen over the recommended-on-paper Option 1 once
the implementation trade-offs were concrete:

- **It keeps the money-path math untouched.** The contract header states its overrides "each narrow what
  the base would allow — none widens it", and deliberately keeps `totalAssets` minimal. Option 1 rewrites
  `totalAssets` (called on *every* deposit/withdraw/convert/preview) to loop and impair — heavy and
  invasive on the exact function the header protects. Option 2 leaves `totalAssets = idle +
  principalOutstanding` **O(1) and unchanged**, and only narrows the four `max*` ceilings — precisely the
  override style the contract already uses.
- **It fully closes the race** and produces the same fair outcome: while any open loan is past
  `deadline + SEIZE_GRACE` and unseized, `maxDeposit`/`maxWithdraw`/`maxRedeem` all return 0, so nobody
  can enter or exit at the stale par NAV. The permissionless `seize` recognizes the loss (drops
  `principalOutstanding`) and clears the freeze; everyone then exits at the corrected, shared price.
- **Custom-code surface is minimal** (the ethos): one bounded `EnumerableSetLib.Uint256Set` of open
  loans (add on `borrow`, remove on full-repay and on `seize`), a `MAX_ACTIVE_LOANS = 256` cap so the
  freeze scan can never be griefed out-of-gas, and one `hasSeizableLoan()` view. No new NAV accounting,
  no `markDefault` machinery, no keeper.

Freeze boundary is `deadline + SEIZE_GRACE` (not `deadline`): the grace hour is a genuine borrower cure
window, so par valuation and normal liquidity during it are intended, and the freeze begins exactly when
`seize` becomes callable. This leaves a bounded ~1h residual (an LP exiting during grace on a loan that
ultimately defaults) — minor, and matches standard impair-at-default timing.

**Verification:** `NftfiVaultSeizureRace.t.sol` — the pre-fix race (early exiter took 50/fair-35, stayer
20) is replaced by an equal 35/35 split; the early exit reverts during the freeze; a healthy loan and the
grace window do NOT freeze (narrowness). Freeze gate mutation-verified (remove it → red). **54 nftfi
tests pass, zero regression.**

### Operational notes (not vulnerabilities)

- **`liquidationSink` must be set.** The freeze clears only via `seize`, which reverts if the sink is
  unset. A pool that lends with no sink can be frozen by a default until the owner sets one — set the
  sink before lending (the deploy path does).
- **Freeze-scan gas** grows with concurrent open loans (bounded at 256). Realistic single-collection
  pools hold far fewer; if a pool is expected to run hot, consider lowering `MAX_ACTIVE_LOANS` or the
  incremental-counter variant of Option 1.
- **Griefing is uneconomical.** To hold the freeze open an attacker must keep a loan past `deadline +
  grace`; but that loan is permissionlessly seizable, so anyone clears the freeze and the attacker forfeits
  their (over-collateralized) NFT.

## Status

- ✅ Confirmed + reproduced, then FIXED (freeze-on-seizable) and verified — pre-deploy, **not pushed**.
- ✅ 54 nftfi tests green (existing 51 + 3 regression); freeze gate mutation-verified.
- Note: the same par-until-seize valuation feeds `NftfiBnpl` if it prices against this vault — check when
  BNPL integrates.
