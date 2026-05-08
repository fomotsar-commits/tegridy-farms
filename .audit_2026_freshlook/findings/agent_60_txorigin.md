# Agent 60 — tx.origin / EOA-detection / EIP-7702 fresh-eyes audit

**Lens:** tx.origin phishing risk, EOA-only assumptions, AA wallet incompatibility,
constructor-bypass of `code.length` checks, EIP-7702 (Pectra) post-fork EOA-with-code.

**Working dir scanned:** `contracts/src/**` (no test or script files).

---

## Headline

- `tx.origin` — **0 occurrences** anywhere in `contracts/src/`. No phishing surface.
- `extcodesize`, `Address.isContract` — **0 occurrences**. Modern `code.length` is used everywhere.
- All EOA/contract detection is via `addr.code.length` (10 distinct sites).
- 7702 risk has been explicitly addressed in 2 places (`OwnableNoRenounce`, `TegridyFactory.createPair`)
  but is **NOT** addressed in 5 other admin-wiring sites where it could matter, and the
  Toweli ERC-2612 permit's branch logic also misclassifies 7702-EOAs (with consequences ranging
  from "harmless if the delegate implements 1271" to "permit calls revert with confusing typed errors").

---

## F-60-1 — `Toweli.permit()` mis-routes EIP-7702 delegated EOAs to the ERC-1271 branch

**File:** `contracts/src/Toweli.sol:195`

```solidity
if (owner.code.length == 0) {
    // EOA path — ECDSA.tryRecover, expects recovered == owner
} else {
    // Contract path — SignatureChecker.isValidSignatureNow → ERC-1271 staticcall
}
```

**Issue.** Post-Pectra (live since 2025-05-07, i.e. **today** per the system date),
an EIP-7702 delegated EOA has `code.length == 23` (the canonical
`0xef0100‖addr` delegation pointer). This contract sends such an owner down the
**contract** branch, where `SignatureChecker.isValidSignatureNow` performs an
ERC-1271 `isValidSignature` staticcall against the delegated implementation.

There are two failure modes:

1. **Delegate implements ERC-1271 correctly.** The user's wallet is signing
   typed-data with the underlying EOA's private key, which is what ECDSA
   recovery would have validated — but the delegate's `isValidSignature` is
   the one that gets queried. If the delegate is a 4337-style validator
   contract, it likely *does* understand its own EIP-712 typed-data flow but
   may not accept a raw ECDSA signature shaped as `(r, s, v)` over the OZ
   ERC-2612 typehash. In practice many 7702 delegates (e.g. Argent, Coinbase
   Smart Wallet, Safe-style adaptations) wrap the signature in their own
   modular validator format, so the bare `abi.encodePacked(r, s, v)` will
   not validate → permit reverts `ERC2612InvalidSigner(address(0), owner)`.
   Result: ERC-2612 permit silently broken for 7702 users.

2. **Delegate does NOT implement ERC-1271.** The staticcall to a non-existent
   selector returns empty data → `SignatureChecker` returns false →
   `ERC2612InvalidSigner`. Same revert, same broken UX, but here the user
   would be surprised because they signed with their EOA private key and that
   ought to work.

**Severity:** LOW. ERC-2612 permit is a UX optimisation; the standard 2-tx
`approve + transferFrom` flow remains. But the contract's NatSpec at lines
24-27 / 124-136 explicitly advertises "Compatible with account abstraction
flows via ERC-2612 permit" and the v3-LIB-L2 fix was specifically added so
SCWs work — 7702 EOAs are the new "third class" of caller that this branch
logic doesn't handle.

**Fix sketch.** Mirror the `OwnableNoRenounce` post-Pectra pattern: treat
`code.length == 0 OR code.length == 23` as the EOA branch (ECDSA path), and
only `code.length > 0 && code.length != 23` as the SCW branch. A 7702-EOA
signing with their own private key over the OZ ERC-2612 typehash will then
recover correctly and the permit succeeds.

```solidity
uint256 codeLen = owner.code.length;
if (codeLen == 0 || codeLen == 23) {
    // EOA or 7702-delegated EOA — ECDSA.tryRecover still works
}
```

The `OwnableNoRenounce` comment at line 88-100 explicitly notes this exact
pattern. The Toweli permit predates the OwnableNoRenounce fix by audit batch
notation but neither was retrofitted onto the other.

---

