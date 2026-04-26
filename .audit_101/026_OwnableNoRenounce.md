# Audit 026 — `contracts/src/base/OwnableNoRenounce.sol`

**Auditor:** Agent 026 / 101  **Scope:** AUDIT-ONLY (no code changes)
**Target file:** `contracts/src/base/OwnableNoRenounce.sol` (22 LoC)
**Parent:** OZ `Ownable2Step` (v5.1.0) → `Ownable`

---

## Source under review

```solidity
abstract contract OwnableNoRenounce is Ownable2Step {
    constructor(address initialOwner) Ownable(initialOwner) {
        require(initialOwner != address(0), "ZERO_OWNER");
    }
    function renounceOwnership() public pure override {
        revert("RENOUNCE_DISABLED");
    }
}
```

---

## Importer impact map (16 contracts inherit, 2 stand-alone variants)

| # | Contract | Owner-arg style | Notes |
|---|---|---|---|
| 1 | `CommunityGrants` | `OwnableNoRenounce(msg.sender)` | std |
| 2 | `POLAccumulator` | `OwnableNoRenounce(msg.sender)` | std |
| 3 | `MemeBountyBoard` | `OwnableNoRenounce(msg.sender)` | std |
| 4 | `PremiumAccess` | `OwnableNoRenounce(msg.sender)` | std |
| 5 | `ReferralSplitter` | `OwnableNoRenounce(msg.sender)` | std |
| 6 | `SwapFeeRouter` | `OwnableNoRenounce(msg.sender)` | std |
| 7 | `TegridyLaunchpadV2` | `OwnableNoRenounce(_owner)` | explicit owner arg |
| 8 | `RevenueDistributor` | `OwnableNoRenounce(msg.sender)` | std |
| 9 | `TegridyFeeHook` | `OwnableNoRenounce(_owner)` | explicit owner arg (CREATE2) |
| 10| `TegridyLPFarming` | `OwnableNoRenounce(msg.sender)` | std |
| 11| `TegridyLending` | `OwnableNoRenounce(msg.sender)` | std |
| 12| `TegridyNFTLending` | `OwnableNoRenounce(msg.sender)` | std |
| 13| `TegridyStaking` | `OwnableNoRenounce(msg.sender)` | std (also ERC721) |
| 14| `TegridyRestaking` | `OwnableNoRenounce(msg.sender)` | std |
| 15| `GaugeController` | `OwnableNoRenounce(msg.sender)` | std |
| 16| `VoteIncentives` | `OwnableNoRenounce(msg.sender)` | std |
| 17| `TegridyNFTPoolFactory` | `OwnableNoRenounce(_owner)` | explicit owner arg |

**Outside scope (not inheriting OwnableNoRenounce, but using own 2-step):**
- `TegridyDropV2.sol` — proxy-cloned, hand-rolled `pendingOwner` + `transferOwnership` + `acceptOwnership`; `renounceOwnership` is `external view onlyOwner` (no-op, not reverting).
- `TegridyTWAP.sol` — hand-rolled 2-step; `renounceOwnership` is `external pure` (no-op, no revert).

---

## HIGH

**None identified.** Renounce is hard-blocked by `revert`; constructor enforces non-zero owner; OZ `Ownable2Step.transferOwnership` already requires `acceptOwnership` to settle the transfer, so the second-step pull preserves the owner if a wrong address is set as `pendingOwner`. No proxy upgrade hijack vector — none of the 17 importers are upgradeable proxies; `OwnableNoRenounce` is constructor-based (not initializer-based), incompatible with UUPS/transparent proxies which would be the only way to bypass.

## MEDIUM

### M-01 — Renounce-bypass via `transferOwnership(address(0))` is **NOT mitigated**
`Ownable2Step.transferOwnership(address(0))` is permitted (per OZ NatSpec line 41: "Setting `newOwner` to the zero address is allowed; this can be used to cancel an initiated ownership transfer"). The owner can call `transferOwnership(0)` — but because `acceptOwnership` requires `msg.sender == pendingOwner`, and `address(0)` cannot send a tx, this **cannot complete the renounce**, so the bypass is effectively neutralized. Still: the dangling `_pendingOwner = address(0)` state is harmless but the explicit revert in `renounceOwnership` gives a false sense of finality. **Impact: informational** — promotes M-01 to *acknowledged-by-design*. Recommend adding NatSpec to `OwnableNoRenounce` clarifying that `transferOwnership(0)` simply cancels a pending transfer (cannot brick).

