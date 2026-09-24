# Agent 52 — ERC-777 Callback Abuse Audit

**Lens:** ERC-777 callback / ERC-1820 hook re-entrancy across all token-accepting contracts.
**Scope:** All Solidity under `contracts/src/`.
**Date:** 2026-05-07
**Working dir:** `C:\Users\jimbo\OneDrive\Desktop\tegriddy farms`

---

## Token-Entry Surface Inventory

| Contract | Arbitrary token? | Gate | Recipient hook risk |
|---|---|---|---|
| `TegridyFactory.createPair` | YES (any token0/token1) | `_rejectERC777` (best-effort) | n/a — view |
| `TegridyPair.swap` / `mint` / `burn` | NO (token0/token1 fixed at init) | factory rejection at creation | CEI + FoT post-balance check |
| `TegridyRouter.*` | YES (path[0]) | gated by Pair existence (i.e., factory pre-check) | `nonReentrant` |
| `SwapFeeRouter.swap*` (5 variants) | YES (path[0]) — **NO WHITELIST** | none | `nonReentrant` + CEI |
| `SwapFeeRouter.convertTokenFeesToETH{,FoT}` | YES (token param) | only if accumulator non-zero | CEI + cooldown + TWAP floor |
| `VoteIncentives.depositBribe` | YES (token param) | `whitelistedTokens[token]` (admin-only) | `nonReentrant` + balance-diff |
| `VoteIncentives.depositBribeETH` | ETH only | n/a | `nonReentrant` |
| `TegridyLPFarming` | NO (immutable stakingToken/rewardToken) | n/a | — |
| `TegridyStaking` | NO (immutable rewardToken) | n/a | — |
| `TegridyRestaking` | NO (immutable rewardToken/bonusRewardToken) | n/a | — |
| `TegridyLending` | NO (ETH only for principal) | n/a | — |
| `TegridyNFTLending` | NO (ETH only for principal) | n/a | — |
| `TegridyNFTPool` | NO (single fixed `nftCollection` ERC-721) | n/a | buyer-callback re-entry blocked |
| `TegridyNFTPoolFactory.createPool` | NO (NFT only, single collection) | n/a | `nonReentrant` |
| `CommunityGrants` | NO (toweli only) | n/a | — |
| `PremiumAccess` | NO (toweli only) | n/a | — |
| `TegridyFeeHook.convertERC20FeesToETH` | YES (currency param from V4 PoolManager) | owner-only multi-hop, TWAP floor | CEI + 24h sync timelock |
| `MemeBountyBoard` | ETH only | n/a | `nonReentrant` |
| `RevenueDistributor` | ETH only on `receive()` | n/a | `nonReentrant` |
| `POLAccumulator` | ETH only on `receive()` | n/a | `nonReentrant` |
| `TegridyDropV2` / `TegridyLaunchpadV2` | n/a — no token movement | n/a | — |

---

## Key Observation: ERC-1820 Recipient-Registration Strict Spec

Per ERC-777 §"Operators and Recipient Hooks", a strict ERC-777 token MUST revert
when sending to a contract recipient that has NOT registered a `TokensRecipient`
implementer with the canonical ERC-1820 registry (`0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24`).

**Verified:** NO contract in `contracts/src/` registers a `TokensRecipient` /
`tokensReceived` implementer (`Grep` for `setInterfaceImplementer` /
`tokensReceived` returned no matches).

**Consequence:** A strict ERC-777 token cannot be deposited into any Tegriddy
contract — `safeTransferFrom(user, contract, amount)` reverts in the token's
internal `_callTokensReceived` check before any state mutates on the Tegriddy
side. This closes the bulk of the canonical ERC-777 reentrancy class.

**Residual threat:** "Lenient" ERC-777 hybrids that fire `tokensToSend` /
`tokensReceived` callbacks WITHOUT enforcing recipient registration. Examples
include certain proprietary token deployments and fork-derivatives that drop
the recipient-must-be-registered enforcement to "play nicely" with vanilla
ERC-20 receivers. These can still trigger hooks on the SENDER side (msg.sender
during `safeTransferFrom`) and on the RECEIVER side (during `safeTransfer`) —
the receiver-side hook is the dangerous primitive when the recipient is a
caller-controlled contract.

