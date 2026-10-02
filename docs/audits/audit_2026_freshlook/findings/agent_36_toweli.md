# Agent 36 — Toweli.sol Fresh-Eyes Audit

**Target:** `contracts/src/Toweli.sol` (231 lines)
**Lens:** ERC20 supply integrity, transfer hooks, permit, votes, fee-on-transfer, ownership
**Date:** 2026-05-07

---

## Summary Table

| ID         | Severity | Title                                                                       | Status        |
|------------|----------|-----------------------------------------------------------------------------|---------------|
| F-36-01    | MEDIUM   | NatSpec / inheritance mismatch — "governance" token has no ERC20Votes       | DESIGN GAP    |
| F-36-02    | LOW      | Domain separator: chainId is correctly cached at deploy AND re-derived on fork — verify | OK / NOTE     |
| F-36-03    | LOW      | `_useNonce` mutated BEFORE deadline check is fine, but mutated for failed permits | NO-OP         |
| F-36-04    | LOW      | EIP-712 version locked to "1" forever — no v2 upgrade path                  | ACK'D BY DEV  |
| F-36-05    | INFO     | Recipient zero-check uses string require, not custom error                  | STYLE         |
| F-36-06    | INFO     | `_initialMintDone` could be `immutable`-equivalent via constructor-only mint | DESIGN CHOICE |
| F-36-07    | INFO     | No burn entrypoint — burn-via-zero-address-transfer not blocked but rare    | OK            |
| F-36-08    | INFO     | `permit()` re-implementation drifts if OZ changes typehash literal          | KNOWN         |
| F-36-09    | INFO     | DEFERRED: DEEP-LIB-M4 (recipient.code.length > 0) not enforced              | DEFERRED      |

---

## F-36-01 — NatSpec promises "governance token" but contract has no ERC20Votes

**Severity:** MEDIUM (design / consumer-side risk)
**Location:** `Toweli.sol:15`, `Toweli.sol:48`, contract-wide

### Observation

Line 15 NatSpec:
```
/// @title Toweli — Tegridy Farms governance & revenue-accrual token
```

Line 48 inheritance:
```solidity
contract Toweli is ERC20, ERC20Permit {
```

The contract is `ERC20 + ERC20Permit` only. There is **no** `ERC20Votes`, no `Checkpoints`, no `delegate()` / `delegateBySig()`, no snapshot logic, and no transfer-side checkpoint update.

### Why This Matters

The agent scope ("ERC20Votes: snapshot integrity, delegation, transfer-on-vote") and the contract NatSpec both imply this is a governance token. But:

1. **No on-chain voting weight tracking** — anyone holding TOWELI cannot vote in an on-chain governor without an external snapshot mechanism (e.g., off-chain Snapshot.org tied to balance at block N, OR a wrapper contract that mints veTOWELI / wTOWELI with checkpoints).
2. **Consumer contracts that assume `getVotes(address)` / `getPastVotes(address, ts)` exist will fail to compile or revert** when integrating TOWELI directly. Agents 10/11 (vote incentives + snapshots) and Agent 17 (gauge weights) likely consume voting power — they would need to read it from a *separate* wrapper, not from TOWELI itself.
3. **If a Governor contract is wired directly to TOWELI**, it will revert on `getPastVotes` (function does not exist) — protocol governance silently broken.

### Risk Classification

This is a **design intention** finding, not a vulnerability. Two possible interpretations:

- **(A) Intentional:** Voting is handled by a separate veTOWELI / staking contract (revenue-accrual = staking dividends). Then the NatSpec wording "governance token" is loose — it means "token used as the underlying for governance," not "token that itself implements votes." The "no admin surface; nothing to rug" design (line 31) is in tension with embedded ERC20Votes, since `_update` would need a checkpoint write that increases gas cost on every transfer for non-governance users.
- **(B) Accidental omission:** The NatSpec at lines 23-27 lists "compatible with Uniswap V2 routing, standard DEX adapters, and account abstraction flows via ERC-2612 permit" but does NOT list "compatible with OpenZeppelin Governor." Contrast with the Gauge / VoteInc system which clearly wants vote-weighted decisions.

### Recommendation

Confirm intent. If (A), update NatSpec to clarify "governance accounting handled by separate veTOWELI staker — TOWELI itself is a transferable balance only." If (B), add ERC20Votes — but note this is a *bytecode-changing* addition that breaks the "fixed deployed code, vanity address" promise on line 20-22.

**Note:** Given the deployed bytecode is at the verified `0x420698...` address and the design is explicitly "no admin, nothing to rug, fixed forever," interpretation (A) is overwhelmingly likely. The finding here is documentation clarity, not an exploit vector.

---

## F-36-02 — Domain separator chainId behaviour on fork

**Severity:** LOW (informational — verify OZ behaviour)
**Location:** `Toweli.sol:48` (inheritance from `ERC20Permit` → `EIP712`)

### Observation

