# Agent 34 — TegridyLaunchpadV2 Fresh-Eyes Audit

**Target:** `contracts/src/TegridyLaunchpadV2.sol` (~427 lines)
**Related:** `contracts/src/TegridyDropV2.sol`, `contracts/src/base/{OwnableNoRenounce,TimelockAdmin}.sol`
**Lens:** Clone deploy / init atomicity / CREATE2 salt / impl hijack / registry poisoning
**Date:** 2026-05-07

---

## Summary

Reviewed the click-deploy factory line by line under the listed lenses. The factory is unusually well-hardened — the deploy+init atomicity (single tx, no half-init clones), the `abi.encode` salt construction, the `_disableInitializers()` lock on the impl, the immutable `dropTemplate` address, and the `acceptOwnership` proposal-flush all directly address the high-impact attack classes in scope. CREATE2 salt structurally cannot collide cross-chain or cross-launchpad (chainid + address(this) baked in). The protocol-fee/recipient governance is timelocked with value-and-ETA binding (closed both DEEP-LP-04 and V2-LP-01). No open-permission-with-funds; no upgradeable proxy; no init-after-deploy gap.

**Findings on this pass: 0 exploitable.** Three observations of the "informational / scaling-limited / by-design" class — none let a third party hijack a clone, mint without paying, or steal protocol fees. The notes-section captures three additional dead-end leads that I traced and ruled out so future agents do not re-trace them.

---

## Findings

### F-34-K-01 — INFORMATIONAL — `getAllCollections()` is unbounded; no economic impact

**Severity:** Informational
**Lens:** Drop registry / pagination

**Observation.** Line 280-282 retains the unbounded `getAllCollections()` view. Per the inline NatSpec on lines 274-279 and the documented `MAX_PAGINATED_LIMIT = 1000` cap (line 94) on the paginated counterpart, this is acknowledged-deprecated behaviour. Past a few thousand collections the view will exceed Alchemy/Infura's 8MB JSON-RPC response cap and become uncallable.

**Impact.** None on-chain. Off-chain indexers that have not migrated to `getCollectionsPaginated` will silently break; new indexers should ignore this entry-point. No funds at risk.

**Status.** By design. Already documented as scaling-limited in DEEP-LP-03 fix.

---

### F-34-K-02 — INFORMATIONAL — `dropTemplate` immutability is a constitutional choice, not a vulnerability

**Severity:** Informational
**Lens:** Implementation upgrade path / swap-impl-mid-flight

**Observation.** `dropTemplate` is `immutable` (line 110), set ONCE in the constructor via `address(new TegridyDropV2())` (line 177). There is no setter, no proxy, no upgradeability mechanism. The "swap impl mid-flight breaks existing clones" attack class is structurally unreachable here — once the factory is deployed, the template address is constitutional.

**Impact.** Conversely, any bug in `TegridyDropV2` is permanent for every drop deployed off this factory; mitigation is forward-only (deploy a replacement factory). The inline AUDIT L-L03 comment (lines 99-109) calls this out explicitly. This is the standard Sudoswap / 0xSplits / Foundation design — it is the right trade-off for the "factory's identity IS the template's identity" invariant.

**Status.** Intentional design choice with a documented trade-off.

---

### F-34-K-03 — INFORMATIONAL — `protocolFeeBps == 0` is a permitted state at construction

**Severity:** Informational (initially flagged H, downgraded after re-reading)
**Lens:** Fee on deploy / who pays / can be 0

**Observation.** Constructor (lines 160-178) does not enforce `_protocolFeeBps > 0`. The validation is only `_protocolFeeBps > MAX_PROTOCOL_FEE_BPS` (line 169). A factory deployed with `_protocolFeeBps = 0` will create clones whose `platformFeeBps = 0`, and `TegridyDropV2.initialize` accepts this without revert (line 383: only `> MAX_PLATFORM_FEE_BPS` reverts).

**Impact.** None. A 0-bps protocol fee is a legitimate launch configuration (free-listing tier). The setter path (`proposeProtocolFee`) explicitly rejects `newFeeBps == protocolFeeBps` (line 316), so a 0→0 no-op is impossible and an upward move is timelocked. No exploitation surface — this is product policy, not a security bug.

**Status.** Working as intended.

---

## Notes / Dead-Ends Traced and Ruled Out

