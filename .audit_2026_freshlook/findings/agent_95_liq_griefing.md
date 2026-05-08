# Agent 95 — Liquidity Griefing Fresh-Eyes Audit

**Lens:** Range manipulation, pool starvation, dust attacks, spam fund-wasters.
**Targets:** All swap/pool/lending contracts.
**Date:** 2026-05-07
**Method:** Fresh-eyes read; no audit history consulted.

---

## Executive Summary

Tegriddy Farms has substantial defensive depth vs prior griefing waves: MIN_INITIAL_TOKENS gate at 1000 raw units + 1000× MINIMUM_LIQUIDITY in `TegridyPair.mint`, `MAX_PAIRS = 10000` cap on `TegridyFactory`, `MAX_POOLS_PER_COLLECTION = 200` + `MIN_DEPOSIT = 0.05 ether` on NFT pool factory, `minPrincipal = 0.001 ether` on both lending contracts, and per-token `minBribeAmounts` on VoteIncentives. The highest-impact remaining surfaces are: (1) NO cap on Launchpad collection registry and (2) NO cap on TegridyLending/NFTLending offers list, both of which are O(n)-enumeration-amplified. A handful of medium and low findings cover keeper gas-griefing, dust-WETH accumulation, and direct-NFT-deposit recovery gaps.

---

## F-95-K-1 (HIGH) — TegridyLaunchpadV2 unbounded `allCollections` registry, free createCollection

**File:** `contracts/src/TegridyLaunchpadV2.sol:185-263`

```solidity
function createCollection(CollectionConfig calldata cfg)
    external
    whenNotPaused
    returns (uint256 id, address collection)
{
    // ... no fee, no MIN_DEPOSIT, no MAX_COLLECTIONS cap ...
    collection = Clones.cloneDeterministic(dropTemplate, salt);
    TegridyDropV2(collection).initialize(...);
    id = allCollections.length;
    collections[id] = CollectionInfo({...});
    allCollections.push(collection);
}
```

**Grief vector:** `createCollection` is permissionless, payment-free, and has NO ceiling on `allCollections.length`. Every call:
- Clones the `dropTemplate` (CREATE2 deploy ≈ 200k gas per pool, but attacker pays only their gas — protocol pays nothing).
- Pushes onto unbounded `allCollections[]`.
- Stores a 5-field `CollectionInfo` struct (≥ 5 SSTOREs).
- Indexers / subgraphs / `getAllCollections()` / `getCollectionsPaginated` all degrade as `n` grows.

`MAX_PAGINATED_LIMIT = 1000` only caps the per-page response — it does NOT cap total registry size. `getAllCollections()` is documented "scaling-limited past a few thousand entries" but the contract itself does not enforce a hard cap. NFTPoolFactory has `MAX_POOLS_PER_COLLECTION = 200`, but Launchpad has no analogous global cap.

**Cost of attack:** ~200k–300k gas per spam collection × current L1 gas price. On Base / Optimism at ~0.001 gwei, ~$0.001 per collection. 100k spam collections cost ~$100 and brick `getAllCollections`, the analytics frontend, and any indexer that doesn't paginate.

**Target's loss:**
- Subgraph indexing cost grows linearly forever.
- Frontend "explore drops" page becomes uncallable.
- Any code path that does `getAllCollections().length` or iterates `_poolsByCollection` becomes unusable.

