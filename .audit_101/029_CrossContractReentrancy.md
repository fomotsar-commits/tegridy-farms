# Agent 029 — Cross-Contract Reentrancy Audit (AUDIT-ONLY)

Mission: forensic review of cross-contract reentrancy paths in `contracts/src/` for
TegridyPair, TegridyRouter, SwapFeeRouter, TegridyFeeHook, POLAccumulator,
RevenueDistributor, TegridyNFTPool, TegridyLending, TegridyNFTLending,
TegridyRestaking. Cross-checked against `RedTeam_CrossContract.t.sol` (20 attacks).

## Surface inventory

External calls to user/token-controlled addresses, by contract:

- **TegridyPair** (336 LoC): `safeTransfer`/`safeTransferFrom` on token0/token1
  inside `mint/burn/swap/skim/sync` (all `nonReentrant`). Reserves now updated
  *before* outbound transfers (CEI fix H-01 / M-02). Flash-swap data rejected
  (`require(data.length == 0)`).
- **TegridyRouter** (511 LoC): `safeTransfer`/`safeTransferFrom`,
  `IWETH.deposit/withdraw/transfer`, `TegridyPair(pair).swap/mint/burn`,
  `WETHFallbackLib.safeTransferETHOrWrap` (10k stipend). All public entrypoints
  carry `nonReentrant`.
- **SwapFeeRouter** (1254 LoC): pulls/pushes ERC20, calls inner Uniswap V2 router
  (`router.swapExact*`), writes accumulators *before* router call, then forwards
  net to user. `pendingDistribution` queue + `withdrawPendingDistribution` are
  pull-based with WETH fallback. ETH legs use 50k gas stipend on `.call`.
- **TegridyFeeHook** (421 LoC): `onlyPoolManager` for `afterSwap`;
  `claimFees` is permissionless `nonReentrant`, decrements `accruedFees` BEFORE
  `poolManager.take(currency, revenueDistributor, amount)`. CEI clean.
- **POLAccumulator** (521 LoC): owner-only `accumulate`/`executeHarvestLP`;
  external calls = router.swapExactETHForTokens, router.addLiquidityETH,
  router.removeLiquidityETH, treasury `.call{value}`, toweli safeTransfer.
  All `nonReentrant`.
- **RevenueDistributor** (819 LoC): `claim/claimUpTo` use `msg.sender.call{value, gas:10000}`
  (Solmate stipend) — too little gas to re-enter; failed transfer credits
  `pendingWithdrawals` (pull pattern). `withdrawPending` uses
  `WETHFallbackLib.safeTransferETHOrWrap`. `try/catch` on
  `votingEscrow.paused()`, `restakingContract.restakers/boostedAmountAt`,
  `votingPowerOf`, `userTokenId`, `positions`. `nonReentrant` everywhere.
- **TegridyNFTPool** (688 LoC): `nftCollection.safeTransferFrom` (from arbitrary
  user-controlled ERC721 — onERC721Received callback into seller possible).
  `_sendETH` uses WETHFallbackLib (10k stipend). All swap paths `nonReentrant`.
  `claimProtocolFees` only callable by `factory`.
- **TegridyLending** (972 LoC): `staking.transferFrom` (NOT `safeTransferFrom` —
  no onERC721Received), `WETHFallbackLib.safeTransferETHOrWrap` to lender/treasury/
  borrower, ITegridyPair spot-reserve read for ETH-floor (sandwich-manipulable
  per documented critique 5.4). All `nonReentrant`.
- **TegridyNFTLending** (783 LoC): `IERC721(collateralContract).transferFrom`
  (whitelisted only — but whitelisted collection may itself be an ERC721 with
  no callbacks; transferFrom not safe so no onERC721Received). Same WETH fallback.
  `activeLoansOfCollection` guards whitelist removal.
- **TegridyRestaking** (1162 LoC): `stakingNFT.safeTransferFrom` (back to
  user — onERC721Received callback fires on restaker recipient),
  `staking.getReward/toggleAutoMaxLock/claimUnsettled/revalidateBoost/positions`,
  `bonusRewardToken.safeTransfer`, `rewardToken.safeTransfer`. Most paths
  `nonReentrant` and use `try/catch` for resilience.

## Coverage gap matrix vs RedTeam_CrossContract.t.sol

