# Audit 011 — TegridyDropV2.sol

**Agent**: 011 / 101
**Target**: `contracts/src/TegridyDropV2.sol` (482 lines)
**Cross-check**: `contracts/test/TegridyDropV2.t.sol` (484 lines)
**Hunt scope**: merkle preimage collision, claim duplication via hash flip, root rotation race, missing nullifier per epoch, signature replay, ECDSA malleability, max-claim-per-address bypass via proxy, claim deadline absent/wrong direction, royalty bypass, _safeMint reentrancy, owner withdraw of un-claimed funds w/o grace, ERC721-enumerable gas grief.

---

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 1     |
| MEDIUM   | 3     |
| LOW      | 4     |
| INFO     | 4     |
| **Total**| **12**|

---

## HIGH

### H-01 — Merkle root rotation race against in-flight allowlist claimers

**Location**: `setMerkleRoot()` (L346–L349) + `mint()` ALLOWLIST branch (L285–L297).

**Issue**: `setMerkleRoot()` is callable by `owner` at any time, with no phase or pause guard. While the mint phase is `ALLOWLIST`, the owner (or a compromised owner key, or an MEV-bot front-running an admin tx) can:
1. Front-run pending allowlist mint txs by rotating the root mid-block to one that excludes them, or
2. Atomically rotate root → mint to attacker-controlled addresses encoded in the new root → rotate back.

