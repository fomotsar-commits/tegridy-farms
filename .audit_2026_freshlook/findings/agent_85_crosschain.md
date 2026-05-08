# Agent 85/100 — Cross-Chain Messaging / Replay / Signed-Payload Lens

**Date:** 2026-05-07
**Working dir:** `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms`
**Lens:** LayerZero, Wormhole, Axelar, CCIP, generic bridge integrations, replay across chains, signed-payload chainId binding, nonceX/sequenceId per chain, endpoint upgrade trust.
**Method:** Read-only grep + targeted reads across `contracts/src/**/*.sol`. No edits. No audit-history `.md` reads.

---

## Executive Summary

**No cross-chain messaging integration exists in the protocol.** This is itself the strongest cross-chain defense — there is no LayerZero / Wormhole / Axelar / CCIP attack surface to exploit, no foreign-endpoint trust assumptions, no relayer/guardian quorum to subvert, no `lzReceive`/`_nonblockingLzReceive` callback to spoof, no sequence-number replay to engineer.

All on-chain signed payloads or commit-reveal hashes that COULD theoretically be replayed across chains (Toweli EIP-2612 permits, Drop merkle leaves, Gauge/VoteIncentives commit hashes) are **structurally bound to a single chain** via one of two mechanisms:

1. **EIP-712 domain separator** (Toweli permit) — includes `block.chainid` and `address(this)` per the EIP-712 spec, automatically.
2. **Explicit `block.chainid + address(this)` in the preimage** (commit-reveal hashes) or **address(this) in the leaf** (Drop) where `address(this)` is itself derived from a CREATE2 salt that includes `block.chainid` (Factory, Launchpad, NFTPoolFactory).