RedTeam test (20 attacks) covers:
- ATTACK4: claim() reentrancy via ETH receive — DEFENDED
- ATTACK9: ReferralSplitter reentrancy — DEFENDED
- ATTACK15: PendingWithdrawal reentrancy — DEFENDED
- ATTACK17: Staking↔Restaking desync — DEFENDED

NOT covered (gaps below):
- A. Read-only reentrancy on `TegridyPair.getReserves()` from the inside of a
  **router→pair→token→user-callback→pair-pricing-router** chain when token is a
  malicious custom ERC20 (NOT the documented unsupported ERC777, but a token
  designed to call a downstream consumer mid-transfer).
- B. Read-only reentrancy on `RevenueDistributor.pendingETH`/`epochClaimed` while
  `claim()` is mid-flight (10k stipend rules out this in practice).
- C. Cross-contract reentrancy SwapFeeRouter → router → pair → token →
  POLAccumulator/RevenueDistributor `.call{gas:50_000}` queue mutations.
- D. ERC721 `onReceived` callback exploit on `TegridyNFTPool.swapNFTsForETH` —
  `nftCollection` is user-supplied at clone-init time; `safeTransferFrom`
  triggers `_checkOnERC721Received` on `address(this)` which is implemented
  here. After the transfer, `_sendETH` fires with 10k stipend. The pool's own
  `onERC721Received` writes to `_idToIndex/_heldIds`. This is internal state,
  but the pool nests calls inside a `for` loop that updates `spotPrice` BEFORE
  the loop, then `nftCollection.safeTransferFrom(seller, address(this), tokenIds[i])`
  one-by-one → if `seller` is a contract whose token transfer fails for one ID
  mid-way, the loop reverts (clean), but `spotPrice` is already mutated. NOT
  reentrancy — accounting is fine because revert restores. OK.
- E. Custom-collection NFT in TegridyNFTLending: `transferFrom` (not safe) means
  no onERC721Received — but the collection is admin-whitelisted, and a whitelisted
  collection with a malicious `transferFrom` (e.g., reverts on default-claim) is
  the only DOS vector. Out of scope for reentrancy.

## ATTACK PATHS (numbered)

### ATTACK PATH 1 — Read-only reentrancy on TegridyPair.getReserves() during burn() callback (PARTIALLY MITIGATED)
- Surface: `TegridyPair.burn(to)` lines 150-176. Even though _update() now runs BEFORE
  outbound transfers (M-02 fix in src), the outbound `safeTransfer` on token0/token1
  still fires after state is settled. So getReserves() returns *consistent* state
  during the transfer hook.
- The risk transfers to a different invariant: `IERC20(token).balanceOf(address(this))`
  read by `_calculateLiquidity` in TegridyRouter for an ADJACENT pair when an
  attacker token's transfer hook calls `TegridyRouter.addLiquidity(otherTokenA, otherTokenB)`
  where otherTokenB == this same attacker token. Path:
  Router.removeLiquidity → Pair.burn → token0.safeTransfer → token0.attacker_hook →
  Router.addLiquidity(otherToken, token0) → reads stale `balanceOf` (token0 is
  mid-transfer, balance not yet decremented at the source pair).
- DEFENSIVE NOTE: TegridyFactory `_rejectERC777` blocks at creation; doc says
  "ERC-777 tokens and tokens with transfer callbacks are NOT supported." But a
  *post-creation* upgrade of an upgradeable token to add callbacks isn't
  prevented; the per-swap FOT_OUTPUT_0/1 check at end of `swap()` would catch
  *fee-on-transfer* deviation but NOT a pure callback-only exploit that doesn't
  alter the balance equation.
- IMPACT: HIGH theoretical, gated by token-upgrade governance. Not in test suite.
- Numbered functions: `TegridyPair.swap` (L183), `TegridyPair.burn` (L150),
  `TegridyRouter.addLiquidity` (L67), `TegridyRouter._calculateLiquidity` (L490).

