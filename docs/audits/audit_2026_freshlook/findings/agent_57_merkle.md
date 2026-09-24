# Agent 57 — Merkle Tree Exploit Lens

**Scope.** Fresh-eyes hunt for second-preimage, leaf-as-node, multi-leaf reuse, sorted-pair
mismatch, ABI-encoding ambiguity, missing chain/contract binding, and proof-cap DoS across
every `MerkleProof` / `merkle` / `keccak256(abi.encode*)` / `bytes32 root` site under
`contracts/src/`.

**Surface mapped.**
- `MerkleProof.verify(...)` is invoked at **exactly one** site:
  `contracts/src/TegridyDropV2.sol:541` (allowlist mint).
- `TegridyLaunchpadV2.sol` only **stores** `cfg.merkleRoot` and forwards it into the
  cloned drop's `initialize()` (`:233`, `:260`); it never verifies a proof.
- The remaining `keccak256(abi.encode*)` matches in `TegridyFactory`, `TegridyFeeHook`,
  `TegridyTWAP`, `CommunityGrants`, `ReferralSplitter`, `VoteIncentives` are **timelock /
  mapping storage keys**, not merkle leaves. Out of lens scope; no proof verification path.
- OpenZeppelin Contracts v5.6.0 (cancun) is in tree at
  `contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol`.
  Verification path uses `Hashes.commutativeKeccak256` — sorted-pair (commutative)
  internal-node hashing.

---

## Findings

### F-57-1 — `address(this)` binds leaf to drop, but **chain-id is not in the leaf**
**File:line.** `contracts/src/TegridyDropV2.sol:538-541`

**Verification.**
```solidity
bytes32 leaf = keccak256(
    bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount)))
);
if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();
```

**Manipulation.** Cross-chain replay would require an attacker to deploy a **clone with
the same address** on a second chain that uses the same merkle root.

**Why it does not exploit.** The factory salt at
`TegridyLaunchpadV2.sol:213-215` already includes `block.chainid`:

```solidity
bytes32 salt = keccak256(
    abi.encode(block.chainid, address(this), msg.sender, allCollections.length, cfg.name, cfg.symbol)
);
collection = Clones.cloneDeterministic(dropTemplate, salt);
```

`Clones.cloneDeterministic` derives the runtime address from `(implementation, salt,
factory)`, and the factory's address is itself chain-dependent. `block.chainid` is in the
salt, so two chains produce different clone addresses, and the leaf binding to
`address(this)` reduces to a chain binding.

**Notes / dead-end.** A creator who **side-loads** a drop (deploys a `TegridyDropV2` clone
outside the factory) could pick the implementation address freely, but they own the drop
and choose the root. No outside-attacker path. **Not an exploit.**

**Status.** ACK / NOT-EXPLOITABLE.

---

### F-57-2 — Second-preimage (leaf-as-internal-node) attack — neutralised by double-hash
**File:line.** `contracts/src/TegridyDropV2.sol:538-541`,
`contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol:16-21`

**Verification.** OZ MerkleProof header explicitly warns:
> "You should avoid using leaf values that are 64 bytes long prior to hashing... the
> concatenation of a sorted pair of internal nodes in the Merkle tree could be
> reinterpreted as a leaf value."

The Drop builds the leaf as:
```solidity
keccak256( bytes.concat( keccak256( abi.encode(address(this), msg.sender, allowedAmount) ) ) )
```

That is the canonical OZ/`@openzeppelin/merkle-tree` **double-hash** form. The inner
`keccak256` produces a 32-byte digest; `bytes.concat` wraps it; the outer `keccak256`
hashes those 32 bytes. The pre-image to the outer hash is **always 32 bytes**, never 64,
so it can never collide with an internal-node concatenation `(left || right)` (which is
64 bytes in the sorted-pair scheme).

**Manipulation tried.** Treating an internal node as a forged leaf — fails because
`keccak256(internalNode_64B)` ≠ `keccak256(bytes.concat(keccak256(...32B...)))`.

**Status.** Properly mitigated. The defense matches OZ's `StandardMerkleTree` JS library
out of the box.

---

### F-57-3 — `abi.encode` (not `encodePacked`) for the leaf preimage
**File:line.** `contracts/src/TegridyDropV2.sol:539`

