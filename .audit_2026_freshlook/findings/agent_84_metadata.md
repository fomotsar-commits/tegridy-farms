# Agent 84/100 — ERC20 Metadata Reliance Audit

**Lens:** `decimals()` / `symbol()` / `name()` consumers — non-standard returns, missing implementations, hardcoded decimal assumptions, and conversion math that silently assumes 18-decimal scale on caller-supplied tokens.

**Scope:** All Solidity files under `contracts/src/`.

**Method:** Grepped every `.decimals()`, `.symbol()`, `.name()` call site; cross-checked all `1e18` / `10**18` literals; traced `IERC20Metadata` imports; reviewed every external-token entry point (whitelist-bribe, fee-router conversion, restaking bonus pool, lending oracle).

---

## Summary of metadata call sites

| Call site | Token | Cached vs. live | Risk |
|-----------|-------|-----------------|------|
| `POLAccumulator.sol:290` `IERC20Metadata(_toweli).decimals()` | TOWELI (own) | Cached at construction → `toweliUnit` immutable | Low (TOWELI is locked at 18) |

That is the **only** `decimals()` consumer in the entire codebase. No `.symbol()` or `.name()` reads on any external ERC20 anywhere — so MakerDAO MKR-style `bytes32` returns and legacy USDT-no-metadata are not on the attack surface.

---

## F-84-1 — TegridyRestaking bonus-rate caps assume 18-decimal bonus token (MEDIUM)

**File:** `contracts/src/TegridyRestaking.sol:180`, `:318`
**Metadata call:** None — but caps are **denominated in raw token wei** without ever reading `bonusRewardToken.decimals()`.

```solidity
uint256 public constant MAX_BONUS_REWARD_RATE = 100e18;          // line 180
if (_bonusRewardPerSecond > 10e18) revert BadParam();            // line 318 (constructor)
if (_rate > MAX_BONUS_REWARD_RATE) revert RateTooHigh();         // line 1333 (proposeBonusRate)
```

`bonusRewardToken` is documented as accepting **"ETH (WETH) or any ERC20 for bonus"** (line 92). The constructor only checks `bonusRewardToken != address(0)` and `bonusRewardToken != rewardToken`. **No `decimals()` snapshot, no decimal-scaled cap.**

**Divergence:** Both caps treat the token as 18-decimal. The semantic meaning of the cap collapses for non-18-decimal tokens:

| Bonus token | `MAX_BONUS_REWARD_RATE = 100e18` actually means… |
|-------------|---------------------------------------------------|
| WETH (18 dec) | 100 WETH/sec (sensible upper bound) |
| USDC (6 dec) | `100e18 / 1e6 = 1e14` USDC/sec ≈ **\$3.15e21/year** (no cap) |
| WBTC (8 dec) | `100e18 / 1e8 = 1e12` WBTC/sec (no cap) |
| DAI (18 dec) | 100 DAI/sec (fine) |

The 48-hour `BONUS_RATE_TIMELOCK` is the only real bound for non-18-decimal tokens.

**Impact:** Owner-key compromise on an L2 deployment using a 6-decimal stablecoin bonus token can set `bonusRewardPerSecond` arbitrarily high (up to `100e18` wei = `1e14` raw stablecoin units/sec) and drain the entire bonus pool in one pre-warmed `_accrueBonus()` cycle, with the rate-cap revert never firing. The 48h timelock ensures detection but does not block the action if monitoring is asleep.

**Honest-operator footgun:** An operator deploying with a 6-decimal token who reads "max 100" thinks they're capping at 100/sec. They are actually capping at `1e14` units/sec.

**Defence pattern of record:** Compound III sets cap *as fraction of supply*, not raw wei; Synthetix StakingRewards uses `rewardRate = reward / duration` and bounds the *reward amount* not the rate, sidestepping decimals entirely. A read-and-cache `bonusDecimals = bonusRewardToken.decimals()` in the constructor with `MAX_BONUS_REWARD_RATE = 100 * 10**bonusDecimals` would scale correctly.

---

## F-84-2 — VoteIncentives min-bribe ceiling assumes 18-decimal bribe token (LOW–MEDIUM)

**File:** `contracts/src/VoteIncentives.sol:1343`

```solidity
/// AUDIT FIX (BATCH-H M13): cap at 1e24 (1M tokens with 18 decimals).
uint256 public constant MAX_MIN_BRIBE_AMOUNT = 1e24;
```

The codebase comment (line 1339) explicitly acknowledges this is "1M tokens with 18 decimals." `whitelistedTokens` admits arbitrary owner-whitelisted ERC20s as bribe tokens (line 1101 `applyWhitelistChange`).