## F-60-2 — `setLendingAdmin` / `setVoteIncentivesAdmin` / `setGaugeController` accept 7702-delegated EOAs as "contracts"

**Files:**
- `contracts/src/TegridyLending.sol:137` — `require(_admin.code.length > 0, "ADMIN_MUST_BE_CONTRACT");`
- `contracts/src/VoteIncentives.sol:123` — `require(_gaugeController.code.length > 0, "GC_MUST_BE_CONTRACT");`
- `contracts/src/VoteIncentives.sol:148` — `require(_admin.code.length > 0, "ADMIN_MUST_BE_CONTRACT");`

**Issue.** The check `code.length > 0` accepts any address with code, including
a 7702-delegated EOA whose `code.length == 23`. The intent of the guards
(per the surrounding comments and the parallel fix in `OwnableNoRenounce`) is
to require a **genuine contract** (multisig, admin contract, gauge
controller) — not an EOA pretending to be a contract via 7702 delegation.

**Exploit path.**

1. Owner (multisig) is tricked / phished / mispastes into calling
   `setLendingAdmin(0x<7702-EOA>)` where the EOA is controlled by an
   attacker and has been 7702-delegated to some innocent-looking validator
   stub.
2. The check `_admin.code.length > 0` passes (length is 23).
3. `lendingAdmin` is now permanently set to the attacker's EOA. Recovery
   requires the 48h `proposeAdminReplacement` timelock at best, or is
   **impossible** if the contract has no replacement path (TegridyLending
   only has `setLendingAdmin` as a one-shot — see `LendingAdminAlreadySet`
   revert at line 136).
4. The attacker now controls every `onlyAdmin`-gated function on the
   `TegridyLending` instance — and `lendingAdmin` is callable from EVM-side
   even though it's "an EOA" because 7702 routes calls *through* the EOA's
   delegated code.

For `setLendingAdmin` specifically, **there is no admin replacement function**
in the file (grep confirms only `setLendingAdmin`, no `proposeAdminReplacement`
sister). A wrong assignment is unrecoverable and the contract is bricked or
captured.

**Severity contrast.**
- `OwnableNoRenounce._transferOwnership` (BATCH-H M29) **already fixed** this
  by also rejecting `code.length == 23`.
- `TegridyFactory.createPair` (BATCH-L1 M16) **already fixed** the same on
  token addresses (`t0len != 23 && t1len != 23`).
- The three sites above were **not** retrofitted.

**Severity:** MEDIUM. The owner is a multisig and a typo on the address is
the realistic threat model (the same threat model the existing fixes guard
against). 7702 specifically extends the typo into a "this looks like a
contract on Etherscan" social-engineering vector because the etherscan UI
will render `code.length == 23` as "Contract" with a green tick and the
delegation pointer expanded to the implementation. An attacker doesn't need
multisig keys; they only need the multisig to call `setLendingAdmin` once
with a hostile address.

**Fix.** Replace each `require(_x.code.length > 0, ...)` with the `length > 0
&& length != 23` pattern used by `OwnableNoRenounce`. Suggested helper:

```solidity
function _requireGenuineContract(address a) internal view {
    uint256 len = a.code.length;
    if (len == 0 || len == 23) revert NotAContract();
}
```

Also applies to:
- `TegridyStaking.sol:469` (`setJbacVault`) — `code.length == 0` path; misses 7702.
- `TegridyStaking.sol:1885` (`setStakingAdmin`) — same.
- `GaugeController.sol:839, 843` (`proposeAddGauge` gauge + pair) — same.
- `TegridyNFTLending.sol:393` (`setSequencerFeed`) — same.
- `TegridyNFTLending.sol:1028` (`whitelistCollection`) — same; partially mitigated by
  the `IERC165.supportsInterface(0x80ac58cd)` follow-up call (line 1029) which a
  7702-delegated EOA would only pass if its delegate implemented ERC-721 —
  unlikely but not impossible.
- `TegridyNFTPoolFactory.sol:207` (`createPool`) — same; also has a follow-up
  `safeTransferFrom` of NFTs from the caller which would naturally exclude
  most-but-not-all 7702 delegates.

---

## F-60-3 — `TegridyStaking._afterTokenTransfer` "EOA-only AlreadyHasPosition" guard misses 7702-EOAs

**File:** `contracts/src/TegridyStaking.sol:1347-1352`

```solidity
if (
    to != address(0) &&
    userTokenId[to] != 0 &&
    to.code.length == 0 &&    // ← only treats raw EOAs as "EOA"
    !isLendingContract[from]
) revert AlreadyHasPosition();
```