OZ's `EIP712` (used by `ERC20Permit`) caches `_HASHED_NAME`, `_HASHED_VERSION`, and computes the domain separator with the **current** `block.chainid` at call time, not at deploy time. From OZ source:

```solidity
function _domainSeparatorV4() internal view returns (bytes32) {
    if (address(this) == _CACHED_THIS && block.chainid == _CACHED_CHAIN_ID) {
        return _CACHED_DOMAIN_SEPARATOR;
    } else {
        return _buildDomainSeparator();
    }
}
```

So on a hard fork (chainId change), the domain separator is correctly re-derived. **No vulnerability** — just verifying the OZ guarantee holds for this contract.

### Risk

None on canonical mainnet. If TOWELI is bridged to L2 / sidechain via lock-and-mint, the **bridged wrapper** (not TOWELI itself) needs its own permit logic with its own chainId — this is correctly noted in the NatSpec at lines 41-47 about EIP-712 version "1" being locked. No action.

---

## F-36-03 — Nonce consumption order in custom permit override

**Severity:** LOW (informational)
**Location:** `Toweli.sol:158-164`

### Observation

The custom `permit()` override calls `_useNonce(owner)` **inside** the `keccak256(abi.encode(...))` for `structHash`:

```solidity
if (block.timestamp > deadline) {
    revert ERC2612ExpiredSignature(deadline);
}

bytes32 structHash = keccak256(
    abi.encode(PERMIT_TYPEHASH_LOCAL, owner, spender, value, _useNonce(owner), deadline)
);
```

`_useNonce` increments the nonce **before** signature validation. If signature validation later reverts (`ECDSAInvalidSignatureS`, `ERC2612InvalidSigner`, etc.), the nonce increment is rolled back by the EVM revert — **so this is fine**.

### Verification

This matches OZ's stock `ERC20Permit.permit` exactly. The "use nonce → derive hash → validate signature" order is the EIP-2612 canonical pattern and the revert correctly unwinds the nonce. No issue.

### Edge case

Note: a *deliberate* attacker calling `permit` with a known-bad signature does **not** consume a nonce (revert unwinds it). This is the correct behaviour and matches OZ. No fix needed.

---

## F-36-04 — EIP-712 version "1" locked forever

**Severity:** LOW (acknowledged by developer)
**Location:** `Toweli.sol:37-47, 90`

### Observation

Already acknowledged in `DEEP-LIB-I2` comment. Any future v2 contract MUST keep `version = "1"` to preserve cross-chain signature compatibility. This is a **forward-compat constraint**, not an exploit.

No action — already documented. Just flagging for the audit corpus.

---

## F-36-05 — Style: `require` with string instead of custom error

**Severity:** INFO
**Location:** `Toweli.sol:92, 119`

```solidity
require(recipient != address(0), "Toweli: zero recipient");
require(!_initialMintDone, "MINT_DISABLED");
```

OZ-modern conventions favour custom errors (cheaper, typed). Both reverts here are constructor-only or genuinely-impossible-post-deploy paths — gas optimisation is irrelevant (both paths are unreachable in steady state). **No action.**

---

## F-36-06 — `_initialMintDone` slot vs immutable

**Severity:** INFO / DESIGN CHOICE
**Location:** `Toweli.sol:65-72, 116-122`

### Observation

The "mint exactly once" invariant is enforced via a `bool` storage slot + runtime check in `_update`. An alternative would be:

- Constructor mints to recipient.
- `_update` reads `_isInitializing()` from a transient flag (forge-style).
- After constructor, the flag is `false` permanently.

This pattern (shown in some OZ Initializable variants) avoids the persistent `bool` storage slot. However, it requires careful reasoning about transient storage / TLOAD-TSTORE which only became available post-Cancun.

**Trade-off:** The current pattern uses 1 SSTORE at deploy + 1 SLOAD per transfer (warm slot, cheap). A `transient` flag would be ~100 gas cheaper per mint-attempt revert path but adds complexity. **No action — current pattern is bulletproof and the gas cost is trivial.**

The dev's own AUDIT L-T01 comment (lines 65-71) already analyses the slot-packing trade-off and concludes "31 bytes of waste are a one-time cost paid at deploy and never again." Agreed.

---

## F-36-07 — Burn path via transfer-to-zero

**Severity:** INFO
**Location:** `Toweli.sol:116-122`

### Observation

`_update(from, to, value)` allows `to == address(0)` to pass through. ERC20's `transfer(address(0), x)` is blocked at the `_transfer` level by OZ (reverts `ERC20InvalidReceiver(0)`). So users **cannot** burn TOWELI via direct transfer.

However, anyone can burn by sending to *any* dead address (`0x000...dEaD`, `0xdead...`). That's not a contract issue — that's user choice — and it correctly reduces effective supply without affecting `totalSupply()`.

If governance ever introduces an ERC20Votes wrapper, dead-address holdings will count as "lost" voting weight (no delegation possible from a non-key address). Standard behaviour. **No action.**

---

## F-36-08 — Custom `PERMIT_TYPEHASH_LOCAL` drift risk

