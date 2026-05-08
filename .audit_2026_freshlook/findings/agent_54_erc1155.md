# Agent 54/100 — ERC1155 / ERC721 Conflation Hunt

Lens: ERC1155 callbacks (onERC1155Received / Batch), confusion with ERC721, standard-conflation bugs.

Scope: All Solidity under `contracts/src/`.

---

## Executive summary

The Tegriddy protocol is purely ERC721-shaped. There are zero `ERC1155` / `IERC1155` / `onERC1155Received` references anywhere in `contracts/src/`. No contract implements `IERC1155Receiver`. No contract advertises 0xd9b67a26 (ERC1155) or 0x4e2312e0 (ERC1155Receiver) via supportsInterface.

Despite the absence of explicit ERC1155 plumbing, two surfaces accept attacker-supplied NFT contract addresses, and only one of the two enforces an ERC721 interface check. The other (TegridyNFTPoolFactory.createPool) accepts ANY contract — no ERC165 check, no rejection of ERC1155 — which opens a small catalog of standard-conflation footguns. None of them rise to a fund-loss break in isolation because every downstream call uses the strict ERC721 `safeTransferFrom(address,address,uint256)` selector that ERC1155 does not expose, but a pool created against an ERC1155-only contract is permanently bricked by design and bloats the per-collection 200-pool DoS cap; a pool created against a hybrid (ERC721+ERC1155) contract creates a token-id-namespace ambiguity that the pool's `_idToIndex` bookkeeping is not designed to handle.

The most likely real exposure is operational/UX: a user clicking through the launchpad's collection picker can deploy a pool for an ERC1155 collection that looks like an ERC721 from the outside — the factory will accept it, deploy a clone, and only fail when the user tries to seed liquidity. By that point the pool is registered in `isPool[]`, indexed in `_poolsByCollection[]`, and counts toward the 200-pool MAX_POOLS_PER_COLLECTION cap.

---

## Findings

### F-54-1 — TegridyNFTPoolFactory.createPool has zero ERC165 / ERC721 interface check (cf. TegridyNFTLending.proposeWhitelistCollection which DOES check 0x80ac58cd)

**File:** `contracts/src/TegridyNFTPoolFactory.sol:194-278`
**Function:** `createPool(address nftCollection, ...)`
**Severity:** Low–Medium (operational / DoS surface; not direct fund loss)

**The conflation:**
The factory permits *any* contract to be passed as `nftCollection`. Validation is limited to:

```
if (nftCollection == address(0)) revert ZeroAddress();
require(nftCollection.code.length > 0, "NOT_CONTRACT");
```

There is no `IERC165(nftCollection).supportsInterface(0x80ac58cd)` check, no rejection of ERC1155 (0xd9b67a26), and no rejection of contracts that implement BOTH. Compare the sister contract:

`contracts/src/TegridyNFTLending.sol:1029` — `proposeWhitelistCollection` DOES gate on:
```solidity
try IERC165(_collection).supportsInterface(0x80ac58cd) returns (bool ok) {
    require(ok, "NOT_ERC721");
} catch { /* pre-ERC165 fall-through */ }
```

The asymmetry between the two sibling NFT-accepting contracts is a fix-distribution gap. NFTPoolFactory is permissionless (anyone can call createPool — no whitelist), so the lack of an interface check is more impactful here than on NFTLending where the lender's whitelist-entry path is admin-gated.

**Exploit shapes (each a separable LOW):**