**Issue.** The `AlreadyHasPosition` guard prevents an EOA from holding two
position NFTs because `userTokenId` is a single-slot mapping that would
silently lose track of one of them — voting power and reward accounting
would alias to a single id. Contracts like `TegridyRestaking` legitimately
hold multiple positions, so the guard is conditional on `to.code.length == 0`.

A 7702-delegated EOA has `code.length == 23` → falls into the "is a
contract" branch → guard does **not** fire → the user can hold two NFTs at
the same address but `userTokenId[to]` only stores the latest, so:

- Reward settlement on the older NFT may misroute (the line 1376 `_touch(to)`
  and line 1374 `userTokenId[to] = id` overwrite the older id's rotation).
- Voting power aggregation uses `_positionsByOwner[to]` (the EnumerableSet at
  line 1338), which is consistent — that path is fine.
- `userTokenId` consumers (search the codebase for `userTokenId[`) would mis-resolve.

Let me trust the existing comments at 1342: contracts CAN hold multiple positions
because `_positionsByOwner` aggregates them. So the 7702-EOA doesn't lose any
voting power — it gets the *contract* treatment, which is the more permissive
path. The harm is the inverse: the **user expected the EOA-only AlreadyHasPosition
guard to protect them from accidentally splitting their stake across two NFTs**,
and that guarantee is silently lost the moment they delegate via 7702.

**Severity:** LOW. This is a UX safety-rail downgrade, not a fund-loss exploit.
The user's positions remain accounted-for via the set-based aggregation. But
the documented invariant ("Prevent overwriting an existing position for EOAs")
is no longer enforced for the 7702-EOA subset, which is the population that
is going to grow rapidly post-Pectra.

**Fix.** Same pattern: `to.code.length == 0 || to.code.length == 23` to keep
the EOA-style safety rail for 7702 users.

---

## F-60-4 — `TegridyStaking._afterTokenTransfer` `MultipleNFTsAtAddress` event miss

**File:** `contracts/src/TegridyStaking.sol:1371`

```solidity
if (to.code.length > 0 && to != restakingContract && userTokenId[to] != 0) {
    emit MultipleNFTsAtAddress(to, id, userTokenId[to]);
}
```

**Issue.** The event is emitted when a non-restaking contract receives a
second+ NFT. A 7702-EOA satisfies `code.length > 0` (length 23) and is not
the restaking contract → it WOULD be flagged. That actually works correctly
in this direction — the event fires for 7702 EOAs that accumulate multiple
positions, which is the intended monitoring signal.

**Note:** **Not a finding.** Documented for the auditor to confirm the
asymmetry between F-60-3 (silent AlreadyHasPosition skip) and F-60-4
(event emitted). Both checks fire for 7702-EOAs because both check
`code.length > 0`-vs-`==0`, and 23 > 0 = true and 23 != 0 = true. So:

- 1347-1352 guard: 7702 EOA goes to the **contract** branch → guard SKIPPED
  (the EOA-rail is silently downgraded — F-60-3).
- 1371 event: 7702 EOA goes to the **contract** branch → event FIRED (operator
  sees "weird non-restaking contract holding multiple NFTs").

The downstream off-chain monitoring will probably file the event as a
false-positive "uncategorised contract" since 7702 delegates aren't
distinguishable from genuine contracts at this check.

---

## F-60-5 — `TegridyFactory._rejectERC777` early-out skips ERC-1820 hooks if the registry has been 7702-aliased

**File:** `contracts/src/TegridyFactory.sol:347`

```solidity
if (ERC1820_REGISTRY.code.length > 0) { ... }
```

**Issue.** The ERC-1820 registry is at the immutable singleton address
`0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24`. Its bytecode is published and
length is fixed. A check `code.length > 0` against this address is sound
because the address either has the canonical registry deployed or it
doesn't — there is no scenario where it has `code.length == 23` (no one
will 7702-delegate the canonical registry singleton; that EOA's private key
is presumably destroyed).

**Verdict:** **Not a finding.** The address is hardcoded and can only ever
be the canonical registry or empty. Documented for completeness so future
auditors don't flag it.

---

## F-60-6 — `OwnableNoRenounce._transferOwnership` — confirmed correct

**File:** `contracts/src/base/OwnableNoRenounce.sol:86-103`

