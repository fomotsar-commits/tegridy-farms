# Agent 16/100 — TegridyDropV2.sol (Drop Clone Template)

**Scope:** `contracts/src/TegridyDropV2.sol` (~1134 lines), with related context from `contracts/src/TegridyLaunchpadV2.sol`, `contracts/src/base/TimelockAdmin.sol`, `contracts/src/lib/WETHFallbackLib.sol`, `contracts/src/lib/SequencerCheck.sol`.

**Lens applied:** Initializable / clone correctness; atomic InitParams field defaults; contractURI / tokenURI risks; mint phase boundaries (allowlist→public); merkle leaf encoding & double-mint; refund flow correctness post-cancel; withdraw permissions & receiver; ERC2981 royalty cap; soulbound flag (N/A — none); per-wallet cap bypass; reveal toggling; ERC-7572 contractURI emission; safeMint reentrancy via onERC721Received.

---

## Summary

A single LOW-severity owner-footgun was identified — `setMintPhase(MintPhase.DUTCH_AUCTION)` does not re-validate the `dutchStartTime + dutchDuration > block.timestamp` invariant that `initialize()` (V2-DROP-04) and `executeDutchAuction()` (V3-DROP-01) both enforce. An owner who toggles back into DUTCH_AUCTION on an elapsed curve silently launches at the floor (`dutchEndPrice`), reproducing the V2-DROP-04 fat-finger class on a path the prior fixes did not cover. Self-inflicted only — no third-party extraction vector.

The remainder of the contract surface is exceptionally well-hardened. The merkle leaf binds `(address(this), msg.sender, allowedAmount)` double-hashed (defeats cross-drop replay, second-preimage, and `setMaxPerWallet`-bump bypass simultaneously). Refund / cancel flows are now structurally unreachable post-DEEP-DROP-05 (`cancelSale` gated to `totalSupply == 0`), with vestigial slots preserved only for ABI compat. Three independent timelocked admin paths (root rotation, price change, dutch curve) all enforce a "no pending proposal" booby-trap clear on `setMintPhase` and `acceptOwnership`. Funds always route to the deploy-time-immutable `creator`, never to a transferable `owner`.

---

## Findings

### F-16-K-1 (LOW): `setMintPhase(DUTCH_AUCTION)` missing elapsed-curve guard

**Location:** `TegridyDropV2.sol:678-680`

**Status:** Owner-footgun, no third-party exploit. Mirrors but does not extend V2-DROP-04 / V3-DROP-01.

**Description:**
The `setMintPhase` setter only verifies that a dutch curve has been configured at all (`dutchDuration != 0`):

```
if (phase == MintPhase.DUTCH_AUCTION && dutchDuration == 0) {
    revert DutchAuctionNotActive();
}
```

It does not re-check that the curve is still live. The two sibling entry points DO enforce that invariant:

- `initialize()` lines 444-448 — `revert DutchAuctionAlreadyEnded()` if `dutchStartTime + dutchDuration <= block.timestamp` (V2-DROP-04).
- `executeDutchAuction()` line 920 — `revert InvalidDutchAuctionConfig()` for the same condition (V3-DROP-01).

**Reproduction:**
1. Drop deploys with `dutchStartTime = T`, `dutchDuration = D`, `initialPhase = CLOSED`.
2. Wall clock advances past `T + D` (curve fully elapsed) without the owner ever rotating to DUTCH_AUCTION.
3. Owner calls `setMintPhase(DUTCH_AUCTION)` — passes the `dutchDuration != 0` gate.
4. Mint at line 511 does NOT revert (`block.timestamp >= dutchStartTime`, so the early `< dutchStartTime` check is satisfied).
5. `_dutchAuctionPriceWithoutSequencerCheck()` returns `dutchEndPrice` (line 644: `if (elapsed >= dutchDuration) return dutchEndPrice;`).
6. All remaining supply mints at the floor.

