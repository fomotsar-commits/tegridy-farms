# External Integration Brittleness Audit — post_fix_scan5

**Date:** 2026-05-09
**Branch:** main @ HEAD (d5ca554)
**Mandate:** `memory/feedback_minimal_surface.md` — custom code IS the attack surface; copy from billion-dollar protocols verbatim. This audit asks the inverse question: **what does the protocol assume about the EXTERNAL integrations it does not control, and what happens when those assumptions are violated?**

---

## Summary classification

| # | Integration | Status |
|---|---|---|
| 1 | Chainlink L2 Sequencer Uptime Feed | DEFENDED |
| 2 | Uniswap V4 PoolManager (TegridyFeeHook) | ASSUMED |
| 3 | Uniswap V2 fork (TegridyFactory/Pair internal) | DEFENDED |
| 4 | JBAC NFT (`0xd37264c71e9af940e49795F0d3a8336afAaFDdA9`) | ASSUMED |
| 5 | JBAY Gold (`0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3`) | NOT PRESENT |
| 6 | WETH9 (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` etc.) | DEFENDED |
| 7 | TOWELI (own-protocol token) | DEFENDED |
| 8 | Solady ERC721 (TegridyStaking) | DEFENDED |
| 9 | OZ-equivalent in-tree TimelockAdmin | DEFENDED |
| 10 | Off-chain merkle tree generator (TegridyDropV2) | ASSUMED (operator-supplied) |
| 11 | Front-end / indexer ABI shape | ASSUMED (regen-on-change discipline) |

No `BROKEN` findings — but several `ASSUMED` integrations are worth re-reading explicitly because they sit one upgrade away from real risk.

---

## 1. Chainlink L2 Sequencer Uptime Feed — **DEFENDED**

**File:** `contracts/src/lib/SequencerCheck.sol` (415 LoC); consumers: `SwapFeeRouter`, `MemeBountyBoard`, `TegridyDropV2`, `TegridyLending`, `TegridyNFTLending`, `POLAccumulator`, `TegridyTWAP`, `VoteIncentives`, `TegridyFactory`, `TegridyNFTPoolFactory`, `TegridyLaunchpadV2`, `ReferralSplitter`, `CommunityGrants`, `GaugeController`.

### Canonical assumption
- `latestRoundData()` returns `(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)`.
- `answer == 0` → sequencer up; `answer != 0` → down. Strictly enforced (not `answer == 1`).
- `startedAt` = wall-clock of the current up answer; subtracted from `block.timestamp` to enforce a post-resume grace.
- Per-chain feed addresses (Arbitrum/Optimism/Base) are immutable and stable.

### Violation response
| Failure mode | Behavior |
|---|---|
| Feed reverts (decommissioned) | `latestRoundData()` reverts → consumer reverts via `SequencerCheck` → swap/lending/drop fails closed. Off-chain monitors must catch and re-wire. |
| Feed returns `updatedAt == 0` | `revert SequencerGracePeriodNotOver()` — fail closed. |
| Feed returns `answeredInRound < roundId` | `revert SequencerDown()`. |
| `block.timestamp - updatedAt > 24h` | `revert SequencerDown()` — keeper-lapse guard (Aave V3 `PriceOracleSentinel` pattern). |
| `updatedAt > block.timestamp` (clock skew on bridged feed) | `revert SequencerDown()` — fail closed (V2-LIB-M1, v3-LIB-M1). |
| `answer == 2` (hypothetical "degraded" extension) | `revert SequencerDown()` — strict `!= 0` check (M-Lib3). |
| `answer == -1` (typed-bug from bridged feed) | `revert SequencerDown()`. |
| Feed `decimals` change | **NOT READ** — protocol never calls `decimals()`. Boolean uptime convention is inferred only from `answer == 0`. No brittleness. |
| `feed == address(0)` on L2 | `revert SequencerFeedNotConfigured()` — H-9 / FRESH-2026 fix; deploy-time gate also rejects (lines 829 of `TegridyLending`). |

### Blast radius
None — the lib fails closed on every anomaly. The only DoS shape is the entire L2 deployment going dark while Chainlink rotates feeds, which is the intended emergency-state behavior. Off-chain monitor hook: `tryCheckSequencerUp` returns `(false, reason)` for indexers/quoters without DoS-bombing reads.

### Mitigation
Already in place. The `getResumeTimestamp()` helper additionally returns `type(uint256).max` on stale paths so consumer comparisons of the form `observation.timestamp >= resumeAt + GRACE` overflow checked-math (M-34/F-40-SEQ-2). The mainnet fast-path no-op (`feed == address(0) && chainid == 1`) is the one branch that silently passes — but mainnet has no sequencer concept so this is structurally correct.

---

## 2. Uniswap V4 PoolManager (TegridyFeeHook callbacks) — **ASSUMED**

**File:** `contracts/src/TegridyFeeHook.sol`. Imports from `@uniswap/v4-core` directly (`IHooks`, `IPoolManager`, `PoolKey`, `BalanceDelta`, `BeforeSwapDelta`, `Currency`).

### Canonical assumption
- `IHooks` lifecycle method signatures are stable (`afterSwap` returns `(bytes4, int128)`).
- `BalanceDelta` is from the swapper's perspective (negative = paid, positive = received).
- The unspecified-side fee-extraction pattern (`hookDeltaUnspecified` returned by `afterSwap`) is settled by `poolManager.take(currency, address(this), amount)` from inside the unlock context.
- The hook address must encode permission flags in its low 14 bits (`0x3FFF`); deployment uses CREATE2 salt-mining to produce `addr & 0x3FFF == 0x0044` for `afterSwap | afterSwapReturnsDelta`.
- `Currency.unwrap(currency)` returns the underlying ERC20 address (or `address(0)` for native ETH).
- `poolManager.balanceOf(this, currencyId)` returns the hook's claimable ERC6909 credit balance.

### Violation response
| Failure mode | Behavior |
|---|---|
| `IHooks.afterSwap` signature changes in a future v4-core version | Compile-time break on ABI mismatch when redeployed against new v4-core. Live deployment is pinned to a specific compiled v4-core; no in-place upgrade possible. |
| `Currency.unwrap()` semantics change (e.g. tagged-pointer encoding) | `accruedFees[creditToken] += feeUint` would map to a wrong key — silent fee-accounting corruption. Defended by `poolManager.take(feeCurrency, ...)` which uses the V4 `Currency` type natively, so the *transfer* still works; only the off-chain reconciliation key is at risk. |
| `currency.take()` rejects (e.g. ERC6909 mint fails) | The whole swap reverts via `CurrencyNotSettled` at unlock-close (this is what PASS7-HOOK-01 fix already addressed). |
| PoolManager rejects hook with permission mask `0x0044` in v5+ | Pool creation reverts at `initialize`; existing pools keep working. |
| Hook permission bitmask widens past 14 bits in a future v4 release | `require(uint160(addr) & 0x3FFF == 0x0044)` accepts our deployment by construction. The constructor's mask is hard-coded; any v4 evolution that requires bits 14+ must be deployed with a new mask. NatSpec at line 191-198 explicitly flags this as a future-revision dependency. |
| `PoolKey` struct shape change | `_poolKeyHash(key) = keccak256(abi.encode(key))` — any ABI-encoding change breaks the allowlist. Every pre-approved pool would silently slip to the default `accruedFees == 0` branch (NOT a revert — `afterSwap` returns zero fee). |
| `BeforeSwapDelta` zero-delta semantics flip | `afterSwap` only checks `amount0 == 0 && amount1 == 0` early-out. A future v4 that re-defines zero-delta could subtly change fee-extraction edge cases — but never introduce a stuck-fund condition (the fee math gates on `swapAmount > 0`). |

### Blast radius
- **Worst-case (mass bug):** signature/permission-mask change makes the hook unusable across ALL pools. Fee accumulation halts; existing accrued fees are still claimable via `claimFees` / `convertERC20FeesToETH` (those don't depend on PoolManager callback shape — they only depend on the ERC20 balance the hook holds).
- **Worst-case (silent data corruption):** none — the hook's storage shape is decoupled from PoolManager internals.

### Mitigation
- **Already hardened:** the hook does NOT trust V4 to identify its calling pool; `approvedPools[_poolKeyHash(key)]` is the secondary auth gate. A malicious pool that gets routed through the hook gets a zero-fee return.
- **Already hardened:** `MustConvertERC20First` and the WETH-only `claimFees` path mean stranded ERC20 fees CAN be unstuck even if the V4 callback shape becomes uncallable.
- **Not hardened (acceptable):** the contract pins a specific v4-core import. Future v4 revisions require a fresh deploy and a CREATE2-mined address with the new permission mask — this is the inherent V4 hook design pattern, not a Tegridy bug.

---

## 3. Uniswap V2 fork (TegridyFactory / TegridyPair internal) — **DEFENDED**

**Files:** `contracts/src/TegridyFactory.sol`, `contracts/src/TegridyPair.sol`. Tokens routed into pairs are external to the protocol but the factory enforces creation-time gates and the pair enforces per-swap balance gates.

### Canonical assumption
- Tokens behave like canonical ERC20 (no transfer hooks, no fee-on-transfer, no rebase, no upgrade to hostile token mid-life).
- Standard ERC-20 `balanceOf`/`transfer` semantics; no callback into the pair.

### Violation response
| Failure mode | Behavior |
|---|---|
| Token registers ERC-1820 hook post-creation (ERC-777 retroactively) | `_rejectERC777` is creation-time only (line 387-446). Already-deployed pair would let cross-contract reentrancy through. **Mitigated** by the per-swap `FOT_OUTPUT_0`/`FOT_OUTPUT_1` post-balance equality check (line 320-321) which catches any output-side balance drift, and by `nonReentrant` on swap/mint/burn/skim/sync/harvest. |
| Token upgrades to fee-on-transfer mid-life | Same per-swap post-balance check reverts every subsequent swap — the pair becomes effectively dead but no value leaks. NatSpec line 311-321 explicitly documents this is the design intent (NEW-A1). |
| Token returns `false` from `transfer` instead of reverting | `SafeERC20.safeTransfer` reverts on `false` return — DEFENDED. |
| Token `balanceOf` reverts | `mint`/`burn`/`swap`/`skim`/`sync` revert; pair becomes locked. **Acceptable** — locked liquidity is recoverable via burn-as-LP-holder once the token is fixed (or never, but no worse than dead). |
| Token has supply > `uint112.max` | `_update` `require(balance0 <= type(uint112).max)` reverts on first transfer-into-reserves — pair is unusable at deploy time, never accumulates corrupted state. |
| Token contract `selfdestruct`s | Pair becomes unusable; no value leak (token is gone). |
| Token `code.length == 23` (EIP-7702 delegated EOA) | Factory rejects at `createPair` (line 233 — `t0len != 23 && t1len != 23`). DEFENDED. |
| Pair receives unsolicited token donation | `skim()` is permissionless and gated on `disabledPairs`/`blockedTokens` (D-AMM-H2 fix). Donation cannot poison TWAP cumulative because the pair gates ALL state-mutating paths (`sync`, `skim`, `harvest`) on the disable flag. |
| First-depositor inflation attack | `MINIMUM_LIQUIDITY * 1000` floor on initial liquidity (line 165) makes the inflation attack uneconomical. |

### Blast radius
Single-pair lock at worst. Factory-level guardian + 24-48h timelocked `disabledPairs`/`blockedTokens` rotation surface allows operator response without the hostile token reaching governance-class contracts.

### Mitigation
Anything missing? The post-creation token mutation case (an already-deployed token upgrading via proxy to add `tokensReceived` hooks) is structurally defended by the per-swap `FOT_OUTPUT_*` post-balance gate AND the `ReentrancyGuard.nonReentrant` modifier, so even an ERC-777-on-day-2 token cannot drain the pair — it just becomes a dead pair.

---

## 4. JBAC NFT (`0xd37264c71e9af940e49795F0d3a8336afAaFDdA9`) — **ASSUMED**

**Files:** `contracts/src/TegridyStakingJbacVault.sol`, `contracts/src/TegridyStaking.sol`, `contracts/src/PremiumAccess.sol`.

### Canonical assumption
- Hardcoded address passed through constructor as `_jbacNFT`; stored as `IERC721 immutable jbacNFT`.
- `ownerOf(tokenId)` returns the holder's address.
- `safeTransferFrom` succeeds for valid (owner, recipient, tokenId) tuples.
- `balanceOf(user) > 0` indicates the user holds at least one JBAC.
- Token IDs are non-zero (the vault's `claimStrandedJbac` defensive check rejects `jId == 0`).

### Violation response
| Failure mode | Behavior |
|---|---|
| JBAC contract is upgradeable (proxy) and changes implementation | All of `ownerOf`, `safeTransferFrom`, `balanceOf` could behave arbitrarily. `safeTransferFromBounded` (in TegridyLending/TegridyNFTLending) caps returndata copy and gas budget; staking does NOT use the bounded helper for JBAC reads — it relies on direct calls. |
| `ownerOf` returns arbitrary data (returndata bomb) | TegridyStaking calls `IERC721(jbacNFT).balanceOf(msg.sender)` and `safeTransferFrom` directly. Solidity's `try/catch` is NOT used here — the call would consume returned data via standard dispatch. **POTENTIAL BRITTLENESS:** if JBAC ever ships a malicious implementation, `revalidateBoost` and `stakeWithBoost` could OOG. The vault's `returnJbac` already wraps `safeTransferFrom` in `try/catch` so the stranded-JBAC path is safe. |
| JBAC contract pauses | `safeTransferFrom` reverts. The vault's `try/catch` in `returnJbac` (line 92-99) catches this and routes to `strandedJbacOwner` for later reclaim. DEFENDED for return path. Inbound transfers in `stakeWithBoost` would revert (acceptable — user retries when JBAC unpauses). |
| JBAC tokenId 0 is mintable | The vault rejects `jId == 0` explicitly (line 113-114). The staking `jbacTokenId: 0` sentinel means "no JBAC deposited" — if a real tokenId 0 ever lands here, it's misclassified as legacy-grandfathered. **Mild brittleness but acceptable** because JBAC was deployed years ago and the registered token IDs do not include 0. |
| JBAC implementer adds royalty/fee on transfer | Not a fee-on-transfer ERC20; ERC721 transfers are unit-quantity and don't lose tokens. Indirect risk: the ERC721's tokensReceived-style callback into the vault. The vault's `onERC721Received` (line 124-131) only accepts inbound from `address(jbacNFT)`, blocking unrelated callback abuse. |

### Blast radius
- **Stranded JBAC NFTs** if JBAC contract pauses during a position close — but the `claimStrandedJbac` recovery path is wired correctly.
- **Boost manipulation** if JBAC `ownerOf` ever lies. This was already mitigated by switching from flash-loan-able `balanceOf > 0` (H-1) to the deposit-based pattern: the user MUST physically transfer the JBAC into the vault. Once the JBAC is in the vault, the boost is anchored to the deposit, not to ongoing `ownerOf` reads.

### Mitigation
The protocol assumes JBAC is the well-known deployed JBAC NFT contract (a static, non-upgradeable collection per public Etherscan history). If JBAC is ever migrated or upgraded:
- A new staking deploy with the new JBAC address would be required.
- The current immutable wiring is the correct choice — a settable JBAC address would be a captured-owner attack surface (M-32 logic applies).

**Recommended (not blocking):** add `safeOwnerOfBounded`/bounded transfer in `TegridyStaking` for the JBAC paths to match `TegridyLending`/`TegridyNFTLending` (already in `lib/SafeERC721Call.sol` — see `_collateralContract` callsites at line 561, 725, 733, 1022 in `TegridyLending.sol`). This is defense-in-depth against future-JBAC-upgrade, not a current bug.

---

## 5. JBAY Gold (`0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3`) — **NOT PRESENT IN CODE**

**Search:** No matches for `0x6Aa03F42` or `JBAY` or `jbayGold` anywhere in `contracts/src/**`.

### Canonical assumption
None — the integration was discussed in earlier audit rounds but is **not wired in the current code**.

### Violation response
N/A — no on-chain dependence exists.

### Blast radius
Zero (nothing to break).

### Mitigation
**Accept-as-design.** PremiumAccess gates exclusively on `jbacNFT` (the JBAC ERC721) and the time-based subscription, not on a JBAY Gold ERC20 balance. If the previous audit findings document expected JBAY Gold gating, that expectation is stale — the current source has dropped it. No security loss; a feature delta to be reflected in product docs.

---

## 6. WETH9 — **DEFENDED**

**Files:** `contracts/src/lib/WETHFallbackLib.sol`; consumers store WETH as `immutable`. Per-chain canonical addresses validated by `contracts/script/CheckCanonicalWETH.s.sol`.

### Canonical assumption
- `deposit() payable` wraps msg.value as WETH credited to caller.
- `withdraw(uint256)` unwraps caller's WETH balance to ETH.
- `transfer(to, amount)` returns `bool true` on success.
- Per-chain WETH9 is canonical and immutable post-deploy.

### Violation response
| Failure mode | Behavior |
|---|---|
| Wrong WETH passed at deploy (e.g. attacker WETH on a fork) | `WETHFallbackLib.safeTransferETHOrWrap(weth, to, amount)` would reroute ETH through an attacker contract on fallback. **Mitigated** by `CheckCanonicalWETH` post-deploy script + immutable storage in every consumer. The lib doesn't validate `weth` itself — that's by design (pass-through reuse). |
| WETH `deposit()` reverts (paused / OOG) | `safeTransferETHOrWrapNoRevert` returns `mode == 3` (deposit failed); ETH stays in caller. Reverting variant `safeTransferETHOrWrap` reverts with `WETHTransferFailed`. |
| WETH `transfer()` returns `false` (some quirky tokens) | `WETHTransferFailed` on the reverting variant; mode==2 stranded-WETH on the no-revert variant. The latter explicitly emits `WETHTransferStuck` so callers can sweep. |
| WETH contract self-destructs (extremely unlikely on canonical WETH) | `deposit()` becomes a no-op (CALL to empty code returns success without value movement). The lib's `transfer` would then revert (no code to dispatch), surfacing as `WETHTransferFailed`. |
| Recipient `to == address(0)` | `revert ZeroRecipient()` (DEEP-LIB-H1). Without this, raw `.call{value:}` to 0x0 succeeds and silently burns ETH. |
| Caller passes 30k stipend but recipient `receive()` needs more | Falls through to WETH wrap path; recipient receives WETH. Stipend was bumped from 10k → 30k (M-36/F-40-WFL-1) to fit cold-SSTORE + LOG2 receivers without spurious fallback. |

### Blast radius
- **Deploy-time mis-wiring:** would route value to an attacker WETH. The `CheckCanonicalWETH` script is a `forge script` that asserts every deployed contract's `weth()` / `WETH()` view returns the canonical per-chain address. Operator MUST run this post-deploy.
- **Live-WETH semantics regression:** never has happened in the WETH9 canonical contracts on mainnet. Quasi-impossible.

### Mitigation
- Immutable storage in every consumer (`RevenueDistributor.weth`, `SwapFeeRouter.WETH`, `TegridyFeeHook.WETH`, `MemeBountyBoard.weth`, `ReferralSplitter.weth`, `TegridyLending.weth`, `POLAccumulator.weth`, `CommunityGrants.weth`, `TegridyNFTPool.weth`, `TegridyDropV2.weth`).
- `OwnableNoRenounce` does not validate the WETH address on transfer — that's the deploy script's job, enforced by `CheckCanonicalWETH`.

---

## 7. TOWELI (own-protocol token) — **DEFENDED**

**File:** `contracts/src/Toweli.sol`.

### Canonical assumption
- Fixed supply (1B), minted exactly once in constructor, no mint/burn/pause/blocklist surface.
- Standard OZ ERC20 + ERC20Permit semantics.
- EIP-712 `version = "1"` baked into the domain separator forever.
- ERC-1271 / SCW compatible permit via `SignatureChecker`.

### Violation response
| Failure mode | Behavior |
|---|---|
| A future fork forgets the `_initialMintDone` guard | The fork's bytecode would allow re-mint. Doesn't affect the canonical mainnet deployment. The `_update` override (line 116-122) hardcodes the once-only mint as a bytecode invariant. |
| A future fork changes the EIP-712 version string | Existing client-side `permit` signatures break. Documented in NatSpec line 37-47 — the lock is intentional. |
| A bridge wrapper deploys with different `name`/`symbol` | Cross-chain signature compatibility breaks (different domain separator). Acceptable — bridged tokens are distinct surfaces. |
| OZ updates `PERMIT_TYPEHASH` literal | The `PERMIT_TYPEHASH_LOCAL` constant (line 81-82) is hardcoded; if OZ ever changes the literal, this contract's signing would diverge. NatSpec line 74-80 flags the dependency. |

### Blast radius
None for the canonical deployment — TOWELI's surface is closed (no admin functions). Forks bear their own risk.

### Mitigation
Already complete. The `_initialMintDone` flag + `_update` override + nonexistent burn/mint entrypoints make the fixed-supply property a bytecode invariant.

---

## 8. Solady ERC721 (TegridyStaking) — **DEFENDED**

**File:** `contracts/src/TegridyStaking.sol` (imports `solady/tokens/ERC721.sol`).

### Canonical assumption
- `_afterTokenTransfer(from, to, id)` is called AFTER the ownership slot is updated for `transferFrom`, `_mint`, AND `_burn` — single hook, replaces Solmate's three-hook model.
- Solady's `_burn` clears `_ownerOf` BEFORE firing `_afterTokenTransfer` so reentrant `transferFrom` from inside the burn callback reverts on empty-ownership (CCR-01 invariant).
- `_beforeTokenTransfer(from, to, id)` is called BEFORE the slot mutates.
- Standard ERC721 surface (`Transfer`/`Approval`/`ApprovalForAll`) is byte-identical.

### Violation response
| Failure mode | Behavior |
|---|---|
| Solady minor-version changes hook ordering | `_clearPosition` would call `vault.returnJbac(...)` BEFORE the staking NFT's ownership slot clears, opening CCR-01 (re-escrow during burn callback). NatSpec line 1334-1351 explicitly anchors the ordering invariant; if Solady ever changes it, the audit-fix premise breaks. The integration is pinned to a specific Solady tag in `package.json` / `contracts/lib/`. |
| Solady major version splits the hook back to before/after | Build break — re-deploy needed. No silent corruption. |
| Solady changes `ownerOf` revert vs return-zero semantics | TegridyStaking uses Solady's `ownerOf` directly; downstream consumers (`TegridyLending.sol:1120`, `TegridyNFTLending.sol`) handle revert-vs-empty in their `try/catch` blocks (line 2093-2096). |

### Blast radius
- **Locked positions** if Solady upgrade breaks the burn ordering. But Solady is pinned at a specific commit, so no implicit upgrade.
- **CCR-01 re-escrow** if a future child contract overrides Solady's `_burn` and reorders the ownership clear — but this would be an in-tree change, caught at audit.

### Mitigation
Already complete. Pin Solady at the audited commit (`contracts/lib/solady/`). The ordering invariant is documented in TegridyStaking NatSpec at line 1344-1351; any in-tree change to the hook order would surface in code review.

---

## 9. In-tree TimelockAdmin (OZ TimelockController-equivalent) — **DEFENDED**

**File:** `contracts/src/base/TimelockAdmin.sol`. Inherited by 14+ contracts.

### Canonical assumption
- `_proposalValidity()` returns the validity window (default 7 days).
- Children may override `_minDelay()` / `_maxDelay()` / `_proposalValidity()`.
- Override returns are ALL floored at `MIN_DELAY` (1 hour).
- `_executeAfter` is `internal` (children read for legacy compatibility); writes MUST go through `_propose`/`_execute`/`_cancel`/`_forceCancel`.

### Violation response
| Failure mode | Behavior |
|---|---|
| Child overrides `_proposalValidity()` to return 0 | Floored at `MIN_DELAY` (1 hour) by the `_execute` body (line 199-204). Cannot collapse the validity window to a 1-second race. |
| Child overrides `_minDelay()` to return 0 | Floored at `MIN_DELAY` by `_propose` body (line 167). Cannot bypass the timelock. |
| Child overrides `_maxDelay()` to return < `_minDelay()` | `_propose` falls back to `MAX_DELAY` (line 173). |
| Child overrides `_proposalValidity()` to return below `MIN_DELAY` and emits a misleading `expiresAt` | `_propose` floors the emitted `expiresAt` at `MIN_DELAY` (F-40-TLA-1). Off-chain monitors see the same window the contract enforces. |
| Child direct-writes `_executeAfter[KEY] = 0` to bypass `ProposalCancelled` | Documented in NatSpec line 42-47 as forbidden; in-tree audit confirms every direct-write path uses `_forceCancel`. New child contracts MUST audit this. |
| `delay > MAX_DELAY` (30 days) | `revert DelayTooLong` (M-Lib1) — bounds the worst-case lockout from a captured owner. |

### Blast radius
None for the canonical deployment. The lib's flooring guards are defense-in-depth against override mistakes; even a buggy override can only TIGHTEN the timelock, never bypass it.

### Mitigation
Already complete. The `_forceCancel` helper + the `internal`-not-`private` `_executeAfter` slot together let children clear stale state with proper event emission. Adding new child contracts requires reading `TimelockAdmin.sol` NatSpec carefully — no automation enforces the invariant.

---

## 10. Off-chain merkle tree generator (TegridyDropV2 allowlist) — **ASSUMED**

**Files:** Solidity verification at `contracts/src/TegridyDropV2.sol:528-545`. The off-chain generator is **not in this repo** — operators (or collection creators) must produce the merkle tree externally and paste the root via `setMerkleRoot`.

### Canonical assumption
- Leaf preimage shape: `keccak256(bytes.concat(keccak256(abi.encode(address(this), msg.sender, allowedAmount))))`.
  - `address(this)` is the deployed clone address, NOT the factory.
  - `msg.sender` is the recipient claiming the proof.
  - `allowedAmount` is the per-claimer cap (uint256).
  - Double-hashed leaf per OZ MerkleTree (NEW-L5) to defeat second-preimage collisions.
- Tree built with OZ `StandardMerkleTree` or compatible (sibling-pair sort).
- `block.chainid` is **NOT in the leaf** — replay across chains relies on the unique deploy address per-chain (not a problem because TegridyDropV2 clones are CREATE2'd with chainid in the factory salt).

### Violation response
| Failure mode | Behavior |
|---|---|
| Generator omits the `allowedAmount` field | All proofs invalid → every allowlist mint reverts `InvalidProof`. Drop is bricked in ALLOWLIST phase but PUBLIC/DUTCH phases unaffected. Owner can fix with `proposeMerkleRoot` + 24h timelock. |
| Generator uses single-hash (no double-keccak) | Same — proofs invalid. |
| Generator passes the factory address instead of clone address | Same — proofs invalid. |
| Generator includes `chainid` in the leaf | Proofs invalid (the on-chain check doesn't prepend chainid). UX degradation only — no security loss. |
| Generator uses sorted-pair vs unsorted-pair construction inconsistently with OZ MerkleProof | Some proofs verify, others don't. **This is the highest-risk failure mode** because partial validity could be exploited by an attacker who finds a sibling-collision on the broken sub-tree. **Mitigation:** the on-chain side uses OZ `MerkleProof.verify` which expects sorted-pair construction (industry standard); generators that produce unsorted leaves break consistently and visibly, not selectively. |

### Blast radius
- Worst case: bricked ALLOWLIST phase. Owner can rotate the root via `proposeMerkleRoot` (24h timelock; phase-gated to CLOSED — H-01/R023). Refunds are available via `cancelSale` if the drop is irrecoverable.
- No security-class loss — the on-chain `allowlistClaimed[msg.sender] + quantity > allowedAmount` cap (line 542-544) prevents over-claiming even with a degenerate generator.

### Mitigation
**Recommended (operator-facing, not blocking):**
- Document the leaf preimage shape in `frontend/README.md` or a dedicated `docs/MERKLE_LEAF.md`.
- Provide a reference generator script under `scripts/generateMerkleTree.ts` using `@openzeppelin/merkle-tree`'s `StandardMerkleTree.of(values, ['address', 'address', 'uint256'])` shape so collection creators don't roll their own.
- Currently NEITHER exists in-repo. The frontend `OwnerAdminPanel`/`OwnerAdminPanelV2` has the operator paste a precomputed `0x...` root (validated only by regex `/^0x[0-9a-fA-F]{64}$/`) — this is the operator's responsibility.

---

## 11. Front-end / indexer ABI shape — **ASSUMED**

**Files:** `frontend/wagmi.config.ts` (regenerates `src/generated.ts` from `src/lib/contracts.ts`); `indexer/ponder.config.ts` (inline ABI definitions, bytes32-keyed `ProposalCreated/Executed/Cancelled` triplets). 

### Canonical assumption
- `wagmi:generate` is run after every contract change.
- `frontend/src/lib/contracts.ts` mirrors the actual on-chain ABI for each contract.
- `indexer/ponder.config.ts` inline ABIs match the on-chain event signatures byte-for-byte.

### Load-bearing ABI shapes (front-end / indexer)

| Contract | Event(s) the indexer subscribes to | Front-end coverage |
|---|---|---|
| TegridyStaking | `Staked`, `Withdrawn`, `EarlyWithdrawn`, `RewardPaid`, `LockExtended`, `AmountIncreased`, `ProposalCreated/Executed/Cancelled` (bytes32), `Paused`/`Unpaused` | Full read/write hooks regenerated via `wagmi:generate`. |
| TegridyRestaking | `Restaked`, `Unrestaked`, `BonusClaimed`, `BaseClaimed`, `PositionRefreshed`, `BoostRevalidated`, `EmergencyForceReturn`, pause | Same |
| RevenueDistributor | `EpochDistributed`, `Claimed`, pause | Same |
| VoteIncentives | `EpochAdvanced`, `BribeDeposited`, `BribeDepositedETH`, `BribeClaimed`, `GaugeVoted`, `VoteCommitted`, `VoteRevealed`, `OrphanedBribeRefunded`, `UnvotedBribeRefunded`, `MinBribeAmountChange*`, pause | Same |
| LPFarming | `Staked`, `Withdrawn`, `RewardPaid`, pause | Same |
| TegridyLending | `LoanOfferCreated`, `LoanAccepted`, `LoanRepaid`, `DefaultClaimed`, ProposalCreated/Executed/Cancelled (bytes32), pause | Same |
| SwapFeeRouter | `SwapExecuted`, pause | Same |
| CommunityGrants | `ProposalCreated/Voted/Executed/Cancelled` (uint256 id) AND `ProposalCreated/Executed/Cancelled` (bytes32 key — TimelockAdmin overload), pause | Two-overload ABI required |
| MemeBountyBoard | `BountyCreated`, `BountyCompleted`, pause | Same |
| GaugeController | `Voted`, `VoteCommitted`, `VoteRevealed`, `Gauge{Add,Remove}{Proposed,d}`, `EmissionBudget{Proposed,Updated}`, pause | Same |
| TegridyPair (factory pattern) | `Swap`, `Mint`, `Burn` (subscribed via `TegridyFactory.PairCreated`) | Frontend reads pair state via wagmi-generated hooks |
| TegridyFactory | `PairCreated`, `Guardian*`, `PairEmergencyDisabled` | Same |
| TegridyTWAP | `DeviationBypassed` | Same |
| PremiumAccess_Pause / POLAccumulator_Pause / TegridyNFTLending_Pause | Pause-only filter (3 dedicated entries) | Same |
| TegridyStakingAdmin / SwapFeeRouterAdmin | TimelockAdmin minimal (bytes32-keyed) | Address is env-loaded; no-op if unset |

### Violation response
| Failure mode | Behavior |
|---|---|
| Solidity adds a new field to an existing event | Indexer's inline ABI doesn't see the new field; events still decode but the new field is silently dropped. Front-end `generated.ts` must be regenerated; old hooks return undefined for the missing field — TypeScript build flags it. |
| Solidity removes/renames an event | Indexer subscription becomes a no-op (no logs match the topic). Front-end TypeScript build breaks (referenced event missing) — caught at CI. |
| ProposalCreated overload conflict (uint256 vs bytes32) | Both already coexist; indexer wires the correct ABI per contract. New contracts inheriting TimelockAdmin MUST use the bytes32 overload. CommunityGrants is the only consumer with both overloads on one address; documented in `ponder.config.ts` line 494-565. |
| New child contract added without ABI registration in `wagmi.config.ts` | Contract works on-chain but no front-end hook is generated. Manual fix needed. |
| New child contract added without indexer subscription | Events are unindexed; UI can't render history. Manual fix needed. |
| ABI regen forgotten after a security fix that adds a new event | Front-end keeps stale hooks; new event is invisible to UI but data is on-chain. Acceptable degradation — no security loss. |

### Blast radius
- **UX-level only.** No security-class loss. Off-chain components that drift from on-chain ABI just lose visibility; the contracts themselves are unaffected.
- **Worst case:** indexer + front-end show stale state during a security incident response (e.g., new emergency-cancel event isn't indexed). Operators MUST run `wagmi:generate` and manually update `ponder.config.ts` after every contract change.

### Mitigation
Already in place via build-time ABI codegen + CI TypeScript checks. NOT in place: an automated CI job that diffs `frontend/src/lib/contracts.ts` and `indexer/ponder.config.ts` against the latest compiled `contracts/out/*.json` — adding such a diff job would catch ABI drift earlier (operator-facing recommendation, not a security fix).

---

## Aggregate observations

1. **No BROKEN integrations.** Every external dependency is either structurally guaranteed (immutable canonical address with a post-deploy verification script) or fails closed.
2. **Three ASSUMED integrations stand out:**
   - **JBAC NFT** uses direct calls (not bounded-returndata) on the staking path; if JBAC is ever upgraded, the bounded helper from `lib/SafeERC721Call.sol` should be applied for parity with TegridyLending/TegridyNFTLending.
   - **Uniswap V4 PoolManager** is pinned to a specific v4-core import. V4 is still pre-1.0 so signature/permission-mask churn is the inherent risk; the protocol's own `approvedPools[]` defense mitigates the malicious-pool branch but cannot mitigate v4-core upgrades.
   - **Off-chain merkle generator** for TegridyDropV2 is not in-repo. Adding a reference generator script to `scripts/` would close a UX brittleness (NOT a security one).
3. **DEFENDED integrations (Chainlink, V2-fork, WETH, TOWELI, Solady, TimelockAdmin)** all have explicit fail-closed paths AND post-deploy verification (or structural invariants).
4. **JBAY Gold is NOT wired.** Earlier audit references to JBAY Gold gating PremiumAccess are stale — current code uses JBAC NFT + time-based subscription only.
5. **Indexer/front-end ABI drift is a process risk, not a contract risk.** A CI job that diffs codegen output against compiled artifacts would close the gap.

---

## Files referenced

- `contracts/src/lib/SequencerCheck.sol` — Chainlink L2 uptime guard
- `contracts/src/lib/WETHFallbackLib.sol` — WETH9 fallback transfer lib
- `contracts/src/lib/SafeERC721Call.sol` — bounded transferFrom/ownerOf
- `contracts/src/base/OwnableNoRenounce.sol` — admin surface
- `contracts/src/base/TimelockAdmin.sol` — timelock with override-floor
- `contracts/src/TegridyFeeHook.sol` — Uniswap V4 hook
- `contracts/src/TegridyFactory.sol` — V2-fork factory + ERC777 reject
- `contracts/src/TegridyPair.sol` — V2-fork pair + FoT post-balance gate
- `contracts/src/TegridyStaking.sol` — Solady ERC721 + JBAC vault wiring
- `contracts/src/TegridyStakingJbacVault.sol` — JBAC custody + stranded reclaim
- `contracts/src/PremiumAccess.sol` — JBAC-gated subscription
- `contracts/src/TegridyDropV2.sol` — merkle allowlist (off-chain generator)
- `contracts/src/TegridyLending.sol` — sequencerFeed wiring + ownerOf
- `contracts/src/Toweli.sol` — fixed-supply token
- `contracts/script/CheckCanonicalWETH.s.sol` — post-deploy WETH validator
- `frontend/wagmi.config.ts` — ABI codegen config
- `indexer/ponder.config.ts` — event subscriptions
