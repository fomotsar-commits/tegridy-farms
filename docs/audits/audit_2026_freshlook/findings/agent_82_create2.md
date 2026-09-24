# Agent 82 — CREATE2 / Factory Salt Collisions / Init Front-Running

**Lens:** CREATE2 deployment paths, factory salts, clone address prediction, init front-running.
**Scope:** All Solidity in `contracts/src/`.
**Date:** 2026-05-07.

## Inventory of CREATE2 / `cloneDeterministic` deployment sites

| # | File:line | Mechanism | Salt computation |
|---|-----------|-----------|------------------|
| 1 | `contracts/src/TegridyFactory.sol:194-197` | inline-asm `create2` of `TegridyPair` creationCode | `keccak256(abi.encode(block.chainid, address(this), token0, token1))` |
| 2 | `contracts/src/TegridyNFTPoolFactory.sol:229-239` | OZ `Clones.cloneDeterministic` of `poolImplementation` | `keccak256(abi.encodePacked(block.chainid, address(this), msg.sender, _allPools.length, nftCollection, uint8(_poolType)))` |
| 3 | `contracts/src/TegridyLaunchpadV2.sol:213-217` | OZ `Clones.cloneDeterministic` of `dropTemplate` | `keccak256(abi.encode(block.chainid, address(this), msg.sender, allCollections.length, cfg.name, cfg.symbol))` |
| 4 | `contracts/src/TegridyFeeHook.sol:207-229` (deployment external — Arachnid) | External CREATE2 via Arachnid deterministic deployer for V4 hook bit-pattern | Off-chain salt-mined; constructor takes explicit `_owner` |
| 5 | `contracts/src/Toweli.sol:88-…` (deployment external — Arachnid) | External CREATE2 for vanity-prefix token deploy | Off-chain salt-mined; constructor takes explicit `recipient` |

`Clones for address` is imported in `TegridyNFTPoolFactory.sol:23`; `Clones` is imported in `TegridyLaunchpadV2.sol:4`. No other deterministic-deploy primitives in scope (no `LibClone`, no `Create2.deploy`, no `predictDeterministicAddress`).

Commit-reveal salts in `GaugeController.sol:438` and `VoteIncentives.sol:1485` are NOT CREATE2 salts — they are commitment hashes for governance vote privacy and bind to chainid + contract + voter. Out of scope for this lens; verified well-formed (chainid + address(this) + caller all present).

---

## Per-vector analysis

### 1. Salt includes address(this), msg.sender, nonce, chainId?

| Site | chainid | address(this) | msg.sender | counter | type-discriminant | result |
|------|---------|---------------|------------|---------|-------------------|--------|
| TegridyFactory | yes | yes | no (token0/token1 only) | no | n/a | OK — single pair per token-pair is the protocol invariant; `getPair[t0][t1] != 0` revert at `TegridyFactory.sol:183` enforces uniqueness atomically |
| TegridyNFTPoolFactory | yes | yes | yes | yes (`_allPools.length`) | yes (`uint8(_poolType)`) | OK — full creator+counter+collection binding |
| TegridyLaunchpadV2 | yes | yes | yes | yes (`allCollections.length`) | yes (name/symbol via `abi.encode`) | OK — `abi.encode` (not packed) over dynamic strings closes the encodePacked-collision class explicitly per inline comment |

All three on-chain CREATE2 sites are properly chain-pinned (chainid in salt) and factory-pinned (`address(this)` in salt). **No predictable-salt vulnerability.**

### 2. Counter-based salt cross-chain collision

Each factory uses `_allPools.length` / `allCollections.length` / `allPairs.length` style counters. Because **chainid is also in the salt**, two chains with the same factory address and the same counter value still produce different addresses. The counter alone is not load-bearing for cross-chain isolation — it only serves to differentiate same-creator same-config repeat-calls within one chain.

Verified: cross-chain replay impossible.

### 3. Front-run deploy: attacker mines salt to grab the address

The attacker would need to deploy a contract at the factory's predicted CREATE2 address ahead of the factory's call. CREATE2 address = `keccak256(0xff || deployer || salt || keccak(initcode))[12:]`, where `deployer` is the calling contract. For all three on-chain factories, **the deployer in the CREATE2 hash is the factory contract itself, not an EOA the attacker controls**. The attacker cannot deploy from the factory's address (only the factory's bytecode can call CREATE2 from its address). Squatting via plain CREATE/CREATE2 from any other deployer lands at a different address.

Verified: not viable.

### 4. Front-run init: deploy without atomic init

