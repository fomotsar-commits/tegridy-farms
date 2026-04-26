# Agent 028 — WETHFallbackLib.sol forensic audit

**Target:** `contracts/src/lib/WETHFallbackLib.sol`
**Mode:** AUDIT-ONLY (no code edits).

## Library surface

```solidity
function safeTransferETHOrWrap(address weth, address to, uint256 amount) internal {
    if (amount == 0) return;
    if (weth == address(0)) revert ZeroWETHAddress();
    (bool ok,) = to.call{value: amount, gas: 10000}("");   // 10k stipend (H-02)
    if (ok) return;
    IWETH(weth).deposit{value: amount}();                  // wrap whole amount
    bool sent = IWETH(weth).transfer(to, amount);
    if (!sent) revert WETHTransferFailed();
}

function safeTransferETH(address to, uint256 amount) internal {
    if (amount == 0) return;
    (bool ok,) = to.call{value: amount}("");               // unbounded gas
    if (!ok) revert ETHTransferFailed();
}
```

## Importers (12 production contracts)

| File | Path | weth field | mutability |
|---|---|---|---|
| Router | contracts/src/TegridyRouter.sol | `address public immutable WETH` (constructor) | immutable |
| SwapFeeRouter | contracts/src/SwapFeeRouter.sol | `address public immutable WETH = router.WETH()` | immutable |
| RevenueDistributor | contracts/src/RevenueDistributor.sol | `IWETH public immutable weth` | immutable |
| VoteIncentives | contracts/src/VoteIncentives.sol | `IWETH public immutable weth` | immutable |
| CommunityGrants | contracts/src/CommunityGrants.sol | `address public immutable weth` | immutable |
| ReferralSplitter | contracts/src/ReferralSplitter.sol | `address public immutable weth` | immutable |
| MemeBountyBoard | contracts/src/MemeBountyBoard.sol | `address public immutable weth` | immutable |
| TegridyLending | contracts/src/TegridyLending.sol | `address public immutable weth` | immutable |
| TegridyNFTLending | contracts/src/TegridyNFTLending.sol | `address public immutable weth` | immutable |
| TegridyNFTPoolFactory | contracts/src/TegridyNFTPoolFactory.sol | `address public immutable weth` | immutable |
| **TegridyNFTPool** | contracts/src/TegridyNFTPool.sol | `address public weth` (init-once, EIP-1167 clone) | mutable storage, set once via `initialize()` |
| **TegridyDropV2** | contracts/src/TegridyDropV2.sol | `address public weth` (init-once, EIP-1167 clone) | mutable storage, set once via `initialize()` |

`TegridyNFTPool` and `TegridyDropV2` use ERC-1167 clone proxies, so `immutable` cannot be used; both rely on `initializer` modifier (OZ Initializable) to lock the field after first call. No public/external setter for `weth` exists in any contract; verified via grep `setWeth|setWETH`.

---

## HIGH

### H-1 (info-only — design tension): `safeTransferETHOrWrap` whole-amount wrap leaks accounting state when stipend fails partway

If the recipient is a contract whose `receive()` consumes >10k gas, the `to.call{gas:10000}` reverts and the library wraps **the full `amount`** as WETH and ERC20-transfers it. That is the intended Aave/Seaport behaviour. **However**, the failure mode is silently observable to the caller's accounting — none of the 12 importers emit a "fellThroughToWETH" event, so any downstream protocol (Lending, Drop, NFTPool, Bounty) that maintains an "ETH paid out" counter will see no signal that the recipient received WETH instead of ETH. Not exploitable, but breaks tooling/indexers that track ETH flow per address.

**Status:** present; not currently a bug since callers don't differentiate.

---

## MEDIUM

### M-1: Recipient can grief 10k gas stipend → forced WETH path → forced ERC20 acceptance

Any contract recipient that wants to **avoid receiving ETH** can simply revert in `receive()` (or consume >10k gas). The library will then wrap and `IWETH.transfer(to, amount)`. Mainnet WETH9's `transfer` returns `true` even for contracts with no ERC20 hooks (no `_beforeTokenTransfer`), so the path always succeeds. **Implication:** the recipient cannot block the payout, but it also cannot opt out of WETH custody — they will accumulate WETH balance whether they wanted it or not. For revert-on-receive contract recipients (e.g., a multisig that only handles ERC20 explicitly), this is the desired Solmate/Seaport behaviour; for reverting-by-mistake recipients (a buggy receive), it silently masks the bug. Worth a release note.