**Severity:** INFO (documented mitigation already in place)
**Location:** `Toweli.sol:81-82`

### Observation

The dev already acknowledges (`DEEP-LIB-L3` comment at lines 74-80) that this constant must match OZ's exact bytes. If OZ ever ships a typehash change in a future ERC20Permit revision, a **devops procedure** must update this constant.

**Sanity check:** The string `"Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"` matches EIP-2612 spec exactly. No drift. ✓

No action. Just noting the dev has already correctly identified this as a manual-tracking item.

---

## F-36-09 — DEFERRED `recipient.code.length > 0` not enforced at deploy

**Severity:** LOW (operational mitigation in place)
**Location:** `Toweli.sol:92-104`

### Observation

The dev explicitly defers `DEEP-LIB-M4` (require recipient be a contract = multisig, not EOA) because tests use EOA addresses. Operational discipline at deploy time is the substitute defense.

**Risk:** If TOWELI is ever re-deployed (new chain, fork) by a less-disciplined operator who passes an EOA recipient, all 1B tokens go to a single private key — a much bigger rug surface than a multisig.

**Mitigation:** TOKENOMICS.md and TOKEN_DEPLOY.md instruct multisig. This is a known deferred fix. **No action by audit** — this is on the deploy runbook.

---

## Lens Coverage Checklist

| Lens                                                 | Result                                                       |
|------------------------------------------------------|--------------------------------------------------------------|
| Supply integrity (1B, no further mint)               | ✓ Constructor-only mint, `_update` blocks all post-deploy mint paths via `_initialMintDone` flag. Bulletproof. |
| Transfer hooks `_update` / `_beforeTokenTransfer`     | ✓ Only `_update` overridden, only mint-path is gated. Burn and transfer pass through unchanged. |
| Blacklist / paused transfer                           | ✓ None (intentional per NatSpec). No admin surface = no rug. |
| ERC20Permit domain separator / nonces / deadline      | ✓ OZ inheritance handles chainId correctly via `_domainSeparatorV4`. Nonces/deadline correct. |
| ERC20Votes snapshot / delegation / transfer-on-vote   | ⚠ NOT IMPLEMENTED — see F-36-01. Likely intentional (governance handled by external veToken), but NatSpec is misleading. |
| Burn function                                         | ✓ No public burn. Burn-by-dead-address possible (user choice). |
| transferOwnership / renounce                          | ✓ No owner. Truly ownerless. |
| Hidden tax / fee-on-transfer                          | ✓ None. `_update` does not skim, modify, or redirect value. |
| Mint() somewhere                                      | ✓ None. `_initialMintDone` blocks post-deploy mints. |
| Domain separator hardcoding (chainId)                 | ✓ OZ runtime-computes, fork-safe. |
| Rebase / supply elasticity                            | ✓ None. Fixed supply enforced. |
| approveMax pattern abuse                              | ✓ Standard `_approve` via permit; no infinite-allowance hidden surface. |

---

## Notes / Dead Ends

- **`recipient.code.length > 0` runtime check on `_update`?** Considered: would break Uniswap V2 LP minting (router is a contract, but recipients are users when liquidity is removed). Bad idea. Rejected.
- **Replay across chains?** Cross-chain permit signatures are **NOT** replayable because `_buildDomainSeparator()` includes `block.chainid`. Verified ✓.
- **EIP-1271 SCW + `tryRecover` interaction:** The `code.length == 0` gate at line 195 ensures EOA path runs ECDSA pre-validation, contract path skips straight to ERC-1271. No path mixes the two. The dev's `v3-LIB-L2` fix is correct.
- **`_useNonce` reentrancy?** `_useNonce` is OZ internal that increments a uint256. No external call possible during mutation. Safe.
- **`_approve(owner, spender, value)` allowance overwrite vs increment?** OZ's `_approve` is an **overwrite** (not increment) — correct EIP-2612 behaviour. A naïve attacker cannot stack two valid permits to multiply allowance — second one overwrites the first.
- **ERC20Permit + transfers in same tx?** No interaction — permit only writes allowance. Transfers happen separately. Clean separation.

---

## Final Verdict

**No exploitable vulnerabilities found.** The contract is a tight, well-audited fixed-supply ERC20 with permit support and no admin surface.

The single non-trivial finding (**F-36-01**) is a NatSpec / design-clarity issue: the contract is described as a "governance" token but lacks ERC20Votes machinery. This is almost certainly intentional (governance accounting is delegated to an external veTOWELI / staker contract — consistent with the "fixed-supply, no admin" design philosophy), but the NatSpec wording "governance & revenue-accrual token" could mislead an integrator into expecting `getPastVotes` / `delegate` directly on TOWELI.

All previously-identified audit fixes (R014, V2-LIB-L4, v3-LIB-L1, v3-LIB-L2, DEEP-LIB-L3, DEEP-LIB-I2, L-T01, DEFERRED DEEP-LIB-M4) appear correctly implemented and well-documented in-line.

The contract is **production-grade** for its stated fixed-supply ERC20 + permit purpose.