No findings of severity ≥ Low under this lens. One Info-level dead-end (Drop leaf doesn't include `block.chainid` directly, but is structurally chain-bound — see F-85-K1 for the proof).

---

## F-85-K0 — Cross-chain messaging integration: ABSENT (Info / Defensive Note)

**Severity:** N/A (defensive observation — strongest possible posture)
**Status:** Confirmed absent

### Evidence
Grep across `contracts/src/` for the entire surface:

```
LayerZero | lzReceive | Wormhole | Axelar | CCIP | NonblockingLzApp | OAppCore
ILayerZero | ILayerZeroEndpoint | IWormhole | IAxelar | ICCIP | IRouterClient
ENDPOINT | endpoint | _send | _lzSend | sendMessage | relayer | attestations
guardian | signedPayload | sequenceId
```

Returns **zero matches** for any cross-chain bridge protocol or its idiomatic methods/interfaces. The only hits for `bridge` are:
- `SwapFeeRouter.sol:1902-1944` — Uniswap V2 TWAP "spot×elapsed bridge term" (mathematical idle-window bridge, not cross-chain).
- `TegridyTWAP.sol:312, 464` — same idle-window cumulative bridge.
- `TegridyLending.sol:1600` — comment about Chainlink-bridged feed clock skew (oracle-side concern, handled by `SequencerCheck.sol`).
- `Toweli.sol:40, 47, 143` — NatSpec stating that future Toweli derivatives ("multi-chain bridge wrappers") are intended to extend the `permit()` virtual; no bridge logic in this contract.
- `PremiumAccess.sol:218` — comment about NFT bridge transfers (an external concern, not implemented here).

The only hits for `endpoint` are `SwapFeeRouter.sol:1966` referring to Uniswap pair endpoints (price-feed terminology, not LayerZero endpoints).

### Why this matters
The most-exploited DeFi attack class of 2022-2024 (Wormhole, Ronin, Nomad, Multichain, Harmony Horizon, Poly Network — collectively ~$3B lost) is the bridge / cross-chain-message layer. By containing zero such integration, Tegriddy Farms inherits **none** of:
- Replay across chains (same payload accepted by 2+ deployments).
- Compromised relayer / guardian quorum.
- Endpoint-upgrade trust (delegate proxy on the endpoint can rewrite message handling).
- `_nonblockingLzReceive` storage-slot poisoning.
- Wormhole VAA signature-malleability bugs.
- Axelar gateway forgery.

If the protocol later introduces cross-chain functionality (e.g. a Toweli OFT/xERC20 wrapper, gauge-vote messaging across L2s), this finding becomes void and a fresh audit pass with the same lens MUST be re-run on whatever is added.

### Recommendation
- **Keep it absent unless absolutely necessary.** Every LayerZero / OFT / xERC20 wrapper added is a new trust assumption (LZ ULN config, default receive library upgrade authority, default send library, etc.).
- If a future relaunch on a new chain creates a "bridged Toweli" wrapper, the wrapper MUST live in a separate repo / audit cycle and MUST NOT inherit this contract's `_initialMintDone` invariant directly (the wrapper's `mint` semantics on the destination chain conflict with Toweli's "mint exactly once" property).
- Document this absence prominently in protocol docs so future contributors don't introduce a bridge integration without re-auditing.

---

## F-85-K1 — Drop merkle leaf: structurally chain-bound (Info / Verified Safe)

**Severity:** Info (no action required)
**File:** `contracts/src/TegridyDropV2.sol:538-540`

### Observation
The Drop merkle leaf does NOT include `block.chainid` directly:

```solidity
bytes32 leaf = keccak256(
    bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount)))
);
```

Surface-level concern: if the same drop contract were deployed at the same address on two chains (via CREATE2 with the same salt and same bytecode), an allowlist proof valid on chain A could be replayed on chain B without an explicit `chainid` field in the leaf.

### Why it's safe
The drop is a `TegridyDropV2` instance deployed by `TegridyLaunchpadV2`, which uses a CREATE2 salt that **explicitly includes `block.chainid`** (`TegridyLaunchpadV2.sol:209-214`):

```solidity
// include chainid + address(this) so cross-chain CREATE2 collisions
abi.encode(block.chainid, address(this), msg.sender, allCollections.length, cfg.name, cfg.symbol)
```

Therefore `address(this)` (the drop contract) is **provably different** on every chain even if the same factory is deployed at the same address everywhere — the salt diverges via `block.chainid`, so the CREATE2 computation produces different addresses. The leaf's `address(this)` field becomes the de-facto chainId binding.

Same reasoning applies to:
- `TegridyFactory.sol:188-194` — pair deployment salt includes `block.chainid`.
- `TegridyNFTPoolFactory.sol:225-231` — pool deployment salt includes `block.chainid`.

### Edge case (Info-only, not exploitable)
If a Drop is deployed via `new TegridyDropV2(...)` (plain CREATE) instead of through the launchpad's CREATE2 path, its address is determined by `(deployer, deployer-nonce)` only. Two chains where the same deployer EOA happens to use the same nonce sequence to deploy a drop would produce the same address. Operationally this is not how the launchpad works (it always deploys via CREATE2), but a manual deployment path could in principle hit this. Not exploitable in practice given:
1. The leaf also binds `msg.sender` (claimer EOA) and `allowedAmount` — replay benefits the SAME claimer for the same amount, on a chain where the merkle root must independently be set by the drop owner. The owner is the one putting the same root on both chains (ALWAYS a self-inflicted move).
2. `allowlistClaimed[msg.sender]` is per-chain storage, so the cap is enforced per chain independently.

The "attack" reduces to: "if the operator deploys the same drop on two chains with the same merkle root, the same claimer can claim on both." That's the operator's choice, not a vulnerability.

### Recommendation
Defense-in-depth (NOT required, marginal value):
- Optionally extend the leaf preimage to include `block.chainid`. Costs the same gas; eliminates the edge case at the operator-mistake level.
- Pattern of record (already used elsewhere in this codebase): `VoteIncentives.sol:1487` and `GaugeController.sol:447` both include `block.chainid` in their commit-reveal preimage for exactly this reason.

Since the launchpad path already binds via CREATE2 salt and the operator-mistake edge case is self-inflicted, this is filed as Info only.

---

## F-85-K2 — Toweli EIP-2612 permit: chain-bound via EIP-712 domain (Verified Safe)

**Severity:** None (verified safe, expected EIP-712 behavior)
**File:** `contracts/src/Toweli.sol:149-220`

### Observation
The Toweli `permit()` override re-implements OZ `ERC20Permit.permit` with `SignatureChecker` for SCW (ERC-1271) compatibility. The struct hash:

```solidity
bytes32 structHash = keccak256(
    abi.encode(PERMIT_TYPEHASH_LOCAL, owner, spender, value, _useNonce(owner), deadline)
);
bytes32 hash = _hashTypedDataV4(structHash);
```

`_hashTypedDataV4` from OZ's `EIP712` mixes in the EIP-712 domain separator, which by spec includes:
- `name` (`"Toweli"`)
- `version` (`"1"`, baked at construction — see line 38 NatSpec)
- `chainId` — `block.chainid` at the point of `_buildDomainSeparator`
- `verifyingContract` — `address(this)`

OZ's `EIP712` impl caches the separator per chainId and rebuilds on chain fork (where `block.chainid` changes), so a permit signed for chain A is **NOT** valid on chain B even if the same Toweli contract is deployed at the same address — the domain's `chainId` field diverges.

### Verified
- `Toweli.sol:81-82` — typehash matches the canonical EIP-2612 typehash exactly.
- Nonce binding: `_useNonce(owner)` is per-owner, increments on every successful permit (replay-on-same-chain is also blocked).
- Deadline check on line 158 prevents stale signature use.
- ERC-1271 dispatch path on line 222+ uses the same `hash` (which includes the EIP-712 domain), so SCW signatures inherit the same chain-binding.

### Edge case considered (NOT a finding)
EIP-712 domain has a known weakness: `chainId` is a value field, not a "verifying chain" enforcement. A signature crafted for chainId X could be presented to a contract running on chainId Y if the contract DOESN'T check `chainId == block.chainid` — but OZ's `_hashTypedDataV4` DOES embed `block.chainid` into the digest itself (via `_domainSeparatorV4` → `_buildDomainSeparator`), so signature recovery on chain Y returns a different signer than the actual signer-on-chain-X, and the `recovered != owner` branch reverts.

Verified by reading `Toweli.sol:195-221`: ECDSA recovery + `recovered == owner` check. If chainIds differed, the recovered address would be wrong, branch falls through to `ERC2612InvalidSigner`.

### Recommendation
None. This is the canonical EIP-712 chain-binding behavior. Already correct.

---

## F-85-K3 — VoteIncentives / GaugeController commit-reveal: chainId binding present (Verified Safe)

**Severity:** None
**Files:**
- `VoteIncentives.sol:1487` — `keccak256(abi.encode(block.chainid, address(this), user, epoch, pair, power, salt))`
- `GaugeController.sol:447` — `abi.encode(block.chainid, address(this), voter, tokenId, gauges, weights, salt, epoch)`

Both commit hashes explicitly include `block.chainid + address(this)`. Even if both contracts are deployed identically on multiple chains, a commit submitted on chain A's contract cannot be replayed on chain B's contract — the preimage divergence guarantees a different hash, and the reveal step recomputes the hash with chain B's `block.chainid` and rejects.

The comments at `VoteIncentives.sol:1477-1478` and `GaugeController.sol:441-444` document the intent explicitly. Already audited in prior batches (NEW-I2, etc.).

---

## F-85-K4 — No nonceX / sequenceId concern (Confirmed N/A)

**Severity:** N/A
**Status:** Vacuously safe

There is no per-chain message sequence counter because there are no cross-chain messages. The only `nonce` in the codebase is:
- OZ `Nonces._useNonce(owner)` in Toweli for EIP-2612 (per-owner local nonce, not a cross-chain sequence).

The DropV2, Launchpad, NFTPool factories use a `salt` field in CREATE2 derivations (chain-bound as noted above). No sequenceId / Wormhole-style nonce pattern exists.

---

## F-85-K5 — Endpoint upgrade trust: N/A (Confirmed absent)

**Severity:** N/A
**Status:** Vacuously safe

No LayerZero endpoint, no Axelar gateway, no Wormhole core bridge, no CCIP router. There is no endpoint contract whose `setSendVersion` / `setReceiveVersion` / `forceResumeReceive` / library upgrade authority could be subverted to steal funds.

(Compare to e.g. LayerZero V1 OFTs where the deployer's `setTrustedRemote` permission is a high-value target — Tegriddy Farms doesn't have this surface.)

---

## Notes / Dead-ends pursued

1. **`SwapFeeRouter.sol:1902` "bridge term"** — initial concern this might be a cross-chain integration. Confirmed it's a Uniswap V2 TWAP idle-window mathematical bridge (`spot * elapsedSinceLastPairTouch`). Not cross-chain.

2. **`TegridyLending.sol:1600` "bridged feed"** — concern this might involve cross-chain price relay. Confirmed it's a comment about Chainlink feed clock skew (the AggregatorV3 feed's `updatedAt` may exceed `block.timestamp` on L2 if the answer was bridged from a parent chain). Already handled by `SequencerCheck.sol` directional underflow guards (lines 87, 137, 209, 284, 337). Not a cross-chain attack surface — purely defensive math against bridge-induced timestamp anomalies in oracle data.