1. **Pure ERC1155 passed as `nftCollection`:**
   - `createPool` succeeds with no ETH, no initial token IDs (just `msg.value >= MIN_DEPOSIT`).
   - The factory deploys + initializes a `TegridyNFTPool` clone with `nftCollection = IERC721(<ERC1155 address>)`.
   - Pool is now permanently dead: every `swapETHForNFTs` / `swapNFTsForETH` / `addLiquidity` call invokes `nftCollection.safeTransferFrom(address,address,uint256)` (3-arg ERC721 selector 0x42842e0e), which the ERC1155 contract does not implement → revert.
   - Pool consumes one of the 200 `MAX_POOLS_PER_COLLECTION` slots permanently, distorts `getPoolsForCollection` enumeration, and pollutes any router that does best-price discovery across this collection.
   - Cost to attacker: one `createPool` call with `MIN_DEPOSIT = 0.05 ETH` (recoverable later via `removeLiquidity`'s ETH path) → effectively just gas.
   - **Spam vector:** repeat the call N×200 against N target ERC1155 collections to brick router enumeration on every one. Pre-existing MAX_POOLS_PER_COLLECTION cap was meant to bound the legitimate-collection spam (LOOP-01); the ERC1155 channel side-steps that bound by using collections where MAX is meaningful but every pool is dead.
   - The `MIN_DEPOSIT || initialTokenIds.length > 0` guard means `initialTokenIds=[X]` would let an attacker skip MIN_DEPOSIT, BUT the safeTransferFrom-on-ERC1155 reverts so they need the MIN_DEPOSIT path.

2. **Hybrid ERC721 + ERC1155 contract passed:**
   - Many real-world NFT contracts (Manifold, OpenSea Lazy Mint Adapter, certain wrapper deployments) advertise both `0x80ac58cd` and `0xd9b67a26`.
   - Token IDs in such hybrid contracts can collide between the ERC721 leg and the ERC1155 leg — the same `tokenId` integer can refer to one ERC721 NFT (single owner) AND one ERC1155 fungible bucket (multiple owners with various amounts).
   - The pool's `nftCollection.safeTransferFrom(address,address,uint256)` 3-arg call resolves to the ERC721 leg, but `nftCollection.ownerOf(tokenId)` (used in `syncNFTs` at line 694) ALSO resolves to the ERC721 leg — the ERC1155 leg is never reachable through the pool's external surface, so the bookkeeping stays internally consistent.
   - **However:** a malicious hybrid contract could implement `ownerOf` to return `address(this)` (the pool) for tokenIds the pool never received via the ERC721 leg, and then have its ERC1155 `safeTransferFrom` call the pool's `onERC721Received` (the pool only checks `msg.sender == address(nftCollection)`, line 783). The pool's `onERC721Received` would `_addHeldId(tokenId)` for a tokenId that does not actually exist on the ERC721 leg. The pool would then attempt to sell a phantom NFT — `swapNFTsForETH` would revert on the ERC721 `safeTransferFrom(this, msg.sender, tokenId)`, but the buyer side `swapETHForNFTs` would CHARGE the buyer for the phantom and then revert during the transfer-out, returning the ETH.
   - **Net result:** for a hybrid-collection pool, the attacker can keep `_heldIds` perpetually polluted with phantom IDs, distorting `_minLiquidityBuffer`-style bonding-curve invariants that depend on `_heldIds.length` — see `TegridyNFTPool.sol` `_minLiquidityBuffer` referenced at line 423/657. Each phantom inflates the buffer requirement, possibly bricking legitimate `withdrawETH` / `removeLiquidity` paths. Recovery requires `syncNFTs(tokenIds)` ON the phantom IDs — which the malicious hybrid can keep returning `current == address(this)` for, defeating the cleanup.
   - This requires a whitelisted-but-malicious hybrid collection, and the factory has no whitelist. So in practice this is a "victim deploys a pool for a malicious hybrid the attacker promotes to them" lure.

**Fix:**
Add ERC165 preflight identical to NFTLending's:
```solidity
try IERC165(nftCollection).supportsInterface(0x80ac58cd) returns (bool ok) {
    require(ok, "NOT_ERC721");
} catch { /* pre-ERC165 ERC721 — allow */ }
// And explicitly reject ERC1155:
try IERC165(nftCollection).supportsInterface(0xd9b67a26) returns (bool is1155) {
    require(!is1155, "IS_ERC1155");
} catch {}
```

The "and ALSO reject hybrid" guard is the meaningful new piece vs NFTLending — NFTLending's check is a bare `require(ok)` that PASSES on hybrid (since hybrid does claim 0x80ac58cd).

---

### F-54-2 — TegridyNFTPool.onERC721Received accepts deposits identified only by `msg.sender == address(nftCollection)`; under a hybrid ERC721+ERC1155 collection, ERC1155 transfer hooks can re-enter via the same address

**File:** `contracts/src/TegridyNFTPool.sol:777-801`
**Function:** `onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)`
**Severity:** Low (requires malicious hybrid + factory ingestion via F-54-1)

**The conflation:**
The pool's `onERC721Received` is the only authentication boundary for inbound NFT deposits. It checks:
- `msg.sender == address(nftCollection)` (the configured ERC721)
- One of: `operator ∈ {owner, address(this), factory}` OR `_swapInFlight && from == _swapCaller`

There is no separate `onERC1155Received` / `onERC1155BatchReceived` implementation. By the ERC1155 standard (EIP-1155), a contract that does NOT advertise `IERC1155Receiver.onERC1155Received.selector` MUST reject inbound `safeTransferFrom`/`safeBatchTransferFrom` calls — but the rejection happens in the SENDER's safeTransfer wrapper, not at the pool. A hybrid collection's ERC1155 leg COULD bypass this by:
- Using a non-`safe` `transferFrom` entrypoint (no receiver check). Standard ERC1155 has only `safeTransferFrom`/`safeBatchTransferFrom`, but a hostile hybrid is free to add a non-standard `unsafeTransferFrom` that simply calls `pool.onERC721Received(...)` directly with a 4-byte calldata that LOOKS like an ERC721 callback.
- The pool sees `msg.sender == address(nftCollection)` (true — same hybrid contract address), accepts the deposit, calls `_addHeldId(tokenId)`.

The collection then tells the pool "you own tokenId X" via its ERC721 `ownerOf` (which the hybrid can answer arbitrarily for fake tokens).

**Exploit:**
This is the same engine as F-54-1's hybrid attack, escalated. The `_swapInFlight && from == _swapCaller` branch is particularly interesting: during a buy-back swap (`swapNFTsForETH`), the seller's `onERC721Received` is set as `_swapCaller`. If the seller IS the hybrid collection (i.e. `_swapCaller = nftCollection`), the gate at line 795-796 reduces to `_swapInFlight && from == address(nftCollection)`, and the hybrid collection's hook can itself re-enter `onERC721Received` to inject phantom tokenIds bypassing the explicit `authorizedOperator` allowlist.

In practice this is hard to trigger because the seller is `msg.sender` of `swapNFTsForETH`, and a contract calling `swapNFTsForETH` from inside its own ERC1155 hook is contrived. But the absence of an explicit "is this an ERC1155-shaped re-entry?" check leaves the surface non-zero.

**Fix:**
Pair F-54-1's interface check (which prevents ERC1155 contracts from being deployed at all) with an explicit `onERC1155Received` / `onERC1155BatchReceived` that REVERTS — so a future ABI-level confusion attack (e.g. through a router calling `safeBatchTransferFrom` against the pool) reverts loudly rather than silently.

```solidity
function onERC1155Received(address, address, uint256, uint256, bytes calldata)
    external pure returns (bytes4) { revert("ERC1155_NOT_SUPPORTED"); }
function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
    external pure returns (bytes4) { revert("ERC1155_NOT_SUPPORTED"); }
```

This is defense-in-depth; without it, the lack of the receiver simply means inbound `safeTransferFrom` from a well-behaved ERC1155 sender reverts with an unhelpful "NO_RECEIVER" error code that off-chain monitors don't easily classify.

---

### F-54-3 — TegridyTokenURIReader.tokenURI(id) is ERC721-only by design; if an indexer/marketplace mistakes the staking NFT for ERC1155 and queries `uri(id)` it will get a 4-byte revert with no metadata fallback

**File:** `contracts/src/TegridyTokenURIReader.sol:41-84`
**Function:** `tokenURI(uint256 tokenId)`
**Severity:** Informational

**The conflation:**
ERC721's metadata is queried via `tokenURI(uint256)` (selector `0xc87b56dd`). ERC1155's metadata is queried via `uri(uint256)` (selector `0x0e89341c`). The staking NFT is pure ERC721 (Solady-derived, see `TegridyStaking.sol:1397`'s `tokenURI` override) — the URI reader correctly mirrors that.

But `TegridyTokenURIReader` is NOT registered as the staking NFT's authoritative metadata source on-chain (it's a separate contract — staking returns `""` from `tokenURI`, see `TegridyStaking.sol:1397-1399`, and frontends know to read the URI reader instead). Indexers that follow EIP-721 strictly will query the staking NFT's `tokenURI(id)` and get an empty string; indexers that follow EIP-1155 (e.g. an ERC1155-aware marketplace that received a transfer event and falls back to `uri()` when `tokenURI()` is empty) will get a "function selector not found" revert from the staking NFT.

**Exploit:** none direct. UX-only — secondary marketplaces may show staking position NFTs with broken metadata if their resolver heuristics are 1155-first. The mitigation is documented in the URI reader comments (line 51-57) and is not a bug.

**Note:** The reader does NOT implement `uri(uint256)` (the ERC1155 metadata getter). If a future contributor adds an ERC1155 receiver elsewhere (e.g. for a new product line), this reader cannot be re-used as-is for ERC1155 metadata; it will need a sibling `uri()` function that maps to the same SVG/JSON synthesis.

---

### F-54-4 — Conflation surface check: TegridyRestaking, TegridyStakingJbacVault, TegridyStaking are all clean

**Files:**
- `contracts/src/TegridyRestaking.sol:2119-2122` — `onERC721Received` properly gated to `msg.sender == address(staking)` (the tsTOWELI staking NFT). Reverts on any other inbound NFT.
- `contracts/src/TegridyStakingJbacVault.sol:124-131` — `onERC721Received` properly gated to `msg.sender == address(jbacNFT)`. Reverts on any other inbound NFT.
- `contracts/src/TegridyStaking.sol:1401-1406` — IERC721Receiver intentionally REMOVED (post-batch-14); JBAC custody moved to vault. Solady's base `supportsInterface` (ERC165 + ERC721 + ERC721Metadata) is the only response set. No ERC1155 interface advertised, no ERC1155 receiver function. Clean.

No ERC1155 confusion possible on these paths; the `address staking`/`address jbacNFT` checks are immutable, set at deploy time, not address-typed for ERC1155.

---

### F-54-5 — TegridyNFTLending.proposeWhitelistCollection enforces ERC165(0x80ac58cd) but does NOT explicitly reject ERC1155 — hybrid (both 721+1155) collections pass

**File:** `contracts/src/TegridyNFTLending.sol:1019-1033`
**Function:** `proposeWhitelistCollection(address _collection)`
**Severity:** Informational (admin-gated; lender-side path also requires ownerOf which would resolve to the ERC721 leg)

**The conflation:**
The whitelist gate at line 1029 reads:
```solidity
try IERC165(_collection).supportsInterface(0x80ac58cd) returns (bool ok) {
    require(ok, "NOT_ERC721");
} catch { /* pre-ERC165 fall-through */ }
```

This passes for any contract that advertises ERC721 — including hybrids that ALSO advertise ERC1155. There is no "and not 1155" guard.

**Exploit:**
Lending's downstream surface is well-protected — `IERC721(_collateralContract).ownerOf(_tokenId)` at line 432 (createOffer) and 546 (acceptOffer) routes to the ERC721 leg, and the post-condition `IERC721(collateralContract).ownerOf(_tokenId) != address(this)` at line 589 (acceptOffer) catches no-op transfers. For a pure-hybrid collection where the ERC721 leg behaves correctly, lending stays consistent.

The only residual concern is if a hybrid's ERC721 leg were structured so that `tokenId X` exists on the ERC1155 leg as a fungible bucket but NOT on the ERC721 leg. The lender's createOffer would revert at `ownerOf` (no ERC721 token X) — so the offer never gets created. Safe.

**Fix:** Optional — add explicit `require(!supportsInterface(0xd9b67a26), "IS_HYBRID")` to surface the asymmetry to admins, but this would block legitimate hybrid collections (some of which do ship safely). Leave as-is + document.

---

### F-54-6 — Drop / Launchpad are ERC721-only by design; no ERC1155 mint primitive

**Files:**
- `contracts/src/TegridyDropV2.sol:21` — `contract TegridyDropV2 is ERC721("", ""), ERC2981, ...` — pure OZ ERC721. `supportsInterface` at line 479-486 returns ERC721 + ERC2981 only.
- `contracts/src/TegridyLaunchpadV2.sol:177` — `dropTemplate = address(new TegridyDropV2());` — only deploys ERC721 clones.

No ERC1155 surface here. If the protocol ever adds an ERC1155 drop variant, this asymmetry would need a separate launchpad path. Documented in launchpad lines 96-109 ("templates are constitutional" / forward-only).

---

## Notes / dead-ends

1. **Token-id namespace overlap on hybrid 721/1155 contracts** — explored at length in F-54-1 / F-54-2. The overlap can produce phantom-id pollution in `TegridyNFTPool._heldIds`, but the gating at `onERC721Received` (line 783) — combined with ERC1155's standard requirement that senders use `safeTransferFrom`/`safeBatchTransferFrom` — means a well-behaved ERC1155 sender will never reach the pool's hook. The attack requires a hostile hybrid collection that intentionally calls the pool's `onERC721Received` directly (non-standard).

2. **`SafeERC721Call.safeTransferFromBounded`** at `contracts/src/lib/SafeERC721Call.sol` uses ERC721's 3-arg `transferFrom(address,address,uint256)` selector 0x23b872dd. ERC1155 has no equivalent at this selector — calls to a pure ERC1155 will revert at the dispatch table. Hybrid contracts could implement this selector but route to ERC1155 internal storage; that's the F-54-1 / F-54-2 surface.

3. **ERC1155 batch transfer hook re-entry** — not applicable. No contract in `contracts/src/` implements `onERC1155BatchReceived`. Inbound batch transfers to any Tegriddy contract revert at the sender's `safeBatchTransferFrom` wrapper because no Tegriddy contract advertises the ERC1155Receiver interface (0x4e2312e0). Defense is implicit (absence) not explicit (revert) — see F-54-2's recommendation to add explicit reverts.

4. **ERC721 vs ERC1155 supportsInterface discrimination** is implemented ONCE in the codebase (TegridyNFTLending:1029, ERC721-positive). It is missing from TegridyNFTPoolFactory.createPool. There is no positive ERC1155 detection anywhere.

5. **PremiumAccess uses `IERC721(jbacNFT).balanceOf(user)`** — the selector overlaps with ERC1155's `balanceOf(address,uint256)` only at the function name; the ABI signatures differ. JBAC is hardcoded as ERC721 at deploy time so no swap is possible. Clean.

6. **GaugeController, VoteIncentives, CommunityGrants, RevenueDistributor, etc.** — all interact with the staking NFT exclusively (immutable `staking` reference, ERC721-only). No conflation surface.

7. **`onERC721Received` in TegridyRestaking has the `from` parameter unused** — does not gate on `from == address(this)` for the JBAC-deposit case. But staking is the only allowed inbound `msg.sender` (line 2120), so this is correctly scoped.

---

## Summary table

| ID | File:line | Function | Severity | Status |
|----|-----------|----------|----------|--------|
| F-54-1 | TegridyNFTPoolFactory.sol:194-278 | createPool | Low–Medium | Real gap (no ERC165 check) |
| F-54-2 | TegridyNFTPool.sol:777-801 | onERC721Received (no 1155 receiver siblings) | Low | Defense-in-depth |
| F-54-3 | TegridyTokenURIReader.sol:41-84 | tokenURI (no uri() sibling) | Informational | Documented |
| F-54-4 | Restaking/JbacVault/Staking | various | Clean | OK |
| F-54-5 | TegridyNFTLending.sol:1019-1033 | proposeWhitelistCollection (admin-gated) | Informational | OK |
| F-54-6 | TegridyDropV2.sol / Launchpad | architecture | Clean | OK |

## Top recommendation

Add an ERC165 supportsInterface(0x80ac58cd) gate to `TegridyNFTPoolFactory.createPool` at line 207 (after the `code.length > 0` check). This closes the only meaningful conflation surface — the permissionless pool-factory entrypoint — and brings it into parity with the admin-gated whitelist path on the sister NFTLending contract.

Optionally pair with explicit reverting `onERC1155Received` / `onERC1155BatchReceived` on `TegridyNFTPool` for defense-in-depth and clearer off-chain monitor classification.
