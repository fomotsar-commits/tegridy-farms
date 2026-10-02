# Audit 003 — TegridyFactory.sol

Agent 003 of 101. AUDIT-ONLY (no code changes).

Target: `contracts/src/TegridyFactory.sol`
Cross-checked: `contracts/test/TegridyFactory.t.sol`, `contracts/test/Audit195_Factory.t.sol`,
related: `contracts/src/TegridyPair.sol`, `contracts/src/TegridyRouter.sol`,
`contracts/src/base/TimelockAdmin.sol`.

LOC of target: 376. SLOC: ~260.

---

## SUMMARY COUNTS

| Severity | Count |
|---|---|
| HIGH     | 1 |
| MEDIUM   | 4 |
| LOW      | 5 |
| INFO     | 6 |
| Test gaps | 7 |

---

## HIGH

### H-01 — `setGuardian` is instant, no timelock; bypasses governance for an instant-disable role
File: `TegridyFactory.sol`
Lines: 346–351 (`setGuardian`) interacting with 358–374 (`emergencyDisablePair`).

`setGuardian` is callable by `feeToSetter` with no timelock. Once a guardian is
set, that guardian (any EOA / multisig) can call `emergencyDisablePair(pair)` for
**any** address — there is no check that the pair was created by this factory
(see L-02). A compromised or malicious feeToSetter can therefore install a
hostile guardian in one tx and instantly halt every pool, then use the same
power to halt re-enables (the emergency path force-cancels the timelocked
proposal at line 369–372). Because every other privileged setter mutation in
this contract is timelocked behind `FEE_TO_SETTER_DELAY = 48h` /
`FEE_TO_CHANGE_DELAY = 48h` / `PAIR_DISABLE_DELAY = 48h`, the unrestricted
guardian appointment is the weakest link in the chain.

Test gap: `TegridyFactory.t.sol::test_NEWA2_setGuardian_onlySetter` only
verifies access control. There is no test asserting that guardian appointment
must be revocable by something other than the same setter, no test for "rogue
setter installs hostile guardian," and no DoS-via-batch-disable test.

Recommendation (advisory): require either (a) `setGuardian` to itself be
timelocked, or (b) a separate `guardianAdmin` role distinct from `feeToSetter`,
or (c) a `_guardianRevoke()` that any LP token holder of any disabled pair can
call to dispute (similar to OZ DefaultAdminRules opt-out).

---

## MEDIUM

### M-01 — CREATE2 salt collides across chains (replay across L2s with same factory addr)
File: `TegridyFactory.sol`
Lines: 113.

`bytes32 salt = keccak256(abi.encodePacked(token0, token1));`

Salt does not include `block.chainid` or `address(this)`. Combined with the
same `creationCode` of `TegridyPair`, deploying TegridyFactory at the **same
deterministic address** on multiple chains (very common via CREATE2 deployer
or `vanity` addresses) means the same `(token0, token1)` produces the same
pair address on every chain. This is benign for *legitimate* pairs since
each chain has separate state, but it means a malicious actor who races
factory deployment on a new chain can pre-compute every pair address and
front-run liquidity that arrives via cross-chain bridging into a contract
they control — same address, but their factory's TegridyPair bytecode could
be substituted (only matters if the deployer is not a verified-source
deployment).

A second class: if the Factory is ever redeployed at a fresh address on the
same chain (e.g. for a v2 migration), the same salt yields a *different* pair
address, but the **old** factory's pair address remains live. Any frontend or
periphery that hard-codes pair addresses derived from the *new* factory will
silently bypass the old pairs. This is mostly an integration foot-gun.

Mitigation: include `address(this)` and/or `block.chainid` in the salt:
`keccak256(abi.encode(block.chainid, address(this), token0, token1))`.

Cross-check: `Audit195_Factory.t.sol::test_F02_create2_salt_deterministic`
confirms exact CREATE2 derivation but does NOT test cross-chain salt safety
or factory-address-binding.