These leads were investigated and dropped. Recording them so future agents do not re-trace.

### N-34-A — CREATE2 salt front-run

**Lead.** Could an attacker observe a pending `createCollection(cfg)` in the mempool, copy `cfg`, and front-run it to mint at the predicted address?

**Resolution.** Salt construction (line 213-215):
```solidity
bytes32 salt = keccak256(
    abi.encode(block.chainid, address(this), msg.sender, allCollections.length, cfg.name, cfg.symbol)
);
```
The salt binds to `msg.sender`, so a front-runner with a different EOA computes a different salt and a different CREATE2 address — the predicted address the victim was targeting is reachable ONLY by the victim. `allCollections.length` further binds to the factory's monotonic state, so even self-replay across the same factory diverges. `block.chainid + address(this)` close cross-chain and cross-factory collisions. `abi.encode` (not `encodePacked`) eliminates the `("ab","c")` vs `("a","bc")` ambiguity for the dynamic-string fields. Ruled out.

### N-34-B — Drop registry poisoning

**Lead.** Can `collections[id]` / `allCollections[i]` be poisoned with an arbitrary contract address?

**Resolution.** The only writer to either storage variable is `createCollection` (lines 244-252). The `collection` value written is the return of `Clones.cloneDeterministic(dropTemplate, salt)` — a freshly-deployed clone of the immutable `dropTemplate`. There is no admin setter, no batch-import, no migration path that lets an arbitrary address enter the registry. Even an `onlyOwner` cannot inject a hostile address. Ruled out.

### N-34-C — Stuck deploy / partial state if init reverts

**Lead.** If `Clones.cloneDeterministic` succeeds but the subsequent `initialize` reverts (e.g. on `royaltyBps > MAX_ROYALTY_BPS`), is there a partially-created clone left at the predicted address that an attacker can then claim?

**Resolution.** Both calls happen inside the same `createCollection` external transaction (lines 217-242). A revert anywhere in `initialize` propagates up and the EVM reverts the ENTIRE transaction — including the `Clones.cloneDeterministic` deploy, the `allCollections.push`, the storage writes, and the events. Atomic by EVM transaction semantics. The clone simply does not exist post-revert. The predicted address is also bound to `msg.sender + allCollections.length`, so even if it did persist, no other actor could initialize at that address (they compute a different salt). Ruled out.

### N-34-D — `_disableInitializers` on the impl

**Lead.** Could an attacker call `initialize` directly on the canonical `dropTemplate` and freeze a permanent owner / mint config there, breaking future clone semantics?

**Resolution.** `TegridyDropV2.constructor()` (line 24-26) calls `_disableInitializers()` on the impl. Direct `initialize` calls on the template revert with `InvalidInitialization()`. Clones bypass the impl's storage entirely (delegatecall semantics), so the impl-locked initialization does not stop fresh clones from initializing. Standard OpenZeppelin Initializable pattern, correctly applied. Ruled out.

### N-34-E — ERC165 supportsInterface on the clone

**Lead.** Does the clone correctly report ERC721 + ERC2981 interfaces? A misreport would break marketplace integration but is not a security bug.

**Resolution.** `TegridyDropV2.supportsInterface` (lines 479-486) overrides both ERC721 and ERC2981 and `super.supportsInterface(interfaceId)` walks both parent chains. Correctly implemented. Out of scope for this lens regardless — informational only.

### N-34-F — Implementation upgrade path

**Lead.** Is there any path — owner-controlled, timelock-mediated, or otherwise — to swap `dropTemplate` after construction?

**Resolution.** None. `dropTemplate` is `immutable`. There is no `setDropTemplate`, no UUPS upgrade hook, no proxy. The factory itself is not behind a proxy either (no `Initializable` import, has a real constructor). The only "upgrade" path is "deploy a new factory" — by design (see F-34-K-02). Ruled out.

### N-34-G — Cross-salt clones with same params have same predictable address

**Lead.** Re-stated formally: if Alice and Bob both submit `createCollection` with identical `cfg`, do they end up at the same address (collision DoS)?

