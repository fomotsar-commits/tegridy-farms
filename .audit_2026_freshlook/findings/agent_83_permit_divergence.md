# Agent 83 — Permit Divergence (EIP-2612 / DAI-style / Permit2 / USDC odd permit)

Scope: All Solidity in `contracts/src/`. Lens: divergent permit signatures across token families and consumer assumptions thereof.

Verdict: **No exploitable findings.** The protocol does not consume `permit()` on any external token. The only permit surface is `Toweli.permit` (own token), which is canonical ERC-2612 with a SCW-compatible `SignatureChecker` extension that preserves typehash / nonce / deadline / domain semantics. There is therefore no DAI-vs-EIP2612 divergence, no USDC permit2 fallback path to break, and no try/catch wrapper that could swallow a permit revert.

Two notes (informational), no bugs:
- `TegridyPair` (LP token) deliberately omits permit (audit-acknowledged at `TegridyPair.sol:28-29`). Routers correctly do not expose `removeLiquidityWithPermit`.
- Toweli's permit override deviates from OZ stock by using `SignatureChecker` (ERC-1271 dispatch) but keeps the canonical `Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)` typehash and `_hashTypedDataV4`, so off-chain signers and on-chain ERC-2612 integrators (e.g., 1inch aggregator, Permit2's `Permit2Lib.permit2` ERC-2612 fallback path, Uniswap UniversalRouter `PERMIT` command, AlphaRouter) treat it as canonical.

---

## Permit-call census across `contracts/src/`

Greps run:
- `permit(` — only one match: `Toweli.sol:149` (own definition; not a call).
- `IERC20Permit` / `IERC2612` / `ERC20Permit` — only Toweli's import + parent.
- `Permit2` / `permit2` / `allowanceTransfer` / `PERMIT2` — **zero matches.**
- `DOMAIN_SEPARATOR` / `nonces(` / `PERMIT_TYPEHASH` — only inside Toweli.
- `try.*permit` / `catch.*[Pp]ermit` — **zero matches** (no wrapper hides a revert).
- `removeLiquidityWithPermit` / `selfPermit` / `permitAndCall` — **zero matches.**

Conclusion of census: there is **no consumer code in this codebase** that calls `.permit()` on any external ERC-20. Items 1, 2, 3, 5, and 6 of the brief therefore do not exist as attack surface inside `contracts/src/`. The remaining items (4 deadline check, 7 third-party assumes canonical) are evaluated against `Toweli.permit` below.

---

## F-83-1 — Toweli.permit deadline check is well-formed (NEGATIVE FINDING)

File: `contracts/src/Toweli.sol:158-160`

```solidity
if (block.timestamp > deadline) {
    revert ERC2612ExpiredSignature(deadline);
}
```

Equivalent to OZ's stock `ERC20Permit.permit`. `>` (not `>=`) means a permit signed for `deadline = block.timestamp` is still valid in the same block, matching every mainstream ERC-2612 implementation (OZ, USDC v2.2, DAI legacy, solmate, solady). Off-by-one consistent with industry. No issue.

---

## F-83-2 — Typehash matches OZ exactly (NEGATIVE FINDING)

File: `contracts/src/Toweli.sol:81-82`

```solidity
bytes32 private constant PERMIT_TYPEHASH_LOCAL =
    keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
```

Byte-identical to OZ `ERC20Permit._PERMIT_TYPEHASH`, USDC FiatTokenV2.2, solmate, solady. Comment at L74-80 acknowledges and locks the dependency. If OZ ever shipped a typehash change (they have not; ERC-2612 is finalized), this constant would need a corresponding bump — but that is a maintenance hazard, not a current vulnerability.

DAI-style permit divergence (`Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)`) is **not** used by Toweli, but Toweli also does not advertise a DAI-style entrypoint, so no integrator calling DAI semantics on Toweli would reach a non-revert path: the function shape is fixed `(address,address,uint256,uint256,uint8,bytes32,bytes32)` and a DAI-style signature would simply produce a wrong digest → `ERC2612InvalidSigner`. Clean revert, no exploit.