| Site | Deploy + init in same external call? | Init access-controlled? |
|------|--------------------------------------|--------------------------|
| TegridyFactory | yes (`createPair` calls `TegridyPair.initialize` on line 200 immediately after CREATE2 on 196) | yes — `TegridyPair.initialize` requires `msg.sender == factory` (`TegridyPair.sol:104`); `factory` is set in the pair's constructor to `msg.sender`, which is the factory by definition (constructor runs during CREATE2) |
| TegridyNFTPoolFactory | yes (`createPool` calls `TegridyNFTPool(pool).initialize(...)` on line 245 immediately after `cloneDeterministic` on line 239) | OZ `initializer` modifier on `TegridyNFTPool.initialize` (`TegridyNFTPool.sol:229`) — but **no caller-address check**. Atomicity in the same external transaction prevents any attacker from squeezing an `initialize()` call between deploy and the factory's own `initialize` call. |
| TegridyLaunchpadV2 | yes (`createCollection` calls `TegridyDropV2(collection).initialize(...)` on line 219 immediately after `cloneDeterministic` on line 217) | OZ `initializer` modifier on `TegridyDropV2.initialize` (`TegridyDropV2.sol:377`) — no caller check, but atomicity holds. |

Both NFTPool and DropV2 implementation contracts call `_disableInitializers()` in their constructors (`TegridyNFTPool.sol:215-217`, `TegridyDropV2.sol:24-26`) so the implementation itself cannot be initialized by a hostile actor. Clones are initialized atomically. **No init front-run window.**

### 5. Same salt re-use after redeploy

CREATE2 redeploy at the same address requires `selfdestruct` of the prior contract. Grep across `contracts/src/` for `selfdestruct` finds zero call sites in deployable code (only NatSpec mentions in `RevenueDistributor.sol:310`, `TegridyDropV2.sol:229`, `TegridyDropV2.sol:965`, all describing forced-ETH receipt mitigations).

Verified: not viable.

### 6. Salt mining for vanity address — attacker mines own salt, forces collision