**Divergence:** For a 6-decimal token (USDC), `1e24` wei = `1e18` raw USDC = **1 quintillion USDC** — the ceiling is meaningless for stablecoins. For an 8-decimal WBTC, `1e24` wei = `1e16` BTC — also meaningless.

**Impact:** The cap was added (BATCH-H M13) to prevent a captured admin from setting `minBribeAmounts[token] = type(uint256).max` and DoS-ing all deposits of that token. The cap successfully prevents `type(uint256).max` but does not prevent a captured admin from setting a value that DoS-es legitimate USDC bribes (e.g., `1e23` = 100M USDC). The 24h timelock on `applyMinBribeAmountChange` (`onlyAdmin`) is the real defense.

**Severity:** LOW — admin-only timelocked path, monitorable. But the comment claims "1M tokens with 18 decimals" as the ceiling rationale, and that claim is silently wrong for non-18-decimal tokens.

---

## F-84-3 — VoteIncentives default min-bribe is unsafe for non-18-decimal whitelisted tokens (LOW)

**File:** `contracts/src/VoteIncentives.sol:385`, `:663`

```solidity
/// SECURITY FIX H-7 + R020 H-3: per-token minimum bribe with a sensible
/// 18-decimal default. Owners must configure per-token mins for non-18-
/// decimal tokens (USDC, USDT) via proposeMinBribeAmount.
uint256 public constant DEFAULT_MIN_TOKEN_BRIBE = 1e15;          // line 385

uint256 effectiveMin = tokenMin > 0 ? tokenMin : DEFAULT_MIN_TOKEN_BRIBE;  // line 663
require(actualReceived >= effectiveMin, "BRIBE_TOO_SMALL");       // line 664
```

**Divergence:** `1e15` wei is "0.001 token" at 18-dec but `1e15 / 1e6 = 1e9` USDC at 6-dec — i.e., **\$1 billion USDC minimum bribe** if the operator forgets to configure `minBribeAmounts[USDC]`.

**Impact:** Two mirror-image failure modes between whitelisting and per-token-min:
1. **Forgot to configure:** USDC bribes effectively cannot be deposited until per-token min is set. Operator footgun, not exploit.
2. **Half-configured:** Whitelist USDC + leave default min applied → no bribes ever flow → wasted whitelist slot.

The comment correctly documents the requirement. The fragility is procedural, not algorithmic. Note for runbook: any non-18-decimal whitelist must be paired with a `proposeMinBribeAmount(token, ...)` call **before** the whitelist is honored at deposit-time.

---

## F-84-4 — SwapFeeRouter conversion floor is intentionally 18-decimal-biased, documented (INFORMATIONAL)

**File:** `contracts/src/SwapFeeRouter.sol:220`

```solidity
uint256 public constant MIN_TOKEN_FEE_FOR_CONVERSION = 1e18;
```

The NatSpec (lines 210–216) explicitly says "1e18 corresponds to ~\$1 trillion" for 6-decimal stablecoins and recommends a future `convertTokenFeesToETHFor6Decimal()` helper. **Not a finding** — this is acknowledged design debt with an explicit migration plan and a fallback path (`withdrawTokenFees` to treasury). Including it for completeness so the next agent doesn't duplicate-flag.

The downstream `_enforceTWAPMinETHOut` (line 1958) is **decimal-agnostic** — uses `amountIn * priceDiff / (elapsed * Q112_SFR)` with native UQ112x112 fixed-point math. No assumption of 18 decimals on the conversion side itself.

---

## F-84-5 — POLAccumulator's `decimals()` reliance is correctly hardened (POSITIVE FINDING)

**File:** `contracts/src/POLAccumulator.sol:290`

```solidity
toweliUnit = 10 ** IERC20Metadata(_toweli).decimals();
```

Cached at construction-time; reverts on tokens missing the function (so a broken/legacy token deploy fails fast at construction, not silently mid-operation). Used consistently at the consult site (line 928) and the spot-quote-in site (line 931) and the fair-reserve sqrt (line 941). The deviation comparison and fair-reserve math both use the same unit, so the "decimals-mismatched DoS in one direction" pattern flagged on `TegridyFeeHook.sol:366` (legacy fix) cannot apply here. Verifies as correctly implemented per the FIX D-POL-M1 commentary.

If TOWELI ever ships a non-standard `decimals()` impl (e.g., immutable but callable as zero-arg view returning 18 only via bytecode-level fallback) the construction would still resolve cleanly because `IERC20Metadata` calls into the canonical OZ ERC20 interface. The Toweli source (line 48 `contract Toweli is ERC20, ERC20Permit`) inherits OZ ERC20 which exposes a standard `decimals()` returning `uint8(18)`. Construction-time revert covers the pathological case.

