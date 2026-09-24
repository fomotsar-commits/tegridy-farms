# Agent 012 — TegridyLaunchpadV2.sol

**Target:** `contracts/src/TegridyLaunchpadV2.sol` (247 lines)
**Tests:** `contracts/test/TegridyLaunchpadV2.t.sol` (224 lines, 9 tests + 1 fuzz)
**Date:** 2026-04-25

---

## Scope-mismatch note

The hunt list (sale griefing, refund DoS via fallback, vesting cliff math,
contributor cap bypass, sale start/end front-run, finalize() called twice,
unsold burn, owner withdraw before finalization, allowlist signature replay,
oracle dependency, claim before finalize, raised vs target rounding) presumes
a **token-sale launchpad** primitive (deposit ETH, raise toward soft/hard cap,
vest tokens, refund on failure, finalize-then-claim).

`TegridyLaunchpadV2` is a **CREATE2 factory for `TegridyDropV2` NFT clones** —
no deposits, no escrow, no vesting, no soft cap, no finalize, no refunds, no
oracle pricing, no signature allowlist (uses Merkle root passed to clone).
~13 of 13 hunt categories are N/A at this surface; the per-mint sale logic
lives downstream in `TegridyDropV2` (audited separately by other agents).

Findings below cover what is actually in scope: factory wiring, salt
collision, fee-recipient/fee-bps timelock plumbing, and admin surface.

---

## HIGH

*(none)*

The factory has been previously hardened (Slither encode-packed-collision fix
already applied at L138, confirmed by inline comment dated 2026-04-19). No
critical residual risk in this contract.

---

## MEDIUM

