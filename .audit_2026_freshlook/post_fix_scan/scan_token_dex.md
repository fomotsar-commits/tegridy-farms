# Post-Wave-A Confirmatory Exploit Scan — Token + DEX Core

**Date:** 2026-05-09
**Reviewer:** Independent post-fix scan
**Scope:** `Toweli.sol` (231 LoC), `TegridyFactory.sol` (683 LoC), `TegridyPair.sol` (554 LoC), `TegridyRouter.sol` (570 LoC), `TegridyTWAP.sol` (1085 LoC)
**Mandate:** `memory/feedback_minimal_surface.md` — minimal attack surface, battle-tested only, custom code IS the exploit source.

---

## TL;DR (5-line summary)

1. All 5 contracts: **PASS** — no new exploitable findings introduced by Wave A. The 100-agent fixes (H-7, M-23, F-31-D, M-24, H-16, F-30-9, F-46-1, F-24-1, M-44, F-95-K-4/8, etc.) verify against canonical patterns and storage layouts match `.audit_2026_freshlook/storage_layout/*.txt` exactly.
2. Cross-cutting pattern: every state-mutating path on the Pair (mint/burn/swap/sync/skim/harvest) is consistently gated by `disabledPairs` + `blockedTokens`; sister-fix asymmetry **not** present.
3. **CONCERN-1 (LOW, divergence-from-canonical):** `Toweli.permit` reimplements OZ's `ERC20Permit.permit` from scratch (~80 LoC of custom signature-validation flow) where the minimal-surface mandate would prefer inheriting OZ's `permit` and overriding only the SCW dispatch leg.
4. **CONCERN-2 (LOW, custom-code surface):** `TegridyPair.harvest()` is a 90-LoC permissionless-with-bootstrap-gate primitive whose canonical V2 alternative is **DELETE harvest entirely** (V2 materialises the protocol fee organically via mint/burn `_mintFee`). Audit notes flag this as defensible; minimal-surface mandate suggests revisiting in a future wave.
5. **CONCERN-3 (LOW, observability redundancy):** TegridyFactory has THREE separate cancellation-event surfaces (`ProposalCancelled` from TimelockAdmin, plus typed `*Cancelled` events). Each `cancel*` emits both — pure-observability cost, not exploitable, but +5 events of redundant code.

**Output path:** `.audit_2026_freshlook/post_fix_scan/scan_token_dex.md`

---

## Per-Contract Verdicts

| Contract | Verdict | Storage layout | New exploits | Notes |
|---|---|---|---|---|
| Toweli.sol | **PASS** (1 LOW concern) | matches | 0 | CONCERN-1 below; permit-rebuild questionable vs override |
| TegridyFactory.sol | **PASS** | matches | 0 | F-30-9, H-16 verified; all state mutators rate-limited or timelocked |
| TegridyPair.sol | **PASS** (1 LOW concern) | matches | 0 | H-7, M-23, F-31-D verified; CONCERN-2 below for harvest existence |
| TegridyRouter.sol | **PASS** | n/a (stateless aside from ReentrancyGuard) | 0 | DEEP-R-L02/M05 verified; FoT segregation correct |
| TegridyTWAP.sol | **PASS** | matches | 0 | M-24, F-46-1, F-24-1, F-74-11, M-44 verified; cross-decimal floor caveat (Obs 3 of fix_review) carried forward |