**Importer impact:**
- `TegridyLending.repayLoan` (line 540): if lender's contract reverts on ETH, lender silently accrues WETH at the canonical chain WETH — fine.
- `MemeBountyBoard.completeBounty` (line 334) — uses **inline** 10k-stipend `.call` followed by pending-payout queue rather than the lib. Confirm parity: bounty completion does NOT auto-wrap; it credits `pendingPayouts[winner]` and the winner pulls via `withdrawPayout()` → which calls `safeTransferETHOrWrap`. Two-stage wrap consistent.

### M-2: `IWETH.transfer` boolean is honored, but `bool sent` ignores tokens that revert vs return-false

Line 51: `bool sent = IWETH(weth).transfer(to, amount); if (!sent) revert WETHTransferFailed();`

Canonical mainnet WETH9 (`0xC02a…`) has no transfer-blocking behaviour. **However** the audit assumption is "trusted, immutable WETH set at deploy time." If an attacker can substitute a malicious WETH at deploy time (e.g., a misconfigured chain registry, a typo in a frontend deploy script that pulls the wrong canonical address), `IWETH.transfer` could return false, revert, or burn the deposited ETH. The library has no `transferFrom`/safeERC20 wrapper and trusts deploy-time governance. The 12 importers do verify `_weth != address(0)` but none verify `IWETH(weth).symbol() == "WETH"` or that `weth.code.length > 0`. Mitigation depends entirely on deploy-time review.

**Importer impact (chain-specific WETH drift):**
- TegridyNFTPool / TegridyDropV2 use **factory-supplied** WETH per clone. A malicious factory operator could deploy clones with attacker-controlled WETH. Currently both factories (`TegridyNFTPoolFactory.sol`, `TegridyLaunchpadV2.sol`) use their own immutable `weth` and pass it to the clone, so it inherits factory governance. Verified the factory does not accept a per-clone WETH override — clone receives `factory.weth` only.
- POLAccumulator (line 149) does `weth = router.WETH()` — derives WETH from the router. If the router was deployed with a wrong WETH, POLAccumulator inherits that. Not in the importer list (POLAccumulator does not import the lib) but confirms the trust pattern.

### M-3: Return-data bombing on the ETH `.call`

The library uses `(bool ok,) = to.call{...}("");` — return-data is discarded with the trailing comma. This is the safe Solmate pattern; **no return-data bomb is possible** here because the second tuple slot is dropped without copying. CONFIRMED SAFE.

However, `safeTransferETH` (the non-fallback variant, line 59) does the same — also safe.

**Importer impact:** none.

### M-4: Reentrancy posture — 10k stipend prevents external calls from recipient back into protocol contracts, but the WETH-fallback branch performs `IWETH.deposit{value:amount}()` followed by `IWETH.transfer(to, amount)`

If `weth` were attacker-controlled, `deposit()` could re-enter any caller of `safeTransferETHOrWrap`. **Mitigation:** every importer call site is wrapped in `nonReentrant` modifier on the entry function (verified for `MemeBountyBoard.withdrawPayout`, `TegridyLending.cancelOffer/repay/acceptOffer`, `CommunityGrants.executeProposal`, `ReferralSplitter.claim*`, `TegridyNFTLending.*`, `TegridyDropV2.mint/withdraw/refund`, `TegridyNFTPool._sendETH` callers, `RevenueDistributor.claim`, `VoteIncentives.claim`). `TegridyRouter.addLiquidityETH` and `removeLiquidityETH` likewise carry `nonReentrant`. Confirmed posture: even malicious WETH cannot cross-function re-enter the same contract.

**Cross-contract reentrancy** is the residual risk: a malicious WETH could call into a *different* protocol contract during `deposit`. Mitigation depends on each target contract being self-protected with its own `nonReentrant`. This is implementation-wide and out of scope for the lib itself.

### M-5: `safeTransferETH` (non-fallback variant) forwards UNBOUNDED gas

Line 57-61. Used only by `TegridyLending.repayLoan` line 550 (`safeTransferETH(msg.sender, overpayment)` for borrower overpayment refund). The recipient is `msg.sender` — the borrower repaying their own loan — so they self-griefed. Reasonable, but the unbounded gas means a borrower's `receive()` could re-enter `repayLoan()` of a different lender, etc. **Mitigation:** `repayLoan()` is `nonReentrant`. Cross-contract reentrancy possible if the borrower contract calls into *another* TegridyLending instance or another protocol contract. Low likelihood, INFO-tier in practice.