**Resolution.** No. Salt includes `msg.sender` AND `allCollections.length`. Different `msg.sender` → different salt → different address. Same `msg.sender` but consecutive calls → different `allCollections.length` → different salt → different address. Both axes of variation are non-controllable by an attacker (they cannot move the victim's `msg.sender`, and `allCollections.length` is monotonic factory state). Ruled out.

### N-34-H — Whitelist of allowed callers

**Lead.** `createCollection` is permissionless — any address can deploy a clone. Is that intended?

**Resolution.** Yes. This is a public click-deploy factory; the absence of a whitelist is the product. Each clone is owned by its `msg.sender` (line 248: `creator: msg.sender`), so the only thing a "spam" deployer can do is fill the factory's array with clones they own. No fee on deploy is collected (the fee is on MINT, not on DEPLOY), so the spam-cost is purely the deployer's gas. No funds at risk. Ruled out.

### N-34-I — ABI-encoded args size mismatch / wrong storage layout

**Lead.** Could a malformed `CollectionConfig` cause the inline `TegridyDropV2.InitParams({...})` struct construction (lines 220-241) to land in the wrong storage layout at the clone?

**Resolution.** Solidity 0.8.26 enforces strict struct-field name+type matching at compile time. The factory's `cfg` fields (struct on lines 133-148) are individually copied into the `InitParams` struct (lines 220-241) by name, with explicit per-field assignment — not a memcpy or a low-level call. Field count and types are verified by the compiler. No layout-mismatch surface. Ruled out.

### N-34-J — Pause bypass on execute paths

**Lead.** Could an attacker (or compromised owner) execute a queued fee/recipient change while the factory is paused?

**Resolution.** Both `executeProtocolFee` (line 345) and `executeProtocolFeeRecipient` (line 379) are gated by `whenNotPaused`. The DEEP-LP-02 fix is in place. The cancel paths (`cancelProtocolFee`, `cancelProtocolFeeRecipient`) are intentionally NOT pause-gated so a guardian can clear a hostile proposal queued by a now-compromised owner. Correctly architected. Ruled out.

### N-34-K — `acceptOwnership` proposal-flush race

**Lead.** Can the outgoing owner queue a hostile fee/recipient proposal at T-0, then transfer ownership to the new owner; the new owner accepts at T-47h59m, then at T-48h:01s the proposal becomes executable under the new owner's authority?

**Resolution.** `acceptOwnership` override (lines 414-426) flushes BOTH `_executeAfter[FEE_CHANGE]` and `_executeAfter[FEE_RECIPIENT_CHANGE]` and zeroes the pending values (`pendingProtocolFeeBps`, `pendingProtocolFeeRecipient`) at the moment of acceptance. Mirrors `TegridyDropV2.acceptOwnership` MERKLE_ROOT flush. No queue survives an ownership rotation. The DEEP-LP-01 fix is in place and complete. Ruled out.

### N-34-L — Re-init attempt on already-initialized clone

**Lead.** Could `createCollection` be called twice with the same params (same `msg.sender` + same name/symbol) such that the second call hits an already-deployed clone and re-initializes it with attacker-controlled fields?

**Resolution.** Two layers of defense:
1. The salt includes `allCollections.length`, which monotonically increases. A second call from the same `msg.sender` produces a DIFFERENT salt → different CREATE2 address → fresh, uninitialized clone.
2. Even if (1) somehow degenerated to the same address, `Clones.cloneDeterministic` reverts on `ERC1167FailedCreateClone` when CREATE2 collides with an existing contract — the EVM-level deploy check fires before `initialize` is even reached.
3. And as a third layer, `TegridyDropV2.initialize` carries the `initializer` modifier — re-entry reverts with `InvalidInitialization()`.

Triple-defended. Ruled out.

---

## Conclusion

`TegridyLaunchpadV2.sol` is one of the cleanest contracts in this codebase under the listed lenses. Every named attack class on the lens list has a structural defense already in place, and the inline AUDIT comments document the rationale behind each defense. I found nothing exploitable on this pass.

If a future agent finds a bug in this file, the highest-leverage place to look is NOT the factory itself — it is the propagated `InitParams` into `TegridyDropV2.initialize`. The factory faithfully forwards `msg.sender` as creator, the immutable `weth` and `sequencerFeed`, and the current (governed) `protocolFeeBps` / `protocolFeeRecipient`. Any vulnerability that lands in a fresh clone post-init is almost certainly a `TegridyDropV2.initialize` bug or a mint-path bug, not a factory bug.

**Net status: 0 actionable findings on TegridyLaunchpadV2 from this lens-set.**
