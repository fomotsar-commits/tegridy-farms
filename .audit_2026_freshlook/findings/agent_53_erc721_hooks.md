# Agent 53 — ERC721 onERC721Received / safeMint / safeTransferFrom callback re-entrancy

Lens: every receiver-hook firing site across `contracts/src/` — can the recipient hook re-enter, observe inconsistent state, or chain-call to over-mint, double-vote, or steal?

Working dir: `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms`
Files audited (only files where ERC721 hooks are reachable):
- `TegridyDropV2.sol` (only `_safeMint` site in repo)
- `TegridyNFTPool.sol` + `TegridyNFTPoolFactory.sol`
- `TegridyRestaking.sol`
- `TegridyStaking.sol` + `TegridyStakingJbacVault.sol`
- `TegridyNFTLending.sol`, `TegridyLending.sol` (transferFrom-only paths confirmed)
- `lib/SafeERC721Call.sol`

## Surface inventory

### safeMint sites (`_safeMint` / `safeMint`)
Single occurrence in entire `src/`:
- `TegridyDropV2.sol:576`  inside `mint()` loop.
  No other contract uses safeMint — `TegridyStaking.sol:771,822` use plain `_mint` (Solady, no callback).

### Inbound safeTransferFrom (recipient is `address(this)`)
- `TegridyRestaking.sol:632` — restaker -> restaking contract (`onERC721Received` is `view`)
- `TegridyStaking.sol:830` — staker -> JBAC vault (vault hook gated to `msg.sender == jbacNFT`, `view`)
- `TegridyNFTPool.sol:352, 385` — seller -> pool / owner -> pool (pool hook gated; see below)
- `TegridyNFTPoolFactory.sol:273` — creator -> new pool (creator approval semantics, factory has nonReentrant)

### Outbound safeTransferFrom (recipient is user/contract)
- `TegridyNFTPool.sol:292` — pool -> buyer in `swapETHForNFTs` loop
- `TegridyNFTPool.sol:411` — pool -> owner in `removeLiquidity`
- `TegridyNFTPool.sol:683` — pool -> owner in `withdrawNFTs`
- `TegridyRestaking.sol:1108` — restaking -> user in `unrestake`
- `TegridyRestaking.sol:1581` — restaking -> user in `emergencyWithdrawNFT`
- `TegridyRestaking.sol:1656` — owner-only `rescueNFT` to staking address
- `TegridyRestaking.sol:1678` — owner-only `recoverStuckNFT`-shape rescue
- `TegridyRestaking.sol:1779` — restaking -> user in `emergencyForceReturn` (paused)
- `TegridyStakingJbacVault.sol:92` — vault -> user in `returnJbac` (`onlyStaking`)
- `TegridyStakingJbacVault.sol:117` — vault -> user in `claimStrandedJbac` (nonReentrant, CEI)

### `transferFrom` (no callback) — sanity-checked, no hook risk
- `TegridyNFTLending.sol:581` (acceptOffer escrow), 857 (`_safeOutboundTransfer` via `SafeERC721Call.safeTransferFromBounded` which selects `transferFrom`, NOT safeTransferFrom)
- `TegridyLending.sol:1332` (same library helper)
- ERC20 `safeTransferFrom` calls in CommunityGrants / PremiumAccess / Router / Staking / VoteIncentives / SwapFeeRouter — all use OpenZeppelin's SafeERC20 against ERC20 tokens; not in scope here.

### Approvals to attacker-controlled contracts
None. `Grep` of `\.approve\(|setApprovalForAll\(` across `src/` returns zero NFT-approval call sites — the protocol never grants NFT operator rights to externally-supplied addresses.

## Findings

### F-53-1 — Notes / dead-end: TegridyDropV2.mint  loop  (no exploit)
File: `TegridyDropV2.sol`
Function: `mint(uint256 quantity, ...)` lines 496-584
- `nonReentrant` (line 499) blocks self-reentry.
- CEI is explicit (lines 551-573) — `totalSupply`, `mintedPerWallet`, `paidPerWallet`, `allowlistClaimed`, `totalProceeds` all updated BEFORE the `_safeMint` loop at 575-577.
- Receiver hook on each iteration sees post-mint state for ALL counters, since they were committed pre-loop.
- Hook callable surface: only `mint`, `refund`, `acceptOwnership` are non-onlyOwner externals. `mint` re-entry blocked. `refund` requires `mintPhase == CANCELLED`; `cancelSale` is owner-only and requires `totalSupply == 0`, structurally unreachable post-first-mint. `acceptOwnership` requires `pendingOwner == msg.sender` (admin-only path).
- ETH overpay refund at line 580 uses `WETHFallbackLib.safeTransferETHOrWrap` with the 10k-gas stipend (lib lines 76-78), so even after the loop a malicious receiver cannot complex-reenter via ETH callback.
- Verdict: dead end. The defense was already applied per the in-line note at lines 551-559 (AUDIT R023 / M-02).

