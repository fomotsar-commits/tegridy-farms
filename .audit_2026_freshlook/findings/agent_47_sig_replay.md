# Agent 47 — Signature Replay Audit (Fresh Eyes)

**Lens:** EIP-712 / ERC-2612 / Permit2 / cross-chain / cross-contract signature replay
**Scope:** `contracts/src/**/*.sol` (excluding `lib/`, `base/` already reviewed
            for the surface they expose to signed inputs)
**Date:** 2026-05-07
**Method:** grepped `ecrecover|recover\(|verify|permit|EIP712|_hashTypedData|
            domainSeparator|isValidSignature|ERC1271|signature` across all source.
            Cross-checked OZ EIP712.sol / ERC20Permit.sol / ECDSA.sol / SignatureChecker.sol
            against the live import paths.

---

## 0. Executive snapshot

The signature attack surface is **astonishingly narrow** for a protocol of
this size:

| Contract              | Signed-input surface                                |
| --------------------- | --------------------------------------------------- |
| `Toweli.sol`          | ERC-2612 `permit()` only (EOA + ERC-1271 dispatch)  |
| `TegridyDropV2.sol`   | Merkle proof for allowlist `mint()` (no signatures) |
| `VoteIncentives.sol`  | commit-reveal hashes (no signatures, msg.sender-bound) |
| `GaugeController.sol` | commit-reveal hashes (no signatures, msg.sender-bound) |
| All other contracts   | **NONE** — pure tx/msg.sender authorization        |

There is **no Permit2**, **no ERC-3009 `transferWithAuthorization`**, **no
cross-chain bridge ingress**, **no meta-transaction relayer**, **no
off-chain trusted-signer claim flow**, **no governance signature aggregation**,
**no router `selfPermit` wrapper**. The entire ECDSA-replay attack surface is
the standard OZ `ERC20Permit` pattern, which Toweli further hardens with an
EOA-vs-SCW two-path dispatch.

Most "what could go wrong" lines on the brief therefore have **no place to
trigger**. I document the few that do, and mark the rest as Not-Applicable
(ND-N) with reasoning so the next reviewer doesn't redo the search.

---

## F-47-1 — Toweli.permit: EIP-712 domain + nonce + malleability properly handled

**Severity:** INFO (No finding — verification report)
**File:** `contracts/src/Toweli.sol:48-231`
**Imports:** `@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol`
            (OZ v5.5.0), `cryptography/ECDSA.sol` (OZ v5.6.0),
            `cryptography/SignatureChecker.sol` (OZ v5.6.0)

**Domain separator components (verified):**
- `name        = "Toweli"`             (constructor `ERC20Permit("Toweli")`)
- `version     = "1"`                  (hardcoded in OZ `ERC20Permit` ctor: `EIP712(name, "1")`)
- `chainId     = block.chainid`        (rebuilt on chain-id change — `EIP712.sol:82-88`)
- `verifyingContract = address(this)`  (rebuilt on impl-change — `EIP712.sol:83`)
- `salt        = (none)`               (5-field domain, fields=`0x0f`)

**Fork-replay protection:** OZ `EIP712._domainSeparatorV4()` caches the
separator at construction *and* the corresponding `chainId` and `address(this)`.
On any divergence (e.g., L2 hard fork producing a chain-id split, or a clone
proxy with different runtime address), it falls back to `_buildDomainSeparator()`
which reads `block.chainid` live. Pre-fork-signed permits CANNOT replay
post-fork (different domain separator → different digest). [`EIP712.sol:82-92`]

**Nonce model:** OZ `Nonces.sol` per-owner monotonic counter, fetched and
incremented via `_useNonce(owner)` exactly once per `permit` (`Toweli.sol:163`).
Single-purpose — no shared nonce surface, no cross-purpose replay between
`permit` and any other signed flow (because no other signed flow exists).

**Typehash:** `Toweli.sol:81-82` re-derives the canonical OZ typehash literal
`Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)`.
Verified byte-for-byte identical to `ERC20Permit.sol:21-22`.