### ATTACK PATH 2 — RevenueDistributor `pendingDistribution` read-only reentrancy (LOW)
- Surface: `SwapFeeRouter.distributeFeesToStakers` (L879) calls
  `revenueDistributor.call{value, gas:50_000}("")`. If the configured
  `revenueDistributor` is a contract that consumes 50k gas to perform
  `staticcall(SwapFeeRouter).pendingDistribution(self)` inside its `receive()`, it
  reads BEFORE the `pendingDistribution[revenueDistributor] += stakerAmount` write
  on the failure branch. This is upstream of the queue increment, so the
  re-entrant view sees stale (under-counted) pending, but no funds are lost —
  the call success path doesn't increment.
- IMPACT: LOW (informational). `pendingDistribution` is monotonic and the
  observation window is during a CEI-violating gap that 50k gas cannot exploit
  for state mutation.
- Numbered: `SwapFeeRouter.distributeFeesToStakers` (L879-937),
  `SwapFeeRouter.pendingDistribution` mapping (L164).

### ATTACK PATH 3 — TegridyRestaking↔TegridyStaking unsettledRewards race during a malicious receiver's `onERC721Received` (HIGH, partially mitigated)
- Surface: `TegridyRestaking.unrestake` (L470). It calls
  `stakingNFT.safeTransferFrom(this, msg.sender, tokenId)` on L552, where
  `msg.sender` is the restaker. If restaker is a contract whose
  `onERC721Received` calls `TegridyStaking.claimUnsettled()` directly (it's
  permissionless, callable by anyone), it drains the shared
  `unsettledRewards[address(restakingContract)]` bucket BEFORE
  `unrestake` reads `staking.unsettledRewards(this)` on L553.
  - `unsettledSnapshot` (L308 `restake()`) was set at deposit time
  - Delta computation on L555: `unsettledAfter > depositSnapshot` becomes 0
  - Restaker's legitimate share is lost; the actual gain went to other
    restakers via the shared bucket.
- MITIGATION: The H-06 fix introduced `unsettledSnapshot`, but the snapshot is
  the deposit-time read, not a pre-transfer read. A re-entrant `claimUnsettled`
  during the NFT-receive callback bumps `unsettledRewards(this)` BACK DOWN to
  zero, so the post-transfer read returns 0 → user gets 0 → owed amount goes
  to `pendingUnsettledRewards` (recoverable via `claimPendingUnsettled`).
  Net result: not theft, but the user's unsettled is silently double-deferred,
  and `claimPendingUnsettled` (L603) makes them pay gas to recover what
  should have been atomic. The `nonReentrant` on `unrestake` does NOT block
  re-entry into `staking.claimUnsettled()` because that's a different contract.
- Worst case: another concurrent restaker calls `unrestake` between the victim's
  deferred state and `claimPendingUnsettled` → can drain. The shortfall path
  L573-577 + the `priorPending` accumulator on L558 mitigate but don't eliminate.
- IMPACT: MEDIUM-HIGH (denial of unsettled rewards / griefing). Not tested.
- Numbered: `TegridyRestaking.unrestake` (L470-599), `restake` (L289),
  `claimPendingUnsettled` (L603), `staking.claimUnsettled` (cross-contract).

### ATTACK PATH 4 — TegridyFeeHook.claimFees read-only reentrancy via PoolManager.take (LOW, mitigated by Uniswap V4 lock)
- Surface: `TegridyFeeHook.claimFees(currency, amount)` (L275). Decrements
  `accruedFees[currency]` BEFORE `poolManager.take(...)`. If the
  `revenueDistributor` recipient triggers a callback that calls
  `accruedFees(currency)` view, it reads the decremented value — but Uniswap V4
  PoolManager wraps everything in a `lock()` callback so re-entrancy from outside
  the callback is impossible. CEI is correct.
- IMPACT: LOW. Already correctly handled.
- Numbered: `TegridyFeeHook.claimFees` (L275-282).

### ATTACK PATH 5 — TegridyNFTPool seller-controlled ERC721 onReceived during swapNFTsForETH (MEDIUM)
- Surface: `TegridyNFTPool.swapNFTsForETH` (L232). Loop on L251-253:
  `nftCollection.safeTransferFrom(msg.sender, address(this), tokenIds[i])`.
  The `nftCollection` is a user-set address from `initialize` (factory-controlled
  but factory accepts any IERC721). If the collection is a malicious ERC721 whose
  `transferFrom` re-enters `swapNFTsForETH` with overlapping IDs, the
  `nonReentrant` on the function blocks re-entry. ✓ DEFENDED.