**Verification.** Three params: `(address, address, uint256)`. All **fixed-width**, so
even `encodePacked` would not produce dynamic-type ambiguity. The contract uses
`abi.encode` regardless — strictly safer, length-prefixed, zero collision class even if
the schema is later widened to include dynamic types.

**Manipulation.** `encodePacked` collisions across `(string, string)` pairs only matter
when adjacent **dynamic** fields collapse — none here. **No collision class.**

**Status.** Defensive choice; future-proof.

---

### F-57-4 — Sorted-pair (commutative) hashing — client/contract agreement
**File:line.** `contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol:60`,
`contracts/src/TegridyDropV2.sol:541`

**Verification.** OZ uses `Hashes.commutativeKeccak256` — sorted-pair internal nodes. The
intended off-chain tree builder is `@openzeppelin/merkle-tree` (`StandardMerkleTree`)
which uses the **same** sorted-pair convention. As long as the operator generates trees
with the OZ JS library (the standard for this leaf format), there is no client/contract
mismatch.

**Manipulation.** A creator who builds an unsorted-pair tree off-chain by mistake will
have **all** proofs revert. Deterministic and observable; no fund-loss path. The only
risk is operational, and the natspec at `:535` explicitly pins the leaf format the
operator must mirror.

**Status.** ACK / OPERATIONAL ONLY.

---

### F-57-5 — Per-user claim tracking: leaf reuse after partial claim
**File:line.** `contracts/src/TegridyDropV2.sol:530-549`

**Verification.**
```solidity
if (allowlistClaimed[msg.sender] + quantity > allowedAmount) {
    revert AllowlistAllocationExceeded();
}
allowlistClaimed[msg.sender] += quantity;
```

`allowlistClaimed[msg.sender]` accumulates against the **leaf-bound** `allowedAmount`
(which is part of the leaf preimage), so the same proof can be re-presented across
multiple txs but the running sum is hard-capped by the leaf cap.

**Manipulation.**
- Re-present the proof N times with `quantity=1` each — **caps at `allowedAmount`**.
- Try to swap the `allowedAmount` parameter to a larger value while reusing the proof —
  fails: `allowedAmount` is in the leaf preimage, so changing it changes the leaf and
  the proof no longer reconstructs the root. **Verified by inspection.**
- `setMaxPerWallet` bump while ALLOWLIST is active — gated to CLOSED at `:812`, so the
  cap can't be reopened mid-mint. Even if it could, `allowlistClaimed` is **independent
  of `mintedPerWallet`** and would still bound at the leaf value.

**Status.** Defenses compose correctly (MICROSCOPE C1 fix, lines 531-548).

---

### F-57-6 — Proof-length cap (calldata DoS / griefing)
**File:line.** `contracts/src/TegridyDropV2.sol:496` (signature),
`:541` (verify call)

**Verification.** The `mint()` signature accepts `bytes32[] calldata proof` with no
length check. `MerkleProof.processProof` is `O(proof.length)` and runs entirely in
`calldata→memory` keccak256 hops, which are cheap on a per-step basis. The block gas
limit caps real-world abuse. There is no `MAX_PROOF_LENGTH` constant.

**Manipulation.**
- An attacker pads `proof` with garbage. The first non-matching sibling derails the
  rolling `computedHash`; the final compare against `merkleRoot` fails, the call reverts.
  Attacker pays the gas, no state mutation. **Self-DoS only.**
- Could a user **brick their own claim** by submitting a 100k-element proof? Only if they
  pay the gas. The drop is unaffected; `nonReentrant` is not even reached for that wallet
  past the revert.
- A creator publishing a tree of depth >256 is operationally absurd (2^256 leaves).
  Realistic depths are <30 even for million-claimer drops.

**Status.** No griefing primitive. A defensive `proof.length <= 32` guard would be belt-
and-braces but is not a finding under the lens. **Notes / dead-end.**

---

### F-57-7 — Multi-claim batching / proof reuse across leaves
**File:line.** `contracts/src/TegridyDropV2.sol:496-549`