**Deadline check:** `block.timestamp > deadline` revert is the FIRST
statement of `permit` (`Toweli.sol:158-160`), before nonce consumption — so
an expired permit does not waste a nonce. Matches OZ.

**Malleability:** EOA path (`Toweli.sol:195-220`) uses
`ECDSA.tryRecover(hash, v, r, s)` which enforces `s ≤ secp256k1n/2`
(`ECDSA.sol:185`). SCW path (`Toweli.sol:225`) calls `SignatureChecker.
isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))`; for an EOA
signer the SignatureChecker also routes through `ECDSA.tryRecover(hash, signature)`
which enforces both length=65 and the same `s` upper-half check
(`ECDSA.sol:65-80, 185`). The malleability flip
`(r, secp256k1n − s, v ⊕ 1)` is rejected by both paths.

**Compact EIP-2098 (64-byte) signatures:** Toweli's `permit(v,r,s)` overload
takes the discrete `(v,r,s)` triple. The internal SCW dispatch packs them as
65-byte `(r,s,v)` before calling `SignatureChecker`. Solidity's `abi.encodePacked
(bytes32, bytes32, uint8)` produces exactly 65 bytes, never 64. So compact
2098 is structurally unreachable and the `tryRecover(bytes signature)` overload
rejects the 64-byte case anyway. **No double-claim primitive.**

**ERC-1271 / SCW acceptance:** Routed through `SignatureChecker.
isValidERC1271SignatureNow` which `staticcall`s the contract owner with the
EIP-712 digest (already includes nonce+deadline) and checks the
`bytes4` magic-value return. Since the OZ Nonce slot is incremented BEFORE
the SCW dispatch (`Toweli.sol:163` → `_useNonce`), a contract that returns
`true` once cannot have its signature reused on the next call: the digest
will already be different (next nonce). [No replay vector.]

**Frontrun-grief:** Standard ERC-2612 frontrun consideration. A pending
`permit` in the mempool can be sniped and submitted by anyone (the spender
field commits the recipient, but anyone can call `permit` itself). Toweli's
permit doesn't bundle the post-permit action (no `permit + transferFrom`
combiner is exposed by Toweli). The frontrun griefing pattern (force the
victim's tx to revert by consuming the nonce) is the classic OZ design
trade-off and is documented as accepted: any caller of a permit-then-action
flow downstream MUST wrap the `permit()` in a `try/catch` + `if (allowance
< value)` check. **None of Tegridy's contracts call `IERC20Permit.permit`,**
so this defensive wrapper is a moot concern internally — the risk only exists
for third-party integrators relying on Toweli, and is the standard ERC-2612
caveat documented by Compound, Uniswap V2 / V3, etc.

**Verdict:** No replay primitive identified. Implementation is conservative
(uses OZ stock + adds SCW path) and mitigates malleability, fork replay,
cross-chain replay, and version-collision per EIP-712 best practice.

---

## F-47-2 — TegridyDropV2 Merkle leaf: `chainId` not in leaf preimage

**Severity:** LOW (theoretical — mitigated via launchpad CREATE2 salt)
**File:** `contracts/src/TegridyDropV2.sol:537-541`
**Leaf format:**

```solidity
bytes32 leaf = keccak256(
    bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount)))
);
if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();
```

**Replay vector (theoretical):**
The leaf preimage commits to `address(this)` and the claimer's address but
NOT `block.chainid`. If a TegridyDropV2 clone is deployed at the same address
on Chain A and Chain B (deterministic CREATE2 from a factory whose salt does
not include chainid), an allowlist proof generated for Chain A's tree could
be verified on Chain B against the same root. A claimer who exhausted their
`allowedAmount` on Chain A could claim again on Chain B for the same allocation.

**Why it doesn't fire today (mitigations):**
1. The intended deployment path is `TegridyLaunchpadV2.createCollection`,
   which builds the salt for `Clones.cloneDeterministic` from
   `keccak256(abi.encode(block.chainid, address(this), msg.sender,
   allCollections.length, cfg.name, cfg.symbol))`
   [`TegridyLaunchpadV2.sol:213-215`]. Every clone produced by the launchpad
   has a chain-bound address — same name/symbol on a different chain produces
   a different clone address, so the per-chain `address(this)` already binds
   the leaf to a chain.
2. The protocol is single-chain (Base) per `project_relaunch.md`. No
   second-chain deployment exists for cross-chain leaf-replay to even target.
3. Each clone holds an independent `merkleRoot` proposed/executed via
   24-hour timelock, so an admin on Chain B could not collude with a
   reused-leaf claimer without ALSO adopting the Chain A root verbatim — at
   which point the claim is intentional, not a replay.

**Residual risk:**
If `TegridyDropV2` is ever deployed *outside* the launchpad's
chainid-bound salt path (e.g., a custom deploy script, a future v3
launchpad that drops the chainid prefix, or a non-clone deployment), the
leaf becomes cross-chain replayable. The leaf format is itself
permanent (any change breaks every off-chain proof generator
documented at `TegridyDropV2.sol:535`).

**Mitigation gap:**
- Bake `block.chainid` into the leaf preimage:
  `keccak256(abi.encode(block.chainid, address(this), msg.sender, allowedAmount))`.
- This is a **hard breaking change** for any tree generator — every existing
  proof becomes invalid.
- For relaunch-from-new-wallet (per `project_relaunch.md`), this is a
  **zero-cost time** to make the change — no live tree exists to invalidate.

**Recommendation:**
Add `block.chainid` to the leaf preimage during the relaunch window. The
`TegridyLaunchpadV2` salt's `block.chainid` already provides defense-in-depth,
but the leaf itself should not depend on the launchpad path's discipline.

**Note for next reviewer:** If you find this finding redundant against
existing audit notes citing DEEP-DROP-09 / NEW-L5 / MICROSCOPE C1, those
findings address per-claimer cap binding and second-preimage attacks
respectively — they do **not** address chainid binding in the leaf preimage,
which is a distinct cross-chain class.

---

## F-47-3 — VoteIncentives `computeCommitHash`: sound (no signature)

**Severity:** ND (Not a finding — verification report)
**File:** `contracts/src/VoteIncentives.sol:1480-1488`

```solidity
function computeCommitHash(address user, uint256 epoch, address pair,
                           uint256 power, bytes32 salt)
    public view returns (bytes32) {
    return keccak256(abi.encode(
        block.chainid, address(this), user, epoch, pair, power, salt
    ));
}
```

This is a **hash commitment**, not a signed message. The reveal step uses
`msg.sender` (`VoteIncentives.sol:1580`) so a third party cannot reveal
someone else's commit. Domain binding via (chainid, address) prevents
cross-chain and cross-contract replay. Salt is voter-supplied entropy.
**No replay primitive.**

---

## F-47-4 — GaugeController `computeCommitment`: sound (no signature)

**Severity:** ND (Not a finding — verification report)
**File:** `contracts/src/GaugeController.sol:433-449`

Same shape as F-47-3. Binds `chainid`, `address(this)`, `voter`, `tokenId`,
`gauges`, `weights`, `salt`, `epoch`. Reveal is constrained by NFT
ownership of `tokenId` at reveal time. **No replay primitive.**

---

## ND items — searched, no surface present

Documented so the next reviewer does not redo the search:

| Brief item                                            | ND reason                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Permit2 (`PermitSingle`/`PermitBatch`/`permitTransferFrom`) | Zero matches across `contracts/src/`. Not integrated.    |
| Cross-chain bridges (CCIP / LayerZero / Axelar)       | Zero matches. No bridge ingress.                            |
| Meta-tx / ERC-2771 forwarder                          | Zero matches. No relayer.                                  |
| ERC-3009 `transferWithAuthorization`                  | Zero matches. Toweli does not implement.                   |
| Off-chain trusted signer (claim sigs / vouchers)      | Zero matches. All claim flows are on-chain checkpoint-bound. |
| Router `selfPermit` / `permitAndAct` wrapper          | Zero matches. `TegridyRouter` does not bundle permit.       |
| Frontrun-grief on `permit`-then-action wrapper        | N/A — no internal permit-then-action exists.                |
| Cross-purpose nonce (one nonce shared across functions) | Only `Toweli.permit` consumes nonces. Trivially single-purpose. |
| Salt missing in EIP-712 domain                        | Toweli uses 5-field domain (no salt). Salt is the field for "version-bump-without-redeploy" and is not needed for a fixed-supply token whose version is locked to `"1"` forever (`Toweli.sol:37-47`). |
| Compact EIP-2098 (64-byte) signature acceptance       | Toweli's `permit(v,r,s)` overload reconstructs 65 bytes; OZ `tryRecover(bytes)` rejects 64-byte input. Unreachable. |
| Off-chain signer key compromise scope                 | No off-chain signer key. Owner is multisig, not a signer.   |

---

## Notes / dead-ends

- **Looked for:** `selfPermit`, `permitAndDeposit`, `permitAndStake`,
  `permitAndAdd`, `permitTransferFrom`, `swapWithPermit` patterns — none
  found. This is the SINGLE most common ECDSA-replay-grief vector in DEX/
  vault protocols (frontrunner submits the permit, victim's bundled
  permit-then-act tx then reverts because nonce is consumed). **Not present here.**

- **Looked for:** `bytes calldata signature`, `bytes memory sig`,
  `(uint8 v, bytes32 r, bytes32 s)` parameter patterns in any function
  other than `Toweli.permit`. **Zero matches.**

- **Looked for:** OZ `Nonces.sol` re-use for multiple purposes (e.g., a
  governance contract that uses `_useNonce` for both `castVoteBySig` and
  `delegateBySig`). **Not present** — Toweli is the only user of Nonces.

- **Looked for:** `domainSeparator()` external view leak that could be
  used in a CREATE2-deterministic same-address-on-multi-chain attack.
  Toweli exposes `DOMAIN_SEPARATOR()` per ERC-2612 (via OZ `ERC20Permit.sol:74-76`).
  Live separator includes `block.chainid` so cross-chain reads return
  different values; replay impossible.

- **Looked for:** Reverted `revoke` / `invalidate` flows that could leave
  a signed permit valid after the user "thought" they revoked. The OZ
  Nonces model has no in-band revocation — the standard mitigation is to
  call `permit` with `value=0` to bump the nonce. This is the OZ documented
  pattern and not a Tegridy-specific issue.

- **Looked for:** `eip712Domain()` (ERC-5267) consumer-side — none of the
  contracts call it. Toweli inherits the OZ default which exposes
  `(fields=0x0f, name, version, chainId, verifyingContract, salt=0)`.

---

## Summary

After a fresh-eyes pass over the entire `contracts/src/` tree:

- **One real, narrow finding** (F-47-2): TegridyDropV2 Merkle leaf does
  not include `block.chainid`. Cross-chain replay is structurally blocked
  *today* by the launchpad's chainid-bound CREATE2 salt and by the
  protocol being single-chain. Adding chainid to the leaf preimage during
  the relaunch window costs nothing and closes the class for any future
  non-launchpad deploy of TegridyDropV2.
- **No findings** on the Toweli `permit` flow. The EOA/SCW two-path
  implementation is conservative, uses OZ stock primitives, and correctly
  handles fork-replay, malleability, ERC-1271 dispatch, and typed errors.
- **No signature-replay surface** exists in any other contract: no
  Permit2, no bridges, no meta-tx, no trusted-signer claims, no signed
  governance.

The protocol's design choice to keep the off-chain signature surface
minimal is the strongest possible defense against this entire bug class.
