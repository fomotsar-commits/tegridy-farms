# Agent 001 — TegridyPair.sol Forensic Audit

Target: `contracts/src/TegridyPair.sol` (337 lines, Solidity ^0.8.26)
Tests cross-checked: `TegridyPair.t.sol`, `RedTeam_AMM.t.sol`, `FinalAudit_AMM.t.sol`, `FuzzInvariant.t.sol`, `Audit195_Pair.t.sol`.

---

## HIGH severity

### H-1. `harvest()` exits the `feeOn==false` branch with `kLast==0` but never resets the path that re-enters `feeOn==true`, double-counting fees on the next mint.
- **Location:** `TegridyPair.sol:280-286` (`harvest()`), interacts with `_mintFee` at `:307-325`.
- **Vector:** `harvest()` → `_mintFee(_reserve0, _reserve1)` → returns `feeOn`. If `feeTo == address(0)` while `kLast != 0`, `_mintFee` zeros `kLast` (line 322-324). Now `harvest()` reads `feeOn=false` and skips re-setting `kLast = r0*r1`, which is correct. **However**, if `feeTo` was never set when first liquidity was added, `kLast` was never written by `mint()` (line 140 only writes `if feeOn`), so K growth from many swaps accumulates **before** `feeTo` is enabled. The first `harvest()` after `feeTo` is enabled then reads `_kLast == 0` and the inner branch (`if (_kLast != 0)`) is skipped, **the entire pre-enable K growth is silently captured by the next mint as kLast = currentK, and the protocol never claims the historical fee share.** Permissionless `harvest()` cannot recover this because it follows the same `_kLast != 0` gate.
- **PoC sketch:** Deploy with `feeTo=0`, seed liquidity (kLast stays 0), run 10000 swaps growing K 10x, factory enables feeTo, anyone calls `harvest()` → `_kLast==0` → no LP minted → next regular mint sets kLast = current K, treasury loses 1/6 of all historical fees.

### H-2. Reserves drift permanently when `IERC20.balanceOf` returns less than `postBalance` for non-FoT reasons (token pause, blocklist) — the FoT-output revert at `:243-244` reverts AFTER `_update()` already wrote new reserves.
- **Location:** `TegridyPair.sol:228-244` — order is `_update(post0,post1)` → `safeTransfer` → `require balance == postBalance`.
- **Vector:** `_update` is at line 228 (writes reserves). `safeTransfer` at 231/232 may succeed silently with a token whose `balanceOf` is rebasing/paused. The post-transfer balance check at 243 reverts the entire tx — which DOES roll back `_update`. **However**, since `_update` is in the same tx, the revert is fine. The actual bug is that `nonReentrant` lock prevents reentrancy WITHIN this pair, but the `safeTransfer` to a malicious recipient `to` that calls **a different pair / router** during ERC-777 hook will read the pair's `getReserves()` returning **already-updated post-swap reserves while the swap may still revert**. This is the documented "read-only reentrancy" surface — but the inverse case: a malicious cross-pair callback can act on phantom mid-swap state.
- **PoC sketch:** Token0 with ERC-777 send hook → `to` callback reads other pair's TWAP/oracle that uses `pairAB.getReserves()` for pricing → executes external trade against new reserves before parent swap reverts; ERC-777 reject at factory is creation-time only.

### H-3. `harvest()` lacks `nonReentrant`-protected check for `disabledPairs` / `blockedTokens` — protocol fee accrues on disabled pairs.
- **Location:** `TegridyPair.sol:280-286`.
- **Vector:** Once a pair is disabled (e.g. malicious token discovered), `mint()` and `swap()` correctly block further interaction. But `harvest()` continues to mint LP to `feeTo` based on prior K growth. If `feeTo` is a contract that auto-stakes/sells, it interacts with the disabled pair via LP redemption → bypassing the disable. More importantly, `_mintFee` reads `factory.feeTo()` but never checks `disabledPairs(this)`, so `harvest()` is callable on a quarantined pair.
- **PoC sketch:** Governance disables PAIR after detecting exploit → attacker calls `pair.harvest()` → mints LP to `feeTo`, which is ERC20 transferable → LP escapes the quarantine via standard ERC20 paths.

---

## MEDIUM severity

### M-1. `mint()` reads `factory.disabledPairs(this)` and `factory.blockedTokens(t0/t1)` but `burn()` does NOT — LPs locked in a disabled/blocked pair cannot exit via `burn()` if it were also blocked, but as written `burn` is **always** callable. This is consistent with U-V2 but inconsistent with the new `mint`-side gate, creating a footgun: governance disables pair → mint reverts with "PAIR_DISABLED", users assume contract is frozen, attempt to burn → succeeds → confusion.
- **Location:** `TegridyPair.sol:101-102` (mint gate) vs `:150-176` (no gate).
- **PoC:** Documentation drift only; not exploitable. (Acceptable design but inconsistent.)