### M-02 — Stale `pendingOwner` griefing surface (inherited from OZ)
`Ownable2Step` allows the current owner to set `pendingOwner` to any address and never expire it. A compromised current-owner key (before rotation) could front-run a multisig handover by re-calling `transferOwnership(attacker)` until the multisig accepts. All 17 importers are vulnerable. **Mitigation note**: protocol uses `TimelockAdmin` on most contracts, but `transferOwnership` itself is **not gated** by the timelock in any importer (Grep confirms zero `_timelockedTransferOwnership` patterns). Recommend either (a) timelocking `transferOwnership` in `OwnableNoRenounce`, or (b) a `cancelTransfer` admin entry-point with explicit event.

### M-03 — Two contracts (`TegridyDropV2`, `TegridyTWAP`) silently NO-OP `renounceOwnership` instead of reverting
`TegridyDropV2.renounceOwnership` is `external view onlyOwner {}` (no body, no revert) and `TegridyTWAP.renounceOwnership` is `external pure {}` — both succeed silently. Off-chain monitors expecting a revert (per the `OwnableNoRenounce` pattern) will be desynchronized. These are not in scope of `OwnableNoRenounce` but are a **consistency gap** flagged for cross-audit.

## LOW

### L-01 — Custom revert string instead of OZ custom error
`require(initialOwner != address(0), "ZERO_OWNER")` in the constructor is redundant — `Ownable(initialOwner)` already reverts with `OwnableInvalidOwner(address(0))` (custom error, ~50 gas cheaper, indexable). This double-check costs every deployment a few hundred gas and produces a non-standard string error. Not exploitable; just stylistic.

### L-02 — `renounceOwnership()` declared `pure`, blocks future hooks
Marking the override `pure` (instead of `view` or non-mutating with state-read) means subclasses cannot add an event emission or state-read in a future override without also dropping `pure`. If governance ever wants `OwnershipRenounceAttempted` telemetry, the base must change. Minor maintainability concern.

### L-03 — No `OwnershipTransferStarted` event override / re-emission
`OwnableNoRenounce` does not re-emit or augment `OwnershipTransferStarted`. Inherited from OZ — fine — but the base's own `renounceOwnership` revert emits **no event**, so off-chain indexers cannot distinguish "owner attempted renounce" from "tx reverted for other reason". Add an event before `revert` (requires dropping `pure`).

### L-04 — `initialOwner` constructor arg passed via `msg.sender` in 14/17 importers
14 contracts hard-code `OwnableNoRenounce(msg.sender)` instead of taking an `address _owner` parameter. For non-CREATE2 deploys this is fine, but if any of these 14 are ever deployed via Arachnid's deterministic deployer (`0x4e59b44847b379578588920cA78FbF26c0B4956C`), ownership will land on the proxy address, not the deployer — bricking the contract. Only `TegridyLaunchpadV2`, `TegridyFeeHook`, and `TegridyNFTPoolFactory` defensively accept `_owner`. **Recommendation**: standardize all 17 to accept `address _owner`.

## INFO

### I-01 — Init double-call: N/A
`OwnableNoRenounce` is constructor-based, not `initializer`-based. The two contracts using `initialize()` (`TegridyDropV2`, `TegridyNFTPool`) do **not** inherit `OwnableNoRenounce`. No double-init risk.

### I-02 — Child `_checkOwner` overrides: NONE found
Grep across `contracts/src` shows **zero** `_checkOwner` overrides. All 17 importers use the inherited OZ `_checkOwner` via `onlyOwner` modifier. No unsafe override to flag.

### I-03 — Tests
`test_renounceOwnership_disabled` exists in `TegridyDropV2.t.sol` (expects `"RENOUNCE_DISABLED"` revert) — but `TegridyDropV2` does **not** inherit `OwnableNoRenounce`; this test will fail or always pass (its `renounceOwnership` is a no-op `view`). **Likely a stale test inherited from a refactor.** Cross-flag for `TegridyDropV2` audit.

### I-04 — Solidity pragma `^0.8.20`
Matches OZ v5.1.0 minimum. Compatible with all 17 importers (all also `^0.8.20`+).

### I-05 — `abstract` modifier correctly used; cannot be deployed standalone.

---

## Top-3 priority items (for fix sprint)

1. **M-02** — Add timelock-gated `transferOwnership` (or per-importer wrapper) to neutralize compromised-owner front-running.
2. **L-04** — Standardize all 17 importers to accept `address _owner` constructor arg (CREATE2-safe).
3. **M-03 / I-03** — Reconcile `TegridyDropV2` + `TegridyTWAP` `renounceOwnership` to revert (not no-op); fix the stale test in `TegridyDropV2.t.sol`.

## Counts
- HIGH: 0
- MEDIUM: 3
- LOW: 4
- INFO: 5
- **Importers (inheriting): 17**  +  **2 outside-scope 2-step variants** (TegridyDropV2, TegridyTWAP)
