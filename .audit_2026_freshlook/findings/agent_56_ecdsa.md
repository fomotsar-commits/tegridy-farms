# Agent 56/100 — ECDSA Signature Malleability / EIP-2098 / Signer-Recovery Audit

**Lens:** ECDSA signature malleability, EIP-2098 short signatures, ERC-1271 SCW fallbacks, signature length validation, domain-separator scoping, raw `ecrecover` vs `ECDSA.tryRecover`, signature-replay across protocol functions, Solady SignatureCheckerLib usage.

**Working dir:** `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms`
**Targets scoped:** `contracts/src/*.sol` (29 contracts).

---

## Inventory of signature surfaces

The protocol's only ECDSA / EIP-712 / ERC-1271 surface is:

| File | Lines | Surface |
|------|-------|---------|
| `contracts/src/Toweli.sol` | 149-230 | `permit(owner, spender, value, deadline, v, r, s)` — EIP-2612 override using OZ `ECDSA.tryRecover` (EOA path) + `SignatureChecker.isValidSignatureNow` (SCW path). |

**Confirmed absent (verified by grep across all 29 src files):**

- `ecrecover` precompile is **never** called directly (no raw assembly recovery anywhere).
- `tryRecover` is only invoked from `Toweli.permit`.
- `SignatureChecker` / `EIP712` / `_hashTypedDataV4` / `DOMAIN_SEPARATOR` are only used in `Toweli.sol`.
- No 64-byte EIP-2098 short-signature parsing path.
- Solady is imported in `TegridyStaking.sol` only for `ERC721` — **not** `SignatureCheckerLib`.
- No bespoke meta-tx / claim-voucher / off-chain order flows. (Merkle proofs in `TegridyDropV2.sol` and `TegridyLaunchpadV2.sol` are hash-tree leaf inclusion only — not ECDSA-signed.)
- `permit()` is never called by any protocol contract on user tokens (no `IERC20Permit.permit(...)` callsites in `contracts/src/`); the surface is purely user-facing on Toweli.

So this audit reduces to a deep review of `Toweli.permit` (lines 149-230) plus its OZ dependency chain.

---

## Findings

### F-56-1 — INFO — Toweli `permit` EOA path: malleability defeated by OZ ECDSA.tryRecover lower-half-s gate

**File:** `contracts/src/Toweli.sol:195-219`
**Severity:** INFO (no exploit; documented as confirmation that the malleability vector is closed).

**Path:**
```
Toweli.permit (line 149)
  → owner.code.length == 0 branch (line 195)
    → ECDSA.tryRecover(hash, v, r, s) [tuple overload] (line 197)
       → OZ ECDSA.sol:170-196 enforces: uint256(s) > 0x7FFF...A0 → InvalidSignatureS
```

**Verification:** OZ v5.6 `ECDSA.tryRecover((bytes32 hash, uint8 v, bytes32 r, bytes32 s))` at
`contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol:170-196` rejects any
`s` greater than `secp256k1n / 2` with `RecoverError.InvalidSignatureS`, which Toweli
re-throws as `ECDSA.ECDSAInvalidSignatureS(s)` at `Toweli.sol:206`. The high-S malleability
twin is therefore impossible to consume — and even if it slipped through, the EIP-2612 nonce
(`_useNonce(owner)` at line 163) would have been incremented before the recover, so the malleable
twin and the canonical sig couldn't both succeed regardless.

**Status:** Defended in depth. Nothing to fix.

---

### F-56-2 — INFO — Toweli `permit` SCW path: bytes-overload re-entry preserves malleability gate and rejects EIP-2098

**File:** `contracts/src/Toweli.sol:225` (and `Toweli.sol:222-227` for the SCW `code.length > 0` branch).
**Severity:** INFO.

**Path:**
```
Toweli.permit
  → owner.code.length > 0 branch
    → SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r,s,v))
       → if signer.code.length == 0: ECDSA.tryRecover(hash, signature) [bytes overload]
            → length must be exactly 65 (line 65 of ECDSA.sol) — 64-byte EIP-2098 rejected
            → calls (v,r,s) overload internally → same lower-half-s gate
       → else: staticcall isValidSignature(hash, signature) [ERC-1271]
```