### M-2. `_mintFee` does NOT update `kLast` when `liquidity == 0` (rounding to zero). `mint()` at `:140` then writes `kLast = r0*r1` only if `feeOn`. So `kLast` keeps drifting upward only on successful liquidity events. **Edge case:** repeated dust mints with `_totalSupply==0` path is impossible (covered by MIN_INITIAL_TOKENS) but subsequent mints with `liq0==liq1==0` will revert at `:135` "INSUFFICIENT_LIQUIDITY_MINTED" — fine. However, `harvest()` re-running `_mintFee` when `liquidity==0` (rounding) and then setting `kLast = r0*r1` at `:284` **resets kLast forward without minting any fee LP** — losing all accumulated fee credit since last harvest.
- **Location:** `TegridyPair.sol:280-286`, `:316-319`.
- **Vector:** Permissionless `harvest()` called repeatedly with tiny K-growth between calls → numerator small, divides to 0 → no LP minted, but `kLast` is overwritten to current K → griefing the protocol fee.
- **PoC sketch:** Bot calls `harvest()` after every block with even 1-wei K growth → `liquidity = totalSupply * 1 / (5*sqrt(K)+sqrt(K))` rounds to 0 → kLast bumped → over a year, the cumulative `liquidity > 0` ceiling of the lossy chunks is never realized.

### M-3. `_update()` writes `blockTimestampLast = uint32(block.timestamp)` but does NOT compute `priceCumulative` deltas. Code comment claims "Uniswap V2 interface parity" — but third-party integrators expecting U-V2's full `(reserve0, reserve1, timestamp)` semantics that include sliding TWAP via `price0CumulativeLast` will silently get bad data.
- **Location:** `TegridyPair.sol:294-300`.
- **Vector:** Off-chain indexers / lending protocols using `getReserves()` + `blockTimestampLast` to compute TWAP will read fresh timestamps but stale prices, producing manipulable median.
- **PoC sketch:** Lending oracle does `(r,t)=getReserves()` at t1, then again at t2, computes `(r1-r0)/(t2-t1)` assuming cumulative — it's just spot price diff → trivially manipulable via flashloan donate + sync.

### M-4. `skim(to)` is permissionless and runs through `nonReentrant`, but DOES NOT check `disabledPairs` / `blockedTokens`. After governance disables pair, attacker can still drain any tokens donated post-disable via `skim`.
- **Location:** `TegridyPair.sol:255-265`.
- **Vector:** Pair disabled → an attacker still has `skim` available → siphons direct deposits / dust accumulated post-disable.

### M-5. `mint()` uses `IERC20(token0).balanceOf(this) - _reserve0` (line 114). With a token whose `balanceOf` reverts (some access-controlled tokens) the entire pair becomes unusable — including `burn` (also reads balanceOf at 153). LPs are locked. The `_rejectERC777` at factory creation is bypassed if token upgrades to such behavior post-deploy.
- **Vector:** Upgradeable token → `balanceOf` blacklists pair → mint/burn revert forever → LPs locked.

### M-6. First-depositor inflation defense `rawLiquidity > MINIMUM_LIQUIDITY * 1000` (line 126) is **not** a true defense against the donate-attack on a low-decimal token (e.g. 6-dec USDC-like): with 6-dec tokens, `MIN_INITIAL_TOKENS=1000` is `0.001 USDC` and the `>1_000_000` rawLiquidity threshold is reachable with `~1.001 USDC * 1.001 USDC` = ~1 USDC each. Attacker can still grief at low cost.
- **Location:** `TegridyPair.sol:121, 126`.
- **PoC sketch:** Attacker first-deposits 1.001 USDC + 1.001 USDC → mints ~999 LP, then donates 1000 USDC each → next depositor at 100 USDC mints `min(100*1000/1001, ...) = 99` LP, attacker holds ~91% of pool with ~$2 cost.

### M-7. `_mintFee` reads `factory.feeTo()` on every mint/burn/harvest — a malicious feeToSetter can flip `feeTo` between `0` and a controlled address mid-flow via the 48h timelock. Consider race: a swap that brought K up by X, then governance enables `feeTo`, then immediately a `harvest()` caller mints HUGE retroactive fee from K-growth that occurred while `feeTo == 0` (per H-1 above, but with attacker-controlled feeTo).

---

## LOW / INFO

### L-1. `swap()` line 200 `require(to != token0 && to != token1)` is checked AFTER the `to != address(0) && to != address(this)` check at 192. Two require statements with two different revert messages for `to`-validation; consolidate.