**Verification.** `mint()` takes one `proof` for `msg.sender`'s leaf only. There is **no
multi-leaf batch path**, no `claimMany(addresses[], proofs[][])`, no merkle multiproof.
Each call validates exactly one leaf bound to `msg.sender`.

**Manipulation.**
- Reuse another wallet's leaf? Fails — leaf binds `msg.sender`. Forging a tx where
  `msg.sender == victim` requires the victim's private key.
- Sending the proof from a different `msg.sender` and trying to swap who consumes the
  allocation? Fails identically — the `address(this), msg.sender, allowedAmount` triple
  in the preimage is rebuilt from `address(this)` and `msg.sender` server-side; an
  attacker has no input lever on it other than `allowedAmount`, which is also leaf-bound.

**Status.** No multi-claim attack surface.

---

### F-57-8 — Root rotation / mid-mint exclusion
**File:line.** `contracts/src/TegridyDropV2.sol:695-754`, `:651-688`

**Verification.** Direct `setMerkleRoot` is permanently disabled (`revert
"Use proposeMerkleRoot()"`). Rotations go through propose / execute / cancel with a 24h
delay, **gated to CLOSED / CANCELLED / paused** phases at both propose and execute time.
Phase change is frozen while a rotation is pending (`MerkleRotationPending` revert at
`:666`). Execute also requires `expectedRoot` and `expectedExecuteAfter` value-binding
(V3-DROP-02 sibling fixes) so a re-propose race within the timelock window can't smuggle a
different root under the same multisig approval.

**Manipulation tried.**
- Owner front-runs a pending claimer with a hostile rotation — blocked by the active-
  phase rotation guard at `_canRotateMerkleRoot()` (`:705-709`).
- Owner queues rotation, then flips ALLOWLIST mid-window — blocked by
  `MerkleRotationPending` at `setMintPhase` (`:666`).
- Owner queues `bytes32(0)` to brick the drop — blocked at execute by `:739`.

**Status.** Layered defense; matches Compound Timelock pattern.

---

## Summary

**The single merkle-verify site** in the entire protocol (`TegridyDropV2.mint`,
allowlist phase) is **defensive across every lens checked**:

| # | Lens | Status |
|---|------|--------|
| 1 | All claim params in leaf (msg.sender, address(this), allowedAmount) | OK |
| 2 | Leaf-as-internal-node second-preimage | Defeated by OZ double-hash form |
| 3 | encodePacked dynamic-type ambiguity | N/A — fixed-width fields, abi.encode used anyway |
| 4 | Sorted-pair client/contract agreement | OZ commutativeKeccak256 + OZ JS lib |
| 5 | Per-user claim tracking, leaf-bound cap | `allowlistClaimed` against leaf `allowedAmount` |
| 6 | Proof length cap | No cap; only self-DoS, attacker pays gas |
| 7 | Multi-claim batch / cross-leaf reuse | No batch path; leaf binds `msg.sender` |
| 8 | Root rotation mid-mint exclusion | Timelocked, phase-gated, value-bound |
| - | Chain-id binding | Implicit via `address(this)` + factory salt with `block.chainid` |

**No exploitable findings under the merkle lens. No new high/medium/low.**

The implementation tracks the canonical OZ `StandardMerkleTree` model end-to-end. The
double-hashed leaf format and sorted-pair commutative internal hashing are the same shape
the OZ JS library produces, so off-chain tree generation is straightforward and the
contract's accepted form has zero schema drift.

**Dead ends pursued.** Cross-chain replay (closed by chainid in factory salt → distinct
clone addresses), 64-byte leaf collision (closed by double hash), abi.encodePacked
collision (no dynamic types), proof-length DoS (only self-DoS), multi-claim reuse (no
batch entry point), `setMerkleRoot` rotation (deprecated, replaced by timelocked
propose/execute).

**Out-of-scope confirms.** `VoteIncentives.computeCommitHash` (1480-1488) is a
commit-reveal hash, not a merkle leaf; it includes `block.chainid` and `address(this)`
for replay isolation. Storage-key derivations across `TegridyFactory`, `TegridyFeeHook`,
`TegridyTWAP`, `CommunityGrants`, `ReferralSplitter` use `keccak256(abi.encode*)` to
namespace mappings — not merkle proofs. No verification path; not in scope.