### M1 — `dropTemplate` clone implementation is uninitialized but never
locked, so anyone can call `initialize()` directly on the template.
**Loc:** L115 `dropTemplate = address(new TegridyDropV2());`
**Impact:** if `TegridyDropV2.initialize()` lacks an `_disableInitializers()`
or an "already-initialized" guard fired by the factory, an attacker can call
`initialize` on the template itself, take ownership of the master copy, and
front-run reads/views that point to the template (mint-pages, indexers,
explorer probes). Clones via `Clones.cloneDeterministic` get fresh storage so
they're unaffected, **but** the template owner could brick logic that
introspects `dropTemplate` (e.g., off-chain UIs that call `name()` /
`mintPhase()` on it for default values).
**Mitigation in factory:** call `TegridyDropV2(dropTemplate).initialize(...)`
with a sentinel `creator = address(this)` immediately after deployment in
the constructor, OR require `TegridyDropV2._disableInitializers()` in its
constructor. Verify by inspecting `TegridyDropV2.initialize` (out of scope
for this agent — flag for cross-check).
**Severity:** MEDIUM (depends on `TegridyDropV2`'s internal guard).

### M2 — Fee-change timelock has no upper bound on `pendingProtocolFeeBps`
storage time; stale proposals can persist indefinitely.
**Loc:** L202–222
**Impact:** owner proposes `9999` fee → market reacts → owner cancels → owner
proposes again at next opportunity. The `pendingProtocolFeeBps` value lives
forever in storage between propose/execute/cancel. Combined with the lack of
an explicit "expiry" on `_executeAfter[FEE_CHANGE]`, an old proposal that was
never executed and never cancelled can be sniped by the owner months later
without re-announcing. Most timelock libs include an `EXPIRY_PERIOD` (e.g.,
14 days post-`executeAfter`); `TimelockAdmin` should be checked for one.
**Severity:** MEDIUM. **Fix:** add an expiry window in `TimelockAdmin` or
re-validate timestamp inside `executeProtocolFee`.

### M3 — `cancelProtocolFeeRecipient` does not emit an event.
**Loc:** L239–242
**Impact:** L218 `cancelProtocolFee()` emits `ProtocolFeeCancelled`, but its
sibling `cancelProtocolFeeRecipient()` (L239) silently zeros pending state
with no event. Off-chain governance dashboards relying on event indexing will
miss recipient-cancellation entirely, leaving a "pending recipient" displayed
in UI when in reality it has been wiped on-chain.
**Severity:** MEDIUM (governance UX / indexer drift; not exploitable but
audit-grade).
**Fix:** add `event ProtocolFeeRecipientCancelled()` and emit it.

---

## LOW

### L1 — `MAX_PROTOCOL_FEE_BPS = 1000` (10%) is permissive vs industry norm
**Loc:** L56
**Impact:** OpenSea / Foundation / Zora cap protocol take at 2.5–5%. 10% is
high enough that creators may be surprised by post-deploy fee bumps within
the timelock window. Consider documenting this clearly.
**Severity:** LOW.

### L2 — `getCollection(id)` reverts with `CollectionNotFound`, but
`collections[id]` returns a default zero struct for OOB ids if accessed via
the public mapping getter.
**Loc:** L77 (public mapping) vs L188 (guarded view)
**Impact:** off-chain integrators calling the auto-generated `collections(uint256)`
getter (public mapping) bypass the bounds check and get a zero `creator` /
zero `collection` — which their UI may render as "valid empty collection".
**Severity:** LOW. **Fix:** mark mapping `private` or `internal`; only
expose via guarded `getCollection`.

### L3 — Fee-change requires `newFeeBps != protocolFeeBps`, but
fee-recipient proposal does **not** check `newRecipient != protocolFeeRecipient`.
**Loc:** L224
**Impact:** owner can spam `proposeProtocolFeeRecipient(currentRecipient)`
to start a 48h timelock window for no reason, blocking subsequent legitimate
proposals (depends on `TimelockAdmin._propose` behaviour — if it overwrites,
this is just noise; if it rejects pending, it's mild griefing). Symmetry
with `proposeProtocolFee` (which has `FeeUnchanged` revert) is the issue.
**Severity:** LOW.

### L4 — `getAllCollections()` returns the entire `address[]` storage array
unbounded.
**Loc:** L197–199
**Impact:** at scale (10k+ collections) this returndata blows past
RPC-provider response-size limits and breaks indexers. Standard pagination
is missing.
**Severity:** LOW (operational, not security).

### L5 — `pause()` blocks `createCollection` but does **not** block fee
proposals or fee executions.
**Loc:** L244–245 vs L201–242
**Impact:** if the owner pauses to handle an incident, they can still
silently move fees during the pause window. Pausing is meant to freeze the
contract surface; selective pause that excludes admin-econ knobs is unusual.
**Severity:** LOW (acceptable design choice but worth flagging).

---

## INFO

### I1 — Inline comment at L134 already documents a Slither/encode-packed
collision fix dated 2026-04-19. Salt now uses `abi.encode` — verified
collision-resistant. **No action.**

### I2 — `weth` is `immutable` and never read post-construction by the
factory itself; passed only into `TegridyDropV2.initialize`. Could be
removed from factory storage if WETH is hardcoded in `TegridyDropV2`. Low
priority refactor.

### I3 — Constructor does not validate `_owner != address(0)`; relies on
`OwnableNoRenounce(_owner)` to do so. Confirm in base contract. (Cross-check
agent: OwnableNoRenounce auditor.)

### I4 — `CollectionInfo.id` is redundant: it equals the mapping key. Costs
20k SSTORE per collection for no functional value. Refactor: drop `id` from
struct; recompute when needed.

### I5 — Salt includes `allCollections.length`, so two creators racing two
collections of the same `(name, symbol)` will get different salts purely by
sequencing — good for collision avoidance, bad for deterministic predict-then-
deploy flows. Document this in NatSpec.

### I6 — `createCollection` emits **two** events for one logical action
(`CollectionCreated` + `CollectionCreatedV2`). Indexers must dedupe by
(blockNumber, txHash, logIndex) or they will double-count.

---

## Hunt-list mapping (explicit N/A reasons)

| Hunt category                      | Status | Why                                           |
|------------------------------------|--------|-----------------------------------------------|
| Sale griefing (dust to fail cap)   | N/A    | No cap, no sale primitive in factory.         |
| Refund DoS via fallback            | N/A    | No `payable` ingress; factory takes no ETH.   |
| Vesting cliff math errors          | N/A    | No vesting logic.                             |
| Contributor cap bypass via proxy   | N/A    | No contributor model.                         |
| Sale start/end front-run by owner  | PARTIAL| Initial mint phase set in `cfg.initialPhase`; creator (not factory owner) controls timing. Cross-check `TegridyDropV2`. |
| Fee skim race                      | LOW    | Timelocked 48h on factory, see M2.            |
| `finalize()` callable twice        | N/A    | No `finalize`.                                |
| Accidental burn of unsold          | N/A    | No unsold; factory is per-collection.         |
| Owner withdraw before finalization | N/A    | No escrow in factory.                         |
| Allowlist signature replay         | N/A    | Merkle root, not signatures, at factory.      |
| Oracle dependency for tier pricing | N/A    | No oracle.                                    |
| Claim before finalize              | N/A    | No claim.                                     |
| Raised vs target rounding          | N/A    | No raise.                                     |

---

## Test gaps

`TegridyLaunchpadV2.t.sol` is reasonable (10 tests + 1 fuzz). Missing:

1. **No test that `dropTemplate` itself cannot be re-initialized by an
   attacker.** Add: `vm.expectRevert(...); TegridyDropV2(launchpad.dropTemplate()).initialize(stubParams);` — pins M1.
2. **No test for the timelocked fee-change path** (`proposeProtocolFee`,
   warp 48h, `executeProtocolFee`, assert `protocolFeeBps`). Existing tests
   ignore the entire admin surface.
3. **No test for `cancelProtocolFee` / `cancelProtocolFeeRecipient`** — would
   surface M3 (missing event).
4. **No test for `proposeProtocolFee(currentFee)` revert** with `FeeUnchanged`.
5. **No test that the recipient propose path does not check `==current`** —
   would surface L3.
6. **No test for `pause()` blocking `createCollection`** but not blocking
   `proposeProtocolFee` — would document L5.
7. **No test for `getCollection(OOB_id)` revert** — would document L2.
8. **No test that two creators with identical `(name, symbol)` get distinct
   clone addresses** — pins the Slither salt fix at L134 against regression.
9. **No fuzz over `cfg.merkleRoot != 0` + `cfg.initialPhase != ALLOWLIST`**
   — confirms wiring doesn't disable Merkle gate accidentally.
10. **No invariant test** that `getCollectionCount() == allCollections.length`
    after N successful creates and M reverts.

---

## Summary

- **HIGH:** 0
- **MEDIUM:** 3 (template-init, timelock-expiry, missing cancel event)
- **LOW:** 5
- **INFO:** 6
- **Test gaps:** 10

Factory is structurally clean post-2026-04-19 hardening. Residual risks are
admin-surface UX (event symmetry, expiry windows) and a reachable-but-narrow
template-initialization concern that hinges on `TegridyDropV2`'s internal
guards (cross-check required).