---

## F-83-3 — EIP-712 domain v"1" is correctly locked (NEGATIVE FINDING)

File: `contracts/src/Toweli.sol:90` and L37-47 NatSpec.

```solidity
ERC20Permit("Toweli")
```

OZ's `ERC20Permit` constructor passes `version = "1"` to `EIP712`, which is baked into the domain separator. The NatSpec correctly warns future maintainers: any v2 redeployment must keep `version = "1"` to preserve cross-chain signature compatibility. This is a documentation control, not a code bug.

`name()` is `"Toweli"` (constructor arg) — matches the EIP712 init string, so the domain `name` field aligns with the token name. Good.

---

## F-83-4 — SCW ERC-1271 dispatch preserves canonical client semantics (NEGATIVE FINDING)

File: `contracts/src/Toweli.sol:149-230`

The override:
1. Verifies `block.timestamp <= deadline` (canonical).
2. Computes `structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline))` (canonical).
3. Computes `_hashTypedDataV4(structHash)` (canonical EIP-712 + domain separator).
4. Splits on `owner.code.length`:
   - EOA path: `ECDSA.tryRecover(hash, v, r, s)` then strict equality `recovered == owner`. Bubbles canonical `ECDSAInvalidSignatureS` / `InvalidSignatureLength` / `InvalidSignature` errors.
   - SCW path: `SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))` → reverts `ERC2612InvalidSigner(0x0, owner)` on failure.
5. On success: `_approve(owner, spender, value)`.

For a canonical ERC-2612 client (1inch aggregator, Permit2Lib, UniversalRouter PERMIT command, every wagmi/ethers/viem `signTypedData` codepath), the on-the-wire signature is `(v, r, s)` over the canonical EIP-712 digest. Toweli accepts that signature via the EOA path with no behavioral change vs OZ stock. **No third-party assumption of canonical permit is broken by this override.**

The SCW path is purely additive (extends acceptance to ERC-1271 owners); it cannot reject a signature that OZ's stock `ERC20Permit.permit` would have accepted.

Malleability: `ECDSA.tryRecover` (OZ v5+) rejects `s > secp256k1n/2`. The recovered EOA is then strict-equality-compared to `owner`, so a malleated `(v',r,s')` cannot pass either. No malleability surface.

`_useNonce` is OZ's monotonic counter — replay protection is unchanged from canonical ERC-2612.

---

## F-83-5 — Permit front-run grief on Toweli (LOW, ACK / DESIGN-ACCEPTED)

File: `contracts/src/Toweli.sol:149-230`

Like every ERC-2612 permit, a watcher on the mempool can extract the raw `(v, r, s)` from a user's pending `permit + transferFrom` bundle, submit just the `permit()` portion ahead of the user's own tx, and burn the user's nonce. The user's intended `transferFrom` call still succeeds (allowance is set), but if the user's tx was a `multicall`/aggregated `permit + action` bundle that re-calls `permit()` instead of relying on prior allowance, the second `permit()` reverts (nonce already consumed) and the bundle reverts.

Mitigations available, none required of this contract:
- 1inch / Permit2 / UniversalRouter all wrap permit in `try { permit(...) } catch {}` precisely so a front-run consumed-nonce does not brick the bundle. **This protocol's contracts never aggregate a permit-then-action call,** so there is no in-protocol surface where a front-run permit could grief a user beyond the standard ERC-2612 grief that affects every permit-enabled token.
- Toweli does not call its own `permit()` from any other entrypoint. There is no protocol-side bundle to grief.

This is the standard ERC-2612 front-run grief that the EIP itself acknowledges; not a Toweli-specific bug. No remediation in scope.

---

## F-83-6 — No consumer of `permit()` exists in `contracts/src/` (NEGATIVE FINDING — KEY)