### M-02 — `_rejectERC777` ERC-1820 hashes are computed every call and grow gas linearly
File: `TegridyFactory.sol`
Lines: 249–265.

`_rejectERC777` rebuilds the `bytes32[3]` hash array and loops over three
hashes on every `createPair` call, doing a `STATICCALL` to ERC-1820 for each.
Three external staticcalls + three keccak256s per createPair. Not a security
bug per se, but each staticcall is unbounded user-controlled gas if the token
or registry is a contract (registry is a known deployed contract, so bounded;
but `granularity()` and `supportsInterface(...)` calls to `token` are not
bounded — a malicious token can return huge revert data or burn gas, griefing
the deployer of `createPair`. Since `createPair` is permissionless, an
attacker could front-run a victim's createPair and cause it to revert OOG
under tight gas estimates.

Recommendation: cap gas on `staticcall` to ERC-1820 / token (e.g.
`staticcall{gas: 30_000}`) and constify the hashes as constants outside the
function.

Cross-check: `Audit195_Factory.t.sol::test_F06_*` covers happy + stealth
bypass paths. No griefing or OOG fuzz.

### M-03 — Stealth ERC-777 bypasses `_rejectERC777`; INIT and createPair still succeed
File: `TegridyFactory.sol`
Lines: 222–266.

This is acknowledged in the doc-comment at 215–221 but it remains a real
attack surface that the factory documents away rather than blocks. A token
that does NOT register with ERC-1820, does NOT implement ERC-165, and does
NOT expose `granularity()` will trip none of the three checks while still
calling tokensReceived hooks via internal logic. The
`Audit195_Factory.t.sol::test_F06_stealth_erc777_bypasses_detection` test
*explicitly demonstrates this bypass* and merely asserts that the bypass
"works" — it is a known-broken case, not a passing safety property.

Combined with F-19 ("anyone can createPair") and the lack of pair-creator
attestation, an attacker can list a stealth-777 pair, lure user liquidity,
then execute reentrant drain via cross-pair callbacks. Documented but
unblocked.

Recommendation: maintain an on-chain allowlist (or use `feeToSetter` to
proactively `proposeTokenBlocked` known-bad tokens). At minimum, log a
`PairCreated` event variant when a token's ERC-165 / ERC-1820 / granularity
checks were inconclusive so off-chain monitoring can flag.

### M-04 — `proposePairDisabled` accepts arbitrary addresses (no factory-membership check)
File: `TegridyFactory.sol`
Lines: 306–313.

There is no `require(_isPair(pair), ...)` — feeToSetter can `proposePairDisabled`
for any address, including non-pairs and pairs from competing forks. This
creates a footgun where an admin wastes 48h disabling a fake address, *or*
where the disabled-pairs map gets polluted with thousands of useless entries
that other contracts (TegridyPair line 101, 184; TegridyRouter line 455)
all `SLOAD` against. The mapping itself is bounded per-pair so cost stays
constant, but it's an attack-vector for griefing the admin's opsec workflow.

Cross-check: `Audit195_Factory.t.sol::test_F20_proposePairDisabled_arbitrary_address`
explicitly demonstrates this and labels it "Low," but combined with the
guardian instant-disable (H-01), the attack surface is wider.

Recommendation: `require(_isFactoryPair[pair], "NOT_OUR_PAIR");` where
`_isFactoryPair` is set in `createPair`.

---

## LOW

### L-01 — `createPair` does not check `getPair[token1][token0]` separately before write
File: `TegridyFactory.sol`
Lines: 109, 120–121.

After sorting (`token0 < token1`), only `getPair[token0][token1] == address(0)`
is checked. Then *both* directions are written. This is correct under
sorted-token invariant, but if any future code path bypasses sorting (e.g. a
helper or a fork), the asymmetry could allow `getPair[token1][token0]` to
hold a stale pair while `getPair[token0][token1]` is zero. Not exploitable
today since the sort is immediate and deterministic.

### L-02 — No public `INIT_CODE_PAIR_HASH` constant — off-chain pair prediction relies on full creationCode
File: `TegridyFactory.sol`
(Absence; no line ref.)

UniswapV2 exposes `INIT_CODE_HASH` so periphery / SDKs / aggregators can
predict pair addresses without on-chain calls. TegridyFactory does not.
TegridyRouter._pairFor (line 452–456) deliberately uses `getPair` lookup
instead — that's a sound choice for the router itself (M-05 below) but it
means every external integrator pays a STATICCALL per pair and SDK consumers
must ship the entire `TegridyPair` creationCode to compute hashes. This is
the inverse of the usual "drift" finding — there's no constant *to* drift,
which means no risk of constant-vs-bytecode mismatch.

Cross-check: `Audit195_Factory.t.sol::test_F03_no_init_code_hash_exposed` notes
this as a Low-severity gap.

### L-03 — `proposeFeeToChange` accepts the *current* feeTo (no SAME_FEE_TO check)
File: `TegridyFactory.sol`
Lines: 134–140.

Unlike `proposeFeeToSetter` (line 177: `require(_newSetter != feeToSetter, "SAME_SETTER")`),
`proposeFeeToChange` happily proposes the same address as the current `feeTo`.
This is a no-op that wastes 48 hours and burns the proposal slot
(`ExistingProposalPending` blocks any other change for the duration).

Cross-check: `Audit195_Factory.t.sol::test_F22_proposeFeeToChange_same_address_allowed`
confirms the gap.

Recommendation: `require(_feeTo != feeTo, "SAME_FEE_TO");`.

### L-04 — Token blocklist allows blocking `address(0)`
File: `TegridyFactory.sol`
Lines: 269–284.

`proposeTokenBlocked(address(0), true)` succeeds with no zero-address
guard (line 269 takes any token). After execution, `blockedTokens[address(0)]
= true`. The blocklist for `address(0)` has no useful effect because
`createPair` already rejects zero (line 100), but it pollutes events and
storage.

Cross-check: `Audit195_Factory.t.sol::test_F07_setTokenBlocked_no_zero_check`
confirms.

Recommendation: `require(token != address(0), "ZERO_ADDRESS");` in
`proposeTokenBlocked`.

### L-05 — `cancelPairDisabled` does not emit a cancellation event
File: `TegridyFactory.sol`
Lines: 326–331.

Other cancel paths (`cancelFeeToChange`, `cancelTokenBlocked`,
`cancelFeeToSetterProposal`) emit dedicated cancellation events. `cancelPairDisabled`
calls `_cancel(key)` which emits the inherited `ProposalCancelled(key)` from
TimelockAdmin, but does not emit a typed `PairDisableCancelled(pair)` event,
so off-chain indexers cannot easily match cancellations to their proposals
without reverse-deriving the keccak256 key.

Recommendation: add `event PairDisableCancelled(address indexed pair);` and
emit on cancel.

---

## INFO

### I-01 — `allPairs` is unbounded; iteration helpers absent
Lines: 42, 86–88, 122. `allPairsLength` is the only enumeration helper. No
gas-griefing risk inside the contract itself (only `push`), but external
indexers iterating via `allPairs(i)` pay one SLOAD per pair. Not exploitable.

### I-02 — `acceptFeeToSetter` clears any pending feeTo change (good); event coverage is also good
Lines: 195–200. The "silent cancellation" of the pending feeTo change is
audibly emitted (`FeeToChangeCancelled` at line 199) — properly mitigated.
Verified by `Audit195_Factory.t.sol::test_F28_pending_feeTo_cleared_on_setter_transfer`.

### I-03 — Token0/token1 ordering is consistent and correct
Lines: 99: `tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA)` — matches
UniswapV2. Bidirectional `getPair` write at 120–121 ensures lookups are
symmetric.

### I-04 — Zero-address checks in constructor + proposers
Lines: 79–80 (constructor), 100, 136, 176, 308 — present and tested.

### I-05 — EOA rejection via `code.length > 0`
Line: 102. Correct but bypassable during constructor execution of the token
itself (a token can `createPair` from its own constructor when `extcodesize`
sees zero — but that fails the `code.length > 0` check on the *other* token,
and the malicious-token path is already blocked elsewhere).

### I-06 — No reentrancy on `createPair`
The `TegridyPair(pair).initialize(...)` external call at line 119 happens
*after* `getPair` is written at line 120–121, but *before* the `allPairs.push`
and event emission. `initialize` is gated by `msg.sender == factory` and
`!_initialized`, so a reentrant `createPair` call from the new pair's
constructor is impossible (constructor of TegridyPair only sets
`factory = msg.sender`). However, if `initialize` ever called back into the
factory (it doesn't today), state ordering is mostly safe — the only
window is between `getPair` write (120) and `allPairs.push` (122), during
which `allPairsLength()` and the new pair would diverge. Not exploitable
today.

---

## TEST GAPS

1. **No CREATE2 salt cross-chain test.** `Audit195_Factory.t.sol::test_F02_*`
   only verifies single-chain determinism. Add a fuzz that asserts salt
   *differs* across chain IDs (would FAIL under current code → demonstrates
   M-01).
2. **No guardian-replacement test under stress** — there's no test where the
   feeToSetter installs guardian-A, guardian-A disables N pairs, then
   feeToSetter swaps to guardian-B, and we verify whether the previous
   guardian-A retains any residual permission. They do not (the role is a
   single slot), but the absence of a regression test is a gap.
3. **No griefing fuzz on `_rejectERC777`** — no test where the candidate
   token contract burns gas via a pathological `granularity()` /
   `supportsInterface()` (M-02).
4. **No SAME_FEE_TO test** — the `proposeFeeToChange(feeTo)` call is allowed
   (L-03) and not asserted as a property anywhere.
5. **No pair-membership check test for `proposePairDisabled` / emergency**
   path. F-20 only documents that arbitrary addresses are accepted.
6. **No `cancelPairDisabled` event-emission test.** L-05 absent.
7. **Stealth-ERC777 bypass is asserted as PASS, not as KNOWN-WEAK.**
   `test_F06_stealth_erc777_bypasses_detection` asserts the bypass works.
   This is correct as POC but should be paired with an integration test
   (e.g. assert that the off-chain blocklist at least flags the pair).

---

## CROSS-CHECK — RouterFactory drift

`TegridyRouter._pairFor` (line 452–456) intentionally uses
`factory.getPair(...)` lookup instead of CREATE2 prediction. Sound choice —
it means any change to `TegridyPair` creationCode does NOT silently
de-sync the router. No INIT_CODE_HASH drift risk because no constant exists
to drift (see L-02). This is a deliberate engineering trade.

`TegridyPair.initialize` (line 74–82) is gated by `msg.sender == factory`
and `!_initialized` — Factory at line 119 calls it correctly. Token0/token1
ordering matches the salt sort.

---

## RECOMMENDATIONS (priority order)

1. (HIGH) Re-evaluate the `setGuardian` instant-set policy. Either timelock
   it or split the guardian-admin role.
2. (MEDIUM) Add `block.chainid` and `address(this)` to the CREATE2 salt.
3. (MEDIUM) Cap gas on `_rejectERC777` external calls; consider an on-chain
   allowlist for production-grade tokens.
4. (MEDIUM) Track factory-created pairs in `_isFactoryPair` mapping and
   require it in `proposePairDisabled` / `emergencyDisablePair`.
5. (LOW) Add `SAME_FEE_TO`, `ZERO_ADDRESS` (token block), and
   `PairDisableCancelled` event.
6. (LOW) Expose `INIT_CODE_PAIR_HASH` as a public constant (or a view that
   computes it once via `keccak256(type(TegridyPair).creationCode)`) for
   off-chain integrators.

— end audit 003 —