3. **`Toweli.sol:40-47` "multi-chain bridge wrappers"** — concern this might indicate planned cross-chain logic in the contract. Confirmed it's NatSpec describing future derivatives (rebases / fork wrappers / OFT-like) that are intentionally OUT OF SCOPE for this contract. The `virtual` keyword on `permit()` is preserved for those future derivatives but they don't exist in this repo.

4. **`PremiumAccess.sol:218` "NFT transfers (marketplace listings, bridges, etc.)"** — concern this might be a bridge integration. Confirmed it's a comment about NFT escrow temporarily not equalling current ownership; no bridge code in this contract.

5. **Chainlink data on L2** — `SequencerCheck.sol` uses Chainlink's L2 sequencer uptime feed. This IS technically a cross-chain mechanism (Chainlink relays sequencer status from off-chain), but it's:
   - A read-only trusted oracle, not a message bus.
   - The trust assumption is Chainlink's, not ours.
   - Fully audited by prior batches (M4 4h staleness, etc.).
   - Not exploitable by replay since it's a one-way data feed with no signed payload we accept.

   Filed as out-of-scope for this lens.

6. **Drop merkle leaf chain-binding** — pursued the question "what if a drop is deployed via plain `new` instead of launchpad CREATE2?" Confirmed F-85-K1 reduces to operator-mistake, not exploit.

