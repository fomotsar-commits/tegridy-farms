# Agent 30/100 — Factory Fresh-Eyes Audit

**Target**: `contracts/src/TegridyFactory.sol`
**Related**: `contracts/src/TegridyPair.sol`, `contracts/src/base/TimelockAdmin.sol`
**Lens**: Pair creation gates, ordering, registries, salt collision, admin paths, disabledPairs cross-contract impact

---

## Findings

### F-30-1 — emergencyDisablePair allows arbitrary-address disabling (no factory-membership check)
**Severity**: LOW (latent / governance-trust dependent)
**Location**: `TegridyFactory.sol:505-520`

```solidity
function emergencyDisablePair(address pair) external {
    require(pair != address(0), "ZERO_ADDRESS");
    require(
        msg.sender == guardian || msg.sender == feeToSetter,
        "NOT_GUARDIAN"
    );
    disabledPairs[pair] = true;
    ...
}
```

The function does NOT verify `isPair[pair]` or `pair.code.length > 0` or that the address is a registered TegridyPair. A guardian or feeToSetter can mark **any arbitrary address** (including non-pair addresses, EOAs, other forks' pairs) as disabled.

**Impact**:
- `proposePairDisabled` has identical lack of pair-membership validation; the timelock provides 48h notice but does not prevent invalid targets.
- `disabledPairs` mapping is consumed by `VoteIncentives.forfeitCommitOnDisabledPair` (line 1695) which uses it as the gate to allow forfeit. A malicious admin could disable an arbitrary address to satisfy the gate, but the commit-hash preimage requirement (`computeCommitHash(user, epoch, pair, power, salt)`) means the victim must have committed to that address — pure-arbitrary-address attacks don't unlock victim funds.
- `TegridyTWAP.update` and `consult` check both `isPair(pair)` AND `disabledPairs(pair)`; only registered pairs reach the disabled check, so this consumer is defended in depth.
- Off-chain indexers that read `disabledPairs(arbitraryAddress)` may be confused.

**Recommendation**: Add `require(isPair[pair], "NOT_FACTORY_PAIR")` to both `proposePairDisabled` and `emergencyDisablePair`. Tightens the contract surface and prevents `disabledPairs[arbitraryAddress]` entries that have no semantic meaning for THIS factory.

---

### F-30-2 — Compromised feeToSetter wins 48h fee-redirection race even when rotation is in flight
**Severity**: MEDIUM (specific to compromised-key recovery scenario)
**Location**: `TegridyFactory.sol:218-234, 258-292`

The two-step setter rotation (proposeFeeToSetter → 48h → acceptFeeToSetter) and the fee-direction change (proposeFeeToChange → 48h → executeFeeToChange) both have 48-hour timelocks. The setter rotation includes a force-cancel of any pending FEE_TO_CHANGE on completion (lines 285-290), so a compromised setter's pending fee-change is voided when the new setter takes over.

But the race favors the attacker by a 1-block margin:

1. T=0: attacker (with stolen feeToSetter key) calls `proposeFeeToChange(maliciousAddr)`. `_executeAfter[FEE_TO_CHANGE] = T + 48h`.
2. T=Δ (a few minutes): legitimate setter detects the compromise and calls `proposeFeeToSetter(safeAddr)`. `feeToSetterChangeTime = T + Δ + 48h`.
3. T=48h: attacker calls `executeFeeToChange()`. The proposal is ready. Attacker's malicious `feeTo` becomes live. `_executeAfter[FEE_TO_CHANGE]` is cleared.
4. T=48h+Δ: legitimate setter calls `acceptFeeToSetter()` from `safeAddr`. The force-cancel of FEE_TO_CHANGE at lines 285-290 is a no-op (no proposal exists; already executed).

After step 4, the new setter must propose a fresh feeToChange and wait another 48h. **Net effect: ~96h of malicious fee redirection from the moment of compromise to recovery**, plus whatever the attacker already siphoned in step 3.

**Why this matters**: the prevailing audit narrative ("setter rotation force-cancels FEE_TO_CHANGE") is incomplete — it works only if the rotation completes BEFORE the attacker's fee proposal becomes executable. With identical 48h delays on both paths, the legitimate setter loses by definition (because the attacker proposed first).

**Recommendation**: One of:
- (a) Allow the **guardian** to call `cancelFeeToChange()` (currently feeToSetter-only). The guardian is the existing emergency-response role — extending its authority to cancel a pending fee-direction change would let governance abort a malicious proposal during the window.
- (b) Make `FEE_TO_SETTER_DELAY` shorter than `FEE_TO_CHANGE_DELAY` (e.g. 24h vs 48h). The legitimate setter can then complete rotation before the attacker can execute, and the rotation force-cancels the pending feeChange.
- (c) Reset `_executeAfter[FEE_TO_CHANGE]` whenever a setter rotation is PROPOSED (not just accepted), so a pending fee-change is paused until the rotation outcome is decided.

(b) is simplest; it inverts the timelock asymmetry to favor recovery. (a) is more flexible but introduces a new guardian power.

---

### F-30-3 — proposeTokenBlocked / proposePairDisabled accept zero address
**Severity**: INFORMATIONAL
**Location**: `TegridyFactory.sol:367, 404`

`proposeTokenBlocked(address token, bool blocked)` (line 367) does not validate `token != address(0)`. While `createPair` separately blocks zero-token pairs (line 169), an admin could queue `blockedTokens[address(0)] = true` for no reason. The corresponding pair-disable function DOES have `require(pair != address(0), "ZERO_ADDRESS")` at line 406 — there's an inconsistency.

**Recommendation**: Add `require(token != address(0), "ZERO_ADDRESS")` to `proposeTokenBlocked` for symmetry with `proposePairDisabled`. Pure hardening; no current attack vector.

---

### F-30-4 — MAX_PAIRS griefing requires high but finite gas budget
**Severity**: LOW (acknowledged tradeoff in source comments)
**Location**: `TegridyFactory.sol:73-74, 167`

`createPair` is permissionless and deploys a new TegridyPair via CREATE2 each call. The cap is 10000 pairs, after which `PairLimitReached` reverts. An attacker controlling 10000 distinct ERC-20 contracts (cheap to deploy) can spam-create up to the cap, permanently blocking legitimate pair creation on this factory.

Cost estimate (rough): ~1.5M gas per createPair (deploy small pair contract + bookkeeping), 10000 calls ≈ 15B gas. At 10 gwei × 1 ETH = ~150 ETH ($300K-$500K depending on price). High but feasible for a determined attacker against a small protocol.

**Mitigation acknowledged in source**: the contract docstring explicitly notes that a v2 factory can be deployed without disturbing existing pairs. This is the known recovery path.

**Optional hardening** (not strictly required): require a small ETH fee for `createPair` (e.g. 0.01 ETH) routed to feeTo. This raises the griefing cost to ~$50M+ at 10000 pairs while remaining negligible for legitimate users. Or: gate `createPair` to a small allowlist of "approved deployers" plus a public-fee path that routes through governance review. Either changes the protocol's "permissionless pair creation" property and may be undesirable.

---

### F-30-5 — Pair creation race with token-block proposal traps liquidity providers
**Severity**: MEDIUM (governance-action timing)
**Location**: `TegridyFactory.sol:367-382`, `TegridyPair.sol:130-131`

Sequence:
1. T=0: `feeToSetter` (or attacker controlling it) calls `proposeTokenBlocked(tokenX, true)`. 24h timelock.
2. T=12h: honest user calls `createPair(tokenX, tokenY)`. `_rejectERC777(tokenX)` checks `!blockedTokens[tokenX]` — passes (still false). Pair is created.
3. T=12h+: honest user calls `mint()` to deposit liquidity. Mint checks `!blockedTokens[token0] && !blockedTokens[token1]` — passes. LP shares minted.
4. T=24h: anyone calls `executeTokenBlocked(tokenX)`. Now `blockedTokens[tokenX] = true`.
5. Result: `swap()`, `sync()`, `skim()`, `harvest()`, AND `mint()` are all blocked because they check `blockedTokens`. **However, `burn()` does NOT check `blockedTokens`** (TegridyPair.sol line 179) — LPs can withdraw via direct `pair.burn()` calls (bypassing the router).

This means LPs who deposited during the timelock window can still recover their underlying tokens via direct burn. The funds are not permanently locked. But there's no on-chain warning to LPs that a token-block is pending — `pendingTokenBlockTime(tokenX)` exposes the readyAt timestamp, but the user must know to query it.

**Note**: Comment in TegridyPair line 131 explicitly notes mint is gated on disabled+blocked; line 179 `burn()` is intentionally NOT gated. This is correct design (LP escape hatch). Documenting here for completeness — the factory's lack of "createPair pending-block check" is actually safe because of the burn escape hatch.

**Recommendation**: Optionally — add `require(_executeAfter[keccak256(abi.encodePacked(TOKEN_BLOCK_CHANGE, token))] == 0 || pendingTokenBlockValue[token] == false, "TOKEN_BLOCK_PENDING")` to `createPair` for both tokens, so users cannot create a pair during a pending-block window. Strict hardening; current state is recoverable.

---

### F-30-6 — feeTo can be set to address(0xdead) or other unrecoverable address via 48h timelock
**Severity**: LOW (governance-trust)
**Location**: `TegridyFactory.sol:218-220`

`proposeFeeToChange(address _feeTo)` requires `_feeTo != address(0)`. But it accepts ANY non-zero address: `0xdead`, EOA without private-key knowledge, contract that reverts on receive, etc. After 48h execute, `feeTo = 0xdead` (or similar) and protocol fees accrue to an unspendable address.

**Impact**:
- Protocol fees would accrue as LP tokens minted to `0xdead` — unrecoverable.
- This is a "stuck-state" outcome but not directly an exploitable attack — the attacker doesn't profit.
- Recovery requires another 48h timelock to propose a new feeTo. During that window, fees that mint via `harvest()` go to `0xdead`.

**Recommendation**: Optional — add `require(_feeTo.code.length > 0 || _feeTo == feeToSetter, "FEE_TO_NOT_CONTRACT_OR_SETTER")` or similar to encourage feeTo being a contract (treasury multisig). Not strictly required; governance discipline suffices.

---

### F-30-7 — Cross-contract dependency: VoteIncentives.forfeitCommitOnDisabledPair gates on disabledPairs but factory has no event-only guarantee
**Severity**: INFORMATIONAL (architecture note)
**Location**: `TegridyFactory.sol:418, 511`, `VoteIncentives.sol:1695`

`VoteIncentives.forfeitCommitOnDisabledPair` (line 1695) reads `factory.disabledPairs(pair)` to gate the forfeit path. The factory writes to `disabledPairs` in three places:
1. `executePairDisabled` (line 418) — timelocked path.
2. `emergencyDisablePair` (line 511) — instant guardian/setter path.
3. (Implicitly) initial state is `false` for all addresses.

A `disabledPairs` flip from true → false happens via `executePairDisabled` after a `proposePairDisabled(pair, false)`. There's no instant "re-enable" path (intentional). This means a pair that's disabled stays disabled for at least 48h, giving voters time to forfeit their commits.

**No vulnerability**, but worth noting: VoteIncentives' design assumes that "disabled" is a sticky state (once flipped, stays for 48h). The factory honors this.

---

### F-30-8 — pendingPairDisableValue is not cleared on emergencyDisablePair when pending value is `true`
**Severity**: INFORMATIONAL
**Location**: `TegridyFactory.sol:514-518`

The H-2 fix at line 514 only cancels pending RE-ENABLE proposals (`pendingPairDisableValue[pair] == false`). When the pending value is `true` (i.e. a pending DISABLE proposal that aligns with the emergency action), the code leaves `_executeAfter[key]` and `pendingPairDisableValue[pair]` unchanged. This is intentional per the comment ("benign — same end-state").

However, the unused state lingers: when the timelocked DISABLE proposal eventually reaches `executePairDisabled` (line 414-421), it executes idempotently (re-writes `disabledPairs[pair] = true`) and emits `PairDisableExecuted(pair, true)`. Off-chain monitors may see two "disable" events (one PairEmergencyDisabled, one PairDisableExecuted) for the same pair, which is mildly noisy but not incorrect.

**Recommendation**: None required. Documenting for clarity.

---

### F-30-9 — Initial guardian setup race
**Severity**: LOW (deployment-procedure)
**Location**: `TegridyFactory.sol:455-460`

`setGuardian(address _guardian)` is callable only when `guardian == address(0)`. After the constructor, `guardian` is `address(0)`. Anyone (with feeToSetter privilege) can set it once. Until set, `emergencyDisablePair` is callable ONLY by `feeToSetter` (since `guardian == address(0)` and no msg.sender will match).

**Risk**: between deploy and first `setGuardian`, the guardian role is unfilled. If the deployer's setter key is compromised before `setGuardian` is called, attacker can set guardian to an attacker-controlled address WITHOUT a 48h timelock (initial-only path).

**Mitigation**: The deployer should call `setGuardian` atomically in the deployment script alongside the constructor. Note that `proposeGuardianChange` requires `_newGuardian != guardian` — so attacker can't easily revert legitimate guardian via timelock-bypass.

---

### F-30-10 — PendingFeeTo / pendingGuardian / pendingFeeToSetter readable but not invalidated by setter rotation
**Severity**: INFORMATIONAL
**Location**: Multiple

After `acceptFeeToSetter`, the new setter inherits all pending proposals OTHER than FEE_TO_CHANGE (which is force-cancelled at line 288). Pending state for:
- `GUARDIAN_CHANGE` (in TimelockAdmin) — NOT cancelled.
- `TOKEN_BLOCK_CHANGE` (per-token keys) — NOT cancelled.
- `PAIR_DISABLE_CHANGE` (per-pair keys) — NOT cancelled.

A compromised previous setter could queue many pending pair-disables / token-blocks / guardian-changes, then the new setter must individually cancel each before they execute. With 24h-48h delays, the new setter has time to cancel — but if the attacker queued, say, 100 pair-disables, the new setter must call `cancelPairDisabled(pair)` 100 times within 48h.

**Impact**: griefing the new setter with cancellation work. Not a direct exploit.

**Recommendation**: Optional — when `acceptFeeToSetter` runs, force-cancel ALL pending TimelockAdmin proposals. This is invasive (requires enumerating active keys, which the contract doesn't track). Practical alternative: governance procedure to propose+cancel atomically as needed.

---

## Notes / Dead Ends

1. **Init code hash mismatch in router**: Investigated. `TegridyRouter._pairFor` (line 511-515) uses `factory.getPair(tokenA, tokenB)` — a state lookup, not CREATE2 prediction. So init code hash changes do NOT break the router. This is explicitly noted in the source comment at lines 507-510. **Not a finding.**

2. **CREATE2 salt collision**: Salt = `keccak256(abi.encode(block.chainid, address(this), token0, token1))`. Distinct (token0, token1) pairs (with `token0 < token1` enforced) produce distinct salts by collision resistance. Cross-chain replay protected by `chainid`. Cross-factory protected by `address(this)`. **Not a finding.**

3. **Pair re-init**: TegridyPair.initialize has `_initialized` guard (line 105). The factory only calls initialize once during createPair. **Not a finding.**

4. **Same-token pair**: `tokenA != tokenB` is checked at line 164 BEFORE sorting. **Not a finding.**

5. **EIP-7702 detection**: Code length 23 (delegation pointer) is rejected at line 176. Real ERC-20s have far more bytecode. **Not a finding.**

6. **getPair returns wrong pair**: The mapping is set both forward (token0→token1) AND reverse (token1→token0) in createPair (lines 201-202). No way for the wrong pair to be returned. **Not a finding.**

7. **Pair ordering edge**: Sort logic `tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA)` is the canonical V2 pattern. **Not a finding.**

8. **isPair registry consistency**: `isPair[pair] = true` is set in createPair (line 205). It is NEVER set to `false`, so once a pair is registered with this factory, it remains registered. This is the intended behavior — the registry is a one-way "did this factory deploy this pair" check. **Not a finding.**

9. **Allowance / fee accrual**: `_mintFee` in TegridyPair mints LP tokens directly via `_mint(feeTo, liquidity)` — no allowance involved, no external call to feeTo. Safe. **Not a finding.**

10. **MIN_DELAY / MAX_DELAY hooks**: TegridyFactory does NOT override `_minDelay` / `_maxDelay` / `_proposalValidity`. Uses defaults (1h min, 30d max, 7d validity) plus the protocol-wide hard floors at TimelockAdmin lines 130-136. **Not a finding.**

11. **Reentrancy**: TegridyFactory.createPair calls `pair.initialize` after CREATE2. `initialize` is `external`, but the pair's constructor sets `factory = msg.sender` and initialize requires `msg.sender == factory` — so initialize is only callable by the factory once. The factory itself has no reentrancy guards but doesn't need them — no attacker-controlled callbacks during createPair. **Not a finding.**

12. **Storage layout for pendingGuardian**: Appended at end of storage (line 119) per AUDIT R028 H-01 to preserve test-cheat slot positions. Verified — `pendingGuardian` is the last declared state variable. **Not a finding.**

---

## Summary

10 findings across the factory:
- **0 CRITICAL / HIGH** — the audit history shows the factory has been heavily reviewed; no novel high-severity surface remains.
- **2 MEDIUM** — F-30-2 (compromised-setter fee-redirection race) and F-30-5 (LP timing race during token-block proposal). F-30-2 is the most actionable: the 48h+48h symmetric timelock structure favors the attacker by definition. F-30-5 has a built-in escape hatch via burn() but lacks an explicit warning surface.
- **4 LOW** — F-30-1 (arbitrary-address disable), F-30-4 (MAX_PAIRS griefing, acknowledged), F-30-6 (unrecoverable feeTo), F-30-9 (initial guardian race).
- **4 INFORMATIONAL** — F-30-3, F-30-7, F-30-8, F-30-10.

**Top recommendation**: F-30-2 — flip the timelock asymmetry so `FEE_TO_SETTER_DELAY < FEE_TO_CHANGE_DELAY`, OR allow the guardian to cancel a pending FEE_TO_CHANGE. Either change closes the compromise-recovery race window.