**Suggested mitigation:** Add `MAX_COLLECTIONS = 100_000` ceiling check, require `MIN_CREATE_FEE` (or similar to NFTPoolFactory's MIN_DEPOSIT), or both.

---

## F-95-K-2 (MEDIUM) — TegridyLending / TegridyNFTLending: unbounded `offers[]` array

**Files:**
- `contracts/src/TegridyLending.sol:786-809` (offer push)
- `contracts/src/TegridyNFTLending.sol:438-462` (offer push)

```solidity
// TegridyLending._createLoanOffer
offerId = offers.length;
offers.push(LoanOffer({
    lender: msg.sender,
    principal: effectivePrincipal,
    // ... 11 more fields ...
}));
```

**Grief vector:** Both lending contracts allow `createLoanOffer` / `createOffer` calls down to `minPrincipal = 0.001 ether` (TegridyLending) or `MIN_PRINCIPAL = 0.001 ether` (NFTLending). Neither has a `MAX_OFFERS` cap. The struct is large (~14 fields on TegridyLending; uses ~5+ storage slots per offer):
- A 1 ETH attack budget creates 1000 dust offers per protocol.
- `offers[]` array enumeration via `offerCount()` and `getOffer(i)` becomes a slog.
- Any frontend filter "find offers for collateral X" must iterate entire array.

Both contracts do not enforce a ceiling like `MAX_PAIRS` (Factory) or `MAX_POOLS_PER_COLLECTION` (NFTPoolFactory). `cancelOffer` refunds, so the attacker can recycle 0.001 ETH indefinitely (gas is the only ongoing cost).

**Cost of attack:** ~120k gas per offer (storage push of large struct) × 0.001 gwei on L2 ≈ $0.0001 per offer. 100k offers ≈ $10 to fully bury the offer book.

**Target's loss:**
- Offer-discovery latency degrades.
- `getAllOffers`-style indexer queries (off-chain) grow unbounded.
- Borrowers can't easily find legitimate offers.

**Note:** `0.001 ether` floor is the documented anti-dust gate (R014 audit), but the floor does not bound the OFFER COUNT — only the principal value per offer.

**Suggested mitigation:** Add `MAX_OFFERS_PER_LENDER` (e.g. 50) AND `MAX_TOTAL_OFFERS` (e.g. 10000), or charge non-refundable creation fee that scales with offer count.

---

## F-95-K-3 (MEDIUM) — NFT pool factory: 200-pool cap × 0.05 ETH still exploitable per-collection

**File:** `contracts/src/TegridyNFTPoolFactory.sol:53-63, 211-212`

```solidity
uint256 public constant MAX_POOLS_PER_COLLECTION = 200;
uint256 public constant MIN_DEPOSIT = 0.05 ether;
// ...
require(msg.value >= MIN_DEPOSIT || initialTokenIds.length > 0, "MIN_DEPOSIT");
require(_poolsByCollection[nftCollection].length < MAX_POOLS_PER_COLLECTION, "MAX_POOLS_PER_COLLECTION");
```

**Grief vector:** The MIN_DEPOSIT is bypassable via `initialTokenIds.length > 0` — depositing a SINGLE worthless NFT (e.g. a 0-floor collection minted by the attacker) satisfies the OR condition without any ETH cost. Attacker:
1. Deploys a worthless ERC721 collection.
2. Mints 200 NFTs (each cost: gas only, ~50k each ≈ $0.05 on L2).
3. Calls `createPool` 200 times against their own collection, burning the 200 NFTs into the pool.
4. Has now permanently filled their own collection's pool slot — 200 dead pools.

For an attacker spamming an UNRELATED collection (e.g. JBAC, Nakamigos), they need to OWN 200 NFTs of that collection — NFT supply is the gate. But attacker can also do:
1. Deploy 200 separate dust collections (minimal ERC721 stubs, each ~500k gas to deploy ≈ $0.50 on L2 ≈ $100 total).
2. Create 200 pools each (one per own-controlled collection) — bloats `_allPools` (no global cap on `_allPools.length`).

**Cost of attack:** ~$50–$200 to balloon `_allPools` to thousands, breaking `getAllPools()` (no pagination ceiling exists for global view).

**Target's loss:** Indexer/subgraph cost; pool-discovery latency; `getAllPools` becomes uncallable.

**Suggested mitigation:** Add `MAX_TOTAL_POOLS` global cap, OR require `MIN_DEPOSIT` regardless of `initialTokenIds.length` (close the OR-bypass).

---

## F-95-K-4 (LOW) — TegridyTWAP `update()` keeper-gas griefing window

**File:** `contracts/src/TegridyTWAP.sol:266-455`

```solidity
function update(address pair) external payable nonReentrant {
    if (!factory.isPair(pair)) revert UnknownPair();
    if (factory.disabledPairs(pair)) revert PairDisabled();

    if (updateFee > 0) {
        if (msg.value < updateFee) revert InsufficientFee();
        // ...
    } else {
        require(msg.value == 0, "FEE_NOT_SET");
    }
    if (!canUpdate(pair)) revert PeriodNotElapsed();
    // ...
}
```

**Grief vector:** `update()` is permissionless (intentionally so, for keepers). When `updateFee == 0` (default for backward compatibility), an attacker can call `update(pair)` exactly at the boundary (`MIN_PERIOD = 15 minutes` after the last observation) on every authentic pair. Cost is only ~80k gas per call. This:
- Doesn't poison the buffer (deviation gate enforces ±50%).
- DOES race honest keepers — keeper's tx wastes gas reverting `PeriodNotElapsed`.
- Pairs the attacker's spot snapshot into the buffer at every boundary, displacing keeper observations.

At 15-min cadence on 100 pairs: 96 calls/day/pair × 100 pairs ≈ 9600 update calls/day. If attacker front-runs every honest keeper, ~$100/day in wasted keeper gas (assumes 0.001 gwei L2).

**Cost of attack:** Equal to keeper cost (~$100/day to grief 100 pairs on L2) — economically unprofitable for attacker, but ALSO unprofitable for keeper, and the deviation gate is now anchored on attacker's spot read instead of keeper's intended observation.

**Target's loss:**
- Keeper budget burn.
- The "lastSpot" baseline is whatever spot was at the boundary — attacker can sandwich a small swap before update to nudge the recorded baseline within the ±50% gate.

**Mitigation already partly in place:** `MIN_UPDATE_INTERVAL` rate-limits to 15 min. `updateFee` allows owner to add a fee (capped at 0.01 ETH). Recommend setting `updateFee` to a non-zero value before mainnet so attackers face direct ETH cost, not just gas.

---

## F-95-K-5 (LOW) — TegridyPair.harvest gateable via permissionless flow

**File:** `contracts/src/TegridyPair.sol:340-416`

```solidity
function harvest() external nonReentrant {
    require(!ITegridyFactory(factory).disabledPairs(address(this)), "PAIR_DISABLED");
    // ...
    require(block.timestamp >= lastHarvestAt + HARVEST_INTERVAL, "HARVEST_TOO_SOON");
    // ...
    require(totalSupply() > supplyBefore || bootstrap || cleanup, "NO_FEE_TO_MATERIALIZE");
    lastHarvestAt = block.timestamp;
    // ...
}
```

**Grief vector:** `harvest()` is permissionless with `HARVEST_INTERVAL = 5 minutes`. Attacker calls `harvest()` exactly at boundary on every pair. The D-AMM-M2 fix already guards against the bump-without-mint case, so the attacker can't outright brick the cadence — but they can:
- Front-run honest LPs' `harvest()` to capture bot-style MEV opportunity (per the NatSpec, this is bounded by 1/6th of swap fee + 5min interval — uneconomic).
- Burn keeper gas on revert if multiple keepers race.

**Cost of attack:** Trivial (~50k gas per call), BUT:
- The fix already revert-rolls back the timestamp bump if no LP mints.
- Bootstrap path is gated to `feeToSetter` (FRESH-EYES M-2).
- So the attacker mostly wastes their own gas with no harm beyond keeper-race.

**Target's loss:** Marginal keeper gas burn; noise in the `Mint` event stream.

**Mitigation:** Acceptable as designed — the cap on extractable MEV (1/6th × 0.3% × interval cadence) makes spam-harvest economically irrational. Documented as such in NatSpec.

---

## F-95-K-6 (LOW) — Direct NFT transfer to TegridyNFTLending escrow → NO recovery

**File:** `contracts/src/TegridyNFTLending.sol` (whole file)

**Observation:** `TegridyNFTLending` does NOT implement `IERC721Receiver`, so `safeTransferFrom` from an arbitrary ERC721 contract reverts. HOWEVER, `transferFrom` (non-safe) WILL succeed and orphan the NFT in the lending contract. There is NO `claimUnsolicitedNFT` / `sweepStuckNFT` admin function.

```bash
$ grep -E "sweepNFT|claimUnsolicitedNFT|stuckNFT" TegridyNFTLending.sol
# (no matches)
```

**Grief vector:** Attacker calls `nftCollection.transferFrom(attacker, lendingAddr, attackerTokenId)` for ANY whitelisted collection. The NFT is now orphaned. Lending contract has no recovery path for NFTs that are NOT tied to an active loan record. Stuck-collateral recovery (`claimStuckCollateral`) only works for `loanId`s where transfer no-op'd post-acceptance. Orphaned NFTs that are NOT tied to a loanId are STUCK FOREVER.

**Cost of attack:** Cost of transferring own worthless NFT (~50k gas). Damage: forces the protocol to either (a) deploy an admin sweeper later (governance noise) or (b) leave the asset stuck.

**Target's loss:**
- Attacker can dump worthless NFTs of whitelisted collections (e.g. burn-your-own JBAC into the contract). Most attacks are just an ERC721 ID-pollution prank, but for valuable NFTs the user loses real value with no recourse.
- Lending contract balance in collection enumeration includes orphans, polluting `balanceOf(lendingAddr)` reads off-chain.

**Suggested mitigation:** Add `sweepUnsolicitedNFT(address collection, uint256 tokenId, address to) onlyOwner` that asserts NO active loan references this `(collection, tokenId)` and forwards to `to`. Mirrors the EVERY mature P2P NFT-lending protocol.

---

## F-95-K-7 (LOW) — TegridyLending direct NFT transfer to escrow → also no recovery for non-loan NFTs

**File:** `contracts/src/TegridyLending.sol`

Same shape as F-95-K-6. The lending contract holds `TegridyStaking` NFTs as collateral. `claimStuckCollateral(loanId)` covers the case where an outbound transfer no-op'd. But:
- A user who accidentally `transferFrom`s a staking NFT to lendingAddr (without going through `acceptOffer`) is stuck.
- An attacker who dumps a tsTOWELI NFT (theirs or someone else's they got via `transferFrom`-pull) into lendingAddr orphans it.

No `sweepUnsolicitedStakingNFT` admin path exists. Same risk as F-95-K-6, just for staking NFTs specifically.

---

## F-95-K-8 (LOW) — TegridyTWAP `withdrawFees()` callable by anyone (intended)

**File:** `contracts/src/TegridyTWAP.sol:612-620`

```solidity
function withdrawFees() external nonReentrant {
    uint256 amount = accumulatedFees;
    if (amount == 0) revert NoFees();
    accumulatedFees = 0;
    address to = feeRecipient == address(0) ? owner : feeRecipient;
    (bool ok,) = to.call{value: amount}("");
    require(ok, "WITHDRAW_FAILED");
    emit FeesWithdrawn(to, amount);
}
```

**Observation:** `withdrawFees` is permissionless — anyone can call it. Funds always flow to `feeRecipient || owner`, so this is not a theft vector. But it IS a gas-griefing vector:
- Attacker calls `withdrawFees` at small `accumulatedFees` increments.
- Forces the recipient (typically a multisig) to handle many small inbound transfers.

**Cost of attack:** Negligible (~30k gas per call); damage is gas burn on the recipient side if they receive via a contract.

**Severity:** LOW — by design, but worth flagging that the protocol-fee recipient should be an EOA or simple multisig, not a contract that runs gas-heavy logic in `receive()`.

---

## F-95-K-9 (NOTE / DEAD-END) — NFT pool floor sniping: same-block guard already closes it

**File:** `contracts/src/TegridyNFTPool.sol:262-264, 332-333`

```solidity
function swapETHForNFTs(...) {
    if (block.timestamp == lastWithdrawBlock) revert WithdrawalLandedThisBlock();
    // ...
}
function swapNFTsForETH(...) {
    if (block.timestamp == lastWithdrawBlock) revert WithdrawalLandedThisBlock();
    // ...
}
```

Floor-sniping the mixed-rarity vault would require getting `safeTransferFrom` of a specific tokenId out via `swapETHForNFTs(tokenIds, ...)` — and the buyer specifies which IDs they want. There is no random-pick mechanism, so the "rare floor" sniping vector reduces to: did the buyer pay the right `inputAmount` for the rare ID they explicitly named? Yes — they paid exactly `numItems * spotPrice`, regardless of rarity. The sudoswap-style design intentionally treats every NFT in the pool as fungible at spot. **This is a pool-design choice, not a griefing surface — out of scope.**

---

## F-95-K-10 (NOTE / DEAD-END) — Pair disable abuse → only governance + guardian

**File:** `contracts/src/TegridyFactory.sol:404-433, 505-520`

`proposePairDisabled` / `executePairDisabled` is `onlyFeeToSetter` (governance), 48h timelocked. `emergencyDisablePair` is `feeToSetter || guardian` (instant), and the H-2 fix prevents an attacker from using the emergency flag to overwrite a pending re-enable proposal.

**Verdict:** No griefing surface — only governance can disable pairs. Out of scope for liquidity griefing.

---

## F-95-K-11 (NOTE) — Vote with 1 wei stake against governance

**File:** `contracts/src/GaugeController.sol:303-402`

The vote() function checks `votingPower == 0 → revert ZeroVotingPower` (line 359). MIN_STAKE on TegridyStaking is 100e18 (line 122). So no 1-wei voting is possible from a staking position. `MemeBountyBoard` requires `MIN_VOTE_BALANCE = 1000 ether` (line 69). VoteIncentives.vote requires `power > 0` (line 598) and `userPower > 0` (line 627). All vote paths have anti-dust guards.

**Verdict:** No 1-wei vote-grief surface — defenses are explicit.

---

## F-95-K-12 (NOTE) — WETH dust accumulation in pools

**File:** `contracts/src/TegridyNFTPool.sol:1029-1035`

`rescueStrandedRoyalty` sweeps ALL `wethToken.balanceOf(address(this))` — owner-only. Anyone can `WETH.transfer(poolAddr, dust)` to insert dust, which then accrues until owner sweeps. Not a theft vector (owner gets all WETH), but the sweep target is `msg.sender` (the owner), so:
- Attacker can spam tiny WETH transfers (gas burn ~30k each) to bloat `balanceOf(poolAddr)`.
- The pool owner can recover via `rescueStrandedRoyalty` whenever — but the bloat is gas-priced for the sweeper.

**Severity:** Negligible — owner can sweep cheaply, no fund loss. **Out of scope.**

---

## Summary Table

| ID         | Severity | File:Line                                      | Cost to Attack | Target Loss              |
|------------|----------|------------------------------------------------|----------------|--------------------------|
| F-95-K-1   | HIGH     | TegridyLaunchpadV2.sol:185                     | ~$100 (100k spam) | indexer/frontend bricked |
| F-95-K-2   | MED      | TegridyLending.sol:786, TegridyNFTLending.sol:438 | ~$10           | offer book bloat         |
| F-95-K-3   | MED      | TegridyNFTPoolFactory.sol:201                  | ~$50–$200      | global pool bloat        |
| F-95-K-4   | LOW      | TegridyTWAP.sol:266                            | ~$100/day      | keeper gas burn          |
| F-95-K-5   | LOW      | TegridyPair.sol:340                            | trivial        | keeper race noise        |
| F-95-K-6   | LOW      | TegridyNFTLending.sol (no sweep fn)            | ~50k gas       | orphaned NFTs            |
| F-95-K-7   | LOW      | TegridyLending.sol (no sweep fn)               | ~50k gas       | orphaned staking NFTs    |
| F-95-K-8   | LOW      | TegridyTWAP.sol:612                            | trivial        | recipient gas burn       |

## Dead-Ends / Already-Closed

- F-95-K-9 (mixed-rarity floor sniping): out of scope by design
- F-95-K-10 (pair disable abuse): governance-only, timelocked
- F-95-K-11 (1-wei voting): MIN_STAKE / MIN_VOTE_BALANCE close it
- F-95-K-12 (WETH dust): owner can sweep, no loss

## Recommendations Priority

1. **F-95-K-1 (HIGH)**: Add `MAX_COLLECTIONS = 100_000` ceiling + per-creator rate limit on TegridyLaunchpadV2.
2. **F-95-K-2 (MED)**: Add `MAX_TOTAL_OFFERS` and/or `MAX_OFFERS_PER_LENDER` on both lending contracts.
3. **F-95-K-3 (MED)**: Either add `MAX_TOTAL_POOLS` global cap OR require `MIN_DEPOSIT` regardless of `initialTokenIds.length`.
4. **F-95-K-4 (LOW)**: Set `updateFee` to a non-zero value at mainnet deploy (existing setter; just needs governance call).
5. **F-95-K-6 / F-95-K-7 (LOW)**: Add `sweepUnsolicitedNFT(collection, tokenId, to) onlyOwner` to both lending contracts.

— End of report —