Storage-layout verification: all 4 layouts that exist (`Toweli`, `TegridyFactory`, `TegridyPair`, `TegridyTWAP`) compared against the source contracts at the slot level — no drift. `TegridyRouter` does not have a layout file (it has only ReentrancyGuard's slot 0 + immutables, which the foundry layout dump elides).

---

## Toweli.sol — PASS (1 CONCERN)

### Divergences from canonical (OZ ERC20 + ERC20Permit)

| Line | Divergence | Classification | Justification |
|---|---|---|---|
| L48 | inherits `ERC20 + ERC20Permit` only (no Ownable, no Pausable) | **JUSTIFIED** | minimal-surface mandate; matches USDC v2.2 fixed-supply pattern verbatim |
| L72 | `bool _initialMintDone` private one-shot | **JUSTIFIED — R014** | Battle-tested defense for "no future mint": one-shot flag bound to `_update` override. Canonical pattern: ERC20Permit gives no equivalent; this is the smallest possible delta. No post-deploy admin surface. |
| L82 | `bytes32 PERMIT_TYPEHASH_LOCAL` re-derived constant | **JUSTIFIED — DEEP-LIB-L3** | OZ keeps `PERMIT_TYPEHASH` private; re-deriving it is the only way to override `permit`. Hash matches OZ exactly. |
| L116-122 | `_update` mint-disable hook | **JUSTIFIED — R014** | OZ's `_mint` is non-virtual; `_update` is OZ's recommended override path. Pass-through for transfers/burns is canonical. |
| L149-230 | `permit` full reimplementation (~80 LoC) | **CONCERN-1 — QUESTIONABLE** | Re-derives the EIP-712 digest (`structHash` + `_hashTypedDataV4`), branches on `owner.code.length`, calls `ECDSA.tryRecover` for EOAs, calls `SignatureChecker.isValidSignatureNow` for SCWs. **Canonical alternative:** call `super.permit(...)` for the EOA path (so OZ's stock `permit` runs verbatim with its typed errors), and add a SECOND public function `permitWithERC1271(...)` (or override `permit` only after first calling `super.permit` and falling back on revert). The current rebuild duplicates ~30 lines of OZ logic that could just be inherited. **Not exploitable** — typed-error branches are correct, signature-replay defended via OZ's `_useNonce`, deadline checked first, `_approve` only called after validation. But ~50 LoC of custom signature logic where ~20 would suffice. |

### Independent exploit audit

- **External call before state writes?** No. `_useNonce(owner)` mutates state at L163; `_approve` mutates at L200/L229. No external calls between them. The only external call in `permit` is `SignatureChecker.isValidSignatureNow(owner, hash, sig)` (L225), which is a STATICCALL — cannot reenter and cannot mutate.
- **Signature malleability?** `ECDSA.tryRecover(hash, v, r, s)` rejects high-S (canonical OZ check). No regression.
- **Deadline check ordering?** L158 deadline check fires BEFORE nonce consumption — correct (OZ pattern). A failed signature check still consumes a nonce, which is intentional (replay defense).
- **`_useNonce` is consumed even if signature invalid?** Yes — at L163 nonce is consumed inside `keccak256(abi.encode(..., _useNonce(owner), ...))`. This matches OZ stock `permit` exactly: the nonce always advances on a permit attempt to bind the digest. The post-validation revert on bad signature does NOT roll back the nonce because `_useNonce` is called before any revert path. Correct V2 semantic.
- **DEFERRED DEEP-LIB-M4 (recipient.code.length > 0):** documented at L93-105 as a runbook deferral, not an exploit. Constructor still reverts `address(0)`. EOA recipients are operationally rejected via deploy procedure.
- **Immutability of EIP-712 version "1":** L37-47 NatSpec bakes "version=1" into the domain separator forever. No exploit; forward-compat note for future Toweli derivatives.

### Storage-layout check
Matches `storage_layout/Toweli.txt` exactly (slot 8 = `_initialMintDone bool`, all OZ slots 0-7 ahead of it, no packing collisions). PASS.

### Redundancy
None to flag. The deferred `recipient.code.length` guard at L93-105 is correctly deferred per the audit-spec rule "if tests break excessively, defer".

---

## TegridyFactory.sol — PASS

### Divergences from canonical (Uniswap V2 UniswapV2Factory)

| Line | Divergence | Classification | Justification |
|---|---|---|---|
| L15 | `is TimelockAdmin` (vs V2's no-admin design) | **JUSTIFIED** | MakerDAO DSPause pattern. V2's instant-set `setFeeTo`/`setFeeToSetter` is a known footgun. Timelocking via shared lib (used across 13 contracts in tree) is canonical. |
| L44 | `address public guardian` + emergencyDisablePair | **JUSTIFIED — NEW-A2** | Compound pause-guardian pattern. Required for active-exploit response (malicious-token-flip-to-FoT). Re-enable still timelocked. |
| L62 | `mapping(address => bool) isPair` | **JUSTIFIED — R014** | O(1) authenticity for TegridyTWAP.update(). Canonical V2 only has `getPair[t0][t1]` which the TWAP cannot use. Single SSTORE per createPair, single SLOAD per oracle update. |
| L73 | `MAX_PAIRS = 10000` | **JUSTIFIED — R064** | Anti-spam ceiling on push-only `allPairs`. Battle-tested pattern (Uniswap V3 has no equivalent because pair creation is fee-gated; V2 forks routinely add this cap). |
| L93 | `MAX_EMERGENCY_DISABLES_PER_DAY = 3` | **JUSTIFIED — H-16** | Compound pause-guardian discipline (per-day cap). Bounds single-key compromise blast radius. |
| L94-156 | rate-limit storage (`emergencyDisablesToday u8` + `lastDisableDay u64`) | **JUSTIFIED — H-16** | Required for L93 to function. Packed into slot 14 with `pendingGuardian` (verified in storage_layout). |
| L172-185 | constructor requires non-zero `_guardian` | **JUSTIFIED — F-30-9** | Closes deploy-window race where compromised setter could install hostile guardian. |
| L201-211 | `allPairsPaginated` | **JUSTIFIED — R064** | Off-chain enumeration helper. Pure view, no exploit surface. |
| L243-254 | salt includes `block.chainid + factory` | **JUSTIFIED — BATCH-L4 M2** | Canonical Uniswap V2 used `keccak(token0,token1)`; modern audits consistently flag cross-chain CREATE2 collision. Sushi/Pancake forks also include chainid. |
| L387-446 | `_rejectERC777` | **JUSTIFIED — A4-M-10 / NEW-A9** | ERC-1820 + ERC-165 + `granularity()` triple-check. Best-effort but canonical for V2 forks supporting modern ERC-20s. 30k staticcall gas cap (D-AMM-INFO2) prevents OOG-grief. |
| L399-446 | per-staticcall `gas: 30_000` cap | **JUSTIFIED — D-AMM-INFO2** | Aave V3 / OZ pattern — bounded external view calls. |
| L519-526 | `proposePairDisabled` requires `isPair[pair]` | **JUSTIFIED — F-30-1 / M-21** | Closes captured-setter pollution of `disabledPairs`. |
| L648-682 | `emergencyDisablePair` rate-limit + isPair gate + cancel-only-reenable (H-2) | **JUSTIFIED — H-16 / F-30-1 / H-2** | All three sub-fixes verified. The H-2 carve-out (only cancel pending RE-ENABLEs, leave pending DISABLEs) is correct: cancelling a pending DISABLE would amount to a guardian veto over governance. |

### Independent exploit audit

- **External call before state writes?** No. `_rejectERC777` is the only external call in `createPair`, and it precedes the `disabledPairs[pair] = true` write. The only external call in `emergencyDisablePair` is none — purely state mutation. `executeFeeToChange` has no external call. All paths are CEI.
- **Sister-fix asymmetry?** Checked:
  - `proposePairDisabled` (L519) and `emergencyDisablePair` (L648) BOTH gate on `isPair[pair]` — symmetric. PASS.
  - `cancelFeeToChange` (L304) extends to `guardian` (F-30-2). `cancelTokenBlocked` (L466) is feeToSetter-only. **Sister-fix asymmetry: BENIGN.** Token-blocks are slow-cadence (24h delay, easily caught); fee redirection is the high-blast-radius path that needs guardian veto. Not a regression — intentional asymmetry per F-30-2.
  - `cancelGuardianChange` (L619) is feeToSetter-only. Combined with `_executeAfter[GUARDIAN_CHANGE]` cleanup in `acceptFeeToSetter` (L367-372), captured-setter cannot strand a hostile pending guardian. PASS.
- **New code introducing findings?**
  - L659 `uint64(block.timestamp / 1 days)` — UTC day index. Wraps in year ~5849424173 — not exploitable.
  - L666 `uint8 nextCount = emergencyDisablesToday + 1` — unchecked addition? Solidity 0.8 default is checked. Cap is 3, so overflow at 256 unreachable. PASS.
  - L580-582 `setGuardian` requires `code.length > 0 && code.length != 23` (rejects EOAs and EIP-7702 delegated EOAs) — same gate at L599-602 in `proposeGuardianChange`. Symmetric. PASS.
- **`acceptFeeToSetter` cleanup of pending GUARDIAN_CHANGE (L367):** correct. Without this, a captured setter could queue a hostile guardian, propose feeToSetter rotation, the new setter accepts, then the hostile guardian becomes executable in 48h with no further setter approval. The cleanup forecasts this and force-cancels. F-30-10 verified.
- **Per-token TOKEN_BLOCK_CHANGE proposals NOT cleaned up on setter rotation:** documented at L361-366. Acceptable: each proposal is keyed by `keccak(TOKEN_BLOCK_CHANGE, token)`, not enumerable on-chain. The 24h delay gives the new setter time to triage. Not a finding.

### Storage layout
14 slots match `storage_layout/TegridyFactory.txt` exactly. Slot 14 packs `pendingGuardian` (20 bytes) + `emergencyDisablesToday` (1 byte) + `lastDisableDay` (8 bytes) = 29 bytes. Verified in layout file. PASS.

### Redundancy
- **Soft observation only:** L268-272 `setFeeTo(address) external pure { revert(...) }` is dead code that costs no gas if uncalled but adds bytecode. The `revert` message is purely for off-chain "did this work?" UX. Acceptable; dropping it would remove a developer-friendly surface. NOT FLAGGED as redundant.

---

## TegridyPair.sol — PASS (1 CONCERN)

### Divergences from canonical (Uniswap V2 UniswapV2Pair)

| Line | Divergence | Classification | Justification |
|---|---|---|---|
| L9 | imports `solmate FixedPointMathLib` | **JUSTIFIED** | Solmate `sqrt` is battle-tested in Uniswap V3/V4 + Seaport. Replaces V2's hand-rolled Babylonian. |
| L66-69 | `price0CumulativeLast` / `price1CumulativeLast` | **JUSTIFIED — R014** | Verbatim Uniswap V2 cumulative-price pattern (UQ112x112 * seconds, intentional uint256 wrap). PASS. |
| L80-81 | `lastHarvestAt` + `HARVEST_INTERVAL = 5 minutes` | **JUSTIFIED — R016 M-1** | MEV cap: 1/6 protocol fee × 5 min cadence makes harvest-MEV uneconomic. Pattern: Curve `claim_admin_fees()` + cooldown. |
| L106 | `error ReservesZeroPostRebase()` | **JUSTIFIED — F-31-E** | Typed error replaces `Panic(0x12)` div-by-zero. Strict observability improvement. |
| L140-141 | `mint` gates `disabledPairs` + `blockedTokens` | **JUSTIFIED — M-1** | Symmetric with swap. Without it users can lose tokens to dead pairs. |
| L149 | `mint` rejects `to == address(this)` | **JUSTIFIED — NEW-A10** | Closes V2 footgun: minting LP to pair self lets attacker drain via `burn(attacker)`. Burn already had this check; symmetry. |
| L195 | `if (feeOn && kLast != 0 && !disabledPairs)` (mint) | **JUSTIFIED — H-7 / F-31-A / F-31-B** | THE critical kLast bootstrap gate. Verified in fix_review/agent_review_Pair_TWAP.md L34-83. PASS. |
| L238 | same gate on burn | **JUSTIFIED — H-7 / F-31-A / F-31-B** | Symmetric with mint. PASS. |
| L259 | `require(data.length == 0, "NO_FLASH_SWAPS")` | **JUSTIFIED** | V2 supports flash swaps; Tegridy explicitly does not. Closes a major attack surface (post-creation token-flip exploits, oracle poisoning via flash). Hard delete > guard. |
| L271-277 | direction-aware `to != token{0,1}` | **JUSTIFIED — F-31-D** | V2 had no such check at all; Tegridy was over-restrictive. Direction-aware version preserves defense-in-depth on output side only. PASS. |
| L320-321 | `FOT_OUTPUT_*` post-swap balance check | **JUSTIFIED — NEW-A1** | Critical: factory-time `_rejectERC777` is best-effort + post-creation token-flip can flip a token to FoT mode. This per-swap re-validation closes the slow-drain path. |
| L337-364 | skim/sync gated on `disabledPairs` + `blockedTokens` | **JUSTIFIED — D-AMM-H2** | Donation primitive blocked. Verified in fix_review/agent_review_Pair_TWAP.md L99-145. PASS. |
| L388-471 | `harvest()` permissionless w/ bootstrap-gated to feeToSetter | **CONCERN-2** | Discussed below. |
| L486-517 | `_update` integrates cumulative price | **JUSTIFIED — R014** | Canonical V2 cumulative pattern. unchecked block, modular wrap, uint256 widening. PASS. |
| L524-542 | `_mintFee` | **MATCHES V2** | Byte-for-byte canonical V2. PASS. |

### CONCERN-2: harvest() existence (LOW)

`harvest()` (L388-471) is a 90-LoC permissionless primitive that exists ONLY because mint/burn no longer bootstrap `kLast` (post H-7 fix). Canonical V2 has no `harvest` — `_mintFee` runs inside mint/burn and that materialises the protocol fee organically.

**Minimal-surface alternative:** keep V2's organic materialisation. The H-7 finding closes the flash-loan-anchor on `kLast` bootstrap; the same outcome is achievable by:
1. Either: leave V2's bootstrap-on-mint and require `feeTo` set at deploy-time only (no rotation), OR
2. Make `kLast` initialise to a sentinel `uint256.max` at first mint and check `if (kLast != type(uint256).max)` in `_mintFee` — making the bootstrap a deterministic, non-anchor-able event.

This is not "easily fixable in this scan" — would need its own design pass. Flagging as **CONCERN-2** (LOW) for a future minimal-surface revisit. The current `harvest` is internally consistent (HARVEST_INTERVAL + 1/6 fee structurally caps MEV per fix_review L374-386), bootstrap-gated to feeToSetter (FRESH-EYES M-2), all four state-mutating gates symmetric. **Not exploitable as written.**

### Independent exploit audit

- **External call before state writes?** Walked every external touch:
  - `mint`: balanceOf calls (view) → `_mintFee` → `_mint` (internal) → `_update` → kLast write → emit. NO external call between state writes. PASS.
  - `burn`: balanceOf → `_mintFee` → `_burn` → `_update` → kLast write → safeTransfer × 2 (output) → emit. **Output transfers AFTER reserves updated** (CEI). PASS.
  - `swap`: balanceOf → K-check → `_update` → safeTransfer × 2 (output) → balanceOf re-check (FoT defense) → emit. **Output transfers AFTER reserves updated**, FoT re-check is reads-only. PASS.
  - `harvest`: factory views → `_mintFee` → kLast write → emit. No external transfers. PASS.
  - `skim`: balanceOf → safeTransfer × 2 → emit. No reserve writes (skim never touches reserves). PASS.
  - `sync`: balanceOf → `_update`. Canonical. PASS.
- **Sister-fix asymmetry?** Checked H-7 on mint vs burn: BOTH have `if (feeOn && kLast != 0 && !disabledPairs)` (L195/L238). Symmetric. PASS.
- **New code introducing findings?**
  - `harvest()` bootstrap-gate at L450 reverts `"HARVEST_BOOTSTRAP_GATED"` (string revert vs typed error — minor inconsistency vs other typed errors in this file). Not exploitable; cosmetic.
  - L411 `EMPTY_PAIR` revert on zero reserves prevents loop-grief on dormant pair. Wave A addition. PASS.
  - L458 cleanup-path `bool cleanup = (!feeOn && kLastBefore != 0)` is needed because `_mintFee`'s `else if (_kLast != 0) { kLast = 0 }` cleanup branch must not be unwound. Verified.
- **Read-only reentrancy window:** L204 NatSpec acknowledges burn's read-only window between `safeTransfer` and `emit Burn`. The CEI fix at L225 (`_update` BEFORE transfers) closes this. The remaining window is between L243 `safeTransfer(to, amount0)` and L246 `emit Burn`. Reserves are already correct at this point — readers see a consistent state. PASS.
- **`harvest()` MEV reentrancy:** `nonReentrant` at L388. `_mintFee` mints LP to `feeTo` (could be a contract). If `feeTo` is a malicious-token-pair address that calls back into harvest, `nonReentrant` blocks. PASS.
- **`harvest()` cleanup-path correctness (V3-AMM-M1):** if `feeTo` was non-zero at last harvest (kLast was bootstrapped), then disabled (`feeTo = address(0)`), `_mintFee`'s `else if (_kLast != 0) { kLast = 0 }` branch runs. `feeOn = false`, `kLastBefore != 0`, `cleanup = true` — passes the require. After the require, `lastHarvestAt = block.timestamp`, `lpMinted = 0`, `feeOn = false` so kLast write at L463-465 is skipped. State: kLast = 0 (cleared by _mintFee). PASS.

### Storage layout
13 slots match `storage_layout/TegridyPair.txt` exactly. Note slot 8 is packed: `reserve0 u112` + `reserve1 u112` + `blockTimestampLast u32` = 28 bytes (4 bytes free) — matches V2 packing exactly. PASS.

### Redundancy
None to flag.

---

## TegridyRouter.sol — PASS

### Divergences from canonical (Uniswap V2 UniswapV2Router02)

| Line | Divergence | Classification | Justification |
|---|---|---|---|
| L8 | imports `WETHFallbackLib` | **JUSTIFIED** | Aave V3 WETHGateway pattern. ETH refund failures don't brick the user's tx. |
| L21-31 | typed errors instead of string reverts | **JUSTIFIED** | Solidity 0.8.4+ idiom; gas-efficient. |
| L69 | `MAX_DEADLINE = 2 hours` | **JUSTIFIED — L-1 / R016 M-1** | Long-tail deadline footgun closure. Aggregator integrations documented at L41-68. |
| L90-92 | `receive()` requires `msg.sender == WETH` | **JUSTIFIED** | Stops generic ETH dust from sticking on the router. V2 Router02 had this same guard. |
| L153, L157, L176, L207-211 | `to != address(this)` checks | **JUSTIFIED — DEEP-R-M05** | Output to router is irrecoverable (no admin sweep). Symmetric across all entry points. |
| L211, L231, L251, L285, L305, L327, L358, L378, L401 | `to != _pairFor(...)` (pair-self) | **JUSTIFIED — H-09** | LP-to-pair-self drain primitive (matches Pair NEW-A10). Symmetric across all 9 entry points. |
| L214, L232, L252, L287, L307, L329, L359, L379, L402 | `_validatePathNoCycles` | **JUSTIFIED — H5** | Cycle-revert-after-transfer would strand tokens. Pre-validate. |
| L349-411 | FoT-supporting variants | **JUSTIFIED** | Canonical V2 Router02 pattern. Output measured via balance-before/after. |
| L511-515 | `_pairFor` factory lookup vs CREATE2-predict | **JUSTIFIED** | V2 hardcodes init code hash; Tegridy uses factory lookup so router survives Pair bytecode changes. Single STATICCALL. |

### Independent exploit audit

- **External call before state writes?** Router is stateless (no storage writes other than `nonReentrant`). All paths follow: validate → safeTransferFrom (input → pair) → pair.swap/mint/burn → safeTransfer/withdraw (output → user). Reentrancy guard prevents same-router reentry. PASS.
- **Sister-fix asymmetry?** Checked all 9 swap variants:
  - `to != address(0)`: 9/9
  - `to != address(this)`: 9/9
  - `to != _pairFor(...)`: 9/9
  - `_validatePathNoCycles`: 9/9 (note: `_swap` and `_swapSupportingFeeOnTransferTokens` rely on this caller-side validation, comment at L469 acknowledges)
  - `path.length > 10` (PathTooLong): only on FoT variants (L354, L373, L396) and `getAmountsOut/In` (L417, L429). **Sister-fix asymmetry detected: standard variants don't enforce PathTooLong directly.** But: standard variants call `getAmountsOut`/`getAmountsIn` which DO enforce it (L417, L429). So PathTooLong is reached transitively. Verified — not a regression.
- **DEEP-R-L02 (removeLiquidity zero-recipient):** L153 `require(to != address(0), "ZERO_TO")` matches `removeLiquidityETH` L176. Symmetric. PASS.
- **DEEP-R-M05 (router-self recipient):** symmetric across all 11 user-facing entry points. PASS.
- **`receive()` guard at L91:** rejects all ETH except from WETH (`withdraw` callbacks). Without this, generic ETH sent to router gets stuck (no sweep). PASS.
- **WETHFallbackLib paths (4 sites):** L140, L197, L259, L341. All on the OUTBOUND ETH leg where contract callers might reject ETH. The lib falls back to WETH wrap. Pattern: Aave V3 WETHGateway. PASS.
- **`_calculateLiquidity` (L549-569):** standard V2 quote-based optimal-amount calculation. `require(amountAOptimal <= amountADesired, "EXCESSIVE_A_AMOUNT")` at L564 replaced an `assert` (L-08). PASS.
- **No flash-swap support:** TegridyPair rejects `data.length != 0` at L259 of TegridyPair.sol; router never passes non-empty data (L477, L503). Defense-in-depth. PASS.

### Storage layout
Stateless aside from immutables (`factory`, `WETH`) and ReentrancyGuard. No layout file generated. PASS.

### Redundancy
- **Soft observation:** the `error CyclicPath()` declaration (L26) can no longer trip in `_swap`/`_swapSupportingFeeOnTransferTokens` because callers pre-validate via `_validatePathNoCycles`. The error is still revertable from `_validatePathNoCycles` itself (L458). NOT REDUNDANT — a lone hop=2+ caller bypassing _validatePathNoCycles would still hit it transitively. Acceptable.

---

## TegridyTWAP.sol — PASS

### Divergences from canonical (Uniswap V2 OracleLibrary cumulative pattern)

| Line | Divergence | Classification | Justification |
|---|---|---|---|
| L84 | `is TWAPAdmin, ReentrancyGuard, TimelockAdmin` | **JUSTIFIED** | Inline Ownable2Step (TWAPAdmin) + reentrancy + timelock. All canonical OZ/Maker patterns. |
| L98-103 | `Observation { timestamp u32, bypassed bool, price0Cum u256, price1Cum u256 }` | **JUSTIFIED — R014** | Widened cumulatives to uint256 (V2 OracleLibrary uses uint224); `bypassed` flag is a design addition for fail-closed semantics. Canonical V2 has neither — but Tegridy's wider deviation gate (FRESH-EYES H-3) requires bypass tracking. |
| L120 | `MAX_DEVIATION_BPS = 2000` | **JUSTIFIED — F-46-1** | Tightened from 5000. Verified in fix_review/agent_review_Pair_TWAP.md L376-422. |
| L142 | `MAX_BRIDGING_GAP = 2 hours` | **JUSTIFIED — F-24-1** | Verified in fix_review/agent_review_Pair_TWAP.md L324-372. |
| L176 | `DEFAULT_MIN_RESERVE_FLOOR_WEI = 10 ether` | **JUSTIFIED — M-24 / F-31-C** | Verified in fix_review/agent_review_Pair_TWAP.md L292-321. |
| L188 | `minReserveFloor1` per-side | **JUSTIFIED — F-24-2** | Cross-decimal pair gating. NatSpec L596-606 carries forward the runbook caveat. |
| L256 | `MIN_UPDATE_FEE = 1e14` | **JUSTIFIED — F-95-K-4** | Anti-grief floor on fresh deploys. Owner can opt out via `setUpdateFee`. |
| L266 | `updateFeeConfigured bool` | **JUSTIFIED — F-95-K-4** | Required for L256 to function. |
| L383-409 | refund leg with 30k stipend + bank-on-fail | **JUSTIFIED — M-44 / F-55-8** | Aerodrome distributor pattern. Bank-on-fail prevents update() brick from hostile receive(). |
| L411-416 | explicit `msg.value == 0` rejection on zero-fee path | **JUSTIFIED** | Prevents accidental ETH lock-in once owner sets updateFee=0. PASS. |
| L463-497 | sequencer-outage detection in update() | **JUSTIFIED — F-74-11** | Aave V3 PriceOracleSentinel pattern; uses `tryCheckSequencerUp` (non-reverting) so update() continues during outages. |
| L499-519 | count==0 bootstrap → `bypassed = true` | **JUSTIFIED — FRESH-EYES H-3** | Closes "first-observation manipulation" — a brand-new pair's first update would otherwise admit any spot price as the anchor. |
| L553-569 | count<=2 grace → `bypassed = true` + `lastBypassUsed` stamp | **JUSTIFIED — H-13 / F-89-K / F-46-2** | Verified in fix_review/agent_review_Pair_TWAP.md L239-289. |
| L620 | dormancy-bypass branch `onlyOwner` | **JUSTIFIED — D-AMM-H1** | Closes flash-loan-anchored bootstrap primitive. |
| L725 | `consult()` 4h staleness override | **JUSTIFIED — M-48 / F-74-4** | Aave V3 price-sensitive default. |
| L736 | `consult()` rejects `factory.disabledPairs(pair)` | **JUSTIFIED — FRESH-EYES H-5** | Companion to update()-side H-2. |
| L756-763 | consult() rejects `latest.bypassed` | **JUSTIFIED — D-AMM-M5 / V2-AMM-H1** | Provisional observation defense. |
| L791 | `Math.mulDiv` for amountOut | **JUSTIFIED — F-24-4 / F-42-2** | OZ Math 512-bit mulDiv. Canonical Uniswap V3 OracleLibrary pattern. |
| L884 | `withdrawFees onlyOwner` | **JUSTIFIED — F-95-K-8** | Verified in fix_review L526-548. |
| L900-934 | `proposeAdminResetPair` etc | **JUSTIFIED — D-AMM-H3** | 24h timelock; required recovery primitive after a poisoning event. |
| L1024-1053 | `_getCumulativePricesOverPeriod` rejects `best.bypassed` | **JUSTIFIED — V2-AMM-H1 / PASS7-TWAP-01** | Closes anchor-side bypass-poisoning even when latest is non-bypassed. PASS7-TWAP-01 fix removed the `&& found` carve-out that had reopened the !found fallback path. |
| L1064-1070 | sequencer-grace gate on `best` (anchor) | **JUSTIFIED — FRESH-EYES M-1** | Symmetric with consult-entry gate; closes anchor-end window during outage resume. |

### Independent exploit audit

- **External call before state writes?**
  - `update()`: `factory.isPair`, `factory.disabledPairs`, `pair.getReserves`, `pair.price0CumulativeLast`, `pair.price1CumulativeLast`, `tryCheckSequencerUp` — all VIEW/STATICCALL except the refund `msg.sender.call{value: excess, gas: 30000}("")` at L403. **L403 happens BEFORE state writes** (storage writes at L649-661). However, the refund is bounded by 30k gas and `nonReentrant` modifier (L364) blocks reentry. The bank-on-fail path (L407) re-adds to `accumulatedFees` which was already mutated at L386. **Race condition?** No — `accumulatedFees += effectiveFee` at L386, then refund at L403, on failure `accumulatedFees += excess` at L407. Both writes are additions; no race. PASS.
  - `consult()`: pure view + STATICCALL. PASS.
  - `withdrawFees()`: state write at L887 BEFORE call at L889. CEI. PASS.
- **Sister-fix asymmetry?**
  - `update` and `consult` BOTH gate on `factory.disabledPairs` (L375 and L736) — symmetric. PASS.
  - `update` count<=2 grace stamps `lastBypassUsed` (L568); count==0 bootstrap stamps it (L518); dormancy-bypass stamps it (L622); bridging/sequencer trip stamps it (L640). **All four bypass branches stamp.** Sister-fix asymmetry NOT present. PASS.
  - `_getCumulativePricesOverPeriod` rejects bypassed `best` at L1053; consult rejects bypassed `latest` at L761. Both ends of the lookup window guarded. Symmetric. PASS.
  - `consult-entry` sequencer check at L725 (4h); `_getCumulativePricesOverPeriod`-anchor sequencer check at L1064-1070. **Asymmetry on staleness window:** entry uses 4h, anchor uses NONE (just resume-grace check). **Benign:** anchor check uses `getResumeTimestamp` which is the most-recent post-up `startedAt`; if the feed is keeper-lapsed the entry-side check at L725 already reverts. Net: anchor is gated transitively. PASS.
- **New code introducing findings?**
  - L383 `effectiveFee = updateFeeConfigured ? updateFee : MIN_UPDATE_FEE` — flips on first call to `setUpdateFee`. No initialisation race; constructor sets `updateFeeConfigured = false` (default), so brand-new deploys are protected by `MIN_UPDATE_FEE`. PASS.
  - L407 `accumulatedFees += excess` on refund failure could in principle wrap, but `accumulatedFees` is uint256 and the protocol caps individual update fees at `MAX_UPDATE_FEE = 0.01 ether`, so 2^256 would take ~1.16e57 calls. Unreachable. PASS.
  - L420 `if (reserve0 == 0 || reserve1 == 0) revert NoReserves()` — strict zero check is correct. The reserve floor at L435 then enforces `floor0`/`floor1` which is non-zero by default. PASS.
  - L499 `if (count == 0) { ... bypassed = true; lastBypassUsed = block.timestamp; }` — sets bypass for the very first observation. The bypass is then NOT followed by deviation gate enforcement (since the count==0 branch returns at L519). The slot is then written at L653-658 with `bypassed = true`. Subsequent consult() reads will reject this until count >= 4 (3 grace + 1 honest). PASS.
- **TWAPAdmin (L47-77) inline implementation:** mini-Ownable2Step. `transferOwnership(0)` reverts (L63), `acceptOwnership` requires pendingOwner == msg.sender (L68), `renounceOwnership` reverts (L74-76). All correct vs OZ Ownable2Step semantics. **CONCERN-redundant?** Yes — could just inherit OZ Ownable2Step. ~30 LoC saved. Not exploitable; flagged as Wave-B candidate.
- **Sequencer-feed immutable (L276):** correct. Cannot be hot-swapped post-deploy. address(0) is a valid value (mainnet). PASS.

### Storage layout
14 slots match `storage_layout/TegridyTWAP.txt` exactly. Note slot 13 packs `feeRecipient` (20 bytes) + `updateFeeConfigured` (1 byte) = 21 bytes (11 bytes free). Verified. PASS.

### Cross-decimal pair caveat (carried from fix_review Obs-3)

Per fix_review/agent_review_Pair_TWAP.md L596-606, the `effectiveMinReserveFloor1` fallback to `effectiveMinReserveFloor` will brick a USDC pair (6-decimal) until owner explicitly sets `setMinReserveFloor1`. Documented at L177-186; reads as a soft warning rather than a hard requirement. **This scan confirms no exploit, but the runbook gap persists.** Recommendation (NOT a fix in this scan): tighten the L177-186 NatSpec to "REQUIRED for any non-18-decimal pair."

### Redundancy
- **TWAPAdmin (L47-77):** ~30 LoC of inline Ownable2Step where OZ Ownable2Step would do verbatim. Minimal-surface mandate would prefer inherit. NOT exploitable (correct semantics). Flagged for Wave-B revisit.
- **Soft observation:** `tryGetLatestObservation` (L832) is a non-reverting sister of `getLatestObservation`. Both are external view; consumers choose. Not redundant in the minimal-surface sense — one can be deleted only if all callers want fail-loud semantics. Acceptable.

---

## Cross-Cutting Observations

### Observation A — `disabledPairs` gates are uniformly enforced

Every state-mutating path on TegridyPair (mint L140, swap L255, sync L361, skim L338, harvest L397) and observation path on TegridyTWAP (update L375, consult L736) checks `factory.disabledPairs(pair)`. Burn intentionally remains callable (LP exit). **No sister-fix asymmetry.** PASS.

### Observation B — `blockedTokens` symmetry

Same surfaces all check `blockedTokens[token0]` and `blockedTokens[token1]`. Symmetric. PASS.

### Observation C — TimelockAdmin shared across Factory + TWAP

Both contracts inherit `TimelockAdmin` (L15 Factory, L84 TWAP). The `_executeAfter` mapping is keyed by hash so cross-contract collisions are impossible. Both use `_forceCancel` for out-of-band clears (Factory L355, L370). DEEP-LIB-M5 verified.

### Observation D — Storage-layout no-drift verification

Compared all 4 contracts that have layout files (`Toweli`, `TegridyFactory`, `TegridyPair`, `TegridyTWAP`) against source. Slot-by-slot match. No layout drift since the layout dump was generated. PASS.

### Observation E — No reentrancy gap on Pair.harvest

Walked the harvest CEI: factory views → `_mintFee` (mints LP to feeTo, an EXTERNAL call if feeTo is a contract) → kLast write → emit. **`_mintFee` does call `_mint(feeTo, liquidity)`** (L536) which IS a state mutation on the LP token. If `feeTo` is itself a contract that hooks `_mint` (impossible with standard ERC20 — `_mint` doesn't call out), no reentrancy is possible. `nonReentrant` at L388 is belt-and-suspenders. PASS.

---

## Summary of Findings

| ID | Severity | Type | Location | Description |
|---|---|---|---|---|
| CONCERN-1 | LOW | Divergence-from-canonical | Toweli.sol:149-230 | `permit` rebuild duplicates ~30 LoC of OZ logic; canonical alternative is inherit + override SCW dispatch only. **NOT exploitable.** Wave-B candidate. |
| CONCERN-2 | LOW | Custom-code-surface | TegridyPair.sol:388-471 | `harvest()` is a 90-LoC primitive that V2 doesn't have. The H-7 finding could be closed by a sentinel-kLast pattern instead of bootstrap-gating harvest. **NOT exploitable as written.** Wave-B candidate. |
| CONCERN-3 | LOW | Observability redundancy | TegridyTWAP.sol:47-77 | Inline TWAPAdmin where OZ Ownable2Step would do verbatim. ~30 LoC saving. **NOT exploitable.** Wave-B candidate. |

**No HIGH or MEDIUM findings.** All Wave-A 100-agent fixes verify against their cited canonical patterns. Storage layouts match. No external-call-before-state-write violations. No sister-fix asymmetry. No new exploits introduced.

**Verdict: Token + DEX core PASS — minimal-surface mandate compliance acceptable; 3 LOW redundancy concerns flagged for Wave-B consideration but not blocking.**