---

## Dead-ends investigated

- **`TegridyTokenURIReader.sol:87-88`** — `amount / 1e18` and `amount % 1e18 / 1e16` are display-only formatting for TOWELI (own 18-dec token). Decimal-correct. Not a finding.
- **`TegridyLPFarming.sol:251, :258`** — Synthetix-style `* 1e18 / total` accumulator precision; both numerator and denominator carry the factor; cancellation makes it decimal-agnostic. Not a finding.
- **`TegridyStaking.sol:120` `ACC_PRECISION = 1e18`** — same Synthetix accumulator pattern; TOWELI in/TOWELI out both 18-dec. Not a finding.
- **`TegridyRestaking.sol:84` `ACC_PRECISION = 1e18`** — accumulator precision, not a decimal assumption (cancels in the math). Note however that the *bonus reward attribution* path multiplies through this with raw wei from `bonusRewardToken`, see F-84-1.
- **`TegridyStaking.sol:122` `MIN_STAKE = 100e18`, `:126` `MIN_NOTIFY_AMOUNT = 1000e18`** — constants apply to TOWELI (own 18-dec); decimal-correct.
- **`TegridyPair.sol`** — explicit "removed decimal normalization" comment (line 30); operates on raw reserves; standard Uniswap V2 semantics. No metadata reads anywhere. Not a finding.
- **`TegridyRouter.sol`** — `_getAmountOut`, `quote`, `_getReserves` all decimal-agnostic. Not a finding.
- **`TegridyTWAP.consult()`** — caller passes `amountIn`; the fixed-point math is decimal-agnostic. Not a finding.
- **`MemeBountyBoard.sol`, `CommunityGrants.sol`, `PremiumAccess.sol`, `RevenueDistributor.sol`, `ReferralSplitter.sol`** — all single-token contracts on TOWELI / ETH / WETH only, no caller-supplied ERC20 in the metadata path. Not a finding.
- **`TegridyDropV2.sol:461-462`, `TegridyStaking.sol:1385-1389`** — these are *implementations* of `name()` / `symbol()` (returning standard `string memory`), not consumers. Not findings; included so the next pass knows these are not TOCTOU readers.
- **`TegridyLending.sol`** — handles only ETH (loan principal) + tsTOWELI NFT (collateral) + `consult(pair, toweli, ...)` for ETH-floor; never touches arbitrary-ERC20 metadata. Not a finding.
- **`TegridyNFTLending.sol`, `TegridyNFTPool.sol`, `TegridyNFTPoolFactory.sol`, `TegridyStakingJbacVault.sol`** — pure ERC721 contracts; no ERC20 metadata path. Not findings.
- **`TegridyLaunchpadV2.sol:51, :123, :191, :214`** — user-supplied `name`/`symbol` strings stored verbatim for NFT collection construction; not a metadata *read* of a third-party token. Not a finding.

---

## Actionable summary

| ID | Severity | File:line | Fix shape |
|----|----------|-----------|-----------|
| F-84-1 | MEDIUM | `TegridyRestaking.sol:180,:318` | Read+cache `bonusDecimals = bonusRewardToken.decimals()` in constructor (try/catch, default 18 on revert), scale `MAX_BONUS_REWARD_RATE` to `100 * 10**bonusDecimals`. Mirrors POLAccumulator's `toweliUnit` pattern. |
| F-84-2 | LOW–MEDIUM | `VoteIncentives.sol:1343` | Either drop the comment claim of "1M tokens" or scale `MAX_MIN_BRIBE_AMOUNT` per-token via a setter that snapshots `decimals()` at whitelist time. |
| F-84-3 | LOW | `VoteIncentives.sol:385` | Procedural — runbook gate: every non-18-decimal whitelist must be preceded by `proposeMinBribeAmount(token, ...)`. |
| F-84-4 | INFO | `SwapFeeRouter.sol:220` | No action — design debt acknowledged in NatSpec with explicit migration path. |
| F-84-5 | POSITIVE | `POLAccumulator.sol:290` | Reference implementation. Pattern to mirror in F-84-1 fix. |

No exploit chains discovered. The codebase has a single explicit `decimals()` consumer (POLAccumulator), and that consumer is correctly hardened. The remaining findings are about **implicit** 18-decimal assumptions baked into raw `1e18`-scaled caps on caller-supplied bonus / bribe tokens. F-84-1 is the highest-impact: it weakens the bonus-rate cap from "useful safety bound" to "useful only against 18-decimal misconfigurations" on any non-18-decimal bonus token.