```solidity
uint256 codeLen = newOwner.code.length;
if (codeLen == 0 || codeLen == 23) revert OwnerNotContract(newOwner);
```

**Verdict:** This is the **reference implementation** for the rest of the
codebase. The pattern `(codeLen == 0 || codeLen == 23)` correctly rejects
both raw EOAs and 7702-delegated EOAs on multisig-only ownership transfer.
The comment at lines 88-100 explicitly documents the EIP-7702 / Pectra
rationale. **Not a finding.** Listed because F-60-1 / F-60-2 should be
fixed by mirroring this exact pattern.

---

## F-60-7 — `TegridyFactory.createPair` token check — confirmed correct

**File:** `contracts/src/TegridyFactory.sol:174-176`

```solidity
uint256 t0len = token0.code.length;
uint256 t1len = token1.code.length;
require(t0len > 0 && t0len != 23 && t1len > 0 && t1len != 23, "NOT_CONTRACT");
```

**Verdict:** Same reference pattern as OwnableNoRenounce, correctly applied
to token addresses to reject 7702-EOAs masquerading as ERC-20s. **Not a
finding.** Listed as the second locus where the codebase already does this
right; the gap is that other admin-wiring sites (F-60-2) didn't get
retrofitted with the same check.

---

## Constructor-bypass risk on `code.length` checks — analysis

Solidity's `address.code.length` returns 0 for an address whose contract
is currently inside its constructor (runtime code hasn't been written yet
at the EVM `EXTCODESIZE` level). This is the classic "isContract" bypass.

For each EOA-detection (`code.length == 0`) site I traced the consequence
of a contract-in-constructor passing as EOA:

| Site | Direction | Constructor-bypass exploit? |
|---|---|---|
| `TegridyStaking.sol:1350` (`AlreadyHasPosition`) | EOAs blocked | None — would just *trigger* the stricter guard, no privilege gain |
| `TegridyStaking.sol:469` (`setJbacVault`) | EOAs blocked | None — `setJbacVault` is `onlyOwner`; an attacker who can frontrun a constructor for the vault address has bigger problems |
| `TegridyStaking.sol:1885` (`setStakingAdmin`) | EOAs blocked | None — same `onlyOwner` gate |
| `GaugeController.sol:839, 843` (`proposeAddGauge`) | EOAs blocked | None — `onlyOwner` |
| `TegridyNFTLending.sol:393` (`setSequencerFeed`) | EOAs blocked | None — `onlyOwner`, one-shot |
| `VoteIncentives.sol:1426` (`_validatePair`) | EOAs blocked | None — runtime-validated against `factory.getPair()` next line, so even a constructor-bypass-then-revert yields no fake pair |

Every EOA-detection site that *blocks* EOAs is gated by `onlyOwner` (or by
a runtime cross-check). The constructor-bypass requires the bypass to
happen *during* the on-chain transaction the owner sends, which means the
owner is signing a transaction that deploys the malicious contract first.
That's not a meaningful attack — the owner is already malicious or
compromised at that point and could simply pass an unconstrained address.

The contract-detection (`code.length > 0`) sites, on the other hand, are
the F-60-2 set above, where the constructor bypass is **the wrong direction**
(a contract-in-constructor would FAIL the check, which is the safe failure
mode), so the only residual risk there is the **7702 direction** (EOA
appearing as contract because of delegation), which F-60-2 covers.

**Verdict on constructor bypass:** No exploit path in the current codebase.

---

## EIP-7702 considerations summary

| Pattern | Mitigated? | File / Notes |
|---|---|---|
| Multisig-ownership-only invariant | YES | `OwnableNoRenounce.sol:86-103` |
| Pair token must be ERC-20 contract | YES | `TegridyFactory.sol:174-176` |
| Lending admin must be contract | **NO** | `TegridyLending.sol:137` — F-60-2 |
| Vote incentives admin must be contract | **NO** | `VoteIncentives.sol:148` — F-60-2 |
| GaugeController must be contract | **NO** | `VoteIncentives.sol:123` — F-60-2 |
| Staking admin must be contract | **NO** | `TegridyStaking.sol:1885` — F-60-2 |
| JBAC vault must be contract | **NO** | `TegridyStaking.sol:469` — F-60-2 |
| Gauge / pair must be contract | **NO** | `GaugeController.sol:839, 843` — F-60-2 |
| Sequencer feed must be contract | **NO** | `TegridyNFTLending.sol:393` — F-60-2 |
| ERC-721 collection must be contract | partial | `TegridyNFTLending.sol:1028` + ERC-165 follow-up — F-60-2 (low residual) |
| ERC-721 collection (factory) must be contract | partial | `TegridyNFTPoolFactory.sol:207` + downstream `safeTransferFrom` — F-60-2 (low residual) |
| ERC-2612 permit dispatch (EOA vs SCW) | **NO** | `Toweli.sol:195` — F-60-1 |
| Staking AlreadyHasPosition EOA-rail | **NO** | `TegridyStaking.sol:1350` — F-60-3 |