---

## F-52-1 — Best-effort ERC-777 rejection in TegridyFactory (acknowledged)

**File:** `contracts/src/TegridyFactory.sol:317-364` (`_rejectERC777`)
**Severity:** INFORMATIONAL (already documented in NatSpec)

**Observation:** `_rejectERC777` checks three things:
1. `supportsInterface(0xe58e113c)` (ERC-165) — token can hide by not implementing ERC-165
2. `granularity()` — token can hide by reverting
3. ERC-1820 registry lookup of `ERC777Token` / `ERC777TokensRecipient` / `ERC777TokensSender` — token can hide by not registering

A token that implements `tokensToSend` / `tokensReceived` callbacks WITHOUT the
ERC-165 supportsInterface, WITHOUT a `granularity()` function, AND WITHOUT
ERC-1820 self-registration would silently pass `_rejectERC777` and create a Pair.

**Mitigation already in place (defense-in-depth):**
- `TegridyPair.swap` (line 254-257): CEI ordering, reserves updated BEFORE outbound transfer.
- `TegridyPair.swap` (line 272-273): `FOT_OUTPUT_0` / `FOT_OUTPUT_1` post-balance equality check rejects any token that takes a haircut, donates, or otherwise mutates the pair balance during the outbound transfer (even via callback).
- `TegridyPair.skim` / `sync` (lines 289-316): `nonReentrant` + `disabledPairs` + `blockedTokens` gates.
- `TegridyFactory.proposeTokenBlocked` (line 367+): timelocked owner block path for tokens that slip through `_rejectERC777`.

**Status:** NOT a fresh finding — already disclosed in `_rejectERC777`'s NatSpec
(lines 305-311 explicitly call this best-effort and bypassable). The factory
maintains an off-chain allowlist + on-chain `blockedTokens` for known-bad tokens.

---

## F-52-2 — SwapFeeRouter accepts arbitrary `path[0]` with no whitelist

**File:** `contracts/src/SwapFeeRouter.sol:752, 817, 946, 1007` (5 swap variants)
**Severity:** LOW (recipient-hook surface bounded by upstream defenses)

**Observation:** All `swapExactTokens*` variants do
`IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn)` with NO
whitelist of allowed input tokens. A lenient ERC-777 hybrid with a
`tokensToSend` hook fires on `msg.sender` (the user) during the pull.

**Hook re-entry path (sender-side):**
1. User sets `path[0] = LENIENT_ERC777`, calls `SwapFeeRouter.swapExactTokensForETH(...)`.
2. `safeTransferFrom` invokes `LENIENT_ERC777._callTokensToSend(user, ...)`.
3. The user's pre-registered `tokensToSend` implementer fires.
4. The implementer attempts to re-enter `SwapFeeRouter` → BLOCKED by `nonReentrant`.
5. The implementer attempts to enter `TegridyRouter` → BLOCKED by `TegridyRouter`'s `nonReentrant` (verified line 205-394).
6. The implementer attempts to call `VoteIncentives.depositBribe` — BLOCKED by `VoteIncentives.depositBribe`'s `nonReentrant` only IF the OUTER call frame is also a VoteIncentives call. Here it is NOT — outer is SwapFeeRouter — so this is a CROSS-CONTRACT entry, not a re-entry, and `nonReentrant` does NOT block it.

**However** — the cross-contract entry into `VoteIncentives.depositBribe` is a
fresh, well-formed call. It pulls from `msg.sender` (which is the hook
implementer — also a contract under attacker control) per `whitelistedTokens`.
There is no manipulable state on the SwapFeeRouter side that VoteIncentives
reads, so the cross-call cannot be exploited to shift accounting.

