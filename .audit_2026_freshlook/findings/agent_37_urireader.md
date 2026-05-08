# Agent 37 — TegridyTokenURIReader.sol Fresh-Eyes Audit

**Target:** `contracts/src/TegridyTokenURIReader.sol` (~214 lines)
**Lens:** Untrusted external call gas griefing, returndata bombs, try/catch swallow, memory expansion DoS, ERC standard fallbacks (ERC721A/4907/4906/5192/7572), cross-chain canonical URI, caller-supplied collection address.
**Date:** 2026-05-07

---

## Scope-vs-Implementation Mismatch (Pre-finding Note)

The audit-brief lens describes this contract as a "fallback tokenURI resolver for non-standard ERC721s" that takes a caller-supplied collection address. **The actual implementation is fundamentally different**: it is a fixed-purpose SVG/JSON metadata generator hard-wired to a single immutable `ITegridyStaking` instance set at construction. There is no caller-supplied NFT contract parameter, no ERC721A/4907/4906/5192 detection path, no contractURI fallback, no cross-chain bridging, no `IERC721Metadata.tokenURI` proxy call.

Consequently, the entire class of lens items related to "untrusted NFT contract" is materially de-risked: the only external call surface is `staking.ownerOf` and `staking.positions`, both targeting a contract owned by the same protocol team, set by the deployer at construction, and pre-audited heavily in this same project. None of the returndata-bomb / griefing vectors that apply to a generic resolver apply here.

The findings below are therefore drawn from the actual implementation and adjacent risks. Many lens items are flagged as **N/A** with reasoning, not omitted silently.

---

## F-37-1 [INFO] — `staking` is `address`-typed at constructor; no zero-address check

**Severity:** INFO
**Location:** `TegridyTokenURIReader.sol:37-39`

```solidity
constructor(address _staking) {
    staking = ITegridyStaking(_staking);
}
```

There is no `require(_staking != address(0), ...)` guard. If the deployer passes `address(0)`, every call to `tokenURI(...)` reverts in the `try staking.ownerOf(tokenId)` step (no code at zero, the call falls into the `catch` branch and surfaces `"NONEXISTENT"`). The reader is then perma-bricked.

**Impact:** Operational — a misdeployment produces a soft-bricked reader rather than a clear constructor-revert. Indexers will see every `tokenURI` resolve to `"NONEXISTENT"` and may incorrectly assume token enumeration. Not exploitable.

**Recommendation:** Add `require(_staking != address(0), "ZERO_STAKING");` in the constructor. Cheap, removes a footgun.

---

## F-37-2 [INFO] — `staking` is immutable; no migration path for staking-contract upgrade

**Severity:** INFO
**Location:** `TegridyTokenURIReader.sol:35`

```solidity
ITegridyStaking public immutable staking;
```

`staking` is declared `immutable`. If the protocol ever migrates to a new staking contract (e.g., V2 with extended `Position` struct), the reader cannot be re-pointed and must be redeployed in lockstep with the staking contract. The new staking contract must then update its `tokenURI` resolver to point at the new reader.

This is a **deliberate design choice** consistent with the comment at line 50-57 (V2-URI-01) — the audit history acknowledges that any future staking-contract change requires a coordinated redeploy. Flagged here only as a deployment-runbook note: the reader is non-upgradeable on purpose.

**Impact:** None at the contract level. Operational risk only — runbook hazard.

---

## F-37-3 [LOW] — `lockDuration / 86400` truncation in JSON `display_type:"number"` attribute

**Severity:** LOW (cosmetic / indexer-correctness)
**Location:** `TegridyTokenURIReader.sol:207`

```solidity
'{"trait_type":"Lock Duration","display_type":"number","value":', uint256(lockDuration / 86400).toString(), '},',
```

The lock duration is stored as `uint32` seconds and rendered to JSON as **integer days** via floor-division by 86400. Any sub-day component is silently truncated.

For example:
- `lockDuration = 86399` (≈1 day minus 1 second) → `value: 0`
- `lockDuration = 90000` (1d 1h) → `value: 1` (with the `1h` component lost)
- `lockDuration = 7 * 86400 + 100` (1 week + 100s) → `value: 7`

For OpenSea-style numeric trait filtering ("show me positions locked > 30 days") the truncation can produce off-by-one filtering. The SVG-side text (`_formatDays` line 94-97) has the same truncation but only renders text like "30d" so it's less semantically loaded than the numeric trait.

**Mitigation upstream:** The staking contract appears to enforce `lockDuration` as multiples of full days (per project conventions referenced in audit comments), so in practice this floor never matters. **If that invariant is ever relaxed**, this trait silently lies to indexers.