`permit()` (as a call) appears **zero** times across:
- All routers (`TegridyRouter`, `SwapFeeRouter`).
- All vaults (`TegridyStaking`, `TegridyRestaking`, `TegridyStakingJbacVault`, `TegridyLPFarming`).
- Lending & NFT lending (`TegridyLending`, `TegridyNFTLending`, `TegridyNFTPool`, `TegridyNFTPoolFactory`).
- Distribution & gov (`RevenueDistributor`, `GaugeController`, `VoteIncentives`, `CommunityGrants`, `ReferralSplitter`).
- Drop / launchpad / bounty (`TegridyDropV2`, `TegridyLaunchpadV2`, `MemeBountyBoard`).
- Hook / oracle / accumulator (`TegridyFeeHook`, `TegridyTWAP`, `POLAccumulator`).
- Premium / admin (`PremiumAccess`, `TegridyLendingAdmin`, `TegridyStakingAdmin`, `SwapFeeRouterAdmin`, `VoteIncentivesAdmin`, `TegridyTokenURIReader`).
- All `base/` and `lib/` files.

Implication: the brief's items 1 (DAI-permit divergence breaking ERC-2612 consumers), 2 (`permit()` called unconditionally on a non-permit token), 3 (USDC Permit2 fallback), 5 (try/catch swallowing revert), and 6 (front-run grief on a protocol-side bundle) **have no in-scope attack surface** because no protocol contract calls `permit()` on any token.

This is a defensive design choice — gasless approvals are not part of the protocol's UX flow; users approve the standard way. Eliminates an entire class of permit-divergence bugs by construction.

---

## F-83-7 — TegridyPair LP token has no permit (DEFERRED, audit-acknowledged)

File: `contracts/src/TegridyPair.sol:28-29`

```solidity
/// @dev AUDIT NOTE #65: EIP-2612 permit is not supported on LP tokens. Adding permit would require
///      inheriting ERC20Permit, which is deferred to a future version to avoid redeployment risk.
```

A canonical Uniswap V2 router exposes `removeLiquidityWithPermit` so users can remove liquidity in one tx. `TegridyRouter.removeLiquidity` (L144) **does not** offer this variant, and there are no callers that try to call `pair.permit()` (verified by census above). So the missing LP permit is a UX gap, not a vulnerability — no consumer ever assumes the LP token has permit, so no consumer reverts. Acknowledged.

---

## Dead-ends explored

- **Searched for any `try { ... .permit(...) } catch {}` block** that could silently swallow a permit revert and continue with stale allowance: zero matches.
- **Searched for `Permit2` / `allowanceTransfer` / `PERMIT2`** integration (would imply USDC's Permit2-style alternative path): zero matches in `contracts/src/`. Permit2 only appears in deep library code under `contracts/lib/v4-periphery/lib/permit2/...`, which is third-party and not deployed by this protocol.
- **Searched for `selfPermit` / `permitAndCall` / `multicall + permit`** bundles in the routers: zero matches. The protocol does not multi-batch permit, so no front-run-permit grief is possible against bundle execution.
- **Searched for any signature-typehash literal other than the canonical Permit struct** (e.g., DAI's `Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)`): only the canonical typehash exists, in Toweli at L82.
- **Checked `SignatureChecker` import path** — uses OZ canonical, which itself does ECDSA recovery (with malleability check) for EOAs and ERC-1271 staticcall for contracts. No custom forks, no shortcut.

---

## Summary

| # | Item from brief | Status |
|---|---|---|
| 1 | DAI permit typehash divergence | N/A — no protocol contract calls `.permit()` |
| 2 | `permit()` called on non-permit token (revert) | N/A — no protocol contract calls `.permit()` |
| 3 | USDC Permit2 fallback assumption | N/A — no Permit2 usage |
| 4 | Permit deadline check | OK — `>` strict, canonical |
| 5 | try/catch around permit | N/A — no try/catch around permit anywhere |
| 6 | Front-run permit grief | Theoretical (every ERC-2612), no protocol bundle exposes it |
| 7 | Toweli's permit override breaks canonical assumers | OK — typehash, domain, nonces all canonical; SCW path is purely additive |

**No actionable findings. Protocol is permit-divergence safe by construction.**