**Recipient-side hook (during output return):**
- `swapExactETHForTokensSupportingFeeOnTransferTokens` line 886-911 routes
  output to `address(this)` (SwapFeeRouter) and then `safeTransfer(to, userAmount)`
  to the caller. If OUT token is lenient ERC-777, the recipient-side hook fires
  on SwapFeeRouter (no implementer registered → no-op for lenient
  implementations) THEN fires again on `to` (caller).
- The `to`-side hook can re-enter SwapFeeRouter — `nonReentrant` blocks.
- The `to`-side hook can re-enter the inner Uniswap router — that router has
  its own per-call nonReentrant via the wrapping pair's nonReentrant.

**Net assessment:** The recipient-hook surface in SwapFeeRouter is ATTENUATED
by the layered `nonReentrant` guards in SwapFeeRouter, TegridyRouter, and each
TegridyPair. No state-corruption primitive surfaces.

**Recommendation (defense-in-depth, not a bug):** Add an optional
`blockedInputTokens` mapping similar to the factory's `blockedTokens`, so
governance can block known-bad tokens from being used as `path[0]` even when
the underlying Uniswap pair is healthy. The Uniswap V2 fee-on-transfer
behavior already discourages abusive tokens economically; this would be
operational hygiene rather than a security fix.

---

## F-52-3 — VoteIncentives bribe-claim batch loop with multiple ERC-777 tokens

**File:** `contracts/src/VoteIncentives.sol:894-992` (`claimBribesBatch`)
**Severity:** INFORMATIONAL — properly defended

**Observation:** `claimBribesBatch` iterates over `epochBribeTokens[e][pair]`
and calls `_safeTransferExternal(token, msg.sender, share)` for each. If
multiple bribe tokens in the same epoch/pair are lenient ERC-777, EACH call
fires a `tokensReceived` hook on `msg.sender` mid-loop.

**Defenses verified:**
1. `claimed[msg.sender][e][pair][token] = true` is set BEFORE the transfer
   (line 945) — same-token re-entry into the same loop iteration is idempotent.
2. `claimBribesBatch` is `nonReentrant` — re-entry into the same function is
   blocked by `_status == _ENTERED`.
3. `_safeTransferExternal` has `require(msg.sender == address(this))` and is
   wrapped in `try/catch` — a hook revert credits `pendingTokenWithdrawals`
   instead of unwinding the whole batch.
4. Cross-function re-entry into `claimBribes`, `vote()`, `depositBribe()`,
   `withdrawPendingToken`, `refundOrphanedBribe`, `refundUnvotedBribe`,
   `refundSubQuorumBribe` — all `nonReentrant`. The OZ ReentrancyGuard `_status`
   is shared across the entire contract, so the outer guard locks all entry
   points during the hook.
5. The `MIN_BRIBE_CLAIM_QUORUM` + `depositedOnPair` self-bribe lockout +
   `VOTE_DEADLINE` claim-window gating prevent the classic
   "vote-bribe-self-vote-claim-bond-back" cycle.

**Residual concern (not exploitable):** The `bribeAmount = epochBribes[e][pair][token]`
read happens INSIDE the loop. If the hook could mutate `epochBribes` from
another contract path, subsequent iterations would see stale-or-fresh values.
But all `epochBribes` writes are inside `nonReentrant` paths, so mid-loop
mutation is impossible.

**Status:** No exploit. Defense layering is correct.

---

## F-52-4 — TegridyFeeHook accepts arbitrary V4 PoolManager currency