### F-53-2 — Notes / dead-end: TegridyNFTPool.swapETHForNFTs buyer-callback  (no exploit)
File: `TegridyNFTPool.sol`
Function: `swapETHForNFTs(...)` lines 257-324
- `nonReentrant` + `whenNotPaused` (line 261).
- `_swapInFlight = true` at line 273; `_swapCaller` deliberately NOT set in BUY direction per V3-NFTPOOL-01 fix (lines 274-280).
- Per-iteration: `_idToIndex` check (line 290), `_removeHeldId` (line 291), then `nftCollection.safeTransferFrom(this, buyer, tokenId)` (line 292) which fires the buyer's hook.
- Buyer's hook can attempt deposit-via-`onERC721Received` re-entry. Blocked because:
  - `authorizedSwapInflow = _swapInFlight && from == _swapCaller` requires `from == address(0)` (since `_swapCaller` was never set in BUY); attacker cannot transfer FROM zero-address (777-799).
  - `authorizedOperator` requires operator to be {owner, this, factory}, none of which the buyer can satisfy unless they ARE one of those.
- Buyer's hook cannot re-enter swap functions (`nonReentrant` is global per-contract).
- `spotPrice` was already incremented for the FULL batch at line 286 before the loop, so each iteration's hook sees the final committed price.
- Verdict: dead end.

### F-53-3 — Notes / dead-end: TegridyNFTPool.swapNFTsForETH inbound deposits  (no exploit)
File: `TegridyNFTPool.sol`
Function: `swapNFTsForETH(...)` lines 326-381
- `nonReentrant`, `_swapInFlight = true`, `_swapCaller = msg.sender = seller` (lines 342-344).
- `nftCollection.safeTransferFrom(seller, pool, tokenId)` per iteration (line 352). Receiver hook fires on POOL itself (since pool is `to`), NOT on seller (ERC721 spec: only inbound hook fires).
- Pool's `onERC721Received` (lines 777-801): `authorizedSwapInflow = _swapInFlight && from == _swapCaller` is true; `_addHeldId(tokenId)` runs.
- Re-entry vector: a malicious nftCollection's transferFrom could call other contracts. `nonReentrant` on `swapNFTsForETH` blocks re-entry into pool. Attacker collection still cannot synthesize fake `_addHeldId` for IDs it doesn't actually move because pool's hook only adds the `tokenId` actually passed in — and the for-loop will happily process whatever the collection chose to deliver. The trust boundary is the collection itself; widely understood.
- Verdict: dead end (collection-honesty trust assumption).

### F-53-4 — Notes / dead-end: TegridyRestaking.unrestake re-entry close-out  (no exploit)
File: `TegridyRestaking.sol`
Function: `unrestake()` lines 961-1185 ish (transfer at 1108)
- `nonReentrant` on entry.
- CEI: `totalActivePrincipal`, `totalRestaked`, `tokenIdToRestaker[tokenId]`, `restakers[msg.sender]` ALL deleted/decremented BEFORE the `safeTransferFrom` (lines 1071-1078). Boost checkpoint zeroed at 1079.
- Pre-transfer per-tokenId pull (`claimUnsettledForTokenId`) at 1089-1093 is gated `try/catch`.
- `safeTransferFrom` wrapped in `try/catch`; on failure, `strandedRestakeRecipient[tokenId] = msg.sender` is the fallback (lines 1108-1113). This stranded record is later claimable via `claimStrandedRestakeNFT` (line 1652) which is `nonReentrant` and CEI-correct.
- Receiver hook on user fires after staking-side `_afterTokenTransfer` has run (Solady ordering — `lib/solady/src/tokens/ERC721.sol:309,315`). Hook sees consistent state.
- Re-entry into restaking: blocked by `nonReentrant`.
- Cross-contract re-entry: hook can call governance modules (GaugeController / VoteIncentives), but at this moment `restakers[msg.sender]` is ALREADY deleted, so VotePowerOracle returns only the staking-side power — no double-vote vector. Explicitly addressed by AUDIT FIX (BATCH-C H4) at lines 1756-1770 of the analogous `emergencyForceReturn`, mirrored here.
- Verdict: dead end.

### F-53-5 — Notes / dead-end: TegridyStaking.stakeWithBoost JBAC inbound  (no exploit)
File: `TegridyStaking.sol:791-833`
- `nonReentrant whenNotPaused updateReward`.
- `_mint(msg.sender, tokenId)` (line 822) is plain `_mint`, NOT `_safeMint` — no receiver callback to staker.
- Then `rewardToken.safeTransferFrom(staker, this, amount)` (line 823) — TOWELI is the deployed-immutable Toweli.sol contract, no ERC20-transfer callback.
- Then `jbacNFT.safeTransferFrom(staker, jbacVault, jbacTokenId)` (line 830) — fires the vault's `onERC721Received`. Vault hook (`TegridyStakingJbacVault.sol:124-131`) is `view`, only validates `msg.sender == address(jbacNFT)` and returns the magic value. No state mutation possible.
- Position struct, totalStaked, totalBoostedStake, boost checkpoint all written BEFORE the JBAC transfer.
- Verdict: dead end.