**Notes:**
- The `abi.encodePacked(r, s, v)` reassembly at `Toweli.sol:225` always produces a 65-byte blob,
  so the explicit length-check inside OZ's `ECDSA.tryRecover(bytes)` (which would emit
  `InvalidSignatureLength` for 64-byte short sigs at `ECDSA.sol:78`) is structurally guaranteed
  to pass for this contract — the protocol cannot be tricked into accepting a shortened compact
  sig.
- The `code.length > 0` outer branch in Toweli short-circuits straight to the ERC-1271
  staticcall (`SignatureChecker.isValidERC1271SignatureNow`), bypassing the inner EOA path
  entirely for SCW owners. The duplicate `code.length` check inside `SignatureChecker` is
  redundant but harmless.
- Recursive ERC-1271 (a SCW that itself returns a 1271 magic value by recursively staticcalling
  another contract) is permitted by the OZ helper — this is accepted standard behavior; the
  staticcall context prevents state-mutation reentrancy from the SCW back into Toweli.

**Status:** Safe. ERC-1271 recursion is a feature of the spec, not a vulnerability here, because:
(a) the call is `staticcall` so the SCW cannot mutate state during validation, and
(b) the typehash + nonce + domain-separator triple uniquely binds the digest to this Toweli
deployment + this owner + this nonce, so the recursive call cannot be repurposed.

---

### F-56-3 — INFO — Domain separator correctly binds chainId + verifyingContract (no cross-deploy / cross-chain replay)

**File:** `contracts/src/Toweli.sol:166` (`_hashTypedDataV4(structHash)`) →
`contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol:91`.
**Severity:** INFO.

`EIP712._buildDomainSeparator()` includes `block.chainid` and `address(this)` in the
hashed domain, so a permit signed for Toweli on one chain cannot be replayed on another
chain or against any other deployment. The `version = "1"` lock documented at
`Toweli.sol:37-47` is intentional and correct — any future Toweli derivative MUST keep
`version = "1"` in its EIP712 init or every existing user signature breaks. This is
documented as a deliberate design constraint.

**Status:** Correct. Cross-deployment / cross-chain replay are blocked by the standard
OZ EIP-712 domain-separator construction.

---

### F-56-4 — LOW (operational) — `_useNonce(owner)` is consumed BEFORE signature validation; SCW failures still increment nonce

**File:** `contracts/src/Toweli.sol:162-166` (nonce consumed at line 163 inside the `structHash`
encoding) and the failure path at `Toweli.sol:225-227`.
**Severity:** LOW (denial-of-self only; **not exploitable by attacker**).

**Mechanic:** The struct-hash for the EIP-712 digest includes `_useNonce(owner)`, which is
evaluated at line 163 — this returns the current nonce value AND atomically increments
storage. If the subsequent `SignatureChecker.isValidSignatureNow` call fails (line 225) or
if the EOA path falls through to `ERC2612InvalidSigner` (line 219, 226), the transaction
reverts and the nonce-increment side-effect is rolled back along with the rest of state.

So in practice **the nonce is only burned on a successful permit**, identical to OZ stock.
This is not actually a finding — `_useNonce` semantics include the rollback-on-revert
behavior, so a malicious 1271 owner that always returns false cannot grief itself or anyone
else.