### L-2. `_update()` truncates to `uint112` via `require(... <= type(uint112).max)` then `uint112(balance)` cast — safe but redundant; the require already enforces it. The `uint32(block.timestamp)` cast at 298 silently overflows in 2106 (year). Add explicit comment / use `uint32(block.timestamp % 2**32)` for clarity.

### L-3. `MINIMUM_LIQUIDITY = 1000` is a `uint256 constant`. With per-token min `1000` at line 121, the burn-floor at line 162 (`amount0 > 0 && amount1 > 0`) means with imbalanced reserves (e.g. 1 wei token1, 1 ether token0 after extreme swap), `amount1` can round to 0, blocking burn forever. Combined with the locked 1000 LP at `0xdead`, a ~1000-LP "trapped" floor in extreme imbalance is possible.

### L-4. `event Skim` is emitted at `:264` but the `Sync` event at `:299` fires from `_update`. `skim()` updates balances but does NOT call `_update` → reserves and balances diverge until next mint/burn/swap/sync. This is correct U-V2 behavior but worth a comment because it's counterintuitive (skim "fixes" the divergence on the balance side, leaving reserves stale until sync).

### L-5. `ITegridyFactory` interface (line 332-336) does NOT include `feeToSetter` or `pendingFeeTo` — pair cannot detect mid-timelock state. Acceptable but limiting.

### L-6. The `data.length == 0` check at line 188 is a hard ban on flash swaps. The `bytes calldata data` parameter is permanently dead weight in the ABI; signature parity with Uniswap V2 is preserved but every swap pays calldata gas for an unused argument.

### L-7. `harvest()` (`:280`) emits no event. Off-chain indexers cannot distinguish a `feeTo` LP-mint via `harvest()` from one via `mint()` — both fire `Transfer(0, feeTo, x)` only.

### INFO-1. `_mintFee` formula `numerator = totalSupply * (rootK - rootKLast); denominator = rootK * 5 + rootKLast;` — battle-tested U-V2. Solmate `sqrt` is sound. No concerns on sqrt rounding; `rootK >= rootKLast` is enforced via `if`.

### INFO-2. `nonReentrant` is on every external state-changing function (mint/burn/swap/skim/sync/harvest). Lock modifier is OZ ReentrancyGuard — sound.

### INFO-3. The Initialize event (line 67) does not include the factory address — minor for indexers.

---

## Test Gaps

1. **No fuzz test for `harvest()`** in any of the four suites. `FuzzInvariant.t.sol` invariant handler (`PairHandler` :231) calls only `doSwapAForB`, `doSwapBForA`, `doMint` — never `harvest()`, never `burn()`, never `skim()`, never `sync()`. **The kNeverDecreases invariant is not exercising harvest's fee-mint path.**
2. **No test for the H-1 scenario:** swaps grow K while `feeTo == 0`, then `feeTo` is set; nothing asserts that the historical K growth between feeTo-disabled and feeTo-enabled is correctly captured (it is NOT — the kLast=0 path zeros it).
3. **No test for M-2:** repeated dust harvest in a loop confirming kLast advances without minting any fee LP. `test_NEWA7_harvestIdempotentWithoutVolume` only tests two calls in one block.
4. **No test for M-3:** reading `blockTimestampLast` over time to confirm it does NOT track price cumulative; tests assume `getReserves()` is U-V2 compliant.
5. **No test for swap with `to` = a contract that reenters via ERC-777** (`ReentrancyAttacker` mock exists at RedTeam_AMM.t.sol:90 but is never wired to a hook-firing token; the attacker just calls swap normally).
6. **No fuzz test on first-depositor with low-decimal tokens** (M-6). Tests are 18-decimal only; a 6-decimal fuzz would expose the cheap inflation surface.
7. **No test for `_update` overflow at `uint112.max`** — `Audit195_Pair.t.sol:679` mentions "Values at exactly uint112.max should work (via sync)" but doesn't actually fuzz the boundary.
8. **`invariant_reservesMatchBalances`** (FuzzInvariant.t.sol:343) will FAIL by design after any direct token donation if the handler ever sent tokens to the pair without calling sync — the invariant is too strict and only passes because the handler never donates. A handler that calls `tokenA.transfer(pair, x)` without minting is missing.
9. **No test for `mint` to `feeTo` when `feeTo == address(this)`** — would deadlock.
10. **No test for skim()/sync() being callable on disabled pairs** (M-4).
11. **No test verifying `_mintFee` correctness across multiple `feeTo` toggles** (mostly relevant to M-7 / H-1).
12. **No test for `swap()` with `amount0Out == _reserve0` exactly** — boundary at line 194 (`<` not `<=`) — exists implicitly but not asserted with equality.

---

## Counts
- HIGH: 3
- MEDIUM: 7
- LOW/INFO: 7 LOW + 3 INFO = 10
- Test gaps: 12