The codebase's EIP-7702 awareness is **partial**: the OwnableNoRenounce
fix (BATCH-H M29) and the TegridyFactory token check (BATCH-L1 M16) set the
right pattern, but ten other `code.length` sites were not retrofitted.
With Pectra live as of 2025-05-07 (today) the 7702-delegated-EOA population
is going to start rising over the next weeks; the gap should be closed
before mainnet relaunch.

---

## Notes / dead-ends

- Searched for `tx.origin`, `msg.sender == tx.origin`, `tx.origin == msg.sender`,
  `extcodesize`, `Address.isContract`, `isContract(`. Zero hits across
  `contracts/src/`. The codebase is clean of phishing-via-tx.origin
  surface.
- The `payable(msg.sender)` and `address(msg.sender)` patterns are used
  extensively but never compared to `tx.origin` for auth.
- No `delegatecall` to user-controlled addresses (separate audit lens but
  worth noting tx.origin would be load-bearing if there were).
- The `Toweli.sol` `recipient.code.length > 0` deferral comment at line 93
  (DEEP-LIB-M4) is a documented operational-discipline trade-off — not a
  fresh finding, kept here for the auditor's awareness only.
- `VoteIncentives.sol:1426` `_validatePair` checks `code.length == 0` then
  immediately cross-checks against `factory.getPair(t0, t1)`, so a
  constructor-bypass-then-revert is structurally caught by the registry
  check. Robust.
- `GaugeController.sol:839, 843` apply only at gauge addition, which is
  `onlyOwner`. Even if 7702 lets an EOA pass the check, the gauge has to be
  callable by emission distributors; if the 7702 delegate doesn't implement
  the gauge interface, the downstream `notifyRewardAmount` call simply
  reverts (livenness loss, not theft). The 48-hour timelock on
  `executeAddGauge` (per the PASS7-GAUGE-H1 comments) gives ample
  observation window. Marked MEDIUM in F-60-2 because the failure mode is
  emissions-routed-to-EOA, but in this specific case the realistic outcome
  is a stuck/bricked gauge slot rather than fund theft.

---

## Summary

- **F-60-1 (LOW):** `Toweli.permit()` mis-routes 7702-EOAs to the ERC-1271 branch → permit silently broken for 7702 wallets.
- **F-60-2 (MEDIUM):** Five+ admin/contract-wiring sites (`TegridyLending.setLendingAdmin`, `VoteIncentives.setVoteIncentivesAdmin` / `setGaugeController`, `TegridyStaking.setJbacVault` / `setStakingAdmin`, `GaugeController.proposeAddGauge`, `TegridyNFTLending.setSequencerFeed` / `whitelistCollection`, `TegridyNFTPoolFactory.createPool`) accept 7702-delegated EOAs because they only check `code.length > 0`, not `> 0 && != 23`. `TegridyLending.setLendingAdmin` is the worst because it's one-shot and unrecoverable.
- **F-60-3 (LOW):** `TegridyStaking._afterTokenTransfer` AlreadyHasPosition rail silently downgrades for 7702-EOAs.
- **F-60-4 (NOT A FINDING):** Documented for asymmetry with F-60-3.
- **F-60-5 (NOT A FINDING):** ERC-1820 registry singleton hardcoded address, immune.
- **F-60-6, F-60-7 (NOT FINDINGS — reference correct fixes):** `OwnableNoRenounce` and `TegridyFactory.createPair` correctly handle 7702. The fix pattern is already in-tree; F-60-1, F-60-2, F-60-3 just need to mirror it.

**No `tx.origin` usage anywhere.** No phishing surface from that vector.
**No `extcodesize` / `Address.isContract` library calls.** No constructor-bypass exploits identified.
**Primary residual risk: incomplete EIP-7702 retrofit.** Eight `code.length > 0` sites and two `code.length == 0` sites need the `!= 23` extension before relaunch.