**Recommendation:** If staking enforces day-aligned lock durations, document that invariant inline at line 207. Otherwise, surface fractional days (e.g., render duration in seconds and use `display_type:"number"` with `unit` metadata, or refuse non-aligned values upstream).

---

## F-37-4 [LOW] — `_formatAmount` 2-decimal truncation can mis-display very small amounts

**Severity:** LOW (cosmetic)
**Location:** `TegridyTokenURIReader.sol:86-92`

```solidity
function _formatAmount(uint256 amount) internal pure returns (string memory) {
    uint256 whole = amount / 1e18;
    uint256 frac = (amount % 1e18) / 1e16; // 2 decimal places
    if (frac == 0) return whole.toString();
    ...
}
```

A position with `amount = 9.999e15` wei (i.e., `0.009999 TOWELI`) renders as **"0"** because both `whole` and `frac` truncate to zero. The SVG and JSON both display "0 TOWELI" while the underlying staked amount is non-zero.

In the staking contract, minimum stake amounts are likely enforced (typical pattern), so amounts below 0.01 TOWELI never reach the reader in practice. **However**, if an attacker can craft a position with `amount < 1e16` (e.g., via a precision-loss path in the staking math), the position renders as "0 TOWELI" while still having a real boostedAmount and reward share. This is a minor display-vs-reality desync.

The `amount <= 1e9 ether` upper-bound check at line 77 protects against the upper end; there is no lower-bound check.

**Recommendation:** Either (a) add a lower-bound minimum-stake invariant at line 77 to assert non-zero display, or (b) render "<0.01" for the small-but-nonzero case to avoid the "0" lie. Pure cosmetic, not exploitable.

---

## F-37-5 [INFO] — JSON `description` field interpolates `_boostDisplay` and `_formatAmount` inline without escaping

**Severity:** INFO (defense-in-depth)
**Location:** `TegridyTokenURIReader.sol:200-212`

```solidity
'","description":"Tegridy Farms staking position. ', _formatAmount(amount), ' TOWELI staked at ', _boostDisplay(boostBps), ' boost.',
```

Comment at lines 134-140 explicitly notes that `_jsonEscape` was **removed** because every interpolated field is "numeric / constant." The audit-fix comment correctly identifies that:
1. `_formatAmount` returns digits + dot only (`whole.toString()` + `"."` + `fracStr`).
2. `_boostDisplay` returns digits + dot + `"x"`.
3. `tokenId.toString()`, `_formatDays`, status enum strings — all controlled.
4. `autoMaxLock ? 'Yes' : 'No'`, `hasJbacBoost ? 'Yes' : 'No'` — boolean-derived constants.

**The inventory is currently complete; no JSON-injection surface exists today.** The risk is only that a future contributor adds an attacker-influenced string field without re-introducing the escape helper. The inline comment captures that pattern-of-record explicitly.

The `_lockStatus` strings (`"Auto-Max"`, `"Flexible"`, `"Expired"`, `"Active"`) contain no JSON-special characters — verified safe.

**Findings:** No actionable vuln. Logged here only as an attestation that the field-by-field walk found no break in the no-attacker-input invariant.

---

## F-37-6 [N/A — out of scope] — Returndata bomb / gas griefing via untrusted NFT

**Lens item:** Returndata-bomb DoS, gas griefing through hostile ERC721 implementation.

**Status:** N/A. The reader does not call any caller-supplied or untrusted NFT contract. Both `staking.ownerOf(tokenId)` (line 58) and `staking.positions(tokenId)` (line 68) target the immutable, in-protocol `TegridyStaking` contract, which is in-scope of the same audit pass and which has known-bounded returndata sizes (a single `address` and a fixed 11-field struct).

If a future variant of this contract is built that **does** take a caller-supplied collection address, the standard mitigation (ExcessivelySafeCall.staticcall with returndata caps) would be required.

---

## F-37-7 [N/A — out of scope] — Reentrancy via NFT contract during URI read

**Lens item:** Reentrancy via NFT contract during URI read.

**Status:** N/A. `tokenURI` is a `view` function; the reader is invoked from off-chain RPC calls or other `view` contexts. The downstream `staking.ownerOf` and `staking.positions` are also `view`. No state mutation, no value transfer, no callbacks. Reentrancy not applicable.

The lens-flagged "low impact but check" note is correct — there is no impact because there is no state to mutate.

---

## F-37-8 [N/A — out of scope] — Try/catch swallow returns

**Lens item:** Try/catch swallow returns.