Critically, the contract has **no notion of an "epoch" or "snapshot"** — there is one global `merkleRoot`, no per-root nullifier, and no per-epoch `mintedPerWallet`. This means the same wallet can be re-included in a fresh tree and **bypass `maxPerWallet`** if the admin rotates the root after they hit their cap (their `mintedPerWallet[msg.sender]` resets are not even needed — but the admin can't reset them, which means the *opposite* attack: a legitimately-allowlisted user can be excluded from a re-rolled tree without recourse, even after paying gas to prepare a tx).

The H9 "withdrawn → cannot reopen" guard does NOT cover this — root rotation is orthogonal to phase.

**Recommendation**: Either (a) require `mintPhase == CLOSED` to call `setMerkleRoot`, or (b) emit a delay (e.g., `setMerkleRoot` queues a pending root with `block.timestamp + ROOT_DELAY`, and `commitMerkleRoot` activates it), letting in-flight users finalize.

**Test gap**: No test asserts that root rotation during ALLOWLIST is restricted. `test_allowlistMint_acceptsValidProof` covers the happy path only.

---

## MEDIUM

### M-01 — `maxPerWallet` bypass via fresh address per drop (sybil) is unmitigated; partial bypass via re-init impossible but partial bypass via NFT transfer is possible

**Location**: `mint()` L277–L279, `mintedPerWallet` mapping L114.

**Issue**: `mintedPerWallet` is keyed by `msg.sender` only. A user can:
- mint `maxPerWallet` from address A, transfer the NFTs to address B, mint another `maxPerWallet` from A (cap is per-mint count, not per-balance). **Wait — re-checked: `mintedPerWallet` is incremented unconditionally and not decremented on transfer; this is correct.** But:
- mint `maxPerWallet` from address A, mint `maxPerWallet` from address C (a fresh EOA they control). This is the standard sybil bypass and the contract has **no mechanism to prevent it** — no proof-of-personhood, no signature-bound max, no IP/captcha.

For ALLOWLIST phase this is partly mitigated because each leaf is `(drop, minter)` — only listed addresses can mint. But for **PUBLIC and DUTCH_AUCTION** phases there is no per-wallet cap defense beyond the trivially-bypassed `mintedPerWallet`.

**Recommendation**: Acknowledge in NatSpec that `maxPerWallet` is a UX speed bump, not a sybil defense. For genuine fairness on public phases, integrate a signature-based allow flow or an off-chain rate-limit oracle. At minimum, document this clearly so factory creators don't think they're getting strong per-person caps.

**Test gap**: No test explicitly demonstrates the sybil bypass; user expectations may diverge from contract behavior.

---

### M-02 — `_safeMint` invokes `onERC721Received` BEFORE state updates (cross-function reentrancy surface)

**Location**: `mint()` loop L300–L303.

```solidity
for (uint256 i; i < quantity; ++i) {
    _safeMint(msg.sender, startId + i);
}
totalSupply += quantity;
mintedPerWallet[msg.sender] += quantity;
paidPerWallet[msg.sender] += totalCost;
```

`_safeMint` calls the receiver's `onERC721Received` hook for contract receivers. While this function is `nonReentrant`, the **receiver hook fires while `totalSupply`, `mintedPerWallet`, and `paidPerWallet` are still stale**. A receiver implementing `onERC721Received` could:
- Read `totalSupply` and observe an inconsistent view (`balanceOf(msg.sender) > 0` but `totalSupply == 0`),
- Cross-call into other contracts that read this drop's state in the same block.

The `nonReentrant` modifier prevents *re-entering this contract*, but does not prevent a malicious receiver from interacting with **other contracts that read this contract's state** (e.g., a Launchpad mirror, a price oracle that snapshots `totalSupply`, or a trading bot that monitors `mintedPerWallet`).

**Severity**: MEDIUM (state inconsistency window; no direct fund loss because `nonReentrant` blocks re-entry into mint/withdraw/refund).

**Recommendation**: Update `totalSupply`, `mintedPerWallet`, `paidPerWallet` BEFORE the `_safeMint` loop (CEI pattern). The token IDs are deterministic from the prior `totalSupply`.

**Test gap**: No reentrancy test with a malicious `onERC721Received` receiver. Suggested test: deploy a contract that re-reads `drop.totalSupply()` from inside `onERC721Received` and asserts the expected post-state.

---

### M-03 — `pause()` does NOT block `withdraw()` or `cancelSale()` — only `mint()`

**Location**: `withdraw()` L418, `cancelSale()` L448 — neither has `whenNotPaused`.

**Issue**: `Pausable` is intended as a circuit breaker. If a vulnerability is detected mid-sale and `pause()` is called, mints stop — but the owner can still `withdraw()` (after closing) or `cancelSale()` and trigger `refund()` flows. If the bug is in `WETHFallbackLib` or in fund accounting, pause does not give responders time to investigate. Compare to ERC4626 vaults where pause typically blocks deposit AND withdraw to allow safe recovery.

**Recommendation**: Add `whenNotPaused` to `withdraw()` (and consider `refund()` if the WETH fallback path itself is the suspect surface).

**Test gap**: No test exercises pause-then-withdraw or pause-then-refund.

---

## LOW

### L-01 — `setMintPrice(0)` allowed when `mintPhase == CLOSED` lets the owner front-run a phase change to grief minters

**Location**: `setMintPrice()` L351–L355.

```solidity
require(price > 0 || mintPhase == MintPhase.CLOSED, "ZERO_PRICE_ONLY_WHEN_CLOSED");
```

The owner can: (a) set price to 0 while closed, (b) flip to PUBLIC. Within the same tx batch (or just back-to-back), mints with `msg.value == 0` succeed. This is owner-discretionary so not a third-party attack, but a malicious factory operator could publish a "free mint" event, drain free mints to themselves, then raise the price for the public — a rug-style griefing vector. The 2-step ownership doesn't cover the original creator since they ARE the owner.

**Recommendation**: Either disallow `mintPrice == 0` entirely, or emit a `MintPriceChanged(0)` only with a delay (timelock) so users can front-run.

---

### L-02 — `dutchStartPrice <= dutchEndPrice` validated but `dutchStartPrice == dutchEndPrice` means a flat price labeled "auction"

**Location**: `configureDutchAuction()` L388, `initialize()` L210.

`<=` correctly rejects equal prices, but the error name `InvalidDutchAuctionConfig` is generic. The intent (decay strictly required) should be documented in NatSpec. Minor doc/UX issue.

---

### L-03 — `tokenURI` returns empty string when `revealed && _revealURI == ""` (silent post-reveal misconfiguration)

**Location**: `tokenURI()` L239–L247.

```solidity
if (revealed) {
    return bytes(_revealURI).length > 0
        ? string.concat(_revealURI, tokenId.toString())
        : "";
}
return _baseTokenURI;
```

If the owner accidentally calls `reveal("")`, every tokenURI silently returns `""`. Marketplaces will treat the collection as having no metadata. Since `reveal()` is one-shot (`AlreadyRevealed`), the owner has bricked metadata permanently.

**Recommendation**: `require(bytes(revealURI).length > 0, "EMPTY_REVEAL_URI")` in `reveal()`.

---

### L-04 — `acceptOwnership` does not zero `pendingOwner` if msg.sender ≠ pendingOwner — wait, it does. Actual issue: no event emitted on ownership transfer

**Location**: `transferOwnership()` L467–L470, `acceptOwnership()` L472–L476.

No `OwnershipTransferred` events emitted. Block explorers and indexers commonly key off the OZ-standard event. Trivial fix.

---

## INFO

### I-01 — Per-hunt-checklist verification

| Hunt item | Verdict |
|-----------|---------|
| Merkle preimage collision (single-hash leaf) | **MITIGATED** — double-hash leaf at L293 (NEW-L5 fix) |
| Claim duplication via hash flip | N/A — no separate claim() function; mint cap enforced via `mintedPerWallet` |
| Root rotation race against claimers | **OPEN** — see H-01 |
| Missing nullifier per epoch | **PARTIAL** — see H-01 (no epoch concept) |
| Signature replay across drops | N/A — no signature-based mint, only merkle |
| ECDSA malleability | N/A — no ECDSA recovery in this contract |
| max-claim-per-address bypass via proxy | **OPEN sybil-style** — see M-01 |
| Claim deadline absent or wrong-direction | **OPEN** — no end-time enforcement on PUBLIC or ALLOWLIST phases (only DUTCH start gate); a stalled drop can be minted into indefinitely. See I-04 |
| Royalty bypass | **MITIGATED** — `MAX_ROYALTY_BPS = 1000` (NEW-L7 fix) |
| `_safeMint` reentrancy on receive hook | **PARTIAL** — see M-02 (state inconsistency window) |
| Owner withdraw of un-claimed funds w/o grace | **MITIGATED** — withdraw blocked unless CLOSED or sold-out (NEW-L1 fix) |
| ERC721 enumerable gas grief | N/A — base `ERC721` only (no `ERC721Enumerable`); no `tokenOfOwnerByIndex` loop |

### I-02 — Allowlist `proof` parameter ignored in PUBLIC phase

**Location**: `mint()` L264, L285.

The `bytes32[] calldata proof` parameter is ignored when phase ≠ ALLOWLIST. Not a bug, but a minor calldata cost (though `calldata` arrays cost only the offset/length when unused). Worth noting that the function signature commits the contract to this shape forever.

### I-03 — `currentPrice()` returns `mintPrice` for CLOSED/CANCELLED phases

**Location**: `currentPrice()` L314–L319, `_dutchAuctionPrice()` L321–L328.

When `mintPhase == CLOSED` or `CANCELLED`, `currentPrice()` returns `mintPrice` rather than reverting. Front-ends may display stale prices. Cosmetic.

### I-04 — No mint deadline / sale-end timestamp

The contract has no `saleEndTime`. A drop in PUBLIC or ALLOWLIST phase can theoretically be minted into forever (until owner manually closes). Combined with H-01 root rotation, an inattentive owner leaves the door open indefinitely. Suggest adding optional `saleEndTime` field in `InitParams`.

---

## Test Gaps Summary

| Hunt area | Coverage | Gap |
|-----------|----------|-----|
| Root rotation mid-ALLOWLIST | None | No test for `setMerkleRoot` during active ALLOWLIST |
| `_safeMint` malicious receiver | None | No `onERC721Received` reentrancy/state-read test |
| pause-then-withdraw | None | No test asserts paused withdraw behavior |
| Sybil `maxPerWallet` bypass | None | No test demonstrates fresh-EOA bypass |
| `reveal("")` brick scenario | None | No test for empty reveal URI |
| Ownership transfer event emission | None | No event assertion |
| Sale deadline | N/A — feature absent | Should be added |
| `setMintPrice(0)` rug scenario | None | No test asserts a malicious flow |

Recommended additions: 8 new tests covering the gaps above. Highest-value: H-01 root-rotation, M-02 reentrancy receiver, M-03 pause-blocks-withdraw.

---

## Overall

12 findings (1 HIGH / 3 MEDIUM / 4 LOW / 4 INFO). The contract has clearly been hardened (NEW-L1, NEW-L5, NEW-L7, H9, M8 audit comments are all present and well-implemented), but the merkle root mutability + lack of epoch/nullifier (H-01) and the CEI ordering in `mint()` (M-02) remain open. None of the listed items appear exploitable for direct fund theft by a third party, but H-01 and L-01 expose users to malicious-owner griefing that the 2-step ownership and `withdrawn` guard do NOT cover.