### F-53-6 — Notes / dead-end: TegridyStakingJbacVault.returnJbac no-nonReentrant  (no exploit)
File: `TegridyStakingJbacVault.sol:87-99`
- Function lacks an explicit `nonReentrant` modifier, BUT:
  - `onlyStaking` modifier (line 89) restricts entry to the immutable wired `staking` contract.
  - The JBAC `safeTransferFrom` recipient hook fires on `to` (the user), and ANY recipient-side re-entry would have to go through `staking.x` (which holds the outer `nonReentrant` lock from `withdraw`/`earlyWithdraw`/`emergency*`) and back through `_clearPosition` — blocked.
  - Even if a hostile JBAC contract itself re-entered the vault, all entry points fail `onlyStaking` because the caller is the JBAC contract (or attacker), not `staking`.
  - The function holds NO state mutation BEFORE the safeTransferFrom — only on the catch-failure path it writes `strandedJbacOwner` / `strandedJbacTokenId`. Re-entry on the catch path cannot happen because catch only fires after the call returns.
  - Pre-call invariant CCR-01 (file natspec line 81-86): `_clearPosition` calls `_burn(tokenId)` BEFORE `returnJbac`, so any reentrant `transferFrom` from inside the JBAC callback hits empty `_ownerOf` and reverts.
- Verdict: dead end.

### F-53-7 — Notes / dead-end: TegridyNFTPoolFactory.createPool initial NFT seeding  (no exploit)
File: `TegridyNFTPoolFactory.sol:194-278`
- `nonReentrant whenNotPaused`.
- `nft.safeTransferFrom(msg.sender, pool, initialTokenIds[i])` loop at line 273 fires the new pool's `onERC721Received` (since pool is `to`).
- Pool's hook gating: `operator == factory` is true (factory is the msg.sender of the safeTransferFrom call, and was passed in via `initialize` as `factory`). So `authorizedOperator` admits the deposit.
- A malicious nftCollection re-entering the factory hits `nonReentrant`. The pool itself is freshly deployed so no state corruption.
- Verdict: dead end (defense-in-depth comment at lines 202-205).

### F-53-8 — Notes / dead-end: NFT lending paths use plain transferFrom only  (no exploit)
Files: `TegridyNFTLending.sol`, `TegridyLending.sol`, `lib/SafeERC721Call.sol`
- `SafeERC721Call.safeTransferFromBounded` uses selector `0x23b872dd = transferFrom(address,address,uint256)` (line 33), NOT `safeTransferFrom`. Per ERC721 spec, plain `transferFrom` does NOT invoke `onERC721Received`.
- `acceptOffer` in NFTLending escrows via `IERC721(...).transferFrom(borrower, this, tokenId)` (line 581); `claimDefault`, `repayLoan`, `claimStuckCollateral` all use the bounded helper which is also plain `transferFrom`.
- Result: NFT collateral movement in lending NEVER fires a receiver hook on either end. `nonReentrant` is still applied as defense-in-depth, plus post-condition `ownerOf` check (line 589) catches malicious-collection no-op transfers.
- Verdict: dead end. The "NFT collateral safeTransferFrom on liquidate → receiver hook re-enters lending" attack class is structurally absent from this codebase.

## Summary

Across all 5 contracts that touch ERC721 receiver hooks, every safeMint / safeTransferFrom site I examined is defended by one or more of:
1. `nonReentrant` (per-contract OZ ReentrancyGuard) on every state-mutating external entry point.
2. CEI ordering — committed state writes BEFORE every receiver-hook-firing call (TegridyDropV2 mint, TegridyRestaking unrestake / emergencyWithdrawNFT / emergencyForceReturn, TegridyStaking stakeWithBoost, TegridyStakingJbacVault claimStrandedJbac).
3. Receiver-hook gating — `onERC721Received` implementations are either `view`-pure (TegridyRestaking, TegridyStakingJbacVault) or admit only authorized-operator/swap-inflow combinations (TegridyNFTPool).
4. Plain `transferFrom` (no callback) for NFT collateral movement in lending (`SafeERC721Call.safeTransferFromBounded`).
5. Try/catch fallbacks with stranded-record bookkeeping for hostile-recipient self-DoS scenarios (Restaking unrestake, JBAC vault returnJbac, Drop ETH refund via 10k-gas stipend).

Every concrete vector listed in the lens (1) safeMint cap-bypass, (2) inbound hook re-entry, (3) stacked safeMint loops, (4) approval-then-call, (5) NFT collateral liquidation, (6) JBAC vault returnJbac, (7) Restaking, (8) Drop refund/mint, (9) NFT pool deposit/withdraw/swap is structurally closed.

No findings to file. All 8 surface points reduce to dead ends with documented prior fixes (R023 / M-02, V3-NFTPOOL-01, V2-NFTPOOL-01, BATCH-C H4/H5, CCR-01, BATCH-H M9, GAS-01).