**Status:** Reviewed and clear. The single try/catch at line 58-62 wraps `staking.ownerOf(tokenId)` and:
- On success: requires `holder != address(0)` and continues.
- On revert: surfaces a typed `"NONEXISTENT"` revert.

The intent is documented (DEEP-URI-02 audit fix) — the goal is to convert any upstream revert into a uniform `NONEXISTENT` typed error, which is the correct behavior. The catch does **not** silently return a default-looking JSON; it propagates a revert. This is the safe pattern. No issue.

---

## F-37-9 [N/A — out of scope] — Memory expansion DoS via huge string return

**Lens item:** Memory expansion DoS via huge string return.

**Status:** N/A in the call chain. The only external returns are an `address` (32 bytes) and an 11-field tuple of small fixed types. Internal string concatenation is bounded by the SVG template (a few hundred bytes of constants + small numeric formats), with `boostBps` bounded by `boostBps <= 50000` (line 78) and `amount <= 1e9 ether` (line 77), capping the digit-count of any rendered number. Memory usage is linear and bounded.

A `view`-call gas limit at the RPC layer (typical 50M default; OpenSea uses much smaller) would catch a runaway case anyway. Not exploitable.

---

## F-37-10 [N/A — out of scope] — Use as a building-block from a payable view (attacker-NFT grief)

**Lens item:** If a reader is called from a payable view, attacker NFT can grief.

**Status:** N/A. There is no payable function in this contract; `tokenURI` is `view`. Even if a caller were to wrap this reader in a payable function, the attacker has no controlled NFT in the call path — the staking contract is fixed at construction.

---

## F-37-11 [N/A — out of scope] — Fallback to ERC721A / ERC4907 / ERC4906 / ERC5192

**Lens item:** Standard-detection fallback paths for ERC721A / 4907 / 4906 / 5192.

**Status:** N/A. The reader never attempts to detect or call any of these standards. It speaks only the `ITegridyStaking` interface. The base staking NFT (per the consumer-side `tokenURI` plumbing implied by audit comments referencing OZ ERC721) appears to be vanilla OpenZeppelin ERC721 with this reader as the metadata source, so the lens-listed standards are simply not in the picture.

---

## F-37-12 [N/A — out of scope] — contractURI fallback (ERC-7572)

**Lens item:** ERC-7572 contractURI fallback.

**Status:** N/A. This contract has no `contractURI()` function and is not designed to render collection-level metadata. If the protocol wants ERC-7572 contract-level metadata, that lives elsewhere (likely on the staking contract itself).

---

## F-37-13 [N/A — out of scope] — Cross-chain canonical URI bridging

**Lens item:** Cross-chain canonical URI bridging.

**Status:** N/A. The reader produces a self-contained `data:application/json;base64,...` URI on-chain with the SVG inlined as `data:image/svg+xml;base64,...`. There is no IPFS gateway, Arweave reference, HTTP host, or cross-chain canonical pointer. The output is fully on-chain and identical on every chain the contract is deployed to (modulo the embedded `tokenId` and the staking-contract data).

This is **good defense-in-depth**: there is no off-chain or cross-chain dependency for the URI to resolve.

---

## F-37-14 [N/A — out of scope] — Caller-supplied collection address (proxy / impostor)

**Lens item:** Anyone can read any contract's URI even if it's a proxy.

**Status:** N/A. There is no caller-supplied collection address. `staking` is fixed and immutable.

---

## F-37-15 [INFO] — `_lockStatus` is `view` (not `pure`) due to `block.timestamp` read

**Severity:** INFO
**Location:** `TegridyTokenURIReader.sol:127-132, 142, 195, 199`

```solidity
function _lockStatus(uint64 lockEnd, bool autoMaxLock) internal view returns (string memory) {
    if (autoMaxLock) return "Auto-Max";
    if (lockEnd == 0) return "Flexible";
    if (block.timestamp >= lockEnd) return "Expired";
    return "Active";
}
```

The function reads `block.timestamp`, which makes both `_buildSVG` and `_buildJSON` (and therefore `tokenURI`) timestamp-dependent. The audit history (H22 comment lines 107-126) acknowledges this and explicitly designs the function to flip **at most once per position lifecycle** — the `Active → Expired` transition at the `lockEnd` boundary.