- The seller's own `onERC721Received` doesn't fire (NFT goes pool-bound). Pool's
  own `onERC721Received` (L552) only allows operator ∈ {owner, this, factory}
  — but in `swapNFTsForETH` the operator is the pool contract itself. ✓ Trip-up:
  during loop iteration N, pool calls `nftCollection.safeTransferFrom(seller, this, id)`
  → `_checkOnERC721Received(seller, this, this, id, "")` fires `this.onERC721Received`
  → operator is `this` ✓. No reentrancy issue. Subsequent _sendETH uses
  10k stipend.
- IMPACT: LOW. Defended.
- Numbered: `TegridyNFTPool.swapNFTsForETH` (L232), `onERC721Received` (L552).

### ATTACK PATH 6 — Multi-hop router→pair→pair-token-callback→adjacent-pair-stale-reserves (HIGH, depends on token type acceptance)
- Surface: `TegridyRouter._swap` (L404). For path = [A,B,C], hop 1 sends A→B
  to pairBC. Pair AB.swap() transfers B to pairBC; if B is a token whose
  transfer hook calls `TegridyRouter.swapExactTokensForTokens` for an unrelated
  path that uses pairBC, the second swap reads pairBC.getReserves() which is
  STALE relative to the just-deposited B (pair AB has not yet been updated
  since this is mid-transfer). Wait — `TegridyPair.swap` updates reserves
  BEFORE outbound transfer (H-01 fix). So _update on pairAB happens, then B
  flows to pairBC. The destination-pair (pairBC) sees actual `balanceOf(pairBC)`
  fully up-to-date because the transfer is what feeds it. The remaining gap
  is that pairBC's internal `reserve0/reserve1` haven't been updated — the
  next call to pairBC.swap() in hop 2 would read fresh balanceOf and compute
  amount0In correctly.
- Read-only attack: `TegridyRouter.getAmountsOut` static view called from a
  re-entrant view returns stale answers — but the actual swap execution uses
  pair-balance-based pricing inside hop 2. Damage limited to off-chain
  quote staleness.
- However, an adjacent pair (pairBD) NOT in this swap path could have its
  reserves manipulated: B's transfer hook calls
  `TegridyPair(pairBD).skim(attacker)` → pulls excess B donated earlier.
  Skim is `nonReentrant` per pair, but each pair has its own guard.
- IMPACT: MEDIUM. Hinges on whether any deployed token has transfer hooks.
  Documented unsupported but not blocked at runtime for non-ERC777 callback
  tokens.
- Numbered: `TegridyRouter._swap` (L404), `TegridyPair.swap` (L183),
  `TegridyPair.skim` (L255).

### ATTACK PATH 7 — TegridyLending ETH-floor sandwich during acceptOffer (DOCUMENTED, MEDIUM)
- Surface: `TegridyLending._positionETHValue` (L715). Reads
  `ITegridyPair(pair).getReserves()` — sandwich-manipulable inside the same tx.
  Documented as deferred to TWAP. Not strictly reentrancy but cross-contract
  state-trust assumption.
- Numbered: `TegridyLending.acceptOffer` (L403), `_positionETHValue` (L715).

## Counts

- Total contracts in scope: **10**
- Total external-call sites to user/token addresses: **~60** (rough)
- `nonReentrant` coverage: **all public state-mutating fns across all 10 contracts**
- ETH `.call` sites with full gas: **0** in audited scope (all use stipend or
  WETHFallbackLib)
- ERC721 callback receivers: **2** (`TegridyNFTPool.onERC721Received`,
  `TegridyRestaking.onERC721Received`); both restrict caller.
- Read-only reentrancy windows found: **3** — all either gated by stipend
  budget (10k/50k) or already CEI-fixed. Most plausible: Path 3 (Restaking
  unsettled race during NFT-receive callback).
- ATTACKs not covered by RedTeam_CrossContract: Paths **1, 3, 6** (custom-token
  callback chains and Restaking unsettled-race).

## File references (absolute paths)

- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyPair.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyRouter.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\SwapFeeRouter.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyFeeHook.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\POLAccumulator.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\RevenueDistributor.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyNFTPool.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyLending.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyNFTLending.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\src\TegridyRestaking.sol`
- `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms\contracts\test\RedTeam_CrossContract.t.sol`