7. **EIP-712 chainId weakness** — pursued the canonical "EIP-712 domain has chainId as a value, not enforcement" concern. Confirmed OZ's `_hashTypedDataV4` correctly embeds `block.chainid` into the digest, signature recovery on a wrong-chain replay returns a different `recovered` and the permit reverts. Already correct.

---

## Format F-85-K Summary Table

| ID       | Severity | Title                                                          | File                                | Line(s)       | Status     |
|----------|----------|----------------------------------------------------------------|-------------------------------------|---------------|------------|
| F-85-K0  | Info     | No cross-chain messaging integration (defensive note)          | (entire codebase)                   | N/A           | Confirmed  |
| F-85-K1  | Info     | Drop leaf chain-bound via CREATE2 salt                         | TegridyDropV2.sol                   | 538-540       | Verified   |
| F-85-K2  | None     | Toweli permit chain-bound via EIP-712 domain                   | Toweli.sol                          | 149-220       | Verified   |
| F-85-K3  | None     | Commit-reveal hashes include `block.chainid`                   | VoteIncentives.sol, GaugeController.sol | 1487, 447 | Verified   |
| F-85-K4  | N/A      | No nonceX/sequenceId (no cross-chain msgs)                     | (entire codebase)                   | N/A           | Vacuous    |
| F-85-K5  | N/A      | No endpoint upgrade trust (no endpoint)                        | (entire codebase)                   | N/A           | Vacuous    |

**Cross-chain attack surface: zero.**
**Net actionable findings under this lens: zero.**
**Optional defense-in-depth (F-85-K1): add `block.chainid` to Drop leaf preimage; marginal value, NOT recommended unless leaf format is being changed for other reasons (would invalidate existing trees).**

---

*Agent 85 / 100 — fresh-eyes cross-chain lens. Read-only. No edits performed.*