**The lifecycle invariant is currently airtight**:
- `Auto-Max` is set whenever `autoMaxLock == true`. If `autoMaxLock` toggles, the URI changes — but `autoMaxLock` is a position-state flag presumably set by the user, so this is a user-driven transition (a discrete event, not a continuous timestamp leak).
- `Flexible` ↔ `Active`/`Expired` transition occurs if the user converts a flexible position into a locked one (lockEnd goes from 0 to nonzero) — again, a discrete user event.
- `Active → Expired` flips exactly once per position at the `lockEnd` block — a single hash mutation.

**Caveat:** If a future feature allows `autoMaxLock` to be toggled multiple times, **or** allows lock-duration extension (which would update `lockEnd` to a new future timestamp, potentially "un-Expiring" a previously-Expired position), the single-flip invariant breaks and indexers will see continuous URI mutation.

**Recommendation:** The H22/DEEP-URI-03 comments capture this clearly. No action required as long as the staking contract preserves the invariants. Future contributors must be aware.

---

## F-37-16 [LOW] — `tokenURI` reverts with bare-string `"NONEXISTENT"` instead of typed custom error

**Severity:** LOW (gas + indexer-friendliness)
**Location:** `TegridyTokenURIReader.sol:59, 61, 77, 78`

```solidity
require(holder != address(0), "NONEXISTENT");
revert("NONEXISTENT");
require(amount <= 1e9 ether, "AMOUNT_OOB");
require(boostBps <= 50000, "BOOST_OOB");
```

These are bare-string `require`/`revert` calls. Solidity 0.8.4+ supports custom errors which:
1. Save ~50 gas per revert path (4-byte selector vs string-encoded reason).
2. Are easier for indexers/dApps to decode programmatically.
3. Allow embedding the offending value (e.g., `error NONEXISTENT(uint256 tokenId);`).

**Impact:** Pure gas/UX optimization. Not security-relevant. The EIP-721 spec only requires that `tokenURI` "throws" for non-existent tokens; custom errors satisfy this just as well as string reverts.

**Recommendation:** Convert to:
```solidity
error NONEXISTENT(uint256 tokenId);
error AMOUNT_OOB(uint256 amount);
error BOOST_OOB(uint16 boostBps);
```
Optional cleanup, no security impact.

---

## F-37-17 [LOW] — `staking.positions(tokenId)` returns 11 fields; reader discards 4 mid-tuple

**Severity:** LOW (defense-in-depth)
**Location:** `TegridyTokenURIReader.sol:64-68`

```solidity
(
    uint256 amount, , ,
    uint64 lockEnd, uint16 boostBps, uint32 lockDuration,
    bool autoMaxLock, bool hasJbacBoost, , ,
) = staking.positions(tokenId);
```

The reader destructures 11 return values, picks 7 (`amount`, `lockEnd`, `boostBps`, `lockDuration`, `autoMaxLock`, `hasJbacBoost`, and a `stakeTimestamp` slot via the trailing `,`), and silently drops `boostedAmount`, `rewardDebt`, `stakeTimestamp`, `jbacTokenId`, and `jbacDeposited`.

The comment at line 19 (H-1 fix) notes that the struct was **extended** to add `jbacTokenId` and `jbacDeposited` at the tail. **If a future migration extends the struct further** (e.g., adds a 12th field at the tail), this destructuring continues to compile and silently truncates — the new field is never seen by the reader.

This is **the intended and safe behavior** for backward-compat extensions: the reader will keep working without code changes if new fields are appended. **However**, if a future migration **inserts a field in the middle** of the tuple (rather than appending), the positional destructuring breaks silently — `boostBps` could be reading what was supposed to be `lockEnd`, etc.

The struct interface is owner-controlled and the audit history (H-1) shows the team is following the safe append-only pattern.

**Recommendation:** Inline a comment near line 64 documenting the **append-only** invariant on the `positions(...)` return tuple. It's the kind of constraint that's easy to forget during a future refactor.

---

## F-37-18 [INFO] — `_buildJSON` calls `_formatAmount` and `_boostDisplay` twice each per call

**Severity:** INFO (gas)
**Location:** `TegridyTokenURIReader.sol:201-206`

```solidity
'","description":"Tegridy Farms staking position. ', _formatAmount(amount), ' TOWELI staked at ', _boostDisplay(boostBps), ' boost.',
...
'{"trait_type":"Staked Amount","value":"', _formatAmount(amount), ' TOWELI"},',
'{"trait_type":"Boost","value":"', _boostDisplay(boostBps), '"},',
```

`_formatAmount(amount)` is called once in `_buildSVG` (via `amountStr` cached at line 146) and twice more directly in `_buildJSON` (lines 202, 205). Same for `_boostDisplay` (lines 147, 202, 206). The `_buildSVG` caching is correct; the JSON builder doesn't reuse the SVG-built strings even though they're available.