---

## LOW

### L-1: Dust ETH stuck if `IWETH.transfer` succeeds but recipient is blacklisted by a future WETH9 fork

Some chains have WETH9 forks (e.g., Optimism, some L2 wrappers) that may add transfer hooks or pause functionality. If a chain WETH supports blacklist (very unlikely for the canonical wrapper, but possible on forks), `transfer` would revert, and the library reverts with `WETHTransferFailed()` — leaving the ETH already wrapped inside the library's contract context. Since the library is a pure `internal` library, there is no library balance — the wrapped ETH lives in the **importer's** WETH balance. The importer would need a `recoverWETH` function to sweep it out. None of the 12 importers explicitly handle this case.

**Importer impact:** TegridyLending, TegridyNFTLending, CommunityGrants, MemeBountyBoard, ReferralSplitter, RevenueDistributor, VoteIncentives, TegridyDropV2, TegridyNFTPool, SwapFeeRouter, TegridyRouter, TegridyNFTPoolFactory — none has a generic ERC20 sweep that includes WETH; only TegridyNFTPoolFactory and a few have admin recovery. If a WETH-blacklist scenario happens, those funds are stuck. Recommend documenting this as a known-acceptable risk for canonical WETH9 chains.

### L-2: `amount == 0` early-return silently no-ops

Line 41: `if (amount == 0) return;` — silently swallows zero-value transfers. Generally desirable, but it means callers don't have to gate `amount > 0` themselves. Verified all 12 importers either gate explicitly (e.g., `MemeBountyBoard.withdrawPayout` checks `amount == 0`) or are reachable only when amount > 0 (e.g., post-fee-split arithmetic).

### L-3: msg.value vs amount mismatch — library doesn't validate that the calling contract holds `amount` ETH

Library is `internal` and uses `address(this).balance` implicitly via `to.call{value:amount}` and `IWETH.deposit{value:amount}`. If `amount > address(this).balance`, the EVM reverts. The library does not validate this. Caller responsibility. Verified all importers compute `amount` from prior state, not from arbitrary user input — correct posture.

### L-4: 10k gas stipend may be insufficient for some legitimate Safe wallets / abstract account contracts

EIP-4337 smart accounts and some Safe modules may need >10k gas for `receive()`, e.g., to record incoming ETH in storage. They will fall through to the WETH path and silently receive WETH. For most accounts, this is acceptable; for accounts that explicitly want ETH (e.g., a relayer needing native ETH for gas), the WETH wrap forces them to unwrap. INFO-tier — Solmate/Seaport accept this tradeoff.

---

## INFO

### I-1: Gas optimization — duplicate balance check
Library does not check `weth.code.length > 0`. If `weth` is an EOA at deploy time (impossible if checks pass at deploy), `deposit` would still succeed silently. Not a vulnerability (the deploy-time `_weth != address(0)` check + the importer's deploy script vetting WETH address).

### I-2: No event emission for the "fell through to WETH" branch
None of the 12 importers emit a distinct event when WETH fallback fires. Indexers cannot distinguish ETH vs WETH payment in transaction history. Tooling concern only.

### I-3: `safeTransferETH` (non-fallback) has no chain-stipend protection
Used in TegridyLending overpayment refund only. Acceptable per design.

### I-4: Library has no slippage on wrap
Wraps 1:1 (canonical WETH9 has no fee-on-deposit). Slippage is implicit zero. Confirmed safe for canonical WETH9 chains.

### I-5: TegridyNFTPool / TegridyDropV2 — clone proxy factories
Mutable `weth` field is set in `initialize()` guarded by OpenZeppelin `initializer` modifier. After init, the field is effectively immutable for that clone. Verified no setter exists. Posture matches an `immutable` field; risk equivalent.

---

## Summary table

| Severity | Count |
|---|---|
| HIGH | 1 (info-only design note) |
| MEDIUM | 5 |
| LOW | 4 |
| INFO | 5 |

## Top systemic risk

The library's correctness depends entirely on the deploy-time WETH address being the canonical chain WETH9. There is no on-chain runtime validation. All 12 importers trust their constructor/initializer caller. Recommend a deploy-script invariant check (off-chain) that asserts `IWETH.symbol() == "WETH"` and `decimals == 18` and `address` matches the published canonical for each chain. No on-chain change required.