**File:** `contracts/src/TegridyFeeHook.sol:558-617` (`convertERC20FeesToETH`)
**Severity:** LOW (gated to whatever the V4 pool's `currency` happens to be)

**Observation:** The fee hook is called by Uniswap V4 PoolManager and
accumulates fees in whatever the pool's underlying currency is. If the V4 pool
is a Tegriddy-deployed pool, `currency` is bounded by the V4 hook's pair
selection. But the hook would also accept fees from any V4 pool that points
its hook contract here.

**Defenses:**
- `convertERC20FeesToETH` is `onlyOwner`, `nonReentrant`, `whenNotPaused`.
- Multi-hop `path` validation requires `path[0] == currency` and `path[len-1] == WETH`.
- TWAP-floor `minETHOut` enforcement (line 572): `< 1e14` reverts.
- 24h timelock on `proposeSyncAccruedFees` prevents instant fee destruction.
- CEI: `accruedFees[currency]` decremented BEFORE the swap (line 595).

**ERC-777 hook entry path:**
1. V4 PoolManager pushes lenient ERC-777 fee tokens into `TegridyFeeHook`.
2. Hook fires `tokensReceived` on TegridyFeeHook → no implementer registered →
   strict ERC-777 reverts (the fee push fails). Lenient ERC-777 no-ops.
3. Owner calls `convertERC20FeesToETH(currency, ...)`.
4. `forceApprove(router, amount)` triggers token's `tokensToSend` hook on
   TegridyFeeHook → no implementer → no-op.
5. `router.swapExactTokensForETH` — inner pair is `nonReentrant`.
6. Recipient of the swap is `address(this)` (TegridyFeeHook). Hook fires on
   TegridyFeeHook again. CEI already decremented `accruedFees`, so even a
   re-entry attempt finds no extra fees to drain.

**Status:** No exploit. CEI + onlyOwner + timelock layering is correct.

---

## F-52-5 — Cross-contract reentrancy through hook into VoteIncentives/Lending state reads

**File:** Cross-contract analysis
**Severity:** INFORMATIONAL — no exploit identified

**Observation:** A hook fired during a SwapFeeRouter or TegridyRouter swap
could read state from VoteIncentives, Lending, etc. But:
- VoteIncentives state reads (`gaugeVotes`, `totalGaugeVotes`, `epochBribes`)
  are only consumed inside `claimBribes*` paths, which are all `nonReentrant`.
  An attacker cannot exploit a stale read in another VoteIncentives function
  because writes are guard-locked.
- Lending escrow state (`unsettledRewardsByTokenId`) is read at loan
  acceptance/settlement; the lending contract uses ETH only (no ERC-777 ingress).
- TegridyStaking position reads: the Position struct read happens via static
  external view in `TegridyLPFarming` and `TegridyRestaking`. These reads are
  used inside `nonReentrant` write paths, so a hook cannot inject during a
  read-then-write window.

**Status:** No cross-contract reentrancy primitive identified.

---

## F-52-6 — NFT recipient hook (ERC-721 onERC721Received) confirmed defended

**File:** `contracts/src/TegridyNFTPool.sol:777-801` (`onERC721Received`)
**Severity:** INFORMATIONAL (existing defense verified)

**Observation:** `safeTransferFrom(address(this), buyer, tokenId)` triggers
`onERC721Received` on a contract buyer. The buyer's hook can attempt to
deposit arbitrary tokenIds back into the pool during the swap.

**Defense verified (lines 783-796):**
- `msg.sender == nftCollection` (only the registered collection can deposit)
- During `_swapInFlight`, `from` MUST equal `_swapCaller` — buyer-as-`from`
  rejected (UNAUTHORIZED_DEPOSIT)
- `swap*` functions are `nonReentrant` — re-entering the swap is blocked

**Status:** Not an ERC-777 vector but the analogous ERC-721 callback class is
explicitly fenced. Audit comment V2-NFTPOOL-01 documents the prior fix.

---

## F-52-7 — TegridyNFTPoolFactory.createPool with malicious nftCollection

**File:** `contracts/src/TegridyNFTPoolFactory.sol:194-278` (`createPool`)
**Severity:** INFORMATIONAL (existing defense verified)

**Observation:** A malicious NFT collection's `safeTransferFrom` could
re-enter `createPool` during the initial liquidity transfer (line 273).

**Defense:** `createPool` is `nonReentrant` (BATCH-H M9, line 201). Mid-call
re-entry to bypass MAX_POOLS_PER_COLLECTION is blocked.

**Status:** Defended.

---

## Notes / Dead Ends

- **VoteIncentives self-`_safeTransferExternal`:** the `external` self-call
  path is concerning at first glance because OZ's `nonReentrant` modifier
  applies per-function-via-status-flag and the helper is unguarded. But
  `require(msg.sender == address(this))` ensures it's only callable from the
  outer `claimBribes` / `claimBribesBatch`, which ARE `nonReentrant`. The OZ
  status flag is set in the OUTER frame and protects the entire contract for
  the duration of the outer call. Verified safe.
- **Lending pullEscrowRewards:** rewards are TOWELI (a plain ERC-20Permit
  token, no hooks). No ERC-777 surface.
- **TegridyDropV2 / TegridyLaunchpadV2 / GaugeController / ReferralSplitter:**
  no `safeTransferFrom` / `safeTransfer` calls (these contracts either don't
  hold tokens or operate on accounting only).
- **`CommunityGrants` / `PremiumAccess`:** only handle TOWELI. Not an
  ERC-777 vector.
- **ERC777 hybrid fee-on-transfer combos:** the protocol's pair-level
  `FOT_OUTPUT` post-balance equality check (TegridyPair.sol:272-273) rejects
  any token that mutates pair balance during the outbound transfer, including
  via hook side-effects. This is the load-bearing defense against hybrids
  that pass `_rejectERC777` but exhibit FoT-via-hook behavior.

---

## Summary

ERC-777 callback abuse is comprehensively defended at the protocol level
through five independent layers:

1. **TegridyFactory `_rejectERC777`** (contracts/src/TegridyFactory.sol:317-364):
   ERC-165 + `granularity()` probe + ERC-1820 lookup of all three hook
   interfaces. Best-effort, acknowledged as bypassable for non-canonical
   ERC-777 implementations.
2. **TegridyPair CEI + FoT-output check**
   (contracts/src/TegridyPair.sol:254-273): reserves update BEFORE outbound
   transfer; post-balance equality assertion catches any token that mutates
   pair balance via callback.
3. **No ERC-1820 recipient registration** anywhere in `contracts/src/` — strict
   ERC-777 reverts on push to any Tegriddy contract.
4. **Whitelist gating** on the only permissionless arbitrary-token deposit
   path (`VoteIncentives.depositBribe`).
5. **`nonReentrant` blanket** on every state-mutating function across
   SwapFeeRouter, TegridyRouter, TegridyPair, TegridyNFTPool, VoteIncentives,
   Lending, NFTLending, Restaking, LPFarming, and Staking.

No fresh exploit identified. All findings are informational confirmations of
existing defenses or LOW-severity defense-in-depth recommendations
(F-52-2 optional input-token blocklist on SwapFeeRouter).

**Files referenced:**
- `contracts/src/TegridyFactory.sol`
- `contracts/src/TegridyPair.sol`
- `contracts/src/TegridyRouter.sol`
- `contracts/src/SwapFeeRouter.sol`
- `contracts/src/VoteIncentives.sol`
- `contracts/src/TegridyFeeHook.sol`
- `contracts/src/TegridyNFTPool.sol`
- `contracts/src/TegridyNFTPoolFactory.sol`
- `contracts/src/TegridyLPFarming.sol`
- `contracts/src/TegridyStaking.sol`
- `contracts/src/TegridyRestaking.sol`
- `contracts/src/TegridyLending.sol`
- `contracts/src/TegridyNFTLending.sol`
- `contracts/src/Toweli.sol`
- `contracts/src/MemeBountyBoard.sol`
- `contracts/src/POLAccumulator.sol`
- `contracts/src/RevenueDistributor.sol`
- `contracts/src/CommunityGrants.sol`
- `contracts/src/PremiumAccess.sol`
- `contracts/src/TegridyDropV2.sol`
- `contracts/src/TegridyLaunchpadV2.sol`
- `contracts/src/GaugeController.sol`
- `contracts/src/ReferralSplitter.sol`
- `contracts/src/TegridyTWAP.sol`
- `contracts/src/TegridyStakingJbacVault.sol`