**Impact:**
The owner is the creator. The path is self-inflicted (a creator who fat-fingers a phase toggle on a stale curve gets the floor price they didn't expect). H19 (`ZeroPricePostMint`) does NOT cover this because that invariant is on the `mintPrice` slot, not the dutch curve. If `dutchEndPrice == 0`, the mint is free; otherwise it's at the floor.

A third party cannot trigger this — only `onlyOwner` calls reach `setMintPhase`. No extraction vector. The harm is purely creator self-rug.

**Recommendation:**
Add the V2-DROP-04 / V3-DROP-01 mirror:

```
if (phase == MintPhase.DUTCH_AUCTION) {
    if (dutchDuration == 0) revert DutchAuctionNotActive();
    if (dutchStartTime + dutchDuration <= block.timestamp) revert DutchAuctionAlreadyEnded();
}
```

This makes the sibling guard symmetric across all three entry points (init, execute, setPhase) and removes the "stale curve" footgun without any compatibility cost. Same pattern as Sudoswap LSSVMPair rejecting expired auctions at every entry.

---

## Notes / Dead-ends checked (no finding)

The following were probed and confirmed safe:

1. **Re-init protection.** `_disableInitializers()` in constructor blocks impl re-init; `initializer` modifier on `initialize()` blocks clone re-init. Standard OZ Initializable pattern, correct usage with clone deploy.

2. **Atomic InitParams defaults.** Every required field has an explicit zero check (`creator`, `platformFeeRecipient`, `weth`, `maxSupply`). `mintPrice == 0` and `maxPerWallet == 0` are intentionally allowed (free mints, uncapped per-wallet). `royaltyBps` and `platformFeeBps` are capped at 10% (`MAX_ROYALTY_BPS`, `MAX_PLATFORM_FEE_BPS`). `initialPhase == ALLOWLIST` requires non-zero `merkleRoot`. `initialPhase == DUTCH_AUCTION` requires full curve config AND non-elapsed window.

3. **contractURI / tokenURI XSS.** Strings are owner-set with no validation, but XSS in marketplace metadata is the consumer's responsibility (OpenSea/Blur sanitize). No on-chain escalation. ERC-7572 `ContractURIUpdated()` event fires correctly in both `initialize` (when non-empty) and `setContractURI`.

4. **Mint phase ALLOWLIST→PUBLIC front-run.** Standard NFT MEV surface; not exploitable beyond mempool ordering. No mint-state leaks across phases (allowlist consumption tracked separately from `mintedPerWallet`).

5. **Merkle leaf encoding.** `keccak256(bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount))))` — double-hashed (defeats second-preimage / leaf-as-node), drop-bound (defeats cross-clone replay), claimer-bound (defeats wallet shuffling), amount-bound (defeats `setMaxPerWallet` bump bypass). `allowlistClaimed[msg.sender]` accumulator is independent of `mintedPerWallet`. Manifold ERC721LazyPayableClaim equivalent.

6. **Refund flow post-cancel.** Structurally unreachable on any new clone: `cancelSale()` requires `totalSupply == 0` (DEEP-DROP-05); therefore `paidPerWallet[X] == 0` for all X at cancel time; therefore `refund()` always hits `NothingToRefund`. Vestigial — preserved for ABI compat. `unclaimedRefundPool` similarly dead-state, no write paths remain.

7. **Withdraw permissions & receiver.** `onlyOwner` + `nonReentrant` + sale-end gating (CLOSED OR sold-out, never mid-mint — closes the H9 / NEW-L1 batch-drain). Proceeds always route to `creator` (immutable, set at init), NEVER to the transferable `owner`. A transferred-owner cannot redirect funds. `withdrawn = true` is one-way, locking out subsequent `cancelSale()`. M-7 distributes only `totalProceeds` (not raw balance), preventing donation-front-run inflating platformFeeBps.

8. **ERC2981 royalty cap.** `MAX_ROYALTY_BPS = 1000` (10%). Set once at init via `_setDefaultRoyalty(creator, royaltyBps)`. No external mutator. Receiver pinned to `creator` (immutable).

9. **Soulbound flag.** N/A — no transfer override, contract is fully transferable. Not in spec.

10. **Per-wallet cap bypass via second wallet / signature whitelist.** Sybil resistance is impossible on-chain; merkle leaf binds claim to `msg.sender`, so a sybil farmer must have N pre-allocated leaves. Not exploitable beyond the merkle root the creator commits to.

11. **Reveal flag toggling.** `reveal()` is one-shot (`AlreadyRevealed` revert). After reveal, `setBaseURI` is also blocked. Owner cannot rotate `_revealURI` post-reveal (no setter). Pre-reveal `setBaseURI` is mitigated by `freezeBaseURI()` (one-shot, requires non-empty URI per V2-DROP-06). Sound Protocol / Manifold equivalent.

12. **ERC-7572 emission.** `ContractURIUpdated()` event signature matches spec, fires on init (when non-empty) and on every `setContractURI`. Marketplaces re-index on signal.

13. **safeMint reentrancy via onERC721Received.** `nonReentrant` blocks self-reentry on `mint()`. CEI ordering in M-02 fix updates `totalSupply` / `mintedPerWallet` / `paidPerWallet` / `totalProceeds` BEFORE the `_safeMint` loop, so receiver hooks see a coherent post-mint snapshot. Overpayment refund uses 10000-gas WETH-fallback transfer (cross-contract reentrancy capped to event-emit budget).

14. **Constructor vs initializer for clone deploy.** `ERC721("", "")` constructor runs only on the implementation, leaving impl's `_name`/`_symbol` slots empty. Override of `name()` and `symbol()` reads `_dropName`/`_dropSymbol` set in `initialize()`. Clones do not run constructors; their `_name`/`_symbol` slots are zero but never read. No layout drift.

15. **Owner transfer correctness.** 2-step (`transferOwnership` / `acceptOwnership`). `acceptOwnership` flushes ALL three pending timelocked proposals (MERKLE_ROOT_CHANGE, MINT_PRICE_CHANGE, DUTCH_CONFIG_CHANGE) per M-D3 / V2-DROP-01 / V2-DROP-03 booby-trap defense. `renounceOwnership` reverts (RENOUNCE_DISABLED). `creator` (royalty/withdraw/rescue receiver) is immutable post-init — owner transfer cannot redirect funds.

16. **Timelock booby-trap on `setMintPhase`.** All three pending proposal slots (`_executeAfter[MERKLE_ROOT_CHANGE | MINT_PRICE_CHANGE | DUTCH_CONFIG_CHANGE]`) freeze phase changes (R014 H-8, V2-DROP-01, V2-DROP-03). Owner must `cancel*` before re-opening — closes the close→reopen smuggle of queued hostile changes into active mint phases.

17. **`whenNotPaused` on execute paths.** All three execute functions (V3-DROP-03) carry `whenNotPaused` so a queued change cannot fire mid-pause. Propose paths intentionally lack the gate — pausing during pending proposal expiry is acceptable behavior (pause delays execution but doesn't strictly block; proposal can re-issue post-unpause if expired).

18. **Sequencer gating on dutch quote.** `mint()` uses `_dutchAuctionPrice()` (reverting probe via `SequencerCheck.checkSequencerUp`), preventing post-outage price-decay arbitrage. `currentPrice()` uses `tryCheckSequencerUp` and returns `type(uint256).max` sentinel for indexer / UI consumers. V2-DROP-05 split avoids the prior STATICCALL self-call gas overhead.

19. **WETH single-write invariant.** `weth` is set once in `initialize()` and never mutated (R014 L-4). No setter exists by design. Comment explicitly warns future contributors to justify any setter under audit since post-init swap to attacker-controlled WETH would break refund / withdraw routing.

20. **mintedPerWallet vs allowlistClaimed independence.** `setMaxPerWallet(max)` (gated to CLOSED) cannot retroactively reopen a consumed allowlist allocation because `allowlistClaimed[msg.sender] + quantity > allowedAmount` is checked against the leaf-bound amount, not `maxPerWallet`. Closes MICROSCOPE C1.

21. **`paidPerWallet` accumulator vs overpayment refund.** `paidPerWallet[msg.sender] += totalCost` records ONLY the legitimate price × quantity, not `msg.value`. Overpayment is refunded but not accumulated. Total proceeds invariant (`totalProceeds`) tracks the sum of all `paidPerWallet` entries.

22. **`MAX_MINT_PER_TX = 50` cap.** Bounds Transfer event burst, fits in block gas, prevents `quantity = maxSupply` self-DoS. Matches TegridyStaking `MAX_POSITIONS_PER_HOLDER`.

23. **ERC721("", "") storage clash.** Base ERC721 v5 stores `_name` and `_symbol` in fixed slots set by constructor; clones inherit empty slots but never read them (overridden getters). No layout drift.

24. **Free-mint footgun via `mintPrice == 0` direct-clone deploy.** A creator bypassing the factory could deploy with `mintPrice = 0`, `maxPerWallet = 0`, `initialPhase = PUBLIC` and burn `MAX_MINT_PER_TX = 50` per tx until `maxSupply` exhausts. Not exploitable by a third party against an honest creator's drop — only by the deployer themselves against their own drop. Pre-mint `mintPrice` is freely settable (H19 only restricts post-`totalSupply > 0`). Acceptable as a "free drop" UX.

25. **`_dutchAuctionPrice` arithmetic.** No underflow (`dutchStartPrice > dutchEndPrice` enforced; `decay < priceDrop`). No overflow (`priceDrop * elapsed` bounded by `100 ether * 30 days` ≈ 3e27, far below `uint256.max`).

26. **ContractURI / tokenURI URL injection.** Owner-set strings are not parsed on-chain. URL injection attacks against off-chain consumers (marketplaces, indexers) are out-of-scope for the contract. Best-practice URI sanitization is a marketplace responsibility.

---

## Output path

`.audit_2026_freshlook/findings/agent_16_dropv2.md`