I initially flagged this as a possible signature-replay vector ("SCW returns false, nonce
already consumed → attacker re-uses the digest with a different sig"), but reverification
confirmed the entire `permit()` body is one transaction; on revert, `_useNonce`'s storage
write rolls back and the nonce is preserved.

**Status:** No finding. Documented to record the dead-end review path.

---

### F-56-5 — INFO — No shared-nonce / cross-function signature replay surface

**Severity:** INFO.

The protocol has exactly one signature-consuming function (`Toweli.permit`), so the "shared
nonce across multiple functions → cross-function replay" vector is structurally impossible.
A separate review of every function in `contracts/src/` confirms no other function takes
`(v, r, s)`, `bytes signature`, or any digest-derived authorization parameter:

| Vector | Status |
|--------|--------|
| Permit replay across Toweli functions | N/A — only `permit()` accepts a signature. |
| Permit replay across protocol contracts | N/A — no protocol contract calls `IERC20Permit.permit` on user funds. |
| Off-chain claim voucher / meta-tx / EIP-1167 minimal-forwarder | N/A — none implemented. |
| Off-chain order book signature (Seaport / 0x style) | N/A — none implemented. |
| Off-chain Merkle root attestation by trusted signer | N/A — Drop / Launchpad use plain Merkle hash inclusion, not signed roots. |

---

### F-56-6 — INFO — Signature-length validation is OZ-managed, not hand-rolled

**Severity:** INFO.

Toweli passes `(v, r, s)` as separate `uint8 + bytes32 + bytes32` parameters (so the ABI
decoder enforces sizes) and reassembles to 65 bytes via `abi.encodePacked(r, s, v)` at
line 225. There is no path where user-controlled `bytes calldata signature` of arbitrary
length reaches the contract — so the length-confusion class of bugs (EIP-2098 short-sig
ambiguity, or the OZ pre-v4.7.3 vuln where `(r, vs)` overload accepted a 65-byte input as if
it were 64-byte) does not apply.

Inside OZ `ECDSA.tryRecover(bytes)` the explicit `signature.length == 65` gate at
`ECDSA.sol:65` further rejects 64-byte / 96-byte / arbitrary-length blobs with
`InvalidSignatureLength`. EIP-2098 is therefore only reachable via the `(bytes32 r, bytes32 vs)`
overload, which Toweli does not call.

---

## Notes / dead-ends explored

1. **Solady `SignatureCheckerLib`** — not imported anywhere in `contracts/src/`. The Solady
   import in `TegridyStaking.sol:36` is `solady/tokens/ERC721.sol` only.
2. **Permit2 / Uniswap signature transfers** — the v4-periphery / permit2 libs sit in
   `contracts/lib/v4-periphery/lib/permit2/` but are not directly imported by any
   `contracts/src/` file. The fee hook in `TegridyFeeHook.sol` integrates with Uniswap V4
   Pool Manager via callbacks, not via Permit2 sigTransfers.
3. **Toweli `permit` `code.length` race** — a SCW owner that becomes-uninitialized (selfdestruct,
   then redeployment via CREATE2 with different bytecode) could theoretically have an old
   permit accepted under different validation logic, but selfdestruct semantics post-Dencun
   make this practically infeasible (selfdestruct only zeroes the balance; bytecode persists),
   and the `code.length == 0 → EOA path` would still require a valid secp256k1 sig from a
   private key the attacker would have to know.
4. **EIP-712 nested struct-hash collision** — Toweli uses the canonical EIP-2612 typehash
   `Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)`
   (line 82). No nested types, no array fields, no string fields → no struct-hash
   linearization ambiguity.
5. **`abi.encodePacked(r, s, v)` ordering** — OZ's `tryRecover(bytes)` reads `r` from
   offset 0x20, `s` from 0x40, and `v` from byte 0 of offset 0x60 (`ECDSA.sol:71-75`).
   Toweli's `abi.encodePacked(r, s, v)` produces exactly that layout (32 + 32 + 1 = 65 bytes),
   so ordering is correct.
6. **VRF / on-chain randomness signed beacons** — none in scope.

---

## Summary

The Tegridy Farms protocol exposes exactly one ECDSA / signature-verification surface:
`Toweli.permit()` at `contracts/src/Toweli.sol:149-230`. That surface delegates to OZ v5.6
`ECDSA.tryRecover` and `SignatureChecker.isValidSignatureNow`, both of which:

- Reject high-S signatures (malleability defeated).
- Reject non-65-byte signature blobs in the bytes overload.
- Bind the digest to `chainId + address(this)` via the EIP-712 domain separator.
- Use OZ's nonce mechanism (`_useNonce`) which atomically increments and rolls back on revert.
- Dispatch correctly to ERC-1271 for SCW owners with no recursion / reentrancy hazard
  (staticcall scope).

**No actionable findings.** All recovery / verification calls use the malleability-safe
`ECDSA.tryRecover` overload. There is no raw `ecrecover`, no hand-rolled signature parsing,
no shared-nonce / cross-function replay surface, and no bespoke voucher / meta-tx flow.
The five informational entries above are documentation of confirmed-safe behavior, not
defects.