**Impact:** Minor gas waste in a `view` function. Practically irrelevant for off-chain RPC reads, but if `tokenURI` is ever consumed on-chain (e.g., a future protocol that reads metadata mid-transaction), the redundant string-building pads gas.

**Recommendation:** Cache `amountStr` and `boostStr` at the `tokenURI` level (or pass them through `_buildJSON`) to avoid the duplicate work. Cosmetic.

---

## F-37-19 [INFO] — No reentrancy guard on `tokenURI` (correctly, but worth noting)

**Severity:** INFO
**Location:** `TegridyTokenURIReader.sol:41`

`tokenURI` is `external view` and reads-only; there is no `nonReentrant` modifier, which is the correct call. Re-entry into a `view` function does not threaten state. Logged for completeness against the lens item.

---

## Summary

| Finding | Severity | Topic |
|---------|----------|-------|
| F-37-1  | INFO | Constructor accepts zero-address `_staking` (soft-bricks reader) |
| F-37-2  | INFO | `staking` immutable — non-upgradeable by design (runbook hazard) |
| F-37-3  | LOW  | `lockDuration / 86400` floor-truncation in numeric JSON trait |
| F-37-4  | LOW  | `_formatAmount` truncates non-zero amounts < 0.01 TOWELI to "0" |
| F-37-5  | INFO | JSON-injection surface absent today, defense-in-depth note |
| F-37-6  | N/A  | Returndata bomb / griefing — no caller-supplied NFT |
| F-37-7  | N/A  | Reentrancy — `view`-only, no state |
| F-37-8  | N/A  | Try/catch correct (`NONEXISTENT` propagation) |
| F-37-9  | N/A  | Memory DoS — bounded inputs, bounded output |
| F-37-10 | N/A  | Payable-view griefing — no payable, no untrusted NFT |
| F-37-11 | N/A  | ERC721A/4907/4906/5192 fallback — out of scope |
| F-37-12 | N/A  | ERC-7572 contractURI fallback — out of scope |
| F-37-13 | N/A  | Cross-chain canonical URI — fully on-chain output |
| F-37-14 | N/A  | Caller-supplied collection — none |
| F-37-15 | INFO | `_lockStatus` timestamp dependence — invariant currently airtight |
| F-37-16 | LOW  | Bare-string reverts vs custom errors |
| F-37-17 | LOW  | `positions(...)` append-only invariant unwritten |
| F-37-18 | INFO | `_formatAmount` / `_boostDisplay` called twice in JSON |
| F-37-19 | INFO | No reentrancy guard on `tokenURI` (correct, noted) |

**No HIGH or MEDIUM findings.** Five LOW/INFO items, none security-critical. The contract is small, single-purpose, and well-defended for what it actually does. The lens-described risk model (untrusted caller-supplied NFT, returndata bombs, multi-standard fallback) **does not apply to this implementation**, which is a fixed metadata generator for a single in-protocol staking contract.

The strongest defense in this design is what is **not** there: no caller-supplied address, no off-chain URI dependency, no IPFS/HTTP host, no proxy detection logic, no fallback to other standards. The attack surface is correspondingly tiny.

## Notes / Dead-ends

- **Checked:** Whether `Base64.encode` from OZ has any returndata-bomb behavior. It is pure-Solidity and bounded by input length; the input is bounded by the SVG/JSON template + small numeric formats. Safe.
- **Checked:** Whether `Strings.toString` can be passed adversarial input. All call sites pass `uint256` / `address` types — no attacker-controlled string surface.
- **Checked:** Whether `string.concat` has any reentrancy or memory expansion footgun in 0.8.26. It compiles to a deterministic memory-allocation sequence; bounded by sum of input lengths. No issue.
- **Checked:** Whether the contract can be a victim of a **storage collision** if proxied. It uses no proxy pattern; `staking` is `immutable`, stored in code rather than storage. No collision risk.
- **Dead-end:** Looked for a `setStaking` / upgrade hook. None exists, by design.
- **Dead-end:** Looked for any payable / value-transfer code paths. None exist.
- **Dead-end:** Looked for any `delegatecall` / `call` / `staticcall` to caller-controlled targets. None exist.
- **Dead-end:** Checked for ERC165 `supportsInterface` on `staking` before calling. None present, but unnecessary — the staking contract is fixed and known to implement the consumed interface.
- **Cross-cluster note:** F-37-1 (zero-address constructor) and F-37-17 (struct-extension append-only invariant) are the two items that would benefit most from a one-line code edit; everything else is informational or N/A.