For `TegridyFeeHook` (`contracts/src/TegridyFeeHook.sol:223`), V4 requires the hook address to satisfy `uint160(address(this)) & 0x3FFF == 0x0044`. Salt mining is REQUIRED by design. The hook constructor takes `_owner` as an explicit arg (line 207), so the bytecode (which includes constructor args in CREATE2's initcode) differs for any attacker substituting their own owner address — different bytecode → different CREATE2 hash → different address. The attacker cannot grab the legitimate-owner's mined address with a hostile owner.

Same posture for `Toweli` (`contracts/src/Toweli.sol:88`): `recipient` is a constructor arg, bound into initcode. **No vanity-collision attack.**

### 7. Cross-chain replay of CREATE2 deploy

Already covered in #1 and #2 — all three on-chain factory salts include `block.chainid`. External Arachnid deploys for the hook and Toweli are off-chain operations and are not replay-relevant (a deployer can run the same script on any chain and accept the resulting same address as a feature, not a bug, since these are immutable-ownerless / constructor-pinned tokens).

---

## Findings

### F-82-1: NOTE — `TegridyNFTPoolFactory` salt uses `abi.encodePacked` while `TegridyLaunchpadV2` uses `abi.encode`

**File:** `contracts/src/TegridyNFTPoolFactory.sol:229-238`
**Severity:** Informational (no exploit)
**Status:** SAFE — verified

The Launchpad inline comment (`TegridyLaunchpadV2.sol:196-207`) explicitly motivates the `encode` choice as collision-safety because `name`/`symbol` are dynamic strings. The NFTPoolFactory uses `encodePacked`, but every salt component is fixed-width — `block.chainid` (uint256, 32 bytes), `address(this)` (20 bytes), `msg.sender` (20 bytes), `_allPools.length` (uint256, 32 bytes), `nftCollection` (20 bytes), `uint8(_poolType)` (1 byte). With no dynamic types in the tuple, encodePacked is collision-safe (Solidity docs: "If you use keccak256(abi.encodePacked(a, b)) and both a and b are dynamic types, it's easy to craft collisions… If you only use one dynamic type, ambiguity does not arise"). All operands here are fixed-width primitives, so the encoding is unambiguous.

**No fix required.** The asymmetry between the two factories is documentation-only — both salts are collision-safe.

### F-82-2: NOTE — `TegridyFactory` salt does NOT include `msg.sender`, intentionally

**File:** `contracts/src/TegridyFactory.sol:194`
**Severity:** Informational
**Status:** SAFE — by design

`createPair` is permissionless and the protocol invariant is "exactly one pair per (token0, token1) tuple, regardless of who calls first." The `getPair[token0][token1] != 0` check at `TegridyFactory.sol:183` enforces that invariant atomically. Excluding `msg.sender` from the salt makes the pair address a deterministic function of the tuple — the desired Uniswap-V2-parity property. A front-runner who mines `(token0, token1)` to produce a particular pair address would deploy the legitimate pair (TegridyPair bytecode is fixed and bound by `type(TegridyPair).creationCode` + the salt), so the "front-run" outcome is identical to the legitimate outcome.

**No fix required.**

### F-82-3: NOTE — `TegridyFeeHook` deployed via Arachnid; constructor takes explicit `_owner` (Wave-0 fix)

**File:** `contracts/src/TegridyFeeHook.sol:199-229`
**Severity:** Informational
**Status:** SAFE — verified after Wave-0 redeploy

V4 hook bit-pattern enforcement (`require(uint160(address(this)) & 0x3FFF == 0x0044)`, line 223) requires CREATE2 salt mining. The constructor takes `_owner` explicitly (line 207) rather than capturing `msg.sender`, defending against the known Arachnid-proxy footgun where deploying via the canonical deterministic deployer would otherwise strand ownership on the proxy address. **Constructor-args are part of the CREATE2 initcode, so any attacker substituting their own owner produces a different mined address.** Cannot front-run the legitimate owner.

**No fix required.**

### F-82-4: NOTE — Implementation contracts call `_disableInitializers()` in constructor

**Files:**
- `contracts/src/TegridyNFTPool.sol:215-217`
- `contracts/src/TegridyDropV2.sol:24-26`

**Status:** SAFE — verified

Both clone-template contracts disable initialization on the master implementation, eliminating the "uninitialized implementation hijack" class (well-known OZ Initializable footgun pre-4.7 / re-emerging via clone + `selfdestruct(initialize(attackerOwner))` patterns).

**No fix required.**

### F-82-5: NOTE — `createCollection` not marked `nonReentrant`, but no reentrancy surface

**File:** `contracts/src/TegridyLaunchpadV2.sol:185`
**Severity:** Informational
**Status:** SAFE — verified

`createCollection` does not have `nonReentrant`. The only external call during the function body is to `TegridyDropV2(collection).initialize(...)` (line 219). `TegridyDropV2.initialize` (lines 377-…) only writes internal state; no external calls. Reentrancy via the initialize path back into `createCollection` is therefore impossible. Compare: `TegridyNFTPoolFactory.createPool` IS marked `nonReentrant` (line 201) because it transfers NFTs (which can callback via `onERC721Received`).

**No fix required.**

---

## Dead-ends and counter-checked vectors

- **EIP-1167 minimal-proxy initcode-hash collision:** The minimal-proxy initcode includes the implementation address, which differs per factory (Launchpad's `dropTemplate` vs. NFTPoolFactory's `poolImplementation`). No initcode-hash overlap between factories. Implementation addresses are recorded as `immutable` (Launchpad) or constructor-set (NFTPoolFactory). Confirmed isolated.
- **CREATE2 collision via differing initcode at same salt:** Factory-deployed via internal `cloneDeterministic` cannot mix initcodes; each factory only deploys one template type. Confirmed N/A.
- **`Clones.predictDeterministicAddress` exposure:** Not exposed externally; no `predictDeterministicAddress` calls anywhere in `contracts/src/` (verified via grep). External integrators that want to predict pool/drop addresses must derive the salt themselves. Acceptable.
- **`SwapFeeRouter.sol:1108-1111` and `:1750-1756` references to CREATE2:** NatSpec only — discussing pendingDistribution recipient survivability against `selfdestruct + CREATE2 redeploy` of arbitrary external addresses, not a CREATE2 site within this codebase. Out of scope for this lens.
- **`TegridyRouter.sol:507-510`:** The router does NOT use CREATE2 prediction (uses `factory.getPair` lookup instead, decoupling from initcode hash). Avoids the `init code hash hardcode bites you on bytecode change` footgun.
- **`block.chainid` correctness across forks:** EIP-1344 — chainid changes on hardfork → all three factory salts naturally re-derive after a chain split. Acceptable.
- **Counter wraparound:** `_allPools.length` / `allCollections.length` / `allPairs.length` are uint256; `MAX_PAIRS` (TegridyFactory) and `MAX_POOLS_PER_COLLECTION = 200` (NFTPoolFactory) are far below 2^256. No wraparound.

---

## Summary

**0 exploitable findings on the CREATE2 / factory-salt / init-frontrun lens.**

All three on-chain CREATE2 deployment sites (`TegridyFactory`, `TegridyNFTPoolFactory`, `TegridyLaunchpadV2`) properly bind:
- `block.chainid` → cross-chain replay impossible
- `address(this)` → multi-factory-on-same-chain isolated
- `msg.sender` (except `TegridyFactory`, where the protocol invariant is "single pair per token-pair") → cross-creator squatting blocked
- a counter (`_allPools.length` / `allCollections.length`) → repeat-call collision blocked
- type-discriminating fields (collection/poolType, name/symbol, token0/token1) → semantically-distinct deploys land at distinct addresses

Deploy-and-initialize is atomic in every site. Implementation contracts call `_disableInitializers()`. Constructor-arg-bound external CREATE2 deploys (`TegridyFeeHook`, `Toweli`) defend against vanity-address-mining hijack via owner/recipient-as-constructor-arg.

Five informational NOTEs (`F-82-1` through `F-82-5`) document non-issues for future-auditor reference. None require code changes.
